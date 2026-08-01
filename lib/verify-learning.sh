#!/usr/bin/env bash
set -uo pipefail
# ============================================================================
# verify-learning.sh — READ-ONLY liveness probes for the ruflo + AQE self-
# learning loop (GitHub issue #4: "enabled-but-hollow").
#
# The whole class of bugs in issue #4 is "looks healthy, is hollow": MCP status
# tools over-report (e.g. aqe_health claimed 3116 entries vs ~138 committed
# rows). So this script trusts ONLY committed disk state — direct sqlite3 row
# counts and on-disk artifacts — never an MCP self-report. It FAILS LOUDLY
# (exit 1) when controllers are enabled but the structured tables are empty, the
# neural trainer is stuck in JS fallback, or HNSW is unindexed. CI-friendly.
#
# Probes:
#   #2 ruflo controllers hollow (memory_entries>0 but structured tables 0) FAIL
#   #3 neural trainer in JS fallback (lora totalUpdates>0, totalAdaptations 0) FAIL
#   #4 HNSW unindexed (AQE vectors>0 but useNativeHNSW unset)               FAIL
#   #6 dimension guard (vectors 384-dim AND blob == dim*4)                   FAIL-on-corruption
#   #9 graphAdapter not wiring relationships (graph_edges 0)                 WARN
#   #10 SONA table unpopulated (sona_patterns 0)                            WARN
#   #11 sona-seam sentinels (SONA-TRAIN-V1 + RUFLO-LORA-ADAPT-V1 in dist)   FAIL
#   #12 capture-arm inflow (INFLOW-LIVENESS-V1: hooks wired + pool fresh)   FAIL-if-unwired / WARN-stale
#   #7 model router liveness (totalDecisions / routing_outcomes)            INFO
#
# Usage:
#   bin/ruflo-kit verify-learning <target>            # human report, exit 1 if hollow
#   bin/ruflo-kit verify-learning <target> --json     # machine-readable summary
#   bin/ruflo-kit verify-learning <target> --dry-run  # same probes; the one CLI
#                                                      #   call with no disk
#                                                      #   substitute (aqe
#                                                      #   ruvector status) is
#                                                      #   skipped instead of
#                                                      #   run, since running it
#                                                      #   creates .agentic-qe/
#                                                      #   as an upstream side
#                                                      #   effect (B24)
#   bin/ruflo-kit verify-learning <target> -h|--help  # this help
# ============================================================================

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# Pre-strip our own flags (--json / -h) so common.sh's kit_resolve doesn't warn
# on them; forward the rest, including --dry-run, to kit_resolve (which parses
# it into $DRY_RUN — B24: no longer a pure no-op, see the RUVECTOR_HNSW
# resolution below).
JSON=0; FWD=()
for a in "$@"; do
  case "$a" in
    --json)    JSON=1 ;;
    -h|--help) sed -n '3,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)         FWD+=("$a") ;;
  esac
done
kit_resolve ${FWD[@]+"${FWD[@]}"}
kit_require_target
cd "$TARGET_DIR"

# ── safe sqlite/file helpers ─────────────────────────────────────────────────
# Store reads go through kit_sqlite_ro (common.sh, KIT-SQLITE-SHIM-V1): sqlite3
# CLI first, else node + the global ruflo's better-sqlite3. Before the shim, a
# sqlite3-less host read every count as 0 and graded a genuinely HOLLOW loop as
# "partial" (observed 2026-07-20, Rust-target adoption) — the exact "looks healthy,
# is hollow" masking this script exists to kill.
num_or_zero() { local n="$1"; [[ "$n" =~ ^[0-9]+$ ]] && echo "$n" || echo 0; }
sqlite_count_safe() {
  local db="$1" sql="$2"
  [[ -f "$db" ]] || { echo 0; return; }
  local out; out="$(kit_sqlite_ro "$db" "$sql" 2>/dev/null || echo 0)"
  num_or_zero "${out:-0}"
}
table_exists() {
  local db="$1" t="$2"
  [[ -f "$db" ]] || return 1
  local out
  out="$(kit_sqlite_ro "$db" \
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='$t' LIMIT 1;" 2>/dev/null || true)"
  [[ "${out:-}" == "1" ]]
}
# Count a table only if it exists (an absent table is 0, not an error).
count_tbl() { local db="$1" t="$2"; table_exists "$db" "$t" && sqlite_count_safe "$db" "SELECT COUNT(*) FROM $t;" || echo 0; }
# Read a numeric field from a JSON file via node. The file path is passed via
# argv (NEVER interpolated into the program string) so a TARGET_DIR containing
# quotes can't inject JS — mirrors the argv pattern in fix-aqe.sh. The accessor
# expr is a fixed kit literal (not user data), passed via env and eval'd.
json_num() {
  local file="$1" expr="$2" def="${3:-0}"
  JN_EXPR="$expr" JN_DEF="$def" node -e \
    'try{const j=require(process.argv[1]);const v=eval(process.env.JN_EXPR);process.stdout.write(String(v??Number(process.env.JN_DEF)))}catch(e){process.stdout.write(String(Number(process.env.JN_DEF)))}' \
    "$PWD/$file" 2>/dev/null || echo "$def"
}

# ── stores (canonical roots, per audit Smell #3) ────────────────────────────
SWARM_DB=".swarm/memory.db"            # ruflo coordination + controllers
AQE_DB=".agentic-qe/memory.db"         # AQE learning (canonical)
AGENTDB="agentdb.db"                   # reflexion/episodes (canonical)
LORA=".swarm/lora-weights.json"
AQE_CONFIG=".agentic-qe/config.yaml"
ROUTER_STATE=".swarm/model-router-state.json"

PASS=0; WARN=0; FAIL=0; INFO=0
# In --json mode, emit only counters (keep stdout pure JSON); otherwise print.
ok()   { [[ "$JSON" -eq 0 ]] && pass "$1"; PASS=$((PASS+1)); }
bad()  { [[ "$JSON" -eq 0 ]] && fail "$1"; FAIL=$((FAIL+1)); }
soft() { [[ "$JSON" -eq 0 ]] && warn "$1"; WARN=$((WARN+1)); }
note() { [[ "$JSON" -eq 0 ]] && info "$1"; INFO=$((INFO+1)); }

# ── probes ──────────────────────────────────────────────────────────────────
# #2 structured learning store. The reflexion/skill rows live in agentdb.db (the
# kit's harvest sink, written via the agentdb Node API: reflexion.storeEpisode +
# skills.createSkill) — NOT .swarm/memory.db, whose structured tables are hollow
# BY DESIGN (claude-flow's flat coordination store; ruflo ships no CLI that writes
# the structured schema). So measure the CANONICAL store — agentdb.db episodes +
# skills — and treat .swarm/memory.db's memory_entries as the flat-activity signal
# that says structured learning SHOULD have something to harvest. FAIL only when
# there's flat activity but nothing harvested into the reflexion store.
probe_reflexion_store() {
  local epi ski me struct eligible
  epi="$(count_tbl "$AGENTDB" episodes)"
  ski="$(count_tbl "$AGENTDB" skills)"
  me="$(count_tbl "$SWARM_DB" memory_entries)"
  struct=$((epi + ski))
  # HOLLOW is judged against what harvest can actually consume: eligible rows in
  # .agentic-qe captured_experiences (success=1, quality>=0.7 — the exact
  # tools/aqe-harvest.cjs filter; embedding-less rows count as harvestable — they
  # always reach the reflexion sink (HARVEST-VECLESS-V1) and since HARVEST-EMBED-V1
  # also train Sink A via a harvest-time derived vector). Flat .swarm memory_entries are NOT a
  # harvest source — the kit's own init/pretrain seeds them, so using them as the
  # "should have harvested" signal misclassified EVERY fresh post-setup target as
  # broken (first fresh-target e2e, 2026-07-18) and contradicted SETUP-V1's
  # "fresh machine → PROVED" contract. Experiences appear once live sessions
  # capture real work; from then on this probe FAILs exactly as before.
  eligible=0
  if table_exists "$AQE_DB" captured_experiences; then
    eligible="$(sqlite_count_safe "$AQE_DB" "SELECT COUNT(*) FROM captured_experiences WHERE success=1 AND quality>=0.7;")"
  fi
  RUFLO_ME="$me"; RUFLO_STRUCT="$struct"
  if [[ "$struct" -gt 0 ]]; then
    ok "reflexion store populated (agentdb.db: $epi episodes, $ski skills)"
  elif [[ "$eligible" -gt 0 ]]; then
    bad "reflexion store HOLLOW: $eligible harvestable experience(s) captured but agentdb.db has 0 episodes/skills — structured learning not harvested. Run: ruflo-kit harvest $TARGET_DIR (or fix-learning)"
  else
    note "reflexion store not yet populated ($me flat entries are bootstrap/coordination data, not harvestable — episodes appear after live sessions capture experiences)"
  fi
}

# #3 neural trainer in JS fallback: the LoRA writer logs updates but never
# produces a real adaptation (native backend never engaged). FAIL.
probe_lora_backend() {
  local ta tu sessions_n
  if [[ ! -f "$LORA" ]]; then note "no lora-weights.json yet (#3 n/a)"; LORA_TA=-2; return; fi
  ta="$(json_num "$LORA" "(j.stats||{}).totalAdaptations" -1)"
  tu="$(json_num "$LORA" "(j.stats||{}).totalUpdates" -1)"
  LORA_TA="$ta"
  # totalUpdates counts train() gradient writes; totalAdaptations counts the
  # adapter being APPLIED at inference (lora-adapter.js adapt()). A fresh target
  # whose only updates came from the kit's own neural-train bootstrap has ta=0
  # because no live session has routed through the adapter yet — that is
  # "primed", not a broken backend. FAIL only when session records exist, i.e.
  # the adapter SHOULD have been applied but never was (the original #3 defect).
  sessions_n=0
  if [[ -d ".claude-flow/sessions" ]]; then
    sessions_n="$(find .claude-flow/sessions -maxdepth 1 -name 'session-*.json' 2>/dev/null | wc -l | tr -d ' ')"
  fi
  if [[ "$tu" -gt 0 && "$ta" -eq 0 && "$sessions_n" -gt 0 ]]; then
    bad "neural trainer in JS FALLBACK: lora totalUpdates=$tu but totalAdaptations=0 across $sessions_n session(s) (adapter never applied at inference) — run: ruflo-kit fix-learning $TARGET_DIR"
  elif [[ "$ta" -gt 0 ]]; then
    ok "neural trainer engaged (lora adaptations=$ta)"
  elif [[ "$tu" -gt 0 ]]; then
    note "lora trainer primed (totalUpdates=$tu) — adaptations engage once live sessions route through the adapter (0 session records yet)"
  else
    note "lora trainer idle (totalUpdates=$tu, totalAdaptations=$ta)"
  fi
}

# #11 sona-seam sentinels: the SONA learning loop is closed by two kit dist
# patches applied to the INSTALLED global ruflo — SONA-TRAIN-V1 (memory/
# intelligence.js: endTrajectory drives LoRAAdapter.train()) and RUFLO-LORA-ADAPT-V1
# (mcp-tools/hooks-tools.js: route-time adapt() consumes the trained delta). If a
# ruflo upgrade wipes either patch the JS LoRA arm silently reverts to write-only
# — and the #3 totalUpdates>0∧adaptations==0 tripwire stays GREEN because training
# also stops (totalUpdates freezes). So assert the seams directly: grep the dist
# for both sentinels. This probe reads the GLOBAL dist (not the target); the src
# root resolves via KIT_RUFLO_DIST_SRC (test override) else `npm root -g`. No dist
# on disk at all ⇒ WARN not-assessable (offline / no global install); a dist file
# present but its sentinel ABSENT ⇒ FAIL (the loop reverted — re-run fix-ruflo).
seam_dist_src() {
  if [[ -n "${KIT_RUFLO_DIST_SRC:-}" ]]; then echo "$KIT_RUFLO_DIST_SRC"; return; fi
  local g; g="$(npm root -g 2>/dev/null || echo '')"
  [[ -n "$g" ]] && echo "$g/ruflo/node_modules/@claude-flow/cli/dist/src"
}
probe_seam_sentinels() {
  local root intel ht
  root="$(seam_dist_src)"
  intel="$root/memory/intelligence.js"
  ht="$root/mcp-tools/hooks-tools.js"
  # Not-assessable when the dist can't be located at all, or the two target files
  # aren't both present (unexpected dist shape / offline) — mirror the "n/a" prereq
  # convention, but as a WARN so a wiped install is visibly flagged (never a FAIL).
  if [[ -z "$root" || ! -f "$intel" || ! -f "$ht" ]]; then
    soft "sona-seam sentinels not assessable — no installed ruflo dist found (offline/no global) — SEAM-SENTINEL-V1 skipped"
    return
  fi
  local miss=""
  grep -q "SONA-TRAIN-V1" "$intel" || miss+="SONA-TRAIN-V1(intelligence.js) "
  grep -q "RUFLO-LORA-ADAPT-V1" "$ht" || miss+="RUFLO-LORA-ADAPT-V1(hooks-tools.js) "
  if [[ -z "$miss" ]]; then
    ok "sona-seam sentinels present in installed dist (SONA-TRAIN-V1 + RUFLO-LORA-ADAPT-V1)"
  else
    bad "sona-seam SENTINEL MISSING in installed dist: ${miss}— SONA learning loop reverted to write-only (an upgrade wiped a kit patch). Run: bin/ruflo-kit fix-ruflo $TARGET_DIR"
  fi
}

# #12 capture-arm inflow liveness (INFLOW-LIVENESS-V1, Patch 67). The pool
# every harvest replays — captured_experiences — only grows while a capture
# hook is wired in .claude/settings.json (kit_aqe_capture_wired, common.sh).
# A `--force` re-init that clobbers settings kills the arm with NO other
# symptom: the pool reads "fully harvested", adaptations keep growing (the
# ruflo arm still trains), and Patch-63 HOLLOW semantics stay green because
# there are no eligible UNharvested rows. Observed on the adopted Rust
# workflow-platform target (hooks died
# 2026-07-19 17:42 via `ruflo init --wizard --force`; pool frozen at 4,402;
# found only by a manual settings-snapshot diff). FAIL requires PROOF the arm
# once existed: rows with source LIKE 'cli-hook-%' are written only by the
# Claude Code hook subprocesses, so hook-origin rows + no hook wired = the arm
# was killed. A pool without hook-origin rows (middleware-only capture, ADR-051
# — or a pre-source schema) is a WARN: capture may be by design fleet-driven,
# and FAILing it would false-positive every middleware-only project (caught by
# the fresh-target fixtures on first run). When wired, a staleness advisory
# compares the newest experience against the newest session record — sessions
# much newer than the last capture suggest the hooks fire but never land
# (timeout/npx cold-start class) → WARN, never FAIL (a chat-only session
# legitimately captures nothing).
# ── Probe #13: in-process embedder liveness (EMBEDDER-LIVENESS-V1) ───────────
# DRIVE the embedder and classify the vector's GEOMETRY. Every cheaper proxy is
# a check that cannot tell:
#   · require.resolve  — a resolvable package with a broken native binding still
#                        yields dead embeddings
#   · isTransformerAvailable() — a latch that reads false before AND after failure
#   · the stored `model` column — it says all-MiniLM-L6-v2 even for hash-proxy rows
#   · dimension_guard  — a hash proxy is exactly 384-dim and exactly 1536 bytes
# The one assertion that survives all of those is "a real dense vector came back".
# cosVsHash is the discriminator that catches the SILENT hash-proxy substitution:
# the fallback is deterministic, so we recompute it locally (embedding-utils.js's
# 3-pass sin/charCode loop) and compare. Measured separation on a healthy host:
# nzFrac 1.00 / cosVsHash -0.017, versus hash-proxy nzFrac 0.63-0.77 /
# cosVsHash 0.995-0.9997. Not knife-edge.
# KIT_VL_AQE_BASE overrides the base so a falsification fixture can prove teeth
# without uninstalling the package (KIT_HARVEST_NODE_BASE precedent).
probe_embedder_liveness() {
  local base rejs out state detail
  base="${KIT_VL_AQE_BASE:-$(npm root -g 2>/dev/null)}"
  rejs="$base/agentic-qe/dist/learning/real-embeddings.js"
  if [[ -z "$base" || ! -f "$rejs" ]]; then
    soft "embedder not assessable — agentic-qe real-embeddings.js absent (${rejs:-<unresolved>}) [not-assessable] (#13)"
    return
  fi
  out="$(node -e '
// 60s, not 25s: a WARM embedder answers in ~60ms and a DEAD one throws
// instantly, so this budget is never the thing being measured — it exists only
// for a cold model load. Too tight and the probe flips healthy/not-assessable
// under parallel-suite CPU contention, which turns proof x2 UNSTABLE for a
// reason that has nothing to do with the embedder.
const T=60000, TEXT="probe: embedder liveness";
// real-embeddings.js console.logs "[RealEmbeddings] Loading model: ..." on its
// own stdout. Left alone, that becomes the first token and the verdict parse
// below reads it as the state — a healthy embedder would report not-assessable.
// Keep stdout for the verdict ONLY; diagnostics go to stderr.
for (const k of ["log","info","warn","debug"]) console[k]=(...a)=>{try{process.stderr.write(a.join(" ")+"\n")}catch(e){}};
const run=(async()=>{
  const m=await import("file://"+process.argv[1]);
  if(typeof m.computeRealEmbedding!=="function") return ["not-assessable","module exports no computeRealEmbedding"];
  const v=await m.computeRealEmbedding(TEXT);
  if(!v||!v.length) return ["broken","embedder returned an empty vector"];
  const a=Array.from(v), n=a.length;
  const nz=a.filter(x=>x!==0).length/n;
  const norm=Math.sqrt(a.reduce((s,x)=>s+x*x,0));
  const h=new Array(n).fill(0), s=TEXT.toLowerCase().trim();
  for(let p=0;p<3;p++) for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);h[(c*(i+1)*(p+1))%n]+=Math.sin(c*(p+1))/(i+1);}
  const hn=Math.sqrt(h.reduce((t,x)=>t+x*x,0))||1;
  let d=0; for(let i=0;i<n;i++) d+=a[i]*(h[i]/hn);
  const cos=norm?d/norm:0;
  const st=`dim=${n} nzFrac=${nz.toFixed(3)} norm=${norm.toFixed(4)} cosVsHash=${cos.toFixed(4)}`;
  if(norm===0||nz===0) return ["broken","all-zero vector ("+st+")"];
  if(cos>0.99) return ["broken","HASH-PROXY fallback, not MiniLM ("+st+")"];
  if(n!==384) return ["broken","unexpected dimension ("+st+")"];
  if(nz<0.95) return ["broken","sparse vector ("+st+")"];
  return ["healthy",st];
})();
Promise.race([run,new Promise(r=>setTimeout(()=>r(["not-assessable","timed out after "+T+"ms"]),T))])
 .then(o=>{process.stdout.write(o[0]+" "+o[1]);process.exit(0)})
 .catch(e=>{process.stdout.write("broken "+String((e&&e.message)||e).replace(/\s+/g," ").slice(0,220));process.exit(0)});
' "$rejs" 2>/dev/null)"
  # Belt and braces: take the LAST stdout line, so any stray print that still
  # escapes cannot displace the verdict.
  out="$(printf '%s' "$out" | tail -1)"
  state="${out%% *}"; detail="${out#* }"
  case "$state" in
    healthy) ok "in-process embedder LIVE — $detail (#13)" ;;
    broken)  bad "in-process embedder DEAD: $detail — capture rows will carry NULL or fake vectors and every downstream store degrades silently. Heal: bin/ruflo-kit sync $TARGET_DIR (AQE-EMBEDDER-RESOLVE-V1) (#13)" ;;
    *)       soft "embedder not assessable — ${detail:-no verdict from probe} [not-assessable] (#13)" ;;
  esac
}

# ── Probe #14: capture input diversity (CAPTURE-DIVERSITY-V1) ────────────────
# A healthy embedder is NOT sufficient: a stale .claude/hooks/aqe-hook.cjs that
# spawns with stdio ['ignore',...] discards the stdin the CLI's file-path
# fallback needs, so every captured row lands as the content-free string
# "<domain>: edit: " with the path missing. Observed: 3137 of 3139 eligible rows
# identical on one target, which trained its LoRA 5611 times on ~1 direction
# (25x this repo's adaptation-norm sum, 43x its max |B|).
# Measured over the EXACT embedding recipe text, since two rows with different
# `task` can still collapse to one vector. Healthy baseline here: modeShare
# 0.087-0.200. Broken target: 0.9994. Thresholds sit 3x above healthy and well
# below broken. The stale-shim grep is a HINT in the message, never the
# assertion — modeShare is the property.
probe_capture_diversity() {
  local n mode share pct empty_mode
  n="$(sqlite_count_safe "$AQE_DB" "SELECT COUNT(*) FROM (SELECT 1 FROM captured_experiences WHERE success=1 AND quality>=0.7 ORDER BY rowid DESC LIMIT 200);")"
  if [[ "${n:-0}" -lt 50 ]]; then
    note "capture diversity not assessable — only ${n:-0} eligible rows (need 50) [not-assessable] (#14)"
    return
  fi
  mode="$(sqlite_count_safe "$AQE_DB" "SELECT MAX(c) FROM (SELECT COUNT(*) c FROM (SELECT domain,task FROM captured_experiences WHERE success=1 AND quality>=0.7 ORDER BY rowid DESC LIMIT 200) GROUP BY domain||': '||task);")"
  [[ -z "$mode" || "$mode" -le 0 ]] && { note "capture diversity not assessable — mode query returned nothing [not-assessable] (#14)"; return; }
  pct=$(( mode * 100 / n ))
  # An empty-payload mode (recipe text ending in ':' — the stale-shim signature)
  # is never legitimate, so it trips well below the general gate.
  empty_mode="$(sqlite_count_safe "$AQE_DB" "SELECT COUNT(*) FROM (SELECT domain,task FROM captured_experiences WHERE success=1 AND quality>=0.7 AND trim(domain||': '||task) LIKE '%:' ORDER BY rowid DESC LIMIT 200);")"
  if [[ "${empty_mode:-0}" -gt 0 ]] && [[ $(( empty_mode * 100 / n )) -gt 30 ]]; then
    bad "capture payload EMPTY in $(( empty_mode * 100 / n ))% of the last $n rows — the recipe text ends at ':' with no file path, so they all embed to ONE vector and collapse Sink A. Likely a stale .claude/hooks/aqe-hook.cjs spawning with stdio ['ignore',...] (upstream uses ['inherit','pipe','pipe']), which discards the stdin the file-path fallback reads. Heal: bin/ruflo-kit fix-aqe $TARGET_DIR (#14)"
  elif [[ "$pct" -gt 60 ]]; then
    bad "capture diversity COLLAPSED — one text is ${pct}% of the last $n eligible rows; Sink A would train repeatedly on a single vector (#14)"
  elif [[ "$pct" -ge 35 ]]; then
    soft "capture diversity low — one text is ${pct}% of the last $n eligible rows (healthy is <35%) (#14)"
  else
    ok "capture inputs diverse — most common text is ${pct}% of the last $n eligible rows (#14)"
  fi
}

# ── Probe #15: capture embed OUTCOME (EMBED-OUTCOME-V1) ──────────────────────
# #13 asks "can the embedder work"; this asks "did the vector actually land".
# They are NOT the same question, and today this repo proves it: #13 PASSes on a
# healthy embedder while 100% of new rows land with embedding NULL. Mechanism is
# in the installed dist (hooks-AGE3HCFI.js): the hook INSERTs the row, then fires
# an UN-AWAITED async IIFE that embeds and UPDATEs, wrapped in a bare `catch{}`.
# Nothing awaits it and nothing logs it, so under host contention the subprocess
# exits before the ~135ms embed completes and the vector is lost silently.
#
# GRACE WINDOW is the whole design problem: that embed is async-after, so the
# freshest rows legitimately have no vector yet. Measured longitudinally (diff
# the NULL id-set over time, since the schema records no embed time): max
# observed fill latency 33 min, and filling is BURSTY — one target read ~30%
# NULL at 15-60min old, then 0% four minutes later. 60 min is 1.8x the max
# latency and one stabilization interval past where the measurement stops
# moving, so it tolerates the burst rather than crying wolf on it.
#
# THRESHOLDS from the worst rolling 200-row window across both targets: the
# known-good regime is not "near zero", it is ZERO over 3362 rows / 2964
# windows. The partial-loss regime peaks at 29%. FAIL at 50% therefore sits
# 1.7x above the worst degraded window and at half the broken regime.
#
# NB: harvest opens the pool READ-ONLY and never writes back, so HARVEST-EMBED-V1's
# derived vectors do not fill this column — it is a pure capture-path signal.
probe_embed_outcome() {
  local db="$AQE_DB" ok tbl col n nul pct age
  # ONE source for the grace window — tools/aqe-embed-sweep.cjs must use the
  # same value (GRACE_MINUTES there). If they drift, the sweep either races the
  # capture path's own pending UPDATE or fills rows this probe is still counting.
  local GRACE_MINUTES=60
  local graced="completed_at <= datetime('now','-${GRACE_MINUTES} minutes')"
  if [[ ! -f "$db" ]]; then
    note "capture embed outcome not assessable — no AQE store at $db [not-assessable] (#15)"; return
  fi
  # Openability FIRST: without it a corrupt file makes the sqlite_master query
  # come back empty and the probe blames a missing table — a wrong reason.
  ok="$(sqlite_count_safe "$db" "SELECT 1;")"
  if [[ "$ok" != "1" ]]; then
    soft "capture embed outcome not assessable — store unreadable (locked, corrupt, or no sqlite instrument) [not-assessable] (#15)"; return
  fi
  tbl="$(sqlite_count_safe "$db" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='captured_experiences';")"
  [[ "${tbl:-0}" -eq 0 ]] && { note "capture embed outcome not assessable — captured_experiences table absent (fresh AQE store) [not-assessable] (#15)"; return; }
  col="$(sqlite_count_safe "$db" "SELECT COUNT(*) FROM pragma_table_info('captured_experiences') WHERE name='embedding';")"
  [[ "${col:-0}" -eq 0 ]] && { note "capture embed outcome not assessable — pre-embedding schema (no embedding column) [not-assessable] (#15)"; return; }

  n="$(sqlite_count_safe "$db" "SELECT COUNT(*) FROM (SELECT 1 FROM captured_experiences WHERE $graced ORDER BY completed_at DESC LIMIT 200);")"
  if [[ "${n:-0}" -lt 50 ]]; then
    note "capture embed outcome not assessable — only ${n:-0} row(s) past the 60m grace window (need 50) [not-assessable] (#15)"; return
  fi
  # COALESCE is load-bearing: SUM() over an empty set is NULL, and a NULL here
  # would render as an empty string — indistinguishable from a failed read.
  nul="$(sqlite_count_safe "$db" "SELECT COALESCE(SUM(embedding IS NULL),0) FROM (SELECT embedding FROM captured_experiences WHERE $graced ORDER BY completed_at DESC LIMIT 200);")"
  # ANTI-LAUNDERING: `ruflo-kit embed-sweep` fills this same column. A row it
  # filled proves nothing about the CAPTURE path, which is what this probe
  # measures — and unlike probe #16's hash proxies there is NO geometric tell,
  # because a correct sweep writes byte-identical vectors to a correct capture
  # (verified: cosine 1.000000). The kit-owned ledger is the only possible
  # discriminator, so count swept rows as still-lost. Without this, running the
  # remedy would turn the verdict green while the defect it reports is untouched
  # — the kit laundering its own evidence.
  local swept=0
  if [[ -f "$TARGET_DIR/.swarm/embed-sweep-state.json" ]]; then
    swept="$(node -e '
const fs=require("fs"),cp=require("child_process"),path=require("path");
const PROJ=process.argv[1];
let ids=[];try{ids=JSON.parse(fs.readFileSync(path.join(PROJ,".swarm","embed-sweep-state.json"),"utf8")).sweptIds||[]}catch(e){process.stdout.write("0");process.exit(0)}
if(!ids.length){process.stdout.write("0");process.exit(0)}
const set=new Set(ids);
let Database=null;
try{const g=cp.execSync("npm root -g",{stdio:["ignore","pipe","ignore"],timeout:10000}).toString().trim();
  for(const c of [path.join(g,"agentic-qe","node_modules","better-sqlite3"),path.join(g,"better-sqlite3")]){try{Database=require(c);break}catch(e){}}}catch(e){}
if(!Database){process.stdout.write("0");process.exit(0)}
try{const db=new Database(path.join(PROJ,".agentic-qe","memory.db"),{readonly:true,fileMustExist:true});
  const rows=db.prepare("SELECT id FROM captured_experiences WHERE completed_at <= datetime(\x27now\x27,\x27-'"$GRACE_MINUTES"' minutes\x27) ORDER BY completed_at DESC LIMIT 200").all();
  db.close();
  process.stdout.write(String(rows.filter(r=>set.has(r.id)).length));
}catch(e){process.stdout.write("0")}
' "$TARGET_DIR" 2>/dev/null)"
    [[ "$swept" =~ ^[0-9]+$ ]] || swept=0
  fi
  pct=$(( (${nul:-0} + swept) * 100 / n ))
  # Surface the window's age so a verdict describing a long-dead regime is
  # self-evident rather than silently stale.
  age="$(sqlite_count_safe "$db" "SELECT CAST((julianday('now')-julianday(MAX(completed_at)))*1440 AS INTEGER) FROM (SELECT completed_at FROM captured_experiences WHERE $graced ORDER BY completed_at DESC LIMIT 200);")"
  local when="newest graced row ${age:-?}m old"
  [[ "${swept:-0}" -gt 0 ]] && when="$when; ${swept} of them kit-swept (counted as lost — the sweep fills the column, it does not fix capture)"
  # Report the EFFECTIVE lost count (NULL + kit-swept), not the raw NULL count —
  # after a sweep the raw count is 0 while the capture path is just as broken,
  # and "0 of 200 (100%)" reads like an instrument fault.
  local lost=$(( ${nul:-0} + ${swept:-0} ))
  if [[ "$pct" -ge 50 ]]; then
    # Deliberately does NOT name sync/fix-aqe: the embedder is not the fault here
    # and no kit verb repairs this. Naming one would be a false instruction.
    bad "capture embed DEAD: ${lost} of ${n} graced rows (${pct}%) have NO vector — the capture hook's un-awaited embed loses its race with subprocess exit (bare catch{}, upstream), so these rows never carry a vector in the pool. Harvest can still derive at replay time; the pool column stays empty. ${when} (#15)"
  elif [[ "$pct" -gt 2 ]]; then
    soft "capture embed LEAKING: ${pct}% of the last ${n} graced rows have no vector (healthy is 0%) — partial vector loss, cause unresolved. ${when} (#15)"
  else
    ok "capture embeds land: ${pct}% of the last ${n} graced rows lack a vector. ${when} (#15)"
  fi
}

# ── Probe #16: stored-vector provenance (STORED-VECTOR-PROVENANCE-V1) ────────
# A repaired embedder does NOT repair vectors already written. Hash-proxy rows
# are 384-dim, 1536 bytes and unit-norm, so dimension_guard passes them
# byte-identically; and the `model` column records the WRITER, not the embedder
# — measured here, one label covered 139 proxies AND 51 genuine rows.
# Geometry is the discriminator: genuine MiniLM vectors are fully dense
# (nzFrac exactly 1.000), hash proxies are sparse (0.63-0.78). Measured against
# the definitive cosine-vs-hash test on 502 real rows across two targets: they
# agreed on every single row, 0 disagreements. Geometry is preferred because the
# cosine test needs the row's exact source text, and at least three writers with
# three different text recipes populate this table (one of which accepts a
# caller-supplied vector whose text is not recoverable from the DB at all).
# Scans rather than samples: contamination is episodic, so the newest-64 sample
# read 95% while the full table read 69%. Cost is process startup, not rows.
probe_stored_vector_provenance() {
  local db="$AQE_DB" out state detail
  if [[ ! -f "$db" ]]; then
    note "stored-vector provenance not assessable — no AQE store [not-assessable] (#16)"; return
  fi
  out="$(node -e '
const fs=require("fs"),path=require("path"),cp=require("child_process");
const DB=process.argv[1];
let Database=null;
for (const c of (()=>{try{const g=cp.execSync("npm root -g",{stdio:["ignore","pipe","ignore"],timeout:10000}).toString().trim();
  return [path.join(g,"agentic-qe","node_modules","better-sqlite3"),path.join(g,"better-sqlite3"),path.join(g,"ruflo","node_modules","better-sqlite3")];}catch(e){return[]}})())
  { try { Database=require(c); break; } catch(e){} }
if(!Database){process.stdout.write("not-assessable no loadable better-sqlite3 (cannot read vector blobs)");process.exit(0)}
if(!fs.existsSync(DB)){process.stdout.write("not-assessable no AQE store");process.exit(0)}
let db; try{ db=new Database(DB,{readonly:true,fileMustExist:true}); }
catch(e){ process.stdout.write("not-assessable store unreadable ("+String(e.message||e).replace(/\s+/g," ").slice(0,90)+")"); process.exit(0) }
let rows=[];
try{
  const t=db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type=\x27table\x27 AND name=\x27qe_pattern_embeddings\x27").get();
  if(!t||!t.c){ process.stdout.write("not-assessable qe_pattern_embeddings table absent"); process.exit(0) }
  rows=db.prepare("SELECT embedding FROM qe_pattern_embeddings LIMIT 5000").all();
}catch(e){ process.stdout.write("not-assessable table read failed ("+String(e.message||e).replace(/\s+/g," ").slice(0,90)+")"); process.exit(0) }
finally{ try{db.close()}catch(e){} }
if(rows.length<20){ process.stdout.write("not-assessable only "+rows.length+" stored pattern vector(s) (need 20)"); process.exit(0) }
let proxy=0,lo=1,hi=0;
for(const r of rows){
  const b=r.embedding; if(!b||!b.byteLength) continue;
  const v=new Float32Array(b.buffer,b.byteOffset,b.byteLength/4);
  let nz=0; for(let i=0;i<v.length;i++) if(v[i]!==0) nz++;
  const f=nz/v.length;
  if(f<0.95){ proxy++; if(f<lo)lo=f; if(f>hi)hi=f; }
}
const pct=Math.round(proxy*100/rows.length);
if(proxy===0) process.stdout.write("healthy all "+rows.length+" stored pattern vectors are dense (genuine MiniLM)");
else process.stdout.write((pct>=25?"broken":"warn")+" "+proxy+" of "+rows.length+" stored pattern vectors ("+pct+"%) are HASH PROXIES (nzFrac "+lo.toFixed(2)+"-"+hi.toFixed(2)+" vs 1.000 genuine)");
' "$db" 2>/dev/null)"
  out="$(printf '%s' "$out" | tail -1)"
  state="${out%% *}"; detail="${out#* }"
  case "$state" in
    healthy) ok "stored vectors genuine — $detail (#16)" ;;
    warn)    soft "stored vectors partially contaminated: $detail — the model column does NOT distinguish them; a repaired embedder does not repair these rows (#16)" ;;
    broken)  bad "STORED VECTORS CONTAMINATED: $detail. All carry a MiniLM model label, so the column cannot tell them apart. They poison HNSW recall, and fixing the embedder does NOT repair them — they must be re-embedded or purged (#16)" ;;
    *)       note "stored-vector provenance not assessable — ${detail:-no verdict} [not-assessable] (#16)" ;;
  esac
}

probe_capture_inflow() {
  local pool wired=0 exp_ts gap_h
  pool="$(count_tbl "$AQE_DB" captured_experiences)"
  kit_aqe_capture_wired "$TARGET_DIR" && wired=1
  if [[ "$pool" -eq 0 ]]; then
    if [[ "$wired" -eq 1 ]]; then
      note "capture inflow wired, pool empty — experiences appear once live sessions do real work (#12)"
    else
      note "no capture hooks and empty pool — AQE capture not configured here (#12)"
    fi
    return
  fi
  if [[ "$wired" -eq 0 ]]; then
    local cli_rows
    cli_rows="$(sqlite_count_safe "$AQE_DB" "SELECT COUNT(*) FROM captured_experiences WHERE source LIKE 'cli-hook-%';")"
    if [[ "$cli_rows" -gt 0 ]]; then
      bad "capture arm UNWIRED: $cli_rows hook-captured experience(s) (source cli-hook-%) exist but .claude/settings.json has NO aqe capture hook (post-edit/post-task/post-command) — the arm that captured them is GONE and the pool is FROZEN; every future harvest replays nothing new. A --force re-init likely clobbered the hooks. Restore the stock aqe hook set, then: ruflo-kit fix-aqe $TARGET_DIR (INFLOW-LIVENESS-V1)"
    else
      soft "capture hooks not wired ($pool experience(s), none hook-originated — middleware/fleet capture only): Claude-session work is NOT being captured; wire the stock aqe hooks if that is unintended (#12)"
    fi
    return
  fi
  exp_ts="$(kit_sqlite_ro "$AQE_DB" "SELECT MAX(completed_at) FROM captured_experiences;" 2>/dev/null | head -1)"
  # Hours the newest session record post-dates the newest capture; -1 = not
  # assessable (no session records / unparseable timestamp). Date math in node
  # (portable across GNU/BSD date).
  gap_h="$(EXP_TS="$exp_ts" node -e '
    const fs=require("fs"),p=".claude-flow/sessions";
    let m=0;try{for(const f of fs.readdirSync(p))if(/^session-.*\.json$/.test(f))m=Math.max(m,fs.statSync(p+"/"+f).mtimeMs);}catch(e){}
    const e=Date.parse((process.env.EXP_TS||"").replace(" ","T")+"Z");
    if(!m||isNaN(e)){process.stdout.write("-1");process.exit(0);}
    process.stdout.write(String(Math.floor((m-e)/3600000)));' 2>/dev/null || echo -1)"
  if [[ "$gap_h" =~ ^[0-9]+$ ]] && [[ "$gap_h" -gt 24 ]]; then
    soft "capture inflow STALE: newest experience is ${gap_h}h older than the newest session record (newest capture: ${exp_ts:-unknown}) — hooks are wired but may not be landing (check .agentic-qe/hooks-health.log) (#12)"
  else
    ok "capture inflow live: hooks wired, pool=$pool (newest capture: ${exp_ts:-unknown}) (#12)"
  fi
}

# #4 native HNSW backend. The authoritative flag lives in the ruvector FLAGS
# STORE (read via `aqe ruvector status`), NOT config.yaml — and it is ON by
# default. So `config.yaml` lacking the key is NOT evidence of a problem (the
# old probe false-FAILed on every project). We FAIL only when the flag is
# EXPLICITLY false; config.yaml is a weak fallback used only when aqe can't be
# queried. RUVECTOR_HNSW (true|false|"") is resolved once in the run section.
probe_hnsw_native() {
  local vec; vec="$(count_tbl "$AQE_DB" vectors)"
  if [[ "${RUVECTOR_HNSW:-}" == "false" ]]; then
    bad "HNSW native backend DISABLED: useNativeHNSW=false (ruvector flags) — run: aqe ruvector flags --set useNativeHNSW=true && aqe learning repair"
  elif [[ "${RUVECTOR_HNSW:-}" == "true" ]]; then
    if [[ "$vec" -gt 0 ]]; then ok "native HNSW enabled (useNativeHNSW=true, AQE vectors=$vec)"
    else note "native HNSW enabled (no AQE vectors yet)"; fi
  elif grep -q 'useNativeHNSW' "$AQE_CONFIG" 2>/dev/null; then
    ok "useNativeHNSW codified in config.yaml (AQE vectors=$vec)"
  else
    note "native HNSW flag indeterminate (aqe ruvector status unavailable; AQE vectors=$vec)"
  fi
}

# #6 dimension guard (defensive — issue's 1536-vs-384 claim was a byte/dim
# misread; this asserts the real invariant instead of "fixing" a non-bug).
probe_dimension_guard() {
  local res; res="$(assert_vector_dim_ok "$AQE_DB" vectors embedding dimensions 384)"
  case "$res" in
    OK)                 ok "dimension guard: all AQE vectors 384-dim, blob=dimensions*4" ;;
    EMPTY|NO_TABLE)     note "dimension guard: no vectors to check" ;;
    DIM_MISMATCH:*|BLOB_MISMATCH:*)
                        bad "dimension guard FAILED: $res (expected 384-dim, blob=dimensions*4)" ;;
    *)                  soft "dimension guard inconclusive ($res)" ;;
  esac
}

# #9 graphAdapter: relationship graph never populated. Non-fatal.
probe_graph_edges() {
  local ge; ge="$(count_tbl "$SWARM_DB" graph_edges)"
  if [[ "$ge" -eq 0 && "${RUFLO_ME:-0}" -gt 0 ]]; then
    soft "graph_edges=0 (graphAdapter not wiring relationships) — non-fatal (#9)"
  else
    ok "graph_edges=$ge"
  fi
}

# #10 SONA table unpopulated (3-way SONA split unconsolidated). Non-fatal.
probe_sona() {
  local sp; sp="$(count_tbl "$AQE_DB" sona_patterns)"
  if [[ "$sp" -eq 0 ]]; then
    soft "AQE sona_patterns=0 (SONA table unpopulated; 3-way SONA split unconsolidated) — non-fatal (#10)"
  else
    ok "sona_patterns=$sp"
  fi
}

# #7 router liveness — informational, never fails (issue claimed totalRouted:0;
# disk shows it IS live at the hooks layer).
probe_router_info() {
  local td ro
  td="$(json_num "$ROUTER_STATE" "j.totalDecisions" 0)"
  ro="$(count_tbl "$AQE_DB" routing_outcomes)"
  note "router live: model-router totalDecisions=$td, AQE routing_outcomes=$ro (#7)"
}

# Daemon advisory (non-fatal). A RUNNING ruflo daemon holds DB locks (so
# fix-learning's dream step fails "database is locked") and caches state in
# memory — so a just-run fix-learning may not be reflected until the daemon AND
# Claude Code are restarted. Surfaced as a WARN so the "still hollow after a fix"
# case is self-explaining.
#
# DRY-RUN-ARTIFACT-V1 (B24): this used to shell out to `ruflo daemon status`,
# whose upstream side effect of instantiating internal config objects just to
# print a table creates .claude-flow/logs/daemon.log even on this read-only
# probe — exactly the leak `sync --dry-run` was found leaving behind (no
# daemon is spawned by it; ensureDaemonRunning is skipped for the `daemon`
# subcommand — this is a truthfulness defect, not a billing one). Replaced with
# kit_daemon_ps_lines (common.sh), the same pgrep-based discovery status.sh and
# proof.sh already treat as this kit's canonical daemon truth ("state files
# lie — trust pgrep").
#
# B24-DAEMON-SCOPE-V1 (critic-found regression, fixed here): kit_daemon_ps_lines
# is UNSCOPED by design (it "mirrors BOTH existing sites", status.sh/proof.sh,
# which deliberately want the global "any daemon anywhere" view). The FIRST cut
# of this fix consumed it directly and kept the old call's target-specific
# causal wording ("it locks the DBs") — false the moment a DIFFERENT project's
# ruflo daemon happened to be running on the same host (reproduced live: a
# stray daemon for an unrelated workspace made this probe warn about DBs it
# does not lock, on the same host where `ruflo daemon status` correctly
# reported this target as stopped). kit_daemon_scope_split (common.sh) restores
# workspace scoping via a genuine TRI-STATE (see its header for the MINE/OTHER/
# UNKNOWN contract and the parent/subdirectory design decision): only a MINE
# daemon gets the causal "it locks the DBs" claim; OTHER is an informational
# note that must not read as if it affects this target; UNKNOWN is hedged,
# never silently folded into either bucket. Applies in every mode, not just
# --dry-run — no CLI call either way, so no side effect to gate on.
probe_daemon_advisory() {
  local rows pid state ws
  local mine_pids=() other_notes=() unknown_pids=()
  rows="$(kit_daemon_scope_split "$TARGET_DIR" 2>/dev/null)"
  [[ -z "$rows" ]] && return 0
  while IFS=$'\t' read -r pid state ws; do
    [[ -z "$pid" ]] && continue
    case "$state" in
      MINE)    mine_pids+=("$pid") ;;
      OTHER)   other_notes+=("pid $pid → $ws") ;;
      UNKNOWN) unknown_pids+=("$pid") ;;
    esac
  done <<< "$rows"

  if [[ ${#mine_pids[@]} -gt 0 ]]; then
    local pids; pids="$(IFS=,; echo "${mine_pids[*]}")"
    soft "ruflo daemon is RUNNING for THIS target (pid ${pids}) — it locks the DBs (fix-learning 'dream' fails locked) and caches state; restart the daemon + Claude Code after a fix, then re-verify"
  fi
  if [[ ${#unknown_pids[@]} -gt 0 ]]; then
    local pids; pids="$(IFS=,; echo "${unknown_pids[*]}")"
    soft "ruflo daemon proc(s) found with no --workspace visible in argv (pid ${pids}) — scope could not be determined; this MAY belong to this target (operator? check with: ps -p ${pids} -o args=)"
  fi
  if [[ ${#other_notes[@]} -gt 0 ]]; then
    local joined; joined="$(IFS='; '; echo "${other_notes[*]}")"
    note "ruflo daemon(s) running for a DIFFERENT workspace — do not lock this target's DBs: $joined"
  fi
}

# Root-resolution hijack advisory (non-fatal). ≤3.10.3 findProjectRoot() took the TOPMOST
# .agentic-qe walking up from cwd; 3.10.4 takes NEAREST + honors AQE_PROJECT_ROOT first.
# On ≤3.10.3, if ~/.agentic-qe exists ABOVE the project, every
# AQE process NOT pinned with AQE_PROJECT_ROOT (the MCP server `aqe-mcp`, the daemon,
# ad-hoc `aqe` calls) resolves there instead of the project — silently writing this
# project's learning into the HOME brain (cross-project leak; cwd does not help).
probe_root_hijack() {
  local home_aqe="$HOME/.agentic-qe"
  [[ -d "$home_aqe" ]] || return 0
  case "$TARGET_DIR/" in "$HOME/"*) ;; *) return 0 ;; esac   # only when target lives UNDER $HOME
  [[ "$TARGET_DIR" == "$HOME" ]] && return 0                  # target IS home — not a hijack
  # aqe 3.10.4 picks NEAREST + honors AQE_PROJECT_ROOT first, so the ancestor ~/.agentic-qe
  # can no longer hijack root resolution. Only raise the strong warning on ≤3.10.3 or unknown.
  local ver; ver="$(aqe_installed_version)"
  if [[ -n "$ver" ]] && ! aqe_semver_lt "$ver" "3.10.4"; then
    soft "ancestor ~/.agentic-qe present but harmless on aqe $ver (≥3.10.4 nearest-wins prevents the hijack; AQE_PROJECT_ROOT pins make it moot) — leftover housekeeping; remove it if you like"
    return 0
  fi
  soft "root-hijack target present: ~/.agentic-qe sits ABOVE this project → findProjectRoot routes unpinned AQE processes (aqe-mcp, daemon) to the HOME brain. Ensure the AQE_PROJECT_ROOT pins are applied (ruflo-kit fix-aqe $TARGET_DIR) and consider removing ~/.agentic-qe"
}

# ── run ─────────────────────────────────────────────────────────────────────
RUFLO_ME=0; RUFLO_STRUCT=0; LORA_TA=0
# Authoritative native-HNSW flag from the ruvector flags store (true|false|""),
# resolved ONCE. This is the source of truth for #4 — config.yaml is not.
#
# DRY-RUN-ARTIFACT-V1 (B24): `aqe ruvector status` has an upstream side effect
# of instantiating internal config objects just to print a table, which
# creates .agentic-qe/ on disk even for this read-only probe. Unlike the
# daemon check above, there is no disk file to substitute: reading the
# installed aqe dist confirms useNativeHNSW is pure in-memory module state
# (a hardcoded default merged with env vars at process start — no flags file
# is ever written, so a stale on-disk read would just be a second CLI-shaped
# guess, not a truer one). Under --dry-run we skip the call rather than
# fabricate a disk read that cannot exist, falling back only as far as the one
# input that IS on disk-adjacent ground truth — the env var the CLI itself
# would honor (RUVECTOR_USE_NATIVE_HNSW). probe_hnsw_native already degrades
# to config.yaml / "indeterminate" when RUVECTOR_HNSW is empty, so an
# unresolved flag under dry-run reports honestly rather than silently.
RUVECTOR_HNSW=""
RUVECTOR_HNSW_NOTE=""
if [[ "${DRY_RUN:-0}" -eq 1 ]]; then
  if [[ -n "${RUVECTOR_USE_NATIVE_HNSW:-}" ]]; then
    RUVECTOR_HNSW="$(tr 'A-Z' 'a-z' <<< "$RUVECTOR_USE_NATIVE_HNSW")"
    RUVECTOR_HNSW_NOTE="[dry-run] useNativeHNSW resolved from env RUVECTOR_USE_NATIVE_HNSW=$RUVECTOR_HNSW — skipped: would run 'aqe ruvector status' (creates .agentic-qe/ as an upstream side effect)"
  else
    RUVECTOR_HNSW_NOTE="[dry-run] skipped: would run 'aqe ruvector status' (creates .agentic-qe/ as an upstream side effect) — no on-disk flags store exists to substitute; native-HNSW probe below falls back to config.yaml/indeterminate"
  fi
elif command -v aqe >/dev/null 2>&1; then
  RUVECTOR_HNSW="$(aqe ruvector status 2>/dev/null | grep -iE 'useNativeHNSW' | grep -oiE 'true|false' | head -1 | tr 'A-Z' 'a-z')"
fi
if [[ "$JSON" -eq 0 ]]; then
  header "verify-learning" "ruflo + AQE self-learning loop liveness (read-only)"
  kit_banner
  echo ""
fi
[[ -n "$RUVECTOR_HNSW_NOTE" ]] && note "$RUVECTOR_HNSW_NOTE"
# Instrument transparency (KIT-SQLITE-SHIM-V1): with NO sqlite backend at all
# every count below reads 0 and a hollow store would grade as fresh — surface
# that masking as a WARN (verdict can then never be better than "partial").
SQLITE_BACKEND="$(kit_sqlite_backend)"
if [[ "$SQLITE_BACKEND" == "none" ]]; then
  soft "no sqlite instrument (sqlite3 CLI absent, global better-sqlite3 unloadable) — all store counts read 0; verdict may MASK a hollow loop"
elif [[ "$SQLITE_BACKEND" == "node" ]]; then
  note "store reads via node better-sqlite3 fallback (sqlite3 CLI not installed)"
fi
probe_embedder_liveness
probe_embed_outcome
probe_stored_vector_provenance
probe_capture_diversity
probe_reflexion_store
probe_lora_backend
probe_seam_sentinels
probe_capture_inflow
probe_hnsw_native
probe_dimension_guard
probe_graph_edges
probe_sona
probe_router_info
probe_daemon_advisory
probe_root_hijack

VERDICT="live"
[[ "$WARN" -gt 0 ]] && VERDICT="partial"
[[ "$FAIL" -gt 0 ]] && VERDICT="hollow"

if [[ "$JSON" -eq 1 ]]; then
  printf '{"pass":%d,"warn":%d,"fail":%d,"info":%d,"verdict":"%s"}\n' \
    "$PASS" "$WARN" "$FAIL" "$INFO" "$VERDICT"
else
  echo ""
  echo "  Summary: $PASS pass  $WARN warn  $FAIL fail  $INFO info"
  case "$VERDICT" in
    hollow)  fail "learning loop HOLLOW — run: bin/ruflo-kit fix-learning $TARGET_DIR" ;;
    partial) warn "learning loop partial (non-fatal warnings)" ;;
    live)    pass "learning loop live" ;;
  esac
fi

# Exit-code policy (CI): FAIL → 1 (real, actionable regression); WARN/clean → 0.
[[ "$FAIL" -gt 0 ]] && exit 1
exit 0
