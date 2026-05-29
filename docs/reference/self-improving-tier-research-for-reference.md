# Route Q-learner never persists CLI feedback (autoSaveInterval); trained LoRA/SONA not consumed at inference — routing appears non-self-improvin

## Summary

While verifying whether ruflo is **self-improving** (not just self-learning) on a global install (ruflo **3.10.5**, darwin-arm64), we traced the routing/learning path through source and ran a controlled experiment. ruflo is clearly **self-learning** (trajectories/patterns/embeddings accumulate and persist), but **self-improvement of routing is blocked by two concrete issues** (one a clear bug with a one-line fix), plus a contributing limitation. Filing everything we learned for your consideration.

All findings are reproducible with two small helper scripts in https://github.com/pacphi/ruflo-machine-ref (`ruflo-improvement-eval`, `ruflo-patch-route-learning`).

## Three learning subsystems (for shared vocabulary)
- **Route Q-learner** (`@claude-flow/cli/.../ruvector/q-learning-router.js`) — picks the agent for a task; exposes ε / TD-error / Q-table.
- **SONA / ReasoningBank** (`memory/intelligence.js`, `@ruvector/ruvllm` `SonaCoordinator`) — records trajectories, distills patterns; updates a *scalar* per-pattern "confidence" (the code calls this "LoRA-style" but it is not the matrix adapter).
- **MicroLoRA matrix adapter** (`services/ruvector-training.js` `JsMicroLoRA`, A/B/scaling) — trained by `neural train`; tracks `deltaNorm`.

---

## Finding 1 (BUG) — `route feedback` never persists; CLI route-learning is a no-op

`commands/route.js` `feedbackCommand` calls `router.update(...)` but **never** `router.saveModel()`. `ruvector/q-learning-router.js` defaults `DEFAULT_CONFIG.autoSaveInterval = 100`, and `update()` only auto-saves on `updateCount % autoSaveInterval === 0`. Because each CLI invocation is a fresh process that loads the model, applies a **single** update, and exits, the `% 100` save never fires — so `.swarm/q-learning-model.json` never advances and `route stats` is **permanently** `Update Count 0 / Epsilon 1.0000`, no matter how much feedback is given.

**Evidence (stock):** 6 separate `ruflo route feedback -t … -a … -r …` calls → `route stats` still `Update Count 0, ε 1.0`.
**After setting `autoSaveInterval: 1`:** the same 6 calls → `Update Count 6, ε 1.0→0.997`, model persisted. CLI route-learning now accumulates.

**Suggested fix (either):**
- `await router.saveModel()` at the end of `feedbackCommand` (targeted), and/or
- `DEFAULT_CONFIG.autoSaveInterval = 1` (every update durable).

---

## Finding 2 (GAP) — trained LoRA/SONA is never consumed at inference

The learning that's most advertised (rising `deltaNorm` / LoRA) **changes no routing decision**:
- Every `SonaCoordinator` call in the CLI is training/recording — `recordSignal`, `recordTrajectory`, `addTrajectoryStep`, `endTrajectory`, `distillLearning`. There is **no inference call** in any decision path.
- `SonaCoordinator`'s public API has **no `predict`/`forward`/`infer`** — only recording/stats/`createEmbedding`. From a consumer's view it is write-only.
- `JsMicroLoRA.forward_array` (the B·A path) has **zero callers** outside its own training file.
- The routing/recall scorer uses **scalar pattern-confidence** (`intelligence.js` `pattern.confidence += loraLearningRate * reward`), not the trained adapter.

So the model trains but never reads what it learned at decision time — the loop is open.

**Suggested direction:** expose an inference path from the trained adapter (a `predict`/`forward`) and consume it in the routing/recall scorer so learning closes the loop. (This is the change that would let routing measurably improve from accumulated learning.)

---

## Finding 3 (LIMITATION) — state encoder collapses semantically-distinct tasks

`q-learning-router.js` `featureVectorToKey` quantizes the feature vector in 4-feature groups and hashes; in practice the key is dominated by the length/word-count buckets (features 32–47), while the keyword bits (0–31, and debug/document keywords at index ≥32 aren't encoded at all). Result: tasks that differ only by routing keywords hash to the **same** Q-state.

**Evidence:** six routing-keyword-distinct tasks ("unit test spec coverage", "implement code build create", …) all produced **one** state key (`fstate_4gfz7k`). Distinct *word counts* were required to obtain distinct states.

Effect: even with Finding 1 fixed, task-specific routing is limited because distinct tasks share a policy slot.

---

## Finding 4 (POSITIVE) — with Finding 1 fixed, the route learner *does* self-improve (modestly)

A held-out, ablated, multi-seed experiment against the **real** `createQLearningRouter` (synthetic-reward env engineered to occupy distinct Q-states per Finding 3; greedy eval; learning vs a no-learning ablation):

```
route Q-learner · 5 seeds · learning vs no-learning ablation
  cold 17% → warm 33%   Δ+16pp   permutation p=0.004   Cohen's d=∞   above-chance: yes
  ε 1.0→0.40   δ̄→0.03   |Q|=6   (monotone learning curve)
```

So the loop *can* self-improve and the gain is statistically real, but **modest** — it learns the optimal action for only part of the state space within practical episode counts (consistent with Findings 2–3 and a slow ε schedule).

---

## Environment & repro
- ruflo 3.10.5, Node 26.2.0, darwin-arm64.
- Repro/verification scripts (MIT): https://github.com/pacphi/ruflo-machine-ref
  - `ruflo-patch-route-learning` — applies/verifies the Finding-1 fix.
  - `ruflo-improvement-eval` — the held-out/ablated proof; `--probe-states`, `--inspect-decision`, `--cli-check` for diagnostics.

## Net
- **Finding 1** is a clear bug with a one-line fix that immediately makes CLI route-learning functional.
- **Finding 2** is the architectural change needed for the learned adapters to actually influence decisions (the crux of "self-improving").
- **Finding 3** would further help task-specific routing.

Happy to open PRs for Finding 1 (and a state-encoder tweak for Finding 3) if useful.