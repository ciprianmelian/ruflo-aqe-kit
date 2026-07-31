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

// Non-empty, parses as JS, and carries all required anchors on executable
// (non-comment) lines. Returns { ok, reason } — reason is only meaningful
// when ok is false. Deliberately factored out from validateHeuristically
// (round 3 / B10 round 3): a sha match against a resolved kit asset proves
// two files are IDENTICAL, never that either one is VALID — two identical
// corrupt files match perfectly, and the realistic path here is exactly
// that: fix-statusbar.sh writes the canonical snapshot FROM the kit asset,
// so a kit asset corrupted upstream propagates to both sides and matches
// trivially. Running these structural checks on the ground-truth path too
// (see below) turns "ground truth" into "verified identical AND
// structurally sane," not a full bypass of sanity checking.
function validateStructurally(src) {
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
  return { ok: true };
}

// Full heuristic validation: the structural checks above, plus the size
// floor computed by the caller. Returns { ok, reason } — reason is only
// meaningful when ok is false, and is written straight into the guard log
// so a refusal is diagnosable on sight.
function validateHeuristically(src, floorBytes, floorReason) {
  const structural = validateStructurally(src);
  if (!structural.ok) return structural;
  // B10 fix: this used to also require `floorBytes > 0`, on the assumption
  // that a falsy floorBytes meant "no floor was computed." That's wrong: a
  // sidecar-resolved kit asset that is itself zero-length computes a real,
  // deliberate floor of exactly 0 (see the call site below, which now
  // refuses outright rather than ever handing this function a 0), and a
  // `> 0` test can't tell that apart from "no floor argument was given at
  // all" (undefined/null, the actual "not configured" case). `typeof
  // floorBytes === 'number'` alone is the correct presence check — it
  // already excludes undefined/null, and a computed 0 is harmless here
  // regardless (src.length is always >= 1 by this point, so `src.length <
  // 0` can never fire; the enforcement for a broken zero-length reference
  // lives at the caller, which refuses before a nonsensical 0 floor is ever
  // built).
  if (typeof floorBytes === 'number' && src.length < floorBytes) {
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
    const wantSize = fs.statSync(canonical).size; // sibling of the B10 fix below: needed to tell "verified identical" from "identically empty"
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

      if (kitAsset && kitAsset.sha === want && wantSize > 0) {
        // Byte-identical to a real, currently-existing kit asset, and
        // non-empty by byte count. Round 3 (B10 round 3 critic): a sha
        // match proves the two files are IDENTICAL, never that either one
        // is VALID — two identical corrupt files match perfectly, and the
        // realistic path here is exactly that: fix-statusbar.sh writes the
        // canonical snapshot FROM the kit asset, so if the kit asset is
        // ever reduced to inert content upstream (or corrupted some other
        // way), both sides inherit it and match trivially (the critic's
        // repro: a canonical snapshot of a single "\n" and a kit asset of a
        // single "\n" — same sha, both size 1, `wantSize > 0` satisfied,
        // restored and logged as verified before this fix). Run the same
        // structural checks (parses as JS, carries the required anchors)
        // the heuristic path already requires — cheap, since this content
        // is already being read to compute `want`'s sha, and it only runs
        // when a mismatch was already detected (have !== want), never on
        // every tick. This makes "ground truth" mean "verified identical
        // AND structurally sane," not a full bypass of sanity checking.
        // Deliberately NOT re-applying the size floor here: a byte-identical
        // match to a live kit asset is already a stronger size signal than
        // any floor heuristic could be.
        const structural = validateStructurally(fs.readFileSync(canonical, 'utf8'));
        if (structural.ok) {
          verdict = { ok: true, groundTruth: true };
        } else {
          verdict = { ok: false, reason: 'byte-identical to kit asset ' + kitAsset.path + ' but ' + structural.reason };
        }
      } else if (kitAsset && kitAsset.sha === want) {
        // B10-sibling fix: kitAsset.sha === want is trivially satisfiable
        // with NEITHER side telling us anything — sha256("") is a fixed
        // value, so a zero-byte canonical snapshot and a zero-byte resolved
        // kit asset always match here. Without `wantSize > 0` above, that
        // would fall into the branch above and issue this guard's STRONGEST
        // positive verdict ("verified against live kit asset") for two
        // files that are both nothing, then copy the empty snapshot over
        // the installed statusline. Refuse and name the actual reason,
        // rather than falling through to the mismatch branch below (whose
        // groundTruthNote wording assumes the shas differ, which they don't
        // here).
        verdict = {
          ok: false,
          reason: 'canonical snapshot and resolved kit asset ' + kitAsset.path + ' are BOTH zero bytes — a sha match on empty content is not ground truth',
        };
      } else if (kitAsset) {
        // Round 4 fix #4: ground truth WAS available via the sidecar, but the
        // candidate didn't match it (could be a stale-but-legitimate snapshot
        // from before a kit upgrade, OR the exact corruption this guard
        // exists to catch — the heuristic below is what tells them apart).
        // Log this distinctly from "no sidecar at all" either way.
        groundTruthNote = ' [ground truth available via sidecar — kit asset ' + kitAsset.path +
          ' sha ' + kitAsset.sha.slice(0, 12) + ' != candidate sha ' + want.slice(0, 12) + ' — falling back to heuristic]';
        if (kitAsset.size === 0) {
          // B10 fix: a sidecar-resolvable but ZERO-LENGTH kit asset is not
          // "no size reference available" — it's evidence the kit asset
          // itself is broken. Computing floorBytes = 0 * MIN_SIZE_FRACTION
          // and handing it to validateHeuristically would (pre-fix) admit a
          // candidate of ANY size, since a 0 floor never rejects anything.
          // Refuse outright instead of falling back further: a zero-byte
          // reference can't tell us "no floor is required" (that's the
          // no-kitAsset branch below, still gated by the absolute floor) —
          // it tells us the reference itself is unusable, which is a
          // stronger reason to distrust the heuristic path, not a reason to
          // skip it.
          verdict = {
            ok: false,
            reason: 'kit asset ' + kitAsset.path + ' resolved to 0 bytes — refusing to use a zero-length reference as a size floor',
          };
        } else {
          // Round 4 fix #2: use the resolved kit asset's ACTUAL size as the
          // floor reference — never the installed file, which is smallest
          // exactly when it's the stub this guard is healing.
          const floorBytes = kitAsset.size * MIN_SIZE_FRACTION;
          const floorReason = Math.round(MIN_SIZE_FRACTION * 100) + '% of the kit asset\'s ' + kitAsset.size + 'B (' + kitAsset.path + ')';
          verdict = validateHeuristically(fs.readFileSync(canonical, 'utf8'), floorBytes, floorReason);
        }
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
