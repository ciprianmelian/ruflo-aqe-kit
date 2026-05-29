# What's genuinely left (R&D, not wiring)

**Handoff doc — self-improvement loop, post-Tier-10.** Companion to `self-improvement-next-steps.md` (the prior plan, commit `9d5bffe`) — that doc proposed the work; this doc records what got DONE and isolates what genuinely remains as **research**, not plumbing.

**Location note:** lives in the kit's `docs/` directory alongside the other narrative docs (`self-improvement-next-steps.md` is a sibling here; `self-improving-tier-research-for-reference.md` is under `docs/reference/`).

---

## TL;DR — the honest verdict

- **The loop is CLOSED end-to-end, in production, on BOTH routers.** Reward is now an objective transcript-outcome signal (not prose sentiment, not a constant); the Router B store is written per-turn and consumed by a graded dist re-rank; the AQE router is fed the derived boolean. The wiring is done and codified in `fix-aqe.sh` / `fix-ruflo.sh`.
- **The MECHANISM is PROVEN.** Controlled tests show the RL paths move toward reward when fed varied outcomes (AQE: signed/reproducible q-moves with a flat no-train control; LoRA: `B.sumAbs` off zero under real training; Router B re-rank: exact no-op on empty store, re-ranks on populated store).
- **PRODUCTION EFFICACY is NEUTRAL — not yet proven.** Held-out routing accuracy is **flat at 25% raw / 33.3% normalized**. Worse, the live signal is on-policy: reinforcing the agent ruflo already picked can **entrench misroutes** rather than correct them.

So: **self-LEARNING is real** (artifacts grow + persist). **Self-IMPROVEMENT on real work is NOT yet demonstrated.** Everything below is what stands between "closed loop" and "demonstrably improves."

These are genuine R&D questions (algorithm + measurement design), not missing wires. Do NOT report them as TODO plumbing.

---

## What got resolved this session (so the next session doesn't re-litigate it)

| Was a gap | Now | Where |
|---|---|---|
| Reward = gameable prose-sentiment / constant `0.8` | Objective outcome oracle (`is_error`, Bash exits, test FAIL/pass, recovery) | `_derive-outcome.cjs` (`DERIVE-OUTCOME-V1`) |
| Constant subagent-trainer reward | Varied reward via `deriveOutcome(...)` | `ruflo-train-subagent.cjs:86-88` |
| Hardcoded `post-route --success true` Stop hook | Outcome-derived boolean + graded store writer | `aqe-post-route.cjs`; wired `fix-aqe.sh:147-149` |
| "Router B store not CLI-writable" | THIS wrapper writes `routing-outcomes.json` (WS2b); dist re-rank reads it | `aqe-post-route.cjs:130`; `RUFLO-SEMRANK-V1` |
| Router B had no graded ranking | `score·0.75 + meanQuality·0.25` re-rank, empty-store no-op | `fix-ruflo.sh wire_semantic_rerank` (`RUFLO-SEMRANK-V1`) |
| No trusted routed-agent at Stop (poison risk) | On-policy capture of ruflo's own pick | `ruflo-route-capture.cjs` (`RUFLO-ROUTE-CAPTURE-V1`) |
| **Envelope-pollution guard** — meta-envelopes poisoning the store | **DONE** — `isRoutableTask` rejects `<task-notification>` / slash-echoes / hook+tool-result echoes at BOTH the capture and the Stop write; runtime store files gitignored | `ruflo-route-capture.cjs:39-44`, `aqe-post-route.cjs:86-91`; `.gitignore:16-17` |

---

## The remaining gates (R&D, in priority order)

### Gate 1 — Exploration in Router B (THE binding constraint)

The capture→outcome→re-rank loop is strictly **on-policy**: it records and reinforces the agent ruflo ALREADY picked (`ruflo-route-capture.cjs:17-22` says this explicitly). With no exploration, the loop can *sharpen* a correct policy and *penalize* a bad pick on a task it already gets right — but it **cannot DISCOVER** a better route for a task it currently mis-routes, and reinforcing a confident misroute actively entrenches it. This is the single thing most likely to make "more training" produce *worse* held-out accuracy.

**What's genuinely needed (pick one, this is a design decision):**
- **ε-greedy / UCB over the candidate set** in the route decision, so alternative agents get sampled and can earn reward. Requires touching the route-selection path, not just the re-rank.
- **Off-policy counterfactual outcomes** — log the reward a *different* candidate agent would have earned (e.g. via a held-out judged replay) and train on that, so the policy can move toward an unsampled-but-better action without live exploration risk.

Either is real RL design work. Until one lands, treat any held-out accuracy *gain* with suspicion (it could be overfit to the on-policy distribution) and any *drop* as expected entrenchment.

### Gate 2 — Denser / sharper reward signal

Measured: **~90% of real turns succeed**, so the derived `success` boolean is positive on the vast majority of turns (`_derive-outcome.cjs:34-43`, `aqe-post-route.cjs:16-20`). The oracle is honest and objective, but a near-constant-positive signal is a **sparse, weakly-discriminative** learning signal — the RL estimators get little gradient to move on.

**What's genuinely needed (R&D, not a threshold tweak):**
- A reward that **discriminates among successes** — e.g. graded by task difficulty, edits-to-completion, retries, tool-call efficiency, or a judged quality score — not just pass/fail. (Note: the AQE router currently discards the graded value anyway and consumes only the boolean; honoring the graded reward in AQE is a bundled-dist patch — see file map — but is downstream of designing a reward worth grading.)
- **Negative-mining**: deliberately surface the minority of genuinely-failed turns so they aren't drowned out.
- Validate the design by instrumenting `success`/`reward` distribution across ~20+ real turns and confirming it actually spreads (not >90% pinned at one value).

### Gate 3 — Longitudinal proof (the measurement gate)

The verdict is currently NEUTRAL because we lack the evidence to claim IMPROVING. The bench (`selfimprove-bench.cjs`) is built for exactly this and now has the integrity instrumentation, but the runs haven't been done.

**What's genuinely needed:**
- **≥3 runs under the SAME scorer** (`scorerVersion='norm-v1'`, enforced at `selfimprove-bench.cjs:196,202-209`) showing accuracy trend up — a scorer change is a redefinition, NOT learning (a prior audit caught a phantom +8.3pp that was purely normalization).
- **A flat no-train control arm** run in parallel (train disabled) — improvement only counts if the trained arm rises AND the control stays flat. Reproducible to ≥2σ.
- Report **`accuracyRawPct` alongside the normalized headline** so a label-map change can't masquerade as learning.
- Use the AQE-router diagnostic arm (`measureAqeRouter()`, `:119-150`) to watch the router the oracle actually feeds — and note that because Patch 30 now feeds `rl_q_values` a non-constant reward, the harness's prior `reward CONSTANT ⇒ NOT-IMPROVING` blocker (`:215`) can finally clear.

Integrity gate (do NOT relax): if these aren't met, the honest verdict stays *"self-learns; self-improvement unproven."*

### Gate 4 — Envelope-pollution guard — **RESOLVED this session**

Listed for completeness so it isn't re-opened. Meta-envelopes (`<task-notification>`, slash-command echoes, hook/tool-result echoes) arriving as a "prompt"/first-user-message would have poisoned `routing-outcomes.json` with non-task noise. `isRoutableTask` now rejects them at BOTH ends — capture (`ruflo-route-capture.cjs:39-44`) and Stop-time write (`aqe-post-route.cjs:86-91`, which also rejects an already-polluted sentinel) — and the runtime store files are gitignored (`.gitignore:16-17`). **No further action.**

---

## File / sentinel map (so the next session can pick this up cold)

**Helpers (tracked source → installed to `.claude/helpers/` by `fix-aqe.sh:89`):**
- `assets/claude-helpers/_derive-outcome.cjs` — `DERIVE-OUTCOME-V1`. The reward oracle. `deriveOutcome(eventsOrText)` is pure/testable; `--selftest` runs 6 crafted cases. Scoring spec at `:47-53`; turn-scoping `lastTurnEvents` at `:90-114`. **Touch here for Gate 2.**
- `assets/claude-helpers/aqe-post-route.cjs` — Stop hook. Feeds AQE boolean + ruflo `post-task -q` + WS2b store writer (`recordRoutingOutcome:130`). Honest-scope header `:11-22`. Poison guard `isRoutableTask:86-91`.
- `assets/claude-helpers/ruflo-route-capture.cjs` — `RUFLO-ROUTE-CAPTURE-V1`, UserPromptSubmit. Writes `.claude-flow/.ruflo-route.json`. On-policy caveat `:17-22`; envelope guard `:39-44`. **Touch here for Gate 1 (add exploration to the captured pick).**
- `assets/claude-helpers/ruflo-train-subagent.cjs` — SubagentStop LoRA trainer; varied reward via `deriveOutcome` at `:86-88`.
- `assets/claude-helpers/ruflo-train.cjs` — PostToolUse Edit/Write LoRA trainer; STILL uses literal `0.8` default at `:26` (not migrated — candidate for Gate 2 if this path matters).
- `assets/claude-helpers/aqe-rag-inject.cjs` — `AQE-RAG-INJECT-V1`, PreToolUse RAG (not a reward path; listed for completeness).

**Dist patches (re-applied by the fix scripts; lost on reinstall):**
- `fix-ruflo.sh` `wire_semantic_rerank` — `RUFLO-SEMRANK-V1` (`:565-626`, called `:708,:732`). Graded re-rank `score·0.75 + meanQuality·0.25` into `…/@claude-flow/cli/dist/src/mcp-tools/hooks-tools.js`. Reversible `.semrank-bak`. **Touch here for Gate 1 (exploration in the route decision) and Gate 2 (weight by graded quality — already partially here).**
- AQE bundled chunk `agentic-qe/dist/cli/chunks/hooks-*.js` — the AQE router discards the graded reward and consumes only the boolean (quality binary 0.675/0.425, Q-update `success?0.1:-1`). Honoring the graded reward is a bundled-dist patch (codify in `fix-aqe.sh` with a sentinel + `.bak`, like `AQE-PROMOTE-V1`). **Gate 2, lower priority.**

**Wiring (idempotent, in `fix-aqe.sh`):** helper install loop `:89`; PreToolUse RAG `:124`; PostToolUse train `:126`; SessionEnd harvest `:132`; SubagentStop trainsub `:139`; Stop legacy-strip+rewire `:147-149`; UserPromptSubmit route-capture `:157`; `enabledMcpjsonServers += claude-flow` `:159`.

**Runtime store (gitignored, regenerates):** `.claude-flow/routing-outcomes.json` (graded outcomes, WS2b), `.claude-flow/.ruflo-route.json` (on-policy capture sentinel). `.gitignore:16-17`.

**Measurement:** `tools/selfimprove-bench.cjs` (READ-ONLY; appends `.claude-flow/selfimprove-history.jsonl`). `scorerVersion='norm-v1'` `:196`; same-scorer trend `:202-209`; `accuracyRawPct` `:112`; `methodCounts` `:89,:97`; AQE-router arm `measureAqeRouter()` `:119-150`; verdict gate `:215`.

**Vendor source of truth (for the dist patches above):** `vendor/ruflo/v3/@claude-flow/cli/src/{mcp-tools/hooks-tools.ts, ruvector/q-learning-router.ts, ruvector/lora-adapter.ts, commands/route.ts, commands/hooks.ts}`; AQE reward formula in `agentic-qe/dist/cli/chunks/hooks-*.js`.

**Full patch narrative:** `docs/_INSTRUCTIONS.md` Tier 10 (Patches 29-34).
