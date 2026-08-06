/**
 * Falsification tests for lib/proof.sh P16 "memory-roundtrip"
 * (MEMORY-ROUNDTRIP-V1, Wave-2 B13).
 *
 * THE DRIFT CLASS this probe closes: every other memory/store check in this
 * kit (kit_sqlite_rw_check / P13 stores-writable, the AQE capture-arm wiring
 * check) only ever proves PRESENCE — a store file exists, accepts a
 * momentary write lock, holds rows — never that a value written through the
 * real `ruflo memory` CLI actually comes back out through a reader
 * INDEPENDENT of that same CLI. A backend that silently no-ops a write (or
 * whose CLI serves a cached/stale answer on retrieve while the disk write
 * itself failed) reads healthy to every probe that came before this one.
 * P16 (`probe_memory_roundtrip`, lib/proof.sh) delegates to
 * kit_memory_roundtrip_check (lib/common.sh) — store -> CLI retrieve ->
 * independent on-disk read -> purge -> post-purge retrieve, entirely inside
 * a disposable `mktemp -d` (never touching the target's real .agentic-qe/,
 * .swarm/, or agentdb.db). This file falsifies the WIRED probe end-to-end
 * (through the real proof.sh, not just the common.sh helper, which already
 * has its own independent unit coverage) across its outcomes:
 *
 *   healthy         -> PASS  full round trip verified, independent read
 *                      included.
 *   gap (shallow)   -> FAIL  the CLI's own retrieve never returns what was
 *                      just stored — caught without even needing the
 *                      independent reader (a no-op `store`/`retrieve`).
 *   gap (deep)      -> FAIL  THE CENTERPIECE case: a store whose `retrieve`
 *                      echoes the value back from a side channel (looks
 *                      PERFECT to a CLI-only round trip — store, then
 *                      retrieve, matches) while the actual sqlite write to
 *                      `memory_entries` silently never happens. Only the
 *                      independent on-disk read (a separate `sqlite3`
 *                      invocation against the same pinned db file) catches
 *                      this — proving P16 does not just re-ask the same CLI
 *                      that already claimed success.
 *   not-assessable  -> FAIL, never a silent PASS/WARN, when `ruflo` is
 *                      entirely absent from PATH. Precedent: P6 bsqlite
 *                      ("PROVED must not be earned blind"), not P7 brain
 *                      ("KB absent" WARN) — the brain KB is a genuinely
 *                      optional, documented opt-in; `ruflo` is the memory
 *                      layer this probe exists to verify. This state is
 *                      never a NEW way to lose PROVED: with `ruflo` off
 *                      PATH, P1 ruflo-cli already hard-FAILs in the same run
 *                      (asserted directly below, not just argued in prose).
 *   gap (B19,        -> FAIL (regression). Before a follow-up fix to
 *   "none"-backend)     lib/common.sh's kit_memory_roundtrip_check, when
 *                      kit_sqlite_backend answered "none" (neither the
 *                      sqlite3 CLI nor a loadable global better-sqlite3
 *                      available), the independent-read step was skipped
 *                      entirely and the function still reported "healthy"
 *                      purely on the CLI's own claims — the exact
 *                      side-channel-echo blind spot this probe exists to
 *                      close, silently reappearing on an instrument-less
 *                      host. Fixed: "none" now maps to `gap`, so the SAME
 *                      cache-echo fixture that correctly FAILs under `cli`
 *                      and `node` also FAILs here (see buildNoInstrument /
 *                      the B19 regression describe block below), and the
 *                      detail says "no independent verification" explicitly
 *                      rather than reading like a completed check against a
 *                      backend literally named "none".
 *
 * Self-contained harness (own mkGroot/mkBin/mkKit/mkTarget), matching this
 * repo's established per-file-fixture convention (tests/proof.test.js,
 * tests/proof-truth-hardening.test.js, tests/proof-bsqlite-probe.test.js all
 * do the same rather than sharing a fixture module).
 */
'use strict';

const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIB = path.resolve(__dirname, '..', 'lib');

const PIN = '3.0.0-alpha.10';
const HOISTED = '3.0.0-alpha.17';

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

// Fake global npm root with the three agentdb slots + a require()-able nested
// module exposing >=23 classes (so P4/P5 don't spuriously FAIL and muddy the
// JSON this test parses) plus a working better-sqlite3 fixture — mirrors
// tests/proof-bsqlite-probe.test.js's 'healthy' mkGroot exactly.
function mkGroot(base) {
  const groot = path.join(base, 'groot');
  const pkg = (rel, ver, extra) => {
    const d = path.join(groot, rel);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'agentdb', version: ver, ...(extra || {}) }));
    return d;
  };
  pkg('agentdb', PIN);
  pkg('ruflo/node_modules/agentdb', HOISTED);
  const nested = pkg('ruflo/node_modules/@claude-flow/memory/node_modules/agentdb', PIN, { main: 'index.js' });
  let src = '';
  const names = [];
  for (let i = 0; i < 25; i++) { src += `class C${i} {}\n`; names.push(`C${i}`); }
  fs.writeFileSync(path.join(nested, 'index.js'), src + `module.exports = { ${names.join(', ')} };\n`);
  const bs = path.join(groot, 'agentdb', 'node_modules', 'better-sqlite3');
  fs.mkdirSync(bs, { recursive: true });
  fs.writeFileSync(path.join(bs, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '11.8.1', main: 'index.js' }));
  fs.writeFileSync(path.join(bs, 'index.js'), [
    "module.exports = function FakeDatabase(file) {",
    "  return { prepare(sql) { return { get() { return { ok: 1 }; } }; }, close() {} };",
    "};",
  ].join('\n') + '\n');
  return groot;
}

// The `ruflo memory {init,store,retrieve,purge}` body, one per falsification
// shape. Backed by the REAL sqlite3 CLI (this file never shims sqlite3, so
// the system binary resolves for both this shim's own backing AND
// kit_memory_roundtrip_check's independent on-disk read of the same file).
//
//   healthy      — the real, correct round trip: init creates the table,
//                  store INSERTs, retrieve SELECTs, purge DELETEs.
//   no-persist   — shallow gap: store/retrieve are both no-ops, so the CLI's
//                  own retrieve never echoes back what was "stored" — caught
//                  before the independent reader is ever consulted.
//   side-channel — deep gap (the centerpiece): store/retrieve go through a
//                  side-channel cache file instead of the db, so the CLI
//                  round trip LOOKS perfect (store, then retrieve, matches)
//                  while `memory_entries` never receives the row. Only the
//                  independent on-disk read (a separate `sqlite3` call
//                  against the same pinned file) can tell the difference.
function rufloMemoryBody(shape) {
  const argParse = `
  mpath=""; mkey=""; mns=""; mval=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --path) mpath="$2"; shift 2 ;;
      -k) mkey="$2"; shift 2 ;;
      -n|--namespace) mns="$2"; shift 2 ;;
      --value) mval="$2"; shift 2 ;;
      --force|--value-only) shift ;;
      --backend) shift 2 ;;
      *) shift ;;
    esac
  done`;

  if (shape === 'no-persist') {
    return `if [ "$1" = "memory" ]; then
  shift
  msub="$1"; shift
${argParse}
  case "$msub" in
    init) sqlite3 "$mpath" "CREATE TABLE IF NOT EXISTS memory_entries (namespace TEXT, key TEXT, content TEXT);"; exit $? ;;
    store) exit 0 ;;
    retrieve) exit 0 ;;
    purge) exit 0 ;;
    *) exit 0 ;;
  esac
fi`;
  }
  if (shape === 'side-channel') {
    return `if [ "$1" = "memory" ]; then
  shift
  msub="$1"; shift
${argParse}
  cache="\${mpath}.cache.\${mns}.\${mkey}"
  case "$msub" in
    init)     sqlite3 "$mpath" "CREATE TABLE IF NOT EXISTS memory_entries (namespace TEXT, key TEXT, content TEXT);"; exit $? ;;
    store)    printf '%s' "$mval" > "$cache"; exit 0 ;;
    retrieve) cat "$cache" 2>/dev/null; exit 0 ;;
    purge)    rm -f "\${mpath}".cache."\${mns}".* 2>/dev/null; exit 0 ;;
    *)        exit 0 ;;
  esac
fi`;
  }
  // Same side-channel echo defect as 'side-channel' above, but `init` uses a
  // plain `touch` instead of `sqlite3 ... CREATE TABLE` — this variant is
  // driven under a PATH with NO sqlite3 CLI at all (the B19 "none"-backend
  // regression, see buildNoInstrument below), so the shim itself must not
  // depend on sqlite3 being present. The defect under test is identical:
  // store/retrieve echo the value through a cache file; `memory_entries`
  // (whatever schema it has, if any) never receives the row.
  if (shape === 'side-channel-no-instrument') {
    return `if [ "$1" = "memory" ]; then
  shift
  msub="$1"; shift
${argParse}
  cache="\${mpath}.cache.\${mns}.\${mkey}"
  case "$msub" in
    init)     : > "$mpath"; exit 0 ;;
    store)    printf '%s' "$mval" > "$cache"; exit 0 ;;
    retrieve) cat "$cache" 2>/dev/null; exit 0 ;;
    purge)    rm -f "\${mpath}".cache."\${mns}".* 2>/dev/null; exit 0 ;;
    *)        exit 0 ;;
  esac
fi`;
  }
  // 'healthy' (default): the real round trip.
  return `if [ "$1" = "memory" ]; then
  shift
  msub="$1"; shift
${argParse}
  case "$msub" in
    init)     sqlite3 "$mpath" "CREATE TABLE IF NOT EXISTS memory_entries (namespace TEXT, key TEXT, content TEXT);"; exit $? ;;
    store)    sqlite3 "$mpath" "DELETE FROM memory_entries WHERE namespace='$mns' AND key='$mkey'; INSERT INTO memory_entries (namespace,key,content) VALUES ('$mns','$mkey','$mval');"; exit $? ;;
    retrieve) sqlite3 "$mpath" "SELECT content FROM memory_entries WHERE namespace='$mns' AND key='$mkey' LIMIT 1;"; exit 0 ;;
    purge)    sqlite3 "$mpath" "DELETE FROM memory_entries WHERE namespace='$mns';"; exit $? ;;
    *)        exit 0 ;;
  esac
fi`;
}

function mkBin(base, groot, { memoryShape = 'healthy' } = {}) {
  const bin = path.join(base, 'bin');
  writeExec(path.join(bin, 'ruflo'), `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "3.32.2"; exit 0; fi
if [ "$1" = "mcp" ] && [ "$2" = "start" ]; then echo '{"jsonrpc":"2.0","id":1,"result":{}}'; sleep 0.1; exit 0; fi
if [ "$1" = "hooks" ] && [ "$2" = "route" ]; then echo "route: coder"; exit 0; fi
${rufloMemoryBody(memoryShape)}
exit 0
`);
  writeExec(path.join(bin, 'aqe'), `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "3.12.2"; exit 0; fi
exit 0
`);
  writeExec(path.join(bin, 'agentdb'), `#!/usr/bin/env bash\nexit 0\n`);
  // sqlite3 is intentionally left unshimmed — the real system CLI must
  // resolve, both for this file's own ruflo shim bodies above AND for
  // kit_memory_roundtrip_check's independent on-disk read.
  writeExec(path.join(bin, 'npm'), `#!/usr/bin/env bash
if [ "$1" = "root" ] && [ "$2" = "-g" ]; then echo "${groot}"; exit 0; fi
if [ "$1" = "--version" ]; then echo "10.8.0"; exit 0; fi
exit 0
`);
  return bin;
}

// `commonShOverride` (optional): raw file content to write as lib/common.sh
// instead of copying the current working-tree file — used by the B19 teeth
// regression to run the REAL proof.sh against the pre-fix helper (via
// `git show <pinned-SHA>:lib/common.sh` — see that test's own comment for
// why a pinned SHA, not `HEAD`), rather than merely asserting the fixed
// code's current behavior.
function mkKit(base, { commonShOverride } = {}) {
  const kit = path.join(base, 'kit');
  const lib = path.join(kit, 'lib');
  fs.mkdirSync(lib, { recursive: true });
  if (commonShOverride) {
    fs.writeFileSync(path.join(lib, 'common.sh'), commonShOverride);
  } else {
    fs.copyFileSync(path.join(LIB, 'common.sh'), path.join(lib, 'common.sh'));
  }
  fs.copyFileSync(path.join(LIB, 'proof.sh'), path.join(lib, 'proof.sh'));
  writeExec(path.join(lib, 'status.sh'), `#!/usr/bin/env bash\necho '{"sentinels":{"present":6,"total":6}}'\n`);
  writeExec(path.join(lib, 'verify-learning.sh'), `#!/usr/bin/env bash\necho '{"pass":1,"warn":0,"fail":0,"info":0,"verdict":"live"}'\n`);
  writeExec(path.join(lib, 'health.sh'), `#!/usr/bin/env bash\necho '{"metrics":{"memory":{"totalEntries":100,"hnswEntries":50}}}'\n`);
  const asset = path.join(kit, 'assets', 'statusline.cjs');
  fs.mkdirSync(path.dirname(asset), { recursive: true });
  fs.writeFileSync(asset,
    '#!/usr/bin/env node\n' +
    `if (process.argv.includes('--json')) console.log(${JSON.stringify(JSON.stringify({ swarmdb: { vectorCount: 0 }, tests: { testFiles: 2, testCases: 10, countMethod: 'regex-scan' } }))});\n`);
  fs.chmodSync(asset, 0o755);
  return kit;
}

function mkTarget(base) {
  const target = path.join(base, 'target');
  fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(target, '.mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2) + '\n');
  fs.writeFileSync(path.join(target, '.claude', 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: 'echo PROOF_SL_OK' },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(target, 'claude-flow.config.json'),
    JSON.stringify({ daemon: { autostart: false } }, null, 2) + '\n');
  const sl = path.join(target, '.claude', 'helpers', 'statusline.cjs');
  fs.mkdirSync(path.dirname(sl), { recursive: true });
  fs.writeFileSync(sl,
    '#!/usr/bin/env node\n' +
    '// DAEMON-AUTOSTART-3-V1 child-env pin present (test fixture)\n' +
    `if (process.argv.includes('--json')) console.log(${JSON.stringify(JSON.stringify({ swarmdb: { vectorCount: 0 }, tests: { testFiles: 2, testCases: 10, countMethod: 'regex-scan' } }))});\n`);
  fs.chmodSync(sl, 0o755);
  return target;
}

// memoryShape: 'healthy' | 'no-persist' | 'side-channel'.
function build(memoryShape) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'proof-memrt-')));
  worlds.push(base);
  const groot = mkGroot(base);
  const bin = mkBin(base, groot, { memoryShape });
  const kit = mkKit(base);
  const target = mkTarget(base);
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME || base };
  const r = spawnSync('bash', [path.join(kit, 'lib', 'proof.sh'), target, '--single', '--json'],
    { encoding: 'utf8', env, timeout: 60000 });
  let json = null;
  try { json = JSON.parse((r.stdout || '').trim()); } catch { /* leave null, asserted below */ }
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}

// A PATH dir mirroring every executable on the real inherited PATH EXCEPT the
// named one — same idiom as tests/kit-sqlite-shim.test.js's mkStrippedBin,
// adapted to hide `ruflo` (there it hides `sqlite3`) rather than shimming it,
// since node/perl/bash and the real `ruflo` binary can live in the very same
// directory (true on this dev host — both resolve under the active nvm bin
// dir) and a plain PATH-prepend trick cannot hide one file inside a directory
// while keeping its siblings.
function mkStrippedBinExcluding(base, excludeName) {
  const bin = path.join(base, 'stripped-bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const d of (process.env.PATH || '').split(':')) {
    let names;
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (n === excludeName) continue;
      try { fs.symlinkSync(path.join(d, n), path.join(bin, n)); } catch { /* dup name from an earlier PATH dir */ }
    }
  }
  return bin;
}

// Build a world where `ruflo` is genuinely absent from PATH (not merely
// unshimmed — node/perl/sqlite3/etc. must still resolve so the rest of
// proof.sh can run at all). `npm`/`aqe`/`agentdb` are still stubbed
// deterministically; sqlite3 resolves from the stripped real PATH.
function buildRufloAbsent() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'proof-memrt-absent-')));
  worlds.push(base);
  const groot = mkGroot(base);
  const stub = path.join(base, 'stub-bin');
  writeExec(path.join(stub, 'aqe'), `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "3.12.2"; fi\nexit 0\n`);
  writeExec(path.join(stub, 'agentdb'), `#!/usr/bin/env bash\nexit 0\n`);
  writeExec(path.join(stub, 'npm'), `#!/usr/bin/env bash
if [ "$1" = "root" ] && [ "$2" = "-g" ]; then echo "${groot}"; exit 0; fi
if [ "$1" = "--version" ]; then echo "10.8.0"; exit 0; fi
exit 0
`);
  const stripped = mkStrippedBinExcluding(base, 'ruflo');
  const kit = mkKit(base);
  const target = mkTarget(base);
  const env = { PATH: `${stub}:${stripped}`, HOME: process.env.HOME || base };
  const r = spawnSync('bash', [path.join(kit, 'lib', 'proof.sh'), target, '--single', '--json'],
    { encoding: 'utf8', env, timeout: 60000 });
  let json = null;
  try { json = JSON.parse((r.stdout || '').trim()); } catch { /* leave null, asserted below */ }
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}

// Build a world where `ruflo` IS present (running the 'side-channel-no-
// instrument' shim) but `kit_sqlite_backend` resolves to "none": sqlite3 is
// stripped from PATH (same mkStrippedBinExcluding idiom as buildRufloAbsent,
// here hiding `sqlite3` instead of `ruflo`), and `npm root -g` points at this
// file's own mkGroot fixture, which never creates a `ruflo/node_modules/
// better-sqlite3` directory (that path only exists under the REAL global
// root on this dev machine) — so the node fallback in kit_sqlite_backend
// also fails to resolve, and the function is forced to answer "none".
// THE REGRESSION THIS PROVES (B19): before the lib/common.sh fix, this exact
// cache-echo fixture — which correctly FAILs under both the `cli` and `node`
// backends (see the 'side-channel' test above and the live-host check in the
// prior report) — reported "healthy" when neither instrument was available,
// because the independent-read step was skipped entirely rather than
// treated as a gap. After the fix it must FAIL, with a detail that makes
// "no verification happened" unmistakable rather than reading like a
// completed check against a backend literally named "none".
// `commonShOverride` (optional, passed through to mkKit): raw lib/common.sh
// content to use instead of the current working-tree file — lets the B19
// teeth regression below run the REAL proof.sh against the PRE-FIX helper
// (via `git show <pinned-SHA>:lib/common.sh` — pinned, not `HEAD`; see that
// test's own comment) rather than only asserting the fixed code's current
// output, closing the gap a critic found: this test previously proved its
// claim only by hand (interactively, during development), with no committed
// mechanism reproducing it — unlike B17,
// which already had one.
function buildNoInstrument({ commonShOverride } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'proof-memrt-noinstr-')));
  worlds.push(base);
  const groot = mkGroot(base);
  const stub = path.join(base, 'stub-bin');
  writeExec(path.join(stub, 'ruflo'), `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "3.32.2"; exit 0; fi
if [ "$1" = "mcp" ] && [ "$2" = "start" ]; then echo '{"jsonrpc":"2.0","id":1,"result":{}}'; sleep 0.1; exit 0; fi
if [ "$1" = "hooks" ] && [ "$2" = "route" ]; then echo "route: coder"; exit 0; fi
${rufloMemoryBody('side-channel-no-instrument')}
exit 0
`);
  writeExec(path.join(stub, 'aqe'), `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "3.12.2"; fi\nexit 0\n`);
  writeExec(path.join(stub, 'agentdb'), `#!/usr/bin/env bash\nexit 0\n`);
  writeExec(path.join(stub, 'npm'), `#!/usr/bin/env bash
if [ "$1" = "root" ] && [ "$2" = "-g" ]; then echo "${groot}"; exit 0; fi
if [ "$1" = "--version" ]; then echo "10.8.0"; exit 0; fi
exit 0
`);
  const stripped = mkStrippedBinExcluding(base, 'sqlite3');
  const kit = mkKit(base, { commonShOverride });
  const target = mkTarget(base);
  const env = { PATH: `${stub}:${stripped}`, HOME: process.env.HOME || base };
  const r = spawnSync('bash', [path.join(kit, 'lib', 'proof.sh'), target, '--single', '--json'],
    { encoding: 'utf8', env, timeout: 60000 });
  let json = null;
  try { json = JSON.parse((r.stdout || '').trim()); } catch { /* leave null, asserted below */ }
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}

function probe(json, name) { return json.probes.find((p) => p.name === name); }

describe('probe_memory_roundtrip (P16) — healthy round trip', () => {
  it('should_PASS_when_storeRetrieveIndependentReadAndPurgeAllVerify', () => {
    const { json } = build('healthy');
    expect(json).not.toBeNull();
    const p = probe(json, 'memory-roundtrip');
    expect(p).toBeDefined();
    expect(p.verdict).toBe('PASS');
    expect(p.detail).toMatch(/on-disk confirm/);
    expect(p.detail).toMatch(/purge all verified/);
  });
});

describe('probe_memory_roundtrip (P16) — falsification: shallow gap (CLI retrieve never echoes the write)', () => {
  it('should_FAIL_notPass_when_storeAndRetrieveAreBothNoOps', () => {
    const { json } = build('no-persist');
    expect(json).not.toBeNull();
    const p = probe(json, 'memory-roundtrip');
    expect(p).toBeDefined();
    expect(p.verdict).toBe('FAIL');
    expect(p.detail).toMatch(/CLI retrieve did not return the exact stored value/);
  });
});

describe('probe_memory_roundtrip (P16) — falsification: deep gap (THE centerpiece — CLI-only round trip looks perfect)', () => {
  it('should_FAIL_notPass_when_theCliEchoesAValueFromASideChannelButNeverWritesTheDb', () => {
    const { json } = build('side-channel');
    expect(json).not.toBeNull();
    const p = probe(json, 'memory-roundtrip');
    expect(p).toBeDefined();
    // A CLI-only round trip (store, then retrieve, matches) would have PASSed
    // this exact fixture — the failure can ONLY come from the independent
    // on-disk read catching that `memory_entries` never received the row.
    expect(p.verdict).toBe('FAIL');
    expect(p.detail).toMatch(/independent sqlite3 read of memory_entries did not show the stored value on disk/);
  });
});

describe('probe_memory_roundtrip (P16) — falsification: not-assessable must never silently PASS or WARN', () => {
  it('should_FAIL_notPass_notWarn_when_rufloIsAbsentFromPath_andRuflo_cliAlreadyFailedInTheSameRun', () => {
    const { json } = buildRufloAbsent();
    expect(json).not.toBeNull();
    const p = probe(json, 'memory-roundtrip');
    expect(p).toBeDefined();
    // Precedent: P6 bsqlite FAILs when totally unassessable ("PROVED must not
    // be earned blind") rather than P7 brain's WARN (a legitimately optional
    // component) — ruflo is not optional here, it IS the subject under test.
    expect(p.verdict).toBe('FAIL');
    expect(p.detail).toMatch(/not optional/);
    expect(p.detail).toMatch(/PROVED must not be earned blind/);
    expect(p.detail).toMatch(/ruflo not on PATH/);
    // This is never a NEW way to lose PROVED: with ruflo off PATH, P1
    // ruflo-cli has already hard-FAILed in this exact run.
    const p1 = probe(json, 'ruflo-cli');
    expect(p1).toBeDefined();
    expect(p1.verdict).toBe('FAIL');
  });
});

describe('probe_memory_roundtrip (P16) — B19 regression: the "none"-backend must never report healthy', () => {
  it('should_FAIL_notReportHealthy_when_theSideChannelEchoFixtureRunsWithNeitherSqliteInstrumentAvailable', () => {
    const { json } = buildNoInstrument();
    expect(json).not.toBeNull();
    const p = probe(json, 'memory-roundtrip');
    expect(p).toBeDefined();
    // THE B19 defect: before the lib/common.sh fix, kit_memory_roundtrip_check
    // skipped the independent-read step entirely when kit_sqlite_backend
    // returned "none" and still reported healthy purely on the CLI's own
    // (here, side-channel-echoed) claims — exactly the false-positive shape
    // this whole probe exists to catch, silently reappearing on an
    // instrument-less host.
    expect(p.verdict).not.toBe('PASS');
    expect(p.verdict).toBe('FAIL');
    // The detail must make "no independent verification happened" explicit —
    // never phrase it as a completed check against a backend named "none"
    // (the exact misreadable string this regression retires).
    expect(p.detail).toMatch(/no independent verification/i);
    expect(p.detail).not.toMatch(/on-disk confirm \(none\)/);
  });
});

describe('probe_memory_roundtrip (P16) — B19 teeth: the pre-fix helper genuinely reported healthy on this exact fixture', () => {
  it('should_proveTeeth_byRunningTheRealProofShAgainstThePreFixLibCommonSh_andSeeingItReportPass', () => {
    // Closes the gap a critic named: the test above only asserts the FIXED
    // code's current behavior — it never itself reproduced the pre-fix
    // defect. This rebuilds the identical fixture with the ORIGINAL
    // kit_memory_roundtrip_check and runs the REAL, unmodified proof.sh
    // against it end-to-end — not a shortcut unit call — to prove the false
    // PASS was real.
    //
    // Pinned to a specific SHA (`fbcff73`, Patch 71 — the last commit before
    // this session's B17/B19 fixes), NOT `HEAD`: an earlier version of this
    // test pinned to HEAD, and the moment the fix was committed (Patch 72,
    // ac124a8) HEAD moved past the bug, silently turning "proves the false
    // PASS was real" into "reconstructs the fixed helper and asserts it's
    // still fixed" — a tautology that still happened to pass, for the wrong
    // reason (confirmed live: this exact test went red the moment Patch 72
    // landed, for exactly that reason). A SHA pin has its own residual
    // fragility (a history rewrite — rebase/squash/force-push — would still
    // break it), but that is a far rarer, more deliberate event than "a
    // fix commits," which is guaranteed to happen. Not embedded as a literal
    // fixture string (the more robust alternative this repo already uses
    // elsewhere, e.g. tests/intel-rootwalk-patch.test.js, and this file's own
    // sibling tests/kit-sqlite-backup-rc.test.js for kit_sqlite_backup):
    // `buildNoInstrument`'s `commonShOverride` replaces the ENTIRE
    // lib/common.sh (proof.sh sources the whole file, not just one
    // function), which is ~1000 lines — hand-embedding that is disproportionate
    // duplication for one test versus a single pinned SHA with this comment.
    const preFix = execSync('git show fbcff73:lib/common.sh', { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
    const { json } = buildNoInstrument({ commonShOverride: preFix });
    expect(json).not.toBeNull();
    const p = probe(json, 'memory-roundtrip');
    expect(p).toBeDefined();
    // Pre-fix: the exact same cache-echo fixture that now correctly FAILs
    // reported PASS, because the independent-read step was skipped entirely
    // for the "none" backend instead of gating the verdict.
    expect(p.verdict).toBe('PASS');
    expect(p.detail).toMatch(/on-disk confirm \(none\)/);
  });
});
