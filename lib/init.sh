#!/usr/bin/env bash
set -uo pipefail
# ============================================================================
# init-ruflo-aqe-agentdb.sh — One-shot project initialization for:
#   • ruflo        (v3 MCP orchestration platform)
#   • Agentic QE   (standalone AQE v3 plugin)
#   • AgentDB      (controller-registry + ReasoningBank patches)
#
# Idempotent: safe to re-run. Skips steps that are already complete unless
# --force is passed. Each step is gated and prints clear status.
#
# Usage:
#   bin/ruflo-kit init <target>              # standard
#   bin/ruflo-kit init <target> --force      # re-init everything
#   bin/ruflo-kit init <target> --reactivate # skip 2/3/4, re-run activation + daemon only
#   bin/ruflo-kit init <target> --dry-run    # show plan only
# ============================================================================

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

pass()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail()   { echo -e "  ${RED}✗${NC} $1"; }
warn()   { echo -e "  ${YELLOW}!${NC} $1"; }
info()   { echo -e "  ${CYAN}→${NC} $1"; }
header() { echo -e "\n${CYAN}[$1]${NC} ${BOLD}$2${NC}"; }

kit_resolve "$@"
[[ "$KIT_WANT_HELP" -eq 1 ]] && { sed -n '4,17p' "$0"; exit 0; }
mkdir -p "$TARGET_DIR"   # init may bootstrap a brand-new codebase path
cd "$TARGET_DIR"
# --force is the superset — implies --reactivate semantics
[[ "$FORCE" -eq 1 ]] && REACTIVATE=1

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] $*"
    return 0
  fi
  "$@"
}

ERRORS=0
STEPS_RUN=0
STEPS_SKIPPED=0

echo -e "${BOLD}============================================${NC}"
echo -e " ${BOLD}ruflo + AQE + AgentDB initialization${NC}"
echo -e " kit:    $KIT_DIR"
echo -e " target: $TARGET_DIR"
if [[ "$FORCE" -eq 1 ]]; then
  echo -e " mode: ${YELLOW}--force${NC}"
elif [[ "$REACTIVATE" -eq 1 ]]; then
  echo -e " mode: ${YELLOW}--reactivate${NC} (skip 2/3/4, re-run activation + daemon)"
fi
[[ "$DRY_RUN" -eq 1 ]] && echo -e " mode: ${YELLOW}--dry-run${NC}"
echo -e "${BOLD}============================================${NC}"

# ── 1/9: Prerequisites ──────────────────────────────────────────────────────
header "1/9" "Prerequisites"

NODE_VER="$(node -v 2>/dev/null || echo none)"
NPM_VER="$(npm -v 2>/dev/null || echo none)"
RUFLO_VER="$(ruflo --version 2>/dev/null | head -1 || echo none)"
AQE_VER="$(aqe --version 2>/dev/null | head -1 || echo none)"
CLAUDE_BIN="$(command -v claude || true)"

if [[ "$NODE_VER" == "none" ]]; then
  fail "node not found"; ((ERRORS++)) || true
else
  pass "node $NODE_VER"
fi

if [[ "$NPM_VER" == "none" ]]; then
  fail "npm not found"; ((ERRORS++)) || true
else
  pass "npm $NPM_VER"
fi

if [[ "$RUFLO_VER" == "none" ]]; then
  warn "ruflo not installed globally — will use 'npx -y ruflo@latest' for setup commands"
  warn "BUT: the 7 advanced AgentDB controllers require a GLOBAL ruflo install."
  warn "  The MCP launches from the global 'ruflo' binary (.mcp.json), and the"
  warn "  agentdb@3.0.0-alpha.10 controller fix only sticks in the global tree —"
  warn "  npx reverts it on every call. Install with: npm i -g ruflo  (see Patch 18)"
  RUFLO_CMD=(npx -y ruflo@latest)
else
  pass "ruflo $RUFLO_VER"
  RUFLO_CMD=(ruflo)
fi

if [[ "$AQE_VER" == "none" ]]; then
  warn "agentic-qe (aqe) not installed globally — will use 'npx -y agentic-qe@latest'"
  warn "for a faster, cached install run: npm install -g agentic-qe"
  AQE_CMD=(npx -y agentic-qe@latest)
else
  pass "aqe $AQE_VER"
  AQE_CMD=(aqe)
fi

if [[ -z "$CLAUDE_BIN" ]]; then
  warn "claude CLI not on PATH — MCP registration step will be skipped by fix scripts"
else
  pass "claude CLI: $CLAUDE_BIN"
fi

# Tier 6.5: persistent ONNX/transformers cache. Without this, each npx cache
# wipe (upgrade scripts, manual cleanups) re-downloads ~25MB of model
# weights — Xenova/all-MiniLM-L6-v2 in particular — every time. Point
# TRANSFORMERS_CACHE at a stable per-user dir; both ruflo and AQE pick it up.
# Overridable via RUFLO_MODEL_CACHE env var.
RUFLO_MODEL_CACHE="${RUFLO_MODEL_CACHE:-$HOME/.cache/ruflo-models}"
mkdir -p "$RUFLO_MODEL_CACHE"
export TRANSFORMERS_CACHE="$RUFLO_MODEL_CACHE"
pass "ONNX model cache: $RUFLO_MODEL_CACHE (TRANSFORMERS_CACHE exported)"

if [[ "$ERRORS" -gt 0 ]]; then
  fail "missing prerequisites — aborting"
  exit 1
fi

# ── 2/9: ruflo init ─────────────────────────────────────────────────────────
if [[ "$REACTIVATE" -eq 1 && "$FORCE" -eq 0 ]]; then
  header "2/9" "ruflo init (V3 runtime + .claude/ integration)"
  pass "SKIPPED (--reactivate: ruflo init not re-run)"
  ((STEPS_SKIPPED++)) || true
else
  header "2/9" "ruflo init (V3 runtime + .claude/ integration)"

  RUFLO_INITIALIZED=0
  if [[ -f ".claude-flow/config.yaml" && -f ".mcp.json" && -d ".claude/skills" ]]; then
    RUFLO_INITIALIZED=1
  fi

  if [[ "$RUFLO_INITIALIZED" -eq 1 && "$FORCE" -eq 0 ]]; then
    pass "ruflo already initialized (.claude-flow/config.yaml present)"
    info "use --force to re-run 'ruflo init --force'"
    ((STEPS_SKIPPED++)) || true
  else
    if [[ "$FORCE" -eq 1 ]]; then
      info "running: ruflo init --force"
      run "${RUFLO_CMD[@]}" init --force
    else
      info "running: ruflo init"
      run "${RUFLO_CMD[@]}" init
    fi
    ((STEPS_RUN++)) || true
  fi
fi

# ── 3/9: ruflo memory init (creates .swarm/memory.db) ───────────────────────
if [[ "$REACTIVATE" -eq 1 && "$FORCE" -eq 0 ]]; then
  header "3/9" "ruflo memory init (.swarm/memory.db)"
  pass "SKIPPED (--reactivate: memory init not re-run)"
  ((STEPS_SKIPPED++)) || true
else
  header "3/9" "ruflo memory init (.swarm/memory.db)"

  if [[ -f ".swarm/memory.db" && "$FORCE" -eq 0 ]]; then
    DB_SIZE="$(wc -c < .swarm/memory.db 2>/dev/null || echo 0)"
    pass "memory.db exists (${DB_SIZE} bytes)"
    ((STEPS_SKIPPED++)) || true
  else
    info "running: ruflo memory init"
    if run "${RUFLO_CMD[@]}" memory init; then
      pass "memory database initialized"
      ((STEPS_RUN++)) || true
    else
      fail "ruflo memory init failed"
      ((ERRORS++)) || true
    fi
  fi
fi

# ── 4/9: agentic-qe init ────────────────────────────────────────────────────
if [[ "$REACTIVATE" -eq 1 && "$FORCE" -eq 0 ]]; then
  header "4/9" "agentic-qe init (AQE v3 — auto-detect, copy .claude/ templates)"
  pass "SKIPPED (--reactivate: aqe init not re-run)"
  ((STEPS_SKIPPED++)) || true
else
  header "4/9" "agentic-qe init (AQE v3 — auto-detect, copy .claude/ templates)"

  # AQE init has two distinct effects:
  #   (a) SDK init    — creates .agentic-qe/memory.db and seeds SONA/DreamScheduler
  #   (b) Project init — copies ~120 skills, ~60 agents, ~20 commands into .claude/
  # Only checking for (a) is not enough — `npx agentic-qe init` without `--auto`
  # (or with `--memory hybrid` only) does (a) but NOT (b). The skip-check below
  # requires a known AQE-specific skill marker so a half-init forces a re-run.
  # Reference: https://github.com/proffesor-for-testing/agentic-qe#quick-start
  AQE_MARKER=".claude/skills/agentic-quality-engineering"
  AQE_FULLY_INITIALIZED=0
  if [[ -f ".agentic-qe/memory.db" && ( -d "$AQE_MARKER" || -f "$AQE_MARKER" || -f "${AQE_MARKER}.md" || -f "${AQE_MARKER}/SKILL.md" ) ]]; then
    AQE_FULLY_INITIALIZED=1
  fi

  if [[ "$AQE_FULLY_INITIALIZED" -eq 1 && "$FORCE" -eq 0 ]]; then
    pass "agentic-qe already initialized (SDK + .claude/ templates present)"
    ((STEPS_SKIPPED++)) || true
  elif [[ -f ".agentic-qe/memory.db" && "$AQE_FULLY_INITIALIZED" -eq 0 ]]; then
    warn ".agentic-qe/memory.db exists but .claude/ AQE templates missing — running '--auto --upgrade' to complete the half-init"
    AQE_FLAGS=(--auto --upgrade)
    if run "${AQE_CMD[@]}" init "${AQE_FLAGS[@]}"; then
      pass "agentic-qe init completed"
      ((STEPS_RUN++)) || true
    else
      fail "agentic-qe init failed"
      ((ERRORS++)) || true
    fi
  else
    info "running: ${AQE_CMD[*]} init --auto"
    AQE_FLAGS=(--auto)
    [[ "$FORCE" -eq 1 ]] && AQE_FLAGS+=(--upgrade)
    if run "${AQE_CMD[@]}" init "${AQE_FLAGS[@]}"; then
      pass "agentic-qe initialized"
      ((STEPS_RUN++)) || true
    else
      fail "agentic-qe init failed"
      ((ERRORS++)) || true
    fi
  fi
fi

# ── 4.5/9: Backfill ruflo + AQE .claude templates (agents/commands/skills) ──
# `ruflo init` (step 2) and `aqe init` (step 4) each copy their OWN .claude
# templates, but in practice neither guarantees the FULL set lands — an
# AQE-first project ends up with the qe-* agents + only a thin ruflo subset
# (init copies curated/partial sets, and step ordering can leave gaps; observed:
# 79/89 ruflo agents, 8/23 categories). This step NON-DESTRUCTIVELY backfills
# every agent/command/skill present in the global ruflo CLI template or the
# agentic-qe template but MISSING from .claude/ — it only ADDS files, never
# overwrites (so qe-* and any local customizations are preserved). Idempotent.
# NOTE: ruflo PLUGINS are NOT part of init's .claude (the CLI template ships none;
# install via `ruflo plugin install <name>`). HOOKS live in .claude/settings.json
# (wired by fix-aqe.sh, step 6.5) — there is no .claude/hooks template to copy.
if [[ "$REACTIVATE" -eq 1 && "$FORCE" -eq 0 ]]; then
  header "4.5/9" "Backfill .claude templates (agents/commands/skills)"
  pass "SKIPPED (--reactivate)"
  ((STEPS_SKIPPED++)) || true
else
  header "4.5/9" "Backfill .claude templates (agents/commands/skills)"
  GNM_ROOT="$(npm root -g 2>/dev/null || true)"
  CLI_TPL="$GNM_ROOT/ruflo/node_modules/@claude-flow/cli/.claude"
  AQE_TPL="$GNM_ROOT/agentic-qe/.claude"
  # Non-destructive copy: add files present in $1 (src) but absent in $2 (dst).
  _backfill() {
    local src="$1" dst="$2" added=0 rel d
    [[ -d "$src" ]] || { echo 0; return; }
    while IFS= read -r rel; do
      rel="${rel#./}"; [[ -n "$rel" ]] || continue
      d="$dst/$rel"
      [[ -e "$d" ]] && continue            # never overwrite existing
      mkdir -p "$(dirname "$d")"
      cp "$src/$rel" "$d" 2>/dev/null && added=$((added+1))
    done < <(cd "$src" && find . -type f)
    echo "$added"
  }
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] would non-destructively backfill .claude/{agents,commands,skills} from ruflo CLI + agentic-qe templates"
  elif [[ ! -d "$CLI_TPL" && ! -d "$AQE_TPL" ]]; then
    warn "no GLOBAL ruflo/agentic-qe .claude template found (npx-only install?) — skipping backfill"
    warn "  for full templates install globally: npm i -g ruflo agentic-qe"
  else
    total_added=0
    for kind in agents commands skills; do
      a="$(_backfill "$CLI_TPL/$kind" ".claude/$kind")"
      b="$(_backfill "$AQE_TPL/$kind" ".claude/$kind")"
      n=$((a + b))
      total_added=$((total_added + n))
      [[ "$n" -gt 0 ]] && info "  $kind: +$n (ruflo $a, aqe $b)"
    done
    if [[ "$total_added" -gt 0 ]]; then
      pass "Backfilled $total_added missing .claude template files (non-destructive)"
      ((STEPS_RUN++)) || true
    else
      pass ".claude templates already complete (nothing to backfill)"
      ((STEPS_SKIPPED++)) || true
    fi
    AG="$(find .claude/agents -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
    CM="$(find .claude/commands -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
    SK="$(find .claude/skills -type f 2>/dev/null | wc -l | tr -d ' ')"
    info "  .claude inventory: $AG agents, $CM commands, $SK skills"
  fi
fi

# ── 5/9: AgentDB patches (controller-registry, ReasoningBank, embedder) ─────
header "5/9" "AgentDB patches (fix-ruflo.sh)"

if [[ ! -x "$KIT_LIB/fix-ruflo.sh" ]]; then
  warn "fix-ruflo.sh not found or not executable — skipping AgentDB patches"
  ((ERRORS++)) || true
else
  info "running: fix-ruflo.sh"
  if run bash "$KIT_LIB/fix-ruflo.sh" "$TARGET_DIR"; then
    pass "AgentDB patches applied"
    ((STEPS_RUN++)) || true
  else
    # fix-ruflo.sh exits 1 if any check fails; warnings only — don't abort
    warn "fix-ruflo.sh reported issues (see its log)"
  fi
fi

# ── 6/9: Statusbar restore (AQE init clobbers it) ───────────────────────────
header "6/9" "Statusbar restore (fix-statusbar.sh)"

if [[ ! -x "$KIT_LIB/fix-statusbar.sh" ]]; then
  warn "fix-statusbar.sh not found or not executable — skipping"
else
  info "running: fix-statusbar.sh"
  if run bash "$KIT_LIB/fix-statusbar.sh" "$TARGET_DIR" >/tmp/fix-statusbar-init.log 2>&1; then
    pass "statusbar restored"
    ((STEPS_RUN++)) || true
  else
    warn "fix-statusbar.sh reported issues (see /tmp/fix-statusbar-init.log)"
  fi
fi

# ── 6.5/9: AQE hardening (AQE-PROMOTE distillation + .claude dual-hook/RAG) ─
header "6.5/9" "AQE hardening (fix-aqe.sh)"

if [[ ! -x "$KIT_LIB/fix-aqe.sh" ]]; then
  warn "fix-aqe.sh not found or not executable — skipping AQE codification"
else
  info "running: fix-aqe.sh"
  if run bash "$KIT_LIB/fix-aqe.sh" "$TARGET_DIR" >/tmp/fix-aqe-init.log 2>&1; then
    pass "AQE hardening applied (AQE-PROMOTE + helpers + hook wiring)"
    ((STEPS_RUN++)) || true
  else
    warn "fix-aqe.sh reported issues (see /tmp/fix-aqe-init.log)"
  fi

  # Re-mint the AQE-PROMOTE pattern that step-4 `aqe init` drops. fix-aqe.sh
  # (above) only re-applies the dist-chunk PATCH that relaxes the distillation
  # filter — it does NOT run extraction. `aqe learning extract` re-distills the
  # promoted pattern, so it MUST run AFTER the patch. Idempotent (UNIQUE
  # constraint → re-extract is a no-op once present). Non-fatal.
  info "running: ${AQE_CMD[*]} learning extract (re-mint AQE-PROMOTE pattern)"
  if run "${AQE_CMD[@]}" learning extract >/tmp/aqe-learning-extract-init.log 2>&1; then
    pass "AQE promoted pattern re-minted (learning extract)"
    ((STEPS_RUN++)) || true
  else
    warn "aqe learning extract reported issues (see /tmp/aqe-learning-extract-init.log) — non-fatal"
  fi
fi

# ── 7/9: Activation table (swarm → embeddings → HNSW → neural → hooks → ─────
#         hive-mind → daemon). Each sub-step is idempotent; --force re-runs.
# Order matters: data plane (memory + embeddings + HNSW) MUST be up before
# `daemon start`, otherwise background workers crash-loop. See research doc
# §2.1 for skip conditions and rationale.
header "7/9" "Activation table (self-learning loop)"

# Local helper: ISO-8601 "minutes since file modified" — used by the swarm
# state freshness check (A). Falls back to 99999 if the file is missing.
mtime_minutes_ago() {
  local f="$1"
  [[ -f "$f" ]] || { echo 99999; return; }
  local now_s mtime_s
  now_s=$(date +%s)
  # GNU stat vs BSD stat
  mtime_s=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)
  echo $(( (now_s - mtime_s) / 60 ))
}

ACT_TOTAL=7
ACT_RUN=0
ACT_SKIPPED=0
ACT_FAILED=0

# ── 7A: Swarm init (coordinator + queue) ──────────────────────────────────
SWARM_STATE=".claude-flow/swarm/swarm-state.json"
if [[ -f "$SWARM_STATE" && "$FORCE" -eq 0 ]] && [[ "$(mtime_minutes_ago "$SWARM_STATE")" -lt 30 ]]; then
  pass "7A: swarm already initialized (state < 30 min old)"
  ((ACT_SKIPPED++)) || true
else
  info "7A: running: ruflo swarm init --topology hierarchical-mesh --max-agents 15"
  if run "${RUFLO_CMD[@]}" swarm init --topology hierarchical-mesh --max-agents 15 >/tmp/ruflo-swarm-init.log 2>&1; then
    pass "7A: swarm initialized"
    ((ACT_RUN++)) || true
  else
    warn "7A: ruflo swarm init failed (see /tmp/ruflo-swarm-init.log) — continuing"
    ((ACT_FAILED++)) || true
  fi
fi

# ── 7B: Embeddings init (ONNX provider seat) ──────────────────────────────
# Skip-check: embeddings_status reports an active provider. The CLI prints
# "Provider: Xenova/all-MiniLM-L6-v2" (or similar) when initialised. We grep
# case-insensitively for "provider" and any non-empty model id on the same
# line. If the status call itself errors, treat as not-initialised.
EMB_STATUS_OUT="$( "${RUFLO_CMD[@]}" embeddings status 2>/dev/null || true )"
EMB_INITIALIZED=0
if echo "$EMB_STATUS_OUT" | grep -qiE 'provider.*[A-Za-z0-9_/.-]+'; then
  EMB_INITIALIZED=1
fi
if [[ "$EMB_INITIALIZED" -eq 1 && "$FORCE" -eq 0 ]]; then
  pass "7B: embeddings already initialized"
  ((ACT_SKIPPED++)) || true
else
  info "7B: running: ruflo embeddings init"
  if run "${RUFLO_CMD[@]}" embeddings init >/tmp/ruflo-embeddings-init.log 2>&1; then
    pass "7B: embeddings initialized"
    ((ACT_RUN++)) || true
  elif grep -q "Invalid model ID format: Xenova/" /tmp/ruflo-embeddings-init.log 2>/dev/null \
       && "${RUFLO_CMD[@]}" embeddings providers 2>/dev/null | grep -qiE 'ready'; then
    # Known COSMETIC upstream bug: `embeddings init`'s own validator rejects
    # ruflo's default model id `Xenova/all-MiniLM-L6-v2` because it forbids the
    # "/". Embeddings are actually operational (providers report Ready), so this
    # is a pass — it was inflating the "N failed" activation tally for nothing.
    pass "7B: embeddings operational (provider Ready; init model-ID validator error is cosmetic)"
    ((ACT_SKIPPED++)) || true
  else
    warn "7B: ruflo embeddings init failed (see /tmp/ruflo-embeddings-init.log) — continuing"
    ((ACT_FAILED++)) || true
  fi
fi

# ── 7C: HNSW build (vector index file) ────────────────────────────────────
# Skip-check: HNSW is active if EITHER (a) `.swarm/hnsw.index` exists with
# content (older versions wrote a sidecar file), OR (b) `ruflo memory stats`
# reports the in-DB HNSW index as active. Lazy builds keep the index inside
# memory.db and never write the sidecar file — relying on `[[ -s ]]` alone
# caused 7C to re-seed every run (the writes were no-ops via UNIQUE
# collision, but it still showed as "1 run" each time).
HNSW_INDEX=".swarm/hnsw.index"
# Tier 6.3: under --force, remove the stale on-disk sidecar before triggering
# a fresh build. Without this, `--force` would otherwise no-op when the
# sidecar's mere existence trips the skip-check below.
if [[ "$FORCE" -eq 1 && -f "$HNSW_INDEX" ]]; then
  HNSW_OLD_SIZE="$(du -h "$HNSW_INDEX" 2>/dev/null | awk '{print $1}')"
  info "7C: --force — removing stale hnsw.index (size: ${HNSW_OLD_SIZE})"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] would: rm -f $HNSW_INDEX"
  else
    rm -f "$HNSW_INDEX"
    pass "7C: stale hnsw.index removed"
  fi
fi
HNSW_OK=0
if [[ -s "$HNSW_INDEX" ]]; then HNSW_OK=1; fi
if [[ "$HNSW_OK" -eq 0 ]] && "${RUFLO_CMD[@]}" memory stats 2>/dev/null \
     | grep -qE 'HNSW Index[[:space:]]*[│|:][[:space:]]*active'; then
  HNSW_OK=1
fi
if [[ "$HNSW_OK" -eq 1 && "$FORCE" -eq 0 ]]; then
  if [[ -s "$HNSW_INDEX" ]]; then
    HNSW_SIZE="$(wc -c < "$HNSW_INDEX" 2>/dev/null || echo 0)"
    pass "7C: HNSW index present (${HNSW_SIZE} bytes)"
  else
    pass "7C: HNSW index active in-DB (memory stats)"
  fi
  ((ACT_SKIPPED++)) || true
else
  info "7C: seeding 3 entries to trigger lazy HNSW build"
  seed_ok=0
  for i in 1 2 3; do
    # Stable keys so re-runs are idempotent. A UNIQUE collision on a re-run
    # is fine — we treat existing key as success.
    if run "${RUFLO_CMD[@]}" memory store -k "init/hnsw-seed-$i" \
         -v "bootstrap seed $i" >>/tmp/ruflo-hnsw-build.log 2>&1; then
      seed_ok=$((seed_ok + 1))
    elif "${RUFLO_CMD[@]}" memory retrieve -k "init/hnsw-seed-$i" >/dev/null 2>&1; then
      # Key already exists from a prior run — count as success.
      seed_ok=$((seed_ok + 1))
    fi
  done
  if [[ "$seed_ok" -ge 1 ]]; then
    if [[ -s "$HNSW_INDEX" ]]; then
      HNSW_SIZE="$(wc -c < "$HNSW_INDEX" 2>/dev/null || echo 0)"
      pass "7C: HNSW index built ($seed_ok/3 seeds, ${HNSW_SIZE} bytes)"
    else
      warn "7C: $seed_ok/3 seeds stored but hnsw.index not yet on disk (may build on next op)"
    fi
    ((ACT_RUN++)) || true
  else
    warn "7C: HNSW seed failed (see /tmp/ruflo-hnsw-build.log) — continuing"
    ((ACT_FAILED++)) || true
  fi
fi

# Tier 6.3: post-build invariant. The HNSW index is in-DB on modern ruflo
# (rows in `vector_indexes` table). Each index row carries a `total_vectors`
# count; that count must agree with the number of vector-bearing rows in
# `memory_entries`. Drift indicates a build that aborted mid-write or an
# upstream schema bump that re-shaped vector_indexes. `sqlite3 -readonly`
# usage is load-bearing (Patch 10) — never query a live ruflo DB without it.
SWARM_DB=".swarm/memory.db"
if [[ "$DRY_RUN" -ne 1 && -f "$SWARM_DB" ]] && command -v sqlite3 >/dev/null 2>&1; then
  HNSW_ENTRIES="$(sqlite3 -readonly "$SWARM_DB" 'SELECT COUNT(*) FROM memory_entries WHERE embedding IS NOT NULL;' 2>/dev/null || echo 0)"
  HNSW_ENTRIES="${HNSW_ENTRIES:-0}"
  HNSW_TOTAL_FROM_INDEX=0
  if sqlite3 -readonly "$SWARM_DB" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='vector_indexes' LIMIT 1;" 2>/dev/null | grep -q 1; then
    HNSW_TOTAL_FROM_INDEX="$(sqlite3 -readonly "$SWARM_DB" 'SELECT COALESCE(SUM(total_vectors), 0) FROM vector_indexes;' 2>/dev/null || echo 0)"
    HNSW_TOTAL_FROM_INDEX="${HNSW_TOTAL_FROM_INDEX:-0}"
  fi
  if [[ "$HNSW_TOTAL_FROM_INDEX" -ne "$HNSW_ENTRIES" ]]; then
    # ADVISORY (not a failure): on ruflo 3.10.x the `vector_indexes.total_vectors`
    # column is NOT maintained by `embeddings index -a rebuild` — verified live:
    # rebuild reports its real vector count ("Vectors: N") but leaves this column
    # at 0. So this invariant false-positives on current ruflo. The HNSW index is
    # built and search functions; do NOT treat as drift or auto-rebuild (proven
    # not to reconcile the column). Surfaced as info only.
    info "7C: vector_indexes.total_vectors=$HNSW_TOTAL_FROM_INDEX vs memory_entries(embedding)=$HNSW_ENTRIES — advisory only (ruflo 3.10.x does not maintain this counter; HNSW search still works). Manual rebuild if desired: ruflo embeddings index -a rebuild"
  else
    pass "7C: HNSW invariant OK (index total_vectors == memory_entries WHERE embedding NOT NULL == $HNSW_ENTRIES)"
  fi
fi

# ── 7D: Neural train (SONA self-learning loop seed) ───────────────────────
# Skip-check: neural_status reports active patterns. Output varies by
# version — accept all three observed forms:
#   • "Patterns: 7"           (older / colon-prefixed)
#   • "7 patterns stored"     (current — number BEFORE noun)
#   • "active: true"          (legacy boolean)
# NOTE: `ruflo neural pretrain` does NOT exist — only `train` (verified).
NEURAL_STATUS_OUT="$( "${RUFLO_CMD[@]}" neural status 2>/dev/null || true )"
NEURAL_ACTIVE=0
if echo "$NEURAL_STATUS_OUT" | grep -qiE 'patterns?:[[:space:]]*[1-9]|[1-9][0-9]*[[:space:]]+pattern'; then NEURAL_ACTIVE=1; fi
if echo "$NEURAL_STATUS_OUT" | grep -qiE 'active:[[:space:]]*true'; then NEURAL_ACTIVE=1; fi
if [[ "$NEURAL_ACTIVE" -eq 1 && "$FORCE" -eq 0 ]]; then
  pass "7D: neural already trained / active"
  ((ACT_SKIPPED++)) || true
else
  info "7D: running: ruflo neural train -p coordination -e 50 --wasm --flash --contrastive"
  if run "${RUFLO_CMD[@]}" neural train -p coordination -e 50 --wasm --flash --contrastive \
       >/tmp/ruflo-neural-train.log 2>&1; then
    pass "7D: neural training kicked off (pattern=coordination, epochs=50)"
    ((ACT_RUN++)) || true
  else
    warn "7D: ruflo neural train failed (see /tmp/ruflo-neural-train.log) — continuing"
    ((ACT_FAILED++)) || true
  fi
fi

# ── 7E: Hooks pretrain (pattern-store priors) ─────────────────────────────
# Skip-check: hooks intelligence stats reports >0 patterns. The output is a
# box-drawing table with cells like `│ Patterns Learned │ 7 │` — the cell
# separator is U+2502 (box drawing light vertical), NOT ASCII `|`. Accept
# both so this works against current and future ruflo CLI styles.
# Default depth=shallow for fast bootstrap; --full-pretrain bumps it to medium.
HOOKS_STATS_OUT="$( "${RUFLO_CMD[@]}" hooks intelligence stats 2>/dev/null || true )"
HOOKS_HAS_PATTERNS=0
if echo "$HOOKS_STATS_OUT" | grep -qE 'Patterns Learned[[:space:]]*[│|][[:space:]]*[1-9]'; then HOOKS_HAS_PATTERNS=1; fi
if [[ "$HOOKS_HAS_PATTERNS" -eq 0 ]] && echo "$HOOKS_STATS_OUT" | grep -qiE 'patterns?:[[:space:]]*[1-9]'; then HOOKS_HAS_PATTERNS=1; fi
if [[ "$HOOKS_HAS_PATTERNS" -eq 1 && "$FORCE" -eq 0 ]]; then
  pass "7E: hooks pattern store already populated"
  ((ACT_SKIPPED++)) || true
else
  HOOKS_DEPTH="${HOOKS_PRETRAIN_DEPTH:-shallow}"
  info "7E: running: ruflo hooks pretrain -p . --depth $HOOKS_DEPTH --with-embeddings"
  if run "${RUFLO_CMD[@]}" hooks pretrain -p . --depth "$HOOKS_DEPTH" --with-embeddings \
       >/tmp/ruflo-hooks-pretrain.log 2>&1; then
    pass "7E: hooks pretrained (depth=$HOOKS_DEPTH)"
    ((ACT_RUN++)) || true
  else
    warn "7E: ruflo hooks pretrain failed (see /tmp/ruflo-hooks-pretrain.log) — continuing"
    ((ACT_FAILED++)) || true
  fi
fi

# ── 7F: Hive-mind init (collective memory backbone) ───────────────────────
HIVE_STATE=".claude-flow/hive-mind/state.json"
if [[ -f "$HIVE_STATE" && "$FORCE" -eq 0 ]]; then
  pass "7F: hive-mind already initialized"
  ((ACT_SKIPPED++)) || true
else
  info "7F: running: ruflo hive-mind init -t hierarchical-mesh -c byzantine -m 15 -p --memory-backend hybrid"
  if run "${RUFLO_CMD[@]}" hive-mind init \
       -t hierarchical-mesh -c byzantine -m 15 -p --memory-backend hybrid \
       >/tmp/ruflo-hivemind-init.log 2>&1; then
    pass "7F: hive-mind initialized"
    ((ACT_RUN++)) || true
  else
    warn "7F: ruflo hive-mind init failed (see /tmp/ruflo-hivemind-init.log) — continuing"
    ((ACT_FAILED++)) || true
  fi
fi

# ── 7G: Daemon start (background workers) ─────────────────────────────────
# MUST run last — depends on memory + embeddings + HNSW being up so workers
# don't crash-loop. With --force, stop the daemon first to re-seat workers
# against any new config.
# NOTE: `ruflo daemon status` ALWAYS exits 0 with an ASCII box — exit code
# is unreliable. Grep for the canonical "Status: ● RUNNING" line (U+25CF
# filled circle); fall back to a literal "RUNNING" match for older versions.
DAEMON_STATUS_OUT="$( "${RUFLO_CMD[@]}" daemon status 2>/dev/null || true )"
DAEMON_RUNNING=0
if echo "$DAEMON_STATUS_OUT" | grep -q $'Status: \xe2\x97\x8f RUNNING'; then DAEMON_RUNNING=1; fi
if [[ "$DAEMON_RUNNING" -eq 0 ]] && echo "$DAEMON_STATUS_OUT" | grep -qE 'Status:.*RUNNING'; then DAEMON_RUNNING=1; fi

if [[ ( "$FORCE" -eq 1 || "$REACTIVATE" -eq 1 ) && "$DAEMON_RUNNING" -eq 1 ]]; then
  if [[ "$FORCE" -eq 1 ]]; then
    info "7G: --force — stopping running daemon first"
  else
    info "7G: --reactivate — stopping running daemon first"
  fi
  run "${RUFLO_CMD[@]}" daemon stop >/tmp/ruflo-daemon-stop.log 2>&1 || true
  DAEMON_RUNNING=0
fi

if [[ "$DAEMON_RUNNING" -eq 1 ]]; then
  pass "7G: daemon already running"
  ((ACT_SKIPPED++)) || true
else
  info "7G: running: ruflo daemon start"
  if run "${RUFLO_CMD[@]}" daemon start >/tmp/ruflo-daemon-start.log 2>&1; then
    pass "7G: daemon started"
    ((ACT_RUN++)) || true
  else
    warn "7G: ruflo daemon start failed (see /tmp/ruflo-daemon-start.log) — continuing"
    ((ACT_FAILED++)) || true
  fi
fi

# Activation summary line — surfaces partial activation without failing the run.
if [[ "$ACT_FAILED" -gt 0 ]]; then
  warn "activation: $ACT_RUN run, $ACT_SKIPPED skipped, $ACT_FAILED failed of $ACT_TOTAL"
else
  pass "activation: $ACT_RUN run, $ACT_SKIPPED skipped (all $ACT_TOTAL OK)"
fi

# Roll activation counters into the global step accounting.
STEPS_RUN=$((STEPS_RUN + ACT_RUN))
STEPS_SKIPPED=$((STEPS_SKIPPED + ACT_SKIPPED))

# ── 7.5: Post-activation .mcp.json dedup ────────────────────────────────────
# fix-ruflo.sh Step 5b.1 removes a duplicate `ruflo` MCP server, but it runs at
# init Step 5 — BEFORE the Step-7 activation commands (`ruflo swarm init` / `hive-mind
# init`) which RE-register an `mcpServers.ruflo` (npx) entry into .mcp.json. So the
# dedup must run again AFTER activation. Canonical claude-flow launcher is the
# global-`ruflo` entry; remove the npx `ruflo` dup if it reappeared. (See Patch 20.2.)
if [[ "$DRY_RUN" -ne 1 && -f "$TARGET_DIR/.mcp.json" ]] && command -v jq >/dev/null 2>&1; then
  if jq -e '.mcpServers.ruflo and .mcpServers["claude-flow"]' "$TARGET_DIR/.mcp.json" >/dev/null 2>&1; then
    tmp_dd="$(mktemp)"
    if jq 'del(.mcpServers.ruflo)' "$TARGET_DIR/.mcp.json" > "$tmp_dd" \
       && python3 -c "import json; json.load(open('$tmp_dd'))" 2>/dev/null; then
      mv "$tmp_dd" "$TARGET_DIR/.mcp.json"
      pass "post-activation: removed duplicate ruflo MCP server re-added by Step-7 (kept claude-flow/global)"
    else
      rm -f "$tmp_dd"; warn "post-activation .mcp.json dedup failed — leaving untouched"
    fi
  else
    pass "post-activation: no duplicate ruflo MCP server"
  fi
fi

# ── 8/9: Seed memory.db with init marker ────────────────────────────────────
header "8/9" "Seed memory.db with init marker"

if [[ "$DRY_RUN" -eq 1 ]]; then
  info "[dry-run] would: ruflo memory store -k init -v 'initialized <date>'"
else
  # Idempotency: if the 'init' key already exists, nothing to do. ruflo's
  # SQLite-backed memory enforces a UNIQUE(namespace, key) constraint, so a
  # blind re-store on a re-run would always fail.
  if "${RUFLO_CMD[@]}" memory retrieve -k "init" >/dev/null 2>&1; then
    pass "memory already seeded (key: init exists)"
    ((STEPS_SKIPPED++)) || true
  else
    STAMP="$(date +%Y-%m-%d_%H:%M:%S)"
    # MCP can be briefly busy right after fix-ruflo.sh re-registers it. Retry
    # with exponential backoff for genuinely transient failures.
    MAX_ATTEMPTS=5
    BACKOFF=1
    seeded=0
    for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
      if "${RUFLO_CMD[@]}" memory store -k "init" \
           -v "ruflo+aqe+agentdb initialized at $STAMP" >/dev/null 2>&1; then
        if [[ "$attempt" -eq 1 ]]; then
          pass "memory seeded (key: init)"
        else
          pass "memory seeded (key: init) — succeeded on attempt $attempt/$MAX_ATTEMPTS"
        fi
        ((STEPS_RUN++)) || true
        seeded=1
        break
      fi
      # Belt-and-braces: another concurrent run may have just inserted the key
      # between our retrieve check and this store. Re-check; treat as success.
      if "${RUFLO_CMD[@]}" memory retrieve -k "init" >/dev/null 2>&1; then
        pass "memory seeded (key: init exists — inserted concurrently)"
        ((STEPS_SKIPPED++)) || true
        seeded=1
        break
      fi
      if [[ "$attempt" -lt "$MAX_ATTEMPTS" ]]; then
        info "memory seed attempt $attempt/$MAX_ATTEMPTS failed — retrying in ${BACKOFF}s"
        sleep "$BACKOFF"
        BACKOFF=$((BACKOFF * 2))  # 1s, 2s, 4s, 8s between attempts
      fi
    done
    if [[ "$seeded" -eq 0 ]]; then
      warn "memory seed failed after $MAX_ATTEMPTS attempts — MCP may be unreachable"
      warn "retry manually: ${RUFLO_CMD[*]} memory store -k init -v ok"
    fi
  fi
fi

# ── 9/9: Verification ───────────────────────────────────────────────────────
header "9/9" "Verification"

checks_ok=0
checks_total=0

check() {
  ((checks_total++)) || true
  if [[ -n "$2" ]]; then
    pass "$1"; ((checks_ok++)) || true
  else
    warn "$1 — missing"
  fi
}

check ".mcp.json"                 "$([[ -f .mcp.json ]] && echo y)"
check ".claude/settings.json"     "$([[ -f .claude/settings.json ]] && echo y)"
check ".claude/skills/"           "$([[ -d .claude/skills ]] && echo y)"
check ".claude-flow/config.yaml"  "$([[ -f .claude-flow/config.yaml ]] && echo y)"
check ".swarm/memory.db"          "$([[ -f .swarm/memory.db ]] && echo y)"
check ".agentic-qe/memory.db"     "$([[ -f .agentic-qe/memory.db ]] && echo y)"
check ".claude/skills/agentic-quality-engineering" "$([[ -d .claude/skills/agentic-quality-engineering || -f .claude/skills/agentic-quality-engineering.md ]] && echo y)"
check ".claude/helpers/statusline.cjs" "$([[ -f .claude/helpers/statusline.cjs ]] && echo y)"
check ".claude/agents (ruflo full set backfilled)" "$([[ -f .claude/agents/core/coder.md || -f .claude/agents/analysis/code-analyzer.md ]] && echo y)"

# Verify MCP server is reachable through ruflo
if "${RUFLO_CMD[@]}" mcp status >/dev/null 2>&1; then
  pass "ruflo MCP server reachable"; ((checks_ok++)) || true
else
  warn "ruflo MCP status check failed (will retry inside Claude Code)"
fi
((checks_total++)) || true

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}============================================${NC}"
echo -e " ${BOLD}Summary${NC}"
echo -e "${BOLD}============================================${NC}"
echo -e "  Steps run:     ${GREEN}$STEPS_RUN${NC}"
echo -e "  Steps skipped: ${CYAN}$STEPS_SKIPPED${NC} (already initialized)"
echo -e "  Verification:  ${GREEN}$checks_ok${NC}/$checks_total checks passed"

if [[ "$ERRORS" -gt 0 ]]; then
  echo -e "  Errors:        ${RED}$ERRORS${NC}"
  echo ""
  echo -e "  ${YELLOW}Fix the errors above and re-run.${NC}"
  exit 1
fi

echo ""
echo -e "  ${GREEN}All systems ready.${NC}"
echo ""
echo -e "  ${BOLD}Next:${NC}"
echo -e "    1. Restart Claude Code (Ctrl+C then 'claude') to pick up the new statusline."
echo -e "    2. Inside Claude Code, verify: agentdb_controllers → active: 23/23 (all controllers on)"
echo -e "    3. Run a quick check:          memory_search 'init'"
echo -e ""
echo -e "  ${BOLD}Maintenance:${NC}"
echo -e "    • bin/ruflo-kit session <target>       — run at the start of each Claude session"
echo -e "    • bin/ruflo-kit fix-ruflo <target>     — re-run after any Node/ruflo upgrade"
echo -e "    • bin/ruflo-kit fix-statusbar <target> — re-run after 'aqe init' clobbers it"
exit 0
