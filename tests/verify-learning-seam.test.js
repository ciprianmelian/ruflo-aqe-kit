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

// Deterministic stubs for the CLIs the other probes consult (useNativeHNSW on,
// daemon stopped) so only the seam probe can drive the verdict here.
function stubBin() {
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'vlseambin-'));
  fs.writeFileSync(path.join(b, 'aqe'),
    '#!/usr/bin/env bash\nif [ "$1" = ruvector ] && [ "$2" = status ]; then echo "  useNativeHNSW: true (set)"; fi\nexit 0\n');
  fs.writeFileSync(path.join(b, 'ruflo'),
    '#!/usr/bin/env bash\nif [ "$1" = daemon ] && [ "$2" = status ]; then echo "Status: stopped"; fi\nexit 0\n');
  fs.chmodSync(path.join(b, 'aqe'), 0o755);
  fs.chmodSync(path.join(b, 'ruflo'), 0o755);
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

function runVerify(target, distSrc, extra = []) {
  const b = stubBin();
  const env = { ...process.env, PATH: `${b}:${process.env.PATH}` };
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
