#!/usr/bin/env bash
set -uo pipefail

# ============================================================================
# ruflo-session-init.sh — Initialize ruflo memory, intelligence & AgentDB
# Run at the start of each Claude Code session for 100% efficient ruflo usage.
# Usage: bin/ruflo-kit session <target>
# ============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
info() { echo -e "  ${CYAN}→${NC} $1"; }

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
kit_resolve "$@"
kit_require_target
cd "$TARGET_DIR"
ERRORS=0

echo "============================================"
echo " ruflo session init"
echo " kit:    $KIT_DIR"
echo " target: $TARGET_DIR"
echo "============================================"

# ── Step 1: Apply patches ────────────────────────────────────────────────────

echo -e "\n${CYAN}[1/9]${NC} Applying ruflo patches"

if [[ -f "$KIT_LIB/fix-ruflo.sh" ]]; then
  # Run fix-ruflo.sh silently, only show fixes
  FIXES=$(bash "$KIT_LIB/fix-ruflo.sh" "$TARGET_DIR" 2>&1 | grep -c "✓" || true)
  FIXES=${FIXES:-0}
  pass "fix-ruflo.sh completed ($FIXES checks passed)"
else
  warn "fix-ruflo.sh not found"
  ((ERRORS++)) || true
fi

# ── Step 2: Repair statusbar (ruflo + Agentic QE v3) ─────────────────────────

echo -e "\n${CYAN}[2/9]${NC} Statusbar coexistence check"

if [[ -f "$KIT_LIB/fix-statusbar.sh" ]]; then
  STATUS_FIXES=$(bash "$KIT_LIB/fix-statusbar.sh" "$TARGET_DIR" 2>&1 | grep -c "✓" || true)
  STATUS_FIXES=${STATUS_FIXES:-0}
  pass "fix-statusbar.sh completed ($STATUS_FIXES checks passed)"
else
  warn "fix-statusbar.sh not found"
  ((ERRORS++)) || true
fi

# ── Step 3: .claude/helpers module-type pin ──────────────────────────────────
# HELPER-MODULE-PIN-V1: in a "type":"module" project, Node loads the CJS helpers
# (router.js, hook-handler.cjs's deps) as ES modules → every PreCompact/SessionEnd
# hook crashes "require is not defined". fix-aqe applies this at init, but `aqe/
# ruflo init` regenerate the .js helpers, so re-heal it every session (cheap,
# idempotent, only acts on ESM projects).

echo -e "\n${CYAN}[3/9]${NC} Helper module-type pin (ESM-project hook crash guard)"

case "$(pin_helpers_module_type "$TARGET_DIR")" in
  PINNED)          pass "pinned .claude/helpers → commonjs (+github-safe.mjs) — fixes 'require is not defined' hook crash" ;;
  ALREADY)         pass "helper module-type already pinned (commonjs)" ;;
  NOT_ESM_PROJECT) pass "project root is commonjs — no helper pin needed" ;;
  NO_DIR)          warn ".claude/helpers not present yet (run: bin/ruflo-kit init)" ;;
  DRYRUN)          info "[dry-run] would pin .claude/helpers → commonjs (+github-safe.mjs)" ;;
  *)               : ;;
esac

# ── Step 4: Verify MCP server is running ─────────────────────────────────────

echo -e "\n${CYAN}[4/9]${NC} MCP server check"

MCP_PID=$(ps aux | grep "ruflo mcp start" | grep -v grep | awk '{print $2}' | head -1)
if [[ -n "$MCP_PID" ]]; then
  pass "MCP server running (PID $MCP_PID)"
else
  warn "MCP server not running — Claude Code should auto-start it"
  ((ERRORS++)) || true
fi

# ── Step 4: Daemon mode (opt-in by default) ──────────────────────────────────
#
# COST SAFETY: the daemon spawns billed `claude --print` LLM calls (sonnet/opus)
# every 10–30 min, 24/7, detached to launchd — it keeps spending with NO Claude
# Code session open. Auto-starting it here every session was the de-facto
# supervisor that made it "bill for days". Auto-start is therefore OPT-IN.
#
#   RUFLO_DAEMON_MODE=off   (default) — do NOT start; you run `ruflo daemon
#                                       start` yourself when you want the loop.
#   RUFLO_DAEMON_MODE=auto            — auto-start the persistent daemon every
#                                       session (the old always-on behavior).
#   RUFLO_DAEMON_MODE=once            — run a single worker pass this session
#                                       (`daemon trigger`), no persistent loop.
#
# DO NOT revert this to unconditional auto-start — see docs/_INSTRUCTIONS.md
# (Daemon cost-safety patch). The learning-loop value does not justify silent,
# unattended, 24/7 token spend.
RUFLO_DAEMON_MODE="${RUFLO_DAEMON_MODE:-off}"

echo -e "\n${CYAN}[5/9]${NC} Daemon mode (${RUFLO_DAEMON_MODE})"

# `ruflo daemon status` always exits 0 with an ASCII box. Grep for the
# canonical "Status: ● RUNNING" line (U+25CF filled circle) and fall back
# to a literal "RUNNING" match for older versions.
DAEMON_STATUS_OUT="$(ruflo daemon status 2>/dev/null || true)"
DAEMON_RUNNING=0
if echo "$DAEMON_STATUS_OUT" | grep -q $'Status: \xe2\x97\x8f RUNNING'; then DAEMON_RUNNING=1; fi
if [[ "$DAEMON_RUNNING" -eq 0 ]] && echo "$DAEMON_STATUS_OUT" | grep -qE 'Status:.*RUNNING'; then DAEMON_RUNNING=1; fi

case "$RUFLO_DAEMON_MODE" in
  auto)
    if [[ "$DAEMON_RUNNING" -eq 1 ]]; then
      pass "daemon already running"
    else
      info "daemon stopped — starting (RUFLO_DAEMON_MODE=auto)"
      if ruflo daemon start >/tmp/ruflo-session-daemon-start.log 2>&1; then
        pass "daemon started"
      else
        warn "ruflo daemon start failed (see /tmp/ruflo-session-daemon-start.log)"
        ((ERRORS++)) || true
      fi
    fi
    ;;
  once)
    info "single worker pass (RUFLO_DAEMON_MODE=once) — no persistent loop"
    if ruflo daemon trigger -w audit >/tmp/ruflo-session-daemon-trigger.log 2>&1; then
      pass "worker pass complete"
    else
      warn "daemon trigger failed (see /tmp/ruflo-session-daemon-trigger.log)"
    fi
    ;;
  *)
    if [[ "$DAEMON_RUNNING" -eq 1 ]]; then
      info "daemon running but RUFLO_DAEMON_MODE=off — leaving it (you started it)"
    else
      info "daemon auto-start OFF (cost-safe default)"
      info "  • opt in:  export RUFLO_DAEMON_MODE=auto   (persistent loop)"
      info "  • one-shot: ruflo daemon trigger -w audit  (single pass)"
    fi
    ;;
esac

# ── Step 5: Verify persistent storage ────────────────────────────────────────

echo -e "\n${CYAN}[6/9]${NC} Persistent storage check"

MEMORY_DB="$TARGET_DIR/.swarm/memory.db"
HNSW_INDEX="$TARGET_DIR/.swarm/hnsw.index"
GRAPH_STATE="$TARGET_DIR/.claude-flow/data/graph-state.json"
INTEL_SNAPSHOT="$TARGET_DIR/.claude-flow/data/intelligence-snapshot.json"

if [[ -f "$MEMORY_DB" ]]; then
  DB_SIZE=$(du -h "$MEMORY_DB" | awk '{print $1}')
  pass "memory.db: $DB_SIZE"
else
  fail "memory.db missing — run: npx ruflo@latest memory store --key init --value ok"
  ((ERRORS++)) || true
fi

if [[ -f "$HNSW_INDEX" ]]; then
  IDX_SIZE=$(du -h "$HNSW_INDEX" | awk '{print $1}')
  pass "hnsw.index: $IDX_SIZE"
else
  warn "hnsw.index not found (will be created on first vector operation)"
fi

if [[ -f "$GRAPH_STATE" ]]; then
  NODE_COUNT=$(node -e "try{const d=require('$GRAPH_STATE');console.log(d.nodeCount||Object.keys(d.nodes||{}).length||0)}catch{console.log(0)}" 2>/dev/null)
  EDGE_COUNT=$(node -e "try{const d=require('$GRAPH_STATE');console.log(d.edges?.length||0)}catch{console.log(0)}" 2>/dev/null)
  pass "graph-state.json: $NODE_COUNT nodes, $EDGE_COUNT edges"
else
  warn "graph-state.json not found"
fi

if [[ -f "$INTEL_SNAPSHOT" ]]; then
  SNAP_SIZE=$(du -h "$INTEL_SNAPSHOT" | awk '{print $1}')
  pass "intelligence-snapshot.json: $SNAP_SIZE"
else
  warn "intelligence-snapshot.json not found"
fi

# Stray RVF .agentic-qe advisory (RVF-STRAY-SWEEP-V1): the cwd-relative RVF path
# resolution scatters RVF-only .agentic-qe dirs across subfolders. Read-only here —
# removal is gated behind `fix-learning --cleanup --confirm`.
sweep_stray_aqe_dirs "$TARGET_DIR" list >/dev/null 2>&1 || true
if [[ "${SWEEP_STRAY_COUNT:-0}" -gt 0 ]]; then
  warn "$SWEEP_STRAY_COUNT stray RVF .agentic-qe dir(s) (cwd-relative scatter) — clean with: bin/ruflo-kit fix-learning $TARGET_DIR --cleanup --confirm"
else
  pass "no stray RVF .agentic-qe dirs (root store is the only one)"
fi

# ── Step 6: Verify AgentDB controllers ───────────────────────────────────────

echo -e "\n${CYAN}[7/9]${NC} AgentDB controller check"

# Durable on-disk schema for the standalone agentdb MCP store (issue #4 gap #1):
# without it, db_stats/agentdb_stats error after every session restart (the schema
# lives only in the server's memory). Idempotent — only inits a 0-byte/missing db.
case "$(ensure_agentdb_schema "$TARGET_DIR")" in
  INITIALIZED) pass "agentdb.db schema initialized on disk (durable across restarts — was ephemeral)" ;;
  PRESENT)     pass "agentdb.db on-disk schema present (db_stats survives restart)" ;;
  NO_CLI)      warn "agentdb CLI not found — cannot persist schema; install: npm i -g agentdb" ;;
  FAILED)      warn "agentdb init did not write a schema (see /tmp/agentdb-init-schema.log)" ;;
  *)           : ;;
esac

# Use npx to query the MCP server
CONTROLLERS=$(npx ruflo@latest memory list --namespace pattern --limit 1 2>&1)
if echo "$CONTROLLERS" | grep -q "error\|Error\|ECONNREFUSED"; then
  warn "Cannot query MCP — server may not be ready yet"
  info "After Claude Code starts, verify with: agentdb_controllers"
else
  pass "MCP tools accessible"
fi

# Tier 7 invariant: the live MCP launches from the GLOBAL ruflo, and its
# controller registry resolves a NESTED agentdb that must be 3.0.0-alpha.10
# for all 7 advanced controllers to activate (alpha.14 regressed the classes).
# Verify the global tree's nested agentdb version — not the npx cache (which
# reverts on every npx call and is no longer the launch path). See Patch 18.
EXPECT_AGENTDB="3.0.0-alpha.10"
GLOBAL_MEM=$(find ~/.nvm/versions /usr/local/lib/node_modules /opt/homebrew/lib/node_modules \
  -path "*ruflo/node_modules/@claude-flow/memory/dist/controller-registry.js" 2>/dev/null | head -1)
if [[ -n "$GLOBAL_MEM" ]]; then
  NESTED_AGENTDB="$(dirname "$(dirname "$GLOBAL_MEM")")/node_modules/agentdb/package.json"
  NESTED_VER="$(node -e "try{console.log(require('$NESTED_AGENTDB').version)}catch{console.log('missing')}" 2>/dev/null)"
  if [[ "$NESTED_VER" == "$EXPECT_AGENTDB" ]]; then
    pass "Global controller-registry resolves agentdb@$NESTED_VER (7 controllers active)"
  else
    warn "Global nested agentdb is $NESTED_VER (expected $EXPECT_AGENTDB) — 7 controllers will be dormant"
    info "Re-applying via fix-ruflo.sh (Step 3b)..."
    bash "$KIT_LIB/fix-ruflo.sh" "$TARGET_DIR" 2>&1 | grep -E "3b/11|controller|alpha\.10" | head -5
    ((ERRORS++)) || true
  fi
else
  warn "No GLOBAL ruflo controller-registry found — install ruflo globally (npm i -g ruflo); the MCP launches from the global tree (Patch 18)"
  ((ERRORS++)) || true
fi

# AGENTDB-GLOBAL-MCP-V1: the SEPARATE agentdb stdio MCP server launches from the
# GLOBAL `agentdb` binary and needs better-sqlite3 (a peer dep npm/npx do NOT
# auto-install) resolvable, else it dies on startup → /mcp -32000. Three asserts:
# (1) global agentdb pinned to alpha.10, (2) better-sqlite3 resolvable from
# agentdb's context, (3) .mcp.json uses the global launch form (not npx).
EXPECT_AGENTDB_GLOBAL="3.0.0-alpha.10"
GLOBAL_AGENTDB_VER="$(npm list -g agentdb --depth=0 2>/dev/null | grep "agentdb@" | sed 's/.*agentdb@//' | tr -d '[:space:]')"
if [[ "$GLOBAL_AGENTDB_VER" == "$EXPECT_AGENTDB_GLOBAL" ]]; then
  pass "Global agentdb@$GLOBAL_AGENTDB_VER pinned (MCP launcher)"
else
  warn "Global agentdb is '${GLOBAL_AGENTDB_VER:-missing}' (expected $EXPECT_AGENTDB_GLOBAL) — re-run fix-ruflo Step 5a (AGENTDB-GLOBAL-MCP-V1)"
  ((ERRORS++)) || true
fi

GLOBAL_NM="$(npm root -g 2>/dev/null)"
# require() (load), not just require.resolve() — catches a NODE_MODULE_VERSION
# ABI mismatch (present but stale after a node upgrade) that would still -32000.
if [[ -n "$GLOBAL_NM" ]] && \
   node -e "const p=require.resolve('better-sqlite3',{paths:['$GLOBAL_NM/agentdb','$GLOBAL_NM']});if(!p.startsWith('$GLOBAL_NM'))process.exit(3);require(p)" >/dev/null 2>&1; then
  pass "better-sqlite3 loads from agentdb context (no -32000)"
else
  warn "better-sqlite3 NOT loadable from agentdb context (missing or ABI-stale) — agentdb MCP will -32000; re-run fix-ruflo Step 5a (AGENTDB-GLOBAL-MCP-V1)"
  ((ERRORS++)) || true
fi

MCP_JSON="$TARGET_DIR/.mcp.json"
if [[ -f "$MCP_JSON" ]] && command -v jq >/dev/null 2>&1; then
  ADB_LAUNCH="$(jq -r '.mcpServers.agentdb.command // ""' "$MCP_JSON" 2>/dev/null)"
  case "$ADB_LAUNCH" in
    agentdb) pass ".mcp.json agentdb uses global launch (command:\"agentdb\")" ;;
    npx)     warn ".mcp.json agentdb still launches via npx — re-run fix-ruflo Step 5b (AGENTDB-GLOBAL-MCP-V1)"; ((ERRORS++)) || true ;;
    *)       warn ".mcp.json agentdb launch command is '${ADB_LAUNCH:-unset}' (expected 'agentdb') — re-run fix-ruflo Step 5b"; ((ERRORS++)) || true ;;
  esac
fi

# ── Step 7: RuVector native binaries ─────────────────────────────────────────

echo -e "\n${CYAN}[8/9]${NC} RuVector native binary check"

# Platform-correct native-binary tag (darwin-arm64 / linux-arm64-gnu / …) and
# search roots (npx cache + global-ruflo nested node_modules). Both come from
# common.sh so session + health agree. Fixes false "native not found" on
# linux-arm64 hosts (e.g. DGX Spark): the old map sent arm64 → darwin-arm64 and
# searched only ~/.npm/_npx, missing the real linux-arm64-gnu binary under the
# global ruflo install. WASM fallback covers any genuine absence (slower, fine).
ARCH="$(ruvector_platform_tag)"
ROOTS=(); while IFS= read -r r; do [[ -n "$r" && -e "$r" ]] && ROOTS+=("$r"); done < <(ruvector_search_roots)

_find_native() { [[ ${#ROOTS[@]} -gt 0 ]] && find "${ROOTS[@]}" -name "$1" 2>/dev/null | head -1; }
SONA_BIN=$(_find_native "sona.$ARCH.node")
ATTENTION_BIN=$(_find_native "attention.$ARCH.node")
GRAPH_BIN=$(_find_native "ruvector-graph*.node")

[[ -n "$SONA_BIN" ]] && pass "SONA native: $ARCH" || warn "SONA native not found for $ARCH (WASM fallback active)"
[[ -n "$ATTENTION_BIN" ]] && pass "Attention native: $ARCH" || warn "Attention native not found for $ARCH (WASM fallback active)"
[[ -n "$GRAPH_BIN" ]] && pass "GNN native: found" || warn "GNN native not found (WASM fallback active)"

# ── Step 9: Self-learning loop liveness (read-only diagnostic) ────────────────
# Surfaces the issue #4 "enabled-but-hollow" class: controllers report active but
# the structured stores are empty / the neural trainer is in JS fallback / HNSW
# is unindexed. Read-only; NON-FATAL (a fresh project is legitimately hollow —
# it populates from real agent activity over time), so it never flips the session
# exit code, it just points at fix-learning.

echo -e "\n${CYAN}[9/9]${NC} Self-learning loop liveness (read-only)"

if [[ -f "$KIT_LIB/verify-learning.sh" ]]; then
  VL_JSON="$(bash "$KIT_LIB/verify-learning.sh" "$TARGET_DIR" --json 2>/dev/null | tail -1)"
  VL_VERDICT="$(node -e "try{process.stdout.write((JSON.parse(process.argv[1]).verdict)||'unknown')}catch(e){process.stdout.write('unknown')}" "$VL_JSON" 2>/dev/null || echo unknown)"
  case "$VL_VERDICT" in
    live)    pass "learning loop live" ;;
    partial) warn "learning loop partial (non-fatal) — detail: bin/ruflo-kit verify-learning $TARGET_DIR" ;;
    hollow)  warn "learning loop HOLLOW — run: bin/ruflo-kit fix-learning $TARGET_DIR (stop daemon + live Claude Code first)" ;;
    *)       info "learning-loop verdict unavailable (verify-learning could not run)" ;;
  esac
else
  warn "verify-learning.sh not found"
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "============================================"
echo " Session Init Summary"
echo "============================================"

if [[ "$ERRORS" -eq 0 ]]; then
  echo -e "  ${GREEN}All systems ready${NC}"
else
  echo -e "  ${YELLOW}$ERRORS issue(s) — see warnings above${NC}"
fi

echo ""
echo "  Next steps (in Claude Code):"
echo "    1. Verify: agentdb_controllers → active: 23/23 (all 7 advanced controllers on)"
echo "    2. Search: memory_search 'audio recording' → should find audit data"
echo "    3. Activate intelligence: use hooks_intelligence_trajectory-start"
echo "       during swarm work to begin SONA learning"
echo ""

exit "$( [[ "$ERRORS" -gt 0 ]] && echo 1 || echo 0 )"
