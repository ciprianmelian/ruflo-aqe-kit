# Changelog — 2026-07-17 session

Everything merged to `main` on July 17, 2026 — since the last commit of June 8 (`44629d2`).
Every wave shipped through a double verification loop: author self-check, then an independent
adversarial audit against disk evidence.

**19 commits · 56 files changed · +9,588 lines · 773 tests green (42 files) · 2× verified**

## Stack upgrades — with an evidence-based pin decision

- **ruflo 3.14.1 → 3.32.2** and **agentic-qe 3.10.4 → 3.12.2** (schema migrations
  `qe_trajectories.metadata_json` + `qe_pattern_nulls` applied; trajectories intact).
- **AgentDB is now a deliberate three-slot layout** (Patch 52): upstream hoists `alpha.17`
  (which permanently removed 8 controller classes); the kit keeps `alpha.10` as a **nested
  shadow** at `@claude-flow/memory/node_modules/agentdb` for the memory layer only, and the
  standalone global MCP server stays alpha.10. Decided by a live A/B, not doctrine — and
  confirmed post-restart: **23/23 controllers active**.
- Upstream fixes absorbed: route-feedback persistence (#2222), daemon budget governance
  (#2661), post-task hook args (#508/#509).

## Ruflo Brain — new knowledge layer, zero standing cost

- `BRAIN-MCP-V1` (Patch 53) — the `search_ruvnet` MCP tool: source-grounded answers over
  ~53 rUv-ecosystem repos from a 1.7 GB Ed25519-verified knowledge base (≈736 MB download).
  Deliberately MCP-only: no hooks, no launchd, nothing billed.
- New `fix-brain` verb (download, verify, register, health-probe) and a `🧿 Ruflo Brain`
  statusline row (`BRAIN-STATUSLINE-V1`: repos · size · MCP · reader). MCP chip healed to 4/4.
- Validated live: the first query returned the exact ADR (ADR-055) our pin decision rests on.

## The learning loop: from write-only to closed

- `RUFLO-LORA-ADAPT-V1` (Patch 55) — the trained LoRA was never *consumed* (pacphi F2);
  Router B now adapts its query embedding through the learned weights at route time and
  persists the stats (the route CLI is one-shot).
- Dual-loop architecture documented: AQE consumes learning via the router Q-bonus, ruflo via
  route-time adapt — coupled only by safe batch bridges (dual-train hook, harvest, shared
  reward oracle). No second live writer.
- **Proof, not promise:** one route moved `totalAdaptations` 0→1; the verify-learning verdict
  upgraded **HOLLOW → PARTIAL** with zero failing probes.

## Reliability & integrity fixes

- Baseline turned green: 19 pre-existing helper defects fixed (router pattern precedence,
  session-id collisions, ESM `github-safe` crash under a commonjs root, and the
  dangerous-command block now a *real* block — exit 2, `HOOK-BLOCK-EXIT2-V1`).
- False-success bug in four fix-ruflo dist patchers (a moved anchor logged ✓ while patching
  nothing) — now rc-checked; `NEURAL-CKPT-V1` became the first patch to **self-retire** via
  the new defect gates (#2549 made it moot upstream).
- The billed daemon resurrected itself four times in one session — root-caused to
  `daemonAutoStart: true` honored by upstream paths (`ruflo doctor --fix`, aqe session
  hooks); pinned off (`AQE-DAEMON-AUTOSTART-OFF-V1`) and it stayed down.
- Also: dream-lockfix cli chunk located by code anchor instead of a content-hashed filename
  (`IJ4BUSJN → XNNYHQLW` churn); a NUL byte that inverted a guard in fix-aqe.sh; an
  auto-memory test-isolation leak that wrote into the live memory store.

## New operator tooling

- **Porcelain:** `ruflo-kit status` (disk-derived truth, always-valid `--json`) and
  `ruflo-kit sync` (one-verb heal with per-stage summary). Bare `ruflo-kit` prints instant
  status hints.
- **Dashboard:** `ruflo-kit dashboard` (`DASHBOARD-V1`) — live web view at `127.0.0.1:7431`;
  foreground-only, read-only, localhost-only, $0 by construction.
- **Proof & drift:** `tools/improvement-eval.cjs` (hard 2σ / 3-run gate for the
  self-improvement question) and `.github/workflows/nightly-drift.yml` — installs the *real*
  latest upstream nightly and fails on unhealable drift.
- `dist_defect_present()` / `defect_gate()` in common.sh: patch only when the literal bug is
  confirmed in the installed dist, so stopgaps retire themselves.
- The 42-file vitest suite is now tracked in the repo and gates every change.

## Docs & memory synced

Patches 52–55 written; operator guides aligned with the new reality (OPERATIONS incl. the new
A9 brain runbook, CHEATSHEET, README, CLAUDE.md runtime facts): three-slot pin, dual daemon
gates, porcelain-first workflow.

---

Merged as `155c41e` and pushed to `origin/main`; feature branch deleted.
**Still open:** the cross-session self-improvement proof (instrument ready, needs ≥3 runs) ·
health-parser nit on 3.32.2 `memory stats` output.
