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

# Pre-flight: a running daemon holds the DBs (its writers lock the AQE store, so
# the dream step fails "database is locked") and caches state in memory, so the
# results of this run won't show until the daemon + Claude Code restart.
if command -v ruflo >/dev/null 2>&1 && ruflo daemon status 2>/dev/null | grep -qiE 'RUNNING'; then
  warn "ruflo daemon is RUNNING: it locks the AQE DB (the 'dream' step will fail locked) and caches state."
  warn "  → for a clean run: 'ruflo daemon stop' first, then after this completes restart the daemon + Claude Code, then verify-learning."
  echo ""
fi

ACT_RUN=0; ACT_SKIPPED=0; ACT_FAILED=0
REQUIRED_FAILED=0   # only steps 3,4,6,10 flip CI exit

# Improvement 1 — transient-lock retry. The AQE learning commands intermittently
# hit "database is locked" / SQLITE_BUSY (back-to-back sqlite writers checkpoint-
# contending, or a live MCP/daemon connection). Those are transient, so retry the
# step with exponential backoff — but ONLY when the failure log carries a lock
# signature (a genuine error must NOT burn retries). Tunable via env for CI.
FIXLEARN_RETRIES="${FIXLEARN_RETRIES:-3}"   # max attempts on a transient DB lock
FIXLEARN_BACKOFF="${FIXLEARN_BACKOFF:-1}"   # initial backoff seconds (doubles)
LOCK_SIG='database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED'

# step <n> <required:0|1> <skip-test-cmd-or-empty> -- <command...>
# skip-test: a command string eval'd; exit 0 == already satisfied (skip).
step() {
  local n="$1" required="$2" skiptest="$3"; shift 3
  [[ "$1" == "--" ]] && shift
  if [[ -n "$skiptest" ]] && eval "$skiptest" >/dev/null 2>&1; then
    pass "$n: already satisfied — skipping"; ACT_SKIPPED=$((ACT_SKIPPED+1)); return 0
  fi
  info "$n: running: $*"
  local log="/tmp/fix-learning-$n.log" attempt=1 delay="$FIXLEARN_BACKOFF"
  while :; do
    if run "$* >$log 2>&1"; then
      if [[ "$attempt" -gt 1 ]]; then pass "$n: done (after $attempt attempts)"; else pass "$n: done"; fi
      ACT_RUN=$((ACT_RUN+1)); return 0
    fi
    # run() in --dry-run never fails, so we only get here on a real failure.
    if [[ "$attempt" -lt "$FIXLEARN_RETRIES" ]] && grep -qiE "$LOCK_SIG" "$log" 2>/dev/null; then
      warn "$n: transient DB lock (attempt $attempt/$FIXLEARN_RETRIES) — retrying in ${delay}s"
      sleep "$delay"; delay=$((delay * 2)); attempt=$((attempt + 1)); continue
    fi
    warn "$n: failed (see $log) — continuing"
    ACT_FAILED=$((ACT_FAILED+1))
    [[ "$required" -eq 1 ]] && REQUIRED_FAILED=$((REQUIRED_FAILED+1))
    return 0
  done
}

# Improvement 2 — persistence assertion. Issue #4's core meta-finding: the
# runtime reports success while the committed tables stay empty ("looks healthy,
# is hollow"). After a populate step, confirm the target table ACTUALLY grew on
# disk; if a step claimed success but committed nothing, WARN loudly instead of
# trusting the ✓. Never flips the exit code (diagnostic). No-op in dry-run.
persist_check() {
  local n="$1" db="$2" tbl="$3" before="$4" after
  [[ "${DRY_RUN:-0}" -eq 1 ]] && return 0
  after="$(count_tbl "$db" "$tbl")"
  if [[ "$after" -gt "$before" ]]; then
    pass "$n: persisted $tbl ${before}->${after} (+$((after - before)))"
  else
    warn "$n: step reported success but $tbl did NOT grow on disk (${before}->${after}) — runtime over-reported vs committed state (issue #4); likely DB-locked or a no-op. Re-run with the daemon + live Claude Code stopped."
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
# Persistence-checked: extract must actually commit qe_patterns, not just claim it.
QP_BEFORE="$(count_tbl "$AQE_DB" qe_patterns)"
step 7 0 "" -- "${AQE[@]}" learning extract
persist_check 7 "$AQE_DB" qe_patterns "$QP_BEFORE"

# 8 — consolidate/promote patterns (optional; skip if subcommand absent).
SUB=consolidate
if sub_exists "${AQE[@]}" learning; then
  step 8 0 "" -- "${AQE[@]}" learning consolidate
else
  pass "8: 'aqe learning consolidate' unavailable — skipping"; ACT_SKIPPED=$((ACT_SKIPPED+1))
fi

# 9 — dream-cycle discovery (#10) (optional; skip if subcommand absent).
# Persistence-checked: dream must actually commit dream_cycles.
SUB=dream
if sub_exists "${AQE[@]}" learning; then
  DC_BEFORE="$(count_tbl "$AQE_DB" dream_cycles)"
  step 9 0 "" -- "${AQE[@]}" learning dream
  persist_check 9 "$AQE_DB" dream_cycles "$DC_BEFORE"
else
  pass "9: 'aqe learning dream' unavailable — skipping"; ACT_SKIPPED=$((ACT_SKIPPED+1))
fi

# 10 — real MicroLoRA adaptation (#3). Skip if the trainer is already engaged.
step 10 1 '[[ "$(lora_adaptations)" -gt 0 ]]' -- "${RUFLO[@]}" neural train -p coordination -e 50 --wasm --flash --contrastive

# 11 — harvest: replay AQE experiences into the agentdb reflexion store (#2). This
# is the ONLY path that populates structured episodes/skills (in agentdb.db, the
# canonical store) — ruflo's hooks write flat memory_entries, never the structured
# schema. The harvest (agentdb Node API: reflexion.storeEpisode + skills.createSkill)
# is idempotent via .swarm/harvest-state.json and self-checkpoints agentdb.db.
# Persistence-checked against agentdb.db episodes so an over-report is visible.
HARVEST_TOOL="$KIT_TOOLS/aqe-harvest.cjs"
if [[ "${FIXLEARN_HARVEST:-1}" -ne 1 ]]; then
  pass "11: harvest disabled (FIXLEARN_HARVEST=0) — skipping"; ACT_SKIPPED=$((ACT_SKIPPED+1))
elif [[ ! -f "$HARVEST_TOOL" ]]; then
  pass "11: harvest tool not present — skipping"; ACT_SKIPPED=$((ACT_SKIPPED+1))
elif [[ "${DRY_RUN:-0}" -eq 1 ]]; then
  info "11: [dry-run] node aqe-harvest.cjs (replay AQE experiences → agentdb.db episodes/skills)"; ACT_SKIPPED=$((ACT_SKIPPED+1))
else
  EPI_BEFORE="$(count_tbl agentdb.db episodes)"
  info "11: running: harvest (AQE experiences → agentdb.db reflexion store)"
  if node "$HARVEST_TOOL" >/tmp/fix-learning-11.log 2>&1; then
    pass "11: done"; ACT_RUN=$((ACT_RUN+1))
    persist_check 11 agentdb.db episodes "$EPI_BEFORE"
  else
    warn "11: harvest failed (see /tmp/fix-learning-11.log) — continuing"; ACT_FAILED=$((ACT_FAILED+1))
  fi
fi

echo ""
echo "  Summary: $ACT_RUN run, $ACT_SKIPPED skipped, $ACT_FAILED failed"
info "verify with: bin/ruflo-kit verify-learning $TARGET_DIR"

# Exit 1 only when a REQUIRED step (3,4,6,10) hard-failed, so CI surfaces a real
# stall; optional/diagnostic steps never flip the exit code.
[[ "$REQUIRED_FAILED" -gt 0 ]] && exit 1
exit 0
