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
# propagated to every stage. Exit is nonzero ONLY when a fix stage HARD-fails
# (present but did not run to completion) — a stage that completes with manual-
# action warnings is a `warn`, and verify-learning's partial/hollow verdict
# never flips the exit (a fresh project is legitimately hollow).
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
parse_changes() {
  local out="$1" n
  n="$(grep -oE 'complete — [0-9]+ change' <<< "$out" | grep -oE '[0-9]+' | head -1)"
  [[ -z "$n" ]] && n="$(grep -E 'Fixes applied:' <<< "$out" | grep -oE '[0-9]+' | head -1)"
  [[ -z "$n" ]] && n="-"
  echo "$n"
}

record() {
  STAGE_NAME+=("$1"); STAGE_RESULT+=("$2"); STAGE_CHANGES+=("$3"); STAGE_DETAIL+=("$4")
}

# run_fix <label> <script> <completion-regex>
# ok   = exit 0. warn = nonzero exit BUT the completion marker printed (ran to
# the end; the nonzero is manual-actions, not a crash). fail = nonzero AND no
# completion marker (hard failure) → flips the sync exit code.
run_fix() {
  local label="$1" script="$2" complete_re="$3"
  if [[ ! -f "$script" ]]; then
    info "$label: script not present — skipping"
    record "$label" skip "-" "not present"
    return
  fi
  header "$label" "running${_DRY_TAG}"
  local out rc
  out="$(bash "$script" "$TARGET_DIR" ${_dryflag[@]+"${_dryflag[@]}"} 2>&1)"; rc=$?
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
  if [[ "$rc" -eq 0 ]]; then
    pass "$label complete ($chg_disp)"
    record "$label" ok "$changes" ""
  elif grep -qE "$complete_re" <<< "$out"; then
    warn "$label completed with manual actions (exit $rc)"
    record "$label" warn "$changes" "exit $rc — manual actions"
  else
    fail "$label did NOT complete (exit $rc)"
    record "$label" fail "$changes" "exit $rc — did not complete"
    HARD_FAIL=1
  fi
}

run_fix "fix-ruflo"     "$KIT_LIB/fix-ruflo.sh"     'Log:'
run_fix "fix-aqe"       "$KIT_LIB/fix-aqe.sh"       'fix-aqe complete'
run_fix "fix-statusbar" "$KIT_LIB/fix-statusbar.sh" 'Restart Claude Code|statusline'
run_fix "fix-brain"     "$KIT_LIB/fix-brain.sh"     'fix-brain complete'

# ── verify-learning: read-only liveness, NON-fatal (never flips exit) ────────
header "verify-learning" "read-only loop liveness (non-fatal)"
if [[ -f "$KIT_LIB/verify-learning.sh" ]]; then
  VL_JSON="$(bash "$KIT_LIB/verify-learning.sh" "$TARGET_DIR" --json 2>/dev/null | tail -1)"
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
