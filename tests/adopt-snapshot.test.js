/**
 * Tests for lib/snapshot.sh + lib/adopt.sh (MEMORY-PRESERVE-PROOF-V1).
 *
 * snapshot: WAL-safe backup + per-table row-count manifest of a target's
 * learning stores into $HOME/.ruflo-kit/backups/<basename>-<ts>/, plus a
 * baseline pointer at <target>/.claude-flow/data/adoption-baseline.json.
 * adopt --verify-only: recount every baselined table and diff — PRESERVED
 * (exit 0) when nothing shrank, VIOLATED (exit 2) on any shrink.
 *
 * Full `adopt` (snapshot → setup → diff) is NOT exercised here — setup is far
 * too heavy for a unit fixture; adopt.sh is structured so the diff logic runs
 * standalone via --verify-only, and that is what these tests drive. HOME is
 * pointed at a throwaway dir so backups never touch the real ~/.ruflo-kit.
 */
'use strict';

const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIB = path.resolve(__dirname, '..', 'lib');
const SNAPSHOT = path.join(LIB, 'snapshot.sh');
const ADOPT = path.join(LIB, 'adopt.sh');

const worlds = [];
afterEach(() => {
  while (worlds.length) {
    const w = worlds.pop();
    try { fs.rmSync(w, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function sql(db, statements) {
  const r = spawnSync('sqlite3', [db, statements], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('sqlite3 failed: ' + (r.stderr || r.error));
  return (r.stdout || '').trim();
}

// Fixture target: two small sqlite stores, a fake RVF artifact, and a
// pre-existing corrupt artifact next to a store (must be surfaced, not touched).
function mkWorld() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adopttest-')));
  worlds.push(base);
  const target = path.join(base, 'target');
  fs.mkdirSync(path.join(target, '.swarm'), { recursive: true });
  fs.mkdirSync(path.join(target, '.agentic-qe'), { recursive: true });
  sql(path.join(target, '.swarm', 'memory.db'),
    'CREATE TABLE notes(a); INSERT INTO notes VALUES (1),(2),(3);' +
    'CREATE TABLE patterns(b); INSERT INTO patterns VALUES (9);');
  sql(path.join(target, '.agentic-qe', 'memory.db'),
    'CREATE TABLE mem(x); INSERT INTO mem VALUES (1),(2);');
  fs.writeFileSync(path.join(target, '.agentic-qe', 'aqe.rvf'), 'RVF fake-payload');
  fs.writeFileSync(path.join(target, '.swarm', 'memory.db.corrupt-20260101'), 'junk');
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  const run = (script, args = []) => {
    const r = spawnSync('bash', [script, target, ...args],
      { encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 30000 });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  return { base, target, home, run };
}

function backupDirs(home) {
  const root = path.join(home, '.ruflo-kit', 'backups');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).map((d) => path.join(root, d));
}

describe('snapshot: backup + manifest + baseline pointer', () => {
  it('backs up both sqlite stores + the RVF artifact, with correct per-table counts', () => {
    const { target, home, run } = mkWorld();
    const { code, out } = run(SNAPSHOT);
    expect(code).toBe(0);

    const dirs = backupDirs(home);
    expect(dirs.length).toBe(1);
    const dest = dirs[0];
    expect(path.basename(dest)).toMatch(/^target-\d{8}-\d{6}/);

    // Backup files exist; sqlite backups hold the same rows as the source.
    expect(fs.existsSync(path.join(dest, '.swarm', 'memory.db'))).toBe(true);
    expect(fs.existsSync(path.join(dest, '.agentic-qe', 'memory.db'))).toBe(true);
    expect(sql(path.join(dest, '.swarm', 'memory.db'), 'SELECT COUNT(*) FROM notes;')).toBe('3');
    expect(sql(path.join(dest, '.swarm', 'memory.db'), 'SELECT COUNT(*) FROM patterns;')).toBe('1');
    expect(sql(path.join(dest, '.agentic-qe', 'memory.db'), 'SELECT COUNT(*) FROM mem;')).toBe('2');
    // RVF raw copy is byte-identical.
    expect(fs.readFileSync(path.join(dest, '.agentic-qe', 'aqe.rvf')))
      .toEqual(fs.readFileSync(path.join(target, '.agentic-qe', 'aqe.rvf')));

    // Manifest: sentinel + per-table counts + rvf list + corrupt surfacing.
    const m = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'));
    expect(m.sentinel).toBe('MEMORY-PRESERVE-PROOF-V1');
    expect(m.dir).toBe(dest);
    expect(m.counts['.swarm/memory.db']).toEqual({ notes: 3, patterns: 1 });
    expect(m.counts['.agentic-qe/memory.db']).toEqual({ mem: 2 });
    expect(m.rvf).toContain('.agentic-qe/aqe.rvf');
    expect(m.corruptArtifacts).toContain('.swarm/memory.db.corrupt-20260101');

    // Corrupt artifact is REPORTED in the output and NOT touched on disk.
    expect(out).toMatch(/corrupt artifact/i);
    expect(fs.readFileSync(path.join(target, '.swarm', 'memory.db.corrupt-20260101'), 'utf8')).toBe('junk');

    // Baseline pointer: {dir, createdAt, counts} inside the target.
    const b = JSON.parse(fs.readFileSync(
      path.join(target, '.claude-flow', 'data', 'adoption-baseline.json'), 'utf8'));
    expect(b.dir).toBe(dest);
    expect(typeof b.createdAt).toBe('string');
    expect(b.counts).toEqual(m.counts);
  });

  it('--dry-run prints the plan and writes NOTHING', () => {
    const { target, home, run } = mkWorld();
    const { code, out } = run(SNAPSHOT, ['--dry-run']);
    expect(code).toBe(0);
    expect(out).toMatch(/dry-run/);
    expect(out).toMatch(/would sqlite-backup \.swarm\/memory\.db/);
    expect(out).toMatch(/would raw-copy\s+\.agentic-qe\/aqe\.rvf/);
    expect(backupDirs(home).length).toBe(0);
    expect(fs.existsSync(path.join(target, '.claude-flow', 'data', 'adoption-baseline.json'))).toBe(false);
  });

  // ── F8 root-cause regression: WAL-mode source → vacuous "{}" counts ────────
  // Empirical field defect (B7, gauntlet 2026-07-31): `bin/ruflo-kit snapshot .`
  // reported empty "{}" row-counts for every store on a real target. Root
  // cause: ruflo/AQE/AgentDB stores run journal_mode=WAL; `.backup` (the online
  // backup API) copies that flag into the backup file's header, but the copy
  // itself gets no -wal/-shm sidecar (the API never creates one) — so
  // `sqlite3 -readonly` (every count/enumeration call) fails SQLITE_CANTOPEN
  // (rc 14) on the copy, deterministically, every time. The original code fed
  // that failing call through process substitution (`< <(...)`), which
  // discards the command's exit status, so the failure was invisible and the
  // loop just silently ran zero iterations, emitting "{}" as if the store had
  // no tables. This is the single most important regression guard in this
  // file — it fails loudly against the pre-fix code.
  it('a WAL-mode source store still backs up with REAL per-table counts (not vacuous "{}")', (ctx) => {
    const { target, home, run } = mkWorld();
    sql(path.join(target, '.swarm', 'memory.db'), 'PRAGMA journal_mode=WAL;');
    // Confirm the fixture actually reproduces the CANTOPEN precondition this
    // test exists to falsify: a plain online-backup copy of a WAL-mode db,
    // opened -readonly with no sidecar of its own, must fail on this host —
    // otherwise this test would pass for the wrong reason.
    const probeCopy = path.join(home, 'probe-copy.db');
    execSync(`sqlite3 "${path.join(target, '.swarm', 'memory.db')}" ".backup '${probeCopy}'"`);
    const probe = spawnSync('sqlite3', ['-readonly', probeCopy, 'SELECT 1;'], { encoding: 'utf8' });
    // SKIP, do not FAIL, when the host cannot stage the scenario. Whether a
    // `.backup` copy of a WAL db is readable `-readonly` without its sidecar
    // depends on the sqlite3 build: it reproduces on this Mac and does NOT on
    // the CI runners, where the probe exits 0. Failing there asserted a fact
    // about the host's SQLite, not about the kit, and reported a broken kit
    // on every nightly. An unreproducible precondition is "not assessable" —
    // the same third state the kit's own probes use.
    if (probe.status === 0) {
      ctx.skip(`sqlite3 on this host opens a WAL .backup copy -readonly (rc 0), `
        + `so the CANTOPEN precondition cannot be staged — nothing to assert`);
      return;
    }

    const { code, out } = run(SNAPSHOT);
    expect(code).toBe(0);
    expect(out).not.toMatch(/\(\{\}\)/); // never report a store as backed-up-with-empty-counts
    expect(out).not.toMatch(/UNREADABLE/);

    const dest = backupDirs(home)[0];
    const m = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'));
    expect(m.counts['.swarm/memory.db']).toEqual({ notes: 3, patterns: 1 });
    expect(m.unreadableStores).toEqual([]);
  });

  // ── F8 fix shape: a store that backs up fine but enumerates to ZERO tables
  // must fail LOUDLY, never silently write "{}" as if that were a successful,
  // empty count. A real learning store always has at least one table; an
  // empty-but-valid sqlite file here stands in for "enumeration came back
  // with nothing" without needing to fake instrument unavailability.
  it('a store that backs up but enumerates ZERO tables is reported UNREADABLE and fails LOUDLY (nonzero exit)', () => {
    const { target, home, run } = mkWorld();
    // Overwrite with a valid, non-empty-on-disk sqlite file that has no user tables.
    fs.rmSync(path.join(target, '.swarm', 'memory.db'));
    sql(path.join(target, '.swarm', 'memory.db'), 'PRAGMA user_version=1;');

    const { code, out } = run(SNAPSHOT);
    expect(code).toBe(1); // LOUD: nonzero exit, never a quiet success
    expect(out).toMatch(/UNREADABLE/);
    expect(out).toMatch(/snapshot INCOMPLETE/);

    const dest = backupDirs(home)[0];
    const m = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'));
    expect(m.counts['.swarm/memory.db']).toBe('UNREADABLE'); // never {}
    expect(m.unreadableStores).toContain('.swarm/memory.db');

    const b = JSON.parse(fs.readFileSync(
      path.join(target, '.claude-flow', 'data', 'adoption-baseline.json'), 'utf8'));
    expect(b.counts['.swarm/memory.db']).toBe('UNREADABLE');
    expect(b.unreadableStores).toContain('.swarm/memory.db');
  });
});

describe('adopt --verify-only: the preservation receipt diff', () => {
  it('unchanged stores → PRESERVED, exit 0', () => {
    const { run } = mkWorld();
    expect(run(SNAPSHOT).code).toBe(0);
    const { code, out } = run(ADOPT, ['--verify-only']);
    expect(code).toBe(0);
    expect(out).toMatch(/MEMORY-PRESERVE-PROOF-V1: PRESERVED/);
    expect(out).not.toMatch(/SHRANK/);
  });

  it('a deleted row after snapshot → VIOLATED, exit 2, table shows the shrink', () => {
    const { target, run } = mkWorld();
    expect(run(SNAPSHOT).code).toBe(0);
    sql(path.join(target, '.swarm', 'memory.db'), 'DELETE FROM notes WHERE rowid = 1;');
    const { code, out } = run(ADOPT, ['--verify-only']);
    expect(code).toBe(2);
    expect(out).toMatch(/MEMORY-PRESERVE-PROOF-V1: VIOLATED/);
    expect(out).toMatch(/notes\s+3 -> 2/);
    expect(out).toMatch(/SHRANK/);
  });

  it('no baseline yet → usage error exit 1 (not a violation)', () => {
    const { run } = mkWorld();
    const { code, out } = run(ADOPT, ['--verify-only']);
    expect(code).toBe(1);
    expect(out).toMatch(/no adoption baseline/);
  });

  it('adopt refuses --force with an explicit message', () => {
    const { run } = mkWorld();
    const { code, out } = run(ADOPT, ['--force']);
    expect(code).toBe(1);
    expect(out).toMatch(/refuses --force/);
  });

  // ── F8 fix: a vacuous/unusable baseline must NEVER be graded PRESERVED ──────
  // Before this fix, an empty counts object (whatever its cause) read as
  // "fresh target — nothing can shrink" and was rubber-stamped PRESERVED. A
  // baseline produced by the fixed snapshot.sh now marks a failed store as
  // "UNREADABLE" instead of "{}"; adopt must treat that as NOT ASSESSABLE
  // (exit 3) — never silently PRESERVED, and never a false VIOLATED either.
  it('a baseline with an UNREADABLE-marked store → NOT ASSESSABLE (exit 3), never PRESERVED', () => {
    const { target, run } = mkWorld();
    fs.mkdirSync(path.join(target, '.claude-flow', 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(target, '.claude-flow', 'data', 'adoption-baseline.json'),
      JSON.stringify({
        dir: '/tmp/fake', createdAt: '2026-07-31T00:00:00Z',
        counts: { '.swarm/memory.db': 'UNREADABLE' },
        unreadableStores: ['.swarm/memory.db'],
      }));
    const { code, out } = run(ADOPT, ['--verify-only']);
    expect(code).toBe(3);
    expect(out).toMatch(/NOT ASSESSABLE/);
    expect(out).not.toMatch(/: PRESERVED/);
    expect(out).not.toMatch(/VIOLATED/);
  });

  // ── F8 fix, opposite direction: a momentary/transient recount failure must
  // never default to "0" (which reads as a full shrink → false VIOLATED).
  // Simulates a live store that became unreadable AFTER the baseline was
  // taken (e.g. an incomplete restore/copy that dropped the WAL sidecar,
  // leaving a valid, present, non-empty file that still fails -readonly) —
  // the same CANTOPEN precondition as the snapshot-side fix, but hitting the
  // LIVE recount path in adopt.sh instead of the backup path in snapshot.sh.
  it('a live store unreadable at recount time (present, valid, but -readonly fails) → NOT ASSESSABLE, not VIOLATED', (ctx) => {
    const { target, home, run } = mkWorld();
    expect(run(SNAPSHOT).code).toBe(0); // baseline: notes=3, patterns=1

    // Replace the live db with a WAL-mode online-backup copy of itself — same
    // mechanism as the snapshot-side fixture: a valid, present, correctly-
    // countable-if-only-you-could-open-it file with no sidecar of its own.
    const liveDb = path.join(target, '.swarm', 'memory.db');
    const walCopy = path.join(home, 'wal-source.db');
    fs.copyFileSync(liveDb, walCopy);
    execSync(`sqlite3 "${walCopy}" "PRAGMA journal_mode=WAL; INSERT INTO notes VALUES (999);"`);
    const cantopenCopy = path.join(home, 'cantopen.db');
    execSync(`sqlite3 "${walCopy}" ".backup '${cantopenCopy}'"`);
    const probe = spawnSync('sqlite3', ['-readonly', cantopenCopy, 'SELECT 1;'], { encoding: 'utf8' });
    // Same host-dependent precondition as the snapshot-side test above: skip
    // rather than fail where sqlite3 can open a WAL .backup copy -readonly.
    if (probe.status === 0) {
      ctx.skip(`sqlite3 on this host opens a WAL .backup copy -readonly (rc 0), `
        + `so the CANTOPEN precondition cannot be staged — nothing to assert`);
      return;
    }
    fs.copyFileSync(cantopenCopy, liveDb);

    const { code, out } = run(ADOPT, ['--verify-only']);
    expect(code).toBe(3);
    expect(out).toMatch(/NOT ASSESSABLE/);
    expect(out).toMatch(/not assessable \(recount failed twice/);
    expect(out).not.toMatch(/SHRANK/);       // never a false violation
    expect(out).not.toMatch(/: PRESERVED/);  // never a silent pass either
  });
});

// ── kit_sqlite_ro / kit_sqlite_backup node fallback (no sqlite3 on PATH) ─────
// The shim's ELSE arm resolves better-sqlite3 from the GLOBAL ruflo install
// ($(npm root -g)/ruflo/node_modules/better-sqlite3). Exercised with a minimal
// PATH that has node + an npm stub but NO sqlite3. Skipped when the global
// better-sqlite3 is absent (the fallback's own precondition).
let GROOT = '';
try { GROOT = execSync('npm root -g', { encoding: 'utf8' }).trim(); } catch { /* ignore */ }
const BS3 = GROOT && path.join(GROOT, 'ruflo', 'node_modules', 'better-sqlite3');
const hasBs3 = !!(BS3 && fs.existsSync(BS3));
const itBs3 = hasBs3 ? it : it.skip;

function realBin(name) {
  return execSync(`command -v ${name}`, { encoding: 'utf8', shell: '/bin/bash' }).trim();
}

describe('sqlite shim: node + better-sqlite3 fallback when sqlite3 CLI is absent', () => {
  itBs3('kit_sqlite_ro reads and kit_sqlite_backup produces a loadable copy', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sqlshim-')));
    worlds.push(base);
    const db = path.join(base, 'src.db');
    sql(db, 'CREATE TABLE notes(a); INSERT INTO notes VALUES (1),(2),(3);');
    const dest = path.join(base, 'bk', 'src.db');

    // Minimal PATH: node (real), npm (stub echoing the real global root), and
    // the two externals the helpers touch (dirname, mkdir). NO sqlite3.
    const bin = path.join(base, 'shimbin');
    fs.mkdirSync(bin);
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\necho "${GROOT}"\n`);
    fs.chmodSync(path.join(bin, 'npm'), 0o755);
    for (const tool of ['dirname', 'mkdir']) {
      fs.symlinkSync(realBin(tool), path.join(bin, tool));
    }

    const script = [
      `source "${LIB}/common.sh"`,
      'command -v sqlite3 >/dev/null 2>&1 && { echo "sqlite3 leaked onto PATH"; exit 8; }',
      'kit_sqlite_ro "$1" "SELECT COUNT(*) FROM notes;" || exit 7',
      'kit_sqlite_backup "$1" "$2" || exit 9',
    ].join('\n');
    const r = spawnSync('/bin/bash', ['-c', script, '_', db, dest],
      { encoding: 'utf8', env: { PATH: bin, HOME: base }, timeout: 30000 });
    expect(r.status).toBe(0);
    expect((r.stdout || '').trim()).toBe('3');
    // The backup is a real sqlite db with the same rows (verified with the
    // real CLI from the test process, which has the normal PATH).
    expect(sql(dest, 'SELECT COUNT(*) FROM notes;')).toBe('3');
  });
});
