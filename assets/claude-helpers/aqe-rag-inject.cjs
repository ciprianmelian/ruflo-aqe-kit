#!/usr/bin/env node
/*
 * AQE-RAG-INJECT-V1 — pre-task semantic retrieval over AQE captured_experiences.
 * Emits {hookSpecificOutput.additionalContext} with the top-k prior experiences
 * most similar to the current task, turning the embedded experience store into a
 * working RAG loop. Read-only; imports ONLY AQE leaf modules (never the fleet
 * bootstrap, which OOMs); always exits 0 so it can never block a Task spawn.
 */
const fs = require('fs');
const path = require('path');

// Keep stdout clean for the hook JSON: AQE's embedder logs "[RealEmbeddings] ..."
// via console.log to stdout. Route all console output to stderr; only our final
// process.stdout.write emits the hook payload.
const _err = (...a) => { try { process.stderr.write(a.map(String).join(' ') + '\n'); } catch (e) {} };
console.log = _err; console.info = _err; console.warn = _err; console.debug = _err;

// NPM-ROOT-RESOLVE-V1: global node_modules via `npm root -g` (custom npm
// prefixes diverge from the execPath guess); wrapped require so a target that
// predates _npm-root.cjs degrades to the old inline derivation.
let npmRootG;
try { npmRootG = require(path.join(__dirname, '_npm-root.cjs')); }
catch (e) { npmRootG = () => path.join(path.dirname(path.dirname(process.execPath)), 'lib', 'node_modules'); }

(async () => {
  try {
    // 1. task text from argv or stdin event JSON
    let task = process.argv[2] || '';
    if (!task) {
      try {
        const raw = fs.readFileSync(0, 'utf8');
        if (raw && raw.trim()) {
          const j = JSON.parse(raw);
          task = j.prompt || (j.tool_input && (j.tool_input.prompt || j.tool_input.description)) || '';
        }
      } catch (e) { /* no stdin */ }
    }
    task = String(task || '').trim();
    if (!task) { process.stdout.write('{}'); return; }

    // 2. resolve the global agentic-qe install (npm root -g, execPath fallback)
    const base = path.join(npmRootG(), 'agentic-qe');
    const projDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const dbPath = path.join(projDir, '.agentic-qe', 'memory.db');
    if (!fs.existsSync(base) || !fs.existsSync(dbPath)) { process.stdout.write('{}'); return; }

    // 3. embed the query via AQE's MiniLM (leaf module only — no fleet bootstrap)
    const mod = await import('file://' + path.join(base, 'dist', 'learning', 'real-embeddings.js'));
    const out = await mod.computeRealEmbedding(task);
    // computeRealEmbedding may return the vector directly (typed array) or wrapped
    const arr = (out && (out.embedding || out.vector || out.data)) || out;
    if (!arr || !arr.length) { process.stdout.write('{}'); return; }
    const qvec = Float32Array.from(arr);

    // 4. read embedded experiences (read-only)
    const Database = require(path.join(base, 'node_modules', 'better-sqlite3'));
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare(
      'SELECT task, agent, domain, success, quality, embedding FROM captured_experiences WHERE embedding IS NOT NULL'
    ).all();
    db.close();

    // 5. cosine score (inline; same space, 384-dim Float32LE blobs)
    const cos = (a, b) => {
      let d = 0, na = 0, nb = 0;
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
      return (na && nb) ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
    };
    const scored = [];
    for (const r of rows) {
      const buf = r.embedding;
      if (!buf || buf.byteLength < 4) continue;
      const vec = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
      const s = cos(qvec, vec);
      if (s >= 0.40) scored.push({ s, r });
    }
    scored.sort((a, b) => b.s - a.s);
    // de-dup near-identical tasks so the top-k are distinct
    const seen = new Set();
    const top = [];
    for (const x of scored) {
      const key = String(x.r.task || '').slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      top.push(x);
      if (top.length >= 3) break;
    }
    if (!top.length) { process.stdout.write('{}'); return; }

    // 6. emit additionalContext
    const lines = top.map((t, i) => {
      const r = t.r;
      const ok = (r.success ? 'ok' : 'fail');
      return `${i + 1}. [sim ${t.s.toFixed(2)} · ${ok} · q${(r.quality || 0).toFixed(2)} · ${r.agent}/${r.domain}] ${String(r.task || '').slice(0, 140)}`;
    });
    const ctx = 'Prior QE experiences relevant to this task (AQE memory, top ' + top.length + '):\n' + lines.join('\n');
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: ctx } }));
  } catch (e) {
    process.stdout.write('{}');
  }
})();
