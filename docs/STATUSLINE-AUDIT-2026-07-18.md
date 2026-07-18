# Statusline Evidence Audit — 2026-07-18

Every number in every row of the live statusline, traced to its producing code path and
verified against ground truth on disk — never against the statusline's own claims. Conducted
by a 4-worker hierarchical-mesh swarm (rows split by domain), lead-verified spot checks,
strictly read-only (`sqlite3 -readonly`, `stat`, one-shot CLI reads under `alarm`).

**Snapshot audited** (frozen 2026-07-18T14:43:51Z; live DBs kept drifting by single digits
during the audit — noted where relevant):

```
▊ RuFlo V3.32.7 ● Ciprian Melian │ ⏇ main ?5 │ Opus 4.6 (1M context)
🏗️ Learning [●●●●●] 5/5   ⚡ HNSW 150x
🤖 Swarm ◉ 1/15  👥 Sub 0  🪝 10/10  🔴 CVE 0/0  💾 18MB  🧠 86%
📶 SONA [●●●●○] 1481 traj │ 176 patterns │ Δ 1.43 LoRA
🔬 SI acc 16.7% │ ◇2 rwd │ Q±.55 │ ◈ loop:closed eff:flat
🔧 Architecture ADRs ●0/0 │ Learn ●100% │ Security ●PENDING
📊 AgentDB Vectors ●811 │ Size 2.3MB │ Tests ●47 (~188 cases) │ MCP ●4/4
🗃️ Swarm DB Vectors ●1052⚡ │ Size 10.3MB
🧿 Ruflo Brain KB ●53 repos │ Size 1.5GB │ MCP ●registered │ Reader ●ok
▊ Agentic QE v3 ⏇ main 🎓 28 patterns │ 🧭 541 traj │ 🧬 2170 vec⚡ │ 💾 32.0MB
```

**Verdict legend** — `REAL` displayed == ground truth, reproducible; `DERIVED` computed by a
stated formula (honesty judged per case); `STALE` faithful to a frozen snapshot;
`COSMETIC` hardcoded/invented/measuring something other than what the label implies;
`COUNTER` faithful to its source, but the source is a free-running event counter, not a store.

---

## ⚠ Critical incidental finding: the statusline was silently spawning billed-risk daemons

While grounding the AQE row, the audit found **12 live daemon processes** — one per cwd that
had ever rendered the statusline (this repo, 10 `osam-brainrow-*` test-fixture tmp dirs, the
CI-sim clone, `/var/folders/…/T`). Root cause, read from the installed dist: **ruflo ≥3.32
auto-spawns a detached background daemon on EVERY CLI invocation** except `daemon` itself
(`@claude-flow/cli/dist/src/index.js:179` → `services/daemon-autostart.js`). The statusline
shells out to `ruflo hooks statusline --json` on a **5-second refresh**, making the statusline
itself a daemon-resurrection channel that bypasses both existing kit gates (`RUFLO_DAEMON_MODE`,
`daemonAutoStart:false` — they guard other start-sites). Kill-and-respawn was observed live:
a fresh daemon reappeared within seconds of `pkill`.

**Remediated this session (`DAEMON-AUTOSTART-3-V1`):** (1) project-root
`claude-flow.config.json` `{"daemon":{"autostart":false}}` — the upstream-honored project
opt-out; (2) **all three** statusline copies (`.claude/helpers/statusline.cjs`,
`assets/claude-helpers/statusline.cjs`, `assets/statusline.cjs` — the fix-statusbar source,
caught only because the brain-row tests respawned 4 daemons through it) pin
`RUFLO_DAEMON_AUTOSTART=0` into their child env, gating every exec site including renders
against foreign cwds (test fixtures, CI). Verified: all 12 daemons killed; a full render, a
direct CLI call, and the statusline test suites now spawn **zero**. Upstream bounds (12 h TTL, #2661 opt-in AI workers) made this bounded-risk rather
than runaway-billing, but the policy here is daemon-off, and the statusline violated it 288×/day.
**Follow-up:** fix-ruflo should write the same `claude-flow.config.json` pin on every target
(sentinel proposed: `CF-CONFIG-AUTOSTART-OFF-V1`).

---

## Row-by-row findings

### Header — `RuFlo V3.32.7 │ ⏇ main ?5 │ Opus 4.6 (1M context)`

| Displayed | Verdict | What it really is |
|---|---|---|
| `V3.32.7` | REAL | Live read of the global `ruflo/package.json`; matches installed 3.32.7. |
| `⏇ main ?5` | REAL | Real `git status`: branch main, 5 untracked files (the .mcp.json baks, `.ruvnet-brain/`, two SECURITY_ANALYSIS strays). |
| `Opus 4.6 (1M context)` | **COSMETIC** | A flat string literal in upstream dist (`hooks.js:3494`) — never reads the model id. Actual models used per `~/.claude.json`: `claude-opus-4-8[1m]`, `claude-fable-5`. With stdin (real Claude Code renders) the true model name from stdin wins; the literal shows only in stdin-less invocations. |

### Learning — `[●●●●●] 5/5 ⚡ HNSW 150x`

| Displayed | Verdict | What it really is |
|---|---|---|
| `5/5` domains | **COSMETIC** | Upstream `patternsLearned = floor(memory.db_size_KB / 2)` → bucketed `>=500 → 5`. "5/5 domains complete" literally means "`.swarm/memory.db` is bigger than 1 MB". No domain or completion state is read. |
| `⚡ HNSW 150x` | **COSMETIC** | Kit-side bucket label (`statusline.cjs`): `>10000 vecs → '12500x', >1000 → '150x', else '10x'`. No benchmark exists; 1052 indexed vectors landed in the 150x bucket. The ⚡ itself is defensible (`vector_indexes SUM(total_vectors)=1016 > 0`) — the *magnitude* is fabricated. |

### Swarm — `◉ 1/15  👥 Sub 0  🪝 10/10  🔴 CVE 0/0  💾 18MB  🧠 86%`

| Displayed | Verdict | What it really is |
|---|---|---|
| `◉ 1/15` | **COSMETIC** | Upstream runs `ps aux \| grep -c agentic-flow` minus 1. No swarm registry, no hive-mind state — neither of this session's `swarm_init` ids is involved. Self-inflating: the audit's own grep pushed it to 2. A transient process-name grep. |
| `👥 Sub 0` | REAL (trivially) | Upstream hardcodes subAgents=0. Honest zero. |
| `🪝 10/10` | DERIVED (tautology) | Count of hook **event categories** in `.claude/settings.json` (PreToolUse … Notification = 10), returned as `{enabled:h, total:h}` — the two halves are the same number by construction; can never show 8/10. |
| `🔴 CVE 0/0` | REAL (empty) | `.claude/security-scans` doesn't exist → honest "no scan has ever run". **The documented #2694 fabrication (`totalCves=3` hardcoded) is RETIRED in this dist** — the grep finds nothing. |
| `💾 18MB` | **COSMETIC** | `process.memoryUsage().heapUsed` of the **statusline-rendering CLI process itself**. Says nothing about the project. |
| `🧠 86%` | DERIVED | Kit composite: `55·(1−e^−ΔLoRA) + 30·min(1,traj/500) + 14·min(1,patterns/50)` = 41.8 + 30 + 14 = 85.8 → 86. Recomputes exactly; honest math — but 44 of the 86 points are **saturated** by the inflated SONA counters (below), so the score mostly reflects counter overflow plus the one real term (LoRA magnitude). It deliberately replaces upstream's hardcoded 0.82/0.75 constants. |

### SONA — `[●●●●○] 1481 traj │ 176 patterns │ Δ 1.43 LoRA`

| Displayed | Verdict | What it really is |
|---|---|---|
| `1481 traj` | **COUNTER** | Display == CLI == `stats.json` exactly — but it's a free-running event counter, proven live (1481→1482 between two reads; independently re-confirmed by the lead). **Stored reality:** `.swarm/memory.db` `trajectories`/`trajectory_steps` = **0 rows**; real trajectory-like artifacts: 24 `.swarm` episodes (all reward 0.0) + **810 harvested episodes in `agentdb.db`**. "1481 trajectory-record events fired", not "1481 trajectories stored". |
| `176 patterns` | **COUNTER** | Same counter family (176→177 mid-audit). Real distinct pattern artifacts: 7 (HNSW patterns.json) to 16 (models.json) — e.g. `import-pattern "const fs = require('fs');"`. An order of magnitude below the counter. |
| `Δ 1.43 LoRA` | **REAL** | L1 norm of the trained LoRA B matrix in `.swarm/lora-weights.json`; recomputed independently: Σ\|B\| = 1.42912754… — matches the JSON to 1e-16. **The one fully-trustworthy number in the row.** |
| gauge `[●●●●○]` tier 4 | DERIVED | Correct ladder (`traj ≥ 50,150,350,700,1500`), but keyed on the inflated counter. Built on the 24–810 real episodes it would read tier 0–4 depending on which store you believe. |

Sample of real stored trajectory artifacts (`.swarm/memory.db episodes`, verbatim):

```
id | when_utc            | task                                          | reward | success
1  | 2026-07-17 10:28:44 | ruflo+aqe+agentdb initialized at 2026-05-27_2 | 0.0    | 0
2  | 2026-07-17 10:28:44 | bootstrap seed 1                              | 0.0    | 0
3  | 2026-07-17 10:28:44 | {"filesAnalyzed":12,"totalLines":0,...        | 0.0    | 0
```

(the richer harvested store, `agentdb.db` episodes: 810 rows of real Claude-Code edit events,
2026-05-28 → 2026-07-18, 728 of them under this repo — see AgentDB row below).

### SI — `acc 16.7% │ ◇2 rwd │ Q±.55 │ ◈ loop:closed eff:flat`

**The entire row is a faithful rendering of a bench snapshot frozen on 2026-05-29** (last line
of `selfimprove-history.jsonl`, file untouched for ~7 weeks). Nothing is fabricated — and
nothing is current.

| Displayed | Verdict | What it really is |
|---|---|---|
| `acc 16.7%` | REAL but **STALE** | Routing accuracy 2/12 from the May-29 bench — the **worst** point in the 8-run history; the untrained baseline scored 25% (3/12). Post-training runs scored *worse* than untrained. |
| `◇2 rwd` | REAL but STALE | `rewardDistinct=2` from the same frozen bench (two distinct reward values observed). |
| `Q±.55` | REAL but STALE, mislabeled | `qSpread=0.5477` — a raw spread, not mean±spread as "±" implies. |
| `loop:closed` | DERIVED (honest) | `rewardConstant=false` (distinct rewards > 1) → "closed". Condition verified against the file. |
| `eff:flat` | DERIVED (deliberately honest) | A hardcoded neutral cap that **refuses to claim efficacy** — the row's saving grace: it structurally cannot render the accuracy regression as improvement. |

### Architecture — `ADRs ●0/0 │ Learn ●100% │ Security ●PENDING`

| Displayed | Verdict | What it really is |
|---|---|---|
| `ADRs 0/0` | REAL | None of the 6 scanned ADR dirs exists in this repo; true zero. (`implemented` is set equal to `count` — the chip can only ever show N/N.) |
| `Learn ●100%` | **COSMETIC** | `dddProgress = domainsCompleted/5·100` — the same `.swarm/memory.db`-file-size bucket as "5/5". A restatement of "the DB is > 1 MB". |
| `Security ●PENDING` | REAL (empty) | Same honest no-scan-has-run state as CVE 0/0. |

### JSON-only `v3Progress` — `patternsLearned 5246, sessionsCompleted 524`

| Value | Verdict | What it really is |
|---|---|---|
| `patternsLearned 5246` | **COSMETIC** | Upstream `Math.floor(memory.db_size_KB / 2)`. Reproduced live: 10,500 KB → 5,250 (5,246 at snapshot = db was ~8 KB smaller). Rises on any DB write, including WAL noise. The actual store: 1,029 embedded entries. **Half the file size in KB, masquerading as a pattern count.** |
| `sessionsCompleted 524` | **COSMETIC** | `max(1, floor(patternsLearned/10))` — i.e. db-size ÷ 20. `.claude/sessions` doesn't exist. Not a session count. |

### AgentDB — `Vectors ●811 │ Size 2.3MB │ Tests ●47 (~188 cases) │ MCP ●4/4`

| Displayed | Verdict | What it really is |
|---|---|---|
| `●811` | **REAL** | 811 `episode_embeddings` in `agentdb.db` (all other embedding tables 0). Each is a genuine 1536-byte = 384-dim float32 MiniLM-L6 embedding of a real edit-event episode (810 parent episodes, span 2026-05-28→07-18, 728 under this repo; 1 harmless orphan embedding). |
| `Size 2.3MB` | REAL | db + shm = 2,348 KB, byte-exact. |
| no ⚡ | REAL/honest | No `vector_indexes` table → flat blobs; ⚡ correctly withheld. |
| `Tests ●47` | REAL | 46 `.test.js` + 1 `.test.cjs` — reproduced by re-walking the same roots; reconciles with git. |
| `(~188 cases)` | **DERIVED — misleading** | `testFiles × 4`, a hardcoded multiplier. Real suite: **808** `it()`/`test()` cases (241 describes) — understates 4.3×. The `~` is its only honesty. Should be a real count or dropped. |
| `MCP ●4/4` | REAL (config-only) | 4 servers **declared** in `.mcp.json` (agentic-qe, agentdb, claude-flow, ruvnet-brain) and all 4 in `enabledMcpjsonServers`. Not a liveness check — "configured & not disabled", not "responding". |

### Swarm DB — `Vectors ●1052⚡ │ Size 10.3MB`

| Displayed | Verdict | What it really is |
|---|---|---|
| `●1052` | **REAL** | Exact query sum reproduced: 1,029 `memory_entries` with embeddings (namespaces: **feedback 932** — hook-captured task outcomes — session 72, pretrain 10, patterns 8, default 4, probe 2) + 24 `pattern_embeddings`. Live-drifted +1 during the audit (actively written store). |
| `⚡` | REAL | `vector_indexes SUM(total_vectors)=1016 > 0` (no `hnsw.index` file — the gate's second branch). Honestly lit. |
| `Size 10.3MB` | REAL | db+wal+shm = 10,592 KB at snapshot, byte-exact (drifts with WAL). |

### Ruflo Brain — `KB ●53 repos │ Size 1.5GB │ MCP ●registered │ Reader ●ok`

| Displayed | Verdict | What it really is |
|---|---|---|
| `●53 repos` | REAL | 53 distinct prefixes across 104 `.rvf` shard files in `~/.cache/ruvnet-brain/kb` (KB release **v3.3.1** per `.release-tag`). |
| `Size 1.5GB` | DERIVED/honest | Top-level KB files = 1.47 GB (excludes the reader's `node_modules`, documented in-code); whole-dir `du` = 1.7 GB. |
| `MCP ●registered` / `Reader ●ok` | REAL (static) | `.mcp.json` entry present / `@xenova/transformers` on disk. Presence checks, not liveness. |

### AQE footer — `🎓 28 patterns │ 🧭 541 traj │ 🧬 2170 vec⚡ │ 💾 32.0MB`

| Displayed | Verdict | What it really is |
|---|---|---|
| `🎓 28` | REAL | Raw `qe_patterns` row count at snapshot (29 one minute later — a dream-cycle insight landed at 14:44:54, 63 s after the freeze). The bench filter in the query is currently inert. **Semantics:** mostly seed/captured rows — 27 of 29 have `quality_score=0, usage_count=0`; only one (`general-purpose-general-2026-07`, usage=9, q=0.735) shows real reuse. Domain distribution matches the SessionStart hook line exactly. |
| `🧭 541` | REAL | Unfiltered `qe_trajectories` count (545 live). **Semantics:** thin hook-emission stubs — `agent=general-purpose`, `task=general-purpose:hook-<id>`, `metadata_json` NULL in 541/545, no verdict/reward columns; outcome is a binary success flag (230 ✓ / 315 ✗ ≈ 42%). Real rows, thin substance. |
| `🧬 2170 vec` | REAL sum | Exact: captured_experiences 1,389 + qe_trajectories 541 + vectors 211 + qe_pattern_embeddings 30. All verified 384-dim (1536-byte) — no dimension drift. Note ~25% of "vec" re-counts the traj chip's same 541 rows. |
| `⚡` (on vec) | **COSMETIC** | Lit by `vectors > 0` — unlike the other two rows there is no index behind it: `.agentic-qe/data/hnsw/` is an **empty directory** and memory.db has no `vector_indexes` table. Claims acceleration that isn't there. |
| `💾 32.0MB` | REAL | memory.db 27.66 + wal 4.31 + shm 0.03 = 31.99 MB. Excludes the `.rvf` sidecars (~27.6 MB more; true AQE footprint ≈ 60 MB). |

### Bonus: SessionStart hook line — `Routing confidence: 62% across 808 requests`

`62%` is REAL (`.swarm/model-router-state.json` `avgConfidence 0.6235`). `808 requests` is
**UNVERIFIABLE from disk** — no repo-side file holds that counter (routing-outcomes is a
500-capped rolling window; totalDecisions=21); it comes from the global `aqe` binary's internal
cumulative accounting.

---

## Rollup

**Verdict census across ~40 audited values:** REAL 20 · DERIVED 7 · STALE 4 (the whole SI row) ·
COUNTER 2 (SONA traj/patterns) · COSMETIC 8.

**Trustworthy at face value:** everything on the AgentDB / Swarm DB / Brain rows (byte-exact,
sample-verified), the AQE footer counts (with thin-substance caveats), `Δ 1.43 LoRA`, ADRs 0/0,
CVE 0/0, git chip, version.

**Read with translation:** `🧠 86%` (transparent formula, saturated inputs), `🪝 10/10`
(X/X tautology), `~188 cases` (files×4; real suite is 808), Brain `1.5GB` (content-only).

**Do not trust as labeled:** SONA `1481 traj / 176 patterns` (free-running counters; stored
reality is 24–810 episodes / 7–16 patterns), `⚡ HNSW 150x` and the AQE `⚡` (unbenchmarked /
unbacked), `5/5 domains`+`Learn 100%`+`patternsLearned 5246`+`sessionsCompleted 524` (all one
file-size formula wearing four different costumes), `◉ 1/15` (a `ps|grep`), `💾 18MB` (the
renderer's own heap), the stdin-less model label (hardcoded string).

**Stale:** the SI row — faithful to a 2026-05-29 bench in which trained routing (16.7%) scored
*worse* than untrained (25%); re-run `ruflo-kit bench` to refresh, and note `eff:flat` honestly
refuses to claim improvement.

**Attribution:** every fabricated/cosmetic magnitude except the `150x`/AQE-⚡ labels and the
`×4` test multiplier originates **upstream** (`ruflo hooks statusline --json` / hooks.js /
local-signals.js); the kit's overlays (store counts, brain, hooks, MCP, 🧠 composite, LoRA)
are the audit's best performers. Retired en route: upstream #2694 CVE fabrication is confirmed
gone in 3.32.7.

## Remediations applied this session

1. **`DAEMON-AUTOSTART-3-V1`** — `claude-flow.config.json` autostart pin + `RUFLO_DAEMON_AUTOSTART=0`
   in the statusline's child env (both copies); 12 daemons killed; zero respawn verified.

## Recommended follow-ups (not applied)

1. fix-ruflo sentinel writing the `claude-flow.config.json` daemon pin on every target
   (`CF-CONFIG-AUTOSTART-OFF-V1`) + a proof probe asserting zero `cli.js daemon start` processes.
2. Replace `testFiles × 4` with a real `it()/test()` grep count (cheap, bounded).
3. Replace the `150x` bucket label with the vector count it actually reflects (e.g. `⚡ 1016 indexed`),
   and gate the AQE ⚡ on a real index like the other two rows.
4. SONA row honesty: render stored-artifact counts (episodes/patterns on disk) instead of, or
   alongside, the free-running counters.
5. Refresh the SI bench (≥3 runs, per the improvement-eval gate) so the row stops showing May-29 data.

*Full per-number evidence (queries, samples, line numbers): scratchpad `sl-audit/` worker
reports (w-audit-sona, w-audit-header, w-audit-stores, w-audit-aqe) — archived with this doc's
sources; regenerate any figure with the queries quoted above.*
