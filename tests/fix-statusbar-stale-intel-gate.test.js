/**
 * Tests for the B8 fix: the RUFLO-INTEL cascade's stale sentinel gate in
 * lib/fix-statusbar.sh, plus the sibling sweep it prompted.
 *
 * Background (see docs/gauntlet-2026-07-31/MASTER-LEDGER.md, B8, and
 * kit-self-audit F4): step (f)'s outer gate used to read
 *
 *   grep -q "AQE310-REALIGN-V1" "$STATUSLINE_FILE" && ! grep -q "RUFLO-INTEL-V2" "$STATUSLINE_FILE"
 *
 * — a negative sentinel meant to make the block a one-time no-op once its own
 * output had landed. But assets/statusline.cjs (the canonical asset Step 1.0
 * installs verbatim) went on to absorb this step's whole job directly — a real
 * opts-based `_ra_intelligence(opts)`, the SONA render row, the DDD->Learning
 * relabel, `getSelfImprove()` and the 🔬 SI row — under "TRUTH-SL-V1" /
 * "RUFLO-INTEL-V3" naming, WITHOUT ever emitting the literal "RUFLO-INTEL-V2".
 * The negative half of the gate was therefore permanently true: the block
 * re-fired on every run, briefly regressing the file to an older
 * implementation before the pre-existing Step 1z reverted it back to
 * canonical — printing "healed statusline drift" even on a fully converged
 * target. A second, independent defect turned out to be the ACTUAL
 * persistent cause: an unconditional `sed` (no sentinel gate at all) that
 * rewrote canonical's deliberately-neutral `let ver = '0.0.0';` placeholder
 * to the live-detected ruflo version on every run — likewise superseded by
 * `getPkgVersion()`'s own live package.json detection, and likewise the
 * sole remaining source of every-run false "healed drift" once the
 * RUFLO-INTEL-V2 gate was removed (proven manually before this suite: see
 * the B8 report).
 *
 * This suite:
 *   1. proves real idempotency end-to-end (two spawned fix-statusbar runs
 *      against a throwaway fixture target — the actual deliverable);
 *   2. pins the removed patterns so they can't silently come back;
 *   3. asserts the sentinels the surviving sibling gates (_ra_dbkb,
 *      AGENTDB-SPLIT-V1) depend on actually exist in the canonical asset —
 *      so a future asset rename trips a test instead of silently
 *      re-breaking the idempotency this suite just proved;
 *   4. a falsification fixture (F4-style): reconstructs the exact broken gate
 *      shape and demonstrates it DOES misfire against a fixture standing in
 *      for "canonical evolved past the negated sentinel" — the failure mode
 *      this whole fix closes.
 */
'use strict';

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const KIT_CLI = path.join(REPO, 'bin', 'ruflo-kit');
const CANONICAL = path.join(REPO, 'assets', 'statusline.cjs');
const FIX_STATUSBAR = path.join(REPO, 'lib', 'fix-statusbar.sh');
const FIX_STATUSBAR_SRC = fs.readFileSync(FIX_STATUSBAR, 'utf8');
const CANONICAL_SRC = fs.readFileSync(CANONICAL, 'utf8');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function runFixStatusbar(targetDir) {
  return spawnSync('bash', [KIT_CLI, 'fix-statusbar', targetDir], {
    encoding: 'utf8',
    timeout: 60000,
  });
}

// ── 1. end-to-end idempotency proof ──────────────────────────────────────────

describe('fix-statusbar — B8 idempotency: converged run never claims to heal drift', () => {
  let target;

  beforeAll(() => {
    target = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-statusbar-idempotency-'));
  });

  afterAll(() => {
    if (target) fs.rmSync(target, { recursive: true, force: true });
  });

  it('first run installs canonical cleanly (exit 0)', () => {
    const r = runFixStatusbar(target);
    expect(r.status).toBe(0);
    const out = `${r.stdout}${r.stderr}`;
    // First run on a bare target legitimately INSTALLS (not "heals drift") —
    // that's Step 1.0's install branch, a different code path/message than
    // Step 1z's drift-heal branch this suite is guarding against.
    expect(out).not.toMatch(/healed statusline drift/i);
  }, 30000);

  it('second consecutive run on the now-converged target does NOT claim to heal drift', () => {
    const r = runFixStatusbar(target);
    expect(r.status).toBe(0);
    const out = `${r.stdout}${r.stderr}`;
    expect(out).not.toMatch(/healed statusline drift/i);
    // Nor should the removed cascade steps' fix messages ever reappear.
    expect(out).not.toMatch(/RUFLO-INTEL-V2/);
    expect(out).not.toMatch(/RUFLO-INTEL-V3/);
    expect(out).toMatch(/installed statusline sha256 matches canonical/);
  }, 30000);

  it('after two runs the installed statusline.cjs is byte-identical to the canonical asset', () => {
    const installed = path.join(target, '.claude', 'helpers', 'statusline.cjs');
    expect(fs.existsSync(installed)).toBe(true);
    expect(sha256(installed)).toBe(sha256(CANONICAL));
  });

  it('a third run stays idempotent too (not a fluke of run #2 specifically)', () => {
    const r = runFixStatusbar(target);
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/healed statusline drift/i);
  }, 30000);
});

// ── 2. regression guards — the removed patterns must never come back ───────

describe('fix-statusbar.sh — B8 removed patterns stay removed', () => {
  it('no longer contains the broken compound gate (AQE310-REALIGN-V1 present && RUFLO-INTEL-V2 absent)', () => {
    expect(FIX_STATUSBAR_SRC).not.toMatch(
      /grep -q "AQE310-REALIGN-V1"[^\n]*&&\s*!\s*grep -q "RUFLO-INTEL-V2"/
    );
  });

  it('no longer contains the dependent RUFLO-INTEL-V3 self-improvement injection gate', () => {
    expect(FIX_STATUSBAR_SRC).not.toMatch(
      /grep -q "RUFLO-INTEL-V2"[^\n]*&&\s*!\s*grep -q "function getSelfImprove"/
    );
  });

  it('no longer contains the unconditional (unsentineled) `let ver = ...` version-sed', () => {
    expect(FIX_STATUSBAR_SRC).not.toMatch(
      /_ra_sed "s\|let ver = '\[0-9\]/
    );
  });

  it('the script is still syntactically valid bash after the removals', () => {
    const r = spawnSync('bash', ['-n', FIX_STATUSBAR], { encoding: 'utf8' });
    expect(r.status).toBe(0);
  });
});

// ── 3. sibling-gate sentinel tripwires ───────────────────────────────────────
// The sweep found two OTHER gates in fix-statusbar.sh with the exact same
// shape (`AQE310-REALIGN-V1 present && <marker> absent`) that are currently
// correctly gated only because their negated marker still exists verbatim in
// the canonical asset. These assertions make a future canonical rename of
// either marker fail a test loudly instead of silently resurrecting B8's
// failure mode under a new name.

describe('assets/statusline.cjs — sentinels the surviving sibling gates depend on', () => {
  it('still carries "AQE310-REALIGN-V1" (the shared base marker all three gates check)', () => {
    expect(CANONICAL_SRC).toContain('AQE310-REALIGN-V1');
  });

  it('still carries "_ra_dbkb" (fix-statusbar.sh step (e) WAL-aware-size gate\'s negated marker)', () => {
    expect(CANONICAL_SRC).toContain('_ra_dbkb');
  });

  it('still carries "AGENTDB-SPLIT-V1" (fix-statusbar.sh step (g)\'s negated marker — the most direct B8 sibling: same file, same base marker, same shape)', () => {
    expect(CANONICAL_SRC).toContain('AGENTDB-SPLIT-V1');
  });

  it('the functionality B8\'s removed blocks used to inject now lives directly in canonical (proves the removal, not just the gate, was correct)', () => {
    expect(CANONICAL_SRC).toMatch(/function _ra_intelligence\(opts\)/);
    expect(CANONICAL_SRC).toMatch(/function getSelfImprove\(\)/);
    // The neutral fallback the (now-removed) version-sed used to fight with.
    expect(CANONICAL_SRC).toMatch(/let ver = '0\.0\.0';\s*\/\/ TRUTH-SL-V1: neutral fallback/);
  });
});

// ── 4. falsification fixture — proves the broken SHAPE actually misfires ────
// F4-style: reconstruct the exact gate condition fix-statusbar.sh used to run
// and show it evaluates to "would re-fire" against a fixture standing in for
// "canonical moved on to a new marker name" — i.e. the general failure mode,
// not just this one instance of it.

describe('falsification fixture — the B8 gate SHAPE, proven to misfire when the checked marker goes stale', () => {
  function evalGate(fileContents) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-gate-fixture-'));
    const file = path.join(dir, 'statusline.cjs');
    fs.writeFileSync(file, fileContents);
    try {
      // The exact shape B8 removed: base-marker-present && negated-versioned-marker-absent.
      const r = spawnSync('bash', ['-c',
        `grep -q "AQE310-REALIGN-V1" "$1" && ! grep -q "RUFLO-INTEL-V2" "$1"`,
        'sh', file,
      ]);
      return r.status === 0; // 0 == gate TRUE == "would re-fire"
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('misfires (gate true) on a file that has moved on to V3 naming and never wrote the V2 literal — the real canonical shape', () => {
    const stale = 'AQE310-REALIGN-V1\nRUFLO-INTEL-V3 self-improvement row\nfunction _ra_intelligence(opts) {}\n';
    expect(evalGate(stale)).toBe(true);
  });

  it('does not fire once the block has actually run and left its own marker behind (the ONLY case the gate was designed for)', () => {
    const patched = 'AQE310-REALIGN-V1\nRUFLO-INTEL-V2: SONA/neural learning ladder\n';
    expect(evalGate(patched)).toBe(false);
  });

  it('does not fire pre-realignment (base marker itself absent)', () => {
    expect(evalGate('nothing relevant here\n')).toBe(false);
  });
});
