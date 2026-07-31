/**
 * Tests for SEVERE-FIX-V1 — the severity tier in lib/sync.sh's run_fix().
 *
 * ROUND 1 DEFECT (B9, Wave 5): run_fix() used to decide ok/warn/fail by
 * grepping a stage's own printed output for a "completion marker" regex.
 * fix-ruflo.sh's marker was the literal string 'Log:' — but fix-ruflo prints
 * `echo -e "\n  Log: $LOG_FILE"` UNCONDITIONALLY as its very last statement,
 * regardless of whether the run succeeded, warned, or hard-failed. So the
 * grep always matched, `warn` was the only branch a nonzero exit could ever
 * reach, and `sync`'s own exit code could never go nonzero no matter how
 * badly a fix stage failed. FIX: grade purely on exit code, never text.
 *
 * ROUND 2 DEFECT (EXIT-1-COLLISION-V1, found by the B18 critic reviewing
 * round 1): round 1's exit-code contract reserved plain `1` for "warn". But
 * fix-ruflo.sh (and the other fix-*.sh stages) run under `set -uo pipefail`
 * with `-e` deliberately omitted, and on this kit's target bash, a script
 * FILE (not `bash -c`) that references an unset variable anywhere under
 * `set -u` aborts with exit status 1 — verified directly below. So a genuine
 * mid-script crash — even one occurring AFTER a real SEVERE_ERRORS-
 * incrementing security/native-integrity failure had already run — was
 * graded identically to "completed cleanly, cosmetic drift only". This is
 * the exact shape of the round-1 defect recurring through the exit code
 * instead of the output text. FIX: `warn` moved off of 1 onto 21 — chosen,
 * like 20, from outside bash's entire crash-code family (1, 2, 126, 127,
 * 128+n, 130), so neither reserved value can be produced by an accidental
 * abort.
 *
 * CURRENT CONTRACT (lib/fix-ruflo.sh's exit tail / lib/sync.sh's run_fix()):
 *   0  = ok     (clean)
 *   21 = warn   (cosmetic / manual-action drift only)
 *   20 = fail   (SEVERE — a SECURITY or NATIVE-INTEGRITY repair itself failed)
 *   *  = fail   (crash — did not run to completion; INCLUDES plain 1, which
 *                round 1 reserved for warn and which is bash's own
 *                unbound-variable-under-set-u abort code)
 * Only the two `fail` cases flip sync's own exit code.
 *
 * Two teeth proofs are included:
 *  - Round 1's: the same exit-20 fixture run against the PRE-ROUND-1 run_fix
 *    (recovered from git HEAD, since round 1 was uncommitted at write time)
 *    shows the old code swallows the failure; current code does not.
 *  - Round 2's: a REAL patch_ruvector_execsafe run (sourced verbatim from
 *    fix-ruflo.sh, same extraction technique as
 *    tests/fix-ruflo-ruvector-execsafe.test.js) against the real 1/30
 *    hooks_verify anchor — a genuine PARTIAL match that genuinely increments
 *    SEVERE_ERRORS — followed by a deliberate unbound-variable reference
 *    (simulating an ordinary bug elsewhere in this 3500+-line file that never
 *    reaches the exit tail). Run against a frozen ROUND-1 snapshot of
 *    lib/sync.sh (round 1 was never committed, so it isn't reachable via git
 *    HEAD — the snapshot is embedded below as base64, captured immediately
 *    before the round-2 edit) versus the CURRENT lib/sync.sh.
 *
 * Run individually — this repo has confirmed cross-file suite interference:
 *   npx vitest run tests/sync-severity-tier.test.js
 */
'use strict';

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIB = path.resolve(__dirname, '..', 'lib');
const REPO = path.resolve(__dirname, '..');
const FIX_RUFLO_SRC = fs.readFileSync(path.join(LIB, 'fix-ruflo.sh'), 'utf8');

const stripAnsi = (s) => s.replace(/\[[0-9;]*m/g, '');

// A fix-stage stub that mimics the REAL fix-ruflo.sh shape: it prints an
// UNCONDITIONAL "Log: <path>" line as its very last statement (exactly like
// fix-ruflo.sh's `echo -e "\n  Log: $LOG_FILE"`) regardless of `code`, then
// exits with `code`. This is the literal mechanism that let a hard failure
// masquerade as a soft warning under the old grep-based grader (round 1).
function fixRufloStub(code) {
  return `#!/usr/bin/env bash
target="$1"
echo "fix-ruflo diagnostic & fix"
echo "Fixes applied:    0"
echo "Manual actions:   1"
echo -e "\\n  Log: /tmp/fix-ruflo-stub.log"
exit ${code}
`;
}

function vlStub(verdict = 'live') {
  return `#!/usr/bin/env bash
echo '{"pass":1,"warn":0,"fail":0,"info":0,"verdict":"${verdict}"}'
exit 0
`;
}

// A trivial fix stub for the OTHER three stages (never the subject under
// test here) — always clean, always exits 0.
function cleanStub(label) {
  return `#!/usr/bin/env bash
echo "${label} complete — 0 change(s)"
exit 0
`;
}

// Build a throwaway kit dir around a given sync.sh source, with common.sh
// alongside it (unmodified — sync.sh sources it for helpers like pass/warn/
// fail/header/info and kit_resolve/kit_require_target/kit_daemon_staleness).
// `fixRufloFile` lets a caller substitute a custom fix-ruflo.sh (round 2's
// real-crash reproduction) instead of the generic numeric-code stub.
function mkKit(syncShSource, fixRufloCodeOrFile) {
  const kit = fs.mkdtempSync(path.join(os.tmpdir(), 'severitykit-'));
  const lib = path.join(kit, 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.copyFileSync(path.join(LIB, 'common.sh'), path.join(lib, 'common.sh'));
  fs.writeFileSync(path.join(lib, 'sync.sh'), syncShSource);
  fs.chmodSync(path.join(lib, 'sync.sh'), 0o755);

  const fixRufloBody =
    typeof fixRufloCodeOrFile === 'string' && fixRufloCodeOrFile.startsWith('#!')
      ? fixRufloCodeOrFile // caller supplied a full script body directly
      : fixRufloStub(fixRufloCodeOrFile);

  const files = {
    'fix-ruflo.sh': fixRufloBody,
    'fix-aqe.sh': cleanStub('fix-aqe'),
    'fix-statusbar.sh': cleanStub('fix-statusbar'),
    'fix-brain.sh': cleanStub('fix-brain'),
    'verify-learning.sh': vlStub('live'),
  };
  for (const [n, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(lib, n), body);
    fs.chmodSync(path.join(lib, n), 0o755);
  }
  return kit;
}

function runSync(kit, target) {
  const r = spawnSync('bash', [path.join(kit, 'lib', 'sync.sh'), target], { encoding: 'utf8' });
  return { code: r.status, out: stripAnsi(r.stdout + r.stderr) };
}

// The PRE-ROUND-1 lib/sync.sh, recovered from git HEAD (round 1 was
// uncommitted at write time, so HEAD still holds the completion-regex bug)
// — used only to PROVE round 1's teeth (its tests must fail against it).
function preRound1SyncSh() {
  return execFileSync('git', ['show', 'HEAD:lib/sync.sh'], { cwd: REPO, encoding: 'utf8' });
}

// The POST-ROUND-1 / PRE-ROUND-2 lib/sync.sh — i.e. exactly what shipped
// after round 1 closed (warn reserved plain exit 1) and before the round-2
// EXIT-1-COLLISION-V1 fix landed. Round 1 was never committed either, so this
// is not reachable via any git ref; it's a frozen base64 snapshot captured
// from the working tree immediately before the round-2 edit, embedded as
// base64 specifically to avoid the bash `${...}` / backtick sequences in this
// file colliding with JS template-literal syntax if pasted as a template
// string. Used only to PROVE round 2's teeth (the new collision test must
// fail against this exact pre-fix contract).
const ROUND1_SYNC_SH_B64 =
  'IyEvdXNyL2Jpbi9lbnYgYmFzaApzZXQgLXVvIHBpcGVmYWlsCiMgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQojIGxpYi9zeW5jLnNoIOKAlCBvbmUtdmVyYiBIRUFMLiBSdW5zIHRoZSBmaXggY2FzY2FkZSBpbiBkZXBlbmRlbmN5IG9yZGVyIGFuZAojIHByaW50cyBhIHNpbmdsZSBzdW1tYXJ5IHRhYmxlIG9mIHdoYXQgZWFjaCBzdGFnZSBkaWQuCiMKIyAgIGJpbi9ydWZsby1raXQgc3luYyA8dGFyZ2V0PiAgICAgICAgICAgICAgIyBjb252ZXJnZSB0byBnb29kCiMgICBiaW4vcnVmbG8ta2l0IHN5bmMgPHRhcmdldD4gLS1kcnktcnVuICAgICMgc2hvdyB0aGUgcGxhbjsgY2hhbmdlIG5vdGhpbmcKIwojIE9yZGVyIChtaXJyb3JzIGFnZW50aWMta2l0J3MgYGFrIHN5bmNgIOKAlCBoZWFsIGV2ZXJ5dGhpbmcgYW4gdXBncmFkZSB3aXBlcywKIyB0aGVuIHJlLXZlcmlmeSk6IGZpeC1ydWZsbyDihpIgZml4LWFxZSDihpIgZml4LXN0YXR1c2JhciDihpIgZml4LWJyYWluIChza2lwcGVkCiMgY2xlYW5seSB3aGVuIGFic2VudCkg4oaSIHZlcmlmeS1sZWFybmluZyAocmVhZC1vbmx5LCBOT04tZmF0YWwpLiAtLWRyeS1ydW4gaXMKIyBwcm9wYWdhdGVkIHRvIGV2ZXJ5IHN0YWdlLiBFeGl0IGlzIG5vbnplcm8gd2hlbiBhIGZpeCBzdGFnZSBIQVJELWZhaWxzOiBpdAojIGVpdGhlciBkaWQgbm90IHJ1biB0byBjb21wbGV0aW9uIChjcmFzaCksIG9yIGl0IGNvbXBsZXRlZCBidXQgYSBTRUNVUklUWSBvcgojIE5BVElWRS1JTlRFR1JJVFkgcmVwYWlyIGl0c2VsZiBmYWlsZWQgKFNFVkVSRS1GSVgtVjEsIGV4aXQgY29kZSAyMCDigJQgc2VlCiMgcnVuX2ZpeCgpIGJlbG93KSDigJQgYSBzdGFnZSB0aGF0IGNvbXBsZXRlcyB3aXRoIG9ubHkgY29zbWV0aWMvbWFudWFsLWFjdGlvbgojIHdhcm5pbmdzIGlzIGEgYHdhcm5gIGFuZCBkb2VzIG5vdCBmbGlwIHRoZSBleGl0LiB2ZXJpZnktbGVhcm5pbmcncwojIHBhcnRpYWwvaG9sbG93IHZlcmRpY3QgbmV2ZXIgZmxpcHMgdGhlIGV4aXQgKGEgZnJlc2ggcHJvamVjdCBpcyBsZWdpdGltYXRlbHkKIyBob2xsb3cpLgojID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KCnNvdXJjZSAiJChkaXJuYW1lICIke0JBU0hfU09VUkNFWzBdfSIpL2NvbW1vbi5zaCIKa2l0X3Jlc29sdmUgIiRAIiAgICAgICAgICAjIHBhcnNlcyAtLWRyeS1ydW4gaW50byBEUllfUlVOIG5hdGl2ZWx5CiMgRGlzcGxheSBzdWZmaXhlcyDigJQgbXVzdCBiZSBFTVBUWSB3aGVuIGRyeS1ydW4gaXMgb2ZmLiAoQSAiOisiLXN0eWxlIHBhcmFtZXRlcgojIGV4cGFuc2lvbiBvbiBEUllfUlVOIGV4cGFuZHMgZm9yICIwIiB0b28sIHdoaWNoIG1hZGUgbGl2ZSBzdW1tYXJpZXMgY2xhaW0KIyAiKGRyeS1ydW4g4oCUIG5vIGNoYW5nZXMgbWFkZSkiOyBoZW5jZSB0aGUgZXhwbGljaXQgLWVxIDEgdGVzdC4pCl9EUllfU0ZYPSIiOyBfRFJZX1RBRz0iIgpbWyAiJERSWV9SVU4iIC1lcSAxIF1dICYmIHsgX0RSWV9TRlg9IiAoZHJ5LXJ1biDigJQgbm8gY2hhbmdlcyBtYWRlKSI7IF9EUllfVEFHPSIgKGRyeS1ydW4pIjsgfQpraXRfcmVxdWlyZV90YXJnZXQKCmVjaG8gIj09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09IgplY2hvICIgcnVmbG8ta2l0IHN5bmMiCmVjaG8gIiBraXQ6ICAgICRLSVRfRElSIgplY2hvICIgdGFyZ2V0OiAkVEFSR0VUX0RJUiIKW1sgIiREUllfUlVOIiAtZXEgMSBdXSAmJiBlY2hvICIgTU9ERTogICBkcnktcnVuIChubyBjaGFuZ2VzKSIKZWNobyAiPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0iCgpfZHJ5ZmxhZz0oKQpbWyAiJERSWV9SVU4iIC1lcSAxIF1dICYmIF9kcnlmbGFnPSgtLWRyeS1ydW4pCgojIFBhcmFsbGVsIGFycmF5cyBob2xkIGVhY2ggc3RhZ2UncyBvdXRjb21lIChiYXNoIDMuMiBoYXMgbm8gYXNzb2MgYXJyYXlzKS4KU1RBR0VfTkFNRT0oKTsgU1RBR0VfUkVTVUxUPSgpOyBTVEFHRV9DSEFOR0VTPSgpOyBTVEFHRV9ERVRBSUw9KCkKSEFSRF9GQUlMPTAKCiMgRXh0cmFjdCBhIGNoYW5nZSBjb3VudCBmcm9tIGEgc3RhZ2UncyBvdXRwdXQ6ICJjb21wbGV0ZSDigJQgTiBjaGFuZ2UocykiCiMgKGZpeC1hcWUvZml4LWJyYWluKSBvciAiRml4ZXMgYXBwbGllZDogICAgTiIgKGZpeC1ydWZsbykuICctJyB3aGVuIG5laXRoZXIuCnBhcnNlX2NoYW5nZXMoKSB7CiAgbG9jYWwgb3V0PSIkMSIgbgogIG49IiQoZ3JlcCAtb0UgJ2NvbXBsZXRlIOKAlCBbMC05XSsgY2hhbmdlJyA8PDwgIiRvdXQiIHwgZ3JlcCAtb0UgJ1swLTldKycgfCBoZWFkIC0xKSIKICBbWyAteiAiJG4iIF1dICYmIG49IiQoZ3JlcCAtRSAnRml4ZXMgYXBwbGllZDonIDw8PCAiJG91dCIgfCBncmVwIC1vRSAnWzAtOV0rJyB8IGhlYWQgLTEpIgogIFtbIC16ICIkbiIgXV0gJiYgbj0iLSIKICBlY2hvICIkbiIKfQoKcmVjb3JkKCkgewogIFNUQUdFX05BTUUrPSgiJDEiKTsgU1RBR0VfUkVTVUxUKz0oIiQyIik7IFNUQUdFX0NIQU5HRVMrPSgiJDMiKTsgU1RBR0VfREVUQUlMKz0oIiQ0IikKfQoKIyBydW5fZml4IDxsYWJlbD4gPHNjcmlwdD4KIwojIFNFVkVSRS1GSVgtVjEgZXhpdC1jb2RlIGNvbnRyYWN0ICh0aGUgT05MWSBzaWduYWwgdXNlZCB0byBncmFkZSBhIHN0YWdlIOKAlAojIG5ldmVyIHRoZSBzdGFnZSdzIHByaW50ZWQgb3V0cHV0KS4gR3JhZGluZyB1c2VkIHRvIGBncmVwYCB0aGUgdHJhbnNjcmlwdCBmb3IKIyBhICJjb21wbGV0aW9uIG1hcmtlciIgc3RyaW5nIHRvIGRpc3Rpbmd1aXNoIGEgY3Jhc2ggZnJvbSBhIGNvbXBsZXRlZC13aXRoLQojIHdhcm5pbmdzIHJ1bjsgZml4LXJ1ZmxvIHByaW50cyBhbiB1bmNvbmRpdGlvbmFsICJMb2c6IDxwYXRoPiIgbGluZSBhcyBpdHMKIyB2ZXJ5IGxhc3Qgc3RhdGVtZW50IHJlZ2FyZGxlc3Mgb2Ygb3V0Y29tZSwgc28gdGhhdCBtYXJrZXIgd2FzIHByZXNlbnQgZXZlbgojIG9uIGEgaGFyZCBmYWlsdXJlIGFuZCB0aGUgZ3JlcCBhbHdheXMgbWF0Y2hlZCDigJQgc3luYydzIG93biBleGl0IGNvZGUgY291bGQKIyBuZXZlciBmbGlwIG5vbnplcm8gbm8gbWF0dGVyIGhvdyBiYWRseSBhIGZpeCBzdGFnZSBmYWlsZWQuIEV4aXQgY29kZSBpcyBub3QKIyBzdWJqZWN0IHRvIHRoYXQ6IGEgc2NyaXB0IGNhbm5vdCBmYWJyaWNhdGUgaXRzIG93biBleGl0IHN0YXR1cyBieSBwcmludGluZwojIHRleHQsIGFuZCBhIHNjcmlwdCB0aGF0IGNyYXNoZXMgYmVmb3JlIHJlYWNoaW5nIGl0cyBpbnRlbmRlZCBgZXhpdCBOYCBjYW5ub3QKIyBwcm9kdWNlIG9uZSBvZiB0aGVzZSBjb2RlcyBieSBhY2NpZGVudCAoY2hvc2VuIG9mZiBiYXNoJ3Mgb3duIGNyYXNoLXJlbGF0ZWQKIyBjb2RlcyAxLzIvMTI2LzEyNy8xMjgrbi8xMzAgZm9yIHRoZSBzZXZlcmUgdGllciDigJQgc2VlIGJlbG93KS4KIyAgIDAgID0gb2sgICAgIOKAlCBjbGVhbiBydW4sIG5vdGhpbmcgdG8gcmV2aWV3LgojICAgMSAgPSB3YXJuICAg4oCUIGNvbXBsZXRlZCB0byB0aGUgZW5kOyBvbmx5IGNvc21ldGljL21hbnVhbC1hY3Rpb24gZHJpZnQKIyAgICAgICAgICAgICAgICAgcmVtYWlucyAocHJlLWV4aXN0aW5nIGtpdCBjb252ZW50aW9uIGZvciB0aGVzZSBzY3JpcHRzKS4KIyAgIDIwID0gZmFpbCAgIOKAlCBjb21wbGV0ZWQgdG8gdGhlIGVuZCwgYnV0IGEgU0VDVVJJVFkgb3IgTkFUSVZFLUlOVEVHUklUWQojICAgICAgICAgICAgICAgICByZXBhaXIgaXRzZWxmIGZhaWxlZCAoU0VWRVJFX0VSUk9SUz4wIOKAlCBjdXJyZW50bHkgZW1pdHRlZCBieQojICAgICAgICAgICAgICAgICBmaXgtcnVmbG8uc2ggZm9yIFJVVkVDVE9SLUVYRUNTQUZFLVYxIC8gQUdFTlREQi1ORVNURUQtTkFUSVZFLVYxKS4KIyAgICAgICAgICAgICAgICAgSGFyZC1mYWlscyBhbmQgZmxpcHMgc3luYydzIG93biBleGl0IGNvZGUuCiMgICAqICA9IGZhaWwgICDigJQgYW55IG90aGVyIG5vbnplcm8gY29kZSBtZWFucyB0aGUgc2NyaXB0IGRpZCBOT1QgcnVuIHRvCiMgICAgICAgICAgICAgICAgIGNvbXBsZXRpb24gKHN5bnRheCBlcnJvciwgdW5ib3VuZCB2YXIsIGtpbGxlZCwgLi4uKS4gQWxzbwojICAgICAgICAgICAgICAgICBoYXJkLWZhaWxzIOKAlCB0aGlzIGlzIHRoZSBjYXNlIHRoZSBvbGQgcmVnZXggZ3JhZGVyIGNvdWxkCiMgICAgICAgICAgICAgICAgIG1pc3Rha2UgZm9yIGEgc29mdCB3YXJuaW5nLgpydW5fZml4KCkgewogIGxvY2FsIGxhYmVsPSIkMSIgc2NyaXB0PSIkMiIKICBpZiBbWyAhIC1mICIkc2NyaXB0IiBdXTsgdGhlbgogICAgaW5mbyAiJGxhYmVsOiBzY3JpcHQgbm90IHByZXNlbnQg4oCUIHNraXBwaW5nIgogICAgcmVjb3JkICIkbGFiZWwiIHNraXAgIi0iICJub3QgcHJlc2VudCIKICAgIHJldHVybgogIGZpCiAgaGVhZGVyICIkbGFiZWwiICJydW5uaW5nJHtfRFJZX1RBR30iCiAgbG9jYWwgb3V0IHJjCiAgb3V0PSIkKGJhc2ggIiRzY3JpcHQiICIkVEFSR0VUX0RJUiIgJHtfZHJ5ZmxhZ1tAXSsiJHtfZHJ5ZmxhZ1tAXX0ifSAyPiYxKSI7IHJjPSQ/CiAgIyBEUllSVU4tV09VTEQtQ09VTlQtVjE6IGluIGRyeS1ydW4gZXZlcnkgc3RhZ2UgYXBwbGllcyAwIGNoYW5nZXMgYnkgZGVzaWduLAogICMgc28gdGhlIHN0YWdlJ3Mgb3duIGNoYW5nZSBjb3VudGVyIHRydXRoZnVsbHkgcmVhZHMgMCB3aGlsZSBpdHMgdHJhbnNjcmlwdCBpcwogICMgZnVsbCBvZiAiW2RyeS1ydW5dIFdvdWxkOiIgbGluZXMg4oCUIHRoZSBvbGQgc3VtbWFyeSB0aGVuIGNsYWltZWQKICAjICJjb21wbGV0ZSAoMCBjaGFuZ2UocykpIiBhZ2FpbnN0IGEgZG96ZW5zLWxpbmUgcGxhbi4gSW4gZHJ5LXJ1biwgY291bnQgdGhlCiAgIyBzdGFnZSdzIFtkcnktcnVuXSB3b3VsZC1hY3Rpb24gbGluZXMgaW5zdGVhZCBhbmQgTEFCRUwgdGhlbSBhcyB3b3VsZC1jaGFuZ2VzCiAgIyAocGVyLXN0YWdlIGxpbmUgKyBDSEFOR0VTIGNvbHVtbikuIE5vbi1kcnktcnVuIGNvdW50aW5nIGlzIHVudG91Y2hlZC4KICBsb2NhbCBjaGFuZ2VzIGNoZ19kaXNwCiAgaWYgW1sgIiREUllfUlVOIiAtZXEgMSBdXTsgdGhlbgogICAgY2hhbmdlcz0iJChncmVwIC1jICdcW2RyeS1ydW5cXScgPDw8ICIkb3V0IikiCiAgICBjaGdfZGlzcD0iJGNoYW5nZXMgd291bGQtY2hhbmdlKHMpIgogICAgY2hhbmdlcz0iJGNoYW5nZXMgd291bGQiCiAgZWxzZQogICAgY2hhbmdlcz0iJChwYXJzZV9jaGFuZ2VzICIkb3V0IikiCiAgICBjaGdfZGlzcD0iJGNoYW5nZXMgY2hhbmdlKHMpIgogIGZpCiAgY2FzZSAiJHJjIiBpbgogICAgMCkKICAgICAgcGFzcyAiJGxhYmVsIGNvbXBsZXRlICgkY2hnX2Rpc3ApIgogICAgICByZWNvcmQgIiRsYWJlbCIgb2sgIiRjaGFuZ2VzIiAiIgogICAgICA7OwogICAgMSkKICAgICAgd2FybiAiJGxhYmVsIGNvbXBsZXRlZCB3aXRoIG1hbnVhbCBhY3Rpb25zIChleGl0ICRyYykiCiAgICAgIHJlY29yZCAiJGxhYmVsIiB3YXJuICIkY2hhbmdlcyIgImV4aXQgJHJjIOKAlCBtYW51YWwgYWN0aW9ucyIKICAgICAgOzsKICAgIDIwKQogICAgICBmYWlsICIkbGFiZWw6IGEgU0VDVVJJVFkgb3IgTkFUSVZFLUlOVEVHUklUWSByZXBhaXIgZmFpbGVkIChleGl0ICRyYykiCiAgICAgIHJlY29yZCAiJGxhYmVsIiBmYWlsICIkY2hhbmdlcyIgImV4aXQgJHJjIOKAlCBzZXZlcmU6IHNlY3VyaXR5L25hdGl2ZS1pbnRlZ3JpdHkgcmVwYWlyIGZhaWxlZCIKICAgICAgSEFSRF9GQUlMPTEKICAgICAgOzsKICAgICopCiAgICAgIGZhaWwgIiRsYWJlbCBkaWQgTk9UIGNvbXBsZXRlIChleGl0ICRyYykiCiAgICAgIHJlY29yZCAiJGxhYmVsIiBmYWlsICIkY2hhbmdlcyIgImV4aXQgJHJjIOKAlCBkaWQgbm90IGNvbXBsZXRlIgogICAgICBIQVJEX0ZBSUw9MQogICAgICA7OwogIGVzYWMKfQoKcnVuX2ZpeCAiZml4LXJ1ZmxvIiAgICAgIiRLSVRfTElCL2ZpeC1ydWZsby5zaCIKcnVuX2ZpeCAiZml4LWFxZSIgICAgICAgIiRLSVRfTElCL2ZpeC1hcWUuc2giCnJ1bl9maXggImZpeC1zdGF0dXNiYXIiICIkS0lUX0xJQi9maXgtc3RhdHVzYmFyLnNoIgpydW5fZml4ICJmaXgtYnJhaW4iICAgICAiJEtJVF9MSUIvZml4LWJyYWluLnNoIgoKIyDilIDilIAgdmVyaWZ5LWxlYXJuaW5nOiByZWFkLW9ubHkgbGl2ZW5lc3MsIE5PTi1mYXRhbCAobmV2ZXIgZmxpcHMgZXhpdCkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmhlYWRlciAidmVyaWZ5LWxlYXJuaW5nIiAicmVhZC1vbmx5IGxvb3AgbGl2ZW5lc3MgKG5vbi1mYXRhbCkiCmlmIFtbIC1mICIkS0lUX0xJQi92ZXJpZnktbGVhcm5pbmcuc2giIF1dOyB0aGVuCiAgVkxfSlNPTj0iJChiYXNoICIkS0lUX0xJQi92ZXJpZnktbGVhcm5pbmcuc2giICIkVEFSR0VUX0RJUiIgLS1qc29uIDI+L2Rldi9udWxsIHwgdGFpbCAtMSkiCiAgVkxfVkVSRElDVD0iJChub2RlIC1lICJ0cnl7cHJvY2Vzcy5zdGRvdXQud3JpdGUoKEpTT04ucGFyc2UocHJvY2Vzcy5hcmd2WzFdKS52ZXJkaWN0KXx8J3Vua25vd24nKX1jYXRjaChlKXtwcm9jZXNzLnN0ZG91dC53cml0ZSgndW5rbm93bicpfSIgIiRWTF9KU09OIiAyPi9kZXYvbnVsbCB8fCBlY2hvIHVua25vd24pIgogIGNhc2UgIiRWTF9WRVJESUNUIiBpbgogICAgbGl2ZSkgICAgcGFzcyAibGVhcm5pbmcgbG9vcCBsaXZlIiA7OwogICAgcGFydGlhbCkgd2FybiAibGVhcm5pbmcgbG9vcCBwYXJ0aWFsIChub24tZmF0YWwpIiA7OwogICAgaG9sbG93KSAgd2FybiAibGVhcm5pbmcgbG9vcCBIT0xMT1cg4oCUIHJ1bjogYmluL3J1ZmxvLWtpdCBmaXgtbGVhcm5pbmcgJFRBUkdFVF9ESVIiIDs7CiAgICAqKSAgICAgICBpbmZvICJsZWFybmluZy1sb29wIHZlcmRpY3QgdW5hdmFpbGFibGUiIDs7CiAgZXNhYwogIHJlY29yZCAidmVyaWZ5LWxlYXJuaW5nIiAiJFZMX1ZFUkRJQ1QiICItIiAicmVhZC1vbmx5IChub24tZmF0YWwpIgplbHNlCiAgaW5mbyAidmVyaWZ5LWxlYXJuaW5nLnNoIG5vdCBwcmVzZW50IOKAlCBza2lwcGluZyIKICByZWNvcmQgInZlcmlmeS1sZWFybmluZyIgc2tpcCAiLSIgIm5vdCBwcmVzZW50IgpmaQoKIyDilIDilIAgU3VtbWFyeSB0YWJsZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKZWNobyAiIgplY2hvICI9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSIKZWNobyAiIHN5bmMgc3VtbWFyeSR7X0RSWV9TRlh9IgplY2hvICI9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSIKcHJpbnRmICIgICUtMTZzICUtOHMgJS05cyAlc1xuIiAiU1RBR0UiICJSRVNVTFQiICJDSEFOR0VTIiAiREVUQUlMIgpmb3IgaSBpbiAiJHshU1RBR0VfTkFNRVtAXX0iOyBkbwogIF9yPSIke1NUQUdFX1JFU1VMVFskaV19IgogIGNhc2UgIiRfciIgaW4KICAgIG9rfGxpdmUpICAgICAgICAgIF9jPSIkR1JFRU4iIDs7CiAgICB3YXJufHBhcnRpYWx8aG9sbG93KSBfYz0iJFlFTExPVyIgOzsKICAgIGZhaWwpICAgICAgICAgICAgIF9jPSIkUkVEIiA7OwogICAgKikgICAgICAgICAgICAgICAgX2M9IiRDWUFOIiA7OwogIGVzYWMKICBwcmludGYgIiAgJS0xNnMgJHtfY30lLThzJHtOQ30gJS05cyAlc1xuIiBcCiAgICAiJHtTVEFHRV9OQU1FWyRpXX0iICIkX3IiICIke1NUQUdFX0NIQU5HRVNbJGldfSIgIiR7U1RBR0VfREVUQUlMWyRpXX0iCmRvbmUKZWNobyAiIgoKIyDilIDilIAgRGFlbW9uIHN0YWxlbmVzcyAoREFFTU9OLVNUQUxFLURJU1QtVjEg4oCUIGRldGVjdGlvbi1vbmx5LCBraWxscyBub3RoaW5nKSDilIDilIAKIyBBIGRhZW1vbiB0aGF0IHN0YXJ0ZWQgQkVGT1JFIGZpeC1ydWZsbydzIG5ld2VzdCBkaXN0IHBhdGNoIGtlZXBzIHJ1bm5pbmcgdGhlCiMgcHJlLXBhdGNoIGNvZGUgZXZlbiB0aG91Z2ggdGhlIHN0YWdlIHRhYmxlIGFib3ZlIGp1c3QgcmVwb3J0ZWQgdGhlIHBhdGNoCiMgYXBwbGllZC4gU3VyZmFjZSB0aGF0IGhlcmUg4oCUIG9ubHkgd2hlbiA+PTEgZGFlbW9uIGlzIHJ1bm5pbmcgYXQgYWxsLgpfRFNUQUxFPSIkKGtpdF9kYWVtb25fc3RhbGVuZXNzKSIKaWYgW1sgLW4gIiRfRFNUQUxFIiBdXTsgdGhlbgogIGVjaG8gIiBkYWVtb24gc3RhbGVuZXNzIChkZXRlY3Rpb24tb25seSDigJQgbm90aGluZyBpcyBzdG9wcGVkIGZvciB5b3UpIgogIHdoaWxlIElGUz0gcmVhZCAtciBfZGw7IGRvIGVjaG8gIiAgJF9kbCI7IGRvbmUgPDw8ICIkX0RTVEFMRSIKICBlY2hvICIiCmZpCgppZiBbWyAiJEhBUkRfRkFJTCIgLWVxIDEgXV07IHRoZW4KICBlY2hvIC1lICIgICR7UkVEfeKclyBvbmUgb3IgbW9yZSBmaXggc3RhZ2VzIGhhcmQtZmFpbGVkJHtOQ30g4oCUIHNlZSBvdXRwdXQgYWJvdmUiCiAgZWNobyAiPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0iCiAgZXhpdCAxCmZpCmVjaG8gLWUgIiAgJHtHUkVFTn3inJMgc3luYyBjb21wbGV0ZSR7TkN9JHtfRFJZX1RBR30iCmVjaG8gIj09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09IgpleGl0IDAK';

function round1SyncSh() {
  return Buffer.from(ROUND1_SYNC_SH_B64, 'base64').toString('utf8');
}

const currentSyncSh = () => fs.readFileSync(path.join(LIB, 'sync.sh'), 'utf8');

// ── Round-2 extraction: pull the REAL patch_ruvector_execsafe verbatim out of
// fix-ruflo.sh (same technique as tests/fix-ruflo-ruvector-execsafe.test.js —
// duplicated here rather than imported, since this round's footprint is this
// one test file) ──────────────────────────────────────────────────────────
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
    if (line === '}') return out.join('\n');
  }
  throw new Error('patch_ruvector_execsafe closing brace not found');
}

const WRAPPER_FUNCTION_SRC = extractWrapperFunctionSource(FIX_RUFLO_SRC);
const HELPER_ANCHOR =
  "function sanitizeNumericArg(arg, defaultVal) {\n  const n = parseInt(arg, 10);\n  return Number.isFinite(n) && n > 0 ? n : (defaultVal || 0);\n}\n";
const REQUIRE_LINE = "const { execSync, execFileSync } = require('child_process');";

// The exact hooks_verify pair (10-space indent, byte-exact) — the single
// simplest real anchor among the 30 — so this fixture matches 1/30, exactly
// as in tests/fix-ruflo-ruvector-execsafe.test.js's own critic-finding test.
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

// Builds a real fix-ruflo.sh stand-in: sources the REAL, unmodified
// patch_ruvector_execsafe against a genuine 1/30-anchor JS fixture (a true
// PARTIAL match — SEVERE_ERRORS genuinely increments via the real code path),
// then — simulating "an ordinary bug elsewhere in this 3500+-line file" —
// references an unset variable under `set -u`, aborting the script before it
// ever reaches an intentional `exit N`. This is "the exact reproduction"
// the critic ran: a genuine severe failure immediately followed by a
// mid-script crash.
function realCrashAfterSevereFailureFixture() {
  return `#!/usr/bin/env bash
set -uo pipefail
_here="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
source "$_here/common.sh"
source "$_here/wrapper-func.sh"
DRY_RUN=0
ERRORS=0
SEVERE_ERRORS=0
FIXES=0
FIX_LOG=()
# --- REAL, unmodified fix-ruflo.sh code below (sourced verbatim above): a
# genuine 1/30 anchor match -> PARTIAL -> the real
# SEVERE_ERRORS=$(( \${SEVERE_ERRORS:-0} + 1 )) line executes for real.
patch_ruvector_execsafe "$_here/tiny-real-fixture.js"
echo "severe-errors-after-real-partial-match: $SEVERE_ERRORS" >&2
# --- Simulated ordinary bug elsewhere in the file: an unbound-variable
# reference under set -u. This must abort the script BEFORE it reaches any
# intentional exit tail (exit 20 / 21 / 0).
echo "$__this_variable_was_never_declared_anywhere_in_this_file__"
echo "UNREACHABLE — the line above must have aborted the script first"
exit 99
`;
}

function mkRealCrashKit(syncShSource) {
  const kit = fs.mkdtempSync(path.join(os.tmpdir(), 'severitykit-crash-'));
  const lib = path.join(kit, 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.copyFileSync(path.join(LIB, 'common.sh'), path.join(lib, 'common.sh'));
  fs.writeFileSync(path.join(lib, 'sync.sh'), syncShSource);
  fs.chmodSync(path.join(lib, 'sync.sh'), 0o755);
  fs.writeFileSync(path.join(lib, 'wrapper-func.sh'), WRAPPER_FUNCTION_SRC);
  fs.writeFileSync(path.join(lib, 'tiny-real-fixture.js'), tinyRealFixture());
  const files = {
    'fix-ruflo.sh': realCrashAfterSevereFailureFixture(),
    'fix-aqe.sh': cleanStub('fix-aqe'),
    'fix-statusbar.sh': cleanStub('fix-statusbar'),
    'fix-brain.sh': cleanStub('fix-brain'),
    'verify-learning.sh': vlStub('live'),
  };
  for (const [n, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(lib, n), body);
    fs.chmodSync(path.join(lib, n), 0o755);
  }
  return kit;
}

let target;
let preRound1Src;
beforeEach(() => {
  target = fs.mkdtempSync(path.join(os.tmpdir(), 'severitytgt-'));
});
afterEach(() => fs.rmSync(target, { recursive: true, force: true }));

beforeAll(() => {
  preRound1Src = preRound1SyncSh();
  // Sanity: the pre-round-1 source really does contain the smuggled-
  // completion mechanism this suite's round-1 teeth proof targets, so a
  // future refactor that removes the 'Log:' regex entirely doesn't make that
  // teeth-proof pass for the wrong reason (git HEAD not actually being the
  // buggy version any more).
  expect(preRound1Src).toMatch(/run_fix\s+"fix-ruflo"\s+"\$KIT_LIB\/fix-ruflo\.sh"\s+'Log:'/);
  // Sanity: the round-1 snapshot embedded above really does reserve plain
  // exit 1 for warn (the exact shape EXIT-1-COLLISION-V1 fixes), so the
  // round-2 teeth proof doesn't pass for the wrong reason either.
  expect(round1SyncSh()).toMatch(/^\s*1\)\s*\n\s*warn "\$label completed with manual actions/m);
  expect(currentSyncSh()).not.toMatch(/^\s*1\)\s*\n\s*warn "\$label completed with manual actions/m);
});

describe('SEVERE-FIX-V1: severity tier — CURRENT sync.sh', () => {
  it('a failed SECURITY/NATIVE-INTEGRITY repair (exit 20) makes sync exit nonzero', () => {
    const kit = mkKit(currentSyncSh(), 20);
    try {
      const { code, out } = runSync(kit, target);
      expect(code).not.toBe(0);
      expect(out).toMatch(/hard-failed/);
      expect(out).toMatch(/SECURITY or NATIVE-INTEGRITY/);
    } finally {
      fs.rmSync(kit, { recursive: true, force: true });
    }
  });

  it('cosmetic-only drift (exit 21) still warns but keeps sync at exit 0', () => {
    const kit = mkKit(currentSyncSh(), 21);
    try {
      const { code, out } = runSync(kit, target);
      expect(code).toBe(0);
      expect(out).toMatch(/manual actions/);
      expect(out).not.toMatch(/hard-failed/);
    } finally {
      fs.rmSync(kit, { recursive: true, force: true });
    }
  });

  it('a fully clean run (exit 0) stays at exit 0', () => {
    const kit = mkKit(currentSyncSh(), 0);
    try {
      const { code, out } = runSync(kit, target);
      expect(code).toBe(0);
      expect(out).toMatch(/fix-ruflo complete/);
    } finally {
      fs.rmSync(kit, { recursive: true, force: true });
    }
  });

  it('an unexpected crash code (e.g. 127) is still graded a hard fail, not a warn', () => {
    const kit = mkKit(currentSyncSh(), 127);
    try {
      const { code, out } = runSync(kit, target);
      expect(code).not.toBe(0);
      expect(out).toMatch(/hard-failed/);
    } finally {
      fs.rmSync(kit, { recursive: true, force: true });
    }
  });
});

describe('EXIT-1-COLLISION-V1 (round 2): plain exit 1 is no longer the warn code', () => {
  it('bare exit 1 (bash\'s own unbound-variable-under-set-u abort code) is graded a HARD fail under CURRENT sync.sh', () => {
    const kit = mkKit(currentSyncSh(), 1);
    try {
      const { code, out } = runSync(kit, target);
      expect(code).not.toBe(0);
      expect(out).toMatch(/hard-failed/);
      expect(out).not.toMatch(/manual actions/);
    } finally {
      fs.rmSync(kit, { recursive: true, force: true });
    }
  });

  it('sanity: an unbound-variable reference in a bash SCRIPT FILE (not `bash -c`) really does abort with exit 1 on this host — the exact shape run_fix()\'s children run in', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unbound-var-'));
    try {
      const script = path.join(tmp, 'crash.sh');
      fs.writeFileSync(script, '#!/usr/bin/env bash\nset -uo pipefail\necho "before"\necho "$never_declared_anywhere"\necho "after"\n');
      fs.chmodSync(script, 0o755);
      const r = spawnSync('bash', [script], { encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/before/);
      expect(r.stdout).not.toMatch(/after/); // aborted before reaching the next line
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('THE EXACT REPRODUCTION: a genuine SEVERE failure (real 1/30 RUVECTOR-EXECSAFE-V1 PARTIAL match) followed by a mid-script unbound-variable abort makes sync exit nonzero under CURRENT sync.sh', () => {
    const kit = mkRealCrashKit(currentSyncSh());
    try {
      const { code, out } = runSync(kit, target);
      expect(code).not.toBe(0);
      expect(out).toMatch(/hard-failed/);
      expect(out).not.toMatch(/manual actions/);
    } finally {
      fs.rmSync(kit, { recursive: true, force: true });
    }
  });

  it('TEETH: the SAME real-crash fixture is swallowed as exit 0 by the POST-ROUND-1/PRE-ROUND-2 sync.sh (bug reproduced)', () => {
    const kit = mkRealCrashKit(round1SyncSh());
    try {
      const { code, out } = runSync(kit, target);
      // This is the round-2 defect: bash's own unbound-var abort code (1)
      // collided with round 1's reserved warn value, so a genuine security
      // repair failure immediately followed by an ordinary crash is graded
      // identically to "completed cleanly, cosmetic drift only".
      expect(code).toBe(0);
      expect(out).toMatch(/manual actions/);
      expect(out).not.toMatch(/hard-failed/);
    } finally {
      fs.rmSync(kit, { recursive: true, force: true });
    }
  });
});

describe('SEVERE-FIX-V1: teeth proof — the SAME fixture against the PRE-ROUND-1 run_fix', () => {
  it('BUG REPRODUCED on pre-round-1 sync.sh: a severe (exit 20) failure is swallowed as exit 0', () => {
    const kit = mkKit(preRound1Src, 20);
    try {
      const { code, out } = runSync(kit, target);
      // This is the round-1 defect: the unconditional "Log:" line satisfies
      // the old completion regex, so a hard failure downgrades to a warning
      // and sync's own exit code stays 0.
      expect(code).toBe(0);
      expect(out).toMatch(/manual actions/);
      expect(out).not.toMatch(/hard-failed/);
    } finally {
      fs.rmSync(kit, { recursive: true, force: true });
    }
  });

  it('the CURRENT sync.sh does NOT reproduce the round-1 bug on the identical fixture', () => {
    const kit = mkKit(currentSyncSh(), 20);
    try {
      const { code } = runSync(kit, target);
      expect(code).not.toBe(0);
    } finally {
      fs.rmSync(kit, { recursive: true, force: true });
    }
  });
});

describe('SEVERE-FIX-V1: real fix-ruflo.sh emits the exit-code contract', () => {
  it('grep confirms SEVERE_ERRORS gates a distinct exit 20, separate from ERRORS-only exit 21 (not 1)', () => {
    const src = FIX_RUFLO_SRC;
    expect(src).toMatch(/SEVERE_ERRORS=0/);
    expect(src).toMatch(/if \[\[ "\$SEVERE_ERRORS" -gt 0 \]\]; then\s*\n\s*exit 20/);
    expect(src).toMatch(/elif \[\[ "\$ERRORS" -gt 0 \]\]; then\s*\n\s*exit 21/);
    expect(src).not.toMatch(/elif \[\[ "\$ERRORS" -gt 0 \]\]; then\s*\n\s*exit 1\s*\n/);
    // Both named defects from the ledger increment the severe counter. The
    // increment is deliberately NOT `((SEVERE_ERRORS++))` — see
    // fix-ruflo-ruvector-execsafe.test.js / fix-ruflo-nested-native.test.js,
    // which `source` these functions verbatim under `set -u` with only
    // ERRORS=0 predeclared; an unguarded increment would abort those extracted
    // fragments with an unbound-variable error before they ever print a
    // result. `${SEVERE_ERRORS:-0}` defaults safely either way.
    expect(src).toMatch(/RUVECTOR-EXECSAFE-V1[\s\S]{0,400}SEVERE_ERRORS=\$\(\( \$\{SEVERE_ERRORS:-0\} \+ 1 \)\)/);
    expect(src).toMatch(/AGENTDB-NESTED-NATIVE-V1|native-integrity repair failed/i);
    expect(src).not.toMatch(/\(\(SEVERE_ERRORS\+\+\)\)/);
  });
});
