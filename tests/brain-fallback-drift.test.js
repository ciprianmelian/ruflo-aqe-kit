/**
 * Drift tripwire for the ruvnet-brain CI/clean-clone fallback (BRAIN-FALLBACK-DEGRADED-V1).
 *
 * Background: lib/fix-brain.sh falls back to the kit-tracked assets/brain/server.mjs only
 * when the gitignored vendor/ruvnet-brain checkout is absent. That fallback used to carry a
 * comment claiming it was "verified byte-identical to upstream" — a claim upstream's 4.0.0
 * release quietly falsified by rewriting plugin/mcp/server.mjs from a v1 transparent stdio
 * proxy into a stateful v2 "Stable Spine" shell (hot-swap child management, a lease file, a
 * timeout/outage alarm, and two extra CLI-execution tools via managed-cli-interface.mjs). The
 * comment kept asserting identity for who knows how long after that stopped being true.
 *
 * The kit's decision (see the gauntlet 2026-07-31 brain ledger entry E1) is to KEEP
 * the v1 proxy deliberately: v2's extra tools + outbound alarm widen the surface past the
 * "one MCP tool" design fix-brain.sh states for itself. This suite is the tripwire against
 * that decision silently rotting again:
 *
 *   1. no comment anywhere in the fallback's footprint may claim byte-identity to upstream;
 *   2. both provenance comments must carry the BRAIN-FALLBACK-DEGRADED-V1 marker and name the
 *      specific upstream version/commit the decision was documented against;
 *   3. the fallback must not quietly gain the v2-only siblings (managed-cli-interface.mjs /
 *      brain-alarm.mjs) or declare the v2 tools — that would be exactly the scope creep the
 *      decision rejected, done by accident instead of by review;
 *   4. when vendor/ruvnet-brain is present (this repo's own self-application checkout — not
 *      guaranteed on every machine, so this section skips cleanly rather than failing CI when
 *      absent), the documented reference version must not be BEHIND the currently vendored
 *      version — if upstream has moved further, the decision needs a human to re-look, not a
 *      silently stale comment;
 *   5. if a comment cites a commit hash alongside the version (e.g. "v4.0.2 (commit 453ae58)"),
 *      that hash must actually resolve in vendor/ruvnet-brain AND its package.json at that
 *      commit must read the cited version — a wrong-but-plausible pairing (an earlier commit
 *      that happens to precede the same version bump, or a commit for a different version
 *      entirely) is exactly the error class a first draft of this file's own comment shipped
 *      with (v4.0.2 paired with commit e20cdf2, which is actually the 4.0.0 release commit —
 *      the correct commit for the current v4.0.2 state is 453ae58). Section 4's semver-only
 *      staleness check cannot catch that: the version number can still be numerically current
 *      while the hash next to it points at the wrong commit;
 *   6. a cited commit reference that is PRESENT but malformed (e.g. truncated to fewer than 7
 *      hex chars) must FAIL, never silently pass as if no hash were cited at all. Round 3's own
 *      first draft of section 5 had exactly this hole: its capture group required 7-40 hex
 *      chars and was optional, so a sub-7-char citation failed to CAPTURE rather than failed to
 *      MATCH — `if (!m[2]) continue` then treated "malformed but present" identically to
 *      "absent", a bypassable tripwire. Section 6 captures ANY "(commit ...)" content verbatim
 *      and validates its shape independently of vendor/ruvnet-brain's presence (pure string
 *      validation on our own tracked files, so it can never legitimately skip).
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const FALLBACK = path.join(REPO, 'assets', 'brain', 'server.mjs');
const FIX_BRAIN = path.join(REPO, 'lib', 'fix-brain.sh');
const VENDOR_DIR = path.join(REPO, 'vendor', 'ruvnet-brain');
const VENDOR_SERVER = path.join(VENDOR_DIR, 'plugin', 'mcp', 'server.mjs');
const VENDOR_PKG = path.join(VENDOR_DIR, 'package.json');

const MARKER = 'BRAIN-FALLBACK-DEGRADED-V1';
// Matches "... documented against upstream v4.0.2 (commit 453ae58)" and pulls out the semver
// plus an optional commit reference. The commit group captures ANYTHING between "(commit "
// and ")" — not just well-formed hex — so a malformed/truncated citation still gets captured
// (group defined, contents wrong) instead of failing to match (group undefined, indistinguishable
// from "no hash cited"). Shape validity is checked separately by HASH_SHAPE_RE (see section 6);
// this regex's job is only to tell "a commit was cited" apart from "no commit was cited".
const REFERENCE_RE = /BRAIN-FALLBACK-DEGRADED-V1[^\n]*upstream v(\d+\.\d+\.\d+)(?:\s*\(commit ([^)]*)\))?/;

// A plausible, unambiguous abbreviated git SHA: hex only, 7-40 chars (git's default abbrev
// length is 7; anything shorter is too easily ambiguous to trust as a citation).
const HASH_SHAPE_RE = /^[0-9a-f]{7,40}$/;

// Runs `git show <ref>:<file>` inside vendor/ruvnet-brain; returns the content or null on
// any failure (bad ref, bad path, git not installed) — callers treat null as "unverifiable".
function gitShowAt(ref, file) {
  const r = spawnSync('git', ['-C', VENDOR_DIR, 'show', `${ref}:${file}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

// True only if `hash` resolves to an actual commit object in vendor/ruvnet-brain.
function commitExists(hash) {
  const r = spawnSync('git', ['-C', VENDOR_DIR, 'cat-file', '-e', `${hash}^{commit}`], { encoding: 'utf8' });
  return r.status === 0;
}

function parseSemver(v) {
  const m = String(v || '').trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// true when a < b
function semverLt(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

// Strips whole-line `//` comments (this file only uses line comments — no block comments)
// so scope-creep checks look at actual code, not the prose that explains what's excluded.
function codeOnly(src) {
  return src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

// ── 1 & 3. the fallback file itself ─────────────────────────────────────────

describe('brain fallback — v1 proxy exists, parses, and stays scope-limited', () => {
  it('assets/brain/server.mjs exists', () => {
    expect(fs.existsSync(FALLBACK)).toBe(true);
  });

  it('passes node --check', () => {
    const r = spawnSync(process.execPath, ['--check', FALLBACK], { encoding: 'utf8' });
    expect(r.status).toBe(0);
  });

  it('does not import the v2-only siblings (managed-cli-interface.mjs / brain-alarm.mjs)', () => {
    // The header comment legitimately NAMES these upstream-only files to explain what's
    // excluded and why — so this checks actual CODE (comment lines stripped), not prose.
    const code = codeOnly(fs.readFileSync(FALLBACK, 'utf8'));
    expect(code).not.toMatch(/managed-cli-interface\.mjs/);
    expect(code).not.toMatch(/brain-alarm\.mjs/);
  });

  it('does not declare the v2-only tools (ruvnet_cli_help / ruvnet_cli_run)', () => {
    const code = codeOnly(fs.readFileSync(FALLBACK, 'utf8'));
    expect(code).not.toMatch(/ruvnet_cli_help/);
    expect(code).not.toMatch(/ruvnet_cli_run/);
  });
});

// ── 2. comment honesty across the fallback's footprint ──────────────────────

describe('brain fallback — provenance comments stay honest', () => {
  it('assets/brain/server.mjs does not claim byte-identity to upstream', () => {
    const src = fs.readFileSync(FALLBACK, 'utf8');
    expect(src).not.toMatch(/byte-identical/i);
  });

  it('lib/fix-brain.sh does not claim byte-identity to upstream', () => {
    const src = fs.readFileSync(FIX_BRAIN, 'utf8');
    expect(src).not.toMatch(/byte-identical/i);
  });

  it('assets/brain/server.mjs carries the BRAIN-FALLBACK-DEGRADED-V1 marker with a referenced version', () => {
    const src = fs.readFileSync(FALLBACK, 'utf8');
    expect(src).toContain(MARKER);
    expect(REFERENCE_RE.test(src)).toBe(true);
  });

  it('lib/fix-brain.sh carries the BRAIN-FALLBACK-DEGRADED-V1 marker with a referenced version', () => {
    const src = fs.readFileSync(FIX_BRAIN, 'utf8');
    expect(src).toContain(MARKER);
    expect(REFERENCE_RE.test(src)).toBe(true);
  });
});

// ── 6. a cited commit reference must be well-formed, or FAIL — never silently skipped ───
// Pure string validation on our own tracked files: needs no git, no vendor/ruvnet-brain, so
// this can never legitimately skip. Runs before (and independently of) the vendor-gated
// resolve+version-match check in section 5, so a malformed hash fails here even when vendor/
// is absent on this machine.

describe('brain fallback — a cited commit reference cannot be malformed or truncated', () => {
  it('regression case: a 6-hex-char citation is CAPTURED (not silently treated as absent)', () => {
    // Reproduces the exact loophole found in review: the first draft's capture group required
    // 7-40 hex chars and was optional, so a 6-char citation failed to CAPTURE rather than
    // failed to MATCH, and callers' `if (!m[2]) continue` conflated "malformed" with "absent".
    const synthetic = '// BRAIN-FALLBACK-DEGRADED-V1 — documented against upstream v4.0.2 (commit e20cdf).';
    const m = synthetic.match(REFERENCE_RE);
    expect(m).not.toBeNull();
    expect(m[2]).toBe('e20cdf'); // captured verbatim, 6 chars — proves it was NOT dropped
    expect(HASH_SHAPE_RE.test(m[2])).toBe(false); // and shape validation correctly rejects it
  });

  it('regression case: no "(commit ...)" parenthetical at all is correctly treated as absent (fine)', () => {
    const synthetic = '// BRAIN-FALLBACK-DEGRADED-V1 — documented against upstream v4.0.2.';
    const m = synthetic.match(REFERENCE_RE);
    expect(m).not.toBeNull();
    expect(m[2]).toBeUndefined(); // no citation at all — nothing to validate, not a failure
  });

  it('neither real file cites a malformed/truncated commit reference', () => {
    const files = [FALLBACK, FIX_BRAIN];
    const bad = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const m = src.match(REFERENCE_RE);
      if (!m || m[2] === undefined) continue; // no commit cited at all — fine, nothing to check
      if (!HASH_SHAPE_RE.test(m[2])) {
        bad.push(
          `${path.relative(REPO, file)}: cites a commit reference "${m[2]}" that is not a valid ` +
          `7-40 char hex hash (too short to be an unambiguous git abbreviation, or not hex at all) ` +
          `— fix the hash or drop the "(commit ...)" parenthetical entirely.`
        );
      }
    }
    expect(bad.join('\n')).toBe('');
  });
});

// ── 4. the referenced version must not fall behind the vendored checkout ────
// Skips cleanly (never fails CI) when vendor/ruvnet-brain isn't checked out on this
// machine — it's a local-only, gitignored clone, not guaranteed anywhere but here.

describe('brain fallback — documented reference version vs. the vendored checkout', () => {
  const vendorPresent = fs.existsSync(VENDOR_SERVER) && fs.existsSync(VENDOR_PKG);

  it('reports vendor/ruvnet-brain presence (informational; absence is not a failure)', () => {
    if (!vendorPresent) {
      console.warn(
        'vendor/ruvnet-brain not present on this machine (gitignored, local-only checkout) ' +
        '— skipping the reference-version drift check; nothing to compare against.'
      );
    }
    expect(true).toBe(true);
  });

  it('the fallback still differs from upstream\'s current v2 server.mjs (informational — confirms the known, deliberate divergence; would also pass harmlessly if upstream ever reverted to something v1-shaped)', () => {
    if (!vendorPresent) return;
    const a = fs.readFileSync(FALLBACK, 'utf8');
    const b = fs.readFileSync(VENDOR_SERVER, 'utf8');
    if (a === b) {
      console.warn('assets/brain/server.mjs is now byte-identical to vendor/ruvnet-brain/plugin/mcp/server.mjs — the v1/v2 divergence this decision was based on may have closed; re-review the BRAIN-FALLBACK-DEGRADED-V1 comments.');
    }
    expect(true).toBe(true);
  });

  it('neither provenance comment\'s referenced version is behind the currently vendored version', () => {
    if (!vendorPresent) return;
    const vendorVersion = parseSemver(JSON.parse(fs.readFileSync(VENDOR_PKG, 'utf8')).version);
    expect(vendorVersion).not.toBeNull();

    const files = [FALLBACK, FIX_BRAIN];
    const stale = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const m = src.match(REFERENCE_RE);
      if (!m) {
        stale.push(`${path.relative(REPO, file)}: missing a parseable BRAIN-FALLBACK-DEGRADED-V1 reference version`);
        continue;
      }
      const referenced = parseSemver(m[1]);
      if (referenced && semverLt(referenced, vendorVersion)) {
        stale.push(
          `${path.relative(REPO, file)}: documented against v${m[1]}, but vendor/ruvnet-brain is now ` +
          `v${vendorVersion.join('.')} — upstream moved further since this decision was written; ` +
          `re-review whether the v1 fallback (and its comments) still hold.`
        );
      }
    }
    expect(stale.join('\n')).toBe('');
  });

  it('any commit hash cited alongside the version actually resolves and matches that version', () => {
    if (!vendorPresent) return;
    // Guards against the exact defect class a first draft of these comments shipped with:
    // "v4.0.2 (commit e20cdf2)" — e20cdf2 is a real, resolvable commit, but it's upstream's
    // 4.0.0 release commit, not 4.0.2. Section 4 (semver-only) cannot see this: the cited
    // version was numerically current, the hash next to it was simply the wrong commit.
    const files = [FALLBACK, FIX_BRAIN];
    const bad = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const m = src.match(REFERENCE_RE);
      if (!m || m[2] === undefined) continue; // no cited commit hash — nothing to verify (that's fine)
      if (!HASH_SHAPE_RE.test(m[2])) continue; // malformed shape — section 6 already fails this, independent of vendor/
      const [, citedVersion, hash] = m;
      if (!commitExists(hash)) {
        bad.push(`${path.relative(REPO, file)}: cites commit ${hash}, which does not resolve in vendor/ruvnet-brain`);
        continue;
      }
      const pkgAtCommit = gitShowAt(hash, 'package.json');
      const versionAtCommit = pkgAtCommit && parseSemver(JSON.parse(pkgAtCommit).version);
      if (!versionAtCommit) {
        bad.push(`${path.relative(REPO, file)}: cites commit ${hash}, whose package.json could not be read/parsed`);
        continue;
      }
      const cited = parseSemver(citedVersion);
      if (!cited || versionAtCommit.join('.') !== cited.join('.')) {
        bad.push(
          `${path.relative(REPO, file)}: cites "v${citedVersion} (commit ${hash})", but commit ${hash}'s ` +
          `package.json is actually v${versionAtCommit.join('.')} — wrong commit for that version, ` +
          `re-verify with: git -C vendor/ruvnet-brain show ${hash}:package.json`
        );
      }
    }
    expect(bad.join('\n')).toBe('');
  });
});
