/**
 * Tests for lib/verify-learning.sh + the assert_vector_dim_ok helper in
 * lib/common.sh (GitHub issue #4 — "enabled-but-hollow" detection).
 *
 * Strategy: build throwaway sqlite fixtures with the sqlite3 CLI, then spawn the
 * real script against each fixture target dir. Asserts on exit status + the
 * --json verdict, so we prove the fail-loud contract without touching real
 * runtime stores. The whole point of issue #4 is "trust committed disk, not MCP
 * self-reports" — so these fixtures ARE committed sqlite rows.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const VERIFY = path.join(REPO, 'lib', 'verify-learning.sh');
const COMMON = path.join(REPO, 'lib', 'common.sh');

function sqlite(db, sql) {
  const r = spawnSync('sqlite3', [db, sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sqlite3 failed: ${r.stderr || r.stdout}`);
}
// Deterministic stubs for the two CLIs the probes consult: `aqe ruvector status`
// (the authoritative #4 oracle) and `ruflo daemon status` (the advisory). This
// decouples tests from the ambient global flag store / a live daemon.
function stubBin({ hnsw = 'true', daemon = 'stopped' } = {}) {
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'vlbin-'));
  fs.writeFileSync(path.join(b, 'aqe'),
    `#!/usr/bin/env bash\nif [ "$1" = ruvector ] && [ "$2" = status ]; then echo "  useNativeHNSW: ${hnsw} (set)"; fi\nexit 0\n`);
  fs.writeFileSync(path.join(b, 'ruflo'),
    `#!/usr/bin/env bash\nif [ "$1" = daemon ] && [ "$2" = status ]; then echo "Status: ${daemon}"; fi\nexit 0\n`);
  fs.chmodSync(path.join(b, 'aqe'), 0o755);
  fs.chmodSync(path.join(b, 'ruflo'), 0o755);
  return b;
}
// A known-good dist stub carrying BOTH sona-seam sentinels, so probe #11
// (probe_seam_sentinels) is PINNED to PASS here regardless of the live global's
// patch state. These fixtures are about issue #4 hollow detection, not the seam
// probe; a dedicated suite (verify-learning-seam.test.js) exercises #11's PASS/
// FAIL/not-assessable branches. Without this pin the #4 tests would couple to
// whether the machine's global ruflo happens to be patched.
function goodDistSrc() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vldist-'));
  fs.mkdirSync(path.join(d, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(d, 'mcp-tools'), { recursive: true });
  fs.writeFileSync(path.join(d, 'memory', 'intelligence.js'), '// SONA-TRAIN-V1\n');
  fs.writeFileSync(path.join(d, 'mcp-tools', 'hooks-tools.js'), '// RUFLO-LORA-ADAPT-V1\n');
  return d;
}
function runVerify(target, extra = [], stub = {}) {
  const b = stubBin(stub);
  const dist = goodDistSrc();
  const r = spawnSync('bash', [VERIFY, target, ...extra], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, PATH: `${b}:${process.env.PATH}`, KIT_RUFLO_DIST_SRC: dist },
  });
  fs.rmSync(b, { recursive: true, force: true });
  fs.rmSync(dist, { recursive: true, force: true });
  return r;
}
function mkTarget() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-'));
  fs.mkdirSync(path.join(d, '.swarm'), { recursive: true });
  fs.mkdirSync(path.join(d, '.agentic-qe'), { recursive: true });
  return d;
}

// Hollow fixture: genuine session evidence exists (eligible captured_experiences
// + a session record) yet nothing was learned — structured tables empty, lora
// never applied. #2/#3 must FAIL. (Post-e2e semantics: hollow is judged against
// the actual harvest source and session records, not kit-seeded flat entries.)
function buildHollow(d) {
  sqlite(path.join(d, '.swarm', 'memory.db'),
    'CREATE TABLE memory_entries(id INTEGER); INSERT INTO memory_entries VALUES (1),(2),(3);' +
    'CREATE TABLE episodes(id INTEGER); CREATE TABLE skills(id INTEGER); CREATE TABLE patterns(id INTEGER);' +
    'CREATE TABLE causal_edges(id INTEGER); CREATE TABLE reasoning_patterns(id INTEGER);' +
    'CREATE TABLE learning_experiences(id INTEGER); CREATE TABLE graph_edges(id INTEGER);');
  sqlite(path.join(d, '.agentic-qe', 'memory.db'),
    'CREATE TABLE vectors(dimensions INTEGER, embedding BLOB); INSERT INTO vectors VALUES (384, zeroblob(1536));' +
    'CREATE TABLE sona_patterns(id INTEGER); CREATE TABLE routing_outcomes(id INTEGER);' +
    // The harvest source (tools/aqe-harvest.cjs filter): eligible rows that
    // SHOULD have produced agentdb.db episodes.
    'CREATE TABLE captured_experiences(task TEXT, success INTEGER, quality REAL, embedding BLOB);' +
    "INSERT INTO captured_experiences VALUES ('t1', 1, 0.9, zeroblob(4)), ('t2', 1, 0.8, zeroblob(4));");
  // A live session routed through the stack → lora ta=0 is a real failure here.
  fs.mkdirSync(path.join(d, '.claude-flow', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(d, '.claude-flow', 'sessions', 'session-1.json'), '{"endedAt":"2026-07-18T00:00:00Z"}');
  fs.writeFileSync(path.join(d, '.agentic-qe', 'config.yaml'),
    'learning:\n  hnswConfig:\n    M: 8\n    efConstruction: 100\n');
  fs.writeFileSync(path.join(d, '.swarm', 'lora-weights.json'),
    JSON.stringify({ stats: { totalUpdates: 100, totalAdaptations: 0 } }));
}

// Healthy fixture: reflexion store (agentdb.db) populated, lora engaged,
// useNativeHNSW set, graph + sona non-empty → verdict must NOT be hollow.
function buildHealthy(d) {
  sqlite(path.join(d, '.swarm', 'memory.db'),
    'CREATE TABLE memory_entries(id INTEGER); INSERT INTO memory_entries VALUES (1),(2),(3);' +
    'CREATE TABLE graph_edges(id INTEGER); INSERT INTO graph_edges VALUES (1);');
  // #2 reads the canonical reflexion store (agentdb.db episodes+skills), NOT .swarm.
  sqlite(path.join(d, 'agentdb.db'),
    'CREATE TABLE episodes(id INTEGER); INSERT INTO episodes VALUES (1),(2);' +
    'CREATE TABLE skills(id INTEGER); INSERT INTO skills VALUES (1);');
  sqlite(path.join(d, '.agentic-qe', 'memory.db'),
    'CREATE TABLE vectors(dimensions INTEGER, embedding BLOB); INSERT INTO vectors VALUES (384, zeroblob(1536));' +
    'CREATE TABLE sona_patterns(id INTEGER); INSERT INTO sona_patterns VALUES (1);' +
    'CREATE TABLE routing_outcomes(id INTEGER); INSERT INTO routing_outcomes VALUES (1);');
  fs.writeFileSync(path.join(d, '.agentic-qe', 'config.yaml'),
    'learning:\n  hnswConfig:\n    M: 8\n    useNativeHNSW: true\n');
  fs.writeFileSync(path.join(d, '.swarm', 'lora-weights.json'),
    JSON.stringify({ stats: { totalUpdates: 100, totalAdaptations: 7 } }));
}

function parseJson(stdout) {
  const line = stdout.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(line);
}

describe('verify-learning: hollow detection (issue #4 #2/#3/#4)', () => {
  let d;
  beforeAll(() => { d = mkTarget(); buildHollow(d); });
  afterAll(() => fs.rmSync(d, { recursive: true, force: true }));

  it('exits 1 (fail-loud) on an enabled-but-hollow loop', () => {
    expect(runVerify(d).status).toBe(1);
  });

  it('--json verdict "hollow" with 2 fails (#2 controllers, #3 lora) when HNSW flag is on', () => {
    // useNativeHNSW is ON by default in the ruvector flags store, so #4 must NOT
    // fail merely because config.yaml lacks the key (the original false-positive).
    const r = runVerify(d, ['--json'], { hnsw: 'true' });
    expect(r.status).toBe(1);
    const j = parseJson(r.stdout);
    expect(j.verdict).toBe('hollow');
    expect(j.fail).toBe(2);
  });

  it('#4 FAILS only when useNativeHNSW is EXPLICITLY false (then 3 fails)', () => {
    const r = runVerify(d, ['--json'], { hnsw: 'false' });
    expect(parseJson(r.stdout).fail).toBe(3);
    expect(runVerify(d, [], { hnsw: 'false' }).stdout).toMatch(/HNSW native backend DISABLED/);
  });

  it('warns (non-fatal) when the ruflo daemon is RUNNING', () => {
    const r = runVerify(d, [], { daemon: 'RUNNING' });
    expect(r.stdout).toMatch(/daemon is RUNNING/);
    expect(r.status).toBe(1); // still hollow; the daemon note never changes the verdict
  });

  it('--json stdout is a single clean JSON line (no ANSI/probe leakage)', () => {
    const r = runVerify(d, ['--json']);
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\{.*\}$/);
    expect(r.stdout).not.toMatch(/\[/); // no color escapes
  });
});

describe('verify-learning: healthy loop', () => {
  let d;
  beforeAll(() => { d = mkTarget(); buildHealthy(d); });
  afterAll(() => fs.rmSync(d, { recursive: true, force: true }));

  it('exits 0 and verdict is not hollow', () => {
    const r = runVerify(d, ['--json']);
    expect(r.status).toBe(0);
    expect(parseJson(r.stdout).verdict).not.toBe('hollow');
    expect(parseJson(r.stdout).fail).toBe(0);
  });
});

// #2 measures the CANONICAL reflexion store (agentdb.db), NOT .swarm/memory.db
// (which is hollow by design). This guards the gap-#2 store-divergence fix.
describe('verify-learning: #2 reads agentdb.db, not .swarm', () => {
  function base(d) {
    sqlite(path.join(d, '.swarm', 'memory.db'),
      'CREATE TABLE memory_entries(id INTEGER); INSERT INTO memory_entries VALUES (1),(2);' +
      'CREATE TABLE graph_edges(id INTEGER); INSERT INTO graph_edges VALUES (1);');
    sqlite(path.join(d, '.agentic-qe', 'memory.db'),
      'CREATE TABLE vectors(dimensions INTEGER, embedding BLOB); INSERT INTO vectors VALUES (384, zeroblob(1536));' +
      'CREATE TABLE sona_patterns(id INTEGER); INSERT INTO sona_patterns VALUES (1);' +
      'CREATE TABLE routing_outcomes(id INTEGER);');
    fs.writeFileSync(path.join(d, '.agentic-qe', 'config.yaml'), 'learning:\n  hnswConfig:\n    useNativeHNSW: true\n');
    fs.writeFileSync(path.join(d, '.swarm', 'lora-weights.json'), JSON.stringify({ stats: { totalUpdates: 5, totalAdaptations: 9 } }));
  }

  it('OK when agentdb.db has episodes even though .swarm structured tables are empty', () => {
    const d = mkTarget(); base(d);
    sqlite(path.join(d, 'agentdb.db'), 'CREATE TABLE episodes(id INTEGER); INSERT INTO episodes VALUES (1),(2),(3); CREATE TABLE skills(id INTEGER);');
    const r = runVerify(d);
    expect(r.stdout).toMatch(/reflexion store populated \(agentdb\.db: 3 episodes/);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('HOLLOW (points at harvest) when agentdb.db is absent but harvestable experiences exist — .swarm episodes are NOT counted', () => {
    const d = mkTarget(); base(d);
    // Put episodes in the WRONG store (.swarm/memory.db) — must be IGNORED for #2.
    spawnSync('sqlite3', [path.join(d, '.swarm', 'memory.db'),
      'CREATE TABLE episodes(id INTEGER); INSERT INTO episodes VALUES (1),(2);'], { encoding: 'utf8' });
    // Eligible harvest input exists → the empty canonical store is a real defect.
    sqlite(path.join(d, '.agentic-qe', 'memory.db'),
      'CREATE TABLE captured_experiences(task TEXT, success INTEGER, quality REAL, embedding BLOB);' +
      "INSERT INTO captured_experiences VALUES ('t', 1, 0.95, zeroblob(4));");
    // No agentdb.db created → the canonical reflexion store is genuinely empty.
    const r = runVerify(d);
    expect(r.stdout).toMatch(/reflexion store HOLLOW.*ruflo-kit harvest/);
    expect(r.status).toBe(1);
    fs.rmSync(d, { recursive: true, force: true });
  });
});

// Fresh post-setup target (first fresh-target e2e, 2026-07-18): the kit's own
// init/pretrain seeds flat memory_entries and neural-train writes lora updates,
// but NO session has captured experiences or routed through the adapter yet.
// That state is "primed", NOT hollow — setup must be able to PROVE it.
describe('verify-learning: fresh post-setup target is primed, not hollow', () => {
  let d;
  beforeAll(() => {
    d = mkTarget();
    sqlite(path.join(d, '.swarm', 'memory.db'),
      'CREATE TABLE memory_entries(id INTEGER); INSERT INTO memory_entries VALUES (1),(2),(3),(4),(5);' +
      'CREATE TABLE graph_edges(id INTEGER); INSERT INTO graph_edges VALUES (1);');
    sqlite(path.join(d, '.agentic-qe', 'memory.db'),
      'CREATE TABLE vectors(dimensions INTEGER, embedding BLOB); INSERT INTO vectors VALUES (384, zeroblob(1536));' +
      'CREATE TABLE sona_patterns(id INTEGER); INSERT INTO sona_patterns VALUES (1);' +
      'CREATE TABLE routing_outcomes(id INTEGER); INSERT INTO routing_outcomes VALUES (1);' +
      // Experience table exists but has nothing harvest-eligible yet.
      'CREATE TABLE captured_experiences(task TEXT, success INTEGER, quality REAL, embedding BLOB);' +
      "INSERT INTO captured_experiences VALUES ('low-quality', 1, 0.2, zeroblob(4)), ('failed', 0, 0.9, zeroblob(4));");
    fs.writeFileSync(path.join(d, '.agentic-qe', 'config.yaml'), 'learning:\n  hnswConfig:\n    useNativeHNSW: true\n');
    // Bootstrap neural-train wrote updates; the adapter was never applied — and
    // there are no session records, so this must NOT be called a JS fallback.
    fs.writeFileSync(path.join(d, '.swarm', 'lora-weights.json'),
      JSON.stringify({ stats: { totalUpdates: 200, totalAdaptations: 0 } }));
  });
  afterAll(() => fs.rmSync(d, { recursive: true, force: true }));

  it('exits 0 with no FAILs (proof P10 maps live|partial → PASS)', () => {
    const r = runVerify(d, ['--json']);
    expect(r.status).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.verdict).not.toBe('hollow');
    expect(j.fail).toBe(0);
  });

  it('names the primed states honestly (no false JS-FALLBACK / HOLLOW claims)', () => {
    const r = runVerify(d);
    expect(r.stdout).toMatch(/reflexion store not yet populated/);
    expect(r.stdout).toMatch(/lora trainer primed/);
    expect(r.stdout).not.toMatch(/JS FALLBACK/);
  });

  it('flips to HOLLOW the moment a session captures an eligible experience that is never harvested (embedding-less rows count — HARVEST-VECLESS-V1)', () => {
    // aqe 3.12.2 captures experiences with embedding=NULL; harvest's reflexion
    // sink consumes them anyway, so they are harvestable and must arm the tripwire.
    sqlite(path.join(d, '.agentic-qe', 'memory.db'),
      "INSERT INTO captured_experiences VALUES ('real work', 1, 0.9, NULL);");
    fs.mkdirSync(path.join(d, '.claude-flow', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(d, '.claude-flow', 'sessions', 'session-9.json'), '{}');
    const r = runVerify(d, ['--json']);
    expect(r.status).toBe(1);
    expect(parseJson(r.stdout).verdict).toBe('hollow');
  });
});

describe('assert_vector_dim_ok dimension guard (issue #4 #6)', () => {
  function guard(db, table, col, dimc, exp) {
    const r = spawnSync('bash', ['-c',
      `source "${COMMON}"; assert_vector_dim_ok "${db}" "${table}" "${col}" "${dimc}" "${exp}"`],
      { encoding: 'utf8' });
    return r.stdout.trim();
  }
  let d;
  beforeAll(() => {
    d = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-'));
    sqlite(path.join(d, 'ok.db'), 'CREATE TABLE vectors(dimensions INTEGER, embedding BLOB); INSERT INTO vectors VALUES (384, zeroblob(1536));');
    sqlite(path.join(d, 'baddim.db'), 'CREATE TABLE vectors(dimensions INTEGER, embedding BLOB); INSERT INTO vectors VALUES (1536, zeroblob(1536));');
    sqlite(path.join(d, 'badblob.db'), 'CREATE TABLE vectors(dimensions INTEGER, embedding BLOB); INSERT INTO vectors VALUES (384, zeroblob(999));');
    sqlite(path.join(d, 'empty.db'), 'CREATE TABLE vectors(dimensions INTEGER, embedding BLOB);');
  });
  afterAll(() => fs.rmSync(d, { recursive: true, force: true }));

  it('OK when dimensions==384 and blob==dim*4', () => {
    expect(guard(path.join(d, 'ok.db'), 'vectors', 'embedding', 'dimensions', '384')).toBe('OK');
  });
  it('DIM_MISMATCH when declared dimension != expected (the issue\'s 1536 misread, now guarded)', () => {
    expect(guard(path.join(d, 'baddim.db'), 'vectors', 'embedding', 'dimensions', '384')).toMatch(/^DIM_MISMATCH:1536/);
  });
  it('BLOB_MISMATCH when blob bytes != dimensions*4', () => {
    expect(guard(path.join(d, 'badblob.db'), 'vectors', 'embedding', 'dimensions', '384')).toMatch(/^BLOB_MISMATCH:/);
  });
  it('EMPTY on a zero-row table', () => {
    expect(guard(path.join(d, 'empty.db'), 'vectors', 'embedding', 'dimensions', '384')).toBe('EMPTY');
  });
  it('NO_TABLE on a missing db / table', () => {
    expect(guard(path.join(d, 'nope.db'), 'vectors', 'embedding', 'dimensions', '384')).toBe('NO_TABLE');
  });
});
