/**
 * Tests for fix-ruflo's RUVECTOR-EXECSAFE-V1 dist patch — specifically the
 * fail-closed gate on PARTIAL application.
 *
 * Defect (found by an independent critic review, reproduced here): the
 * patcher engine wrote the file and stamped the RUVECTOR-EXECSAFE-V1
 * sentinel whenever `applied > 0`, with no check that EVERY known
 * shell-injection anchor was actually matched. Drifting just one of the 30
 * hardcoded anchors (simulating a future upstream/dist format change)
 * produced APPLIED:29/30, sentinel written, rc=0, ERRORS not incremented —
 * and because the sentinel was now on disk, the wrapper's old "sentinel
 * present -> skip" idempotency check would treat the file as fully clean
 * FOREVER, silently freezing the one remaining vulnerable execSync( call
 * site with no operator-visible failure. The 0/30 (fully drifted) case
 * already failed closed correctly; only the partial case did not.
 *
 * Fix under test: the engine now requires every pair to be "accounted for"
 * (matched in its old shape now, or already in its new shape from an earlier
 * run) before it will write anything at all; a single unmatched anchor blocks
 * the whole write AND the sentinel (exit code 3, PARTIAL). The wrapper's
 * idempotency check no longer trusts the sentinel alone — it only skips a
 * file that dist_defect_present already found execSync(-free.
 *
 * Two independent harnesses, both against the REAL code (byte-identical to
 * what fix-ruflo.sh embeds — extracted via string parsing, not reimplemented):
 *
 *  1. The engine (patcher) script in isolation, driven with a small SELF-
 *     CONTAINED custom 3-pair spec (not the real 30) so the fixtures stay
 *     small and every outcome — happy path, partial, zero-match, idempotent
 *     re-run, and a legacy-partial repair — is easy to construct and assert
 *     on precisely. This proves the accounting/gating algorithm itself,
 *     independent of the specific 30 anchors (those were verified live
 *     against the real installed ruvector copies during development).
 *
 *  2. The full bash wrapper function `patch_ruvector_execsafe`, run with its
 *     REAL embedded 30-pair spec via `source`, against a small fixture that
 *     only matches ONE of the 30 real anchors (hooks_verify) — reproducing
 *     the critic's exact finding end-to-end through the actual shipped
 *     wrapper: ERRORS incremented, FIXES not incremented, file left
 *     byte-identical, no sentinel written.
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

// ── Extraction: pull the REAL, currently-shipped code out of fix-ruflo.sh ────
// (string parsing, not a reimplementation — these tests exercise exactly what
// ships, not a hand-written stand-in for it.)

function extractEngineScript(src) {
  const lines = src.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === 'patch_ruvector_execsafe() {');
  if (startIdx === -1) throw new Error('patch_ruvector_execsafe() not found in fix-ruflo.sh');
  let i = startIdx;
  while (i < lines.length && !/cat > "\$patcher" <<'PJS'/.test(lines[i])) i++;
  if (i >= lines.length) throw new Error('engine heredoc start not found');
  i++;
  const out = [];
  while (i < lines.length && lines[i] !== 'PJS') {
    out.push(lines[i]);
    i++;
  }
  if (i >= lines.length) throw new Error('engine heredoc terminator (PJS) not found');
  return out.join('\n');
}

function extractSpecText(src) {
  const lines = src.split('\n');
  let i = lines.findIndex((l) => /cat > "\$spec" <<'SPEC_EOF'/.test(l));
  if (i === -1) throw new Error('spec heredoc start not found');
  i++;
  const out = [];
  while (i < lines.length && lines[i] !== 'SPEC_EOF') {
    out.push(lines[i]);
    i++;
  }
  if (i >= lines.length) throw new Error('spec heredoc terminator (SPEC_EOF) not found');
  return out.join('\n') + '\n';
}

function extractWrapperFunctionSource(src) {
  const lines = src.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === 'patch_ruvector_execsafe() {');
  if (startIdx === -1) throw new Error('patch_ruvector_execsafe() not found in fix-ruflo.sh');
  let inHeredoc = false;
  const out = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    if (!inHeredoc && /cat > "\$patcher" <<'PJS'/.test(line)) {
      inHeredoc = true;
      continue;
    }
    if (inHeredoc) {
      if (line === 'PJS') inHeredoc = false;
      continue;
    }
    if (line === '}') return out.join('\n'); // function's real closing brace, outside the heredoc
  }
  throw new Error('patch_ruvector_execsafe closing brace not found');
}

const ENGINE_JS = extractEngineScript(FIX_RUFLO_SRC);
const REAL_SPEC_TEXT = extractSpecText(FIX_RUFLO_SRC);
const WRAPPER_FUNCTION_SRC = extractWrapperFunctionSource(FIX_RUFLO_SRC);

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runEngine(fixtureFile, specFile) {
  const r = spawnSync('node', [ENGINE_PATH, fixtureFile, specFile], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// A small custom (not the real 30) OLD/NEW pair set, chosen so each OLD block
// is a single, independently balanced statement — no reconstruction of
// surrounding case/try scaffolding needed to keep fixtures valid JS.
const CUSTOM_PAIRS = [
  {
    old: "  const r1 = execSync('cmd1', { encoding: 'utf-8' });",
    neu: "  const r1 = runFoo(['cmd1']);",
  },
  {
    old: "  const r2 = execSync('cmd2', { encoding: 'utf-8' });",
    neu: "  const r2 = runFoo(['cmd2']);",
  },
  {
    old: "  const r3 = execSync('cmd3', { encoding: 'utf-8' });",
    neu: "  const r3 = runFoo(['cmd3']);",
  },
];

function customSpecText() {
  return CUSTOM_PAIRS.map((p) => `###OLD###\n${p.old}\n###NEW###\n${p.neu}\n###END###\n`).join('');
}

const HELPER_ANCHOR =
  "function sanitizeNumericArg(arg, defaultVal) {\n  const n = parseInt(arg, 10);\n  return Number.isFinite(n) && n > 0 ? n : (defaultVal || 0);\n}\n";
const REQUIRE_LINE = "const { execSync, execFileSync } = require('child_process');";

// A valid, self-balanced fixture: boilerplate anchors + the 3 custom pairs'
// OLD shapes, each inside its own tiny function (so removing/replacing one
// line never unbalances another).
function customFixtureBody() {
  return [
    REQUIRE_LINE,
    '',
    HELPER_ANCHOR,
    'function handlerA() {',
    CUSTOM_PAIRS[0].old,
    '  return r1;',
    '}',
    'function handlerB() {',
    CUSTOM_PAIRS[1].old,
    '  return r2;',
    '}',
    'function handlerC() {',
    CUSTOM_PAIRS[2].old,
    '  return r3;',
    '}',
    'module.exports = { handlerA, handlerB, handlerC };',
    '',
  ].join('\n');
}

let ENGINE_PATH;
let CUSTOM_SPEC_PATH;
let workDir;

beforeAll(() => {
  workDir = mkTmp('ruvector-execsafe-');
  ENGINE_PATH = path.join(workDir, 'engine.js');
  fs.writeFileSync(ENGINE_PATH, ENGINE_JS);
  CUSTOM_SPEC_PATH = path.join(workDir, 'custom-spec.txt');
  fs.writeFileSync(CUSTOM_SPEC_PATH, customSpecText());
  // Sanity: the extracted engine is itself valid JS.
  expect(spawnSync('node', ['--check', ENGINE_PATH]).status).toBe(0);
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('RUVECTOR-EXECSAFE-V1 engine — fail-closed accounting (custom 3-pair spec)', () => {
  function writeFixture(name, body) {
    const p = path.join(workDir, name);
    fs.writeFileSync(p, body);
    return p;
  }

  it('happy path: all 3 pairs match -> writes, stamps sentinel once, zero execSync( left, valid JS', () => {
    const f = writeFixture('happy.js', customFixtureBody());
    const before = fs.readFileSync(f, 'utf8');
    const r = runEngine(f, CUSTOM_SPEC_PATH);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/APPLIED:3\/3/);
    const after = fs.readFileSync(f, 'utf8');
    expect(after).not.toBe(before);
    expect(after.match(/RUVECTOR-EXECSAFE-V1/g)).toHaveLength(1);
    expect(after).not.toMatch(/execSync\(/);
    expect(after).not.toContain(REQUIRE_LINE); // simplified once fully clean
    expect(spawnSync('node', ['--check', f]).status).toBe(0);
  });

  it('idempotent: re-running a fully-patched file is a byte-identical no-op', () => {
    const f = writeFixture('happy2.js', customFixtureBody());
    expect(runEngine(f, CUSTOM_SPEC_PATH).code).toBe(0);
    const afterFirst = fs.readFileSync(f, 'utf8');
    const second = runEngine(f, CUSTOM_SPEC_PATH);
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/ALREADY_CLEAN/);
    expect(fs.readFileSync(f, 'utf8')).toBe(afterFirst);
  });

  it('PARTIAL (2/3 accounted for): refuses to write ANYTHING — no file mutation, no sentinel, non-zero rc', () => {
    const body = customFixtureBody().replace(
      CUSTOM_PAIRS[2].old,
      "  const r3 = execSync('cmd3-DRIFTED', { encoding: 'utf-8' });" // neither old nor new shape for pair 3
    );
    const f = writeFixture('partial.js', body);
    const before = fs.readFileSync(f, 'utf8');
    const r = runEngine(f, CUSTOM_SPEC_PATH);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/PARTIAL:2\/3/);
    expect(r.out).toMatch(/MISSING:/);
    // The single most important assertion: file is COMPLETELY untouched —
    // not even the 2 genuinely-matching pairs were applied. All-or-nothing.
    expect(fs.readFileSync(f, 'utf8')).toBe(before);
    expect(fs.readFileSync(f, 'utf8')).not.toMatch(/RUVECTOR-EXECSAFE-V1/);
    expect(fs.readFileSync(f, 'utf8')).toMatch(/execSync\(/); // still vulnerable, as it must remain
  });

  it('re-running on a PARTIAL-blocked file keeps refusing (never freezes as "done")', () => {
    const body = customFixtureBody().replace(CUSTOM_PAIRS[2].old, "  const r3 = execSync('cmd3-DRIFTED', {});");
    const f = writeFixture('partial-repeat.js', body);
    const first = runEngine(f, CUSTOM_SPEC_PATH);
    const second = runEngine(f, CUSTOM_SPEC_PATH);
    expect(first.code).toBe(3);
    expect(second.code).toBe(3); // not 0 — a stale run must not make this look done
    expect(fs.readFileSync(f, 'utf8')).not.toMatch(/RUVECTOR-EXECSAFE-V1/);
  });

  it('zero match (0/3 accounted for): ANCHOR_NOT_FOUND, file untouched, no sentinel', () => {
    const body = [REQUIRE_LINE, '', HELPER_ANCHOR, 'function unrelated() { return execSync("echo hi"); }', ''].join(
      '\n'
    );
    const f = writeFixture('zero.js', body);
    const before = fs.readFileSync(f, 'utf8');
    const r = runEngine(f, CUSTOM_SPEC_PATH);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/ANCHOR_NOT_FOUND:no_pairs_matched/);
    expect(fs.readFileSync(f, 'utf8')).toBe(before);
  });

  it('legacy-partial repair: a file with 2/3 already converted (+ stale sentinel) can still be finished', () => {
    // Simulates what an OLDER, buggy version of this same patch could have
    // left behind (sentinel + helpers already inserted, 2 sites already
    // converted, 1 site still vulnerable) — must NOT be treated as frozen.
    const happy = customFixtureBody();
    const r1 = runEngine(writeFixture('legacy-seed.js', happy), CUSTOM_SPEC_PATH);
    expect(r1.code).toBe(0);
    let fullyPatched = fs.readFileSync(path.join(workDir, 'legacy-seed.js'), 'utf8');
    // Revert exactly one site back to its OLD (vulnerable) shape, leaving the
    // sentinel/helpers from the "earlier run" in place.
    expect(fullyPatched).toContain(CUSTOM_PAIRS[2].neu);
    const legacyPartial = fullyPatched.replace(CUSTOM_PAIRS[2].neu, CUSTOM_PAIRS[2].old);
    const f = writeFixture('legacy-partial.js', legacyPartial);
    const r = runEngine(f, CUSTOM_SPEC_PATH);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/APPLIED:1\/3 ALREADY_DONE:2/);
    const after = fs.readFileSync(f, 'utf8');
    expect(after).not.toMatch(/execSync\(/);
    expect(after.match(/RUVECTOR-EXECSAFE-V1/g)).toHaveLength(1); // not duplicated
    expect(spawnSync('node', ['--check', f]).status).toBe(0);
  });

  it('READ_FAILED (rc=5): nonexistent file reports the real cause, not "anchor not found"', () => {
    const missing = path.join(workDir, 'does-not-exist.js');
    const r = runEngine(missing, CUSTOM_SPEC_PATH);
    expect(r.code).toBe(5);
    expect(r.out).toMatch(/READ_FAILED:ENOENT/);
  });

  it('WRITE_FAILED (rc=4): a read-only target reports EACCES, not "anchor not found"', () => {
    if (process.getuid && process.getuid() === 0) {
      return; // root bypasses file-mode write protection; not testable as root
    }
    const f = writeFixture('readonly.js', customFixtureBody());
    fs.chmodSync(f, 0o444);
    try {
      const r = runEngine(f, CUSTOM_SPEC_PATH);
      expect(r.code).toBe(4);
      expect(r.out).toMatch(/WRITE_FAILED:EACCES/);
    } finally {
      fs.chmodSync(f, 0o644);
    }
  });
});

describe('RUVECTOR-EXECSAFE-V1 wrapper — patch_ruvector_execsafe fails closed end-to-end (real 30-pair spec)', () => {
  // Runs the REAL bash function (sourced verbatim, real embedded spec) against
  // a small fixture. common.sh supplies pass/warn/info/fix/dist_defect_present.
  function runWrapper(fixtureFile) {
    const script = [
      'set -uo pipefail',
      `source ${JSON.stringify(COMMON)}`,
      `source ${JSON.stringify(path.join(workDir, 'wrapper-func.sh'))}`,
      'DRY_RUN=0',
      'ERRORS=0',
      'FIXES=0',
      'FIX_LOG=()',
      `patch_ruvector_execsafe ${JSON.stringify(fixtureFile)}`,
      'echo "__ERRORS=$ERRORS __FIXES=$FIXES"',
    ].join('\n');
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const m = out.match(/__ERRORS=(\d+) __FIXES=(\d+)/);
    return { code: r.status, out, errors: m ? Number(m[1]) : null, fixes: m ? Number(m[2]) : null };
  }

  beforeAll(() => {
    fs.writeFileSync(path.join(workDir, 'wrapper-func.sh'), WRAPPER_FUNCTION_SRC);
    expect(spawnSync('bash', ['-n', path.join(workDir, 'wrapper-func.sh')]).status).toBe(0);
  });

  // The exact hooks_verify pair (10-space indent, byte-exact) — the single
  // simplest real anchor among the 30 — so this fixture matches 1/30.
  function tinyRealFixture() {
    return [
      REQUIRE_LINE,
      '',
      'function sanitizeShellArg(arg) { return arg; }',
      '',
      HELPER_ANCHOR,
      'function handleHooksVerify() {',
      "          const output = execSync('npx ruvector hooks verify', { encoding: 'utf-8', timeout: 15000 });",
      '  return output;',
      '}',
      'module.exports = { handleHooksVerify };',
      '',
    ].join('\n');
  }

  it('reproduces the critic finding: 1/30 real anchor matched -> PARTIAL, refuses to write, ERRORS++, no sentinel', () => {
    const f = path.join(workDir, 'tiny-real.js');
    fs.writeFileSync(f, tinyRealFixture());
    const before = fs.readFileSync(f, 'utf8');
    const r = runWrapper(f);
    expect(r.out).toMatch(/PARTIAL:1\/30/);
    expect(r.out).toMatch(/PARTIAL match/i);
    expect(r.errors).toBe(1); // must be visible as an error, not a silent success
    expect(r.fixes).toBe(0); // must NOT be logged as a fix
    expect(fs.readFileSync(f, 'utf8')).toBe(before); // byte-identical, untouched
    expect(fs.readFileSync(f, 'utf8')).not.toMatch(/RUVECTOR-EXECSAFE-V1/);
    fs.rmSync(`${f}.execsafe-bak`, { force: true });
  });

  it('re-running the same PARTIAL fixture never flips to "already present" (no permanent freeze)', () => {
    const f = path.join(workDir, 'tiny-real-repeat.js');
    fs.writeFileSync(f, tinyRealFixture());
    const first = runWrapper(f);
    const second = runWrapper(f);
    expect(first.errors).toBe(1);
    expect(second.errors).toBe(1); // still an error the second time, not silently clean
    expect(second.out).not.toMatch(/already present/i);
    fs.rmSync(`${f}.execsafe-bak`, { force: true });
  });

  it('a genuinely clean file (no execSync at all) is reported already-clean with zero mutation', () => {
    const f = path.join(workDir, 'clean.js');
    const body = "const { execFileSync } = require('child_process');\nfunction ok() { return execFileSync('true', []); }\n";
    fs.writeFileSync(f, body);
    const r = runWrapper(f);
    expect(r.out).toMatch(/already clean/i);
    expect(r.errors).toBe(0);
    expect(fs.readFileSync(f, 'utf8')).toBe(body);
  });

  it('a nonexistent target file is a NOFILES no-op, not a crash or an error', () => {
    const missing = path.join(workDir, 'does-not-exist-wrapper.js');
    const r = runWrapper(missing);
    expect(r.code).toBe(0);
    expect(r.errors).toBe(0);
  });
});
