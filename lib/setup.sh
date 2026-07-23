#!/usr/bin/env bash
set -uo pipefail
# Note: -e intentionally omitted — stages record ok/warn/fail through the
# summary arrays, not the shell's exit-on-error, and probe helpers signal via
# tokens/return codes the stages interpret themselves.
# ============================================================================
# lib/setup.sh — SETUP-V1. Fresh machine → PROVED working stack, one verb.
#
#   bin/ruflo-kit setup <target>                    # install + init + heal + proof
#   bin/ruflo-kit setup <target> --with-brain-kb    # also fetch the ruvnet-brain KB
#   bin/ruflo-kit setup <target> --refresh-brain-kb # fetch + refresh a stale KB
#   bin/ruflo-kit setup <target> --skip-install     # assume globals already present
#   bin/ruflo-kit setup <target> --json             # pass --json through to proof
#   bin/ruflo-kit setup <target> --dry-run          # show the plan; change nothing
#
# Stages: S1 prereqs → S2 global installs → S3 init → S4 heal (sync) →
#         S5 brain KB (opt-in) → S6 daemon policy (no action, ever) →
#         S7 proof x2. setup's exit code == proof's exit code (0 only on PROVED).
#
# IDEMPOTENCY CONTRACT: a second run on a healthy machine is S1 pass, S2 all
# "present" (no install call), S3/S4 zero changes, S5 skipped (or KB current),
# S6 no action, S7 PROVED — and writes nothing new.
#
# DAEMON: setup NEVER starts or stops the ruflo daemon. It is OPT-IN and OFF by
# design (billed 24/7 if started — Patch 50; gates RUFLO_DAEMON_MODE +
# daemonAutoStart:false). S6 only REPORTS a pre-existing daemon.
# ============================================================================

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# ── Pre-parse setup-only flags, then hand the rest to kit_resolve ────────────
# kit_resolve() warns on flags it doesn't know, so strip ours first (fix-brain
# idiom). --dry-run is left for kit_resolve to parse into DRY_RUN.
WITH_BRAIN_KB=0; REFRESH_BRAIN_KB=0; SKIP_INSTALL=0; JSON=0
_KR_ARGS=()
for _a in "$@"; do
  case "$_a" in
    --with-brain-kb)    WITH_BRAIN_KB=1 ;;
    --refresh-brain-kb) REFRESH_BRAIN_KB=1; WITH_BRAIN_KB=1 ;;
    --skip-install)     SKIP_INSTALL=1 ;;
    --json)             JSON=1 ;;
    *)                  _KR_ARGS+=("$_a") ;;
  esac
done
kit_resolve ${_KR_ARGS[@]+"${_KR_ARGS[@]}"}

_dryflag=()
[[ "$DRY_RUN" -eq 1 ]] && _dryflag=(--dry-run)
# Display suffixes — must be EMPTY when dry-run is off. (A ":+"-style parameter
# expansion on DRY_RUN expands for "0" too, which made live summaries claim
# "(dry-run — no changes made)"; hence the explicit -eq 1 test.)
_DRY_SFX=""; _DRY_TAG=""
[[ "$DRY_RUN" -eq 1 ]] && { _DRY_SFX=" (dry-run — no changes made)"; _DRY_TAG=" (dry-run)"; }

echo "============================================"
echo " ruflo-kit setup"
echo " kit:    $KIT_DIR"
echo " target: $TARGET_DIR"
[[ "$DRY_RUN" -eq 1 ]] && echo " MODE:   dry-run (no changes)"
echo "============================================"

# Parallel arrays (bash 3.2 has no assoc arrays): name | result | detail.
STAGE_NAME=(); STAGE_RESULT=(); STAGE_DETAIL=()
record_stage() { STAGE_NAME+=("$1"); STAGE_RESULT+=("$2"); STAGE_DETAIL+=("$3"); }

print_summary() {
  echo ""
  echo "============================================"
  echo " setup summary${_DRY_SFX}"
  echo "============================================"
  printf "  %-8s %-8s %s\n" "STAGE" "RESULT" "DETAIL"
  local i
  for i in "${!STAGE_NAME[@]}"; do
    local col
    case "${STAGE_RESULT[$i]}" in
      ok)   col="$GREEN" ;;
      warn) col="$YELLOW" ;;
      fail) col="$RED" ;;
      *)    col="$CYAN" ;;
    esac
    printf "  %-8s ${col}%-8s${NC} %s\n" "${STAGE_NAME[$i]}" "${STAGE_RESULT[$i]}" "${STAGE_DETAIL[$i]}"
  done
  echo ""
}

# ── S1: prerequisites (read-only) ────────────────────────────────────────────
header "S1" "prerequisites (read-only)"
S1_FAIL=0
for _t in node npm git sqlite3 unzip; do
  if command -v "$_t" >/dev/null 2>&1; then
    pass "$_t present"
  else
    warn "$_t NOT found"
    [[ "$_t" == "node" || "$_t" == "npm" ]] && S1_FAIL=1
  fi
done
if command -v jq >/dev/null 2>&1; then info "jq present (optional)"; else info "jq not found (optional)"; fi

NODE_VER="$(node --version 2>/dev/null | sed 's/^v//' | tr -d '[:space:]')"
NODE_MAJOR="${NODE_VER%%.*}"
if [[ "$NODE_MAJOR" =~ ^[0-9]+$ && "$NODE_MAJOR" -ge 18 ]]; then
  pass "node $NODE_VER (major >= 18)"
elif [[ -n "$NODE_VER" ]]; then
  warn "node $NODE_VER (major < 18 — ruflo/aqe expect Node >= 18)"
fi

NPM_VER="$(npm --version 2>/dev/null | tr -d '[:space:]')"
info "npm ${NPM_VER:-not found}"
if npm_wants_allow_scripts; then
  info "curated --allow-scripts will be used for native builds (npm >= 11.17)"
else
  info "install-scripts flag not required for this npm"
fi

if [[ "$(uname -s 2>/dev/null)" == "Darwin" ]]; then
  if xcode-select -p >/dev/null 2>&1; then
    pass "xcode command-line tools present"
  else
    warn "xcode-select -p failed — native builds may fail (run: xcode-select --install)"
  fi
fi

if [[ "$S1_FAIL" -eq 1 ]]; then
  fail "node and npm are REQUIRED — nothing else can work. Aborting."
  record_stage "S1" fail "node/npm missing"
  print_summary
  exit 1
fi
record_stage "S1" ok "prereqs satisfied"

# ── S2: global installs (probe-first, idempotent) ────────────────────────────
header "S2" "global installs${SKIP_INSTALL:+ (skipped: --skip-install)}"
if [[ "$SKIP_INSTALL" -eq 1 ]]; then
  info "--skip-install: assuming ruflo / agentic-qe / agentdb are already global"
  record_stage "S2" skip "--skip-install"
else
  if command -v ruflo >/dev/null 2>&1; then
    pass "ruflo present"
  else
    info "ruflo absent — installing ruflo@latest"
    if kit_npm_global_install "ruflo@latest"; then pass "ruflo installed"; else warn "ruflo install did not complete (see ${KIT_NPM_LOG:-/tmp/ruflo-kit-npm-global.log})"; fi
  fi

  if command -v aqe >/dev/null 2>&1; then
    pass "agentic-qe present"
  else
    info "aqe absent — installing agentic-qe@latest"
    if kit_npm_global_install "agentic-qe@latest"; then pass "agentic-qe installed"; else warn "agentic-qe install did not complete"; fi
  fi

  if command -v agentdb >/dev/null 2>&1 && global_bsqlite_loads; then
    pass "agentdb present + better-sqlite3 loads"
  else
    info "agentdb/better-sqlite3 not ready — installing agentdb@$KIT_AGENTDB_PIN + better-sqlite3"
    if kit_npm_global_install "agentdb@$KIT_AGENTDB_PIN" "better-sqlite3@^11.8.1"; then pass "agentdb + better-sqlite3 installed"; else warn "agentdb install did not complete"; fi
  fi
  record_stage "S2" ok "globals ensured"
fi

# ── S3: init (idempotent bootstrap; init.sh self-no-ops when already set up) ──
header "S3" "init${_DRY_TAG}"
if bash "$KIT_LIB/init.sh" "$TARGET_DIR" ${_dryflag[@]+"${_dryflag[@]}"}; then
  pass "init complete"
  record_stage "S3" ok ""
else
  warn "init returned nonzero (non-fatal — heal will re-converge)"
  record_stage "S3" warn "exit nonzero"
fi

# ── S4: heal (the sync fix cascade; nonzero == hard stage failure) ───────────
header "S4" "heal (sync cascade)${_DRY_TAG}"
if bash "$KIT_LIB/sync.sh" "$TARGET_DIR" ${_dryflag[@]+"${_dryflag[@]}"}; then
  pass "sync complete"
  record_stage "S4" ok ""
else
  fail "sync hard-failed"
  record_stage "S4" fail "exit nonzero"
fi

# ── S5: brain KB (opt-in; a GB-class download must be explicit) ──────────────
header "S5" "brain KB${WITH_BRAIN_KB:+ (--with-brain-kb)}"
if [[ "$WITH_BRAIN_KB" -eq 1 ]]; then
  _bf=(--download)
  [[ "$REFRESH_BRAIN_KB" -eq 1 ]] && _bf+=(--refresh)
  if bash "$KIT_LIB/fix-brain.sh" "$TARGET_DIR" "${_bf[@]}" ${_dryflag[@]+"${_dryflag[@]}"}; then
    pass "fix-brain complete (${_bf[*]})"
    record_stage "S5" ok "${_bf[*]}"
  else
    warn "fix-brain returned nonzero"
    record_stage "S5" warn "exit nonzero"
  fi
else
  info "brain KB skipped — pass --with-brain-kb to fetch the ~736MB ruvnet-brain KB (fix-brain --download)"
  record_stage "S5" skip "no --with-brain-kb"
fi

# ── S6: daemon policy — NO action, ever ──────────────────────────────────────
header "S6" "daemon policy (no action)"
info "the ruflo daemon is OPT-IN and OFF by design — billed 24/7 if started (Patch 50)"
info "gates: RUFLO_DAEMON_MODE + .agentic-qe/config.yaml daemonAutoStart:false"
info "setup NEVER starts or stops the daemon"
# Detect via the shared dual-pattern helper (common.sh kit_daemon_ps_lines) — the
# real daemon cmdline is `node .../bin/cli.js daemon start`, which 'ruflo daemon'
# alone never matches (2026-07-20 blindspot). NB: not `if pgrep|grep -q` — under
# this script's pipefail, grep -q's early exit SIGPIPEs the second pgrep and a
# FOUND daemon reads as none (observed live 2026-07-23: S6 said "no daemon" while
# the same run's staleness audit and proof P14 both saw 2).
if [[ -n "$(kit_daemon_ps_lines)" ]]; then
  warn "a ruflo daemon is RUNNING (pre-existing — not started by setup); stop with: ruflo daemon stop"
  record_stage "S6" warn "daemon pre-existing"
else
  pass "no daemon running (cost-safe)"
  record_stage "S6" ok "no action"
fi

# ── S7: proof x2 — setup's exit code == proof's exit code ────────────────────
header "S7" "proof (x2 disk-evidence)"
if [[ "$DRY_RUN" -eq 1 ]]; then
  info "[dry-run] skipping proof x2 (would run: bash $KIT_LIB/proof.sh $TARGET_DIR)"
  record_stage "S7" skip "dry-run"
  PROOF_RC=0
else
  _pf=()
  [[ "$JSON" -eq 1 ]] && _pf+=(--json)
  bash "$KIT_LIB/proof.sh" "$TARGET_DIR" ${_pf[@]+"${_pf[@]}"}
  PROOF_RC=$?
  if [[ "$PROOF_RC" -eq 0 ]]; then
    pass "proof PROVED"
    record_stage "S7" ok "PROVED"
  else
    fail "proof did not PROVE (exit $PROOF_RC)"
    record_stage "S7" fail "exit $PROOF_RC"
  fi
fi

print_summary
exit "$PROOF_RC"
