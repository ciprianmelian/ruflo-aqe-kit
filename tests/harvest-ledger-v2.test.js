/**
 * Tests for tools/aqe-harvest.cjs — HARVEST-LEDGER-V2 + HARVEST-DEDUPE-V1.
 *
 * v1 wrote EVERY fresh row's id into the ledger's `ids` regardless of whether
 * Sink A trained it, and `ids` is the sole eligibility filter — so a row that
 * produced no vector was consumed forever and could never train, even after the
 * embedder was repaired. Measured when this landed: 957 such rows on this repo,
 * 589 on the gauntlet target.
 *
 * v2 splits the outcome three ways:
 *   trained   -> ids           (text digest recorded in trainedTexts)
 *   redundant -> ids           TERMINAL — a duplicate text is a duplicate forever
 *   deferred  -> pendingSinkA  RETRIED — no vector YET; a fixed embedder helps
 *
 * DEDUPE exists because Sink A's objective is adapter.train(v, v, quality), a
 * reconstruction where input === target: the 2nd..Nth presentation of an
 * identical vector adds no information and only reweights one direction. A
 * target whose capture hook wrote 3137 identical content-free rows had
 * accumulated 5611 updates on ~1 direction before this guard existed.
 *
 * TEETH: the pre-fix tool is pinned to an explicit SHA, never `HEAD` — a
 * HEAD-pinned fixture expires the instant the fix it proves is committed.
 */
'use strict';

const { spawnSync, execFileSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const TOOL = path.join(REPO, 'tools', 'aqe-harvest.cjs');
const DIM = 8;

/** Pre-fix baseline. MUST stay reachable: `git show <SHA>:tools/aqe-harvest.cjs`. */
const PRE_V2_REF = 'becbeb2';

function findBetterSqlite3() {
  const candidates = [];
  try {
    const g = execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).toString().trim();
    candidates.push(
      path.join(g, 'agentic-qe', 'node_modules', 'better-sqlite3'),
      path.join(g, 'better-sqlite3'),
      path.join(g, 'ruflo', 'node_modules', 'better-sqlite3'),
    );
  } catch (e) {}
  for (const c of candidates) { try { require(c); return c; } catch (e) {} }
  return null;
}
const BSQL = findBetterSqlite3();
const suite = BSQL ? describe : describe.skip;
if (!BSQL) console.warn('[harvest-ledger-v2.test] no loadable better-sqlite3 — suite skipped');

const tmps = [];
const mktmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });

function mkStubBase({ withEmbedder = true } = {}) {
  const base = mktmp('hlv2-base-');
  const bs = path.join(base, 'agentic-qe', 'node_modules', 'better-sqlite3');
  fs.mkdirSync(bs, { recursive: true });
  fs.writeFileSync(path.join(bs, 'package.json'), JSON.stringify({ name: 'better-sqlite3', main: 'index.js' }));
  fs.writeFileSync(path.join(bs, 'index.js'), `module.exports = require(${JSON.stringify(BSQL)});\n`);

  if (withEmbedder) {
    const emb = path.join(base, 'agentic-qe', 'dist', 'learning');
    fs.mkdirSync(emb, { recursive: true });
    fs.writeFileSync(path.join(emb, 'package.json'), JSON.stringify({ type: 'module' }));
    fs.writeFileSync(path.join(emb, 'real-embeddings.js'), `
import fs from 'fs';
export async function computeRealEmbedding(text) {
  fs.appendFileSync('embed-receipt.jsonl', JSON.stringify({ text }) + '\\n');
  return Array.from({ length: ${DIM} }, (_, i) => ((text.length % 13) + i + 1) / 100);
}
`);
  }

  const lad = path.join(base, 'ruflo', 'node_modules', '@claude-flow', 'cli', 'dist', 'src', 'ruvector');
  fs.mkdirSync(lad, { recursive: true });
  fs.writeFileSync(path.join(lad, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(lad, 'lora-adapter.js'), `
import fs from 'fs';
const calls = [];
const adapter = {
  config: { inputDim: ${DIM} },
  train(a, b, q) { calls.push({ dim: a.length, q }); },
  saveWeights() {
    fs.mkdirSync('.swarm', { recursive: true });
    fs.writeFileSync('.swarm/lora-weights.json', JSON.stringify({ stats: { totalUpdates: calls.length }, calls }));
  },
};
export async function getLoRAAdapter() { return adapter; }
`);

  const adb = path.join(base, 'ruflo', 'node_modules', 'agentdb', 'dist', 'src');
  fs.mkdirSync(adb, { recursive: true });
  fs.writeFileSync(path.join(adb, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(adb, 'index.js'), `
import fs from 'fs';
export class AgentDB {
  constructor() { this.episodes = 0; }
  async initialize() {}
  get reflexion() { return { storeEpisode: async () => { this.episodes++; } }; }
  get skills() { return { createSkill: async () => {} }; }
  async close() { fs.writeFileSync('agentdb-receipt.json', JSON.stringify({ episodes: this.episodes })); }
}
`);
  return base;
}

function mkProject(rows) {
  const proj = mktmp('hlv2-proj-');
  fs.mkdirSync(path.join(proj, '.agentic-qe'), { recursive: true });
  const Database = require(BSQL);
  const db = new Database(path.join(proj, '.agentic-qe', 'memory.db'));
  db.exec(`CREATE TABLE captured_experiences (
    id TEXT PRIMARY KEY, task TEXT NOT NULL, agent TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT '', success INTEGER NOT NULL DEFAULT 0,
    quality REAL NOT NULL DEFAULT 0.5, result_json TEXT, embedding BLOB)`);
  const ins = db.prepare('INSERT INTO captured_experiences (id, task, agent, domain, success, quality, result_json, embedding) VALUES (?,?,?,?,?,?,?,?)');
  for (const r of rows) {
    ins.run(r.id, r.task, r.agent || 'coder', r.domain || '', r.success === false ? 0 : 1,
      r.quality == null ? 0.9 : r.quality, r.result_json || '{}',
      r.embedding ? Buffer.from(r.embedding.buffer) : null);
  }
  db.close();
  return proj;
}

function runHarvest(proj, base, tool = TOOL) {
  const res = spawnSync(process.execPath, [tool], {
    cwd: proj, env: { ...process.env, KIT_HARVEST_NODE_BASE: base }, encoding: 'utf8', timeout: 60000,
  });
  let summary = null;
  try { summary = JSON.parse((res.stdout || '').trim().split('\n').pop()); } catch (e) {}
  return { ...res, summary };
}

/** The pre-fix tool, materialised from a pinned SHA. */
let preFixTool = null;
function preV2Tool() {
  if (preFixTool) return preFixTool;
  const src = execFileSync('git', ['show', `${PRE_V2_REF}:tools/aqe-harvest.cjs`], { cwd: REPO, encoding: 'utf8' });
  const d = mktmp('hlv2-prefix-');
  preFixTool = path.join(d, 'aqe-harvest.cjs');
  fs.writeFileSync(preFixTool, src);
  return preFixTool;
}

const readLedger = (proj) => JSON.parse(fs.readFileSync(path.join(proj, '.swarm', 'harvest-state.json'), 'utf8'));
const loraCalls = (proj) => JSON.parse(fs.readFileSync(path.join(proj, '.swarm', 'lora-weights.json'), 'utf8')).calls;
const vec = (fill) => new Float32Array(DIM).fill(fill);

suite('HARVEST-LEDGER-V2 — a row that never trained is deferred, not burned', () => {
  it('the pinned pre-fix baseline still contains the defect it is used to prove', () => {
    // A teeth test is worthless if its baseline silently stopped being buggy.
    const src = execFileSync('git', ['show', `${PRE_V2_REF}:tools/aqe-harvest.cjs`], { cwd: REPO, encoding: 'utf8' });
    expect(src).toMatch(/const newIds = \(ledger\.ids \|\| \[\]\)\.concat\(fresh\.map\(r => r\.id\)\)/);
    expect(src).not.toMatch(/pendingSinkA/);
  });

  it('defers a vecless row, then trains it on a later run once the embedder works', () => {
    const proj = mkProject([{ id: 'a1', task: 'implement retry backoff', domain: 'code', embedding: null }]);

    const r1 = runHarvest(proj, mkStubBase({ withEmbedder: false }));
    expect(r1.summary).toMatchObject({ trained: 0, deferredSinkA: 1, episodes: 1 });
    const l1 = readLedger(proj);
    expect(l1.v).toBe(2);
    expect(l1.pendingSinkA).toEqual(['a1']);
    expect(l1.ids).not.toContain('a1');          // NOT burned

    const r2 = runHarvest(proj, mkStubBase({ withEmbedder: true }));
    expect(r2.summary).toMatchObject({ trained: 1, trainedEmbeddedAtHarvest: 1, retriedSinkA: 1 });
    expect(r2.summary.episodes).toBe(0);         // Sink B skipped — no duplicate episode
    const l2 = readLedger(proj);
    expect(l2.ids).toContain('a1');
    expect(l2.pendingSinkA).toEqual([]);
  });

  it('TEETH: the pre-fix tool burns that same row — run 2 finds nothing fresh', () => {
    const proj = mkProject([{ id: 'a1', task: 'implement retry backoff', domain: 'code', embedding: null }]);
    const pre = preV2Tool();

    const r1 = runHarvest(proj, mkStubBase({ withEmbedder: false }), pre);
    expect(r1.summary.trained).toBe(0);
    expect(readLedger(proj).ids).toContain('a1');   // burned: consumed having trained nothing

    const r2 = runHarvest(proj, mkStubBase({ withEmbedder: true }), pre);
    expect(r2.summary).toMatchObject({ note: 'nothing fresh' });
    expect(r2.summary.trained).toBe(0);             // never trainable again
  });

  it('does not drop a fresh row when Sink A cannot run at all', () => {
    // Sink B already stored the episode; re-offering the row as fresh would
    // duplicate it, so it must land in pendingSinkA rather than vanish.
    const proj = mkProject([{ id: 'c1', task: 'no adapter available', domain: 'code', embedding: vec(0.3) }]);
    const base = mkStubBase({ withEmbedder: true });
    fs.rmSync(path.join(base, 'ruflo', 'node_modules', '@claude-flow'), { recursive: true, force: true });

    const r = runHarvest(proj, base);
    expect(r.summary.trained).toBe(0);
    const l = readLedger(proj);
    expect(l.pendingSinkA).toContain('c1');
    expect(l.ids).not.toContain('c1');
  });

  it('migrates a v1 ledger without re-harvesting or stranding it', () => {
    const proj = mkProject([{ id: 'm1', task: 'already consumed', domain: 'code', embedding: vec(0.5) }]);
    fs.mkdirSync(path.join(proj, '.swarm'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.swarm', 'harvest-state.json'),
      JSON.stringify({ ids: ['m1'], lastRowid: 1, updatedAt: '2026-01-01T00:00:00Z' }));

    const r = runHarvest(proj, mkStubBase());
    expect(r.summary).toMatchObject({ note: 'nothing fresh' });   // v1 ids still honoured
  });
});

suite('HARVEST-DEDUPE-V1 — identical embed text trains exactly once', () => {
  const dupRows = [
    { id: 'd1', task: 'edit: ', domain: 'code-intelligence', embedding: vec(0.2) },
    { id: 'd2', task: 'edit: ', domain: 'code-intelligence', embedding: vec(0.2) },
    { id: 'd3', task: 'edit: ', domain: 'code-intelligence', embedding: vec(0.2) },
  ];

  it('trains once and marks the rest redundant and TERMINAL', () => {
    const proj = mkProject(dupRows);
    const r = runHarvest(proj, mkStubBase());
    expect(r.summary).toMatchObject({ trained: 1, redundantSinkA: 2, freshConsumed: 3 });
    expect(loraCalls(proj)).toHaveLength(1);

    const l = readLedger(proj);
    expect(l.ids.sort()).toEqual(['d1', 'd2', 'd3']);   // all terminal
    expect(l.pendingSinkA).toEqual([]);
    expect(Object.keys(l.trainedTexts)).toHaveLength(1);

    // Redundant rows are never re-offered.
    expect(runHarvest(proj, mkStubBase()).summary).toMatchObject({ note: 'nothing fresh' });
  });

  it('TEETH: the pre-fix tool trains on all three identical vectors', () => {
    const proj = mkProject(dupRows);
    const r = runHarvest(proj, mkStubBase(), preV2Tool());
    expect(r.summary.trained).toBe(3);
    expect(loraCalls(proj)).toHaveLength(3);
  });

  it('dedupes ACROSS runs, not just within one', () => {
    const proj = mkProject([dupRows[0]]);
    expect(runHarvest(proj, mkStubBase()).summary.trained).toBe(1);

    // A later row with the same recipe text must not retrain.
    const Database = require(BSQL);
    const db = new Database(path.join(proj, '.agentic-qe', 'memory.db'));
    db.prepare('INSERT INTO captured_experiences (id, task, agent, domain, success, quality, result_json, embedding) VALUES (?,?,?,?,?,?,?,?)')
      .run('d9', 'edit: ', 'coder', 'code-intelligence', 1, 0.9, '{}', Buffer.from(vec(0.2).buffer));
    db.close();

    const r2 = runHarvest(proj, mkStubBase());
    expect(r2.summary).toMatchObject({ trained: 0, redundantSinkA: 1 });
    expect(readLedger(proj).ids).toContain('d9');
  });

  it('distinguishes the two skip reasons in a single run', () => {
    // Without this, "deferred" and "redundant" could be silently conflated and
    // every other test here would still pass.
    const proj = mkProject([
      { id: 's1', task: 'unique work item', domain: 'code', embedding: vec(0.4) },
      { id: 's2', task: 'unique work item', domain: 'code', embedding: vec(0.4) }, // duplicate text
      { id: 's3', task: 'vecless row', domain: 'code', embedding: null },          // no vector
    ]);
    const r = runHarvest(proj, mkStubBase({ withEmbedder: false }));
    expect(r.summary).toMatchObject({ trained: 1, redundantSinkA: 1, deferredSinkA: 1 });

    const l = readLedger(proj);
    expect(l.ids.sort()).toEqual(['s1', 's2']);   // trained + redundant are terminal
    expect(l.pendingSinkA).toEqual(['s3']);       // only the vecless row is retried
  });

  it('treats an all-zero derived vector as terminal, never training on it', () => {
    // computeRealEmbedding returns [0]*n for text it deems non-semantic and does
    // NOT throw, so an unguarded caller trains the adapter toward the origin.
    const base = mkStubBase({ withEmbedder: true });
    fs.writeFileSync(path.join(base, 'agentic-qe', 'dist', 'learning', 'real-embeddings.js'),
      `export async function computeRealEmbedding() { return new Array(${DIM}).fill(0); }\n`);
    const proj = mkProject([{ id: 'z1', task: '{"metrics":{"n":1}}', domain: 'x', embedding: null }]);

    const r = runHarvest(proj, base);
    expect(r.summary).toMatchObject({ trained: 0, degenerateSinkA: 1 });
    expect(loraCalls(proj)).toHaveLength(0);
    expect(readLedger(proj).ids).toContain('z1');      // terminal, not retried forever
    expect(readLedger(proj).pendingSinkA).toEqual([]);
  });
});
