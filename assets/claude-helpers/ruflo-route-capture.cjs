#!/usr/bin/env node
/*
 * ruflo-route-capture.cjs — RUFLO-ROUTE-CAPTURE-V1 (UserPromptSubmit)
 *
 * Closes the Router B learning loop in PRODUCTION. The Stop wrapper (aqe-post-route.cjs)
 * writes graded outcomes to .claude-flow/routing-outcomes.json which the RUFLO-SEMRANK-V1
 * dist re-rank consumes — but ONLY when the turn's routed agent is RELIABLY known. At Stop
 * time there is no trustworthy routed agent in scope (the AQE `recommended` field is a
 * different vocabulary, qe-test-architect not tester/coder, and is not turn-correlated).
 *
 * This hook supplies that missing piece: on each user prompt it asks ruflo's OWN router
 * (`ruflo hooks route`) what it recommends for the task, and stashes {task, agent, ts} in
 * .claude-flow/.ruflo-route.json. aqe-post-route.cjs reads that sentinel at Stop and pairs
 * the recommendation with the turn's derived outcome quality → a real on-policy training
 * signal in ruflo's OWN agent vocabulary (so it matches the re-rank's candidate agents).
 *
 * HONEST SCOPE: this is an ON-POLICY signal — it records the agent ruflo ALREADY picked,
 * weighted by outcome. It reinforces good picks and (via lower quality) discourages bad
 * ones, but because ruflo's router does not EXPLORE alternatives, this alone cannot
 * DISCOVER a better route for a task it currently mis-routes — it can only sharpen/penalize
 * the existing policy. Closing the loop end-to-end is the point here; measurable accuracy
 * improvement still depends on signal density + (future) exploration.
 *
 * Read-only w.r.t. everything except the sentinel; silent (stderr only); always exit 0;
 * never blocks the prompt.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const _err = (...a) => { try { process.stderr.write(a.map(String).join(' ') + '\n'); } catch (e) {} };
console.log = _err; console.info = _err; console.warn = _err; console.debug = _err;

// A UserPromptSubmit can fire for NON-task system events whose `prompt` is a Claude Code
// meta-envelope (agent-completion <task-notification>, slash-command echoes, hook output,
// tool-result echoes). Those are NOT routing requests — recording them would poison the
// store with non-task noise (keywords like tmp/file-paths/tool-ids). Only capture genuine
// user routing prompts. (Companion guard lives in aqe-post-route.cjs.)
function isRoutableTask(t) {
  const s = String(t || '').trim();
  if (!s) return false;
  if (/^<(task-notification|command-message|command-name|command-args|local-command|system-reminder|user-prompt-submit-hook|bash-(input|stdout|stderr)|tool_use|tool_result)\b/i.test(s)) return false;
  return true;
}

(function main() {
  try {
    let payload = {};
    try { const raw = fs.readFileSync(0, 'utf8'); if (raw && raw.trim()) payload = JSON.parse(raw); } catch (e) {}
    const prompt = String(payload.prompt || payload.user_prompt || payload.input || '').trim();
    if (!prompt) { process.stdout.write('{}'); return; }
    if (!isRoutableTask(prompt)) { _err('[ruflo-route-capture] skipped non-task envelope'); process.stdout.write('{}'); return; }

    // Ask ruflo's own router (on-policy, vocabulary-consistent with the re-rank candidates).
    let out = '';
    try {
      out = execFileSync('ruflo', ['hooks', 'route', '--task', prompt],
        { timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    } catch (e) { out = (e && e.stdout ? e.stdout.toString() : '') || ''; }
    const m = out.replace(/\x1b\[[0-9;]*m/g, '').match(/Agent:\s*([A-Za-z0-9_-]+)/);
    const agent = m ? m[1] : '';
    if (!agent) { process.stdout.write('{}'); return; }

    const dir = path.join(process.cwd(), '.claude-flow');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    fs.writeFileSync(path.join(dir, '.ruflo-route.json'),
      JSON.stringify({ task: prompt.slice(0, 500), agent, ts: new Date().toISOString() }));
    _err('[ruflo-route-capture] task routed → ' + agent);
    process.stdout.write('{}');
  } catch (e) {
    try { process.stdout.write('{}'); } catch (_) {}
  } finally {
    process.exit(0);
  }
})();
