/**
 * Tests for tools/aqe-embed-sweep.cjs — EMBED-SWEEP-V1.
 *
 * The sweep backfills `captured_experiences.embedding` for rows the capture
 * hook lost (un-awaited embed + bare catch{}, upstream). It replays a
 * DETERMINISTIC computation, so a correct sweep writes byte-identical vectors
 * to a correct capture — which is exactly why it is dangerous: there is no
 * geometric tell afterwards, unlike probe #16's hash proxies. Two safeguards
 * carry the design and both are tested here:
 *
 *   IDENTITY GATE — refuse to write at all unless this host's embedder
 *   reproduces the store's EXISTING vectors. Without it the sweep could
 *   silently become the contamination source probe #16 exists to catch.
 *
 *   ANTI-LAUNDERING — probe #15 counts kit-swept rows as still-lost, via the
 *   kit-owned ledger. Otherwise running the remedy turns the verdict green
 *   while the defect it reports is untouched.
 *
 * HOUSE RULE: every negative / "nothing happened" assertion is paired with a
 * POSITIVE CONTROL, because a tool that dies on startup satisfies "wrote
 * nothing" trivially.
 */
'use strict';

const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const TOOL = path.join(REPO, 'tools', 'aqe-embed-sweep.cjs');
const VERIFY = path.join(REPO, 'lib', 'verify-learning.sh');
const DIM = 384;

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
if (!BSQL) console.warn('[embed-sweep.test] no loadable better-sqlite3 — suite skipped');

const tmps = [];
const mktmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });

/**
 * Stub toolchain. `variant` picks the embedder's behaviour:
 *   'A'    deterministic vector family A (the "correct" embedder)
 *   'B'    a DIFFERENT family — used to trip the identity gate
 *   'zero' returns the all-zero vector (what the real embedder does for
 *          non-semantic text, WITHOUT throwing)
 *   'dim'  returns a 128-dim vector
 */
function mkStubBase(variant = 'A') {
  const base = mktmp('sweep-base-');
  const bs = path.join(base, 'agentic-qe', 'node_modules', 'better-sqlite3');
  fs.mkdirSync(bs, { recursive: true });
  fs.writeFileSync(path.join(bs, 'package.json'), JSON.stringify({ name: 'better-sqlite3', main: 'index.js' }));
  fs.writeFileSync(path.join(bs, 'index.js'), `module.exports = require(${JSON.stringify(BSQL)});\n`);

  const emb = path.join(base, 'agentic-qe', 'dist', 'learning');
  fs.mkdirSync(emb, { recursive: true });
  fs.writeFileSync(path.join(emb, 'package.json'), JSON.stringify({ type: 'module' }));
  const body = {
    A: `const n=${DIM},v=new Array(n);for(let i=0;i<n;i++)v[i]=Math.sin((i+1)*(1+(text.length%7))*0.37)+1.7;
        const m=Math.sqrt(v.reduce((s,x)=>s+x*x,0));return v.map(x=>x/m);`,
    B: `const n=${DIM},v=new Array(n);for(let i=0;i<n;i++)v[i]=Math.cos((i+3)*(2+(text.length%5))*0.91)+2.3;
        const m=Math.sqrt(v.reduce((s,x)=>s+x*x,0));return v.map(x=>x/m);`,
    // These two must still reproduce HISTORY (so the identity gate passes) and
    // misbehave only on new texts — which is also how the real embedder acts:
    // isNonSemanticText zeroes particular inputs, not everything.
    zero: `if (text.startsWith('hist')) { const n=${DIM},v=new Array(n);
        for(let i=0;i<n;i++)v[i]=Math.sin((i+1)*(1+(text.length%7))*0.37)+1.7;
        const m=Math.sqrt(v.reduce((s,x)=>s+x*x,0));return v.map(x=>x/m); }
      return new Array(${DIM}).fill(0);`,
    dim: `if (text.startsWith('hist')) { const n=${DIM},v=new Array(n);
        for(let i=0;i<n;i++)v[i]=Math.sin((i+1)*(1+(text.length%7))*0.37)+1.7;
        const m=Math.sqrt(v.reduce((s,x)=>s+x*x,0));return v.map(x=>x/m); }
      const n=128,v=new Array(n).fill(0.1);const m=Math.sqrt(v.reduce((s,x)=>s+x*x,0));return v.map(x=>x/m);`,
  }[variant];
  fs.writeFileSync(path.join(emb, 'real-embeddings.js'),
    `import fs from 'fs';
export async function computeRealEmbedding(text) {
  try { fs.appendFileSync('embed-receipt.jsonl', JSON.stringify({ text }) + '\\n'); } catch (e) {}
  ${body}
}
`);
  return base;
}

/** Build the vector the stub would produce, so fixtures can pre-seed matching history. */
function stubVec(text, variant = 'A') {
  const n = DIM, v = new Array(n);
  if (variant === 'A') for (let i = 0; i < n; i++) v[i] = Math.sin((i + 1) * (1 + (text.length % 7)) * 0.37) + 1.7;
  else for (let i = 0; i < n; i++) v[i] = Math.cos((i + 3) * (2 + (text.length % 5)) * 0.91) + 2.3;
  const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return Float32Array.from(v.map((x) => x / m));
}
const textOf = (domain, task) => String(`${domain ?? ''}: ${task}`).replace(/<[^>]*>/g, '').slice(0, 512);

/**
 * rows: [{ id, domain, task, ageMinutes, embedded: false|'A'|'B' }]
 * Always seeds >= 20 embedded "history" rows so the identity gate is assessable.
 */
function mkProject(rows, { historyVariant = 'A', history = 20 } = {}) {
  const proj = mktmp('sweep-proj-');
  fs.mkdirSync(path.join(proj, '.agentic-qe'), { recursive: true });
  const Database = require(BSQL);
  const db = new Database(path.join(proj, '.agentic-qe', 'memory.db'));
  db.exec(`CREATE TABLE captured_experiences (
    id TEXT PRIMARY KEY, task TEXT NOT NULL, agent TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT '', success INTEGER NOT NULL DEFAULT 1,
    quality REAL NOT NULL DEFAULT 0.9, completed_at TEXT, consolidated_into TEXT,
    embedding BLOB, embedding_dimension INTEGER)`);
  const ins = db.prepare(
    `INSERT INTO captured_experiences (id,task,agent,domain,completed_at,consolidated_into,embedding,embedding_dimension)
     VALUES (?,?,?,?,datetime('now','-'||?||' minutes'),?,?,?)`);
  for (let i = 0; i < history; i++) {
    const t = textOf('hist', `history item ${i}`);
    const v = stubVec(t, historyVariant);
    ins.run(`h${i}`, `history item ${i}`, 'coder', 'hist', '600', null, Buffer.from(v.buffer), DIM);
  }
  for (const r of rows) {
    let blob = null, dim = null;
    if (r.embedded) { const v = stubVec(textOf(r.domain ?? 'code', r.task), r.embedded); blob = Buffer.from(v.buffer); dim = DIM; }
    ins.run(r.id, r.task, 'coder', r.domain ?? 'code', String(r.ageMinutes ?? 120), r.consolidated ?? null, blob, dim);
  }
  db.close();
  return proj;
}

function runSweep(proj, base, extra = []) {
  const res = spawnSync(process.execPath, [TOOL, ...extra], {
    cwd: proj, env: { ...process.env, KIT_SWEEP_NODE_BASE: base }, encoding: 'utf8', timeout: 120000,
  });
  let summary = null;
  try { summary = JSON.parse((res.stdout || '').trim().split('\n').pop()); } catch (e) {}
  return { ...res, summary };
}
const nullCount = (proj) => {
  const Database = require(BSQL);
  const db = new Database(path.join(proj, '.agentic-qe', 'memory.db'), { readonly: true });
  const n = db.prepare('SELECT COUNT(*) c FROM captured_experiences WHERE embedding IS NULL').get().c;
  db.close(); return n;
};
const embedCalls = (proj) => {
  try { return fs.readFileSync(path.join(proj, 'embed-receipt.jsonl'), 'utf8').split('\n').filter(Boolean).length; }
  catch (e) { return 0; }
};

suite('EMBED-SWEEP-V1 — fills lost vectors, refuses when it should', () => {
  const graced = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `e${from + i}`, task: `work item ${from + i}`, ageMinutes: 120 }));

  it('POSITIVE CONTROL: writes vectors for graced NULL rows', () => {
    const proj = mkProject(graced(30));
    const r = runSweep(proj, mkStubBase('A'));
    expect(r.summary).toMatchObject({ eligible: 30, written: 30, raced: 0, nonSemantic: 0 });
    expect(nullCount(proj)).toBe(0);
  });

  it('is idempotent — a second run finds nothing and embeds nothing', () => {
    const proj = mkProject(graced(30));
    const base = mkStubBase('A');
    runSweep(proj, base);
    const before = embedCalls(proj);
    const r2 = runSweep(proj, base);
    expect(r2.summary).toMatchObject({ eligible: 0, written: 0 });
    // POSITIVE CONTROL: a new graced row IS picked up, proving run 2 was not
    // simply broken.
    const Database = require(BSQL);
    const db = new Database(path.join(proj, '.agentic-qe', 'memory.db'));
    db.prepare(`INSERT INTO captured_experiences (id,task,agent,domain,completed_at) VALUES ('new1','fresh work','coder','code',datetime('now','-120 minutes'))`).run();
    db.close();
    expect(runSweep(proj, base).summary).toMatchObject({ written: 1 });
    expect(embedCalls(proj)).toBeGreaterThan(before);
  });

  it('respects the grace window, and the SAME rows aged out are swept', () => {
    const young = mkProject(graced(30).map((r) => ({ ...r, ageMinutes: 5 })));
    expect(runSweep(young, mkStubBase('A')).summary).toMatchObject({ eligible: 0, written: 0 });
    expect(nullCount(young)).toBe(30);
    // POSITIVE CONTROL — identical rows, only older.
    const old = mkProject(graced(30).map((r) => ({ ...r, ageMinutes: 120 })));
    expect(runSweep(old, mkStubBase('A')).summary).toMatchObject({ written: 30 });
  });

  it('IDENTITY GATE: refuses to write when the embedder disagrees with history', () => {
    // History written by embedder A; this host runs embedder B.
    const proj = mkProject(graced(30), { historyVariant: 'A' });
    const r = runSweep(proj, mkStubBase('B'));
    expect(r.summary).toMatchObject({ written: 0, note: 'identity gate failed' });
    expect(r.stderr).toMatch(/identity gate FAILED/);
    expect(nullCount(proj)).toBe(30);   // nothing written
    // POSITIVE CONTROL: matching embedder proceeds on the same fixture shape.
    const ok = mkProject(graced(30), { historyVariant: 'A' });
    expect(runSweep(ok, mkStubBase('A')).summary).toMatchObject({ written: 30 });
  });

  it('refuses when there is too little history to assess identity', () => {
    const proj = mkProject(graced(30), { history: 5 });
    const r = runSweep(proj, mkStubBase('A'));
    expect(r.summary).toMatchObject({ written: 0, note: 'identity gate not assessable' });
    expect(nullCount(proj)).toBe(30);
    // POSITIVE CONTROL: the explicit override writes.
    expect(runSweep(mkProject(graced(30), { history: 5 }), mkStubBase('A'), ['--force-no-baseline']).summary)
      .toMatchObject({ written: 30 });
  });

  it('NEVER writes the all-zero vector the embedder returns for non-semantic text', () => {
    // computeRealEmbedding returns [0]*384 and does NOT throw. A zero vector is
    // worse than NULL: it would enter HNSW and cosine against it is degenerate.
    const proj = mkProject(graced(5), { history: 20 });
    const r = runSweep(proj, mkStubBase('zero'));
    expect(r.summary).toMatchObject({ written: 0, nonSemantic: 5 });
    expect(nullCount(proj)).toBe(5);
  });

  it('rejects a wrong-dimension vector rather than mixing dims into the index', () => {
    const proj = mkProject(graced(5), { history: 20 });
    const r = runSweep(proj, mkStubBase('dim'));
    expect(r.summary.written).toBe(0);
    expect(r.summary.rejectedDim + r.summary.rejectedNorm).toBeGreaterThan(0);
    expect(nullCount(proj)).toBe(5);
  });

  it('never overwrites a vector that already exists', () => {
    const proj = mkProject([...graced(5), { id: 'keep', task: 'already embedded', ageMinutes: 120, embedded: 'A' }]);
    const Database = require(BSQL);
    let db = new Database(path.join(proj, '.agentic-qe', 'memory.db'), { readonly: true });
    const before = db.prepare("SELECT embedding e FROM captured_experiences WHERE id='keep'").get().e;
    db.close();
    runSweep(proj, mkStubBase('A'));
    db = new Database(path.join(proj, '.agentic-qe', 'memory.db'), { readonly: true });
    const after = db.prepare("SELECT embedding e FROM captured_experiences WHERE id='keep'").get().e;
    db.close();
    expect(Buffer.compare(before, after)).toBe(0);
  });

  it('skips consolidated rows, and sweeps the same row when not consolidated', () => {
    const con = mkProject([{ id: 'c1', task: 'consolidated', ageMinutes: 120, consolidated: 'parent-1' }]);
    expect(runSweep(con, mkStubBase('A')).summary).toMatchObject({ eligible: 0 });
    const free = mkProject([{ id: 'c1', task: 'consolidated', ageMinutes: 120 }]);
    expect(runSweep(free, mkStubBase('A')).summary).toMatchObject({ written: 1 });
  });

  it('--dry-run reports the plan and changes nothing on disk', () => {
    const proj = mkProject(graced(30));
    const r = runSweep(proj, mkStubBase('A'), ['--dry-run']);
    expect(r.summary).toMatchObject({ written: 0, wouldWrite: 30, dryRun: true });
    expect(nullCount(proj)).toBe(30);
    expect(fs.existsSync(path.join(proj, '.swarm', 'embed-sweep-state.json'))).toBe(false);
  });

  it('dedupes identical texts so one embed serves many rows', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, task: 'edit: same', ageMinutes: 120 }));
    const proj = mkProject(rows);
    const r = runSweep(proj, mkStubBase('A'));
    expect(r.summary).toMatchObject({ eligible: 20, distinctTexts: 1, written: 20 });
  });
});

suite('EMBED-SWEEP-V1 — probe #15 cannot be laundered by the sweep', () => {
  const many = (n, age) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, task: `job ${i}`, ageMinutes: age }));

  function runVerify(proj) {
    const r = spawnSync('bash', [VERIFY, proj], { encoding: 'utf8', timeout: 120000, env: { ...process.env } });
    return (r.stdout || '') + (r.stderr || '');
  }
  const line15 = (out) => (out.split('\n').find((l) => l.includes('(#15)')) || '');

  it('THE CRUX: after a sweep fills every column, #15 still FAILs and says why', () => {
    const proj = mkProject(many(200, 120));
    expect(line15(runVerify(proj))).toMatch(/capture embed DEAD/);   // pre-sweep

    const r = runSweep(proj, mkStubBase('A'));
    expect(r.summary.written).toBe(200);
    expect(nullCount(proj)).toBe(0);                                  // column IS full

    const after = line15(runVerify(proj));
    expect(after).toMatch(/capture embed DEAD/);                      // still failing
    expect(after).toMatch(/kit-swept/);
    expect(after).toMatch(/200 of 200/);                              // effective, not raw NULL
  });

  it('POSITIVE CONTROL: the same full column WITHOUT a sweep ledger PASSes', () => {
    // Without this pair, a probe hardcoded to FAIL would satisfy the crux test.
    const proj = mkProject(many(200, 120).map((r) => ({ ...r, embedded: 'A' })));
    expect(fs.existsSync(path.join(proj, '.swarm', 'embed-sweep-state.json'))).toBe(false);
    expect(line15(runVerify(proj))).toMatch(/capture embeds land/);
  });
});
