#!/usr/bin/env bash
set -uo pipefail
# Note: -e intentionally omitted — ((var++)) returns 1 when var=0 under set -e.

# ============================================================================
# fix-aqe.sh — Codify the AQE-side hardening (companion to fix-ruflo.sh).
# Run from anywhere: bin/ruflo-kit fix-aqe <target> [--dry-run]
#
#   (1) AQE-PROMOTE-V1 — relax the `agent != 'cli-hook'` clause in the agentic-qe
#       `learning extract` candidate query that starved pattern distillation
#       (the 230+ highest-quality cli-hook experiences were excluded). The
#       quality>=0.7 / successRate>=0.7 integrity bars are untouched.
#   (2) .claude helper install — install ruflo-train.cjs + aqe-rag-inject.cjs
#       from assets/claude-helpers/ and wire .claude/settings.json:
#         · PostToolUse ^(Write|Edit|MultiEdit)$ += ruflo-train (dual ruflo+AQE
#           train on live edits — RUFLO-TRAIN-V1)
#         · PreToolUse ^(Task|Agent)$ += aqe-rag-inject (pre-task RAG retrieval —
#           AQE-RAG-INJECT-V1)
#         · enabledMcpjsonServers += claude-flow (MCP chip 3/3)
#   (3) AQE-DREAM-LOCKFIX-V2 — atomic claim across all 4 dream_cycle insert
#       paths + WAL checkpoint caller + startup/per-cycle orphan sweep.
#   (4) AQE-ROUTING-THRESHOLD-V1 — codify .agentic-qe/config.yaml
#       routing.confidenceThreshold = 0.6 (survives an aqe-init regen).
#   (5) CLAUDE-CMD-DOCS-V1 — install kit-maintained .claude/commands docs from
#       tracked assets/claude-commands/ (currently the analysis compliance report).
#   (6) AQE-POSTTASK-ARGS-V1 — normalize the stock post-task hook `aqe init`
#       generates (`--success` with no value -> success=0 on every trajectory;
#       no --agent -> agent='unknown'). Rewrites to `--success true` + real
#       --agent/--description so Task trajectories can promote into patterns.
#   (7) AQE-PROJECT-ROOT-PIN-V1 — pin settings.json env.AQE_PROJECT_ROOT=<target> so
#       the kernel's findProjectRoot() resolves deterministically (honored before any
#       cwd walk-up). Hardens SQLite-side resolution + future-proofs for the upstream
#       RVF fix. (≤3.10.3 RVF stores bypassed findProjectRoot — see #8; fixed
#       upstream in aqe 3.10.4: nearest-wins + RVF anchored to AQE_PROJECT_ROOT ?? findProjectRoot.)
#   (7b) AQE-MCP-ROOT-PIN-V1 — same pin in .mcp.json's agentic-qe server env, so the
#       long-lived `aqe-mcp` server stops resolving to ~/.agentic-qe via findProjectRoot's
#       topmost-.agentic-qe hijack (settings.json only covers hooks, not the MCP process).
#   (8) RVF-STRAY-SWEEP-V1 — advisory listing of RVF-only stray .agentic-qe dirs the
#       ≤3.10.3 cwd-relative RVF path resolution scattered across subfolders; 3.10.4
#       anchors RVF so the advisory now surfaces historical strays. Removal is gated
#       behind `fix-learning --cleanup --confirm`. Core helper in common.sh.
#
# Idempotent (sentinels / cmp / membership / value checks), reversible (.bak).
# Full rationale: docs/_INSTRUCTIONS.md Patches 21-22, 35, 41, 46.
# ============================================================================

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
kit_resolve "$@"
kit_require_target
cd "$TARGET_DIR"

HELPER_SRC="$KIT_ASSETS/claude-helpers"
CLAUDE_HELPERS="$TARGET_DIR/.claude/helpers"
SETTINGS="$TARGET_DIR/.claude/settings.json"

echo "============================================"
echo " fix-aqe — AQE distillation + .claude wiring"
echo " kit:    $KIT_DIR"
echo " target: $TARGET_DIR"
[[ "$DRY_RUN" -eq 1 ]] && echo " MODE: dry-run (no changes)"
echo "============================================"

# Locate the global agentic-qe install.
AQE_ROOT=""
for cand in "$(npm root -g 2>/dev/null)/agentic-qe" \
            "$(node -e 'try{console.log(require("path").dirname(require.resolve("agentic-qe/package.json")))}catch(e){}' 2>/dev/null)"; do
  [[ -n "$cand" && -f "$cand/package.json" ]] && { AQE_ROOT="$cand"; break; }
done

# ── Step 1: AQE-PROMOTE-V1 ──────────────────────────────────────────────────
header "1" "AQE distillation filter (AQE-PROMOTE-V1)"
if [[ -z "$AQE_ROOT" ]]; then
  warn "global agentic-qe not found (npm root -g) — skipping AQE-PROMOTE"
else
  Q="WHERE quality >= ? AND agent != 'cli-hook' GROUP BY domain HAVING COUNT(*) >= ?"
  QNEW="WHERE quality >= ? AND agent IS NOT NULL /* AQE-PROMOTE-V1 */ GROUP BY domain HAVING COUNT(*) >= ?"
  CHUNKS=()
  while IFS= read -r _c; do [[ -n "$_c" ]] && CHUNKS+=("$_c"); done < <(grep -rl "GROUP BY domain HAVING COUNT" "$AQE_ROOT/dist/cli/chunks/" 2>/dev/null | grep '\.js$')
  patched=0
  for f in "${CHUNKS[@]:-}"; do
    [[ -f "$f" ]] || continue
    if grep -q "AQE-PROMOTE-V1" "$f"; then pass "AQE-PROMOTE-V1 already present: $(basename "$f")"; patched=1; continue; fi
    grep -qF "$Q" "$f" || continue
    if [[ "$DRY_RUN" -eq 1 ]]; then info "[dry-run] would relax cli-hook filter in $(basename "$f")"; patched=1; continue; fi
    [[ -e "$f.aqe-promote-bak" ]] || cp "$f" "$f.aqe-promote-bak"
    QQ="$Q" QN="$QNEW" node -e 'const fs=require("fs"),F=process.argv[1];let s=fs.readFileSync(F,"utf8");s=s.split(process.env.QQ).join(process.env.QN);fs.writeFileSync(F,s)' "$f"
    if node --check "$f" 2>/dev/null; then fix "Relaxed cli-hook distillation filter (AQE-PROMOTE-V1): $(basename "$f")"; pass "patched $(basename "$f")"; patched=1
    else warn "AQE-PROMOTE produced invalid JS — restoring $(basename "$f")"; cp "$f.aqe-promote-bak" "$f"; fi
  done
  [[ "$patched" -eq 0 ]] && warn "candidate-query chunk not found (agentic-qe version drift?) — verify manually"
fi

# ── Step 2: .claude helper install + settings.json wiring ───────────────────
header "2" ".claude helpers + hook wiring"
if [[ ! -d "$HELPER_SRC" ]]; then
  warn "no assets/claude-helpers/ source dir — skipping helper install"
else
  mkdir -p "$CLAUDE_HELPERS"
  # _derive-outcome.cjs MUST install alongside its consumers: aqe-post-route.cjs and
  # ruflo-train-subagent.cjs `require('./_derive-outcome.cjs')` relative to __dirname,
  # so the oracle has to land in .claude/helpers/ too (listed first for clarity).
  for h in _derive-outcome.cjs ruflo-train.cjs ruflo-train-subagent.cjs aqe-rag-inject.cjs aqe-post-route.cjs ruflo-route-capture.cjs; do
    src="$HELPER_SRC/$h"; dst="$CLAUDE_HELPERS/$h"
    [[ -f "$src" ]] || { warn "missing source $h"; continue; }
    if cmp -s "$src" "$dst" 2>/dev/null; then pass "$h up to date"; continue; fi
    if [[ "$DRY_RUN" -eq 1 ]]; then info "[dry-run] would install $h"; continue; fi
    [[ -f "$dst" && ! -e "$dst.fixaqe-bak" ]] && cp "$dst" "$dst.fixaqe-bak"
    cp "$src" "$dst" && { node --check "$dst" 2>/dev/null && { fix "Installed .claude/helpers/$h"; pass "installed $h"; } || { warn "$h failed node --check"; }; }
  done

  # HELPER-MODULE-PIN-V1: in a "type":"module" project, the CJS helpers load as ES
  # modules and the PreCompact/SessionEnd hooks crash with "require is not defined".
  # Pin .claude/helpers/ to commonjs + relocate the ESM github-safe.js -> .mjs.
  case "$(pin_helpers_module_type "$TARGET_DIR")" in
    PINNED)          fix "Pinned .claude/helpers to commonjs (+github-safe.mjs)"; pass "helper module-type pinned (commonjs) — fixes hook 'require is not defined' in ESM projects" ;;
    ALREADY)         pass "helper module-type already pinned (commonjs)" ;;
    NOT_ESM_PROJECT) pass "project root is commonjs — no helper pin needed" ;;
    DRYRUN)          info "[dry-run] would pin .claude/helpers to commonjs (+github-safe.mjs)" ;;
    NO_DIR)          : ;;  # no .claude/helpers yet (run AQE/ruflo init first)
  esac

  if [[ ! -f "$SETTINGS" ]]; then
    warn "no .claude/settings.json — cannot wire hooks (run AQE/ruflo init first)"
  elif [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] would wire RAG + dual-train hooks + enabledMcpjsonServers"
  else
    [[ -e "$SETTINGS.fixaqe-bak" ]] || cp "$SETTINGS" "$SETTINGS.fixaqe-bak"
    WIRE="$(mktemp)"
    cat > "$WIRE" <<'NODE'
const fs = require('fs'); const F = process.argv[2];
let s; try { s = JSON.parse(fs.readFileSync(F, 'utf8')); } catch (e) { console.log('INVALID_JSON'); process.exit(0); }
s.hooks = s.hooks || {};
let changed = false;
function ensureHook(eventArr, matcher, cmd, tag, timeout) {
  // Dedup across ALL groups sharing this matcher (settings.json can contain
  // duplicate matcher groups) — only add if the tag is absent from every one.
  const groups = eventArr.filter(x => (x.matcher || '') === matcher);
  if (groups.some(g => (g.hooks || []).some(h => (h.command || '').includes(tag)))) return;
  let g = groups[0];
  if (!g) { g = { matcher: matcher, hooks: [] }; eventArr.push(g); }
  g.hooks = g.hooks || [];
  g.hooks.push({ type: 'command', command: cmd, timeout: timeout, continueOnError: true });
  changed = true;
}
const RAG = "sh -c \x27exec node \"${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/aqe-rag-inject.cjs\" \"$TOOL_INPUT_prompt\"\x27";
const TRAIN = "sh -c \x27exec node \"${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/ruflo-train.cjs\" \"$TOOL_INPUT_file_path\" 0.8\x27";
s.hooks.PreToolUse = s.hooks.PreToolUse || [];
ensureHook(s.hooks.PreToolUse, '^(Task|Agent)$', RAG, 'aqe-rag-inject', 8000);
s.hooks.PostToolUse = s.hooks.PostToolUse || [];
ensureHook(s.hooks.PostToolUse, '^(Write|Edit|MultiEdit)$', TRAIN, 'ruflo-train', 8000);
// Keep agentdb.db live: batch-replay fresh AQE experiences into it on session end
// (the harvester is idempotent via .swarm/harvest-state.json, opens the AQE source
// read-only, and self-checkpoints agentdb.db so the read-only statusline can read it).
// aqe-harvest lives in the KIT (not the target); run it by absolute kit path,
// with cwd = target so it reads the target's .agentic-qe DB. KITDIR injected via env at wire time.
const HARVEST = "sh -c \x27D=\"${CLAUDE_PROJECT_DIR:-.}\"; cd \"$D\" 2>/dev/null; node \"" + process.env.KITDIR + "/tools/aqe-harvest.cjs\" >/dev/null 2>&1 || true\x27";
s.hooks.SessionEnd = s.hooks.SessionEnd || [];
ensureHook(s.hooks.SessionEnd, '', HARVEST, 'aqe-harvest', 60000);
// Train the ruflo SONA LoRA on Task SUBAGENT completion (RUFLO-TRAIN-SUBAGENT-V1):
// ruflo-train.cjs only fires on Edit/Write, so research/analysis subagent work never
// fed the trainer. Reads the SubagentStop payload (transcript) on stdin, embeds the
// subagent output, and trains -> .swarm/lora-weights.json. continueOnError, never blocks.
const TRAINSUB = "sh -c \x27exec node \"${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/ruflo-train-subagent.cjs\"\x27";
s.hooks.SubagentStop = s.hooks.SubagentStop || [];
ensureHook(s.hooks.SubagentStop, '', TRAINSUB, 'ruflo-train-subagent', 30000);
// Replace the hardcoded constant `post-route --success true` Stop hook with the
// outcome-derived wrapper (aqe-post-route.cjs). First strip the legacy constant group
// so the constant-reward blocker doesn't linger, then wire the wrapper. (The wrapper
// feeds a derived BOOLEAN success — see its header for honest-scope caveats.)
const POSTROUTE = "sh -c \x27exec node \"${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/aqe-post-route.cjs\"\x27";
s.hooks.Stop = s.hooks.Stop || [];
const _stopBefore = s.hooks.Stop.length;
s.hooks.Stop = s.hooks.Stop.filter(function (g) { return !((g.hooks || []).some(function (h) { return (h.command || '').includes('post-route --success true'); })); });
if (s.hooks.Stop.length !== _stopBefore) changed = true;  // stripped the legacy constant-reward group
ensureHook(s.hooks.Stop, '', POSTROUTE, 'aqe-post-route', 8000);  // wire wrapper (sets changed if newly added)
// Capture ruflo's OWN route recommendation on each prompt (RUFLO-ROUTE-CAPTURE-V1) and
// stash {task,agent,ts} in .claude-flow/.ruflo-route.json. The Stop wrapper reads it to
// pair ruflo's pick with the turn outcome → populates routing-outcomes.json (the store the
// RUFLO-SEMRANK-V1 dist re-rank consumes). This is what closes the Router B loop in
// production (without it, the routed agent is unknown at Stop and the store stays empty).
const ROUTECAP = "sh -c \x27exec node \"${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/ruflo-route-capture.cjs\"\x27";
s.hooks.UserPromptSubmit = s.hooks.UserPromptSubmit || [];
ensureHook(s.hooks.UserPromptSubmit, '', ROUTECAP, 'ruflo-route-capture', 6000);
// AQE-POSTTASK-ARGS-V1: normalize the stock post-task hook that `aqe init` generates.
// Upstream emits `... post-task --task-id "$TOOL_RESULT_agent_id" --success --json`,
// but `--success <bool>` REQUIRES a value — commander consumes the next token ("--json")
// as the value, so `e.success!=="true"` => EVERY trajectory writes success=0, and --json
// is swallowed. It also passes no --agent, so the trajectory agent is "unknown". Both
// starve pattern distillation (qe_trajectories never promote). Fix in place, on the
// existing ^(Task|Agent)$ group where $TOOL_INPUT_subagent_type/$TOOL_RESULT_agent_id are
// real: (A) --success -> --success true; (B) add --agent "$TOOL_INPUT_subagent_type" +
// --description "$TOOL_INPUT_prompt" (the latter feeds upstream's domain/taskType bridge).
// NOTE: post-task has no --domain flag and Z() never sets it, so the trajectory's domain
// column stays 'general' regardless — out of scope here (would need a dist patch). Idempotent
// (skips if already '--success true'); rewrites only the agentic-qe post-task command string.
const PT_FIXED = 'npx agentic-qe hooks post-task --task-id "$TOOL_RESULT_agent_id" --agent "$TOOL_INPUT_subagent_type" --success true --description "$TOOL_INPUT_prompt" --json';
for (const g of (s.hooks.PostToolUse || [])) {
  for (const h of (g.hooks || [])) {
    const c = h.command || '';
    if (c.includes('agentic-qe hooks post-task') && !c.includes('--success true')) {
      h.command = PT_FIXED; changed = true;  // AQE-POSTTASK-ARGS-V1
    }
  }
}
// AQE-HOOK-REPOINT-V1: the kit mandates the GLOBAL `aqe` binary for hook commands
// (issue #4 wiring-smell #1), mirroring the global-ruflo MCP treatment. `npx agentic-qe`
// cold-start + ONNX model load routinely BLOWS the 3-5s hook timeouts and the failure is
// swallowed (continueOnError) — a root cause of the "hooks fire but tables never populate"
// symptom. Repoint every `npx agentic-qe hooks …` → `aqe hooks …` ONLY when the kit found a
// global aqe (AQE_PRESENT injected at wire time); otherwise leave npx (the portable fallback).
// Idempotent: matches the `npx` prefix, so a second run is a no-op. We KEEP continueOnError:true
// (a flaky hook must never block the user's Write/Edit) — using the fast global binary, not
// flipping the gate, is what stops the timeout-driven swallow. This also catches PT_FIXED above
// (it carries the npx prefix), keeping a single source of truth.
const AQE_PRESENT = process.env.AQE_PRESENT === '1';
if (AQE_PRESENT) {
  for (const ev of Object.keys(s.hooks)) {
    for (const g of (s.hooks[ev] || [])) {
      for (const h of (g.hooks || [])) {
        if (typeof h.command === 'string' && h.command.includes('npx agentic-qe hooks')) {
          h.command = h.command.replace(/npx agentic-qe hooks/g, 'aqe hooks');  // AQE-HOOK-REPOINT-V1
          changed = true;
        }
      }
    }
  }
  s.permissions = s.permissions || {}; s.permissions.allow = s.permissions.allow || [];
  if (!s.permissions.allow.includes('Bash(aqe:*)')) { s.permissions.allow.push('Bash(aqe:*)'); changed = true; }
}
// AQE-HARVEST-DRIFT-V1: older settings carried a stale RELATIVE harvest command
// (`[ -f scripts/aqe-harvest.cjs ] && node scripts/aqe-harvest.cjs`) that never runs from a
// target cwd and scatters learning across project boundaries (issue #4 wiring-smell #2).
// Replace any non-KITDIR-absolute harvest invocation with the canonical HARVEST built above.
for (const g of (s.hooks.SessionEnd || [])) {
  for (const h of (g.hooks || [])) {
    if (typeof h.command === 'string'
        && h.command.includes('aqe-harvest.cjs')
        && !h.command.includes(process.env.KITDIR || ' ')) {
      h.command = HARVEST; changed = true;  // AQE-HARVEST-DRIFT-V1
    }
  }
}
const en = Array.isArray(s.enabledMcpjsonServers) ? s.enabledMcpjsonServers : [];
if (!en.includes('claude-flow')) { s.enabledMcpjsonServers = en.concat(['claude-flow']); changed = true; }
// AQE-PROJECT-ROOT-PIN-V1: pin AQE_PROJECT_ROOT so the kernel's findProjectRoot()
// resolves deterministically — it honors this env BEFORE any cwd walk-up, anchoring
// every findProjectRoot consumer (memory.db, workers, code-intel) regardless of the
// hook/worker cwd. CAVEAT (≤3.10.3): the RVF pattern store + brain dual-writer used a
// CWD-RELATIVE '.agentic-qe' and did NOT call findProjectRoot, so on those versions this
// pin did not by itself stop RVF stray dirs (that needed the RVF-STRAY sweep below + the
// upstream fix that routes RVF through findProjectRoot). Fixed upstream in aqe 3.10.4:
// nearest-wins + RVF anchored to AQE_PROJECT_ROOT ?? findProjectRoot, so the pin DOES
// reach RVF now. It hardens all SQLite-side resolution today. TARGET_DIR injected at wire time.
const PROJ = process.env.TARGET_DIR;
if (PROJ) { s.env = s.env || {}; if (s.env.AQE_PROJECT_ROOT !== PROJ) { s.env.AQE_PROJECT_ROOT = PROJ; changed = true; } }
if (changed) { fs.writeFileSync(F, JSON.stringify(s, null, 2) + '\n'); console.log('CHANGED'); } else { console.log('UNCHANGED'); }
NODE
    AQE_PRESENT="$( { [[ -n "${AQE_ROOT:-}" ]] || command -v aqe >/dev/null 2>&1; } && echo 1 || echo 0 )"
    RES="$(KITDIR="$KIT_DIR" AQE_PRESENT="$AQE_PRESENT" TARGET_DIR="$TARGET_DIR" node "$WIRE" "$SETTINGS" 2>/dev/null)"; rm -f "$WIRE"
    if node -e "JSON.parse(require('fs').readFileSync('$SETTINGS','utf8'))" 2>/dev/null; then
      case "$RES" in
        CHANGED) fix "Wired RAG + dual-train hooks + enabledMcpjsonServers into settings.json"; pass "settings.json hooks wired";;
        UNCHANGED) pass "settings.json hooks already wired";;
        *) warn "settings.json wiring inconclusive ($RES)";;
      esac
    else
      warn "settings.json became invalid — restoring backup"; cp "$SETTINGS.fixaqe-bak" "$SETTINGS"
    fi
  fi
fi

# ── Step 2b: AQE-MCP-ROOT-PIN-V1 (.mcp.json agentic-qe env) ─────────────────
# The AQE MCP server (`aqe-mcp`, launched from .mcp.json) resolves its store via
# findProjectRoot(), whose (≤3.10.3) "topmost .agentic-qe wins" rule HIJACKED to
# ~/.agentic-qe whenever that dir existed higher up the tree than the project — so the
# long-lived MCP server wrote every project's experiences into the HOME brain regardless
# of cwd (verified: aqe-mcp held ~/.agentic-qe/memory.db open with cwd=project). 3.10.4
# picks NEAREST + honors AQE_PROJECT_ROOT first; the pin remains recommended config. The
# settings.json pin (Step 2) only covers Claude Code HOOKS; the MCP server reads its
# env from .mcp.json. Pin AQE_PROJECT_ROOT there too — findProjectRoot honors it
# BEFORE the walk-up, defeating the hijack. Takes effect on the next MCP (re)spawn.
header "2b" "AQE MCP root pin (AQE-MCP-ROOT-PIN-V1)"
MCP_JSON="$TARGET_DIR/.mcp.json"
if [[ ! -f "$MCP_JSON" ]]; then
  warn "no .mcp.json — skipping AQE MCP root pin (run AQE/ruflo init first)"
elif [[ "$DRY_RUN" -eq 1 ]]; then
  info "[dry-run] would pin AQE_PROJECT_ROOT in .mcp.json agentic-qe server env"
else
  [[ -e "$MCP_JSON.fixaqe-bak" ]] || cp "$MCP_JSON" "$MCP_JSON.fixaqe-bak"
  RES="$(TARGET_DIR="$TARGET_DIR" node -e '
    const fs=require("fs"),F=process.argv[1];
    let s; try{s=JSON.parse(fs.readFileSync(F,"utf8"))}catch(e){console.log("INVALID_JSON");process.exit(0)}
    const srv=(s.mcpServers||{});
    // pin the AQE server (named "agentic-qe", or any whose command is aqe-mcp)
    const keys=Object.keys(srv).filter(k=>/^agentic-qe$/.test(k)||/aqe-mcp/.test(srv[k]&&srv[k].command||""));
    if(!keys.length){console.log("NO_AQE_SERVER");process.exit(0)}
    let changed=false;const PROJ=process.env.TARGET_DIR;
    for(const k of keys){const sv=srv[k];sv.env=sv.env||{};if(sv.env.AQE_PROJECT_ROOT!==PROJ){sv.env.AQE_PROJECT_ROOT=PROJ;changed=true;}}
    if(changed){fs.writeFileSync(F,JSON.stringify(s,null,2)+"\n");console.log("CHANGED")}else{console.log("UNCHANGED")}
  ' "$MCP_JSON" 2>/dev/null)"
  if node -e "JSON.parse(require('fs').readFileSync('$MCP_JSON','utf8'))" 2>/dev/null; then
    case "$RES" in
      CHANGED)      fix "Pinned AQE_PROJECT_ROOT in .mcp.json agentic-qe env (AQE-MCP-ROOT-PIN-V1)"; pass "AQE MCP root pinned — stops the ~/.agentic-qe hijack on MCP respawn";;
      UNCHANGED)    pass "AQE MCP root already pinned (.mcp.json)";;
      NO_AQE_SERVER) warn "no agentic-qe/aqe-mcp server in .mcp.json — nothing to pin";;
      *)            warn ".mcp.json AQE pin inconclusive ($RES)";;
    esac
  else
    warn ".mcp.json became invalid — restoring backup"; cp "$MCP_JSON.fixaqe-bak" "$MCP_JSON"
  fi
fi

# ── Step 3: AQE-DREAM-LOCKFIX-V2 ────────────────────────────────────────────
# Dream-engine simultaneous-writer race (#461). V1 guarded only the hook trigger
# path; the auditor found the DAEMON drives cycles through the ENGINE path
# (dream-engine.js saveCycle) plus two bundled paths (mcp/bundle.js, cli chunk),
# all UNGUARDED → new "database is locked" + stuck running rows kept accumulating.
# V2 guards ALL FOUR insert paths and adds a PERIODIC (per-cycle) orphan sweep so a
# long-lived daemon self-heals without a restart. Sentinel bumped to V2 so it
# re-applies over V1; each already-patched target is restored from its pristine
# .dream-lockfix-bak FIRST (no patch stacking), then re-patched cleanly.
#   1a hooks-dream-learning.js : atomic claim (re-applied, V2 sentinel).
#   1b dream-engine.js         : wal_checkpoint(TRUNCATE) after success+failure.
#   1c dream-engine.js         : STARTUP orphan sweep after migrateSchema().
#   1d dream-engine.js         : ENGINE-path atomic claim + PERIODIC sweep at the
#                                start of dream() (the live daemon driver).
#   1e mcp/bundle.js + cli chunk : bundled saveCycle() plain INSERT → sweep +
#                                conditional INSERT (WHERE NOT EXISTS recent running).
header "3" "Dream-engine lock fix (AQE-DREAM-LOCKFIX-V2)"
if [[ -z "$AQE_ROOT" ]]; then
  warn "global agentic-qe not found — skipping AQE-DREAM-LOCKFIX"
else
  HDL="$AQE_ROOT/dist/cli/commands/hooks-handlers/hooks-dream-learning.js"
  DEN="$AQE_ROOT/dist/learning/dream/dream-engine.js"
  MCPB="$AQE_ROOT/dist/mcp/bundle.js"
  # The cli chunk name is content-hashed and changes on every aqe release
  # (IJ4BUSJN in 3.10.x, XNNYHQLW in 3.12.2, …) — discover it by its anchor,
  # same pattern as the AQE-PROMOTE-V1 chunk discovery above.
  CLIC="$(grep -rl "INSERT INTO dream_cycles" "$AQE_ROOT/dist/cli/chunks/" 2>/dev/null | grep '\.js$' | grep -v '\.bak' | head -1)"
  [[ -z "$CLIC" ]] && CLIC="$AQE_ROOT/dist/cli/chunks/chunk-IJ4BUSJN.js"   # legacy fallback for the missing-target warn path

  # Restore any target already carrying a (stale V1) sentinel from its pristine
  # .dream-lockfix-bak BEFORE re-patching, so V2 applies to a clean base and never
  # stacks on V1. Only restores when the target has a sentinel but NOT V2 yet.
  if [[ "$DRY_RUN" -ne 1 ]]; then
    for _t in "$HDL" "$DEN" "$MCPB" "$CLIC"; do
      [[ -f "$_t" ]] || continue
      if grep -q "AQE-DREAM-LOCKFIX" "$_t" && ! grep -q "AQE-DREAM-LOCKFIX-V2" "$_t"; then
        if [[ -e "$_t.dream-lockfix-bak" ]]; then
          cp "$_t.dream-lockfix-bak" "$_t"; info "restored $(basename "$_t") from pristine .bak (pre-V2)"
        else
          warn "$(basename "$_t") has a stale sentinel but NO .bak — cannot safely re-patch; skipping"
        fi
      fi
    done
  fi

  # ---- 1a: atomic claim in hooks-dream-learning.js -------------------------
  if [[ ! -f "$HDL" ]]; then
    warn "1a target missing: $HDL"
  elif grep -q "AQE-DREAM-LOCKFIX-V2" "$HDL"; then
    pass "1a atomic-claim already present: $(basename "$HDL")"
  elif [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] would install atomic dream claim in $(basename "$HDL")"
  else
    [[ -e "$HDL.dream-lockfix-bak" ]] || cp "$HDL" "$HDL.dream-lockfix-bak"
    node -e '
const fs=require("fs"),F=process.argv[1];let s=fs.readFileSync(F,"utf8");
const OLD=`        try {
            const { getUnifiedMemory } = await import('"'"'../../../kernel/unified-memory.js'"'"');
            const um = getUnifiedMemory();
            if (um.isInitialized()) {
                const db = um.getDatabase();
                const running = db
                    .prepare(\`SELECT COUNT(*) AS n FROM dream_cycles
             WHERE status = '"'"'running'"'"'
               AND start_time > datetime('"'"'now'"'"', '"'"'-60 seconds'"'"')\`)
                    .get();
                if (running && running.n > 0) {
                    return { triggered: false, reason: '"'"'already-running'"'"' };
                }
            }
        }
        catch {
            // fail-open — if dream_cycles table is missing or unified memory not
            // ready, we'\''d rather risk the rare lock than block dreaming entirely.
        }`;
const NEW=`        // AQE-DREAM-LOCKFIX-V2: true mutual exclusion via an ATOMIC claim.
        // The old peek-then-insert guard had a TOCTOU race (every concurrent
        // hook subprocess peeked '"'"'no running cycle'"'"' before any inserted one,
        // so they all proceeded and collided on the WAL writer). Here a single
        // conditional INSERT lets exactly one racer win: the row is inserted only
        // WHERE NOT EXISTS a recent running cycle, then changes()===1 confirms we
        // won. Losers exit early with reason='"'"'already-running'"'"'. Fail-soft: any
        // error falls through to legacy behaviour (dream proceeds, as before).
        try {
            const { getUnifiedMemory } = await import('"'"'../../../kernel/unified-memory.js'"'"');
            const um = getUnifiedMemory();
            if (um.isInitialized()) {
                const db = um.getDatabase();
                const claimId = randomUUID();
                const nowIso = new Date().toISOString();
                const info = db
                    .prepare(\`INSERT INTO dream_cycles
               (id, start_time, status, created_at)
             SELECT ?, ?, '"'"'running'"'"', ?
             WHERE NOT EXISTS (
               SELECT 1 FROM dream_cycles
               WHERE status = '"'"'running'"'"'
                 AND start_time > strftime('"'"'%Y-%m-%dT%H:%M:%fZ'"'"', '"'"'now'"'"', '"'"'-5 minutes'"'"')
             )\`)
                    .run(claimId, nowIso, nowIso);
                if (info.changes !== 1) {
                    return { triggered: false, reason: '"'"'already-running'"'"' };
                }
            }
        }
        catch {
            // fail-soft — if the atomic claim cannot run (table missing, unified
            // memory not ready), fall through and let the cycle proceed, exactly
            // as the legacy fail-open guard did.
        }`;
if(!s.includes(OLD)){console.log("ANCHOR_MISS");process.exit(0);}
s=s.split(OLD).join(NEW);fs.writeFileSync(F,s);console.log("OK");
' "$HDL" > /tmp/.aqe-dlf-1a 2>/dev/null
    R="$(cat /tmp/.aqe-dlf-1a 2>/dev/null)"; rm -f /tmp/.aqe-dlf-1a
    if [[ "$R" == "ANCHOR_MISS" ]]; then
      warn "1a anchor not found (version drift?) — verify $(basename "$HDL") manually"
    elif node --check "$HDL" 2>/dev/null; then
      fix "Atomic dream claim (AQE-DREAM-LOCKFIX-V2/1a): $(basename "$HDL")"; pass "1a patched $(basename "$HDL")"
    else
      warn "1a produced invalid JS — restoring $(basename "$HDL")"; cp "$HDL.dream-lockfix-bak" "$HDL"
    fi
  fi

  # ---- 1b + 1c + 1d: dream-engine.js ---------------------------------------
  if [[ ! -f "$DEN" ]]; then
    warn "1b/1c/1d target missing: $DEN"
  elif grep -q "AQE-DREAM-LOCKFIX-V2" "$DEN"; then
    pass "1b/1c/1d engine guard+sweep already present: $(basename "$DEN")"
  elif [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] would install WAL checkpoint + sweep + engine claim in $(basename "$DEN")"
  else
    [[ -e "$DEN.dream-lockfix-bak" ]] || cp "$DEN" "$DEN.dream-lockfix-bak"
    node -e '
const fs=require("fs"),F=process.argv[1];let s=fs.readFileSync(F,"utf8");
// 1b success path: after status='"'"'completed'"'"' updateCycle()
const SOLD=`            this.currentCycle.status = '"'"'completed'"'"';
            await this.updateCycle(this.currentCycle);`;
const SNEW=`            this.currentCycle.status = '"'"'completed'"'"';
            await this.updateCycle(this.currentCycle);
            // AQE-DREAM-LOCKFIX-V2/1b: drain the WAL after a successful cycle.
            // UnifiedMemoryManager.checkpoint() exists but had zero callers, so the
            // WAL grew unbounded (~4MB observed). TRUNCATE keeps it near zero.
            try { this.db.pragma('"'"'wal_checkpoint(TRUNCATE)'"'"'); } catch { /* fail-soft */ }`;
// 1b failure path: the updateCycle() inside the catch{} block
const FOLD=`                this.currentCycle.durationMs = Date.now() - startTime;
                await this.updateCycle(this.currentCycle);`;
const FNEW=`                this.currentCycle.durationMs = Date.now() - startTime;
                await this.updateCycle(this.currentCycle);
                // AQE-DREAM-LOCKFIX-V2/1b: drain the WAL after a failed cycle too.
                try { this.db.pragma('"'"'wal_checkpoint(TRUNCATE)'"'"'); } catch { /* fail-soft */ }`;
// 1c startup orphan sweep: right after migrateSchema() in initialize()
const COLD=`            // Migrate legacy schema: rename '"'"'duration'"'"' → '"'"'duration_ms'"'"' if needed
            this.migrateSchema();`;
const CNEW=`            // Migrate legacy schema: rename '"'"'duration'"'"' → '"'"'duration_ms'"'"' if needed
            this.migrateSchema();
            // AQE-DREAM-LOCKFIX-V2/1c: sweep orphaned '"'"'running'"'"' cycles left behind
            // by crashed/killed processes. A real hook cycle is ~10s; 10 minutes is a
            // 60x margin so a legitimately in-flight cycle is never swept. Fail-soft.
            try {
                this.db.exec("UPDATE dream_cycles SET status='"'"'failed'"'"', error=COALESCE(error,'"'"'orphaned: swept at startup'"'"'), end_time=COALESCE(end_time,start_time), duration_ms=COALESCE(duration_ms,0) WHERE status='"'"'running'"'"' AND start_time < strftime('"'"'%Y-%m-%dT%H:%M:%fZ'"'"','"'"'now'"'"','"'"'-10 minutes'"'"')");
            }
            catch { /* fail-soft */ }`;
// 1d ENGINE-path atomic claim + PERIODIC sweep: replace the unguarded
// "build currentCycle + saveCycle" prologue of dream() with sweep-then-claim.
// The claim INSERTs the running row itself (so saveCycle is NOT called — that
// would duplicate the PK); a lost claim returns a benign skipped result.
const DOLD=`        // Create cycle record
        this.currentCycle = {
            id: uuidv4(),
            startTime: new Date(),
            conceptsProcessed: 0,
            associationsFound: 0,
            insightsGenerated: 0,
            status: '"'"'running'"'"',
        };
        await this.saveCycle(this.currentCycle);`;
const DNEW=`        // Create cycle record
        this.currentCycle = {
            id: uuidv4(),
            startTime: new Date(),
            conceptsProcessed: 0,
            associationsFound: 0,
            insightsGenerated: 0,
            status: '"'"'running'"'"',
        };
        // AQE-DREAM-LOCKFIX-V2/1d: the DAEMON drives cycles through THIS engine path,
        // which was unguarded (only the hook path had the V1 claim) — concurrent
        // engine + hook + MCP writers collided on the WAL ("database is locked") and
        // left stuck running rows. Here we (a) PERIODICALLY sweep stale orphans so a
        // long-lived daemon self-heals without a restart, then (b) make an ATOMIC
        // claim: INSERT the running row only WHERE NOT EXISTS a recent running cycle.
        // Won (changes()===1) ⇒ proceed (row already persisted, so skip saveCycle).
        // Lost ⇒ return a benign skipped result. Fail-soft: on any error fall back to
        // the original unconditional saveCycle so dreaming is never fully blocked.
        let _claimed = false;
        try {
            if (this.db) {
                this.db.exec("UPDATE dream_cycles SET status='"'"'failed'"'"', error=COALESCE(error,'"'"'orphaned: swept pre-cycle'"'"'), end_time=COALESCE(end_time,start_time), duration_ms=COALESCE(duration_ms,0) WHERE status='"'"'running'"'"' AND start_time < strftime('"'"'%Y-%m-%dT%H:%M:%fZ'"'"','"'"'now'"'"','"'"'-10 minutes'"'"')");
                const _info = this.db.prepare(\`INSERT INTO dream_cycles (id, start_time, status, created_at) SELECT ?, ?, '"'"'running'"'"', ? WHERE NOT EXISTS (SELECT 1 FROM dream_cycles WHERE status='"'"'running'"'"' AND start_time > strftime('"'"'%Y-%m-%dT%H:%M:%fZ'"'"','"'"'now'"'"','"'"'-5 minutes'"'"'))\`)
                    .run(this.currentCycle.id, this.currentCycle.startTime.toISOString(), this.currentCycle.startTime.toISOString());
                if (_info.changes !== 1) {
                    const _skipped = { ...this.currentCycle, status: '"'"'skipped'"'"', endTime: new Date(), durationMs: 0 };
                    this.currentCycle = null;
                    return { cycle: _skipped, insights: [], activationStats: { totalIterations: 0, peakActivation: 0, nodesActivated: 0 }, patternsCreated: 0 };
                }
                _claimed = true;
            }
        }
        catch { _claimed = false; /* fail-soft → unconditional save below */ }
        if (!_claimed) await this.saveCycle(this.currentCycle);`;
let miss=[];
if(!s.includes(SOLD))miss.push("1b-success");else s=s.split(SOLD).join(SNEW);
if(!s.includes(FOLD))miss.push("1b-failure");else s=s.split(FOLD).join(FNEW);
if(!s.includes(COLD))miss.push("1c-sweep");else s=s.split(COLD).join(CNEW);
if(!s.includes(DOLD))miss.push("1d-claim");else s=s.split(DOLD).join(DNEW);
if(miss.length){console.log("ANCHOR_MISS:"+miss.join(","));process.exit(0);}
fs.writeFileSync(F,s);console.log("OK");
' "$DEN" > /tmp/.aqe-dlf-bc 2>/dev/null
    R="$(cat /tmp/.aqe-dlf-bc 2>/dev/null)"; rm -f /tmp/.aqe-dlf-bc
    case "$R" in
      OK)
        if node --check "$DEN" 2>/dev/null; then
          fix "WAL checkpoint + sweep + engine claim (AQE-DREAM-LOCKFIX-V2/1b+1c+1d): $(basename "$DEN")"; pass "1b/1c/1d patched $(basename "$DEN")"
        else
          warn "1b/1c/1d produced invalid JS — restoring $(basename "$DEN")"; cp "$DEN.dream-lockfix-bak" "$DEN"
        fi;;
      ANCHOR_MISS*) warn "1b/1c/1d anchor not found ($R) — verify $(basename "$DEN") manually";;
      *) warn "1b/1c/1d inconclusive ($R)";;
    esac
  fi

  # ---- 1e: bundled saveCycle() in mcp/bundle.js + cli chunk ----------------
  # Minified CJS/ESM bundles: transform the plain saveCycle INSERT into a sweep +
  # CONDITIONAL INSERT (WHERE NOT EXISTS recent running). A losing racer simply
  # inserts no duplicate running row (no stuck-row accumulation, no same-ms double
  # claim). The cycle object's PK is preserved so a later updateCycle still matches
  # when the row was inserted. String-anchored on the shared minified saveCycle body.
  for _bt in "$MCPB" "$CLIC"; do
    _bn="$(basename "$_bt")"
    if [[ ! -f "$_bt" ]]; then
      warn "1e target missing: $_bt"; continue
    elif grep -q "AQE-DREAM-LOCKFIX-V2" "$_bt"; then
      pass "1e bundled guard already present: $_bn"; continue
    elif [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] would guard bundled saveCycle in $_bn"; continue
    fi
    [[ -e "$_bt.dream-lockfix-bak" ]] || cp "$_bt" "$_bt.dream-lockfix-bak"
    node -e '
const fs=require("fs"),F=process.argv[1];let s=fs.readFileSync(F,"utf8");
if(s.includes("AQE-DREAM-LOCKFIX-V2")){console.log("ALREADY");process.exit(0);}
// The minified saveCycle body (same in both bundles). Match the prepare(`INSERT…`).run(…)
// and rewrite to: sweep, then conditional INSERT via prepare(`… WHERE NOT EXISTS …`).run(…).
const OLD=`this.db.prepare(\`
      INSERT INTO dream_cycles
      (id, start_time, end_time, duration_ms, concepts_processed, associations_found,
       insights_generated, status, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    \`).run(e.id,e.startTime.toISOString(),e.endTime?.toISOString()??null,e.durationMs??null,e.conceptsProcessed,e.associationsFound,e.insightsGenerated,e.status,e.error??null,e.startTime.toISOString())`;
const NEW=`(()=>{try{/* AQE-DREAM-LOCKFIX-V2/1e: periodic sweep + conditional claim (bundled) */this.db.exec("UPDATE dream_cycles SET status='"'"'failed'"'"', error=COALESCE(error,'"'"'orphaned: swept (bundled)'"'"'), end_time=COALESCE(end_time,start_time), duration_ms=COALESCE(duration_ms,0) WHERE status='"'"'running'"'"' AND start_time < strftime('"'"'%Y-%m-%dT%H:%M:%fZ'"'"','"'"'now'"'"','"'"'-10 minutes'"'"')");}catch{}this.db.prepare(\`
      INSERT INTO dream_cycles
      (id, start_time, end_time, duration_ms, concepts_processed, associations_found,
       insights_generated, status, error, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ? != '"'"'running'"'"' OR NOT EXISTS (SELECT 1 FROM dream_cycles WHERE status='"'"'running'"'"' AND start_time > strftime('"'"'%Y-%m-%dT%H:%M:%fZ'"'"','"'"'now'"'"','"'"'-5 minutes'"'"'))
    \`).run(e.id,e.startTime.toISOString(),e.endTime?.toISOString()??null,e.durationMs??null,e.conceptsProcessed,e.associationsFound,e.insightsGenerated,e.status,e.error??null,e.startTime.toISOString(),e.status)})()`;
if(!s.includes(OLD)){console.log("ANCHOR_MISS");process.exit(0);}
s=s.split(OLD).join(NEW);fs.writeFileSync(F,s);console.log("OK");
' "$_bt" > /tmp/.aqe-dlf-1e 2>/dev/null
    R="$(cat /tmp/.aqe-dlf-1e 2>/dev/null)"; rm -f /tmp/.aqe-dlf-1e
    case "$R" in
      OK)
        if node --check "$_bt" 2>/dev/null; then
          fix "Bundled saveCycle guard (AQE-DREAM-LOCKFIX-V2/1e): $_bn"; pass "1e patched $_bn"
        else
          warn "1e produced invalid JS — restoring $_bn"; cp "$_bt.dream-lockfix-bak" "$_bt"
        fi;;
      ALREADY) pass "1e bundled guard already present: $_bn";;
      ANCHOR_MISS) warn "1e anchor not found in $_bn — verify manually";;
      *) warn "1e inconclusive ($R) for $_bn";;
    esac
  done
fi

# ── Step 4: AQE ML-router confidence threshold (AQE-ROUTING-THRESHOLD-V1) ───
# Codifies the .agentic-qe/config.yaml routing.confidenceThreshold so a regen
# (`aqe init`) can't silently restore the stock 0.7 (which sat above the live
# ~0.66 confidence, so the AQE ML route rarely fired). Value-based idempotency.
# Scope: gates ONLY the AQE ML router; Router B uses its own >0.4 gate. See
# docs/_INSTRUCTIONS.md Patch 38 / 41.
header "4" "AQE ML-router confidence threshold (config.yaml)"
AQE_CONFIG="$TARGET_DIR/.agentic-qe/config.yaml"
AQE_CONF_THRESHOLD="0.6"   # kit-enforced; change here to retune.
if [[ ! -f "$AQE_CONFIG" ]]; then
  warn "no .agentic-qe/config.yaml — skipping (run aqe init first)"
else
  cur="$(grep -E '^[[:space:]]*confidenceThreshold:' "$AQE_CONFIG" | head -1 | sed -E 's/.*confidenceThreshold:[[:space:]]*//; s/[[:space:]#].*$//')"
  if [[ -z "$cur" ]]; then
    warn "no confidenceThreshold key in config.yaml (routing block absent?) — verify manually"
  elif [[ "$cur" == "$AQE_CONF_THRESHOLD" ]]; then
    pass "confidenceThreshold already $AQE_CONF_THRESHOLD"
  elif [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] would set confidenceThreshold: $cur → $AQE_CONF_THRESHOLD"
  else
    [[ -e "$AQE_CONFIG.fixaqe-bak" ]] || cp "$AQE_CONFIG" "$AQE_CONFIG.fixaqe-bak"
    TH="$AQE_CONF_THRESHOLD" node -e 'const fs=require("fs"),F=process.argv[1];let s=fs.readFileSync(F,"utf8");s=s.replace(/^(\s*confidenceThreshold:\s*)\S+/m,`$1${process.env.TH}`);fs.writeFileSync(F,s)' "$AQE_CONFIG"
    new="$(grep -E '^[[:space:]]*confidenceThreshold:' "$AQE_CONFIG" | head -1 | sed -E 's/.*confidenceThreshold:[[:space:]]*//; s/[[:space:]#].*$//')"
    if [[ "$new" == "$AQE_CONF_THRESHOLD" ]]; then fix "Set AQE routing confidenceThreshold $cur → $AQE_CONF_THRESHOLD"; pass "confidenceThreshold $cur → $AQE_CONF_THRESHOLD"
    else warn "confidenceThreshold edit did not take — restoring"; cp "$AQE_CONFIG.fixaqe-bak" "$AQE_CONFIG"; fi
  fi

  # AQE-DAEMON-AUTOSTART-OFF-V1: codify workers.daemonAutoStart=false. The stock
  # config ships true, and `ruflo doctor --fix` (fix-learning step 1) plus the aqe
  # session hooks HONOR it — observed live 3x in one session: the billed daemon
  # kept resurrecting despite RUFLO_DAEMON_MODE=off gating our own scripts
  # (Patch 50 covers only the kit's start sites, not upstream's). Same
  # value-codify pattern as confidenceThreshold above; daemon use stays possible
  # via explicit `ruflo daemon start` / RUFLO_DAEMON_MODE=auto.
  das="$(grep -E '^[[:space:]]*daemonAutoStart:' "$AQE_CONFIG" | head -1 | sed -E 's/.*daemonAutoStart:[[:space:]]*//; s/[[:space:]#].*$//')"
  if [[ -z "$das" ]]; then
    pass "no daemonAutoStart key in config.yaml — nothing to pin"
  elif [[ "$das" == "false" ]]; then
    pass "daemonAutoStart already false (AQE-DAEMON-AUTOSTART-OFF-V1)"
  elif [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] would set daemonAutoStart: $das → false"
  else
    [[ -e "$AQE_CONFIG.fixaqe-bak" ]] || cp "$AQE_CONFIG" "$AQE_CONFIG.fixaqe-bak"
    node -e 'const fs=require("fs"),F=process.argv[1];let s=fs.readFileSync(F,"utf8");s=s.replace(/^(\s*daemonAutoStart:\s*)\S+/m,"$1false");fs.writeFileSync(F,s)' "$AQE_CONFIG"
    ndas="$(grep -E '^[[:space:]]*daemonAutoStart:' "$AQE_CONFIG" | head -1 | sed -E 's/.*daemonAutoStart:[[:space:]]*//; s/[[:space:]#].*$//')"
    if [[ "$ndas" == "false" ]]; then fix "daemonAutoStart $das → false (AQE-DAEMON-AUTOSTART-OFF-V1 — billed daemon stays opt-in)"; pass "daemonAutoStart pinned false"
    else warn "daemonAutoStart edit did not take — verify manually"; fi
  fi

  # AQE-NATIVE-HNSW-V1: codify learning.hnswConfig.useNativeHNSW=true so AQE indexes
  # its vectors with the native RuVector HNSW (issue #4 gap #4 — vectors present but
  # unindexed). This only CODIFIES the config so it survives `aqe init` regen; the
  # RUNTIME activation/index-rebuild is fix-learning Step 6 (aqe ruvector flags …).
  # The key's presence is its own idempotency sentinel; insert as a 4-space sibling
  # under the existing 2-space `hnswConfig:` block via a YAML-safe node edit.
  if grep -q 'useNativeHNSW' "$AQE_CONFIG"; then
    pass "useNativeHNSW already codified"
  elif ! grep -qE '^[[:space:]]*hnswConfig:' "$AQE_CONFIG"; then
    warn "no learning.hnswConfig block in config.yaml — skipping useNativeHNSW codify"
  elif [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] would set learning.hnswConfig.useNativeHNSW: true"
  else
    [[ -e "$AQE_CONFIG.fixaqe-bak" ]] || cp "$AQE_CONFIG" "$AQE_CONFIG.fixaqe-bak"
    node -e '
      const fs=require("fs"),F=process.argv[1];
      const lines=fs.readFileSync(F,"utf8").split("\n");
      const out=[];
      for (const l of lines) {
        out.push(l);
        if (/^\s{2}hnswConfig:\s*$/.test(l)) out.push("    useNativeHNSW: true  # AQE-NATIVE-HNSW-V1");
      }
      fs.writeFileSync(F, out.join("\n"));
    ' "$AQE_CONFIG"
    if grep -q 'useNativeHNSW: true' "$AQE_CONFIG"; then
      fix "Codified learning.hnswConfig.useNativeHNSW=true (AQE-NATIVE-HNSW-V1)"; pass "useNativeHNSW codified"
    else
      warn "useNativeHNSW insert did not take — restoring"; cp "$AQE_CONFIG.fixaqe-bak" "$AQE_CONFIG"
    fi
  fi
fi

# ── Step 5: tracked .claude command docs (CLAUDE-CMD-DOCS-V1) ────────────────
# Restores kit-maintained docs under .claude/commands/ from tracked sources in
# assets/claude-commands/ (the .claude/ tree is regenerated by ruflo/aqe init
# and not version-controlled). Generic: installs every *.md preserving its
# relative path. Currently: analysis/COMMAND_COMPLIANCE_REPORT.md. cmp-skip /
# .bak / dry-run, matching the helper-install loop. See _INSTRUCTIONS Patch 41.
header "5" ".claude command docs (tracked → installed)"
CMD_SRC="$KIT_ASSETS/claude-commands"
CMD_DST="$TARGET_DIR/.claude/commands"
if [[ ! -d "$CMD_SRC" ]]; then
  warn "no assets/claude-commands/ source dir — skipping command-doc install"
else
  while IFS= read -r src; do
    [[ -n "$src" ]] || continue
    rel="${src#"$CMD_SRC"/}"; dst="$CMD_DST/$rel"
    if cmp -s "$src" "$dst" 2>/dev/null; then pass "$rel up to date"; continue; fi
    if [[ "$DRY_RUN" -eq 1 ]]; then info "[dry-run] would install command doc $rel"; continue; fi
    mkdir -p "$(dirname "$dst")"
    [[ -f "$dst" && ! -e "$dst.fixaqe-bak" ]] && cp "$dst" "$dst.fixaqe-bak"
    cp "$src" "$dst" && { fix "Installed .claude/commands/$rel"; pass "installed $rel"; }
  done < <(find "$CMD_SRC" -type f -name '*.md' 2>/dev/null)
fi

# ── Step 6: dream min-concepts floor (AQE-DREAM-MINCONCEPTS-V1) ─────────────
# DEFAULT_DREAM_CONFIG.minConceptsRequired=10 hard-blocks ALL dream consolidation
# until the concept graph has 10 nodes — so a fresh fleet (the 2 seeded patterns)
# can NEVER dream ("Insufficient concepts: N<10"). Lower the floor so a young fleet
# starts consolidating early; dream QUALITY scales with accumulated concepts, so a
# low floor only UNBLOCKS early cycles, it does not degrade later ones. Codifies the
# workaround validated in the e2e (10→2 produced 5 real insights on a 2-pattern fleet).
# Global agentic-qe dist; sentinel + .bak + node --check; runs AFTER the lockfix step
# so a lockfix restore-then-repatch is followed by this re-apply in the same run.
header "6" "Dream min-concepts floor (AQE-DREAM-MINCONCEPTS-V1)"
AQE_DREAM_MINCONCEPTS="2"   # kit floor (stock default is 10); raise to retune
if [[ -z "$AQE_ROOT" ]]; then
  warn "global agentic-qe not found — skipping dream min-concepts floor"
else
  DEN6="$AQE_ROOT/dist/learning/dream/dream-engine.js"
  if [[ ! -f "$DEN6" ]]; then
    warn "dream-engine.js not found — skipping"
  elif grep -q "AQE-DREAM-MINCONCEPTS-V1" "$DEN6"; then
    pass "dream min-concepts floor already set (AQE-DREAM-MINCONCEPTS-V1)"
  elif ! grep -q "minConceptsRequired: 10," "$DEN6"; then
    warn "minConceptsRequired: 10 anchor not found (version drift?) — verify manually"
  elif [[ "${DRY_RUN:-0}" -eq 1 ]]; then
    info "[dry-run] would set minConceptsRequired 10 → $AQE_DREAM_MINCONCEPTS"
  else
    [[ -e "$DEN6.minconcepts-bak" ]] || cp "$DEN6" "$DEN6.minconcepts-bak"
    MC="$AQE_DREAM_MINCONCEPTS" node -e 'const fs=require("fs"),F=process.argv[1];let s=fs.readFileSync(F,"utf8");s=s.replace("minConceptsRequired: 10,","minConceptsRequired: "+process.env.MC+", /* AQE-DREAM-MINCONCEPTS-V1 (stock 10; lowered so a young fleet can consolidate) */");fs.writeFileSync(F,s)' "$DEN6"
    if node --check "$DEN6" 2>/dev/null; then fix "Lowered dream minConceptsRequired 10 → $AQE_DREAM_MINCONCEPTS (AQE-DREAM-MINCONCEPTS-V1)"; pass "minConceptsRequired → $AQE_DREAM_MINCONCEPTS"
    else warn "min-concepts patch produced invalid JS — restoring"; cp "$DEN6.minconcepts-bak" "$DEN6"; fi
  fi
fi

# ── Step 7: stray RVF .agentic-qe advisory (RVF-STRAY-SWEEP-V1) ──────────────
# Non-destructive here: list any RVF-only stray .agentic-qe dirs the ≤3.10.3 cwd-relative
# RVF path resolution scattered across subfolders (vendor/*, docs/, .claude/); 3.10.4
# anchors RVF, so this advisory now surfaces historical strays. Removal is
# gated behind `fix-learning --cleanup --confirm` (so deletion always needs an explicit
# opt-in). See common.sh sweep_stray_aqe_dirs + AQE-PROJECT-ROOT-PIN-V1 above.
header "7" "Stray RVF .agentic-qe advisory (RVF-STRAY-SWEEP-V1)"
sweep_stray_aqe_dirs "$TARGET_DIR" list
if [[ "${SWEEP_STRAY_COUNT:-0}" -eq 0 ]]; then
  pass "no stray RVF .agentic-qe dirs (root store is the only one)"
else
  info "$SWEEP_STRAY_COUNT stray RVF dir(s) — remove with: bin/ruflo-kit fix-learning $TARGET_DIR --cleanup --confirm"
fi

# ── Step 8: pre-bash block must exit 2 (HOOK-BLOCK-EXIT2-V1) ─────────────────
# Upstream's generated hook-handler.cjs "blocks" dangerous commands with
# process.exit(1) — but per the Claude Code hook contract exit 1 is a
# NON-blocking error (the command still runs); only exit 2 blocks. The helper
# is regenerated by upstream refreshes, so re-heal it here. Uses defect_gate
# (grep the installed helper for the literal bug) so the patch self-retires
# the day upstream ships exit 2 itself.
header "8" "pre-bash dangerous-command block exit code (HOOK-BLOCK-EXIT2-V1)"
HH="$CLAUDE_HELPERS/hook-handler.cjs"
if [[ ! -f "$HH" ]]; then
  warn "hook-handler.cjs not present — skipping"
elif defect_gate "$HH" '\[BLOCKED\] Dangerous command' "pre-bash block present" >/dev/null \
     && ! grep -q "HOOK-BLOCK-EXIT2-V1" "$HH" \
     && awk '/\[BLOCKED\] Dangerous command/{f=1} f&&/process\.exit\(1\)/{found=1} END{exit !found}' "$HH"; then
  if [[ "${DRY_RUN:-0}" -eq 1 ]]; then
    info "[dry-run] would rewrite pre-bash block process.exit(1) → exit(2)"
  else
    [[ -e "$HH.exit2-bak" ]] || cp "$HH" "$HH.exit2-bak"
    # \r?\n: the upstream cross-platform refresh writes this helper with CRLF
    # endings — match either and re-emit the captured newline so we never mix.
    node -e 'const fs=require("fs"),F=process.argv[1];let s=fs.readFileSync(F,"utf8");s=s.replace(/(\[BLOCKED\] Dangerous command detected: \$\{d\}`\);)(\r?\n)([ \t]*)process\.exit\(1\);/,"$1$2$3// Exit 2 = blocking per the Claude Code hook contract (exit 1 is non-blocking). HOOK-BLOCK-EXIT2-V1$2$3process.exit(2);");fs.writeFileSync(F,s)' "$HH"
    if node --check "$HH" 2>/dev/null && grep -q "HOOK-BLOCK-EXIT2-V1" "$HH"; then
      fix "pre-bash dangerous-command block now exits 2 (HOOK-BLOCK-EXIT2-V1)"
      pass "block exit code healed → 2"
    else
      warn "exit-2 patch failed or produced invalid JS — restoring"; cp "$HH.exit2-bak" "$HH"
    fi
  fi
elif grep -q "HOOK-BLOCK-EXIT2-V1" "$HH" 2>/dev/null; then
  pass "pre-bash block already exits 2 (HOOK-BLOCK-EXIT2-V1)"
else
  pass "exit(1) defect not found in pre-bash block — nothing to heal (self-retired)"
fi

echo -e "\n============================================"
echo " fix-aqe complete — ${FIXES} change(s)"
for l in "${FIX_LOG[@]:-}"; do [[ -n "$l" ]] && echo "   • $l"; done
echo "============================================"
