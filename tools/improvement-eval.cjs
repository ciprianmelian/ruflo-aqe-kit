#!/usr/bin/env node
/*
 * improvement-eval.cjs — cross-session ≥2σ self-improvement proof (learning gate #4 / G3).
 *
 * selfimprove-bench.cjs establishes the TREATMENT-arm trend (held-out routing accuracy of
 * the trained router, appended to .claude-flow/selfimprove-history.jsonl). This instrument
 * adds the missing half of the G3 gate (docs/whats-genuinely-left-rnd.md:56-66): a paired
 * NO-TRAIN CONTROL arm, and the between-arm statistics that turn "accuracy went up" into
 * "training CAUSED it, reproducibly". Methodology ported from vendor/agentic-kit's
 * improvement-eval.mjs (permutation test + Cohen's d + a pre-registered, non-relaxable gate).
 *
 * Each run (one session) — BOTH arms route in disposable sandbox cwds with ε=0
 * (deterministic), so neither touches a live store and the ONLY difference between them is
 * the policy they read (COUNTERFACTUAL-BY-STORE, not by env flag — an env flag was inert
 * because `ruflo hooks route` neither trains nor explores by default, so both arms hit the
 * same live policy and Δ was structurally pinned at 0):
 *   • TREATMENT arm — routes against a fresh copy of the CURRENT live policy stores.
 *   • CONTROL arm   — routes against a FROZEN copy of those stores, baselined ONCE into
 *                     .claude-flow/eval-baseline/ and reused unchanged (--rebaseline
 *                     re-freezes and resets the longitudinal series). `ruflo hooks route`
 *                     reads its whole learned policy from cwd-relative stores
 *                     (.claude-flow/routing-outcomes.json → learned patterns + the
 *                     RUFLO-SEMRANK re-rank, .swarm/lora-weights.json + neural checkpoints →
 *                     the route-time LoRA adapt(), .swarm/memory.db → the AgentDB bridge,
 *                     .ruflo-explore-state.json → ε decay), so a frozen-copy cwd IS a frozen
 *                     policy. Both arms score the SAME held-out set + normLabel scorer as
 *                     selfimprove-bench.cjs, so the two instruments stay commensurable.
 *   • As the live policy trains forward across sessions, treatment diverges from the fixed
 *     control; each paired row records both arms' consulted-store sha256 (proof they read
 *     DIFFERENT state) and the baselineId they were measured against.
 *   • Appends one paired row to .claude-flow/improvement-eval-history.jsonl.
 *
 * Verdict (read across sessions from BOTH histories):
 *   between-arm separation (mean_T − mean_C) / SE, one-sided permutation p, Cohen's d.
 *   HARD GATE (pre-registered, do NOT relax — Integrity Rule): IMPROVING requires
 *   ≥3 paired sessions AND ≥2σ between-arm separation AND a FLAT control arm AND mean_T>mean_C.
 *   Anything short of that is UNPROVEN; a trained arm at/below control is NOT-IMPROVING.
 *
 * READ-ONLY wrt every LIVE store — it snapshots (copy, never move) the cwd-relative policy
 * stores into throwaway sandboxes and invokes `ruflo hooks route` (a pure query, like the
 * bench) only inside them; it never writes a live store, and appends only to its own JSONL.
 * Re-runnable and longitudinal: run it each session.
 *
 * Usage:
 *   node tools/improvement-eval.cjs [--seeds N] [--json] [--quiet]
 *   node tools/improvement-eval.cjs --rebaseline            # re-freeze control baseline (resets series)
 *   node tools/improvement-eval.cjs --selftest              # stats self-check, no ruflo calls
 *   node tools/improvement-eval.cjs --history-file <f>      # analyze <f> only (no collection)
 *   node tools/improvement-eval.cjs --bench-history <f>     # override selfimprove-history path
 *   node tools/improvement-eval.cjs --baseline-dir <d>      # override the frozen-baseline dir
 *   node tools/improvement-eval.cjs --preflight             # re-baseline readiness check (no routing)
 * Exit: 0 IMPROVING (or --selftest / --preflight all-pass) · 1 otherwise.
 *
 * MEASUREMENT EPOCH (Wave 4, 2026-07-31 — do not remove): every figure this instrument
 * produced before 2026-07-31 was measured on a stack now known to have been misreporting
 * in two independent ways — (a) better-sqlite3 had no compiled binding under the ruflo
 * agentdb root, so AgentDB (incl. the @claude-flow/neural reasoning-bank path behind SONA
 * training) silently ran on sql.js WASM emulation; (b) ruflo #2786 turned
 * bridgeRecordFeedback from a swallowed no-op into a live recordTrajectory writer, adding
 * an unattributed training path (and a same-turn DOUBLE-write inside hooks_post-task).
 * Pre-line rows are therefore HISTORY, not evidence: they are never deleted, but the gate
 * refuses to blend them with post-line rows (see EPOCH_LINE below), and collection refuses
 * to run against a baseline frozen before the line. "trained ≤ control" readings from
 * before the line are readings of a broken instrument, not of the learning loop.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const CWD = process.cwd();
const EVAL_HIST = val('--history-file', path.join(CWD, '.claude-flow', 'improvement-eval-history.jsonl'));
const BENCH_HIST = val('--bench-history', path.join(CWD, '.claude-flow', 'selfimprove-history.jsonl'));
const SEEDS = Math.max(1, parseInt(val('--seeds', '3'), 10) || 3);
const JSON_OUT = has('--json');
const QUIET = has('--quiet');
const ANALYSIS_ONLY = has('--history-file'); // inject fixtures / re-score without live routing
const REBASELINE = has('--rebaseline');       // deliberately re-freeze the control baseline
const BASELINE_DIR = val('--baseline-dir', path.join(CWD, '.claude-flow', 'eval-baseline'));

// Scorer identity. Bump ONLY when the accuracy DEFINITION changes (task set, label map, hit
// rule) — the cross-session trend is read across like-scorer rows only, so a metric
// redefinition can never masquerade as learning. Matches the bench's norm-v1 label scorer.
const SCORER = 'eval-v1';
// Held-out set scored under norm-v1 → the bench's accuracyPct is directly comparable.
const BENCH_SCORER = 'norm-v1';

// ── Pre-registered gate (HARD-CODED — do not relax) ──────────────────────────
const MIN_RUNS = 3;     // ≥3 paired sessions
const SIGMA_MIN = 2.0;  // ≥2σ between-arm separation ("reproducible to ≥2σ", G3:62)
const FLAT_BAND = 0.05; // control arm counts as flat if its accuracy spread ≤ 5pp

// ── Measurement epoch line (HARD-CODED — see header; do not move backward) ────
// Rows timestamped before this line were measured on the pre-repair instrument
// (WASM-emulated sqlite backend + unattributed #2786 writer) and are excluded from
// the gate arrays — reported as history, never blended. Rows whose ts CANNOT BE
// PLACED against the line (missing or unparseable) are ALSO excluded and reported:
// an unplaceable row admitted to the gate would let the excluded history walk back
// in by stripping timestamps, which defeats the whole property.
//
// WHY 13:00Z and not midnight: the three onsets all happened DURING 2026-07-31 —
// ruflo 3.33.0 (#2786) installed 10:12Z, the better-sqlite3 native rebuild and the
// TRAJ-ATTR-V1 wiring completed before 12:57Z — so a midnight line admitted same-day
// pre-repair measurements (e.g. bench rows from 10:42:10Z) as post-line. 13:00Z is the
// last onset rounded UP to the hour: on this host any row stamped after it ran on
// the repaired, attributed stack. Other hosts must not trust the time at all — they
// prove instrument state directly via --preflight.
const EPOCH_LINE = '2026-07-31T13:00:00Z';
const EPOCH_ID = 'post-repair-2026-07-31';
const EPOCH_REASON = 'pre-line rows were measured on an emulated sqlite backend (missing better-sqlite3 binding under the ruflo agentdb root) and before trajectory-source attribution (#2786 writer live but unmarked)';
const epochOf = (row) => {
  const t = row && row.ts ? Date.parse(row.ts) : NaN;
  if (!Number.isFinite(t)) return 'no-ts';
  return t < Date.parse(EPOCH_LINE) ? 'pre' : 'post';
};
// HONEST LIMIT: manifest.created is self-reported at freeze time and is NOT covered
// by the content-addressed baselineId, so a forward-dated created evades this check.
// Local disk evidence cannot distinguish that from an honest freeze; the guard is
// against the accidental confound (extending a stale series), not a forging operator.
const baselinePreEpoch = (manifest) => {
  const t = manifest && manifest.created ? Date.parse(manifest.created) : NaN;
  return Number.isFinite(t) && t < Date.parse(EPOCH_LINE);
};

// ── Held-out task set (FIXED; reused + extended from selfimprove-bench.cjs) ───
const TASKS = [
  { prompt: 'generate unit tests for the authentication service', expect: 'tester' },
  { prompt: 'write integration tests for the payment module', expect: 'tester' },
  { prompt: 'find coverage gaps in the order pipeline', expect: 'tester' },
  { prompt: 'security review of the login flow for injection flaws', expect: 'reviewer' },
  { prompt: 'review this pull request for code quality and style', expect: 'reviewer' },
  { prompt: 'audit the API surface for breaking changes', expect: 'reviewer' },
  { prompt: 'implement a new REST endpoint for user profiles', expect: 'coder' },
  { prompt: 'fix the null-pointer bug in the shopping cart', expect: 'coder' },
  { prompt: 'add input validation to the signup handler', expect: 'coder' },
  { prompt: 'refactor the data-access layer to remove duplication', expect: 'architect' },
  { prompt: 'design the system architecture for a notification service', expect: 'architect' },
  { prompt: 'research the best caching strategy for session storage', expect: 'researcher' },
  // extensions (still within the bench's label vocabulary):
  { prompt: 'add end-to-end tests covering the checkout happy path', expect: 'tester' },
  { prompt: 'optimize the hot query path in the reporting service', expect: 'coder' },
];
// CONSERVATIVE alias map (identical to the bench): collapse only genuinely-same roles.
const LABEL_EQUIV = {
  'security-architect': 'reviewer', 'security-auditor': 'reviewer', 'code-review-swarm': 'reviewer',
  'qe-test-architect': 'tester', 'qe-coverage-specialist': 'tester',
  'backend-dev': 'coder', 'system-architect': 'architect', 'researcher': 'researcher',
};
const normLabel = (a) => LABEL_EQUIV[a] || a;

// ── Statistics (no external deps; deterministic for small pools) ──────────────
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sampVar = (a) => (a.length < 2 ? 0 : a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1));
const spread = (a) => (a.length ? Math.max(...a) - Math.min(...a) : 0);

// Cohen's d (pooled). Exact: d = (μA−μB)/pooled_sd. Zero pooled variance ⇒ ±∞ (or 0 if equal).
function cohensD(a, b) {
  const sp = Math.sqrt(((a.length - 1) * sampVar(a) + (b.length - 1) * sampVar(b)) / Math.max(1, a.length + b.length - 2));
  if (sp === 0) return mean(a) === mean(b) ? 0 : (mean(a) > mean(b) ? Infinity : -Infinity);
  return (mean(a) - mean(b)) / sp;
}

// One-sided permutation test: P(permuted (μA−μB) ≥ observed). Exact enumeration when the
// pooled set is small (≤14 → deterministic, so crafted fixtures have a known p), else 10k samples.
function* combos(arr, k, start = 0, acc = []) {
  if (acc.length === k) { yield acc; return; }
  for (let i = start; i < arr.length; i++) yield* combos(arr, k, i + 1, acc.concat(arr[i]));
}
function permP(a, b) {
  const obs = mean(a) - mean(b), pool = a.concat(b), n = a.length;
  let ge = 0, total = 0;
  if (pool.length <= 14) {
    const idx = [...pool.keys()];
    for (const c of combos(idx, n)) {
      const set = new Set(c);
      const A = pool.filter((_, i) => set.has(i)), B = pool.filter((_, i) => !set.has(i));
      if (mean(A) - mean(B) >= obs - 1e-12) ge++;
      total++;
    }
  } else {
    total = 10000;
    for (let s = 0; s < total; s++) {
      const sh = pool.slice();
      for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
      if (mean(sh.slice(0, n)) - mean(sh.slice(n)) >= obs - 1e-12) ge++;
    }
  }
  return total ? ge / total : 1;
}

// Between-arm separation in σ units (Welch-style SE of the difference). This IS the "≥2σ" gate.
function sigmaSeparation(t, c) {
  const dMean = mean(t) - mean(c);
  const se = Math.sqrt(sampVar(t) / Math.max(1, t.length) + sampVar(c) / Math.max(1, c.length));
  if (se === 0) return dMean > 0 ? Infinity : (dMean < 0 ? -Infinity : 0);
  return dMean / se;
}

// ── Verdict ladder (pre-registered gate) ─────────────────────────────────────
// t[] / c[] are paired per-session treatment / control accuracies (0..1). controlFlat guards
// against attributing a shared environmental drift to training (G3: control must stay flat).
function verdictOf(t, c) {
  const n = Math.min(t.length, c.length);
  const dMean = mean(t) - mean(c);
  const sigma = sigmaSeparation(t, c);
  const controlFlat = spread(c) <= FLAT_BAND;
  const d = cohensD(t, c);
  const p = n >= 2 ? permP(t, c) : 1;
  let verdict, reason;
  if (n < MIN_RUNS) {
    verdict = 'UNPROVEN';
    reason = `Need ≥${MIN_RUNS} paired sessions under scorer ${SCORER}; have ${n}. Run each session to accrue the control arm.`;
  } else if (dMean <= 0) {
    verdict = 'NOT-IMPROVING';
    reason = `Trained arm is not above the no-train control (Δ=${(dMean * 100).toFixed(1)}pp ≤ 0) across ${n} sessions — training shows no held-out benefit.`;
  } else if (sigma >= SIGMA_MIN && controlFlat) {
    verdict = 'IMPROVING';
    reason = `Trained arm beats the flat no-train control by ${(dMean * 100).toFixed(1)}pp at ${sigma === Infinity ? '∞' : sigma.toFixed(1)}σ (≥${SIGMA_MIN}σ) across ${n} sessions (perm p${p < 0.001 ? '<0.001' : '=' + p.toFixed(3)}, d=${d === Infinity ? '∞' : d.toFixed(2)}).`;
  } else if (!controlFlat) {
    verdict = 'UNPROVEN';
    reason = `Δ=${(dMean * 100).toFixed(1)}pp positive but the control arm is NOT flat (spread ${(spread(c) * 100).toFixed(1)}pp > ${FLAT_BAND * 100}pp) — a shared drift can't be ruled out; the gain is not attributable to training.`;
  } else {
    verdict = 'UNPROVEN';
    reason = `Δ=${(dMean * 100).toFixed(1)}pp positive but only ${sigma === Infinity ? '∞' : sigma.toFixed(1)}σ (<${SIGMA_MIN}σ required) across ${n} sessions — not yet reproducible to the pre-registered bar.`;
  }
  return {
    n, deltaPP: +(dMean * 100).toFixed(2), sigma: sigma === Infinity ? 999 : +sigma.toFixed(2),
    permP: +p.toFixed(4), cohensD: d === Infinity ? 999 : +d.toFixed(2), controlFlat,
    sigmaMin: SIGMA_MIN, minRuns: MIN_RUNS, verdict, reason,
  };
}

// ── Live collection (skipped in analysis-only / selftest) ────────────────────
// ε=0 on BOTH arms → routing is a deterministic function of the cwd policy store, so the
// ONLY between-arm difference is frozen-baseline vs current-live. CLAUDE_FLOW_MEMORY_PATH is
// stripped so it can't redirect the AgentDB store away from the sandbox cwd.
const ARM_ENV = (() => { const e = Object.assign({}, process.env, { RUFLO_ROUTE_EPSILON: '0' }); delete e.CLAUDE_FLOW_MEMORY_PATH; return e; })();
function sh(cmd, cwd) {
  try { return execSync(cmd, { timeout: 20000, env: ARM_ENV, cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); }
  catch (e) { return (e.stdout ? e.stdout.toString() : '') || ''; }
}
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
function routeAgent(prompt, cwd) {
  const out = stripAnsi(sh('ruflo hooks route --task ' + JSON.stringify(prompt), cwd));
  const m = out.match(/Agent:\s*([A-Za-z0-9_-]+)/);
  return m ? m[1] : '(none)';
}
// One arm, `SEEDS` passes over the held-out set, routed in sandbox `cwd`; { acc, seeds:[...] }.
function measureArm(cwd) {
  const perSeed = [];
  for (let s = 0; s < SEEDS; s++) {
    let correct = 0;
    for (const t of TASKS) if (normLabel(routeAgent(t.prompt, cwd)) === normLabel(t.expect)) correct++;
    perSeed.push(correct / TASKS.length);
  }
  return { acc: mean(perSeed), seeds: perSeed };
}
// Instrument fingerprint recorded on every collected row — the confounds the
// 2026-07-31 line exists for, probed at measurement time so a FUTURE drift of any
// of them is visible per-row instead of silently blending into the series. The
// sentinel probes matter most: a mid-series ruflo bump that wipes SONA-TRAIN-V1
// silently reverts the JS arm to write-only, pinning treatment ≡ control — which
// would read as "training has no effect" unless the rows show WHEN the seam died.
// Versions come from package.json reads (no subprocess). Best-effort:
// null = could not assess (recorded as null, never guessed).
function probeInstrument() {
  let bsqliteNativeOk = null, bridge2786 = null;
  let sonaTrainSentinel = null, loraAdaptSentinel = null, rufloVersion = null, aqeVersion = null;
  try {
    const attr = require(path.join(__dirname, 'trajectory-attribution.cjs'));
    const root = attr.resolveNpmRoot();
    bridge2786 = attr.detectBridgeTrajectoryLive(root).live;
    try {
      const dist = path.join(root, 'ruflo', 'node_modules', '@claude-flow', 'cli', 'dist', 'src');
      sonaTrainSentinel = fs.readFileSync(path.join(dist, 'memory', 'intelligence.js'), 'utf8').includes('SONA-TRAIN-V1');
      loraAdaptSentinel = fs.readFileSync(path.join(dist, 'mcp-tools', 'hooks-tools.js'), 'utf8').includes('RUFLO-LORA-ADAPT-V1');
    } catch (e) { /* dist unreadable — sentinels stay null */ }
    try { rufloVersion = JSON.parse(fs.readFileSync(path.join(root, 'ruflo', 'package.json'), 'utf8')).version || null; } catch (e) {}
    try { aqeVersion = JSON.parse(fs.readFileSync(path.join(root, 'agentic-qe', 'package.json'), 'utf8')).version || null; } catch (e) {}
    try {
      // Resolve better-sqlite3 exactly as the ruflo agentdb root would (nearest-first),
      // then prove it can OPEN and ANSWER — a require()-only check cannot tell native
      // from the silent sql.js/WASM fallback this line exists because of.
      const { createRequire } = require('module');
      const req = createRequire(path.join(root, 'ruflo', 'node_modules', 'agentdb', 'noop.js'));
      const Database = req('better-sqlite3');
      const d = new Database(':memory:');
      const ok = d.prepare('SELECT 1 AS ok').get();
      d.close();
      bsqliteNativeOk = !!(ok && ok.ok === 1);
    } catch (e) { bsqliteNativeOk = false; }
  } catch (e) { /* attribution module unavailable — probes stay null */ }
  return { bsqliteNativeOk, bridge2786, sonaTrainSentinel, loraAdaptSentinel, rufloVersion, aqeVersion, nodeVersion: process.version };
}

function collectSession() {
  const manifest = ensureBaseline();                 // freeze once (or --rebaseline)
  // EPOCH GUARD (collection): a baseline frozen before the 2026-07-31 measurement
  // line anchors the whole series to the pre-repair instrument — refuse rather than
  // quietly extend an uncomparable series. --rebaseline is the sanctioned reset.
  if (baselinePreEpoch(manifest)) {
    process.stderr.write('\n\x1b[0;31m✗ REFUSING to collect: the frozen control baseline predates the ' + EPOCH_LINE.slice(0, 10) + ' measurement line.\x1b[0m\n' +
      '    ' + EPOCH_REASON + '.\n' +
      '    Run `node tools/improvement-eval.cjs --rebaseline` to freeze a post-line baseline and restart the series.\n\n');
    process.exit(1);
  }
  const treatSandbox = mkSandbox(CWD, 'treat');       // CURRENT live policy
  const ctrlSandbox = mkSandbox(BASELINE_DIR, 'ctrl'); // FROZEN baseline policy
  let treatment, control, tHash, cHash;
  try {
    // Fingerprint the INPUT policy each arm will consult BEFORE routing — route writes
    // transient state into its cwd (ruvector.db, explore log), which is not policy.
    tHash = hashState(treatSandbox);
    cHash = hashState(ctrlSandbox);
    treatment = measureArm(treatSandbox);
    control = measureArm(ctrlSandbox);
  } finally { rmrf(treatSandbox); rmrf(ctrlSandbox); }
  const row = {
    ts: process.env.EVAL_TS || new Date().toISOString(), scorerVersion: SCORER, seeds: SEEDS, n: TASKS.length,
    treatmentAcc: +treatment.acc.toFixed(4), controlAcc: +control.acc.toFixed(4),
    treatmentSeeds: treatment.seeds, controlSeeds: control.seeds,
    // Provenance: which frozen baseline this pair was measured against, and the content
    // hash of the policy store EACH arm actually consulted (proof the arms read different
    // state as soon as the live policy has trained past the baseline). controlStateHash
    // MUST equal baselineId; stateDiffers flips true once treatment diverges from control.
    baselineId: manifest.baselineId, baselineCreated: manifest.created,
    treatmentStateHash: tHash.hash, controlStateHash: cHash.hash,
    treatmentStateFiles: tHash.files, controlStateFiles: cHash.files,
    stateDiffers: tHash.hash !== cHash.hash,
    // Wave 4 provenance: which measurement epoch this row belongs to, and the
    // instrument state it was taken under (see probeInstrument).
    epoch: EPOCH_ID,
    instrument: probeInstrument(),
  };
  try { fs.mkdirSync(path.dirname(EVAL_HIST), { recursive: true }); fs.appendFileSync(EVAL_HIST, JSON.stringify(row) + '\n'); }
  catch (e) { /* read-only fs — analysis still proceeds on prior rows */ }
  return row;
}

// ── History readers ──────────────────────────────────────────────────────────
function readJsonl(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
// Paired treatment/control arrays from the eval history (same-scorer, both arms numeric).
// When a `baselineId` is given (a live run against a frozen baseline), ONLY rows measured
// against THAT baseline count — the longitudinal series is per-baseline, so a --rebaseline
// (or a row from the pre-frozen-baseline instrument, which carries no baselineId) can never
// contaminate the gate. When null (analysis-only / fixtures), every same-scorer row counts.
// Clock-sanity slack: a counted row stamped further than this beyond the reading
// host's clock is FLAGGED as suspect (forged-or-skewed timestamp), but still counts —
// the gate's conditions are pre-registered and a hard exclusion would misfire on
// legitimate clock skew (and on the test harness's own deterministic EVAL_TS stamps).
// This is visibility for the same forged-timestamp class documented at
// baselinePreEpoch: local evidence cannot prove a timestamp, only bound its absurdity.
const FUTURE_SLACK_MS = 24 * 3600 * 1000;
const tsSuspectFuture = (row, nowMs) => {
  const t = row && row.ts ? Date.parse(row.ts) : NaN;
  return Number.isFinite(t) && t > (nowMs ?? Date.now()) + FUTURE_SLACK_MS;
};

function readPairedArms(file, baselineId) {
  const t = [], c = [];
  let excludedPreLine = 0, excludedNoTs = 0, suspectFutureTs = 0;
  for (const r of readJsonl(file)) {
    if (r.scorerVersion !== SCORER) continue;
    if (baselineId && r.baselineId !== baselineId) continue;
    if (typeof r.treatmentAcc !== 'number' || typeof r.controlAcc !== 'number') continue;
    // EPOCH GUARD: a row timestamped before the measurement line is history, not
    // evidence — count it out loud, never into the gate arrays (see header). A row
    // whose ts cannot be PLACED is excluded the same way: admitting it would let
    // pre-line history re-enter the gate by losing its timestamp.
    const ep = epochOf(r);
    if (ep === 'pre') { excludedPreLine++; continue; }
    if (ep === 'no-ts') { excludedNoTs++; continue; }
    if (tsSuspectFuture(r)) suspectFutureTs++;   // counted, but loudly flagged (see above)
    t.push(r.treatmentAcc); c.push(r.controlAcc);
  }
  return { t, c, excludedPreLine, excludedNoTs, suspectFutureTs };
}
// Bench treatment-arm longitudinal trend (accuracyPct under norm-v1) — corroborating context.
// Bench ts values may carry non-ISO suffixes ("…Z-run1"), so extract the ISO prefix before
// placing a row against the epoch line; no parseable prefix ⇒ cannot place ⇒ kept (legacy).
function benchEpochOf(r) {
  const m = String(r && r.ts || '').match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?/);
  if (!m) return 'no-ts';
  const t = Date.parse(m[0].endsWith('Z') ? m[0] : m[0] + 'Z');
  if (!Number.isFinite(t)) return 'no-ts';
  return t < Date.parse(EPOCH_LINE) ? 'pre' : 'post';
}
function readBenchTrend(file) {
  // Rows without an explicit scorerVersion are pre-normalization history — mixing
  // them back in resurrects the phantom +8.3pp the norm-v1 split existed to kill.
  // EPOCH GUARD: pre-line bench rows are likewise excluded (same broken instrument),
  // and so are rows whose ts cannot be placed (the real history holds norm-v1 rows
  // with ts like 'trained-run1-…' and '' — all June-era pre-line; counting them as
  // post-line corroboration is exactly the blend this guard exists to forbid).
  const rows = readJsonl(file).filter((r) => r.scorerVersion === BENCH_SCORER && typeof r.accuracyPct === 'number');
  const excludedPreLine = rows.filter((r) => benchEpochOf(r) === 'pre').length;
  const excludedNoTs = rows.filter((r) => benchEpochOf(r) === 'no-ts').length;
  const accs = rows.filter((r) => benchEpochOf(r) === 'post').map((r) => r.accuracyPct);
  if (accs.length < 2) return { runs: accs.length, deltaPP: null, flat: null, excludedPreLine, excludedNoTs };
  return { runs: accs.length, deltaPP: +(accs[accs.length - 1] - accs[0]).toFixed(1), flat: Math.abs(accs[accs.length - 1] - accs[0]) < 5, excludedPreLine, excludedNoTs };
}

// ── Frozen-baseline counterfactual (the control arm's policy store) ───────────
// The EXACT cwd-relative artifacts `ruflo hooks route` consults as learned policy
// (verified against the installed dist: hooks-tools.js ROUTING_OUTCOMES_PATH + the
// RUFLO-SEMRANK re-rank, ruvector/lora-adapter.js weightsPath + neural checkpoints,
// memory/memory-bridge.js getDbPath, and the ε-state file). A missing entry is simply
// absent in the snapshot — route no-ops on it, so an untrained store degrades cleanly.
const SNAPSHOT_PATHS = [
  '.claude-flow/routing-outcomes.json',   // learned patterns + SEMRANK graded re-rank
  '.claude-flow/.ruflo-explore-state.json', // ε decay counter (moot at ε=0, snapshotted for fidelity)
  '.claude-flow/neural',                   // lora-checkpoint-*.json (autoloaded on adapter init)
  '.swarm/lora-weights.json',              // LoRA B matrix consumed by route-time adapt()
  '.swarm/memory.db', '.swarm/memory.db-wal', '.swarm/memory.db-shm', // AgentDB bridge router
  'ruvector.db',                           // native VectorDb (HNSW) persistence, if present
  'claude-flow.config.json',               // memory.persistPath etc. — keep path resolution identical
];
const manifestPath = (dir) => path.join(dir, 'manifest.json');

function sha256File(f) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }
  catch { return null; }
}
// Depth-first list of files under `abs`, as paths relative to `root`, sorted for stability.
function walkFiles(abs, root, out) {
  let st; try { st = fs.statSync(abs); } catch { return out; }
  if (st.isDirectory()) { for (const e of fs.readdirSync(abs).sort()) walkFiles(path.join(abs, e), root, out); }
  else if (st.isFile()) { out.push(path.relative(root, abs)); }
  return out;
}
// Content-addressed fingerprint of the DURABLE policy under `root`. Identical policy stores
// ⇒ identical hash — this IS the per-arm "which policy did it read" proof. Transient sqlite
// sidecars (-wal/-shm) are excluded: they churn on every open and are not stable policy, so
// including them would flap the fingerprint on write-noise rather than real learning.
const HASH_SKIP = /(?:-wal|-shm)$/;
function hashState(root) {
  const map = {};
  for (const rel of SNAPSHOT_PATHS) for (const f of walkFiles(path.join(root, rel), root, [])) if (!HASH_SKIP.test(f)) map[f] = sha256File(path.join(root, f));
  const keys = Object.keys(map).sort();
  const hash = crypto.createHash('sha256').update(keys.map((k) => k + ':' + map[k]).join('\n')).digest('hex');
  return { hash, files: keys.length, map };
}
function copyRecursive(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); for (const e of fs.readdirSync(src)) copyRecursive(path.join(src, e), path.join(dst, e)); }
  else { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); } // src read-only; dst is a fresh sandbox file
}
// Copy the whitelist srcRoot → dstRoot (dirs recursively). Never moves, never writes under
// srcRoot. Returns the relative paths actually copied.
function snapshotState(srcRoot, dstRoot) {
  const copied = [];
  for (const rel of SNAPSHOT_PATHS) {
    const src = path.join(srcRoot, rel);
    if (!fs.existsSync(src)) continue;
    copyRecursive(src, path.join(dstRoot, rel));
    copied.push(rel);
  }
  return copied;
}
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } }
// Best-effort stack versions for the manifest (real freeze only; tests pass an explicit stub).
function captureStack() {
  const one = (cmd) => { try { return execSync(cmd, { timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } };
  return { ruflo: one('ruflo --version'), aqe: one('aqe --version'), node: process.version };
}
// Freeze liveRoot's policy stores into baselineDir + write manifest. Pure fs — NO routing.
// The manifest lives at baselineDir/manifest.json (outside the whitelist, so it never leaks
// into a routing cwd). baselineId = the content hash of the frozen stores.
function freezeBaseline(liveRoot, baselineDir, opts = {}) {
  rmrf(baselineDir);
  fs.mkdirSync(baselineDir, { recursive: true });
  snapshotState(liveRoot, baselineDir);
  const h = hashState(baselineDir);
  const manifest = {
    created: new Date().toISOString(), scorerVersion: SCORER, stack: opts.stack || {},
    sources: h.map, baselineId: h.hash, files: h.files,
    note: 'Frozen control-arm policy for the G3 improvement gate. Treatment routes against the ' +
      'CURRENT live stores, control against this frozen copy. `--rebaseline` re-freezes and RESETS ' +
      'the longitudinal series (prior rows were measured against a different baselineId).',
  };
  fs.writeFileSync(manifestPath(baselineDir), JSON.stringify(manifest, null, 2));
  return manifest;
}
// Freeze once; reuse unchanged thereafter. --rebaseline forces a re-freeze with a loud warning.
function ensureBaseline() {
  const exists = fs.existsSync(manifestPath(BASELINE_DIR));
  if (exists && !REBASELINE) return JSON.parse(fs.readFileSync(manifestPath(BASELINE_DIR), 'utf8'));
  if (exists && REBASELINE) {
    process.stderr.write('\n\x1b[1;33m⚠️  --rebaseline: RE-FREEZING the control baseline.\x1b[0m\n' +
      '    This RESETS the longitudinal self-improvement series — every prior treatment-vs-control\n' +
      '    row was measured against a DIFFERENT baselineId and is no longer directly comparable.\n' +
      '    The pre-registered ≥3-run / ≥2σ gate restarts its accrual from this run.\n\n');
  }
  return freezeBaseline(CWD, BASELINE_DIR, { stack: captureStack() });
}
// A throwaway routing cwd holding a fresh copy of `srcRoot`'s policy stores.
function mkSandbox(srcRoot, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-arm-' + tag + '-'));
  snapshotState(srcRoot, dir);
  return dir;
}

// ── --selftest: stats vs crafted fixtures with KNOWN answers (no ruflo) ───────
function selftest() {
  const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
  const checks = [];
  const chk = (name, cond) => checks.push({ name, pass: !!cond });
  // permutation p: 3 ones vs 3 zeros → only the observed split reaches the max diff → 1/C(6,3)=1/20.
  chk('permP([1,1,1],[0,0,0]) === 0.05', approx(permP([1, 1, 1], [0, 0, 0]), 0.05));
  // Cohen's d exactness: μΔ=0.2, pooled sd=0.1 → d=2.0.
  chk("cohensD exact = 2.0", approx(cohensD([0.6, 0.7, 0.8], [0.4, 0.5, 0.6]), 2.0));
  chk('cohensD sign is directional', cohensD([0.4, 0.5, 0.6], [0.6, 0.7, 0.8]) === -2 || approx(cohensD([0.4, 0.5, 0.6], [0.6, 0.7, 0.8]), -2.0));
  chk('sigmaSeparation ≥2 on separated flat arms', sigmaSeparation([0.7, 0.72, 0.74], [0.5, 0.5, 0.5]) >= SIGMA_MIN);
  // verdict ladder edges:
  chk('IMPROVING: 3 runs, ≥2σ, flat control', verdictOf([0.7, 0.72, 0.74], [0.5, 0.5, 0.5]).verdict === 'IMPROVING');
  chk('NOT-IMPROVING: trained ≤ control', verdictOf([0.5, 0.5, 0.5], [0.6, 0.6, 0.6]).verdict === 'NOT-IMPROVING');
  chk('UNPROVEN: <3 runs', verdictOf([0.7, 0.74], [0.5, 0.5]).verdict === 'UNPROVEN');
  chk('UNPROVEN: positive but <2σ', verdictOf([0.6, 0.4, 0.6], [0.5, 0.5, 0.5]).verdict === 'UNPROVEN');
  chk('UNPROVEN: strong Δ but control not flat', verdictOf([0.7, 0.72, 0.74], [0.4, 0.5, 0.6]).verdict === 'UNPROVEN');
  chk('gate constants are hard (2σ / 3 runs)', SIGMA_MIN === 2.0 && MIN_RUNS === 3);
  // frozen-baseline plumbing (pure fs, no ruflo): freeze → hash → re-copy round-trips.
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-self-'));
    try {
      const live = path.join(tmp, 'live'), base = path.join(tmp, 'base');
      fs.mkdirSync(path.join(live, '.claude-flow'), { recursive: true });
      fs.writeFileSync(path.join(live, '.claude-flow', 'routing-outcomes.json'), JSON.stringify({ outcomes: [{ agent: 'coder', quality: 0.9 }] }));
      const m1 = freezeBaseline(live, base, { stack: { ruflo: 'test' } });
      chk('freezeBaseline writes a baselineId + manifest', !!m1.baselineId && fs.existsSync(manifestPath(base)));
      // a control sandbox copied FROM the baseline must hash-match baselineId (control==frozen).
      const ctrl = path.join(tmp, 'ctrl'); snapshotState(base, ctrl);
      chk('control snapshot hash === baselineId', hashState(ctrl).hash === m1.baselineId);
      // treatment reading a MUTATED live store must hash DIFFERENTLY from the frozen control.
      fs.writeFileSync(path.join(live, '.claude-flow', 'routing-outcomes.json'), JSON.stringify({ outcomes: [{ agent: 'tester', quality: 0.1 }] }));
      const treat = path.join(tmp, 'treat'); snapshotState(live, treat);
      chk('divergent live store ⇒ treatment hash !== control hash', hashState(treat).hash !== hashState(ctrl).hash);
    } finally { rmrf(tmp); }
  }
  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) console.log(`  ${c.pass ? '✓' : '✗'} ${c.name}`);
  if (failed.length) { console.log(`selftest FAILED (${failed.length}/${checks.length})`); process.exit(1); }
  console.log(`selftest OK (${checks.length}/${checks.length})`);
  process.exit(0);
}

// ── --preflight: re-baseline readiness (Wave 4) — no routing, no writes ───────
// A fair post-line series requires the instrument to be verifiably sound BEFORE the
// control baseline is frozen. This mode checks exactly the preconditions whose silent
// absence produced the pre-2026-07-31 confound, so nobody can re-run the eval on a
// broken instrument by accident. Exit 0 only when every check passes.
function preflight() {
  const checks = [];
  const inst = probeInstrument();
  checks.push({
    name: 'better-sqlite3 native opens from the ruflo agentdb root', ok: inst.bsqliteNativeOk === true,
    note: inst.bsqliteNativeOk === true ? 'open+SELECT 1 ok (not the sql.js/WASM fallback)'
      : inst.bsqliteNativeOk === false ? 'resolve/require/open FAILED — AgentDB would silently fall back to WASM; repair (npm rebuild better-sqlite3 in that tree) before baselining'
        : 'could not assess (attribution module or npm root unavailable)',
  });
  checks.push({
    name: 'ruflo #2786 bridge→trajectory writer state is KNOWN', ok: inst.bridge2786 !== null,
    note: inst.bridge2786 === null ? 'installed dist not found — cannot record writer provenance'
      : 'bridgeRecordFeedback → recordTrajectory is ' + (inst.bridge2786 ? 'LIVE (each post-task double-writes)' : 'not present (upstream moved/removed it — flag self-retired)'),
  });
  // Kit learning-loop sentinels: without BOTH, the JS arm is write-only and the
  // treatment arm cannot differ from control by training (SEAM-SENTINEL-V1 precedent).
  try {
    const attr = require(path.join(__dirname, 'trajectory-attribution.cjs'));
    const root = attr.resolveNpmRoot();
    const dist = path.join(root, 'ruflo', 'node_modules', '@claude-flow', 'cli', 'dist', 'src');
    const intel = fs.readFileSync(path.join(dist, 'memory', 'intelligence.js'), 'utf8');
    const hooks = fs.readFileSync(path.join(dist, 'mcp-tools', 'hooks-tools.js'), 'utf8');
    checks.push({ name: 'SONA-TRAIN-V1 sentinel present (train seam)', ok: intel.includes('SONA-TRAIN-V1'), note: 'memory/intelligence.js' });
    checks.push({ name: 'RUFLO-LORA-ADAPT-V1 sentinel present (consume seam)', ok: hooks.includes('RUFLO-LORA-ADAPT-V1'), note: 'mcp-tools/hooks-tools.js' });
  } catch (e) {
    checks.push({ name: 'kit learning-loop sentinels readable', ok: false, note: 'installed dist unreadable: ' + e.message });
  }
  // Attribution wiring: the Stop hook must be recording trajectory sources, or the
  // new series inherits the same unattributable-writers confound.
  try {
    const hook = fs.readFileSync(path.join(CWD, '.claude', 'helpers', 'aqe-post-route.cjs'), 'utf8');
    checks.push({ name: 'Stop-hook trajectory attribution wired (traj-attr-v1)', ok: hook.includes('traj-attr-v1'), note: '.claude/helpers/aqe-post-route.cjs' });
  } catch (e) {
    checks.push({ name: 'Stop-hook trajectory attribution wired (traj-attr-v1)', ok: false, note: '.claude/helpers/aqe-post-route.cjs unreadable' });
  }
  // Baseline epoch: absent is fine (first run freezes post-line); pre-line is a hard stop.
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath(BASELINE_DIR), 'utf8')); } catch (e) {}
  checks.push({
    name: 'control baseline is post-epoch (or absent, to be frozen now)',
    ok: !manifest || !baselinePreEpoch(manifest),
    note: !manifest ? 'no baseline yet — first collection (or --rebaseline) freezes one post-line'
      : baselinePreEpoch(manifest) ? 'frozen ' + manifest.created + ' < ' + EPOCH_LINE + ' — run --rebaseline'
        : 'frozen ' + manifest.created,
  });
  const failed = checks.filter((x) => !x.ok);
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ preflight: true, epochLine: EPOCH_LINE, checks, ready: failed.length === 0 }, null, 2) + '\n');
  } else {
    console.log('\n══ Re-baseline preflight (measurement epoch ' + EPOCH_LINE.slice(0, 10) + ') ══');
    for (const x of checks) console.log('  ' + (x.ok ? '✓' : '✗') + ' ' + x.name + (x.note ? '  — ' + x.note : ''));
    console.log(failed.length === 0
      ? '\nREADY — freeze the baseline with --rebaseline, then run one plain eval per session (≥' + MIN_RUNS + ' sessions, same host + stack).\n'
      : '\nNOT READY (' + failed.length + ' failing) — fix the above BEFORE freezing a baseline, or the new series repeats the pre-line confound.\n');
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

// Pure helpers exported for unit tests (stats + baseline lifecycle). Requiring the module
// does NOT run main (guarded below), so tests never spawn ruflo or touch a live store.
module.exports = {
  verdictOf, permP, cohensD, sigmaSeparation, mean, spread,
  hashState, snapshotState, freezeBaseline, manifestPath, SNAPSHOT_PATHS, SCORER,
  EPOCH_LINE, EPOCH_ID, epochOf, baselinePreEpoch, readPairedArms, probeInstrument,
  benchEpochOf, readBenchTrend, tsSuspectFuture,
};
if (require.main !== module) return;

// ── Main ─────────────────────────────────────────────────────────────────────
if (has('-h') || has('--help')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 33).map((l) => l.replace(/^\s?\* ?/, '').replace(/^\/\*| ?\*\/$/g, '')).join('\n'));
  process.exit(0);
}
if (has('--selftest')) selftest();
if (has('--preflight')) preflight();

let collected = null;
if (!ANALYSIS_ONLY) collected = collectSession();

// Live runs read only rows measured against the just-used baseline; analysis-only counts all.
const { t, c, excludedPreLine, excludedNoTs, suspectFutureTs } = readPairedArms(EVAL_HIST, collected ? collected.baselineId : null);
const bench = readBenchTrend(BENCH_HIST);
const v = verdictOf(t, c);
const result = {
  scorerVersion: SCORER, seeds: SEEDS, session: collected,
  treatment: t, control: c, benchTrend: bench,
  epoch: { line: EPOCH_LINE, id: EPOCH_ID, excludedPreLine, excludedNoTs, suspectFutureTs, reason: EPOCH_REASON },
  ...v,
};

if (JSON_OUT) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exit(v.verdict === 'IMPROVING' ? 0 : 1); }
if (QUIET) { process.stdout.write(v.verdict + '\n'); process.exit(v.verdict === 'IMPROVING' ? 0 : 1); }

const C = process.stdout.isTTY
  ? { g: '\x1b[0;32m', y: '\x1b[1;33m', r: '\x1b[0;31m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', y: '', r: '', d: '', b: '', x: '' };
console.log(C.b + '\n══ Cross-Session Self-Improvement Proof (G3 / gate #4) ══' + C.x);
if (collected) console.log('This session: treatment ' + (collected.treatmentAcc * 100).toFixed(1) + '%  control ' + (collected.controlAcc * 100).toFixed(1) + '%  (seeds=' + SEEDS + ', n=' + collected.n + ')');
else console.log(C.d + 'analysis-only (--history-file ' + EVAL_HIST + ') — no live routing' + C.x);
if (excludedPreLine > 0) {
  console.log(C.y + 'EPOCH LINE ' + EPOCH_LINE + ': ' + excludedPreLine + ' pre-line row(s) EXCLUDED from the gate' + C.x);
  console.log(C.d + '  (' + EPOCH_REASON + ' — kept as history, never blended with post-line data)' + C.x);
}
if (excludedNoTs > 0) console.log(C.y + 'EPOCH LINE: ' + excludedNoTs + ' row(s) with missing/unparseable ts EXCLUDED from the gate' + C.x + C.d + ' (unplaceable against the line — cannot be proven post-repair)' + C.x);
if (suspectFutureTs > 0) console.log(C.y + 'CLOCK SANITY: ' + suspectFutureTs + ' counted row(s) are stamped >24h beyond this host\'s clock' + C.x + C.d + ' (forged-or-skewed ts — still counted, gate unchanged; investigate before trusting the verdict)' + C.x);
console.log('Paired sessions: ' + C.b + v.n + C.x + C.d + ' (need ≥' + MIN_RUNS + ')' + C.x +
  '  ·  treatment μ ' + (mean(t) * 100).toFixed(1) + '%  control μ ' + (mean(c) * 100).toFixed(1) + '%');
console.log('Between-arm: Δ ' + C.b + (v.deltaPP >= 0 ? '+' : '') + v.deltaPP + 'pp' + C.x +
  '  separation ' + (v.sigma === 999 ? '∞' : v.sigma) + 'σ' + C.d + ' (gate ≥' + SIGMA_MIN + 'σ)' + C.x +
  '  perm p' + (v.permP < 0.001 ? '<0.001' : '=' + v.permP) + '  d=' + (v.cohensD === 999 ? '∞' : v.cohensD) +
  '  control ' + (v.controlFlat ? C.g + 'flat' + C.x : C.y + 'NOT flat' + C.x));
const benchExcl = (bench.excludedPreLine || 0) + (bench.excludedNoTs || 0);
const benchExclNote = benchExcl ? ' (' + (bench.excludedPreLine || 0) + ' pre-line + ' + (bench.excludedNoTs || 0) + ' unplaceable-ts row(s) excluded)' : '';
if (bench.deltaPP != null) console.log(C.d + 'Bench treatment trend (norm-v1, corroborating): ' + (bench.deltaPP >= 0 ? '+' : '') + bench.deltaPP + 'pp over ' + bench.runs + ' runs' + benchExclNote + C.x);
else if (benchExcl) console.log(C.d + 'Bench treatment trend: no post-line series yet' + benchExclNote + C.x);
const vc = v.verdict === 'IMPROVING' ? C.g : v.verdict === 'NOT-IMPROVING' ? C.r : C.y;
console.log(C.b + 'VERDICT: ' + vc + v.verdict + C.x);
console.log(C.d + v.reason + C.x + '\n');
process.exit(v.verdict === 'IMPROVING' ? 0 : 1);
