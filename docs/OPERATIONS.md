# Operations Guide

Step-by-step procedures for the ruflo + AQE + AgentDB stack. One-line lookups → [CHEATSHEET.md](./CHEATSHEET.md); deep rationale → [./_INSTRUCTIONS.md](./_INSTRUCTIONS.md).

All commands run through the `bin/ruflo-kit` dispatcher with a positional `<target>` codebase path (the kit `TARGET_DIR`; defaults to `$(pwd)`). Examples below use `<target>` as a placeholder — substitute the path to the codebase you are operating on (or `.` for the current repo).

**Contents**
- [A. Workflows](#a-workflows)
  - [A1. First-time setup](#a1-first-time-setup)
  - [A2. Session start](#a2-session-start)
  - [A3. Upgrade ruflo](#a3-upgrade-ruflo)
  - [A3b. Upgrade AQE](#a3b-upgrade-aqe)
  - [A4. Fix config drift](#a4-fix-config-drift)
  - [A5. Health check](#a5-health-check)
  - [A6. Self-improvement bench](#a6-self-improvement-bench)
  - [A7. Security scan](#a7-security-scan)
  - [A8. Daemon & token cost](#a8-daemon--token-cost)
  - [A9. ruvnet-brain (MCP-only knowledge base)](#a9-ruvnet-brain-mcp-only-knowledge-base)
- [B. Troubleshooting](#b-troubleshooting)
- [C. Architecture (plain English)](#c-architecture-plain-english)
- [D. See also](#d-see-also)

---

## A. Workflows

### A1. First-time setup

*Use when:* setting up the stack on a fresh checkout.

1. From the project root, run: `bin/ruflo-kit init <target>`
2. To preview without changing anything: `bin/ruflo-kit init <target> --dry-run`
3. To re-initialise everything from scratch: `bin/ruflo-kit init <target> --force` (`--force` implies `--reactivate`).
4. To re-seat only activation + daemon (skip re-running init/memory/aqe init): `bin/ruflo-kit init <target> --reactivate`

This one script calls `fix-ruflo.sh` (step 5), `fix-statusbar.sh` (step 6) and `fix-aqe.sh` (step 6.5) for you, so a fresh checkout is fully wired in one run.

**AQE install:** AQE ships as the global `agentic-qe` package (CLI binary `aqe`, MCP binary `aqe-mcp`); install it with `npm i -g agentic-qe` (npx fallback: `npx -y agentic-qe@latest`). The init script's **step 4** runs `aqe init --auto`, which creates `.agentic-qe/memory.db`, installs ~115 skills / ~60 agents / ~20 `aqe-*` commands, and appends the `## Agentic QE v3` section to `CLAUDE.md`. (`aqe init` *without* `--auto` is a half-init — always use `--auto`.) Because `aqe init` also clobbers the statusline and regenerates `CLAUDE.md`/`settings.json`, `fix-statusbar.sh` runs after it.

**Verify:** run `bin/ruflo-kit session <target>` and confirm "All systems ready".

### A2. Session start

*Use when:* beginning a Claude Code session, to prime memory and confirm the loop is alive.

1. Run: `bin/ruflo-kit session <target>`
2. It applies patches (`fix-ruflo.sh`, `fix-statusbar.sh`), checks the MCP server, reports daemon status (**does not auto-start it** — auto-start is opt-in, see [A8](#a8-daemon--token-cost)), verifies persistent storage, and checks the AgentDB controllers and native binaries.
3. In Claude Code, verify controllers: `agentdb_controllers` → active **23/23**.

**Verify:** the summary prints "All systems ready" (0 issues). Warnings list anything to address.

### A3. Upgrade ruflo

*Use when:* moving to a newer ruflo release. **Run AFTER closing the Claude Code session** — it restarts the live MCP server.

1. Close the Claude Code session.
2. Install the new global binary: `npm i -g ruflo`
3. Preview the upgrade first: `bin/ruflo-kit upgrade <target> --dry-run`
4. Run it for real: `bin/ruflo-kit upgrade <target>` (upgrades global ruflo, wipes + rehydrates the npx cache, re-runs `fix-ruflo.sh` to re-pin AgentDB to alpha.10, then re-activates).
5. Restart Claude Code (the MCP server picks up the new ruflo).
6. Verify: `bin/ruflo-kit session <target>`, then in Claude Code `agentdb_controllers` → **23/23**.

**Why not npx:** the MCP server launches from the **global** `ruflo` binary. `npx ruflo@latest` reconciles its cache on every call and would revert the alpha.10 AgentDB pin — so upgrades go through `npm i -g` + this script, never npx.

**AgentDB pin layout (hoisted vs nested — as of ruflo 3.32.2).** Modern ruflo (≥3.3x) **hoists `agentdb@alpha.17` to `ruflo/node_modules/agentdb`**, but Step 3b keeps **`agentdb@3.0.0-alpha.10` in the nested `@claude-flow/memory/node_modules/agentdb` slot**. Node resolves the nearest `node_modules` first, so the nested alpha.10 **shadows** the hoisted alpha.17 *for the memory layer only* — the two coexist. Why not just adopt the hoisted alpha.17: it **permanently removed 8 controller classes** (`SemanticRouter`, `GNNService`, `RVFOptimizer`, `GuardedVectorBackend`, `MutationGuard`, `AttestationLog`, `HierarchicalMemory`, `MemoryConsolidation`), and ruflo's rewritten `ControllerRegistry` (ADR-053/055) **degrades per-controller instead of crashing** — so an un-pinned alpha.17 would *look* healthy while silently missing those controllers. Both versions pass the core smokes; alpha.10 is the one that boots the advanced controllers (the `GuardedBackend` proof-engine boot is the tell). alpha.17 also moved `better-sqlite3` peerDep → optionalDependencies, so Patch 49's global better-sqlite3 install is now belt-and-suspenders. Full A/B record: `_INSTRUCTIONS.md` Patch 52. **Restart-gated:** the live `agentdb_controllers` count only reflects the pin *after* a Claude Code restart (running MCP caches the old dist).

### A3b. Upgrade AQE

*Use when:* moving to a newer `agentic-qe` release. **This is a manual 5-step sequence — there is no upgrade automation for AQE** (the `upgrade` command is ruflo-only). Unlike AgentDB, AQE is **unpinned / free-floating @latest**, so there is no version pin to defend — but a reinstall *does* drop two local patches you must restore. Run AFTER closing the Claude Code session (it restarts the live `aqe-mcp` server).

1. Close the Claude Code session.
2. Install the new global package: `npm i -g agentic-qe@latest`
3. Re-run AQE init in upgrade mode: `aqe init --auto --upgrade`
4. Re-apply the lost dist patch and re-mint the dropped pattern: `bin/ruflo-kit fix-aqe <target> && aqe learning extract`
5. Restore the statusline (`aqe init` clobbers it): `bin/ruflo-kit fix-statusbar <target>`
6. Restart Claude Code (the MCP server picks up the new AQE).

**Why it's manual / what's lost on every reinstall:**
- The **AQE-PROMOTE-V1** patch lives *inside* the global package at `<global agentic-qe>/dist/cli/chunks/*.js` (the chunk matching `GROUP BY domain HAVING COUNT`; `fix-aqe.sh` locates it dynamically). Any `npm i -g agentic-qe` **overwrites `dist/`**, so the patch is lost → re-run `fix-aqe.sh`.
- The minted `qe_patterns` row is dropped when the AQE DB re-inits → re-run `aqe learning extract` to re-mint it.
- `bin/ruflo-kit upgrade` never runs `agentic-qe` install, `aqe init`, or `fix-aqe.sh` — it only upgrades ruflo. AQE upgrades are entirely the sequence above.
- **3.10.4 note (#516):** the `AQE_PROJECT_ROOT` pins (kept at the MCP + daemon spawn points) and the `RVF-STRAY-SWEEP-V1` cleanup exist to contain a ≤3.10.3 project-root hijack — a stray `~/.agentic-qe` captured root resolution to `$HOME`, and RVF also minted cwd-relative strays. `agentic-qe@3.10.4` fixed both at the source (nearest-wins `findProjectRoot` + RVF honoring `AQE_PROJECT_ROOT`); the kit keeps the pins as the **canonical** anchor and the sweep as **legacy cleanup**. Full record: `_INSTRUCTIONS.md` Patch 51.
- **3.12.2 note (current):** the global is now `agentic-qe@3.12.2`. The 3.12.2 schema migrations (`qe_trajectories.metadata_json` column + a `qe_pattern_nulls` backfill) applied cleanly and were verified — **~530 trajectories intact (point-in-time; they accrue)**. `fix-aqe.sh` also relocated its dream-lockfix CLI-chunk lookup from a content-hashed filename to an INSERT-anchor match (the hash changed `IJ4BUSJN → XNNYHQLW` in 3.12.2), and re-asserts `daemonAutoStart: false` (`AQE-DAEMON-AUTOSTART-OFF-V1`, see [A8](#a8-daemon--token-cost)). Full record: `_INSTRUCTIONS.md` Patch 52 / 54.

**Verify:** `aqe --version` reports the new version; `bin/ruflo-kit fix-aqe <target>` re-run reports items as "already present"; statusline shows ruflo + Agentic QE v3.

### A4. Fix config drift

*Use when:* something that was working has reset (often after `aqe init` or a reinstall). All three are idempotent and safe to re-run; `fix-ruflo.sh` and `fix-aqe.sh` accept `--dry-run` (and `fix-aqe.sh` is reversible via `.bak`); `fix-statusbar.sh` takes no flags.

Run only the one that drifted, or run them in this order if several did:

1. ruflo / claude-flow MCP setup drifted (controllers dormant, MCP misconfigured): `bin/ruflo-kit fix-ruflo <target>`
2. Status bar reverted to the minimal stub: `bin/ruflo-kit fix-statusbar <target>`
3. AQE-side hardening lost (pattern distillation, `.claude` helpers/hooks): `bin/ruflo-kit fix-aqe <target>`
4. Restart Claude Code so the MCP server reloads.
5. If much is broken at once, the heavier option is `bin/ruflo-kit init <target> --reactivate`, which re-runs all three plus re-activation.

**Verify:** each script prints a per-check summary; re-running reports items as "already present".

### A5. Health check

*Use when:* you want to know whether the self-learning loop is still growing or has silently flatlined.

1. Run: `bin/ruflo-kit health <target>` — snapshots ~14 metrics, diffs against the previous run, writes `.claude-flow/data/health-last.json`, and appends a row to `.claude-flow/data/health-history.jsonl`.
2. Force a fresh baseline: `bin/ruflo-kit health <target> --reset`
3. Diff without updating the snapshot: `bin/ruflo-kit health <target> --dry-run`
4. Emit raw snapshot JSON only: `bin/ruflo-kit health <target> --json`
5. Read the output: growth markers mean metrics (memory, intelligence, neural, AQE patterns/trajectories, DB rows/sizes) are rising; regression markers mean a metric dropped.

**Verify:** healthy = growth or steady across runs (exits 0). The script **exits non-zero if anything regressed**, so it doubles as a CI gate — a degraded run = repeated regressions; investigate via A4, then [./_INSTRUCTIONS.md](./_INSTRUCTIONS.md).

### A6. Self-improvement bench

*Use when:* settling "are routing decisions measurably improving?" with data, not assertion.

1. Run: `bin/ruflo-kit bench <target>` — READ-ONLY; routes a fixed held-out task set, scores accuracy + confidence, checks reward variance, and appends one row to `.claude-flow/selfimprove-history.jsonl`.
2. Machine-readable output: `bin/ruflo-kit bench <target> --json`
3. Suppress chatter: `bin/ruflo-kit bench <target> --quiet`
4. Also diagnose the AQE router's confidence: `bin/ruflo-kit bench <target> --aqe-confidence`
5. Re-run across sessions — a single run can only *disprove*; the verdict needs a trend over runs.
6. Pair with `bin/ruflo-kit harvest <target>` (also wired to SessionEnd) to replay AQE experiences into the ruflo substrate between bench runs.
7. For a **statistically framed** verdict, run the gate-#4 instrument directly: `node tools/improvement-eval.cjs` — multi-seed runs with a permutation-test *p*-value, Cohen's *d* effect size, and a hard **2σ / 3-run** pass gate (`--selftest` validates the instrument itself). It is the measurement tool for the R&D gate; the gate stays **OPEN** until there are ≥3 cross-session runs. See [whats-genuinely-left-rnd.md](./whats-genuinely-left-rnd.md).
8. Drift guard: `.github/workflows/nightly-drift.yml` runs a nightly **real-latest** install of ruflo + aqe, the fix scripts, and `health` on **macOS + Ubuntu**, so an upstream bump that moves an anchor or resets a pin is caught before a live session hits it.

**Reading the verdict ladder** (the bench is deliberately hard to turn green):
- `NOT-IMPROVING (blocked)` — reward is constant; improvement is impossible by construction.
- `UNPROVEN (need >=3 same-scorer runs)` — reward varies, but there aren't yet 3 runs under the current scorer to establish a trend.
- `IMPROVING (evidence, control pending)` — accuracy rose across >=3 same-scorer runs; still **not PROVEN** until a flat no-train control arm is shown (the harness cannot run that control itself).

**Verify:** a new row lands in `.claude-flow/selfimprove-history.jsonl`. **Honest reading:** the loop's mechanism is proven but production efficacy is NEUTRAL — never green without a flat no-train control. See [§C3](#c3-honest-self-improvement-status) and [whats-genuinely-left-rnd.md](./whats-genuinely-left-rnd.md). Do not read a single up-tick as "it self-improves".

### A7. Security scan

*Use when:* auditing the project for security issues. **There is no kit command for this — it is a CLI / MCP capability only.**

1. CLI scan: `ruflo security scan`
2. From Claude Code, the AI-defence MCP tools: `aidefence_scan`, `aidefence_is_safe`, `aidefence_has_pii`.
3. From Claude Code (after `fleet_init`), comprehensive SAST/DAST: `mcp__agentic-qe__security_scan_comprehensive`.

**Verify:** review the reported findings; address before committing.

### A8. Daemon & token cost

*Use when:* deciding whether to run the background daemon, or chasing unexplained Claude token spend.

**The mental model that matters:** the daemon is a **standalone background server**, not part of your Claude Code session. Once started it detaches and reparents to `launchd` (PID 1) and keeps looping — spawning billed `claude --print` LLM calls (sonnet/opus) every 10–30 min, **24/7, whether or not Claude Code, your terminal, or your editor is open**. Closing the session does nothing to it. **If you start it, you own stopping it** — treat `ruflo daemon start` like launching a web server.

**Auto-start is OPT-IN** (Patch 50). The kit no longer starts the daemon for you at session start or bootstrap. Control it with `RUFLO_DAEMON_MODE`:

| `RUFLO_DAEMON_MODE` | session-init / bootstrap behavior | spend |
|---|---|---|
| *(unset)* / `off` | **Default.** Never auto-starts. You run the loop yourself when you want it. | none in background |
| `auto` | Auto-starts the persistent daemon every session (the pre–Patch-50 behavior). | continuous, 24/7 |
| `once` | Runs **one** worker pass (`daemon trigger -w audit`) at session start, then exits. | bounded per session |

**Daily workflows:**

1. *One-off analysis, no loop:* `ruflo daemon trigger -w audit` (runs once, exits — `audit`, `optimize`, `testgaps`, `map`, `consolidate`).
2. *Run the persistent loop for a while:* `ruflo daemon start` … then **always** `ruflo daemon stop` when done; confirm with `ruflo daemon status` (`Status: ○ STOPPED`).
3. *Opt into always-on:* `export RUFLO_DAEMON_MODE=auto` (in your shell profile or the project env). Remember: after any dist patch, `ruflo daemon stop && ruflo daemon start` to reload the in-memory dist.

**Audit anytime** (does anything keep looping?):
```bash
alias flowps='ps -ax -o pid,etime,command | grep -E "claude-flow|claude --print|ruflo (daemon|mcp)" | grep -v grep'
```
Stale `daemon-state.json` files can read `running: true` with no live process — trust `ps`/`flowps` and `ruflo daemon status`, not the state file.

**No launchd supervisor here.** `ruflo daemon install-supervisor` *would* install a launchd/systemd unit that respawns the daemon on login/reboot — this kit does **not** use it. If you ever ran it, `stop` is not enough; run `ruflo daemon uninstall-supervisor`. (Verified clean on this machine: nothing in `~/Library/LaunchAgents`, `launchctl list`.)

**The AQE side has its own daemon — pinned OFF (`AQE-DAEMON-AUTOSTART-OFF-V1`).** AQE's `.agentic-qe/config.yaml` carries a `daemonAutoStart` flag; `fix-aqe.sh` pins it **`false`**. This matters because upstream **`aqe doctor --fix` honored a `true` value and resurrected the billed AQE daemon three times in one session** — so the kit re-asserts `false` on every `fix-aqe` run. This is the AQE-side complement to the `RUFLO_DAEMON_MODE` gate above; both must be off for a truly quiet background.

**Upstream is catching up (recheck on upgrade).** ruflo **#2661** landed daemon governance in the 3.27+ line — opt-in AI workers, a global budget ledger, and a circuit breaker. That is the right long-term home for cost control, but the kit's **daemon-off default is retained as belt-and-suspenders** until the governance is verified on the pinned version. Don't remove the local gates just because upstream added a budget knob.

**Hard guardrails (your real safety net, independent of process hygiene):** in the Anthropic Console set a **monthly spend limit + usage alerts**, and use a **separate API key for automation** so it can be monitored and revoked independently of your interactive key.

**Verify:** `ruflo daemon status` → `Status: ○ STOPPED` when you expect it off; `flowps` shows no `claude --print` / `daemon start` processes; `.agentic-qe/config.yaml` shows `daemonAutoStart: false`.

---

### A9. ruvnet-brain (MCP-only knowledge base)

*Use when:* you want the agent to have an on-demand knowledge base to query, **without** adding any always-on background cost.

**What it is:** a knowledge-brain wired as an **MCP server only** — no hooks, no `launchd` unit, no plugin, nothing that spawns billed work. `lib/fix-brain.sh` registers the **`ruvnet-brain`** server (exposing the `search_ruvnet` tool) in `.mcp.json`, backed by an Ed25519-verified knowledge base (**≈736 MB download → ≈1.7 GB unpacked**) cached at `~/.cache/ruvnet-brain/kb`. It is a **read surface** the agent queries on demand; unlike the daemon ([A8](#a8-daemon--token-cost)) it has **zero always-on cost** and no session-lifecycle coupling — which is the entire design rationale (`BRAIN-MCP-V1`).

1. Register + (opt-in) fetch the KB: `bin/ruflo-kit fix-brain <target> --download` (the `--download` pulls the 1.7 GB KB; omit it to register the server against an already-cached KB).
2. Health probe: `bin/ruflo-kit fix-brain <target>` re-runs idempotently — it confirms the `ruvnet-brain` server answers and the KB Ed25519 signature verifies.
3. From Claude Code, query via the `search_ruvnet` MCP tool after a restart (Claude Code launches the MCP server lazily on first call).

**Why MCP-only (not a hook or daemon):** anything that fires on a hook or a timer can spawn billed `claude --print` work unattended — the exact trap Tier 13 closed. A pure MCP read surface can only run when the agent explicitly calls it, so it stays free at rest. Full record: `_INSTRUCTIONS.md` Patch 53.

**Verify:** `.mcp.json` contains a **`ruvnet-brain`** server entry (the server exposes the `search_ruvnet` tool — do not grep for the tool name); `~/.cache/ruvnet-brain/kb` exists and verifies; the health probe reports OK.

---

## B. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `agentdb_controllers` shows fewer than 23/23 (the 7 advanced controllers `mutationGuard`, `gnnService`, `attestationLog`, `semanticRouter`, `guardedVectorBackend`, `rvfOptimizer`, `graphAdapter` go dark) | AgentDB bumped past alpha.10 (regressed classes) | `bin/ruflo-kit fix-ruflo <target>` (Step 3b re-pins to alpha.10); restart Claude Code; confirm with `agentdb_controllers` |
| MCP tools missing / not callable | MCP launched via npx instead of the global binary, or daemon down | `ruflo daemon start`; confirm `.mcp.json` → `command: "ruflo"`, `args: ["mcp","start"]`; restart Claude Code |
| GNN / SONA native acceleration unavailable after a `npm i -g ruflo` | Global install shipped without the prebuilt native binaries | `bin/ruflo-kit fix-ruflo <target>` restores the prebuilt RuVector binaries from `assets/builds/` into the global install |
| Status bar broken / minimal stub | Drift after `aqe init` or reinstall | `bin/ruflo-kit fix-statusbar <target>` |
| AQE pattern distillation / promoted pattern gone after an `agentic-qe` reinstall or DB re-init | Reinstall overwrote the AQE-PROMOTE-V1 dist patch and/or dropped the minted `qe_patterns` row | `bin/ruflo-kit fix-aqe <target> && aqe learning extract` |
| Session feels "cold" / no memory recall | `ruflo-session-init.sh` not run this session | Run [A2](#a2-session-start) |
| Tests hang / never exit | `npm test` started in watch mode | Use `npm test -- --run` |
| `*.db` corruption or accidental wipe | Destructive op on a database file | Restore from backup; **never** `rm -f` on `.agentic-qe/` or `*.db` |

---

## C. Architecture (plain English)

### C1. Three layers

- **ruflo** — the orchestration layer. Spawns and coordinates agents, routes tasks, runs the MCP server and daemon.
- **Agentic QE v3 (AQE)** — the quality-engineering layer. 13 bounded contexts (test generation, coverage, quality assessment, defect intelligence, and more) with its own learning store. Installed as the global `agentic-qe` package (CLI `aqe`, MCP `aqe-mcp`) and **unpinned / free-floating @latest** — there is no version pin here (no symmetry with the AgentDB `alpha.10` pin); `settings.json` `aqe.version` is only a record of the last init. A reinstall does, however, drop the local AQE-PROMOTE-V1 patch and the minted pattern row — see [A3b](#a3b-upgrade-aqe).
- **AgentDB** — the memory layer. Vector store with 23 controllers and HNSW indexing for fast semantic search and pattern recall.

RuVector's native acceleration (GNN and SONA) ships as prebuilt `.node` binaries kept in `assets/builds/`. `fix-ruflo.sh` restores them into the global install after a `npm i -g ruflo`, so the accelerated paths survive an upgrade — you don't run anything in `assets/builds/` directly.

### C2. The learning loop

Hooks fire around each task: a pre-task hook injects relevant prior context, a post-task hook records what happened. Recorded outcomes are stored as patterns, consolidated by background workers, and recalled on the next task.

```
task → pre-task hook (recall context) → work → post-task hook (record outcome)
          ↑                                                        │
          └──── background consolidation ←── pattern store ←───────┘
```

### C3. Honest self-improvement status

- **Self-LEARNING is real** — artifacts (patterns, trajectories, embeddings, LoRA weights) grow and persist across sessions.
- **Self-IMPROVEMENT is mechanism-proven but production efficacy is NEUTRAL** — controlled tests show the learning paths move toward reward when fed varied outcomes, but measurable improvement on real work is **not yet demonstrated** (held-out routing accuracy is flat, and the live signal is on-policy).

Do **not** state that "the system self-improves." The accurate framing is *"self-learns; self-improvement on real work is unproven."* For the R&D status and the remaining gates, see [whats-genuinely-left-rnd.md](./whats-genuinely-left-rnd.md); for deep technical detail see [./_INSTRUCTIONS.md](./_INSTRUCTIONS.md).

---

## D. See also

- [./_INSTRUCTIONS.md](./_INSTRUCTIONS.md) — deep technical rationale (Patch-N narrative).
- [whats-genuinely-left-rnd.md](./whats-genuinely-left-rnd.md) — current honest self-improvement / R&D status.
- [self-improvement-next-steps.md](./self-improvement-next-steps.md) — dated handoff snapshot (superseded; historical context).
- [reference/self-improving-tier-research-for-reference.md](./reference/self-improving-tier-research-for-reference.md) — upstream routing/learning findings.
- [../CLAUDE.md](../CLAUDE.md) — project configuration and policies.
