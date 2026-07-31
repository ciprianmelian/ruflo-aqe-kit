#!/usr/bin/env bash
set -uo pipefail
# ============================================================================
# lib/adopt.sh — ADOPT verb (MEMORY-PRESERVE-PROOF-V1). The A1b adoption flow
# as ONE verb, with a machine-verified preservation receipt:
#
#   snapshot (WAL-safe backup + per-table row-count baseline, lib/snapshot.sh)
#     → setup on the target WITHOUT --force (lib/setup.sh)
#     → recount every baselined table
#     → diff vs the baseline → preservation table (before -> after, delta)
#     → verdict PRESERVED (no table shrank) / VIOLATED (any shrink; exit 2)
#
# Overall exit = setup's proof verdict AND the preservation verdict:
#   0  setup PROVED and no table shrank
#   2  preservation VIOLATED (a baselined table shrank) — takes precedence
#   3  preservation NOT ASSESSABLE — the baseline (or a live recount) had an
#      unusable/unreadable store; this is NOT graded PRESERVED (F8: an empty
#      or unreadable count set is not evidence that nothing shrank)
#   *  otherwise setup's own exit code
#
# Usage:
#   bin/ruflo-kit adopt <target>                # full flow
#   bin/ruflo-kit adopt <target> --dry-run      # propagates to snapshot + setup
#   bin/ruflo-kit adopt <target> --verify-only  # recount + diff vs the existing
#                                               # baseline only (no snapshot/setup)
#   bin/ruflo-kit adopt <target> -h|--help      # this help
#
# adopt REFUSES --force: the whole point is that adoption never resets an
# existing target's learning stores.
# ============================================================================

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# Pre-strip adopt-only flags so kit_resolve doesn't warn on them (fix-brain idiom).
VERIFY_ONLY=0; _KR_ARGS=()
for _a in "$@"; do
  case "$_a" in
    --verify-only) VERIFY_ONLY=1 ;;
    *)             _KR_ARGS+=("$_a") ;;
  esac
done
kit_resolve ${_KR_ARGS[@]+"${_KR_ARGS[@]}"}
[[ "$KIT_WANT_HELP" -eq 1 ]] && { sed -n '3,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

if [[ "$FORCE" -eq 1 ]]; then
  fail "adopt refuses --force: MEMORY-PRESERVE-PROOF-V1 exists to guarantee an adoption never resets the target's learning stores."
  info "If you explicitly intend a destructive re-init, that is 'ruflo-kit init <target> --force' — a different verb, deliberately."
  exit 1
fi

kit_require_target
BASELINE="$TARGET_DIR/.claude-flow/data/adoption-baseline.json"

# ── Preservation diff (the receipt) ──────────────────────────────────────────
# Reads the baseline pointer, recounts every baselined table via kit_sqlite_ro
# (a missing db/table recounts as 0 — that IS a shrink if it had rows), prints
# the preservation table, and sets PRESERVE_VERDICT=PRESERVED|VIOLATED|
# NOT ASSESSABLE. Returns 0 PRESERVED / 1 VIOLATED / 2 no-baseline (usage
# error) / 3 NOT ASSESSABLE. Testable standalone via --verify-only.
#
# F8 fix (both directions of the vacuous-receipt hole):
#   (a) baseline-side: snapshot.sh (Patch B7) now marks a store UNREADABLE in
#       the baseline instead of writing an empty "{}" when its enumeration
#       failed. Any store so marked means the baseline cannot certify that
#       store never shrank — this must NOT read as "fresh target, nothing can
#       shrink" and must NOT be graded PRESERVED.
#   (b) recount-side: a single failed recount query used to default `after` to
#       0, which reads as a full shrink of a real store — a false VIOLATED on
#       a momentary/transient failure. Now: retry once, and if still unusable
#       mark that table UNREADABLE-THIS-INSTANT rather than 0 — it is excluded
#       from the shrink comparison and instead forces NOT ASSESSABLE (never a
#       silent pass, never a false violation).
PRESERVE_VERDICT=""
preservation_diff() {
  local baseline="$1" shrank=0 rows=0 unassessable=0
  [[ -f "$baseline" ]] || { fail "no adoption baseline at $baseline — run 'ruflo-kit snapshot' (or full 'adopt') first"; return 2; }
  header "receipt" "preservation diff vs $baseline"
  printf "  %-28s %-28s %10s -> %-10s %s\n" "STORE" "TABLE" "BEFORE" "AFTER" "DELTA"
  local kind store tbl before after delta sign tq
  local -a baseline_unreadable=()
  while IFS=$'\t' read -r kind store tbl before; do
    [[ -z "$kind" ]] && continue
    if [[ "$kind" == "UNREADABLE" ]]; then
      baseline_unreadable+=("$store")
      continue
    fi
    [[ -z "$store" ]] && continue
    rows=$((rows + 1))
    tq="$(printf '%s' "$tbl" | sed 's/"/""/g')"
    if [[ ! -f "$TARGET_DIR/$store" ]]; then
      # Genuinely gone — this IS real shrinkage if it had rows (deliberate:
      # the comment this replaces already called this out as intentional).
      after=0
    else
      after="$(kit_sqlite_ro "$TARGET_DIR/$store" "SELECT COUNT(*) FROM \"$tq\";" 2>/dev/null | head -1)"
      if [[ ! "$after" =~ ^[0-9]+$ ]]; then
        after="$(kit_sqlite_ro "$TARGET_DIR/$store" "SELECT COUNT(*) FROM \"$tq\";" 2>/dev/null | head -1)"   # retry once
      fi
      if [[ ! "$after" =~ ^[0-9]+$ ]]; then
        unassessable=$((unassessable + 1))
        printf "  %-28s %-28s %10s -> %-10s %s\n" "$store" "$tbl" "$before" "UNREADABLE" "not assessable (recount failed twice; db present)"
        continue
      fi
    fi
    delta=$((after - before))
    sign="+"; [[ "$delta" -lt 0 ]] && sign=""
    if [[ "$after" -lt "$before" ]]; then
      shrank=1
      printf "  %-28s %-28s %10s -> %-10s ${RED}%s%s  SHRANK${NC}\n" "$store" "$tbl" "$before" "$after" "$sign" "$delta"
    else
      printf "  %-28s %-28s %10s -> %-10s %s%s\n" "$store" "$tbl" "$before" "$after" "$sign" "$delta"
    fi
  done < <(node -e '
    const fs = require("fs");
    const b = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const s of (b.unreadableStores || [])) console.log("UNREADABLE\t" + s + "\t\t");
    for (const [store, tables] of Object.entries(b.counts || {})) {
      if (typeof tables !== "object" || tables === null) continue;   // e.g. "UNREADABLE" marker string
      for (const [t, n] of Object.entries(tables))
        console.log("TABLE\t" + store + "\t" + t + "\t" + n);
    }
  ' "$baseline" 2>/dev/null)

  if [[ "${#baseline_unreadable[@]}" -gt 0 ]]; then
    for s in "${baseline_unreadable[@]}"; do
      warn "baseline marks '$s' UNREADABLE at snapshot time (enumeration failed) — preservation for this store is NOT ASSESSABLE, not assumed fine"
    done
  fi
  echo ""
  if [[ "$shrank" -eq 1 ]]; then
    PRESERVE_VERDICT="VIOLATED"
    fail "MEMORY-PRESERVE-PROOF-V1: VIOLATED — at least one baselined table shrank"
    return 1
  fi
  if [[ "${#baseline_unreadable[@]}" -gt 0 || "$unassessable" -gt 0 ]]; then
    PRESERVE_VERDICT="NOT ASSESSABLE"
    warn "MEMORY-PRESERVE-PROOF-V1: NOT ASSESSABLE — ${#baseline_unreadable[@]} baseline store(s) unreadable at snapshot time + $unassessable table(s) unreadable on recount. No shrink was OBSERVED, but this is not the same as PRESERVED — re-run 'ruflo-kit snapshot' when the enumeration issue clears, then re-verify."
    return 3
  fi
  # Only claim "fresh target, nothing can shrink" when we positively know
  # there were zero baselined tables AND nothing was unreadable — not merely
  # because the loop above never incremented `rows` (F8: those are different
  # states and used to be conflated).
  [[ "$rows" -eq 0 ]] && info "baseline holds no table counts (fresh target — no learning stores existed at snapshot time) — nothing can shrink"
  PRESERVE_VERDICT="PRESERVED"
  pass "MEMORY-PRESERVE-PROOF-V1: PRESERVED — no baselined table shrank"
  return 0
}

# ── --verify-only: just the recount + diff (used by tests and re-checks) ─────
if [[ "$VERIFY_ONLY" -eq 1 ]]; then
  echo "============================================"
  echo " ruflo-kit adopt --verify-only (MEMORY-PRESERVE-PROOF-V1)"
  kit_banner
  echo "============================================"
  preservation_diff "$BASELINE"; rc=$?
  [[ "$rc" -eq 2 ]] && exit 1     # no baseline — usage error, not a violation
  [[ "$rc" -eq 1 ]] && exit 2     # VIOLATED
  [[ "$rc" -eq 3 ]] && exit 3     # NOT ASSESSABLE
  exit 0
fi

# ── Full adoption flow ───────────────────────────────────────────────────────
_dryflag=()
[[ "$DRY_RUN" -eq 1 ]] && _dryflag=(--dry-run)

echo "============================================"
echo " ruflo-kit adopt (MEMORY-PRESERVE-PROOF-V1)"
kit_banner
echo "============================================"

header "A1" "snapshot (baseline receipt)"
if ! bash "$KIT_LIB/snapshot.sh" "$TARGET_DIR" ${_dryflag[@]+"${_dryflag[@]}"}; then
  fail "snapshot failed — refusing to run setup without a baseline receipt"
  exit 1
fi

header "A2" "setup (never --force)"
bash "$KIT_LIB/setup.sh" "$TARGET_DIR" ${_dryflag[@]+"${_dryflag[@]}"}
SETUP_RC=$?
if [[ "$SETUP_RC" -eq 0 ]]; then
  pass "setup complete (proof verdict: exit 0)"
else
  warn "setup exited $SETUP_RC (proof did not PROVE) — preservation is still checked"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  info "[dry-run] skipping recount + preservation diff (no baseline was written)"
  exit "$SETUP_RC"
fi

header "A3" "recount + preservation verdict"
preservation_diff "$BASELINE"; DIFF_RC=$?
[[ "$DIFF_RC" -eq 2 ]] && exit 1   # snapshot said ok but baseline is missing — hard error

# ── A4: capture-hook parity (INFLOW-LIVENESS-V1, Patch 67) ──────────────────
# Preservation proves no store SHRANK — it cannot prove the pool still GROWS.
# If the target accumulated captured_experiences under a pre-adoption hook set
# that a later `--force` re-init clobbered, adoption inherits a FROZEN pool
# with zero symptoms (observed on the adopted Rust workflow-platform target
# 2026-07-19/20). Non-fatal: adoption
# preserved memory correctly; this surfaces the pre-existing dead arm loudly.
header "A4" "capture-hook parity (inflow liveness)"
CAPTURE_PARITY="wired"
_pool="$(kit_sqlite_ro "$TARGET_DIR/.agentic-qe/memory.db" \
  "SELECT COUNT(*) FROM captured_experiences;" 2>/dev/null | head -1)"
[[ "$_pool" =~ ^[0-9]+$ ]] || _pool=0
_cli_rows="$(kit_sqlite_ro "$TARGET_DIR/.agentic-qe/memory.db" \
  "SELECT COUNT(*) FROM captured_experiences WHERE source LIKE 'cli-hook-%';" 2>/dev/null | head -1)"
[[ "$_cli_rows" =~ ^[0-9]+$ ]] || _cli_rows=0
if kit_aqe_capture_wired "$TARGET_DIR"; then
  pass "aqe capture hooks present in .claude/settings.json (pool: $_pool experience(s))"
elif [[ "$_cli_rows" -gt 0 ]]; then
  CAPTURE_PARITY="UNWIRED"
  warn "capture arm UNWIRED: $_cli_rows hook-captured experience(s) exist but the hook set that captured them is GONE from .claude/settings.json — the pool is frozen and harvests will replay nothing new. Restore the stock aqe hook set, then: ruflo-kit fix-aqe $TARGET_DIR"
elif [[ "$_pool" -gt 0 ]]; then
  CAPTURE_PARITY="middleware-only"
  info "pool has $_pool experience(s), none hook-originated (middleware/fleet capture) — no Claude-session capture hook wired"
else
  CAPTURE_PARITY="none"
  info "no capture hooks and empty pool — AQE capture was never configured here"
fi

echo ""
echo "============================================"
echo " adopt summary"
echo "============================================"
echo "  setup/proof:  $([[ "$SETUP_RC" -eq 0 ]] && echo "PROVED (exit 0)" || echo "NOT PROVED (exit $SETUP_RC)")"
echo "  preservation: ${PRESERVE_VERDICT}"
echo "  capture arm:  ${CAPTURE_PARITY}"
echo ""

# Overall exit: VIOLATED dominates (exit 2), then NOT ASSESSABLE (exit 3);
# else setup's proof verdict.
[[ "$DIFF_RC" -eq 1 ]] && exit 2
[[ "$DIFF_RC" -eq 3 ]] && exit 3
exit "$SETUP_RC"
