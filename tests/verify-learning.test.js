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
function runVerify(target, extra = []) {
  return spawnSync('bash', [VERIFY, target, ...extra], { encoding: 'utf8', timeout: 20000 });
}
function mkTarget() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-'));
  fs.mkdirSync(path.join(d, '.swarm'), { recursive: true });
  fs.mkdirSync(path.join(d, '.agentic-qe'), { recursive: true });
  return d;
}

// Hollow fixture: memory_entries populated, every structured table empty; lora in
// JS fallback; vectors present but useNativeHNSW unset → #2/#3/#4 must FAIL.
function buildHollow(d) {
  sqlite(path.join(d, '.swarm', 'memory.db'),
    'CREATE TABLE memory_entries(id INTEGER); INSERT INTO memory_entries VALUES (1),(2),(3);' +
    'CREATE TABLE episodes(id INTEGER); CREATE TABLE skills(id INTEGER); CREATE TABLE patterns(id INTEGER);' +
    'CREATE TABLE causal_edges(id INTEGER); CREATE TABLE reasoning_patterns(id INTEGER);' +
    'CREATE TABLE learning_experiences(id INTEGER); CREATE TABLE graph_edges(id INTEGER);');
  sqlite(path.join(d, '.agentic-qe', 'memory.db'),
    'CREATE TABLE vectors(dimensions INTEGER, embedding BLOB); INSERT INTO vectors VALUES (384, zeroblob(1536));' +
    'CREATE TABLE sona_patterns(id INTEGER); CREATE TABLE routing_outcomes(id INTEGER);');
  fs.writeFileSync(path.join(d, '.agentic-qe', 'config.yaml'),
    'learning:\n  hnswConfig:\n    M: 8\n    efConstruction: 100\n');
  fs.writeFileSync(path.join(d, '.swarm', 'lora-weights.json'),
    JSON.stringify({ stats: { totalUpdates: 100, totalAdaptations: 0 } }));
}

// Healthy fixture: structured tables populated, lora engaged, useNativeHNSW set,
// graph + sona non-empty → verdict must NOT be hollow.
function buildHealthy(d) {
  sqlite(path.join(d, '.swarm', 'memory.db'),
    'CREATE TABLE memory_entries(id INTEGER); INSERT INTO memory_entries VALUES (1),(2),(3);' +
    'CREATE TABLE episodes(id INTEGER); INSERT INTO episodes VALUES (1),(2);' +
    'CREATE TABLE skills(id INTEGER); CREATE TABLE patterns(id INTEGER);' +
    'CREATE TABLE causal_edges(id INTEGER); CREATE TABLE reasoning_patterns(id INTEGER);' +
    'CREATE TABLE learning_experiences(id INTEGER);' +
    'CREATE TABLE graph_edges(id INTEGER); INSERT INTO graph_edges VALUES (1);');
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

  it('--json emits a pure JSON object with verdict "hollow" and 3 fails', () => {
    const r = runVerify(d, ['--json']);
    expect(r.status).toBe(1);
    const j = parseJson(r.stdout);
    expect(j.verdict).toBe('hollow');
    expect(j.fail).toBe(3); // #2 controllers, #3 lora, #4 hnsw
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
