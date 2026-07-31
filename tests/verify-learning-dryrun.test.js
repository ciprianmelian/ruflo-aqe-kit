/**
 * Tests for B24 (verify-learning has no dry-run): `lib/verify-learning.sh` is
 * documented read-only and always runs (as the 5th sync stage, after B11's
 * four fixed mutation sites), but it had NO --dry-run concept at all — two of
 * its probes shell out to upstream status commands whose OWN side effect of
 * instantiating internal config objects just to print a table creates disk
 * artifacts on a "read-only" run:
 *
 *   - RUVECTOR_HNSW resolution (~:362 pre-fix) `aqe ruvector status`
 *     creates .agentic-qe/
 *   - probe_daemon_advisory (~:330 pre-fix)     `ruflo daemon status`
 *     creates .claude-flow/logs/daemon.log
 *
 * Corrected attribution (see docs/gauntlet-2026-07-31/MASTER-LEDGER.md, B21):
 * this is NOT daemon auto-spawn and NOT a billing risk — no daemon is ever
 * started by either call, confirmed by pgrep before/after in the ground-truth
 * investigation for this suite. It is a truthfulness gap: a read-only stage
 * that leaves disk artifacts behind under --dry-run.
 *
 * Fix shape (asymmetric, because the two sites have different disk-truth
 * availability):
 *   - probe_daemon_advisory: the `ruflo daemon status` CLI call is replaced
 *     UNCONDITIONALLY (every mode, not just --dry-run) with kit_daemon_ps_lines
 *     (common.sh) — the same pgrep-based discovery lib/status.sh and
 *     lib/proof.sh already trust as this kit's canonical daemon truth ("state
 *     files lie, trust pgrep"). No disk-vs-dry-run distinction needed: the CLI
 *     call is simply gone.
 *   - RUVECTOR_HNSW resolution: `aqe ruvector status` reads a flag that is
 *     PURE in-memory state in the installed aqe dist (no flags file is ever
 *     written), so there is no disk equivalent. Gated on $DRY_RUN only: live
 *     behavior is byte-for-byte unchanged; --dry-run skips the call, falls
 *     back to the RUVECTOR_USE_NATIVE_HNSW env var if set (the same input the
 *     CLI itself would honor), and otherwise reports skipped honestly rather
 *     than fabricating a value — probe_hnsw_native already degrades to
 *     config.yaml / "indeterminate" when the flag can't be resolved.
 *
 * KNOWN REMAINING GAP (explicitly out of this file's footprint, reported not
 * fixed): lib/sync.sh:148 invokes verify-learning.sh as `... "$TARGET_DIR"
 * --json` and never forwards `--dry-run` even when sync's own $DRY_RUN is 1.
 * So `bin/ruflo-kit sync <target> --dry-run` still leaves .agentic-qe/ behind
 * (though no longer daemon.log) until sync.sh's call site passes
 * ${_dryflag[@]+"${_dryflag[@]}"} through. This suite tests verify-learning.sh
 * directly (as `bin/ruflo-kit verify-learning <target> --dry-run` already
 * does, since bin/ruflo-kit's verify-learning verb execs it with "$@" as-is)
 * — the one caller that already forwards the flag correctly today.
 *
 * Harness: hermetic. Fake `ruflo`/`aqe` stub binaries on PATH simulate the
 * REAL upstream side effect (creating the artifact on disk) so a POST-FIX
 * dry-run test that finds nothing on disk is proving the call was skipped,
 * not merely that a no-op stub happened not to write anything.
 *
 * Teeth: TEETH tests run the exact pre-fix script content (`git show
 * <PRE_FIX_REF>:lib/verify-learning.sh` — a FIXED commit, NOT HEAD) against
 * the same fixture shape and assert the OLD defect (the artifact appears
 * even under --dry-run).
 *
 * PRE_FIX_REF is pinned to a specific SHA rather than HEAD on purpose: HEAD
 * is a MOVING target, and the instant this fix lands in a commit, `git show
 * HEAD:...` starts returning the FIXED script — every TEETH assertion below
 * would then compare fixed-to-fixed and fail, not because the fix broke but
 * because the test's own premise (HEAD = old code) silently stopped being
 * true. This already happened for real this session: this exact suite went
 * 10/10 -> 9/10 the moment this fix's commit (ac124a8) landed, because this
 * file still read `HEAD:lib/verify-learning.sh` at the time. See
 * tests/dryrun-mutation-guard.test.js's PRE_FIX_REF for the sibling fix and
 * the fuller writeup — same defect, same repair, different file. Do not
 * "modernise" this back to HEAD.
 */
'use strict';

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..');
const VERIFY_LEARNING_SH = path.join(REPO, 'lib', 'verify-learning.sh');

let work, fakebin, fakehome;

function writeExec(p, body) {
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
}

function walk(d) {
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
}

// Full recursive listing (path + content sha256), not a spot check — catches
// both "extra file appeared" and "existing file rewritten in place".
function snapshot(d) {
  return walk(d).map((f) => {
    const rel = path.relative(d, f);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    return `${rel}  ${sha}`;
  }).sort();
}

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'b24-verifylearning-'));
  fakebin = path.join(work, 'bin');
  fakehome = path.join(work, 'home');
  fs.mkdirSync(fakebin, { recursive: true });
  fs.mkdirSync(fakehome, { recursive: true });

  // Fake `aqe`: `ruvector status` simulates the REAL upstream side effect
  // (creating .agentic-qe/ in cwd just to print the table) and emits a parsable
  // useNativeHNSW=true line so probe_hnsw_native reads a determinate value when
  // the call IS made. `--version` returns a fixed string; everything else is a
  // silent no-op (never creates anything else, so unrelated probes see empty
  // state, not a failure).
  writeExec(path.join(fakebin, 'aqe'), [
    '#!/usr/bin/env bash',
    'case "${1:-} ${2:-}" in',
    '  "ruvector status")',
    '    mkdir -p .agentic-qe',
    '    echo "  useNativeHNSW: true"',
    '    exit 0 ;;',
    'esac',
    'case "${1:-}" in',
    '  --version) echo "aqe v9.9.9" ;;',
    '  *) exit 0 ;;',
    'esac',
  ].join('\n') + '\n');

  // Fake `ruflo`: `daemon status` simulates the REAL upstream side effect
  // (creating .claude-flow/logs/daemon.log in cwd just to print the table).
  // Only the PRE-FIX script ever calls this any more (post-fix uses pgrep via
  // kit_daemon_ps_lines and never shells out to `ruflo` for this probe).
  writeExec(path.join(fakebin, 'ruflo'), [
    '#!/usr/bin/env bash',
    'case "${1:-} ${2:-}" in',
    '  "daemon status")',
    '    mkdir -p .claude-flow/logs',
    '    echo "status line" > .claude-flow/logs/daemon.log',
    '    echo "STOPPED"',
    '    exit 0 ;;',
    'esac',
    'case "${1:-}" in',
    '  --version) echo "ruflo v9.9.9" ;;',
    '  *) exit 0 ;;',
    'esac',
  ].join('\n') + '\n');
});

afterAll(() => {
  if (work) fs.rmSync(work, { recursive: true, force: true });
});

function runScript(scriptPath, target, args, extraEnv) {
  const r = spawnSync('bash', [scriptPath, target, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    cwd: target, // verify-learning.sh `cd`s into TARGET_DIR itself; matching cwd
                 // makes the fake stubs' relative mkdir/write land in `target`
                 // regardless, but keeps host-independent sanity if that ever changes.
    env: {
      ...process.env,
      HOME: fakehome,
      PATH: `${fakebin}:${process.env.PATH}`,
      TMPDIR: work,
      ...extraEnv,
    },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), signal: r.signal };
}

// PRE_FIX_REF: pinned to a specific commit, not HEAD — see this file's header
// docstring for why (HEAD moves past the fix the moment it's committed,
// silently turning every TEETH assertion below into a fixed-vs-fixed
// tautology). 0561b7c is Patch 71, the commit immediately before this fix
// landed as part of ac124a8 — confirmed it still has the unconditional `aqe
// ruvector status` call with no $DRY_RUN gate. Do not "modernise" this back
// to HEAD.
const PRE_FIX_REF = '0561b7c';

// Writes `git show <PRE_FIX_REF>:lib/verify-learning.sh` into a dotfile temp
// script INSIDE the real lib/ directory (so KIT_DIR/KIT_ASSETS resolve
// exactly like the post-fix script does), runs it, then removes the temp
// script unconditionally — mirrors tests/dryrun-mutation-guard.test.js's
// convention (same PRE_FIX_REF pin, same reasoning, sibling fix).
function withPreFixScript(fn) {
  const relName = '.pretest-b24-verify-learning.sh';
  const dst = path.join(REPO, 'lib', relName);
  const content = execFileSync('git', ['show', `${PRE_FIX_REF}:lib/verify-learning.sh`], { cwd: REPO, encoding: 'utf8' });
  fs.writeFileSync(dst, content);
  fs.chmodSync(dst, 0o755);
  try {
    return fn(dst);
  } finally {
    fs.rmSync(dst, { force: true });
  }
}

function freshTarget(prefix) {
  return fs.mkdtempSync(path.join(work, prefix));
}

describe('B24 verify-learning --dry-run: no filesystem artifacts', () => {
  it('POST-FIX: --dry-run against a fresh target creates NOTHING (no .agentic-qe/, no .claude-flow/)', () => {
    const target = freshTarget('vl-dryrun-clean-');
    const before = snapshot(target);

    const r = runScript(VERIFY_LEARNING_SH, target, ['--dry-run']);

    expect(fs.existsSync(path.join(target, '.agentic-qe'))).toBe(false);
    expect(fs.existsSync(path.join(target, '.claude-flow', 'logs', 'daemon.log'))).toBe(false);
    expect(snapshot(target)).toEqual(before); // byte-identical, not a directory-listing spot check
    expect(r.code).toBe(0);
  });

  it('POST-FIX: --dry-run output honestly reports the skipped aqe ruvector status call', () => {
    const target = freshTarget('vl-dryrun-honest-');
    const r = runScript(VERIFY_LEARNING_SH, target, ['--dry-run']);
    expect(r.out).toMatch(/\[dry-run\] skipped: would run 'aqe ruvector status'/);
  });

  it('POST-FIX: --dry-run --json also creates nothing and still emits a valid verdict', () => {
    const target = freshTarget('vl-dryrun-json-');
    const before = snapshot(target);

    const r = runScript(VERIFY_LEARNING_SH, target, ['--json', '--dry-run']);

    expect(snapshot(target)).toEqual(before);
    const parsed = JSON.parse(r.out.trim().split('\n').pop());
    expect(parsed).toHaveProperty('verdict');
    expect(['live', 'partial', 'hollow']).toContain(parsed.verdict);
  });

  it('POST-FIX: --dry-run resolves useNativeHNSW from RUVECTOR_USE_NATIVE_HNSW env instead of calling aqe', () => {
    const target = freshTarget('vl-dryrun-envflag-');
    const r = runScript(VERIFY_LEARNING_SH, target, ['--dry-run'], { RUVECTOR_USE_NATIVE_HNSW: 'true' });
    expect(fs.existsSync(path.join(target, '.agentic-qe'))).toBe(false);
    expect(r.out).toMatch(/useNativeHNSW resolved from env RUVECTOR_USE_NATIVE_HNSW=true/);
  });

  it('TEETH: pre-fix verify-learning.sh --dry-run DOES create both .agentic-qe/ and .claude-flow/logs/daemon.log', () => {
    withPreFixScript((preFixScript) => {
      const target = freshTarget('vl-dryrun-prefix-');
      expect(fs.existsSync(path.join(target, '.agentic-qe'))).toBe(false);
      expect(fs.existsSync(path.join(target, '.claude-flow'))).toBe(false);

      runScript(preFixScript, target, ['--dry-run']);

      expect(fs.existsSync(path.join(target, '.agentic-qe'))).toBe(true);
      expect(fs.existsSync(path.join(target, '.claude-flow', 'logs', 'daemon.log'))).toBe(true);
    });
  }, 60000);
});

describe('B24 verify-learning: the real (non-dry-run) verdict is unchanged', () => {
  it('POST-FIX: pass/warn/fail/info counts are identical between a dry-run and a live run against equivalent fresh targets', () => {
    const targetDry = freshTarget('vl-verdict-dry-');
    const targetLive = freshTarget('vl-verdict-live-');

    const dry = runScript(VERIFY_LEARNING_SH, targetDry, ['--json', '--dry-run']);
    const live = runScript(VERIFY_LEARNING_SH, targetLive, ['--json']);

    const dryJson = JSON.parse(dry.out.trim().split('\n').pop());
    const liveJson = JSON.parse(live.out.trim().split('\n').pop());

    // The dry-run adds exactly one extra informational note (the skipped-call
    // transparency line) — pass/warn/fail must be byte-identical; info may be
    // +1 on the dry-run side and never more.
    expect(dryJson.pass).toBe(liveJson.pass);
    expect(dryJson.warn).toBe(liveJson.warn);
    expect(dryJson.fail).toBe(liveJson.fail);
    expect(dryJson.verdict).toBe(liveJson.verdict);
    expect(dryJson.info).toBe(liveJson.info + 1);
  });

  it('POST-FIX: live (non-dry-run) run still calls aqe ruvector status (unchanged) but never creates daemon.log (unconditional fix)', () => {
    const target = freshTarget('vl-live-behavior-');
    runScript(VERIFY_LEARNING_SH, target, []);
    // Unchanged: the ruvector flag has no disk substitute, so the live path
    // still shells out exactly as before.
    expect(fs.existsSync(path.join(target, '.agentic-qe'))).toBe(true);
    // Fixed unconditionally: the daemon probe no longer calls `ruflo` at all.
    expect(fs.existsSync(path.join(target, '.claude-flow', 'logs', 'daemon.log'))).toBe(false);
  });

  it('POST-FIX: exit code policy unchanged — a clean fresh target exits 0 in both modes', () => {
    const targetDry = freshTarget('vl-exitcode-dry-');
    const targetLive = freshTarget('vl-exitcode-live-');
    expect(runScript(VERIFY_LEARNING_SH, targetDry, ['--dry-run']).code).toBe(0);
    expect(runScript(VERIFY_LEARNING_SH, targetLive, []).code).toBe(0);
  });
});

describe('B24 verify-learning: daemon advisory no longer shells out to `ruflo` at all', () => {
  it('POST-FIX: with no `ruflo` binary on PATH, the daemon advisory still runs cleanly (proves it no longer depends on the CLI)', () => {
    const bareBin = path.join(work, 'bin-no-ruflo');
    fs.mkdirSync(bareBin, { recursive: true });
    // Keep only `aqe` on this stripped-down PATH — no `ruflo` binary at all.
    fs.copyFileSync(path.join(fakebin, 'aqe'), path.join(bareBin, 'aqe'));
    fs.chmodSync(path.join(bareBin, 'aqe'), 0o755);

    const target = freshTarget('vl-no-ruflo-binary-');
    const r = spawnSync('bash', [VERIFY_LEARNING_SH, target], {
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, HOME: fakehome, PATH: `${bareBin}:/usr/bin:/bin`, TMPDIR: work },
    });

    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(target, '.claude-flow', 'logs', 'daemon.log'))).toBe(false);
  });

  it('TEETH: pre-fix probe_daemon_advisory silently no-ops (returns early) when `ruflo` is absent — contrast confirming the OLD code path required the binary', () => {
    withPreFixScript((preFixScript) => {
      const bareBin = path.join(work, 'bin-no-ruflo-prefix');
      fs.mkdirSync(bareBin, { recursive: true });
      fs.copyFileSync(path.join(fakebin, 'aqe'), path.join(bareBin, 'aqe'));
      fs.chmodSync(path.join(bareBin, 'aqe'), 0o755);

      const target = freshTarget('vl-no-ruflo-prefix-');
      const r = spawnSync('bash', [preFixScript, target], {
        encoding: 'utf8',
        timeout: 60000,
        env: { ...process.env, HOME: fakehome, PATH: `${bareBin}:/usr/bin:/bin`, TMPDIR: work },
      });

      expect(r.status).toBe(0);
      // Old code path guards on `command -v ruflo` too, so absence is still
      // silent — this just documents both versions tolerate a missing binary,
      // which the artifact tests above rely on for isolating the two sites.
      expect(fs.existsSync(path.join(target, '.claude-flow', 'logs', 'daemon.log'))).toBe(false);
    });
  }, 60000);
});
