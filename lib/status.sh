#!/usr/bin/env bash
set -uo pipefail
# ============================================================================
# lib/status.sh — one screen of TRUTH for a ruflo + AQE target.
#
#   bin/ruflo-kit status <target>            # human dashboard
#   bin/ruflo-kit status <target> --json     # machine shape (always valid JSON)
#   bin/ruflo-kit status <target> --hints     # 4 compact lines (bare-invocation hint)
#   bin/ruflo-kit status <target> --forensics # + manual-install forensics appendix
#                                             # (STATUS-FORENSICS-V1; plain-text only —
#                                             # --json ignores --forensics, JSON unchanged)
#
# PORCELAIN, read-only. Everything reported is DISK-DERIVED — we never ask a
# live MCP/daemon "are you healthy?" (a broken server happily says yes). Sources:
# git sha for the kit, package.json for the globals, grep of the INSTALLED dist
# for the sentinels, `pgrep` (NOT state files — they lie) for the daemon,
# .mcp.json for registered servers, and sqlite3 -readonly for the learning
# stores. Exit 0 ALWAYS — status is a report, not a gate (health/verify own the
# CI exit codes). --json is built with node, so it stays valid JSON even when
# nothing is installed (every field null/empty rather than absent).
# ============================================================================

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# ── Pre-parse status-only flags, then hand the rest to kit_resolve ───────────
# kit_resolve() warns on flags it doesn't recognize, so strip ours first (same
# pattern fix-brain.sh uses for --download).
MODE="human"
FORENSICS=0
_KR_ARGS=()
for a in "$@"; do
  case "$a" in
    --json)      MODE="json" ;;
    --hints)     MODE="hints" ;;
    --forensics) FORENSICS=1 ;;
    *)           _KR_ARGS+=("$a") ;;
  esac
done
kit_resolve ${_KR_ARGS[@]+"${_KR_ARGS[@]}"}
kit_require_target

GROOT="$(npm root -g 2>/dev/null || echo '')"
EXPECT_NESTED="3.0.0-alpha.10"

# ── Kit version (mirrors bin/ruflo-kit `version`) ────────────────────────────
KIT_SHA="$(git -C "$KIT_DIR" rev-parse --short HEAD 2>/dev/null || echo '')"
KIT_DATE="$(git -C "$KIT_DIR" log -1 --format=%cd --date=short 2>/dev/null || echo '')"

# ── Global package versions (hoisted + nested agentdb shadow) ────────────────
pkg_ver() { [[ -n "$1" ]] && node -p "require('$1/package.json').version" 2>/dev/null || echo ''; }
RUFLO_V="$(pkg_ver "${GROOT:+$GROOT/ruflo}")"
AQE_V="$(pkg_ver "${GROOT:+$GROOT/agentic-qe}")"
# THREE distinct agentdb slots — do not conflate:
#   standalone: <npm-g-root>/agentdb            (Patch 49 global MCP install; pinned alpha.10)
#   hoisted:    .../ruflo/node_modules/agentdb  (upstream floor, alpha.17 on ruflo 3.32.2)
#   nested:     .../@claude-flow/memory/node_modules/agentdb (kit's alpha.10 shadow)
AGENTDB_STANDALONE="$(pkg_ver "${GROOT:+$GROOT/agentdb}")"
AGENTDB_HOISTED="$(pkg_ver "${GROOT:+$GROOT/ruflo/node_modules/agentdb}")"
# The nested agentdb under ruflo's @claude-flow/memory is pinned to alpha.10 so
# all 23 controllers activate — it is deliberately a SHADOW of a different
# (newer) hoisted global. Report both slots so a drifted pin is visible.
CF="${GROOT:+$GROOT/ruflo/node_modules/@claude-flow}"
AGENTDB_NESTED="$(pkg_ver "${GROOT:+$GROOT/ruflo/node_modules/@claude-flow/memory/node_modules/agentdb}")"

# ── ruflo dist sentinels (grep the INSTALLED dist, never the kit's own source) ─
# name<TAB>relative-path-under-@claude-flow. dist_defect_present (common.sh)
# echoes PRESENT | ABSENT | NO_FILE — reused here as a plain grep-presence probe.
_sentinel_defs='RUFLO-SEMRANK-V1	cli/dist/src/mcp-tools/hooks-tools.js
RUFLO-ROUTE-EXPLORE-V2	cli/dist/src/mcp-tools/hooks-tools.js
RUFLO-REAL-SPAWN-V1	cli/dist/src/commands/agent.js
RUFLO-LEARNING-PATH-V1	cli/dist/src/commands/hooks.js
SONA-TRAIN-V1	cli/dist/src/memory/intelligence.js'

SENTINEL_ITEMS=""
SENT_PRESENT=0
SENT_TOTAL=0
while IFS=$'\t' read -r _name _rel; do
  [[ -z "$_name" ]] && continue
  SENT_TOTAL=$((SENT_TOTAL + 1))
  _file="${CF:+$CF/$_rel}"
  _state="NO_FILE"
  [[ -n "$_file" ]] && _state="$(dist_defect_present "$_file" "$_name")"
  [[ "$_state" == "PRESENT" ]] && SENT_PRESENT=$((SENT_PRESENT + 1))
  SENTINEL_ITEMS="${SENTINEL_ITEMS}${_name}	${_state}	${_rel}"$'\n'
done <<< "$_sentinel_defs"

# HOOK-BLOCK-EXIT2-V1 lives in the project's patched hook handler (dangerous-cmd
# block must exit 2 to actually BLOCK per the Claude Code hook contract).
HOOK_HANDLER="$TARGET_DIR/.claude/helpers/hook-handler.cjs"
HOOK_BLOCK_EXIT2=0
[[ -f "$HOOK_HANDLER" ]] && grep -q "HOOK-BLOCK-EXIT2-V1" "$HOOK_HANDLER" 2>/dev/null && HOOK_BLOCK_EXIT2=1

# dream-lockfix: the atomic-claim guard is stamped into several global agentic-qe
# dist files (one per dream_cycle insert site). Count the LIVE files carrying it
# (exclude *-bak). Zero after a global aqe upgrade wipes the patch set.
DREAM_LOCKFIX_COUNT=0
if [[ -n "$GROOT" && -d "$GROOT/agentic-qe/dist" ]]; then
  DREAM_LOCKFIX_COUNT="$(grep -rl "AQE-DREAM-LOCKFIX-V2" "$GROOT/agentic-qe/dist" 2>/dev/null \
    | grep -vc -- '-bak' 2>/dev/null || echo 0)"
  DREAM_LOCKFIX_COUNT="${DREAM_LOCKFIX_COUNT//[^0-9]/}"; DREAM_LOCKFIX_COUNT="${DREAM_LOCKFIX_COUNT:-0}"
fi

# ── Daemon state via pgrep (state files lie — Patch 50) ──────────────────────
# Dual pattern (mirrors common.sh kit_daemon_ps_lines / proof P14): `ruflo daemon start`
# execs the nested @claude-flow/cli, so the surviving cmdline is `node .../bin/cli.js
# daemon start ...` — the literal 'ruflo daemon' never appears in it and that pattern
# alone missed EVERY real daemon (observed live 2026-07-20: a running workspace daemon
# reported as "stopped").
DAEMON_PIDS="$( { pgrep -f 'bin/cli.js daemon start' 2>/dev/null; pgrep -f 'ruflo daemon' 2>/dev/null; } | sort -un | tr '\n' ' ' | sed 's/ *$//')"
DAEMON_RUNNING=0
[[ -n "$DAEMON_PIDS" ]] && DAEMON_RUNNING=1

# ── MCP servers registered in .mcp.json (names only) ─────────────────────────
MCP_JSON="$TARGET_DIR/.mcp.json"
MCP_SERVERS=""
if [[ -f "$MCP_JSON" ]]; then
  MCP_SERVERS="$(node -e "try{const j=require('$MCP_JSON');process.stdout.write(Object.keys(j.mcpServers||{}).join('\n'))}catch(e){}" 2>/dev/null || echo '')"
fi

# ── ruvnet-brain KB present/missing + size ───────────────────────────────────
BRAIN_KB="${RUVNET_BRAIN_KB:-${RUVNET_BRAIN_HOME:-$HOME/.cache/ruvnet-brain}/kb}"
BRAIN_PRESENT=0
BRAIN_SIZE=""
BRAIN_VER=""
if [[ -f "$BRAIN_KB/forge-mcp-all.mjs" ]]; then
  BRAIN_PRESENT=1
  _kb="$(du -sk "$BRAIN_KB" 2>/dev/null | awk '{print $1}')"
  [[ "$_kb" =~ ^[0-9]+$ ]] && BRAIN_SIZE=$((_kb * 1024))
  # disk-only KB version (BRAIN-KB-REFRESH-V1) — no network here; freshness
  # against the released bundle is fix-brain Step 1.5's job. Prefer the kit's
  # .release-tag marker (bundle package.json can lag the release tag).
  BRAIN_VER="$(head -1 "$BRAIN_KB/.release-tag" 2>/dev/null | tr -d '[:space:]')"
  BRAIN_VER="${BRAIN_VER#v}"
  [[ -z "$BRAIN_VER" ]] && BRAIN_VER="$(node -p "require('$BRAIN_KB/package.json').version" 2>/dev/null || echo '')"
fi

# ── Learning stores (KIT-SQLITE-SHIM-V1: sqlite3 CLI first, else the global
# ruflo's better-sqlite3 via node — counts appear either way; only a host with
# NEITHER instrument reads n/a) ──────────────────────────────────────────────
SQLITE_BACKEND="$(kit_sqlite_backend)"   # cli | node | none
SQLITE_OK=0
[[ "$SQLITE_BACKEND" != "none" ]] && SQLITE_OK=1
# count <db> <table> -> integer, or '' when no backend / db missing / no table
lstore_count() {
  local db="$1" tbl="$2"
  [[ "$SQLITE_OK" -eq 1 && -f "$db" ]] || { echo ''; return; }
  kit_sqlite_ro "$db" \
    "SELECT COUNT(*) FROM $tbl;" 2>/dev/null | grep -E '^[0-9]+$' | head -1
}
ADB="$TARGET_DIR/agentdb.db"
AQE_DB="$TARGET_DIR/.agentic-qe/memory.db"
L_EPISODES="$(lstore_count "$ADB" episodes)"
L_SKILLS="$(lstore_count "$ADB" skills)"
L_EXPERIENCES="$(lstore_count "$AQE_DB" captured_experiences)"
L_PATTERNS="$(lstore_count "$AQE_DB" qe_patterns)"
# INFLOW-LIVENESS-V1 (Patch 67): structural check that a capture hook is wired,
# so a frozen pool ("--force re-init clobbered the hooks") is visible in status.
CAPTURE_WIRED=0
kit_aqe_capture_wired "$TARGET_DIR" && CAPTURE_WIRED=1

# ── Config: daemon auto-start mode + last health snapshot ────────────────────
DAEMON_AUTOSTART="${RUFLO_DAEMON_MODE:-off}"
HEALTH_FILE="$TARGET_DIR/.claude-flow/data/health-last.json"
HEALTH_PRESENT=0
HEALTH_ISO=""
if [[ -f "$HEALTH_FILE" ]]; then
  HEALTH_PRESENT=1
  HEALTH_ISO="$(node -e "try{process.stdout.write(String(require('$HEALTH_FILE').iso||''))}catch(e){}" 2>/dev/null || echo '')"
fi

# ── JSON assembly (node — valid even when everything is null) ─────────────────
build_json() {
  KIT_SHA="$KIT_SHA" KIT_DATE="$KIT_DATE" KIT_DIR="$KIT_DIR" \
  RUFLO_V="$RUFLO_V" AQE_V="$AQE_V" \
  AGENTDB_HOISTED="$AGENTDB_HOISTED" AGENTDB_NESTED="$AGENTDB_NESTED" EXPECT_NESTED="$EXPECT_NESTED" \
  AGENTDB_STANDALONE="$AGENTDB_STANDALONE" \
  SENTINEL_ITEMS="$SENTINEL_ITEMS" HOOK_BLOCK_EXIT2="$HOOK_BLOCK_EXIT2" DREAM_LOCKFIX_COUNT="$DREAM_LOCKFIX_COUNT" \
  DAEMON_RUNNING="$DAEMON_RUNNING" DAEMON_PIDS="$DAEMON_PIDS" \
  MCP_SERVERS="$MCP_SERVERS" BRAIN_PRESENT="$BRAIN_PRESENT" BRAIN_SIZE="$BRAIN_SIZE" BRAIN_VER="$BRAIN_VER" \
  L_EPISODES="$L_EPISODES" L_SKILLS="$L_SKILLS" L_EXPERIENCES="$L_EXPERIENCES" L_PATTERNS="$L_PATTERNS" SQLITE_OK="$SQLITE_OK" SQLITE_BACKEND="$SQLITE_BACKEND" \
  CAPTURE_WIRED="$CAPTURE_WIRED" \
  DAEMON_AUTOSTART="$DAEMON_AUTOSTART" HEALTH_PRESENT="$HEALTH_PRESENT" HEALTH_ISO="$HEALTH_ISO" \
  node -e '
    const e = process.env;
    const str = (v) => (v === undefined || v === "" ? null : v);
    const num = (v) => (v === undefined || v === "" ? null : Number(v));
    const bool = (v) => v === "1" || v === "true";
    const lines = (v) => (v ? v.split("\n").filter(Boolean) : []);
    const items = lines(e.SENTINEL_ITEMS).map((l) => {
      const [name, state, file] = l.split("\t");
      return { name, present: state === "PRESENT", state, file };
    });
    const hoisted = str(e.AGENTDB_HOISTED), nested = str(e.AGENTDB_NESTED), expect = str(e.EXPECT_NESTED);
    const standalone = str(e.AGENTDB_STANDALONE);
    const out = {
      kit: { version: str(e.KIT_SHA), date: str(e.KIT_DATE), dir: str(e.KIT_DIR) },
      globals: {
        ruflo: str(e.RUFLO_V),
        aqe: str(e.AQE_V),
        agentdb: {
          standalone, hoisted, nested, nestedExpected: expect,
          nestedPinned: nested !== null && nested === expect,
          shadow: hoisted !== null && nested !== null && hoisted !== nested,
        },
      },
      sentinels: {
        present: items.filter((i) => i.present).length,
        total: items.length,
        items,
        hookBlockExit2: bool(e.HOOK_BLOCK_EXIT2),
        dreamLockfix: num(e.DREAM_LOCKFIX_COUNT),
      },
      daemon: {
        running: bool(e.DAEMON_RUNNING),
        pids: (e.DAEMON_PIDS ? e.DAEMON_PIDS.trim().split(/\s+/).filter(Boolean).map(Number) : []),
      },
      mcp: {
        servers: lines(e.MCP_SERVERS),
        brainKb: { present: bool(e.BRAIN_PRESENT), sizeBytes: num(e.BRAIN_SIZE), kbVersion: str(e.BRAIN_VER) || null },
      },
      learning: {
        episodes: num(e.L_EPISODES),
        skills: num(e.L_SKILLS),
        experiences: num(e.L_EXPERIENCES),
        patterns: num(e.L_PATTERNS),
        captureInflowWired: bool(e.CAPTURE_WIRED),
        sqlite: bool(e.SQLITE_OK),
        sqliteBackend: str(e.SQLITE_BACKEND),
      },
      config: {
        daemonAutoStart: str(e.DAEMON_AUTOSTART),
        lastHealth: e.HEALTH_PRESENT === "1" ? { iso: str(e.HEALTH_ISO) } : null,
      },
    };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  '
}

# ── Small display helpers ────────────────────────────────────────────────────
_or_na() { [[ -n "$1" ]] && echo "$1" || echo "n/a"; }
_yesno() { [[ "$1" -eq 1 ]] && echo yes || echo no; }
_human_bytes() {
  local b="${1:-}"
  [[ "$b" =~ ^[0-9]+$ ]] || { echo "n/a"; return; }
  if   [[ "$b" -ge 1073741824 ]]; then awk -v b="$b" 'BEGIN{printf "%.1fG", b/1073741824}'
  elif [[ "$b" -ge 1048576   ]]; then awk -v b="$b" 'BEGIN{printf "%.1fM", b/1048576}'
  elif [[ "$b" -ge 1024      ]]; then awk -v b="$b" 'BEGIN{printf "%.0fK", b/1024}'
  else echo "${b}B"; fi
}

# ── --hints: 4 compact lines for the bare `bin/ruflo-kit` invocation ─────────
if [[ "$MODE" == "hints" ]]; then
  echo "  versions:  ruflo $(_or_na "$RUFLO_V") · aqe $(_or_na "$AQE_V") · agentdb hoisted $(_or_na "$AGENTDB_HOISTED") / nested $(_or_na "$AGENTDB_NESTED")"
  if [[ "$DAEMON_RUNNING" -eq 1 ]]; then
    echo "  daemon:    running (pid ${DAEMON_PIDS// /, }) · autostart=$DAEMON_AUTOSTART"
  else
    echo "  daemon:    stopped (cost-safe) · autostart=$DAEMON_AUTOSTART"
  fi
  echo "  sentinels: $SENT_PRESENT/$SENT_TOTAL ruflo dist · exit2 $(_yesno "$HOOK_BLOCK_EXIT2") · dream-lockfix $DREAM_LOCKFIX_COUNT"
  if [[ "$SQLITE_OK" -eq 1 ]]; then
    _fb=""; [[ "$SQLITE_BACKEND" == "node" ]] && _fb=" (node fallback)"
    echo "  learning:  episodes $(_or_na "$L_EPISODES") · skills $(_or_na "$L_SKILLS") · experiences $(_or_na "$L_EXPERIENCES") · patterns $(_or_na "$L_PATTERNS")${_fb}"
  else
    echo "  learning:  n/a (no sqlite backend: sqlite3 CLI and global better-sqlite3 both unavailable)"
  fi
  exit 0
fi

# ── --json: machine shape ────────────────────────────────────────────────────
if [[ "$MODE" == "json" ]]; then
  # STATUS-FORENSICS-V1 contract: forensics is plain-text only. --json wins and
  # the JSON shape is UNCHANGED (consumers parse stdout); note goes to stderr.
  [[ "$FORENSICS" -eq 1 ]] && \
    echo "note: --forensics is plain-text only — ignored in --json mode (STATUS-FORENSICS-V1)" >&2
  build_json
  exit 0
fi

# ── Human dashboard ──────────────────────────────────────────────────────────
echo "============================================"
echo " ruflo-kit status"
echo " kit:    $KIT_DIR ($(_or_na "$KIT_SHA")${KIT_DATE:+, $KIT_DATE})"
echo " target: $TARGET_DIR"
echo "============================================"

header "globals" "installed packages (disk-derived)"
pass "ruflo $(_or_na "$RUFLO_V")"
pass "agentic-qe $(_or_na "$AQE_V")"
if [[ -n "$AGENTDB_NESTED" && "$AGENTDB_NESTED" != "$EXPECT_NESTED" ]]; then
  warn "agentdb hoisted $(_or_na "$AGENTDB_HOISTED") · nested $(_or_na "$AGENTDB_NESTED") (expected $EXPECT_NESTED — pin drifted; run fix-ruflo)"
elif [[ -n "$AGENTDB_NESTED" ]]; then
  pass "agentdb hoisted $(_or_na "$AGENTDB_HOISTED") · nested $AGENTDB_NESTED (alpha.10 shadow pinned → 23 controllers) · standalone $(_or_na "$AGENTDB_STANDALONE")"
else
  info "agentdb hoisted $(_or_na "$AGENTDB_HOISTED") · nested n/a"
fi

header "sentinels" "kit patches in the INSTALLED dist ($SENT_PRESENT/$SENT_TOTAL present)"
while IFS=$'\t' read -r _name _state _rel; do
  [[ -z "$_name" ]] && continue
  case "$_state" in
    PRESENT) pass "$_name" ;;
    ABSENT)  warn "$_name absent in dist — re-run fix-ruflo (upgrade may have wiped it)" ;;
    NO_FILE) info "$_name — dist file not found (${_rel})" ;;
  esac
done <<< "$SENTINEL_ITEMS"
[[ "$HOOK_BLOCK_EXIT2" -eq 1 ]] && pass "HOOK-BLOCK-EXIT2-V1 (dangerous-cmd block exits 2)" \
  || warn "HOOK-BLOCK-EXIT2-V1 absent — pre-bash block may not actually block (run fix-aqe)"
if [[ "$DREAM_LOCKFIX_COUNT" -gt 0 ]]; then
  pass "AQE-DREAM-LOCKFIX-V2 in $DREAM_LOCKFIX_COUNT global aqe dist file(s)"
else
  info "AQE-DREAM-LOCKFIX-V2 not found in global aqe dist (0 files — run fix-aqe if aqe installed)"
fi

header "daemon" "process truth (pgrep, not state files)"
if [[ "$DAEMON_RUNNING" -eq 1 ]]; then
  warn "running (pid ${DAEMON_PIDS// /, }) — BILLED; stop with: ruflo daemon stop"
else
  pass "stopped (cost-safe default)"
fi
info "auto-start mode: RUFLO_DAEMON_MODE=$DAEMON_AUTOSTART"

header "mcp" "servers registered in .mcp.json + brain KB"
if [[ -n "$MCP_SERVERS" ]]; then
  pass "servers: $(echo "$MCP_SERVERS" | tr '\n' ' ')"
else
  info "no .mcp.json servers (or file absent)"
fi
if [[ "$BRAIN_PRESENT" -eq 1 ]]; then
  pass "ruvnet-brain KB present (${BRAIN_VER:+v$BRAIN_VER · }$(_human_bytes "$BRAIN_SIZE")) at $BRAIN_KB"
else
  info "ruvnet-brain KB not installed (optional: bin/ruflo-kit fix-brain $TARGET_DIR --download)"
fi

header "learning" "structured stores (read-only via kit_sqlite_ro)"
if [[ "$SQLITE_OK" -eq 1 ]]; then
  pass "agentdb.db: episodes $(_or_na "$L_EPISODES") · skills $(_or_na "$L_SKILLS")"
  pass ".agentic-qe/memory.db: experiences $(_or_na "$L_EXPERIENCES") · patterns $(_or_na "$L_PATTERNS")"
  if [[ "$CAPTURE_WIRED" -eq 1 ]]; then
    pass "capture inflow wired (aqe post-edit/post-task hooks present in .claude/settings.json)"
  elif [[ "${L_EXPERIENCES:-0}" =~ ^[0-9]+$ && "${L_EXPERIENCES:-0}" -gt 0 ]]; then
    warn "capture arm UNWIRED — $L_EXPERIENCES experience(s) exist but no aqe capture hook in .claude/settings.json: the pool is FROZEN (INFLOW-LIVENESS-V1). Restore the stock aqe hooks, then: ruflo-kit fix-aqe $TARGET_DIR"
  fi
  [[ "$SQLITE_BACKEND" == "node" ]] && info "counts via node better-sqlite3 fallback (sqlite3 CLI not installed)"
else
  info "no sqlite backend (sqlite3 CLI and global better-sqlite3 both unavailable) — learning store counts n/a"
fi

header "config" "operational settings"
if [[ "$HEALTH_PRESENT" -eq 1 ]]; then
  info "last health snapshot: $(_or_na "$HEALTH_ISO") (.claude-flow/data/health-last.json)"
else
  info "no health snapshot yet (run: bin/ruflo-kit health $TARGET_DIR)"
fi

echo ""
echo "  Full JSON:  bin/ruflo-kit status $TARGET_DIR --json"
echo "  Converge:   bin/ruflo-kit sync   $TARGET_DIR"
echo ""

# ════════════════════════════════════════════════════════════════════════════
# STATUS-FORENSICS-V1 — read-only manual-install forensics appendix.
#
# Appended AFTER the normal status output when --forensics is passed (human
# mode only; --json ignores it — see above; --hints ignores it silently).
# ZERO writes anywhere: shell history is only grepped, target files are only
# stat'ed, npx caches are only listed (cleanup stays fix-ruflo Step 7's job).
# ════════════════════════════════════════════════════════════════════════════
if [[ "$FORENSICS" -eq 1 ]]; then
  echo "============================================"
  echo " forensics — manual-install evidence (STATUS-FORENSICS-V1, read-only)"
  echo "============================================"

  # Portable mtime (Linux stat -c, macOS/BSD stat -f) — display only.
  _f_mtime() {
    local m
    m="$(stat -c '%y' "$1" 2>/dev/null | cut -d'.' -f1)"
    [[ -z "$m" ]] && m="$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$1" 2>/dev/null)"
    echo "${m:-unknown}"
  }

  # ── 1. Shell history scan ──────────────────────────────────────────────────
  header "history" "manual-install fingerprints in shell history (grep-only)"
  _HIST_RAW=""
  _HIST_SEEN=0
  for _hf in "$HOME/.bash_history" "$HOME/.zsh_history"; do
    if [[ -f "$_hf" && -r "$_hf" ]]; then
      _HIST_SEEN=1
      _HIST_RAW="${_HIST_RAW}$(cat "$_hf" 2>/dev/null)"$'\n'
    elif [[ -e "$_hf" ]]; then
      warn "$(basename "$_hf") exists but is not readable — skipped"
    fi
  done

  # Grep the combined history for one category. zsh EXTENDED_HISTORY lines
  # (': <ts>:<elapsed>;cmd') are stripped to the bare command first.
  # Dedup (first occurrence kept), then last 20 survivors per category.
  _hist_scan() {  # $1=ERE  $2=optional exclude-ERE
    local pat="$1" ex="${2:-}" m
    m="$(printf '%s\n' "$_HIST_RAW" \
      | sed -E 's/^: [0-9]+:[0-9]+;//' \
      | grep -E -e "$pat" 2>/dev/null || true)"
    if [[ -n "$ex" ]]; then
      m="$(printf '%s\n' "$m" | grep -Ev -e "$ex" 2>/dev/null || true)"
    fi
    printf '%s\n' "$m" | awk 'NF && !seen[$0]++' | tail -n 20
  }

  _FOUND_ANY=0
  _forensic_cat() {  # $1=name  $2=why-it-matters  $3=ERE  [$4=exclude-ERE]
    local name="$1" why="$2" pat="$3" ex="${4:-}" m n
    m="$(_hist_scan "$pat" "$ex")"
    [[ -z "$m" ]] && return 0
    n="$(printf '%s\n' "$m" | grep -c . 2>/dev/null || echo 0)"
    warn "[$name] $n command(s) — $why"
    while IFS= read -r _l; do
      [[ -z "$_l" ]] && continue
      echo "      \$ $_l"
    done <<< "$m"
    _FOUND_ANY=1
  }

  if [[ "$_HIST_SEEN" -eq 0 ]]; then
    info "no readable shell history (~/.bash_history, ~/.zsh_history) — history scan skipped"
  else
    _forensic_cat "mcp-add-npx" \
      "npx MCP registration reverts the AgentDB alpha.10 pin — npx reconciles its cache on every call; .mcp.json must launch the GLOBAL 'ruflo' binary" \
      'claude mcp add.*npx'
    _forensic_cat "npx-stack-invoke" \
      "npx runs a CACHE copy of the stack — kit dist patches (sentinels) never apply there" \
      'npx .*(ruflo|claude-flow|agentic-qe)' 'claude mcp add'
    _forensic_cat "ruflo-init-force" \
      "'ruflo init --force' CLOBBERS CLAUDE.md/settings — check CLAUDE.md.pre-ruflo* evidence below; the kit's adopt path never uses --force" \
      'ruflo init.*--force'
    _forensic_cat "ruflo-init" \
      "manual 'ruflo init' bypasses the kit's merge-safe setup — run 'ruflo-kit sync' to reconcile" \
      'ruflo init' '--force'
    _forensic_cat "aqe-init" \
      "aqe init <3.12.1 stripped foreign hooks + statusline — verify hooks survived (sentinels section above)" \
      'aqe init'
    _forensic_cat "daemon-ctl" \
      "the daemon spawns BILLED 'claude --print' calls 24/7 — whoever starts it owns stopping it; trust the pgrep daemon section above, never state files" \
      'ruflo daemon (start|stop)'
    _forensic_cat "ruflo-doctor" \
      "'ruflo doctor --fix' has resurrected the gated daemon (pre-Patch 60 channels) — cross-check daemon truth above" \
      'ruflo doctor'
    _forensic_cat "npm-global-install" \
      "a manual global (re)install/upgrade WIPES kit dist patches — re-run 'ruflo-kit sync <target>' after any bump" \
      'npm i(nstall)? -g (ruflo|agentic-qe|agentdb)'
    [[ "$_FOUND_ANY" -eq 0 ]] && pass "no manual-install fingerprints found in shell history"
  fi

  # ── 2. Target-side evidence ────────────────────────────────────────────────
  header "target-evidence" "on-disk traces in $TARGET_DIR (stat-only)"
  _DSTATE="$TARGET_DIR/.claude-flow/daemon-state.json"
  _DPID="$TARGET_DIR/.claude-flow/daemon.pid"
  if [[ -e "$_DSTATE" ]]; then
    warn "daemon-state.json present (mtime $(_f_mtime "$_DSTATE")) — state files LIE; live truth is the pgrep daemon section above"
  else
    pass "no .claude-flow/daemon-state.json"
  fi
  if [[ -e "$_DPID" ]]; then
    warn "daemon.pid present (mtime $(_f_mtime "$_DPID")) — a past daemon ran (or still runs — see pgrep above)"
  else
    pass "no .claude-flow/daemon.pid"
  fi
  _PRE_FOUND=0
  for _pf in "$TARGET_DIR"/CLAUDE.md.pre-ruflo*; do
    [[ -e "$_pf" ]] || continue
    _PRE_FOUND=1
    warn "$(basename "$_pf") (mtime $(_f_mtime "$_pf")) — leftover backup from a 'ruflo init' that overwrote CLAUDE.md"
  done
  [[ "$_PRE_FOUND" -eq 0 ]] && pass "no CLAUDE.md.pre-ruflo* leftovers"

  # ── 3. Stale npx caches (listed the way fix-ruflo Step 7 finds them —
  #      depth-1 dirs under ~/.npm/_npx — but NEVER removed here) ─────────────
  header "npx-caches" "~/.npm/_npx entries mentioning the stack (list-only)"
  _NPX_HITS=0
  if [[ -d "$HOME/.npm/_npx" ]]; then
    while IFS= read -r _nd; do
      [[ -z "$_nd" ]] && continue
      for _np in claude-flow ruflo agentic-qe; do
        if [[ -d "$_nd/node_modules/$_np" ]]; then
          _nv="$(node -e "try{console.log(require('$_nd/node_modules/$_np/package.json').version)}catch{console.log('?')}" 2>/dev/null)"
          warn "npx cache: $_np@${_nv:-?} at $_nd — cache copies drift from the patched global (fix-ruflo Step 7 cleans stale ones)"
          _NPX_HITS=$((_NPX_HITS + 1))
        fi
      done
      if [[ -d "$_nd/node_modules/@claude-flow" ]]; then
        warn "npx cache: @claude-flow/* at $_nd — cache copies drift from the patched global (fix-ruflo Step 7 cleans stale ones)"
        _NPX_HITS=$((_NPX_HITS + 1))
      fi
    done < <(find "$HOME/.npm/_npx" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)
  fi
  [[ "$_NPX_HITS" -eq 0 ]] && pass "no npx caches mentioning claude-flow/ruflo/agentic-qe"

  echo ""
  echo "  Forensics is READ-ONLY: nothing was modified. Cleanup lives in:"
  echo "    bin/ruflo-kit fix-ruflo $TARGET_DIR   (npx caches, ghost state)"
  echo "    bin/ruflo-kit sync      $TARGET_DIR   (full heal cascade)"
  echo ""
fi
exit 0
