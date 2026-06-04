#!/usr/bin/env node
/**
 * Security + functional regression harness for the execFileSync conversion in
 * assets/statusline.cjs and .claude/helpers/statusline.cjs.
 *
 * The statusline sqlite helpers are NOT exported, so we replicate the EXACT
 * patched one-liners here (mirrored verbatim from the patched files, lines 68/72),
 * plus the EXACT OLD vulnerable shell-string form for the control case.
 *
 * Integrity rule: REAL sqlite3 CLI, REAL on-disk DBs, REAL injection attempt.
 * No mocks, no assumed passes. Every assertion prints ACTUAL observed output.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// PATCHED helpers — mirrored VERBATIM from the patched files (L68 / L72).
//   _ra_count: execFileSync('sqlite3', ['-readonly', db, sql], ...)
//   _ra_tbl:   execFileSync('sqlite3', ['-readonly', db, "SELECT 1 ... name='"+t+"' LIMIT 1;"], ...)
// ---------------------------------------------------------------------------
function patched_ra_count(db, sql) {
  if (!fs.existsSync(db)) return 0;
  try { const o = execFileSync('sqlite3', ['-readonly', db, sql], { timeout: 2000, stdio: ['ignore','pipe','ignore'] }).toString(); const n = parseInt(o, 10); return Number.isFinite(n) ? n : 0; } catch (e) { return 0; }
}
function patched_ra_tbl(db, t) {
  if (!fs.existsSync(db)) return false;
  try { return execFileSync('sqlite3', ['-readonly', db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='" + t + "' LIMIT 1;"], { timeout: 2000, stdio: ['ignore','pipe','ignore'] }).toString().trim() === '1'; } catch (e) { return false; }
}

// ---------------------------------------------------------------------------
// OLD vulnerable form — mirrored VERBATIM from pre-fix L68 (control / teeth).
// Intentionally builds a shell string. We DO NOT guard fs.existsSync here so we
// can demonstrate the injection fires even when the db "file" path is crafted.
// ---------------------------------------------------------------------------
function old_ra_count_VULNERABLE(db, sql) {
  const o = execSync('sqlite3 -readonly "' + db + '" "' + sql + '"', { timeout: 2000, stdio: ['ignore','pipe','ignore'] }).toString();
  const n = parseInt(o, 10);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Tiny assertion + reporting framework
// ---------------------------------------------------------------------------
const results = [];
function record(name, pass, observed) {
  results.push({ name, pass, observed });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}`);
  console.log(`        observed: ${observed}`);
}

const cleanup = [];               // dirs/files to rm in finally
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }

// Collect any markers anywhere they could plausibly land.
function findMarkers(marker) {
  const hits = [];
  for (const dir of ['/tmp', os.tmpdir(), process.cwd()]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.includes(marker)) hits.push(path.join(dir, f));
      }
    } catch (e) {}
  }
  return [...new Set(hits)];
}

function makeDbWithRows(dbPath, n) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const rows = Array.from({ length: n }, (_, i) => `(${i + 1}, x'00')`).join(',');
  execFileSync('sqlite3', [dbPath,
    'CREATE TABLE embeddings(id INTEGER PRIMARY KEY, vec BLOB);' +
    (n > 0 ? `INSERT INTO embeddings(id, vec) VALUES ${rows};` : '')
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
function main() {
  const rand = Math.random().toString(36).slice(2, 10) + '_' + Date.now();

  // === TEST 1: FUNCTIONAL — patched _ra_count returns the known row count ===
  {
    const D = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-func-'));
    cleanup.push(D);
    const db = path.join(D, '.agentic-qe', 'memory.db');
    const N = 7;
    makeDbWithRows(db, N);

    const count = patched_ra_count(db, 'SELECT COUNT(*) FROM embeddings');
    const tblExists = patched_ra_tbl(db, 'embeddings');
    const tblMissing = patched_ra_tbl(db, 'no_such_table');

    record('T1a FUNCTIONAL _ra_count returns known N=7',
      count === N, `_ra_count => ${count} (expected ${N})`);
    record('T1b FUNCTIONAL _ra_tbl true for existing table',
      tblExists === true, `_ra_tbl('embeddings') => ${tblExists}`);
    record('T1c FUNCTIONAL _ra_tbl false for missing table',
      tblMissing === false, `_ra_tbl('no_such_table') => ${tblMissing}`);
  }

  // === TEST 3 (run before 2 for clarity): BENIGN PATH WITH SPACES reads OK ===
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-spaces-'));
    cleanup.push(base);
    const spacey = path.join(base, 'a dir with spaces', 'and more');
    const db = path.join(spacey, '.agentic-qe', 'memory.db');
    const N = 4;
    makeDbWithRows(db, N);

    const count = patched_ra_count(db, 'SELECT COUNT(*) FROM embeddings');
    record('T3 BENIGN path-with-spaces reads correctly post-patch',
      count === N, `count over "${db}" => ${count} (expected ${N})`);
  }

  // === TEST 2: SECURITY REGRESSION — injection neutralized by execFileSync ===
  // Craft a path whose directory name carries a shell-injection payload.
  // If a shell ever interprets the db string, `touch /tmp/PWNED_<rand>` runs.
  let evilDir, evilDb;
  {
    const marker = `PWNED_${rand}`;
    const markerPath = `/tmp/${marker}`;
    // Pre-clean any stale marker
    rmrf(markerPath);

    // The injected fragment that breaks out of the OLD `"...db..."` quoting.
    const payloadName = `a";touch ${markerPath};"b`;
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-evil-'));
    cleanup.push(tmpRoot);
    cleanup.push(markerPath);
    evilDir = path.join(tmpRoot, payloadName, '.agentic-qe');
    fs.mkdirSync(evilDir, { recursive: true });
    evilDb = path.join(evilDir, 'memory.db');
    // Create a REAL valid db at that crafted path so the patched reader actually opens it.
    makeDbWithRows(evilDb, 3);

    // --- 2a: PATCHED path — must NOT create marker, must NOT throw ---
    let threw = null, ret;
    try {
      ret = patched_ra_count(evilDb, 'SELECT COUNT(*) FROM embeddings');
    } catch (e) { threw = e; }
    const markersAfterPatched = findMarkers(`PWNED_${rand}`);

    record('T2a SECURITY patched _ra_count did NOT execute injected touch',
      markersAfterPatched.length === 0,
      `markers found after patched call: ${JSON.stringify(markersAfterPatched)}`);
    record('T2b SECURITY patched _ra_count did NOT throw (graceful)',
      threw === null,
      `threw: ${threw ? threw.message : 'none'} ; returned: ${ret}`);
    // Bonus: because db is a REAL valid sqlite file at that literal path, the
    // patched reader should actually read it correctly (path passed as argv, not shell).
    record('T2c SECURITY patched reader still reads the real db at the evil literal path',
      ret === 3,
      `_ra_count over crafted-but-real db => ${ret} (expected 3)`);

    // --- 2-control: OLD form — must create marker (proves test has teeth) ---
    // Clean first so we attribute the marker solely to the old form.
    for (const m of findMarkers(`PWNED_${rand}`)) rmrf(m);
    let ctlThrew = null;
    try {
      old_ra_count_VULNERABLE(evilDb, 'SELECT COUNT(*) FROM embeddings');
    } catch (e) { ctlThrew = e; } // shell may exit non-zero AFTER touch runs; that's fine
    const markersAfterOld = findMarkers(`PWNED_${rand}`);

    record('T2d CONTROL old shell-string form DID execute injected touch (teeth)',
      markersAfterOld.length > 0,
      `markers found after OLD form: ${JSON.stringify(markersAfterOld)} ; old-form threw: ${ctlThrew ? ctlThrew.message.split('\n')[0] : 'none'}`);

    // Clean up the marker(s) the control intentionally created.
    for (const m of findMarkers(`PWNED_${rand}`)) { rmrf(m); cleanup.push(m); }
    const markersFinal = findMarkers(`PWNED_${rand}`);
    record('T2e CLEANUP all PWNED markers removed',
      markersFinal.length === 0,
      `markers remaining: ${JSON.stringify(markersFinal)}`);
  }

  return results.every(r => r.pass);
}

let ok = false;
try {
  ok = main();
} catch (fatal) {
  console.log('FATAL harness error:', fatal && fatal.stack ? fatal.stack : fatal);
  ok = false;
} finally {
  for (const p of cleanup) rmrf(p);
  // Extra safety sweep for any stray PWNED markers from this run
  for (const dir of ['/tmp', os.tmpdir(), process.cwd()]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith('PWNED_')) rmrf(path.join(dir, f));
      }
    } catch (e) {}
  }
}

console.log('\n=================== SUMMARY ===================');
const passed = results.filter(r => r.pass).length;
console.log(`${passed}/${results.length} assertions passed`);
console.log(`VERDICT: ${ok ? 'SECURE' : 'NOT-SECURE'}`);
process.exit(ok ? 0 : 1);
