#!/usr/bin/env bash
set -uo pipefail
# ============================================================================
# verify-learning.sh — READ-ONLY liveness probes for the ruflo + AQE self-
# learning loop (GitHub issue #4: "enabled-but-hollow").
#
# The whole class of bugs in issue #4 is "looks healthy, is hollow": MCP status
# tools over-report (e.g. aqe_health claimed 3116 entries vs ~138 committed
# rows). So this script trusts ONLY committed disk state — direct sqlite3 row
# counts and on-disk artifacts — never an MCP self-report. It FAILS LOUDLY
# (exit 1) when controllers are enabled but the structured tables are empty, the
# neural trainer is stuck in JS fallback, or HNSW is unindexed. CI-friendly.
#
# Probes:
#   #2 ruflo controllers hollow (memory_entries>0 but structured tables 0) FAIL
#   #3 neural trainer in JS fallback (lora totalUpdates>0, totalAdaptations 0) FAIL
#   #4 HNSW unindexed (AQE vectors>0 but useNativeHNSW unset)               FAIL
#   #6 dimension guard (vectors 384-dim AND blob == dim*4)                   FAIL-on-corruption
#   #9 graphAdapter not wiring relationships (graph_edges 0)                 WARN
#   #10 SONA table unpopulated (sona_patterns 0)                            WARN
#   #7 model router liveness (totalDecisions / routing_outcomes)            INFO
#
# Usage:
#   bin/ruflo-kit verify-learning <target>            # human report, exit 1 if hollow
#   bin/ruflo-kit verify-learning <target> --json     # machine-readable summary
#   bin/ruflo-kit verify-learning <target> -h|--help  # this help
# ============================================================================

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# Pre-strip our own flags (--json / -h) so common.sh's kit_resolve doesn't warn
# on them; forward the rest (target path, --dry-run is a no-op for a read tool).
JSON=0; FWD=()
for a in "$@"; do
  case "$a" in
    --json)    JSON=1 ;;
    -h|--help) sed -n '3,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)         FWD+=("$a") ;;
  esac
done
kit_resolve ${FWD[@]+"${FWD[@]}"}
kit_require_target
cd "$TARGET_DIR"

# ── safe sqlite/file helpers (copied from health.sh — not in common.sh) ──────
num_or_zero() { local n="$1"; [[ "$n" =~ ^[0-9]+$ ]] && echo "$n" || echo 0; }
sqlite_count_safe() {
  local db="$1" sql="$2"
  [[ -f "$db" ]] || { echo 0; return; }
  local out; out="$(sqlite3 -readonly "$db" "$sql" 2>/dev/null || echo 0)"
  num_or_zero "${out:-0}"
}
table_exists() {
  local db="$1" t="$2"
  [[ -f "$db" ]] || return 1
  local out
  out="$(sqlite3 -readonly "$db" \
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='$t' LIMIT 1;" 2>/dev/null || true)"
  [[ "${out:-}" == "1" ]]
}
# Count a table only if it exists (an absent table is 0, not an error).
count_tbl() { local db="$1" t="$2"; table_exists "$db" "$t" && sqlite_count_safe "$db" "SELECT COUNT(*) FROM $t;" || echo 0; }
# Read a numeric field from a JSON file via node. The file path is passed via
# argv (NEVER interpolated into the program string) so a TARGET_DIR containing
# quotes can't inject JS — mirrors the argv pattern in fix-aqe.sh. The accessor
# expr is a fixed kit literal (not user data), passed via env and eval'd.
json_num() {
  local file="$1" expr="$2" def="${3:-0}"
  JN_EXPR="$expr" JN_DEF="$def" node -e \
    'try{const j=require(process.argv[1]);const v=eval(process.env.JN_EXPR);process.stdout.write(String(v??Number(process.env.JN_DEF)))}catch(e){process.stdout.write(String(Number(process.env.JN_DEF)))}' \
    "$PWD/$file" 2>/dev/null || echo "$def"
}

# ── stores (canonical roots, per audit Smell #3) ────────────────────────────
SWARM_DB=".swarm/memory.db"            # ruflo coordination + controllers
AQE_DB=".agentic-qe/memory.db"         # AQE learning (canonical)
AGENTDB="agentdb.db"                   # reflexion/episodes (canonical)
LORA=".swarm/lora-weights.json"
AQE_CONFIG=".agentic-qe/config.yaml"
ROUTER_STATE=".swarm/model-router-state.json"

PASS=0; WARN=0; FAIL=0; INFO=0
# In --json mode, emit only counters (keep stdout pure JSON); otherwise print.
ok()   { [[ "$JSON" -eq 0 ]] && pass "$1"; PASS=$((PASS+1)); }
bad()  { [[ "$JSON" -eq 0 ]] && fail "$1"; FAIL=$((FAIL+1)); }
soft() { [[ "$JSON" -eq 0 ]] && warn "$1"; WARN=$((WARN+1)); }
note() { [[ "$JSON" -eq 0 ]] && info "$1"; INFO=$((INFO+1)); }

# ── probes ──────────────────────────────────────────────────────────────────
# #2 ruflo controllers hollow: memory_entries populated but the 6 structured
# learning tables all empty = "enabled but unfed". FAIL.
probe_ruflo_controllers() {
  local me struct=0 t
  me="$(count_tbl "$SWARM_DB" memory_entries)"
  for t in episodes skills patterns causal_edges reasoning_patterns learning_experiences; do
    struct=$((struct + $(count_tbl "$SWARM_DB" "$t")))
  done
  RUFLO_ME="$me"; RUFLO_STRUCT="$struct"
  if [[ "$me" -gt 0 && "$struct" -eq 0 ]]; then
    bad "ruflo controllers HOLLOW: memory_entries=$me but episodes/skills/patterns/causal_edges/reasoning_patterns/learning_experiences all 0 — run: ruflo-kit fix-learning $TARGET_DIR"
  elif [[ "$struct" -gt 0 ]]; then
    ok "ruflo controllers populated (structured rows=$struct, memory_entries=$me)"
  else
    note "ruflo coordination store empty (fresh target)"
  fi
}

# #3 neural trainer in JS fallback: the LoRA writer logs updates but never
# produces a real adaptation (native backend never engaged). FAIL.
probe_lora_backend() {
  local ta tu
  if [[ ! -f "$LORA" ]]; then note "no lora-weights.json yet (#3 n/a)"; LORA_TA=-2; return; fi
  ta="$(json_num "$LORA" "(j.stats||{}).totalAdaptations" -1)"
  tu="$(json_num "$LORA" "(j.stats||{}).totalUpdates" -1)"
  LORA_TA="$ta"
  if [[ "$tu" -gt 0 && "$ta" -eq 0 ]]; then
    bad "neural trainer in JS FALLBACK: lora totalUpdates=$tu but totalAdaptations=0 (native backend never engaged) — run: ruflo-kit fix-learning $TARGET_DIR"
  elif [[ "$ta" -gt 0 ]]; then
    ok "neural trainer engaged (lora adaptations=$ta)"
  else
    note "lora trainer idle (totalUpdates=$tu, totalAdaptations=$ta)"
  fi
}

# #4 native HNSW backend. The authoritative flag lives in the ruvector FLAGS
# STORE (read via `aqe ruvector status`), NOT config.yaml — and it is ON by
# default. So `config.yaml` lacking the key is NOT evidence of a problem (the
# old probe false-FAILed on every project). We FAIL only when the flag is
# EXPLICITLY false; config.yaml is a weak fallback used only when aqe can't be
# queried. RUVECTOR_HNSW (true|false|"") is resolved once in the run section.
probe_hnsw_native() {
  local vec; vec="$(count_tbl "$AQE_DB" vectors)"
  if [[ "${RUVECTOR_HNSW:-}" == "false" ]]; then
    bad "HNSW native backend DISABLED: useNativeHNSW=false (ruvector flags) — run: aqe ruvector flags --set useNativeHNSW=true && aqe learning repair"
  elif [[ "${RUVECTOR_HNSW:-}" == "true" ]]; then
    if [[ "$vec" -gt 0 ]]; then ok "native HNSW enabled (useNativeHNSW=true, AQE vectors=$vec)"
    else note "native HNSW enabled (no AQE vectors yet)"; fi
  elif grep -q 'useNativeHNSW' "$AQE_CONFIG" 2>/dev/null; then
    ok "useNativeHNSW codified in config.yaml (AQE vectors=$vec)"
  else
    note "native HNSW flag indeterminate (aqe ruvector status unavailable; AQE vectors=$vec)"
  fi
}

# #6 dimension guard (defensive — issue's 1536-vs-384 claim was a byte/dim
# misread; this asserts the real invariant instead of "fixing" a non-bug).
probe_dimension_guard() {
  local res; res="$(assert_vector_dim_ok "$AQE_DB" vectors embedding dimensions 384)"
  case "$res" in
    OK)                 ok "dimension guard: all AQE vectors 384-dim, blob=dimensions*4" ;;
    EMPTY|NO_TABLE)     note "dimension guard: no vectors to check" ;;
    DIM_MISMATCH:*|BLOB_MISMATCH:*)
                        bad "dimension guard FAILED: $res (expected 384-dim, blob=dimensions*4)" ;;
    *)                  soft "dimension guard inconclusive ($res)" ;;
  esac
}

# #9 graphAdapter: relationship graph never populated. Non-fatal.
probe_graph_edges() {
  local ge; ge="$(count_tbl "$SWARM_DB" graph_edges)"
  if [[ "$ge" -eq 0 && "${RUFLO_ME:-0}" -gt 0 ]]; then
    soft "graph_edges=0 (graphAdapter not wiring relationships) — non-fatal (#9)"
  else
    ok "graph_edges=$ge"
  fi
}

# #10 SONA table unpopulated (3-way SONA split unconsolidated). Non-fatal.
probe_sona() {
  local sp; sp="$(count_tbl "$AQE_DB" sona_patterns)"
  if [[ "$sp" -eq 0 ]]; then
    soft "AQE sona_patterns=0 (SONA table unpopulated; 3-way SONA split unconsolidated) — non-fatal (#10)"
  else
    ok "sona_patterns=$sp"
  fi
}

# #7 router liveness — informational, never fails (issue claimed totalRouted:0;
# disk shows it IS live at the hooks layer).
probe_router_info() {
  local td ro
  td="$(json_num "$ROUTER_STATE" "j.totalDecisions" 0)"
  ro="$(count_tbl "$AQE_DB" routing_outcomes)"
  note "router live: model-router totalDecisions=$td, AQE routing_outcomes=$ro (#7)"
}

# Daemon advisory (non-fatal). A RUNNING ruflo daemon holds DB locks (so
# fix-learning's dream step fails "database is locked") and caches state in
# memory — so a just-run fix-learning may not be reflected until the daemon AND
# Claude Code are restarted. Surfaced as a WARN so the "still hollow after a fix"
# case is self-explaining.
probe_daemon_advisory() {
  command -v ruflo >/dev/null 2>&1 || return 0
  if ruflo daemon status 2>/dev/null | grep -qiE 'RUNNING'; then
    soft "ruflo daemon is RUNNING — it locks the DBs (fix-learning 'dream' fails locked) and caches state; restart the daemon + Claude Code after a fix, then re-verify"
  fi
}

# ── run ─────────────────────────────────────────────────────────────────────
RUFLO_ME=0; RUFLO_STRUCT=0; LORA_TA=0
# Authoritative native-HNSW flag from the ruvector flags store (true|false|""),
# resolved ONCE. This is the source of truth for #4 — config.yaml is not.
RUVECTOR_HNSW=""
if command -v aqe >/dev/null 2>&1; then
  RUVECTOR_HNSW="$(aqe ruvector status 2>/dev/null | grep -iE 'useNativeHNSW' | grep -oiE 'true|false' | head -1 | tr 'A-Z' 'a-z')"
fi
if [[ "$JSON" -eq 0 ]]; then
  header "verify-learning" "ruflo + AQE self-learning loop liveness (read-only)"
  kit_banner
  echo ""
fi
probe_ruflo_controllers
probe_lora_backend
probe_hnsw_native
probe_dimension_guard
probe_graph_edges
probe_sona
probe_router_info
probe_daemon_advisory

VERDICT="live"
[[ "$WARN" -gt 0 ]] && VERDICT="partial"
[[ "$FAIL" -gt 0 ]] && VERDICT="hollow"

if [[ "$JSON" -eq 1 ]]; then
  printf '{"pass":%d,"warn":%d,"fail":%d,"info":%d,"verdict":"%s"}\n' \
    "$PASS" "$WARN" "$FAIL" "$INFO" "$VERDICT"
else
  echo ""
  echo "  Summary: $PASS pass  $WARN warn  $FAIL fail  $INFO info"
  case "$VERDICT" in
    hollow)  fail "learning loop HOLLOW — run: bin/ruflo-kit fix-learning $TARGET_DIR" ;;
    partial) warn "learning loop partial (non-fatal warnings)" ;;
    live)    pass "learning loop live" ;;
  esac
fi

# Exit-code policy (CI): FAIL → 1 (real, actionable regression); WARN/clean → 0.
[[ "$FAIL" -gt 0 ]] && exit 1
exit 0
