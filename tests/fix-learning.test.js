/**
 * Tests for lib/fix-learning.sh (GitHub issue #4 populate/unlock + cleanup).
 *
 * Safety: the populate chain is exercised either with --dry-run (no command
 * runs) or against a FULL stub of every ruflo/aqe subcommand on PATH — a real
 * ruflo/aqe binary is never invoked. The cleanup + retry tests operate
 * exclusively inside throwaway temp dirs.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const FIX = path.join(REPO, 'lib', 'fix-learning.sh');

// Stub ruflo so the daemon pre-flight (`ruflo daemon status`) is deterministic
// and never depends on a real running daemon. In --dry-run the chain commands
// are only printed (never executed), so a stub suffices.
function stubBin() {
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'flbin-'));
  fs.writeFileSync(path.join(b, 'ruflo'),
    '#!/usr/bin/env bash\nif [ "$1" = daemon ] && [ "$2" = status ]; then echo "Status: stopped"; fi\nexit 0\n');
  fs.chmodSync(path.join(b, 'ruflo'), 0o755);
  return b;
}
function run(target, extra = []) {
  const b = stubBin();
  const r = spawnSync('bash', [FIX, target, ...extra], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, PATH: `${b}:${process.env.PATH}` },
  });
  fs.rmSync(b, { recursive: true, force: true });
  return r;
}
function mkTarget() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-'));
  fs.mkdirSync(path.join(d, '.swarm'), { recursive: true });
  fs.mkdirSync(path.join(d, '.agentic-qe'), { recursive: true });
  fs.writeFileSync(path.join(d, '.agentic-qe', 'config.yaml'),
    'learning:\n  hnswConfig:\n    M: 8\n');
  return d;
}

describe('fix-learning: --dry-run is a true no-op', () => {
  let d;
  beforeAll(() => { d = mkTarget(); });
  afterAll(() => fs.rmSync(d, { recursive: true, force: true }));

  it('prints the full 10-step chain and exits 0', () => {
    const r = run(d, ['--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/1: running: .*doctor --fix/);
    expect(r.stdout).toMatch(/10: running: .*neural train/);
    expect(r.stdout).toMatch(/\[dry-run\]/);
  });

  it('writes NOTHING to the target config during dry-run', () => {
    const before = fs.readFileSync(path.join(d, '.agentic-qe', 'config.yaml'), 'utf8');
    run(d, ['--dry-run']);
    const after = fs.readFileSync(path.join(d, '.agentic-qe', 'config.yaml'), 'utf8');
    expect(after).toBe(before);
    expect(after).not.toMatch(/useNativeHNSW/); // fix-learning never writes config (that's fix-aqe's job)
  });
});

describe('fix-learning --cleanup: gated, non-destructive by default', () => {
  let d;
  beforeEach(() => {
    d = mkTarget();
    // canonical (must be preserved)
    fs.writeFileSync(path.join(d, 'agentdb.db'), 'CANON');
    fs.writeFileSync(path.join(d, '.swarm', 'memory.db'), 'CANON');
    fs.writeFileSync(path.join(d, '.agentic-qe', 'memory.db'), 'CANON');
    // strays under vendor/ and .claude/ (candidates)
    fs.mkdirSync(path.join(d, 'vendor', 'ruflo'), { recursive: true });
    fs.writeFileSync(path.join(d, 'vendor', 'ruflo', 'ruvector.db'), 'STRAY');
    fs.mkdirSync(path.join(d, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(d, '.claude', 'memory.db'), 'STRAY');
  });
  afterEach(() => fs.rmSync(d, { recursive: true, force: true }));

  it('without --confirm: lists strays and deletes NOTHING', () => {
    const r = run(d, ['--cleanup']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/WOULD remove stray store/);
    expect(fs.existsSync(path.join(d, 'vendor', 'ruflo', 'ruvector.db'))).toBe(true);
    expect(fs.existsSync(path.join(d, '.claude', 'memory.db'))).toBe(true);
  });

  it('with --confirm: removes strays (with .cleanup-bak) but preserves canonical roots', () => {
    const r = run(d, ['--cleanup', '--confirm']);
    expect(r.status).toBe(0);
    // strays gone, backups kept
    expect(fs.existsSync(path.join(d, 'vendor', 'ruflo', 'ruvector.db'))).toBe(false);
    expect(fs.existsSync(path.join(d, 'vendor', 'ruflo', 'ruvector.db.cleanup-bak'))).toBe(true);
    expect(fs.existsSync(path.join(d, '.claude', 'memory.db'))).toBe(false);
    expect(fs.existsSync(path.join(d, '.claude', 'memory.db.cleanup-bak'))).toBe(true);
    // canonical untouched
    expect(fs.existsSync(path.join(d, 'agentdb.db'))).toBe(true);
    expect(fs.existsSync(path.join(d, '.swarm', 'memory.db'))).toBe(true);
    expect(fs.existsSync(path.join(d, '.agentic-qe', 'memory.db'))).toBe(true);
  });

  it('--cleanup --dry-run --confirm still deletes nothing (run() suppressed)', () => {
    const r = run(d, ['--cleanup', '--confirm', '--dry-run']);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(d, 'vendor', 'ruflo', 'ruvector.db'))).toBe(true);
  });
});

// ── Improvements: transient-lock retry + persistence assertion ───────────────
// These exercise the REAL chain (not --dry-run) against a FULL stub of every
// ruflo/aqe subcommand, so it runs fast and deterministically. The stub's
// `aqe learning extract` behavior is driven by STUB_EXTRACT_MODE.
describe('fix-learning: retry + persistence (issue #4 robustness)', () => {
  let d, bin, state;

  function writeFullStub(binDir, aqeDb) {
    // aqe: dispatches on "$1 $2"; extract honors STUB_EXTRACT_* env.
    fs.writeFileSync(path.join(binDir, 'aqe'), [
      '#!/usr/bin/env bash',
      'case "$1 $2" in',
      '  "learning --help") echo "  extract x"; echo "  consolidate x"; echo "  dream x"; exit 0 ;;',
      '  "learning extract")',
      '    case "${STUB_EXTRACT_MODE:-noop}" in',
      '      lockfail)',
      '        f="$STUB_STATE_DIR/extract.cnt"; n=0; [ -f "$f" ] && n=$(cat "$f"); n=$((n+1)); echo "$n" > "$f"',
      '        if [ "$n" -le "${STUB_EXTRACT_FAILS:-1}" ]; then echo "Error: database is locked" >&2; exit 1; fi',
      '        exit 0 ;;',
      '      hardfail) echo "Error: boom (not a lock)" >&2; exit 1 ;;',
      '      persist) sqlite3 "$STUB_AQE_DB" "INSERT INTO qe_patterns DEFAULT VALUES;"; exit 0 ;;',
      '      *) exit 0 ;;',  // noop: success, writes nothing
      '    esac ;;',
      '  *) exit 0 ;;',      // loop-health, upgrade, ruvector flags, consolidate, dream
      'esac',
      'exit 0',
    ].join('\n'));
    // ruflo: everything succeeds; daemon reported stopped.
    fs.writeFileSync(path.join(binDir, 'ruflo'),
      '#!/usr/bin/env bash\nif [ "$1" = daemon ] && [ "$2" = status ]; then echo "Status: stopped"; fi\nexit 0\n');
    fs.chmodSync(path.join(binDir, 'aqe'), 0o755);
    fs.chmodSync(path.join(binDir, 'ruflo'), 0o755);
  }

  function sqlite(db, sql) {
    const r = spawnSync('sqlite3', [db, sql], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`sqlite3: ${r.stderr || r.stdout}`);
  }

  beforeEach(() => {
    d = mkTarget();
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'flfullbin-'));
    state = fs.mkdtempSync(path.join(os.tmpdir(), 'flstate-'));
    // empty structured tables so the chain RUNS the populate steps (not skip)
    sqlite(path.join(d, '.swarm', 'memory.db'),
      'CREATE TABLE episodes(id INTEGER); CREATE TABLE skills(id INTEGER); CREATE TABLE patterns(id INTEGER);');
    fs.writeFileSync(path.join(d, '.swarm', 'lora-weights.json'),
      JSON.stringify({ stats: { totalUpdates: 1, totalAdaptations: 0 } }));
    sqlite(path.join(d, '.agentic-qe', 'memory.db'),
      'CREATE TABLE qe_patterns(id INTEGER PRIMARY KEY); CREATE TABLE dream_cycles(id INTEGER PRIMARY KEY);');
    writeFullStub(bin, path.join(d, '.agentic-qe', 'memory.db'));
  });
  afterEach(() => {
    fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  });

  function runChain(env = {}) {
    return spawnSync('bash', [FIX, d], {
      encoding: 'utf8', timeout: 30000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FIXLEARN_BACKOFF: '0',                 // instant retries in tests
        FIXLEARN_HARVEST: '0',                 // don't invoke the real harvest tool in unit tests
        STUB_STATE_DIR: state,
        STUB_AQE_DB: path.join(d, '.agentic-qe', 'memory.db'),
        ...env,
      },
    });
  }

  it('retries a transient "database is locked" and eventually succeeds', () => {
    const r = runChain({ STUB_EXTRACT_MODE: 'lockfail', STUB_EXTRACT_FAILS: '2' });
    expect(r.stdout).toMatch(/7: transient DB lock \(attempt 1\/3\) — retrying/);
    expect(r.stdout).toMatch(/7: transient DB lock \(attempt 2\/3\) — retrying/);
    expect(r.stdout).toMatch(/7: done \(after 3 attempts\)/);
  });

  it('does NOT retry a non-lock failure (no wasted attempts)', () => {
    const r = runChain({ STUB_EXTRACT_MODE: 'hardfail' });
    expect(r.stdout).not.toMatch(/retrying/);
    expect(r.stdout).toMatch(/7: failed/);
  });

  it('WARNS when a step reports success but the table did not grow (over-report)', () => {
    const r = runChain({ STUB_EXTRACT_MODE: 'noop' });
    expect(r.stdout).toMatch(/7: step reported success but qe_patterns did NOT grow on disk \(0->0\)/);
  });

  it('confirms persistence when the step actually commits rows', () => {
    const r = runChain({ STUB_EXTRACT_MODE: 'persist' });
    expect(r.stdout).toMatch(/7: persisted qe_patterns 0->1/);
  });

  it('exhausts retries on a persistent lock and reports failure (non-fatal step 7)', () => {
    const r = runChain({ STUB_EXTRACT_MODE: 'lockfail', STUB_EXTRACT_FAILS: '99' });
    expect(r.stdout).toMatch(/7: transient DB lock \(attempt 2\/3\)/);
    expect(r.stdout).toMatch(/7: failed/);
    expect(r.status).toBe(0); // step 7 is optional — never flips the exit code
  });
});
