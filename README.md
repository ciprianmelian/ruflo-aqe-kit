# ruflo + Agentic QE v3 — Setup & Repair Kit

A cloneable kit that gets [`ruflo`](https://www.npmjs.com/package/ruflo) (the renamed `claude-flow`) and the standalone [`agentic-qe`](https://www.npmjs.com/package/agentic-qe) plugin into a known-good state inside [Claude Code](https://github.com/anthropics/claude-code) — and keeps them there session to session — for **any** codebase you point it at. It also wires the optional **ruvnet-brain** knowledge base (an MCP-only `search_ruvnet` tool over ~53 rUv-ecosystem repos — no hooks, no background cost) and keeps the whole stack honest with disk-derived `status`, self-retiring dist patches, and a nightly upstream-drift CI probe.

## Quickstart

Install once per machine (clones to `~/.ruflo-kit`, symlinks `ruflo-kit` onto your PATH):

```bash
curl -fsSL https://raw.githubusercontent.com/ciprianmelian/ruflo-aqe-kit/main/install.sh | bash
```

Then point it at any codebase:

```bash
# one time per project (bootstrap)
ruflo-kit init /path/to/your/codebase

# every Claude Code session afterwards
ruflo-kit session /path/to/your/codebase

# day to day: a bare `ruflo-kit` prints one-screen status hints;
# `ruflo-kit sync <target>` is the one-verb heal when something drifted
```

`init` is idempotent: it skips `ruflo init` / `aqe init` if they have already run and only re-applies the patches. Pass `--force` to wipe and re-init, or `--dry-run` to preview without changes.

**Upgrade** the kit with `ruflo-kit self-update` (or re-run the installer); **uninstall** with `curl … | bash -s -- --uninstall`. The installer bundles Apple-Silicon (darwin-arm64) native SONA/GNN builds; other platforms run with upstream fallbacks (the native step skips cleanly).

### Manual / contributor install

Prefer a hand-managed clone? It works identically — just call the dispatcher by path:

```bash
git clone https://github.com/ciprianmelian/ruflo-aqe-kit.git && cd ruflo-aqe-kit
bin/ruflo-kit init /path/to/your/codebase
```

`bin/ruflo-kit` and the global `ruflo-kit` are the same entrypoint; the global form is a PATH symlink the installer creates. `KIT_DIR` resolves through that symlink, so the clone can live anywhere.

## KIT_DIR vs TARGET_DIR

The kit (this clone) is `KIT_DIR` — it holds the dispatcher, the `lib/` implementations, the `assets/`, and the `tools/`. The codebase you operate on is `TARGET_DIR` — a positional path you pass to each command (it defaults to `$(pwd)`). One clone of the kit can set up many target codebases; pass `.` when the target is the current directory.

## Commands

Everything runs through the single `bin/ruflo-kit <command> <target> [flags]` dispatcher:

| Command | Implementation | What it does |
|---|---|---|
| `status <target>` | `lib/status.sh` | One-screen disk-derived truth: versions (3 agentdb slots), dist sentinels n/N, daemon via pgrep, MCP servers + brain KB, learning stores, autostart pin. `--json` is always-valid machine output; bare `ruflo-kit` prints the short hints. Exit 0 always. |
| `sync <target>` | `lib/sync.sh` | One-verb heal: fix-ruflo → fix-aqe → fix-statusbar → fix-brain → verify-learning, with a per-stage summary table. `--dry-run` propagates to every stage; exits non-zero only on a hard fix-stage failure. |
| `init <target>` | `lib/init.sh` | One-shot bootstrap: `ruflo init` → `ruflo memory init` → `agentic-qe init` → `.claude` backfill → fix-ruflo → fix-statusbar → fix-aqe → activation table → seed memory → verify. Flags: `--force`, `--reactivate`, `--dry-run`. |
| `session <target>` | `lib/session-init.sh` | Per-session entry: applies patches, checks MCP + daemon, verifies storage and AgentDB controllers. Run at the start of every Claude Code session. |
| `health <target>` | `lib/health.sh` | Growth-delta monitor: snapshots ~14 metrics, diffs against the previous run, exits non-zero on regression (CI-friendly). Flags: `--reset`, `--dry-run`, `--json`. |
| `fix-ruflo <target>` | `lib/fix-ruflo.sh` | Diagnose + repair the ruflo / claude-flow MCP setup; maintains the AgentDB `alpha.10` **nested shadow** (under `@claude-flow/memory`, shadowing the hoisted upstream floor) + the dist sentinels (SONA train/adapt, re-rank, exploration, real spawn). Flags: `--dry-run`. |
| `fix-aqe <target>` | `lib/fix-aqe.sh` | Re-apply AQE-side dist patches + `.claude` helpers/hooks lost on reinstall (dream-lockfix, promote filter, exit-2 block, daemonAutoStart pin, root pins). Flags: `--dry-run`. |
| `fix-brain <target>` | `lib/fix-brain.sh` | Register the MCP-only `ruvnet-brain` server (tool: `search_ruvnet`) + verify/install its Ed25519-signed KB (≈736 MB download → ≈1.7 GB unpacked). Flags: `--download`, `--dry-run`. No hooks, no launchd. |
| `fix-statusbar <target>` | `lib/fix-statusbar.sh` | Restore the rich ruflo + Agentic QE v3 status line clobbered by `aqe init` (incl. the 🧿 Ruflo Brain row). No flags. |
| `upgrade <target>` | `lib/upgrade.sh` | Upgrade global ruflo, wipe + rehydrate the npx cache, re-run fix-ruflo, then `init --reactivate`. Flags: `--dry-run`. Run AFTER closing the session. |
| `verify-learning <target>` | `lib/verify-learning.sh` | READ-ONLY learning-loop liveness probes (committed rows only, never MCP self-reports); verdict live/partial/hollow, CI exit 1 on hollow. |
| `fix-learning <target>` | `lib/fix-learning.sh` | Populate/unlock the learning loop (extract → consolidate → dream → train → harvest) with lock-retry + persist-assertions. Never starts the daemon. Flags: `--cleanup --confirm`. |
| `dashboard <target>` | `tools/dashboard.cjs` | On-demand **local web dashboard** (DASHBOARD-V1): live status cards + health/bench history at `http://127.0.0.1:7431`. Foreground (Ctrl-C stops), read-only, localhost-only, $0 — never detaches. Flags: `--port N`. |
| `bench <target>` | `tools/selfimprove-bench.cjs` | READ-ONLY routing-improvement instrument. Flags: `--json`, `--quiet`, `--aqe-confidence`. |
| `harvest <target>` | `tools/aqe-harvest.cjs` | Batch-replay AQE experiences into the ruflo substrate (SONA LoRA + AgentDB). |
| *(node)* `tools/improvement-eval.cjs` | — | Gate-#4 proof instrument: multi-seed held-out eval, permutation *p* + Cohen's *d* vs the no-train control, hard 2σ/3-run gate. `--selftest`, `--json`. |
| `version` | `bin/ruflo-kit` | Print the kit git sha + detected global `ruflo` / `agentic-qe` versions. |
| `self-update` | `bin/ruflo-kit` | Fast-forward `git pull` the kit clone (then re-run `fix-ruflo` per Patch 44). |

## Layout

```
install.sh                   one-line installer (clone + PATH symlink); also --uninstall
bin/      ruflo-kit          single entrypoint dispatcher
lib/      *.sh + common.sh   shell implementations (common.sh resolves KIT_DIR vs TARGET_DIR)
assets/   claude-helpers/    hook helpers installed into the target's .claude/helpers/
          claude-commands/   kit-maintained .claude/commands docs
          builds/            prebuilt RuVector native (.node) binaries
tools/    *.cjs              node tools (bench, harvest, improvement-eval)
docs/     narrative docs     deep rationale, cheatsheet, operations, R&D status
tests/    *.test.js          vitest suite (npm test -- --run); guards helpers + patch invariants
.github/  workflows/         CI: shellcheck + nightly upstream-drift probe (real-latest install + heal + health)
```

## Requirements

- macOS (Darwin) or Linux. Windows via WSL.
- Bash (the implementations are `#!/usr/bin/env bash`, not POSIX `sh`).
- Node.js ≥ 18 (recommended ≥ 22) and `npm` reachable on the public registry.
- `ruflo` and `agentic-qe` installed globally (`npm i -g ruflo agentic-qe`), plus the Claude Code CLI (`claude`) on `PATH`. See [docs/_INSTRUCTIONS.md](docs/_INSTRUCTIONS.md) for the full prerequisite and install detail.

## Docs

- [docs/_INSTRUCTIONS.md](docs/_INSTRUCTIONS.md) — deep technical rationale (the Patch-N narrative).
- [docs/CHEATSHEET.md](docs/CHEATSHEET.md) — one-line "what do I run for X" reference.
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — step-by-step workflows + troubleshooting.

---

*Licence: MIT. No warranty. Use on a developer machine; never run blind on production infrastructure.*
