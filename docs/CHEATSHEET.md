# Cheatsheet

Quick reference for the ruflo + AQE + AgentDB stack. Procedures → [OPERATIONS.md](./OPERATIONS.md); deep rationale → [./_INSTRUCTIONS.md](./_INSTRUCTIONS.md).

All commands run through the `bin/ruflo-kit` dispatcher with a positional `<target>` codebase path (defaults to `$(pwd)`; use `.` for the current repo).

---

## 1. What do I run for X?

| I want to... | Run |
|---|---|
| Install the kit on a new machine (clone + PATH symlink) | `curl -fsSL https://raw.githubusercontent.com/ciprianmelian/ruflo-aqe-kit/main/install.sh \| bash` |
| Update the kit clone | `ruflo-kit self-update` (or re-run the installer) |
| Show kit + ruflo + aqe versions | `ruflo-kit version` |
| Start a session (prime memory + patches; daemon stays **off** — opt-in) | `bin/ruflo-kit session <target>` |
| Check health / is the loop still growing? | `bin/ruflo-kit health <target>` |
| Upgrade ruflo (⚠ resets ALL ruflo dist patches + agentdb pin — Patch 44) | `npm i -g ruflo && bin/ruflo-kit upgrade <target>` |
| Upgrade AQE (manual — no automation) | `npm i -g agentic-qe@latest && aqe init --auto --upgrade && bin/ruflo-kit fix-aqe <target> && aqe learning extract && bin/ruflo-kit fix-statusbar <target>` |
| Assess quality (AQE) | `aqe quality assess` |
| Generate tests for a file (AQE) | `aqe test generate <file>` |
| Coverage analysis (AQE) | `aqe coverage <path>` |
| Re-mint AQE promoted patterns | `aqe learning extract` |
| Fix ruflo config drift (incl. Router-B re-rank + exploration patches) | `bin/ruflo-kit fix-ruflo <target>` |
| Fix AQE config drift (incl. dream-lock fix + graded reward) | `bin/ruflo-kit fix-aqe <target>` |
| Fix the status bar | `bin/ruflo-kit fix-statusbar <target>` |
| Register the ruvnet-brain MCP knowledge base (MCP-only, no daemon/hooks) | `bin/ruflo-kit fix-brain <target> --download` |
| First-time project init | `bin/ruflo-kit init <target>` |
| **Reload dist patches into the running daemon** (REQUIRED after fix-ruflo/fix-aqe, **only if the daemon is running**) | `ruflo daemon stop && ruflo daemon start` |
| Run ONE background-worker pass (no persistent loop, bounded spend) | `ruflo daemon trigger -w audit` |
| Start the persistent loop (⚠ billed 24/7 until you stop it) | `ruflo daemon start` → **always** `ruflo daemon stop` when done |
| Opt into auto-start every session | `export RUFLO_DAEMON_MODE=auto` (`off` default, `once` = single pass) |
| Audit for anything still looping / spending | `ps -ax -o pid,etime,command \| grep -E "claude --print\|ruflo (daemon\|mcp)" \| grep -v grep` |
| Run the gate-#4 improvement instrument (multi-seed, permutation p, Cohen's d, 2σ/3-run gate) | `node tools/improvement-eval.cjs` (`--selftest` to self-check) |
| Run the self-improvement bench (trained arm) | `bin/ruflo-kit bench <target>` |
| Run the bench CONTROL arm (no-train baseline) | `RUFLO_ROUTE_EPSILON=0 RUFLO_DISABLE_TRAINING=1 bin/ruflo-kit bench <target>` |
| Disable Router-B exploration (regression-safe / control) | set env `RUFLO_ROUTE_EPSILON=0` |
| Test the reward oracle | `node assets/claude-helpers/_derive-outcome.cjs --selftest` |
| Harvest AQE patterns into ruflo | `bin/ruflo-kit harvest <target>` |
| Security scan (CLI/MCP — no kit script) | `ruflo security scan` |

Flag support varies — see [OPERATIONS.md](./OPERATIONS.md) for the exact flags per command and the verify steps. (`fix-statusbar` and `session` take no flags; security scanning is a CLI/MCP capability, not a kit command.) The AQE upgrade row is a manual sequence — `upgrade` is ruflo-only and never touches AQE; see [A3b](./OPERATIONS.md#a3b-upgrade-aqe).

---

## 2. The commands

Each `bin/ruflo-kit <command>` dispatches to an implementation in `lib/` (shell) or `tools/` (node). Helper sources live in `assets/claude-helpers/`.

| Command / impl | What it does |
|---|---|
| `fix-ruflo` → `lib/fix-ruflo.sh` | Diagnose and fix the ruflo / claude-flow MCP setup. Idempotent, `--dry-run`. Step 3b re-pins the global AgentDB to alpha.10. Also wires Router B's **`RUFLO-SEMRANK-V1`** graded re-rank (Patch 32) and **`RUFLO-ROUTE-EXPLORE-V2`** ε-greedy exploration (Patch 37) into the dist `hooks-tools.js` (sentinel + `.bak`). |
| `fix-aqe` → `lib/fix-aqe.sh` | Codify AQE-side hardening — re-applies the **AQE-PROMOTE-V1** dist patch (inside the global `agentic-qe` package's `dist/cli/chunks/*.js`, located dynamically) that is **overwritten on every `agentic-qe` reinstall/upgrade**, the **`AQE-DREAM-LOCKFIX-V2`** dream-engine SQLite-lock fix across all 4 insert paths (Patch 35), install/wire `.claude` helpers (incl. the **`DERIVE-OUTCOME-V2`** graded reward oracle, Patch 36), **set `routing.confidenceThreshold = 0.6`** in `.agentic-qe/config.yaml` (Step 4, Patch 41), and **install kit-maintained `.claude/commands` docs** from tracked `assets/claude-commands/` (Step 5, Patch 41). Pair with `aqe learning extract` to re-mint the lost pattern row. Idempotent, reversible (`.bak`), `--dry-run`. |
| `fix-statusbar` → `lib/fix-statusbar.sh` | Restore ruflo + Agentic QE v3 coexistence in the status bar. Idempotent, safe to re-run after `aqe init`. No flags. |
| `status` → `lib/status.sh` | One-screen disk truth (versions incl. 3 agentdb slots, sentinels n/N, daemon via pgrep, MCP + brain KB, learning stores). `--json` always-valid; bare `ruflo-kit` = short hints. |
| `sync` → `lib/sync.sh` | One-verb heal: fix-ruflo → fix-aqe → fix-statusbar → fix-brain → verify-learning + stage summary. `--dry-run` propagates; hard fix failure = exit 1. |
| `fix-brain` → `lib/fix-brain.sh` | Register the **MCP-only** `ruvnet-brain` server (tool: `search_ruvnet`; `BRAIN-MCP-V1`, Patch 53) in `.mcp.json` — an Ed25519-verified KB (≈736 MB download → ≈1.7 GB unpacked) at `~/.cache/ruvnet-brain/kb`. `--download` fetches the KB. **No hooks, no launchd, no plugin** → zero always-on cost. Idempotent; re-run is a health probe. |
| `init` → `lib/init.sh` | One-shot project init for ruflo + Agentic QE + AgentDB. Calls `fix-ruflo` + `fix-statusbar` + `fix-aqe`. Idempotent; `--force` (implies `--reactivate`), `--reactivate`, `--dry-run`. |
| `health` → `lib/health.sh` | Growth-delta health check — snapshots ~14 metrics, diffs vs last run; exits non-zero if anything regressed (CI-friendly). `--reset`, `--dry-run`, `--json`, `-h`/`--help`. |
| `session` → `lib/session-init.sh` | Per-session init: applies patches, checks MCP + daemon, verifies storage and controllers. No flags. |
| `upgrade` → `lib/upgrade.sh` | Upgrade global ruflo, wipe + rehydrate npx cache, re-run `fix-ruflo`, then `init --reactivate`. `--dry-run`. Run AFTER closing the session. |
| `harvest` → `tools/aqe-harvest.cjs` | Batch-replay AQE's recorded experiences into the ruflo substrate (SONA LoRA + AgentDB). Wired to SessionEnd by `fix-aqe`; AQE DB opened read-only; idempotent via `.swarm/harvest-state.json`. |
| `bench` → `tools/selfimprove-bench.cjs` | READ-ONLY longitudinal instrument for "is routing measurably improving?". `--json`, `--quiet`, `--aqe-confidence`. Run a TRAINED arm and a no-train CONTROL arm (`RUFLO_ROUTE_EPSILON=0 RUFLO_DISABLE_TRAINING=1`) under the same `scorerVersion=norm-v1`, into separate histories — proof needs cross-session runs (R&D gate 3). |
| `assets/claude-helpers/_derive-outcome.cjs` | The objective reward oracle (`DERIVE-OUTCOME-V2`, Patch 36) — graded two-regime reward consumed by the route/train hooks. `--selftest` runs 11 cases. Installed to `.claude/helpers/` by `fix-aqe`. |
| `tools/improvement-eval.cjs` | Gate-#4 instrument (Patch 54) — multi-seed runs, permutation-test *p*-value, Cohen's *d*, hard **2σ / 3-run** pass gate. `--selftest` validates the instrument. The gate stays **OPEN** until ≥3 cross-session runs. |

---

## 3. Runtime facts

- **Current global versions:** ruflo **v3.32.2**, agentic-qe **3.12.2** (as of 2026-07-17). aqe 3.12.2 migrations (`qe_trajectories.metadata_json` + `qe_pattern_nulls`) applied; ~530 trajectories intact (point-in-time).
- The claude-flow MCP server launches from the **GLOBAL `ruflo` binary** (`.mcp.json` → `command: "ruflo"`, `args: ["mcp","start"]`), **NOT** `npx ruflo@latest`.
- **AgentDB pin — nested slot shadows the hoisted copy.** ruflo 3.32.2 hoists `agentdb@alpha.17` to `ruflo/node_modules/agentdb`, but Step 3b keeps **`3.0.0-alpha.10` in the NESTED `@claude-flow/memory/node_modules/agentdb` slot**, which shadows the hoisted alpha.17 *for the memory layer only* (nearest-`node_modules`-wins). Keep the nested pin: alpha.17 **permanently removed 8 controller classes** (SemanticRouter, GNNService, RVFOptimizer, GuardedVectorBackend, MutationGuard, AttestationLog, HierarchicalMemory, MemoryConsolidation), and ruflo's rewritten `ControllerRegistry` (ADR-053/055) degrades per-controller — so alpha.17 would *look* healthy while silently missing them. alpha.10 boots the advanced controllers (`GuardedBackend` proof-engine boot is the tell). When the pin drifts, 7 advanced controllers go dark: `mutationGuard`, `gnnService`, `attestationLog`, `semanticRouter`, `guardedVectorBackend`, `rvfOptimizer`, `graphAdapter`. Full A/B: `_INSTRUCTIONS.md` Patch 52. Live `agentdb_controllers` count is **restart-gated** (MCP caches old dist).
- A separate `agentdb` MCP server is registered in `.mcp.json` (also pinned alpha.10), exposing the direct attention / reflexion / skills / causal / learning-session tools. (alpha.17 moved `better-sqlite3` peerDep → optionalDependencies, so Patch 49's global install is now belt-and-suspenders.)
- The AQE MCP server launches from the **global `aqe-mcp` binary** (`.mcp.json` → `command: "aqe-mcp"`), **NOT** npx. AQE's hooks in `settings.json` call `npx agentic-qe hooks <verb>` (resolves to the global package from the warm cache).
- **AQE is unpinned / free-floating** (`npm i -g agentic-qe@latest`). The `settings.json` `aqe.version` field is a **record of the last init, not an enforced pin** — unlike the hard AgentDB `alpha.10` pin above. It can lag the installed `aqe --version`: e.g. global `aqe` may be 3.10.4 while the field still reads 3.10.1 when `aqe init --upgrade` was deferred.
- Topology: **hierarchical-mesh**, max **15 agents**, **hybrid** memory, **HNSW + neural** enabled.
- Memory backends: `.agentic-qe/memory.db` (AQE) + ruflo `.swarm/` (`memory.db`, `hnsw.index`, `lora-weights.json`) + the AgentDB store.
- **The daemon spawns billed `claude --print` LLM calls (sonnet/opus) every 10–30 min, 24/7, detached to `launchd`** — it spends with NO Claude Code session open. **Auto-start is OPT-IN** (Patch 50): `RUFLO_DAEMON_MODE=off` (default, never auto-starts) / `auto` (every session) / `once` (one pass then exit). `session-init.sh` step 4 + `init.sh` 7G are gated on it; **do not revert to unconditional auto-start**. No launchd supervisor is installed (would be `ruflo daemon install-supervisor`; remove via `uninstall-supervisor`). If you start the loop, you own stopping it. See [OPERATIONS.md A8](./OPERATIONS.md#a8-daemon--token-cost).
- **AQE side: `daemonAutoStart` pinned `false`** (`AQE-DAEMON-AUTOSTART-OFF-V1`, Patch 54) in `.agentic-qe/config.yaml` — upstream `aqe doctor --fix` honored `true` and resurrected the billed AQE daemon 3× in one session, so `fix-aqe` re-asserts `false`. This is the AQE complement to `RUFLO_DAEMON_MODE`; both must be off for a quiet background. Upstream #2661 (ruflo 3.27+) added daemon governance (opt-in workers + budget ledger + circuit breaker) — kit daemon-off retained as belt-and-suspenders.
- **The daemon caches the global `dist` in memory at startup** — patching `dist` on disk (via `fix-aqe.sh`/`fix-ruflo.sh`) does NOT take effect until you **restart the daemon** (`ruflo daemon stop && ruflo daemon start`; there is no `restart` subcommand). Skipping this is what made a dream-lock fix appear to "regress". See `_INSTRUCTIONS.md` Patch 40. (Only relevant when you've opted the daemon on.)
- **Dream-cycle locking** (`AQE-DREAM-LOCKFIX-V2`, Patch 35): the DreamScheduler now uses an atomic claim (`WHERE NOT EXISTS` recent running) across all 4 insert paths + `wal_checkpoint(TRUNCATE)` on every cycle exit + a per-cycle orphan sweep. Time predicates use `strftime('%Y-%m-%dT%H:%M:%fZ',…)` to match the stored `toISOString()` format (a `datetime('now')` predicate is lexically broken for same-day rows).
- **Router B learning** (Patches 36–37): graded reward (`DERIVE-OUTCOME-V2`) + ε-greedy exploration (`RUFLO-ROUTE-EXPLORE-V2`, ε 0.15→0.05, env `RUFLO_ROUTE_EPSILON`, `=0` is an exact no-op). `RUFLO_DISABLE_TRAINING=1` is the no-train control arm. AQE ML router `confidenceThreshold` is **0.6** (`.agentic-qe/config.yaml`, **codified in `fix-aqe.sh` Step 4** so a regen can't reset it); Router B uses its own `topMatch.score > 0.4` gate.
- **Honest learning status:** self-LEARNING is operationally trustworthy; self-IMPROVEMENT is wired + measurable but **not yet proven** (needs cross-session longitudinal data — see [whats-genuinely-left-rnd.md](./whats-genuinely-left-rnd.md)).

---

## 4. Safety (read before destructive ops)

- **BACK UP before any DB operation.** Never `rm -f` on `.agentic-qe/` or `*.db` files without confirmation.
- **NEVER `cp` a backup over a live `.agentic-qe/memory.db`** (Patch 46). It's WAL-mode with live writers (daemon + MCP) — copying over it corrupts the page tree. Use `sqlite3 DB ".backup '/tmp/x.db'"`, surgical `DELETE` (tag rows with a unique prefix), or stop all writers + restart Claude Code first. Recovery if corrupted: `sqlite3 bad.db ".recover" \| sqlite3 fixed.db`, then `PRAGMA journal_mode=WAL`.
- **NEVER auto-commit or push.** Wait for an explicit request.
- **DO NOT bump AgentDB past alpha.10** — it dormant-fails the advanced controllers.
- **Upgrade via `npm i -g ruflo`, not npx** — npx reconciles its cache on every call and reverts the alpha.10 pin.
- **After ANY `agentic-qe` reinstall/upgrade:** re-run `bin/ruflo-kit fix-aqe <target>` (the AQE-PROMOTE-V1 + AQE-DREAM-LOCKFIX-V2 dist patches are overwritten) + `aqe learning extract` (re-mint the lost pattern row) + `bin/ruflo-kit fix-statusbar <target>` (`aqe init` clobbers the statusline).
- **After ANY dist patch (`fix-aqe.sh` / `fix-ruflo.sh`): restart the daemon** (`ruflo daemon stop && ruflo daemon start`). The long-lived daemon runs the OLD in-memory dist until restarted — an unrestarted daemon silently negates the fix.
- **NEVER run `npm test` without `--run`** (watch-mode risk). Use `npm test -- --run`.

---

## 5. See also

- [OPERATIONS.md](./OPERATIONS.md) — step-by-step workflows + troubleshooting.
- [./_INSTRUCTIONS.md](./_INSTRUCTIONS.md) — deep technical rationale (Patch-N narrative).
- [whats-genuinely-left-rnd.md](./whats-genuinely-left-rnd.md) — honest self-improvement / R&D status.
