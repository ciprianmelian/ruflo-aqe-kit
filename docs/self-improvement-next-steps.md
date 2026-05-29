# Self-Improvement — findings & next-step plan (handoff)

> **SUPERSEDED — see [`whats-genuinely-left-rnd.md`](./whats-genuinely-left-rnd.md) for the current state.**
> This is a dated snapshot at commit `9d5bffe`: it *proposed* the work, which has since been *done* (objective oracle `DERIVE-OUTCOME-V1`; Router B loop closed via `RUFLO-SEMRANK-V1` + `RUFLO-ROUTE-CAPTURE-V1`). Labels like `RUFLO-TRAIN-REWARD-V1` and the prose-sentiment `deriveReward` described below are historical and are no longer in the code — do not treat this file as current implementation state.

**Status as of commit `9d5bffe` (2026-05-29).** Question being settled with data, not assertion:
*is the kit self-LEARNING and self-IMPROVING?*

- **Self-LEARNING: PROVEN.** LoRA `B.sumAbs` 1.27→2.06 (updates 239→444), `agentdb.db` episodes 236→315, AQE `captured_experiences` 463, `dream_insights` 750 — all grow + persist.
- **Self-IMPROVING: mechanism PROVEN, production signal NOT yet.** The AQE router's RL loop genuinely moves toward reward when fed varied outcomes (proof below), but the production reward signal is a soft proxy that will be near-constant on real turns. So *measurable* self-improvement on real work is **not yet proven**. Two concrete next steps below close that.

Measurement instrument: `tools/selfimprove-bench.cjs` (re-runnable, READ-ONLY, appends `.claude-flow/selfimprove-history.jsonl`). Current baseline: 25% held-out routing accuracy on Router B (flat); reward variance now `[-1.0, 0.1]` after the wrapper (was constant `[0.1]`).

---

## Architecture map (from the vendor/ruflo source audit)

Three learning paths, three different states:

| Path | What it is | Reward in | Consumed at inference? | Movable from our hooks? |
|------|-----------|-----------|------------------------|--------------------------|
| **AQE router** (`aqe-hook-router`, `rl_q_values` in `.agentic-qe/memory.db`) | Q-learning; drives the UserPromptSubmit `recommendedAgent`+confidence | `aqe hooks post-route --success <bool>` (needs an open route sentinel from the per-turn `aqe hooks route`) | **YES** — `confidence = static·(1-w)+sigmoid(q)·w` | **YES (proven)** — but consumes only the BOOLEAN; graded magnitude discarded (quality binary 0.675/0.425; Q-reward `success?0.1:-1`) at `agentic-qe/dist/cli/chunks/hooks-FUHNE2P7.js:139,61` |
| **Router B** (`ruflo hooks route`) — *the one selfimprove-bench scores* | keyword `TASK_PATTERNS` + semantic cosine; learns from `.claude-flow/routing-outcomes.json` | MCP `hooks_post-task` (writes outcomes); the **CLI** `ruflo hooks post-task` does NOT write that file (verified) | partially: reads `success` boolean + keyword overlap; **discards `quality`** (`loadLearnedPatterns` filters `if(!o.success)continue`, never reads quality) | **NO via CLI** — store not CLI-writable. Needs MCP path or dist patch |
| **LoRA** (`.swarm/lora-weights.json`) | autoencoder `train(emb,emb,r)` | our `ruflo-train*.cjs` (now varied, `RUFLO-TRAIN-REWARD-V1`) | **NO** — `adapt()` exists in source but no router calls it. Write-only dead-end | n/a — out of scope until upstream wires `adapt()` |
| Router A (`ruflo route` standalone) | real complete Q-learning Bellman (`route feedback -r <reward>`) | real arg | yes (its own table) | yes, but NOT on the live `hooks route` path |

**Proof the AQE loop is real** (tester, 2× reproducible, DB snapshot+restored): target pair `state_key=test-execution|normal|test-generation / action=qe-test-architect`. TRAIN (sentinel+`--success true`) q 0.198→**0.260**; NEGATIVE (`--success false`) q 0.198→**−0.460**; CONTROL (constant, no sentinel) **Δ0**. Routed confidence 34.8%→35.2%. Signed, reward-correct, reproducible, flat control.

**Why production efficacy is unproven:** `aqe-post-route.cjs`'s `deriveReward` keyword-counts the agent's own final text (starts 0.7, needs ≥2 failure words to dip <0.5). Real assistant text almost always contains "done/fixed/complete" → `success` ≈ always-true → near-constant → re-creates the very fixed point the wrapper was meant to break.

---

## Next step 1 — Objective-oracle `deriveReward` (HIGHEST leverage, low-risk, in our helpers)

Replace the prose-sentiment heuristic with an **objective outcome signal** parsed from the turn transcript. This gives real, frequent variance the proven AQE loop can act on.

**Files:** `assets/claude-helpers/aqe-post-route.cjs` and `assets/claude-helpers/ruflo-train-subagent.cjs` (share one derivation; consider factoring into a tiny `assets/claude-helpers/_derive-outcome.cjs` required by both). Reinstalled by `fix-aqe.sh` (already in its install loop).

**Signal sources in the Claude Code transcript JSONL** (`transcript_path` in the Stop payload):
- `tool_use` → matching `tool_result` blocks with **`is_error: true`** → failed tool call. Count them.
- **Bash** tool_results: parse non-zero exit / `command not found` / `Error` in the result text.
- **Test/build** tool_results: `FAIL`, `failing`, `✗`, `Tests: N failed`, non-zero jest/vitest/npm exit.
- Edits that were immediately reverted / repeated (retry signal).

**Proposed scoring:** start neutral 0.7; `reward -= 0.25 * errorToolResults`; `-= 0.15 * failedBashExits`; `-= 0.2 * testFailures`; `+= 0.1` if a later test/build tool_result shows pass after a failure (recovery); clamp [0.05, 0.95]; `success = reward >= 0.5`. Keep the explicit `argv[2]` override for tests/replay.

**Validate (reviewer must-fix #3):** instrument `success` across ~20 REAL turns — if it's >90% true, the objective oracle isn't dipping; tune thresholds. Then run `selfimprove-bench.cjs` longitudinally and watch reward distinct-values + the AQE router confidence trend.

---

## Next step 2 — Router B (`ruflo hooks route`) real fix

`ruflo hooks route` is what `selfimprove-bench.cjs` scores, but its learning store `.claude-flow/routing-outcomes.json` is **not written by the CLI `post-task`** (verified: CLI post-task wrote nothing; route output unchanged). Two routes to close it:

**Option A (preferred, no dist patch):** drive the **MCP `hooks_post-task`** tool (which DOES write `routing-outcomes.json` per `vendor/ruflo/v3/@claude-flow/cli/src/mcp-tools/hooks-tools.ts:1273`) with real `{task, agent, success}`. From Claude Code that means calling `mcp__claude-flow__hooks_post-task` after each routed task (a coordination step), or a helper that writes `routing-outcomes.json` directly in the documented shape (`{task, agent, success, quality, keywords}`). Then `ruflo hooks route` reads it via `loadLearnedPatterns` (hooks-tools.ts:221) / `suggestAgentsForTask` (:633-651).

**Option B (graded, needs a dist patch — codify in fix-ruflo.sh):** even once outcomes are written, Router B **ignores `quality`** — `loadLearnedPatterns` (hooks-tools.ts:225) does `if(!o.success)continue` and never reads `quality`; `suggestAgentsForTask` (:640-651) confidence is `0.6 + 0.05*overlap` (keyword-overlap only). To honor a graded reward, patch those two sites to weight by `quality`. This is a published-dist patch → sentinel-gate + `.bak` + re-apply in `fix-ruflo.sh` (mirror the `wire_real_spawn` pattern). Source refs: `vendor/ruflo/.../hooks-tools.ts:221,633-651`; route delegation `commands/hooks.ts:785`.

**Note on the benchmark:** today `selfimprove-bench.cjs` scores Router B. Either (a) fix Router B (above) so the harness's accuracy can move, or (b) add an **AQE-router arm** to the harness (measure the `aqe hooks route` confidence / the moved `rl_q_values` q for held-out task types) so it scores the router we *can* move. Recommended: do both — fix B, and add the AQE arm so the harness covers both routers.

---

## Next step 3 (optional) — AQE graded reward

If we want the AQE router to use the graded reward (not just the boolean), patch `agentic-qe/dist/cli/chunks/hooks-FUHNE2P7.js:139` (`quality = 0.325 + (success?0.25:0) + 0.1`) and the Q-update at `:61` (`d = success?0.1:-1`) to consume a passed `--quality`/reward. Bundled-dist patch → codify in `fix-aqe.sh` with a sentinel + `.bak` (like `AQE-PROMOTE-V1`). Lower priority than steps 1–2.

---

## How to verify (each step)
1. `bin/ruflo-kit bench <target>` — baseline + appends history. Re-run across sessions; PROVEN requires held-out **accuracy** (not confidence) trend up ≥3 runs with non-constant reward AND a flat no-train control.
2. The AQE-router controlled proof (tester method, reproducible): snapshot `.agentic-qe/memory.db`; pick a `(state_key, action_key)`; TRAIN = sentinel+`--success true` ×N; NEGATIVE = `--success false` ×N; CONTROL = constant/no-sentinel; assert TRAIN↑, NEGATIVE↓, CONTROL flat; restore DB.
3. Integrity gate (do NOT relax): consumption mutation test (mutating the store changes the routed output), accuracy-not-confidence, real control arm, ≥2σ reproducible trend. If unmet, the honest verdict is *"self-learns; self-improvement unproven."*

## Key files
- Harness: `tools/selfimprove-bench.cjs` · history `.claude-flow/selfimprove-history.jsonl`
- Wrappers (tracked source → installed by `fix-aqe.sh`): `assets/claude-helpers/aqe-post-route.cjs` (Stop), `ruflo-train-subagent.cjs` (SubagentStop, `RUFLO-TRAIN-REWARD-V1`), `ruflo-train.cjs` (PostToolUse)
- Vendor source of truth: `vendor/ruflo/v3/@claude-flow/cli/src/{mcp-tools/hooks-tools.ts, ruvector/q-learning-router.ts, ruvector/lora-adapter.ts, commands/route.ts, commands/hooks.ts}`
- AQE reward formula (dist): `agentic-qe/dist/cli/chunks/hooks-FUHNE2P7.js:61,139`
- Commits this thread: `2bdf361` (harness + reward variance), `9d5bffe` (post-route wrapper + codify)
</content>
