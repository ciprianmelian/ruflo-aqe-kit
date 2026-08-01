/**
 * Tests for lib/verify-learning.sh probes #15 (EMBED-OUTCOME-V1) and
 * #16 (STORED-VECTOR-PROVENANCE-V1).
 *
 * #13 asks "can the embedder work"; #15 asks "did the vector actually LAND".
 * They are different questions, and this repo proved it: #13 PASSed on a
 * healthy embedder while 100% of new capture rows landed with embedding NULL
 * (the hook's un-awaited embed IIFE loses its race with subprocess exit).
 * #16 exists because a repaired embedder does NOT repair vectors already
 * written, and a hash proxy is 384-dim/1536-byte/unit-norm — byte-identical to
 * MiniLM as far as dimension_guard can see.
 *
 * HOUSE RULE observed throughout: every third-state / negative assertion is
 * paired with a POSITIVE CONTROL on the same fixture shape, because "reports
 * not-assessable" is trivially satisfied by a probe that never ran. That bug
 * shipped once in this kit already.
 *
 * Fixtures are synthetic stores built here, so nothing needs a SHA pin and
 * nothing can expire.
 */
'use strict';

const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const VERIFY = path.join(REPO, 'lib', 'verify-learning.sh');

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
if (!BSQL) console.warn('[verify-learning-embed-outcome.test] no loadable better-sqlite3 — suite skipped');

const tmps = [];
const mktmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });

// Pin probe #13 to a stub so its verdict cannot depend on the host, and keep
// these tests about #15/#16 only.
let _embStub = null;
function embedderStub() {
  if (_embStub) return _embStub;
  _embStub = mktmp('vleo-emb-');
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

/** rows: {count, nullCount, ageMinutes}. Vectors are real dense float32 blobs. */
function mkTarget({ rows = null, patterns = null, noTable = false, noDb = false, corrupt = false, noEmbedCol = false } = {}) {
  const t = mktmp('vleo-target-');
  fs.mkdirSync(path.join(t, '.agentic-qe'), { recursive: true });
  const dbPath = path.join(t, '.agentic-qe', 'memory.db');
  if (noDb) return t;
  if (corrupt) { fs.writeFileSync(dbPath, 'this is not a sqlite database at all'); return t; }

  const Database = require(BSQL);
  const db = new Database(dbPath);
  if (!noTable && rows) {
    db.exec(noEmbedCol
      ? `CREATE TABLE captured_experiences (id TEXT PRIMARY KEY, task TEXT, agent TEXT, domain TEXT, success INTEGER, quality REAL, completed_at TEXT)`
      : `CREATE TABLE captured_experiences (id TEXT PRIMARY KEY, task TEXT, agent TEXT, domain TEXT, success INTEGER, quality REAL, completed_at TEXT, embedding BLOB)`);
    const dense = Buffer.from(new Float32Array(384).fill(0.05).buffer);
    const ins = noEmbedCol
      ? db.prepare(`INSERT INTO captured_experiences VALUES (?,?,?,?,1,0.9,datetime('now','-' || ? || ' minutes'))`)
      : db.prepare(`INSERT INTO captured_experiences VALUES (?,?,?,?,1,0.9,datetime('now','-' || ? || ' minutes'),?)`);
    for (let i = 0; i < rows.count; i++) {
      const args = [`e${i}`, `task ${i}`, 'coder', 'code', String(rows.ageMinutes)];
      if (!noEmbedCol) args.push(i < rows.nullCount ? null : dense);
      ins.run(...args);
    }
  }
  if (patterns) {
    db.exec(`CREATE TABLE qe_pattern_embeddings (pattern_id TEXT PRIMARY KEY, embedding BLOB NOT NULL, dimension INTEGER NOT NULL, model TEXT, created_at TEXT)`);
    const ins = db.prepare('INSERT INTO qe_pattern_embeddings VALUES (?,?,?,?,?)');
    // Proxies are produced by the REAL hash recipe, not hand-crafted sparsity —
    // that is what proves the threshold discriminates the actual artefact.
    const hashVec = (text, n) => {
      const e = new Array(n).fill(0), s = String(text).toLowerCase().trim();
      for (let p = 0; p < 3; p++) for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i); e[(c * (i + 1) * (p + 1)) % n] += Math.sin(c * (p + 1)) / (i + 1);
      }
      const m = Math.sqrt(e.reduce((t2, x) => t2 + x * x, 0)) || 1;
      return Float32Array.from(e.map((x) => x / m));
    };
    for (let i = 0; i < patterns.count; i++) {
      const v = i < patterns.proxyCount
        ? hashVec(`pattern number ${i} description words`, 384)
        : Float32Array.from({ length: 384 }, (_, k) => Math.sin((k + i + 1) * 3.7) + 1.5);
      ins.run(`p${i}`, Buffer.from(v.buffer), 384, patterns.model || 'all-MiniLM-L6-v2', '2026-08-01 10:00:00');
    }
  }
  db.close();
  return t;
}

function runVerify(target) {
  const r = spawnSync('bash', [VERIFY, target], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, KIT_VL_AQE_BASE: embedderStub() },
  });
  return (r.stdout || '') + (r.stderr || '');
}
const line = (out, tag) => (out.split('\n').find((l) => l.includes(tag)) || '');

suite('probe #15 EMBED-OUTCOME-V1 — did the vector actually land', () => {
  it('POSITIVE CONTROL: a fully-embedded graced pool PASSes (proves the probe reaches a verdict)', () => {
    const out = runVerify(mkTarget({ rows: { count: 200, nullCount: 0, ageMinutes: 120 } }));
    expect(line(out, '(#15)')).toMatch(/capture embeds land/);
  });

  it('TEETH: the same pool with vectors removed FAILs — one column is the whole difference', () => {
    const out = runVerify(mkTarget({ rows: { count: 200, nullCount: 200, ageMinutes: 120 } }));
    expect(line(out, '(#15)')).toMatch(/capture embed DEAD: 200 of 200 graced rows \(100%\)/);
    expect(out).toMatch(/learning loop HOLLOW/);
  });

  it('a partial-loss regime WARNs and does NOT reach the FAIL gate', () => {
    // 15% — the real degraded target peaked at 29%, so the gate must not fire.
    const out = runVerify(mkTarget({ rows: { count: 200, nullCount: 30, ageMinutes: 120 } }));
    expect(line(out, '(#15)')).toMatch(/capture embed LEAKING: 15%/);
  });

  it('CRY-WOLF GUARD: 200 all-NULL rows INSIDE the grace window must not FAIL', () => {
    // The embed is async-after and bursty (measured: ~30% NULL at 15-60min, then
    // 0% four minutes later). Young NULLs are pending, not lost.
    const out = runVerify(mkTarget({ rows: { count: 200, nullCount: 200, ageMinutes: 5 } }));
    const l = line(out, '(#15)');
    expect(l).toMatch(/not assessable/);
    expect(l).toMatch(/\[not-assessable\]/);
    expect(l).not.toMatch(/capture embed DEAD/);
  });

  it('POSITIVE CONTROL for the grace guard: the identical rows aged past 60m DO fail', () => {
    // Without this pair, a probe that always took the not-assessable branch
    // would satisfy the cry-wolf test above.
    const out = runVerify(mkTarget({ rows: { count: 200, nullCount: 200, ageMinutes: 120 } }));
    expect(line(out, '(#15)')).toMatch(/capture embed DEAD/);
  });

  it('sample-size edge: 49 graced rows is not-assessable, 50 all-NULL rows FAILs', () => {
    const under = runVerify(mkTarget({ rows: { count: 49, nullCount: 49, ageMinutes: 120 } }));
    expect(line(under, '(#15)')).toMatch(/only 49 row\(s\) past the 60m grace/);
    const at = runVerify(mkTarget({ rows: { count: 50, nullCount: 50, ageMinutes: 120 } }));
    expect(line(at, '(#15)')).toMatch(/capture embed DEAD/);
  });

  it('names no false remedy — no kit verb repairs this fault', () => {
    const out = runVerify(mkTarget({ rows: { count: 200, nullCount: 200, ageMinutes: 120 } }));
    const l = line(out, '(#15)');
    expect(l).not.toMatch(/ruflo-kit sync|fix-aqe/);
    expect(l).toMatch(/upstream/);
  });

  it('distinguishes absent store / absent table / pre-embedding schema by REASON', () => {
    expect(line(runVerify(mkTarget({ noDb: true })), '(#15)')).toMatch(/no AQE store/);
    expect(line(runVerify(mkTarget({ noTable: true, patterns: { count: 0, proxyCount: 0 } })), '(#15)'))
      .toMatch(/captured_experiences table absent/);
    expect(line(runVerify(mkTarget({ rows: { count: 60, nullCount: 0, ageMinutes: 120 }, noEmbedCol: true })), '(#15)'))
      .toMatch(/pre-embedding schema/);
  });

  it('a corrupt store reports UNREADABLE, not "table absent"', () => {
    // Openability must be probed BEFORE table existence, or a corrupt file
    // yields an empty sqlite_master query and the probe blames the wrong thing.
    expect(line(runVerify(mkTarget({ corrupt: true })), '(#15)')).toMatch(/store unreadable/);
  });
});

suite('probe #16 STORED-VECTOR-PROVENANCE-V1 — are stored vectors genuine', () => {
  it('POSITIVE CONTROL: an all-dense table PASSes', () => {
    const out = runVerify(mkTarget({ patterns: { count: 40, proxyCount: 0 } }));
    expect(line(out, '(#16)')).toMatch(/stored vectors genuine/);
  });

  it('TEETH: a table of REAL hash-recipe vectors FAILs', () => {
    const out = runVerify(mkTarget({ patterns: { count: 40, proxyCount: 40 } }));
    expect(line(out, '(#16)')).toMatch(/STORED VECTORS CONTAMINATED: 40 of 40/);
  });

  it('ANTI-GOODHART: proxies and genuine rows sharing one model label still FAIL', () => {
    // Drawn from real data — 139 proxies and 51 genuine rows carried the exact
    // same label. This test fails any future version that trusts that column.
    const out = runVerify(mkTarget({ patterns: { count: 40, proxyCount: 30, model: 'all-MiniLM-L6-v2' } }));
    const l = line(out, '(#16)');
    expect(l).toMatch(/STORED VECTORS CONTAMINATED/);
    expect(l).toMatch(/model label/);
  });

  it('a light contamination WARNs rather than FAILs', () => {
    const out = runVerify(mkTarget({ patterns: { count: 40, proxyCount: 4 } }));
    expect(line(out, '(#16)')).toMatch(/partially contaminated/);
  });

  it('says a fixed embedder does NOT repair these rows', () => {
    const out = runVerify(mkTarget({ patterns: { count: 40, proxyCount: 40 } }));
    expect(line(out, '(#16)')).toMatch(/does NOT repair them/);
  });

  it('sample-size edge: 19 vectors not-assessable, 20 proxies FAIL', () => {
    expect(line(runVerify(mkTarget({ patterns: { count: 19, proxyCount: 19 } })), '(#16)'))
      .toMatch(/only 19 stored pattern vector/);
    expect(line(runVerify(mkTarget({ patterns: { count: 20, proxyCount: 20 } })), '(#16)'))
      .toMatch(/STORED VECTORS CONTAMINATED/);
  });

  it('absent table and absent store are distinct not-assessable reasons', () => {
    expect(line(runVerify(mkTarget({ rows: { count: 60, nullCount: 0, ageMinutes: 120 } })), '(#16)'))
      .toMatch(/qe_pattern_embeddings table absent/);
    expect(line(runVerify(mkTarget({ noDb: true })), '(#16)')).toMatch(/no AQE store/);
  });
});
