#!/usr/bin/env node
/*
 * RUFLO-TRAIN-V1 — per-edit ruflo SONA LoRA trainer (the working dual hook).
 * ruflo's own `hooks post-task`/`task-completed` CLI do NOT reach the patched
 * in-process trainer (CLI→MCP path is broken / writes nowhere). This helper uses
 * the PROVEN direct primitive: embed the edited file/task via AQE's MiniLM, then
 * getLoRAAdapter().train() + saveWeights() → PROJECT/.swarm/lora-weights.json.
 * Runs ALONGSIDE the AQE hooks (dual). Read-mostly; always exits 0 (never blocks).
 */
const fs = require('fs');
const path = require('path');
const _err = (...a) => { try { process.stderr.write(a.map(String).join(' ') + '\n'); } catch (e) {} };
console.log = _err; console.info = _err; console.warn = _err; console.debug = _err;

(async () => {
  try {
    let subject = process.argv[2] || '';
    if (!subject) {
      try {
        const raw = fs.readFileSync(0, 'utf8');
        if (raw && raw.trim()) { const j = JSON.parse(raw); subject = j.tool_input && (j.tool_input.file_path || j.tool_input.prompt) || j.prompt || ''; }
      } catch (e) {}
    }
    subject = String(subject || '').trim();
    if (!subject) { process.stdout.write('{}'); return; }
    const reward = Math.max(0.1, Math.min(1.0, parseFloat(process.argv[3]) || 0.8));

    const nodeBase = path.join(path.dirname(path.dirname(process.execPath)), 'lib', 'node_modules');
    const aqeBase = path.join(nodeBase, 'agentic-qe');
    const cliBase = path.join(nodeBase, 'ruflo', 'node_modules', '@claude-flow', 'cli');
    if (!fs.existsSync(aqeBase) || !fs.existsSync(cliBase)) { process.stdout.write('{}'); return; }

    // embed the edit subject (384-d MiniLM, matches LoRA inputDim)
    const emb = await import('file://' + path.join(aqeBase, 'dist', 'learning', 'real-embeddings.js'));
    const out = await emb.computeRealEmbedding('edit: ' + subject);
    const vecArr = (out && (out.embedding || out.vector || out.data)) || out;
    if (!vecArr || !vecArr.length) { process.stdout.write('{}'); return; }
    const vec = Float32Array.from(vecArr);

    // train the JS LoRA adapter (the only path that persists A/B to .swarm/lora-weights.json)
    const lora = await import('file://' + path.join(cliBase, 'dist', 'src', 'ruvector', 'lora-adapter.js'));
    const adapter = await lora.getLoRAAdapter();
    if (adapter.config && adapter.config.inputDim && vec.length !== adapter.config.inputDim) { process.stdout.write('{}'); return; }
    adapter.train(vec, vec, reward);
    adapter.saveWeights();
    process.stdout.write('{}');
  } catch (e) {
    process.stdout.write('{}');
  }
})();
