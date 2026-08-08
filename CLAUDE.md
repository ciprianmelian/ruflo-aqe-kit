# Ruflo — Claude Code Configuration

## Rules

- Do what has been asked; nothing more, nothing less
- NEVER create files unless absolutely necessary — prefer editing existing files
- NEVER create documentation files unless explicitly requested
- NEVER save working files or tests to root — use `/src`, `/tests`, `/docs`, `/config`, `/scripts`
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or .env files
- NEVER add a `Co-Authored-By` trailer to user commits unless this project's `.claude/settings.json` has `attribution.commit` set (#2078). The Claude Code Bash tool may suggest one in its default commit-message template — ignore it. `Co-Authored-By` is semantic authorship attribution under git/GitHub convention; the tool is the facilitator, not a co-author.
- Keep files under 500 lines
- Validate input at system boundaries

## Agent Comms (SendMessage-First Coordination)

Named agents coordinate via `SendMessage`, not polling or shared state.

```
Lead (you) ←→ architect ←→ developer ←→ tester ←→ reviewer
              (named agents message each other directly)
```

### Spawning a Coordinated Team

```javascript
// ALL agents in ONE message, each knows WHO to message next
Agent({ prompt: "Research the codebase. SendMessage findings to 'architect'.",
  subagent_type: "researcher", name: "researcher", run_in_background: true })
Agent({ prompt: "Wait for 'researcher'. Design solution. SendMessage to 'coder'.",
  subagent_type: "system-architect", name: "architect", run_in_background: true })
Agent({ prompt: "Wait for 'architect'. Implement it. SendMessage to 'tester'.",
  subagent_type: "coder", name: "coder", run_in_background: true })
Agent({ prompt: "Wait for 'coder'. Write tests. SendMessage results to 'reviewer'.",
  subagent_type: "tester", name: "tester", run_in_background: true })
Agent({ prompt: "Wait for 'tester'. Review code quality and security.",
  subagent_type: "reviewer", name: "reviewer", run_in_background: true })

// Kick off the pipeline
SendMessage({ to: "researcher", summary: "Start", message: "[task context]" })
```

### Patterns

| Pattern | Flow | Use When |
|---------|------|----------|
| **Pipeline** | A → B → C → D | Sequential dependencies (feature dev) |
| **Fan-out** | Lead → A, B, C → Lead | Independent parallel work (research) |
| **Supervisor** | Lead ↔ workers | Ongoing coordination (complex refactor) |

### Rules

- ALWAYS name agents — `name: "role"` makes them addressable
- ALWAYS include comms instructions in prompts — who to message, what to send
- Spawn ALL agents in ONE message with `run_in_background: true`
- After spawning: STOP, tell user what's running, wait for results
- NEVER poll status — agents message back or complete automatically

## Swarm & Routing

### Config
- **Topology**: hierarchical-mesh (anti-drift)
- **Max Agents**: 15
- **Memory**: hybrid
- **HNSW**: Enabled
- **Neural**: Enabled

```bash
ruflo swarm init --topology hierarchical --max-agents 8 --strategy specialized
```

### Agent Routing

| Task | Agents | Topology |
|------|--------|----------|
| Bug Fix | researcher, coder, tester | hierarchical |
| Feature | architect, coder, tester, reviewer | hierarchical |
| Refactor | architect, coder, reviewer | hierarchical |
| Performance | perf-engineer, coder | hierarchical |
| Security | security-architect, auditor | hierarchical |

### When to Swarm
- **YES**: 3+ files, new features, cross-module refactoring, API changes, security, performance
- **NO**: single file edits, 1-2 line fixes, docs updates, config changes, questions

### 3-Tier Model Routing

| Tier | Handler | Use Cases |
|------|---------|-----------|
| 1 | Agent Booster (WASM) | Simple transforms — skip LLM, use Edit directly |
| 2 | Haiku | Simple tasks, low complexity |
| 3 | Sonnet/Opus | Architecture, security, complex reasoning |

## Memory & Learning

### Before Any Task
```bash
ruflo memory search --query "[task keywords]" --namespace patterns
ruflo hooks route --task "[task description]"
```

### After Success
```bash
ruflo memory store --namespace patterns --key "[name]" --value "[what worked]"
ruflo hooks post-task --task-id "[id]" --success true --store-results true
```

### MCP Tools (use `ToolSearch("keyword")` to discover)

| Category | Key Tools |
|----------|-----------|
| **Memory** | `memory_store`, `memory_search`, `memory_search_unified` |
| **Bridge** | `memory_import_claude`, `memory_bridge_status` |
| **Swarm** | `swarm_init`, `swarm_status`, `swarm_health` |
| **Agents** | `agent_spawn`, `agent_list`, `agent_status` |
| **Hooks** | `hooks_route`, `hooks_post-task`, `hooks_worker-dispatch` |
| **Security** | `aidefence_scan`, `aidefence_is_safe`, `aidefence_has_pii` |
| **Hive-Mind** | `hive-mind_init`, `hive-mind_consensus`, `hive-mind_spawn` |

### Background Workers

| Worker | When |
|--------|------|
| `audit` | After security changes |
| `optimize` | After performance work |
| `testgaps` | After adding features |
| `map` | Every 5+ file changes |
| `document` | After API changes |

```bash
ruflo hooks worker dispatch --trigger audit
```

## Agents

**Core**: `coder`, `reviewer`, `tester`, `planner`, `researcher`
**Architecture**: `system-architect`, `backend-dev`, `mobile-dev`
**Security**: `security-architect`, `security-auditor`
**Performance**: `performance-engineer`, `perf-analyzer`
**Coordination**: `hierarchical-coordinator`, `mesh-coordinator`, `adaptive-coordinator`
**GitHub**: `pr-manager`, `code-review-swarm`, `issue-tracker`, `release-manager`

Any string works as a custom agent type.

## Build & Test

- ALWAYS run tests after code changes
- ALWAYS verify build succeeds before committing

```bash
npm run build && npm test
```

## CLI Quick Reference

```bash
ruflo init --wizard           # Setup
ruflo swarm init --v3-mode     # Start swarm
ruflo memory search --query "" # Vector search
ruflo hooks route --task ""    # Route to agent
ruflo doctor --fix             # Diagnostics
ruflo security scan            # Security scan
ruflo performance benchmark    # Benchmarks
```

37 commands, 140+ subcommands. Use `--help` on any command for details.

## Setup

```bash
claude mcp add claude-flow -- ruflo mcp start
ruflo daemon start
ruflo doctor --fix
```

**Agent tool** handles execution (agents, files, code, git). **MCP tools** handle coordination (swarm, memory, hooks). **CLI** is the same via Bash.


## Runtime (operational facts)

- This kit is invoked through the `bin/ruflo-kit` dispatcher against a target codebase path (`bin/ruflo-kit <command> <target>`, default target `$(pwd)`). The kit clone is `KIT_DIR`; the path you pass is `TARGET_DIR`. See `README.md` for the command table.
- **Setup + proof are the entry point (SETUP-V1/PROOF-V1, Patch 59):** `ruflo-kit setup <target>` takes a fresh machine to a proved stack (prereqs → global installs → init → sync → opt-in brain KB → proof); its exit code IS the proof verdict, and it NEVER starts the daemon. `ruflo-kit proof <target>` = **16** disk-evidence probes run twice (pass 2 under `env -i`), incl. P14 daemon-gates, P15 statusline-truth (renders the TARGET's INSTALLED `.claude/helpers/statusline.cjs` — the kit's own asset is used only as a fresh-target fallback when nothing is installed yet, Patch 71 F6 fix — and cross-checks its `--json` against an independent sqlite recount), and P16 memory-roundtrip (MEMORY-ROUNDTRIP-V1: a real `ruflo memory` store → retrieve → **independent on-disk read** → purge inside a disposable tmp dir — catches a store whose CLI echoes a value back from a side channel while the actual write to disk silently no-ops, a drift class none of the other 15 probes see; the independent read is mandatory for PASS, so a host with neither the sqlite3 CLI nor a loadable better-sqlite3 FAILs the round trip too, not just when `ruflo` itself is entirely absent (fixed, B19); FAILs, not WARNs, in both cases, since ruflo-absent already hard-FAILs P1); `PROVED` only when both passes agree FAIL-free AND no probe's WARN escalates (P2/P3/P12 mark a WARN `[noresp-timeout]` whenever a REGISTERED component never proved a working handshake — no answer OR not even spawnable, e.g. ENOENT from a stale `.mcp.json` path after an nvm root switch; absent-by-design and benign-empty results are never marked; if the SAME probe carries that marker on BOTH passes — verdict+marker match, not verbatim detail text — it escalates to FAIL, because a persistent no-answer/no-spawn is not first-run warmup, Patch 71 F3 fix, round 2 closed P3's remaining spawn-failure gap). A store held by a LIVE writer (e.g. the session's aqe-mcp) is a WARN "not assessable", never a FAIL. A FRESH target with no session history yet grades "primed", not hollow (Patch 63): learning-HOLLOW fires only against real evidence — eligible `captured_experiences` rows unharvested, or ≥1 session record with the LoRA adapter never applied. Kit verbs pin `AQE_PROJECT_ROOT=<target>` unconditionally (AQE-ROOT-INHERIT-GUARD-V1, Patch 62) — an inherited pin from the caller's shell poisoned fresh-target `aqe init`; pin it yourself for direct `aqe` calls against another project.
- **Porcelain first:** bare `ruflo-kit` prints one-screen status hints; `ruflo-kit status <target> [--json]` is the disk-derived truth (versions, sentinels n/N, daemon via pgrep, MCP servers + brain KB version, learning stores — never MCP self-reports; `--json` is always valid JSON); `ruflo-kit sync <target> [--dry-run]` is the one-verb heal (fix-ruflo → fix-aqe → fix-statusbar → fix-brain → verify-learning).
- **Current globals (2026-08-03): ruflo v3.34.0, agentic-qe v3.13.5 — and globals are PER-HOST npm roots** (this macOS/nvm root: brain KB v3.3.1; the Linux host was last seen at agentic-qe 3.13.1, brain KB v3.9.18-dev — re-read it there, never assume). **aqe 3.13.5 resolves two of the six issues the kit filed** (agentic-qe#585 `computeBatchEmbeddings` now applies the same `isNonSemanticText` guard as the single path, preserving order and skipping the provider for all-nonsemantic batches; #586 `HNSWIndex.js` now takes `createRequire(import.meta.url)` so the unbundled ESM tree imports without `ReferenceError`). Both verified behaviourally on this host, not by reading the changelog. **Neither changes kit behaviour and neither retires a stopgap** — `tools/aqe-embed-sweep.cjs` and `tools/aqe-harvest.cjs` both use the SINGLE `computeRealEmbedding`, and the kit never imports the ESM HNSW tree. The consequence to remember is a latent one: the kit's tools treat an all-zero vector as "non-semantic, terminal", and before 3.13.5 switching them to the batch API would have silently produced DENSE vectors for that same text. **Still open, and still why `proof` FAILs here: agentic-qe#581** (capture hooks lose every embedding), plus #582/#583/#584 and ruflo#2895. Upgrading aqe wipes all kit dist patches — re-run `bin/ruflo-kit sync <target>` (verified: 3.13.3 → 3.13.5 wiped AQE-PROMOTE-V1, AQE-DREAM-LOCKFIX-V2 and AQE-DREAM-MINCONCEPTS-V1, and sync re-landed all of them with zero anchor drift; the top-level `@huggingface/transformers` install survived, which is exactly why it is top-level). (3.33.0 arrived via fix-ruflo Step 1's auto-upgrade during self-application; upstream #2864 restructured Router B and wiped the ROUTE-EXPLORE anchor — Patch 70's dual-anchor patcher re-landed it, proof PROVED 15/15 x2. Earlier 3.32.9 bump, upgraded live under a running harness: snapshot → `kit_npm_global_install` → `sync` → background-daemon restart — open Claude sessions keep serving the pre-upgrade dist in their resident MCP servers until restarted, which is expected; fresh hook subprocesses pick up the new dist immediately. On this bump the patched nested `@claude-flow/cli` tree survived the parent install untouched — fix-ruflo truthfully reported 0 changes with all 5 sentinels verified present by direct grep; fix-aqe re-anchored with 7 changes. Earlier drift note: aqe 3.12.2→3.13.0 moved the dream-lockfix chunk hash `XNNYHQLW → J3L52EA4`, adoption-verified on the Rust workflow-platform target, Patch 65. `sqlite3` CLI is a real probe prerequisite on Linux hosts — see Patch 65c.) The claude-flow MCP server launches from the GLOBAL `ruflo` binary (`.mcp.json` → `command: "ruflo"`), NOT `npx -y ruflo@latest` — npx reconciles its cache on every call and would revert the AgentDB pin below. Upgrades: `npm i -g ruflo` then `bin/ruflo-kit upgrade <target>`. Global installs go through `kit_npm_global_install` (common.sh) — it auto-handles npm ≥11.17's `--allow-scripts` requirement via a dual-gated probe (NPM-ALLOW-SCRIPTS-V1).
- **AgentDB is a THREE-slot layout (Patch 52)**: ruflo hoists the upstream agentdb floor to `ruflo/node_modules/agentdb` (alpha.17 removed 8 controller classes; the exact hoisted version is upstream's to move — alpha.18 as of 3.32.8 — the kit asserts a FLOOR `KIT_AGENTDB_HOISTED_MIN`, never equality); fix-ruflo Step 3b keeps `3.0.0-alpha.10` (`KIT_AGENTDB_PIN`) as a **nested shadow** at `@claude-flow/memory/node_modules/agentdb` (Node resolves nearest-first, so the memory layer gets the full 23+-controller surface); the **standalone** global `agentdb` (its own MCP server in `.mcp.json`) is also alpha.10. `ruflo-kit status` reports all three; do not "fix" the hoisted/nested mismatch — it is deliberate.
- **ruvnet-brain is MCP-only (BRAIN-MCP-V1 Patch 53, BRAIN-KB-REFRESH-V1 Patch 57)**: `.mcp.json` server `ruvnet-brain` exposes the `search_ruvnet` tool (source-grounded answers over 50+ rUv repos; Ed25519-verified GB-class KB at `~/.cache/ruvnet-brain/kb`, currently v3.3.1). Deliberately NO hooks, NO launchd, NO plugin install — zero always-on cost. Manage via `bin/ruflo-kit fix-brain <target> [--download|--refresh]`; every run reports installed-vs-released freshness (offline-safe); the installed identity lives in `$KB_DIR/.release-tag` (the bundle's inner package.json lags the release tag).
- **The background daemon is OPT-IN and BILLED** (Patch 50 + AQE-DAEMON-AUTOSTART-OFF-V1 + DAEMON-AUTOSTART-3-V1). It spawns `claude --print` LLM calls 24/7 detached to `launchd`. THREE gates now hold it off: `RUFLO_DAEMON_MODE` (`off` default / `auto` / `once`) for the kit's own start sites, `.agentic-qe/config.yaml daemonAutoStart: false` for aqe paths, AND `claude-flow.config.json {"daemon":{"autostart":false}}` + the statusline's `RUFLO_DAEMON_AUTOSTART=0` env pin — because **ruflo ≥3.32 auto-spawns a daemon on EVERY CLI invocation** (`services/daemon-autostart.js`; the 5s statusline refresh manufactured 12 daemons before it was gated — Patch 60). Upstream paths (`ruflo doctor --fix`, aqe session hooks) resurrected the daemon repeatedly before these pins. Upstream ruflo ≥3.27 adds its own budget governance (#2661: opt-in AI workers, global ledger, circuit breaker) — treat it as defense-in-depth, not a reason to relax the pins. If you `ruflo daemon start`, you own `ruflo daemon stop`; trust `pgrep`, never daemon state files. Details: `docs/OPERATIONS.md` §A8.
- **The statusline is evidence-backed with ONE canonical source (TRUTH-STATUSLINE-V1, Patch 61):** every rendered chip re-derives from a disk artifact — stored episodes/patterns (never the free-running SONA counters), the real swarm registry (`.claude-flow/swarm/swarm-state.json`), measured indexed-vector counts (no `Nx` speedup claims), regex-counted test cases, store-liveness. **`assets/statusline.cjs` is the single canonical source** — edit IT, then run `bin/ruflo-kit fix-statusbar <target>` to install; NEVER edit `.claude/helpers/statusline.cjs` directly (sha256-verified on install, drift fails `tests/statusline-canonical.test.js`, and upstream session hooks can regenerate the installed copy anyway). Per-number evidence: the 2026-07-18 statusline evidence audit (local session doc — gitignored and purged from history on 2026-08-06, so it is not in a clone).
- **The OTHER `.claude/helpers/*` are ruflo's, and the vendored copies are FALLBACKS, not sources of truth (HELPER-SEED-UPSTREAM-V1, Patch 76).** `assets/claude-helpers/` holds seeds installed ONLY when a target is missing the file — never overwriting an upstream-generated one. **Do NOT bulk-refresh them from upstream.** Two rules, both learned the hard way: (1) `hook-handler.cjs`'s vendored copy carries `HOOK-BLOCK-EXIT2-V1` (the dangerous-command block) and **upstream's copy does not** — refreshing it silently deletes the block; (2) every seeded helper except `intelligence.cjs` is pinned by a kit test asserting the KIT's curated copy (`router.js`→`router.test.js`, `session.js`→`session{,-memory}.test.js`, `statusline.js`→`statusline-js.test.js`, …), so upstream is NOT authoritative for them — seeding eight of them from upstream fixed one suite and broke four. `intelligence.cjs` is the lone exception, seeded from the installed ruflo (`$(npm root -g)/ruflo/node_modules/@claude-flow/cli/.claude/helpers`) because its three suites need `resolveProjectRoot`, which only upstream defines; the vendored fossil predated it and broke every CI run while passing locally. The rule a test now enforces: a helper may seed from upstream ONLY if no kit test reads the kit's copy of it.
- **A green local suite is NOT evidence about CI for anything reading `.claude/helpers/*`, gitignored paths, or git history (Patch 77).** A dev box has upstream-generated helpers, gitignored directories, and dangling git objects that no fresh checkout has; the suite passed 100/100 here while 8 tests failed on the runners. Reproduce with a tracked-files-only clone — `git clone --depth 1 file://$PWD` for the history case, a full `git clone` plus `bash lib/fix-aqe.sh <clone>` for the helper case — which reproduced every one of those failures exactly. Corollary for writing tests: never assert that a gitignored path exists, that a hardcoded commit hash resolves (derive it from `git rev-parse HEAD`), or that a host can stage a scenario (skip as not-assessable instead — `sqlite3`'s WAL `-readonly` behaviour differs between this Mac and the runners).
- **The SONA learning loop is KIT-patched, not upstream (x2-verified 2026-07-19, Patch 64):** upstream's JS LoRAAdapter never trains on its own — the closed loop (train at `endTrajectory`, consume at route time) exists ONLY via the `SONA-TRAIN-V1` + `RUFLO-LORA-ADAPT-V1` dist patches; a ruflo bump that drops either sentinel silently reverts the JS arm to write-only. verify-learning probe #11 (`SEAM-SENTINEL-V1`) greps the installed dist for both sentinels and FAILs the loop verdict (→ proof P10 FAIL) on loss. Related honesty facts: surfaced `avgLoss` is an inference **adaptation norm**, not a training loss (`AVGLOSS-HONESTY-V1` adds the honest `avgAdaptationNorm` sibling); SONA-internal embeddings are a 384-dim FNV-1a hash proxy, not MiniLM; the native `@ruvector/sona` arm has `exportLoraState` but no import — session-ephemeral by upstream limitation (trajectories read 0 each session by design, NOT evidence of non-learning; durable proof is `.swarm/lora-weights.json` B≠0). Open question is EFFECTIVENESS (Gate #4): paired improvement-eval series running (`node tools/improvement-eval.cjs` each session; if trained ≤ control after ≥3 sessions, disable the consumption seam, keep training).
- **Self-retiring patches**: prefer `defect_gate <file> <pattern>` (common.sh) over version comparisons when gating a dist patch — patch only when the literal bug is confirmed in the installed dist, so stopgaps retire themselves when upstream fixes land (Patch 54; NEURAL-CKPT-V1 already retired this way via #2549).
- Full rationale: `docs/_INSTRUCTIONS.md` (Patches 17–19 launch/pin history; 50 daemon; 52–54 vendor-sync/brain/adoptions; 55 dual learning loop; 56–59 setup/proof + CI truthfulness; 60–61 daemon channel #3 + statusline truth; 62–63 fresh-target e2e: root-inherit guard + primed-vs-hollow proof semantics; 64 SONA drift-audit hardening: seam sentinels + avgLoss honesty + canonical-test clobber immunity; 65 first memory-preserving adoption e2e: multi-language statusline truth + npm-root resolution + honest P13 instrument-failure; 66 adoption-hardening suite: adopt/snapshot verbs + sqlite shim + lora prime + stale-dist tripwire + adoption note + dry-run truth + npm-root sweep + forensics; 67 capture-inflow liveness: a --force re-init can kill the aqe capture hooks with every instrument staying green — verify-learning #12 FAILs on hook-origin rows + no hook wired (middleware-only pools WARN), status renders/exports `captureInflowWired`, adopt gains the A4 parity check; 68 self-healing statusline: upstream's delayed detached child rewrites statusline.cjs with the stock fake-counter bar minutes after session start — the guard runs FIRST in the statusLine command each ~5s tick, restores from the pristine `.statusline.canonical.cjs` dotfile snapshot, logs each restore to `.claude-flow/statusline-guard.log`; 69 skill-plugin manifest normalization: skills.sh-installed skill folders carry an npm-shaped `repository` OBJECT that Claude Code's plugin schema rejects (whole skill fails to load) — fix-ruflo Step 5k sweeps the four plugin roots and rewrites object→url string, transient/absent folders read NOFILES=healthy, self-retires when upstream ships a valid manifest; 70 self-application drift + harvest embed-at-consumption: ruflo 3.33.0 #2864 restructured Router B (still deterministic) and wiped the ROUTE-EXPLORE anchor — fix-ruflo now carries a DUAL anchor (≥3.33 ELIG first with upstream's eligibility predicate replicated in the explore scan, ≤3.32 LEGACY fallback, same sentinel), and HARVEST-EMBED-V1 derives vectors for embedding-NULL rows at harvest with the exact upstream recipe — the capture paths embed async-after and the freshest rows lose that race, so ledger consumption was a permanent Sink-A train-never; summary gains `trainedEmbeddedAtHarvest`, source db stays read-only); 71 proof-truth hardening (gauntlet 2026-07-31 audit F3/F5/F6): P15 renders the target's INSTALLED statusline instead of the kit's own asset (previously a proxy artifact — installed drift with a hardcoded/faked number was invisible); P2/P3/P12 tag a genuine "invoked, no answer within timeout" WARN with `[noresp-timeout]`, and the x2 driver escalates that exact marked WARN to FAILED when the same probe carries verdict WARN **and** the marker on both passes (the free-text remainder of the detail may differ — the code is stricter than "repeats identically") (a stable WARN was previously tolerated forever, indistinguishable from a permanently wedged MCP server); P9 drives `HOOK-BLOCK-EXIT2-V1` behaviorally (a real `pre-bash` invocation, dangerous-command payload, asserted exit 2) instead of trusting a sentinel-string grep, catching both a reverted patch and a sentinel that survives in unreachable code; P9 also asserts, for every installed ruvector `bin/mcp-server.js` copy (`RUVECTOR-EXECSAFE-V1`, same global-root discovery fix-ruflo's patcher uses), that zero shell-interpolated `execSync(` calls remain — a property check, never a sentinel grep, so a stray patch-marker comment on an otherwise-still-vulnerable copy still FAILs; zero copies installed is healthy, never a FAIL; 78–80 scaffold-drift remediation + plugin vendoring: Step 5l `DEAD-REMAP-CLASSIFICATION-V1` (double-audited delete/remap/flag sweep of the `ruflo init` scaffold's dead command docs — disputed files are surfaced in a report, never guessed), Step 5m `PLUGIN-NS-ADVISORY-V1` (marketplace plugins call tools under `mcp__plugin_<plugin>_<server>__*`, a namespace that only resolves with the unpinned ruflo-core plugin installed — advisory report maps them to the live `mcp__claude-flow__*` equivalents; greps the GENERIC namespace, refs use the server-providing plugin's name, not the enabled plugin's own), Step 5n `PLUGIN-VENDOR-V1` (opt-in `--vendor-plugins`: vendors namespace-corrected plugin copies into the target's own `.claude/` — 25-suffix verified allowlist rewritten, everything else FLAGged, frontmatter/shebang-safe provenance headers, sha+version idempotency manifest — plus a SessionStart drift sentinel instead of a watcher, keeping the daemon-off posture). Run `bin/ruflo-kit status <target>` for a quick check or `bin/ruflo-kit session <target>` for the full per-session verify.


## Agentic QE v3

This project uses **Agentic QE v3** - a Domain-Driven Quality Engineering platform with 13 bounded contexts, ReasoningBank learning, HNSW vector search, and Agent Teams coordination (ADR-064).

---

### CRITICAL POLICIES

#### Integrity Rule (ABSOLUTE)
- NO shortcuts, fake data, or false claims
- ALWAYS implement properly, verify before claiming success
- ALWAYS use real database queries for integration tests
- ALWAYS run actual tests, not assume they pass

**We value the quality we deliver to our users.**

#### Test Execution
- NEVER run `npm test` without `--run` flag (watch mode risk)
- Use: `npm test -- --run`, `npm run test:unit`, `npm run test:integration` when available

#### Data Protection
- NEVER run `rm -f` on `.agentic-qe/` or `*.db` files without confirmation
- ALWAYS backup before database operations

#### Git Operations
- NEVER auto-commit/push without explicit user request
- ALWAYS wait for user confirmation before git operations

---

### Quick Reference

```bash
# Run tests
npm test -- --run

# Check quality
aqe quality assess

# Generate tests
aqe test generate <file>

# Coverage analysis
aqe coverage <path>
```

### Using AQE MCP Tools

AQE exposes tools via MCP with the `mcp__agentic-qe__` prefix. You MUST call `fleet_init` before any other tool.

#### 1. Initialize the Fleet (required first step)

```typescript
mcp__agentic-qe__fleet_init({
  topology: "hierarchical",
  maxAgents: 15,
  memoryBackend: "hybrid"
})
```

#### 2. Generate Tests

```typescript
mcp__agentic-qe__test_generate_enhanced({
  targetPath: "src/services/auth.ts",
  framework: "vitest",
  strategy: "boundary-value"
})
```

#### 3. Analyze Coverage

```typescript
mcp__agentic-qe__coverage_analyze_sublinear({
  paths: ["src/"],
  threshold: 80
})
```

#### 4. Assess Quality

```typescript
mcp__agentic-qe__quality_assess({
  scope: "full",
  includeMetrics: true
})
```

#### 5. Store and Query Patterns (with learning persistence)

```typescript
// Store a learned pattern
mcp__agentic-qe__memory_store({
  key: "patterns/coverage-gap/{timestamp}",
  namespace: "learning",
  value: {
    pattern: "...",
    confidence: 0.95,
    type: "coverage-gap",
    metadata: { /* domain-specific */ }
  },
  persist: true
})

// Query stored patterns
mcp__agentic-qe__memory_query({
  pattern: "patterns/*",
  namespace: "learning",
  limit: 10
})
```

#### 6. Orchestrate Multi-Agent Tasks

```typescript
mcp__agentic-qe__task_orchestrate({
  task: "Full quality assessment of auth module",
  domains: ["test-generation", "coverage-analysis", "security-compliance"],
  parallel: true
})
```

### MCP Tool Reference

| Tool | Description |
|------|-------------|
| `fleet_init` | Initialize QE fleet (MUST call first) |
| `fleet_status` | Get fleet health and agent status |
| `agent_spawn` | Spawn specialized QE agent |
| `test_generate_enhanced` | AI-powered test generation |
| `test_execute_parallel` | Parallel test execution with retry |
| `task_orchestrate` | Orchestrate multi-agent QE tasks |
| `coverage_analyze_sublinear` | O(log n) coverage analysis |
| `quality_assess` | Quality gate evaluation |
| `memory_store` | Store patterns with namespace + persist |
| `memory_query` | Query patterns by namespace/pattern |
| `security_scan_comprehensive` | SAST/DAST scanning |

### Configuration

- **Enabled Domains**: test-generation, test-execution, coverage-analysis, quality-assessment, defect-intelligence, requirements-validation (+7 more)
- **Learning**: Enabled (transformer embeddings)
- **Max Concurrent Agents**: 5
- **Background Workers**: pattern-consolidator

### V3 QE Agents

QE agents are in `.claude/agents/v3/`. Use with Task tool:

```javascript
Task({ prompt: "Generate tests", subagent_type: "qe-test-architect", run_in_background: true })
Task({ prompt: "Find coverage gaps", subagent_type: "qe-coverage-specialist", run_in_background: true })
Task({ prompt: "Security audit", subagent_type: "qe-security-scanner", run_in_background: true })
```

### Data Storage

- **Memory Backend**: `.agentic-qe/memory.db` (SQLite)
- **Configuration**: `.agentic-qe/config.yaml`

---
*Generated by AQE v3 init - 2026-05-28T10:52:44.449Z*

<!-- KIT-ADOPTION-NOTE-V1 -->
## Kit-managed target (ruflo-aqe-kit)

This project is adopted by the ruflo-aqe-kit at `/Users/cm/THE_AI/osam-fullstack-codebase`. This block is kit-managed — edits between the markers are re-asserted by `fix-ruflo`.

- Heal/check (run from the kit clone): `bin/ruflo-kit sync <target>` (one-verb heal) · `bin/ruflo-kit status <target>` (disk-derived truth) · `bin/ruflo-kit proof <target>` (evidence-probe verdict) · `bin/ruflo-kit dashboard <target>` (browser triage: what is wrong + the command that fixes it).
- Deliberate states — do NOT "fix" these (the dashboard marks each of these "by design"):
  - **AgentDB shadow pin**: the hoisted `ruflo/node_modules/agentdb` floor and the nested `@claude-flow/memory/node_modules/agentdb` pin (`3.0.0-alpha.10`) are MEANT to differ (nearest-first resolution gives the memory layer the full controller surface).
  - **MCP launch**: the claude-flow MCP server launches from the GLOBAL `ruflo` binary (`.mcp.json` -> `command: "ruflo"`), never `npx` — npx cache reconciliation would revert the AgentDB pin.
  - **Daemon autostart is pinned OFF in 3 channels** (`RUFLO_DAEMON_MODE` default off; `.agentic-qe/config.yaml daemonAutoStart: false`; `claude-flow.config.json {"daemon":{"autostart":false}}`). An explicit `ruflo daemon start` is the opt-in — and then you own `ruflo daemon stop`.
- Rule: re-run `ruflo-kit sync <target>` after ANY `npm i -g ruflo` or `npm i -g agentic-qe`.
<!-- /KIT-ADOPTION-NOTE-V1 -->
