/**
 * Tests for assets/statusline-guard.cjs (STATUSLINE-GUARD-V1, Patch 68) — the
 * self-healing statusline restorer that runs as the first step of the settings
 * statusLine command on every refresh tick.
 *
 * Defect class: upstream session machinery rewrites .claude/helpers/
 * statusline.cjs with its stock free-running-counter bar via a DELAYED
 * detached child (observed twice on a fresh target, ~2-15 min after session
 * start) — so a session-start assert loses the race, but a per-tick guard
 * cannot: no clobber survives a single render cycle.
 *
 * Contract pinned here: restore bit-identical from the pristine dotfile
 * snapshot; append one evidence line per restore; never create files when
 * nothing drifted; no-op without a snapshot; ALWAYS exit 0.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const GUARD_ASSET = path.join(REPO, 'assets', 'statusline-guard.cjs');
const CANONICAL_ASSET = path.join(REPO, 'assets', 'statusline.cjs');
const FIXSB = path.join(REPO, 'lib', 'fix-statusbar.sh');

// Round 3: a legitimate canonical now must carry both anchors present at the
// time (see the anchor-presence regression test below), so the fixture's
// stand-in "valid canonical" content is updated to actually be one — a real
// function named generateStatusline whose body contains the literal header
// string, and (round 4) an actual call site invoking it. This is not a
// weaker test double: it's the same synthetic-but-valid role CANON_CONTENT
// always played, updated so it still qualifies as valid under the stronger
// gate (round 1/2 tests exercise the restore MECHANISM, not anchor content,
// so they still assert exactly what they always asserted).
//
// Round 4: the size floor no longer references the installed file (see
// PADDING below) — when no sidecar is present it falls back to a
// conservative absolute floor (ABSOLUTE_MIN_SIZE_BYTES = 2000 in
// assets/statusline-guard.cjs). CANON_CONTENT is a synthetic stand-in, not a
// real statusline, so it needs inert bulk to legitimately clear that floor
// rather than real logic — the padding is clearly labeled as such.
const PADDING = '// padding line to satisfy the round-4 absolute size floor (see ABSOLUTE_MIN_SIZE_BYTES in assets/statusline-guard.cjs)\n'.repeat(20);
const CANON_CONTENT = '#!/usr/bin/env node\n' + PADDING + 'function generateStatusline() { return "▊ RuFlo test canonical"; }\nconsole.log(generateStatusline());\n';
const CLOBBER_CONTENT = '#!/usr/bin/env node\nconsole.log("upstream stock bar");\n';

function mkFixture({ canonical = true, installed = CANON_CONTENT, canonicalContent = CANON_CONTENT } = {}) {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'slguard-'));
  const helpers = path.join(proj, '.claude', 'helpers');
  fs.mkdirSync(helpers, { recursive: true });
  fs.copyFileSync(GUARD_ASSET, path.join(helpers, 'statusline-guard.cjs'));
  if (canonical) fs.writeFileSync(path.join(helpers, '.statusline.canonical.cjs'), canonicalContent);
  if (installed !== null) fs.writeFileSync(path.join(helpers, 'statusline.cjs'), installed);
  return { proj, helpers };
}
function runGuard(helpers) {
  return spawnSync('node', [path.join(helpers, 'statusline-guard.cjs')], { encoding: 'utf8', timeout: 10000 });
}
const readInstalled = (h) => fs.readFileSync(path.join(h, 'statusline.cjs'), 'utf8');
const logPath = (proj) => path.join(proj, '.claude-flow', 'statusline-guard.log');

describe('statusline-guard.cjs (STATUSLINE-GUARD-V1)', () => {
  test('no drift => zero writes (mtime preserved), no log, exit 0', () => {
    const { proj, helpers } = mkFixture();
    const before = fs.statSync(path.join(helpers, 'statusline.cjs')).mtimeMs;
    const r = runGuard(helpers);
    expect(r.status).toBe(0);
    expect(fs.statSync(path.join(helpers, 'statusline.cjs')).mtimeMs).toBe(before);
    expect(fs.existsSync(logPath(proj))).toBe(false);
  });

  test('clobbered => restored bit-identical + one evidence log line', () => {
    const { proj, helpers } = mkFixture({ installed: CLOBBER_CONTENT });
    const r = runGuard(helpers);
    expect(r.status).toBe(0);
    expect(readInstalled(helpers)).toBe(CANON_CONTENT);
    const log = fs.readFileSync(logPath(proj), 'utf8');
    expect(log.trim().split('\n')).toHaveLength(1);
    expect(log).toMatch(/restored canonical statusline/);
  });

  test('statusline.cjs deleted => recreated from snapshot, logged as missing', () => {
    const { proj, helpers } = mkFixture({ installed: null });
    expect(runGuard(helpers).status).toBe(0);
    expect(readInstalled(helpers)).toBe(CANON_CONTENT);
    expect(fs.readFileSync(logPath(proj), 'utf8')).toMatch(/\(missing\)/);
  });

  test('no canonical snapshot => strict no-op, exit 0', () => {
    const { proj, helpers } = mkFixture({ canonical: false, installed: CLOBBER_CONTENT });
    expect(runGuard(helpers).status).toBe(0);
    expect(readInstalled(helpers)).toBe(CLOBBER_CONTENT); // untouched — nothing to restore FROM
    expect(fs.existsSync(logPath(proj))).toBe(false);
  });

  test('repeated clobbers each get healed and each get a log line', () => {
    const { proj, helpers } = mkFixture({ installed: CLOBBER_CONTENT });
    runGuard(helpers);
    fs.writeFileSync(path.join(helpers, 'statusline.cjs'), CLOBBER_CONTENT); // clobber again
    runGuard(helpers);
    expect(readInstalled(helpers)).toBe(CANON_CONTENT);
    expect(fs.readFileSync(logPath(proj), 'utf8').trim().split('\n')).toHaveLength(2);
  });
});

describe('statusline-guard.cjs validates before restoring (STATUSLINE-GUARD-RACE-V1, round 2)', () => {
  // Round-2 critic repro: a torn/truncated write to .statusline.canonical.cjs
  // (e.g. a guard tick observing a concurrent writer mid-copy, or plain disk
  // corruption) used to get copied straight into the live, rendered
  // statusline.cjs with zero validation — corrupting a previously-working
  // installed file and still exiting 0. This describes the fix: the guard
  // must refuse to restore from an invalid snapshot, leaving the installed
  // file exactly as it was, and say so in the log.
  const TORN_CANON = '#!/usr/bin/env node\nfunction broken( {\n'; // same failure shape as a real torn write: "Unexpected end of input"

  test('torn/truncated snapshot + valid installed => guard REFUSES, installed left unchanged, refusal logged', () => {
    const { proj, helpers } = mkFixture({ canonicalContent: TORN_CANON, installed: CANON_CONTENT });
    const before = readInstalled(helpers);
    const r = runGuard(helpers);
    expect(r.status).toBe(0);
    expect(readInstalled(helpers)).toBe(before); // untouched — refused, not corrupted
    const log = fs.readFileSync(logPath(proj), 'utf8');
    expect(log.trim().split('\n')).toHaveLength(1);
    expect(log).toMatch(/REFUSED restore/);
  });

  test('empty snapshot => guard REFUSES (non-empty sanity check), installed unchanged', () => {
    const { proj, helpers } = mkFixture({ canonicalContent: '', installed: CANON_CONTENT });
    const before = readInstalled(helpers);
    const r = runGuard(helpers);
    expect(r.status).toBe(0);
    expect(readInstalled(helpers)).toBe(before);
    expect(fs.readFileSync(logPath(proj), 'utf8')).toMatch(/REFUSED restore/);
  });

  test('installed file stays syntactically valid after a refused restore (node --check)', () => {
    const { helpers } = mkFixture({ canonicalContent: TORN_CANON, installed: CANON_CONTENT });
    runGuard(helpers);
    const check = spawnSync(process.execPath, ['--check', path.join(helpers, 'statusline.cjs')], { encoding: 'utf8' });
    expect(check.status).toBe(0);
  });

  test('a valid snapshot still restores normally — validation does not over-reject the happy path', () => {
    const { proj, helpers } = mkFixture({ installed: CLOBBER_CONTENT }); // default canonical = valid CANON_CONTENT
    const r = runGuard(helpers);
    expect(r.status).toBe(0);
    expect(readInstalled(helpers)).toBe(CANON_CONTENT);
    expect(fs.readFileSync(logPath(proj), 'utf8')).toMatch(/restored canonical statusline/);
  });
});

describe('statusline-guard.cjs — round 3: anchor + size-floor validation defeats "parses as JS"', () => {
  // Round-2's gate was "non-empty + parses as JS". The round-3 critic showed
  // that's too weak: ~14% of truncation offsets of the real 60,248-byte
  // assets/statusline.cjs still parse as valid JS while being functionally
  // empty (a torn write can land exactly on a statement boundary). This
  // describes the fix: required load-bearing anchors + a size floor relative
  // to what's currently installed, on top of the syntax check.

  test('the critic\'s exact byte-1250 truncation of the REAL canonical asset is REFUSED (still parses, missing anchors)', () => {
    const realAsset = fs.readFileSync(CANONICAL_ASSET, 'utf8');
    const truncated = realAsset.slice(0, 1250);
    // Sanity-check the premise: this offset really does still parse as JS —
    // if it didn't, this test would pass for the wrong reason (round-2's
    // syntax check alone, not the new anchor gate).
    expect(() => new (require('vm').Script)(truncated)).not.toThrow();
    expect(truncated).not.toContain('function generateStatusline');
    expect(truncated).not.toContain('▊ RuFlo');

    const { proj, helpers } = mkFixture({ canonicalContent: truncated, installed: CANON_CONTENT });
    const before = readInstalled(helpers);
    const r = runGuard(helpers);
    expect(r.status).toBe(0);
    expect(readInstalled(helpers)).toBe(before); // unchanged — refused, not corrupted
    const log = fs.readFileSync(logPath(proj), 'utf8');
    expect(log).toMatch(/REFUSED restore/);
    expect(log).toMatch(/missing required anchor/);
  });

  test('comment-only snapshot ("// just a comment") is REFUSED despite parsing cleanly', () => {
    const { proj, helpers } = mkFixture({ canonicalContent: '// just a comment\n', installed: CANON_CONTENT });
    const before = readInstalled(helpers);
    expect(runGuard(helpers).status).toBe(0);
    expect(readInstalled(helpers)).toBe(before);
    expect(fs.readFileSync(logPath(proj), 'utf8')).toMatch(/REFUSED restore.*missing required anchor/);
  });

  test('unrelated valid JS ("const x = 1; console.log(x);") is REFUSED despite parsing cleanly', () => {
    const { proj, helpers } = mkFixture({ canonicalContent: 'const x = 1; console.log(x);', installed: CANON_CONTENT });
    const before = readInstalled(helpers);
    expect(runGuard(helpers).status).toBe(0);
    expect(readInstalled(helpers)).toBe(before);
    expect(fs.readFileSync(logPath(proj), 'utf8')).toMatch(/REFUSED restore.*missing required anchor/);
  });

  test('a tiny anchor-bearing but dramatically undersized snapshot is REFUSED by the size floor (round 4: absolute floor, not installed-relative)', () => {
    // All three anchors present ON EXECUTABLE LINES, parses cleanly — this
    // candidate would pass every other check. Round 4: with no sidecar
    // present, the size reference is the conservative ABSOLUTE floor (never
    // the installed file, which the round-4 critic showed is smallest
    // exactly when it's the stub being healed) — isolates the size-floor
    // check from everything else.
    const tinyButAnchored = 'function generateStatusline() { return "▊ RuFlo"; }\nconsole.log(generateStatusline());\n';
    expect(() => new (require('vm').Script)(tinyButAnchored)).not.toThrow();

    // Deliberately give it a SMALL installed baseline too (the exact hole-2
    // shape) — proves the floor is no longer relative to it: were it still
    // installed-relative, a tiny installed file would make this candidate
    // trivially clear the floor instead of failing it.
    const { proj, helpers } = mkFixture({ canonicalContent: tinyButAnchored, installed: 'STUB\n' });
    const before = readInstalled(helpers);
    expect(runGuard(helpers).status).toBe(0);
    expect(readInstalled(helpers)).toBe(before);
    expect(fs.readFileSync(logPath(proj), 'utf8')).toMatch(/REFUSED restore.*below \d+B absolute floor/);
  });

  test('a REFUSED restore leaves the installed file byte-identical AND still rendering non-empty output', () => {
    const { helpers } = mkFixture({ canonicalContent: 'const x = 1;', installed: CANON_CONTENT });
    const beforeBuf = fs.readFileSync(path.join(helpers, 'statusline.cjs'));
    runGuard(helpers);
    const afterBuf = fs.readFileSync(path.join(helpers, 'statusline.cjs'));
    expect(afterBuf.equals(beforeBuf)).toBe(true);
    const render = spawnSync(process.execPath, [path.join(helpers, 'statusline.cjs')], { encoding: 'utf8' });
    expect(render.status).toBe(0);
    expect(render.stdout.trim().length).toBeGreaterThan(0);
  });

  test('the REAL, full canonical asset still restores normally over a stock-clobber stub — validation does not over-reject the actual happy path', () => {
    const realAsset = fs.readFileSync(CANONICAL_ASSET, 'utf8');
    const { helpers } = mkFixture({ canonicalContent: realAsset, installed: 'STOCK STUB\n' });
    const r = runGuard(helpers);
    expect(r.status).toBe(0);
    expect(readInstalled(helpers)).toBe(realAsset);
  });
});

describe('statusline-guard.cjs — round 4: closes the comment-anchor and tail-truncation holes', () => {
  // Round-3's anchors were a plain substring match with no code-context
  // awareness, and its size floor was relative to the currently-installed
  // file. The round-4 critic found two deterministic gaps:
  //   hole 2: anchors present only INSIDE COMMENTS pass, and a small
  //           installed baseline (the realistic upstream-stock-stub-clobber
  //           scenario STATUSLINE-GUARD-V1 exists to defend) makes the old
  //           relative floor trivially clearable.
  //   hole 1: a truncation landing in the file's final ~3% can carry both
  //           original anchors (function defined, header built) while never
  //           reaching the dispatch block that actually CALLS the function —
  //           accepted, installed changed, renders silently blank.

  test('hole 2 repro: a 139-byte fake with both anchors ONLY in comments, over a realistic small stock-stub install, is REFUSED', () => {
    // This is the critic's exact shape: a purely cosmetic fake that would
    // have passed round 3's plain substring anchor check.
    const commentOnlyFake =
      '#!/usr/bin/env node\n' +
      '// function generateStatusline -- placeholder note, not real\n' +
      '// header used to say (was): "▊ RuFlo"\n' +
      'console.log("");\n';
    const realisticStockStub = '#!/usr/bin/env node\nconsole.log("▊ RuFlo + Agentic QE v3");\n'; // Patch 68's actual stock-bar shape, ~55B

    const { proj, helpers } = mkFixture({ canonicalContent: commentOnlyFake, installed: realisticStockStub });
    const beforeBuf = fs.readFileSync(path.join(helpers, 'statusline.cjs'));
    expect(runGuard(helpers).status).toBe(0);
    const afterBuf = fs.readFileSync(path.join(helpers, 'statusline.cjs'));
    expect(afterBuf.equals(beforeBuf)).toBe(true); // unchanged — refused, not overwritten
    const log = fs.readFileSync(logPath(proj), 'utf8');
    expect(log).toMatch(/REFUSED restore/);
    expect(log).toMatch(/missing required anchor on an executable line/);
  });

  test('hole 1 repro: the real asset truncated at the critic\'s exact byte offset (96.9% through, tail invocation missing) is REFUSED', () => {
    // Byte-accurate truncation (Buffer, not a JS string slice — the real
    // asset contains multi-byte UTF-8 characters, so slicing by string index
    // does not land at the same place as slicing by byte count).
    const realAssetBuf = fs.readFileSync(CANONICAL_ASSET);
    const truncatedBuf = realAssetBuf.slice(0, 58904);
    const truncated = truncatedBuf.toString('utf8');
    // Sanity-check the premise: still valid JS, still has the original two
    // anchors, but genuinely lacks the tail invocation — if any of that were
    // false this test would pass for the wrong reason.
    expect(() => new (require('vm').Script)(truncated)).not.toThrow();
    expect(truncated).toContain('function generateStatusline');
    expect(truncated).toContain('▊ RuFlo');
    expect(truncated).not.toContain('console.log(generateStatusline())');

    const { proj, helpers } = mkFixture({ canonicalContent: truncated, installed: fs.readFileSync(CANONICAL_ASSET, 'utf8') });
    const beforeBuf = fs.readFileSync(path.join(helpers, 'statusline.cjs'));
    expect(runGuard(helpers).status).toBe(0);
    const afterBuf = fs.readFileSync(path.join(helpers, 'statusline.cjs'));
    expect(afterBuf.equals(beforeBuf)).toBe(true);
    const log = fs.readFileSync(logPath(proj), 'utf8');
    expect(log).toMatch(/REFUSED restore/);
    expect(log).toMatch(/missing required anchor on an executable line: "console\.log\(generateStatusline\(\)\)"/);
  });

  test('the real, full canonical asset still restores over a stub — happy path unaffected by either fix', () => {
    const realAsset = fs.readFileSync(CANONICAL_ASSET, 'utf8');
    const { helpers } = mkFixture({ canonicalContent: realAsset, installed: 'STOCK STUB\n' });
    expect(runGuard(helpers).status).toBe(0);
    expect(readInstalled(helpers)).toBe(realAsset);
  });
});

describe('statusline-guard.cjs — round 3: opportunistic ground-truth via the provenance sidecar', () => {
  // fix-statusbar.sh writes .statusline.canonical.cjs.source alongside the
  // snapshot: { kitAssetPath, sha256 }. When that path still resolves and its
  // live sha256 matches, the guard verifies byte-for-byte against a REAL,
  // currently-existing kit asset instead of relying on the anchor+size
  // heuristic — and says so in the log. Any failure to resolve falls back to
  // the heuristic with no degradation (the guard must keep working standalone
  // in a target that isn't colocated with a kit clone).
  function mkSidecarWorld({ kitAssetContent, snapshotContent, installed }) {
    const { proj, helpers } = mkFixture({ canonicalContent: snapshotContent, installed });
    const kitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slguard-kitasset-'));
    const kitAssetPath = path.join(kitDir, 'statusline.cjs');
    fs.writeFileSync(kitAssetPath, kitAssetContent);
    const sha256 = require('crypto').createHash('sha256').update(fs.readFileSync(kitAssetPath)).digest('hex');
    fs.writeFileSync(
      path.join(helpers, '.statusline.canonical.cjs.source'),
      JSON.stringify({ kitAssetPath, sha256 })
    );
    return { proj, helpers, kitDir, kitAssetPath };
  }

  test('sidecar resolves + matches => ground-truth verified, log says so', () => {
    const { proj, helpers } = mkSidecarWorld({
      kitAssetContent: CANON_CONTENT,
      snapshotContent: CANON_CONTENT,
      installed: CLOBBER_CONTENT,
    });
    expect(runGuard(helpers).status).toBe(0);
    expect(readInstalled(helpers)).toBe(CANON_CONTENT);
    expect(fs.readFileSync(logPath(proj), 'utf8')).toMatch(/verified against live kit asset/);
  });

  test('sidecar\'s kit-asset path no longer resolves => falls back to heuristic, still restores a valid snapshot', () => {
    const { proj, helpers, kitAssetPath } = mkSidecarWorld({
      kitAssetContent: CANON_CONTENT,
      snapshotContent: CANON_CONTENT,
      installed: CLOBBER_CONTENT,
    });
    fs.rmSync(kitAssetPath); // kit clone moved/deleted since the sidecar was written
    expect(runGuard(helpers).status).toBe(0);
    expect(readInstalled(helpers)).toBe(CANON_CONTENT);
    const log = fs.readFileSync(logPath(proj), 'utf8');
    expect(log).toMatch(/restored canonical statusline/);
    expect(log).not.toMatch(/verified against live kit asset/);
    // Round 4 fix #4: this is the "never had ground truth" case — distinct
    // from "had ground truth and it didn't match" (tested below). No
    // resolvable kit asset means no ground-truth note of any kind.
    expect(log).not.toMatch(/ground truth available via sidecar/);
  });

  test('sidecar\'s kit asset since changed content (upgraded) => falls back to heuristic, not a hard requirement', () => {
    const { proj, helpers } = mkSidecarWorld({
      kitAssetContent: CANON_CONTENT + '// upgraded since the sidecar was written\n',
      snapshotContent: CANON_CONTENT, // CANON_SNAP itself is untouched — still a valid, anchor-bearing file
      installed: CLOBBER_CONTENT,
    });
    expect(runGuard(helpers).status).toBe(0);
    expect(readInstalled(helpers)).toBe(CANON_CONTENT);
    const log = fs.readFileSync(logPath(proj), 'utf8');
    expect(log).toMatch(/restored canonical statusline/);
    expect(log).not.toMatch(/verified against live kit asset/);
  });

  test('round 4 fix #4: "sidecar resolves but candidate sha differs" is logged distinguishably from "no sidecar at all"', () => {
    // Same underlying outcome (fell back to heuristic, still restored) as the
    // "moved/deleted" test above, but the CAUSE is different — ground truth
    // WAS available and the candidate failed it, vs. ground truth was never
    // reachable. An operator reading the log must be able to tell these
    // apart; round 3 could not.
    const { proj: projResolved, helpers: helpersResolved } = mkSidecarWorld({
      kitAssetContent: CANON_CONTENT + '// kit asset moved on\n',
      snapshotContent: CANON_CONTENT,
      installed: CLOBBER_CONTENT,
    });
    expect(runGuard(helpersResolved).status).toBe(0);
    const logResolvedMismatch = fs.readFileSync(logPath(projResolved), 'utf8');
    expect(logResolvedMismatch).toMatch(/ground truth available via sidecar/);
    expect(logResolvedMismatch).toMatch(/!= candidate sha/);

    const { proj: projNone, helpers: helpersNone } = mkFixture({ installed: CLOBBER_CONTENT }); // no sidecar at all
    expect(runGuard(helpersNone).status).toBe(0);
    const logNoSidecar = fs.readFileSync(logPath(projNone), 'utf8');
    expect(logNoSidecar).toMatch(/restored canonical statusline/);
    expect(logNoSidecar).not.toMatch(/ground truth available via sidecar/);

    // The two log lines must be distinguishable from one another, not just
    // individually plausible.
    expect(logResolvedMismatch).not.toBe(logNoSidecar);
  });

  test('a malformed sidecar (bad JSON) is ignored, not fatal — falls back to heuristic', () => {
    const { proj, helpers } = mkFixture({ installed: CLOBBER_CONTENT }); // default canonical = valid CANON_CONTENT
    fs.writeFileSync(path.join(helpers, '.statusline.canonical.cjs.source'), '{ not valid json');
    expect(runGuard(helpers).status).toBe(0);
    expect(readInstalled(helpers)).toBe(CANON_CONTENT);
    expect(fs.readFileSync(logPath(proj), 'utf8')).toMatch(/restored canonical statusline/);
  });

  // B10 (A2 round-4 critic follow-up): the sidecar can resolve to a REAL,
  // existing kit-asset path whose content happens to be zero bytes. Before
  // this fix, floorBytes = kitAsset.size * MIN_SIZE_FRACTION computed exactly
  // 0, and validateHeuristically's `floorBytes > 0` guard read that as "no
  // floor configured" rather than "the floor is zero" — silently skipping the
  // size check and admitting a candidate of ANY size. These tests prove the
  // fix has teeth (the exact pre-fix input is still rejected) and that it
  // doesn't touch the two states it must leave alone: an absent/unresolvable
  // reference (still falls back to the absolute floor, unchanged), and the
  // real happy path (still restores normally).
  describe('B10: zero-length kit asset must not silently disable the size floor', () => {
    test('sidecar resolves to a REAL but ZERO-BYTE kit asset => REFUSED, not silently admitted', () => {
      // Anchor-bearing and tiny — exactly the shape that a skipped floor
      // check would wave through. Differs from the zero-byte kit asset
      // content so the ground-truth byte-identical short-circuit (verdict =
      // { ok: true, groundTruth: true }) does NOT apply here; this test is
      // isolated to the "kitAsset resolved, sha differs" branch where the
      // floor is computed.
      const tinyButAnchored = 'function generateStatusline() { return "▊ RuFlo"; }\nconsole.log(generateStatusline());\n';
      const { proj, helpers } = mkSidecarWorld({
        kitAssetContent: '', // the defect trigger: resolves fine, size === 0
        snapshotContent: tinyButAnchored,
        installed: CLOBBER_CONTENT,
      });
      const before = readInstalled(helpers);
      const r = runGuard(helpers);
      expect(r.status).toBe(0);
      expect(readInstalled(helpers)).toBe(before); // refused — must NOT have been restored
      const log = fs.readFileSync(logPath(proj), 'utf8');
      expect(log).toMatch(/REFUSED restore/);
      expect(log).toMatch(/resolved to 0 bytes/);
    });

    test('sidecar resolves to a ZERO-BYTE kit asset => refusal is diagnosable (names the kit asset path, not a generic heuristic reason)', () => {
      const tinyButAnchored = 'function generateStatusline() { return "▊ RuFlo"; }\nconsole.log(generateStatusline());\n';
      const { proj, helpers, kitAssetPath } = mkSidecarWorld({
        kitAssetContent: '',
        snapshotContent: tinyButAnchored,
        installed: CLOBBER_CONTENT,
      });
      expect(runGuard(helpers).status).toBe(0);
      const log = fs.readFileSync(logPath(proj), 'utf8');
      expect(log).toContain(kitAssetPath);
      // Distinguishable from the pre-existing generic size-floor refusal message.
      expect(log).not.toMatch(/below \d+% of the kit asset/);
      expect(log).not.toMatch(/below \d+B absolute floor/);
    });

    test('unchanged behavior: an ABSENT/unresolvable kit-asset reference still falls back to the absolute floor', () => {
      // Same tiny anchor-bearing candidate, but with NO sidecar at all —
      // proves the zero-byte fix didn't touch the genuinely-null (no
      // reference) path, which must still be gated by ABSOLUTE_MIN_SIZE_BYTES
      // exactly as round 4 established.
      const tinyButAnchored = 'function generateStatusline() { return "▊ RuFlo"; }\nconsole.log(generateStatusline());\n';
      const { proj, helpers } = mkFixture({ canonicalContent: tinyButAnchored, installed: CLOBBER_CONTENT });
      const before = readInstalled(helpers);
      expect(runGuard(helpers).status).toBe(0);
      expect(readInstalled(helpers)).toBe(before);
      const log = fs.readFileSync(logPath(proj), 'utf8');
      expect(log).toMatch(/REFUSED restore/);
      expect(log).toMatch(/below \d+B absolute floor/);
      expect(log).not.toMatch(/resolved to 0 bytes/); // this is the null path, not the zero path — must not be conflated
    });

    test('unchanged behavior: the REAL current statusline.cjs still restores normally through a non-zero sidecar reference', () => {
      // Verified against the actual shipped kit asset (not a fixture stand-in)
      // — proves the B10 fix leaves the genuine happy path untouched.
      const realAsset = fs.readFileSync(CANONICAL_ASSET, 'utf8');
      const { proj, helpers } = mkSidecarWorld({
        kitAssetContent: realAsset,
        snapshotContent: realAsset,
        installed: CLOBBER_CONTENT,
      });
      expect(runGuard(helpers).status).toBe(0);
      expect(readInstalled(helpers)).toBe(realAsset);
      expect(fs.readFileSync(logPath(proj), 'utf8')).toMatch(/verified against live kit asset/);
    });
  });

  // B10-sibling (surfaced while fixing B10, confirmed by the team lead as a
  // guard-clause fix, not a restructure): kitAsset.sha === want is the
  // ground-truth branch's STRONGEST positive verdict — it skips every
  // heuristic entirely. But that equality is trivially satisfiable with
  // neither side telling us anything: sha256("") is a fixed value, so a
  // zero-byte canonical snapshot and a zero-byte resolved kit asset always
  // match. Before this fix, that combination reached `verdict = { ok: true,
  // groundTruth: true }` and restored the empty snapshot while logging
  // "verified against live kit asset" — the strongest claim the guard can
  // make, issued for two files that are both nothing.
  describe('B10-sibling: a ground-truth sha match on BOTH-EMPTY content must not verify', () => {
    test('zero-byte snapshot + zero-byte resolved kit asset => REFUSED, not restored, NOT logged as verified', () => {
      const { proj, helpers } = mkSidecarWorld({
        kitAssetContent: '', // zero bytes
        snapshotContent: '', // zero bytes — sha256("") matches the kit asset's sha256("") trivially
        installed: CLOBBER_CONTENT,
      });
      const before = readInstalled(helpers);
      const r = runGuard(helpers);
      expect(r.status).toBe(0);
      expect(readInstalled(helpers)).toBe(before); // refused — must NOT have restored empty content
      const log = fs.readFileSync(logPath(proj), 'utf8');
      expect(log).toMatch(/REFUSED restore/);
      expect(log).toMatch(/BOTH zero bytes/);
      expect(log).not.toMatch(/verified against live kit asset/); // the strongest verdict must never be issued here
    });

    test('the refusal reason names the actual kit asset path, not a generic heuristic message', () => {
      const { proj, helpers, kitAssetPath } = mkSidecarWorld({
        kitAssetContent: '',
        snapshotContent: '',
        installed: CLOBBER_CONTENT,
      });
      expect(runGuard(helpers).status).toBe(0);
      const log = fs.readFileSync(logPath(proj), 'utf8');
      expect(log).toContain(kitAssetPath);
      expect(log).not.toMatch(/missing required anchor/); // never reaches the heuristic anchor/size checks
      expect(log).not.toMatch(/below \d+% of the kit asset/);
      expect(log).not.toMatch(/below \d+B absolute floor/);
    });

    test('unchanged behavior: a non-empty snapshot that matches a non-empty kit asset still verifies (ground truth happy path intact)', () => {
      // Same shape as the pre-existing "sidecar resolves + matches" test
      // above, restated here to sit next to the both-empty regression so the
      // contrast is explicit: non-empty match verifies, empty "match" refuses.
      const { proj, helpers } = mkSidecarWorld({
        kitAssetContent: CANON_CONTENT,
        snapshotContent: CANON_CONTENT,
        installed: CLOBBER_CONTENT,
      });
      expect(runGuard(helpers).status).toBe(0);
      expect(readInstalled(helpers)).toBe(CANON_CONTENT);
      expect(fs.readFileSync(logPath(proj), 'utf8')).toMatch(/verified against live kit asset/);
    });

    test('unchanged behavior: the REAL current statusline.cjs still takes the ground-truth path normally', () => {
      // Verified against the actual shipped kit asset, not a fixture — proves
      // the both-empty guard clause doesn't touch the genuine non-empty
      // ground-truth path.
      const realAsset = fs.readFileSync(CANONICAL_ASSET, 'utf8');
      expect(realAsset.length).toBeGreaterThan(0); // sanity: premise of "non-empty real asset" actually holds
      const { proj, helpers } = mkSidecarWorld({
        kitAssetContent: realAsset,
        snapshotContent: realAsset,
        installed: CLOBBER_CONTENT,
      });
      expect(runGuard(helpers).status).toBe(0);
      expect(readInstalled(helpers)).toBe(realAsset);
      expect(fs.readFileSync(logPath(proj), 'utf8')).toMatch(/verified against live kit asset/);
    });
  });

  // B10 round 3 (critic follow-up to the round-2 sibling fix): a sha match
  // proves two files are IDENTICAL, not that either is VALID. wantSize > 0
  // closed the "both zero bytes" degenerate case, but a lone "\n" (or any
  // other inert-but-nonzero content) still clears `wantSize > 0` while being
  // exactly as meaningless as the empty-string case — and the realistic path
  // is fix-statusbar.sh writing the snapshot FROM the kit asset, so a kit
  // asset reduced to whitespace upstream propagates the same "\n" to both
  // sides and matches trivially. These tests prove the class is closed (three
  // different whitespace values, not just the one the critic picked), not
  // just the literal repro.
  describe('B10 round 3: a ground-truth sha match on WHITESPACE-ONLY (but non-empty) content must not verify', () => {
    test.each([
      ['a single newline', '\n'],
      ['two spaces', '  '],
      ['a lone tab', '\t'],
    ])('%s on BOTH sides (matching sha, size > 0) => REFUSED, not restored, NOT logged as verified', (_label, whitespace) => {
      const { proj, helpers } = mkSidecarWorld({
        kitAssetContent: whitespace,
        snapshotContent: whitespace, // matches kitAssetContent exactly => sha match, wantSize > 0
        installed: CLOBBER_CONTENT,
      });
      expect(whitespace.length).toBeGreaterThan(0); // sanity: this is the wantSize > 0 case, not the already-fixed zero-byte case
      const before = readInstalled(helpers);
      const r = runGuard(helpers);
      expect(r.status).toBe(0);
      expect(readInstalled(helpers)).toBe(before); // refused — must NOT have restored whitespace over the installed file
      const log = fs.readFileSync(logPath(proj), 'utf8');
      expect(log).toMatch(/REFUSED restore/);
      expect(log).not.toMatch(/verified against live kit asset/); // the strongest verdict must never be issued for inert content
    });

    test('the refusal reason cites the structural failure (missing anchor), not a generic or empty-specific message', () => {
      const { proj, helpers, kitAssetPath } = mkSidecarWorld({
        kitAssetContent: '\n',
        snapshotContent: '\n',
        installed: CLOBBER_CONTENT,
      });
      expect(runGuard(helpers).status).toBe(0);
      const log = fs.readFileSync(logPath(proj), 'utf8');
      expect(log).toContain(kitAssetPath);
      expect(log).toMatch(/missing required anchor on an executable line/); // the actual reason: structurally insane, not merely mismatched
      expect(log).not.toMatch(/BOTH zero bytes/); // this is the wantSize>0 case — must not be conflated with the zero-byte sibling fix
    });

    test('unchanged behavior: a non-empty, anchor-bearing snapshot that matches a non-empty kit asset still verifies', () => {
      const { proj, helpers } = mkSidecarWorld({
        kitAssetContent: CANON_CONTENT,
        snapshotContent: CANON_CONTENT,
        installed: CLOBBER_CONTENT,
      });
      expect(runGuard(helpers).status).toBe(0);
      expect(readInstalled(helpers)).toBe(CANON_CONTENT);
      expect(fs.readFileSync(logPath(proj), 'utf8')).toMatch(/verified against live kit asset/);
    });

    test('unchanged behavior: the REAL current statusline.cjs still takes the ground-truth path normally', () => {
      // Verified against the actual shipped kit asset, not a fixture — proves
      // the round-3 structural check doesn't touch the genuine happy path.
      const realAsset = fs.readFileSync(CANONICAL_ASSET, 'utf8');
      const { proj, helpers } = mkSidecarWorld({
        kitAssetContent: realAsset,
        snapshotContent: realAsset,
        installed: CLOBBER_CONTENT,
      });
      expect(runGuard(helpers).status).toBe(0);
      expect(readInstalled(helpers)).toBe(realAsset);
      expect(fs.readFileSync(logPath(proj), 'utf8')).toMatch(/verified against live kit asset/);
    });
  });
});

describe('statusline-guard.cjs — round 3: REQUIRED_ANCHORS regression guard (F4 sentinel-decay class)', () => {
  // The anchor check is only as good as the anchors actually staying present
  // in the real canonical asset. If a future edit to assets/statusline.cjs
  // ever renames/removes generateStatusline or its header string, the guard
  // would start refusing EVERY restore in the field with no warning anywhere
  // else — the exact stale-sentinel trap this kit has hit before (F4, and
  // the RUFLO-INTEL-V2-vs-V3 drift found in this same piece). This test makes
  // that scenario fail loudly in CI instead: it extracts the actual
  // REQUIRED_ANCHORS array from the guard's source (not a hardcoded copy, so
  // it can't silently drift from what the guard really checks) and asserts
  // each one is present in the real, current assets/statusline.cjs.
  function extractRequiredAnchors() {
    const src = fs.readFileSync(GUARD_ASSET, 'utf8');
    const block = src.match(/const REQUIRED_ANCHORS = \[([\s\S]*?)\];/);
    expect(block).toBeTruthy();
    // Strip each line's trailing `//` comment BEFORE matching a quoted
    // string — the anchor entries carry explanatory comments that
    // themselves contain apostrophes (e.g. "the render function's
    // declaration"), which a naive whole-block quote regex mismatches
    // across (an apostrophe in a comment pairs with the NEXT anchor's
    // opening quote, extracting garbage instead of an anchor).
    const anchors = block[1]
      .split('\n')
      .map((line) => line.split('//')[0])
      .map((codeOnly) => codeOnly.match(/'([^']*)'/))
      .filter(Boolean)
      .map((m) => m[1]);
    // Round 4 added a third (tail-invocation) anchor — bump the floor so a
    // future accidental removal of an anchor entry is itself caught here.
    expect(anchors.length).toBeGreaterThanOrEqual(3);
    return anchors;
  }

  // The guard's own executable-line heuristic, reused here so this test
  // fails the same way the guard itself would refuse a candidate missing an
  // anchor — not a looser or stricter proxy for it.
  function anchorOnExecutableLine(src, anchor) {
    return src.split('\n').some((line) => line.includes(anchor) && !line.trim().startsWith('//'));
  }

  test('every REQUIRED_ANCHOR the guard checks for is actually present in assets/statusline.cjs', () => {
    const anchors = extractRequiredAnchors();
    const realAsset = fs.readFileSync(CANONICAL_ASSET, 'utf8');
    for (const anchor of anchors) {
      expect({ anchor, present: realAsset.includes(anchor) }).toEqual({ anchor, present: true });
    }
  });

  test('the anchors are genuinely load-bearing, not incidental comments (every anchor sits on an executable line)', () => {
    const anchors = extractRequiredAnchors();
    const realAsset = fs.readFileSync(CANONICAL_ASSET, 'utf8');
    for (const anchor of anchors) {
      expect({ anchor, onExecutableLine: anchorOnExecutableLine(realAsset, anchor) })
        .toEqual({ anchor, onExecutableLine: true });
    }
  });

  test('the tail (invocation) anchor specifically is the file\'s actual dispatch call, not merely present somewhere', () => {
    const anchors = extractRequiredAnchors();
    const tailAnchor = anchors.find((a) => a.includes('generateStatusline()') && a !== 'function generateStatusline');
    expect(tailAnchor).toBeTruthy();
    const realAsset = fs.readFileSync(CANONICAL_ASSET, 'utf8');
    // Must appear strictly after the function's own declaration (it's a call
    // site, not the declaration) — a sanity check on ordering, since a call
    // appearing BEFORE its declaration in this file's structure would mean
    // the anchor was misidentified.
    expect(realAsset.indexOf(tailAnchor)).toBeGreaterThan(realAsset.indexOf('function generateStatusline'));
  });
});

describe('fix-statusbar wiring', () => {
  test('settings statusLine command runs the guard first', () => {
    const src = fs.readFileSync(FIXSB, 'utf8');
    const line = src.split('\n').find((l) => l.includes('const desired =') && l.includes('statusline-guard.cjs'));
    expect(line).toBeTruthy();
    // Guard precedes the renderer, joined with ';' so a guard failure never blocks the render.
    expect(line.indexOf('statusline-guard.cjs')).toBeLessThan(line.indexOf('helpers/statusline.cjs" 2>/dev/null ||'));
    expect(line).toMatch(/statusline-guard\.cjs" 2>\/dev\/null;/);
  });
});
