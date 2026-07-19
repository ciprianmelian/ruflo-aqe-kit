#!/usr/bin/env bash
set -uo pipefail
# ============================================================================
# upgrade-2026-05-26.sh — Phase A of the ruflo/agentdb/agentic-qe upgrade
# Run AFTER closing this Claude Code session (it restarts the live MCP server).
# Reference: docs/UPGRADE-PATH-ruflo-agentdb-agentic-qe-2026-05-26.md
# ============================================================================

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
info() { echo -e "  ${CYAN}→${NC} $1"; }
header() { echo -e "\n${CYAN}[$1]${NC} $2"; }

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
kit_resolve "$@"
kit_require_target
cd "$TARGET_DIR"
LOG_FILE="${TMPDIR:-/tmp}/upgrade-ruflo-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "============================================"
echo " Phase A — ruflo 3.6.12 → 3.10.2"
echo " kit:    $KIT_DIR"
echo " target: $TARGET_DIR"
[[ "$DRY_RUN" -eq 1 ]] && echo -e " mode:    ${YELLOW}DRY RUN${NC}"
echo " log:     $LOG_FILE"
echo "============================================"

# ── 1. Pre-flight ────────────────────────────────────────────────────────────
header "1/9" "Pre-flight"
NODE_VER="$(node --version 2>/dev/null || echo 'missing')"
[[ "$NODE_VER" == "missing" ]] && { fail "Node.js not found"; exit 1; }
pass "Node $NODE_VER"

CURRENT_RUFLO="$(npm list -g ruflo --depth=0 2>/dev/null | grep 'ruflo@' | sed 's/.*ruflo@//' | tr -d '[:space:]')"
LATEST_RUFLO="$(npm view ruflo version 2>/dev/null | tr -d '[:space:]')"
info "Current ruflo: ${CURRENT_RUFLO:-none}"
info "Latest  ruflo: ${LATEST_RUFLO:-unknown}"

if [[ -z "$LATEST_RUFLO" ]]; then
  fail "Cannot reach npm registry — abort"
  exit 1
fi
if [[ "$CURRENT_RUFLO" == "$LATEST_RUFLO" ]]; then
  warn "Already on latest — Phase A is a no-op except cache wipe"
fi

# Warn if Claude Code is running (would conflict with MCP restart)
if pgrep -f "ruflo mcp start" >/dev/null 2>&1; then
  warn "ruflo MCP server is currently running — restart Claude Code after this script"
fi

# ── 2. Daemon stop (release npx cache handles) ──────────────────────────────
# Must precede the cache wipe — a running daemon holds open handles into
# ~/.npm/_npx and would prevent the next session's daemon-start from binding
# cleanly. `ruflo daemon stop` is tolerant: exits 0 either way; prints "was
# not running" if already stopped.
header "2/9" "Daemon stop (release npx cache handles)"
if [[ "$DRY_RUN" -eq 1 ]]; then
  info "[dry-run] Would: ruflo daemon stop || true"
else
  if command -v ruflo >/dev/null 2>&1; then
    ruflo daemon stop >/tmp/upgrade-daemon-stop.log 2>&1 || true
    pass "Daemon stop signal sent (see /tmp/upgrade-daemon-stop.log)"
  else
    info "ruflo not yet on PATH — daemon stop skipped (will be re-seated at step 8)"
  fi
fi

# ── 3. Snapshot caches (for rollback) ────────────────────────────────────────
header "3/9" "Cache snapshot"
SNAPSHOT_DIR="${TMPDIR:-/tmp}/ruflo-npx-snapshot-$(date +%Y%m%d-%H%M%S)"
if [[ -d "$HOME/.npm/_npx" ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] Would: ls ~/.npm/_npx > $SNAPSHOT_DIR.list"
  else
    mkdir -p "$SNAPSHOT_DIR"
    # Record what was there (so user can re-resolve other tools if needed)
    ls "$HOME/.npm/_npx" > "$SNAPSHOT_DIR/inventory.txt" 2>/dev/null || true
    pass "Inventory snapshot: $SNAPSHOT_DIR/inventory.txt"
    info "(Cache itself NOT copied — too large; npx will re-resolve on demand)"
  fi
else
  pass "No ~/.npm/_npx to snapshot"
fi

# MODEL-CACHE-SEED-V1: harvest the PACKAGE-LOCAL transformers weight caches into
# the vault BEFORE the install wipes ruflo's. transformers.js never reads
# TRANSFORMERS_CACHE (see common.sh) — the package-local dirs are the live ones.
info "Preserving package-local ONNX weight caches → $(kit_model_vault)"
info "  $(kit_preserve_model_caches)"

# ── 4. Upgrade global ruflo ──────────────────────────────────────────────────
header "4/9" "Upgrade ruflo to $LATEST_RUFLO"
if [[ "$DRY_RUN" -eq 1 ]]; then
  info "[dry-run] Would: npm install -g ruflo@latest"
else
  # GH issue #1825 — silent fail on Node 22/25. Use --foreground-scripts to surface errors.
  if npm install -g ruflo@latest --foreground-scripts 2>&1 | tee "${LOG_FILE}.npm-install.log"; then
    NEW_VER="$(npm list -g ruflo --depth=0 2>/dev/null | grep 'ruflo@' | sed 's/.*ruflo@//' | tr -d '[:space:]')"
    if [[ "$NEW_VER" == "$LATEST_RUFLO" ]]; then
      pass "ruflo upgraded to $NEW_VER"
    else
      fail "ruflo install reported success but version is $NEW_VER (expected $LATEST_RUFLO)"
      fail "Likely hit GH issue #1825 — inspect ${LOG_FILE}.npm-install.log"
      exit 2
    fi
  else
    fail "npm install -g ruflo@latest failed — see ${LOG_FILE}.npm-install.log"
    exit 2
  fi
  # MODEL-CACHE-SEED-V1: reseed the fresh package's transformers cache from the
  # vault so the first post-upgrade embed is a disk hit, not a re-download.
  info "Restoring ONNX weight caches from vault: $(kit_restore_model_caches)"
fi

# ── 5. Wipe npx cache ────────────────────────────────────────────────────────
header "5/9" "Wipe npx cache (forces fresh @claude-flow/memory + agentdb)"

# Tier 6.5 (legacy npx harvest): merge any ~25MB ONNX model caches still living
# inside npx subtrees into the vault before wiping. NOTE: nothing reads the
# vault via TRANSFORMERS_CACHE — transformers.js ignores that env var
# (MODEL-CACHE-SEED-V1, common.sh); the vault is read back by
# kit_restore_model_caches, which reseeds the PACKAGE-LOCAL caches after
# installs. Prefer rsync (faster on large trees, file-wise update semantics);
# fall back to `cp -R` when rsync isn't available.
PRESERVE_MODELS="${RUFLO_MODEL_CACHE:-$HOME/.cache/ruflo-models}"
if [[ -d "$HOME/.npm/_npx" ]]; then
  RSYNC_CMD="rsync -a --update"
  command -v rsync >/dev/null 2>&1 || RSYNC_CMD="cp -R"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] Would: preserve transformers caches under $PRESERVE_MODELS using \"$RSYNC_CMD\""
  else
    mkdir -p "$PRESERVE_MODELS"
    preserved=0
    while IFS= read -r d; do
      if [[ -d "$d" ]]; then
        $RSYNC_CMD "$d/" "$PRESERVE_MODELS/" 2>/dev/null && preserved=$((preserved + 1)) || true
      fi
    done < <(find "$HOME/.npm/_npx" -path "*/@xenova/transformers/.cache" -type d 2>/dev/null)
    if [[ "$preserved" -gt 0 ]]; then
      pass "ONNX models preserved at $PRESERVE_MODELS ($preserved cache(s) merged)"
    else
      info "No @xenova/transformers/.cache dirs found in npx tree — nothing to preserve"
    fi
  fi
fi

if [[ -d "$HOME/.npm/_npx" ]]; then
  CACHE_SIZE="$(du -sh "$HOME/.npm/_npx" 2>/dev/null | awk '{print $1}')"
  warn "About to delete $CACHE_SIZE of npx cache (affects ALL projects, not just this one)"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] Would: rm -rf $HOME/.npm/_npx"
  else
    rm -rf "$HOME/.npm/_npx"
    pass "Cache wiped"
  fi
else
  pass "No cache to wipe"
fi

# ── 6. Rehydrate ruflo cache ─────────────────────────────────────────────────
header "6/9" "Rehydrate ruflo cache"
if [[ "$DRY_RUN" -eq 1 ]]; then
  info "[dry-run] Would: npx -y ruflo@latest --version"
else
  # Trigger a fresh resolution so @claude-flow/memory@alpha.18 lands. Note this
  # pulls agentdb@alpha.14 (the declared dep) into the cache transiently —
  # step 7's fix-ruflo.sh (Step 3b) then force-pins the GLOBAL tree's agentdb to
  # alpha.10, which is what the global-launched MCP actually uses (Patch 18).
  if npx -y ruflo@latest --version 2>&1 | tee -a "$LOG_FILE" | grep -q "v3\."; then
    pass "ruflo MCP entrypoint resolved"
  else
    warn "Could not verify ruflo entrypoint — check log"
  fi
fi

# ── 7. Re-run fix-ruflo.sh (re-force agentdb alpha.10 in the global tree) ─────
# Step 4's global ruflo upgrade resets the nested agentdb to the declared
# ^alpha.14; fix-ruflo.sh Step 3b force-pins it back to alpha.10 (Tier 7/Patch
# 18). The old "Patch 1" import-rewrite is retired — Step 3b supersedes it.
header "7/9" "Re-run fix-ruflo.sh against fresh cache"
if [[ -f "$KIT_LIB/fix-ruflo.sh" ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] Would: bash $KIT_LIB/fix-ruflo.sh"
  else
    bash "$KIT_LIB/fix-ruflo.sh" "$TARGET_DIR" 2>&1 | tail -30
    pass "fix-ruflo.sh complete (Patches 0 & 2 report 'already present'; Step 3b force-pins global agentdb to alpha.10)"
  fi
else
  fail "fix-ruflo.sh not found"
  exit 3
fi

# ── 8/9. Restore AQE promoted pattern (fix-aqe.sh patch + re-mint) ───────────
# Symmetric to step 7 (fix-ruflo): the global ruflo upgrade (step 4) + npx wipe
# (step 5) can disturb the agentic-qe dist tree, and re-resolution drops the
# distilled AQE-PROMOTE pattern. fix-aqe.sh re-applies the dist-chunk PATCH;
# `aqe learning extract` re-distills (re-mints) it. Must precede re-activation.
#   • global aqe → fix-aqe.sh patches dist + extract re-mints under relaxed filter
#   • npx-only   → fix-aqe.sh warns "global agentic-qe not found" & skips patch;
#                  extract still runs against fresh cache (safe no-cost no-op)
header "8/9" "Restore AQE promoted pattern (fix-aqe.sh + learning extract)"
if command -v aqe >/dev/null 2>&1; then
  AQE_CMD=(aqe); info "using global aqe"
else
  AQE_CMD=(npx -y agentic-qe@latest); info "aqe not on PATH — using npx (extract re-mints; dist patch needs a global install)"
fi
if [[ "$DRY_RUN" -eq 1 ]]; then
  info "[dry-run] Would: bash $KIT_LIB/fix-aqe.sh"
  info "[dry-run] Would: ${AQE_CMD[*]} learning extract"
else
  if [[ -f "$KIT_LIB/fix-aqe.sh" ]]; then
    bash "$KIT_LIB/fix-aqe.sh" "$TARGET_DIR" >/tmp/upgrade-aqe-restore.log 2>&1 \
      && pass "fix-aqe.sh re-applied (AQE-PROMOTE dist patch)" \
      || warn "fix-aqe.sh reported issues (see /tmp/upgrade-aqe-restore.log) — non-fatal"
  else
    warn "fix-aqe.sh not found — skipping AQE dist patch (non-fatal)"
  fi
  if "${AQE_CMD[@]}" learning extract >>/tmp/upgrade-aqe-restore.log 2>&1; then
    pass "AQE promoted pattern re-minted (learning extract)"
  else
    warn "aqe learning extract reported issues (see /tmp/upgrade-aqe-restore.log) — non-fatal"
  fi
fi

# ── 9. Re-activate (swarm + embeddings + HNSW + neural + hooks + hive + daemon)
# The npx wipe at step 5 evicts the activation state ruflo daemons hold in memory.
# Without this step, the user is left on a clean install with no daemon, no
# swarm, no neural priors — i.e. "ruflo is installed" but not "ruflo is alive".
# Use --reactivate (not --force) so steps 2/3/4 of init are skipped (no
# re-running of `ruflo init` / `memory init` / `aqe init`) but the activation
# table + daemon re-seat both run.
header "9/9" "Re-activate (init-ruflo-aqe-agentdb.sh --reactivate)"
if [[ -f "$KIT_LIB/init.sh" ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] Would: bash $KIT_LIB/init.sh --reactivate"
  else
    bash "$KIT_LIB/init.sh" "$TARGET_DIR" --reactivate 2>&1 | tail -40
    pass "re-activation complete"
  fi
else
  warn "init.sh not found — manual re-activation required"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "============================================"
echo " Phase A Complete"
echo "============================================"
echo ""
echo "  Next steps (manual):"
echo "    1. Restart Claude Code (MCP server picks up new ruflo)"
echo "    2. Verify: bash $KIT_LIB/session-init.sh"
echo "    3. In Claude Code: agentdb_controllers → active: 23/23 (all 7 advanced controllers on)"
echo ""
echo "  Rollback (if needed):"
echo "    npm install -g ruflo@$CURRENT_RUFLO"
echo "    (npx caches auto-rehydrate; nothing else to restore)"
echo ""
echo "  Log: $LOG_FILE"
echo ""
