#!/usr/bin/env node
/*
 * RUFLO-TRAIN-SUBAGENT-V1 — train the ruflo SONA LoRA on Task SUBAGENT completion.
 * Companion to ruflo-train.cjs (which only fires on PostToolUse Edit/Write, so all
 * Task subagent work — research/analysis/audits — never fed the trainer). Wired on
 * the SubagentStop hook: reads the subagent's output from the payload's
 * transcript_path JSONL (task + ALL assistant text, conclusion-weighted; field
 * fallbacks), embeds it via AQE's MiniLM (384-d = LoRA inputDim), and
 * getLoRAAdapter().train()+saveWeights() -> PROJECT/.swarm/lora-weights.json.
 *
 * Hardened (loop-2): (a) a mkdir-atomic LOCK serializes trainers so concurrent
 * SubagentStops (fan-out) can't interleave the non-atomic saveWeights and corrupt
 * the weights file — if the lock is held, this run SKIPS (a lost sample beats a
 * corrupt adapter); stale locks (>120s) are stolen. (b) a min-length gate skips
 * trivial/near-empty outputs ("done.") so the LoRA isn't trained on noise.
 * Read-mostly; console silenced to stderr; ALWAYS exits 0 (never blocks).
 */
const fs = require('fs');
const path = require('path');
const _err = (...a) => { try { process.stderr.write(a.map(String).join(' ') + '\n'); } catch (e) {} };
console.log = _err; console.info = _err; console.warn = _err; console.debug = _err;

// Objective outcome oracle (DERIVE-OUTCOME-V1) — replaces the inline prose-sentiment
// _deriveReward. Wrapped require: a missing/broken oracle degrades to neutral 0.7 rather
// than throwing (this trainer must never crash a SubagentStop). See _derive-outcome.cjs.
let deriveOutcome;
try { ({ deriveOutcome } = require(path.join(__dirname, '_derive-outcome.cjs'))); }
catch (e) { deriveOutcome = () => ({ reward: 0.7, success: true, signals: { oracleMissing: true } }); }

// NPM-ROOT-RESOLVE-V1: global node_modules via `npm root -g` (custom npm
// prefixes diverge from the execPath guess); wrapped require so a target that
// predates _npm-root.cjs degrades to the old inline derivation.
let npmRootG;
try { npmRootG = require(path.join(__dirname, '_npm-root.cjs')); }
catch (e) { npmRootG = () => path.join(path.dirname(path.dirname(process.execPath)), 'lib', 'node_modules'); }

const MIN_CHARS = 40;        // skip trivial subagent outputs ("done.")
const MAX_CHARS = 3500;      // conclusion-weighted slice fed to the embedder
const LOCK_STALE_MS = 120000;

// Pull task (first user msg) + ALL assistant text from a Claude Code transcript JSONL.
function _extractFromTranscript(transcriptPath) {
  let task = '', allText = '';
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
      const msg = ev && (ev.message || ev);
      if (!msg) continue;
      const role = msg.role || ev.type;
      const content = msg.content;
      const textOf = (c) => typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join('\n') : '';
      if (role === 'user' && !task) { const t = textOf(content).trim(); if (t) task = t; }
      else if (role === 'assistant') { const t = textOf(content); if (t.trim()) allText += (allText ? '\n' : '') + t; }
    }
  } catch (e) {}
  return { task, allText };
}

(async () => {
  let lockDir = '';
  try {
    let payload = {};
    try { const raw = fs.readFileSync(0, 'utf8'); if (raw && raw.trim()) payload = JSON.parse(raw); } catch (e) {}

    // Resolve subject: prefer the transcript (task + conclusion-weighted findings),
    // then common result fields.
    let task = '', body = '', transcriptRaw = '';
    const tp = payload.transcript_path || payload.transcriptPath;
    if (tp && fs.existsSync(tp)) {
      try { transcriptRaw = fs.readFileSync(tp, 'utf8'); } catch (e) {}
      const x = _extractFromTranscript(tp); task = x.task; body = x.allText;
    }
    if (!body) {
      body = payload.result || payload.output || payload.response
        || (payload.tool_response && (payload.tool_response.result || payload.tool_response.output))
        || (typeof payload.last_message === 'string' ? payload.last_message : '') || '';
    }
    body = String(body || '').trim();
    if (body.length < MIN_CHARS) { process.stdout.write('{}'); return; }  // skip noise
    // task gives intent; body's TAIL is the conclusion (MiniLM truncates ~256 tokens).
    const subject = (task ? 'task: ' + task.slice(0, 200) + ' | ' : '') + 'result: ' + body.slice(-MAX_CHARS);

    // DERIVE-OUTCOME-V1: derive a VARIED reward from the subagent's ACTUAL outcome
    // (objective oracle over the transcript — tool failures / Bash exit codes / test
    // FAIL-pass) instead of a constant 0.8 or gameable prose sentiment. Constant reward
    // was THE self-improving blocker — every RL estimator converged to a fixed point
    // (Q-band avg ~0.06, routing confidence pinned). A real outcome signal gives reward
    // variance, the precondition for the learning loop to move. The oracle scores the
    // raw transcript JSONL; if no transcript is available it falls back to the subagent
    // body so trivial turns still get a neutral reward. Explicit argv[2] still overrides.
    const reward = process.argv[2]
      ? Math.max(0.1, Math.min(1.0, parseFloat(process.argv[2])))
      : deriveOutcome(transcriptRaw || body).reward;

    const nodeBase = npmRootG();
    const aqeBase = path.join(nodeBase, 'agentic-qe');
    const cliBase = path.join(nodeBase, 'ruflo', 'node_modules', '@claude-flow', 'cli');
    if (!fs.existsSync(aqeBase) || !fs.existsSync(cliBase)) { process.stdout.write('{}'); return; }

    // Serialize trainers: getLoRAAdapter()->train()->saveWeights() is a non-atomic
    // read-modify-write; concurrent SubagentStops would lose updates / corrupt the
    // 177KB JSON. mkdir is atomic; if held, skip (a missed sample beats corruption).
    lockDir = path.join(process.cwd(), '.swarm', 'lora-train.lock');
    try { const st = fs.statSync(lockDir); if (Date.now() - st.mtimeMs > LOCK_STALE_MS) fs.rmdirSync(lockDir); } catch (e) {}
    try { fs.mkdirSync(lockDir, { recursive: false }); } catch (e) { lockDir = ''; process.stdout.write('{}'); return; }

    const emb = await import('file://' + path.join(aqeBase, 'dist', 'learning', 'real-embeddings.js'));
    const out = await emb.computeRealEmbedding('subagent: ' + subject);
    const vecArr = (out && (out.embedding || out.vector || out.data)) || out;
    if (!vecArr || !vecArr.length) { process.stdout.write('{}'); return; }
    const vec = Float32Array.from(vecArr);

    const lora = await import('file://' + path.join(cliBase, 'dist', 'src', 'ruvector', 'lora-adapter.js'));
    const adapter = await lora.getLoRAAdapter();
    if (adapter.config && adapter.config.inputDim && vec.length !== adapter.config.inputDim) { process.stdout.write('{}'); return; }
    adapter.train(vec, vec, reward);
    adapter.saveWeights();
    process.stdout.write('{}');
  } catch (e) {
    process.stdout.write('{}');
  } finally {
    if (lockDir) { try { fs.rmdirSync(lockDir); } catch (e) {} }
  }
})();
