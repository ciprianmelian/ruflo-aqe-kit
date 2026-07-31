/**
 * Tests for tools/trajectory-attribution.cjs — TRAJ-ATTR-V1 (Wave 4 measurement
 * integrity). Every case here is a FALSIFICATION fixture: attribution that cannot
 * distinguish two sources on a crafted input is worthless, so the crafted inputs
 * include two distinct writers, an uncovered (unknown) transition, pre-attribution
 * history, and both states of the #2786 dist gate.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const attr = require('../tools/trajectory-attribution.cjs');

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'traj-attr-'));
}
function writeWeights(root, content) {
  const p = path.join(root, '.swarm', 'lora-weights.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

describe('trajectory-attribution: weights snapshot', () => {
  it('returns null when the sink does not exist (fresh target — not an error)', () => {
    const root = mkRoot();
    try { expect(attr.snapshotWeights(root)).toBeNull(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('fingerprints content: same bytes ⇒ same sha256, different bytes ⇒ different', () => {
    const root = mkRoot();
    try {
      writeWeights(root, '{"B":[1,2]}');
      const a = attr.snapshotWeights(root);
      const a2 = attr.snapshotWeights(root);
      writeWeights(root, '{"B":[9,9]}');
      const b = attr.snapshotWeights(root);
      expect(a.sha256).toBe(a2.sha256);
      expect(a.sha256).not.toBe(b.sha256);
      expect(a.bytes).toBe(11);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('trajectory-attribution: append + read round-trip', () => {
  it('appends schema-stamped rows and reads them back in order', () => {
    const root = mkRoot();
    try {
      expect(attr.appendEvent(root, { source: 'stop-hook-post-task', reward: 0.7 })).toBe(true);
      expect(attr.appendEvent(root, { source: 'harvest-sinkA', trained: 3 })).toBe(true);
      const rows = attr.readEvents(root);
      expect(rows.length).toBe(2);
      expect(rows[0].schema).toBe('traj-attr-v1');
      expect(rows[0].source).toBe('stop-hook-post-task');
      expect(rows[1].source).toBe('harvest-sinkA');
      expect(rows[1].trained).toBe(3);
      expect(typeof rows[0].ts).toBe('string');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses a row without a source (attribution without a source is noise)', () => {
    const root = mkRoot();
    try {
      expect(attr.appendEvent(root, { reward: 0.9 })).toBe(false);
      expect(attr.readEvents(root)).toEqual([]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('derives weightsChanged from the before/after fingerprints', () => {
    const root = mkRoot();
    try {
      attr.appendEvent(root, { source: 'stop-hook-post-task', weightsBefore: { sha256: 'aaa' }, weightsAfter: { sha256: 'bbb' } });
      attr.appendEvent(root, { source: 'stop-hook-post-task', weightsBefore: { sha256: 'bbb' }, weightsAfter: { sha256: 'bbb' } });
      attr.appendEvent(root, { source: 'stop-hook-post-task', weightsBefore: null, weightsAfter: { sha256: 'ccc' } });
      const rows = attr.readEvents(root);
      expect(rows[0].weightsChanged).toBe(true);
      expect(rows[1].weightsChanged).toBe(false);
      expect(rows[2].weightsChanged).toBe(true); // sink came into existence
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('skips malformed and foreign-schema lines without throwing (history is append-only)', () => {
    const root = mkRoot();
    try {
      attr.appendEvent(root, { source: 'harvest-sinkA' });
      fs.appendFileSync(attr.ledgerPath(root), '{ not json }\n{"schema":"other-v9","source":"x"}\n\n');
      const rows = attr.readEvents(root);
      expect(rows.length).toBe(1);
      expect(rows[0].source).toBe('harvest-sinkA');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('reads an empty list when no ledger exists (pre-attribution target)', () => {
    const root = mkRoot();
    try { expect(attr.readEvents(root)).toEqual([]); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('trajectory-attribution: transition attribution (the falsification core)', () => {
  // Two sources write two DIFFERENT transitions — the classifier must tell them apart.
  const events = [
    { schema: 'traj-attr-v1', source: 'stop-hook-post-task', weightsBefore: { sha256: 'w0' }, weightsAfter: { sha256: 'w1' } },
    { schema: 'traj-attr-v1', source: 'harvest-sinkA', weightsBefore: { sha256: 'w1' }, weightsAfter: { sha256: 'w2' } },
  ];

  it('attributes each covered transition to exactly its own writer', () => {
    expect(attr.attributeTransition(events, 'w0', 'w1')).toEqual(['stop-hook-post-task']);
    expect(attr.attributeTransition(events, 'w1', 'w2')).toEqual(['harvest-sinkA']);
  });

  it('an UNCOVERED transition is unknown — never silently bucketed into a known source', () => {
    expect(attr.attributeTransition(events, 'w2', 'w3')).toEqual([attr.UNKNOWN_SOURCE]);
  });

  it('pre-attribution history (no events at all) classifies unknown by construction', () => {
    expect(attr.attributeTransition([], 'w0', 'w1')).toEqual([attr.UNKNOWN_SOURCE]);
    expect(attr.attributeTransition(null, 'w0', 'w1')).toEqual([attr.UNKNOWN_SOURCE]);
  });

  it('a from-nothing transition (sink created) matches an event with a null before', () => {
    const created = [{ schema: 'traj-attr-v1', source: 'harvest-sinkA', weightsBefore: null, weightsAfter: { sha256: 'w1' } }];
    expect(attr.attributeTransition(created, null, 'w1')).toEqual(['harvest-sinkA']);
  });
});

describe('trajectory-attribution: #2786 dist gate (defect_gate philosophy — self-retiring)', () => {
  // Crafted dist trees with the behavior PRESENT vs REMOVED: the gate must gate on the
  // literal recordTrajectory call inside bridgeRecordFeedback, not on comments/versions.
  function mkDist(bridgeBody) {
    const root = mkRoot();
    const p = path.join(root, 'ruflo', 'node_modules', '@claude-flow', 'cli', 'dist', 'src', 'memory');
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'memory-bridge.js'),
      'export async function bridgeRecordFeedback(options) {\n' + bridgeBody + '\n}\n' +
      'export async function otherThing() {\n  await intelligence.recordTrajectory([], "x");\n}\n');
    return root;
  }

  it('reports LIVE when bridgeRecordFeedback really calls recordTrajectory', () => {
    const root = mkDist('  const intelligence = await import("./intelligence.js");\n  await intelligence.recordTrajectory([{}], "success");');
    try { expect(attr.detectBridgeTrajectoryLive(root).live).toBe(true); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('self-retires (live=false) when the call is gone from the bridge body — even if a comment mentions #2786 and a NEIGHBOR still calls it', () => {
    const root = mkDist('  // #2786 recordTrajectory used to be called here\n  return null;');
    try { expect(attr.detectBridgeTrajectoryLive(root).live).toBe(false); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('returns live=null (not a guess) when the dist is absent', () => {
    const root = mkRoot();
    try { expect(attr.detectBridgeTrajectoryLive(root).live).toBeNull(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('anchor-missing is null, NOT false: a RENAMED bridge function means "cannot assess", never "self-retired"', () => {
    // Round 2 (a): upstream renames bridgeRecordFeedback (or refactors it away) while
    // the double-write continues under the new name — reporting false here would
    // claim the defect retired while it may still be live. Same "cannot tell" family
    // as P13/B16: no subject ⇒ no verdict.
    const root = mkRoot();
    const p = path.join(root, 'ruflo', 'node_modules', '@claude-flow', 'cli', 'dist', 'src', 'memory');
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'memory-bridge.js'),
      'export async function bridgeRecordOutcome(options) {\n  await intelligence.recordTrajectory([{}], "success");\n}\n');
    try { expect(attr.detectBridgeTrajectoryLive(root).live).toBeNull(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('scopes a const-arrow declaration form the same as a function declaration', () => {
    const root = mkRoot();
    const p = path.join(root, 'ruflo', 'node_modules', '@claude-flow', 'cli', 'dist', 'src', 'memory');
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'memory-bridge.js'),
      'export const bridgeRecordFeedback = async (options) => {\n  await intelligence.recordTrajectory([{}], "success");\n}\n' +
      'export async function otherThing() { return null; }\n');
    try { expect(attr.detectBridgeTrajectoryLive(root).live).toBe(true); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('finds the call live in THIS host\'s installed dist iff the file says so (ground-truth cross-check)', () => {
    const real = attr.detectBridgeTrajectoryLive();
    if (real.path && fs.existsSync(real.path)) {
      const src = fs.readFileSync(real.path, 'utf8');
      const m = src.match(/(?:function|const|let|var)\s+bridgeRecordFeedback\b/);
      if (!m) { expect(real.live).toBeNull(); return; }
      const end = src.indexOf('\nexport ', m.index + 1);
      const expected = /recordTrajectory\s*\(/.test(src.slice(m.index, end > m.index ? end : undefined));
      expect(real.live).toBe(expected);
    } else {
      expect(real.live).toBeNull();
    }
  });
});
