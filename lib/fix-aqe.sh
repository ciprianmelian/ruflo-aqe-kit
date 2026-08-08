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
  # B11: this mkdir used to run unconditionally, ahead of the per-file dry-run
  # checks below, so `fix-aqe --dry-run` against a fresh target physically
  # created .claude/helpers/. Gate it — a dry-run only reports what it would do.
  if [[ "$DRY_RUN" -eq 1 ]]; then
    [[ -d "$CLAUDE_HELPERS" ]] || info "[dry-run] would create directory: $CLAUDE_HELPERS"
  else
    mkdir -p "$CLAUDE_HELPERS"
  fi
  # _derive-outcome.cjs MUST install alongside its consumers: aqe-post-route.cjs and
  # ruflo-train-subagent.cjs `require('./_derive-outcome.cjs')` relative to __dirname,
  # so the oracle has to land in .claude/helpers/ too (listed first for clarity).
  # _npm-root.cjs (NPM-ROOT-RESOLVE-V1) likewise: ruflo-train*.cjs and
  # aqe-rag-inject.cjs `require('./_npm-root.cjs')` for the honest global
  # node_modules root (npm root -g, execPath fallback) — same co-install rule.
  for h in _derive-outcome.cjs _npm-root.cjs ruflo-train.cjs ruflo-train-subagent.cjs aqe-rag-inject.cjs aqe-post-route.cjs ruflo-route-capture.cjs; do
    src="$HELPER_SRC/$h"; dst="$CLAUDE_HELPERS/$h"
    [[ -f "$src" ]] || { warn "missing source $h"; continue; }
    if cmp -s "$src" "$dst" 2>/dev/null; then pass "$h up to date"; continue; fi
    if [[ "$DRY_RUN" -eq 1 ]]; then info "[dry-run] would install $h"; continue; fi
    [[ -f "$dst" && ! -e "$dst.fixaqe-bak" ]] && cp "$dst" "$dst.fixaqe-bak"
    cp "$src" "$dst" && { node --check "$dst" 2>/dev/null && { fix "Installed .claude/helpers/$h"; pass "installed $h"; } || { warn "$h failed node --check"; }; }
  done

  # HELPER-SEED-V1: baseline copies of the CLI-generated helpers (router.js,
  # session.js, hook-handler.cjs, statusline*, …) as healed + behavior-tested on
  # a dogfooded machine. These are normally written by `ruflo init`/`aqe init`
  # and then surgically healed in place — so they are installed ONLY WHEN
  # MISSING (a fresh target / CI checkout), never overwriting an existing
  # upstream-generated file. This is what lets the kit's vitest suite run on a
  # clean clone (nightly-drift "Kit unit tests" step).
  # HELPER-SEED-UPSTREAM-V1: prefer the copy the INSTALLED ruflo ships over the
  # kit's vendored fossil, for the helpers ruflo owns.
  #
  # Most files below are ruflo's, not the kit's; a vendored copy of someone
  # else's file drifts the moment they ship a new one. Measured against ruflo
  # 3.34.0: 7 of 13 vendored seeds had drifted, and intelligence.cjs predated
  # `resolveProjectRoot` — so a clean checkout got a helper missing a function
  # three test files require, while a dev machine passed because ruflo's own
  # session hooks had written the real file. Seeding from the installed package
  # makes a CI checkout match a real machine and retires the drift class
  # instead of resetting its clock.
  #
  # The four KIT-AUTHORED helpers (brain-checkpoint.cjs, github-safe.mjs,
  # ruflo-hook.cjs, statusline-v3.cjs) have no upstream counterpart and MUST
  # keep seeding from assets/. statusline.cjs has its own canonical source
  # (see CANONICAL-STATUSLINE below). Everything else falls back to the
  # vendored copy when ruflo cannot be resolved (offline, or upstream moved
  # the path), so this never makes a working target worse.
  RUFLO_HELPERS="$(kit_ruflo_helper_dir 2>/dev/null || true)"
  # ONLY intelligence.cjs. This set was briefly wider and that was a mistake,
  # caught by nightly-drift: EVERY seeded helper is pinned by a kit test that
  # asserts the behaviour of the kit's VENDORED copy (router.js → router.test.js,
  # session.js → session{,-memory}.test.js, statusline.js → statusline-js.test.js,
  # and so on). Seeding those from upstream fixed nothing and broke four suites.
  #
  # intelligence.cjs is the one genuine case, and it is the reverse: its three
  # test files require `resolveProjectRoot`, which ONLY upstream's copy defines
  # — the vendored fossil predated it, which is what broke CI in the first place.
  # So upstream is authoritative for this file and the kit must not freeze it.
  #
  # hook-handler.cjs is excluded for a third, stronger reason even though ruflo
  # ships one: the kit's vendored copy carries HOOK-BLOCK-EXIT2-V1 (the
  # dangerous-command block) and upstream's does not. Seeding upstream's would
  # hand a fresh target an unpatched hook and leave that security property
  # depending on Step 8's anchor still matching a newer upstream shape, instead
  # of being present by construction.
  _helper_is_upstream_owned() {
    case "$1" in
      intelligence.cjs) return 0 ;;
      *) return 1 ;;
    esac
  }

  for h in auto-memory-hook.mjs brain-checkpoint.cjs github-safe.mjs \
           hook-handler.cjs intelligence.cjs learning-service.mjs memory.js \
           metrics-db.mjs router.js ruflo-hook.cjs session.js \
           statusline-v3.cjs statusline.cjs statusline.js v3/advisor-call.cjs; do
    src="$HELPER_SRC/$h"; dst="$CLAUDE_HELPERS/$h"; src_origin="vendored"
    # CANONICAL-STATUSLINE: statusline.cjs seeds from the canonical asset
    # (assets/statusline.cjs — the single source of truth fix-statusbar installs
    # + TRUTH-STATUSLINE-V1 targets), never the claude-helpers/ copy (removed in
    # the canonical consolidation). Redirecting the seed source here means the
    # loop tolerates that copy's absence silently.
    if [[ "$h" == "statusline.cjs" ]]; then
      src="$KIT_ASSETS/statusline.cjs"; src_origin="canonical"
    elif [[ -n "$RUFLO_HELPERS" ]] && _helper_is_upstream_owned "$h" && [[ -f "$RUFLO_HELPERS/$h" ]]; then
      src="$RUFLO_HELPERS/$h"; src_origin="upstream"
    fi
    [[ -f "$src" ]] || { warn "missing seed source $h"; continue; }
    [[ -f "$dst" ]] && { pass "$h present (seed skipped — upstream/healed copy kept)"; continue; }
    if [[ "$DRY_RUN" -eq 1 ]]; then info "[dry-run] would seed $h"; continue; fi
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst" && { node --check "$dst" 2>/dev/null && { fix "Seeded .claude/helpers/$h from $src_origin source (HELPER-SEED-V1)"; pass "seeded $h ($src_origin)"; } || { warn "$h failed node --check"; }; }
  done
  if [[ -z "$RUFLO_HELPERS" ]]; then
    warn "ruflo helper dir unresolvable — upstream-owned helpers seeded from the kit's VENDORED copies, which may be stale (HELPER-SEED-UPSTREAM-V1)"
  fi

  # HELPER-MODULE-PIN-V1: in a "type":"module" project, the CJS helpers load as ES
  # modules and the PreCompact/SessionEnd hooks crash with "require is not defined".
  # Pin .claude/helpers/ to commonjs + relocate the ESM github-safe.js -> .mjs.
  case "$(pin_helpers_module_type "$TARGET_DIR")" in
    PINNED)          fix "Pinned .claude/helpers to commonjs (+github-safe.mjs)"; pass "helper module-type pinned (commonjs) — fixes hook 'require is not defined' in ESM projects" ;;
    MJS_ONLY)        fix "Relocated ESM github-safe.js -> github-safe.mjs (commonjs root)"; pass "github-safe relocated to .mjs — fixes 'Cannot use import statement' under a commonjs root" ;;
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
        && !h.command.includes(process.env.KITDIR || ' ')) {
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
# relative path. Currently EMPTY (.gitkeep only): the sole asset, analysis/
# COMMAND_COMPLIANCE_REPORT.md, was retired in Patch 83 — fix-ruflo Step 5l
# classifies that file as confirmed-dead and deletes it from targets, so the
# kit was deleting and re-seeding the same file on every sync. cmp-skip /
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

# ── Step 8b: in-process embedder resolvability (AQE-EMBEDDER-RESOLVE-V1) ─────
# agentic-qe's real-embeddings.js does `await import('@huggingface/transformers')`
# in its in-process branch, but agentic-qe declares that package in
# devDependencies ONLY — and `npm i -g` never installs devDeps. So on a stock
# global install the import ALWAYS fails and in-process embeddings are dead.
#
# The failure is silent, which is why it ran for weeks unnoticed: the caller
# (ensurePatternEmbedding) swallows the throw at console.debug, so experience
# rows keep landing while their embedding column stays NULL. Measured on the
# 2026-08-01 gauntlet target: 2026-06 = 977 rows / 0 NULL, 2026-08 = 236 rows /
# 236 NULL, i.e. 100% dead with every instrument still green.
#
# Heal by installing the package TOP-LEVEL in the global root. agentic-qe
# resolves it via the ancestor walk (<npm-root>/.. -> <npm-root>), and unlike a
# nested copy or a symlink into ruflo's tree, a top-level sibling is untouched by
# `npm i -g agentic-qe` AND `npm i -g ruflo` — so it never needs re-assertion.
#
# ASSERT THE PROPERTY, NOT THE ARTIFACT: the probe asks "can agentic-qe resolve
# it?", never "does directory X exist?". If upstream ever promotes the dep to
# dependencies/optionalDependencies, npm installs it nested, nested wins the
# resolution, the probe passes and this step no-ops forever — self-retiring by
# construction (defect_gate spirit).
#
# MONOTONE: this step only ever ADDS. It never removes a copy it did not create
# and never tears down one layout to impose another — a step that enforced a
# preferred layout could flip-flop between nested and top-level on every run.
#
# SECURITY NOTE (deliberate override, do not silently revert): upstream withholds
# this dep on purpose (#565) because onnxruntime-node pulls adm-zip <0.6.0,
# GHSA-xcpc-8h2w-3j85. The kit re-enables it knowingly. Verified mitigation: that
# exact chain (onnxruntime-node -> adm-zip 0.5.18) is ALREADY installed and
# loaded on any ruflo host via agentdb's optional dep, so this adds no new
# exposure class; adm-zip is used at install time to unpack a Microsoft-CDN
# archive, not attacker-controlled input. Revisit if onnxruntime-node's range
# moves past adm-zip 0.6.0.
KIT_HF_TRANSFORMERS_MIN="4.2.0"   # FLOOR, never equality (KIT_AGENTDB_HOISTED_MIN precedent)
header "8b" "AQE in-process embedder resolvable (AQE-EMBEDDER-RESOLVE-V1)"
GNM_EMB="$(npm root -g 2>/dev/null)"
RE_JS="$GNM_EMB/agentic-qe/dist/learning/real-embeddings.js"
# Resolve FROM real-embeddings.js itself — the importer's location is what Node
# uses, so this is the same question the failing import asks.
_emb_resolves() {
  [[ -f "$RE_JS" ]] || return 1
  node -e 'require("module").createRequire(process.argv[1]).resolve("@huggingface/transformers")' \
       "$RE_JS" >/dev/null 2>&1
}
# Echoes "<pkg-dir>\t<version>" for the copy agentic-qe actually resolves; rc 1 if
# undeterminable. NB: `resolve("@huggingface/transformers/package.json")` is NOT
# usable — the package's exports map denies that subpath (ERR_PACKAGE_PATH_NOT_
# EXPORTED), which silently yielded an empty version and skipped the floor check
# entirely on first write of this step. Walk up from the resolved ENTRY instead,
# and confirm the manifest's name matches so we cannot land on a parent package.
_emb_pkg_info() {
  [[ -f "$RE_JS" ]] || return 1
  node -e '
const {createRequire}=require("module"),path=require("path"),fs=require("fs");
let d;try{d=path.dirname(createRequire(process.argv[1]).resolve("@huggingface/transformers"))}catch(e){process.exit(1)}
for(let i=0;i<8;i++){
  const p=path.join(d,"package.json");
  if(fs.existsSync(p)){try{const j=JSON.parse(fs.readFileSync(p,"utf8"));
    if(j.name==="@huggingface/transformers"){process.stdout.write(d+"\t"+(j.version||""));process.exit(0)}}catch(e){}}
  const up=path.dirname(d); if(up===d) break; d=up;
}
process.exit(1);' "$RE_JS" 2>/dev/null
}
if [[ -z "$GNM_EMB" || ! -f "$RE_JS" ]]; then
  pass "agentic-qe real-embeddings.js not installed — nothing to assert (self-retired)"
elif _emb_resolves; then
  EMB_INFO="$(_emb_pkg_info)"; EMB_DIR="${EMB_INFO%%$'\t'*}"; EMB_VER="${EMB_INFO##*$'\t'}"
  if [[ -z "$EMB_VER" ]]; then
    # Third state, spoken aloud: resolvable but the manifest could not be read, so
    # the floor is UNVERIFIED. Never let "could not tell" print as a floor pass.
    warn "in-process embedder resolvable but version undeterminable — floor $KIT_HF_TRANSFORMERS_MIN NOT verified"
  elif aqe_semver_lt "$EMB_VER" "$KIT_HF_TRANSFORMERS_MIN"; then
    warn "embedder resolves but v$EMB_VER < floor $KIT_HF_TRANSFORMERS_MIN — upgrading"
    kit_npm_global_install "@huggingface/transformers@^$KIT_HF_TRANSFORMERS_MIN" \
      && fix "embedder upgraded to floor (AQE-EMBEDDER-RESOLVE-V1)" \
      || warn "embedder upgrade failed — in-process embeddings may be degraded"
  else
    pass "in-process embedder resolvable (v$EMB_VER) — ${EMB_DIR#$GNM_EMB/}"
  fi
elif [[ "${DRY_RUN:-0}" -eq 1 ]]; then
  info "[dry-run] would: npm install -g @huggingface/transformers@^$KIT_HF_TRANSFORMERS_MIN (in-process embeddings currently DEAD)"
else
  warn "in-process embedder UNRESOLVABLE from agentic-qe — embeddings are silently dead"
  if kit_npm_global_install "@huggingface/transformers@^$KIT_HF_TRANSFORMERS_MIN" && _emb_resolves; then
    fix "in-process embedder installed top-level and now resolves (AQE-EMBEDDER-RESOLVE-V1)"
    pass "embedder healed — capture rows will carry vectors again"
  else
    warn "embedder install did not make it resolvable — in-process embeddings stay dead (see ${KIT_NPM_LOG:-/tmp/ruflo-kit-npm-global.log})"
  fi
fi

# ── Step 8c: capture hook shim currency (AQE-HOOK-SHIM-STDIN-V1) ─────────────
# `aqe init` COPIES .claude/hooks/aqe-hook.cjs into the target once and nothing
# ever refreshes it. A shim predating upstream's stdin fix spawns the CLI with
# stdio ['ignore',...], discarding the hook event JSON — and the PostToolUse
# command passes `--file "$TOOL_INPUT_file_path"`, which Claude Code does NOT
# expand (upstream #453). With no stdin to fall back on, every captured row
# lands as the content-free string "<domain>: edit: " with the path missing.
# Observed on a target carrying a 7-week-old shim: 3137 of 3139 eligible rows
# identical, which trained its LoRA 5611 times on ~1 direction.
#
# ASSERT THE PROPERTY, NOT A HASH: targets legitimately differ from upstream
# (local hardening, version skew), so a sha256 equality check would flag healthy
# installs and teach operators to ignore it. What matters is exactly one thing —
# is stdin readable by the child? Heal by refreshing from the INSTALLED
# agentic-qe copy, which is upstream's own current shim.
header "8c" "capture hook shim passes stdin through (AQE-HOOK-SHIM-STDIN-V1)"
SHIM="$TARGET_DIR/.claude/hooks/aqe-hook.cjs"
SHIM_SRC="$(npm root -g 2>/dev/null)/agentic-qe/.claude/hooks/aqe-hook.cjs"
_shim_reads_stdin() { grep -qE "stdio:[[:space:]]*\[[[:space:]]*'inherit'" "$1" 2>/dev/null; }
if [[ ! -f "$SHIM" ]]; then
  pass "no aqe-hook.cjs installed here — capture shim not in use (nothing to assert)"
elif _shim_reads_stdin "$SHIM"; then
  pass "capture hook shim passes stdin through — file paths reach captured experiences"
elif [[ ! -f "$SHIM_SRC" ]]; then
  warn "capture hook shim DISCARDS stdin (captured tasks will lose their file path), and no upstream copy is installed to heal from — reinstall agentic-qe"
elif ! _shim_reads_stdin "$SHIM_SRC"; then
  warn "capture hook shim discards stdin, but the installed agentic-qe copy does too — upstream regression, not healable here (leaving target untouched)"
elif [[ "${DRY_RUN:-0}" -eq 1 ]]; then
  info "[dry-run] would refresh $SHIM from the installed agentic-qe copy (currently discards stdin)"
else
  cp -p "$SHIM" "$SHIM.stdin-bak" 2>/dev/null || true
  if cp "$SHIM_SRC" "$SHIM" && node --check "$SHIM" 2>/dev/null && _shim_reads_stdin "$SHIM"; then
    fix "capture hook shim refreshed — stdin now reaches the CLI (AQE-HOOK-SHIM-STDIN-V1)"
    pass "captured tasks will carry their file path again"
  else
    warn "shim refresh failed or produced invalid JS — restoring previous copy"
    [[ -f "$SHIM.stdin-bak" ]] && cp "$SHIM.stdin-bak" "$SHIM"
  fi
fi

# ── Step 9: ONNX model-cache seed (MODEL-CACHE-SEED-V1) ──────────────────────
# transformers.js ignores TRANSFORMERS_CACHE and caches MiniLM weights INSIDE
# the global package (@huggingface/transformers/.cache) — wiped on every
# `npm i -g agentic-qe`, forcing a ~25MB re-download on the next embed (and
# breaking first-embed offline). fix-aqe runs after every AQE reinstall in the
# documented A3b flow, so heal here: harvest whatever caches exist into the
# per-user vault, then reseed any freshly-wiped package cache from it.
# Both operations are merge-update + best-effort (see common.sh).
header "9" "ONNX model-cache seed (MODEL-CACHE-SEED-V1)"
info "vault: $(kit_model_vault) · $(kit_preserve_model_caches) · $(kit_restore_model_caches)"
GNM_MC="$(npm root -g 2>/dev/null)"
# The cache lives inside whichever copy agentic-qe ACTUALLY resolves, so derive
# that dir instead of hardcoding one. The old probe hardcoded
# agentic-qe/node_modules/@huggingface/transformers/.cache — a path that CANNOT
# exist, because the dep is devDependencies-only and never installs there. So it
# took the else branch unconditionally and had, since the day it was written,
# only ever printed "weights not in package cache". That reads as a benign cache
# miss while the real state was "the package is absent and in-process embeddings
# are permanently dead" — a check that could not tell the two apart.
MC_PKG_DIR="$(_emb_pkg_info)"; MC_PKG_DIR="${MC_PKG_DIR%%$'\t'*}"
# v3 caches onnx/model.onnx (fp32) or onnx/model_quantized.onnx depending on dtype — accept either.
if [[ -z "$GNM_MC" || -z "$MC_PKG_DIR" ]]; then
  # Distinct third state: not a cache verdict at all. Step 8b owns this failure.
  warn "MiniLM cache NOT ASSESSABLE — @huggingface/transformers unresolvable from agentic-qe (see Step 8b), so there is no package cache to check"
elif ls "$MC_PKG_DIR/.cache/Xenova/all-MiniLM-L6-v2/onnx"/model*.onnx >/dev/null 2>&1; then
  pass "AQE MiniLM weights present in resolved package cache (disk-hit on next embed) — ${MC_PKG_DIR#$GNM_MC/}"
else
  warn "AQE MiniLM weights not in package cache at ${MC_PKG_DIR#$GNM_MC/} — first embed will download (network needed)"
fi

# ── Step 10: resolveProjectRoot walk-up boundary exclusion (INTEL-ROOTWALK-V1) ──
# .claude/helpers/intelligence.cjs's resolveProjectRoot() walks UP from cwd
# accepting a bare `.claude-flow` directory with no corroborating `.git` — a
# shared/ancestor directory (e.g. the OS temp root, or $HOME) can accumulate a
# stray `.claude-flow` left by an unrelated writer, and any nested
# fixture/subdir lacking its own marker silently inherits that ancestor's
# project state. Same defect shape as the historical ~/.agentic-qe
# findProjectRoot hijack (topmost-wins leaking one project's learning into
# another), resolved upstream in aqe 3.10.4 by anchoring to the
# nearer/corroborated root.
#
# Revision history (all superseded, all left as recognized migration sources
# below so every prior tier reaches the current form in one hop):
#   v1 "depth-0" — trusted a bare `.claude-flow` only at the walk's own
#     origin. Regressed a real case: a non-git project with `.claude-flow`
#     at its root, invoked from a subdirectory, no longer found its own
#     root and fell back to the origin, fragmenting state into a stray
#     per-subdirectory `.claude-flow`.
#   v2 "shared-root exclusion, realpath-per-directory" — excluded $HOME/OS
#     temp root/fs root by comparing `fs.realpathSync(candidate)` against a
#     realpath'd-only exclusion set. Had a real bypass: a caller can pass an
#     alias-form startDir the walk never resolves — a realpath'd-only
#     exclusion set never string-matches a stray marker sitting exactly at
#     the boundary in alias form, so it was adopted anyway. Also missed CI
#     runners whose real temp root is a distinct env var (e.g. GitHub
#     Actions' RUNNER_TEMP) from `os.tmpdir()`.
#   v3 "boundary set, string-normalized, both raw+realpath forms, +literal
#     /tmp" — precomputed a set of the raw AND realpath'd, trailing-
#     separator-normalized form of $HOME/`os.tmpdir()`/literal `/tmp`/
#     $TMPDIR/$TEMP/$TMP/fs-root, string-matched at check time. Closed the
#     v2 alias bypass and the missing-`/tmp` gap, and dropped the per-level
#     realpath cost entirely (a pure string comparison). Had TWO real
#     problems of its own: (a) $TMPDIR/$TEMP/$TMP were trusted verbatim —
#     an operator setting e.g. `TMPDIR=$BUILD_DIR` (a plausible CI
#     misconfiguration) would silently exclude that entire real project;
#     (b) STRING comparison — even of realpath'd values — is fooled by a
#     case-insensitive-but-preserving filesystem (macOS APFS): realpathSync
#     preserves input case, so a case-differing alias of a boundary never
#     string-matched it, and a stray marker sitting there was adopted
#     anyway. This reproduced the ORIGINAL defect through a new alias
#     class.
#
# v4 (current): identity, not strings. Boundary membership is decided by
# `(dev, ino)` from `fs.statSync`, precomputed once per boundary and stat'd
# once per candidate directory in the walk — never by comparing path
# strings, realpath'd or not. This closes case-aliasing, symlink-aliasing,
# trailing separators, and `..` segments in a single mechanism, with no
# platform gating and no normalization guesswork (a `toLowerCase()`-style
# fix would be wrong on case-SENSITIVE volumes, where two distinct
# directories can differ only in case). Each `statSync` is wrapped in
# try/catch so a nonexistent boundary or candidate contributes nothing
# rather than throwing. $TMPDIR/$TEMP/$TMP are validated — absolute path
# AND existing directory — before being trusted; this rejects empty,
# relative, and nonexistent values, but by design cannot distinguish
# "operator meant this as a temp root" from "operator misconfigured it"
# without guessing, so a $TMPDIR genuinely pointed at a real, existing
# project root remains a documented residual failure mode (tested, not
# hidden) rather than something silently guessed around. `.git` and
# `.claude-flow` are both gated by the SAME boundary check (a yadm-style
# dotfiles `.git` at $HOME is the historical `~/.agentic-qe` hijack
# through a different marker) — this is intentional and unchanged from v3,
# not a new decision. A project living UNDER an excluded root is
# unaffected, since only the root directory itself is ever excluded, never
# its children. CLAUDE_PROJECT_DIR stays checked first and unconditionally,
# unchanged. There is exactly one production call site (module load) at a
# depth of a few levels per fresh hook subprocess, never a hot loop —
# correctness, not per-level cost, is what matters here; do not
# reintroduce string/realpath comparison to "optimize" this.
#
# v5: the boundary set built at the top of resolveProjectRoot is a ONE-SHOT
# snapshot with no re-check. If a single stat() during that construction
# fails transiently (EMFILE under fd pressure, an EACCES race, ENOENT/ESTALE
# during a remount), v4 silently dropped that boundary from the set for the
# rest of the call — even though the walk itself later reaches that exact
# directory once the transient condition has cleared, and adopts a bare
# `.claude-flow` sitting there as if it were a legitimate project (the
# original defect, reintroduced via a construction-time race rather than an
# alias). Proved against the real, unmodified file with a stateful
# fs.statSync monkeypatch that throws once for the boundary path and behaves
# normally afterward, including for the walk's own later re-check — the
# candidate-side check (isSharedRoot during the walk) does NOT have this
# problem, since `fs.existsSync(dir/.git)` hits the identical access barrier
# at the identical instant and the two failures cancel out; the
# construction side has no such re-check to cancel against. v5 distinguishes
# ENOENT/ENOTDIR (genuinely absent — skip is correct) from any other errno
# (unknown — must not silently degrade to absent): an unknown failure sets
# `_rootwalkDegraded`, and while degraded this call stops trusting bare
# `.claude-flow` entirely, falling through to `.git` only (still gated by
# the same isSharedRoot check as before — this is the existing, disclosed
# yadm-dotfiles tradeoff, unchanged, not a new one). Rare and
# self-correcting — the next hook invocation gets a fresh call and a fresh
# boundary set — so this trades occasional non-detection for never adopting
# an unverified boundary, the same fail-closed direction as everywhere else
# in this function.
#
# The installed file is regenerated by upstream `ruflo init`/`aqe init`
# (byte-identical to the copy bundled inside the ruflo/claude-flow npm
# packages) and only ever seeded here when absent (HELPER-SEED-V1 above), so
# heal it in place the same way HOOK-BLOCK-EXIT2-V1 heals hook-handler.cjs:
# defect_gate on the literal bug, a single anchored string patch that writes
# nothing unless the whole anchor matches (ANCHOR_NOT_FOUND -> untouched),
# self-retiring the day upstream ships the fix itself. Six pre-patch forms
# are recognized (pristine, v1, v2, v3-without-/tmp, v3-with-/tmp, v4) so
# every prior tier migrates straight to the current form in one hop.
header "10" "resolveProjectRoot walk-up boundary exclusion (INTEL-ROOTWALK-V1)"
INTEL="$CLAUDE_HELPERS/intelligence.cjs"
if [[ ! -f "$INTEL" ]]; then
  warn "intelligence.cjs not present — skipping"
elif grep -q "_rootwalkDegraded" "$INTEL" 2>/dev/null; then
  pass "resolveProjectRoot already identity-boundary-excluded with degraded-boundary handling (INTEL-ROOTWALK-V1 v5)"
elif defect_gate "$INTEL" "fs\.existsSync\(path\.join\(dir, '\.claude-flow'\)\)\) \{" "pristine bare .claude-flow walk-up" >/dev/null \
     || grep -q "INTEL-ROOTWALK-V1" "$INTEL" 2>/dev/null; then
  if [[ "${DRY_RUN:-0}" -eq 1 ]]; then
    info "[dry-run] would rewrite resolveProjectRoot .claude-flow walk-up to identity-based (dev,ino) boundary exclusion with degraded-boundary handling (INTEL-ROOTWALK-V1 v5)"
  else
    [[ -e "$INTEL.rootwalk-bak" ]] || cp "$INTEL" "$INTEL.rootwalk-bak"
    patcher="$(mktemp)"
    cat > "$patcher" <<'PJS'
const fs = require('fs'); const F = process.argv[2];
let raw = fs.readFileSync(F, 'utf8');
if (raw.includes('_rootwalkDegraded')) { process.exit(0); }
const crlf = raw.includes('\r\n');
let s = crlf ? raw.replace(/\r\n/g, '\n') : raw;

// Six recognized pre-patch forms, all migrating straight to the current
// (v5, identity-based + degraded-boundary handling) shape in one hop.
const anchorPristine = "  let dir = path.resolve(startDir || process.cwd());\n  while (true) {\n    if (fs.existsSync(path.join(dir, '.git')) ||\n        fs.existsSync(path.join(dir, '.claude-flow'))) {\n      return dir;\n    }";
const anchorV1 = "  const origin = path.resolve(startDir || process.cwd()); // INTEL-ROOTWALK-V1\n  let dir = origin;\n  while (true) {\n    if (fs.existsSync(path.join(dir, '.git'))) return dir;\n    // A bare .claude-flow with no corroborating .git is trusted only at the\n    // walk origin (depth 0); an ancestor bare .claude-flow (e.g. a stray\n    // marker left by another writer in a shared temp root) is no longer\n    // silently adopted while walking up.\n    if (dir === origin && fs.existsSync(path.join(dir, '.claude-flow'))) return dir;";
const anchorV2 = "  const origin = path.resolve(startDir || process.cwd()); // INTEL-ROOTWALK-V1\n  // A bare .claude-flow with no corroborating .git is trusted at any walk-up\n  // depth EXCEPT when the candidate directory is itself shared infrastructure\n  // ($HOME, the OS temp root, or the filesystem root) -- those accumulate\n  // stray markers left by unrelated writers (the historical ~/.agentic-qe\n  // hijack was HOME; a stray marker at a shared OS temp root is the concrete\n  // case this guards). .git remains trusted at any depth -- an unambiguous\n  // project-root signal. A project living UNDER an excluded root (e.g.\n  // <tmp>/proj/.claude-flow) is unaffected -- only the root itself is\n  // excluded, not its children.\n  const _rootwalkRealpath = (p) => { try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); } };\n  const _rootwalkExcluded = new Set();\n  try { _rootwalkExcluded.add(_rootwalkRealpath(require('os').homedir())); } catch (e) {}\n  try { _rootwalkExcluded.add(_rootwalkRealpath(require('os').tmpdir())); } catch (e) {}\n  _rootwalkExcluded.add(path.resolve(path.parse(origin).root));\n  const isSharedRoot = (d) => _rootwalkExcluded.has(_rootwalkRealpath(d));\n  let dir = origin;\n  while (true) {\n    if (fs.existsSync(path.join(dir, '.git'))) return dir;\n    if (fs.existsSync(path.join(dir, '.claude-flow')) && !isSharedRoot(dir)) return dir;";
const anchorV3NoTmp = "  const origin = path.resolve(startDir || process.cwd()); // INTEL-ROOTWALK-V1\n  // A bare .claude-flow OR .git is trusted at any walk-up depth EXCEPT when\n  // the candidate directory IS itself shared infrastructure ($HOME, the OS\n  // temp root incl. TMPDIR/TEMP/TMP, or the filesystem root) -- those\n  // accumulate stray markers left by unrelated writers (the historical\n  // ~/.agentic-qe hijack was HOME; a stray marker at a shared OS temp root\n  // is the concrete case this guards; a yadm-style dotfiles .git at $HOME\n  // is the same hazard through a different marker, so both markers are\n  // excluded uniformly at a boundary, not just .claude-flow). The boundary\n  // set is precomputed ONCE per call (never per directory in the walk) and\n  // stores BOTH the raw and the realpath'd form of each entry, normalized --\n  // a caller can pass an alias-form startDir, and the walk itself never\n  // resolves symlinks, so matching only the realpath'd form would miss it.\n  // A project living UNDER an excluded root is unaffected -- only the root\n  // itself is excluded, not its children. If the origin itself is a\n  // boundary, the walk exhausts and falls back to the origin.\n  const _rootwalkNorm = (p) => {\n    const s = String(p);\n    const stripped = s.replace(/[\\\\/]+$/, '');\n    return stripped.length > 0 ? stripped : s.slice(0, 1);\n  };\n  const _rootwalkBoundary = new Set();\n  const _rootwalkAddBoundary = (p) => {\n    if (!p) return;\n    _rootwalkBoundary.add(_rootwalkNorm(p));\n    try { _rootwalkBoundary.add(_rootwalkNorm(fs.realpathSync(p))); } catch (e) {}\n  };\n  try { _rootwalkAddBoundary(require('os').homedir()); } catch (e) {}\n  try { _rootwalkAddBoundary(require('os').tmpdir()); } catch (e) {}\n  try { _rootwalkAddBoundary(process.env.TMPDIR); } catch (e) {}\n  try { _rootwalkAddBoundary(process.env.TEMP); } catch (e) {}\n  try { _rootwalkAddBoundary(process.env.TMP); } catch (e) {}\n  try { _rootwalkAddBoundary(path.parse(origin).root); } catch (e) {}\n  const isSharedRoot = (d) => _rootwalkBoundary.has(_rootwalkNorm(d));\n  let dir = origin;\n  while (true) {\n    if (!isSharedRoot(dir)) {\n      if (fs.existsSync(path.join(dir, '.git'))) return dir;\n      if (fs.existsSync(path.join(dir, '.claude-flow'))) return dir;\n    }";
const anchorV3WithTmp = "  const origin = path.resolve(startDir || process.cwd()); // INTEL-ROOTWALK-V1\n  // A bare .claude-flow OR .git is trusted at any walk-up depth EXCEPT when\n  // the candidate directory IS itself shared infrastructure ($HOME, the OS\n  // temp root incl. TMPDIR/TEMP/TMP, or the filesystem root) -- those\n  // accumulate stray markers left by unrelated writers (the historical\n  // ~/.agentic-qe hijack was HOME; a stray marker at a shared OS temp root\n  // is the concrete case this guards; a yadm-style dotfiles .git at $HOME\n  // is the same hazard through a different marker, so both markers are\n  // excluded uniformly at a boundary, not just .claude-flow). The boundary\n  // set is precomputed ONCE per call (never per directory in the walk) and\n  // stores BOTH the raw and the realpath'd form of each entry, normalized --\n  // a caller can pass an alias-form startDir, and the walk itself never\n  // resolves symlinks, so matching only the realpath'd form would miss it.\n  // A project living UNDER an excluded root is unaffected -- only the root\n  // itself is excluded, not its children. If the origin itself is a\n  // boundary, the walk exhausts and falls back to the origin.\n  const _rootwalkNorm = (p) => {\n    const s = String(p);\n    const stripped = s.replace(/[\\\\/]+$/, '');\n    return stripped.length > 0 ? stripped : s.slice(0, 1);\n  };\n  const _rootwalkBoundary = new Set();\n  const _rootwalkAddBoundary = (p) => {\n    if (!p) return;\n    _rootwalkBoundary.add(_rootwalkNorm(p));\n    try { _rootwalkBoundary.add(_rootwalkNorm(fs.realpathSync(p))); } catch (e) {}\n  };\n  try { _rootwalkAddBoundary(require('os').homedir()); } catch (e) {}\n  try { _rootwalkAddBoundary(require('os').tmpdir()); } catch (e) {}\n  try { _rootwalkAddBoundary('/tmp'); } catch (e) {}\n  try { _rootwalkAddBoundary(process.env.TMPDIR); } catch (e) {}\n  try { _rootwalkAddBoundary(process.env.TEMP); } catch (e) {}\n  try { _rootwalkAddBoundary(process.env.TMP); } catch (e) {}\n  try { _rootwalkAddBoundary(path.parse(origin).root); } catch (e) {}\n  const isSharedRoot = (d) => _rootwalkBoundary.has(_rootwalkNorm(d));\n  let dir = origin;\n  while (true) {\n    if (!isSharedRoot(dir)) {\n      if (fs.existsSync(path.join(dir, '.git'))) return dir;\n      if (fs.existsSync(path.join(dir, '.claude-flow'))) return dir;\n    }";

const anchorV4 = "  const origin = path.resolve(startDir || process.cwd()); // INTEL-ROOTWALK-V1\n  // A bare .claude-flow OR .git is trusted at any walk-up depth EXCEPT when\n  // the candidate directory IS itself shared infrastructure ($HOME, the OS\n  // temp root incl. the literal /tmp + TMPDIR/TEMP/TMP, or the filesystem\n  // root). Identity is compared by (dev, ino) from fs.statSync, NOT by\n  // string -- a prior string-based revision (even after realpath) was\n  // fooled by case-insensitive-but-preserving filesystems (macOS APFS):\n  // realpathSync preserves input case, so a case-differing alias of $HOME\n  // never string-matched the boundary set and a stray marker there was\n  // adopted anyway. Comparing filesystem identity instead closes\n  // case-aliasing, symlink-aliasing, trailing separators, and '..'\n  // segments in one move, with no platform gating and no normalization\n  // guesswork. TMPDIR/TEMP/TMP are validated (absolute + existing) before\n  // being trusted, since they are operator-controlled and a plausible CI\n  // misconfiguration (e.g. TMPDIR pointed at a real build/project\n  // directory) would otherwise exclude that project's own marker from\n  // every subdirectory -- validation rejects empty/relative/nonexistent\n  // values, but cannot distinguish 'meant as a temp root' from\n  // 'misconfigured to point at a real project' without guessing, so that\n  // residual failure mode is accepted and covered by a test, not hidden.\n  // A project living UNDER an excluded root is unaffected -- only the root\n  // itself is excluded, not its children. If the origin itself is a\n  // boundary, the walk exhausts and falls back to the origin. There is\n  // exactly one production call site (module load, below) at a depth of a\n  // few levels per fresh hook subprocess -- correctness, not per-level\n  // cost, is what matters here.\n  const _rootwalkStatSafe = (p) => { try { return fs.statSync(p); } catch (e) { return null; } };\n  const _rootwalkValidEnvTemp = (p) => !!p && path.isAbsolute(p) && fs.existsSync(p);\n  const _rootwalkBoundaryIds = new Set();\n  const _rootwalkAddBoundary = (p) => {\n    if (!p) return;\n    const st = _rootwalkStatSafe(p);\n    if (st) _rootwalkBoundaryIds.add(st.dev + ':' + st.ino);\n  };\n  try { _rootwalkAddBoundary(require('os').homedir()); } catch (e) {}\n  try { _rootwalkAddBoundary(require('os').tmpdir()); } catch (e) {}\n  try { _rootwalkAddBoundary('/tmp'); } catch (e) {}\n  try { if (_rootwalkValidEnvTemp(process.env.TMPDIR)) _rootwalkAddBoundary(process.env.TMPDIR); } catch (e) {}\n  try { if (_rootwalkValidEnvTemp(process.env.TEMP)) _rootwalkAddBoundary(process.env.TEMP); } catch (e) {}\n  try { if (_rootwalkValidEnvTemp(process.env.TMP)) _rootwalkAddBoundary(process.env.TMP); } catch (e) {}\n  try { _rootwalkAddBoundary(path.parse(origin).root); } catch (e) {}\n  const isSharedRoot = (d) => {\n    const st = _rootwalkStatSafe(d);\n    return st ? _rootwalkBoundaryIds.has(st.dev + ':' + st.ino) : false;\n  };\n  let dir = origin;\n  while (true) {\n    if (!isSharedRoot(dir)) {\n      if (fs.existsSync(path.join(dir, '.git'))) return dir;\n      if (fs.existsSync(path.join(dir, '.claude-flow'))) return dir;\n    }";

const replacement = [
  "  const origin = path.resolve(startDir || process.cwd()); // INTEL-ROOTWALK-V1",
  "  // A bare .claude-flow OR .git is trusted at any walk-up depth EXCEPT when",
  "  // the candidate directory IS itself shared infrastructure ($HOME, the OS",
  "  // temp root incl. the literal /tmp + TMPDIR/TEMP/TMP, or the filesystem",
  "  // root). Identity is compared by (dev, ino) from fs.statSync, NOT by",
  "  // string -- a prior string-based revision (even after realpath) was",
  "  // fooled by case-insensitive-but-preserving filesystems (macOS APFS):",
  "  // realpathSync preserves input case, so a case-differing alias of $HOME",
  "  // never string-matched the boundary set and a stray marker there was",
  "  // adopted anyway. Comparing filesystem identity instead closes",
  "  // case-aliasing, symlink-aliasing, trailing separators, and '..'",
  "  // segments in one move, with no platform gating and no normalization",
  "  // guesswork. TMPDIR/TEMP/TMP are validated (absolute + existing) before",
  "  // being trusted, since they are operator-controlled and a plausible CI",
  "  // misconfiguration (e.g. TMPDIR pointed at a real build/project",
  "  // directory) would otherwise exclude that project's own marker from",
  "  // every subdirectory -- validation rejects empty/relative/nonexistent",
  "  // values, but cannot distinguish 'meant as a temp root' from",
  "  // 'misconfigured to point at a real project' without guessing, so that",
  "  // residual failure mode is accepted and covered by a test, not hidden.",
  "  // A project living UNDER an excluded root is unaffected -- only the root",
  "  // itself is excluded, not its children. If the origin itself is a",
  "  // boundary, the walk exhausts and falls back to the origin. There is",
  "  // exactly one production call site (module load, below) at a depth of a",
  "  // few levels per fresh hook subprocess -- correctness, not per-level",
  "  // cost, is what matters here.",
  "  const _rootwalkStatSafe = (p) => { try { return fs.statSync(p); } catch (e) { return null; } };",
  "  const _rootwalkValidEnvTemp = (p) => !!p && path.isAbsolute(p) && fs.existsSync(p);",
  "  const _rootwalkBoundaryIds = new Set();",
  "  // INTEL-ROOTWALK-V1 v5: a boundary's stat can fail transiently (EMFILE",
  "  // under fd pressure, an EACCES race, ENOENT/ESTALE during a remount) --",
  "  // treating ANY failure as \"this boundary does not exist\" silently drops",
  "  // it from the set for the rest of this call, even if the walk later",
  "  // reaches that exact directory once the transient condition has",
  "  // cleared, adopting a bare .claude-flow sitting there as if it were a",
  "  // legitimate project. ENOENT/ENOTDIR genuinely mean absent (skip is",
  "  // correct); any other errno means UNKNOWN, and unknown must not",
  "  // silently degrade to absent -- so it sets _rootwalkDegraded instead,",
  "  // and while degraded this call stops trusting bare .claude-flow",
  "  // entirely (falls through to .git only, which stays gated by the same",
  "  // isSharedRoot check as before -- unchanged from the disclosed,",
  "  // accepted yadm-dotfiles tradeoff). Rare and self-correcting (the next",
  "  // hook invocation gets a fresh call and fresh boundary set), so this",
  "  // trades occasional non-detection for never adopting an unverified",
  "  // boundary -- the same fail-closed direction as everywhere else here.",
  "  let _rootwalkDegraded = false;",
  "  const _rootwalkAddBoundary = (p) => {",
  "    if (!p) return;",
  "    try {",
  "      const st = fs.statSync(p);",
  "      _rootwalkBoundaryIds.add(st.dev + ':' + st.ino);",
  "    } catch (e) {",
  "      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return;",
  "      _rootwalkDegraded = true;",
  "    }",
  "  };",
  "  try { _rootwalkAddBoundary(require('os').homedir()); } catch (e) { _rootwalkDegraded = true; }",
  "  try { _rootwalkAddBoundary(require('os').tmpdir()); } catch (e) { _rootwalkDegraded = true; }",
  "  try { _rootwalkAddBoundary('/tmp'); } catch (e) { _rootwalkDegraded = true; }",
  "  try { if (_rootwalkValidEnvTemp(process.env.TMPDIR)) _rootwalkAddBoundary(process.env.TMPDIR); } catch (e) { _rootwalkDegraded = true; }",
  "  try { if (_rootwalkValidEnvTemp(process.env.TEMP)) _rootwalkAddBoundary(process.env.TEMP); } catch (e) { _rootwalkDegraded = true; }",
  "  try { if (_rootwalkValidEnvTemp(process.env.TMP)) _rootwalkAddBoundary(process.env.TMP); } catch (e) { _rootwalkDegraded = true; }",
  "  try { _rootwalkAddBoundary(path.parse(origin).root); } catch (e) { _rootwalkDegraded = true; }",
  "  const isSharedRoot = (d) => {",
  "    const st = _rootwalkStatSafe(d);",
  "    return st ? _rootwalkBoundaryIds.has(st.dev + ':' + st.ino) : false;",
  "  };",
  "  let dir = origin;",
  "  while (true) {",
  "    if (!isSharedRoot(dir)) {",
  "      if (fs.existsSync(path.join(dir, '.git'))) return dir;",
  "      if (!_rootwalkDegraded && fs.existsSync(path.join(dir, '.claude-flow'))) return dir;",
  "    }"
].join('\n');

let matched = false;
if (s.includes(anchorV4)) { s = s.split(anchorV4).join(replacement); matched = true; }
else if (s.includes(anchorV3WithTmp)) { s = s.split(anchorV3WithTmp).join(replacement); matched = true; }
else if (s.includes(anchorV3NoTmp)) { s = s.split(anchorV3NoTmp).join(replacement); matched = true; }
else if (s.includes(anchorV2)) { s = s.split(anchorV2).join(replacement); matched = true; }
else if (s.includes(anchorV1)) { s = s.split(anchorV1).join(replacement); matched = true; }
else if (s.includes(anchorPristine)) { s = s.split(anchorPristine).join(replacement); matched = true; }

if (!matched) { console.error('ANCHOR_NOT_FOUND'); process.exit(2); }
// Fail closed: verify the replacement actually landed before writing anything.
if (!s.includes('_rootwalkDegraded')) { console.error('ANCHOR_NOT_FOUND'); process.exit(2); }

if (crlf) s = s.replace(/\n/g, '\r\n');
fs.writeFileSync(F, s);
PJS
    node "$patcher" "$INTEL"; rc=$?; rm -f "$patcher"
    if [[ $rc -ne 0 ]]; then
      warn "INTEL-ROOTWALK-V1 anchor not found in intelligence.cjs — the file HAS resolveProjectRoot but none of the six recognized pre-patch forms matched, so the boundary-exclusion fix was NOT applied and this target is unprotected. Upstream changed the function: re-anchor the patcher (dist drift, not a stale seed)"
    elif node --check "$INTEL" 2>/dev/null && grep -q "_rootwalkDegraded" "$INTEL"; then
      fix "resolveProjectRoot .claude-flow/.git walk-up now uses (dev,ino) filesystem identity for boundary exclusion with degraded-boundary handling (unknown stat failures no longer silently treated as absent) (INTEL-ROOTWALK-V1)"
      pass "root-walk identity-based boundary exclusion with degraded-boundary handling applied"
    else
      warn "INTEL-ROOTWALK-V1 patch produced invalid JS or verification failed — restoring backup"
      cp "$INTEL.rootwalk-bak" "$INTEL"
    fi
  fi
elif ! grep -q "resolveProjectRoot" "$INTEL" 2>/dev/null; then
  # SUBJECT-ABSENT, and emphatically NOT "self-retired" (INTEL-ROOTWALK-ABSENT-V1).
  #
  # This branch used to fall through to the pass below, reporting green for a
  # file that does not contain the function the whole step is about — the kit's
  # dominant defect class: a check that cannot tell "upstream fixed it" from
  # "the subject was never here". It hid a stale vendored seed for a month:
  # fix-aqe printed a clean bill twice in CI while three test files failed
  # immediately afterwards on `intel.resolveProjectRoot is not a function`.
  warn "intelligence.cjs defines NO resolveProjectRoot — nothing was assessed (NOT 'self-retired'). This helper is ruflo-generated and is expected to define it; the usual cause is a stale vendored seed. Re-run after \`npm i -g ruflo\` so HELPER-SEED-UPSTREAM-V1 can seed from the installed package (INTEL-ROOTWALK-ABSENT-V1)"
else
  pass "bare .claude-flow walk-up defect not found — nothing to heal (self-retired)"
fi

echo -e "\n============================================"
echo " fix-aqe complete — ${FIXES} change(s)"
for l in "${FIX_LOG[@]:-}"; do [[ -n "$l" ]] && echo "   • $l"; done
echo "============================================"
