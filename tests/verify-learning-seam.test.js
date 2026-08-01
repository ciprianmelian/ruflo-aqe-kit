/**
 * Tests for verify-learning.sh probe #11 — the sona-seam sentinel probe
 * (SEAM-SENTINEL-V1). The SONA learning loop is closed by two kit dist patches on
 * the INSTALLED global ruflo: SONA-TRAIN-V1 (memory/intelligence.js) and
 * RUFLO-LORA-ADAPT-V1 (mcp-tools/hooks-tools.js). If a ruflo upgrade wipes either,
 * the JS LoRA arm silently reverts to write-only and the older #3 tripwire stays
 * green (training also stops, so totalUpdates freezes). This probe asserts the
 * seams directly by grepping the dist.
 *
 * Strategy: the probe reads the GLOBAL dist, resolved via KIT_RUFLO_DIST_SRC (a
 * test-only override) else `npm root -g`. We point it at throwaway fixture dist
 * dirs to exercise PASS / FAIL / not-assessable deterministically, over a HEALTHY
 * target so the seam verdict is the only variable — never touching the real global.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const VERIFY = path.join(REPO, 'lib', 'verify-learning.sh');

function sqlite(db, sql) {
  const r = spawnSync('sqlite3', [db, sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sqlite3 failed: ${r.stderr || r.stdout}`);
}

// Deterministic stub for the CLI the other probes consult (useNativeHNSW on)
// so only the seam probe can drive the verdict here.
//
// HERMETICITY-V1 (closes a gap the B24-DAEMON-SCOPE-V1 critic flagged): this
// used to also fake a `ruflo daemon status` binary, but that's dead code —
// probe_daemon_advisory hasn't shelled out to `ruflo` since B24 (it's pgrep/ps
// via kit_daemon_ps_lines / kit_daemon_scope_split now, see lib/common.sh and
// lib/verify-learning.sh). Without a `pgrep`/`ps` stub this suite fell through
// to the REAL system process table on every run — on a dev host running a
// second kit-managed project's daemon, that's a live, non-deterministic extra
// probe result this suite never intended to exercise. Faked deterministically
// to NO DAEMON here, mirroring the convention in tests/verify-learning.test.js
// (whose stubBin's default 'stopped' case fakes pgrep to always exit 1).
function stubBin() {
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'vlseambin-'));
  fs.writeFileSync(path.join(b, 'aqe'),
    '#!/usr/bin/env bash\nif [ "$1" = ruvector ] && [ "$2" = status ]; then echo "  useNativeHNSW: true (set)"; fi\nexit 0\n');
  fs.writeFileSync(path.join(b, 'pgrep'), '#!/usr/bin/env bash\nexit 1\n');
  fs.chmodSync(path.join(b, 'aqe'), 0o755);
  fs.chmodSync(path.join(b, 'pgrep'), 0o755);
  return b;
}

// A HEALTHY target: reflexion store populated, lora engaged, hnsw on, graph+sona
// non-empty — so every probe EXCEPT #11 passes and the seam probe alone decides.
function mkHealthyTarget() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vlseam-'));
  fs.mkdirSync(path.join(d, '.swarm'), { recursive: true });
  fs.mkdirSync(path.join(d, '.agentic-qe'), { recursive: true });
  sqlite(path.join(d, '.swarm', 'memory.db'),
    'CREATE TABLE memory_entries(id INTEGER); INSERT INTO memory_entries VALUES (1),(2),(3);' +
    'CREATE TABLE graph_edges(id INTEGER); INSERT INTO graph_edges VALUES (1);');
  sqlite(path.join(d, 'agentdb.db'),
    'CREATE TABLE episodes(id INTEGER); INSERT INTO episodes VALUES (1),(2);' +
    'CREATE TABLE skills(id INTEGER); INSERT INTO skills VALUES (1);');
  sqlite(path.join(d, '.agentic-qe', 'memory.db'),
    'CREATE TABLE vectors(dimensions INTEGER, embedding BLOB); INSERT INTO vectors VALUES (384, zeroblob(1536));' +
    'CREATE TABLE sona_patterns(id INTEGER); INSERT INTO sona_patterns VALUES (1);' +
    'CREATE TABLE routing_outcomes(id INTEGER); INSERT INTO routing_outcomes VALUES (1);');
  fs.writeFileSync(path.join(d, '.agentic-qe', 'config.yaml'),
    'learning:\n  hnswConfig:\n    useNativeHNSW: true\n');
  fs.writeFileSync(path.join(d, '.swarm', 'lora-weights.json'),
    JSON.stringify({ stats: { totalUpdates: 100, totalAdaptations: 7 } }));
  return d;
}

// Build a fixture dist-src tree; each sentinel present only when requested.
function mkDistSrc({ sona = true, lora = true } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vlseamdist-'));
  fs.mkdirSync(path.join(d, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(d, 'mcp-tools'), { recursive: true });
  fs.writeFileSync(path.join(d, 'memory', 'intelligence.js'),
    sona ? '// SONA-TRAIN-V1 marker\nmodule.exports = {};\n' : '// upgrade wiped the patch\nmodule.exports = {};\n');
  fs.writeFileSync(path.join(d, 'mcp-tools', 'hooks-tools.js'),
    lora ? '// RUFLO-LORA-ADAPT-V1 marker\nmodule.exports = {};\n' : '// upgrade wiped the patch\nmodule.exports = {};\n');
  return d;
}

// Probe #13 (EMBEDDER-LIVENESS-V1) DRIVES a real embedder. Left to resolve
// `npm root -g`, its verdict — and therefore this file's pinned counts — would
// depend on whether the host happens to have @huggingface/transformers. Pin it
// to a stub that returns a dense unit vector so the count stays deterministic.
let _embStub = null;
function embedderStub() {
  if (_embStub) return _embStub;
  _embStub = fs.mkdtempSync(path.join(os.tmpdir(), 'vlseam-emb-'));
  const d = path.join(_embStub, 'agentic-qe', 'dist', 'learning');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(d, 'real-embeddings.js'), `
export async function computeRealEmbedding() {
  const n = 384, v = new Array(n);
  for (let i = 0; i < n; i++) v[i] = Math.sin((i + 1) * 7.13) + 0.5;
  const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / m);
}
`);
  return _embStub;
}

function runVerify(target, distSrc, extra = []) {
  const b = stubBin();
  const env = { ...process.env, PATH: `${b}:${process.env.PATH}`, KIT_VL_AQE_BASE: embedderStub() };
  if (distSrc === null) {
    // Force not-assessable: point at a path with no dist files.
    env.KIT_RUFLO_DIST_SRC = path.join(os.tmpdir(), 'vlseam-nonexistent-' + Date.now());
  } else if (distSrc !== undefined) {
    env.KIT_RUFLO_DIST_SRC = distSrc;
  }
  const r = spawnSync('bash', [VERIFY, target, ...extra], { encoding: 'utf8', timeout: 20000, env });
  fs.rmSync(b, { recursive: true, force: true });
  return r;
}
function parseJson(stdout) {
  return JSON.parse(stdout.trim().split('\n').filter(Boolean).pop());
}

describe('verify-learning #11: sona-seam sentinels (SEAM-SENTINEL-V1)', () => {
  let target;
  beforeAll(() => { target = mkHealthyTarget(); });
  afterAll(() => fs.rmSync(target, { recursive: true, force: true }));

  it('PASSES when both sentinels are present in the dist (healthy loop stays live)', () => {
    const dist = mkDistSrc({ sona: true, lora: true });
    const r = runVerify(target, dist);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/sona-seam sentinels present in installed dist/);
    expect(parseJson(runVerify(target, dist, ['--json']).stdout).fail).toBe(0);
    fs.rmSync(dist, { recursive: true, force: true });
  });

  // HERMETICITY-V1 teeth: the deterministic `pgrep` stub in stubBin() (above)
  // is itself untested unless something asserts on its effect — delete it and
  // every OTHER test in this describe block stays green, because none of them
  // look at `info` or daemon wording. This test exists ONLY to catch that: it
  // pins the exact `info` count AND the absence of every probe_daemon_advisory
  // wording template (MINE/OTHER/UNKNOWN — lib/verify-learning.sh
  // probe_daemon_advisory) for this fixture. Verified by hand: removing the
  // `pgrep` stub on a host running a real stray ruflo daemon (this dev
  // machine, PID 29640 for an unrelated project) flips this exact assertion
  // red — see the B24-DAEMON-SCOPE-V1 hermeticity fix. If `info` ever changes,
  // that is real signal (either this suite is reading host state again, or an
  // unrelated probe's info/note count shifted) — investigate and re-pin the
  // new deterministic value; do NOT loosen this to a range or drop it.
  it('HERMETICITY: pins the exact info count and the absence of any daemon note (teeth for the pgrep stub)', () => {
    const dist = mkDistSrc({ sona: true, lora: true });
    const j = parseJson(runVerify(target, dist, ['--json']).stdout);
    // 2 -> 3: probe #14 (CAPTURE-DIVERSITY-V1) emits one not-assessable note on
    // this fixture's empty pool (needs >=50 eligible rows to judge diversity).
    expect(j.info).toBe(3);
    const human = runVerify(target, dist).stdout;
    expect(human).not.toMatch(/running for THIS target|running for a DIFFERENT workspace|no --workspace visible in argv/);
    fs.rmSync(dist, { recursive: true, force: true });
  });

  it('FAILS (verdict hollow, exit 1) when SONA-TRAIN-V1 is missing from intelligence.js', () => {
    const dist = mkDistSrc({ sona: false, lora: true });
    const r = runVerify(target, dist);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/SENTINEL MISSING.*SONA-TRAIN-V1\(intelligence\.js\)/);
    expect(r.stdout).toMatch(/fix-ruflo/);
    expect(parseJson(runVerify(target, dist, ['--json']).stdout).verdict).toBe('hollow');
    fs.rmSync(dist, { recursive: true, force: true });
  });

  it('FAILS when RUFLO-LORA-ADAPT-V1 is missing from hooks-tools.js', () => {
    const dist = mkDistSrc({ sona: true, lora: false });
    const r = runVerify(target, dist);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/SENTINEL MISSING.*RUFLO-LORA-ADAPT-V1\(hooks-tools\.js\)/);
    fs.rmSync(dist, { recursive: true, force: true });
  });

  it('WARNS not-assessable (never FAIL) when no installed dist is found', () => {
    const r = runVerify(target, null);
    expect(r.status).toBe(0); // WARN keeps the loop live/partial, not hollow
    expect(r.stdout).toMatch(/sona-seam sentinels not assessable/);
    const j = parseJson(runVerify(target, null, ['--json']).stdout);
    expect(j.fail).toBe(0);
    expect(j.verdict).not.toBe('hollow');
  });

  it('passes against the REAL installed dist (when the global ruflo is patched)', () => {
    // (a) from the task: the probe must pass against the real installed dist.
    const g = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout.trim();
    if (!g) return; // no global toolchain on this machine — nothing to assert
    const realSrc = path.join(g, 'ruflo', 'node_modules', '@claude-flow', 'cli', 'dist', 'src');
    const intel = path.join(realSrc, 'memory', 'intelligence.js');
    const ht = path.join(realSrc, 'mcp-tools', 'hooks-tools.js');
    const patched = fs.existsSync(intel) && fs.existsSync(ht) &&
      /SONA-TRAIN-V1/.test(fs.readFileSync(intel, 'utf8')) &&
      /RUFLO-LORA-ADAPT-V1/.test(fs.readFileSync(ht, 'utf8'));
    if (!patched) return; // prerequisite absent (unpatched/offline) — the FAIL/WARN branches cover those
    const r = runVerify(target, realSrc);
    expect(r.stdout).toMatch(/sona-seam sentinels present in installed dist/);
    expect(r.status).toBe(0);
  });
});
