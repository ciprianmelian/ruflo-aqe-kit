#!/usr/bin/env node
/*
 * STATUSLINE-GUARD-V1 (Patch 68) — self-healing statusline.
 *
 * Upstream session machinery rewrites .claude/helpers/statusline.cjs with its
 * stock free-running-counter bar (observed twice on a fresh target, both times
 * minutes AFTER session start via a delayed detached child — so a session-start
 * assert loses the race by design). This guard wins by placement instead of
 * timing: fix-statusbar wires it as the FIRST step of the settings statusLine
 * command, so it runs on every refresh tick (~5s). A clobber can therefore
 * never survive a single render cycle.
 *
 * Mechanism: byte-compare statusline.cjs against the pristine snapshot
 * .statusline.canonical.cjs (a dotfile — upstream installers write named
 * assets, they don't own this). On drift: restore the snapshot and append one
 * evidence line to .claude-flow/statusline-guard.log (recurrences stay
 * countable instead of anecdotal). Missing snapshot => no-op. ALWAYS exit 0 —
 * a guard must never take the statusline down with it.
 *
 * STATUSLINE-GUARD-RACE-V1 (kit self-audit F2, round 2): fix-statusbar.sh
 * writes the snapshot with a same-directory write-temp+rename (atomic), but
 * this guard runs on its own ~5s clock and has no way to know whether a
 * concurrent writer is mid-rename — an external tool, a filesystem without
 * atomic rename semantics, or plain disk corruption could still leave a
 * torn/truncated snapshot on disk. Since this guard is the last line of
 * defense before that content becomes the live, rendered statusline.cjs, it
 * validates the snapshot BEFORE ever copying it. Restoring garbage over a
 * working statusline would violate this guard's one job ("never take the
 * statusline down with it") worse than not restoring at all.
 *
 * STATUSLINE-GUARD-RACE-V1 round 4: rounds 2-3 established non-empty + syntax
 * + anchors + a size floor, but two holes remained, both demonstrated:
 *   - anchors were a plain substring match, so a candidate carrying them only
 *     INSIDE COMMENTS (`// function generateStatusline -- placeholder`) still
 *     passed — a 139-byte cosmetic fake was accepted over a real installed
 *     file. Fix: anchors must now appear on an executable (non-comment) line
 *     in the CANDIDATE itself, not merely present somewhere in its text.
 *   - the size floor was relative to the CURRENTLY-INSTALLED file — but the
 *     installed file is smallest exactly when it's the thing being healed
 *     (a ~55-byte upstream stock-stub clobber, Patch 68's whole reason for
 *     existing), making the floor trivially clearable (~27 bytes). Fix: never
 *     use the installed file as the size reference. Prefer the sidecar's
 *     resolved kit-asset file's actual size (independent of whether its sha
 *     matches — a resolvable-but-stale kit asset still tells you the right
 *     ballpark); otherwise fall back to a conservative absolute floor.
 *   - a truncation landing in the tail ~3% of the file could carry both
 *     anchors (function defined, header string built) yet never actually
 *     INVOKE the render function — the file's only call site lives in its
 *     final dispatch block. Fix: a third required anchor drawn from that
 *     literal invocation, so any truncation before it is caught structurally
 *     regardless of where it falls relative to a brace-balance coincidence.
 *   - when the sidecar resolved but the candidate's sha didn't match it, the
 *     guard silently fell back to heuristics with a log line indistinguishable
 *     from "no sidecar was ever present" — an operator couldn't tell "ground
 *     truth was available and this candidate failed it" from "we never had
 *     ground truth to check." Fix: log that distinction explicitly.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Load-bearing strings only a COMPLETE statusline.cjs contains, in the order
// they appear in the real file: the render function's own definition, the
// literal header it builds, and — round 4 — the actual call site that
// invokes it. All three sit inside executable code (never comments) in
// assets/statusline.cjs, so removing any of them requires a deliberate
// rewrite of the render/dispatch path, not incidental churn. Regression-
// tested: the "REQUIRED_ANCHORS regression guard" describe block in
// tests/statusline-guard.test.js extracts this exact array from this file's
// own source and asserts every entry is present in assets/statusline.cjs, so
// if a future edit ever drops one, that test fails loudly instead of the
// guard silently refusing every restore in the field (the F4 sentinel-decay
// trap this kit keeps re-discovering).
const REQUIRED_ANCHORS = [
  'function generateStatusline',       // the render function's declaration
  '▊ RuFlo',                           // the literal header string it builds
  'console.log(generateStatusline())', // round 4: the actual invocation — without
                                        // this, a candidate can define the function
                                        // and never call it, rendering silently blank
];

// Minimum fraction of the SIZE REFERENCE a restore candidate must reach.
// Round 4: the reference is never the currently-installed file (see below —
// that file is smallest exactly when it's the stock-stub clobber this guard
// exists to heal, making any floor relative to it trivially clearable).
const MIN_SIZE_FRACTION = 0.5;

// Conservative absolute floor, used only when no sidecar-resolved kit-asset
// size is available to serve as the reference. Chosen well below the real
// canonical asset's size (tens of KB) but well above what a purely-cosmetic
// forgery would bother padding to — and the anchor checks below already
// require all three anchors to sit on real executable lines, so clearing
// this floor on top of that requires writing a non-trivial amount of
// actually-working code, not concatenating three short substrings.
const ABSOLUTE_MIN_SIZE_BYTES = 2000;

// True if `anchor` appears as a substring of some line in `src` whose
// trimmed text does not start with a `//` comment marker — i.e. the anchor
// sits on a line that could plausibly execute, not one that's commented out.
// Deliberately the same simple heuristic the anchor-presence regression test
// applies to the pristine asset; round 4 additionally applies it here, to
// the CANDIDATE being validated, which is the check that was missing.
function anchorOnExecutableLine(src, anchor) {
  return src.split('\n').some((line) => line.includes(anchor) && !line.trim().startsWith('//'));
}

// Full heuristic validation: non-empty, parses, carries all required anchors
// on executable (non-comment) lines, and clears the size floor computed by
// the caller. Returns { ok, reason } — reason is only meaningful when ok is
// false, and is written straight into the guard log so a refusal is
// diagnosable on sight.
function validateHeuristically(src, floorBytes, floorReason) {
  if (!src || src.length === 0) return { ok: false, reason: 'empty' };
  try {
    // eslint-disable-next-line no-new
    new vm.Script(src, { filename: 'statusline-snapshot-check.cjs' });
  } catch (e) {
    return { ok: false, reason: 'invalid JS (' + e.message + ')' };
  }
  for (const anchor of REQUIRED_ANCHORS) {
    if (!anchorOnExecutableLine(src, anchor)) {
      return { ok: false, reason: 'missing required anchor on an executable line: ' + JSON.stringify(anchor) };
    }
  }
  if (typeof floorBytes === 'number' && floorBytes > 0 && src.length < floorBytes) {
    return { ok: false, reason: 'candidate is ' + src.length + 'B, below ' + floorReason };
  }
  return { ok: true };
}

// Resolves the sidecar fix-statusbar.sh writes next to CANON_SNAP —
// { kitAssetPath, sha256 } recorded at snapshot-write time — into the LIVE
// kit-asset file's current path/size/sha256, WITHOUT regard to whether that
// live content still matches what was recorded (a resolvable-but-since-
// upgraded kit asset still tells you the right size ballpark; that check is
// the caller's job, using this info independent of match/mismatch). Returns
// null on any failure (missing sidecar, bad JSON, moved/deleted kit asset) —
// "can't opportunistically reference," not a refusal signal.
function resolveSidecarKitAsset(sidecarPath) {
  try {
    if (!fs.existsSync(sidecarPath)) return null;
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    if (!sidecar || typeof sidecar.kitAssetPath !== 'string' || typeof sidecar.sha256 !== 'string') return null;
    if (!fs.existsSync(sidecar.kitAssetPath)) return null;
    const buf = fs.readFileSync(sidecar.kitAssetPath);
    return { path: sidecar.kitAssetPath, size: buf.length, sha: sha256(buf) };
  } catch (e) {
    return null;
  }
}

try {
  const dir = __dirname; // <project>/.claude/helpers
  const installed = path.join(dir, 'statusline.cjs');
  const canonical = path.join(dir, '.statusline.canonical.cjs');
  const sidecar = canonical + '.source';
  if (fs.existsSync(canonical)) {
    const shaOf = (f) => sha256(fs.readFileSync(f));
    const want = shaOf(canonical); // candidate's own sha — reused below as ground truth's "candidate sha"
    const have = fs.existsSync(installed) ? shaOf(installed) : '(missing)';
    if (have !== want) {
      const logDir = path.resolve(dir, '..', '..', '.claude-flow');
      const logLine = (msg) => {
        try {
          fs.mkdirSync(logDir, { recursive: true });
          fs.appendFileSync(path.join(logDir, 'statusline-guard.log'), new Date().toISOString() + ' ' + msg + '\n');
        } catch (e) { /* logging is best-effort */ }
      };

      const kitAsset = resolveSidecarKitAsset(sidecar);
      let verdict;
      let groundTruthNote = '';

      if (kitAsset && kitAsset.sha === want) {
        // Byte-identical to a real, currently-existing kit asset. Strictly
        // stronger than any heuristic — skip them entirely.
        verdict = { ok: true, groundTruth: true };
      } else if (kitAsset) {
        // Round 4 fix #4: ground truth WAS available via the sidecar, but the
        // candidate didn't match it (could be a stale-but-legitimate snapshot
        // from before a kit upgrade, OR the exact corruption this guard
        // exists to catch — the heuristic below is what tells them apart).
        // Log this distinctly from "no sidecar at all" either way.
        groundTruthNote = ' [ground truth available via sidecar — kit asset ' + kitAsset.path +
          ' sha ' + kitAsset.sha.slice(0, 12) + ' != candidate sha ' + want.slice(0, 12) + ' — falling back to heuristic]';
        // Round 4 fix #2: use the resolved kit asset's ACTUAL size as the
        // floor reference — never the installed file, which is smallest
        // exactly when it's the stub this guard is healing.
        const floorBytes = kitAsset.size * MIN_SIZE_FRACTION;
        const floorReason = Math.round(MIN_SIZE_FRACTION * 100) + '% of the kit asset\'s ' + kitAsset.size + 'B (' + kitAsset.path + ')';
        verdict = validateHeuristically(fs.readFileSync(canonical, 'utf8'), floorBytes, floorReason);
      } else {
        // No resolvable kit-asset reference at all — fall back to the
        // conservative absolute floor (still never the installed file).
        const floorReason = ABSOLUTE_MIN_SIZE_BYTES + 'B absolute floor (no resolvable kit-asset reference)';
        verdict = validateHeuristically(fs.readFileSync(canonical, 'utf8'), ABSOLUTE_MIN_SIZE_BYTES, floorReason);
      }

      if (!verdict.ok) {
        logLine(
          'REFUSED restore: canonical snapshot failed validation (' + verdict.reason +
            ')' + groundTruthNote + ' — installed file left unchanged (have ' +
            have.slice(0, 12) + ', would-be-want ' + want.slice(0, 12) + ')'
        );
      } else {
        fs.copyFileSync(canonical, installed);
        logLine(
          'restored canonical statusline (found ' + have.slice(0, 12) + ', want ' + want.slice(0, 12) + ')' +
            (verdict.groundTruth ? ' [verified against live kit asset]' : groundTruthNote)
        );
      }
    }
  }
} catch (e) { /* never block a render */ }
process.exit(0);
