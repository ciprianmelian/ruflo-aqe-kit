# Analysis Commands Compliance Report

_Last reviewed: 2026-05-29 (full directory re-scan; supersedes the 2-file 2026-05-28 pass)._

## Overview
Reviewed **all** command files in `.claude/commands/analysis/` for:
- `mcp__claude-flow__*` tools (preferred for in-Claude-Code invocation)
- CLI commands (acceptable as a reference/fallback) — **but see the binary-naming finding below**
- No direct/private implementation calls

> **Scope note:** this report covers the analysis command docs only. The runtime facts it relies on (the `claude-flow` → `ruflo` rename, the global-binary-not-npx rule, the AgentDB `alpha.10` pin) are documented in [`docs/_INSTRUCTIONS.md`](../../../docs/_INSTRUCTIONS.md) (Patch 18) and [`docs/CHEATSHEET.md`](../../../docs/CHEATSHEET.md) §3.

## Files Reviewed

| File | Style | MCP tool used | Status |
|---|---|---|---|
| `token-efficiency.md` | MCP | `mcp__claude-flow__token_usage` | ✅ Compliant |
| `performance-bottlenecks.md` | MCP | `mcp__claude-flow__task_results` | ✅ Compliant |
| `bottleneck-detect.md` | CLI + MCP example | `mcp__claude-flow__bottleneck_detect` (integration section) | ⚠️ Mixed — CLI-first reference; carries `npx claude-flow` examples |
| `performance-report.md` | CLI only | — | ⚠️ CLI reference — `npx claude-flow analysis …`, no MCP form |
| `token-usage.md` | CLI only | — | ⚠️ CLI reference — `npx claude-flow analysis …`, no MCP form |
| `README.md` | Index | — | ⚠️ Stale index — lists 3 of 5 command files |

## Summary

- **Command files**: 5 (+ `README.md` index)
- **Fully MCP-compliant**: 2 (`token-efficiency`, `performance-bottlenecks`)
- **CLI references (mixed or CLI-only)**: 3 (`bottleneck-detect`, `performance-report`, `token-usage`)
- **Index accuracy**: `README.md` is missing `performance-bottlenecks.md` and `token-efficiency.md`

## Key alignment finding — binary naming

Every CLI example in these docs invokes **`npx claude-flow …`**. That is inconsistent with the rest of this project's documentation and with the live runtime:

- `claude-flow` was **renamed to `ruflo`**; the MCP server and CLI both run from the **global `ruflo` binary**, **never `npx`** (npx reconciles its cache on every call and reverts the AgentDB `alpha.10` pin — `_INSTRUCTIONS.md` Patch 18, CHEATSHEET §3/§4).
- So the correct CLI form is `ruflo <command>` (e.g. `ruflo bottleneck detect`, `ruflo analysis performance-report`), not `npx claude-flow <command>`.

The MCP tool IDs (`mcp__claude-flow__*`) remain correct — the MCP **server** is still registered under the id `claude-flow` in `.mcp.json` even though its binary is `ruflo`.

## Recommendations (for a follow-up pass — these command files were NOT modified in this review)

1. **Replace `npx claude-flow` → `ruflo`** in `bottleneck-detect.md`, `performance-report.md`, `token-usage.md` to match the global-binary rule.
2. **Add the `mcp__claude-flow__*` form** alongside the CLI examples in `performance-report.md` and `token-usage.md` (mirroring the pattern in `token-efficiency.md` / `performance-bottlenecks.md`) so each command has a Claude-Code-native invocation.
3. **Refresh `README.md`** to list all 5 command files.

## Compliance patterns enforced (for the 2 compliant files)

1. **MCP tool usage** — calls use the `mcp__claude-flow__*` format
2. **Parameter format** — JSON parameters properly structured
3. **Command context** — original functionality and expected results preserved
4. **Documentation** — clarity and examples maintained

Net: 2 of 5 command files are fully MCP-compliant; the remaining 3 are valid CLI references that should be re-pointed from `npx claude-flow` to the global `ruflo` binary and given MCP equivalents.
