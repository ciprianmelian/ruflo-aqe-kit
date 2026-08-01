#!/usr/bin/env node
/*
 * BACKUP-SOURCE-INTEGRITY-V1 (kit issue #6) — make `backupMemoryDb()` look at
 * the SOURCE before it copies it forward.
 *
 * Root cause: the installed `@claude-flow/cli` dist
 * (dist/src/services/memory-backup.js) takes a WAL-safe online backup of
 * `.swarm/memory.db` and NEVER runs `PRAGMA integrity_check` on the source.
 * `restoreMemoryDbFromBackup()` already does the right thing on the way OUT —
 * it verifies each candidate and walks back to a clean one. There is simply no
 * check on the way IN, so a corrupt DB is faithfully copied forward every
 * night, recorded as `{ backedUp: true }`, and the last clean snapshot rotates
 * out of retention unnoticed. (Reported window: clean 2026-07-19, corrupt by
 * 2026-07-21, every later snapshot corrupt.)
 *
 * TWO unguarded success paths, not one — a patch covering only the first
 * reproduces this kit's signature defect (a check that reports healthy because
 * it never looked at the path that matters):
 *   A. the online-backup path       (`await db.backup(destPath)`)
 *   B. the byte-copy fallback added by upstream #2798
 *      (`fs.copyFileSync(dbPath, destPath)` when `db.backup()` throws)
 * B is the WORSE one: a DB corrupt enough that better-sqlite3 refuses to open
 * it lands there and is reported as a successful backup. Both are covered by
 * probing ONCE, before either path runs, at the single point where `destPath`
 * is computed.
 *
 * Behaviour added:
 *   - `PRAGMA integrity_check` on the SOURCE before backing up.
 *   - Not `ok` => STILL take the backup (best-effort preservation of whatever
 *     is salvageable) but tag the file `memory-<stamp>.CORRUPT.db`, and emit an
 *     UNCONDITIONAL `console.warn` with the full diagnostic. Never behind
 *     `opts.verbose`: a swallowed warning is the actual bug.
 *   - `sourceIntegrity` / `sourceCorrupt` propagated to the caller on every
 *     return, so a programmatic consumer can tell too.
 *
 * THREE states, on purpose. Under `CLAUDE_FLOW_ENCRYPT_AT_REST` the source is
 * an RFE1 blob, not a native SQLite image (that is exactly why upstream #2798
 * added path B). The pragma does not apply to it, and calling that
 * NOT-ASSESSABLE case "corrupt" would raise a false alarm on every encrypted
 * nightly run. A file-header probe separates the two before opening.
 *
 * Self-retiring: the gate is FUNCTION-SCOPED, not a whole-file grep. A naive
 * grep reads PRESENT on the unpatched dist because the RESTORE path has the
 * pragma — the exact "check that cannot tell" class this kit keeps finding.
 * This tool slices `backupMemoryDb`'s own body and retires the moment upstream
 * puts a source-integrity check inside it.
 *
 * Usage: node backup-integrity-patch.cjs <memory-backup.js> [--dry-run]
 * Stderr protocol (single verdict token; stdout stays quiet):
 *   APPLIED:<n>/<m> | WOULD_APPLY:<n>/<m> | ALREADY_PATCHED | SELF_RETIRED
 *   ANCHOR_NOT_FOUND:<why> | PARTIAL:<n>/<m> ... | WRITE_FAILED:<code>
 *   READ_FAILED:<code>
 * Exit codes (the fix-ruflo.sh wrapper depends on these):
 *   0 = written, would-write (dry-run), or already carrying this patch
 *   2 = ANCHOR_NOT_FOUND — not a memory-backup.js this patch knows how to
 *       read. No write.
 *   3 = PARTIAL — at least one but not all anchors accounted for. FAIL CLOSED:
 *       a single unmatched anchor blocks the ENTIRE write (and the sentinel),
 *       rather than shipping a file that is only mostly fixed. No write.
 *   4 = WRITE_FAILED — fs.writeFileSync threw. Nothing written.
 *   5 = READ_FAILED — fs.readFileSync threw.
 *   6 = SELF_RETIRED — upstream's own backupMemoryDb already checks source
 *       integrity. Nothing to do; the stopgap has retired itself.
 */
'use strict';

const fs = require('fs');

const SENTINEL = 'BACKUP-SOURCE-INTEGRITY-V1';

const F = process.argv[2];
const DRY_RUN = process.argv.includes('--dry-run');
if (!F) {
  console.error('ANCHOR_NOT_FOUND:no_file_argument');
  process.exit(2);
}

let s;
try {
  s = fs.readFileSync(F, 'utf8');
} catch (e) {
  console.error(`READ_FAILED:${e.code || e.message}`);
  process.exit(5);
}

// ── The helper injected into the dist ───────────────────────────────────────
// Emitted as a line array of DOUBLE-quoted source, so the dist's own backticks
// and ${...} need no escaping and read exactly as they will land on disk.
const HELPER = [
  '',
  '/*',
  ' * BACKUP-SOURCE-INTEGRITY-V1 (ruflo-aqe-kit, issue #6) — verify the SOURCE',
  ' * before snapshotting it.',
  ' *',
  ' * backupMemoryDb() has TWO success paths and neither used to look at the',
  ' * source: the WAL-safe online backup, and the raw fs.copyFileSync() byte',
  ' * copy added by #2798 for encrypted-at-rest sources. The byte copy is the',
  ' * worse one — a DB corrupt enough that better-sqlite3 refuses to OPEN it',
  ' * falls through to it and is reported as { backedUp: true }. So the probe',
  ' * runs once, before either path, at the point destPath is computed.',
  ' *',
  ' * Three states on purpose. Under CLAUDE_FLOW_ENCRYPT_AT_REST the source is',
  ' * an RFE1 blob, not a native SQLite image; the pragma does not apply to it,',
  ' * and calling that NOT-ASSESSABLE case "corrupt" would be a false alarm on',
  ' * every encrypted nightly run. The header probe below separates "cannot',
  ' * assess" from "assessed and bad" before opening anything.',
  ' */',
  "const __KIT_SQLITE_MAGIC = 'SQLite format 3\\u0000';",
  'async function __kitProbeSourceIntegrity(Database, dbPath) {',
  '    let header = null;',
  '    try {',
  "        const fd = fs.openSync(dbPath, 'r');",
  '        try {',
  '            const buf = Buffer.alloc(16);',
  '            const n = fs.readSync(fd, buf, 0, 16, 0);',
  "            header = n > 0 ? buf.subarray(0, 16).toString('latin1') : '';",
  '        }',
  '        finally {',
  '            fs.closeSync(fd);',
  '        }',
  '    }',
  '    catch (e) {',
  '        return {',
  '            assessed: false,',
  '            corrupt: false,',
  '            integrity: `not-assessable: source header unreadable (${e?.message ?? e})`,',
  '        };',
  '    }',
  '    // n === 0 is a zero-byte file, which sqlite legitimately treats as a fresh',
  '    // empty DB — let that through to the real check rather than guessing.',
  '    if (header && header !== __KIT_SQLITE_MAGIC) {',
  '        return {',
  '            assessed: false,',
  '            corrupt: false,',
  "            integrity: 'not-assessable: source is not a native SQLite image "
    + "(encrypted-at-rest per #2798, or truncated) — the sqlite self-check does not apply',",
  '        };',
  '    }',
  '    let db = null;',
  '    try {',
  '        db = new Database(dbPath, { readonly: true });',
  "        const integ = String(db.pragma('integrity_check', { simple: true }) ?? '');",
  '        db.close();',
  '        db = null;',
  "        if (integ.toLowerCase() === 'ok')",
  "            return { assessed: true, corrupt: false, integrity: 'ok' };",
  "        return { assessed: true, corrupt: true, integrity: integ || '(empty pragma result)' };",
  '    }',
  '    catch (e) {',
  '        try {',
  '            db?.close();',
  '        }',
  '        catch { /* */ }',
  '        // The header says native SQLite but the engine refuses to read it.',
  '        // That IS corruption — and it is precisely the case that falls',
  '        // through to the byte-copy fallback and is reported as a success.',
  '        return { assessed: true, corrupt: true, integrity: `unopenable: ${e?.message ?? e}` };',
  '    }',
  '}',
  '',
].join('\n');

// Anchored on fileStamp(): the last declaration before backupMemoryDb, and the
// only place the helper can sit above both of its call sites.
const HELPER_ANCHOR = [
  "/** ISO timestamp safe for filenames (no ':' or '.'). */",
  'function fileStamp(ms) {',
  "    return new Date(ms).toISOString().replace(/[:.]/g, '-');",
  '}',
  '',
].join('\n');

// ── The call-site rewrites ──────────────────────────────────────────────────
// INVARIANT: no NEW body below contains the literal `integrity_check`. That
// string lives only in the helper (which sits OUTSIDE backupMemoryDb), so the
// function-scoped self-retirement gate stays a statement about UPSTREAM's code
// and can never be satisfied by our own patch.
const PAIRS = [
  // (1) Single probe point covering BOTH success paths.
  [
    '    const destPath = path.join(destDir, `memory-${fileStamp(opts.timestamp ?? Date.now())}.db`);',
    [
      '    // BACKUP-SOURCE-INTEGRITY-V1: probe the SOURCE before either success',
      '    // path copies it forward — the online backup below AND the #2798',
      '    // byte-copy fallback in its catch block.',
      '    const __kitSrc = await __kitProbeSourceIntegrity(Database, dbPath);',
      "    const destPath = path.join(destDir, `memory-${fileStamp(opts.timestamp ?? Date.now())}"
        + "${__kitSrc.corrupt ? '.CORRUPT' : ''}.db`);",
      '    if (__kitSrc.corrupt) {',
      '        // UNCONDITIONAL — never behind opts.verbose. A backup of a corrupt',
      '        // DB that reports success is the whole defect: the corruption is',
      '        // copied forward nightly and the last clean snapshot rotates out.',
      '        console.warn(`[BACKUP-SOURCE-INTEGRITY-V1] memory DB source FAILED its sqlite'
        + ' self-check: ${dbPath}`',
      '            + `\\n  pragma result: ${__kitSrc.integrity}`',
      '            + `\\n  Snapshot still taken (best-effort preservation) but TAGGED CORRUPT:`',
      '            + `\\n    ${destPath}`',
      '            + `\\n  Do NOT treat this as a good backup. Restore from an older verified`',
      '            + `\\n  snapshot — restoreMemoryDbFromBackup() skips failing candidates.`);',
      '    }',
      '    else if (!__kitSrc.assessed) {',
      '        // Explicit third state. A check that cannot tell must SAY it cannot',
      '        // tell, rather than reporting healthy by default.',
      '        console.warn(`[BACKUP-SOURCE-INTEGRITY-V1] memory DB source integrity NOT'
        + ' ASSESSABLE: ${dbPath}`',
      '            + `\\n  ${__kitSrc.integrity}`',
      '            + `\\n  Snapshot taken and named normally; its integrity is simply unverified.`);',
      '    }',
    ].join('\n'),
  ],
  // (2) Path B — the #2798 byte-copy fallback's success return.
  [
    '                return { backedUp: true, path: destPath, sizeBytes: copiedBytes, rotatedAway, gcsUri };',
    '                return { backedUp: true, path: destPath, sizeBytes: copiedBytes, rotatedAway, gcsUri,'
      + ' sourceIntegrity: __kitSrc.integrity, sourceCorrupt: __kitSrc.corrupt };',
  ],
  // (3) Path B gave up too — report what we knew about the source anyway.
  [
    '        return { backedUp: false, skipped: `backup failed: ${e?.message ?? e}` };',
    '        return { backedUp: false, skipped: `backup failed: ${e?.message ?? e}`,'
      + ' sourceIntegrity: __kitSrc.integrity, sourceCorrupt: __kitSrc.corrupt };',
  ],
  // (4) Path A — the online-backup success return.
  [
    '    return { backedUp: true, path: destPath, sizeBytes, rotatedAway, gcsUri };',
    '    return { backedUp: true, path: destPath, sizeBytes, rotatedAway, gcsUri,'
      + ' sourceIntegrity: __kitSrc.integrity, sourceCorrupt: __kitSrc.corrupt };',
  ],
];

// ── Function-scoped self-retirement gate ────────────────────────────────────
// Slice backupMemoryDb's OWN body. A whole-file grep for the pragma reads
// PRESENT on the unpatched dist (restoreMemoryDbFromBackup has it) and would
// retire this patch on day one against a still-broken backup path.
//
// The boundary has to be TIGHT, and getting it wrong is silent: stopping at the
// next `export` overshoots into restoreMemoryDbFromBackup's DOCSTRING, which
// names the pragma in prose — enough to make this gate read SELF_RETIRED
// against the confirmed-defective dist (observed while building this). So take
// the EARLIEST of: the function's own column-0 closing brace (tsc indents every
// nested block, so a `}` at column 0 can only be the top-level one), the next
// docstring, and the next top-level export.
function backupFnBody(src) {
  const start = src.indexOf('async function backupMemoryDb');
  if (start < 0) return null;
  const ends = [];
  const brace = src.indexOf('\n}\n', start);
  if (brace >= 0) ends.push(brace + 3);
  const doc = src.indexOf('\n/**', start);
  if (doc >= 0) ends.push(doc);
  const exp = src.indexOf('\nexport ', start);
  if (exp >= 0) ends.push(exp);
  return src.slice(start, ends.length ? Math.min(...ends) : src.length);
}

const body = backupFnBody(s);
if (body === null) {
  console.error('ANCHOR_NOT_FOUND:backupMemoryDb');
  process.exit(2);
}

// Our own patch is recognised FIRST. It deliberately keeps the pragma literal
// out of the function body, so the upstream gate below cannot be fooled by it.
if (s.includes(SENTINEL) && PAIRS.every(([, nw]) => s.includes(nw))) {
  console.error('ALREADY_PATCHED');
  process.exit(0);
}

if (/integrity_check/.test(body)) {
  console.error('SELF_RETIRED');
  process.exit(6);
}

// ── Apply ───────────────────────────────────────────────────────────────────
// Three-way accounting per pair (applied / already-in-new-shape / missing) so
// a legacy PARTIAL file can still be finished off, and only a pair matching
// NEITHER shape counts as genuine drift.
let out = s;
if (!out.includes(SENTINEL)) {
  if (!out.includes(HELPER_ANCHOR)) {
    console.error('ANCHOR_NOT_FOUND:fileStamp');
    process.exit(2);
  }
  out = out.replace(HELPER_ANCHOR, HELPER_ANCHOR + HELPER);
}

let applied = 0;
let alreadyDone = 0;
const missing = [];
for (const [oldStr, newStr] of PAIRS) {
  if (out.includes(oldStr)) {
    out = out.split(oldStr).join(newStr);
    applied++;
  } else if (out.includes(newStr)) {
    alreadyDone++;
  } else {
    missing.push(oldStr.trim().slice(0, 70));
  }
}

const total = PAIRS.length;
const accounted = applied + alreadyDone;

if (accounted === 0) {
  console.error('ANCHOR_NOT_FOUND:no_pairs_matched');
  process.exit(2);
}
// FAIL CLOSED. Anything short of every anchor accounted for blocks the write
// AND the sentinel, so the next run re-detects the defect and tries again
// rather than freezing on a half-fixed file behind a green sentinel.
if (accounted !== total) {
  console.error(`PARTIAL:${accounted}/${total} (applied_now=${applied} already_done=${alreadyDone}) `
    + `MISSING:${JSON.stringify(missing)}`);
  process.exit(3);
}

if (DRY_RUN) {
  console.error(`WOULD_APPLY:${applied}/${total}${alreadyDone ? ' ALREADY_DONE:' + alreadyDone : ''}`);
  process.exit(0);
}

try {
  fs.writeFileSync(F, out);
} catch (e) {
  console.error(`WRITE_FAILED:${e.code || e.message}`);
  process.exit(4);
}
console.error(`APPLIED:${applied}/${total}${alreadyDone ? ' ALREADY_DONE:' + alreadyDone : ''}`);
process.exit(0);
