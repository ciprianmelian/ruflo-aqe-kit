/**
 * Regression test for STATUSLINE-GUARD-RACE-V1 (kit self-audit finding F2):
 * a statusline-guard (STATUSLINE-GUARD-V1, Patch 68) tick firing mid-
 * `fix-statusbar` upgrade could silently revert the upgrade while every
 * step of fix-statusbar still reported green — because the pre-fix Step 2.5
 * declared the canonical snapshot "current" by comparing it against the
 * INSTALLED file, which the guard may have just reverted.
 *
 * Failure sequence this test reproduces the fix against:
 *   1. Step 1.0/1z install the NEW kit asset into .claude/helpers/statusline.cjs.
 *   2. A guard tick (running every ~5s in a live session, driven here by a
 *      hammer loop instead of a real clock) fires in the window before the
 *      snapshot is updated: it sees installed(NEW) != snapshot(OLD) and
 *      restores OLD over NEW.
 *   3. Step 2.5's `cmp installed vs snapshot` now reads OLD == OLD →
 *      "canonical snapshot current" → the loss is never recorded.
 *
 * The fix (lib/fix-statusbar.sh Step 0.9 + Step 2.5) pre-syncs the snapshot
 * from the kit asset BEFORE the installed file is ever overwritten with new
 * content, and makes Step 2.5 verify the snapshot against the kit asset
 * (ground truth) instead of the installed file. This suite builds a
 * throwaway "kit clone" (the real lib/common.sh, lib/fix-statusbar.sh,
 * assets/statusline-guard.cjs, plus a fake NEW assets/statusline.cjs
 * standing in for an upgraded kit asset) and a throwaway "target" pre-seeded
 * as if a prior fix-statusbar run had already installed OLD content and
 * wired the guard — then runs the real script while a concurrent loop fires
 * the real guard script every ~15ms for the ENTIRE run, so every possible
 * interleaving window gets hit many times over rather than guessed at.
 *
 * A one-time sanity check that this harness has teeth (not re-run as part of
 * the suite, since `git show HEAD:` against a moving history is exactly the
 * kind of check that silently stops meaning what it says a few commits
 * later): the identical harness run against the pre-fix lib/fix-statusbar.sh
 * reproducibly loses the upgrade — installed content reverts to OLD and
 * Step 2.5 prints "canonical snapshot current" while lying about it. See the
 * PR/commit description for the captured transcript.
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const REAL_COMMON = path.join(REPO, 'lib', 'common.sh');
const REAL_FIXSB = path.join(REPO, 'lib', 'fix-statusbar.sh');
const REAL_GUARD_ASSET = path.join(REPO, 'assets', 'statusline-guard.cjs');

const OLD_CONTENT = '#!/usr/bin/env node\n// RACE-TEST-MARKER: OLD-CONTENT-V1\nconsole.log("old-statusline");\n';
const NEW_CONTENT = '#!/usr/bin/env node\n// RACE-TEST-MARKER: NEW-CONTENT-V2\nconsole.log("new-statusline");\n';

// Builds a throwaway kit-clone + target pair. The target starts in the
// realistic "prior fix-statusbar already ran" state: OLD installed, OLD
// snapshot, guard already wired — exactly what an upgrade run walks into.
function mkFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-race-'));
  const kitLib = path.join(base, 'kit', 'lib');
  const kitAssets = path.join(base, 'kit', 'assets');
  const helpers = path.join(base, 'target', '.claude', 'helpers');
  fs.mkdirSync(kitLib, { recursive: true });
  fs.mkdirSync(kitAssets, { recursive: true });
  fs.mkdirSync(helpers, { recursive: true });

  fs.copyFileSync(REAL_COMMON, path.join(kitLib, 'common.sh'));
  fs.copyFileSync(REAL_FIXSB, path.join(kitLib, 'fix-statusbar.sh'));
  fs.copyFileSync(REAL_GUARD_ASSET, path.join(kitAssets, 'statusline-guard.cjs'));
  fs.writeFileSync(path.join(kitAssets, 'statusline.cjs'), NEW_CONTENT);

  fs.writeFileSync(path.join(helpers, 'statusline.cjs'), OLD_CONTENT);
  fs.writeFileSync(path.join(helpers, '.statusline.canonical.cjs'), OLD_CONTENT);
  fs.copyFileSync(REAL_GUARD_ASSET, path.join(helpers, 'statusline-guard.cjs'));

  return {
    base,
    targetDir: path.join(base, 'target'),
    fixsbPath: path.join(kitLib, 'fix-statusbar.sh'),
    guardPath: path.join(helpers, 'statusline-guard.cjs'),
    installedPath: path.join(helpers, 'statusline.cjs'),
    snapPath: path.join(helpers, '.statusline.canonical.cjs'),
  };
}

// Runs fix-statusbar.sh against the target while hammering the REAL guard
// script every `intervalMs` for the entire duration of the run. No timing
// guesswork: the tick fires continuously, so it lands inside every
// interleaving window (before/during/after the install) many times over
// rather than requiring a precisely-timed single shot.
function runUpgradeWithGuardHammer(fixture, { intervalMs = 15, hardTimeoutMs = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [fixture.fixsbPath, fixture.targetDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      spawnSync('node', [fixture.guardPath], { timeout: 5000 });
    }, intervalMs);

    const hardTimeout = setTimeout(() => {
      clearInterval(timer);
      child.kill('SIGKILL');
      reject(new Error('fix-statusbar.sh did not exit within hardTimeoutMs — hung?'));
    }, hardTimeoutMs);

    child.on('error', (err) => {
      clearInterval(timer);
      clearTimeout(hardTimeout);
      reject(err);
    });
    child.on('exit', (code) => {
      clearInterval(timer);
      clearTimeout(hardTimeout);
      resolve({ code, stdout, stderr, ticks });
    });
  });
}

describe('fix-statusbar vs statusline-guard: upgrade race (STATUSLINE-GUARD-RACE-V1)', () => {
  const fixtureDirs = [];
  afterEach(() => {
    while (fixtureDirs.length) {
      try { fs.rmSync(fixtureDirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('a guard tick firing anywhere during the upgrade heals forward, never reverts it', async () => {
    // Repeated trials: each run hammers the guard continuously across the
    // whole script duration, so a single trial already exercises many
    // interleavings; repeating catches any residual timing-dependent gap.
    const TRIALS = 5;
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const fx = mkFixture();
      fixtureDirs.push(fx.base);

      const result = await runUpgradeWithGuardHammer(fx);

      expect(result.code).toBe(0);
      // Confirms the hammer actually raced the script rather than running
      // entirely before or after it (a silent no-op race proves nothing).
      expect(result.ticks).toBeGreaterThan(0);

      const installed = fs.readFileSync(fx.installedPath, 'utf8');
      const snapshot = fs.readFileSync(fx.snapPath, 'utf8');
      expect(installed).toBe(NEW_CONTENT);
      expect(snapshot).toBe(NEW_CONTENT);
    }
  }, 90000);

  test('Step 2.5 verifies the snapshot against the kit asset (ground truth), not the installed file', () => {
    const src = fs.readFileSync(REAL_FIXSB, 'utf8');
    const step25Idx = src.indexOf('Step 2.5: Self-healing guard');
    expect(step25Idx).toBeGreaterThan(-1);
    const step25 = src.slice(step25Idx);

    const groundTruthIdx = step25.indexOf('if [[ -f "$CANON_SL" ]]');
    const groundTruthCmpIdx = step25.indexOf('cmp -s "$CANON_SL" "$CANON_SNAP"');
    expect(groundTruthIdx).toBeGreaterThan(-1);
    expect(groundTruthCmpIdx).toBeGreaterThan(groundTruthIdx);

    // The old circular check (installed vs snapshot) may still exist as the
    // no-kit-asset fallback, but it must be reachable only AFTER the
    // ground-truth branch guard — never as the first/primary comparison.
    const circularIdx = step25.indexOf('cmp -s "$STATUSLINE_FILE" "$CANON_SNAP"');
    if (circularIdx !== -1) {
      expect(circularIdx).toBeGreaterThan(groundTruthIdx);
    }
  });

  test('the snapshot pre-sync (Step 0.9) runs before STATUSLINE_FILE is ever written with new content (Step 1.0)', () => {
    const src = fs.readFileSync(REAL_FIXSB, 'utf8');
    const preSyncIdx = src.indexOf('Step 0.9: snapshot-first ordering guard');
    const firstInstallIdx = src.indexOf(
      'cp "$CANON_SL" "$STATUSLINE_FILE" && node --check "$STATUSLINE_FILE"'
    );
    expect(preSyncIdx).toBeGreaterThan(-1);
    expect(firstInstallIdx).toBeGreaterThan(-1);
    expect(preSyncIdx).toBeLessThan(firstInstallIdx);
  });

  // Round 2 (kit self-audit F2 follow-up): every write to CANON_SNAP must go
  // through the atomic write-temp+rename helper, never a bare `cp`. A bare
  // `cp` gives a concurrent reader (the guard, on its own ~5s clock) no
  // guarantee it won't observe a partially-written file — the critic
  // demonstrated this with a torn snapshot that made the (unchanged) guard
  // corrupt a valid installed statusline and still exit 0. This is a cheap,
  // permanent tripwire against a future edit reintroducing a bare cp here.
  test('every CANON_SNAP write goes through the atomic helper — no bare `cp ... "$CANON_SNAP"` remains', () => {
    const src = fs.readFileSync(REAL_FIXSB, 'utf8');

    expect(src).toMatch(/kit_snapshot_atomic_write\(\)\s*\{/);

    // Same-directory temp file + rename is what makes the write atomic —
    // mktemp in the destination's own directory, then `mv`.
    const helperIdx = src.indexOf('kit_snapshot_atomic_write() {');
    expect(helperIdx).toBeGreaterThan(-1);
    const helperBody = src.slice(helperIdx, src.indexOf('\n}', helperIdx));
    expect(helperBody).toMatch(/mktemp "\$\(dirname "\$dst"\)/);
    expect(helperBody).toMatch(/mv -f "\$tmp" "\$dst"/);

    // No remaining direct `cp <src> "$CANON_SNAP"` anywhere in the file —
    // every write site must call the helper instead.
    const bareCopyToSnapshot = /cp\s+"\$[A-Z_]+"\s+"\$CANON_SNAP"/g;
    expect(src.match(bareCopyToSnapshot)).toBeNull();

    // The helper must actually be called at every known snapshot-write site
    // (Step 0.9 pre-sync, Step 2.5 ground-truth re-sync, Step 2.5 fallback).
    const callSites = src.match(/kit_snapshot_atomic_write "\$[A-Z_]+" "\$CANON_SNAP"/g) || [];
    expect(callSites.length).toBeGreaterThanOrEqual(3);
  });
});
