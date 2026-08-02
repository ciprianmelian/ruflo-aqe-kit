/**
 * DAEMON-HINT-SCOPE-V1 static guard: a lib/*.sh script that discovers running
 * ruflo daemons via UNSCOPED machine-wide detection (the shared
 * kit_daemon_ps_lines helper, or a hand-rolled duplicate of its literal
 * two-pattern pgrep — status.sh reimplements the pattern inline rather than
 * calling the shared function by name, so both signals must be checked) must
 * ALSO route its user-facing remediation through kit_daemon_scope_split
 * (common.sh). Without that, the remediation text ends up making a
 * target-specific causal claim ("it locks the DBs" / "stop with: ruflo daemon
 * stop") about a daemon that may belong to an entirely different project —
 * the exact regression this session found live (a stray daemon for an
 * unrelated workspace, reproduced against PID 29640) and fixed in
 * lib/verify-learning.sh (probe_daemon_advisory), lib/status.sh (daemon
 * section), lib/setup.sh (S6), and lib/fix-learning.sh (preflight).
 *
 * ROUND 2 (coordinator-found gaps in round 1 of this guard):
 *   (a) SCOPE_SPLIT_RE used to be a bare substring match, so a rename like
 *       `kit_daemon_scope_split_disabled` (or a prefix like
 *       `my_kit_daemon_scope_split`) still satisfied it — the guard would
 *       stay green while the actual call was gone. Fixed with lookaround
 *       assertions requiring a non-identifier character (or start/end of
 *       string) on both sides, so only the exact standalone identifier
 *       counts. Plain `\b` does NOT work here — `_` is a word character, so
 *       there is no word boundary between `...split` and `_disabled`.
 *   (b) The detection signal only covered the kit_daemon_ps_lines/pgrep
 *       shape, so lib/fix-learning.sh and lib/verify-learning.sh — both of
 *       which now correctly call kit_daemon_scope_split and were NEVER
 *       flagged by round 1 — imposed no requirement at all. If either were
 *       reverted to its OLD instrument (fix-learning.sh's prior `ruflo daemon
 *       status | grep -qiE RUNNING`), the guard would stay green. Fixed by
 *       adding a literal, non-comment `daemon status` signal (catches every
 *       invocation shape actually used in this codebase — bare `ruflo daemon
 *       status`, `"${RUFLO_CMD[@]}" daemon status`, `ruflo_timeout N daemon
 *       status`). At design time this exact substring, non-comment, appeared
 *       in EXACTLY lib/health.sh, lib/init.sh, lib/session-init.sh and
 *       nowhere else, so it did not need per-shape variants. All THREE were
 *       then CONVERTED (see below) and none contains it any more — the
 *       falsification test further below proves the signal would still catch
 *       any of the three if it regressed back to the old shape.
 *
 * ROUND 3 (coordinator critic finding, second pass): round 2's session-init.sh
 * EXEMPTION reason was FACTUALLY WRONG, not just imprecise. It claimed
 * "session has no --dry-run/read-only contract to violate." False — Step 3
 * of lib/session-init.sh (pin_helpers_module_type) already honors $DRY_RUN
 * (its DRYRUN case branch), so the file DOES have a partial dry-run contract,
 * and the unconverted daemon-status call — never gated on $DRY_RUN — was
 * inconsistent with it, leaking .claude-flow/logs/daemon.log under `bin/
 * ruflo-kit session <target> --dry-run` exactly like health.sh/init.sh did
 * pre-conversion (confirmed empirically against a scratch harness with
 * fix-ruflo.sh/fix-statusbar.sh stubbed to no-ops, since those two run
 * unconditionally regardless of --dry-run and are out of THIS fix's scope —
 * a separate, larger gap, noted but not chased here). A documented exemption
 * resting on a false premise is worse than no exemption, so it has been
 * RETRACTED, not reworded: session-init.sh is now CONVERTED, third bucket
 * below, alongside health.sh and init.sh.
 *
 * Exemptions (documented, not silent):
 *   - common.sh: the DEFINITION site of both kit_daemon_ps_lines and
 *     kit_daemon_scope_split. Its own doc-comments quote the remediation
 *     phrases ("it locks the DBs", "BILLED; stop with: ruflo daemon stop") as
 *     WORKED EXAMPLES inside kit_daemon_scope_split's header comment, which
 *     would otherwise make common.sh flag itself.
 *   - proof.sh: uses kit_daemon_ps_lines for probe P14's daemon-gates check,
 *     but ALREADY hedges correctly — "$dcount daemon proc(s) running
 *     (operator?)" — with no per-target causal claim (confirmed in this
 *     session's B24 critic review: "status.sh/proof.sh already word it
 *     defensively ... no per-target causal claim"). Explicitly out of scope
 *     per this fix's brief; kept here as an intentional exemption rather than
 *     silently passing.
 *
 * CONVERTED, not exempted, because each had a --dry-run-reachable leak
 * (verified empirically — see each file's own DAEMON-HINT-SCOPE-V1 comment
 * for the before/after artifact diff):
 *   - lib/health.sh: documents `--dry-run` as "diff but don't update
 *     snapshot"; the daemon-status call ran unconditionally regardless of
 *     mode and left .claude-flow/logs/daemon.log behind even under
 *     --dry-run.
 *   - lib/init.sh: has an explicit, previously-litigated (B11)
 *     dry-run-inertness contract ("a --dry-run must never mutate the
 *     filesystem") for two OTHER mutations; the daemon-status call was a
 *     THIRD, previously unaddressed violation of that same contract —
 *     confirmed the same way B11's teeth tests are built (dry-run against a
 *     fresh target, diff the tree).
 *   - lib/session-init.sh (round 3): honors $DRY_RUN partially (Step 3); the
 *     daemon-status call was never gated on it and leaked the same artifact
 *     — see the ROUND 3 note above.
 *
 * NOT exempted, and NOT expected to need kit_daemon_scope_split, because it
 * never does unscoped pgrep-based discovery OR a `daemon status` call in the
 * first place — it invokes a scoped-by-construction CLI ACTION directly
 * (`ruflo daemon stop`, no --all — itself workspace-scoped):
 *   - lib/upgrade.sh (DAEMON-HINT-SCOPE-V1 comment there explains why this
 *     one is left alone — only the success message's WORDING was made
 *     honest about scope, the ACTION was always correct).
 * Proven un-flagged by the detection regex itself (asserted below), not
 * carved out by an allowlist — if it ever grows a real unscoped-pgrep or
 * `daemon status` site, the guard picks it up automatically.
 *
 * HONESTY ABOUT LIMITS (this is a floor, not a ceiling): this guard proves a
 * FILE-LEVEL textual invariant — "if unscoped detection appears anywhere in
 * this file, kit_daemon_scope_split appears somewhere in this file too". It
 * cannot prove the remediation text is CORRECTLY tri-state-branched (that the
 * MINE/OTHER/UNKNOWN buckets are wired to the right wording) — that is what
 * the per-file behavioral tests (tests/verify-learning.test.js,
 * tests/status.test.js) already cover. It also cannot catch a brand-new
 * unscoped-detection mechanism that doesn't match any signal below (a
 * genuinely novel implementation, not a pattern this kit has actually used).
 * Treat a failure here as "investigate", not as proof of correctness when it
 * passes.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const LIB = path.resolve(__dirname, '..', 'lib');

// Files that legitimately carry unscoped daemon-discovery machinery without
// needing to route through kit_daemon_scope_split — see file header for why.
// (session-init.sh is NOT here — round 3 retracted that exemption; it is
// converted, like health.sh/init.sh, and no longer trips the detector at all.)
const EXEMPT = new Set(['common.sh', 'proof.sh']);

// Strips '#'-led comment lines (leading whitespace allowed) so a doc-comment
// that merely MENTIONS a pattern — explaining a fix, narrating history —
// never counts as real usage. (Inline trailing comments after real code are
// intentionally NOT stripped: a real call followed by `# ...` still contains
// the real call earlier on the same line.)
function nonCommentSource(src) {
  return src
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

// UNSCOPED-DETECTION signal: the shared helper's name, a literal
// reimplementation of its two-pattern pgrep shape (status.sh's own inline
// dual pgrep, which never calls kit_daemon_ps_lines by name — see
// lib/common.sh's kit_daemon_ps_lines header for why BOTH patterns are
// required: 'bin/cli.js daemon start' catches the real surviving argv,
// 'ruflo daemon' alone misses it per commit fcaec68's blindspot), OR a real
// (non-comment) `daemon status` CLI invocation — round 2's added signal,
// catching the DIFFERENT-shaped defect fix-learning.sh had (correct scope,
// untrustworthy/leaky instrument) that the pgrep-based signal alone missed.
const UNSCOPED_DETECTION_RE = /kit_daemon_ps_lines|pgrep\s+-f\s+['"](bin\/cli\.js daemon start|ruflo daemon)['"]|daemon status/;

// Word-boundary-safe match for the REQUIREMENT side (round 2 fix (a)): `\b`
// does not help here since `_` is a word character, so
// `kit_daemon_scope_split_disabled` has no boundary right after `split`.
// Lookaround requires a non-identifier char (or start/end of string) on
// BOTH sides, so only the exact standalone identifier satisfies it — a
// suffixed or prefixed rename does not.
const SCOPE_SPLIT_RE = /(?<![A-Za-z0-9_])kit_daemon_scope_split(?![A-Za-z0-9_])/;

function libShFiles() {
  // Dotfiles are excluded because tests/dryrun-mutation-guard.test.js writes
  // `lib/.pretest-b11-<name>.sh` — a copy of a script as it was BEFORE a fix —
  // into the real lib/ so that KIT_DIR resolves correctly, then removes it in
  // a finally. While it exists, this guard (running in parallel) would scan a
  // deliberately pre-fix script and fail against a defect that was already
  // fixed. No real kit script is a dotfile, so skipping them is exact, not a
  // workaround: it narrows the scan to the files the guard is actually about.
  return fs.readdirSync(LIB).filter((f) => f.endsWith('.sh') && !f.startsWith('.'));
}

describe('DAEMON-HINT-SCOPE-V1 guard: unscoped daemon detection must route remediation through kit_daemon_scope_split', () => {
  const files = libShFiles();
  const flaggedByDetection = files.filter((f) =>
    UNSCOPED_DETECTION_RE.test(nonCommentSource(fs.readFileSync(path.join(LIB, f), 'utf8'))));

  // Goodhart trap check: if the detection regex somehow matched nothing (a
  // future refactor renames kit_daemon_ps_lines, say), every it() below would
  // vacuously pass and this guard would silently check nothing. Pin the
  // known-fixed sites explicitly so that failure mode is itself caught.
  // health.sh, init.sh, AND session-init.sh (round 3) are DELIBERATELY absent
  // from this list: now that all three are converted, none contains "daemon
  // status" or kit_daemon_ps_lines text at all, so the detection signal
  // correctly does NOT fire on them any more — that is the fix working, not
  // a gap. Their protection is the falsification test below instead: it
  // proves that IF any were reverted to the old instrument, THIS SAME
  // live-disk loop would flag it and require kit_daemon_scope_split.
  it('sanity: the detection signal fires on every currently-unconverted known site (status.sh, setup.sh, proof.sh, common.sh)', () => {
    expect(flaggedByDetection).toEqual(expect.arrayContaining([
      'status.sh', 'setup.sh', 'proof.sh', 'common.sh',
    ]));
  });

  it('sanity: a file that only calls a scoped-by-construction daemon CLI ACTION (upgrade.sh: `ruflo daemon stop`, no status/pgrep site) is NOT flagged', () => {
    expect(flaggedByDetection).not.toContain('upgrade.sh');
  });

  it('sanity: the CONVERTED files (health.sh, init.sh, session-init.sh) are no longer flagged — the old instrument is genuinely gone, not just supplemented', () => {
    expect(flaggedByDetection).not.toContain('health.sh');
    expect(flaggedByDetection).not.toContain('init.sh');
    expect(flaggedByDetection).not.toContain('session-init.sh');
  });

  // Round 2 falsification: prove the WORD-BOUNDARY fix actually matters, not
  // just that the regex looks stricter. A bare substring match would have
  // let this synthetic "renamed away" source pass; the fixed regex must not.
  it('falsification: a source containing only a SUFFIXED rename of kit_daemon_scope_split does NOT satisfy the requirement regex', () => {
    const renamed = 'DSCOPE="$(kit_daemon_scope_split_disabled "$TARGET_DIR")"';
    expect(renamed).not.toMatch(SCOPE_SPLIT_RE);
  });
  it('falsification: a source containing only a PREFIXED rename of kit_daemon_scope_split does NOT satisfy the requirement regex', () => {
    const renamed = 'DSCOPE="$(my_kit_daemon_scope_split "$TARGET_DIR")"';
    expect(renamed).not.toMatch(SCOPE_SPLIT_RE);
  });
  it('sanity: the real, unmodified call in lib/status.sh DOES satisfy the requirement regex', () => {
    const code = nonCommentSource(fs.readFileSync(path.join(LIB, 'status.sh'), 'utf8'));
    expect(code).toMatch(SCOPE_SPLIT_RE);
  });

  // Falsification for the round-2 (b) detection gap itself: reverting
  // lib/health.sh, lib/init.sh, or lib/session-init.sh to its OLD instrument
  // (the exact pre-fix `... daemon status ...` shape, with no
  // kit_daemon_scope_split anywhere near it) must be a state the live-disk
  // loop above WOULD flag as needing the helper. Driven against a synthetic
  // snippet — not a real file mutation — so this proof never touches disk,
  // live or otherwise.
  it('falsification: the OLD (pre-fix) health.sh/init.sh/session-init.sh daemon-status instrument is flagged AND fails the requirement', () => {
    const oldStyleSnippet = [
      '# Daemon: `ruflo daemon status` always exits 0, grep for the canonical line',
      'DAEMON_OUT=$(ruflo_timeout 5 daemon status || true)',
      'DAEMON_RUNNING=false',
      'if echo "$DAEMON_OUT" | grep -q \'RUNNING\'; then DAEMON_RUNNING=true; fi',
    ].join('\n');
    const code = nonCommentSource(oldStyleSnippet);
    expect(UNSCOPED_DETECTION_RE.test(code)).toBe(true);   // would be flagged
    expect(SCOPE_SPLIT_RE.test(code)).toBe(false);          // and fail the requirement
  });

  for (const f of flaggedByDetection) {
    if (EXEMPT.has(f)) continue;
    it(`lib/${f}: has unscoped daemon detection — must also call kit_daemon_scope_split`, () => {
      const code = nonCommentSource(fs.readFileSync(path.join(LIB, f), 'utf8'));
      expect(code).toMatch(SCOPE_SPLIT_RE);
    });
  }
});
