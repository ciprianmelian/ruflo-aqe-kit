#!/usr/bin/env bash
set -uo pipefail
# Note: -e intentionally omitted — ((var++)) returns 1 when var=0, which
# would kill the script under set -e. We handle errors explicitly instead.

# ============================================================================
# fix-ruflo.sh — Diagnose and fix ruflo/claude-flow MCP setup
# Run from any project root: bin/ruflo-kit fix-ruflo <target> [--dry-run]
# ============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
kit_resolve "$@"
kit_require_target

# Log file for persistent record
LOG_FILE="${TMPDIR:-/tmp}/fix-ruflo-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
info() { echo -e "  ${CYAN}→${NC} $1"; }
header() { echo -e "\n${CYAN}[$1]${NC} $2"; }

# Track what was fixed for summary
FIXES=0
ERRORS=0
FIX_LOG=()
fix() { ((FIXES++)) || true; FIX_LOG+=("$1"); }

cd "$TARGET_DIR"
TARGET_DIR="$TARGET_DIR"
HOME_DIR="$HOME"
MCP_JSON="$TARGET_DIR/.mcp.json"

echo "============================================"
echo " ruflo diagnostic & fix"
echo " kit:    $KIT_DIR"
echo " target: $TARGET_DIR"
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo -e " mode:    ${YELLOW}DRY RUN${NC} (no changes)"
fi
echo " log:     $LOG_FILE"
echo "============================================"

# ── Step 1: Environment ──────────────────────────────────────────────────────

header "1/11" "Environment"

NODE_PATH="$(which node 2>/dev/null || echo '')"
if [[ -z "$NODE_PATH" ]]; then
  fail "Node.js not found"
  exit 1
fi
pass "Node: $(node --version) at $NODE_PATH"

RUFLO_PATH="$(which ruflo 2>/dev/null || echo '')"
if [[ -n "$RUFLO_PATH" ]]; then
  RUFLO_VER="$(ruflo --version 2>/dev/null || echo 'unknown')"
  pass "Global ruflo: $RUFLO_VER at $RUFLO_PATH"
else
  warn "No global ruflo — will install"
fi

# ── Step 2: Remove stale global claude-flow ──────────────────────────────────

header "2/11" "Stale global packages"

if npm list -g claude-flow 2>/dev/null | grep -q "claude-flow@"; then
  info "Removing stale global claude-flow (renamed to ruflo)"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] Would: npm uninstall -g claude-flow"
  else
    npm uninstall -g claude-flow 2>/dev/null || true
    fix "Removed stale global claude-flow"
    pass "Removed claude-flow"
  fi
else
  pass "No stale claude-flow"
fi

# Install/update global ruflo
LATEST_RUFLO="$(npm view ruflo version 2>/dev/null || echo '')"
INSTALLED_RUFLO="$(npm list -g ruflo --depth=0 2>/dev/null | grep "ruflo@" | sed 's/.*ruflo@//' | tr -d '[:space:]' || echo '')"

# Normalize: strip whitespace for clean comparison
LATEST_RUFLO="$(echo "$LATEST_RUFLO" | tr -d '[:space:]')"
INSTALLED_RUFLO="$(echo "$INSTALLED_RUFLO" | tr -d '[:space:]')"

if [[ -z "$INSTALLED_RUFLO" ]]; then
  info "Installing ruflo@latest globally"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] Would: npm install -g ruflo@latest"
  else
    npm install -g ruflo@latest 2>/dev/null && {
      fix "Installed ruflo@$LATEST_RUFLO"
      INSTALLED_RUFLO="$LATEST_RUFLO"
      pass "Installed ruflo@$LATEST_RUFLO"
    } || {
      fail "npm install -g ruflo@latest failed"
      ((ERRORS++)) || true
    }
  fi
elif [[ "$INSTALLED_RUFLO" != "$LATEST_RUFLO" && -n "$LATEST_RUFLO" ]]; then
  info "Updating ruflo: $INSTALLED_RUFLO → $LATEST_RUFLO"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] Would: npm install -g ruflo@latest"
  else
    npm install -g ruflo@latest 2>/dev/null && {
      fix "Updated ruflo to $LATEST_RUFLO"
      INSTALLED_RUFLO="$LATEST_RUFLO"
      pass "Updated ruflo to $LATEST_RUFLO"
    } || {
      fail "npm install -g ruflo@latest failed"
      ((ERRORS++)) || true
    }
  fi
else
  pass "ruflo@$INSTALLED_RUFLO is current"
fi

# ── Step 3: Shadow agentdb ───────────────────────────────────────────────────

header "3/11" "Shadow agentdb detection"

# Check home directory for shadow agentdb
if [[ -d "$HOME_DIR/node_modules/agentdb" ]]; then
  SHADOW_VER="$(node -e "try{console.log(require('$HOME_DIR/node_modules/agentdb/package.json').version)}catch{console.log('?')}" 2>/dev/null)"
  # Check if it exports AgentDB class
  HAS_CLASS="$(node --input-type=module -e "
    try {
      const m = await import('$HOME_DIR/node_modules/agentdb/dist/src/index.js');
      console.log(typeof m.AgentDB === 'function' ? 'yes' : 'no');
    } catch { console.log('no'); }
  " 2>/dev/null || echo 'no')"

  if [[ "$HAS_CLASS" != "yes" ]]; then
    # Check ~/package.json for explicit dependency
    if grep -q '"agentdb"' "$HOME_DIR/package.json" 2>/dev/null; then
      warn "Shadow agentdb@$SHADOW_VER at ~/node_modules (listed in ~/package.json — skipping removal)"
      warn "Consider pinning agentdb@3.0.0-alpha.10 in ~/package.json (the controller-bearing pin — see Patch 18; do NOT use alpha.12+)"
    else
      info "Removing shadow agentdb@$SHADOW_VER at ~/node_modules (orphan, no AgentDB class)"
      if [[ "$DRY_RUN" -eq 1 ]]; then
        info "[dry-run] Would: rm -rf $HOME_DIR/node_modules/agentdb"
      else
        rm -rf "$HOME_DIR/node_modules/agentdb"
        fix "Removed shadow agentdb from ~/node_modules"
        pass "Shadow removed"
      fi
    fi
  else
    # shellcheck disable=SC2088  # literal ~ in a human-readable message, not a path
    pass "~/node_modules/agentdb@$SHADOW_VER exports AgentDB class (OK)"
  fi
else
  pass "No shadow agentdb at ~/node_modules"
fi

# Check project node_modules for shadow
if [[ -d "$TARGET_DIR/node_modules/agentdb" ]]; then
  PROJ_SHADOW_VER="$(node -e "try{console.log(require('$TARGET_DIR/node_modules/agentdb/package.json').version)}catch{console.log('?')}" 2>/dev/null)"
  if grep -q '"agentdb"' "$TARGET_DIR/package.json" 2>/dev/null; then
    warn "Project has agentdb@$PROJ_SHADOW_VER in node_modules (explicit dependency — kept)"
  else
    info "Removing orphan agentdb@$PROJ_SHADOW_VER from project node_modules"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] Would: rm -rf $TARGET_DIR/node_modules/agentdb"
    else
      rm -rf "$TARGET_DIR/node_modules/agentdb"
      fix "Removed orphan agentdb from project"
      pass "Project shadow removed"
    fi
  fi
else
  pass "No shadow agentdb in project"
fi

# Check npx cache subtrees for orphan agentdb shadows.
# These break bare import('agentdb') resolution inside controller-registry.js.
# IMPORTANT: skip nested @claude-flow/*/node_modules/agentdb — those are bundled
# deps and must be kept. Only top-level orphans with major < 3 are removed.
NPX_SHADOW_COUNT=0
if [[ -d "$HOME_DIR/.npm/_npx" ]]; then
  while IFS= read -r shadow_pkg; do
    [[ -z "$shadow_pkg" ]] && continue
    # Skip bundled agentdb under @claude-flow/* — those are intentional
    if [[ "$shadow_pkg" == *"/@claude-flow/"*"/node_modules/agentdb/package.json" ]]; then
      continue
    fi
    SHADOW_DIR="$(dirname "$shadow_pkg")"
    NPX_SHADOW_VER="$(node -e "try{console.log(require('$shadow_pkg').version)}catch{console.log('?')}" 2>/dev/null)"
    # Parse major version (strip pre-release suffix). Default to 0 on parse failure.
    NPX_SHADOW_MAJOR="$(echo "$NPX_SHADOW_VER" | sed 's/[^0-9.].*//' | cut -d. -f1)"
    NPX_SHADOW_MAJOR="${NPX_SHADOW_MAJOR:-0}"
    if ! [[ "$NPX_SHADOW_MAJOR" =~ ^[0-9]+$ ]]; then
      NPX_SHADOW_MAJOR=0
    fi
    if [[ "$NPX_SHADOW_MAJOR" -lt 3 ]]; then
      info "Removing orphan npx shadow: agentdb@$NPX_SHADOW_VER at $SHADOW_DIR"
      if [[ "$DRY_RUN" -eq 1 ]]; then
        info "[dry-run] Would: rm -rf $SHADOW_DIR"
        ((NPX_SHADOW_COUNT++)) || true
      else
        rm -rf "$SHADOW_DIR"
        fix "Removed orphan npx agentdb@$NPX_SHADOW_VER shadow"
        ((NPX_SHADOW_COUNT++)) || true
      fi
    else
      pass "npx agentdb@$NPX_SHADOW_VER at $SHADOW_DIR (v3+, kept)"
    fi
  done < <(find "$HOME_DIR/.npm/_npx" -path "*/node_modules/agentdb/package.json" 2>/dev/null)
fi

if [[ "$NPX_SHADOW_COUNT" -eq 0 ]]; then
  pass "No orphan agentdb shadows in npx caches"
else
  pass "Processed $NPX_SHADOW_COUNT orphan npx agentdb shadow(s)"
  # Tier 6.4: louder follow-up. The npx cache layout re-hoists nested
  # agentdb@2 (a transitive dep of older @claude-flow/memory builds) on
  # every `npx -y ruflo` resolution. The hoist is upstream behavior — this
  # loop only cleans the orphan, not the cause. Surface the cycle so the
  # user understands why this never stays clean after a wipe.
  warn "Removed $NPX_SHADOW_COUNT agentdb@<3 orphan(s) — npx caches re-hoist on every 'npx -y ruflo' call."
  warn "This is upstream behavior (ruflo's transitive deps include nested agentdb@2). Re-run after any npx wipe + rehydrate (e.g. after upgrade-2026-05-26.sh)."
fi

# ── Step 3b: Force controller-registry's agentdb to alpha.10 (Tier 7) ─────────
# The 7 advanced AgentDB controllers report `enabled:false` via
# `mcp__claude-flow__agentdb_controllers` (16/23 active). Root cause:
# @claude-flow/memory's controller-registry.js gates them on a bare
# `await import('agentdb')` exposing classes — MutationGuard, AttestationLog,
# GNNService, RVFOptimizer, GuardedVectorBackend, SemanticRouter — that ONLY
# agentdb@3.0.0-alpha.10 exports. memory declares `agentdb ^3.0.0-alpha.14`,
# but alpha.14 REGRESSED those exports (the alpha.12 architectural pivot), so
# the nested @claude-flow/memory/node_modules/agentdb (alpha.14) leaves 6 of
# them dark. We force that NESTED slot to alpha.10. NOTE on graphAdapter (the
# 7th): it is NOT a top-level class export in alpha.10, so a minimal/uninit
# AgentDB probe shows it absent — but on the FULLY-initialized server instance
# the registry reads it via the internal `agentdb.graphAdapter` field, which IS
# populated at runtime. Verified live: all 23 controllers report enabled (7/7
# recovered) after forcing alpha.10 + Claude Code restart.
#
# CRITICAL — global install only, NOT npx caches: every `npx -y ruflo@latest`
# invocation reconciles its cache tree back to the declared `^alpha.14`,
# clobbering alpha.10 on every call (incl. the MCP server's own startup). So
# the npx cache cannot be durably patched. The fix only sticks in the GLOBAL
# install (`npm -g`), which npx never reconciles — which is exactly why this
# project's `.mcp.json` launches claude-flow via the global `ruflo` binary
# (command:"ruflo", not `npx -y ruflo@latest`). See _INSTRUCTIONS.md Patch 18.
# NOTE: the live MCP only picks this up after a Claude Code restart (ESM module
# cache holds the old copy for the process lifetime).
AGENTDB_FORCE_VERSION="3.0.0-alpha.10"
AGENTDB_STABLE_CACHE="$HOME_DIR/.cache/ruflo-agentdb-$AGENTDB_FORCE_VERSION"
header "3b/11" "Force agentdb@$AGENTDB_FORCE_VERSION in controller-registry (unlocks all 7 dormant controllers)"

# Ensure a stable, npx-wipe-proof source of the package (with its deps hoisted).
ensure_agentdb_source() {
  if [[ -f "$AGENTDB_STABLE_CACHE/node_modules/agentdb/package.json" ]]; then
    local v
    v="$(node -e "try{console.log(require('$AGENTDB_STABLE_CACHE/node_modules/agentdb/package.json').version)}catch{console.log('?')}" 2>/dev/null)"
    [[ "$v" == "$AGENTDB_FORCE_VERSION" ]] && return 0
  fi
  info "Populating stable agentdb@$AGENTDB_FORCE_VERSION cache at $AGENTDB_STABLE_CACHE"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] Would: npm install agentdb@$AGENTDB_FORCE_VERSION --prefix $AGENTDB_STABLE_CACHE"
    return 1
  fi
  mkdir -p "$AGENTDB_STABLE_CACHE"
  if npm install "agentdb@$AGENTDB_FORCE_VERSION" --prefix "$AGENTDB_STABLE_CACHE" --no-save --no-audit --no-fund >/dev/null 2>&1; then
    return 0
  fi
  warn "Could not populate stable agentdb@$AGENTDB_FORCE_VERSION cache (npm install failed)"
  ((ERRORS++)) || true
  return 1
}

# SONA fix (Tier 7): the agentdb LearningSystem does `import('@ruvector/sona')`,
# but the @ruvector/sona that resolves from the nested context is a STUB
# (package.json + README, NO index.js) → import throws ERR_MODULE_NOT_FOUND →
# SonaTrajectoryService falls back to in-memory ("Sona unavailable"). A COMPLETE
# copy (index.js + native sona.<arch>.node, incl. darwin-arm64) ships inside
# @claude-flow/neural. Copy it into the nested agentdb's OWN node_modules so the
# import resolves the complete package → native SONA RL learning (NOT Rosetta —
# the failure was a missing JS entry, not an arch mismatch). Idempotent. Runs on
# BOTH the force path and the already-alpha.10 path (agentdb dir present either way).
ensure_nested_sona() {
  local nested="$1/node_modules/agentdb"
  [[ -d "$nested" && "$DRY_RUN" -ne 1 ]] || return 0
  [[ -f "$nested/node_modules/@ruvector/sona/index.js" ]] && return 0
  local _root _sona_src
  _root="$(cd "$1/../.." 2>/dev/null && pwd)"   # .../<ruflo>/node_modules
  _sona_src="$(find "$_root" -maxdepth 7 -path "*@ruvector/sona/index.js" 2>/dev/null | head -1)"
  if [[ -n "$_sona_src" ]]; then
    mkdir -p "$nested/node_modules/@ruvector"
    rm -rf "$nested/node_modules/@ruvector/sona"
    cp -R "$(dirname "$_sona_src")" "$nested/node_modules/@ruvector/sona"
    fix "Installed complete @ruvector/sona into nested agentdb (native SONA RL learning)"
  else
    warn "No complete @ruvector/sona (with index.js) found under $_root — SONA stays in-memory fallback"
  fi
}

# SONA fix part 2 (Tier 7.1): ensure_nested_sona repairs the agentdb-NESTED
# @ruvector/sona (used by AgentDB's LearningSystem). But the ruflo CLI's
# @claude-flow/cli/dist/src/services/ruvector-training.js does its own
# `import('@ruvector/sona')`, which hoist-resolves to the TOP-LEVEL
# <ruflo>/node_modules/@ruvector/sona — and THAT copy is also a STUB (no
# index.js, no native .node), so `require.resolve('@ruvector/sona')` from the
# CLI fails, `new SonaEngine()` throws (swallowed), sonaEngine stays null and
# signalsProcessed:0. Repair the top-level copy too, from the same complete
# package that ships in @claude-flow/neural. Idempotent; $1 = a @claude-flow/memory dir.
ensure_toplevel_sona() {
  [[ "$DRY_RUN" -ne 1 ]] || return 0
  local _root tgt _sona_src
  _root="$(cd "$1/../.." 2>/dev/null && pwd)" || return 0   # .../<ruflo>/node_modules
  [[ -n "$_root" ]] || return 0
  tgt="$_root/@ruvector/sona"
  [[ -f "$tgt/index.js" ]] && return 0   # already complete
  _sona_src="$(find "$_root" -maxdepth 7 -path "*@ruvector/sona/index.js" 2>/dev/null | head -1)"
  if [[ -n "$_sona_src" ]]; then
    mkdir -p "$_root/@ruvector"
    rm -rf "$tgt"
    cp -R "$(dirname "$_sona_src")" "$tgt"
    fix "Installed complete @ruvector/sona at top level (ruflo CLI native SONA can load)"
  else
    warn "No complete @ruvector/sona (with index.js) found under $_root — CLI SONA stays unavailable"
  fi
}

# SONA train() wiring (Tier 7.2): ruflo's LocalSonaCoordinator.endTrajectory computes a
# real verdict reward (success=1.0/partial=0.5/failure=-0.5) but dead-ends it into
# ReasoningBank confidence-scalar nudges — it NEVER calls the JS LoRAAdapter.train(), so
# the adapter B matrix stays zero-init forever (no real learning; all lora checkpoints B=0).
# The WASM SONA microLoRA is a SEPARATE adapter whose trained weights never reach the
# visible artifacts (confirmed via ruvector crate audit: serialize_state omits A/B). So the
# correct, reversible, no-rebuild seam is to drive the JS LoRAAdapter.train() — the only path
# that persists A/B to .swarm/lora-weights.json. Insert a guarded train() drive into
# endTrajectory; the reward then actually moves B and persists. Validated live: 6 verdicts ->
# B.sumAbs 0 -> 0.054 (all 3072 entries nonzero). Idempotent (SONA-TRAIN-V1), reversible
# (.sona-train-bak). $1 = a @claude-flow/memory dir; intelligence.js is a sibling under cli/.
wire_sona_train() {
  [[ "$DRY_RUN" -ne 1 ]] || return 0
  local cfroot intel
  cfroot="$(cd "$1/.." 2>/dev/null && pwd)" || return 0   # .../node_modules/@claude-flow
  intel="$cfroot/cli/dist/src/memory/intelligence.js"
  [[ -f "$intel" ]] || return 0
  grep -q "SONA-TRAIN-V1" "$intel" && { pass "SONA train() wiring already present"; return 0; }
  [[ -f "$intel.sona-train-bak" ]] || cp "$intel" "$intel.sona-train-bak"
  local patcher; patcher="$(mktemp)"
  cat > "$patcher" <<'PJS'
const fs = require('fs'); const F = process.argv[2];
let s = fs.readFileSync(F, 'utf8');
if (s.includes('SONA-TRAIN-V1')) { process.exit(0); }
const uniq = "        // Clear current trajectory\n        this.currentTrajectorySteps = [];\n        return { reward, patternsUpdated };";
if (!s.includes(uniq)) { console.error('ANCHOR_NOT_FOUND'); process.exit(2); }
const block = [
"        // SONA-TRAIN-V1: drive the real JS LoRA trainer from the verdict reward so",
"        // the adapter B matrix actually learns (persists to .swarm/lora-weights.json).",
"        // The confidence nudges above only touch ReasoningBank scalars; without this the",
"        // LoRA B stays zero-init forever. Additive + guarded; never breaks endTrajectory.",
"        try {",
"            const { getLoRAAdapter } = await import('../ruvector/lora-adapter.js');",
"            const _ad = await getLoRAAdapter();",
"            const _dim = (_ad && _ad.config && _ad.config.inputDim) || 0;",
"            let _trained = 0;",
"            for (const _st of this.currentTrajectorySteps) {",
"                if (!_st.embedding || _st.embedding.length === 0) continue;",
"                if (_dim && _st.embedding.length !== _dim) continue;",
"                _ad.train(_st.embedding, _st.embedding, reward);",
"                _trained++;",
"            }",
"            if (_trained > 0) _ad.saveWeights();",
"        } catch (e) { /* SONA-TRAIN-V1: trainer optional, never break endTrajectory */ }",
""
].join('\n');
s = s.replace(uniq, block + uniq);
fs.writeFileSync(F, s);
PJS
  node "$patcher" "$intel"; local rc=$?; rm -f "$patcher"
  # rc=2 = ANCHOR_NOT_FOUND: file untouched, node --check would pass trivially —
  # claiming success here is the false-✓ bug (Integrity Rule). Warn instead.
  if [[ $rc -ne 0 ]]; then
    warn "SONA-TRAIN-V1 anchor not found in intelligence.js (dist drift) — re-anchor needed, NOT applied"
    return 0
  fi
  if node --check "$intel" 2>/dev/null; then
    fix "Wired endTrajectory -> LoRAAdapter.train() so SONA actually learns (SONA-TRAIN-V1)"
  else
    warn "SONA-TRAIN-V1 produced invalid intelligence.js — restoring backup"
    cp "$intel.sona-train-bak" "$intel"
  fi
}

# Neural checkpoint fix (Tier 7.3): the `neural train` command trains the WASM microLoRA but
# then constructs a FRESH JS LoRAAdapter and immediately saveCheckpoint()s it — serializing
# the zero-init (B=0), so every lora-checkpoint-*.json was untrained. saveCheckpoint falls
# through to the JS exportWeights() JSON (ruvllm pipeline is a no-op here), so training the JS
# adapter on the same collected `embeddings` before saving makes the checkpoint reflect real
# learning. Validated: checkpoint B.sumAbs 0 -> 0.057. Idempotent (NEURAL-CKPT-V1), reversible
# (.neural-ckpt-bak). $1 = a @claude-flow/memory dir; neural.js is a sibling under cli/.
train_neural_checkpoint() {
  [[ "$DRY_RUN" -ne 1 ]] || return 0
  local cfroot nf
  # Self-retire (#2549, ruflo >=3.19): `neural train` now routes through the native
  # @ruvector/ruvllm TrainingPipeline, whose checkpoints ARE the trained weights;
  # the fresh-adapter save survives only as an explicit fallback (guarded by
  # `nativeResult?.checkpointPath`) for hosts without native builds — which
  # NATIVE-BUILDS-V1 installs. Patching that dormant fallback buys nothing.
  local _nf_probe="$(cd "$1/.." 2>/dev/null && pwd)/cli/dist/src/commands/neural.js"
  if [[ -f "$_nf_probe" ]] && [[ "$(dist_defect_present "$_nf_probe" 'nativeResult\?\.checkpointPath')" == "PRESENT" ]]; then
    pass "neural checkpoint patch self-retired — native TrainingPipeline writes trained checkpoints (#2549)"
    return 0
  fi
  cfroot="$(cd "$1/.." 2>/dev/null && pwd)" || return 0   # .../node_modules/@claude-flow
  nf="$cfroot/cli/dist/src/commands/neural.js"
  [[ -f "$nf" ]] || return 0
  grep -q "NEURAL-CKPT-V1" "$nf" && { pass "neural checkpoint training already present"; return 0; }
  [[ -f "$nf.neural-ckpt-bak" ]] || cp "$nf" "$nf.neural-ckpt-bak"
  local patcher; patcher="$(mktemp)"
  cat > "$patcher" <<'PJS'
const fs = require('fs'); const F = process.argv[2];
let s = fs.readFileSync(F, 'utf8');
if (s.includes('NEURAL-CKPT-V1')) { process.exit(0); }
const uniq = "                await adapter.initBackend();\n                await adapter.saveCheckpoint(cpPath);";
if (!s.includes(uniq)) { console.error('ANCHOR_NOT_FOUND'); process.exit(2); }
const repl = [
"                await adapter.initBackend();",
"                // NEURAL-CKPT-V1: train the JS adapter on the collected embeddings so the",
"                // saved checkpoint has a learned (non-zero) B matrix instead of the zero-init.",
"                try { for (const _emb of embeddings) { if (_emb && _emb.length === dim) adapter.train(_emb, _emb, 1.0); } } catch (e) { /* NEURAL-CKPT-V1: best-effort */ }",
"                await adapter.saveCheckpoint(cpPath);"
].join('\n');
s = s.replace(uniq, repl);
fs.writeFileSync(F, s);
PJS
  node "$patcher" "$nf"; local rc=$?; rm -f "$patcher"
  if [[ $rc -ne 0 ]]; then
    warn "NEURAL-CKPT-V1 anchor not found in neural.js (dist drift) — NOT applied"
    return 0
  fi
  if node --check "$nf" 2>/dev/null; then
    fix "neural train now trains the JS adapter before checkpoint (NEURAL-CKPT-V1)"
  else
    warn "NEURAL-CKPT-V1 produced invalid neural.js — restoring backup"
    cp "$nf.neural-ckpt-bak" "$nf"
  fi
}

# Real subscription-backed agent spawn (Tier 8, RUFLO-REAL-SPAWN-V1): `ruflo agent
# spawn` (CLI) and the `agent_spawn` MCP tool only register an IDLE bookkeeping row
# (status 'idle', taskCount 0) — a bare `agent spawn --task` persists the task but
# dispatches it to NO runner. The paths that DO execute (agent_execute, managed_agent_*,
# WASM agents) all require a pay-per-token ANTHROPIC_API_KEY, NOT the Claude Code
# subscription. The only subscription-backed runner in the kit is the local `claude`
# CLI (used internally by headless-worker-executor + `hive-mind spawn --claude`). This
# wires the `agent spawn` action so that WHEN --task is given it really executes via
# `claude --print` (subscription auth, no API key; prompt piped via stdin to avoid
# shell tokenization; headless env CLAUDE_CODE_HEADLESS/CLAUDE_ENTRYPOINT=worker with
# parent session markers unset; process-group kill on --timeout) and reflects real
# status (completed/failed + lastResult) in .claude-flow/agents/store.json so
# `agent list` is no longer stuck idle. Bare `agent spawn` (no --task) is UNCHANGED.
# Validated live: `agent spawn -t researcher --task "...PONG..."` returned real PONG
# with ANTHROPIC_API_KEY unset. Idempotent (RUFLO-REAL-SPAWN-V1), reversible
# (.realspawn-bak). $1 = a @claude-flow/memory dir; agent.js is a sibling under cli/.
wire_real_spawn() {
  [[ "$DRY_RUN" -ne 1 ]] || return 0
  local cfroot aj
  cfroot="$(cd "$1/.." 2>/dev/null && pwd)" || return 0   # .../node_modules/@claude-flow
  aj="$cfroot/cli/dist/src/commands/agent.js"
  [[ -f "$aj" ]] || return 0
  grep -q "RUFLO-REAL-SPAWN-V1" "$aj" && { pass "real subscription-backed agent spawn already present"; return 0; }
  [[ -f "$aj.realspawn-bak" ]] || cp "$aj" "$aj.realspawn-bak"
  local inj patcher; inj="$(mktemp)"; patcher="$(mktemp)"
  cat > "$inj" <<'RSINJ'

            // RUFLO-REAL-SPAWN-V1: agent_spawn only registers idle metadata, so a
            // bare `agent spawn --task` never runs anything. When --task is given,
            // execute it FOR REAL via the local `claude` CLI (Claude Code
            // subscription auth — NO ANTHROPIC_API_KEY). Prompt is piped via stdin
            // (no shell tokenization), headless env, process-group kill on timeout.
            if (ctx.flags.task) {
                const { spawn: _cfSpawn, execSync: _cfExec } = await import('child_process');
                const _path = await import('path');
                const _fs = await import('fs');
                let _claudeOk = false;
                try { _cfExec('which claude', { stdio: 'ignore' }); _claudeOk = true; } catch (e) { }
                if (!_claudeOk) {
                    output.printWarning('`claude` CLI not found — task registered but NOT executed. Install Claude Code (npm i -g @anthropic-ai/claude-code) for real subscription-backed spawn.');
                }
                else {
                    output.printInfo(`Executing task via Claude Code (subscription): ${output.highlight(String(ctx.flags.task).slice(0, 60))}`);
                    output.printWarning('Headless agent runs with --dangerously-skip-permissions (uses tools without prompts).');
                    // Clear ALL parent Claude Code session markers so the child `claude`
                    // does not detect a nested session (the primary case is spawning from
                    // inside an active CC session). CLAUDE_ENTRYPOINT=worker alone is not
                    // enough — CLAUDE_CODE_ENTRYPOINT/SSE_PORT/SESSION_ID/EXECPATH leak too.
                    const _env = { ...process.env, CLAUDE_CODE_HEADLESS: 'true', CLAUDE_ENTRYPOINT: 'worker' };
                    for (const _k of ['CLAUDE_SESSION_ID', 'CLAUDE_PARENT_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_SSE_PORTS', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_EXECPATH']) delete _env[_k];
                    // Real tool use needs non-interactive permissions (no TTY in headless) —
                    // matches hive-mind/headless-worker. The project MCP fleet is NOT
                    // auto-attached (booting agentdb via npx + aqe GNN/SONA on every spawn is
                    // a hang/cost bomb); pass --mcp-config yourself if a task needs ruflo tools.
                    const _args = ['--print', '--dangerously-skip-permissions'];
                    const _prompt = `You are a ${agentType} agent (name: ${agentName}). Complete this task and report the result concisely:\n\n${ctx.flags.task}`;
                    const _timeoutMs = Math.max(30, Number(ctx.flags.timeout) || 300) * 1000;
                    const _res = await new Promise((resolve) => {
                        let _out = '', _err = '', _done = false;
                        const _child = _cfSpawn('claude', _args, { cwd: process.cwd(), env: _env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
                        const _killTree = (sig) => { try { if (process.platform !== 'win32' && _child.pid) { process.kill(-_child.pid, sig); return; } } catch (e) { } try { _child.kill(sig); } catch (e) { } };
                        const _to = setTimeout(() => { _killTree('SIGTERM'); setTimeout(() => { if (!_child.killed) _killTree('SIGKILL'); }, 5000); }, _timeoutMs);
                        try { _child.stdin.end(_prompt); } catch (e) { }
                        _child.stdout.on('data', (d) => { _out += d.toString(); });
                        _child.stderr.on('data', (d) => { _err += d.toString(); });
                        _child.on('error', (e) => { if (_done) return; _done = true; clearTimeout(_to); resolve({ ok: false, out: '', err: e.message }); });
                        _child.on('close', (code) => { if (_done) return; _done = true; clearTimeout(_to); resolve({ ok: code === 0, out: _out, err: _err, code }); });
                    });
                    if (_res.ok) {
                        output.writeln();
                        output.printSuccess('Task completed (Claude Code subscription):');
                        output.writeln(_res.out.trim());
                        result.status = 'completed';
                        result.lastResult = _res.out.trim().slice(0, 2000);
                    }
                    else {
                        output.printError(`Task execution failed${_res.code != null ? ' (exit ' + _res.code + ')' : ''}: ${(_res.err || '').trim().slice(0, 300)}`);
                        result.status = 'failed';
                    }
                    try {
                        const _sp = _path.join(process.cwd(), '.claude-flow', 'agents', 'store.json');
                        if (_fs.existsSync(_sp)) {
                            const _store = JSON.parse(_fs.readFileSync(_sp, 'utf-8'));
                            // store shape: { agents: { "<agentId>": {agentId,status,taskCount,...} }, version }
                            const _agents = (_store && _store.agents && typeof _store.agents === 'object') ? _store.agents : null;
                            const _rec = _agents ? (_agents[result.agentId] || Object.values(_agents).find((a) => a && a.agentId === result.agentId)) : null;
                            if (_rec) {
                                _rec.status = result.status;
                                _rec.taskCount = (_rec.taskCount || 0) + 1;
                                if (result.lastResult) _rec.lastResult = result.lastResult;
                                _rec.lastActiveAt = new Date().toISOString();
                                _fs.writeFileSync(_sp, JSON.stringify(_store, null, 2));
                            }
                        }
                    } catch (e) { }
                }
            }
RSINJ
  cat > "$patcher" <<'RSPATCH'
const fs = require('fs');
const target = process.argv[2], injectFile = process.argv[3];
let s = fs.readFileSync(target, 'utf-8');
if (s.includes('RUFLO-REAL-SPAWN-V1')) { process.exit(0); }
const inject = fs.readFileSync(injectFile, 'utf-8');
const anchor = 'updateSwarmActivityMetrics(1);';
const idx = s.indexOf(anchor);
if (idx === -1) { console.error('ANCHOR_NOT_FOUND'); process.exit(2); }
const lineEnd = s.indexOf('\n', idx);
s = s.slice(0, lineEnd + 1) + inject + s.slice(lineEnd + 1);
fs.writeFileSync(target, s);
RSPATCH
  node "$patcher" "$aj" "$inj"; local rc=$?; rm -f "$patcher" "$inj"
  if [[ $rc -ne 0 ]]; then
    warn "RUFLO-REAL-SPAWN-V1 anchor not found in agent.js (dist drift) — NOT applied"
    return 0
  fi
  if node --check "$aj" 2>/dev/null; then
    fix "Wired agent spawn --task to execute via Claude Code subscription (claude --print) (RUFLO-REAL-SPAWN-V1)"
  else
    warn "RUFLO-REAL-SPAWN-V1 produced invalid agent.js — restoring backup"
    cp "$aj.realspawn-bak" "$aj"
  fi
}

# RUFLO-SEMRANK-V1: graded re-rank of Router B's SEMANTIC path by learned outcome
# quality. The semantic router ranks purely on embedding cosine; this blends in the
# mean graded `quality` (the objective-oracle reward) recorded per agent in
# .claude-flow/routing-outcomes.json, so agents that actually DELIVERED on similar tasks
# float up. Modeled LINE-FOR-LINE on wire_real_spawn. Injected immediately BEFORE the
# `// Get agents from semantic routing or fall back to keyword` anchor (semanticResult is
# populated, the >0.4 gate hasn't run). EXACT NO-OP when the store is empty/absent (the
# loops do nothing) — reversibility-by-data. Blend keeps scores in [0,1] so the
# downstream >0.4 gate + confidence=topMatch.score semantics are preserved.
# Idempotent (RUFLO-SEMRANK-V1), reversible (.semrank-bak).
wire_semantic_rerank() {
  [[ "$DRY_RUN" -ne 1 ]] || return 0
  local cfroot ht
  cfroot="$(cd "$1/.." 2>/dev/null && pwd)" || return 0   # .../node_modules/@claude-flow
  ht="$cfroot/cli/dist/src/mcp-tools/hooks-tools.js"
  [[ -f "$ht" ]] || return 0
  grep -q "RUFLO-SEMRANK-V1" "$ht" && { pass "semantic outcome re-rank already present"; return 0; }
  [[ -f "$ht.semrank-bak" ]] || cp "$ht" "$ht.semrank-bak"
  local inj patcher; inj="$(mktemp)"; patcher="$(mktemp)"
  cat > "$inj" <<'SRINJ'
        // RUFLO-SEMRANK-V1: blend learned outcome quality into the semantic scores
        // before the >0.4 gate. Reuses module-scope loadRoutingOutcomes(). Best-effort;
        // an EMPTY/absent store makes every loop a no-op (the routing is unchanged).
        try {
            const _outcomes = loadRoutingOutcomes();
            if (_outcomes.length && semanticResult.length) {
                const _W = 0.25;
                const _qSum = {}, _qCnt = {};
                for (const _o of _outcomes) {
                    if (!_o || !_o.agent || typeof _o.quality !== 'number')
                        continue;
                    _qSum[_o.agent] = (_qSum[_o.agent] || 0) + _o.quality;
                    _qCnt[_o.agent] = (_qCnt[_o.agent] || 0) + 1;
                }
                for (const _r of semanticResult) {
                    const _ags = (_r.metadata && _r.metadata.agents) || [];
                    let _sum = 0, _n = 0;
                    for (const _a of _ags) {
                        if (_qCnt[_a]) { _sum += _qSum[_a] / _qCnt[_a]; _n++; }
                    }
                    if (_n > 0) {
                        const _meanQ = _sum / _n;
                        _r.score = _r.score * (1 - _W) + _meanQ * _W;
                    }
                }
                semanticResult.sort((_a, _b) => _b.score - _a.score);
            }
        }
        catch { /* RUFLO-SEMRANK-V1 best-effort — never break routing */ }
SRINJ
  cat > "$patcher" <<'SRPATCH'
const fs = require('fs');
const target = process.argv[2], injectFile = process.argv[3];
let s = fs.readFileSync(target, 'utf-8');
if (s.includes('RUFLO-SEMRANK-V1')) { process.exit(0); }
const inject = fs.readFileSync(injectFile, 'utf-8');
const anchor = '// Get agents from semantic routing or fall back to keyword';
const idx = s.indexOf(anchor);
if (idx === -1) { console.error('ANCHOR_NOT_FOUND'); process.exit(2); }
// Insert IMMEDIATELY BEFORE the anchor line (preserve the anchor's own indentation start).
const lineStart = s.lastIndexOf('\n', idx) + 1;
s = s.slice(0, lineStart) + inject + s.slice(lineStart);
fs.writeFileSync(target, s);
SRPATCH
  node "$patcher" "$ht" "$inj"; local rc=$?; rm -f "$patcher" "$inj"
  if [[ $rc -ne 0 ]]; then
    warn "RUFLO-SEMRANK-V1 anchor not found in hooks-tools.js (dist drift) — NOT applied"
    return 0
  fi
  if node --check "$ht" 2>/dev/null; then
    fix "Wired semantic-path graded outcome re-rank into Router B (RUFLO-SEMRANK-V1)"
  else
    warn "RUFLO-SEMRANK-V1 produced invalid hooks-tools.js — restoring backup"
    cp "$ht.semrank-bak" "$ht"
  fi
}

# RUFLO-ROUTE-EXPLORE-V1: ε-greedy EXPLORATION at Router B's deterministic pick.
# The semantic loop is strictly on-policy — it always takes semanticResult[0] after the
# SEMRANK sort, so the reward loop can never DISCOVER a better route (on-policy overfit).
# This rewrites the pick (the `if (semanticResult[0].score > 0.4)` block) so that, among
# the eligible top-K (K=3, only those still above the existing >0.4 gate), with prob (1-ε)
# we take [0] (EXACT current behaviour) and with prob ε we uniformly sample one of the
# eligible alternatives (indices 1..K-1). Crucially the swap happens AT THE PICK, so the
# chosen agent propagates into primaryAgent.type (agents[0]) → the CLI `Agent:` line →
# ruflo-route-capture → the reward trains the EXPLORED pick, not the exploited [0].
#   ε: RUFLO_ROUTE_EPSILON env overrides (0 = fully disabled, regression-safe + Gate 3
#      control arm); else linear decay 0.15 → 0.05 floor over the first 200 routed tasks,
#      counter persisted in .claude-flow/.ruflo-explore-state.json (alongside the route store).
#   LOG: append {decision,chosenAgent,exploitAgent,epsilon,score,ts} to
#        .claude-flow/.ruflo-explore.jsonl (the bench reads explore-rate + counterfactuals).
# Best-effort try/catch: any error falls back to the exact deterministic [0] pick.
# Idempotent (RUFLO-ROUTE-EXPLORE-V1), reversible (.explore-bak).
wire_route_exploration() {
  [[ "$DRY_RUN" -ne 1 ]] || return 0
  local cfroot ht
  cfroot="$(cd "$1/.." 2>/dev/null && pwd)" || return 0   # .../node_modules/@claude-flow
  ht="$cfroot/cli/dist/src/mcp-tools/hooks-tools.js"
  [[ -f "$ht" ]] || return 0
  grep -q "RUFLO-ROUTE-EXPLORE-V2" "$ht" && { pass "route exploration already present"; return 0; }
  [[ -f "$ht.explore-bak" ]] || cp "$ht" "$ht.explore-bak"
  local patcher; patcher="$(mktemp)"
  cat > "$patcher" <<'REXPATCH'
const fs = require('fs');
const target = process.argv[2];
let s = fs.readFileSync(target, 'utf-8');
if (s.includes('RUFLO-ROUTE-EXPLORE-V2')) { process.exit(0); }
const OLD = `        if (semanticResult.length > 0 && semanticResult[0].score > 0.4) {
            const topMatch = semanticResult[0];
            agents = topMatch.metadata.agents || ['coder', 'researcher'];
            confidence = topMatch.score;
            matchedPattern = topMatch.intent;
        }`;
const NEW = `        if (semanticResult.length > 0 && semanticResult[0].score > 0.4) {
            // RUFLO-ROUTE-EXPLORE-V2: ε-greedy pick over DISTINCT ELIGIBLE AGENTS.
            // V1 sampled by INDEX over the raw top-K, but the top-K can contain duplicate
            // agent labels (e.g. two 'testing-task' patterns both → tester) — so an
            // 'explore' that hit a duplicate index captured the SAME agent as exploit[0]
            // and trained the on-policy pick anyway (tester saw 8/11 explores as no-ops).
            // V2 first de-duplicates the eligible candidates by the CAPTURED agent identity
            // (metadata.agents[0] — what becomes primaryAgent.type), keeping the highest
            // score per distinct agent, then explores among the OTHER distinct agents. This
            // guarantees chosenAgent != exploitAgent whenever decision==='explore'.
            let topMatch = semanticResult[0];
            try {
                const _GATE = 0.4, _K = 3, _SCAN = 8;
                const _agentOf = (_r) => (_r && _r.metadata && _r.metadata.agents && _r.metadata.agents[0]) || null;
                // Scan a bounded window (>_K, capped at _SCAN) so we can still surface up to
                // _K DISTINCT agents even when the leading entries share an agent label.
                const _seen = new Set();
                const _distinct = []; // highest-score entry per distinct eligible agent, score order
                for (const _r of semanticResult.slice(0, _SCAN)) {
                    if (!_r || _r.score <= _GATE) continue;
                    const _ag = _agentOf(_r);
                    if (!_ag || _seen.has(_ag)) continue; // first (=highest score) wins per agent
                    _seen.add(_ag);
                    _distinct.push(_r);
                    if (_distinct.length >= _K) break;
                }
                let _eps;
                const _envEps = process.env.RUFLO_ROUTE_EPSILON;
                const _stateDir = join(resolve('.'), '.claude-flow');
                const _statePath = join(_stateDir, '.ruflo-explore-state.json');
                let _count = 0;
                try { if (existsSync(_statePath)) _count = (JSON.parse(readFileSync(_statePath, 'utf-8')).count) || 0; } catch { }
                if (_envEps !== undefined && _envEps !== '') {
                    _eps = Math.max(0, Math.min(1, parseFloat(_envEps)));
                } else {
                    // linear decay 0.15 -> 0.05 over first 200 routed tasks, then floor 0.05
                    _eps = _count >= 200 ? 0.05 : 0.15 - (0.10 * (_count / 200));
                }
                // exploit = top distinct-agent entry (== semanticResult[0]'s agent).
                const _exploit = _distinct[0] || semanticResult[0];
                const _exploitAgent = _agentOf(_exploit) || 'coder';
                let _decision = 'exploit';
                topMatch = _exploit;
                // explore requires >= 2 DISTINCT eligible agents; sample among the OTHERS.
                if (_eps > 0 && _distinct.length > 1 && Math.random() < _eps) {
                    const _altIdx = 1 + Math.floor(Math.random() * (_distinct.length - 1));
                    topMatch = _distinct[_altIdx];
                    _decision = 'explore';
                }
                const _chosenAgent = _agentOf(topMatch) || _exploitAgent;
                // persist incremented decay counter (only when ε is decay-driven, i.e. no env override)
                try {
                    if (_envEps === undefined || _envEps === '') {
                        mkdirSync(_stateDir, { recursive: true });
                        writeFileSync(_statePath, JSON.stringify({ count: _count + 1 }));
                    }
                } catch { }
                // append decision to the explore log for the bench
                try {
                    mkdirSync(_stateDir, { recursive: true });
                    writeFileSync(join(_stateDir, '.ruflo-explore.jsonl'),
                        JSON.stringify({ decision: _decision, chosenAgent: _chosenAgent, exploitAgent: _exploitAgent, distinctAgents: _distinct.length, epsilon: Math.round(_eps * 1000) / 1000, score: Math.round(topMatch.score * 1000) / 1000, ts: new Date().toISOString() }) + '\\n',
                        { flag: 'a' });
                } catch { }
            }
            catch { topMatch = semanticResult[0]; /* RUFLO-ROUTE-EXPLORE-V2 fail-safe — exact deterministic pick */ }
            agents = topMatch.metadata.agents || ['coder', 'researcher'];
            confidence = topMatch.score;
            matchedPattern = topMatch.intent;
        }`;
if (!s.includes(OLD)) { console.error('ANCHOR_NOT_FOUND'); process.exit(2); }
s = s.split(OLD).join(NEW);
fs.writeFileSync(target, s);
REXPATCH
  node "$patcher" "$ht"; local rc=$?; rm -f "$patcher"
  if [[ $rc -eq 2 ]]; then
    warn "RUFLO-ROUTE-EXPLORE-V2 anchor not found in hooks-tools.js — verify manually"
    return 0
  fi
  if node --check "$ht" 2>/dev/null; then
    fix "Wired ε-greedy route exploration over DISTINCT agents into Router B (RUFLO-ROUTE-EXPLORE-V2)"
  else
    warn "RUFLO-ROUTE-EXPLORE-V2 produced invalid hooks-tools.js — restoring backup"
    cp "$ht.explore-bak" "$ht"
  fi
}

# SONA embedding dim fix (Tier A, SONA-EMBED-384): persistent-sona's createHashEmbedding
# defaulted to 64-dim while the rest of the stack is MiniLM-384, so its patterns were
# dimensionally non-conformant (different vector space). Bump the default to 384 (sync,
# safe, deterministic — the char-hash distributes over %dim). CONFORMANCE ONLY: still a
# hash, not semantic; the real MiniLM swap is a deferred async ticket. Idempotent
# (SONA-EMBED-384), reversible (.sona-embed-bak). $1 = a @claude-flow/memory dir.
ensure_sona_embed_384() {
  [[ "$DRY_RUN" -ne 1 ]] || return 0
  local ps="$1/dist/persistent-sona.js" rv="$1/dist/rvf-learning-store.js"
  [[ -f "$ps" ]] || return 0
  grep -q "SONA-EMBED-384" "$ps" && { pass "SONA-EMBED-384 already present"; return 0; }
  [[ -f "$ps.sona-embed-bak" ]] || cp "$ps" "$ps.sona-embed-bak"
  [[ -f "$rv" && ! -e "$rv.sona-embed-bak" ]] && cp "$rv" "$rv.sona-embed-bak"
  node -e '
    const fs = require("fs");
    const edits = [
      { f: process.argv[1], from: "createHashEmbedding(text, dim = 64) {", to: "createHashEmbedding(text, dim = 384) { /* SONA-EMBED-384 */" },
      { f: process.argv[2], from: "const DEFAULT_DIMENSIONS = 64;", to: "const DEFAULT_DIMENSIONS = 384; /* SONA-EMBED-384 */" },
    ];
    for (const x of edits) { if (!fs.existsSync(x.f)) continue; let s = fs.readFileSync(x.f, "utf8"); if (s.includes("SONA-EMBED-384")) continue; if (!s.includes(x.from)) continue; fs.writeFileSync(x.f, s.replace(x.from, x.to)); }
  ' "$ps" "$rv"
  if node --check "$ps" 2>/dev/null && { [[ ! -f "$rv" ]] || node --check "$rv" 2>/dev/null; }; then
    fix "Bumped persistent-sona embedding dim 64->384 (SONA-EMBED-384)"
  else
    warn "SONA-EMBED-384 invalid — restoring backups"; cp "$ps.sona-embed-bak" "$ps" 2>/dev/null; [[ -f "$rv.sona-embed-bak" ]] && cp "$rv.sona-embed-bak" "$rv"
  fi
}

# Native build install (Tier C, NATIVE-BUILDS-V1): the SONA rebuild (adds native
# exportLoraState() — real LoRA A/B persistence) and the GNN arm64 binary (closes the
# "GNN unavailable on Apple Silicon" gap) are prebuilt in assets/builds/. They live in the
# GLOBAL ruflo install and are lost on `npm i -g ruflo`, so reinstall them here. darwin-arm64
# only. Idempotent (cmp skips identical), reversible (.prebuilt-bak). $1 = a @claude-flow/memory dir.
# Rebuild recipe is in docs/_INSTRUCTIONS.md Patch 23.
install_native_builds() {
  [[ "$DRY_RUN" -ne 1 ]] || return 0
  # Apple-Silicon detection that survives a Rosetta-translated bash: under
  # Rosetta `uname -m` reports x86_64, so gate on the hardware capability
  # (sysctl hw.optional.arm64 == 1 on every Apple Silicon Mac) as well.
  [[ "$(uname)" == "Darwin" ]] || return 0
  [[ "$(uname -m)" == "arm64" || "$(sysctl -n hw.optional.arm64 2>/dev/null)" == "1" ]] || return 0
  local builds sona gnn root
  builds="$KIT_ASSETS/builds"
  sona="$builds/sona.darwin-arm64.node"; gnn="$builds/ruvector-gnn.darwin-arm64.node"
  root="$(cd "$1/../.." 2>/dev/null && pwd)" || return 0   # .../<ruflo>/node_modules
  [[ -n "$root" ]] || return 0
  if [[ -f "$sona" ]]; then
    while IFS= read -r d; do
      for t in sona.darwin-universal.node sona.darwin-arm64.node; do
        [[ -f "$d/$t" ]] || continue
        cmp -s "$sona" "$d/$t" && continue
        [[ -e "$d/$t.prebuilt-bak" ]] || cp "$d/$t" "$d/$t.prebuilt-bak"
        cp "$sona" "$d/$t" && fix "Installed native SONA build (exportLoraState) -> $t"
      done
    done < <(find "$root" -type d -path "*@ruvector/sona" 2>/dev/null)
  fi
  if [[ -f "$gnn" ]]; then
    while IFS= read -r d; do
      local g="$d/ruvector-gnn.darwin-arm64.node"
      cmp -s "$gnn" "$g" 2>/dev/null && continue
      [[ -f "$g" && ! -e "$g.prebuilt-bak" ]] && cp "$g" "$g.prebuilt-bak"   # back up any pre-existing binary (symmetry w/ SONA branch + header claim)
      cp "$gnn" "$g" && fix "Installed native GNN arm64 build -> $(echo "$d"|sed 's#.*/node_modules/##')"
    done < <(find "$root" -type d -path "*@ruvector/gnn-darwin-arm64" 2>/dev/null)
  fi
}

force_nested_agentdb() {
  # $1 = a @claude-flow/memory directory
  local memdir="$1"
  local nested="$memdir/node_modules/agentdb"
  [[ -f "$memdir/dist/controller-registry.js" ]] || return 0
  local cur="?"
  [[ -f "$nested/package.json" ]] && cur="$(node -e "try{console.log(require('$nested/package.json').version)}catch{console.log('?')}" 2>/dev/null)"
  if [[ "$cur" == "$AGENTDB_FORCE_VERSION" ]]; then
    pass "nested agentdb already $AGENTDB_FORCE_VERSION: $memdir"
    ensure_nested_sona "$memdir"
    ensure_toplevel_sona "$memdir"
    wire_sona_train "$memdir"
    train_neural_checkpoint "$memdir"
    wire_real_spawn "$memdir"
    wire_semantic_rerank "$memdir"
    wire_route_exploration "$memdir"
    ensure_sona_embed_384 "$memdir"
    install_native_builds "$memdir"
    return 0
  fi
  info "nested agentdb is $cur — forcing $AGENTDB_FORCE_VERSION: $memdir"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] Would: copy agentdb@$AGENTDB_FORCE_VERSION into $nested"
    return 0
  fi
  ensure_agentdb_source || return 1
  # Reversible backup of the displaced copy (once).
  if [[ -d "$nested" && ! -e "$nested.prealpha10-bak" ]]; then
    mv "$nested" "$nested.prealpha10-bak"
  else
    rm -rf "$nested"
  fi
  mkdir -p "$memdir/node_modules"
  cp -R "$AGENTDB_STABLE_CACHE/node_modules/agentdb" "$nested"
  ensure_nested_sona "$memdir"
  ensure_toplevel_sona "$memdir"
  wire_sona_train "$memdir"
  train_neural_checkpoint "$memdir"
  wire_real_spawn "$memdir"
  wire_semantic_rerank "$memdir"
  wire_route_exploration "$memdir"
  ensure_sona_embed_384 "$memdir"
  install_native_builds "$memdir"
  # Verify the classes the registry needs actually import (real ESM path).
  local probe="$memdir/dist/__agentdb_force_probe.mjs"
  printf 'const m=await import("agentdb");const need=["MutationGuard","AttestationLog","GNNService","RVFOptimizer","GuardedVectorBackend","SemanticRouter"];const have=need.filter(c=>typeof m[c]==="function");console.log(have.length===need.length?("OK:"+have.length+"/"+need.length):("MISSING:"+need.filter(c=>typeof m[c]!=="function").join(",")));\n' > "$probe"
  local res
  res="$(node "$probe" 2>/dev/null | grep -E '^(OK|MISSING)' || echo 'LOAD_FAIL')"
  rm -f "$probe"
  if [[ "$res" == OK:* ]]; then
    local cls_cnt="${res#OK:}"
    fix "Forced agentdb@$AGENTDB_FORCE_VERSION; $cls_cnt controller classes import (offline ESM probe): $memdir"
    # Honesty (audit MEDIUM #3): the offline probe only proves the class EXPORTS
    # resolve. The live `agentdb_controllers` count is set at MCP-server init and
    # is NOT verifiable from this script — it needs a Claude Code restart.
    pass "controller-registry primed: $cls_cnt class exports OK → 'agentdb_controllers' should report 23/23 AFTER a Claude Code restart (not verifiable in-script)"
  else
    warn "Forced agentdb@$AGENTDB_FORCE_VERSION but class probe returned: $res ($memdir)"
    ((ERRORS++)) || true
  fi
}

# Apply to the GLOBAL ruflo install only (npx caches revert on every call — see
# the note above). Covers any node version under ~/.nvm + a non-nvm global.
AGENTDB_FORCED_ANY=0
while IFS= read -r memreg; do
  [[ -z "$memreg" ]] && continue
  force_nested_agentdb "$(dirname "$(dirname "$memreg")")"
  AGENTDB_FORCED_ANY=1
done < <(
  { find "$HOME_DIR/.nvm" -maxdepth 12 -path "*ruflo/node_modules/@claude-flow/memory/dist/controller-registry.js" 2>/dev/null
    find "/usr/local/lib/node_modules" "/opt/homebrew/lib/node_modules" -maxdepth 6 -path "*ruflo/node_modules/@claude-flow/memory/dist/controller-registry.js" 2>/dev/null
  } | sort -u
)
if [[ "$AGENTDB_FORCED_ANY" -eq 0 ]]; then
  warn "No GLOBAL ruflo @claude-flow/memory controller-registry found — install ruflo globally (npm i -g ruflo) so .mcp.json's 'ruflo mcp start' resolves, then re-run."
fi

# ── Step 4: Remove local ruflo dependency ────────────────────────────────────

header "4/11" "Local ruflo dependency check"

if [[ -f "$TARGET_DIR/package.json" ]]; then
  LOCAL_DEPS=""
  grep -qE '"ruflo"' "$TARGET_DIR/package.json" 2>/dev/null && LOCAL_DEPS="$LOCAL_DEPS ruflo"
  grep -qE '"@claude-flow/cli"' "$TARGET_DIR/package.json" 2>/dev/null && LOCAL_DEPS="$LOCAL_DEPS @claude-flow/cli"
  grep -qE '"@claude-flow/memory"' "$TARGET_DIR/package.json" 2>/dev/null && LOCAL_DEPS="$LOCAL_DEPS @claude-flow/memory"

  if [[ -n "$LOCAL_DEPS" ]]; then
    warn "package.json has conflicting deps:$LOCAL_DEPS"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] Would remove:$LOCAL_DEPS"
    else
      info "Removing conflicting deps:$LOCAL_DEPS"
      npm uninstall $LOCAL_DEPS 2>/dev/null || true
      fix "Removed conflicting local deps:$LOCAL_DEPS"
      pass "Removed:$LOCAL_DEPS"
    fi
  else
    pass "No local ruflo/@claude-flow deps in package.json"
  fi
else
  pass "No package.json (no local deps to conflict)"
fi

# ── Step 5: Fix .mcp.json ───────────────────────────────────────────────────

header "5/11" "MCP configuration"

if [[ -f "$MCP_JSON" ]]; then
  NEEDS_FIX=0

  # Check package name
  if grep -q '@claude-flow/cli' "$MCP_JSON"; then
    info "Fixing: @claude-flow/cli@latest → ruflo@latest"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] Would: sed replace @claude-flow/cli@latest with ruflo@latest in .mcp.json"
    else
      if [[ "$(uname)" == "Darwin" ]]; then
        sed -i '' 's/@claude-flow\/cli@latest/ruflo@latest/g' "$MCP_JSON"
      else
        sed -i 's/@claude-flow\/cli@latest/ruflo@latest/g' "$MCP_JSON"
      fi
      fix "Fixed .mcp.json: cli→ruflo"
    fi
    NEEDS_FIX=1
  fi

  # Also catch older variants
  if grep -q 'claude-flow@v3alpha' "$MCP_JSON"; then
    info "Fixing: claude-flow@v3alpha → ruflo@latest"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] Would: sed replace claude-flow@v3alpha with ruflo@latest in .mcp.json"
    else
      if [[ "$(uname)" == "Darwin" ]]; then
        sed -i '' 's/claude-flow@v3alpha/ruflo@latest/g' "$MCP_JSON"
      else
        sed -i 's/claude-flow@v3alpha/ruflo@latest/g' "$MCP_JSON"
      fi
      fix "Fixed .mcp.json: v3alpha→ruflo"
    fi
    NEEDS_FIX=1
  fi

  # Check autoStart
  if grep -q '"autoStart": false' "$MCP_JSON"; then
    info "Fixing: autoStart false → true"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] Would: sed replace autoStart false with true in .mcp.json"
    else
      if [[ "$(uname)" == "Darwin" ]]; then
        sed -i '' 's/"autoStart": false/"autoStart": true/g' "$MCP_JSON"
      else
        sed -i 's/"autoStart": false/"autoStart": true/g' "$MCP_JSON"
      fi
      fix "Fixed .mcp.json: autoStart"
    fi
    NEEDS_FIX=1
  fi

  # Tier 7: the canonical claude-flow launch is the GLOBAL ruflo binary
  # (command:"ruflo"), NOT `npx -y ruflo@latest` — every npx-ruflo call
  # reconciles the agentdb controller fix away (see Step 3b + Patch 18). Detect
  # the launch shape so the -y warning + correctness check don't misfire.
  CF_COMMAND="$(jq -r '.mcpServers."claude-flow".command // ""' "$MCP_JSON" 2>/dev/null || echo "")"

  # The -y flag only matters for the npx launch form; the global form has no npx.
  if [[ "$CF_COMMAND" == "npx" ]] && ! grep -q '"-y"' "$MCP_JSON"; then
    warn "npx launch form missing -y flag (may cause interactive prompts)"
    ((ERRORS++)) || true
  fi

  if [[ "$NEEDS_FIX" -eq 0 ]]; then
    if [[ "$CF_COMMAND" == "ruflo" ]]; then
      # Canonical Tier 7 state: claude-flow launches from the GLOBAL `ruflo` binary.
      # Modern Claude Code .mcp.json carries NO `autoStart` field (servers start on
      # demand / via enabledMcpjsonServers) — and the autoStart-false→true block above
      # already normalized any explicit false — so its absence here is correct, not a
      # manual-review case. Don't gate the OK verdict on autoStart presence.
      pass ".mcp.json is correct (global ruflo launch — Tier 7)"
    elif grep -q '"ruflo@latest"' "$MCP_JSON"; then
      warn ".mcp.json uses 'npx -y ruflo@latest' — switch claude-flow command to global 'ruflo' so the agentdb controller fix (Step 3b) survives restarts (Patch 18)"
    else
      warn ".mcp.json may need manual review (claude-flow launch command is '${CF_COMMAND:-unset}', expected 'ruflo')"
    fi
  elif [[ "$DRY_RUN" -eq 0 ]]; then
    pass ".mcp.json fixed"
  fi
else
  warn "No .mcp.json found — creating one"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] Would: create .mcp.json with ruflo@latest config"
  else
    cat > "$MCP_JSON" << 'MCPEOF'
{
  "mcpServers": {
    "claude-flow": {
      "command": "ruflo",
      "args": ["mcp", "start"],
      "env": {
        "npm_config_update_notifier": "false",
        "CLAUDE_FLOW_MODE": "v3",
        "CLAUDE_FLOW_HOOKS_ENABLED": "true",
        "CLAUDE_FLOW_TOPOLOGY": "hierarchical-mesh",
        "CLAUDE_FLOW_MAX_AGENTS": "15",
        "CLAUDE_FLOW_MEMORY_BACKEND": "hybrid"
      },
      "autoStart": true
    }
  }
}
MCPEOF
    fix "Created .mcp.json"
    pass "Created .mcp.json"
  fi
fi

# ── Step 5b: Register agentdb as a 3rd MCP server (Tier 6.1) ────────────────
# Unlocks the agentdb-direct MCP toolset: attention, reflexion, skills,
# causal, learning-session tools — only exposed when agentdb is its own MCP
# entry, not when accessed via `mcp__claude-flow__*` routing. Pinned to
# alpha.10 — the last PRE-PIVOT release that still ships those 7 controllers;
# alpha.12 removed them. Do NOT bump to alpha.12+ without verifying upstream
# restored them (see _INSTRUCTIONS.md Patch 17.1 quarterly-review note).
# - No autoStart (matches agentic-qe's shape; opt-in via settings.json's
#   `enabledMcpjsonServers`).
#
# LAUNCH SHAPE — GLOBAL binary, NOT npx (mirrors claude-flow's Tier 7 launch):
# the old `npx -y agentdb@<ver> mcp start` form crashes on a fresh npx cache —
# agentdb's native peer `better-sqlite3` is NOT auto-installed by npx, so the
# server dies on startup with `ERR_MODULE_NOT_FOUND: better-sqlite3` and Claude
# Code's `/mcp` reports -32000. The durable fix (same rationale as Patch 18 for
# claude-flow) is to install agentdb + better-sqlite3 GLOBALLY and launch the
# GLOBAL `agentdb` binary (command:"agentdb", args:["mcp","start"]). npx never
# reconciles a `npm -g` install, so the native build sticks across restarts.
AGENTDB_VERSION="3.0.0-alpha.10"

# ── Step 5b.0: AGENTDB-GLOBAL-MCP-V1 — install agentdb + better-sqlite3 globally
# Idempotent: skip when BOTH the global `agentdb` binary and a resolvable global
# `better-sqlite3` are present. Native-build failure is non-fatal (warn + keep
# going) — the .mcp.json entry is still written so a later manual `npm i -g` (or
# a re-run on a box with build tools) heals it.
GLOBAL_AGENTDB_OK=0
GLOBAL_BSQLITE_OK=0
command -v agentdb >/dev/null 2>&1 && GLOBAL_AGENTDB_OK=1
NPM_ROOT_G="$(npm root -g 2>/dev/null || echo '')"
# better-sqlite3 must LOAD from agentdb's own context (that's where the MCP
# server loads it). We require() it, not just require.resolve() — better-sqlite3
# is a native addon pinned to NODE_MODULE_VERSION, so after a node upgrade a
# present-but-ABI-stale build still resolves yet throws on load. Load-testing
# detects that and forces a reinstall (npm rebuilds against the current ABI),
# so the fix self-heals across node upgrades instead of silently staying broken.
# PEER SCOPE (verified against agentdb@3.0.0-alpha.10 dist): better-sqlite3 is
# the ONLY boot-path peer. The CLI entry agentdb-cli.js statically imports
# migrate.js → `import Database from 'better-sqlite3'` (top-level), so the CLI
# can't load without it. The other two declared peers are NOT on the mcp-start
# path: @xenova/transformers is a lazy `await import()` in EmbeddingService, and
# `sqlite3` is only used by a CLI report subcommand; the server's DB layer uses
# sql.js (a regular dep, bundled). So installing better-sqlite3 alone is correct
# — do NOT add the other peers (extra native builds, no benefit).
# Assert the resolved path is UNDER the global root — node walks up parent dirs,
# so a stray ~/node_modules/better-sqlite3 would otherwise satisfy this and mask a
# missing global install (the .mcp.json `agentdb` binary only sees the global one).
if [[ -n "$NPM_ROOT_G" ]] && \
   node -e "const p=require.resolve('better-sqlite3',{paths:['$NPM_ROOT_G/agentdb','$NPM_ROOT_G']});if(!p.startsWith('$NPM_ROOT_G'))process.exit(3);require(p)" >/dev/null 2>&1; then
  GLOBAL_BSQLITE_OK=1
fi
if [[ "$GLOBAL_AGENTDB_OK" -eq 1 && "$GLOBAL_BSQLITE_OK" -eq 1 ]]; then
  pass "Global agentdb + better-sqlite3 present (AGENTDB-GLOBAL-MCP-V1)"
else
  info "Installing agentdb@$AGENTDB_VERSION + better-sqlite3 globally (AGENTDB-GLOBAL-MCP-V1; agentdb=$GLOBAL_AGENTDB_OK better-sqlite3=$GLOBAL_BSQLITE_OK)"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] Would: npm install -g agentdb@$AGENTDB_VERSION better-sqlite3@^11.8.1"
  else
    adb_log="/tmp/ruflo-agentdb-global-install.log"
    if npm install -g "agentdb@$AGENTDB_VERSION" "better-sqlite3@^11.8.1" >"$adb_log" 2>&1; then
      fix "Installed global agentdb@$AGENTDB_VERSION + better-sqlite3 (AGENTDB-GLOBAL-MCP-V1)"
      pass "Global agentdb MCP runtime installed"
    else
      warn "npm install -g agentdb + better-sqlite3 failed (likely better-sqlite3 native build — needs a C++ toolchain: xcode-select --install / build-essential). agentdb MCP will report -32000 until 'npm i -g agentdb@$AGENTDB_VERSION better-sqlite3@^11.8.1' succeeds. Build log: $adb_log. Continuing."
      ((ERRORS++)) || true
    fi
  fi
fi

# ── Step 5b.2: register/migrate the agentdb entry to the GLOBAL launch form ──
# Migration: a PRE-EXISTING entry whose command=="npx" is the broken form — we
# REPLACE it with the global form. Truly-absent → add. Already-global → pass.
AGENTDB_GLOBAL_JQ='.mcpServers.agentdb = {
        "command": "agentdb",
        "args": ["mcp", "start"],
        "env": { "npm_config_update_notifier": "false", "NODE_ENV": "production" }
      }'
if [[ -f "$MCP_JSON" ]]; then
  if ! command -v jq >/dev/null 2>&1; then
    warn "jq not on PATH — skipping agentdb MCP registration (install with: brew install jq)"
    ((ERRORS++)) || true
  else
    ADB_CMD="$(jq -r '.mcpServers.agentdb.command // ""' "$MCP_JSON" 2>/dev/null || echo "")"
    if [[ "$ADB_CMD" == "agentdb" ]]; then
      pass "agentdb MCP server already registered (global launch)"
    elif [[ "$ADB_CMD" == "npx" ]]; then
      # Broken npx form — migrate to the global launch.
      info "Migrating agentdb MCP server from npx → global 'agentdb' binary (fixes -32000 on fresh npx cache)"
      if [[ "$DRY_RUN" -eq 1 ]]; then
        info "[dry-run] Would: jq replace .mcpServers.agentdb with global launch form in .mcp.json"
      else
        backup "$MCP_JSON"
        tmp_mcp="$(mktemp)"
        if jq "$AGENTDB_GLOBAL_JQ" "$MCP_JSON" > "$tmp_mcp" && python3 -c "import json; json.load(open('$tmp_mcp'))" 2>/dev/null; then
          mv "$tmp_mcp" "$MCP_JSON"
          fix "Migrated agentdb MCP server to global launch (command:\"agentdb\")"
          pass "agentdb MCP server migrated to global launch"
        else
          rm -f "$tmp_mcp"
          warn "jq migration of agentdb entry failed — leaving .mcp.json untouched"
          ((ERRORS++)) || true
        fi
      fi
    else
      # Truly absent (or a non-npx/non-global shape) — add the global form.
      info "Registering agentdb MCP server (global launch — unlocks attention/reflexion/skills/causal/learning-session tools)"
      if [[ "$DRY_RUN" -eq 1 ]]; then
        info "[dry-run] Would: jq merge global agentdb entry into .mcp.json"
      else
        backup "$MCP_JSON"
        tmp_mcp="$(mktemp)"
        if jq "$AGENTDB_GLOBAL_JQ" "$MCP_JSON" > "$tmp_mcp" && python3 -c "import json; json.load(open('$tmp_mcp'))" 2>/dev/null; then
          mv "$tmp_mcp" "$MCP_JSON"
          fix "Added agentdb MCP server (global launch) to .mcp.json"
          pass "agentdb MCP server registered (global launch)"
        else
          rm -f "$tmp_mcp"
          warn "jq merge of agentdb entry failed — leaving .mcp.json untouched"
          ((ERRORS++)) || true
        fi
      fi
    fi
  fi
fi

# ── Step 5b.1: Remove duplicate `ruflo` MCP server (Tier 7) ─────────────────
# `ruflo init --force` re-adds an `mcpServers.ruflo` entry (npx -y ruflo@latest
# mcp start) to .mcp.json — a redundant, npx-launched duplicate of the canonical
# `claude-flow` server (Tier 7 pins claude-flow to the GLOBAL ruflo binary). Two
# servers expose the same toolset under different namespaces, and the npx path
# reverts the agentdb controller pin (Patch 19). When both exist, drop the dup.
if [[ -f "$MCP_JSON" ]] && command -v jq >/dev/null 2>&1; then
  if jq -e '.mcpServers.ruflo and .mcpServers["claude-flow"]' "$MCP_JSON" >/dev/null 2>&1; then
    info "Removing duplicate ruflo MCP server (claude-flow is the canonical global launcher)"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] Would: jq del(.mcpServers.ruflo) from .mcp.json"
    else
      tmp_dd="$(mktemp)"
      if jq 'del(.mcpServers.ruflo)' "$MCP_JSON" > "$tmp_dd" && python3 -c "import json; json.load(open('$tmp_dd'))" 2>/dev/null; then
        mv "$tmp_dd" "$MCP_JSON"
        fix "Removed duplicate ruflo MCP server from .mcp.json (kept claude-flow/global)"
        pass "Duplicate ruflo MCP server removed"
      else
        rm -f "$tmp_dd"; warn "jq dedup of .mcp.json ruflo failed — leaving untouched"; ((ERRORS++)) || true
      fi
    fi
  else
    pass "No duplicate ruflo MCP server in .mcp.json"
  fi
fi

# Validate .claude/settings.json hooks (part of MCP/hooks config)
SETTINGS_JSON="$TARGET_DIR/.claude/settings.json"
if [[ -f "$SETTINGS_JSON" ]]; then
  # Check statusLine hook exists
  if grep -q '"statusLine"' "$SETTINGS_JSON"; then
    pass "settings.json has statusLine hook"
  else
    warn "settings.json missing statusLine hook"
    ((ERRORS++)) || true
  fi
  # Check hooks section exists
  if grep -q '"hooks"' "$SETTINGS_JSON"; then
    pass "settings.json has hooks section"
  else
    warn "settings.json missing hooks section"
    ((ERRORS++)) || true
  fi

  # ── Step 5c: Opt agentdb into enabledMcpjsonServers (Tier 6.1) ─────────
  # Claude Code requires project-scope MCP servers (those in .mcp.json) to
  # ALSO appear in `enabledMcpjsonServers` in settings.json before they
  # actually load. Without this, the statusbar MCP chip would show ●2/3
  # red instead of ●3/3 — and `mcp__agentdb__*` tools would not appear in
  # Claude's tool catalog.
  if command -v jq >/dev/null 2>&1; then
    if jq -e '.enabledMcpjsonServers | index("agentdb")' "$SETTINGS_JSON" >/dev/null 2>&1; then
      pass "settings.json: agentdb already in enabledMcpjsonServers"
    else
      info "Opting agentdb into enabledMcpjsonServers (settings.json)"
      if [[ "$DRY_RUN" -eq 1 ]]; then
        info "[dry-run] Would: jq merge agentdb into settings.json enabledMcpjsonServers"
      else
        tmp_settings="$(mktemp)"
        if jq '.enabledMcpjsonServers = ((.enabledMcpjsonServers // []) + ["agentdb"] | unique)' "$SETTINGS_JSON" > "$tmp_settings"; then
          mv "$tmp_settings" "$SETTINGS_JSON"
          fix "Added agentdb to .claude/settings.json enabledMcpjsonServers"
          pass "settings.json: agentdb opted in"
        else
          rm -f "$tmp_settings"
          warn "jq merge of enabledMcpjsonServers failed — leaving settings.json untouched"
          ((ERRORS++)) || true
        fi
      fi
    fi
  fi
else
  warn "No .claude/settings.json — hooks not configured"
  ((ERRORS++)) || true
fi

# ── Step 5d: Normalize CLAUDE.md CLI references (Tier 7) ─────────────────────
# `ruflo init` + `aqe init` generate CLAUDE.md with the PRE-rename package name
# `@claude-flow/cli@latest` in every CLI example, and a Setup line that launches
# the MCP via npx. The CLI was renamed to `ruflo`, and Tier 7 launches the MCP
# from the GLOBAL `ruflo` binary (npx reverts the agentdb controller fix). This
# step rewrites those references the same way Step 5 fixes `.mcp.json`. Mechanical
# + idempotent; `.bak` snapshot guards the write. Does NOT touch the prose
# coordination guidance (SendMessage section) — that needs human authoring.
CLAUDE_MD="$TARGET_DIR/CLAUDE.md"
header "5d/11" "Normalize CLAUDE.md CLI references (@claude-flow/cli → ruflo)"
if [[ ! -f "$CLAUDE_MD" ]]; then
  pass "No CLAUDE.md to normalize"
elif ! grep -qE '@claude-flow/cli@latest|26 commands, 140\+ subcommands' "$CLAUDE_MD"; then
  pass "CLAUDE.md already normalized (no stale @claude-flow/cli refs)"
else
  STALE_COUNT="$(grep -cE '@claude-flow/cli@latest' "$CLAUDE_MD" 2>/dev/null || true)"
  STALE_COUNT="${STALE_COUNT:-0}"
  info "Found $STALE_COUNT @claude-flow/cli@latest reference(s) + possible stale command count"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] Would: rewrite Setup launch line → 'ruflo mcp start', '@claude-flow/cli@latest' → 'ruflo', fix '26 commands' → '37 commands'"
  else
    CLAUDE_MD_BAK="${CLAUDE_MD}.fixruflo.bak"
    cp "$CLAUDE_MD" "$CLAUDE_MD_BAK"
    # Order matters: the Setup `claude mcp add … npx -y …` line must be rewritten
    # as a whole BEFORE the generic npx replacements (otherwise the `-y` form
    # collapses to a bare `ruflo` and loses the `mcp start` subcommand).
    _sed_i() { if [[ "$(uname)" == "Darwin" ]]; then sed -i '' "$1" "$2"; else sed -i "$1" "$2"; fi; }
    _sed_i 's|claude mcp add claude-flow -- npx -y @claude-flow/cli@latest|claude mcp add claude-flow -- ruflo mcp start|g' "$CLAUDE_MD"
    _sed_i 's|npx -y @claude-flow/cli@latest|ruflo|g' "$CLAUDE_MD"
    _sed_i 's|npx @claude-flow/cli@latest|ruflo|g' "$CLAUDE_MD"
    _sed_i 's|26 commands, 140+ subcommands|37 commands, 140+ subcommands|g' "$CLAUDE_MD"
    if grep -qE '@claude-flow/cli@latest' "$CLAUDE_MD"; then
      warn "CLAUDE.md still has @claude-flow/cli@latest references — restoring backup"
      mv "$CLAUDE_MD_BAK" "$CLAUDE_MD"
      ((ERRORS++)) || true
    else
      rm -f "$CLAUDE_MD_BAK"
      fix "Normalized CLAUDE.md: @claude-flow/cli@latest → ruflo (+ global mcp launch, command count)"
      pass "CLAUDE.md CLI references normalized"
      info "Agent Comms prose (SendMessage-First section) is left as-is by design — its researcher/coder/tester/reviewer subagent_types now resolve after the Patch-26 backfill (see Patch 28)."
    fi
  fi
fi

# ── Step 5e: Normalize .claude/ content CLI + agent references (Tier 7) ──────
# A swarm audit of .claude/ found a small set of generated files with the same
# CLI drift CLAUDE.md had: dead `@claude-flow/cli` CLI invocations and a stale
# `v3-qe-*` agent-name prefix. This step normalizes ONLY those confirmed files
# (mechanical, idempotent, .bak-guarded). It deliberately does NOT touch:
# settings.json (config — manual); the ~120-file legacy `claude-flow`/
# `./claude-flow` command catalog (a blind rename would yield plausible-but-WRONG
# subcommands); helpers/sync-v3-metrics.sh (its `@claude-flow/cli` is a
# filesystem-path probe, not a CLI call); and — IMPORTANTLY — `subagent_type`
# example VALUES. An earlier version of this step remapped
# `researcher/architect/coder/tester/reviewer` → `general-purpose`/`qe-*` on the
# premise that those types were invalid. That premise was an ARTIFACT OF AN
# INCOMPLETE INIT: the ruflo agent defs were simply missing. The Patch-26 `.claude`
# backfill (init Step 4.5) restores the full catalog (`core/coder.md`,
# `core/researcher.md`, `core/tester.md`, `core/reviewer.md`, …), so those types
# now RESOLVE — rewriting them would be wrong. Leave subagent_type examples as-is.
header "5e/11" "Normalize .claude/ content CLI + agent references"
CLAUDE_DIR="$TARGET_DIR/.claude"
_cf_sed() { if [[ "$(uname)" == "Darwin" ]]; then sed -i '' "$1" "$2"; else sed -i "$1" "$2"; fi; }
# Files that carry plain CLI drift (`npx @claude-flow/cli[@latest] <cmd>` → `ruflo <cmd>`)
CLAUDE_CLI_FILES=(
  "commands/swarm/swarm.md"
  "skills/browser/SKILL.md"
  "helpers/pre-commit"
  "helpers/post-commit"
)
C5E_CHANGED=0
if [[ ! -d "$CLAUDE_DIR" ]]; then
  pass "No .claude/ directory to normalize"
else
  for rel in "${CLAUDE_CLI_FILES[@]}"; do
    f="$CLAUDE_DIR/$rel"
    [[ -f "$f" ]] || continue
    if grep -q '@claude-flow/cli' "$f" 2>/dev/null; then
      if [[ "$DRY_RUN" -eq 1 ]]; then
        info "[dry-run] Would: @claude-flow/cli → ruflo in $rel"
      else
        cp "$f" "$f.fixruflo.bak"
        _cf_sed 's|npx @claude-flow/cli@latest|ruflo|g' "$f"
        _cf_sed 's|npx @claude-flow/cli|ruflo|g' "$f"
        if grep -q 'npx @claude-flow/cli' "$f"; then
          warn "drift persisted in $rel — restoring"; mv "$f.fixruflo.bak" "$f"; ((ERRORS++)) || true
        else
          rm -f "$f.fixruflo.bak"; fix "Normalized CLI refs in $rel"; C5E_CHANGED=1
        fi
      fi
    fi
  done

  # subagent_type example VALUES: the blanket remap (researcher/coder/tester/reviewer
  # → general-purpose/qe-*) is GONE — post Patch-26 backfill those 4 resolve to real
  # agent defs (core/{researcher,coder,tester,reviewer}.md), so rewriting them would
  # replace valid, intended types. The ONLY exception is `architect`: no def declares
  # `name: architect` (the real one is `system-architect`, via
  # architecture/arch-system-design.md — also the value the stock CLAUDE.md uses), so
  # the stock swarm.md `architect` example does not resolve. Fix ONLY that one value.
  SWARM_MD="$CLAUDE_DIR/commands/swarm/swarm.md"
  if [[ -f "$SWARM_MD" ]] && grep -q 'subagent_type: "architect"' "$SWARM_MD" 2>/dev/null; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] Would: swarm.md subagent_type \"architect\" → \"system-architect\" (only unresolvable role type)"
    else
      cp "$SWARM_MD" "$SWARM_MD.fixruflo.bak"
      _cf_sed 's|subagent_type: "architect"|subagent_type: "system-architect"|g' "$SWARM_MD"
      rm -f "$SWARM_MD.fixruflo.bak"; fix "swarm.md: architect → system-architect (the one role type with no agent def)"; C5E_CHANGED=1
    fi
  fi

  # docs/v3-agents-index.md: the v3-qe-* example names don't exist (real files are qe-*).
  V3_INDEX="$CLAUDE_DIR/docs/v3-agents-index.md"
  if [[ -f "$V3_INDEX" ]] && grep -q 'v3-qe-' "$V3_INDEX" 2>/dev/null; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] Would: v3-qe-* → qe-* in docs/v3-agents-index.md"
    else
      cp "$V3_INDEX" "$V3_INDEX.fixruflo.bak"
      _cf_sed 's|v3-qe-|qe-|g' "$V3_INDEX"
      rm -f "$V3_INDEX.fixruflo.bak"; fix "Fixed v3-qe-* agent names in docs/v3-agents-index.md"; C5E_CHANGED=1
    fi
  fi

  if [[ "$DRY_RUN" -ne 1 && "$C5E_CHANGED" -eq 0 ]]; then
    pass ".claude/ content already normalized"
  elif [[ "$DRY_RUN" -ne 1 ]]; then
    pass ".claude/ content normalized (swarm.md CLI, browser, pre/post-commit, v3-agents-index; subagent_types left as-is)"
  fi
fi

# ── Step 5f: settings.json hygiene (Tier 7) ─────────────────────────────────
# Three verified config misalignments in .claude/settings.json:
#  (1) includeCoAuthoredBy:true contradicts the project's Co-Authored-By policy
#      (CLAUDE.md: never add the trailer unless attribution.commit is set; no
#      attribution block exists) → set false.
#  (2) permissions.allow has dead/malformed entries: `Bash(npx @claude-flow*)`
#      and `Bash(npx claude-flow*)` name the renamed package; `mcp__claude-flow__:*`
#      has a stray colon (Claude Code MCP wildcard is `mcp__server__*`).
#  (3) mcpServers.ruflo registers a THIRD claude-flow MCP via `npx ruflo@3.5.18 mcp`
#      — an old, npx-pinned duplicate of .mcp.json's global `claude-flow` (Tier 7
#      launches from the global binary). Remove it.
# jq-driven, idempotent (re-run is a no-op), .bak-guarded with JSON re-validation.
SETTINGS_JSON_5F="$TARGET_DIR/.claude/settings.json"
header "5f/11" "settings.json hygiene (Co-Authored-By + permissions + stale MCP)"
if [[ ! -f "$SETTINGS_JSON_5F" ]]; then
  pass "No .claude/settings.json to clean"
elif ! command -v jq >/dev/null 2>&1; then
  warn "jq not on PATH — skipping settings.json hygiene (install: brew install jq)"
  ((ERRORS++)) || true
else
  JQ_5F='
    .includeCoAuthoredBy = false
    | (if (.permissions.allow | type) == "array"
       then .permissions.allow |= map(
         if . == "Bash(npx @claude-flow*)" then "Bash(npx ruflo*)"
         elif . == "Bash(npx claude-flow*)" then "Bash(ruflo*)"
         elif . == "mcp__claude-flow__:*" then "mcp__claude-flow__*"
         else . end)
       else . end)
    | del(.mcpServers.ruflo)
    | (if (.mcpServers | type) == "object" and (.mcpServers | length) == 0 then del(.mcpServers) else . end)
  '
  tmp_5f="$(mktemp)"
  if ! jq "$JQ_5F" "$SETTINGS_JSON_5F" > "$tmp_5f" 2>/dev/null; then
    rm -f "$tmp_5f"; warn "jq transform of settings.json failed — leaving untouched"; ((ERRORS++)) || true
  elif diff -q "$SETTINGS_JSON_5F" "$tmp_5f" >/dev/null 2>&1; then
    rm -f "$tmp_5f"; pass "settings.json already clean (Co-Authored-By + permissions + MCP)"
  elif [[ "$DRY_RUN" -eq 1 ]]; then
    rm -f "$tmp_5f"; info "[dry-run] Would: includeCoAuthoredBy→false, fix permissions, remove stale mcpServers.ruflo"
  else
    cp "$SETTINGS_JSON_5F" "$SETTINGS_JSON_5F.fixruflo.bak"
    mv "$tmp_5f" "$SETTINGS_JSON_5F"
    if python3 -c "import json,sys; json.load(open('$SETTINGS_JSON_5F'))" 2>/dev/null; then
      rm -f "$SETTINGS_JSON_5F.fixruflo.bak"
      fix "settings.json: includeCoAuthoredBy→false, permissions normalized, stale mcpServers.ruflo removed"
      pass "settings.json hygiene applied"
    else
      warn "settings.json failed JSON validation after edit — restoring"
      mv "$SETTINGS_JSON_5F.fixruflo.bak" "$SETTINGS_JSON_5F"; ((ERRORS++)) || true
    fi
  fi
fi

# ── Step 5g: Safe-rename legacy claude-flow CLI refs (Tier 7) ───────────────
# A swarm triage of the 163-file legacy `claude-flow` corpus found that a blind
# rename would corrupt >40% (sparc/github/automation/analysis/optimization/
# monitoring are REMOVED features — `ruflo <cmd>` errors). Only THREE command
# dirs are SAFE to rename: agents/, hive-mind/, coordination/ — ruflo has the
# matching subcommands (`agent …`, `hive-mind …`, `swarm/agent/task …`). This
# step renames ONLY the CLI-invocation forms in those dirs. It NEVER does a bare
# `claude-flow`→`ruflo` (which would hit `@claude-flow/memory` package refs) —
# only the prefixed `npx …`/`./claude-flow` forms. DEAD dirs (delete-not-rename)
# and NEEDS-MAPPING dirs (memory/swarm/hooks/workflows/skills) are left for human
# triage — see _INSTRUCTIONS.md Patch 19.
header "5g/11" "Safe-rename legacy claude-flow CLI refs (agents/ hive-mind/ coordination/)"
SAFE_RENAME_DIRS=(
  "$TARGET_DIR/.claude/commands/agents"
  "$TARGET_DIR/.claude/commands/hive-mind"
  "$TARGET_DIR/.claude/commands/coordination"
)
C5G_CHANGED=0
for d in "${SAFE_RENAME_DIRS[@]}"; do
  [[ -d "$d" ]] || continue
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    # Match only CLI-invocation forms, not @claude-flow/<pkg> package paths.
    if grep -qE 'npx @claude-flow/cli|npx claude-flow|\./claude-flow' "$f" 2>/dev/null; then
      if [[ "$DRY_RUN" -eq 1 ]]; then
        info "[dry-run] Would: rename legacy CLI refs → ruflo in ${f#"$TARGET_DIR/"}"
      else
        cp "$f" "$f.fixruflo.bak"
        _cf_sed 's|npx @claude-flow/cli@latest|ruflo|g' "$f"
        _cf_sed 's|npx @claude-flow/cli|ruflo|g' "$f"
        _cf_sed 's|npx claude-flow@alpha|ruflo|g' "$f"
        _cf_sed 's|npx claude-flow|ruflo|g' "$f"
        _cf_sed 's|\./claude-flow|ruflo|g' "$f"
        rm -f "$f.fixruflo.bak"; C5G_CHANGED=1
      fi
    fi
  done < <(find "$d" -type f -name '*.md' 2>/dev/null)
done
if [[ "$DRY_RUN" -ne 1 && "$C5G_CHANGED" -eq 1 ]]; then
  fix "Safe-renamed legacy claude-flow CLI refs in agents/ hive-mind/ coordination/"
  pass "Legacy CLI refs safe-renamed (3 dirs)"
elif [[ "$DRY_RUN" -ne 1 ]]; then
  pass "No legacy CLI refs to rename in the 3 safe dirs (already clean)"
fi

# ── Step 5h: NEEDS-MAPPING per-verb transforms (Tier 7) ─────────────────────
# The memory/ swarm/ workflows/ hooks/ command dirs + top-level claude-flow-*.md
# mix verbs that map to a real ruflo subcommand with verbs that are DEAD (removed
# features). We rewrite ONLY invocations whose (command, verb) maps to a verb that
# actually exists in `ruflo <cmd> --help` — emitting real ruflo commands only.
# DEAD invocations (memory persist/usage, swarm spawn + swarm-* artifacts,
# workflow create/dev/export/research, hook pre-write/check-protected) are LEFT as
# `claude-flow …` on purpose: an honest "legacy/unverified" marker beats a
# fabricated `ruflo …` command. Verified verb maps (from `ruflo <cmd> --help`):
#   memory query→retrieve, memory search (rename); swarm init (rename);
#   workflow execute→run; hook {pre-edit,post-edit,pre-task,post-task,session-end}→hooks <verb>.
# sed -E for the `(npx[ -y]|./)claude-flow[@alpha]` prefix alternation. The match
# requires that prefix + a space before the verb, so `@claude-flow/memory` (slash,
# no npx) is never touched.
header "5h/11" "NEEDS-MAPPING per-verb transforms (memory/swarm/workflows/hooks)"
_cf_sedE() { if [[ "$(uname)" == "Darwin" ]]; then sed -i '' -E "$1" "$2"; else sed -i -E "$1" "$2"; fi; }
NM_PREFIX='(npx( -y)? |\.\/)claude-flow(@alpha)? '
NM_DIRS=(
  "$TARGET_DIR/.claude/commands/memory"
  "$TARGET_DIR/.claude/commands/swarm"
  "$TARGET_DIR/.claude/commands/workflows"
  "$TARGET_DIR/.claude/commands/hooks"
)
C5H_CHANGED=0
apply_nm() {
  # $1=file. Each transform rewrites a verified legacy (cmd verb) → real ruflo command.
  local f="$1"
  _cf_sedE "s#${NM_PREFIX}memory query#ruflo memory retrieve#g" "$f"
  _cf_sedE "s#${NM_PREFIX}memory search#ruflo memory search#g" "$f"
  _cf_sedE "s#${NM_PREFIX}swarm init#ruflo swarm init#g" "$f"
  _cf_sedE "s#${NM_PREFIX}workflow execute#ruflo workflow run#g" "$f"
  _cf_sedE "s#${NM_PREFIX}hook pre-edit#ruflo hooks pre-edit#g" "$f"
  _cf_sedE "s#${NM_PREFIX}hook post-edit#ruflo hooks post-edit#g" "$f"
  _cf_sedE "s#${NM_PREFIX}hook pre-task#ruflo hooks pre-task#g" "$f"
  _cf_sedE "s#${NM_PREFIX}hook post-task#ruflo hooks post-task#g" "$f"
  _cf_sedE "s#${NM_PREFIX}hook session-end#ruflo hooks session-end#g" "$f"
}
# Build the file list: the 4 NEEDS-MAPPING dirs + the 3 top-level claude-flow-*.md
NM_FILES=()
for d in "${NM_DIRS[@]}"; do
  [[ -d "$d" ]] || continue
  while IFS= read -r f; do [[ -n "$f" ]] && NM_FILES+=("$f"); done < <(find "$d" -type f -name '*.md' 2>/dev/null)
done
while IFS= read -r f; do [[ -n "$f" ]] && NM_FILES+=("$f"); done < <(find "$TARGET_DIR/.claude/commands" -maxdepth 1 -type f -name 'claude-flow-*.md' 2>/dev/null)

for f in "${NM_FILES[@]}"; do
  # Only act if a VERIFIED-mappable legacy invocation is present.
  if grep -qE "${NM_PREFIX}(memory (query|search)|swarm init|workflow execute|hook (pre-edit|post-edit|pre-task|post-task|session-end))" "$f" 2>/dev/null; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] Would: map verified legacy verbs → ruflo in ${f#"$TARGET_DIR/"}"
    else
      cp "$f" "$f.fixruflo.bak"; apply_nm "$f"; rm -f "$f.fixruflo.bak"; C5H_CHANGED=1
    fi
  fi
done
if [[ "$DRY_RUN" -ne 1 && "$C5H_CHANGED" -eq 1 ]]; then
  fix "Mapped verified legacy verbs (memory/swarm/workflow/hooks) → ruflo"
  pass "NEEDS-MAPPING verbs mapped (dead verbs left as legacy markers)"
elif [[ "$DRY_RUN" -ne 1 ]]; then
  pass "No verified-mappable legacy verbs found (already mapped or only dead verbs)"
fi

# ── Step 5i: Restore CLAUDE.md Runtime prose (Tier 7) ───────────────────────
# `ruflo init --force` regenerates CLAUDE.md and drops the Tier-7 "Runtime" note
# (global ruflo launch + agentdb alpha.10 pin). Step 5d re-fixes CLI refs; this
# step re-appends the Runtime note. The "Agent Comms" section is LEFT AS-IS: this
# project adopted the stock "SendMessage-First Coordination" (commit 16cd38c, user
# decision — the 177-agent backfill makes the role subagent_types resolvable), so
# Step 5i no longer rewrites it to fan-out. Python (not sed) for the multi-line
# append; .bak-guarded with a structural check.
CLAUDE_MD_5I="$TARGET_DIR/CLAUDE.md"
header "5i/11" "Restore CLAUDE.md Runtime prose (Tier 7; Agent Comms left as-is)"
if [[ ! -f "$CLAUDE_MD_5I" ]]; then
  pass "No CLAUDE.md to normalize"
elif grep -q "## Runtime (operational facts)" "$CLAUDE_MD_5I"; then
  pass "CLAUDE.md Runtime prose already present"
elif [[ "$DRY_RUN" -eq 1 ]]; then
  info "[dry-run] Would: re-append Runtime note (Agent Comms untouched)"
else
  cp "$CLAUDE_MD_5I" "$CLAUDE_MD_5I.fixruflo.bak"
  C5I_RES="$(CLAUDE_MD_PATH="$CLAUDE_MD_5I" python3 <<'PYEOF'
import os
p = os.environ['CLAUDE_MD_PATH']
src = open(p, encoding='utf-8').read()
changed = False

RUNTIME = """## Runtime (operational facts)

- **The claude-flow MCP server launches from the GLOBAL `ruflo` binary** (`.mcp.json` → `command: "ruflo"`, `args: ["mcp","start"]`), NOT `npx -y ruflo@latest`. npx reconciles its cache on every call and would revert the AgentDB controller pin below. So ruflo upgrades go through `npm i -g ruflo` followed by `bin/ruflo-kit upgrade <target>` (which re-runs `bin/ruflo-kit fix-ruflo <target>`).
- **AgentDB controllers**: the global `@claude-flow/memory`'s nested `agentdb` is pinned to `3.0.0-alpha.10` so all 23 controllers activate (`agentdb_controllers` → 23/23). alpha.12+ regressed the controller classes — do not bump. `bin/ruflo-kit fix-ruflo <target>` Step 3b enforces this.
- A separate `agentdb` MCP server is registered in `.mcp.json` (pinned alpha.10) exposing the direct attention/reflexion/skills/causal/learning-session tools.
- Full rationale: the ruflo-kit's `docs/_INSTRUCTIONS.md` (Patches 17–19). Run `bin/ruflo-kit session <target>` at session start to verify.
"""

if '## Runtime (operational facts)' not in src:
    idx = src.find('## Agentic QE v3')
    if idx != -1:
        src = src[:idx] + RUNTIME + '\n\n' + src[idx:]
        changed = True

if changed and '## Agentic QE v3' in src:
    open(p, 'w', encoding='utf-8').write(src)
    print('CHANGED')
elif not changed:
    print('UNCHANGED')
else:
    print('ABORT_STRUCTURE')
PYEOF
)"
  if [[ "$C5I_RES" == "CHANGED" ]]; then
    rm -f "$CLAUDE_MD_5I.fixruflo.bak"
    fix "Restored CLAUDE.md Runtime note (Agent Comms left as-is — SendMessage-First)"
    pass "CLAUDE.md Runtime prose restored"
  elif [[ "$C5I_RES" == "UNCHANGED" ]]; then
    rm -f "$CLAUDE_MD_5I.fixruflo.bak"
    pass "CLAUDE.md Runtime prose already present"
  else
    warn "CLAUDE.md prose normalization aborted ($C5I_RES) — restoring backup"
    mv "$CLAUDE_MD_5I.fixruflo.bak" "$CLAUDE_MD_5I"; ((ERRORS++)) || true
  fi
fi

# ── Step 6: Claude MCP registration ─────────────────────────────────────────

header "6/11" "Claude MCP registration"

if command -v claude &>/dev/null; then
  MCP_LIST="$(claude mcp list 2>&1 || echo '')"

  if echo "$MCP_LIST" | grep -q "claude-flow"; then
    # Tier 7: stale forms include the old package names AND any npx launch —
    # the canonical registration is the GLOBAL `ruflo mcp start` (npx reconciles
    # the agentdb controller fix away on every call; see Step 3b + Patch 18).
    if echo "$MCP_LIST" | grep -qE "@claude-flow/cli|claude-flow@v3alpha|npx +-y +ruflo|npx +ruflo"; then
      info "Removing stale claude-flow MCP entries (migrating to global ruflo launch)"
      if [[ "$DRY_RUN" -eq 1 ]]; then
        info "[dry-run] Would: claude mcp remove/add claude-flow -- ruflo mcp start"
      else
        claude mcp remove claude-flow -s local 2>/dev/null || true
        claude mcp remove claude-flow -s project 2>/dev/null || true
        claude mcp remove claude-flow -s user 2>/dev/null || true
        info "Re-registering with global ruflo (ruflo mcp start)"
        # -s project: keep the registration in project scope so it aligns with
        # .mcp.json and never shadows it with a local-scope duplicate (audit MEDIUM #2).
        claude mcp add claude-flow -s project -- ruflo mcp start 2>/dev/null || true
        fix "Re-registered MCP with global ruflo launch (project scope)"
        pass "MCP re-registered"
      fi
    elif echo "$MCP_LIST" | grep -q "ruflo"; then
      pass "MCP registration uses global ruflo launch"
    else
      warn "MCP registration exists but may need review"
    fi

    if echo "$MCP_LIST" | grep "claude-flow" | grep -q "Connected"; then
      pass "MCP server connected"
    elif echo "$MCP_LIST" | grep "claude-flow" | grep -q "Failed"; then
      fail "MCP server failed — restart Claude Code after fixes"
      ((ERRORS++)) || true
    fi
  else
    info "No claude-flow MCP entry — adding"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] Would: claude mcp add claude-flow -s project -- ruflo mcp start"
    else
      # -s project: align with .mcp.json, avoid a local-scope shadow (audit MEDIUM #2).
      claude mcp add claude-flow -s project -- ruflo mcp start 2>/dev/null || true
      fix "Registered MCP claude-flow (global ruflo launch, project scope)"
      pass "MCP registered"
    fi
  fi
else
  warn "claude CLI not found — skip MCP registration check"
fi

# ── Step 7: Clean stale npx caches ──────────────────────────────────────────

header "7/11" "NPX cache cleanup"

STALE_COUNT=0
if [[ -d "$HOME_DIR/.npm/_npx" ]]; then
  while IFS= read -r dir; do
    [[ -z "$dir" ]] && continue
    # Check if this cache has @claude-flow/memory without ControllerRegistry
    if [[ -d "$dir/node_modules/@claude-flow/memory" ]]; then
      if [[ ! -f "$dir/node_modules/@claude-flow/memory/dist/controller-registry.js" ]]; then
        MEM_VER="$(node -e "try{console.log(require('$dir/node_modules/@claude-flow/memory/package.json').version)}catch{console.log('?')}" 2>/dev/null)"
        info "Removing stale cache: memory@$MEM_VER (no ControllerRegistry)"
        if [[ "$DRY_RUN" -eq 1 ]]; then
          info "[dry-run] Would: rm -rf $dir"
          ((STALE_COUNT++)) || true
        else
          rm -rf "$dir"
          fix "Removed stale npx cache (memory@$MEM_VER)"
          ((STALE_COUNT++)) || true
        fi
      fi
    fi
    # Check for old claude-flow (not ruflo) caches
    if [[ -d "$dir/node_modules/claude-flow" ]] && [[ ! -d "$dir/node_modules/ruflo" ]]; then
      info "Removing stale claude-flow cache: $dir"
      if [[ "$DRY_RUN" -eq 1 ]]; then
        info "[dry-run] Would: rm -rf $dir"
        ((STALE_COUNT++)) || true
      else
        rm -rf "$dir"
        fix "Removed stale npx cache (old claude-flow)"
        ((STALE_COUNT++)) || true
      fi
    fi
  done < <(find "$HOME_DIR/.npm/_npx" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)
fi

if [[ "$STALE_COUNT" -eq 0 ]]; then
  pass "No stale npx caches"
else
  pass "Removed $STALE_COUNT stale cache(s)"
fi

# ── Step 8: Clean ghost state ────────────────────────────────────────────────

header "8/11" "State file cleanup"

CF_DIR="$TARGET_DIR/.claude-flow"

if [[ -d "$CF_DIR" ]]; then
  # Ghost agents
  if [[ -f "$CF_DIR/agents.json" ]]; then
    AGENTS_SIZE="$(wc -c < "$CF_DIR/agents.json" 2>/dev/null || echo 0)"
    if [[ "$AGENTS_SIZE" -gt 10240 ]]; then
      info "agents.json is ${AGENTS_SIZE}B (bloated) — resetting"
      if [[ "$DRY_RUN" -eq 1 ]]; then
        info "[dry-run] Would: reset agents.json to empty state"
      else
        echo '{ "agents": {} }' > "$CF_DIR/agents.json"
        fix "Reset bloated agents.json"
        pass "agents.json reset"
      fi
    else
      pass "agents.json is clean (${AGENTS_SIZE}B)"
    fi
  fi

  # Ghost hive-mind workers
  if [[ -f "$CF_DIR/hive-mind/state.json" ]]; then
    HIVE_SIZE="$(wc -c < "$CF_DIR/hive-mind/state.json" 2>/dev/null || echo 0)"
    WORKER_COUNT="$(node -e "try{const d=require('$CF_DIR/hive-mind/state.json');console.log(Object.keys(d.workers||{}).length)}catch{console.log(0)}" 2>/dev/null)"
    if [[ "$WORKER_COUNT" -gt 20 ]]; then
      info "hive-mind has $WORKER_COUNT ghost workers — resetting"
      if [[ "$DRY_RUN" -eq 1 ]]; then
        info "[dry-run] Would: reset hive-mind/state.json to empty state"
      else
        echo '{"queen":null,"workers":{},"consensus":{},"kvStore":{}}' > "$CF_DIR/hive-mind/state.json"
        fix "Reset ghost hive-mind workers"
        pass "hive-mind state reset"
      fi
    else
      pass "hive-mind state OK ($WORKER_COUNT workers)"
    fi
  else
    pass "No hive-mind state (clean)"
  fi

  # Ghost swarm state (running with 0 agents)
  if [[ -f "$CF_DIR/swarm/swarm-state.json" ]]; then
    GHOST_SWARM="$(node -e "
      try {
        const d = require('$CF_DIR/swarm/swarm-state.json');
        const sw = d.swarms ? Object.values(d.swarms)[0] : d;
        const age = Date.now() - new Date(sw.updatedAt || sw.startedAt || 0).getTime();
        const ghost = sw.status === 'running' && (!sw.agents || sw.agents.length === 0) && age > 30*60*1000;
        console.log(ghost ? 'yes' : 'no');
      } catch { console.log('no'); }
    " 2>/dev/null)"
    if [[ "$GHOST_SWARM" == "yes" ]]; then
      info "Ghost swarm detected (running, 0 agents, stale >30min)"
      if [[ "$DRY_RUN" -eq 1 ]]; then
        info "[dry-run] Would: reset swarm/swarm-state.json to clean state"
      else
        echo '{"swarms":{},"version":"3.0.0"}' > "$CF_DIR/swarm/swarm-state.json"
        fix "Reset ghost swarm state"
        pass "Swarm state reset"
      fi
    else
      pass "Swarm state OK"
    fi
  fi
else
  pass "No .claude-flow directory (fresh project)"
fi

# ── Step 9: Multi-node check ────────────────────────────────────────────────

header "9/11" "NVM multi-version check"

if [[ -d "$HOME_DIR/.nvm/versions" ]]; then
  STALE_NVM=0
  while IFS= read -r pkg_json; do
    [[ -z "$pkg_json" ]] && continue
    NVM_VER="$(node -e "try{console.log(require('$pkg_json').version)}catch{console.log('?')}" 2>/dev/null)"
    NODE_VER="$(echo "$pkg_json" | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+')"
    if [[ "$NVM_VER" != "$LATEST_RUFLO" && -n "$LATEST_RUFLO" ]]; then
      warn "Node $NODE_VER has ruflo@$NVM_VER (latest: $LATEST_RUFLO)"
      ((STALE_NVM++)) || true
    fi
  done < <(find "$HOME_DIR/.nvm/versions" -name "package.json" -path "*/ruflo/package.json" 2>/dev/null)

  if [[ "$STALE_NVM" -gt 0 ]]; then
    warn "$STALE_NVM Node version(s) have outdated ruflo — update with: npm install -g ruflo@latest"
  else
    pass "All NVM versions up to date"
  fi
else
  pass "No NVM (single Node version)"
fi

# ── Step 10: Agentic QE plugin ──────────────────────────────────────────────

header "10/11" "Agentic QE plugin"

AQE_PKG="@claude-flow/plugin-agentic-qe"
AQE_DIR="$TARGET_DIR/node_modules/$AQE_PKG"

# Tier 7 coherence fix: this kit uses the STANDALONE `agentic-qe` package
# (aqe-mcp, registered in .mcp.json), NOT the legacy @claude-flow/plugin-agentic-qe.
# This step is ADVISORY ONLY and never installs/updates the legacy plugin.
# (Older versions of this script DID install it here — which fought
# fix-statusbar.sh Step 4 that uninstalls it, producing an install→uninstall
# ping-pong + a spurious non-zero exit on re-run when the just-installed plugin
# was then flagged as legacy. Absence of the legacy plugin is the CORRECT state.)
# See docs/UPGRADE-PATH-ruflo-agentdb-agentic-qe-2026-05-26.md (Phase B).
LEGACY_AQE_IN_PKGJSON=0
LEGACY_AQE_IN_NODEMOD=0
if [[ -f "$TARGET_DIR/package.json" ]] && grep -q "\"$AQE_PKG\"" "$TARGET_DIR/package.json" 2>/dev/null; then
  LEGACY_AQE_IN_PKGJSON=1
fi
[[ -d "$AQE_DIR" ]] && LEGACY_AQE_IN_NODEMOD=1

if [[ "$LEGACY_AQE_IN_PKGJSON" -eq 1 || "$LEGACY_AQE_IN_NODEMOD" -eq 1 ]]; then
  LEGACY_AQE_VER="?"
  [[ "$LEGACY_AQE_IN_NODEMOD" -eq 1 ]] && LEGACY_AQE_VER="$(node -e "try{console.log(require('$AQE_DIR/package.json').version)}catch{console.log('?')}" 2>/dev/null)"
  warn "Legacy @claude-flow/plugin-agentic-qe@$LEGACY_AQE_VER detected — superseded by the standalone 'agentic-qe' package (60 agents vs 51, 13 contexts vs 12)."
  warn "fix-statusbar.sh Step 4 removes it automatically; or migrate manually:"
  warn "  npm uninstall @claude-flow/plugin-agentic-qe && npm install -g agentic-qe && aqe init --auto"
  info "(advisory only — not auto-removed here, and NOT counted as an error)"
else
  pass "No legacy @claude-flow/plugin-agentic-qe (standalone agentic-qe is the successor — correct)"
fi

# AgentDB + ReasoningBank fixes to controller-registry.js
#
# History: this used to be THREE source-rewriting patches (0/1/2). On the
# current stack (@claude-flow/memory@3.0.0-alpha.18) Patch 0 and Patch 2 are
# already satisfied upstream (no `require('path')`; the ReasoningBank ctor
# already receives `embedder`) — they remain below only as idempotent guards
# for older memory builds. Patch 1 (bare-import rewrite) has been RETIRED:
# Tier 7's Step 3b force-pins the nested agentdb to alpha.10, so the bare
# `import('agentdb')` resolves correctly with no source rewrite needed.
#
# ROOT CAUSE 0 (require in ESM) — guard only:
#   Older controller-registry.js used `require('path')` in a "type":"module"
#   package → "require is not defined" → this.agentdb=null → controllers off.
#   Fix: rewrite to `await import('node:path')`. (alpha.18: already ESM.)
#
# ROOT CAUSE 2 (missing embedder) — guard only:
#   Older ReasoningBank ctor got (db) not (db, embedder). Fix: add embedder.
#   (alpha.18: already passes embedder.)

REGISTRY_FILE=""
# Tier 7: prefer the GLOBAL install — the live MCP launches from global `ruflo`
# (not npx), so the global registry is the one that actually runs. The npx
# cache is only a fallback for environments without a global ruflo.
while IFS= read -r candidate; do
  [[ -z "$candidate" ]] && continue
  if [[ -f "$candidate" ]]; then
    REGISTRY_FILE="$candidate"
    break
  fi
done < <(find ~/.nvm/versions /usr/local/lib/node_modules /opt/homebrew/lib/node_modules -path "*/@claude-flow/memory/dist/controller-registry.js" 2>/dev/null)

if [[ -z "$REGISTRY_FILE" ]]; then
  # Fallback: npx cache (only relevant if no global ruflo install exists)
  while IFS= read -r candidate; do
    [[ -z "$candidate" ]] && continue
    if [[ -f "$candidate" ]]; then
      REGISTRY_FILE="$candidate"
      break
    fi
  done < <(find ~/.npm/_npx -path "*/@claude-flow/memory/dist/controller-registry.js" 2>/dev/null)
fi

if [[ -n "$REGISTRY_FILE" ]]; then
  MEM_VER="$(node -e "try{const p=require('$(dirname "$REGISTRY_FILE")/../package.json');console.log(p.version)}catch{console.log('?')}" 2>/dev/null)"
  info "Found controller-registry.js (@claude-flow/memory@$MEM_VER)"

  # --- Patch 0: Fix require('path') in ESM context ---
  # controller-registry.js has "type": "module" but uses CJS require('path')
  # This crashes initAgentDB() with "require is not defined", silently disabling ALL controllers
  if grep -q "require('path')" "$REGISTRY_FILE"; then
    info "ESM fix: require('path') found in ESM module — patching to dynamic import"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] Would: replace require('path').resolve with ESM import('node:path')"
    else
      if [[ "$(uname)" == "Darwin" ]]; then
        sed -i '' "s|const resolved = require('path').resolve(dbPath);|const { resolve: pathResolve } = await import('node:path');\n                const resolved = pathResolve(dbPath);|" "$REGISTRY_FILE"
      else
        sed -i "s|const resolved = require('path').resolve(dbPath);|const { resolve: pathResolve } = await import('node:path');\n                const resolved = pathResolve(dbPath);|" "$REGISTRY_FILE"
      fi
      if grep -q "pathResolve" "$REGISTRY_FILE"; then
        fix "Patched ESM: require('path') → import('node:path')"
        pass "ESM require fix applied"
      else
        fail "ESM require fix failed"
        ((ERRORS++)) || true
      fi
    fi
  elif grep -q "pathResolve" "$REGISTRY_FILE"; then
    pass "ESM fix: already using import('node:path')"
  else
    pass "ESM fix: no require('path') found"
  fi

  # --- Patch 1: RETIRED (Tier 7) ---
  # Formerly sed-rewrote the registry's bare `import('agentdb')` to a relative
  # path, on the theory that the bare specifier resolved to a controller-less
  # agentdb. Tier 7 verified the bare import already resolves to the NESTED
  # @claude-flow/memory/node_modules/agentdb — Step 3b force-pins THAT slot to
  # alpha.10, so the (currently 18) bare imports resolve correctly and all 7
  # controllers activate (23/23). The rewrite was redundant + fragile (hardcoded
  # relative path vs. an in-place version swap) and targeted the npx cache,
  # which the global launch no longer uses. See _INSTRUCTIONS.md Patch 18.

  # --- Patch 2: Fix missing embedder in ReasoningBank constructor ---
  if grep -q "return new RB(this.agentdb.database, embedder)" "$REGISTRY_FILE"; then
    pass "ReasoningBank: embedder argument already present"
  elif grep -q "return new RB(this.agentdb.database);" "$REGISTRY_FILE"; then
    info "ReasoningBank: missing embedder argument — patching"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] Would: add embedder to ReasoningBank constructor"
    else
      if [[ "$(uname)" == "Darwin" ]]; then
        sed -i '' 's/return new RB(this\.agentdb\.database);/const embedder = this.createEmbeddingService();\
                    return new RB(this.agentdb.database, embedder);/' "$REGISTRY_FILE"
      else
        sed -i 's/return new RB(this\.agentdb\.database);/const embedder = this.createEmbeddingService();\n                    return new RB(this.agentdb.database, embedder);/' "$REGISTRY_FILE"
      fi
      if grep -q "return new RB(this.agentdb.database, embedder)" "$REGISTRY_FILE"; then
        fix "Patched ReasoningBank: added embedder argument"
        pass "ReasoningBank embedder fix applied"
      else
        fail "ReasoningBank embedder patch failed"
        ((ERRORS++)) || true
      fi
    fi
  else
    if grep -q "ReasoningBank" "$REGISTRY_FILE"; then
      pass "ReasoningBank: constructor call already modified"
    else
      warn "ReasoningBank: not referenced in controller-registry.js"
      ((ERRORS++)) || true
    fi
  fi
else
  warn "AgentDB/ReasoningBank: controller-registry.js not found"
  warn "  Install ruflo globally (npm i -g ruflo) so the global registry exists — that is the tree the MCP launches from (Patch 18)"
  ((ERRORS++)) || true
fi

# Verify ruflo version compatibility (no external semver dependency)
MIN_CF_VER="3.0.0"
if [[ -n "$INSTALLED_RUFLO" ]]; then
  # Pure-node semver comparison using localeCompare with numeric option
  COMPAT="$(node -e "
    const a = '${INSTALLED_RUFLO}'.replace(/-.*/, '').split('.').map(Number);
    const b = '${MIN_CF_VER}'.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((a[i]||0) > (b[i]||0)) { console.log('yes'); process.exit(0); }
      if ((a[i]||0) < (b[i]||0)) { console.log('no'); process.exit(0); }
    }
    console.log('yes');
  " 2>/dev/null || echo 'unknown')"
  if [[ "$COMPAT" == "yes" ]]; then
    pass "ruflo@$INSTALLED_RUFLO meets minimum $MIN_CF_VER"
  elif [[ "$COMPAT" == "no" ]]; then
    fail "ruflo@$INSTALLED_RUFLO below minimum $MIN_CF_VER for agentic-qe"
    ((ERRORS++)) || true
  else
    warn "Could not verify ruflo version compatibility"
  fi
fi

# ── Step 11: Statusline patches (plugins + swarm fixes) ────────────────────

header "11/11" "Statusline patches"

STATUSLINE_FILE="$TARGET_DIR/.claude/helpers/statusline.cjs"

if [[ -f "$STATUSLINE_FILE" ]]; then
  # Defense-in-depth: snapshot before any step-11 node -e patching so a broken
  # write can be restored from .bak after `node --check` fails. Mirror of the
  # same pattern in fix-statusbar.sh step 1d. Step 11 has 4 separate `node -e`
  # blocks (11a/11c/11d/11e) and currently has no guard — the `///g` corruption
  # took 3 debug sessions to find. Distinct .bak suffix avoids stomping
  # fix-statusbar's own .bak when the two scripts run back-to-back.
  STATUSLINE_BAK="${STATUSLINE_FILE}.fixruflo.bak"
  if [[ "$DRY_RUN" -ne 1 ]]; then
    cp "$STATUSLINE_FILE" "$STATUSLINE_BAK"
  fi
  SL_PATCHED=0

  # ── 11a: Plugin detection function ──
  if grep -q "getPluginStatus" "$STATUSLINE_FILE"; then
    pass "Plugin detection already present"
  else
    info "Patching: plugin detection (getPluginStatus)"
    # Use node to do the patching — avoids sed quoting issues
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] Would: patch getPluginStatus into statusline.cjs"
    else
      node -e "
        const fs = require('fs');
        let src = fs.readFileSync('$STATUSLINE_FILE', 'utf-8');

        // 1. Insert getPluginStatus() before generateStatusline()
        const pluginFn = \`
// Plugin detection (scans node_modules for @claude-flow/plugin-* packages)
function getPluginStatus() {
  const plugins = [];
  try {
    const pluginDir = path.join(CWD, 'node_modules', '@claude-flow');
    if (!fs.existsSync(pluginDir)) return plugins;
    const entries = fs.readdirSync(pluginDir).filter(d => d.startsWith('plugin-'));
    for (const entry of entries) {
      try {
        const pkgPath = path.join(pluginDir, entry, 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const manifestPath = path.join(pluginDir, entry, 'plugin.yaml');
        const hasManifest = fs.existsSync(manifestPath);
        const distPath = path.join(pluginDir, entry, 'dist', 'index.js');
        const hasDist = fs.existsSync(distPath);
        plugins.push({
          name: entry.replace('plugin-', ''),
          version: pkg.version || '?',
          status: hasDist && hasManifest ? 'installed' : 'partial',
        });
      } catch { /* skip broken packages */ }
    }
  } catch { /* ignore */ }
  return plugins;
}

\`;
        src = src.replace('function generateStatusline() {', pluginFn + 'function generateStatusline() {');

        // 2. Insert plugin display line before AgentDB line
        const pluginDisplay = \`  // Plugins line
  const plugins = getPluginStatus();
  if (plugins.length > 0) {
    let pluginLine = c.brightGreen + '\\\\uD83E\\\\uDDE9 Plugins' + c.reset + '    ';
    pluginLine += plugins.map(p => {
      const stInd = p.status === 'active' ? c.brightGreen + '\\\\u25CF' : p.status === 'installed' ? c.brightYellow + '\\\\u25CB' : c.red + '\\\\u25CB';
      return stInd + c.reset + ' ' + c.cyan + p.name + c.reset + ' ' + c.dim + p.version + c.reset;
    }).join('  ' + c.dim + '\\\\u2502' + c.reset + '  ');
    lines.push(pluginLine);
  }

\`;
        src = src.replace(/( *\/\/ Line \d+: AgentDB)/, pluginDisplay + '\$1');

        // 3. Add plugins to JSON output
        src = src.replace('v3Progress: getV3Progress()', 'plugins: getPluginStatus(), v3Progress: getV3Progress()');

        fs.writeFileSync('$STATUSLINE_FILE', src);
      " 2>/dev/null && {
        ((SL_PATCHED++)) || true
        pass "Plugin detection patched"
      } || {
        warn "Plugin detection patch failed"
        ((ERRORS++)) || true
      }
    fi
  fi

  # ── 11b: Swarm stale threshold (5min → 30min) ──
  if grep -q "30 \* 60 \* 1000" "$STATUSLINE_FILE"; then
    pass "Swarm stale threshold already 30min"
  elif grep -q "5 \* 60 \* 1000" "$STATUSLINE_FILE"; then
    info "Patching: swarm stale threshold 5min → 30min"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] Would: sed replace 5*60*1000 with 30*60*1000 in statusline.cjs"
    else
      if [[ "$(uname)" == "Darwin" ]]; then
        sed -i '' 's/const staleThresholdMs = 5 \* 60 \* 1000/const staleThresholdMs = 30 * 60 * 1000/' "$STATUSLINE_FILE"
      else
        sed -i 's/const staleThresholdMs = 5 \* 60 \* 1000/const staleThresholdMs = 30 * 60 * 1000/' "$STATUSLINE_FILE"
      fi
      ((SL_PATCHED++)) || true
      pass "Stale threshold updated"
    fi
  else
    pass "Stale threshold already custom"
  fi

  # ── 11c: Ghost swarm detection (nested swarms + empty agents) ──
  if grep -q "swarmState.swarms" "$STATUSLINE_FILE"; then
    pass "Ghost swarm detection already present"
  elif grep -q "getSwarmStatus" "$STATUSLINE_FILE"; then
    info "Patching: ghost swarm detection + nested swarms + topology"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] Would: patch getSwarmStatus in statusline.cjs"
    else
      node -e "
        const fs = require('fs');
        let src = fs.readFileSync('$STATUSLINE_FILE', 'utf-8');

        const oldFn = /function getSwarmStatus\(\) \{[\s\S]*?return \{ activeAgents: 0, maxAgents: CONFIG\.maxAgents, coordinationActive: false \};\n\}/;
        const newFn = \`function getSwarmStatus() {
  const staleThresholdMs = 30 * 60 * 1000;
  const now = Date.now();

  const swarmStatePath = path.join(CWD, '.claude-flow', 'swarm', 'swarm-state.json');
  const swarmState = readJSON(swarmStatePath);
  if (swarmState) {
    const swarmEntry = swarmState.swarms
      ? Object.values(swarmState.swarms)[0]
      : swarmState;
    if (swarmEntry) {
      const updatedAt = swarmEntry.updatedAt || swarmEntry.startedAt;
      const age = updatedAt ? now - new Date(updatedAt).getTime() : Infinity;
      const agents = swarmEntry.agents || [];
      const agentCount = agents.length || swarmEntry.agentCount || 0;
      const topology = swarmEntry.topology || (swarmEntry.config && swarmEntry.config.topology) || '';
      if (age < staleThresholdMs) {
        const isGhost = swarmEntry.status === 'running' && agentCount === 0;
        return {
          activeAgents: agentCount,
          maxAgents: swarmEntry.maxAgents || (swarmEntry.config && swarmEntry.config.maxAgents) || CONFIG.maxAgents,
          coordinationActive: !isGhost && agentCount > 0,
          topology,
        };
      }
    }
  }

  const activityData = readJSON(path.join(CWD, '.claude-flow', 'metrics', 'swarm-activity.json'));
  if (activityData && activityData.swarm) {
    const updatedAt = activityData.timestamp || (activityData.swarm && activityData.swarm.timestamp);
    const age = updatedAt ? now - new Date(updatedAt).getTime() : Infinity;
    if (age < staleThresholdMs) {
      return {
        activeAgents: activityData.swarm.agent_count || 0,
        maxAgents: CONFIG.maxAgents,
        coordinationActive: activityData.swarm.coordination_active || activityData.swarm.active || false,
        topology: '',
      };
    }
  }

  return { activeAgents: 0, maxAgents: CONFIG.maxAgents, coordinationActive: false, topology: '' };
}\`;

        if (oldFn.test(src)) {
          src = src.replace(oldFn, newFn);
          fs.writeFileSync('$STATUSLINE_FILE', src);
          process.exit(0);
        } else {
          process.exit(1);
        }
      " 2>/dev/null && {
        ((SL_PATCHED++)) || true
        pass "Ghost swarm detection patched"
      } || {
        warn "Ghost swarm patch skipped (function already modified or not found)"
      }
    fi
  elif grep -q "AQE310-REALIGN-V1" "$STATUSLINE_FILE"; then
    # aqe-3.10.x realigned variant sources swarm (activeAgents/coordinationActive/
    # topology) from `ruflo hooks statusline --json` (data.swarm), so the legacy
    # getSwarmStatus/swarm-state.json patch is intentionally not applicable here.
    pass "Swarm status sourced from realigned CLI block (aqe-3.10.x) — legacy getSwarmStatus patch N/A"
  else
    warn "getSwarmStatus not found in statusline"
  fi

  # ── 11d: Subagent detection (stdin + file scan) ──
  if grep -q "stdinData.subagents\|stdinData.num_subagents\|subagents.*jsonl" "$STATUSLINE_FILE"; then
    pass "Subagent detection already enhanced"
  elif grep -q "estimated_agents" "$STATUSLINE_FILE"; then
    info "Patching: subagent detection (stdin + file scan)"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] Would: patch subagent detection in statusline.cjs"
    else
      node -e "
        const fs = require('fs');
        let src = fs.readFileSync('$STATUSLINE_FILE', 'utf-8');

        const oldSub = /  \/\/ Sub-agents from file metrics.*?\n  return \{ memoryMB, contextPct, intelligencePct, subAgents \};/s;
        const newSub = \`  // Sub-agents: prefer Claude Code stdin data, fallback to file scan
  let subAgents = 0;
  const stdinData = getStdinData();
  if (stdinData && stdinData.subagents !== undefined) {
    subAgents = stdinData.subagents;
  } else if (stdinData && stdinData.num_subagents !== undefined) {
    subAgents = stdinData.num_subagents;
  } else {
    // Scope to THIS project only (Claude Code mangles paths: /a/b → -a-b)
    try {
      const projKey = CWD.replace(/\\\\//g, '-').replace(/^-/, '-');
      const projDir = path.join(os.homedir(), '.claude', 'projects');
      if (fs.existsSync(projDir)) {
        const projDirs = fs.readdirSync(projDir).filter(d => d.includes(projKey) || projKey.includes(d));
        for (const pd of projDirs) {
          const subDir = path.join(projDir, pd, 'subagents');
          if (!fs.existsSync(subDir)) continue;
          const files = fs.readdirSync(subDir).filter(f => f.endsWith('.jsonl'));
          for (const f of files) {
            try {
              const st = fs.statSync(path.join(subDir, f));
              if (Date.now() - st.mtimeMs < 10 * 60 * 1000) subAgents++;
            } catch { /* skip */ }
          }
        }
      }
    } catch { /* ignore */ }
    const activityData = readJSON(path.join(CWD, '.claude-flow', 'metrics', 'swarm-activity.json'));
    if (activityData && activityData.processes && activityData.processes.estimated_agents) {
      subAgents = Math.max(subAgents, activityData.processes.estimated_agents);
    }
  }

  return { memoryMB, contextPct, intelligencePct, subAgents };\`;

        if (oldSub.test(src)) {
          src = src.replace(oldSub, newSub);
          fs.writeFileSync('$STATUSLINE_FILE', src);
          process.exit(0);
        } else {
          process.exit(1);
        }
      " 2>/dev/null && {
        ((SL_PATCHED++)) || true
        pass "Subagent detection patched"
      } || {
        warn "Subagent patch skipped (already modified or pattern not found)"
      }
    fi
  elif grep -q "AQE310-REALIGN-V1" "$STATUSLINE_FILE"; then
    # aqe-3.10.x realigned variant reads subAgents from system.subAgents (CLI/stdin),
    # not the legacy estimated_agents file-scan, so this patch is not applicable here.
    # (Note: subagent COUNT is not populated by the CLI in this variant — see the
    # separate "Sub N" wiring gap; this step only governs the legacy mechanism.)
    pass "Subagent source is system.subAgents (aqe-3.10.x) — legacy estimated_agents patch N/A"
  else
    warn "estimated_agents not found in statusline"
  fi

  # ── 11e: Swarm line render (labels + topology + idle color) ──
  if grep -q "Sub " "$STATUSLINE_FILE" && grep -q "topoTag" "$STATUSLINE_FILE"; then
    pass "Swarm line render already updated"
  elif grep -q "Line 2: Swarm" "$STATUSLINE_FILE"; then
    info "Patching: swarm line render (labels, topology, idle color)"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] Would: patch swarm line render in statusline.cjs"
    else
      node -e "
        const fs = require('fs');
        let src = fs.readFileSync('$STATUSLINE_FILE', 'utf-8');

        const oldRender = /  \/\/ Line 2: Swarm.*?lines\.push\(\n.*?intellColor.*?\n  \);/s;
        const newRender = \`  // Line 2: Swarm + Hooks + CVE + Memory + Intelligence
  const swarmInd = swarm.coordinationActive ? c.brightGreen + '\\\\u25C9' + c.reset : c.dim + '\\\\u25CB' + c.reset;
  const agentsColor = swarm.activeAgents > 0 ? c.brightGreen : c.dim;
  const secIcon = security.status === 'CLEAN' ? '\\\\uD83D\\\\uDFE2' : (security.status === 'IN_PROGRESS' || security.status === 'STALE') ? '\\\\uD83D\\\\uDFE1' : (security.status === 'NONE' ? '\\\\u26AA' : '\\\\uD83D\\\\uDD34');
  const secColor = security.status === 'CLEAN' ? c.brightGreen : (security.status === 'IN_PROGRESS' || security.status === 'STALE') ? c.brightYellow : (security.status === 'NONE' ? c.dim : c.brightRed);
  const hooksColor = hooks.enabled > 0 ? c.brightGreen : c.dim;
  const intellColor = system.intelligencePct >= 80 ? c.brightGreen : system.intelligencePct >= 40 ? c.brightYellow : c.dim;
  const topoTag = swarm.topology ? ' ' + c.dim + swarm.topology.slice(0, 5) + c.reset : '';
  const subColor = system.subAgents > 0 ? c.brightPurple : c.dim;
  const subLabel = system.subAgents > 0 ? 'Sub ' + system.subAgents : 'Sub 0';

  lines.push(
    c.brightYellow + '\\\\uD83E\\\\uDD16 Swarm' + c.reset + '  ' + swarmInd + ' [' + agentsColor + String(swarm.activeAgents).padStart(2) + c.reset + '/' + c.brightWhite + swarm.maxAgents + c.reset + ']' + topoTag + '  ' +
    subColor + '\\\\uD83D\\\\uDC65 ' + subLabel + c.reset + '    ' +
    c.brightBlue + '\\\\uD83E\\\\uDE9D ' + hooksColor + hooks.enabled + c.reset + '/' + c.brightWhite + hooks.total + c.reset + '    ' +
    secIcon + ' ' + secColor + 'CVE ' + security.cvesFixed + c.reset + '/' + c.brightWhite + security.totalCves + c.reset + '    ' +
    c.brightCyan + '\\\\uD83D\\\\uDCBE ' + system.memoryMB + 'MB' + c.reset + '    ' +
    intellColor + '\\\\uD83E\\\\uDDE0 ' + String(system.intelligencePct).padStart(3) + '%' + c.reset
  );\`;

        if (oldRender.test(src)) {
          src = src.replace(oldRender, newRender);
          fs.writeFileSync('$STATUSLINE_FILE', src);
          process.exit(0);
        } else {
          process.exit(1);
        }
      " 2>/dev/null && {
        ((SL_PATCHED++)) || true
        pass "Swarm line render patched"
      } || {
        warn "Swarm render patch skipped (already modified or pattern not found)"
      }
    fi
  else
    warn "Swarm render section not found in statusline"
  fi

  # ── Summary for step 11 ──
  if [[ "$SL_PATCHED" -gt 0 ]]; then
    fix "Applied $SL_PATCHED statusline patch(es)"
    pass "Applied $SL_PATCHED statusline patch(es)"
  fi

  # ── Post-write syntax guard ──
  # Verify the file still parses after all step-11 writes. If `node --check`
  # fails, restore from .bak so we don't ship a SyntaxError-broken statusline.
  # Single check at the end of step 11 (not per-sub-patch) because: sub-patches
  # are additive on the same file — a broken write would cascade into the next
  # patch's input, and on rollback we want to bail the whole step anyway. The
  # render smoke check below is complementary, not redundant.
  if [[ "$DRY_RUN" -ne 1 ]]; then
    if node --check "$STATUSLINE_FILE" 2>/tmp/statusline-fixruflo-check.log; then
      pass "statusline.cjs syntax OK (node --check)"
      rm -f "$STATUSLINE_BAK"
    else
      fail "statusline.cjs failed node --check — restoring backup"
      cat /tmp/statusline-fixruflo-check.log >&2 || true
      if [[ -f "$STATUSLINE_BAK" ]]; then
        mv "$STATUSLINE_BAK" "$STATUSLINE_FILE"
        info "restored from $STATUSLINE_BAK"
      fi
      ((ERRORS++)) || true
    fi
  fi

  # Verify statusline runs without error
  STATUSLINE_OUT="$(node "$STATUSLINE_FILE" 2>&1)" || true
  if echo "$STATUSLINE_OUT" | grep -qi "Swarm\|plugin"; then
    pass "Statusline renders correctly"
  else
    warn "Statusline may have rendering issues"
  fi

  # Audit LOW #5: settings.json's statusLine command falls back to
  # statusline-v3.cjs if the primary fails — so validate the fallback too.
  STATUSLINE_V3="$TARGET_DIR/.claude/helpers/statusline-v3.cjs"
  if [[ -f "$STATUSLINE_V3" ]]; then
    if node --check "$STATUSLINE_V3" 2>/dev/null; then
      pass "statusline-v3.cjs fallback syntax OK"
    else
      warn "statusline-v3.cjs fallback failed node --check — the statusLine cascade would skip to the plain echo"
      ((ERRORS++)) || true
    fi
  else
    warn "statusline-v3.cjs fallback missing — statusLine cascade has only the plain-echo backstop"
  fi
else
  warn "No statusline.cjs found at $STATUSLINE_FILE"
  warn "Run 'npx ruflo@latest init --wizard' to generate hooks"
  ((ERRORS++)) || true
fi

# ── Step 11b: learning.json reader path fix (RUFLO-LEARNING-PATH-V1) ───────────
# Upstream defect: the hooks statusline/consolidate reader searches .claude-flow/,
# .claude/.claude-flow/, .swarm/ for learning.json — but `ruflo init` WRITES it to
# .claude-flow/metrics/ (init/executor.js). The reader therefore never finds the file
# that exists and falls through to a meaningless .swarm/memory.db file-SIZE proxy for
# the 🧠 intelligence chip (a routine WAL checkpoint can snap it 9%→100%). Add the
# metrics/ path as the first search entry so the reader finds the real file. (The kit's
# statusline RUFLO-INTEL overlay already supersedes the 🧠 chip with real LoRA/routing
# metrics; this fixes the upstream reader so it stops consuming the volatile proxy and
# is correct for anyone reading `ruflo hooks statusline --json` directly.) Global
# @claude-flow/cli dist; sentinel + .bak + node --check. Clean one-line upstream fix.
header "11b/11" "learning.json reader path (RUFLO-LEARNING-PATH-V1)"
LJ_HOOKS="$(npm root -g 2>/dev/null)/ruflo/node_modules/@claude-flow/cli/dist/src/commands/hooks.js"
if [[ ! -f "$LJ_HOOKS" ]]; then
  warn "global @claude-flow/cli hooks.js not found — skipping learning.json path fix"
elif grep -q "RUFLO-LEARNING-PATH-V1" "$LJ_HOOKS"; then
  pass "learning.json reader path already fixed (RUFLO-LEARNING-PATH-V1)"
elif ! grep -q "const learningJsonPaths = \[" "$LJ_HOOKS"; then
  warn "learningJsonPaths anchor not found (version drift?) — verify manually"
elif [[ "$DRY_RUN" -eq 1 ]]; then
  info "[dry-run] would add .claude-flow/metrics/ to learningJsonPaths"
else
  [[ -e "$LJ_HOOKS.learnpath-bak" ]] || cp "$LJ_HOOKS" "$LJ_HOOKS.learnpath-bak"
  node -e 'const fs=require("fs"),F=process.argv[1];const A="const learningJsonPaths = [\n";const INS="                path.join(process.cwd(), \x27.claude-flow\x27, \x27metrics\x27, \x27learning.json\x27), /* RUFLO-LEARNING-PATH-V1 */\n";let s=fs.readFileSync(F,"utf8");if(s.includes(A)&&!s.includes("RUFLO-LEARNING-PATH-V1")){s=s.replace(A,A+INS);fs.writeFileSync(F,s);}' "$LJ_HOOKS"
  if node --check "$LJ_HOOKS" 2>/dev/null && grep -q "RUFLO-LEARNING-PATH-V1" "$LJ_HOOKS"; then
    fix "Added .claude-flow/metrics/ to learning.json reader (RUFLO-LEARNING-PATH-V1)"; pass "learning.json reader path fixed"
  else
    warn "learning.json path patch failed / anchor mismatch — restoring"; cp "$LJ_HOOKS.learnpath-bak" "$LJ_HOOKS"
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "============================================"
echo " Summary"
echo "============================================"
echo -e "  Fixes applied:    ${GREEN}$FIXES${NC}"
echo -e "  Manual actions:   ${YELLOW}$ERRORS${NC}"
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo -e "  Mode:             ${YELLOW}DRY RUN (nothing changed)${NC}"
fi
echo ""

if [[ "${#FIX_LOG[@]}" -gt 0 ]]; then
  echo "  Changes:"
  for entry in "${FIX_LOG[@]}"; do
    echo -e "    ${GREEN}✓${NC} $entry"
  done
  echo ""
fi

if [[ "$FIXES" -gt 0 && "$DRY_RUN" -eq 0 ]]; then
  echo -e "  ${YELLOW}→ Restart Claude Code to apply changes${NC}"
  echo ""
  echo "  After restart, verify with:"
  echo "    1. mcp__claude-flow__agentdb_health"
  echo "    2. mcp__claude-flow__memory_store --key test --value ok"
  echo "    3. mcp__claude-flow__hive-mind_status"
fi

if [[ "$ERRORS" -gt 0 ]]; then
  echo -e "  ${YELLOW}Review warnings above for manual actions${NC}"
fi

if [[ "$FIXES" -eq 0 && "$ERRORS" -eq 0 ]]; then
  echo -e "  ${GREEN}Everything looks good!${NC}"
fi

echo -e "\n  Log: $LOG_FILE"
echo ""

# Exit with error if there are unresolved issues
exit "$( [[ "$ERRORS" -gt 0 ]] && echo 1 || echo 0 )"
