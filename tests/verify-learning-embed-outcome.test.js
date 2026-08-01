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

/**
 * Probe #15 is now BEHAVIOURAL (CAPTURE-EMBED-LANDING-V1): it drives real hooks
 * in a sandbox instead of censusing the pool. The census was replaced because it
 * could not tell the truth — upstream's boot-triggered backfill repairs history
 * indistinguishably (a backfilled vector is byte-identical to a captured one),
 * so a clean census reports how recently a server booted, not whether capture
 * works. Demonstrated during design: 98% pool coverage on a target losing 100%.
 *
 * Fixtures drive a STUB bundle, never the installed dist, so these tests do not
 * quietly turn into not-assessable passes the day upstream fixes the defect.
 */
function mkHookSandbox({ awaitEmbed, writeRow = true, withShim = true, withBundle = true }) {
  const t = mktmp('vleo-hook-');
  if (withShim) {
    fs.mkdirSync(path.join(t, '.claude', 'hooks'), { recursive: true });
    // Minimal shim: spawn the bundle with stdin inherited, like the real one.
    fs.writeFileSync(path.join(t, '.claude', 'hooks', 'aqe-hook.cjs'), `
const { spawnSync } = require('child_process');
const path = require('path');
spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'node_modules', 'agentic-qe', 'bundle.js'), ...process.argv.slice(2)],
  { stdio: ['inherit', 'pipe', 'pipe'], cwd: process.cwd() });
`);
  }
  if (withBundle) {
    const b = path.join(t, 'node_modules', 'agentic-qe');
    fs.mkdirSync(b, { recursive: true });
    // The defect, reproduced literally: INSERT, fire an un-awaited embed, then
    // process.exit(0). `awaitEmbed` is the ONLY difference between the teeth
    // fixture and its positive control.
    fs.writeFileSync(path.join(b, 'bundle.js'), `
const Database = require(${JSON.stringify(BSQL)});
const fs = require('fs'), path = require('path');
const root = process.env.AQE_PROJECT_ROOT || process.cwd();
fs.mkdirSync(path.join(root, '.agentic-qe'), { recursive: true });
const db = new Database(path.join(root, '.agentic-qe', 'memory.db'));
db.pragma('busy_timeout = 20000');
db.exec("CREATE TABLE IF NOT EXISTS captured_experiences (id TEXT PRIMARY KEY, task TEXT, agent TEXT, domain TEXT, success INTEGER, quality REAL, completed_at TEXT, consolidated_into TEXT, embedding BLOB, embedding_dimension INTEGER)");
const id = 'x' + process.pid + Math.random().toString(36).slice(2);
${writeRow ? `db.prepare("INSERT INTO captured_experiences (id,task,agent,domain,success,quality,completed_at) VALUES (?,?,?,?,1,0.9,datetime('now'))").run(id,'edit: probe','cli-hook','code');` : ''}
const embed = async () => {
  await new Promise(r => setTimeout(r, 60));            // stands in for model load
  const v = Float32Array.from({ length: 384 }, (_, i) => Math.sin(i + 1) + 1.5);
  const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  const n = Float32Array.from(v, x => x / m);
  try { db.prepare("UPDATE captured_experiences SET embedding=?, embedding_dimension=? WHERE id=?")
          .run(Buffer.from(n.buffer), 384, id); } catch (e) {}
};
${awaitEmbed ? 'embed().then(() => process.exit(0));' : '(async () => { try { await embed(); } catch (e) {} })(); process.exit(0);'}
`);
  }
  return t;
}

suite('probe #15 CAPTURE-EMBED-LANDING-V1 — drive the hook, assert the vector lands', () => {
  it('POSITIVE CONTROL: a bundle that AWAITS the embed PASSes', () => {
    const out = runVerify(mkHookSandbox({ awaitEmbed: true }));
    expect(line(out, '(#15)')).toMatch(/capture embeds LAND/);
  });

  it('TEETH: the same fixture with the embed un-awaited before exit FAILs', () => {
    // One line differs from the control above — that is the upstream defect.
    const out = runVerify(mkHookSandbox({ awaitEmbed: false }));
    const l = line(out, '(#15)');
    expect(l).toMatch(/capture embed DEAD/);
    expect(l).toMatch(/deterministic, not a race/);
    expect(out).toMatch(/learning loop HOLLOW/);
  });

  it('"no row written" is NOT assessable, never broken', () => {
    // AQE_HOOK_NPX=0 with no local bundle makes the real shim exit 0 silently.
    // Failing a host for that would be the exact defect this probe replaced.
    const l = line(runVerify(mkHookSandbox({ awaitEmbed: false, writeRow: false })), '(#15)');
    expect(l).toMatch(/not assessable/);
    expect(l).toMatch(/wrote no capture row/);
    expect(l).not.toMatch(/capture embed DEAD/);
  });

  it('a target with no hook shim is not assessable', () => {
    const l = line(runVerify(mkHookSandbox({ awaitEmbed: true, withShim: false })), '(#15)');
    expect(l).toMatch(/not assessable/);
    expect(l).toMatch(/no \.claude\/hooks\/aqe-hook\.cjs/);
  });

  it('does NOT double-report #13: a dead embedder makes #15 not-assessable', () => {
    // Without this gate a broken embedder reads as a capture defect and the
    // operator fixes the wrong thing.
    const t = mkHookSandbox({ awaitEmbed: false });
    const badBase = mktmp('vleo-deademb-');
    const d = path.join(badBase, 'agentic-qe', 'dist', 'learning');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ type: 'module' }));
    fs.writeFileSync(path.join(d, 'real-embeddings.js'),
      `export async function computeRealEmbedding() { throw new Error('not installed'); }\n`);
    const r = spawnSync('bash', [VERIFY, t], {
      encoding: 'utf8', timeout: 120000, env: { ...process.env, KIT_VL_AQE_BASE: badBase },
    });
    const out = (r.stdout || '') + (r.stderr || '');
    expect(line(out, '(#13)')).toMatch(/embedder DEAD/);
    const l15 = line(out, '(#15)');
    expect(l15).toMatch(/not assessable/);
    expect(l15).not.toMatch(/capture embed DEAD/);
  });

  it('ISOLATION: leaves no .agentic-qe outside its own sandbox', () => {
    const t = mkHookSandbox({ awaitEmbed: false });
    runVerify(t);
    // The hook creates .agentic-qe in its CWD regardless of AQE_PROJECT_ROOT,
    // so the probe must chdir into its sandbox or it becomes the drift.
    expect(fs.existsSync(path.join(REPO, '.agentic-qe', 'memory.db-probe'))).toBe(false);
    // The sandbox the probe fires in is its own mktemp dir, not the target.
    expect(fs.existsSync(path.join(t, '.agentic-qe', 'memory.db'))).toBe(false);
  });

  it('is deterministic across runs — proof runs verify-learning twice', () => {
    const t = mkHookSandbox({ awaitEmbed: false });
    const a = line(runVerify(t), '(#15)').replace(/\d+ of \d+/, 'N of N');
    const b = line(runVerify(t), '(#15)').replace(/\d+ of \d+/, 'N of N');
    expect(a).toBe(b);
  });

  it('pool coverage is reported as INFO, explicitly not as capture evidence', () => {
    const out = runVerify(mkTarget({ rows: { count: 60, nullCount: 0, ageMinutes: 120 } }));
    const l = out.split('\n').find((x) => x.includes('pool vector coverage')) || '';
    expect(l).toMatch(/cannot attribute them/);
    expect(l).toMatch(/NOT evidence that capture works/);
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
