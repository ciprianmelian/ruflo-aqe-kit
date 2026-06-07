#!/usr/bin/env bash
set -uo pipefail
# ============================================================================
# fix-learning.sh — populate + unlock a HOLLOW ruflo + AQE self-learning loop
# (GitHub issue #4). The encouraging finding in the audit: nearly every gap maps
# to an already-shipped command that is simply un-run or gated behind a native-
# binding flag. This orchestrates that populate/unlock chain idempotently.
#
# Order matters (steps 5+6 unlock native bindings + the HNSW flag BEFORE step 10
# trains, so adaptations actually engage instead of the JS fallback):
#   1  ruflo doctor --fix                          self-repair
#   2  aqe learning health / loop-health           read-only diagnostics (log)
#   3  ruflo hooks pretrain  (#2)                   feed structured tables
#   4  ruflo hooks build-agents (#2)               distil agent configs
#   5  aqe upgrade (#3)                             detect/recommend native bindings
#   6  aqe ruvector flags --set useNativeHNSW (#4)  enable native HNSW
#   7  aqe learning extract (#2/#4)                 mint patterns from experiences
#   8  aqe learning consolidate                     promote patterns
#   9  aqe learning dream (#10)                     spreading-activation discovery
#   10 ruflo neural train (#3)                      real MicroLoRA adaptation
#
# Every step is skip-guarded (no-op if already satisfied) and --dry-run aware.
# A missing optional subcommand is SKIPPED, never a hard failure. The daemon is
# NEVER started here (billed-LLM cost-safety — Patch 50 / opt-in only).
#
# Usage:
#   bin/ruflo-kit fix-learning <target>             # run the populate/unlock chain
#   bin/ruflo-kit fix-learning <target> --dry-run   # show intent, change nothing
#   bin/ruflo-kit fix-learning <target> --cleanup            # LIST stray stores (dry)
#   bin/ruflo-kit fix-learning <target> --cleanup --confirm  # remove strays (backed up)
#   bin/ruflo-kit fix-learning <target> -h|--help   # this help
# ============================================================================

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# Pre-strip our own flags so kit_resolve doesn't warn; forward target + --dry-run.
DO_CLEANUP=0; CONFIRM=0; FWD=()
for a in "$@"; do
  case "$a" in
    --cleanup) DO_CLEANUP=1 ;;
    --confirm) CONFIRM=1 ;;
    -h|--help) sed -n '3,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)         FWD+=("$a") ;;
  esac
done
kit_resolve ${FWD[@]+"${FWD[@]}"}
kit_require_target
cd "$TARGET_DIR"

# ── command resolution (global-first, npx fallback — mirrors init.sh) ────────
if command -v ruflo >/dev/null 2>&1; then RUFLO=(ruflo); else RUFLO=(npx -y ruflo@latest); fi
if command -v aqe   >/dev/null 2>&1; then AQE=(aqe);     else AQE=(npx -y agentic-qe@latest); fi

SWARM_DB=".swarm/memory.db"
AQE_DB=".agentic-qe/memory.db"
LORA=".swarm/lora-weights.json"
AQE_CONFIG=".agentic-qe/config.yaml"

# ── small read helpers ───────────────────────────────────────────────────────
num_or_zero() { local n="$1"; [[ "$n" =~ ^[0-9]+$ ]] && echo "$n" || echo 0; }
count_tbl() {
  local db="$1" t="$2"
  [[ -f "$db" ]] || { echo 0; return; }
  sqlite3 -readonly "$db" \
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='$t' LIMIT 1;" 2>/dev/null | grep -q 1 || { echo 0; return; }
  num_or_zero "$(sqlite3 -readonly "$db" "SELECT COUNT(*) FROM $t;" 2>/dev/null || echo 0)"
}
lora_adaptations() {
  [[ -f "$LORA" ]] || { echo 0; return; }
  node -e "try{process.stdout.write(String((require('$PWD/$LORA').stats||{}).totalAdaptations||0))}catch(e){process.stdout.write('0')}" 2>/dev/null || echo 0
}
# Does `<tool> <group> --help` advertise <sub>? (existence guard for optional subs)
sub_exists() { "$@" --help 2>&1 | grep -qE "^\s+$SUB\b"; }

# ── --confirm-gated, NON-destructive store cleanup (issue #4 gap #8) ─────────
# Canonical roots are NEVER candidates. Strays = *.db under vendor/ or .claude/
# (cwd-scatter copies). Default prints only; deletes solely with --confirm, and
# every deletion is preceded by a .cleanup-bak copy (recoverable).
cleanup_pass() {
  local confirm="$1" f c skip removed=0 found=0
  local CANON=("./agentdb.db" "./.swarm/memory.db" "./.agentic-qe/memory.db")
  header "cleanup" "stray store cleanup (canonical roots preserved)"
  kit_banner
  echo ""
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    skip=0; for c in "${CANON[@]}"; do [[ "$f" == "$c" ]] && skip=1; done
    [[ "$skip" -eq 1 ]] && continue
    found=$((found+1))
    if [[ "$confirm" -eq 1 && "${DRY_RUN:-0}" -eq 1 ]]; then
      info "[dry-run] would remove stray store: $f (after backup to $f.cleanup-bak)"
    elif [[ "$confirm" -eq 1 ]]; then
      backup "$f" "cleanup-bak"          # copy before removing (recoverable)
      rm -f "$f"
      fix "removed stray store $f (backed up to $f.cleanup-bak)"
      pass "removed stray store: $f"
      removed=$((removed+1))
    else
      warn "WOULD remove stray store: $f  (re-run with --cleanup --confirm)"
    fi
  done < <(find ./vendor ./.claude -name '*.db' -not -path '*/node_modules/*' 2>/dev/null)
  if [[ "$found" -eq 0 ]]; then
    pass "no stray stores under vendor/ or .claude/"
  elif [[ "$confirm" -eq 1 ]]; then
    pass "cleanup complete: $removed removed (backups kept)"
  else
    info "$found stray store(s) found — re-run with --cleanup --confirm to remove"
  fi
}

if [[ "$DO_CLEANUP" -eq 1 ]]; then
  cleanup_pass "$CONFIRM"
  exit 0
fi

# ── populate / unlock chain ──────────────────────────────────────────────────
header "fix-learning" "populate + unlock the self-learning loop"
kit_banner
echo ""

ACT_RUN=0; ACT_SKIPPED=0; ACT_FAILED=0
REQUIRED_FAILED=0   # only steps 3,4,6,10 flip CI exit

# step <n> <required:0|1> <skip-test-cmd-or-empty> -- <command...>
# skip-test: a command string eval'd; exit 0 == already satisfied (skip).
step() {
  local n="$1" required="$2" skiptest="$3"; shift 3
  [[ "$1" == "--" ]] && shift
  if [[ -n "$skiptest" ]] && eval "$skiptest" >/dev/null 2>&1; then
    pass "$n: already satisfied — skipping"; ACT_SKIPPED=$((ACT_SKIPPED+1)); return 0
  fi
  info "$n: running: $*"
  if run "$* >/tmp/fix-learning-$n.log 2>&1"; then
    pass "$n: done"; ACT_RUN=$((ACT_RUN+1))
  else
    warn "$n: failed (see /tmp/fix-learning-$n.log) — continuing"
    ACT_FAILED=$((ACT_FAILED+1))
    [[ "$required" -eq 1 ]] && REQUIRED_FAILED=$((REQUIRED_FAILED+1))
  fi
}

struct_rows() {
  local s=0 t
  for t in episodes skills patterns; do s=$((s + $(count_tbl "$SWARM_DB" "$t"))); done
  echo "$s"
}

# 1 — self-repair (cheap, idempotent; always run)
step 1 0 "" -- "${RUFLO[@]}" doctor --fix

# 2 — read-only learning diagnostics (never counts as failure; log only)
step 2 0 "" -- "${AQE[@]}" learning loop-health

# 3 — pretrain: feed the structured tables (#2). Skip if already populated.
step 3 1 '[[ "$(struct_rows)" -gt 0 ]]' -- "${RUFLO[@]}" hooks pretrain -p . --depth shallow --with-embeddings

# 4 — build-agents: distil agent configs from pretrain data (#2).
step 4 1 '[[ "$(struct_rows)" -gt 0 ]]' -- "${RUFLO[@]}" hooks build-agents

# 5 — native-binding detection (#3). Skip if adaptations already engaged.
step 5 0 '[[ "$(lora_adaptations)" -gt 0 ]]' -- "${AQE[@]}" upgrade

# 6 — enable native HNSW flag (#4). Skip if config already carries it.
step 6 1 'grep -q useNativeHNSW "'"$AQE_CONFIG"'"' -- "${AQE[@]}" ruvector flags --set useNativeHNSW=true

# 7 — extract patterns from experiences (#2/#4). Idempotent; always run.
step 7 0 "" -- "${AQE[@]}" learning extract

# 8 — consolidate/promote patterns (optional; skip if subcommand absent).
SUB=consolidate
if sub_exists "${AQE[@]}" learning; then
  step 8 0 "" -- "${AQE[@]}" learning consolidate
else
  pass "8: 'aqe learning consolidate' unavailable — skipping"; ACT_SKIPPED=$((ACT_SKIPPED+1))
fi

# 9 — dream-cycle discovery (#10) (optional; skip if subcommand absent).
SUB=dream
if sub_exists "${AQE[@]}" learning; then
  step 9 0 "" -- "${AQE[@]}" learning dream
else
  pass "9: 'aqe learning dream' unavailable — skipping"; ACT_SKIPPED=$((ACT_SKIPPED+1))
fi

# 10 — real MicroLoRA adaptation (#3). Skip if the trainer is already engaged.
step 10 1 '[[ "$(lora_adaptations)" -gt 0 ]]' -- "${RUFLO[@]}" neural train -p coordination -e 50 --wasm --flash --contrastive

echo ""
echo "  Summary: $ACT_RUN run, $ACT_SKIPPED skipped, $ACT_FAILED failed"
info "verify with: bin/ruflo-kit verify-learning $TARGET_DIR"

# Exit 1 only when a REQUIRED step (3,4,6,10) hard-failed, so CI surfaces a real
# stall; optional/diagnostic steps never flip the exit code.
[[ "$REQUIRED_FAILED" -gt 0 ]] && exit 1
exit 0
