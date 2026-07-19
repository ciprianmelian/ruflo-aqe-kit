#!/usr/bin/env node
/*
 * selfimprove-bench.cjs — settle "is the kit self-IMPROVING?" with DATA, not assertion.
 *
 * Self-LEARNING (artifacts grow + persist) is already proven. This harness tests the
 * harder claim: do the kit's ROUTING DECISIONS measurably improve as it learns?
 *
 * It is a re-runnable, READ-ONLY longitudinal instrument (reads DBs + the routers;
 * appends one row to .claude-flow/selfimprove-history.jsonl). Run it across sessions;
 * a real self-improving system shows held-out accuracy/confidence trending UP while the
 * reward signal carries real variance. Per the integrity gate, the verdict is falsifiable.
 *
 * Metrics per run:
 *   (A) Held-out ROUTING ACCURACY + mean confidence: route a FIXED set of {prompt,
 *       expectedAgent} tasks via `ruflo hooks route` (deterministic) and score
 *       recommendedAgent vs expected. (This is the honest metric — accuracy, not just
 *       confidence; on a held-out set, never the live stream.)
 *   (B) REWARD VARIANCE: distinct last_reward values in rl_q_values. The root blocker
 *       found by the audit is a CONSTANT reward → every estimator sits at a fixed point.
 *       distinct(last_reward)==1  ⇒  improvement is impossible by construction.
 *   (C) Q-SPREAD + LoRA norm: diagnostic only (do NOT count as improvement).
 *
 * Verdict gate (devil's-advocate bar): "self-improving" is only PROVEN over HISTORY when,
 * across >=3 runs, held-out ACCURACY trends up AND reward variance > 0. A single run
 * cannot prove it — it can only DISPROVE (flat + constant reward ⇒ NOT improving today).
 *
 * Usage: node scripts/selfimprove-bench.cjs [--json] [--quiet]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CWD = process.cwd();
const AQE_DB = path.join(CWD, '.agentic-qe', 'memory.db');
const LORA = path.join(CWD, '.swarm', 'lora-weights.json');
const HIST = path.join(CWD, '.claude-flow', 'selfimprove-history.jsonl');
const JSON_OUT = process.argv.includes('--json');
const QUIET = process.argv.includes('--quiet');

// ── Held-out task set (FIXED, never fed to any trainer) ──────────────────────
// Each maps to ruflo's short agent labels (tester/reviewer/coder/architect/...).
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
];

function sh(cmd, timeoutMs) {
  try { return execSync(cmd, { timeout: timeoutMs || 20000, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); }
  catch (e) { return (e.stdout ? e.stdout.toString() : '') || ''; }
}
function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }
function sqlite(db, q) {
  if (!fs.existsSync(db)) return '';
  try { return execSync('sqlite3 -readonly "' + db + '" "' + q + '"', { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch (e) { return ''; }
}

// ── Label normalization (WS3b) ───────────────────────────────────────────────
// CONSERVATIVE alias map: collapse ONLY agent labels that are genuinely the SAME role
// under different vocabularies (ruflo short labels vs AQE qe-* / @claude-flow long
// labels). INTEGRITY: kept deliberately TIGHT — an over-broad map manufactures accuracy
// and is a falsifier the reviewer will check. Raw `got` is always kept in rows for
// transparency; scoring uses norm(got)===norm(expect). Unknown labels pass through
// unchanged (so a genuinely wrong route still reads as a miss).
const LABEL_EQUIV = {
  'security-architect': 'reviewer', 'security-auditor': 'reviewer', 'code-review-swarm': 'reviewer',
  'qe-test-architect': 'tester', 'qe-coverage-specialist': 'tester',
  'backend-dev': 'coder',
  'system-architect': 'architect',
  'researcher': 'researcher',
};
const normLabel = (a) => LABEL_EQUIV[a] || a;

// ── (A) Held-out routing accuracy + mean confidence ─────────────────────────
function measureRouting() {
  let correct = 0, correctRaw = 0, confSum = 0, scored = 0;
  const rows = [];
  const methodCounts = {}; // WS3a histogram: semantic-native | semantic-pure-js | keyword | unknown
  for (const t of TASKS) {
    const out = stripAnsi(sh('ruflo hooks route --task ' + JSON.stringify(t.prompt), 20000));
    const am = out.match(/Agent:\s*([A-Za-z0-9_-]+)/);
    const cm = out.match(/Confidence:\s*([\d.]+)%/);
    // WS3a: routing method (which router path produced the decision).
    const mm = out.match(/Method:\s*(semantic-native|semantic-pure-js|keyword)/i);
    const method = mm ? mm[1].toLowerCase() : 'unknown';
    methodCounts[method] = (methodCounts[method] || 0) + 1;
    const agent = am ? am[1] : '(none)';
    const conf = cm ? parseFloat(cm[1]) : NaN;
    // WS3b: score on normalized labels; ALSO keep the raw (un-normalized) hit so the
    // headline can report both — a normalization change must never read as learning.
    const hit = normLabel(agent) === normLabel(t.expect);
    const hitRaw = agent === t.expect;
    if (Number.isFinite(conf)) { confSum += conf; scored++; }
    if (hit) correct++;
    if (hitRaw) correctRaw++;
    rows.push({ prompt: t.prompt.slice(0, 40), expect: t.expect, got: agent, gotNorm: normLabel(agent), method, conf, hit, hitRaw });
  }
  return {
    n: TASKS.length,
    accuracyPct: Math.round((correct / TASKS.length) * 1000) / 10,       // normalized (headline)
    accuracyRawPct: Math.round((correctRaw / TASKS.length) * 1000) / 10, // un-normalized (transparency)
    meanConfidencePct: scored ? Math.round((confSum / scored) * 10) / 10 : null,
    methodCounts,
    rows,
  };
}

// ── (3c) AQE-router arm — diagnostic, does NOT change the headline verdict ────
// Reads the AQE rl_q_values for the held-out space and reports the Q-distribution +
// reward variance + an optional confidence mean (captured by routing the held-out prompts
// through `aqe hooks route --json` when --aqe-confidence is passed). This measures the
// OTHER router (the AQE rl_q_values path the objective oracle now actually feeds), in
// parallel with Router B. Labeled diagnostic — the headline verdict stays Router-B accuracy
// + reward-non-constant.
function measureAqeRouter() {
  const qMeanRaw = sqlite(AQE_DB, 'SELECT ROUND(AVG(q_value),4) FROM rl_q_values;');
  const qStat = sqlite(AQE_DB, "SELECT ROUND(MIN(q_value),4)||'|'||ROUND(MAX(q_value),4) FROM rl_q_values;").split('|');
  const rewardDistinct = parseInt(sqlite(AQE_DB, 'SELECT COUNT(DISTINCT last_reward) FROM rl_q_values WHERE last_reward IS NOT NULL;'), 10) || 0;
  const rowCount = parseInt(sqlite(AQE_DB, 'SELECT COUNT(*) FROM rl_q_values;'), 10) || 0;
  let confMean = null;
  if (process.argv.includes('--aqe-confidence')) {
    let sum = 0, n = 0;
    for (const t of TASKS) {
      const out = stripAnsi(sh('aqe hooks route --task ' + JSON.stringify(t.prompt) + ' --json', 20000));
      const m = out.match(/"confidence"\s*:\s*([\d.]+)/);
      if (m) { sum += parseFloat(m[1]); n++; }
    }
    confMean = n ? Math.round((sum / n) * 10000) / 10000 : null;
  }
  return {
    rows: rowCount,
    qMean: parseFloat(qMeanRaw) || 0,
    qMin: parseFloat(qStat[0]) || 0,
    qMax: parseFloat(qStat[1]) || 0,
    qSpread: (parseFloat(qStat[1]) || 0) - (parseFloat(qStat[0]) || 0),
    rewardDistinct,
    confidenceMean: confMean,
  };
}

// ── (B) Reward variance + (C) Q-spread (the root-cause diagnostics) ──────────
function measureLearningState() {
  const qcount = parseInt(sqlite(AQE_DB, 'SELECT COUNT(*) FROM rl_q_values;'), 10) || 0;
  const distinctReward = parseInt(sqlite(AQE_DB, 'SELECT COUNT(DISTINCT last_reward) FROM rl_q_values WHERE last_reward IS NOT NULL;'), 10) || 0;
  const rewardVals = sqlite(AQE_DB, 'SELECT DISTINCT last_reward FROM rl_q_values WHERE last_reward IS NOT NULL ORDER BY last_reward;').split('\n').filter(Boolean);
  const qstat = sqlite(AQE_DB, "SELECT ROUND(MIN(q_value),4)||'|'||ROUND(MAX(q_value),4)||'|'||ROUND(AVG(q_value),4) FROM rl_q_values;").split('|');
  let loraB = 0, loraUpdates = 0;
  try {
    const w = JSON.parse(fs.readFileSync(LORA, 'utf8'));
    const B = (w.weights && w.weights.B) || [];
    for (let i = 0; i < B.length; i++) loraB += Math.abs(B[i]);
    loraUpdates = (w.stats && w.stats.totalUpdates) || 0;
  } catch (e) {}
  return {
    qCount: qcount,
    rewardDistinctValues: distinctReward,
    rewardValues: rewardVals,
    rewardIsConstant: distinctReward <= 1,
    qMin: parseFloat(qstat[0]) || 0, qMax: parseFloat(qstat[1]) || 0, qAvg: parseFloat(qstat[2]) || 0,
    qSpread: (parseFloat(qstat[1]) || 0) - (parseFloat(qstat[0]) || 0),
    loraSumAbsB: Math.round(loraB * 10000) / 10000,
    loraTotalUpdates: loraUpdates,
  };
}

// ── History + trend ──────────────────────────────────────────────────────────
function readHistory() {
  try { return fs.readFileSync(HIST, 'utf8').split('\n').filter(Boolean).map(JSON.parse); }
  catch (e) { return []; }
}
function appendHistory(row) {
  try { fs.mkdirSync(path.dirname(HIST), { recursive: true }); fs.appendFileSync(HIST, JSON.stringify(row) + '\n'); }
  catch (e) {}
}

(function main() {
  const routing = measureRouting();
  const state = measureLearningState();
  const aqe = measureAqeRouter(); // WS3c — diagnostic arm (does NOT change the verdict)
  const prior = readHistory();
  // Scorer version: bump whenever the accuracy DEFINITION changes (label map, task set,
  // hit rule). The trend is only ever read across rows with the SAME scorer — a scorer
  // change is a metric redefinition, not learning, and must not produce a phantom delta
  // (a prior audit caught exactly that: +8.3pp that was purely the normalization change).
  const SCORER = 'norm-v1';
  // NOTE: timestamp passed by env so the harness stays deterministic/replayable.
  // ts must never be empty — unordered rows can't be read as a session sequence.
  const row = { ts: process.env.BENCH_TS || new Date().toISOString(), scorerVersion: SCORER, accuracyPct: routing.accuracyPct, accuracyRawPct: routing.accuracyRawPct, meanConfidencePct: routing.meanConfidencePct, methodCounts: routing.methodCounts, rewardDistinct: state.rewardDistinctValues, rewardConstant: state.rewardIsConstant, qSpread: state.qSpread, loraSumAbsB: state.loraSumAbsB, loraUpdates: state.loraTotalUpdates, aqe: { qMean: aqe.qMean, qSpread: aqe.qSpread, rewardDistinct: aqe.rewardDistinct, confidenceMean: aqe.confidenceMean } };
  appendHistory(row);
  const series = prior.concat([row]);
  // ONLY compare like-with-like: rows scored under the current scorer definition.
  const sameScorer = series.filter((r) => r.scorerVersion === SCORER);

  // Trend over SAME-SCORER history only (need >=3 such runs to even consider a trend).
  let trend = 'insufficient-history';
  if (sameScorer.length >= 3) {
    const accs = sameScorer.map((r) => r.accuracyPct).filter((x) => typeof x === 'number');
    const first = accs[0], last = accs[accs.length - 1];
    trend = last - first >= 5 ? 'accuracy-rising' : (last - first <= -5 ? 'accuracy-falling' : 'accuracy-flat');
  }

  // Falsifiable verdict (devil's-advocate gate). NB: "IMPROVING" requires >=3 SAME-SCORER
  // runs AND still defers PROVEN to a no-train control arm (run externally by the tester).
  let verdict, reason;
  if (state.rewardIsConstant) {
    verdict = 'NOT-IMPROVING (blocked)';
    reason = 'Reward signal is CONSTANT (distinct last_reward=' + state.rewardDistinctValues + '). Every downstream estimator sits at a fixed point — self-improvement is impossible by construction until reward carries real variance. Self-LEARNING still holds (artifacts grow); self-IMPROVEMENT does not.';
  } else if (sameScorer.length < 3) {
    verdict = 'UNPROVEN (need >=3 same-scorer runs)';
    reason = 'Reward now varies (' + state.rewardDistinctValues + ' distinct) — the blocker is removed — but proving improvement requires a held-out accuracy trend across >=3 runs UNDER THE CURRENT SCORER (' + SCORER + '); only ' + sameScorer.length + ' so far. Earlier-scorer rows are excluded (a metric redefinition is not learning). Run this harness each session.';
  } else if (trend === 'accuracy-rising') {
    verdict = 'IMPROVING (evidence, control pending)';
    reason = 'Held-out routing accuracy rose >=5pp across ' + sameScorer.length + ' same-scorer runs with non-constant reward. NOT yet PROVEN: a no-train control arm must be shown to stay flat over the same window before declaring self-improvement (the harness cannot run that control itself).';
  } else {
    verdict = 'NOT-IMPROVING';
    reason = 'Reward varies but held-out accuracy is ' + trend + ' across ' + sameScorer.length + ' same-scorer runs — no measured improvement.';
  }

  const result = { routing, state, aqe, runs: series.length, runsSameScorer: sameScorer.length, scorerVersion: SCORER, trend, verdict, reason };
  if (JSON_OUT) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return; }
  if (QUIET) { process.stdout.write(verdict + '\n'); return; }

  const c = { g: '\x1b[0;32m', y: '\x1b[1;33m', r: '\x1b[0;31m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
  console.log(c.b + '\n══ Self-Improvement Benchmark ══' + c.x);
  console.log('(A) Held-out routing: ' + c.b + routing.accuracyPct + '% accuracy' + c.x + ' (' + routing.rows.filter((r) => r.hit).length + '/' + routing.n + ')' + c.d + ' [raw ' + routing.accuracyRawPct + '%, normalized scorer ' + result.scorerVersion + ']' + c.x + ', mean confidence ' + routing.meanConfidencePct + '%');
  for (const r of routing.rows) console.log('    ' + (r.hit ? c.g + '✓' : c.r + '✗') + c.x + ' ' + c.d + r.expect.padEnd(10) + c.x + ' got ' + (r.hit ? r.got : c.y + r.got + c.x) + (r.got !== r.gotNorm ? c.d + '→' + r.gotNorm + c.x : '') + ' @' + r.conf + '% ' + c.d + '[' + r.method + '] ' + r.prompt + c.x);
  console.log('    ' + c.d + 'method histogram: ' + JSON.stringify(routing.methodCounts) + c.x);
  console.log('(B) Reward variance: ' + (state.rewardIsConstant ? c.r + 'CONSTANT' + c.x : c.g + state.rewardDistinctValues + ' distinct' + c.x) + ' values=[' + state.rewardValues.join(', ') + ']  ← the root blocker');
  console.log('(C) Q-spread: min ' + state.qMin + ' max ' + state.qMax + ' avg ' + state.qAvg + ' (spread ' + Math.round(state.qSpread * 1000) / 1000 + ')  |  LoRA sum|B|=' + state.loraSumAbsB + ' updates=' + state.loraTotalUpdates + c.d + ' (LoRA is write-only — diagnostic, not consumed)' + c.x);
  console.log('(D) AQE-router arm ' + c.d + '(diagnostic, not in verdict):' + c.x + ' qMean=' + aqe.qMean + ' qSpread=' + Math.round(aqe.qSpread * 1000) / 1000 + ' rewardDistinct=' + aqe.rewardDistinct + ' rows=' + aqe.rows + (aqe.confidenceMean != null ? ' confMean=' + aqe.confidenceMean : ''));
  console.log('Runs in history: ' + series.length + ' (' + sameScorer.length + ' under scorer ' + result.scorerVersion + ')  |  accuracy trend: ' + trend);
  const vc = verdict.startsWith('IMPROVING') ? c.g : verdict.startsWith('NOT') ? c.r : c.y;
  console.log(c.b + 'VERDICT: ' + vc + verdict + c.x);
  console.log(c.d + reason + c.x + '\n');
})();
