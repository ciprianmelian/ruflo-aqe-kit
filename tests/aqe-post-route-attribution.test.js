/**
 * Tests for the TRAJ-ATTR-V1 wiring in .claude/helpers/aqe-post-route.cjs (Wave 4).
 * The Stop-hook wrapper is the sole production spawner of `ruflo hooks post-task`
 * (the path that, since #2786, double-writes intelligence.recordTrajectory), so it
 * must record one attribution row per turn bracketing the lora-weights transition.
 *
 * Hermetic: stub `aqe`/`ruflo`/`npm` on PATH (the wrapper's spawns and the
 * _npm-root.cjs probe never reach real binaries), sandbox cwd per test.
 * Lock-step falsification: wrapper-written rows MUST parse under the canonical
 * reader in tools/trajectory-attribution.cjs — inline-writer drift fails here.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '../.claude/helpers/aqe-post-route.cjs');
const ASSET = path.resolve(__dirname, '../assets/claude-helpers/aqe-post-route.cjs');
const attr = require('../tools/trajectory-attribution.cjs');

function mkStubBins() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-bin-'));
  for (const name of ['aqe', 'ruflo']) {
    const stub = path.join(bin, name);
    fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(stub, 0o755);
  }
  // `npm root -g` → empty stub root, so _npm-root.cjs never shells the real npm.
  const npmStub = path.join(bin, 'npm');
  fs.writeFileSync(npmStub, '#!/bin/sh\necho "' + bin + '/fake-node-modules"\n');
  fs.chmodSync(npmStub, 0o755);
  fs.mkdirSync(path.join(bin, 'fake-node-modules'), { recursive: true });
  return bin;
}

function run(cwd, bin, { argv = [], env = {} } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...argv], {
    input: '{}', encoding: 'utf8', timeout: 15000, cwd,
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, ...env },
  });
}

describe('aqe-post-route: TRAJ-ATTR-V1 attribution row', () => {
  let bin;
  beforeAll(() => { bin = mkStubBins(); });
  afterAll(() => { fs.rmSync(bin, { recursive: true, force: true }); });

  it('canonical asset and installed helper are byte-identical (edit-the-asset rule)', () => {
    expect(fs.readFileSync(ASSET, 'utf8')).toBe(fs.readFileSync(SCRIPT, 'utf8'));
  });

  it('writes one stop-hook-post-task row per turn, parseable by the canonical reader (lock-step)', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-cwd-'));
    try {
      const r = run(cwd, bin, { argv: ['0.8'] });         // explicit reward override
      expect(r.status).toBe(0);
      const rows = attr.readEvents(cwd);                   // canonical reader, not a re-parse
      expect(rows.length).toBe(1);
      expect(rows[0].source).toBe('stop-hook-post-task');
      expect(rows[0].schema).toBe('traj-attr-v1');
      expect(rows[0].reward).toBe(0.8);
      expect(rows[0].success).toBe(true);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  it('brackets the lora-weights transition: null→null when no sink, fingerprints when present', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-cwd-'));
    try {
      run(cwd, bin, { argv: ['0.8'] });                    // no .swarm/lora-weights.json yet
      fs.mkdirSync(path.join(cwd, '.swarm'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.swarm', 'lora-weights.json'), '{"B":[0.1]}');
      run(cwd, bin, { argv: ['0.3'] });                    // sink now exists (stubs won't change it)
      const rows = attr.readEvents(cwd);
      expect(rows.length).toBe(2);
      expect(rows[0].weightsBefore).toBeNull();
      expect(rows[0].weightsAfter).toBeNull();
      expect(rows[0].weightsChanged).toBe(false);          // null→null: nothing moved
      expect(rows[1].weightsBefore.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[1].weightsAfter.sha256).toBe(rows[1].weightsBefore.sha256);
      expect(rows[1].weightsChanged).toBe(false);          // stub binaries trained nothing — honest
      expect(rows[1].success).toBe(false);                 // reward 0.3 < 0.5
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  it('records bridge2786:null when the dist is unreachable (stub npm root) — never a guess', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-cwd-'));
    try {
      run(cwd, bin, { argv: ['0.8'] });
      const rows = attr.readEvents(cwd);
      expect(rows[0].bridge2786).toBeNull();
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  it('RUFLO_DISABLE_TRAINING=1 (control arm) writes NO attribution row — no learning writes means no row', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-cwd-'));
    try {
      const r = run(cwd, bin, { argv: ['0.8'], env: { RUFLO_DISABLE_TRAINING: '1' } });
      expect(r.status).toBe(0);
      expect(fs.existsSync(path.join(cwd, '.claude-flow', 'trajectory-attribution.jsonl'))).toBe(false);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  it('a read-only ledger dir never blocks Stop (exit 0, stdout {} contract intact)', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-cwd-'));
    try {
      const cf = path.join(cwd, '.claude-flow');
      fs.mkdirSync(cf, { recursive: true });
      fs.chmodSync(cf, 0o555);                             // append will fail
      const r = run(cwd, bin, { argv: ['0.8'] });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('{}');
    } finally {
      try { fs.chmodSync(path.join(cwd, '.claude-flow'), 0o755); } catch (e) {}
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('routing-outcomes rows written by the wrapper carry the additive source field', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-cwd-'));
    try {
      // Fresh route-capture sentinel supplies a reliable agent so WS2b writes.
      fs.mkdirSync(path.join(cwd, '.claude-flow'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.claude-flow', '.ruflo-route.json'),
        JSON.stringify({ agent: 'coder', task: 'implement the endpoint', ts: new Date().toISOString() }));
      run(cwd, bin, { argv: ['0.8'] });
      const store = JSON.parse(fs.readFileSync(path.join(cwd, '.claude-flow', 'routing-outcomes.json'), 'utf8'));
      expect(store.outcomes.length).toBe(1);
      expect(store.outcomes[0].agent).toBe('coder');
      expect(store.outcomes[0].source).toBe('stop-hook-post-task');
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
});
