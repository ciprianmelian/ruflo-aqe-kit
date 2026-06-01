#!/usr/bin/env bash
set -uo pipefail
# ============================================================================
# ruflo-health.sh — Growth-delta health check for ruflo + AQE self-learning loop
#
# The bootstrap, fix, and session-init scripts answer "did init run?". This
# script answers the much more useful question: "is the self-learning loop
# actually growing, or has it silently flatlined?".
#
# Each run captures a snapshot of ~14 metrics across ruflo memory, intelligence
# (SONA + MoE), neural (ReasoningBank), AQE patterns/trajectories, DB row
# counts, DB file sizes, daemon status, and hive workers. The snapshot is
# diff'd against `.claude-flow/data/health-last.json` from the previous run,
# colour-coded growth/regression markers are printed, and the snapshot is
# updated. A rolling `health-history.jsonl` is appended for longer-term trend
# analysis.
#
# Cost: ~1.5s total per run (verified). Does NOT call `ruflo embeddings index`
# (ONNX inference, hundreds of ms) or `aqe status` (noisy [INFO] chatter).
#
# Usage:
#   bin/ruflo-kit health <target>              # diff vs last snapshot, then update
#   bin/ruflo-kit health <target> --reset      # force re-baseline (overwrite)
#   bin/ruflo-kit health <target> --dry-run    # diff but don't update snapshot
#   bin/ruflo-kit health <target> --json       # emit raw current snapshot JSON only
#   bin/ruflo-kit health <target> -h | --help  # this help text
# ============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
kit_resolve "$@"
kit_require_target
cd "$TARGET_DIR"

SNAPSHOT_FILE=".claude-flow/data/health-last.json"
HISTORY_FILE=".claude-flow/data/health-history.jsonl"
SNAPSHOT_VERSION=1

MODE="diff"
for arg in "$@"; do
  case "$arg" in
    --reset)        MODE=reset ;;
    --dry-run)      MODE=dryrun ;;
    --json)         MODE=json ;;
    -h|--help)      sed -n '4,26p' "$0"; exit 0 ;;
    -*)             echo "unknown flag: $arg (use --help)" >&2; exit 2 ;;
    *)              : ;;  # positional target path — resolved by kit_resolve
  esac
done

# Resolve ruflo command (prefer global, fall back to npx)
if command -v ruflo >/dev/null 2>&1; then
  RUFLO=(ruflo)
else
  RUFLO=(npx -y ruflo@latest)
fi

# ── safe helpers ────────────────────────────────────────────────────────────
# Output a non-negative integer or 0 on any failure
num_or_zero() {
  local n="$1"
  if [[ "$n" =~ ^[0-9]+$ ]]; then echo "$n"; else echo 0; fi
}

# stat -f works on BSD/macOS, stat -c on GNU/Linux
file_size() {
  local f="$1"
  [[ -f "$f" ]] || { echo 0; return; }
  local s
  s=$(stat -f %z "$f" 2>/dev/null || stat -c %s "$f" 2>/dev/null || echo 0)
  num_or_zero "$s"
}

# sqlite3 COUNT(*) with table-exists guard; returns 0 on any failure
sqlite_count_safe() {
  local db="$1" sql="$2"
  [[ -f "$db" ]] || { echo 0; return; }
  local out
  out=$(sqlite3 -readonly "$db" "$sql" 2>/dev/null || echo 0)
  num_or_zero "${out:-0}"
}

table_exists() {
  local db="$1" t="$2"
  [[ -f "$db" ]] || return 1
  local out
  out=$(sqlite3 -readonly "$db" \
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='$t' LIMIT 1;" \
    2>/dev/null || true)
  [[ "${out:-}" == "1" ]]
}

# Run a ruflo command with a hard timeout; return stdout (stderr discarded).
# Uses `perl` for portable timeout (no `timeout` on stock macOS).
ruflo_timeout() {
  local secs="$1"; shift
  perl -e 'alarm shift; exec @ARGV' "$secs" "${RUFLO[@]}" "$@" 2>/dev/null || true
}

# Extract a number after a label in tabular output (handles `│` and `|` cells)
extract_number_after() {
  local label="$1" text="$2"
  echo "$text" | grep -m1 -E "$label" | grep -oE '[0-9]+(\.[0-9]+)?' | head -1 || echo 0
}

# Extract a percentage value (e.g. "75.0%") and strip the %
extract_percent() {
  local label="$1" text="$2"
  echo "$text" | grep -m1 -E "$label" | grep -oE '[0-9]+(\.[0-9]+)?%' | head -1 | tr -d '%' || echo 0
}

# ── collect metrics ─────────────────────────────────────────────────────────
NOW_S=$(date +%s)
NOW_MS=$((NOW_S * 1000))
NOW_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Memory: `ruflo memory stats`
MEMORY_OUT=$(ruflo_timeout 5 memory stats || true)
MEMORY_TOTAL=$(extract_number_after 'Total Entries' "$MEMORY_OUT")
MEMORY_TOTAL=$(num_or_zero "$MEMORY_TOTAL")
MEMORY_HNSW=$(echo "$MEMORY_OUT" | grep -m1 -E 'HNSW Index' | grep -oE '\([0-9]+ entries\)' | grep -oE '[0-9]+' || echo 0)
MEMORY_HNSW=$(num_or_zero "$MEMORY_HNSW")

# Intelligence: `ruflo hooks intelligence stats` (SONA + MoE block)
INTEL_OUT=$(ruflo_timeout 5 hooks intelligence stats || true)
SONA_TRAJ=$(extract_number_after 'Trajectories' "$INTEL_OUT")
SONA_TRAJ=$(num_or_zero "$SONA_TRAJ")
SONA_PAT=$(extract_number_after 'Patterns Learned' "$INTEL_OUT")
SONA_PAT=$(num_or_zero "$SONA_PAT")
SONA_QUAL=$(extract_percent 'Avg Quality' "$INTEL_OUT")
MOE_ACC=$(extract_percent 'Routing Accuracy' "$INTEL_OUT")
SEARCH_SPEEDUP=$(echo "$INTEL_OUT" | grep -m1 -E 'HNSW.*Faster Search' | grep -oE '[0-9]+x' | head -1 || echo "")
[[ -z "$SEARCH_SPEEDUP" ]] && SEARCH_SPEEDUP="unknown"

# Neural: `ruflo neural status` (ReasoningBank line)
NEURAL_OUT=$(ruflo_timeout 5 neural status || true)
RB_PAT=$(echo "$NEURAL_OUT" | grep -m1 -E 'ReasoningBank' | grep -oE '[0-9]+ patterns' | grep -oE '[0-9]+' || echo 0)
RB_PAT=$(num_or_zero "$RB_PAT")

# Direct sqlite probes (fast, ~20ms each)
SWARM_DB=".swarm/memory.db"
AQE_DB=".agentic-qe/memory.db"

SWARM_MEM_ENTRIES=$(sqlite_count_safe "$SWARM_DB" 'SELECT COUNT(*) FROM memory_entries;')
SWARM_PAT_EMB=0
if table_exists "$SWARM_DB" pattern_embeddings; then
  SWARM_PAT_EMB=$(sqlite_count_safe "$SWARM_DB" 'SELECT COUNT(*) FROM pattern_embeddings;')
fi
SWARM_VEC_IDX=0
if table_exists "$SWARM_DB" vector_indexes; then
  SWARM_VEC_IDX=$(sqlite_count_safe "$SWARM_DB" 'SELECT COUNT(*) FROM vector_indexes;')
fi

AQE_PAT=0
if table_exists "$AQE_DB" qe_patterns; then
  AQE_PAT=$(sqlite_count_safe "$AQE_DB" 'SELECT COUNT(*) FROM qe_patterns;')
fi
AQE_TRAJ=0
if table_exists "$AQE_DB" qe_trajectories; then
  AQE_TRAJ=$(sqlite_count_safe "$AQE_DB" 'SELECT COUNT(*) FROM qe_trajectories;')
fi

SWARM_DB_SIZE=$(file_size "$SWARM_DB")
AQE_DB_SIZE=$(file_size "$AQE_DB")

# Daemon: `ruflo daemon status` always exits 0, grep for the canonical line
DAEMON_OUT=$(ruflo_timeout 5 daemon status || true)
DAEMON_RUNNING=false
if echo "$DAEMON_OUT" | grep -q $'Status: \xe2\x97\x8f RUNNING'; then DAEMON_RUNNING=true
elif echo "$DAEMON_OUT" | grep -qE 'Status:.*RUNNING'; then DAEMON_RUNNING=true
fi

# Hive workers: parse JSON workers array length cheaply (no jq dep)
HIVE_STATE=".claude-flow/hive-mind/state.json"
HIVE_WORKERS=0
if [[ -f "$HIVE_STATE" ]]; then
  HIVE_WORKERS=$(node -e "
    try {
      const s = JSON.parse(require('fs').readFileSync('$HIVE_STATE', 'utf-8'));
      console.log(Array.isArray(s.workers) ? s.workers.length : 0);
    } catch { console.log(0); }
  " 2>/dev/null || echo 0)
  HIVE_WORKERS=$(num_or_zero "$HIVE_WORKERS")
fi

# Tier 6.6: HNSW backend probe. ruflo's @ruvector/core ships both a NAPI
# (native node addon) and a WASM fallback. NAPI is ~50× faster for HNSW
# search; WASM kicks in transparently when the .node binary is missing or
# fails dlopen (silent perf cliff). Detect via filesystem only — no require()
# (would force a heavy WASM init and skew this health check's cost budget).
# Use `node -e process.platform/arch` (NOT `uname -m`) — Rosetta-emulated
# shells on Apple Silicon report `x86_64` for `uname -m` while node correctly
# reports `arm64`. node's view is what ruflo will actually load, so it's
# the authoritative source.
detect_hnsw_backend() {
  local platarch
  platarch="$(node -e "process.stdout.write(process.platform + '-' + process.arch)" 2>/dev/null || echo "darwin-arm64")"
  local napi
  napi="$(find "$HOME/.npm/_npx" -name "rvf-node.${platarch}.node" 2>/dev/null | head -1)"
  if [[ -n "$napi" ]]; then
    echo "NAPI (${platarch})"
    return
  fi
  if find "$HOME/.npm/_npx" -name "*.wasm" 2>/dev/null | grep -q ruvector; then
    echo "WASM (fallback - ~50x slower)"
    return
  fi
  echo "unknown"
}
HNSW_BACKEND="$(detect_hnsw_backend)"

# ── build current snapshot JSON ─────────────────────────────────────────────
build_snapshot_json() {
  cat <<EOF
{
  "version": $SNAPSHOT_VERSION,
  "timestamp": $NOW_MS,
  "iso": "$NOW_ISO",
  "metrics": {
    "memory": {
      "totalEntries": $MEMORY_TOTAL,
      "hnswEntries": $MEMORY_HNSW
    },
    "intelligence": {
      "sonaPatterns": $SONA_PAT,
      "sonaTrajectories": $SONA_TRAJ,
      "sonaQualityPct": ${SONA_QUAL:-0},
      "moeRoutingAccuracyPct": ${MOE_ACC:-0},
      "searchSpeedupLabel": "$SEARCH_SPEEDUP"
    },
    "neural": {
      "reasoningBankPatterns": $RB_PAT
    },
    "dbRows": {
      "swarmMemoryEntries": $SWARM_MEM_ENTRIES,
      "swarmPatternEmbeddings": $SWARM_PAT_EMB,
      "swarmVectorIndexes": $SWARM_VEC_IDX,
      "aqePatterns": $AQE_PAT,
      "aqeTrajectories": $AQE_TRAJ
    },
    "dbSizeBytes": {
      "swarm": $SWARM_DB_SIZE,
      "aqe": $AQE_DB_SIZE
    },
    "daemon": {
      "running": $DAEMON_RUNNING
    },
    "hive": {
      "workers": $HIVE_WORKERS
    },
    "runtime": {
      "hnswBackend": "$HNSW_BACKEND"
    }
  }
}
EOF
}

CURRENT_JSON=$(build_snapshot_json)

# ── --json mode: dump and exit ──────────────────────────────────────────────
if [[ "$MODE" == "json" ]]; then
  echo "$CURRENT_JSON"
  exit 0
fi

# ── load previous snapshot (if any) ─────────────────────────────────────────
PREV_EXISTS=0
PREV_VERSION=0
PREV_TIMESTAMP=0
if [[ -f "$SNAPSHOT_FILE" ]]; then
  PREV_VERSION=$(node -e "
    try { console.log(JSON.parse(require('fs').readFileSync('$SNAPSHOT_FILE','utf-8')).version || 0); }
    catch { console.log(0); }
  " 2>/dev/null || echo 0)
  PREV_VERSION=$(num_or_zero "$PREV_VERSION")
  if [[ "$PREV_VERSION" -eq "$SNAPSHOT_VERSION" ]]; then
    PREV_EXISTS=1
    PREV_TIMESTAMP=$(node -e "
      try { console.log(JSON.parse(require('fs').readFileSync('$SNAPSHOT_FILE','utf-8')).timestamp || 0); }
      catch { console.log(0); }
    " 2>/dev/null || echo 0)
    PREV_TIMESTAMP=$(num_or_zero "$PREV_TIMESTAMP")
  fi
fi

# ── --reset: overwrite and exit ─────────────────────────────────────────────
write_snapshot() {
  mkdir -p "$(dirname "$SNAPSHOT_FILE")"
  echo "$CURRENT_JSON" > "$SNAPSHOT_FILE"
  # Append a compact one-line entry to the rolling history
  local one_line
  one_line=$(echo "$CURRENT_JSON" | node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      try{process.stdout.write(JSON.stringify(JSON.parse(s))+'\n');}
      catch{process.stdout.write(s);}
    });" 2>/dev/null || echo "$CURRENT_JSON")
  echo "$one_line" >> "$HISTORY_FILE"
}

echo -e "${BOLD}============================================${NC}"
echo -e " ${BOLD}ruflo health${NC}"
echo -e " kit:    $KIT_DIR"
echo -e " target: $TARGET_DIR"
echo -e "${BOLD}============================================${NC}"

if [[ "$MODE" == "reset" ]]; then
  write_snapshot
  echo ""
  echo -e "  ${YELLOW}!${NC} snapshot reset — new baseline at $NOW_ISO"
  echo "  re-run later to see growth-delta"
  exit 0
fi

# ── first-run / version mismatch: write baseline and exit ───────────────────
if [[ "$PREV_EXISTS" -eq 0 ]]; then
  if [[ "$MODE" != "dryrun" ]]; then
    write_snapshot
  fi
  echo ""
  echo -e "  ${CYAN}→${NC} no prior snapshot found (or schema version changed)"
  if [[ "$MODE" == "dryrun" ]]; then
    echo -e "  ${CYAN}→${NC} --dry-run: NOT writing baseline"
  else
    echo -e "  ${GREEN}✓${NC} baseline established at $NOW_ISO → $SNAPSHOT_FILE"
  fi
  echo ""
  echo "  current snapshot:"
  echo "    memory.totalEntries          : $MEMORY_TOTAL"
  echo "    memory.hnswEntries           : $MEMORY_HNSW"
  echo "    intelligence.sonaPatterns    : $SONA_PAT"
  echo "    intelligence.sonaTrajectories: $SONA_TRAJ"
  echo "    intelligence.sonaQualityPct  : ${SONA_QUAL:-0}"
  echo "    intelligence.moeAccuracyPct  : ${MOE_ACC:-0}"
  echo "    intelligence.searchSpeedup   : $SEARCH_SPEEDUP"
  echo "    neural.reasoningBankPatterns : $RB_PAT"
  echo "    dbRows.swarmMemoryEntries    : $SWARM_MEM_ENTRIES"
  echo "    dbRows.swarmPatternEmbeddings: $SWARM_PAT_EMB"
  echo "    dbRows.swarmVectorIndexes    : $SWARM_VEC_IDX"
  echo "    dbRows.aqePatterns           : $AQE_PAT"
  echo "    dbRows.aqeTrajectories       : $AQE_TRAJ"
  echo "    dbSizeBytes.swarm            : $SWARM_DB_SIZE"
  echo "    dbSizeBytes.aqe              : $AQE_DB_SIZE"
  echo "    daemon.running               : $DAEMON_RUNNING"
  echo "    hive.workers                 : $HIVE_WORKERS"
  echo "    runtime.hnswBackend          : $HNSW_BACKEND"
  echo ""
  echo "  re-run later to see growth deltas"
  exit 0
fi

# ── diff mode: extract prev values via node ────────────────────────────────
read_prev() {
  local path="$1"
  node -e "
    try {
      const s = JSON.parse(require('fs').readFileSync('$SNAPSHOT_FILE','utf-8'));
      const v = $path;
      console.log(v === undefined || v === null ? '' : v);
    } catch { console.log(''); }
  " 2>/dev/null || echo ""
}

PREV_MEM_TOTAL=$(read_prev "s.metrics.memory.totalEntries")
PREV_MEM_HNSW=$(read_prev "s.metrics.memory.hnswEntries")
PREV_SONA_PAT=$(read_prev "s.metrics.intelligence.sonaPatterns")
PREV_SONA_TRAJ=$(read_prev "s.metrics.intelligence.sonaTrajectories")
PREV_SONA_QUAL=$(read_prev "s.metrics.intelligence.sonaQualityPct")
PREV_MOE_ACC=$(read_prev "s.metrics.intelligence.moeRoutingAccuracyPct")
PREV_SEARCH_SPEEDUP=$(read_prev "s.metrics.intelligence.searchSpeedupLabel")
PREV_RB_PAT=$(read_prev "s.metrics.neural.reasoningBankPatterns")
PREV_SWARM_MEM=$(read_prev "s.metrics.dbRows.swarmMemoryEntries")
PREV_SWARM_PAT=$(read_prev "s.metrics.dbRows.swarmPatternEmbeddings")
PREV_SWARM_VEC=$(read_prev "s.metrics.dbRows.swarmVectorIndexes")
PREV_AQE_PAT=$(read_prev "s.metrics.dbRows.aqePatterns")
PREV_AQE_TRAJ=$(read_prev "s.metrics.dbRows.aqeTrajectories")
PREV_SWARM_SIZE=$(read_prev "s.metrics.dbSizeBytes.swarm")
PREV_AQE_SIZE=$(read_prev "s.metrics.dbSizeBytes.aqe")
PREV_DAEMON=$(read_prev "s.metrics.daemon.running")
PREV_HIVE=$(read_prev "s.metrics.hive.workers")
PREV_HNSW_BACKEND=$(read_prev "s.metrics.runtime.hnswBackend")
PREV_ISO=$(read_prev "s.iso")

# ── age + relative labels ──────────────────────────────────────────────────
AGE_MS=$((NOW_MS - PREV_TIMESTAMP))
AGE_S=$((AGE_MS / 1000))
AGE_M=$((AGE_S / 60))
AGE_H=$((AGE_M / 60))
AGE_D=$((AGE_H / 24))
DAY24_MS=$((24 * 60 * 60 * 1000))
DAY7_MS=$((7 * 24 * 60 * 60 * 1000))

if   [[ "$AGE_S" -lt 60   ]]; then AGE_LABEL="${AGE_S}s ago"
elif [[ "$AGE_M" -lt 60   ]]; then AGE_LABEL="${AGE_M}m ago"
elif [[ "$AGE_H" -lt 24   ]]; then AGE_LABEL="${AGE_H}h $((AGE_M % 60))m ago"
else AGE_LABEL="${AGE_D}d $((AGE_H % 24))h ago"
fi

echo ""
echo -e " ${DIM}growth since $PREV_ISO ($AGE_LABEL)${NC}"
echo -e "${BOLD}============================================${NC}"

# Counters for the summary line
GROWN=0
STABLE=0
REGRESSED=0
WARNED=0

# Diff renderer for INTEGER growth metrics. Class = "growth" → flatline warns
# after 24h. Class = "neutral" → flatline OK (e.g. quality %, HNSW size which
# can plateau).
#   $1 label   $2 prev   $3 curr   $4 class (growth|neutral)
diff_int() {
  local label="$1" prev="$2" curr="$3" class="${4:-growth}"
  prev=${prev:-0}
  curr=${curr:-0}
  if ! [[ "$prev" =~ ^[0-9]+$ ]]; then prev=0; fi
  if ! [[ "$curr" =~ ^[0-9]+$ ]]; then curr=0; fi

  local delta=$((curr - prev))
  local mark color suffix=""
  if [[ "$delta" -gt 0 ]]; then
    mark="${GREEN}↑${NC}"; color="$GREEN"; suffix=" (+$delta)"; ((GROWN++)) || true
  elif [[ "$delta" -lt 0 ]]; then
    mark="${RED}↓${NC}"; color="$RED"; suffix=" ($delta)"; ((REGRESSED++)) || true
  else
    # stable
    if [[ "$class" == "growth" && "$AGE_MS" -gt "$DAY24_MS" && "$curr" -ne 0 ]]; then
      mark="${YELLOW}!${NC}"; color="$YELLOW"; suffix=" (flatlined >24h)"; ((WARNED++)) || true
    else
      mark="${DIM}✓${NC}"; color="$DIM"; suffix=""; ((STABLE++)) || true
    fi
  fi
  printf "   %b %-30s %s → %b%s%b%s\n" "$mark" "$label" "$prev" "$color" "$curr" "$NC" "$suffix"
}

# Diff renderer for FLOAT percentage metrics (quality, accuracy). Treats <2
# point swings as stable to avoid noise.
diff_pct() {
  local label="$1" prev="$2" curr="$3"
  prev=${prev:-0}
  curr=${curr:-0}
  # Format defaults
  local prevDisp="${prev}%"
  local currDisp="${curr}%"
  # Compute delta via bc (handles floats)
  local delta
  delta=$(awk -v p="$prev" -v c="$curr" 'BEGIN{printf "%.1f", c-p}' 2>/dev/null || echo 0)
  local mark color suffix=""
  local abs_delta
  abs_delta=$(awk -v d="$delta" 'BEGIN{printf "%.1f", (d<0)?-d:d}')
  local is_growth
  is_growth=$(awk -v d="$delta" 'BEGIN{print (d>0)?1:0}')
  local is_regress
  is_regress=$(awk -v d="$delta" 'BEGIN{print (d<0)?1:0}')
  local is_noise
  is_noise=$(awk -v a="$abs_delta" 'BEGIN{print (a<2.0)?1:0}')
  if [[ "$is_noise" -eq 1 ]]; then
    mark="${DIM}✓${NC}"; color="$DIM"; ((STABLE++)) || true
  elif [[ "$is_growth" -eq 1 ]]; then
    mark="${GREEN}↑${NC}"; color="$GREEN"; suffix=" (+${delta}pt)"; ((GROWN++)) || true
  elif [[ "$is_regress" -eq 1 ]]; then
    mark="${RED}↓${NC}"; color="$RED"; suffix=" (${delta}pt)"; ((REGRESSED++)) || true
  fi
  printf "   %b %-30s %s → %b%s%b%s\n" "$mark" "$label" "$prevDisp" "$color" "$currDisp" "$NC" "$suffix"
}

# Diff renderer for DB FILE SIZES — can shrink on legitimate cleanup, so no
# regression warn; growth still highlighted.
diff_size() {
  local label="$1" prev="$2" curr="$3"
  prev=${prev:-0}; curr=${curr:-0}
  if ! [[ "$prev" =~ ^[0-9]+$ ]]; then prev=0; fi
  if ! [[ "$curr" =~ ^[0-9]+$ ]]; then curr=0; fi
  local delta=$((curr - prev))
  local prevKB=$((prev / 1024))
  local currKB=$((curr / 1024))
  local mark color suffix=""
  if [[ "$delta" -gt 0 ]]; then
    local dkb=$((delta / 1024))
    mark="${GREEN}↑${NC}"; color="$GREEN"; suffix=" (+${dkb}KB)"; ((GROWN++)) || true
  elif [[ "$delta" -lt 0 ]]; then
    local dkb=$((delta / 1024))
    mark="${DIM}✓${NC}"; color="$DIM"; suffix=" (${dkb}KB cleanup)"; ((STABLE++)) || true
  else
    mark="${DIM}✓${NC}"; color="$DIM"; ((STABLE++)) || true
  fi
  printf "   %b %-30s %dKB → %b%dKB%b%s\n" "$mark" "$label" "$prevKB" "$color" "$currKB" "$NC" "$suffix"
}

# Diff renderer for bool daemon status
diff_daemon() {
  local prev="$1" curr="$2"
  local mark color line
  if [[ "$prev" == "true" && "$curr" == "false" ]]; then
    mark="${RED}↓${NC}"; color="$RED"; line="daemon DIED — run: ruflo daemon start"
    ((REGRESSED++)) || true
  elif [[ "$prev" == "false" && "$curr" == "true" ]]; then
    mark="${GREEN}↑${NC}"; color="$GREEN"; line="daemon recovered (was stopped)"
    ((GROWN++)) || true
  elif [[ "$curr" == "true" ]]; then
    mark="${DIM}✓${NC}"; color="$DIM"; line="running"
    ((STABLE++)) || true
  else
    mark="${YELLOW}!${NC}"; color="$YELLOW"; line="stopped (run: ruflo daemon start)"
    ((WARNED++)) || true
  fi
  printf "   %b %-30s %b%s%b\n" "$mark" "daemon" "$color" "$line" "$NC"
}

# Diff renderer for the search-speedup label (pure-stable; never warns)
diff_label() {
  local label="$1" prev="$2" curr="$3"
  prev=${prev:-unknown}; curr=${curr:-unknown}
  local mark="${DIM}─${NC}"
  printf "   %b %-30s %s → %s\n" "$mark" "$label" "$prev" "$curr"
}

echo ""
echo -e " ${BOLD}Memory${NC}"
diff_int  "memory.totalEntries"        "$PREV_MEM_TOTAL"  "$MEMORY_TOTAL"  growth
diff_int  "memory.hnswEntries"         "$PREV_MEM_HNSW"   "$MEMORY_HNSW"   growth

echo ""
echo -e " ${BOLD}Intelligence (SONA + MoE)${NC}"
diff_int  "intelligence.sonaPatterns"  "$PREV_SONA_PAT"   "$SONA_PAT"      growth
diff_int  "intelligence.sonaTrajectories" "$PREV_SONA_TRAJ" "$SONA_TRAJ"   growth
diff_pct  "intelligence.sonaQualityPct"     "$PREV_SONA_QUAL"  "$SONA_QUAL"
diff_pct  "intelligence.moeRoutingAccuracy" "$PREV_MOE_ACC"    "$MOE_ACC"
diff_label "intelligence.searchSpeedup"     "$PREV_SEARCH_SPEEDUP" "$SEARCH_SPEEDUP"

echo ""
echo -e " ${BOLD}Neural (ReasoningBank)${NC}"
diff_int  "neural.reasoningBankPatterns" "$PREV_RB_PAT"   "$RB_PAT"        growth

echo ""
echo -e " ${BOLD}DB rows${NC}"
diff_int  "dbRows.swarmMemoryEntries"     "$PREV_SWARM_MEM" "$SWARM_MEM_ENTRIES" growth
diff_int  "dbRows.swarmPatternEmbeddings" "$PREV_SWARM_PAT" "$SWARM_PAT_EMB"     growth
diff_int  "dbRows.swarmVectorIndexes"     "$PREV_SWARM_VEC" "$SWARM_VEC_IDX"     neutral
diff_int  "dbRows.aqePatterns"            "$PREV_AQE_PAT"   "$AQE_PAT"           growth
diff_int  "dbRows.aqeTrajectories"        "$PREV_AQE_TRAJ"  "$AQE_TRAJ"          growth

echo ""
echo -e " ${BOLD}DB sizes${NC}"
diff_size "dbSizeBytes.swarm" "$PREV_SWARM_SIZE" "$SWARM_DB_SIZE"
diff_size "dbSizeBytes.aqe"   "$PREV_AQE_SIZE"   "$AQE_DB_SIZE"

echo ""
echo -e " ${BOLD}Runtime${NC}"
diff_daemon "$PREV_DAEMON" "$DAEMON_RUNNING"
diff_int  "hive.workers" "$PREV_HIVE" "$HIVE_WORKERS" neutral

# Tier 6.6: HNSW backend chip. NAPI = healthy (~50× faster). WASM = silent
# perf cliff. "unknown" = inability to detect (treat as warn).
_hnsw_mark="${DIM}─${NC}"
_hnsw_color="$DIM"
case "$HNSW_BACKEND" in
  NAPI*) _hnsw_mark="${DIM}✓${NC}"; _hnsw_color="$DIM"; ((STABLE++)) || true ;;
  WASM*) _hnsw_mark="${YELLOW}!${NC}"; _hnsw_color="$YELLOW"; ((WARNED++)) || true ;;
  *)     _hnsw_mark="${YELLOW}!${NC}"; _hnsw_color="$YELLOW"; ((WARNED++)) || true ;;
esac
printf "   %b %-30s %b%s%b\n" "$_hnsw_mark" "runtime.hnswBackend" "$_hnsw_color" "$HNSW_BACKEND" "$NC"

# Long-baseline informational note
if [[ "$AGE_MS" -gt "$DAY7_MS" ]]; then
  echo ""
  echo -e " ${CYAN}→${NC} note: baseline is older than 7 days — consider --reset to re-baseline"
fi

# ── summary + verdict ───────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}============================================${NC}"
echo -e "  ${BOLD}Summary${NC}: ${GREEN}$GROWN grew${NC}  ${DIM}$STABLE stable${NC}  ${YELLOW}$WARNED warned${NC}  ${RED}$REGRESSED regressed${NC}"
if [[ "$REGRESSED" -gt 0 ]]; then
  echo -e "  ${BOLD}Verdict${NC}: ${RED}✗ regression detected${NC} — investigate"
elif [[ "$WARNED" -gt 0 ]]; then
  echo -e "  ${BOLD}Verdict${NC}: ${YELLOW}! partial${NC} — some growth metrics flatlined (loop may have paused)"
elif [[ "$GROWN" -gt 0 ]]; then
  echo -e "  ${BOLD}Verdict${NC}: ${GREEN}✓ healthy growth${NC}"
else
  echo -e "  ${BOLD}Verdict${NC}: ${DIM}✓ all stable${NC} (no growth, no regression)"
fi
echo -e "${BOLD}============================================${NC}"

# ── update snapshot + append history (unless --dry-run) ─────────────────────
if [[ "$MODE" != "dryrun" ]]; then
  write_snapshot
fi

# Exit code: 0 healthy/stable, 1 if a regression occurred (CI-friendly)
if [[ "$REGRESSED" -gt 0 ]]; then exit 1; fi
exit 0
