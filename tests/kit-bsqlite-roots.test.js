/**
 * Tests for SQLITE-ROOTS-V1 (lib/common.sh): kit_bsqlite_candidate_roots,
 * kit_bsqlite_native_status, kit_bsqlite_gap.
 *
 * Background (Wave-2 B3, 2026-07-31): the pre-existing sqlite checks
 * (kit_sqlite_backend, global_bsqlite_loads) only ever look at ONE
 * better-sqlite3 build — groot/ruflo/node_modules/better-sqlite3 (or the
 * standalone agentdb slot). Empirically tracing every real
 * require()/import('better-sqlite3') call site in the installed
 * @claude-flow/memory + @claude-flow/cli + agentdb dist confirmed most of
 * them resolve UP to that same sibling build (nearest-wins finds nothing
 * local, so Node walks up) — EXCEPT the HOISTED agentdb floor
 * (groot/ruflo/node_modules/agentdb), whose own core (core/AgentDB.js) does
 * `import('better-sqlite3')` from ITS OWN directory and finds agentdb's OWN
 * nested copy first. On the live host that traced to a genuinely different
 * physical file (different version, different inode) from the sibling build
 * every other check inspects — and AgentDB's own core tries native first,
 * then silently drops to sql.js WASM on failure (console.log only, no
 * throw). These tests prove the new checks catch exactly that: the FIX in
 * lib/common.sh should differentiate a healthy multi-root layout from one
 * where the hoisted floor's own nested build is broken, something none of
 * the legacy single-path checks can see (documented in the last describe
 * block below).
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'lib');

const worlds = [];
afterEach(() => {
  while (worlds.length) {
    const w = worlds.pop();
    try { fs.rmSync(w, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function mkBase() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bsqroots-')));
  worlds.push(base);
  return base;
}

function writeExec(p, body) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
}

// A minimal CommonJS "better-sqlite3" package covering the THREE states
// kit_bsqlite_native_status's deep probe (resolve -> require -> `new
// Database(':memory:')` -> `SELECT 1 AS ok` -> close) must tell apart:
//   ok           — requires cleanly AND behaves like a real Database: opens,
//                  answers `SELECT 1 AS ok`, closes.
//   broken       — throws at require() time (ABI-stale / corrupted build —
//                  the pre-existing "cannot even load" class).
//   brokenOnOpen — requires FINE (no throw at require time — the JS wrapper
//                  loads) but the constructor throws the moment something
//                  actually tries to open a database. This is the class the
//                  deep probe adds: a require()-only check (what this
//                  function did before the deepening) cannot see it at all —
//                  and it is not just theoretical: the SAME shape (JS wrapper
//                  loads, native binding missing) was independently confirmed
//                  live on the hoisted agentdb root during this adoption.
function writeFakeBetterSqlite3(dir, version, { broken = false, brokenOnOpen = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'better-sqlite3', version, main: 'index.js' }));
  let body;
  if (broken) {
    body = "throw new Error('ABI-stale native build (simulated)');\n";
  } else if (brokenOnOpen) {
    body = [
      "module.exports = function FakeDatabase(file) {",
      "  throw new Error('Could not locate the bindings file (simulated open-time break)');",
      "};",
    ].join('\n');
  } else {
    body = [
      "module.exports = function FakeDatabase(file) {",
      "  return {",
      "    prepare(sql) { return { get() { return { ok: 1 }; } }; },",
      "    close() {},",
      "  };",
      "};",
    ].join('\n');
  }
  fs.writeFileSync(path.join(dir, 'index.js'), body);
}

// A fake npm-global-root tree mirroring every real resolution root this
// codebase depends on (SQLITE-ROOTS-V1 / kit_bsqlite_candidate_roots):
//   groot/node_modules/better-sqlite3                                  (top-level fallback)
//   groot/ruflo/node_modules/better-sqlite3                            (sibling baseline)
//   groot/ruflo/node_modules/agentdb/node_modules/better-sqlite3       (hoisted floor's OWN nested copy)
//   groot/ruflo/node_modules/@claude-flow/memory/node_modules/agentdb  (no local copy -> walks up to sibling)
//   groot/ruflo/node_modules/@claude-flow/cli                          (no local copy -> walks up to sibling)
//   groot/agentdb                                                      (standalone slot -> walks up to top-level)
function mkGroot(base, { hoistedBroken = false, hoistedBrokenOnOpen = false } = {}) {
  const groot = path.join(base, 'groot');
  writeFakeBetterSqlite3(path.join(groot, 'node_modules', 'better-sqlite3'), '10.0.0');
  writeFakeBetterSqlite3(path.join(groot, 'ruflo', 'node_modules', 'better-sqlite3'), '12.11.1');
  writeFakeBetterSqlite3(
    path.join(groot, 'ruflo', 'node_modules', 'agentdb', 'node_modules', 'better-sqlite3'),
    '11.10.0',
    { broken: hoistedBroken, brokenOnOpen: hoistedBrokenOnOpen },
  );
  fs.mkdirSync(path.join(groot, 'ruflo', 'node_modules', '@claude-flow', 'memory', 'node_modules', 'agentdb'), { recursive: true });
  fs.mkdirSync(path.join(groot, 'ruflo', 'node_modules', '@claude-flow', 'cli'), { recursive: true });
  fs.mkdirSync(path.join(groot, 'agentdb'), { recursive: true });
  return groot;
}

// Stub npm answering `npm root -g` with a fixed groot, decoupled from the
// child's real npm config (same pattern as tests/kit-sqlite-shim.test.js).
function mkStubNpm(base, groot) {
  const bin = path.join(base, 'stub-bin');
  writeExec(path.join(bin, 'npm'), `#!/usr/bin/env bash
if [ "$1" = "root" ] && [ "$2" = "-g" ]; then echo "${groot}"; exit 0; fi
exit 0
`);
  return bin;
}

// A PATH dir mirroring every executable on the real PATH except sqlite3 —
// forces kit_sqlite_backend (used by the legacy-blind-spot test below) onto
// its node fallback arm instead of the sqlite3 CLI, without disturbing any
// other tool common.sh's top-level code needs (coreutils, git, node, ...).
function mkStrippedBin(base) {
  const bin = path.join(base, 'stripped-bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const d of (process.env.PATH || '').split(':')) {
    let names;
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (n === 'sqlite3') continue;
      try { fs.symlinkSync(path.join(d, n), path.join(bin, n)); } catch { /* dup */ }
    }
  }
  return bin;
}

function driverEnv(base, groot) {
  const stub = mkStubNpm(base, groot);
  const stripped = mkStrippedBin(base);
  return { PATH: `${stub}:${stripped}`, HOME: process.env.HOME };
}

function mkDriver(base) {
  const drv = path.join(base, 'driver.sh');
  writeExec(drv, `#!/usr/bin/env bash
source "${LIB}/common.sh"
case "$1" in
  roots)   kit_bsqlite_candidate_roots ;;
  status)  kit_bsqlite_native_status ;;
  gap)     kit_bsqlite_gap; echo "rc=$?" ;;
  verdict) kit_bsqlite_verdict; echo "rc=$?" ;;
  legacy_backend) kit_sqlite_backend ;;
esac
`);
  return drv;
}

function run(base, env, args) {
  const r = spawnSync('bash', [mkDriver(base), ...args], { encoding: 'utf8', env });
  return { code: r.status, stdout: (r.stdout || '').trim(), stderr: r.stderr || '' };
}

// A stub npm that ALWAYS fails, regardless of subcommand — the driver-script
// equivalent of the critic's round-2 repro
// (`npm(){ return 1; }; export -f npm; kit_bsqlite_gap`): kit_bsqlite_gap
// alone read rc=1 ("no gap") with zero roots ever assessed.
function mkBrokenNpmEnv(base) {
  const bin = path.join(base, 'broken-npm-bin');
  writeExec(path.join(bin, 'npm'), `#!/usr/bin/env bash\nexit 1\n`);
  return { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME };
}

// groot resolves and every candidate root EXISTS on disk, but none of them
// has a better-sqlite3 anywhere up its own resolution chain (a host that
// genuinely has no better-sqlite3 installed at all) — the other way to land
// on zero assessable roots besides npm itself failing.
function mkEmptyGroot(base) {
  const groot = path.join(base, 'empty-groot');
  fs.mkdirSync(path.join(groot, 'ruflo', 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(groot, 'ruflo', 'node_modules', 'agentdb'), { recursive: true });
  fs.mkdirSync(path.join(groot, 'ruflo', 'node_modules', '@claude-flow', 'memory', 'node_modules', 'agentdb'), { recursive: true });
  fs.mkdirSync(path.join(groot, 'ruflo', 'node_modules', '@claude-flow', 'cli'), { recursive: true });
  fs.mkdirSync(path.join(groot, 'agentdb'), { recursive: true });
  return groot;
}

function lineFor(lines, root) {
  return lines.find((l) => l.startsWith(`${root}|`));
}

describe('kit_bsqlite_candidate_roots', () => {
  it('should_listAllSixKnownResolutionRoots_when_grootResolves', () => {
    const base = mkBase();
    const groot = mkGroot(base);

    const r = run(base, driverEnv(base, groot), ['roots']);

    const lines = r.stdout.split('\n').filter(Boolean);
    expect(lines).toEqual([
      path.join(groot, 'ruflo', 'node_modules'),
      path.join(groot, 'ruflo', 'node_modules', 'agentdb'),
      path.join(groot, 'ruflo', 'node_modules', '@claude-flow', 'memory', 'node_modules', 'agentdb'),
      path.join(groot, 'ruflo', 'node_modules', '@claude-flow', 'cli'),
      path.join(groot, 'agentdb'),
      groot,
    ]);
  });

  it('should_returnNonZero_when_npmRootGResolvesToNothing', () => {
    const base = mkBase();

    const r = run(base, driverEnv(base, ''), ['roots']);

    expect(r.stdout).toBe('');
    expect(r.code).not.toBe(0);
  });
});

describe('kit_bsqlite_native_status / kit_bsqlite_gap — correct layout (PASS case)', () => {
  it('should_reportOkForEveryRoot_when_everyResolvedBuildLoadsCleanly', () => {
    const base = mkBase();
    const groot = mkGroot(base, { hoistedBroken: false });

    const r = run(base, driverEnv(base, groot), ['status']);

    const lines = r.stdout.split('\n').filter(Boolean);
    expect(lines.length).toBe(6);
    for (const line of lines) {
      const [, state] = line.split('|');
      expect(state).toBe('ok');
    }
  });

  it('should_reportNoGap_when_everyResolvableRootLoadsCleanly', () => {
    const base = mkBase();
    const groot = mkGroot(base, { hoistedBroken: false });

    const r = run(base, driverEnv(base, groot), ['gap']);

    expect(r.stdout).toBe('rc=1'); // 1 = no gap detected
  });
});

describe('kit_bsqlite_native_status / kit_bsqlite_gap — falsification (hoisted floor native build broken)', () => {
  it('should_reportBrokenForTheHoistedAgentdbRootOnly_when_itsOwnNestedBuildThrowsOnRequire', () => {
    const base = mkBase();
    const groot = mkGroot(base, { hoistedBroken: true });

    const r = run(base, driverEnv(base, groot), ['status']);

    const lines = r.stdout.split('\n').filter(Boolean);
    const hoistedRoot = path.join(groot, 'ruflo', 'node_modules', 'agentdb');
    const hoistedLine = lineFor(lines, hoistedRoot);
    expect(hoistedLine).toBeDefined();
    const [, state, resolved] = hoistedLine.split('|');
    expect(state).toBe('broken');
    expect(resolved).toContain(path.join('agentdb', 'node_modules', 'better-sqlite3'));

    // Every OTHER root (including the sibling baseline the legacy check
    // uses) walks up past the broken nested copy and stays healthy — this
    // is the isolation that makes the gap invisible to a single-path check.
    const siblingRoot = path.join(groot, 'ruflo', 'node_modules');
    const [, siblingState] = lineFor(lines, siblingRoot).split('|');
    expect(siblingState).toBe('ok');
  });

  it('should_reportGap_when_theHoistedAgentdbFloorsOwnNestedBuildIsBroken', () => {
    const base = mkBase();
    const groot = mkGroot(base, { hoistedBroken: true });

    const r = run(base, driverEnv(base, groot), ['gap']);

    expect(r.stdout).toBe('rc=0'); // 0 = gap present
  });

  it('should_notFalsePositive_when_hoistedBuildIsHealthy_evenThoughItIsAPhysicallyDifferentFileFromTheSibling', () => {
    // Confirms the check tracks LOADABILITY per root, not "does every root
    // resolve to the identical physical file" — divergent-but-healthy
    // builds (the deliberate multi-version reality here) must not gap.
    const base = mkBase();
    const groot = mkGroot(base, { hoistedBroken: false });

    const r = run(base, driverEnv(base, groot), ['status']);

    const lines = r.stdout.split('\n').filter(Boolean);
    const hoistedRoot = path.join(groot, 'ruflo', 'node_modules', 'agentdb');
    const siblingRoot = path.join(groot, 'ruflo', 'node_modules');
    const [, hoistedState, hoistedResolved] = lineFor(lines, hoistedRoot).split('|');
    const [, , siblingResolved] = lineFor(lines, siblingRoot).split('|');
    expect(hoistedState).toBe('ok');
    expect(hoistedResolved).not.toBe(siblingResolved); // genuinely different file
  });
});

// ── kit_bsqlite_native_status — deep probe (Wave-2 B13 adoption) ────────────
//
// The DEEP probe adopted from agentic-kit (natives.mjs probeBsq3Runtime)
// resolves -> require()s -> opens a real `:memory:` database -> runs
// `SELECT 1` -> closes, instead of stopping at require(). This closes a gap
// require()-only checking cannot see at all: a build whose JS wrapper loads
// cleanly but whose native binding cannot actually be located/opened. That is
// not a hypothetical — the exact same shape (require() succeeds, `new
// Database()` throws "Could not locate the bindings file") was independently
// observed live on this codebase's own hoisted agentdb root during this
// adoption; these fixtures reproduce it deterministically without depending
// on a real compiled addon.
describe('kit_bsqlite_native_status / kit_bsqlite_gap — falsification (requires fine, throws on OPEN)', () => {
  it('should_reportBrokenForTheHoistedAgentdbRootOnly_when_itRequiresCleanlyButThrowsOpeningADatabase', () => {
    const base = mkBase();
    const groot = mkGroot(base, { hoistedBrokenOnOpen: true });

    const r = run(base, driverEnv(base, groot), ['status']);

    const lines = r.stdout.split('\n').filter(Boolean);
    const hoistedRoot = path.join(groot, 'ruflo', 'node_modules', 'agentdb');
    const hoistedLine = lineFor(lines, hoistedRoot);
    expect(hoistedLine).toBeDefined();
    const [, state, resolved] = hoistedLine.split('|');
    // THE regression this adoption closes: a require()-only check (this
    // function's behavior before the deepening) would read this root as 'ok'
    // — require() never throws for this fixture, only the constructor does.
    expect(state).toBe('broken');
    expect(resolved).toContain(path.join('agentdb', 'node_modules', 'better-sqlite3'));

    // Every other root, including the sibling baseline, is genuinely healthy
    // and must stay 'ok' — the deepened probe must not false-positive on a
    // root whose OWN build actually opens and answers correctly.
    const siblingRoot = path.join(groot, 'ruflo', 'node_modules');
    const [, siblingState] = lineFor(lines, siblingRoot).split('|');
    expect(siblingState).toBe('ok');
  });

  it('should_reportGap_when_theHoistedAgentdbFloorsOwnNestedBuildRequiresButThrowsOnOpen', () => {
    const base = mkBase();
    const groot = mkGroot(base, { hoistedBrokenOnOpen: true });

    const r = run(base, driverEnv(base, groot), ['gap']);

    expect(r.stdout).toBe('rc=0'); // 0 = gap present
  });

  it('should_reportGapVerdictWithFullCheckedCount_when_theHoistedRootThrowsOnOpenNotOnRequire', () => {
    const base = mkBase();
    const groot = mkGroot(base, { hoistedBrokenOnOpen: true });

    const r = run(base, driverEnv(base, groot), ['verdict']);

    const [line, rcLine] = r.stdout.split('\n');
    const [verdict, checked, total] = line.split('|');
    expect(verdict).toBe('gap');
    expect(checked).toBe('6'); // it resolved and was assessable — just broken
    expect(total).toBe('6');
    expect(rcLine).toBe('rc=0');
  });
});

describe('the legacy single-path check cannot see this gap (documents why SQLITE-ROOTS-V1 was needed)', () => {
  it('should_stillReportBackendNode_when_theHoistedFloorsOwnNestedBuildIsBroken', () => {
    // kit_sqlite_backend only ever inspects groot/ruflo/node_modules/better-sqlite3
    // (the sibling baseline). A broken build nested inside the HOISTED
    // agentdb package is invisible to it — this test pins that blind spot so
    // a future change to kit_sqlite_backend's scope doesn't silently drop it
    // without updating this expectation.
    const base = mkBase();
    const groot = mkGroot(base, { hoistedBroken: true });

    const r = run(base, driverEnv(base, groot), ['legacy_backend']);

    expect(r.stdout).toBe('node');
  });
});

// ── kit_bsqlite_verdict — tri-state (round 2) ────────────────────────────────
//
// Round-1 shipped kit_bsqlite_gap as a flat boolean. The gauntlet critic
// reproduced a real Goodhart-class conflation: with `npm` itself broken,
// kit_bsqlite_gap reads rc=1 ("no gap") — INDISTINGUISHABLE from "all 6 roots
// verified healthy". A consumer reading only that boolean cannot tell
// "healthy" from "nothing was ever assessed". kit_bsqlite_verdict fixes this
// by making not-assessable a THIRD, explicit outcome.
describe('kit_bsqlite_verdict — tri-state (healthy / gap / not-assessable)', () => {
  it('should_reportHealthyWithFullCheckedCount_when_everyRootLoadsCleanly', () => {
    const base = mkBase();
    const groot = mkGroot(base, { hoistedBroken: false });

    const r = run(base, driverEnv(base, groot), ['verdict']);

    const [line, rcLine] = r.stdout.split('\n');
    const [verdict, checked, total] = line.split('|');
    expect(verdict).toBe('healthy');
    expect(checked).toBe('6');
    expect(total).toBe('6');
    expect(rcLine).toBe('rc=0');
  });

  it('should_reportGapWithPartialCheckedCount_when_oneRootIsBroken', () => {
    const base = mkBase();
    const groot = mkGroot(base, { hoistedBroken: true });

    const r = run(base, driverEnv(base, groot), ['verdict']);

    const [line, rcLine] = r.stdout.split('\n');
    const [verdict, checked, total] = line.split('|');
    expect(verdict).toBe('gap');
    expect(checked).toBe('6'); // the broken root was still assessable (resolved to a file)
    expect(total).toBe('6');
    expect(rcLine).toBe('rc=0');
  });

  it('should_reportNotAssessable_notHealthy_when_npmRootGItselfFails', () => {
    // The critic's exact repro, reproduced through the real driver script
    // rather than shell-function shadowing: `npm` on PATH always fails, so
    // kit_bsqlite_candidate_roots never even produces a groot.
    const base = mkBase();

    const r = run(base, mkBrokenNpmEnv(base), ['verdict']);

    const [line, rcLine] = r.stdout.split('\n');
    const [verdict, checked, total] = line.split('|');
    expect(verdict).toBe('not-assessable');
    expect(checked).toBe('0');
    expect(total).toBe('0');
    expect(rcLine).toBe('rc=1');
    expect(verdict).not.toBe('healthy'); // the conflation the critic found
  });

  it('should_reportNotAssessable_when_grootResolvesButNoRootHasAnyBetterSqlite3', () => {
    // The other route to zero-assessable: npm works and every candidate
    // root exists on disk, but none of them has a better-sqlite3 anywhere up
    // its own chain (a host with nothing installed at all).
    const base = mkBase();
    const groot = mkEmptyGroot(base);

    const r = run(base, driverEnv(base, groot), ['verdict']);

    const [line] = r.stdout.split('\n');
    const [verdict, checked, total] = line.split('|');
    expect(verdict).toBe('not-assessable');
    expect(checked).toBe('0');
    expect(total).toBe('6'); // roots existed and were enumerated, just nothing loadable
  });

  it('should_stillReadRcOneFromLegacyGap_when_notAssessable_documentingItsLimitation', () => {
    // kit_bsqlite_gap's rc alone still can't distinguish this from healthy —
    // that is the documented, accepted limitation of the legacy boolean
    // surface; callers that need the distinction must use kit_bsqlite_verdict.
    const base = mkBase();

    const r = run(base, mkBrokenNpmEnv(base), ['gap']);

    expect(r.stdout).toBe('rc=1');
  });
});
