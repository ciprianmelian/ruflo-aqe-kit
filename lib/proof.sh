#!/usr/bin/env bash
set -uo pipefail
# Note: -e intentionally omitted — probes signal PASS/WARN/FAIL through recorded
# verdicts, not exit codes, and ((n++)) returns 1 when n=0 under set -e.
# ============================================================================
# lib/proof.sh — PROOF-V1. Prove the ruflo + AQE stack actually works, twice.
#
#   bin/ruflo-kit proof <target>              # 15 probes, run TWICE (x2), verdict
#   bin/ruflo-kit proof <target> --single     # 15 probes, ONE pass
#   bin/ruflo-kit proof <target> --json       # machine shape
#   bin/ruflo-kit proof <target> --dry-run    # list what would run, exit 0
#
# EVERY assertion is DISK-DERIVED or REAL command output — never an MCP/daemon
# self-report (a broken server happily says "healthy"). Fifteen probes:
#   P1  ruflo-cli       ruflo --version exits 0 + prints a semver
#   P2  ruflo-mcp       ruflo mcp start answers one JSON-RPC initialize
#   P3  aqe             aqe --version + aqe-mcp handshake (.mcp.json command)
#   P4  agentdb-slots   3-slot layout: standalone/nested = PIN, hoisted = HOISTED
#   P5  controllers     nested agentdb require()s + exposes >= 23 classes
#   P6  bsqlite         better-sqlite3 loads from agentdb's context
#   P7  brain           ruvnet-brain registered + launcher on disk (KB opt-in)
#   P8  statusline      the target statusline runs on a minimal stdin JSON
#   P9  sentinels       status.sh --json: kit dist patches present == total
#   P10 learning        verify-learning.sh --json: verdict live|partial
#   P11 health-parse    health.sh --json: memory totals sane (comma-bug tripwire)
#   P12 swarm-smoke     ruflo hooks route returns a routing decision
#   P13 stores-writable each present sqlite store takes a momentary write lock
#   P14 daemon-gates    CF-CONFIG autostart:false + statusline DAEMON-AUTOSTART-3-V1
#                       pin (running daemons WARN, never FAIL)
#   P15 statusline-truth canonical --json swarmdb.vectorCount == sqlite sum (±5) +
#                       tests.testCases>=testFiles with countMethod 'regex-scan'
#
# NOTE (P12): `ruflo hooks route` may append one route-capture row to the swarm
# store — this probe is read-MOSTLY, not strictly read-only. Everything else is
# read-only (P13's BEGIN IMMEDIATE; ROLLBACK mutates nothing).
#
# x2 driver (default): pass 1 runs in the inherited env; pass 2 runs under a
# CLEAN env (`env -i HOME PATH TERM`) so it must re-derive every fact from disk.
# Verdict PROVED iff BOTH passes have zero FAIL AND the per-probe verdict vector
# is byte-identical between passes; any flip → UNSTABLE; any FAIL → FAILED.
# Exit 0 ONLY on PROVED.
# ============================================================================

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# ── Pre-parse proof-only flags, then hand the rest to kit_resolve ────────────
# kit_resolve() warns on flags it doesn't know, so strip ours first (the
# fix-brain idiom). --dry-run is left for kit_resolve to parse into DRY_RUN.
SINGLE=0; JSON=0
_KR_ARGS=()
for _a in "$@"; do
  case "$_a" in
    --single) SINGLE=1 ;;
    --json)   JSON=1 ;;
    *)        _KR_ARGS+=("$_a") ;;
  esac
done
kit_resolve ${_KR_ARGS[@]+"${_KR_ARGS[@]}"}
kit_require_target

MCP_JSON="$TARGET_DIR/.mcp.json"
SETTINGS="$TARGET_DIR/.claude/settings.json"
GROOT="$(npm root -g 2>/dev/null || echo '')"

# Parallel arrays (bash 3.2 has no assoc arrays): name | verdict | detail.
P_NAME=(); P_VERDICT=(); P_DETAIL=()
record_probe() { P_NAME+=("$1"); P_VERDICT+=("$2"); P_DETAIL+=("$3"); }

# ── Probes ───────────────────────────────────────────────────────────────────
# P1 ruflo-cli: real `ruflo --version` exits 0 AND prints a semver.
probe_ruflo_cli() {
  local out rc; out="$(ruflo --version 2>/dev/null)"; rc=$?
  local v; v="$(printf '%s' "$out" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  if [[ "$rc" -ne 0 ]]; then
    record_probe "ruflo-cli" FAIL "ruflo --version exit $rc"
  elif [[ -n "$v" ]]; then
    record_probe "ruflo-cli" PASS "ruflo $v"
  else
    record_probe "ruflo-cli" FAIL "exit 0 but no semver in output"
  fi
}

# P2 ruflo-mcp: the claude-flow MCP server answers one JSON-RPC initialize.
probe_ruflo_mcp() {
  case "$(mcp_initialize_probe 8 ruflo mcp start)" in
    PROBE_OK)     record_probe "ruflo-mcp" PASS "initialize handshake answered" ;;
    PROBE_NORESP) record_probe "ruflo-mcp" WARN "no initialize response in 8s (first-run warmup?)" ;;
    *)            record_probe "ruflo-mcp" FAIL "MCP server errored on launch" ;;
  esac
}

# P3 aqe: `aqe --version` exits 0, then handshake the aqe-mcp command from
# the target's .mcp.json (agentic-qe entry) if it is registered.
probe_aqe() {
  local out rc; out="$(aqe --version 2>/dev/null)"; rc=$?
  if [[ "$rc" -ne 0 ]]; then record_probe "aqe" FAIL "aqe --version exit $rc"; return; fi
  local v; v="$(printf '%s' "$out" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  local acmd; acmd="$(node -e '
    try{const j=require(process.argv[1]);const s=(j.mcpServers||{})["agentic-qe"];
    if(s&&s.command){process.stdout.write([s.command].concat(s.args||[]).join("\t"))}}catch(e){}
  ' "$MCP_JSON" 2>/dev/null)"
  if [[ -z "$acmd" ]]; then
    record_probe "aqe" PASS "aqe ${v:-?} (no agentic-qe entry in .mcp.json)"
    return
  fi
  # tab-split robustly (SC2206): read -a with a scoped IFS — no glob expansion,
  # and bash-3.2-safe (no mapfile on stock macOS).
  local parts=()
  IFS=$'\t' read -r -a parts <<< "$acmd"
  case "$(mcp_initialize_probe 8 "${parts[@]}")" in
    PROBE_OK)     record_probe "aqe" PASS "aqe ${v:-?} · aqe-mcp handshake answered" ;;
    PROBE_NORESP) record_probe "aqe" WARN "aqe ${v:-?} · aqe-mcp no response in 8s" ;;
    *)            record_probe "aqe" WARN "aqe ${v:-?} · aqe-mcp probe error" ;;
  esac
}

# P4 agentdb-slots: the deliberate three-slot layout (Patch 52). standalone +
# nested pinned EXACTLY to KIT_AGENTDB_PIN; the hoisted slot is upstream's to
# move — assert only the KIT_AGENTDB_HOISTED_MIN floor (past the 8-controller
# removal watershed), so a routine upstream bump never fails the proof.
probe_agentdb_slots() {
  if [[ -z "$GROOT" ]]; then record_probe "agentdb-slots" FAIL "npm root -g unavailable"; return; fi
  local standalone hoisted nested
  standalone="$(node -p "require('$GROOT/agentdb/package.json').version" 2>/dev/null || echo '')"
  hoisted="$(node -p "require('$GROOT/ruflo/node_modules/agentdb/package.json').version" 2>/dev/null || echo '')"
  nested="$(node -p "require('$GROOT/ruflo/node_modules/@claude-flow/memory/node_modules/agentdb/package.json').version" 2>/dev/null || echo '')"
  local bad=""
  [[ "$standalone" == "$KIT_AGENTDB_PIN" ]] || bad+="standalone=${standalone:-missing} "
  if [[ -z "$hoisted" ]] || aqe_semver_lt "$hoisted" "$KIT_AGENTDB_HOISTED_MIN"; then
    bad+="hoisted=${hoisted:-missing} "
  fi
  [[ "$nested" == "$KIT_AGENTDB_PIN" ]] || bad+="nested=${nested:-missing} "
  if [[ -z "$bad" ]]; then
    record_probe "agentdb-slots" PASS "standalone/$standalone hoisted/$hoisted(>=${KIT_AGENTDB_HOISTED_MIN#3.0.0-}) nested/$nested"
  else
    record_probe "agentdb-slots" FAIL "expected standalone/nested=$KIT_AGENTDB_PIN hoisted>=$KIT_AGENTDB_HOISTED_MIN — got $bad"
  fi
}

# P5 controllers: the nested agentdb must require() and expose the full class
# surface (>= KIT_AGENTDB_CONTROLLERS). A require failure is a hard FAIL.
probe_controllers() {
  if [[ -z "$GROOT" ]]; then record_probe "controllers" FAIL "npm root -g unavailable"; return; fi
  local nested="$GROOT/ruflo/node_modules/@claude-flow/memory/node_modules/agentdb"
  local n; n="$(node -e '
    try{
      const m=require(process.argv[1]);
      const cls=Object.keys(m).filter(k=>{try{return typeof m[k]==="function"
        && /^class[\s{]/.test(Function.prototype.toString.call(m[k]))}catch(e){return false}});
      process.stdout.write(String(cls.length));
    }catch(e){process.stdout.write("REQUIRE_FAIL")}
  ' "$nested" 2>/dev/null)"
  if [[ "$n" == "REQUIRE_FAIL" || -z "$n" ]]; then
    record_probe "controllers" FAIL "nested agentdb require() failed"
  elif [[ "$n" -ge "$KIT_AGENTDB_CONTROLLERS" ]]; then
    record_probe "controllers" PASS "$n/$KIT_AGENTDB_CONTROLLERS controller classes"
  else
    record_probe "controllers" FAIL "$n/$KIT_AGENTDB_CONTROLLERS controller classes (surface shrunk)"
  fi
}

# P6 bsqlite: better-sqlite3 loads from agentdb's context (else agentdb MCP -32000).
probe_bsqlite() {
  if global_bsqlite_loads; then
    record_probe "bsqlite" PASS "better-sqlite3 loads from agentdb context"
  else
    record_probe "bsqlite" FAIL "better-sqlite3 not loadable (agentdb MCP would -32000)"
  fi
}

# P7 brain: ruvnet-brain registered in .mcp.json + its launcher on disk. KB is
# opt-in (a GB download), so KB-absent is a WARN, not a FAIL.
probe_brain() {
  if [[ ! -f "$MCP_JSON" ]]; then record_probe "brain" FAIL "no .mcp.json at target"; return; fi
  local entry rc
  entry="$(node -e '
    try{const j=require(process.argv[1]);const s=(j.mcpServers||{})["ruvnet-brain"];
    if(!s)process.exit(1);
    process.stdout.write(((s.args||[])[0]||"")+"\t"+((s.env||{}).RUVNET_BRAIN_KB||""))}catch(e){process.exit(1)}
  ' "$MCP_JSON" 2>/dev/null)"; rc=$?
  if [[ "$rc" -ne 0 ]]; then record_probe "brain" FAIL "ruvnet-brain not registered in .mcp.json"; return; fi
  local launcher kb; local _oldifs="$IFS"; IFS=$'\t'; read -r launcher kb <<< "$entry"; IFS="$_oldifs"
  if [[ -z "$launcher" || ! -f "$launcher" ]]; then
    record_probe "brain" FAIL "launcher missing on disk: ${launcher:-<none>}"; return
  fi
  # KB identity: prefer the kit's .release-tag marker (the bundle's inner
  # package.json can lag the release tag — see BRAIN-KB-REFRESH-V1).
  local ver=""
  if [[ -n "$kb" ]]; then
    ver="$(head -1 "$kb/.release-tag" 2>/dev/null | tr -d '[:space:]')"; ver="${ver#v}"
    [[ -z "$ver" && -f "$kb/package.json" ]] && ver="$(node -p "require('$kb/package.json').version" 2>/dev/null || echo '')"
  fi
  if [[ -n "$kb" && -f "$kb/forge-mcp-all.mjs" ]]; then
    record_probe "brain" PASS "registered · launcher ok · KB${ver:+ v$ver} present"
  else
    record_probe "brain" WARN "registered · launcher ok · KB absent (opt-in: fix-brain --download)"
  fi
}

# P8 statusline: run the target's statusline command (or the vendored asset) on a
# minimal Claude-Code-shaped stdin JSON; assert exit 0 + non-empty output.
probe_statusline() {
  local scmd input out rc
  scmd="$(node -e '
    try{const j=require(process.argv[1]);process.stdout.write((j.statusLine&&j.statusLine.command)||"")}catch(e){}
  ' "$SETTINGS" 2>/dev/null)"
  # minimal shape statusline.cjs reads from stdin (model/context_window/cost).
  input='{"model":{"display_name":"proof"},"workspace":{"current_dir":"'"$TARGET_DIR"'"},"context_window":{"used_percentage":0},"cost":{"total_cost_usd":0,"total_duration_ms":0}}'
  if [[ -n "$scmd" ]]; then
    out="$(cd "$TARGET_DIR" && printf '%s' "$input" | CLAUDE_PROJECT_DIR="$TARGET_DIR" sh -c "$scmd" 2>/dev/null)"; rc=$?
  elif [[ -f "$KIT_ASSETS/statusline.cjs" ]]; then
    out="$(printf '%s' "$input" | node "$KIT_ASSETS/statusline.cjs" 2>/dev/null)"; rc=$?
  else
    record_probe "statusline" FAIL "no statusLine.command and no vendored statusline.cjs"; return
  fi
  if [[ "$rc" -eq 0 && -n "$out" ]]; then
    record_probe "statusline" PASS "statusline rendered ($(printf '%s' "$out" | wc -l | tr -d ' ') lines)"
  else
    record_probe "statusline" FAIL "statusline exit $rc / empty output"
  fi
}

# P9 sentinels: status.sh --json is disk-derived truth — every kit dist patch
# must be PRESENT (present == total).
probe_sentinels() {
  local out present total
  out="$(bash "$KIT_LIB/status.sh" "$TARGET_DIR" --json 2>/dev/null)"
  read -r present total <<< "$(printf '%s' "$out" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s.slice(s.indexOf("{")));
      process.stdout.write((o.sentinels.present)+" "+(o.sentinels.total))}catch(e){process.stdout.write("ERR ERR")}})
  ' 2>/dev/null)"
  if [[ "$present" == "ERR" || -z "$present" ]]; then
    record_probe "sentinels" FAIL "status.sh --json unparseable"
  elif [[ "$present" -lt "$total" ]]; then
    record_probe "sentinels" FAIL "$present/$total kit dist patches present (re-run fix-ruflo)"
  else
    record_probe "sentinels" PASS "$present/$total kit dist patches present"
  fi
}

# P10 learning: verify-learning.sh verdict must be live or partial.
probe_learning() {
  local j v
  j="$(bash "$KIT_LIB/verify-learning.sh" "$TARGET_DIR" --json 2>/dev/null | tail -1)"
  v="$(node -e 'try{process.stdout.write(JSON.parse(process.argv[1]).verdict||"unknown")}catch(e){process.stdout.write("unknown")}' "$j" 2>/dev/null)"
  case "$v" in
    live|partial) record_probe "learning" PASS "verify-learning verdict: $v" ;;
    hollow)       record_probe "learning" FAIL "learning loop HOLLOW (run fix-learning)" ;;
    *)            record_probe "learning" WARN "learning verdict unavailable ($v)" ;;
  esac
}

# P11 health-parse: the HEALTH-COMMA-V1 tripwire. A thousands-separated count
# misread as `1` shows up as totalEntries<=1 while hnswEntries>0, or
# totalEntries < hnswEntries. Both are impossible for a healthy store.
probe_health_parse() {
  local out tot hnsw
  out="$(bash "$KIT_LIB/health.sh" "$TARGET_DIR" --json 2>/dev/null)"
  read -r tot hnsw <<< "$(printf '%s' "$out" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s.slice(s.indexOf("{")));
      const m=o.metrics.memory;process.stdout.write((m.totalEntries)+" "+(m.hnswEntries))}catch(e){process.stdout.write("ERR ERR")}})
  ' 2>/dev/null)"
  if [[ "$tot" == "ERR" || -z "$tot" ]]; then
    record_probe "health-parse" WARN "health.sh --json unparseable"
  elif [[ "$tot" -eq 0 && "$hnsw" -eq 0 ]]; then
    record_probe "health-parse" WARN "memory empty (fresh target: 0 entries)"
  elif [[ "$tot" -le 1 && "$hnsw" -gt 0 ]]; then
    record_probe "health-parse" FAIL "comma-bug tripwire: totalEntries=$tot but hnswEntries=$hnsw"
  elif [[ "$tot" -lt "$hnsw" ]]; then
    record_probe "health-parse" FAIL "comma-bug tripwire: totalEntries=$tot < hnswEntries=$hnsw"
  else
    record_probe "health-parse" PASS "memory totalEntries=$tot hnswEntries=$hnsw"
  fi
}

# P12 swarm-smoke: the hooks router returns a decision (read-mostly — may append
# one route-capture row). NORESP/empty is a WARN, never a FAIL.
probe_swarm_smoke() {
  local out rc
  out="$(ruflo hooks route --query "proof-smoke" 2>/dev/null)"; rc=$?
  if [[ "$rc" -ne 0 || -z "$out" ]]; then
    out="$(ruflo hooks route --task "proof-smoke" 2>/dev/null)"; rc=$?
  fi
  if [[ "$rc" -eq 0 && -n "$out" ]]; then
    record_probe "swarm-smoke" PASS "hooks route returned a decision"
  else
    record_probe "swarm-smoke" WARN "hooks route gave no output (rc $rc)"
  fi
}

# P13 stores-writable: each present sqlite store takes a momentary write lock
# (BEGIN IMMEDIATE; ROLLBACK — zero mutation). A missing store is WARN, not FAIL.
# busy_timeout 3s: in a LIVE session the aqe-mcp / claude-flow servers hold
# transient RESERVED locks mid-write — "lockable within 3s" is the honest
# invariant; an instant-fail probe just measures the writer's timing, not the
# store's health (observed: P13 flapped whenever the live aqe-mcp was writing).
probe_stores_writable() {
  # KIT-SQLITE-SHIM-V1: the lock test runs through kit_sqlite_rw_check — the
  # sqlite3 CLI when present, else node + the global ruflo's better-sqlite3
  # (same BEGIN IMMEDIATE; ROLLBACK, same 3s busy timeout). A sqlite3-less host
  # therefore gets a REAL probe (it used to hard-FAIL "not assessable" — observed
  # 2026-07-20, Rust-target adoption on a sqlite3-less Ubuntu host). Only a host
  # with NEITHER instrument still FAILs: PROVED must not be earned blind.
  local backend; backend="$(kit_sqlite_backend)"
  if [[ "$backend" == "none" ]]; then
    record_probe "stores-writable" FAIL "no sqlite instrument (sqlite3 CLI absent, global better-sqlite3 unloadable) - writability not assessable"
    return
  fi
  # Transparency: when the lock test ran on the node fallback, say so in the
  # detail — the verdict semantics are identical, but the instrument differs.
  local fbnote=""
  [[ "$backend" == "node" ]] && fbnote=" [via node better-sqlite3 fallback - sqlite3 CLI absent]"
  local rels=(".swarm/memory.db" ".agentic-qe/memory.db" "agentdb.db")
  local rel db checked=0 missing=0 locked="" held=""
  for rel in "${rels[@]}"; do
    db="$TARGET_DIR/$rel"
    if [[ ! -f "$db" ]]; then missing=$((missing + 1)); continue; fi
    checked=$((checked + 1))
    if ! kit_sqlite_rw_check "$db"; then
      # A LIVE writer (aqe-mcp / claude-flow MCP mid-write) yields transient
      # SQLITE_BUSY or even SQLITE_IOERR on WAL checkpoints — that is "not
      # assessable right now", not "broken". FAIL is reserved for a store that
      # fails with NO live holder (genuinely locked/corrupt).
      local holder; holder="$(lsof -t -- "$db" 2>/dev/null | head -1)"
      if [[ -n "$holder" ]]; then held+="$rel(pid $holder) "; else locked+="$rel "; fi
    fi
  done
  if [[ -n "$locked" ]]; then
    record_probe "stores-writable" FAIL "locked/unwritable with no live holder: ${locked}${fbnote}"
  elif [[ -n "$held" ]]; then
    record_probe "stores-writable" WARN "held by live writer: ${held}- writability not assessable mid-session${fbnote}"
  elif [[ "$checked" -eq 0 ]]; then
    record_probe "stores-writable" WARN "no sqlite stores present yet (fresh target)"
  elif [[ "$missing" -gt 0 ]]; then
    record_probe "stores-writable" WARN "$checked store(s) writable; $missing absent${fbnote}"
  else
    record_probe "stores-writable" PASS "$checked store(s) take a write lock cleanly${fbnote}"
  fi
}

# P14 daemon-gates: the three-channel daemon opt-out must be intact on the target.
# FAIL if the project-root claude-flow.config.json is missing or its
# daemon.autostart is not exactly false (CF-CONFIG-AUTOSTART-OFF-V1), OR if the
# INSTALLED statusline lacks the DAEMON-AUTOSTART-3-V1 child-env pin (the 5s
# statusline refresh is the resurrection channel the pin closes). A statusline
# that isn't installed yet is a fresh-target WARN, not a FAIL. Running
# `cli.js daemon start` processes are a WARN, never a FAIL — a deliberate operator
# daemon is allowed (matches setup S6 semantics); the count is surfaced in detail.
probe_daemon_gates() {
  local cf="$TARGET_DIR/claude-flow.config.json"
  local sl="$TARGET_DIR/.claude/helpers/statusline.cjs"
  local verdict="PASS" detail=""
  # (1) project config gate
  local cfstate
  if [[ ! -f "$cf" ]]; then
    cfstate="missing"
  else
    cfstate="$(node -e '
      try{const j=require(process.argv[1]);
        process.stdout.write((j.daemon&&j.daemon.autostart===false)?"off":"on")}
      catch(e){process.stdout.write("bad")}
    ' "$cf" 2>/dev/null)"
  fi
  case "$cfstate" in
    off)     detail="config:off" ;;
    missing) verdict="FAIL"; detail="claude-flow.config.json MISSING (run fix-ruflo)" ;;
    on)      verdict="FAIL"; detail="daemon.autostart != false" ;;
    *)       verdict="FAIL"; detail="claude-flow.config.json unreadable" ;;
  esac
  # (2) installed statusline child-env pin
  if [[ ! -f "$sl" ]]; then
    [[ "$verdict" == "PASS" ]] && verdict="WARN"
    detail="$detail · statusline absent (fresh target)"
  elif grep -q "DAEMON-AUTOSTART-3-V1" "$sl" 2>/dev/null; then
    detail="$detail · statusline pinned"
  else
    verdict="FAIL"; detail="$detail · statusline lacks DAEMON-AUTOSTART-3-V1"
  fi
  # (3) running daemons — WARN, never FAIL
  local dcount
  # bin/cli.js anchors the match to the real daemon argv — a shell whose command
  # line merely CONTAINS the words (e.g. an agent discussing it) false-matched
  # the looser pattern (x2 re-audit note).
  dcount="$(pgrep -f "bin/cli.js daemon start" 2>/dev/null | grep -c . | tr -d ' ')"
  if [[ "${dcount:-0}" -gt 0 ]]; then
    [[ "$verdict" != "FAIL" ]] && verdict="WARN"
    detail="$detail · $dcount daemon proc(s) running (operator?)"
    # DAEMON-STALE-DIST-V1: a daemon that started BEFORE the newest kit dist
    # patch is running pre-patch code (dist patches inert in it until:
    # ruflo daemon stop && ruflo daemon start — deliberate starts are the
    # operator's; auto-spawned strays are safe to stop). Detection-only detail
    # enrichment; verdict semantics UNCHANGED (running daemons stay WARN at most).
    local scount
    scount="$(kit_daemon_staleness 2>/dev/null | grep -cE ' STALE( |$)')"
    [[ "${scount:-0}" -gt 0 ]] && detail="$detail · $scount stale-dist daemon(s)"
  fi
  record_probe "daemon-gates" "$verdict" "$detail"
}

# P15 statusline-truth: the TRUTH-STATUSLINE-V1 contract must hold — every
# displayed number must re-derive from disk. Render the CANONICAL statusline
# ($KIT_ASSETS/statusline.cjs) with --json from the target cwd (stdin=/dev/null,
# 15s SIGKILL guard), then cross-check two fields against independent ground
# truth: (a) swarmdb.vectorCount == a freshly-computed sqlite sum over
# $TARGET/.swarm/memory.db (memory_entries embedding NOT NULL + pattern_embeddings
# + learning_state_embeddings + patterns embedding NOT NULL — the audit formula),
# within ±5 for live drift; (b) tests.testCases >= tests.testFiles AND
# tests.countMethod === 'regex-scan'. No .swarm/memory.db → fresh-target WARN.
# NOTE: (b) requires the TRUTH-SL-V1 statusline to be integrated; if the rendered
# --json lacks these keys the probe correctly FAILs.
probe_statusline_truth() {
  local swarmdb="$TARGET_DIR/.swarm/memory.db"
  if [[ ! -f "$swarmdb" ]]; then
    record_probe "statusline-truth" WARN "no .swarm/memory.db (fresh target)"; return
  fi
  if [[ ! -f "$KIT_ASSETS/statusline.cjs" ]]; then
    record_probe "statusline-truth" FAIL "canonical statusline.cjs absent from kit assets"; return
  fi
  local driver res
  driver="$(mktemp)"
  cat > "$driver" <<'NODE'
'use strict';
const { spawn, execSync } = require('node:child_process');
const [SL, TARGET, SWARMDB, BSQLITE] = process.argv.slice(2);
// KIT-SQLITE-SHIM-V1: pick the recount instrument ONCE — sqlite3 CLI first,
// else node + the global ruflo's better-sqlite3 (path passed in as BSQLITE).
// With NEITHER, the independent recount is honestly UNAVAILABLE: the old code
// silently returned 0 on every error, and a silent 0 could false-PASS drift
// (any statusline rendering vectorCount<=5 would "match" a blind instrument).
let mode = null, bdb = null;
try {
  execSync('sqlite3 -version', { timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
  mode = 'cli';
} catch (e) { /* CLI absent */ }
if (!mode) {
  try {
    const B = require(BSQLITE);
    bdb = new B(SWARMDB, { readonly: true, fileMustExist: true });
    mode = 'node';
  } catch (e) { /* better-sqlite3 absent/unloadable too */ }
}
function sqliteCount(sql) {
  // Instrument present: a per-query error means "missing table" → 0 (the audit
  // formula sums over tables that may legitimately not exist yet).
  if (mode === 'cli') {
    try {
      const o = execSync('sqlite3 -readonly "' + SWARMDB + '" "' + sql + '"',
        { timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      const n = parseInt(o, 10); return Number.isFinite(n) ? n : 0;
    } catch (e) { return 0; }
  }
  if (mode === 'node') {
    try {
      const n = Number(bdb.prepare(sql).pluck().get());
      return Number.isFinite(n) ? n : 0;
    } catch (e) { return 0; }
  }
  return null;
}
if (mode === null) {
  // No instrument at all: refuse the comparison instead of comparing against a
  // silent 0 — an explicit FAIL is the honest verdict here.
  console.log('FAIL|independent recount unavailable (no sqlite3 CLI and no loadable global better-sqlite3) - refusing silent-0 comparison');
  process.exit(0);
}
// Independent 4-query sum — the exact audit formula, computed here (not trusting
// the statusline's own arithmetic). Missing tables count as 0 on either arm.
const indep =
  sqliteCount("SELECT COUNT(*) FROM memory_entries WHERE embedding IS NOT NULL") +
  sqliteCount("SELECT COUNT(*) FROM pattern_embeddings") +
  sqliteCount("SELECT COUNT(*) FROM learning_state_embeddings") +
  sqliteCount("SELECT COUNT(*) FROM patterns WHERE embedding IS NOT NULL");
const child = spawn(process.execPath, [SL, '--json'],
  { cwd: TARGET, stdio: ['ignore', 'pipe', 'ignore'],
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: TARGET }) });
let out = '', done = false;
const finish = (tok) => { if (done) return; done = true; try { child.kill('SIGKILL'); } catch (_) {} console.log(tok); process.exit(0); };
const timer = setTimeout(() => finish('FAIL|canonical render timed out (>15s)'), 15000);
child.stdout.on('data', (d) => { out += d.toString(); });
child.on('error', () => { clearTimeout(timer); finish('FAIL|canonical render spawn error'); });
child.on('exit', () => {
  clearTimeout(timer);
  let j; try { j = JSON.parse(out); } catch (e) { return finish('FAIL|--json not parseable (TRUTH-SL-V1 not integrated yet?)'); }
  const sw = (j.swarmdb && typeof j.swarmdb === 'object') ? j.swarmdb : null;
  const t = (j.tests && typeof j.tests === 'object') ? j.tests : null;
  if (!sw || typeof sw.vectorCount !== 'number') return finish('FAIL|swarmdb.vectorCount missing from --json');
  if (!t) return finish('FAIL|tests block missing from --json');
  const problems = [];
  if (Math.abs(sw.vectorCount - indep) > 5) problems.push('vectorCount ' + sw.vectorCount + ' vs sqlite ' + indep + ' (>5 drift)');
  if (!(typeof t.testCases === 'number' && typeof t.testFiles === 'number' && t.testCases >= t.testFiles))
    problems.push('testCases(' + t.testCases + ') < testFiles(' + t.testFiles + ')');
  if (t.countMethod !== 'regex-scan') problems.push("countMethod='" + t.countMethod + "' != regex-scan");
  const fb = (mode === 'node') ? ' [recount via node better-sqlite3 fallback - sqlite3 CLI absent]' : '';
  if (problems.length) return finish('FAIL|' + problems.join('; ') + fb);
  finish('PASS|vectorCount ' + sw.vectorCount + ' ~ sqlite ' + indep + '; testCases ' + t.testCases + ' >= testFiles ' + t.testFiles + '; regex-scan' + fb);
});
NODE
  res="$(node "$driver" "$KIT_ASSETS/statusline.cjs" "$TARGET_DIR" "$swarmdb" \
    "${GROOT:+$GROOT/ruflo/node_modules/better-sqlite3}" 2>/dev/null)"
  rm -f "$driver"
  local verdict detail
  verdict="${res%%|*}"; detail="${res#*|}"
  case "$verdict" in
    PASS) record_probe "statusline-truth" PASS "$detail" ;;
    FAIL) record_probe "statusline-truth" FAIL "$detail" ;;
    *)    record_probe "statusline-truth" FAIL "render probe inconclusive (${res:-no output})" ;;
  esac
}

run_all_probes() {
  probe_ruflo_cli
  probe_ruflo_mcp
  probe_aqe
  probe_agentdb_slots
  probe_controllers
  probe_bsqlite
  probe_brain
  probe_statusline
  probe_sentinels
  probe_learning
  probe_health_parse
  probe_swarm_smoke
  probe_stores_writable
  probe_daemon_gates
  probe_statusline_truth
}

# ── Emitters ─────────────────────────────────────────────────────────────────
emit_single_json() {
  local names verdicts details
  names="$(printf '%s\n' ${P_NAME[@]+"${P_NAME[@]}"})"
  verdicts="$(printf '%s\n' ${P_VERDICT[@]+"${P_VERDICT[@]}"})"
  details="$(printf '%s\n' ${P_DETAIL[@]+"${P_DETAIL[@]}"})"
  P_NAMES="$names" P_VERDICTS="$verdicts" P_DETAILS="$details" node -e '
    const e=process.env;
    const n=(e.P_NAMES||"").split("\n").filter(x=>x.length>0);
    const v=(e.P_VERDICTS||"").split("\n");
    const d=(e.P_DETAILS||"").split("\n");
    const probes=n.map((name,i)=>({name,verdict:v[i]||"",detail:d[i]||""}));
    const failed=probes.filter(p=>p.verdict==="FAIL").length;
    const warned=probes.filter(p=>p.verdict==="WARN").length;
    process.stdout.write(JSON.stringify({probes,failed,warned}));
  '
  echo ""
}

print_single_table() {
  local failed=0 warned=0 i
  header "proof" "15-probe disk-evidence proof (single pass)"
  kit_banner
  echo ""
  printf "  %-18s %-8s %s\n" "PROBE" "VERDICT" "DETAIL"
  for i in "${!P_NAME[@]}"; do
    local col
    case "${P_VERDICT[$i]}" in
      PASS) col="$GREEN" ;;
      WARN) col="$YELLOW"; warned=$((warned + 1)) ;;
      FAIL) col="$RED"; failed=$((failed + 1)) ;;
      *)    col="$CYAN" ;;
    esac
    printf "  %-18s ${col}%-8s${NC} %s\n" "${P_NAME[$i]}" "${P_VERDICT[$i]}" "${P_DETAIL[$i]}"
  done
  echo ""
  echo -e "  Summary: ${GREEN}$(( ${#P_NAME[@]} - failed - warned )) pass${NC}  ${YELLOW}$warned warn${NC}  ${RED}$failed fail${NC}"
  [[ "$failed" -eq 0 ]] && echo -e "  ${GREEN}✓ single pass: no FAIL${NC}" \
                        || echo -e "  ${RED}✗ single pass: $failed FAIL${NC}"
}

# ── Single-pass mode ─────────────────────────────────────────────────────────
run_single() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    if [[ "$JSON" -eq 1 ]]; then
      echo '{"dryRun":true,"probes":[],"failed":0,"warned":0}'
    else
      echo "[dry-run] would run 15 disk-evidence probes against $TARGET_DIR (no commands executed)"
    fi
    exit 0
  fi
  run_all_probes
  local failed=0 i
  for i in "${!P_VERDICT[@]}"; do [[ "${P_VERDICT[$i]}" == "FAIL" ]] && failed=$((failed + 1)); done
  if [[ "$JSON" -eq 1 ]]; then emit_single_json; else print_single_table; fi
  [[ "$failed" -eq 0 ]] && exit 0 || exit 1
}

# ── x2 driver ────────────────────────────────────────────────────────────────
run_x2() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    if [[ "$JSON" -eq 1 ]]; then
      echo '{"dryRun":true,"stable":true,"verdict":"PROVED"}'
    else
      echo "[dry-run] would run the 15 probes TWICE:"
      echo "  pass 1: bash $KIT_LIB/proof.sh $TARGET_DIR --single --json   (inherited env)"
      echo "  pass 2: env -i HOME PATH TERM bash $KIT_LIB/proof.sh $TARGET_DIR --single --json   (clean env)"
      echo "  verdict PROVED iff both passes have zero FAIL and identical verdict vectors"
    fi
    exit 0
  fi

  local J1 J2
  J1="$(bash "$KIT_LIB/proof.sh" "$TARGET_DIR" --single --json 2>/dev/null | tail -1)"
  J2="$(env -i HOME="$HOME" PATH="$PATH" TERM=dumb bash "$KIT_LIB/proof.sh" "$TARGET_DIR" --single --json 2>/dev/null | tail -1)"

  local RESULT
  RESULT="$(P1="$J1" P2="$J2" node -e '
    const e=process.env;
    let p1,p2;
    try{p1=JSON.parse(e.P1)}catch(x){p1=null}
    try{p2=JSON.parse(e.P2)}catch(x){p2=null}
    if(!p1||!p2||!Array.isArray(p1.probes)||!Array.isArray(p2.probes)){
      process.stdout.write(JSON.stringify({pass1:p1,pass2:p2,stable:false,verdict:"FAILED",error:"a pass produced no parseable JSON"}));
      process.exit(0);
    }
    const vec=o=>o.probes.map(p=>p.name+":"+p.verdict).join("|");
    const stable=vec(p1)===vec(p2);
    const hasFail=(p1.failed>0)||(p2.failed>0);
    const verdict=hasFail?"FAILED":(stable?"PROVED":"UNSTABLE");
    process.stdout.write(JSON.stringify({pass1:p1,pass2:p2,stable,verdict}));
  ')"

  local VERDICT
  VERDICT="$(node -e 'try{process.stdout.write(JSON.parse(process.argv[1]).verdict||"FAILED")}catch(e){process.stdout.write("FAILED")}' "$RESULT" 2>/dev/null)"

  if [[ "$JSON" -eq 1 ]]; then
    echo "$RESULT"
  else
    echo "============================================"
    echo " ruflo-kit proof (x2)"
    echo " kit:    $KIT_DIR"
    echo " target: $TARGET_DIR"
    echo "============================================"
    printf "  %-18s %-7s %-7s %s\n" "PROBE" "PASS1" "PASS2" "DETAIL"
    RESULT_ENV="$RESULT" node -e '
      const r=JSON.parse(process.env.RESULT_ENV);
      const p1=(r.pass1&&r.pass1.probes)||[], p2=(r.pass2&&r.pass2.probes)||[];
      const n=Math.max(p1.length,p2.length);
      for(let i=0;i<n;i++){
        const a=p1[i]||{}, b=p2[i]||{};
        const name=a.name||b.name||"?";
        process.stdout.write("  "+name.padEnd(18)+" "+String(a.verdict||"-").padEnd(7)+" "+String(b.verdict||"-").padEnd(7)+" "+(a.detail||b.detail||"")+"\n");
      }
    ' 2>/dev/null
    echo ""
    case "$VERDICT" in
      PROVED)   echo -e "  ${GREEN}✓ PROVED${NC} — both passes clean, verdict vectors identical" ;;
      UNSTABLE) echo -e "  ${YELLOW}! UNSTABLE${NC} — probe verdicts differ between passes (non-deterministic)" ;;
      *)        echo -e "  ${RED}✗ FAILED${NC} — at least one probe FAILed (see table)" ;;
    esac
    echo "============================================"
  fi

  [[ "$VERDICT" == "PROVED" ]] && exit 0 || exit 1
}

# ── Dispatch ─────────────────────────────────────────────────────────────────
if [[ "$SINGLE" -eq 1 ]]; then
  run_single
else
  run_x2
fi
