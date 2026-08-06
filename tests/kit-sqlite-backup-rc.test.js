/**
 * Regression tests for `kit_sqlite_backup` (lib/common.sh) — B17
 * "sqlite-backup-rc-conflation" (the gauntlet 2026-07-31 master ledger,
 * flagged by B13, confirmed by its critic).
 *
 * THE DEFECT: before this fix, `kit_sqlite_backup` returned the same bare
 * `rc=1` for two materially different states:
 *   (a) the input db doesn't exist at all (a usage/precondition error — the
 *       caller asked for a file that isn't there), and
 *   (b) a backup was genuinely ATTEMPTED but the destination ended up empty
 *       (a real failure — "it looked like it worked and didn't").
 * A caller reading only the boolean success/failure of this function could
 * not tell "nothing was ever attempted" from "an attempt silently produced
 * nothing" — and the second is the dangerous one: an empty backup reporting
 * the same code as a typo'd path is how a restore discovers there was
 * nothing to restore.
 *
 * THE FIX: a tri-state exit code matching this file's own established
 * convention (kit_sqlite_rw_check / kit_bsqlite_verdict / the B19
 * kit_memory_roundtrip_check fix — 0/1/2, not agentic-kit's numeric mapping):
 *   0 success          — backup landed non-empty.
 *   1 genuine failure  — attempted (input present, an instrument existed)
 *                        but produced no usable output.
 *   2 usage/precondition — never attempted: input db missing, OR no sqlite
 *                        instrument on this host at all.
 *
 * ROUND 2 (critic-found, same session): the round-1 fix only replaced the
 * two precondition `return 1`s with `return 2` — it never touched the
 * SUCCESS gate itself, which was `[[ -s "$dest" ]]` alone, never checking
 * the backup COMMAND's own exit status. A failing `sqlite3 ... .backup`
 * (e.g. `db` isn't a valid sqlite file at all) with a stale non-empty
 * `dest` left over from a previous run reported rc=0 "success" — the same
 * "cannot distinguish two materially different states" shape one layer
 * deeper, now inside the success path rather than between two failure
 * codes. Fixed by gating success on the command's own exit status FIRST,
 * then non-emptiness, then a cheap `SELECT 1` sanity read of the
 * destination (not a full `PRAGMA integrity_check` — disproportionate cost
 * for a routine call) confirming it is actually an openable database.
 *
 * ROUND 3 (adversarial critic, three more findings):
 *  (a) The round-2 CLI-arm readback was the function's LAST command with no
 *      `|| return 1` — bash returns a function's last command's own exit
 *      status when nothing overrides it, so a corrupt-but-openable db
 *      (sqlite3 reports SQLITE_CORRUPT=11) made the WHOLE FUNCTION return 11,
 *      silently violating its own documented 0/1/2 contract. Fixed: both
 *      arms now set an explicit `check_rc`, clamped to exactly 0 or 1.
 *  (b) The round-2 readback had ZERO coverage: the round-2 regression fixture
 *      (garbage text as the "corrupt source") fails at the cmd_rc gate and
 *      returns before the readback line is ever reached, so deleting the
 *      readback entirely would have survived the round-2 suite untouched.
 *      Fixed here with a fake-`sqlite3` PATH shim (fakebin convention, same
 *      idiom as tests/dryrun-mutation-guard.test.js /
 *      tests/fix-ruflo-dryrun.test.js) that reports SUCCESS on `.backup`
 *      while writing a deliberately corrupt destination, then fails the
 *      readback query — the only way to actually reach and exercise that
 *      code path. A committed mutation test proves this fixture kills a
 *      readback-deleted mutant while the round-2 fixture does not.
 *  (c) A failing backup could destroy a previously-valid `dest` before
 *      discovering the source was bad (round-2 wrote directly to the final
 *      `dest` path). Unreachable via the sole caller today (lib/snapshot.sh
 *      always builds a fresh timestamped `dest`), but fixed anyway: the
 *      function now writes to a `$dest.tmp.$$` sibling and renames it onto
 *      `dest` only after every check passes, so non-destruction is true by
 *      construction. Verified here by md5 before/after a failing call.
 *
 * This file drives the REAL `kit_sqlite_backup` (sourced from the real
 * lib/common.sh, not a reimplementation) through a tiny bash driver, matching
 * tests/kit-sqlite-shim.test.js's established idiom for this exact function
 * family (that file is left untouched — this is a new, self-contained
 * fixture per this repo's per-file convention).
 */
'use strict';

const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIB = path.resolve(__dirname, '..', 'lib');
const REAL_SQLITE3 = execSync('command -v sqlite3', { encoding: 'utf8', shell: 'bash' }).trim();

const worlds = [];
afterEach(() => {
  while (worlds.length) {
    const w = worlds.pop();
    try { fs.rmSync(w, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function writeExec(p, body) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
}

// Seed a real, valid sqlite db (runs under the full inherited PATH, before
// any PATH shimming for the test itself).
function seedDb(db) {
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const r = spawnSync(REAL_SQLITE3, [db, 'CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (1);'],
    { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sqlite3 seed failed: ${r.stderr || r.stdout}`);
}

// `libPath` (optional): source an alternate lib/common.sh — used by the
// round-3 mutation teeth tests to run the SAME driver against a deliberately
// mutated copy of the current (fixed) helper, rather than the real one.
function mkDriver(base, libPath) {
  const drv = path.join(base, 'driver.sh');
  writeExec(drv, `#!/usr/bin/env bash
source "${libPath || path.join(LIB, 'common.sh')}"
kit_sqlite_backup "$1" "$2"
echo "rc=$?"
`);
  return drv;
}

// fakebin convention (matches tests/dryrun-mutation-guard.test.js /
// tests/fix-ruflo-dryrun.test.js): a PATH dir holding a fake `sqlite3` that
// reports SUCCESS on `.backup <dest>` (writing deliberately corrupt,
// non-empty bytes to `<dest>`) but FAILS a subsequent `SELECT 1;` query
// against that same file — the only way to actually reach and exercise the
// round-2 readback check (a garbage-text "source" fails earlier, at the
// cmd_rc gate, and never gets there).
// fakebin variant for round-3 (c): a fake `sqlite3` that WRITES garbage
// bytes into whatever path it was told to `.backup` INTO, then reports
// FAILURE (exit 1). This is the actual shape of the destructive-overwrite
// bug: sqlite3 "getting further in" before erroring, not merely failing to
// open the source (a source that fails at open, as tried first here, never
// touches the backup-destination argument at all under either round — it is
// not a real repro of this bug, only a coincidental pass). Against round-2
// code (writes directly to `$dest`) this genuinely destroys a valid
// pre-existing `dest`; against round-3 code (writes to a `$tmp` sibling
// first) `dest` is never touched by the tool at all, so it survives by
// construction regardless of what garbage the tool writes to `$tmp`.
function mkFakebinPartialWriteThenFail(base) {
  const fakebin = path.join(base, 'bin-partial');
  writeExec(path.join(fakebin, 'sqlite3'), `#!/usr/bin/env bash
# args: sqlite3 <file> <sql>  where sql is e.g. .backup '<path>'
case "$2" in
  *.backup*)
    target="$(printf '%s' "$2" | sed -n "s/.*\\.backup '\\\\(.*\\\\)'.*/\\\\1/p")"
    printf 'PARTIAL-GARBAGE-FROM-A-CRASHED-COPY' > "$target"
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`);
  return fakebin;
}

function mkFakebinCorruptSqlite3(base) {
  const fakebin = path.join(base, 'bin');
  writeExec(path.join(fakebin, 'sqlite3'), `#!/usr/bin/env bash
# args: sqlite3 <file> <sql>
case "$2" in
  *.backup*)
    dest="$(printf '%s' "$2" | sed -n "s/.*\\.backup '\\\\(.*\\\\)'.*/\\\\1/p")"
    printf 'CORRUPT-BUT-NONEMPTY-BYTES' > "$dest"
    exit 0
    ;;
  *)
    exit 11
    ;;
esac
`);
  return fakebin;
}

// Mutation fixture (round-3 teeth): a copy of the CURRENT (fixed)
// lib/common.sh with kit_sqlite_backup's READBACK-CHECK-V1 gate neutered —
// simulating "someone deleted the readback" — everything else (the tri-state
// rc, the cmd_rc clamp, the atomic temp+rename) stays intact. Read literally
// from the real file so a future refactor that moves these exact lines
// fails this helper loudly (indexOf === -1) rather than silently mutating
// the wrong thing.
function mkReadbackDeletedMutant(base) {
  const src = fs.readFileSync(path.join(LIB, 'common.sh'), 'utf8');
  const startMarker = '  local check_rc\n  if [[ "$arm" == cli ]]; then';
  const endMarker = '  if [[ "$check_rc" -ne 0 ]]; then rm -f "$tmp" 2>/dev/null; return 1; fi\n';
  const start = src.indexOf(startMarker);
  const end = start === -1 ? -1 : src.indexOf(endMarker, start);
  if (start === -1 || end === -1) {
    throw new Error('mkReadbackDeletedMutant: readback markers not found in lib/common.sh — did kit_sqlite_backup change shape?');
  }
  const mutated = src.slice(0, start) + '  local check_rc=0  # MUTATED (test fixture): readback deleted\n' + src.slice(end + endMarker.length);
  const lib = path.join(base, 'mutant-lib');
  fs.mkdirSync(lib, { recursive: true });
  const dest = path.join(lib, 'common.sh');
  fs.writeFileSync(dest, mutated);
  return dest;
}

function runBackup(driver, db, dest, env) {
  const r = spawnSync('bash', [driver, db, dest], { encoding: 'utf8', env: env || process.env });
  const m = (r.stdout || '').match(/rc=(\d+)/);
  return { rc: m ? Number(m[1]) : null, stdout: r.stdout, stderr: r.stderr, code: r.status };
}

// Reconstructs the literal ORIGINAL (pre-B17, pre-Patch-72) `kit_sqlite_backup`
// — the bare rc=1-for-everything version this whole B17 fix line replaces.
// EMBEDDED, not `git show <ref>:lib/common.sh` — a prior version of this file
// pinned to `HEAD`, and the moment the B17 fix was committed (Patch 72,
// ac124a8) HEAD moved past the bug these teeth tests exist to reproduce,
// silently turning "proves the bug was real" into "reconstructs the fixed
// code and asserts it's still fixed" — a tautology that still happened to
// pass, for the wrong reason. Pinning to a specific SHA (e.g. `fbcff73`, the
// last commit before any of this session's fixes) would dodge that one
// failure mode but introduces an equivalent one under a history rewrite
// (rebase/squash/force-push), and this file already has a strictly more
// robust, git-independent pattern two functions below (mkRound2Lib,
// mkRound3Lib, for states that were NEVER committed at all) — this fixture
// now matches that same convention for consistency, rather than mixing
// styles for no reason. Small enough (17 lines) that embedding costs nothing
// noteworthy; ratchet up mkOriginalLib.recordedFromSha if this text is ever
// intentionally re-synced against a later baseline.
function mkOriginalLib(base) {
  const originalLib = `kit_sqlite_backup() {
  local db="$1" dest="$2"
  [[ -f "$db" ]] || return 1
  mkdir -p "$(dirname "$dest")" 2>/dev/null
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$db" ".backup '$dest'" 2>/dev/null
  else
    local bs; bs="$(npm root -g 2>/dev/null)/ruflo/node_modules/better-sqlite3"
    [[ -d "$bs" ]] || return 1
    node -e '
      const B = require(process.argv[1]);
      const db = new B(process.argv[2], { readonly: true, fileMustExist: true });
      db.backup(process.argv[3]).then(() => { db.close(); process.exit(0); })
        .catch(() => { process.exit(1); });
    ' "$bs" "$db" "$dest" 2>/dev/null
  fi
  [[ -s "$dest" ]]
}
`;
  const lib = path.join(base, 'original-lib');
  fs.mkdirSync(lib, { recursive: true });
  const libPath = path.join(lib, 'common.sh');
  fs.writeFileSync(libPath, originalLib);
  return libPath;
}
// recordedFromSha: 'fbcff73' (Patch 71, the last commit before this
// session's B17/B19 work) — informational only; this fixture does not read
// git at test-run time.
mkOriginalLib.recordedFromSha = 'fbcff73';

// Reconstructs the literal ROUND-2 `kit_sqlite_backup` (cmd_rc gate + the
// SELECT-1 readback, but no `|| return 1` clamp on the CLI arm, and writing
// directly to `$dest` rather than a tmp sibling) — used by the round-3 (a)
// and (c) teeth tests below. Round 2 was never committed to git (all of this
// session's fixes landed only in the working tree), so — same reasoning as
// mkOriginalLib above — this is reconstructed verbatim from the source in
// this file's own edit history instead of consulting git. The node arm is
// stubbed to a fixed `cmd_rc=1` (unreachable in these tests, which always
// have sqlite3 on PATH) purely so the file stays syntactically self-contained.
function mkRound2Lib(base) {
  const round2Lib = `kit_sqlite_backup() {
  local db="$1" dest="$2"
  [[ -f "$db" ]] || return 2
  mkdir -p "$(dirname "$dest")" 2>/dev/null
  local cmd_rc arm
  if command -v sqlite3 >/dev/null 2>&1; then
    arm=cli
    sqlite3 "$db" ".backup '$dest'" 2>/dev/null
    cmd_rc=$?
  else
    local bs; bs="$(npm root -g 2>/dev/null)/ruflo/node_modules/better-sqlite3"
    [[ -d "$bs" ]] || return 2
    arm=node
    cmd_rc=1
  fi
  [[ "$cmd_rc" -eq 0 ]] || return 1
  [[ -s "$dest" ]] || return 1
  if [[ "$arm" == cli ]]; then
    sqlite3 "$dest" "SELECT 1;" >/dev/null 2>&1
  fi
}
`;
  const lib = path.join(base, 'round2-lib');
  fs.mkdirSync(lib, { recursive: true });
  const libPath = path.join(lib, 'common.sh');
  fs.writeFileSync(libPath, round2Lib);
  return libPath;
}

// Reconstructs the literal ROUND-3 `kit_sqlite_backup` (the cmd_rc clamp,
// the tmp+rename atomicity, and READBACK-CHECK-V1 all present — but the
// promotion step shells out to `node -e fs.renameSync` UNCONDITIONALLY, and
// the argument handling is still bare `"$1"`/`"$2"`, not `"${1:-}"`/
// `"${2:-}"`) — used by both round-4 teeth tests below. Round 3 was never
// committed (same as round 2 — every fix this session landed only in the
// working tree), reconstructed verbatim from this file's own edit history.
function mkRound3Lib(base) {
  const round3Lib = `kit_sqlite_backup() {
  local db="$1" dest="$2"
  [[ -f "$db" ]] || return 2
  mkdir -p "$(dirname "$dest")" 2>/dev/null
  local tmp="\${dest}.tmp.$$"
  rm -f "$tmp" 2>/dev/null
  local cmd_rc arm
  if command -v sqlite3 >/dev/null 2>&1; then
    arm=cli
    sqlite3 "$db" ".backup '$tmp'" 2>/dev/null
    cmd_rc=$?
  else
    local bs; bs="$(npm root -g 2>/dev/null)/ruflo/node_modules/better-sqlite3"
    [[ -d "$bs" ]] || return 2
    arm=node
    cmd_rc=1
  fi
  if [[ "$cmd_rc" -ne 0 ]]; then rm -f "$tmp" 2>/dev/null; return 1; fi
  if [[ ! -s "$tmp" ]]; then rm -f "$tmp" 2>/dev/null; return 1; fi
  local check_rc
  if [[ "$arm" == cli ]]; then
    sqlite3 "$tmp" "SELECT 1;" >/dev/null 2>&1
    check_rc=$?
  else
    check_rc=1
  fi
  if [[ "$check_rc" -ne 0 ]]; then rm -f "$tmp" 2>/dev/null; return 1; fi
  if ! node -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$tmp" "$dest" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null; return 1
  fi
  return 0
}
`;
  const lib = path.join(base, 'round3-lib');
  fs.mkdirSync(lib, { recursive: true });
  const libPath = path.join(lib, 'common.sh');
  fs.writeFileSync(libPath, round3Lib);
  return libPath;
}

describe('kit_sqlite_backup — B17 tri-state exit code', () => {
  it('should_returnRc2_when_theInputDbDoesNotExist', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sqbackup-')));
    worlds.push(base);
    const driver = mkDriver(base);
    const { rc } = runBackup(driver, path.join(base, 'does-not-exist.db'), path.join(base, 'dest.db'));
    expect(rc).toBe(2);
  });

  it('should_returnRc0_andANonEmptyDest_when_theBackupGenuinelySucceeds', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sqbackup-')));
    worlds.push(base);
    const db = path.join(base, 'source.db');
    seedDb(db);
    const dest = path.join(base, 'dest.db');
    const driver = mkDriver(base);
    const { rc } = runBackup(driver, db, dest);
    expect(rc).toBe(0);
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.statSync(dest).size).toBeGreaterThan(0);
  });

  it('should_returnRc1_distinctFromRc2_when_aBackupIsAttemptedButProducesNoOutput', () => {
    // A real input db exists (so this is NOT the rc=2 "never attempted"
    // case) but the sqlite3 CLI on PATH is a shim that reports success
    // (exit 0) without ever touching the destination — the exact
    // "attempted, silently produced nothing" shape B17 exists to catch.
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sqbackup-')));
    worlds.push(base);
    const db = path.join(base, 'source.db');
    seedDb(db);
    const dest = path.join(base, 'dest.db');
    const driver = mkDriver(base);
    const noopBin = path.join(base, 'noop-bin');
    writeExec(path.join(noopBin, 'sqlite3'), `#!/usr/bin/env bash\nexit 0\n`);
    const env = { ...process.env, PATH: `${noopBin}:${process.env.PATH}` };
    const { rc } = runBackup(driver, db, dest, env);
    expect(rc).toBe(1);
    expect(rc).not.toBe(2);
    expect(fs.existsSync(dest)).toBe(false);
  });
});

describe('kit_sqlite_backup — B17 round 2: the success gate must check the command\'s own exit status', () => {
  it('should_returnRc1_notRc0_when_theSourceIsNotAValidSqliteDb_evenWithStaleNonEmptyDestContent', () => {
    // THE round-2 DEFECT (critic-found, live): the original B17 fix only
    // replaced the two precondition `return 1`s with `return 2` — it never
    // touched the SUCCESS gate, which was `[[ -s "$dest" ]]` alone, never
    // checking whether the backup COMMAND itself reported success. Point
    // `db` at a file that is not a valid sqlite database at all (`sqlite3
    // .backup` fails, non-zero exit, prints an error, and — critically —
    // never touches dest) while `dest` already has stale non-empty content
    // sitting there from a previous run. The old code returned 0 because it
    // only ever asked "is there a non-empty file here?", never "did the
    // backup actually happen?".
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sqbackup-')));
    worlds.push(base);
    const dest = path.join(base, 'dest.db');
    fs.writeFileSync(dest, 'stale content from yesterday');
    const notADb = path.join(base, 'source.db');
    fs.writeFileSync(notADb, 'not a real sqlite db');
    const driver = mkDriver(base);
    const { rc } = runBackup(driver, notADb, dest);
    expect(rc).toBe(1);
    expect(rc).not.toBe(0);
    // The stale content must be left exactly as it was — sqlite3's own
    // `.backup` never touches `dest` when `db` fails to open, so this also
    // confirms the fix isn't accidentally clobbering it on the way to
    // reporting failure.
    expect(fs.readFileSync(dest, 'utf8')).toBe('stale content from yesterday');
  });
});

describe('kit_sqlite_backup — B17 round 2 regression: pre-fix code reported SUCCESS for a failed command with stale dest content', () => {
  it('should_proveTeeth_byShowingThePreFixCodeReturnedRc0_forAFailingSourceWithStaleDestContent', () => {
    // Teeth mechanism: mkOriginalLib (embedded, git-independent — see its
    // own doc comment for why this file no longer uses `git show HEAD`).
    // Reconstruct the ORIGINAL kit_sqlite_backup and run the exact critic
    // repro against it, proving the bug was real, not merely described.
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sqbackup-teeth2-')));
    worlds.push(base);
    const libPath = mkOriginalLib(base);
    const drv = path.join(base, 'driver.sh');
    writeExec(drv, `#!/usr/bin/env bash
source "${libPath}"
kit_sqlite_backup "$1" "$2"
echo "rc=$?"
`);
    const dest = path.join(base, 'dest.db');
    fs.writeFileSync(dest, 'stale content from yesterday');
    const notADb = path.join(base, 'source.db');
    fs.writeFileSync(notADb, 'not a real sqlite db');
    const { rc } = runBackup(drv, notADb, dest);
    // Pre-fix: reported SUCCESS for a command that failed, because it only
    // ever checked `[[ -s "$dest" ]]`, never the command's own exit status.
    expect(rc).toBe(0);
    // ...and the stale content is what "succeeded" — the exact false
    // positive a restore would discover only after it was too late.
    expect(fs.readFileSync(dest, 'utf8')).toBe('stale content from yesterday');
  });
});

describe('kit_sqlite_backup — B17 regression: pre-fix code conflated both cases into rc=1', () => {
  it('should_proveTeeth_byShowingThePreFixCodeReturnsTheSameRc1ForBothMissingInputAndEmptyOutput', () => {
    // Teeth proof: run both scenarios below against the embedded ORIGINAL
    // pre-fix `kit_sqlite_backup` (mkOriginalLib — git-independent, see its
    // doc comment) and confirm they were genuinely indistinguishable (both
    // rc=1) before this fix — not merely asserted in prose.
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sqbackup-teeth-')));
    worlds.push(base);
    const libPath = mkOriginalLib(base);
    const drv = path.join(base, 'driver.sh');
    writeExec(drv, `#!/usr/bin/env bash
source "${libPath}"
kit_sqlite_backup "$1" "$2"
echo "rc=$?"
`);
    const missing = runBackup(drv, path.join(base, 'nope.db'), path.join(base, 'd1.db'));
    const db = path.join(base, 'source.db');
    seedDb(db);
    const dest = path.join(base, 'd2.db');
    const noopBin = path.join(base, 'noop-bin');
    writeExec(path.join(noopBin, 'sqlite3'), `#!/usr/bin/env bash\nexit 0\n`);
    const env = { ...process.env, PATH: `${noopBin}:${process.env.PATH}` };
    const emptyOutput = runBackup(drv, db, dest, env);
    // Pre-fix: both were rc=1 — genuinely indistinguishable.
    expect(missing.rc).toBe(1);
    expect(emptyOutput.rc).toBe(1);
    expect(missing.rc).toBe(emptyOutput.rc);
  });
});

describe('kit_sqlite_backup — B17 round 3 (a): the rc clamp — no raw command exit code may escape', () => {
  it('should_returnRc1_notTheRawSqlite3ExitCode_when_theCopyIsCorruptButOpenableEnoughToFailAQuery', () => {
    // A backup that reports SUCCESS on `.backup` (so it clears the round-2
    // cmd_rc gate) but whose copy fails a readback query with sqlite3's own
    // SQLITE_CORRUPT=11 — before this fix, that raw `11` was the function's
    // own return value (the readback was the LAST command, no `|| return 1`),
    // silently violating the documented 0/1/2 contract.
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sqbackup-clamp-')));
    worlds.push(base);
    const db = path.join(base, 'source.db');
    seedDb(db);
    const dest = path.join(base, 'dest.db');
    const driver = mkDriver(base);
    const fakebin = mkFakebinCorruptSqlite3(base);
    const env = { ...process.env, PATH: `${fakebin}:${process.env.PATH}` };
    const { rc } = runBackup(driver, db, dest, env);
    expect(rc).toBe(1);
    expect(rc).not.toBe(11);
    // The corrupt copy must never be promoted onto `dest` — this is also the
    // (c) atomic-non-destruction property, exercised via the same fixture.
    expect(fs.existsSync(dest)).toBe(false);
    // No leftover temp file either.
    const leftovers = fs.readdirSync(base).filter((f) => f.startsWith('dest.db.tmp.'));
    expect(leftovers).toEqual([]);
  });

  it('should_proveTeeth_byShowingRound2CodeLetsTheRawSqlite3ExitCodeLeakThroughUnclamped', () => {
    // Teeth for (a): run the IDENTICAL corrupt-readback fixture against the
    // reconstructed ROUND-2 kit_sqlite_backup (mkRound2Lib — no `|| return 1`
    // clamp on the CLI arm's readback, which was its last command) and
    // confirm the raw sqlite3 exit code (11, SQLITE_CORRUPT) genuinely leaks
    // through as the function's own return value.
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sqbackup-round2-teeth-a-')));
    worlds.push(base);
    const libPath = mkRound2Lib(base);
    const db = path.join(base, 'source.db');
    seedDb(db);
    const dest = path.join(base, 'dest.db');
    const driver = mkDriver(base, libPath);
    const fakebin = mkFakebinCorruptSqlite3(base);
    const env = { ...process.env, PATH: `${fakebin}:${process.env.PATH}` };
    const { rc } = runBackup(driver, db, dest, env);
    // Round 2: the raw SQLITE_CORRUPT code leaks through, unclamped —
    // silently violating the documented 0/1/2 contract.
    expect(rc).toBe(11);
  });
});

describe('kit_sqlite_backup — B17 round 3 (b): mutation teeth — the readback must actually be exercised', () => {
  it('should_proveTeeth_byShowingAReadbackDeletedMutantWronglyReportsSuccessOnTheFakebinFixture', () => {
    // Construct a mutant of the CURRENT (fixed) helper with ONLY the
    // readback neutered (kept everything else — the tri-state rc, the
    // cmd_rc clamp, the atomic temp+rename — intact), run the exact same
    // corruption fixture from the test above against it, and confirm the
    // mutation SURVIVES (wrongly reports success + promotes corrupt bytes)
    // — proving that test above is the thing standing between "readback
    // present" and "readback silently deleted", not a coincidence.
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sqbackup-mutant-')));
    worlds.push(base);
    const mutantLib = mkReadbackDeletedMutant(base);
    const db = path.join(base, 'source.db');
    seedDb(db);
    const dest = path.join(base, 'dest.db');
    const driver = mkDriver(base, mutantLib);
    const fakebin = mkFakebinCorruptSqlite3(base);
    const env = { ...process.env, PATH: `${fakebin}:${process.env.PATH}` };
    const { rc } = runBackup(driver, db, dest, env);
    expect(rc).toBe(0);
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, 'utf8')).toBe('CORRUPT-BUT-NONEMPTY-BYTES');
  });

  it('should_proveTheGapWasReal_byShowingTheOldRound2FixtureCannotKillTheSameMutant', () => {
    // The exact coverage gap the critic named: the round-2-style "garbage
    // text as the corrupt source" fixture fails at the EARLIER cmd_rc gate
    // and never reaches the readback at all — so it cannot tell a
    // readback-present helper from a readback-deleted one. Same mutant as
    // above, old-style fixture, rc is identical either way (a real
    // mutation-survival, not merely asserted in prose).
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sqbackup-mutant-gap-')));
    worlds.push(base);
    const mutantLib = mkReadbackDeletedMutant(base);
    const driver = mkDriver(base, mutantLib);
    const dest = path.join(base, 'dest.db');
    fs.writeFileSync(dest, 'stale content');
    const notADb = path.join(base, 'garbage-source.db');
    fs.writeFileSync(notADb, 'not a real sqlite db');
    const { rc: mutantRc } = runBackup(driver, notADb, dest);
    const realDriver = mkDriver(base);
    const dest2 = path.join(base, 'dest2.db');
    fs.writeFileSync(dest2, 'stale content');
    const { rc: realRc } = runBackup(realDriver, notADb, dest2);
    // Both the mutant (readback deleted) and the real fixed helper return
    // the SAME rc=1 on this old-style fixture — it genuinely cannot
    // distinguish them, confirming the gap the round 3 fakebin fixture above
    // was built specifically to close.
    expect(mutantRc).toBe(1);
    expect(realRc).toBe(1);
    expect(mutantRc).toBe(realRc);
  });
});

describe('kit_sqlite_backup — B17 round 3 (c): a failing backup must not destroy a valid pre-existing dest', () => {
  it('should_leaveAPreExistingValidDest_byteForByteUnchanged_when_theToolWritesPartialGarbageThenFails', () => {
    // Uses mkFakebinPartialWriteThenFail, NOT a source-fails-at-open fixture:
    // a source that never opens (e.g. garbage text) never touches the
    // backup-destination argument under EITHER round, so it cannot
    // distinguish "writes to dest directly" from "writes to a tmp sibling" —
    // it would pass by coincidence, not by testing the property. This
    // fixture genuinely reaches the destructive-overwrite class: the tool
    // "gets further in" (writes bytes to wherever it was told the backup
    // destination is), THEN fails.
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sqbackup-nondestruct-')));
    worlds.push(base);
    const db = path.join(base, 'source.db');
    seedDb(db);
    const dest = path.join(base, 'valid_dest.db');
    seedDb(dest); // dest already holds a real, valid, non-empty sqlite db
    const before = fs.readFileSync(dest);
    const driver = mkDriver(base);
    const fakebin = mkFakebinPartialWriteThenFail(base);
    const env = { ...process.env, PATH: `${fakebin}:${process.env.PATH}` };
    const { rc } = runBackup(driver, db, dest, env);
    expect(rc).toBe(1);
    const after = fs.readFileSync(dest);
    expect(after.equals(before)).toBe(true);
    // The pre-existing valid content must still be queryable, not merely
    // byte-identical by coincidence.
    const r = spawnSync(REAL_SQLITE3, [dest, 'SELECT COUNT(*) FROM t;'], { encoding: 'utf8' });
    expect(r.stdout.trim()).toBe('1');
  });

  it('should_proveTeeth_byShowingRound2CodeGenuinelyDestroysTheValidDestOnTheSameFixture', () => {
    // Teeth for (c): run the IDENTICAL partial-write-then-fail fixture
    // against the reconstructed ROUND-2 kit_sqlite_backup (mkRound2Lib —
    // wrote directly to `$dest`, before the round-3 tmp+rename fix) —
    // proving the vulnerability was real, not merely argued in prose.
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sqbackup-round2-teeth-c-')));
    worlds.push(base);
    const libPath = mkRound2Lib(base);
    const db = path.join(base, 'source.db');
    seedDb(db);
    const dest = path.join(base, 'valid_dest.db');
    seedDb(dest);
    const before = fs.readFileSync(dest);
    const driver = mkDriver(base, libPath);
    const fakebin = mkFakebinPartialWriteThenFail(base);
    const env = { ...process.env, PATH: `${fakebin}:${process.env.PATH}` };
    const { rc } = runBackup(driver, db, dest, env);
    expect(rc).toBe(1);
    const after = fs.readFileSync(dest);
    // Round 2: genuinely destroyed — this is the real vulnerability, not a
    // hypothetical.
    expect(after.equals(before)).toBe(false);
    expect(after.toString('utf8')).toBe('PARTIAL-GARBAGE-FROM-A-CRASHED-COPY');
  });
});

describe('kit_sqlite_backup — B17 round 4 (a): the CLI arm must not require node', () => {
  it('should_returnRc0_andCreateAValidDest_when_sqlite3IsPresentAndNodeIsAbsent', () => {
    // PATH=/usr/bin:/bin — the critic's exact repro: sqlite3 is present (a
    // real system binary lives there on macOS/most Linux), node is not
    // (node/npm/ruflo live under a separate nvm-managed directory on this
    // dev host and are never installed under /usr/bin or /bin).
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sqbackup-nonode-')));
    worlds.push(base);
    const db = path.join(base, 'source.db');
    seedDb(db);
    const dest = path.join(base, 'dest.db');
    const driver = mkDriver(base);
    const env = { PATH: '/usr/bin:/bin', HOME: base };
    const { rc } = runBackup(driver, db, dest, env);
    expect(rc).toBe(0);
    expect(fs.existsSync(dest)).toBe(true);
    const r = spawnSync('/usr/bin/sqlite3', [dest, 'SELECT COUNT(*) FROM t;'], { encoding: 'utf8' });
    expect(r.stdout.trim()).toBe('1');
  });

  it('should_proveTeeth_byShowingRound3CodeFailsOnTheSameMinimalPath_validBackupLost', () => {
    // Teeth: the IDENTICAL scenario against the reconstructed ROUND-3
    // kit_sqlite_backup (unconditional `node -e fs.renameSync` promotion) —
    // a perfectly valid backup must be lost purely because node is absent.
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sqbackup-round3-teeth-')));
    worlds.push(base);
    const libPath = mkRound3Lib(base);
    const db = path.join(base, 'source.db');
    seedDb(db);
    const dest = path.join(base, 'dest.db');
    const driver = mkDriver(base, libPath);
    const env = { PATH: '/usr/bin:/bin', HOME: base };
    const { rc } = runBackup(driver, db, dest, env);
    // Round 3: a valid, fully-verified backup (cmd_rc=0, non-empty, readback
    // passed) is still LOST — rc=1, dest never created — purely because the
    // promotion step required node and node isn't on this PATH.
    expect(rc).toBe(1);
    expect(fs.existsSync(dest)).toBe(false);
  });
});

describe('kit_sqlite_backup — B17 round 4 (b): must not crash the caller under set -u on a missing argument', () => {
  it('should_returnRc2_cleanly_when_calledWithOnlyOneArgumentUnderSetU', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sqbackup-setu-')));
    worlds.push(base);
    const driver = path.join(base, 'driver-setu.sh');
    writeExec(driver, `#!/usr/bin/env bash
set -u
source "${path.join(LIB, 'common.sh')}"
kit_sqlite_backup "$1"
echo "rc=$?"
`);
    const r = spawnSync('bash', [driver, path.join(base, 'whatever.db')], { encoding: 'utf8' });
    // The SCRIPT itself must exit cleanly (0) — bash's own "unbound
    // variable" abort would show up as a non-zero exit with no "rc=" line
    // ever printed, since the source'd function would never return at all.
    expect(r.status).toBe(0);
    expect(r.stderr || '').not.toMatch(/unbound variable/);
    const m = (r.stdout || '').match(/rc=(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBe(2);
  });

  it('should_proveTeeth_byShowingRound3CodeCrashesTheCallingScript_onASingleMissingArgument', () => {
    // Teeth: the IDENTICAL single-argument call under `set -u` against the
    // reconstructed ROUND-3 kit_sqlite_backup (bare "$1"/"$2", no "${1:-}"/
    // "${2:-}" guard) — the calling script itself must abort.
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sqbackup-round3-setu-teeth-')));
    worlds.push(base);
    const libPath = mkRound3Lib(base);
    const driver = path.join(base, 'driver-setu.sh');
    writeExec(driver, `#!/usr/bin/env bash
set -u
source "${libPath}"
kit_sqlite_backup "$1"
echo "rc=$?"
`);
    const r = spawnSync('bash', [driver, path.join(base, 'whatever.db')], { encoding: 'utf8' });
    // Round 3: the calling script itself crashes — non-zero exit, bash's own
    // "unbound variable" error on stderr, and the "rc=" line is never
    // reached at all.
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unbound variable/);
    expect(r.stdout || '').not.toMatch(/rc=/);
  });
});
