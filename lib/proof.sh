#!/usr/bin/env bash
set -uo pipefail
# Note: -e intentionally omitted — probes signal PASS/WARN/FAIL through recorded
# verdicts, not exit codes, and ((n++)) returns 1 when n=0 under set -e.
# ============================================================================
# lib/proof.sh — PROOF-V1. Prove the ruflo + AQE stack actually works, twice.
#
#   bin/ruflo-kit proof <target>              # 13 probes, run TWICE (x2), verdict
#   bin/ruflo-kit proof <target> --single     # 13 probes, ONE pass
#   bin/ruflo-kit proof <target> --json       # machine shape
#   bin/ruflo-kit proof <target> --dry-run    # list what would run, exit 0
#
# EVERY assertion is DISK-DERIVED or REAL command output — never an MCP/daemon
# self-report (a broken server happily says "healthy"). Thirteen probes:
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
  local _oldifs="$IFS"; IFS=$'\t'; local parts=($acmd); IFS="$_oldifs"
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
probe_stores_writable() {
  local rels=(".swarm/memory.db" ".agentic-qe/memory.db" "agentdb.db")
  local rel db checked=0 missing=0 locked=""
  for rel in "${rels[@]}"; do
    db="$TARGET_DIR/$rel"
    if [[ ! -f "$db" ]]; then missing=$((missing + 1)); continue; fi
    checked=$((checked + 1))
    sqlite3 "$db" "BEGIN IMMEDIATE; ROLLBACK;" >/dev/null 2>&1 || locked+="$rel "
  done
  if [[ -n "$locked" ]]; then
    record_probe "stores-writable" FAIL "locked/unwritable: $locked"
  elif [[ "$checked" -eq 0 ]]; then
    record_probe "stores-writable" WARN "no sqlite stores present yet (fresh target)"
  elif [[ "$missing" -gt 0 ]]; then
    record_probe "stores-writable" WARN "$checked store(s) writable; $missing absent"
  else
    record_probe "stores-writable" PASS "$checked store(s) take a write lock cleanly"
  fi
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
  header "proof" "13-probe disk-evidence proof (single pass)"
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
      echo "[dry-run] would run 13 disk-evidence probes against $TARGET_DIR (no commands executed)"
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
      echo "[dry-run] would run the 13 probes TWICE:"
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
