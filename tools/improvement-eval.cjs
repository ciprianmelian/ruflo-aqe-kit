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
 * Each run (one session):
 *   • TREATMENT arm — `ruflo hooks route` with the live trained policy.
 *   • CONTROL arm    — same routes with RUFLO_DISABLE_TRAINING=1 RUFLO_ROUTE_EPSILON=0
 *                      (train disabled, no exploration — the no-train baseline the bench
 *                      documents). Scored on the SAME held-out set + normLabel scorer as the
 *                      bench, so the two instruments are commensurable.
 *   • Appends one paired row to .claude-flow/improvement-eval-history.jsonl.
 *
 * Verdict (read across sessions from BOTH histories):
 *   between-arm separation (mean_T − mean_C) / SE, one-sided permutation p, Cohen's d.
 *   HARD GATE (pre-registered, do NOT relax — Integrity Rule): IMPROVING requires
 *   ≥3 paired sessions AND ≥2σ between-arm separation AND a FLAT control arm AND mean_T>mean_C.
 *   Anything short of that is UNPROVEN; a trained arm at/below control is NOT-IMPROVING.
 *
 * READ-ONLY wrt every DB — it only invokes `ruflo hooks route` (a pure query, like the bench)
 * and appends to its own JSONL. Re-runnable and longitudinal: run it each session.
 *
 * Usage:
 *   node tools/improvement-eval.cjs [--seeds N] [--json] [--quiet]
 *   node tools/improvement-eval.cjs --selftest              # stats self-check, no ruflo calls
 *   node tools/improvement-eval.cjs --history-file <f>      # analyze <f> only (no collection)
 *   node tools/improvement-eval.cjs --bench-history <f>     # override selfimprove-history path
 * Exit: 0 IMPROVING (or --selftest all-pass) · 1 otherwise.
 */
'use strict';
const fs = require('fs');
const path = require('path');
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
function sh(cmd, env) {
  try { return execSync(cmd, { timeout: 20000, env, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); }
  catch (e) { return (e.stdout ? e.stdout.toString() : '') || ''; }
}
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
function routeAgent(prompt, env) {
  const out = stripAnsi(sh('ruflo hooks route --task ' + JSON.stringify(prompt), env));
  const m = out.match(/Agent:\s*([A-Za-z0-9_-]+)/);
  return m ? m[1] : '(none)';
}
// One arm, `SEEDS` passes over the held-out set; returns { acc, seeds:[...] }.
function measureArm(envOverrides) {
  const env = Object.assign({}, process.env, envOverrides);
  const perSeed = [];
  for (let s = 0; s < SEEDS; s++) {
    let correct = 0;
    for (const t of TASKS) if (normLabel(routeAgent(t.prompt, env)) === normLabel(t.expect)) correct++;
    perSeed.push(correct / TASKS.length);
  }
  return { acc: mean(perSeed), seeds: perSeed };
}
function collectSession() {
  const treatment = measureArm({});
  const control = measureArm({ RUFLO_DISABLE_TRAINING: '1', RUFLO_ROUTE_EPSILON: '0' });
  const row = {
    ts: process.env.EVAL_TS || new Date().toISOString(), scorerVersion: SCORER, seeds: SEEDS, n: TASKS.length,
    treatmentAcc: +treatment.acc.toFixed(4), controlAcc: +control.acc.toFixed(4),
    treatmentSeeds: treatment.seeds, controlSeeds: control.seeds,
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
function readPairedArms(file) {
  const t = [], c = [];
  for (const r of readJsonl(file)) {
    if (r.scorerVersion !== SCORER) continue;
    if (typeof r.treatmentAcc === 'number' && typeof r.controlAcc === 'number') { t.push(r.treatmentAcc); c.push(r.controlAcc); }
  }
  return { t, c };
}
// Bench treatment-arm longitudinal trend (accuracyPct under norm-v1) — corroborating context.
function readBenchTrend(file) {
  const accs = readJsonl(file).filter((r) => (r.scorerVersion || BENCH_SCORER) === BENCH_SCORER && typeof r.accuracyPct === 'number').map((r) => r.accuracyPct);
  if (accs.length < 2) return { runs: accs.length, deltaPP: null, flat: null };
  return { runs: accs.length, deltaPP: +(accs[accs.length - 1] - accs[0]).toFixed(1), flat: Math.abs(accs[accs.length - 1] - accs[0]) < 5 };
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
  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) console.log(`  ${c.pass ? '✓' : '✗'} ${c.name}`);
  if (failed.length) { console.log(`selftest FAILED (${failed.length}/${checks.length})`); process.exit(1); }
  console.log(`selftest OK (${checks.length}/${checks.length})`);
  process.exit(0);
}

// ── Main ─────────────────────────────────────────────────────────────────────
if (has('-h') || has('--help')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 33).map((l) => l.replace(/^\s?\* ?/, '').replace(/^\/\*| ?\*\/$/g, '')).join('\n'));
  process.exit(0);
}
if (has('--selftest')) selftest();

let collected = null;
if (!ANALYSIS_ONLY) collected = collectSession();

const { t, c } = readPairedArms(EVAL_HIST);
const bench = readBenchTrend(BENCH_HIST);
const v = verdictOf(t, c);
const result = {
  scorerVersion: SCORER, seeds: SEEDS, session: collected,
  treatment: t, control: c, benchTrend: bench, ...v,
};

if (JSON_OUT) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exit(v.verdict === 'IMPROVING' ? 0 : 1); }
if (QUIET) { process.stdout.write(v.verdict + '\n'); process.exit(v.verdict === 'IMPROVING' ? 0 : 1); }

const C = process.stdout.isTTY
  ? { g: '\x1b[0;32m', y: '\x1b[1;33m', r: '\x1b[0;31m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', y: '', r: '', d: '', b: '', x: '' };
console.log(C.b + '\n══ Cross-Session Self-Improvement Proof (G3 / gate #4) ══' + C.x);
if (collected) console.log('This session: treatment ' + (collected.treatmentAcc * 100).toFixed(1) + '%  control ' + (collected.controlAcc * 100).toFixed(1) + '%  (seeds=' + SEEDS + ', n=' + collected.n + ')');
else console.log(C.d + 'analysis-only (--history-file ' + EVAL_HIST + ') — no live routing' + C.x);
console.log('Paired sessions: ' + C.b + v.n + C.x + C.d + ' (need ≥' + MIN_RUNS + ')' + C.x +
  '  ·  treatment μ ' + (mean(t) * 100).toFixed(1) + '%  control μ ' + (mean(c) * 100).toFixed(1) + '%');
console.log('Between-arm: Δ ' + C.b + (v.deltaPP >= 0 ? '+' : '') + v.deltaPP + 'pp' + C.x +
  '  separation ' + (v.sigma === 999 ? '∞' : v.sigma) + 'σ' + C.d + ' (gate ≥' + SIGMA_MIN + 'σ)' + C.x +
  '  perm p' + (v.permP < 0.001 ? '<0.001' : '=' + v.permP) + '  d=' + (v.cohensD === 999 ? '∞' : v.cohensD) +
  '  control ' + (v.controlFlat ? C.g + 'flat' + C.x : C.y + 'NOT flat' + C.x));
if (bench.deltaPP != null) console.log(C.d + 'Bench treatment trend (norm-v1, corroborating): ' + (bench.deltaPP >= 0 ? '+' : '') + bench.deltaPP + 'pp over ' + bench.runs + ' runs' + C.x);
const vc = v.verdict === 'IMPROVING' ? C.g : v.verdict === 'NOT-IMPROVING' ? C.r : C.y;
console.log(C.b + 'VERDICT: ' + vc + v.verdict + C.x);
console.log(C.d + v.reason + C.x + '\n');
process.exit(v.verdict === 'IMPROVING' ? 0 : 1);
