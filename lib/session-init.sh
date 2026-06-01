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

echo -e "\n${CYAN}[1/7]${NC} Applying ruflo patches"

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

echo -e "\n${CYAN}[2/7]${NC} Statusbar coexistence check"

if [[ -f "$KIT_LIB/fix-statusbar.sh" ]]; then
  STATUS_FIXES=$(bash "$KIT_LIB/fix-statusbar.sh" "$TARGET_DIR" 2>&1 | grep -c "✓" || true)
  STATUS_FIXES=${STATUS_FIXES:-0}
  pass "fix-statusbar.sh completed ($STATUS_FIXES checks passed)"
else
  warn "fix-statusbar.sh not found"
  ((ERRORS++)) || true
fi

# ── Step 3: Verify MCP server is running ─────────────────────────────────────

echo -e "\n${CYAN}[3/7]${NC} MCP server check"

MCP_PID=$(ps aux | grep "ruflo mcp start" | grep -v grep | awk '{print $2}' | head -1)
if [[ -n "$MCP_PID" ]]; then
  pass "MCP server running (PID $MCP_PID)"
else
  warn "MCP server not running — Claude Code should auto-start it"
  ((ERRORS++)) || true
fi

# ── Step 4: Daemon auto-start ────────────────────────────────────────────────

echo -e "\n${CYAN}[4/7]${NC} Daemon auto-start"

# `ruflo daemon status` always exits 0 with an ASCII box. Grep for the
# canonical "Status: ● RUNNING" line (U+25CF filled circle) and fall back
# to a literal "RUNNING" match for older versions. If not running, start it
# — this is the every-session re-seat that closes the "daemon died between
# sessions" gap.
DAEMON_STATUS_OUT="$(npx -y ruflo@latest daemon status 2>/dev/null || true)"
DAEMON_RUNNING=0
if echo "$DAEMON_STATUS_OUT" | grep -q $'Status: \xe2\x97\x8f RUNNING'; then DAEMON_RUNNING=1; fi
if [[ "$DAEMON_RUNNING" -eq 0 ]] && echo "$DAEMON_STATUS_OUT" | grep -qE 'Status:.*RUNNING'; then DAEMON_RUNNING=1; fi

if [[ "$DAEMON_RUNNING" -eq 1 ]]; then
  pass "daemon already running"
else
  info "daemon stopped — starting"
  if npx -y ruflo@latest daemon start >/tmp/ruflo-session-daemon-start.log 2>&1; then
    pass "daemon started"
  else
    warn "ruflo daemon start failed (see /tmp/ruflo-session-daemon-start.log)"
    ((ERRORS++)) || true
  fi
fi

# ── Step 5: Verify persistent storage ────────────────────────────────────────

echo -e "\n${CYAN}[5/7]${NC} Persistent storage check"

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

# ── Step 6: Verify AgentDB controllers ───────────────────────────────────────

echo -e "\n${CYAN}[6/7]${NC} AgentDB controller check"

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

# ── Step 7: RuVector native binaries ─────────────────────────────────────────

echo -e "\n${CYAN}[7/7]${NC} RuVector native binary check"

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
