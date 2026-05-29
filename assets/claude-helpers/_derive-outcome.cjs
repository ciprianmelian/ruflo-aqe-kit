#!/usr/bin/env node
/*
 * _derive-outcome.cjs — DERIVE-OUTCOME-V2
 *
 * An OBJECTIVE transcript-outcome reward oracle. Replaces the prose-sentiment
 * `deriveReward` heuristic (which keyword-counted the agent's own final text and
 * was therefore gameable + near-always-true on real turns) with a signal grounded
 * in what ACTUALLY happened in the turn: tool failures, non-zero Bash exits,
 * test-runner FAIL/pass, failure→success recovery, and turn EFFICIENCY.
 *
 * WHY this is stronger than prose sentiment:
 *   • `tool_result.is_error === true` is set by the harness, not the agent — it
 *     cannot be talked away by an optimistic final summary.
 *   • A turn that ran `npm test` and got "Tests: 3 failed" scores LOW even if the
 *     agent's closing text says "all fixed" — the oracle reads the result, not the claim.
 *   • Recovery is rewarded: a failed Bash that the agent then re-ran successfully
 *     is partial credit (the loop self-corrected), not a flat zero.
 *
 * V2 — WHY GRADED (the degenerate-signal fix): the V1 BASE=0.7 minus-penalties scheme
 * produced a near-constant reward — observed routing-outcomes.json had n=49 all
 * success=true with quality pinned to {0.7, 0.55}. A near-constant reward teaches the
 * learner nothing (every route looks equally good). V2 keeps the OBJECTIVE failure
 * signals (they still drive genuine failures clearly below 0.5) but spreads the SUCCESS
 * band by grading on turn quality:
 *   • edits-to-completion: a lean clean turn (few edits) earns a small bonus; a churny
 *     many-edit turn earns a small penalty (thrash proxy).
 *   • retry penalty: the same Bash command failing repeatedly before success (flailing).
 *   • tool-call efficiency: very high tool-call counts get a small bounded penalty.
 * Each term is individually bounded so a single big clean task can't dominate, and the
 * result is clamped to [0.05, 0.95]. ORDERING the design requires and the self-test
 * proves: efficient-success > churny-success > recovered-failure > hard-failure.
 *
 * NEGATIVE-MINING: genuine failures (is_error / test-fail, unrecovered) are kept clearly
 * BELOW 0.5 and TAGGED `signals.failureTag` so the minority-failure set is surfaceable.
 *
 * PURE + TESTABLE: deriveOutcome(eventsOrText) takes either an array of parsed
 * transcript events OR the raw JSONL string and returns { reward, success, basis, signals }.
 * No I/O, no process exit. The CLI wrapper at the bottom (only when run directly)
 * reads a transcript path / raw stdin and supports an explicit argv override for
 * tests and replay. Bounded reward in [0.05, 0.95]; success = reward >= 0.5.
 *
 * SCOPE HONESTY: this scores the last turn that ACTUALLY DID TOOL WORK (the most recent
 * user-prompt turn containing tool_result blocks). This deliberately skips a tool-less
 * closing summary turn so its upbeat text cannot mask the failures of the turn it
 * summarizes. It is an outcome proxy, not a formal proof of task correctness — but it is
 * objective (harness-set flags + exit codes + test output + structural turn metrics),
 * not self-report.
 */
'use strict';

// V2 reward is split into two regimes so EFFICIENCY grading never rescues a real failure:
//   • a turn with ANY unrecovered objective failure scores in the FAILURE band (< 0.5),
//     graded only by failure severity + recovery credit (efficiency is irrelevant there);
//   • a CLEAN turn scores in the SUCCESS band [0.55, 0.95], graded by efficiency so the
//     band is SPREAD (lean ≈ 0.90, churny ≈ 0.55) instead of pinned at one value.
// This is what kills the degenerate near-constant signal while keeping failures honest.

// ── Failure-band (objective, harness-grounded) — unchanged intent from V1 ───────────
const FAIL_BASE = 0.45;     // failure-band ceiling (always < 0.5 → never a "success")
const PEN_ERROR = 0.20;     // per error tool_result (is_error === true)
const PEN_BASH_EXIT = 0.15; // per failed Bash exit not already counted as is_error
const PEN_TEST_FAIL = 0.20; // per observed failing test run
const BONUS_RECOVERED = 0.05; // recovery credit (lifts within the failure band, still < 0.5)

// ── Success-band efficiency terms (clean turns only; spread, never rescue) ──────────
const CLEAN_BASE = 0.70;    // clean-turn centre
const BONUS_LEAN = 0.20;    // MAX bonus for a maximally lean clean turn (→ ~0.90)
const PEN_CHURN = 0.15;     // MAX penalty for a churny (many-edit) clean turn (→ ~0.55)
const SUCCESS_FLOOR = 0.55; // a clean turn always succeeds; efficiency only grades above this
const PEN_RETRY = 0.05;     // per repeated identical failed command (flailing), bounded
const PEN_RETRY_CAP = 0.15; // retry penalty cap
const PEN_TOOLSPAM = 0.10;  // MAX penalty for excessive tool-call count
// Edit-count thresholds: <= LEAN edits is lean; >= CHURN edits is churny; linear between.
const EDITS_LEAN = 1, EDITS_CHURN = 8;
// Tool-call efficiency: penalty ramps in above this many tool calls, full at +SPAM_RANGE.
const TOOLS_OK = 12, TOOLS_SPAM_RANGE = 18;

const MIN = 0.05, MAX = 0.95;

// Clamp to [MIN,MAX] and round to 4dp so the 0.5 success boundary is stable against
// IEEE-754 drift (e.g. 0.6 - 0.20 + 0.0999... near a boundary).
const clamp = (x) => Math.round(Math.max(MIN, Math.min(MAX, x)) * 10000) / 10000;
// Bounded linear interpolation helper, result in [lo,hi] as t goes 0→1 (t auto-clamped).
const lerp = (lo, hi, t) => lo + (hi - lo) * Math.max(0, Math.min(1, t));

// Pull the text out of a tool_result.content (string | array of {type:'text',text}).
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text).join('\n');
  }
  return '';
}

// Parse raw JSONL (one JSON event per line) into an array of events. Tolerant:
// malformed lines are skipped. Already-parsed arrays pass straight through.
function parseEvents(input) {
  if (Array.isArray(input)) return input;
  const out = [];
  for (const line of String(input || '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (e) { /* skip malformed */ }
  }
  return out;
}

// A "turn" = the span from a genuine user prompt to the next one. We treat a `user`
// event as a turn boundary ONLY if it carries real user text (not a tool_result echo,
// which the transcript also stores as a user-role message). We then score the LAST turn
// that actually performed tool work — skipping a tool-less closing summary turn so its
// optimistic text cannot mask the failures of the turn it summarizes.
function lastTurnEvents(events) {
  const isBoundary = (e) => {
    const m = (e && (e.message || e)) || {};
    if ((m.role || e.type) !== 'user') return false;
    const c = m.content;
    if (Array.isArray(c) && c.length > 0 && c.every((p) => p && p.type === 'tool_result')) return false; // echo
    return typeof c === 'string' ? !!c.trim()
      : Array.isArray(c) ? c.some((p) => p && p.type === 'text' && p.text && p.text.trim()) : false;
  };
  const hasTool = (slice) => slice.some((e) => {
    const c = ((e && (e.message || e)) || {}).content;
    return Array.isArray(c) && c.some((p) => p && p.type === 'tool_result');
  });
  const bounds = [];
  for (let i = 0; i < events.length; i++) if (isBoundary(events[i])) bounds.push(i);
  if (!bounds.length) return events; // no clear prompt boundary — score everything
  // Prefer the last turn that did tool work (walk boundaries from the end).
  for (let k = bounds.length - 1; k >= 0; k--) {
    const startIdx = bounds[k];
    const endIdx = (k + 1 < bounds.length) ? bounds[k + 1] : events.length;
    const slice = events.slice(startIdx, endIdx);
    if (hasTool(slice)) return slice;
  }
  return events.slice(bounds[bounds.length - 1]); // no tool work anywhere — last turn (neutral)
}

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// A stable key for a Bash invocation so identical repeated failures can be detected.
function bashKey(input) {
  if (!input || typeof input !== 'object') return null;
  const cmd = typeof input.command === 'string' ? input.command.trim() : '';
  return cmd ? cmd : null;
}

/**
 * Objectively score a turn's outcome from its transcript, per the V2 graded spec.
 * @param {Array|string} eventsOrText parsed events OR raw JSONL string
 * @returns {{reward:number, success:boolean, basis:string, signals:object}}
 */
function deriveOutcome(eventsOrText) {
  const all = parseEvents(eventsOrText);
  const events = lastTurnEvents(all);

  let errorToolResults = 0; // is_error === true
  let bashExitRaw = 0;      // "Exit code N>0" seen in result text (pre dedup vs is_error)
  let testFailures = 0, testPasses = 0;
  let editCount = 0;        // V2: Write/Edit/MultiEdit/NotebookEdit tool_use count
  let toolCallCount = 0;    // V2: total tool_use count

  // Track per-tool failure→success recovery. recovered (turn-level boolean) = ANY tool
  // that hard-failed earlier in the turn and later succeeded on a subsequent invocation.
  const toolState = new Map(); // name → { failed:boolean, recovered:boolean }

  // tool_result blocks carry only tool_use_id, not the tool name — map ids→names (and the
  // Bash command, for retry detection) so recovery (same-tool retry) can be detected.
  const idToName = new Map();
  const idToBashKey = new Map();
  const ordered = []; // { name, bashKey, isError, text }

  for (const e of events) {
    const m = (e && (e.message || e)) || {};
    const c = m.content;
    if (!Array.isArray(c)) continue;
    for (const p of c) {
      if (!p || typeof p !== 'object') continue;
      if (p.type === 'tool_use') {
        toolCallCount++;
        if (EDIT_TOOLS.has(p.name)) editCount++;
        if (p.id) {
          idToName.set(p.id, p.name || 'tool');
          if (p.name === 'Bash') { const k = bashKey(p.input); if (k) idToBashKey.set(p.id, k); }
        }
      } else if (p.type === 'tool_result') {
        const name = (p.tool_use_id && idToName.get(p.tool_use_id)) || 'tool';
        const bk = (p.tool_use_id && idToBashKey.get(p.tool_use_id)) || null;
        ordered.push({ name, bashKey: bk, isError: p.is_error === true, text: resultText(p.content) });
      }
    }
  }

  // V2: count repeated IDENTICAL failed Bash commands (flailing). The first failure of a
  // command is "the failure"; each SUBSEQUENT failure of the same command text is a retry.
  const failedBashByKey = new Map(); // bashKey → failure count

  for (const r of ordered) {
    const st = toolState.get(r.name) || { failed: false, recovered: false };
    if (r.isError) {
      errorToolResults++;
      st.failed = true;
      st.recovered = false; // a fresh failure resets recovery for this tool
      if (r.bashKey) failedBashByKey.set(r.bashKey, (failedBashByKey.get(r.bashKey) || 0) + 1);
    } else if (st.failed) {
      st.recovered = true;  // same tool succeeded after a prior failure → recovered
    }
    toolState.set(r.name, st);

    // Non-zero exit code surfaced in result text (covers Bash even if is_error missing).
    if (/(^|\n)\s*Exit code [1-9][0-9]*/.test(r.text)) {
      bashExitRaw++;
      if (r.bashKey && !r.isError) failedBashByKey.set(r.bashKey, (failedBashByKey.get(r.bashKey) || 0) + 1);
    }

    // Test-runner outcome signals (jest/vitest/mocha/pytest style).
    if (/\b\d+\s+failing\b/i.test(r.text) || /Tests:\s+\d+\s+failed/i.test(r.text)
        || /\bFAIL\b/.test(r.text) || /failed,\s*\d+\s+passed/i.test(r.text)) testFailures++;
    else if (/\bTests:\s+\d+\s+passed/i.test(r.text) || /\b\d+\s+passing\b/i.test(r.text)
        || /\bPASS\b/.test(r.text) || /\ball tests? passed\b/i.test(r.text)) testPasses++;
  }

  // failedBashExits = exit-code failures NOT already counted as is_error (avoid double-charging).
  const failedBashExits = Math.max(0, bashExitRaw - errorToolResults);
  // recovered (turn-level): any tool that failed and later succeeded.
  let recovered = false;
  for (const st of toolState.values()) { if (st.failed && st.recovered) { recovered = true; break; } }
  // retries = sum over commands of (failures - 1) for commands that failed >1 time.
  let retries = 0;
  for (const n of failedBashByKey.values()) retries += Math.max(0, n - 1);

  const failurePenalty =
      PEN_ERROR * errorToolResults
    + PEN_BASH_EXIT * failedBashExits
    + PEN_TEST_FAIL * testFailures;
  const hasFailure = (errorToolResults + failedBashExits + testFailures) > 0;

  // tool-call efficiency penalty: 0 up to TOOLS_OK, ramps to -PEN_TOOLSPAM over the next range.
  const toolSpamPen = toolCallCount <= TOOLS_OK ? 0
    : lerp(0, PEN_TOOLSPAM, (toolCallCount - TOOLS_OK) / TOOLS_SPAM_RANGE);
  const retryPen = Math.min(PEN_RETRY_CAP, PEN_RETRY * retries);

  // ── Two-regime reward ──────────────────────────────────────────────────────
  let reward;
  if (hasFailure) {
    // FAILURE band: graded by severity + recovery credit; efficiency is irrelevant.
    // FAIL_BASE < 0.5 guarantees an unrecovered failure is never scored as a success.
    reward = clamp(
      FAIL_BASE
      - failurePenalty
      + BONUS_RECOVERED * (recovered ? 1 : 0)
      - retryPen
    );
  } else {
    // SUCCESS band: a clean turn always succeeds (floor SUCCESS_FLOOR); efficiency SPREADS
    // it. editAdj: +BONUS_LEAN at <=EDITS_LEAN edits → -PEN_CHURN at >=EDITS_CHURN (linear).
    // A 0-edit work turn (read/inspect only) is treated as lean.
    let editAdj;
    if (editCount <= EDITS_LEAN) editAdj = BONUS_LEAN;
    else editAdj = lerp(BONUS_LEAN, -PEN_CHURN, (editCount - EDITS_LEAN) / (EDITS_CHURN - EDITS_LEAN));
    const raw = CLEAN_BASE + editAdj - toolSpamPen - retryPen;
    reward = clamp(Math.max(SUCCESS_FLOOR, raw));
  }

  // NEGATIVE-MINING tag: surface the minority failure set.
  const failureTag = !hasFailure ? null
    : (recovered ? 'recovered-failure'
      : (testFailures > 0 ? 'test-failure' : 'tool-failure'));

  return {
    reward,
    success: reward >= 0.5,
    basis: 'transcript',
    signals: {
      errorToolResults, failedBashExits, testFailures, testPasses, recovered,
      editCount, toolCallCount, retries, failureTag,
    },
  };
}

module.exports = { deriveOutcome, parseEvents, lastTurnEvents, resultText };

// ── CLI / self-test ─────────────────────────────────────────────────────────
if (require.main === module) {
  const fs = require('fs');
  const args = process.argv.slice(2);

  if (args[0] === '--selftest') {
    process.exit(runSelfTest() ? 0 : 1);
  }

  // Explicit reward override (tests/replay): a bare number as argv[0].
  const override = args[0] && /^-?\d*\.?\d+$/.test(args[0]) ? parseFloat(args[0]) : null;
  if (override !== null) {
    const r = clamp(override);
    process.stdout.write(JSON.stringify({ reward: r, success: r >= 0.5, basis: 'override', signals: {} }) + '\n');
    process.exit(0);
  }

  // Otherwise: argv[0] = transcript path, else read raw JSONL from stdin. Unreadable
  // input (no transcript, empty stdin) → neutral 0.7, basis 'fallback'.
  let raw = '', readable = false;
  try {
    if (args[0] && fs.existsSync(args[0])) { raw = fs.readFileSync(args[0], 'utf8'); readable = true; }
    else { raw = fs.readFileSync(0, 'utf8'); readable = !!(raw && raw.trim()); }
  } catch (e) { raw = ''; readable = false; }
  if (!readable) {
    process.stdout.write(JSON.stringify({ reward: 0.7, success: true, basis: 'fallback', signals: {} }) + '\n');
    process.exit(0);
  }
  process.stdout.write(JSON.stringify(deriveOutcome(raw)) + '\n');
  process.exit(0);
}

// Crafted transcripts proving the oracle's behavior. Self-contained (no fixtures).
// Returns true if ALL assertions pass (CLI exits non-zero otherwise).
function runSelfTest() {
  const mk = (events) => events.map((e) => JSON.stringify(e)).join('\n');
  const userMsg = (t) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: t }] } });
  const toolUse = (id, name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: input || {} }] } });
  const toolResult = (id, isError, text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] } });

  const cases = [];

  // 1) CLEAN turn: two tools, no errors → should be HIGH (and a success).
  cases.push(['clean', mk([
    userMsg('do a thing'),
    toolUse('a', 'Read'), toolResult('a', false, 'file contents...'),
    toolUse('b', 'Bash'), toolResult('b', false, 'Build succeeded\nDone.'),
  ])]);

  // 2) FAILING-TOOL turn: a single hard failure, unrecovered → should be < 0.5.
  cases.push(['failing-tool', mk([
    userMsg('run the build'),
    toolUse('a', 'Bash', { command: 'npm run build' }), toolResult('a', true, 'Exit code 1\nError: build failed'),
  ])]);

  // 3) FAILING TEST: npm test reports failures → should be < 0.5 despite no is_error.
  cases.push(['failing-test', mk([
    userMsg('run tests'),
    toolUse('a', 'Bash', { command: 'npm test' }), toolResult('a', false, 'Tests: 3 failed, 5 passed\nFAIL src/x.test.ts'),
  ])]);

  // 4) RECOVERED: Bash fails, then the SAME tool succeeds → partial credit, >= clean-fail but < clean.
  cases.push(['recovered', mk([
    userMsg('fix and rerun'),
    toolUse('a', 'Bash', { command: 'make' }), toolResult('a', true, 'Exit code 1\nError'),
    toolUse('b', 'Bash', { command: 'make' }), toolResult('b', false, 'OK, build succeeded'),
  ])]);

  // 5) MIXED: passing test + one unrecovered failure in a different tool → should dip < 0.5.
  cases.push(['mixed', mk([
    userMsg('do work'),
    toolUse('a', 'Bash', { command: 'npm test' }), toolResult('a', false, 'Tests: 10 passed'),
    toolUse('b', 'Read'), toolResult('b', true, 'Error: ENOENT no such file'),
  ])]);

  // 6) NO TOOLS: pure answer turn → neutral.
  cases.push(['no-tools', mk([
    userMsg('what is 2+2?'),
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'It is 4.' }] } },
  ])]);

  // ── V2 ORDERING cases ─────────────────────────────────────────────────────
  // 7) EFFICIENT-SUCCESS: one edit, clean → top of the success band.
  cases.push(['efficient-success', mk([
    userMsg('apply the fix'),
    toolUse('a', 'Edit'), toolResult('a', false, 'edit applied'),
    toolUse('b', 'Bash', { command: 'npm run build' }), toolResult('b', false, 'Build succeeded'),
  ])]);

  // 8) CHURNY-SUCCESS: many edits, clean → still a success but LOWER than efficient.
  cases.push(['churny-success', mk([
    userMsg('refactor everything'),
    toolUse('e1', 'Edit'), toolResult('e1', false, 'ok'),
    toolUse('e2', 'Edit'), toolResult('e2', false, 'ok'),
    toolUse('e3', 'Edit'), toolResult('e3', false, 'ok'),
    toolUse('e4', 'Edit'), toolResult('e4', false, 'ok'),
    toolUse('e5', 'Edit'), toolResult('e5', false, 'ok'),
    toolUse('e6', 'Edit'), toolResult('e6', false, 'ok'),
    toolUse('e7', 'Edit'), toolResult('e7', false, 'ok'),
    toolUse('e8', 'Edit'), toolResult('e8', false, 'ok'),
  ])]);

  // 9) HARD-FAILURE: two unrecovered errors → bottom.
  cases.push(['hard-failure', mk([
    userMsg('break it'),
    toolUse('a', 'Bash', { command: 'deploy' }), toolResult('a', true, 'Exit code 1\nError'),
    toolUse('b', 'Bash', { command: 'rollback' }), toolResult('b', true, 'Exit code 2\nError'),
  ])]);

  process.stdout.write('DERIVE-OUTCOME-V2 self-test\n');
  const R = {};
  for (const [name, jsonl] of cases) {
    const r = deriveOutcome(jsonl);
    R[name] = r;
    process.stdout.write(
      `  ${name.padEnd(18)} reward=${r.reward.toFixed(3)} success=${String(r.success).padEnd(5)} ` +
      `basis=${r.basis} signals=${JSON.stringify(r.signals)}\n`
    );
  }

  // ── Assertions ─────────────────────────────────────────────────────────────
  const checks = [];
  const expect = (cond, msg) => checks.push({ ok: !!cond, msg });
  // Original 6 invariants (must still hold).
  expect(R['clean'].success === true && R['clean'].reward >= 0.5, 'clean is a success');
  expect(R['failing-tool'].success === false && R['failing-tool'].reward < 0.5, 'failing-tool < 0.5');
  expect(R['failing-test'].success === false && R['failing-test'].reward < 0.5, 'failing-test < 0.5');
  expect(R['recovered'].reward >= R['failing-tool'].reward && R['recovered'].reward < R['clean'].reward,
    'recovered between clean-fail and clean');
  expect(R['mixed'].success === false && R['mixed'].reward < 0.5, 'mixed < 0.5');
  expect(R['no-tools'].reward >= 0.5, 'no-tools neutral/positive');
  // V2 ordering: efficient-success > churny-success > recovered-failure > hard-failure.
  expect(R['efficient-success'].reward > R['churny-success'].reward, 'efficient > churny');
  expect(R['churny-success'].reward > R['recovered'].reward, 'churny-success > recovered-failure');
  expect(R['recovered'].reward > R['hard-failure'].reward, 'recovered-failure > hard-failure');
  // Negative-mining tags.
  expect(R['failing-test'].signals.failureTag === 'test-failure', 'failing-test tagged test-failure');
  expect(R['hard-failure'].signals.failureTag === 'tool-failure', 'hard-failure tagged tool-failure');

  let allOk = true;
  process.stdout.write('\n  assertions:\n');
  for (const c of checks) {
    process.stdout.write(`    ${c.ok ? 'PASS' : 'FAIL'}  ${c.msg}\n`);
    if (!c.ok) allOk = false;
  }
  process.stdout.write(`\n  ${allOk ? 'ALL PASS' : 'FAILURES PRESENT'}\n`);
  return allOk;
}
