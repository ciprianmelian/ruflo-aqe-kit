/**
 * Tests for tools/aqe-harvest.cjs — HARVEST-EMBED-V1.
 *
 * The capture paths write the experience row first and embed async-after; the
 * freshest rows lose that race and read embedding-NULL at harvest time. Because
 * the idempotency ledger consumes rows permanently, skipping them for Sink A
 * was a train-never even after upstream's lazy backfill filled the pool column.
 * HARVEST-EMBED-V1 derives the vector at harvest time with the exact upstream
 * recipe (`${domain}: ${task}`.slice(0,512) through real-embeddings.js) and
 * reports it honestly as `trainedEmbeddedAtHarvest`.
 *
 * Everything here runs against a stub toolchain tree via KIT_HARVEST_NODE_BASE
 * (KIT_RUFLO_DIST_SRC precedent) — no MiniLM model load, no network, no global
 * ruflo/aqe/agentdb. The ONE real dependency is better-sqlite3 (to author the
 * fixture pool and to be re-exported into the stub tree for the tool's read);
 * resolved from the global agentic-qe install, honest skip when absent.
 */
'use strict';

const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const TOOL = path.join(REPO, 'tools', 'aqe-harvest.cjs');
const DIM = 8; // stub adapter inputDim — keeps tests fast, exercises the same guard as 384

// ---- locate a real better-sqlite3 (fixture author + stub re-export target) ----
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
  for (const c of candidates) {
    try { require(c); return c; } catch (e) {}
  }
  return null;
}
const BSQL = findBetterSqlite3();
const suite = BSQL ? describe : describe.skip;
if (!BSQL) console.warn('[harvest-embed.test] no loadable better-sqlite3 found — suite skipped (install the global stack)');

// ---- stub toolchain tree ----
// Layout mirrors what the tool resolves under nodeBase:
//   agentic-qe/node_modules/better-sqlite3   (re-export of the real driver)
//   agentic-qe/dist/learning/real-embeddings.js   (deterministic DIM-dim embedder)
//   ruflo/node_modules/@claude-flow/cli/dist/src/ruvector/lora-adapter.js
//   ruflo/node_modules/agentdb/dist/src/index.js
// The adapter/agentdb stubs write receipts into the harvest cwd so assertions
// read disk evidence, not stub internals.
function mkStubBase({ withEmbedder = true, embedderDim = DIM } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harvemb-base-'));

  const bs = path.join(base, 'agentic-qe', 'node_modules', 'better-sqlite3');
  fs.mkdirSync(bs, { recursive: true });
  fs.writeFileSync(path.join(bs, 'package.json'), JSON.stringify({ name: 'better-sqlite3', main: 'index.js' }));
  fs.writeFileSync(path.join(bs, 'index.js'), `module.exports = require(${JSON.stringify(BSQL)});\n`);

  if (withEmbedder) {
    const emb = path.join(base, 'agentic-qe', 'dist', 'learning');
    fs.mkdirSync(emb, { recursive: true });
    fs.writeFileSync(path.join(emb, 'package.json'), JSON.stringify({ type: 'module' }));
    // Deterministic, text-dependent vector — enough to prove the recipe text
    // reaches the embedder (recorded in a receipt) and the result trains.
    fs.writeFileSync(path.join(emb, 'real-embeddings.js'), `
import fs from 'fs';
export async function computeRealEmbedding(text) {
  fs.appendFileSync('embed-receipt.jsonl', JSON.stringify({ text }) + '\\n');
  return Array.from({ length: ${embedderDim} }, (_, i) => ((text.length % 13) + i) / 100);
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
    fs.writeFileSync('.swarm/lora-weights.json',
      JSON.stringify({ stats: { totalUpdates: calls.length }, calls }));
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

// ---- fixture pool ----
// rows: [{ id, task, domain, quality, success, embedding: Float32Array|null }]
function mkProject(rows) {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'harvemb-proj-'));
  fs.mkdirSync(path.join(proj, '.agentic-qe'), { recursive: true });
  const Database = require(BSQL);
  const db = new Database(path.join(proj, '.agentic-qe', 'memory.db'));
  db.exec(`CREATE TABLE captured_experiences (
    id TEXT PRIMARY KEY, task TEXT NOT NULL, agent TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT '', success INTEGER NOT NULL DEFAULT 0,
    quality REAL NOT NULL DEFAULT 0.5, result_json TEXT, embedding BLOB)`);
  const ins = db.prepare(
    'INSERT INTO captured_experiences (id, task, agent, domain, success, quality, result_json, embedding) VALUES (?,?,?,?,?,?,?,?)');
  for (const r of rows) {
    ins.run(r.id, r.task, r.agent || 'coder', r.domain || '', r.success === false ? 0 : 1,
      r.quality, r.result_json || '{}', r.embedding ? Buffer.from(r.embedding.buffer) : null);
  }
  db.close();
  return proj;
}

function runHarvest(proj, base) {
  const res = spawnSync(process.execPath, [TOOL], {
    cwd: proj,
    env: { ...process.env, KIT_HARVEST_NODE_BASE: base },
    encoding: 'utf8',
    timeout: 60000,
  });
  let summary = null;
  try { summary = JSON.parse((res.stdout || '').trim().split('\n').pop()); } catch (e) {}
  return { ...res, summary };
}

const vec = (fill) => new Float32Array(DIM).fill(fill);

suite('HARVEST-EMBED-V1 — vecless rows train Sink A via a harvest-time derived vector', () => {
  it('derives, trains, and reports the vecless row (embedded row untouched, ineligible row filtered)', () => {
    const base = mkStubBase();
    const proj = mkProject([
      { id: 'has-vec', task: 'edit: a.ts', quality: 0.9, embedding: vec(0.5) },
      { id: 'no-vec', task: 'edit: b.ts', domain: 'test-generation', quality: 0.9, embedding: null },
      { id: 'low-q', task: 'edit: c.ts', quality: 0.3, embedding: null }, // below the harvest filter
    ]);
    const r = runHarvest(proj, base);
    expect(r.summary).toMatchObject({
      freshConsumed: 2, trained: 2, trainedEmbeddedAtHarvest: 1, episodes: 2,
    });
    // the derivation used the EXACT upstream recipe text
    const receipt = fs.readFileSync(path.join(proj, 'embed-receipt.jsonl'), 'utf8').trim();
    expect(JSON.parse(receipt)).toEqual({ text: 'test-generation: edit: b.ts' });
    // both vectors reached the adapter at the right dim
    const lora = JSON.parse(fs.readFileSync(path.join(proj, '.swarm', 'lora-weights.json'), 'utf8'));
    expect(lora.calls).toEqual([{ dim: DIM, q: 0.9 }, { dim: DIM, q: 0.9 }]);
  });

  // Crash-safety coverage ONLY: a harvest must not die on a missing embedder.
  // It deliberately does NOT assert that this is an acceptable steady state —
  // for seven weeks a permanently dead embedder produced a fully green suite
  // because nothing anywhere asserted the non-degraded state. What asserts it
  // now: verify-learning probe #13 (EMBEDDER-LIVENESS-V1), which drives the
  // embedder and fails on a dead one; and the vecless row is no longer BURNED
  // by the ledger either (HARVEST-LEDGER-V2, tests/harvest-ledger-v2.test.js).
  it('degrades the vecless row to SinkB-only when the embedder is unavailable — degraded path, NOT an acceptable steady state', () => {
    const base = mkStubBase({ withEmbedder: false });
    const proj = mkProject([
      { id: 'has-vec', task: 'edit: a.ts', quality: 0.9, embedding: vec(0.5) },
      { id: 'no-vec', task: 'edit: b.ts', quality: 0.9, embedding: null },
    ]);
    const r = runHarvest(proj, base);
    expect(r.summary).toMatchObject({
      freshConsumed: 2, trained: 1, trainedEmbeddedAtHarvest: 0, episodes: 2,
    });
    expect(r.stderr).toMatch(/HARVEST-EMBED-V1: embedder unavailable/);
  });

  it('refuses a wrong-dim derived vector (dim guard applies to derived vectors too)', () => {
    const base = mkStubBase({ embedderDim: DIM + 3 });
    const proj = mkProject([
      { id: 'no-vec', task: 'edit: b.ts', quality: 0.9, embedding: null },
    ]);
    const r = runHarvest(proj, base);
    expect(r.summary).toMatchObject({
      freshConsumed: 1, trained: 0, trainedEmbeddedAtHarvest: 0, episodes: 1,
    });
  });

  it('stays idempotent: the second run consumes nothing (derived rows are ledgered like any other)', () => {
    const base = mkStubBase();
    const proj = mkProject([
      { id: 'no-vec', task: 'edit: b.ts', quality: 0.9, embedding: null },
    ]);
    const first = runHarvest(proj, base);
    expect(first.summary).toMatchObject({ trained: 1, trainedEmbeddedAtHarvest: 1 });
    const second = runHarvest(proj, base);
    expect(second.summary).toMatchObject({ trained: 0, note: 'nothing fresh' });
  });
});

// ── TRAJ-ATTR-V1 (Wave 4): the harvester is one of the writer paths into the LoRA
// sink and must leave an attribution row bracketing its Sink A pass, parseable by the
// canonical reader — so an eval-side delta can be attributed to harvest-replay rather
// than confounded with the per-turn Stop hook. Reuses this file's stub harness.
suite('TRAJ-ATTR-V1 — harvest attributes its Sink A training window', () => {
  const attr = require('../tools/trajectory-attribution.cjs');

  it('writes a harvest-sinkA row with the trained count and the weights transition it caused', () => {
    const base = mkStubBase();
    const proj = mkProject([
      { id: 'has-vec', task: 'edit: a.ts', quality: 0.9, embedding: vec(0.5) },
    ]);
    const r = runHarvest(proj, base);
    expect(r.summary.trained).toBe(1);
    const rows = attr.readEvents(proj);                    // canonical reader (lock-step)
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe('harvest-sinkA');
    expect(rows[0].trained).toBe(1);
    expect(rows[0].freshRows).toBe(1);
    expect(rows[0].weightsBefore).toBeNull();              // sink did not exist pre-harvest
    expect(rows[0].weightsAfter.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].weightsChanged).toBe(true);             // the stub adapter wrote the sink
  });

  it('a trained=0 pass (all rows refused by the dim guard) still leaves an honest row: "harvest ran, trained nothing"', () => {
    const base = mkStubBase({ embedderDim: DIM + 3 });     // derived vector fails the dim guard
    const proj = mkProject([
      { id: 'no-vec', task: 'edit: b.ts', quality: 0.9, embedding: null },
    ]);
    const r = runHarvest(proj, base);
    expect(r.summary.trained).toBe(0);
    const rows = attr.readEvents(proj);
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe('harvest-sinkA');
    expect(rows[0].trained).toBe(0);
    // saveWeights still ran (stub writes on save) — the row records the transition truthfully
    expect(typeof rows[0].weightsChanged).toBe('boolean');
  });
});
