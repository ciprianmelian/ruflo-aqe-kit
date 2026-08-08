#!/usr/bin/env bash
set -uo pipefail
# ============================================================================
# lib/sync.sh — one-verb HEAL. Runs the fix cascade in dependency order and
# prints a single summary table of what each stage did.
#
#   bin/ruflo-kit sync <target>              # converge to good
#   bin/ruflo-kit sync <target> --dry-run    # show the plan; change nothing
#
# Order (mirrors agentic-kit's `ak sync` — heal everything an upgrade wipes,
# then re-verify): fix-ruflo → fix-aqe → fix-statusbar → fix-brain (skipped
# cleanly when absent) → verify-learning (read-only, NON-fatal). --dry-run is
# propagated to every stage. Exit is nonzero when a fix stage HARD-fails: it
# either did not run to completion (crash), or it completed but a SECURITY or
# NATIVE-INTEGRITY repair itself failed (SEVERE-FIX-V1, exit code 20 — see
# run_fix() below) — a stage that completes with only cosmetic/manual-action
# warnings is a `warn` and does not flip the exit. verify-learning's
# partial/hollow verdict never flips the exit (a fresh project is legitimately
# hollow).
# ============================================================================

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
kit_resolve "$@"          # parses --dry-run into DRY_RUN natively
# Display suffixes — must be EMPTY when dry-run is off. (A ":+"-style parameter
# expansion on DRY_RUN expands for "0" too, which made live summaries claim
# "(dry-run — no changes made)"; hence the explicit -eq 1 test.)
_DRY_SFX=""; _DRY_TAG=""
[[ "$DRY_RUN" -eq 1 ]] && { _DRY_SFX=" (dry-run — no changes made)"; _DRY_TAG=" (dry-run)"; }
kit_require_target

echo "============================================"
echo " ruflo-kit sync"
echo " kit:    $KIT_DIR"
echo " target: $TARGET_DIR"
[[ "$DRY_RUN" -eq 1 ]] && echo " MODE:   dry-run (no changes)"
echo "============================================"

_dryflag=()
[[ "$DRY_RUN" -eq 1 ]] && _dryflag=(--dry-run)

# Parallel arrays hold each stage's outcome (bash 3.2 has no assoc arrays).
STAGE_NAME=(); STAGE_RESULT=(); STAGE_CHANGES=(); STAGE_DETAIL=()
HARD_FAIL=0

# Extract a change count from a stage's output: "complete — N change(s)"
# (fix-aqe/fix-brain) or "Fixes applied:    N" (fix-ruflo). '-' when neither.
#
# PARSE-CHANGES-ANSI-V1: strip ANSI SGR escapes BEFORE extracting digits.
# fix-ruflo prints its count COLOURED — the literal bytes are
# `Fixes applied:    <ESC>[0;32m1<ESC>[0m` — so the old
# `grep -oE '[0-9]+' | head -1` matched the **0 inside the colour code**
# `[0;32m` and never reached the count. sync therefore reported fix-ruflo as
# "0 change(s)" ALWAYS, regardless of how much work it did.
#
# Observed live on the 3.33.0 -> 3.34.0 upgrade: the bump wiped all 5 dist
# sentinels + the nested agentdb pin, fix-ruflo re-applied every one of them,
# and sync printed "fix-ruflo ok 0". That is the single moment an operator MOST
# needs to know work happened — a bare "0 changes" reads as "the bump disturbed
# nothing", the exact opposite of the truth.
#
# The first branch was never affected: `complete — [0-9]+ change` anchors on
# literal text, so the captured substring contains only the real number. Only
# the `Fixes applied:` fallback was reachable by the bug — but the strip is
# applied to the whole input so a future coloured `complete —` line cannot
# reintroduce it.
#
# BSD sed (macOS) does not honour `\x1b`; the ESC byte is embedded via bash
# ANSI-C quoting ($'...') so this works on both BSD and GNU sed.
parse_changes() {
  local out n
  # shellcheck disable=SC2001  # ${var//glob/} cannot express [0-9;]*[A-Za-z];
  # doing it with globs needs `shopt -s extglob` plus *([0-9;]), which is both
  # less readable and a shell-option side effect inside a helper. sed is right.
  out="$(sed $'s/\033\\[[0-9;]*[A-Za-z]//g' <<< "$1")"
  n="$(grep -oE 'complete — [0-9]+ change' <<< "$out" | grep -oE '[0-9]+' | head -1)"
  [[ -z "$n" ]] && n="$(grep -E 'Fixes applied:' <<< "$out" | grep -oE '[0-9]+' | head -1)"
  [[ -z "$n" ]] && n="-"
  echo "$n"
}

record() {
  STAGE_NAME+=("$1"); STAGE_RESULT+=("$2"); STAGE_CHANGES+=("$3"); STAGE_DETAIL+=("$4")
}

# run_fix <label> <script>
#
# SEVERE-FIX-V1 exit-code contract (the ONLY signal used to grade a stage —
# never the stage's printed output). Grading used to `grep` the transcript for
# a "completion marker" string to distinguish a crash from a completed-with-
# warnings run; fix-ruflo prints an unconditional "Log: <path>" line as its
# very last statement regardless of outcome, so that marker was present even
# on a hard failure and the grep always matched — sync's own exit code could
# never flip nonzero no matter how badly a fix stage failed.
#   0  = ok     — clean run, nothing to review.
#   21 = warn   — completed to the end; only cosmetic/manual-action drift
#                 remains (pre-existing kit convention for these scripts).
#   20 = fail   — completed to the end, but a SECURITY or NATIVE-INTEGRITY
#                 repair itself failed (SEVERE_ERRORS>0 — currently emitted by
#                 fix-ruflo.sh for RUVECTOR-EXECSAFE-V1 / AGENTDB-NESTED-NATIVE-V1).
#                 Hard-fails and flips sync's own exit code.
#   *  = fail   — any other nonzero code (including 1, 2, 126, 127, 128+n, 130)
#                 means the script did NOT run to completion (syntax error,
#                 unbound var, killed, ...). Also hard-fails.
#
# EXIT-1-COLLISION-V1 (round 2): this contract originally reserved exit 1 for
# `warn`. That collided with reality: fix-ruflo.sh (and the other fix-*.sh
# stages) run under `set -uo pipefail` with `-e` deliberately omitted, and on
# this kit's target bash, a script FILE (not `bash -c`) that references an
# unset variable anywhere under `set -u` aborts with exit status 1 — verified
# directly. So a genuine mid-script crash (e.g. one occurring AFTER a real
# SEVERE_ERRORS-incrementing failure had already run) was graded identically
# to "completed cleanly, cosmetic drift only" — the same class of defect this
# contract exists to close, recurring through the exit code instead of the
# output text. Fixed by moving `warn` off of 1 entirely, onto 21 — chosen, like
# 20, from outside bash's whole crash-code family (1, 2, 126, 127, 128+n, 130),
# so neither reserved value can ever be produced by an accidental abort. Any
# code that isn't 0/20/21 — including plain 1 — is now unambiguously a hard
# fail, whether it came from an intentional early-exit or a genuine crash.
# SEVERE-FIX-V1 exit contract, SHARED BY ALL FOUR fix-*.sh stages:
#   0  = clean
#   21 = warn — completed, cosmetic/manual-action drift only (ERRORS>0, SEVERE_ERRORS==0)
#   20 = severe — a SECURITY or NATIVE-INTEGRITY repair failed (SEVERE_ERRORS>0)
#   anything else (incl. plain 1) = did not run to completion -> hard fail
# The warn code is 21, NOT 1, deliberately: these stages run `set -uo pipefail`
# WITHOUT -e, and an unbound-variable reference aborts a script FILE with exit 1
# (`bash -c` gives 127 — the file form is what run_fix uses). Reserving 1 for
# "graceful warn" therefore made an accidental mid-script abort indistinguishable
# from a clean cosmetic run, so a genuinely failed security repair graded as a
# soft warning and sync still exited 0. 20/21 sit outside bash's whole crash-code
# family (1, 2, 126, 127, 128+n, 130), making this a whitelist: unrecognised
# means failed, which is the safe direction.
# NOTE for future contributors: today only fix-ruflo.sh emits 20/21 deliberately —
# fix-aqe.sh, fix-statusbar.sh and fix-brain.sh carry no bash-level `exit N` and
# fall through to 0. If you add a graceful warn to any of them, use 21. Reaching
# for `exit 1` out of habit would be misgraded here as "did not complete".
run_fix() {
  local label="$1" script="$2"; shift 2
  # Remaining args are stage-specific extra flags (e.g. fix-ruflo's
  # --vendor-plugins / --no-disable-originals — Patch 83).
  if [[ ! -f "$script" ]]; then
    info "$label: script not present — skipping"
    record "$label" skip "-" "not present"
    return
  fi
  header "$label" "running${_DRY_TAG}"
  local out rc
  out="$(bash "$script" "$TARGET_DIR" ${_dryflag[@]+"${_dryflag[@]}"} "$@" 2>&1)"; rc=$?
  # DRYRUN-WOULD-COUNT-V1: in dry-run every stage applies 0 changes by design,
  # so the stage's own change counter truthfully reads 0 while its transcript is
  # full of "[dry-run] Would:" lines — the old summary then claimed
  # "complete (0 change(s))" against a dozens-line plan. In dry-run, count the
  # stage's [dry-run] would-action lines instead and LABEL them as would-changes
  # (per-stage line + CHANGES column). Non-dry-run counting is untouched.
  local changes chg_disp
  if [[ "$DRY_RUN" -eq 1 ]]; then
    changes="$(grep -c '\[dry-run\]' <<< "$out")"
    chg_disp="$changes would-change(s)"
    changes="$changes would"
  else
    changes="$(parse_changes "$out")"
    chg_disp="$changes change(s)"
  fi
  case "$rc" in
    0)
      pass "$label complete ($chg_disp)"
      record "$label" ok "$changes" ""
      ;;
    21)
      warn "$label completed with manual actions (exit $rc)"
      record "$label" warn "$changes" "exit $rc — manual actions"
      ;;
    20)
      fail "$label: a SECURITY or NATIVE-INTEGRITY repair failed (exit $rc)"
      record "$label" fail "$changes" "exit $rc — severe: security/native-integrity repair failed"
      HARD_FAIL=1
      ;;
    *)
      fail "$label did NOT complete (exit $rc)"
      record "$label" fail "$changes" "exit $rc — did not complete"
      HARD_FAIL=1
      ;;
  esac
}

# Patch 83: --vendor-plugins / --no-disable-originals propagate to the
# fix-ruflo stage only (Step 5n is the sole consumer; other stages would
# warn on unknown flags via kit_resolve).
_vendorflags=()
[[ "${VENDOR_PLUGINS:-0}" -eq 1 ]] && _vendorflags+=(--vendor-plugins)
[[ "${NO_DISABLE_ORIGINALS:-0}" -eq 1 ]] && _vendorflags+=(--no-disable-originals)
run_fix "fix-ruflo"     "$KIT_LIB/fix-ruflo.sh" ${_vendorflags[@]+"${_vendorflags[@]}"}
run_fix "fix-aqe"       "$KIT_LIB/fix-aqe.sh"
run_fix "fix-statusbar" "$KIT_LIB/fix-statusbar.sh"
run_fix "fix-brain"     "$KIT_LIB/fix-brain.sh"

# ── verify-learning: read-only liveness, NON-fatal (never flips exit) ────────
header "verify-learning" "read-only loop liveness (non-fatal)"
if [[ -f "$KIT_LIB/verify-learning.sh" ]]; then
  # VL-DRYRUN-FORWARD-V1: verify-learning runs as a separate bash process, so it
  # cannot inherit $DRY_RUN — the flag must be forwarded explicitly or the stage
  # runs live during `sync --dry-run`. It used not to be, which is why a dry run
  # still left `.agentic-qe/` behind (created as an upstream side effect of the
  # `aqe ruvector status` probe). Reuses the same _dryflag array run_fix passes.
  VL_JSON="$(bash "$KIT_LIB/verify-learning.sh" "$TARGET_DIR" --json ${_dryflag[@]+"${_dryflag[@]}"} 2>/dev/null | tail -1)"
  VL_VERDICT="$(node -e "try{process.stdout.write((JSON.parse(process.argv[1]).verdict)||'unknown')}catch(e){process.stdout.write('unknown')}" "$VL_JSON" 2>/dev/null || echo unknown)"
  case "$VL_VERDICT" in
    live)    pass "learning loop live" ;;
    partial) warn "learning loop partial (non-fatal)" ;;
    hollow)  warn "learning loop HOLLOW — run: bin/ruflo-kit fix-learning $TARGET_DIR" ;;
    *)       info "learning-loop verdict unavailable" ;;
  esac
  record "verify-learning" "$VL_VERDICT" "-" "read-only (non-fatal)"
else
  info "verify-learning.sh not present — skipping"
  record "verify-learning" skip "-" "not present"
fi

# ── Summary table ────────────────────────────────────────────────────────────
echo ""
echo "============================================"
echo " sync summary${_DRY_SFX}"
echo "============================================"
printf "  %-16s %-8s %-9s %s\n" "STAGE" "RESULT" "CHANGES" "DETAIL"
for i in "${!STAGE_NAME[@]}"; do
  _r="${STAGE_RESULT[$i]}"
  case "$_r" in
    ok|live)          _c="$GREEN" ;;
    warn|partial|hollow) _c="$YELLOW" ;;
    fail)             _c="$RED" ;;
    *)                _c="$CYAN" ;;
  esac
  printf "  %-16s ${_c}%-8s${NC} %-9s %s\n" \
    "${STAGE_NAME[$i]}" "$_r" "${STAGE_CHANGES[$i]}" "${STAGE_DETAIL[$i]}"
done
echo ""

# ── Daemon staleness (DAEMON-STALE-DIST-V1 — detection-only, kills nothing) ──
# A daemon that started BEFORE fix-ruflo's newest dist patch keeps running the
# pre-patch code even though the stage table above just reported the patch
# applied. Surface that here — only when >=1 daemon is running at all.
_DSTALE="$(kit_daemon_staleness)"
if [[ -n "$_DSTALE" ]]; then
  echo " daemon staleness (detection-only — nothing is stopped for you)"
  while IFS= read -r _dl; do echo "  $_dl"; done <<< "$_DSTALE"
  echo ""
fi

if [[ "$HARD_FAIL" -eq 1 ]]; then
  echo -e "  ${RED}✗ one or more fix stages hard-failed${NC} — see output above"
  echo "============================================"
  exit 1
fi
echo -e "  ${GREEN}✓ sync complete${NC}${_DRY_TAG}"
echo "============================================"
exit 0
