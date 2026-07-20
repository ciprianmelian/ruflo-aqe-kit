#!/usr/bin/env node
/*
 * AQE-HARVEST-V1 — batch-replay AQE's recorded experiences into the dormant ruflo
 * substrate, WITHOUT a second live hook competing for events.
 *   Sink A: ruflo SONA LoRA  — getLoRAAdapter().train(emb, emb, quality) -> .swarm/lora-weights.json
 *   Sink B: AgentDB          — reflexion.storeEpisode + skills.createSkill -> agentdb.db
 * Source DB (.agentic-qe/memory.db) is opened READ-ONLY. Idempotent via a writable
 * .swarm/harvest-state.json ledger (source stays read-only). Causal edges are SKIPPED
 * (no real cause->effect pairs in the data — Integrity Rule: no fabricated relations).
 * Run from the project root. Usage: node scripts/aqe-harvest.cjs
 */
const fs = require('fs');
const path = require('path');
const _err = (...a) => { try { process.stderr.write(a.map(String).join(' ') + '\n'); } catch (e) {} };
console.log = _err; console.info = _err; console.warn = _err; console.debug = _err; // keep stdout clean for the summary

(async () => {
  const PROJ = process.cwd();
  // Global node_modules: `npm root -g` is the truth (a custom npm prefix like
  // ~/.npm-global diverges from the execPath-derived guess, e.g. system node at
  // /usr/bin/node with globals elsewhere); execPath stays as the offline fallback.
  let nodeBase;
  try {
    nodeBase = require('child_process').execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).toString().trim();
  } catch (e) {}
  if (!nodeBase || !fs.existsSync(nodeBase)) {
    nodeBase = path.join(path.dirname(path.dirname(process.execPath)), 'lib', 'node_modules');
  }
  const aqeBase = path.join(nodeBase, 'agentic-qe');
  const cliBase = path.join(nodeBase, 'ruflo', 'node_modules', '@claude-flow', 'cli');
  const adbBase = path.join(nodeBase, 'ruflo', 'node_modules', 'agentdb');
  const srcDb = path.join(PROJ, '.agentic-qe', 'memory.db');
  const ledgerPath = path.join(PROJ, '.swarm', 'harvest-state.json');

  if (!fs.existsSync(srcDb)) { _err('no AQE memory.db at ' + srcDb); process.exit(1); }

  let ledger = { ids: [], lastRowid: 0 };
  try { ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); } catch (e) {}
  const done = new Set(ledger.ids || []);

  const Database = require(path.join(aqeBase, 'node_modules', 'better-sqlite3'));
  const db = new Database(srcDb, { readonly: true, fileMustExist: true });
  // Fresh/hollow AQE store: captured_experiences may not exist yet (no AQE
  // post-task/post-edit hooks have fired). Treat as "nothing to harvest" and exit
  // cleanly instead of FATAL-ing — fix-learning step 11 and SessionEnd rely on this
  // graceful path on fresh projects (else every fresh-project harvest "fails").
  const hasSrc = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='captured_experiences' LIMIT 1"
  ).get();
  if (!hasSrc) {
    db.close();
    process.stdout.write(JSON.stringify({ trained: 0, skills: 0, episodes: 0, note: 'no captured_experiences table (fresh AQE store — nothing to harvest)' }) + '\n');
    return;
  }
  // HARVEST-VECLESS-V1: aqe 3.12.2's capture hook stores experiences WITHOUT
  // embeddings (observed on the first fresh-target e2e: 5 real edit experiences,
  // all embedding-NULL). Sink B (reflexion.storeEpisode) needs no vector — the
  // task/output/reward/success columns are complete real data — so requiring an
  // embedding here silently discarded every session experience. Embedding-less
  // rows now harvest to Sink B only; Sink A keeps its per-row vector guard (no
  // fabricated training vectors). verify-learning probe #2 mirrors this filter —
  // keep the two byte-identical.
  const rows = db.prepare(
    'SELECT rowid, id, task, agent, domain, success, quality, result_json, embedding ' +
    'FROM captured_experiences WHERE success=1 AND quality>=0.7 ORDER BY rowid'
  ).all();
  db.close();
  const fresh = rows.filter(r => !done.has(r.id));
  _err(`harvestable=${rows.length} fresh=${fresh.length}`);
  if (!fresh.length) { process.stdout.write(JSON.stringify({ trained: 0, skills: 0, episodes: 0, note: 'nothing fresh' }) + '\n'); return; }

  // ---- Sink A: ruflo SONA LoRA (proven direct primitive) ----
  let trained = 0;
  try {
    const lora = await import('file://' + path.join(cliBase, 'dist', 'src', 'ruvector', 'lora-adapter.js'));
    const adapter = await lora.getLoRAAdapter();
    const dim = adapter.config && adapter.config.inputDim;
    for (const r of fresh) {
      const b = r.embedding;
      if (!b || b.byteLength < 4) continue;
      const v = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
      if (dim && v.length !== dim) continue;
      adapter.train(v, v, r.quality);
      trained++;
    }
    adapter.saveWeights();
  } catch (e) { _err('SinkA(LoRA) failed:', e.message); }

  // ---- Sink B: AgentDB reflexion + skills (node import; no MCP) ----
  let skills = 0, episodes = 0;
  try {
    const m = await import('file://' + path.join(adbBase, 'dist', 'src', 'index.js'));
    const AgentDB = m.AgentDB || m.default;
    const adb = new AgentDB({ dbPath: path.join(PROJ, 'agentdb.db') });
    if (adb.initialize) await adb.initialize();
    const seenDomain = new Set();
    for (const r of fresh) {
      try {
        await adb.reflexion.storeEpisode({
          sessionId: 'aqe-harvest', task: String(r.task || '').slice(0, 200),
          input: String(r.task || ''), output: String(r.result_json || ''),
          critique: '', reward: r.quality, success: !!r.success,
        });
        episodes++;
      } catch (e) {}
      if (r.domain && !seenDomain.has(r.domain)) {
        seenDomain.add(r.domain);
        try {
          await adb.skills.createSkill({
            name: ('aqe-' + r.domain).slice(0, 80), description: 'Harvested from AQE ' + r.domain + ' experiences',
            code: '', successRate: r.quality, uses: 0, avgReward: r.quality,
            metadata: { source: 'aqe-harvest', domain: r.domain },
          });
          skills++;
        } catch (e) {}
      }
    }
    if (adb.close) await adb.close();
  } catch (e) { _err('SinkB(AgentDB) failed:', e.message); }

  // Checkpoint agentdb.db: better-sqlite3 leaves it in WAL mode, after which a
  // read-only consumer (the statusline's `sqlite3 -readonly`) fails with
  // CANTOPEN(14) — it can't create the -shm needed to read the WAL. TRUNCATE
  // flushes the WAL into the main db and removes the sidecar so reads always work.
  try { require('child_process').execSync('sqlite3 "' + path.join(PROJ, 'agentdb.db') + '" "PRAGMA wal_checkpoint(TRUNCATE);"', { timeout: 5000, stdio: 'ignore' }); } catch (e) { _err('agentdb.db checkpoint failed:', e.message); }

  // ---- update idempotency ledger ----
  try {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const newIds = (ledger.ids || []).concat(fresh.map(r => r.id));
    const lastRowid = Math.max(ledger.lastRowid || 0, ...fresh.map(r => r.rowid));
    fs.writeFileSync(ledgerPath, JSON.stringify({ ids: newIds, lastRowid, updatedAt: new Date().toISOString() }, null, 2));
  } catch (e) { _err('ledger write failed:', e.message); }

  process.stdout.write(JSON.stringify({ trained, skills, episodes, freshConsumed: fresh.length }) + '\n');
})().catch(e => { _err('FATAL:', e.message); process.exit(1); });
