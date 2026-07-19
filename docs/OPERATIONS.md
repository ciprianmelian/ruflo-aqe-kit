# Operations Guide

Step-by-step procedures for the ruflo + AQE + AgentDB stack. One-line lookups → [CHEATSHEET.md](./CHEATSHEET.md); deep rationale → [./_INSTRUCTIONS.md](./_INSTRUCTIONS.md).

All commands run through the `bin/ruflo-kit` dispatcher with a positional `<target>` codebase path (the kit `TARGET_DIR`; defaults to `$(pwd)`). Examples below use `<target>` as a placeholder — substitute the path to the codebase you are operating on (or `.` for the current repo).

**Contents**
- [A. Workflows](#a-workflows)
  - [A1. First-time setup](#a1-first-time-setup)
  - [A1b. Adopting an already-inited target (ruflo init without the kit)](#a1b-adopting-an-already-inited-target-ruflo-init-without-the-kit)
  - [A2. Session start](#a2-session-start)
  - [A3. Upgrade ruflo](#a3-upgrade-ruflo)
  - [A3b. Upgrade AQE](#a3b-upgrade-aqe)
  - [A4. Fix config drift](#a4-fix-config-drift)
  - [A5. Health check](#a5-health-check)
  - [A6. Self-improvement bench](#a6-self-improvement-bench)
  - [A7. Security scan](#a7-security-scan)
  - [A8. Daemon & token cost](#a8-daemon--token-cost)
  - [A9. ruvnet-brain (MCP-only knowledge base)](#a9-ruvnet-brain-mcp-only-knowledge-base)
  - [A10. Fresh machine → proved stack (setup + proof)](#a10-fresh-machine--proved-stack-setup--proof)
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

### A1b. Adopting an already-inited target (ruflo init without the kit)

*Use when:* pointing the kit at a codebase that was already set up with a plain `ruflo init` (and possibly `aqe init`) **without** the kit, and you need to know what it will and won't touch.

**Memory safety — the short answer:** without `--force`, the kit never resets memories. The three canonical stores (`.swarm/memory.db`, `.agentic-qe/memory.db`, `./agentdb.db`) are never deleted, truncated, or rewritten by any kit verb — `init` step 3 skips `ruflo memory init` when `.swarm/memory.db` exists, `fix-learning`'s stray-store cleanup hard-codes all three as preserved canonical roots (and only runs under `--cleanup --confirm`, with a `.cleanup-bak` copy first), and `harvest`/`fix-learning` only ADD rows. The stray-`.agentic-qe` sweep (RVF-STRAY-SWEEP-V1) only targets RVF-only dirs — no `memory.db`/`config.yaml` inside — and `mv`s them to `.cleanup-bak` rather than deleting.

**Init self-no-ops on the existing pieces.** With `.claude-flow/config.yaml` + `.mcp.json` + `.claude/skills` present, `init` skips `ruflo init` entirely; the step-4.5 template backfill is add-only (never overwrites, so local `.claude/` customizations survive). What the kit then ADDS is the AQE/agentdb/brain layer plus the config pins below.

**What the kit WILL change on an adopted target** (all surgical merges, all backed up, all previewable with `--dry-run`):

| Artifact | Change | Safety |
|---|---|---|
| `.mcp.json` | claude-flow entry migrated `npx` → global `ruflo`; duplicate `ruflo` entry deduped; `agentdb` + `ruvnet-brain` servers added | jq merge, JSON-validated, backup + restore-on-failure |
| `CLAUDE.md` | stale `@claude-flow/cli@latest` refs rewritten; Runtime section appended (only if the `## Agentic QE v3` anchor exists) | `.fixruflo.bak`, auto-restore on failed verification; prose untouched by design |
| `.claude/settings.json` | hooks wired (SessionEnd harvest etc.), `AQE_PROJECT_ROOT` pinned, `enabledMcpjsonServers`, `statusLine.command` | node JSON merge preserving other keys, `.fixaqe-bak`, restore-on-invalid |
| `.claude/helpers/statusline.cjs` | **replaced** with the kit's canonical statusline — the one file a custom setup loses | `.bak` + `node --check` + runtime smoke, restore on failure |
| `.agentic-qe/config.yaml` + `claude-flow.config.json` | `daemonAutoStart` / `daemon.autostart` pinned `false` (billed daemon stays opt-in) | single-key edit |
| `node_modules/agentdb` (target) | removed **only if orphaned** (kept with a warning when declared in the target's `package.json`) | guarded check |

**Behavioral deltas to expect:** the MCP launch moves from npx to the global `ruflo` binary (`setup` installs it); daemon autostart is pinned OFF in all three channels — a workflow that relied on autostart now needs an explicit `ruflo daemon start` or `RUFLO_DAEMON_MODE=auto` (see [A8](#a8-daemon--token-cost)). A RUNNING daemon is never killed by adoption — only `upgrade` and `init --force` stop it.

**Recommended sequence:**

1. `bin/ruflo-kit status <target>` — read-only; see what the kit is walking into.
2. `bin/ruflo-kit sync <target> --dry-run` — the whole fix cascade prints its plan with zero writes; review the "would" lines.
3. Optional belt-and-suspenders: `sqlite3 <db> ".backup '/tmp/x.db'"` for the two memory DBs (never `cp` a live WAL DB — §Safety), and git-commit `.mcp.json` / `CLAUDE.md` / `.claude/` if the target is a repo.
4. `bin/ruflo-kit setup <target>` (or `init` + `sync`) — **without `--force`**. Init no-ops the existing ruflo pieces, adds the missing layers; sync converges configs; the 15-probe proof verifies (exit code = verdict).
5. Restart Claude Code so the MCP/settings changes load; the daemon stays opt-in.

**The one destructive switch:** `bin/ruflo-kit init <target> --force` re-runs upstream `ruflo init --force`, which regenerates `CLAUDE.md`/`.claude/` over existing content — reserve it for genuinely broken installs, never for "it was inited without the kit". Two benign edge cases: a *partial* prior init (e.g. no `.claude/skills`) makes `init` re-run plain non-force `ruflo init` (add/skip-oriented; the npx `mcpServers.ruflo` entry it re-adds is deduped right after), and a half `aqe init` (DB present, `.claude/` AQE templates missing) triggers `aqe init --auto --upgrade` — which regenerates the statusline (restored by `fix-statusbar`) but does not touch the DB.

**Verify:** `bin/ruflo-kit proof <target>` ends PROVED, `bin/ruflo-kit status <target>` shows the pre-existing learning stores with their prior row counts intact.

### A2. Session start

*Use when:* beginning a Claude Code session, to prime memory and confirm the loop is alive.

0. Quick look first (optional, ~0.6s): bare `ruflo-kit` or `bin/ruflo-kit status <target>` — one screen of disk-derived truth (versions incl. the 3 agentdb slots, sentinels n/N, daemon via pgrep, learning stores). If it looks right, `session` will mostly confirm it.
1. Run: `bin/ruflo-kit session <target>`
2. It applies patches (`fix-ruflo.sh`, `fix-statusbar.sh`), checks the MCP server, reports daemon status (**does not auto-start it** — auto-start is opt-in, see [A8](#a8-daemon--token-cost)), verifies persistent storage, and checks the AgentDB controllers and native binaries.
3. In Claude Code, verify controllers: `agentdb_controllers` → active **23/23**. (The count reflects the NESTED alpha.10 shadow, not the hoisted alpha.17 — see [A3](#a3-upgrade-ruflo); it is only verifiable after a Claude Code restart, since a live MCP server caches the old dist.)

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

*Use when:* something that was working has reset (often after `aqe init` or a reinstall). All fix scripts are idempotent and safe to re-run; `fix-ruflo.sh`, `fix-aqe.sh` and `fix-brain.sh` accept `--dry-run` (and `fix-aqe.sh` is reversible via `.bak`); `fix-statusbar.sh` takes no flags.

**One-verb path (default):** `bin/ruflo-kit sync <target>` runs fix-ruflo → fix-aqe → fix-statusbar → fix-brain → verify-learning in order and prints a per-stage summary (`--dry-run` propagates to every stage; exit 1 only on a hard fix-stage failure). Not sure anything drifted? `bin/ruflo-kit status <target>` first.

Or run only the one that drifted:

1. ruflo / claude-flow MCP setup drifted (controllers dormant, MCP misconfigured): `bin/ruflo-kit fix-ruflo <target>`
2. Status bar reverted to the minimal stub: `bin/ruflo-kit fix-statusbar <target>`
3. AQE-side hardening lost (pattern distillation, `.claude` helpers/hooks): `bin/ruflo-kit fix-aqe <target>`
4. Brain KB / `ruvnet-brain` MCP registration drifted: `bin/ruflo-kit fix-brain <target>` (see [A9](#a9-ruvnet-brain-mcp-only-knowledge-base))
5. Restart Claude Code so the MCP server reloads.
6. If much is broken at once, the heavier option is `bin/ruflo-kit init <target> --reactivate`, which re-runs the fixes plus re-activation.

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

**THE THIRD CHANNEL — every CLI call auto-spawns a daemon (ruflo ≥3.32, closed by `DAEMON-AUTOSTART-3-V1` + `CF-CONFIG-AUTOSTART-OFF-V1`).** Upstream `services/daemon-autostart.js` runs on **every** `ruflo <anything>` invocation and spawns a detached daemon for the cwd when none is alive there. Because the statusline shells out to `ruflo hooks …` every 5 seconds, this manufactured daemons continuously (12 found in one audit — one per cwd that ever rendered, including test fixtures; kill → respawn within seconds). Neither gate above covers it. The kit now closes it twice over: the canonical statusline pins `RUFLO_DAEMON_AUTOSTART=0` into its child env, and **fix-ruflo writes `claude-flow.config.json` `{"daemon":{"autostart":false}}`** (the upstream-honored project opt-out) on every target. Proof **P14** verifies both gates and warns on any running daemon. To deliberately use auto-start anyway: set `RUFLO_DAEMON_AUTOSTART=1` in your shell (the statusline pin respects an explicit value) and flip the config key — you then own the daemons it creates, in **every directory you run ruflo in**.

**Field note (2026-07-19):** even with all gates in place, one stray daemon (`--workspace <kit repo>`) appeared during a heavy kit session (many CLI invocations incl. sandboxed `hooks route` runs) and was caught by proof **P14** as a WARN. The gates + probe worked as designed — detection, not prevention, is the last line — so the standing drill applies: trust `pgrep -f "cli.js daemon"`, kill anything you didn't deliberately start, and if it recurs, root-cause which invocation path escaped the env/config pins.

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

**Verify:** `.mcp.json` contains a **`ruvnet-brain`** server entry (the server exposes the `search_ruvnet` tool — do not grep for the tool name); `~/.cache/ruvnet-brain/kb` exists and verifies; the health probe reports OK. The statusline shows the `🧿 Ruflo Brain` row (`BRAIN-STATUSLINE-V1`, installed by `fix-statusbar`) with repo count, KB size, MCP registration and reader-deps state — if it reads `KB ●missing`, run `fix-brain --download`.

**Refreshing a stale KB (`BRAIN-KB-REFRESH-V1`, Patch 57):** every `fix-brain` run reports freshness — installed KB identity vs the newest GitHub Release (offline → `UNKNOWN`, informational, never an error). On a STALE report:

```bash
bin/ruflo-kit fix-brain <target> --refresh     # kit path: Ed25519 fail-closed re-download, in-place replace, reader deps reinstalled
npx ruvnet-brain --update                      # upstream alternative (same bundle)
```

The refresh is a **destructive in-place replace** with no multi-GB backup — the safety net is the fail-closed signature verify plus the post-unpack marker check (a failed download leaves the existing KB untouched). The installed identity is recorded in `$KB_DIR/.release-tag` at download time because the bundle's inner `package.json` can lag the release tag (v3.3.1 ships `3.0.0`-era `3.3.0`), which would otherwise read as permanently stale. `ruflo-kit status` shows the KB version disk-only (`mcp.brainKb.kbVersion`).

### A10. Fresh machine → proved stack (`setup` + `proof`)

*Use when:* bringing the full stack up on a new machine or a new target codebase — or whenever you want hard evidence the stack works.

```bash
bin/ruflo-kit setup <target>                   # the whole path: prereqs → installs → init → sync → proof x2
bin/ruflo-kit setup <target> --with-brain-kb   # + the opt-in GB-class knowledge base (add --refresh-brain-kb to force-refresh)
bin/ruflo-kit setup <target> --dry-run         # preview; changes nothing, exits 0
bin/ruflo-kit proof <target>                   # the evidence check alone, any time
```

**Stages:** S1 prereqs (node ≥18, npm — with the npm ≥11.17 install-scripts verdict printed, `NPM-ALLOW-SCRIPTS-V1`) → S2 global installs, probe-first idempotent (`ruflo`, `agentic-qe` — closing the old init gap that only *warned* — and `agentdb@pin` + `better-sqlite3`) → S3 `init` → S4 `sync` (the full heal cascade, including brain MCP registration) → S5 brain KB (only with `--with-brain-kb`) → S6 daemon policy: **setup never starts or stops the daemon** (it is billed — [A8](#a8-daemon--token-cost)); it only reports → S7 **proof x2**, and setup's exit code *is* the proof verdict.

**What `proof` actually proves (15 probes, disk/real-output only — never MCP self-reports):** ruflo + aqe CLIs and MCP `initialize` handshakes; the three AgentDB slots (standalone/nested exactly at the pin, hoisted at-or-past the upstream floor); ≥23 controller classes importable from the nested slot; better-sqlite3 loads; brain registered (KB optional = WARN); statusline renders; dist sentinels n/N; `verify-learning` ∈ {live, partial} (its probe #11 `SEAM-SENTINEL-V1` — Patch 64 — additionally FAILs the loop verdict if the installed dist lost the `SONA-TRAIN-V1`/`RUFLO-LORA-ADAPT-V1` seams to an upstream bump, the silent write-only-revert case the older probes could not see); health parses sanely (the comma-bug tripwire); `hooks route` answers; all three learning stores accept a write lock (a store held by a LIVE writer such as the session's aqe-mcp = WARN "not assessable", never FAIL); **P14 daemon-gates** (FAIL if `claude-flow.config.json` lacks `daemon.autostart:false` or the installed statusline lacks the `DAEMON-AUTOSTART-3-V1` pin; a *running* daemon is only a WARN — a deliberate start is the operator's right); **P15 statusline-truth** (the rendered `--json` is cross-checked against an independent sqlite recount + a real regex test-count). It runs the whole set **twice** — the second pass re-executed under a scrubbed environment (`env -i`) so nothing from the calling shell can influence it — and only identical clean passes earn `PROVED` (exit 0). A probe that changes its answer between passes yields `UNSTABLE`.

**Fresh targets PROVE honestly (Patches 62–63, first fresh-target e2e 2026-07-18):** kit verbs pin `AQE_PROJECT_ROOT=<target>` unconditionally (`AQE-ROOT-INHERIT-GUARD-V1`) so running `setup` from a shell that lives in ANOTHER project — e.g. a Claude session in the kit repo, whose settings export that project's pin — can no longer poison the target's `aqe init`. A zero-history target grades the learning loop **"primed", not hollow**: HOLLOW fires only on real evidence (unharvested eligible `captured_experiences`, or ≥1 session record with the LoRA adapter never applied at inference). The loop then closes on real work: a live Claude Code session in the target captures experiences (CLI runs do NOT) → `ruflo-kit harvest <target>` replays them into episodes/skills (`HARVEST-VECLESS-V1`: embedding-less rows — all of them on aqe 3.12.2 — harvest to the reflexion sink; no fabricated training vectors) → verify-learning flips to populated/engaged → PROVED with substance. **Target-owner note:** kit init vendors an upstream ruflo tree under `.agents/skills/` (~19.5k of its own tests) — scope your test-runner include globs (e.g. vitest `include: ['tests/**']`) or a bare `npx vitest run` collects them.

**Idempotence contract:** a second `setup` run on a healthy machine installs nothing, changes nothing, and ends PROVED again. Full record: `_INSTRUCTIONS.md` Patches 59 + 62–63.

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
