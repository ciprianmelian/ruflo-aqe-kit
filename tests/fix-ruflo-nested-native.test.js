/**
 * Tests for fix-ruflo's AGENTDB-NESTED-NATIVE-V1 step (Step 5b.0b,
 * `repair_nested_bsqlite_native` in lib/fix-ruflo.sh).
 *
 * Defect this step fixes (ledger B18): Step 5b.0 (AGENTDB-GLOBAL-MCP-V1) only
 * load-tests/rebuilds better-sqlite3 for the STANDALONE agentdb MCP slot via
 * the single-path `global_bsqlite_loads` helper, which asserts the resolved
 * path is under the global root by design. It structurally cannot see the
 * hoisted floor's OWN nested copy at
 * $groot/ruflo/node_modules/agentdb/node_modules/better-sqlite3 (or the other
 * roots kit_bsqlite_candidate_roots enumerates) — exactly the root found
 * BROKEN on the coordinator's host (require()-ok, open-failed: no
 * build/Release/ at all). AgentDB silently falls back to sql.js WASM on that
 * failure, and @claude-flow/neural's reasoning-bank (the SONA training path)
 * resolves straight to this hoisted floor — so the gap is invisible at
 * runtime without a step that re-verifies by actually opening a database.
 *
 * These tests drive the REAL shipped function — extracted verbatim from
 * lib/fix-ruflo.sh by string parsing (the technique used by
 * tests/fix-ruflo-ruvector-execsafe.test.js), not a reimplementation of its
 * logic — against a stubbed `kit_bsqlite_native_status` (the real per-root
 * resolve+open probe from lib/common.sh, replaced here so root state is
 * driven by a marker file instead of a real npm tree) and a stubbed `npm`
 * (so no real network/compiler is involved; success is simulated by the stub
 * creating the marker file, exactly mirroring what a real `npm rebuild` /
 * `npm install` success would leave behind on disk: a working native binary).
 *
 * IMPORTANT: run this file in isolation
 * (`npx vitest run --config vitest.config.js tests/fix-ruflo-nested-native.test.js`).
 * This repo has confirmed cross-file vitest pollution (ledger B12) — an
 * aggregate multi-file run is not a reliable signal for this suite.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const FIX_RUFLO = path.join(REPO, 'lib', 'fix-ruflo.sh');
const COMMON = path.join(REPO, 'lib', 'common.sh');
const FIX_RUFLO_SRC = fs.readFileSync(FIX_RUFLO, 'utf8');

// ── Extraction: pull the REAL, currently-shipped function out of
// fix-ruflo.sh (string parsing, not a reimplementation). The function has no
// heredocs and no unindented '}' anywhere except its own closing brace, so a
// simple "stop at the first unindented '}' after the opening line" walk is
// sufficient — same principle as extractWrapperFunctionSource in the
// ruvector-execsafe test, simplified because there's no embedded heredoc to
// skip over here.
function extractFunctionSource(src, funcName) {
  const lines = src.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === `${funcName}() {`);
  if (startIdx === -1) throw new Error(`${funcName}() not found in fix-ruflo.sh`);
  const out = [];
  for (let i = startIdx; i < lines.length; i++) {
    out.push(lines[i]);
    if (lines[i] === '}') return out.join('\n');
  }
  throw new Error(`${funcName} closing brace not found`);
}

const FUNC_SRC = extractFunctionSource(FIX_RUFLO_SRC, 'repair_nested_bsqlite_native');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

let workDir;
let funcSrcPath;

beforeAll(() => {
  workDir = mkTmp('nested-bsqlite-');
  funcSrcPath = path.join(workDir, 'repair-func.sh');
  fs.writeFileSync(funcSrcPath, FUNC_SRC);
  // Sanity: the extracted function is itself valid bash.
  expect(spawnSync('bash', ['-n', funcSrcPath]).status).toBe(0);
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/**
 * Builds and runs the bash driver for one scenario.
 *
 * - `roots`: array of root directory paths (already created on disk). Each
 *   root's state is driven purely by whether "<root>/.native-ok" exists — the
 *   stubbed kit_bsqlite_native_status reads that marker to decide ok/broken,
 *   and the stubbed npm creates it to simulate a successful rebuild/install
 *   (the same observable disk effect a real successful native build leaves).
 * - `rebuildRc` / `installRc`: exit code the stubbed npm returns for
 *   `npm rebuild better-sqlite3` / `npm install --prefix <root> ...` (0 = success).
 * - `rebuildTouch` / `installTouch`: whether that stubbed call actually creates
 *   the marker file, INDEPENDENT of its exit code. Defaults to "touch iff its
 *   rc is 0" (i.e. every existing caller of runRepair keeps its original
 *   coupled behavior unchanged) — pass `false` explicitly to express a
 *   real-world false-success ("npm exited 0 but did not actually fix the
 *   binding"), which the coupled default can never represent.
 * - `dryRun`: sets DRY_RUN=1.
 */
function runRepair(
  { roots, rebuildRc = 0, installRc = 0, rebuildTouch, installTouch, dryRun = false },
  npmLogPath
) {
  const rTouch = (rebuildTouch === undefined ? rebuildRc === 0 : rebuildTouch) ? 1 : 0;
  const iTouch = (installTouch === undefined ? installRc === 0 : installTouch) ? 1 : 0;
  const script = [
    'set -uo pipefail',
    `source ${JSON.stringify(COMMON)}`,
    `source ${JSON.stringify(funcSrcPath)}`,
    `TEST_ROOTS=(${roots.map((r) => JSON.stringify(r)).join(' ')})`,
    `NPM_LOG=${JSON.stringify(npmLogPath)}`,
    `REBUILD_RC=${rebuildRc}`,
    `INSTALL_RC=${installRc}`,
    `REBUILD_TOUCH=${rTouch}`,
    `INSTALL_TOUCH=${iTouch}`,
    // Stub: real per-root resolve+open probe, replaced with a marker-file read.
    'kit_bsqlite_native_status() {',
    '  local r',
    '  for r in "${TEST_ROOTS[@]}"; do',
    '    if [[ -f "$r/.native-ok" ]]; then',
    "      printf '%s|ok|%s/node_modules/better-sqlite3/lib/index.js\\n' \"$r\" \"$r\"",
    '    else',
    "      printf '%s|broken|%s/node_modules/better-sqlite3/lib/index.js\\n' \"$r\" \"$r\"",
    '    fi',
    '  done',
    '}',
    // Stub: no real network/compiler. Logs every invocation. Exit code and
    // marker-touch are DECOUPLED (REBUILD_TOUCH/INSTALL_TOUCH are independent
    // of REBUILD_RC/INSTALL_RC) so a false-success (rc=0, binding still
    // broken) is expressible, not just the coupled "success == fixed" shape.
    'npm() {',
    "  { printf 'CALL:'; printf ' %q' \"$@\"; printf '\\n'; } >> \"$NPM_LOG\"",
    '  if [[ "$1" == "rebuild" ]]; then',
    '    [[ "$REBUILD_TOUCH" -eq 1 ]] && touch "$PWD/.native-ok"',
    '    return "$REBUILD_RC"',
    '  elif [[ "$1" == "install" ]]; then',
    '    local prefix="" args=("$@") i',
    '    for i in "${!args[@]}"; do [[ "${args[$i]}" == "--prefix" ]] && prefix="${args[$((i+1))]}"; done',
    '    [[ "$INSTALL_TOUCH" -eq 1 ]] && touch "$prefix/.native-ok"',
    '    return "$INSTALL_RC"',
    '  fi',
    '  return 0',
    '}',
    `DRY_RUN=${dryRun ? 1 : 0}`,
    'ERRORS=0',
    'FIXES=0',
    'FIX_LOG=()',
    'repair_nested_bsqlite_native',
    'echo "__ERRORS=$ERRORS __FIXES=$FIXES"',
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const m = out.match(/__ERRORS=(\d+) __FIXES=(\d+)/);
  return { code: r.status, out, errors: m ? Number(m[1]) : null, fixes: m ? Number(m[2]) : null };
}

function readNpmCalls(npmLogPath) {
  if (!fs.existsSync(npmLogPath)) return [];
  return fs
    .readFileSync(npmLogPath, 'utf8')
    .split('\n')
    .filter(Boolean);
}

describe('AGENTDB-NESTED-NATIVE-V1 — repair_nested_bsqlite_native', () => {
  it('a broken root is repaired via `npm rebuild better-sqlite3` -> fix logged, marker created, no fallback', () => {
    const root = path.join(workDir, 'root-rebuild-ok');
    fs.mkdirSync(root, { recursive: true });
    const marker = path.join(root, '.native-ok');
    const npmLog = path.join(workDir, 'npm-rebuild-ok.log');

    const r = runRepair({ roots: [root], rebuildRc: 0, installRc: 1 }, npmLog);

    expect(r.out).toMatch(/AGENTDB-NESTED-NATIVE-V1/);
    expect(r.out).toMatch(/Repaired nested better-sqlite3 native binding/);
    expect(fs.existsSync(marker)).toBe(true);
    const calls = readNpmCalls(npmLog);
    expect(calls.some((l) => l.includes('rebuild') && l.includes('better-sqlite3'))).toBe(true);
    expect(calls.some((l) => l.includes('install'))).toBe(false); // rebuild succeeded -> no fallback
    expect(r.fixes).toBe(1);
    expect(r.errors).toBe(0);
  });

  it('a healthy root (already ok) is a no-op — no npm calls, pass logged, zero fixes/errors', () => {
    const root = path.join(workDir, 'root-healthy');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, '.native-ok'), ''); // pre-mark as healthy
    const npmLog = path.join(workDir, 'npm-healthy.log');

    const r = runRepair({ roots: [root] }, npmLog);

    expect(r.out).toMatch(/No nested better-sqlite3 native bindings broken/);
    expect(r.out).toMatch(/AGENTDB-NESTED-NATIVE-V1/);
    expect(fs.existsSync(npmLog)).toBe(false); // npm never invoked
    expect(r.fixes).toBe(0);
    expect(r.errors).toBe(0);
  });

  it('rebuild fails AND the install fallback fails -> stays broken: warn + ERRORS++, no fix, both repairs attempted', () => {
    const root = path.join(workDir, 'root-stays-broken');
    fs.mkdirSync(root, { recursive: true });
    const marker = path.join(root, '.native-ok');
    const npmLog = path.join(workDir, 'npm-stays-broken.log');

    const r = runRepair({ roots: [root], rebuildRc: 1, installRc: 1 }, npmLog);

    expect(r.out).toMatch(/still broken after repair attempt/);
    expect(r.out).toMatch(/AGENTDB-NESTED-NATIVE-V1/);
    expect(fs.existsSync(marker)).toBe(false);
    const calls = readNpmCalls(npmLog);
    expect(calls.some((l) => l.includes('rebuild'))).toBe(true);
    expect(calls.some((l) => l.includes('install'))).toBe(true); // fallback WAS attempted
    expect(r.fixes).toBe(0);
    expect(r.errors).toBe(1); // visible as an error, never a silent success
  });

  it('rebuild fails but the install fallback succeeds -> repaired via fallback, fix logged', () => {
    const root = path.join(workDir, 'root-fallback-ok');
    fs.mkdirSync(root, { recursive: true });
    const marker = path.join(root, '.native-ok');
    const npmLog = path.join(workDir, 'npm-fallback-ok.log');

    const r = runRepair({ roots: [root], rebuildRc: 1, installRc: 0 }, npmLog);

    expect(r.out).toMatch(/falling back to reinstalling a prebuilt binary/);
    expect(r.out).toMatch(/Repaired nested better-sqlite3 native binding/);
    expect(fs.existsSync(marker)).toBe(true);
    const calls = readNpmCalls(npmLog);
    expect(calls.some((l) => l.includes('rebuild'))).toBe(true);
    expect(calls.some((l) => l.includes('install'))).toBe(true);
    expect(r.fixes).toBe(1);
    expect(r.errors).toBe(0);
  });

  it('dry-run: prints what it would do and changes NOTHING on disk (no npm calls, no marker, no ERRORS)', () => {
    const root = path.join(workDir, 'root-dry-run');
    fs.mkdirSync(root, { recursive: true });
    const marker = path.join(root, '.native-ok');
    const npmLog = path.join(workDir, 'npm-dry-run.log');

    const r = runRepair({ roots: [root], rebuildRc: 0, installRc: 0, dryRun: true }, npmLog);

    expect(r.out).toMatch(/\[dry-run\] Would:/);
    expect(r.out).toMatch(/AGENTDB-NESTED-NATIVE-V1/);
    expect(fs.existsSync(npmLog)).toBe(false); // npm never invoked
    expect(fs.existsSync(marker)).toBe(false); // no mutation
    expect(r.fixes).toBe(0);
    expect(r.errors).toBe(0);
  });

  it('FALSE SUCCESS: npm rebuild exits 0 but never actually fixes the binding -> re-verification catches it (warn + ERRORS++, no fix, no "Repaired")', () => {
    // This is the exact case the round-2 critic constructed to test whether
    // the code trusts npm's own exit code or genuinely re-verifies: rebuild
    // "succeeds" (rc=0, as a real `npm rebuild` reporting success but leaving
    // a stale/still-broken binary would) yet the marker (== the real binding)
    // is deliberately never touched. If the production code only checked
    // `$repaired -eq 1` (npm's exit code) without ALSO requiring
    // `kit_bsqlite_native_status` to re-report "ok", this would be wrongly
    // logged as a fix. The other 6 tests cannot express this: their npm stub
    // always couples "exited 0" with "touched the marker", so success and
    // actually-fixed can never diverge in those fixtures.
    const root = path.join(workDir, 'root-false-success');
    fs.mkdirSync(root, { recursive: true });
    const marker = path.join(root, '.native-ok');
    const npmLog = path.join(workDir, 'npm-false-success.log');

    const r = runRepair({ roots: [root], rebuildRc: 0, rebuildTouch: false }, npmLog);

    expect(r.out).not.toMatch(/Repaired nested better-sqlite3 native binding/);
    expect(r.out).toMatch(/still broken after repair attempt/);
    expect(r.out).toMatch(/AGENTDB-NESTED-NATIVE-V1/);
    expect(fs.existsSync(marker)).toBe(false); // binding genuinely never fixed
    const calls = readNpmCalls(npmLog);
    expect(calls.some((l) => l.includes('rebuild'))).toBe(true);
    // rebuild reported success (rc=0), so the code's own `else` (fallback
    // install) branch is never reached — this is a pure re-verify-catches-a-
    // lying-rc case, not a fallback case.
    expect(calls.some((l) => l.includes('install'))).toBe(false);
    expect(r.fixes).toBe(0);
    expect(r.errors).toBe(1); // visible as an error, never a silent false fix
  });

  it('two broken roots in one call are handled independently: one repairs, the other stays broken', () => {
    const rootOk = path.join(workDir, 'root-multi-ok');
    const rootBad = path.join(workDir, 'root-multi-bad');
    fs.mkdirSync(rootOk, { recursive: true });
    fs.mkdirSync(rootBad, { recursive: true });
    const npmLog = path.join(workDir, 'npm-multi.log');

    // A single global REBUILD_RC/INSTALL_RC applies to both roots in this
    // harness; to get one-repairs/one-stays-broken with one npm stub, gate
    // success on which root's rebuild command is running.
    const script = [
      'set -uo pipefail',
      `source ${JSON.stringify(COMMON)}`,
      `source ${JSON.stringify(funcSrcPath)}`,
      `TEST_ROOTS=(${JSON.stringify(rootOk)} ${JSON.stringify(rootBad)})`,
      `NPM_LOG=${JSON.stringify(npmLog)}`,
      `GOOD_ROOT=${JSON.stringify(rootOk)}`,
      'kit_bsqlite_native_status() {',
      '  local r',
      '  for r in "${TEST_ROOTS[@]}"; do',
      '    if [[ -f "$r/.native-ok" ]]; then',
      "      printf '%s|ok|%s/node_modules/better-sqlite3/lib/index.js\\n' \"$r\" \"$r\"",
      '    else',
      "      printf '%s|broken|%s/node_modules/better-sqlite3/lib/index.js\\n' \"$r\" \"$r\"",
      '    fi',
      '  done',
      '}',
      'npm() {',
      "  { printf 'CALL:'; printf ' %q' \"$@\"; printf '\\n'; } >> \"$NPM_LOG\"",
      '  if [[ "$1" == "rebuild" ]]; then',
      '    if [[ "$PWD" == "$GOOD_ROOT" ]]; then touch "$PWD/.native-ok"; return 0; else return 1; fi',
      '  elif [[ "$1" == "install" ]]; then',
      '    return 1', // fallback also fails for the bad root
      '  fi',
      '  return 0',
      '}',
      'DRY_RUN=0',
      'ERRORS=0',
      'FIXES=0',
      'FIX_LOG=()',
      'repair_nested_bsqlite_native',
      'echo "__ERRORS=$ERRORS __FIXES=$FIXES"',
    ].join('\n');
    const spawned = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20000 });
    const out = `${spawned.stdout || ''}${spawned.stderr || ''}`;
    const m = out.match(/__ERRORS=(\d+) __FIXES=(\d+)/);

    expect(fs.existsSync(path.join(rootOk, '.native-ok'))).toBe(true);
    expect(fs.existsSync(path.join(rootBad, '.native-ok'))).toBe(false);
    expect(Number(m[1])).toBe(1); // rootBad stayed broken
    expect(Number(m[2])).toBe(1); // rootOk was repaired
  });
});
