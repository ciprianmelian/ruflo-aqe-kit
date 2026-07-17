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
- **Porcelain first:** bare `ruflo-kit` prints one-screen status hints; `ruflo-kit status <target> [--json]` is the disk-derived truth (versions, sentinels n/N, daemon via pgrep, MCP servers, learning stores — never MCP self-reports; `--json` is always valid JSON); `ruflo-kit sync <target> [--dry-run]` is the one-verb heal (fix-ruflo → fix-aqe → fix-statusbar → fix-brain → verify-learning).
- **Current globals (2026-07-17): ruflo v3.32.2, agentic-qe 3.12.2.** The claude-flow MCP server launches from the GLOBAL `ruflo` binary (`.mcp.json` → `command: "ruflo"`), NOT `npx -y ruflo@latest` — npx reconciles its cache on every call and would revert the AgentDB pin below. Upgrades: `npm i -g ruflo` then `bin/ruflo-kit upgrade <target>`.
- **AgentDB is a THREE-slot layout (Patch 52)**: ruflo 3.32.2 hoists `agentdb@3.0.0-alpha.17` to `ruflo/node_modules/agentdb` (upstream floor — alpha.17 permanently REMOVED 8 controller classes); fix-ruflo Step 3b keeps `3.0.0-alpha.10` as a **nested shadow** at `@claude-flow/memory/node_modules/agentdb` (Node resolves nearest-first, so the memory layer gets the full 23-controller surface while everything else sees alpha.17); the **standalone** global `agentdb` (its own MCP server in `.mcp.json`, direct attention/reflexion/skills/causal tools) is also alpha.10. `ruflo-kit status` reports all three; do not "fix" the hoisted/nested mismatch — it is deliberate.
- **ruvnet-brain is MCP-only (BRAIN-MCP-V1, Patch 53)**: `.mcp.json` server `ruvnet-brain` exposes the `search_ruvnet` tool (source-grounded answers over ~53 rUv repos; Ed25519-verified KB ≈736 MB download → ≈1.7 GB at `~/.cache/ruvnet-brain/kb`). Deliberately NO hooks, NO launchd, NO plugin install — zero always-on cost. Manage via `bin/ruflo-kit fix-brain <target> [--download]`.
- **The background daemon is OPT-IN and BILLED** (Patch 50 + AQE-DAEMON-AUTOSTART-OFF-V1). It spawns `claude --print` LLM calls 24/7 detached to `launchd`. Two gates now hold it off: `RUFLO_DAEMON_MODE` (`off` default / `auto` / `once`) for the kit's own start sites, AND `.agentic-qe/config.yaml daemonAutoStart: false` — upstream paths (`ruflo doctor --fix`, aqe session hooks) honor that config value and resurrected the daemon repeatedly before it was pinned. Upstream ruflo ≥3.27 adds its own budget governance (#2661: opt-in AI workers, global ledger, circuit breaker) — treat it as defense-in-depth, not a reason to relax the pins. If you `ruflo daemon start`, you own `ruflo daemon stop`; trust `pgrep`, never daemon state files. Details: `docs/OPERATIONS.md` §A8.
- **Self-retiring patches**: prefer `defect_gate <file> <pattern>` (common.sh) over version comparisons when gating a dist patch — patch only when the literal bug is confirmed in the installed dist, so stopgaps retire themselves when upstream fixes land (Patch 54; NEURAL-CKPT-V1 already retired this way via #2549).
- Full rationale: `docs/_INSTRUCTIONS.md` (Patches 17–19 launch/pin history; 50 daemon; 52–54 vendor-sync/brain/adoptions). Run `bin/ruflo-kit status <target>` for a quick check or `bin/ruflo-kit session <target>` for the full per-session verify.


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
