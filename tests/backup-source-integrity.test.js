/**
 * Tests for tools/backup-integrity-patch.cjs + lib/fix-ruflo.sh Step 3d —
 * BACKUP-SOURCE-INTEGRITY-V1 (kit issue #6).
 *
 * `backupMemoryDb()` in the installed @claude-flow/cli takes a WAL-safe online
 * snapshot of `.swarm/memory.db` and NEVER runs `PRAGMA integrity_check` on the
 * SOURCE. `restoreMemoryDbFromBackup()` already verifies each candidate on the
 * way OUT and walks back to a clean one; there is simply no check on the way IN.
 * So a corrupt DB is copied forward every night, recorded as `backedUp: true`,
 * and the last clean snapshot rotates out of retention unnoticed.
 *
 * TWO unguarded success paths, and covering only one would reproduce this kit's
 * signature defect (a check that reports healthy because it never looked at the
 * path that matters):
 *   A. the online backup      — `await db.backup(destPath)`
 *   B. the byte-copy fallback — `fs.copyFileSync(dbPath, destPath)` (#2798),
 *      taken when `db.backup()` throws. B is WORSE: a DB corrupt enough that
 *      better-sqlite3 refuses to read it lands there and is raw-copied.
 *
 * Every test below drives the REAL patched `backupMemoryDb` / the REAL
 * `restoreMemoryDbFromBackup` out of a patched COPY of the installed dist —
 * never a reimplementation, and never the live installed file.
 *
 * WHICH PATH RAN is not inferred, it is RECORDED: the fixture's better-sqlite3
 * shim logs every `backup()` call and its outcome, and path B additionally
 * leaves a dest that is byte-identical to the source (copyFileSync's signature;
 * the online backup defragments and does not). So "path B was exercised" is an
 * observation, not an assumption.
 *
 * TEETH / positive controls:
 *   - Every "no warning" assertion is paired with a case that DOES warn through
 *     the same capture harness — a harness that never ran the code would
 *     satisfy the negative assertion alone.
 *   - Every "unpatched is broken" assertion runs the genuinely UNPATCHED
 *     baseline, whose unpatched-ness is itself asserted (see BASELINE below).
 *   - The restore walk-back is paired with a control proving the walk-back was
 *     caused by the integrity check and not by the `.CORRUPT` name or sort order.
 *
 * No fixture is pinned to `HEAD`: the baseline is the installed dist as it sits
 * on disk (or its `.bsintegrity-bak`), and every anchor is an embedded literal.
 */
'use strict';

const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const TOOL = path.join(REPO, 'tools', 'backup-integrity-patch.cjs');
const FIX_RUFLO = path.join(REPO, 'lib', 'fix-ruflo.sh');
const SENTINEL = 'BACKUP-SOURCE-INTEGRITY-V1';

// ── host prerequisites ──────────────────────────────────────────────────────
function npmRootG() {
  try {
    return execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).toString().trim();
  } catch (e) { return null; }
}
function findBetterSqlite3() {
  const g = npmRootG();
  const candidates = g ? [
    path.join(g, 'better-sqlite3'),
    path.join(g, 'agentic-qe', 'node_modules', 'better-sqlite3'),
    path.join(g, 'ruflo', 'node_modules', 'better-sqlite3'),
  ] : [];
  for (const c of candidates) { try { require(c); return c; } catch (e) {} }
  return null;
}

const G = npmRootG();
const DIST = G ? path.join(G, 'ruflo', 'node_modules', '@claude-flow', 'cli',
  'dist', 'src', 'services', 'memory-backup.js') : null;
const BSQL = findBetterSqlite3();

/**
 * The UNPATCHED baseline. Three host states, three honest outcomes:
 *   - dist absent / no better-sqlite3     -> genuinely not assessable: skip.
 *   - dist present and unpatched          -> use it.
 *   - dist present but ALREADY patched    -> use its .bsintegrity-bak; if that
 *     is gone too, do NOT skip — that is a fixable host state and a silent skip
 *     is exactly how a suite reports healthy without having looked.
 */
function resolveBaseline() {
  if (!DIST || !fs.existsSync(DIST)) return { kind: 'absent', why: 'ruflo dist not installed' };
  if (!BSQL) return { kind: 'absent', why: 'no loadable better-sqlite3' };
  const live = fs.readFileSync(DIST, 'utf8');
  if (!live.includes(SENTINEL)) return { kind: 'ok', src: live, from: DIST };
  const bak = `${DIST}.bsintegrity-bak`;
  if (fs.existsSync(bak)) {
    const b = fs.readFileSync(bak, 'utf8');
    if (!b.includes(SENTINEL)) return { kind: 'ok', src: b, from: bak };
  }
  return { kind: 'broken', why: `installed dist already carries ${SENTINEL} and no clean ${path.basename(bak)} exists` };
}
const BASELINE = resolveBaseline();

if (BASELINE.kind === 'absent') {
  console.warn(`[backup-source-integrity.test] ${BASELINE.why} — suite skipped`);
}
const suite = BASELINE.kind === 'ok' ? describe : describe.skip;

// A host state that CAN be fixed must fail loudly rather than skip quietly.
describe('BACKUP-SOURCE-INTEGRITY-V1 — baseline availability', () => {
  it('has an UNPATCHED baseline, or a legitimate reason it cannot', () => {
    expect(BASELINE.kind, BASELINE.why || '').not.toBe('broken');
  });
});

// ── fixtures ────────────────────────────────────────────────────────────────
const tmps = [];
const mktmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });

/**
 * A disposable module root: a better-sqlite3 shim that RECORDS every backup()
 * call, plus a copy of the baseline dist (optionally patched) as a real ESM
 * module the test can import and call for real.
 */
function mkRoot({ patched = true, failBackup = false } = {}) {
  const root = mktmp('bsi-');
  const nm = path.join(root, 'node_modules', 'better-sqlite3');
  fs.mkdirSync(nm, { recursive: true });
  const log = path.join(root, 'backup-calls.log');
  fs.writeFileSync(path.join(nm, 'package.json'),
    JSON.stringify({ name: 'better-sqlite3', main: 'index.js' }));
  fs.writeFileSync(path.join(nm, 'index.js'), `
const fs = require('fs');
const R = require(${JSON.stringify(BSQL)});
const LOG = ${JSON.stringify(log)};
class W extends R {
  async backup(...a) {
    ${failBackup ? "fs.appendFileSync(LOG, 'forced-throw\\n'); throw new Error('forced backup failure');" : ''}
    try { const r = await super.backup(...a); fs.appendFileSync(LOG, 'ok\\n'); return r; }
    catch (e) { fs.appendFileSync(LOG, 'throw:' + e.message + '\\n'); throw e; }
  }
}
module.exports = W;
`);
  const svc = path.join(root, 'svc');
  fs.mkdirSync(svc, { recursive: true });
  fs.writeFileSync(path.join(svc, 'package.json'), JSON.stringify({ type: 'module' }));
  const mb = path.join(svc, 'memory-backup.js');
  // Drop the dist's trailing `//# sourceMappingURL=` line: we do not copy the
  // .map alongside, and vite's loader logs a noisy ENOENT for every import.
  // Last line, comment only — the code under test is untouched.
  fs.writeFileSync(mb, BASELINE.src.replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n'));
  if (patched) {
    const r = spawnSync('node', [TOOL, mb], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`fixture patch failed rc=${r.status}: ${r.stderr}`);
  }
  return { root, mb, log };
}

function makeDb(p, rows = 400) {
  const Database = require(BSQL);
  const db = new Database(p);
  db.pragma('journal_mode = DELETE');
  db.exec('CREATE TABLE memory_entries (id INTEGER PRIMARY KEY, k TEXT, v TEXT)');
  const ins = db.prepare('INSERT INTO memory_entries (k, v) VALUES (?, ?)');
  db.transaction(() => { for (let i = 0; i < rows; i++) ins.run('k' + i, 'v'.repeat(200) + i); })();
  db.close();
}
/** Header + page 1 intact, an interior b-tree page zeroed: OPENS, fails the pragma. */
function corruptOpenable(p) {
  const b = fs.readFileSync(p);
  b.fill(0, 2 * 4096, 3 * 4096);
  fs.writeFileSync(p, b);
}
/** Magic header intact, rest of page 1 garbage: sqlite REFUSES it entirely. */
function corruptUnopenable(p) {
  const b = fs.readFileSync(p);
  for (let i = 16; i < 4096; i++) b[i] = 0xff;
  fs.writeFileSync(p, b);
}
/** The #2798 encrypted-at-rest shape: not a native SQLite image at all. */
function writeEncryptedBlob(p) {
  fs.writeFileSync(p, Buffer.concat([Buffer.from('RFE1'), Buffer.alloc(4096, 0x7a)]));
}

const TS = Date.parse('2026-07-21T03:00:00Z');

/** Drive the real backupMemoryDb, capturing console.warn and the backup() log. */
async function runBackup({ patched = true, failBackup = false, source = 'clean' } = {}) {
  const { root, mb, log } = mkRoot({ patched, failBackup });
  const dbPath = path.join(root, 'memory.db');
  if (source === 'encrypted') writeEncryptedBlob(dbPath);
  else {
    makeDb(dbPath);
    if (source === 'corrupt-openable') corruptOpenable(dbPath);
    if (source === 'corrupt-unopenable') corruptUnopenable(dbPath);
  }
  const srcBytes = fs.readFileSync(dbPath);
  const mod = await import(`file://${mb}?t=${Math.random()}`);
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.map(String).join(' '));
  let res;
  try { res = await mod.backupMemoryDb({ dbPath, timestamp: TS }); }
  finally { console.warn = orig; }
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  const files = fs.existsSync(path.join(root, 'backups')) ? fs.readdirSync(path.join(root, 'backups')) : [];
  const byteIdentical = res.path ? fs.readFileSync(res.path).equals(srcBytes) : null;
  return { res, warns, calls, files, byteIdentical, dbPath, mb, root };
}

// ────────────────────────────────────────────────────────────────────────────
suite('BACKUP-SOURCE-INTEGRITY-V1 — the defect, reproduced on BOTH paths', () => {
  it('TEETH: the baseline is genuinely unpatched and genuinely unguarded', () => {
    // Guards every "unpatched" assertion below: without this, a host whose dist
    // was already healed would make them all pass for the wrong reason.
    expect(BASELINE.src).not.toContain(SENTINEL);
    const start = BASELINE.src.indexOf('async function backupMemoryDb');
    expect(start).toBeGreaterThan(-1);
    const end = BASELINE.src.indexOf('\n/**', start);
    expect(BASELINE.src.slice(start, end)).not.toContain('integrity_check');
    // ...while both success paths exist to be guarded.
    expect(BASELINE.src).toContain('await db.backup(destPath)');
    expect(BASELINE.src).toContain('fs.copyFileSync(dbPath, destPath)');
  });

  it('TEETH: a naive whole-file grep for the pragma reads PRESENT on that same defective dist', () => {
    // This is why the retirement gate must be FUNCTION-SCOPED: the RESTORE
    // function carries the pragma, so a whole-file defect_gate would retire the
    // patch on day one against a still-broken backup path.
    expect(BASELINE.src).toContain('integrity_check');
  });

  it('TEETH path A: unpatched, a corrupt source is copied forward and reported as success', async () => {
    const r = await runBackup({ patched: false, source: 'corrupt-openable' });
    expect(r.calls).toEqual(['ok']);                      // online backup path
    expect(r.res.backedUp).toBe(true);
    expect(path.basename(r.res.path)).not.toContain('CORRUPT');
    expect(r.warns).toEqual([]);
    expect(r.res.sourceIntegrity).toBeUndefined();
  });

  it('TEETH path B: unpatched, an UNOPENABLE source is byte-copied and reported as success', async () => {
    const r = await runBackup({ patched: false, source: 'corrupt-unopenable' });
    expect(r.calls[0]).toMatch(/^throw:/);                // fell into the fallback
    expect(r.byteIdentical).toBe(true);                   // copyFileSync's signature
    expect(r.res.backedUp).toBe(true);
    expect(path.basename(r.res.path)).not.toContain('CORRUPT');
    expect(r.warns).toEqual([]);
  });
});

suite('BACKUP-SOURCE-INTEGRITY-V1 — patched behaviour, path A (online backup)', () => {
  it('leaves the clean happy path untouched: normal name, no warning, integrity ok', async () => {
    const r = await runBackup({ source: 'clean' });
    expect(r.calls).toEqual(['ok']);
    expect(r.res.backedUp).toBe(true);
    expect(path.basename(r.res.path)).toBe('memory-2026-07-21T03-00-00-000Z.db');
    expect(r.warns).toEqual([]);
    expect(r.res.sourceIntegrity).toBe('ok');
    expect(r.res.sourceCorrupt).toBe(false);
  });

  it('tags + warns on a corrupt source, and still takes the backup', async () => {
    // POSITIVE CONTROL for the "no warning" assertion above: same harness, same
    // console.warn capture — here it must fire.
    const r = await runBackup({ source: 'corrupt-openable' });
    expect(r.calls).toEqual(['ok']);                      // still path A
    expect(r.res.backedUp).toBe(true);                    // best-effort preservation
    expect(path.basename(r.res.path)).toBe('memory-2026-07-21T03-00-00-000Z.CORRUPT.db');
    expect(r.files).toEqual(['memory-2026-07-21T03-00-00-000Z.CORRUPT.db']);
    expect(fs.existsSync(r.res.path)).toBe(true);
    expect(r.warns.length).toBe(1);
    expect(r.warns[0]).toContain(SENTINEL);
    expect(r.warns[0]).toContain('FAILED its sqlite self-check');
    expect(r.warns[0]).toContain(r.dbPath);
    expect(r.warns[0]).toContain(r.res.path);
    expect(r.res.sourceCorrupt).toBe(true);
    expect(r.res.sourceIntegrity).toMatch(/btreeInitPage|\*\*\* in database/);
  });

  it('the warning is UNCONDITIONAL — it fires with verbose off AND on', async () => {
    // A swallowed warning is the actual bug, so this must not depend on opts.
    const { root, mb } = mkRoot({});
    const dbPath = path.join(root, 'memory.db');
    makeDb(dbPath); corruptOpenable(dbPath);
    const mod = await import(`file://${mb}?t=${Math.random()}`);
    for (const verbose of [undefined, false, true]) {
      const warns = [];
      const orig = console.warn;
      console.warn = (...a) => warns.push(a.map(String).join(' '));
      try { await mod.backupMemoryDb({ dbPath, destDir: path.join(root, `b-${verbose}`), timestamp: TS, verbose }); }
      finally { console.warn = orig; }
      expect(warns.filter((w) => w.includes(SENTINEL)).length, `verbose=${verbose}`).toBe(1);
    }
  });
});

suite('BACKUP-SOURCE-INTEGRITY-V1 — patched behaviour, path B (#2798 byte-copy fallback)', () => {
  it('an UNOPENABLE source falls through to the byte copy and is STILL tagged + warned', async () => {
    // The path the original reporter's patch missed entirely, and the worse of
    // the two: better-sqlite3 refuses the file, so nothing downstream of
    // db.backup() ever gets a chance to notice.
    const r = await runBackup({ source: 'corrupt-unopenable' });
    expect(r.calls[0]).toMatch(/^throw:/);
    expect(r.byteIdentical).toBe(true);
    expect(r.res.backedUp).toBe(true);
    expect(path.basename(r.res.path)).toBe('memory-2026-07-21T03-00-00-000Z.CORRUPT.db');
    expect(r.warns.length).toBe(1);
    expect(r.warns[0]).toContain(SENTINEL);
    expect(r.res.sourceCorrupt).toBe(true);
    expect(r.res.sourceIntegrity).toMatch(/^unopenable: /);
  });

  it('propagates sourceIntegrity on the fallback even when the source is CLEAN', async () => {
    // POSITIVE CONTROL that the fallback's own return was patched, not just the
    // corrupt-tagging: db.backup() is forced to throw on a healthy DB, so only
    // copyFileSync can produce this result.
    const r = await runBackup({ source: 'clean', failBackup: true });
    expect(r.calls).toEqual(['forced-throw']);
    expect(r.byteIdentical).toBe(true);
    expect(r.res.backedUp).toBe(true);
    expect(path.basename(r.res.path)).toBe('memory-2026-07-21T03-00-00-000Z.db');
    expect(r.res.sourceIntegrity).toBe('ok');
    expect(r.res.sourceCorrupt).toBe(false);
    expect(r.warns).toEqual([]);
  });

  it('does NOT cry corrupt over an encrypted-at-rest source — it says NOT ASSESSABLE', async () => {
    // #2798's whole reason for existing. An RFE1 blob is not a native SQLite
    // image; the pragma does not apply, and tagging it CORRUPT would be a false
    // alarm on every encrypted nightly run. Third state, stated out loud.
    const r = await runBackup({ source: 'encrypted' });
    expect(r.calls[0]).toMatch(/^throw:/);
    expect(r.res.backedUp).toBe(true);
    expect(path.basename(r.res.path)).toBe('memory-2026-07-21T03-00-00-000Z.db');
    expect(r.res.sourceCorrupt).toBe(false);
    expect(r.res.sourceIntegrity).toMatch(/^not-assessable: /);
    expect(r.warns.length).toBe(1);
    expect(r.warns[0]).toContain('NOT ASSESSABLE');
  });
});

suite('BACKUP-SOURCE-INTEGRITY-V1 — the tag does not break restore', () => {
  /** backups/ holding an OLDER clean snapshot and a NEWER one under `newerName`. */
  async function restoreFixture(newerName, corruptNewer) {
    const { root, mb } = mkRoot({});
    const destDir = path.join(root, 'backups');
    fs.mkdirSync(destDir, { recursive: true });
    const older = path.join(destDir, 'memory-2026-07-19T03-00-00-000Z.db');
    const newer = path.join(destDir, newerName);
    makeDb(older, 40);
    makeDb(newer, 400);
    if (corruptNewer) corruptOpenable(newer);
    const live = path.join(root, 'memory.db');
    makeDb(live, 400);
    corruptUnopenable(live);
    const mod = await import(`file://${mb}?t=${Math.random()}`);
    const res = await mod.restoreMemoryDbFromBackup(live, {});
    const seen = fs.readdirSync(destDir).filter((f) => /^memory-.*\.db$/.test(f)).sort().reverse();
    return { res, older, newer, seen };
  }

  it('a .CORRUPT.db snapshot IS a restore candidate and IS the newest one', async () => {
    // Load-bearing precondition: if the name fell outside /^memory-.*\.db$/ the
    // walk-back below would prove nothing about the integrity check.
    const f = await restoreFixture('memory-2026-07-21T03-00-00-000Z.CORRUPT.db', true);
    expect(f.seen[0]).toBe('memory-2026-07-21T03-00-00-000Z.CORRUPT.db');
    expect(f.seen[1]).toBe('memory-2026-07-19T03-00-00-000Z.db');
  });

  it('restore SKIPS the corrupt-tagged newest snapshot and installs the older clean one', async () => {
    const f = await restoreFixture('memory-2026-07-21T03-00-00-000Z.CORRUPT.db', true);
    expect(f.res.restored).toBe(true);
    expect(f.res.from).toBe(f.older);
    expect(f.res.from).not.toBe(f.newer);
    expect(f.res.rows).toBe(40);
  });

  it('CONTROL: an intact newest snapshot IS chosen — the walk-back was the integrity check, not the name', async () => {
    // Same shape, same sort order, same `.CORRUPT.db` filename — only the bytes
    // differ. Without this, "picked the older one" is equally explained by the
    // name or by the sort, and the previous test proves nothing.
    const f = await restoreFixture('memory-2026-07-21T03-00-00-000Z.CORRUPT.db', false);
    expect(f.res.restored).toBe(true);
    expect(f.res.from).toBe(f.newer);
    expect(f.res.rows).toBe(400);
  });
});

suite('BACKUP-SOURCE-INTEGRITY-V1 — patcher mechanics', () => {
  function scratch(src) {
    const d = mktmp('bsi-p-');
    const f = path.join(d, 'memory-backup.js');
    fs.writeFileSync(f, src === undefined ? BASELINE.src : src);
    return f;
  }
  const run = (f, ...args) => {
    const r = spawnSync('node', [TOOL, f, ...args], { encoding: 'utf8' });
    return { rc: r.status, out: (r.stderr || '').trim() };
  };

  it('applies all four anchors and leaves valid JavaScript', () => {
    const f = scratch();
    expect(run(f)).toEqual({ rc: 0, out: 'APPLIED:4/4' });
    expect(spawnSync('node', ['--check', f]).status).toBe(0);
    expect(fs.readFileSync(f, 'utf8')).toContain(SENTINEL);
  });

  it('is idempotent — a second run reports ALREADY_PATCHED and changes nothing', () => {
    const f = scratch();
    run(f);
    const after = fs.readFileSync(f, 'utf8');
    expect(run(f)).toEqual({ rc: 0, out: 'ALREADY_PATCHED' });
    expect(fs.readFileSync(f, 'utf8')).toBe(after);
  });

  it('--dry-run reports WOULD_APPLY and writes NOTHING', () => {
    const f = scratch();
    const before = fs.readFileSync(f, 'utf8');
    expect(run(f, '--dry-run')).toEqual({ rc: 0, out: 'WOULD_APPLY:4/4' });
    expect(fs.readFileSync(f, 'utf8')).toBe(before);
    // POSITIVE CONTROL: the same fixture DOES change without the flag, so the
    // "unchanged" assertion is not satisfied by a patcher that no-ops entirely.
    run(f);
    expect(fs.readFileSync(f, 'utf8')).not.toBe(before);
  });

  it('TEETH: the function-scoped gate does NOT retire against the defective dist', () => {
    // The whole point. A whole-file gate would exit 6 here (the restore path has
    // the pragma) and the patch would never apply.
    expect(run(scratch()).rc).not.toBe(6);
  });

  it('TEETH: it DOES retire once the pragma appears inside backupMemoryDb itself', () => {
    // Positive control for the test above: same file, one line moved into the
    // backup function, and the stopgap stands down.
    const src = BASELINE.src.replace(
      '    const destDir = opts.destDir ?? path.join(path.dirname(dbPath), \'backups\');',
      '    const __up = new Database(dbPath, { readonly: true }).pragma(\'integrity_check\');\n'
      + '    const destDir = opts.destDir ?? path.join(path.dirname(dbPath), \'backups\');');
    expect(src).not.toBe(BASELINE.src); // the replace actually landed
    expect(run(scratch(src))).toEqual({ rc: 6, out: 'SELF_RETIRED' });
  });

  it('FAILS CLOSED on partial drift: no write, no sentinel', () => {
    // One anchor drifted => the whole write is blocked, so the next run still
    // sees the defect and retries, instead of freezing behind a green sentinel.
    const src = BASELINE.src.replace(
      '    return { backedUp: true, path: destPath, sizeBytes, rotatedAway, gcsUri };',
      '    return { backedUp: true, path: destPath, sizeBytes, rotatedAway, gcsUri, extra: 1 };');
    const f = scratch(src);
    const before = fs.readFileSync(f, 'utf8');
    const r = run(f);
    expect(r.rc).toBe(3);
    expect(r.out).toMatch(/^PARTIAL:3\/4 /);
    expect(fs.readFileSync(f, 'utf8')).toBe(before);
    expect(fs.readFileSync(f, 'utf8')).not.toContain(SENTINEL);
  });

  it('reports ANCHOR_NOT_FOUND on an unrecognisable file, and READ_FAILED on a missing one', () => {
    expect(run(scratch('export const nope = 1;\n'))).toEqual({ rc: 2, out: 'ANCHOR_NOT_FOUND:backupMemoryDb' });
    const gone = path.join(mktmp('bsi-x-'), 'nope.js');
    expect(run(gone).rc).toBe(5);
  });

  it('keeps the pragma literal OUT of backupMemoryDb, so the gate stays about upstream', () => {
    // Invariant the tool documents: our own patch must never be able to satisfy
    // the self-retirement gate it is guarded by.
    const f = scratch();
    run(f);
    const s = fs.readFileSync(f, 'utf8');
    const start = s.indexOf('async function backupMemoryDb');
    const end = s.indexOf('\n/**', start);
    expect(s.slice(start, end)).not.toContain('integrity_check');
    expect(s).toContain('integrity_check'); // ...but the helper still has it
  });
});

describe('BACKUP-SOURCE-INTEGRITY-V1 — lib/fix-ruflo.sh Step 3d wiring', () => {
  const src = fs.readFileSync(FIX_RUFLO, 'utf8');

  it('is a syntactically valid script', () => {
    expect(spawnSync('bash', ['-n', FIX_RUFLO], { encoding: 'utf8' }).status).toBe(0);
  });

  it('is labelled 3d/11 — the Step-3x global dist-patch family', () => {
    expect(src).toContain('header "3d/11"');
    expect(src).toMatch(/header "3d\/11" ".*BACKUP-SOURCE-INTEGRITY-V1/);
  });

  it('did NOT collide with the already-taken 11c / 11d labels', () => {
    // 11c/11 is the CVE-count fabrication check and must remain exactly one
    // step; 11d must not have been invented for this patch.
    const headers = [...src.matchAll(/header "([^"]+)"/g)].map((m) => m[1]);
    expect(headers.filter((h) => h === '11c/11').length).toBe(1);
    expect(headers.filter((h) => h === '3d/11').length).toBe(1);
    expect(headers).not.toContain('11d/11');
    expect(new Set(headers).size).toBe(headers.length); // no duplicate labels at all
  });

  it('invokes the kit tool and handles every one of its exit codes', () => {
    expect(src).toContain('$KIT_TOOLS/backup-integrity-patch.cjs');
    const step = src.slice(src.indexOf('header "3d/11"'), src.indexOf('# ── Step 4:'));
    for (const rc of ['0)', '2)', '3)', '4)', '5)', '6)']) expect(step).toContain(rc);
  });

  it('rc 6 is reported as an honest upstream self-retirement, not a silent pass', () => {
    const step = src.slice(src.indexOf('header "3d/11"'), src.indexOf('# ── Step 4:'));
    expect(step).toMatch(/6\)\s*\n\s*pass ".*already fixed upstream.*self-retired/);
  });

  it('takes a .bak before writing, and only outside DRY_RUN', () => {
    const step = src.slice(src.indexOf('header "3d/11"'), src.indexOf('# ── Step 4:'));
    expect(step).toContain('.bsintegrity-bak');
    // The cp must be guarded by the dry-run check on its OWN line — an
    // unconditional cp is precisely the B11 dry-run-mutates defect class.
    expect(step).toMatch(/\[\[ "\$DRY_RUN" -eq 1 \|\| -e "\$BSI_DIST\.bsintegrity-bak" \]\] \|\| cp /);
    expect(step).toMatch(/BSI_DRY="--dry-run"/);
  });

  it('node --check-gates the write and restores the .bak when invalid', () => {
    const step = src.slice(src.indexOf('header "3d/11"'), src.indexOf('# ── Step 4:'));
    expect(step).toMatch(/node --check "\$BSI_DIST"/);
    expect(step).toMatch(/cp "\$BSI_DIST\.bsintegrity-bak" "\$BSI_DIST"/);
  });

  it('never promotes a whole-file grep to the retirement verdict', () => {
    // Both available whole-file greps lie (see the step's block comment). They
    // may be logged as drift INFO; they may not gate the patch.
    const step = src.slice(src.indexOf('header "3d/11"'), src.indexOf('# ── Step 4:'));
    const gating = step.match(/^\s*(if|elif) .*integrity_check.*$/gm) || [];
    for (const line of gating) expect(line).toMatch(/info |PRESENT/);
    expect(step).not.toMatch(/defect_gate "\$BSI_DIST" 'integrity_check'/);
    expect(step).toMatch(/info "whole-file grep sees integrity_check/);
  });
});

suite('BACKUP-SOURCE-INTEGRITY-V1 — Step 3d actually RUNS (hermetic)', () => {
  // Asserting the step's SOURCE text (above) cannot tell whether it executes.
  // This drives the real block with a stub `npm` on PATH resolving to a fake
  // global root, so the step patches a THROWAWAY dist copy — never the live one.
  const stepSrc = (() => {
    const s = fs.readFileSync(FIX_RUFLO, 'utf8');
    const a = s.indexOf('header "3d/11"');
    const b = s.indexOf('# ── Step 4:', a);
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    return s.slice(a, b);
  })();

  /** A fake global npm root + stub `npm`, and a runner that can fire repeatedly. */
  function harness() {
    const home = mktmp('bsi-h-');
    const groot = path.join(home, 'groot');
    const dist = path.join(groot, 'ruflo', 'node_modules', '@claude-flow', 'cli',
      'dist', 'src', 'services', 'memory-backup.js');
    fs.mkdirSync(path.dirname(dist), { recursive: true });
    fs.writeFileSync(dist, BASELINE.src);
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'npm'),
      `#!/bin/sh\nif [ "$1" = root ]; then echo ${JSON.stringify(groot)}; fi\nexit 0\n`, { mode: 0o755 });
    return { dist, run: (dryRun) => runStep({ bin, dist, dryRun }) };
  }

  function runStep({ bin, dist, dryRun }) {
    const script = `
set -u
KIT_TOOLS=${JSON.stringify(path.join(REPO, 'tools'))}
DRY_RUN=${dryRun ? 1 : 0}
ERRORS=0
header() { :; }
pass() { echo "PASS:$*"; }
warn() { echo "WARN:$*"; }
info() { echo "INFO:$*"; }
fix()  { echo "FIX:$*"; }
dist_defect_present() {
  [[ -f "$1" ]] || { echo "NO_FILE"; return; }
  if grep -Eq -- "$2" "$1" 2>/dev/null; then echo "PRESENT"; else echo "ABSENT"; fi
}
${stepSrc}
echo "ERRORS=$ERRORS"
`;
    const r = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    return { rc: r.status, out: (r.stdout || '') + (r.stderr || '') };
  }

  it('patches the (throwaway) dist, reports FIX, and leaves valid JavaScript', () => {
    const h = harness();
    const r = h.run(false);
    expect(r.rc).toBe(0);
    expect(r.out).toContain('FIX:');
    expect(r.out).toContain('APPLIED:4/4');
    expect(r.out).toContain('ERRORS=0');
    expect(fs.readFileSync(h.dist, 'utf8')).toContain(SENTINEL);
    expect(fs.existsSync(`${h.dist}.bsintegrity-bak`)).toBe(true);
    expect(spawnSync('node', ['--check', h.dist]).status).toBe(0);
  });

  it('is idempotent across runs — second run PASSes and rewrites nothing', () => {
    const h = harness();
    h.run(false);
    const after = fs.readFileSync(h.dist, 'utf8');
    const r2 = h.run(false);
    expect(r2.out).toMatch(/PASS:.*already installed \(BACKUP-SOURCE-INTEGRITY-V1\)/);
    expect(r2.out).toContain('ERRORS=0');
    expect(r2.out).not.toContain('FIX:');
    expect(fs.readFileSync(h.dist, 'utf8')).toBe(after);
  });

  it('DRY_RUN mutates NOTHING — no patch, no .bak', () => {
    const h = harness();
    const r = h.run(true);
    expect(r.rc).toBe(0);
    expect(r.out).toContain('[dry-run] Would:');
    expect(r.out).toContain('ERRORS=0');
    expect(fs.readFileSync(h.dist, 'utf8')).toBe(BASELINE.src);
    expect(fs.existsSync(`${h.dist}.bsintegrity-bak`)).toBe(false);
    // POSITIVE CONTROL: the same harness DOES write when DRY_RUN is off, so
    // "nothing changed" is not satisfied by a step that simply never ran.
    h.run(false);
    expect(fs.readFileSync(h.dist, 'utf8')).not.toBe(BASELINE.src);
    expect(fs.existsSync(`${h.dist}.bsintegrity-bak`)).toBe(true);
  });

  it('logs the whole-file-grep drift note without letting it become the verdict', () => {
    const h = harness();
    const r = h.run(true);
    expect(r.out).toContain('INFO:whole-file grep sees integrity_check');
    expect(r.out).not.toContain('self-retired');
  });

  it('reports an honest self-retirement once upstream guards the backup path itself', () => {
    // End-to-end proof of the rc-6 branch: same step, same harness, only the
    // dist changes — and the kit stands down instead of patching.
    const h = harness();
    fs.writeFileSync(h.dist, BASELINE.src.replace(
      '    const destDir = opts.destDir ?? path.join(path.dirname(dbPath), \'backups\');',
      '    const __up = new Database(dbPath, { readonly: true }).pragma(\'integrity_check\');\n'
      + '    const destDir = opts.destDir ?? path.join(path.dirname(dbPath), \'backups\');'));
    const r = h.run(false);
    expect(r.out).toMatch(/PASS:.*already fixed upstream.*self-retired/);
    expect(r.out).toContain('ERRORS=0');
    expect(r.out).not.toContain('FIX:');
    expect(fs.readFileSync(h.dist, 'utf8')).not.toContain(SENTINEL);
  });
});
