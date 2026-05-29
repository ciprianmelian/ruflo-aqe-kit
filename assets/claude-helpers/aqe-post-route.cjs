#!/usr/bin/env node
/*
 * aqe-post-route.cjs — replace the hardcoded `aqe hooks post-route --success true`
 * (which pinned the router to a constant reward) with a success derived from the turn.
 *
 * HONEST SCOPE (read this — do NOT overclaim):
 *  • The reward is derived by the OBJECTIVE outcome oracle (_derive-outcome.cjs /
 *    DERIVE-OUTCOME-V1): harness-set `tool_result.is_error`, non-zero Bash exits, and
 *    test-runner FAIL/pass — NOT the agent's prose. It cannot be talked away by an
 *    upbeat final summary. (This replaced the former gameable keyword-count deriveReward.)
 *  • AQE `post-route` consumes only the BOOLEAN success: upstream quality is binary
 *    (true→0.675 / false→0.425) and the Q-update reward is `success?0.1:-1`. So the
 *    graded reward (0.05–0.95) is DISCARDED by the AQE router — only `success` (=reward≥0.5)
 *    moves rl_q_values. The graded value rides on `ruflo hooks post-task -q` and on the
 *    routing-outcomes.json store the RUFLO-SEMRANK-V1 re-rank reads (see WS2b below).
 *  • SIGNAL DENSITY caveat (measured): real turns mostly succeed, so the derived boolean
 *    is positive on the majority of turns — that is the honest truth, not a bug. The oracle
 *    supplies REAL (if modest) variance grounded in tool outcomes; it dips to false on turns
 *    with a hard tool failure / failing test. It is strictly better than the literal constant
 *    `true`, but a high natural success rate means the per-turn learning signal is sparse.
 *  Mechanism IS real (proven): with an open route sentinel, `post-route --success false`
 *  moves rl_q_values — the arg is honored. The proven limit is signal density, not wiring.
 *
 * WHAT it feeds (best-effort, never blocks Stop, always exit 0):
 *   • AQE router  : `aqe hooks post-route --success <real>`  → rl_q_values (the
 *     aqe-hook-router that drives the UserPromptSubmit suggestion + confidence).
 *     Requires the UserPromptSubmit `aqe hooks route` to have run this turn (it does,
 *     settings.json) so a route sentinel is open for post-route to resolve against.
 *   • Ruflo side  : `ruflo hooks post-task -s <real> -q <reward>` — recorded for ruflo's
 *     learning. NOTE: the CLI post-task does NOT itself write the routing-outcomes.json
 *     that `ruflo hooks route` reads. THIS wrapper writes that store directly (WS2b below),
 *     and the RUFLO-SEMRANK-V1 dist re-rank consumes it — so the Router B loop closes
 *     end-to-end once a reliable routed agent is supplied (see WS2b).
 *
 * Success/quality are DERIVED from the turn's transcript via the OBJECTIVE outcome
 * oracle (_derive-outcome.cjs / DERIVE-OUTCOME-V1): harness-set tool_result.is_error,
 * non-zero Bash exits, and test FAIL/pass — NOT prose sentiment. reward in [0.05,0.95];
 * success = reward >= 0.5. (Replaces the former gameable keyword-count deriveReward.)
 *
 * WS2b — Router B graded outcomes store (.claude-flow/routing-outcomes.json):
 *   The RUFLO-SEMRANK-V1 dist re-rank reads {task,agent,success,quality,keywords,timestamp}
 *   from that store. This wrapper writes one entry PER TURN — but ONLY when the routed
 *   agent is RELIABLY known. INTEGRITY: at Stop time the payload carries only
 *   transcript_path (CC Stop spec: session_id/transcript_path/cwd/stop_hook_active) — the
 *   task is recoverable from the transcript's first user message, but the AQE
 *   routing_outcomes `recommended` field is the WRONG vocabulary (qe-test-architect, not
 *   tester/coder) and is not turn-correlated, so using it would POISON the store.
 *   The routed agent therefore comes from a trusted channel, in priority order:
 *     (1) explicit $RUFLO_ROUTED_AGENT env / argv[3];
 *     (2) the UserPromptSubmit route-capture sentinel .claude-flow/.ruflo-route.json,
 *         written by ruflo-route-capture.cjs = ruflo's OWN `hooks route` pick for this turn
 *         (vocabulary-consistent with the re-rank's candidate agents), accepted only when
 *         FRESH (< 2h) so a prior session can't bleed a wrong agent in.
 *   If neither yields an agent → SKIP the write (poison guard). An empty store makes the
 *   re-rank an exact no-op (reversibility-by-data); a poisoned store would mis-rank — empty
 *   is strictly safer. With (2) wired, the Router B loop now closes in production: capture
 *   ruflo's pick on prompt → derive outcome at Stop → store → re-rank consumes next turn.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const _err = (...a) => { try { process.stderr.write(a.map(String).join(' ') + '\n'); } catch (e) {} };
console.log = _err; console.info = _err; console.warn = _err; console.debug = _err;

// Objective outcome oracle (co-located helper). require is wrapped so a missing/broken
// oracle degrades to a safe neutral reward instead of throwing — this hook MUST NOT block Stop.
let deriveOutcome;
try { ({ deriveOutcome } = require(path.join(__dirname, '_derive-outcome.cjs'))); }
catch (e) { deriveOutcome = () => ({ reward: 0.7, success: true, basis: 'fallback', signals: { oracleMissing: true } }); }

// Mirror of the dist extractKeywords (hooks-tools.js): lowercase, strip non-alnum(+space/-),
// split on whitespace, drop stopwords and tokens of length <= 2. Kept in lock-step so the
// store's keywords match what Router B's loadLearnedPatterns expects.
const _STOP = new Set(('the a an is are was were be been being have has had do does did will would could should may might shall can to of in for on with at by from as into through during before after above below between under again further then once it its this that these those i me my we our you your he she they them and but or nor not no so if when than very just also only both each all any few more most other some such same new now here there where how what which who').split(' '));
function extractKeywords(text) {
  if (!text) return [];
  return String(text).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !_STOP.has(w));
}

// Reject Claude Code meta-envelopes (agent-completion <task-notification>, slash-command
// echoes, hook/tool-result output) that can arrive as a "prompt"/first-user-message — they
// are NOT routing tasks and would poison routing-outcomes.json. (Mirrors the guard in
// ruflo-route-capture.cjs; defends even against an already-polluted sentinel.)
function isRoutableTask(t) {
  const s = String(t || '').trim();
  if (!s) return false;
  if (/^<(task-notification|command-message|command-name|command-args|local-command|system-reminder|user-prompt-submit-hook|bash-(input|stdout|stderr)|tool_use|tool_result)\b/i.test(s)) return false;
  return true;
}

// First genuine user message text = the turn's task (objective; from the transcript).
function firstUserTask(transcript) {
  try {
    for (const line of String(transcript || '').split('\n')) {
      const s = line.trim(); if (!s) continue;
      let ev; try { ev = JSON.parse(s); } catch (e) { continue; }
      const m = ev && (ev.message || ev); if (!m) continue;
      if ((m.role || ev.type) !== 'user') continue;
      const c = m.content;
      if (Array.isArray(c) && c.length && c.every((p) => p && p.type === 'tool_result')) continue;
      const t = typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join('\n') : '';
      if (t.trim()) return t.trim();
    }
  } catch (e) {}
  return '';
}

// Read the UserPromptSubmit route-capture sentinel (.claude-flow/.ruflo-route.json), written
// by ruflo-route-capture.cjs with ruflo's OWN routing pick for this turn (vocabulary-consistent
// with the re-rank candidates). Returns {task, agent} only if FRESH (< 2h) so a stale sentinel
// from a prior session can't bleed a wrong agent into this turn's outcome. null otherwise.
function readRouteSentinel() {
  try {
    const p = path.join(process.cwd(), '.claude-flow', '.ruflo-route.json');
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!j || !j.agent) return null;
    const age = Date.now() - new Date(j.ts || 0).getTime();
    if (!(age >= 0 && age < 2 * 3600 * 1000)) return null; // stale / unparseable ts ⇒ ignore
    if (j.task && !isRoutableTask(j.task)) return null; // reject a polluted (meta-envelope) sentinel
    return { task: j.task || '', agent: String(j.agent).trim() };
  } catch (e) { return null; }
}

// WS2b: append one graded outcome — ONLY when the agent is reliably known. Read {outcomes:[]},
// push, cap last 500, write. SKIP (no-op) if agent unknown — never fabricate (poison guard).
function recordRoutingOutcome(task, agent, success, quality) {
  if (!agent || !task) return false; // integrity: unknown agent ⇒ skip, keep store empty
  if (!isRoutableTask(task)) return false; // poison guard: don't record meta-envelopes
  try {
    const dir = path.join(process.cwd(), '.claude-flow');
    const store = path.join(dir, 'routing-outcomes.json');
    let data = { outcomes: [] };
    try { if (fs.existsSync(store)) { const j = JSON.parse(fs.readFileSync(store, 'utf8')); if (j && Array.isArray(j.outcomes)) data = j; } } catch (e) {}
    data.outcomes.push({ task: String(task).slice(0, 500), agent: String(agent), success: !!success, quality, keywords: extractKeywords(task), timestamp: new Date().toISOString() });
    if (data.outcomes.length > 500) data.outcomes = data.outcomes.slice(-500);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    fs.writeFileSync(store, JSON.stringify({ outcomes: data.outcomes }, null, 2));
    return true;
  } catch (e) { return false; }
}

(function main() {
  let basis = 'transcript', signals = {};
  try {
    let payload = {};
    try { const raw = fs.readFileSync(0, 'utf8'); if (raw && raw.trim()) payload = JSON.parse(raw); } catch (e) {}
    const tp = payload.transcript_path || payload.transcriptPath;
    // Feed the oracle the raw transcript JSONL (it scores the last turn objectively).
    let transcript = '';
    try { if (tp && fs.existsSync(tp)) transcript = fs.readFileSync(tp, 'utf8'); } catch (e) {}

    // Reward source: explicit override (tests/replay) → transcript oracle → fallback.
    let reward;
    if (process.argv[2] && /^-?\d*\.?\d+$/.test(process.argv[2])) {
      reward = Math.max(0.05, Math.min(0.95, parseFloat(process.argv[2])));
      basis = 'override';
    } else {
      const o = deriveOutcome(transcript);
      reward = o.reward; basis = o.basis || 'transcript'; signals = o.signals || {};
    }
    const success = reward >= 0.5;  // AQE consumes only this boolean (graded value is dropped upstream)

    // WS1: one stderr breadcrumb so the tester's realism audit can grep the basis/reward.
    _err('[aqe-post-route] basis=' + basis + ' reward=' + reward.toFixed(3) + ' signals=' + JSON.stringify(signals));

    // CONTROL-ARM TOGGLE (Gate 3): RUFLO_DISABLE_TRAINING=1 computes + logs the reward but
    // performs NO learning writes (AQE post-route, ruflo post-task, routing-outcomes store).
    // Lets the bench run a trained vs control arm with everything else identical. The
    // breadcrumb above still fires so the tester can see what the reward WOULD have been.
    if (/^(1|true|yes)$/i.test(String(process.env.RUFLO_DISABLE_TRAINING || ''))) {
      _err('[aqe-post-route] RUFLO_DISABLE_TRAINING set — skipping all learning writes (control arm)');
      process.stdout.write('{}');
      return;
    }

    // Prefer the GLOBAL aqe binary (the npx form reconciles its cache per call — see
    // CLAUDE.md Runtime note); fall back to npx only if aqe isn't on PATH.
    let aqeCmd = 'aqe', aqeArgs = ['hooks', 'post-route', '--success', String(success)];
    try { execFileSync('sh', ['-c', 'command -v aqe'], { stdio: 'ignore' }); }
    catch (e) { aqeCmd = 'npx'; aqeArgs = ['agentic-qe'].concat(aqeArgs); }
    // (1) AQE router — the proven-movable path (boolean only).
    try { execFileSync(aqeCmd, aqeArgs, { stdio: 'ignore', timeout: 3500 }); } catch (e) {}
    // (2) Ruflo side — fed graded for forward-compat. The CLI post-task does NOT write the
    //     routing-outcomes.json that Router B reads; THIS wrapper writes it directly (WS2b below).
    try { execFileSync('ruflo', ['hooks', 'post-task', '-s', String(success), '-q', reward.toFixed(2)], { stdio: 'ignore', timeout: 3500 }); } catch (e) {}

    // (3) WS2b — graded outcomes store for RUFLO-SEMRANK-V1. Routed agent from a trusted
    // channel: explicit $RUFLO_ROUTED_AGENT / argv[3] first, else the UserPromptSubmit
    // route-capture sentinel (ruflo-route-capture.cjs — ruflo's own on-policy pick for this
    // turn). Unknown ⇒ skip (poison guard: an empty store no-ops the re-rank, safe).
    let agent = (process.env.RUFLO_ROUTED_AGENT || process.argv[3] || '').trim();
    let task = firstUserTask(transcript);
    let agentSrc = agent ? 'explicit' : '';
    if (!agent) {
      const cap = readRouteSentinel();
      if (cap && cap.agent) { agent = cap.agent; if (cap.task) task = cap.task; agentSrc = 'route-capture'; }
    }
    const wrote = recordRoutingOutcome(task, agent, success, reward);
    _err('[aqe-post-route] routing-outcomes ' + (wrote ? 'recorded agent=' + agent + ' (' + agentSrc + ')' : 'SKIPPED (no reliable routed agent — store stays empty, re-rank no-ops)'));

    process.stdout.write('{}');
  } catch (e) {
    try { process.stdout.write('{}'); } catch (_) {}
  } finally {
    process.exit(0);
  }
})();
