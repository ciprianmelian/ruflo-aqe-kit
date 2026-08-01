#!/usr/bin/env node
/**
 * EMBED-SWEEP-V1 — fill `captured_experiences.embedding` for rows whose vector
 * the capture path lost.
 *
 * WHY: agentic-qe's capture hook INSERTs the experience row, then fires an
 * UN-AWAITED async IIFE that embeds and UPDATEs, wrapped in a bare `catch{}`
 * (dist/cli/chunks/hooks-AGE3HCFI.js; upstream's own comment on the unminified
 * twin reads "Fire-and-forget embedding write"). Under host contention the
 * subprocess exits before the embed lands and the vector is lost silently.
 * Upstream's compensator (ExperienceReplay.initialize) is `void (async …)`,
 * capped at 200 per process boot, and dies with a short-lived process — the
 * same defect class as the hook it exists to cover. Measured: 895 rows on this
 * repo sat NULL, filling only 200 per Claude Code restart.
 *
 * WHAT IT IS NOT: this does NOT repair the capture path, and it must never be
 * read as having done so. It replays a DETERMINISTIC computation that was
 * supposed to happen — verified by re-deriving vectors for rows that already
 * have one and getting cosine 1.000000 across two separate eras. Same function,
 * same text, same config => the exact vector capture would have written.
 *
 * WHO BENEFITS: not Sink A — harvest already trains vecless rows from
 * harvest-derived vectors (HARVEST-EMBED-V1) and its ledger shows no pending
 * work. The beneficiary is `getAllEmbeddings` -> the HNSW `experiences`
 * namespace, which filters on `embedding IS NOT NULL`: every NULL row is
 * invisible to experience retrieval.
 *
 * Writes: .agentic-qe/memory.db (embedding column ONLY), .swarm/embed-sweep-state.json
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const _err = (...a) => { try { process.stderr.write(a.map(String).join(' ') + '\n'); } catch (e) {} };
console.log = _err; console.info = _err; console.warn = _err; console.debug = _err; // stdout is the JSON summary only

const GRACE_MINUTES = 60;   // MUST match probe #15's grace (lib/verify-learning.sh)
const BATCH = 32;           // upstream's own backfill batch size
const BASELINE_SAMPLE = 20;
const BASELINE_MIN_COS = 0.9999;

(async () => {
  const argv = process.argv.slice(2);
  const DRY = argv.includes('--dry-run');
  const JSON_ONLY = argv.includes('--json');
  const limIdx = argv.indexOf('--limit');
  const LIMIT = limIdx >= 0 && argv[limIdx + 1] ? parseInt(argv[limIdx + 1], 10) : 0;

  const PROJ = process.cwd();
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

  // TARGET-ECHO-V1: say what will be touched BEFORE touching it. A flag-first
  // invocation once silently operated on the wrong directory.
  _err(`[embed-sweep] target: ${PROJ}`);
  _err('[embed-sweep] writes: .agentic-qe/memory.db (embedding column only), .swarm/embed-sweep-state.json (ledger)');
  _err('[embed-sweep] this does NOT repair the capture path — it backfills vectors the hook already lost');

  let nodeBase = process.env.KIT_SWEEP_NODE_BASE || '';
  try {
    if (!nodeBase) nodeBase = require('child_process').execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).toString().trim();
  } catch (e) {}
  if (!nodeBase || !fs.existsSync(nodeBase)) {
    nodeBase = path.join(path.dirname(path.dirname(process.execPath)), 'lib', 'node_modules');
  }
  const aqeBase = path.join(nodeBase, 'agentic-qe');
  const srcDb = path.join(PROJ, '.agentic-qe', 'memory.db');
  const ledgerPath = path.join(PROJ, '.swarm', 'embed-sweep-state.json');

  if (!fs.existsSync(srcDb)) { _err('no AQE store at ' + srcDb); out({ eligible: 0, written: 0, note: 'no AQE store' }); return; }

  let Database;
  try { Database = require(path.join(aqeBase, 'node_modules', 'better-sqlite3')); }
  catch (e) { _err('no loadable better-sqlite3: ' + e.message); out({ eligible: 0, written: 0, note: 'no sqlite driver' }); return; }

  let embed;
  try {
    const m = await import('file://' + path.join(aqeBase, 'dist', 'learning', 'real-embeddings.js'));
    embed = m.computeRealEmbedding;
    if (typeof embed !== 'function') throw new Error('no computeRealEmbedding export');
  } catch (e) {
    _err('embedder unavailable (' + e.message + ') — nothing written');
    out({ eligible: 0, written: 0, note: 'embedder unavailable' }); return;
  }

  // Upstream's own recipe for this column (scrubReasoningBlocks + the same slice).
  // The capture hook uses the unscrubbed form; measured, they agree on every row
  // present today, and the scrubbed form is the strictly safer superset.
  const textOf = (r) => String(`${r.domain ?? ''}: ${r.task}`).replace(/<[^>]*>/g, '').slice(0, 512);
  const digestOf = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 32);

  let ledger = { v: 1, sweptIds: [], nonSemanticIds: [], runs: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    ledger = {
      v: 1,
      sweptIds: Array.isArray(raw.sweptIds) ? raw.sweptIds : [],
      nonSemanticIds: Array.isArray(raw.nonSemanticIds) ? raw.nonSemanticIds : [],
      runs: Array.isArray(raw.runs) ? raw.runs.slice(-20) : [],
    };
  } catch (e) {}
  const knownNonSemantic = new Set(ledger.nonSemanticIds);

  const db = new Database(srcDb, { fileMustExist: true });
  db.pragma('busy_timeout = 60000');

  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='captured_experiences' LIMIT 1").get();
  if (!hasTable) { db.close(); out({ eligible: 0, written: 0, note: 'no captured_experiences table' }); return; }

  // ---- IDENTITY GATE ----------------------------------------------------
  // Before writing ANY vector, prove this host's embedder is the one that wrote
  // this store's history. Re-derive vectors for rows that already have one and
  // require near-exact agreement. Without this the sweep could silently become
  // a contamination source of exactly the kind probe #16 exists to catch — and
  // unlike a hash proxy there is NO geometric tell afterwards, because a
  // correct sweep is byte-identical to a correct capture.
  const cos = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / (Math.sqrt(x) * Math.sqrt(y) || 1); };
  const sample = db.prepare(
    'SELECT id, domain, task, embedding FROM captured_experiences WHERE embedding IS NOT NULL AND consolidated_into IS NULL ORDER BY rowid DESC LIMIT ?'
  ).all(BASELINE_SAMPLE);
  if (sample.length < BASELINE_SAMPLE && !argv.includes('--force-no-baseline')) {
    db.close();
    _err(`identity gate NOT ASSESSABLE: only ${sample.length} embedded row(s) to check against (need ${BASELINE_SAMPLE}) — refusing to write. Re-run with --force-no-baseline to override.`);
    out({ eligible: 0, written: 0, note: 'identity gate not assessable' }); return;
  }
  let baselineMin = 1;
  for (const r of sample) {
    const stored = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
    let fresh;
    try { fresh = Float32Array.from(await embed(textOf(r))); }
    catch (e) { db.close(); _err('identity gate FAILED: embedder threw (' + e.message + ') — nothing written'); out({ eligible: 0, written: 0, note: 'identity gate failed' }); return; }
    // A non-finite cosine must FAIL the gate. It arises when the fresh vector
    // has a different length than stored (the loop reads undefined -> NaN), and
    // `NaN < threshold` is FALSE — so without this an embedder returning the
    // wrong dimension sails through the gate that exists to catch exactly that.
    const c = cos(stored, fresh);
    if (!Number.isFinite(c)) { baselineMin = -1; break; }
    if (c < baselineMin) baselineMin = c;
  }
  if (sample.length && baselineMin < BASELINE_MIN_COS) {
    db.close();
    _err(`identity gate FAILED: re-derived vectors match stored history at only cos=${baselineMin.toFixed(6)} (need >= ${BASELINE_MIN_COS}). This host's embedder is NOT the one that wrote this store — writing would contaminate the index. Nothing written.`);
    out({ eligible: 0, written: 0, note: 'identity gate failed', baselineCosMin: baselineMin }); return;
  }
  _err(`identity gate: ${sample.length}/${sample.length} rows re-derive at cos >= ${BASELINE_MIN_COS} (min ${baselineMin.toFixed(6)})`);

  // Modal dimension already in the table — a model swap must not mix dims.
  const modalDim = (db.prepare(
    'SELECT embedding_dimension d, COUNT(*) c FROM captured_experiences WHERE embedding IS NOT NULL GROUP BY d ORDER BY c DESC LIMIT 1'
  ).get() || {}).d || 384;

  // ---- ELIGIBLE ROWS ----------------------------------------------------
  // Upstream's predicate verbatim, plus the SAME 60m grace probe #15 uses:
  // never race the capture path's own pending UPDATE, and never steal #15's
  // signal on rows that would have landed by themselves.
  // NOT filtered on success/quality — that is harvest's Sink A eligibility, not
  // the pool's. getAllEmbeddings reads every non-consolidated row, and a failed
  // experience's vector is exactly what "tried this, it failed" retrieval needs.
  let rows = db.prepare(
    `SELECT id, domain, task FROM captured_experiences
     WHERE embedding IS NULL AND consolidated_into IS NULL
       AND completed_at <= datetime('now','-${GRACE_MINUTES} minutes')
     ORDER BY rowid`
  ).all().filter(r => !knownNonSemantic.has(r.id));
  if (LIMIT > 0) rows = rows.slice(0, LIMIT);

  const texts = new Map();  // digest -> text
  for (const r of rows) { const t = textOf(r); r._t = t; r._d = digestOf(t); if (!texts.has(r._d)) texts.set(r._d, t); }
  _err(`eligible=${rows.length} distinctTexts=${texts.size}${DRY ? ' [dry-run]' : ''}`);

  if (!rows.length) { db.close(); out({ eligible: 0, distinctTexts: 0, written: 0, note: 'nothing eligible' }); return; }

  // ---- EMBED (deduped) --------------------------------------------------
  const vectors = new Map(); // digest -> Float32Array | 'zero' | 'reject'
  let rejectedDim = 0, rejectedNorm = 0, nonSemantic = 0;
  const digests = Array.from(texts.keys());
  for (let i = 0; i < digests.length; i += BATCH) {
    for (const d of digests.slice(i, i + BATCH)) {
      let v;
      try { v = Float32Array.from(await embed(texts.get(d))); }
      catch (e) { vectors.set(d, 'reject'); continue; }
      if (!v.length || !v.every(Number.isFinite)) { vectors.set(d, 'reject'); rejectedNorm++; continue; }
      // An all-zero vector is what computeRealEmbedding returns for text it
      // deems non-semantic — and it does NOT throw. Writing it is WORSE than
      // leaving NULL: getAllEmbeddings would admit it into HNSW, where cosine
      // against a zero vector is degenerate.
      if (!v.some((x) => x !== 0)) { vectors.set(d, 'zero'); continue; }
      if (v.length !== modalDim) { vectors.set(d, 'reject'); rejectedDim++; continue; }
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      if (!(norm > 0.99 && norm < 1.01)) { vectors.set(d, 'reject'); rejectedNorm++; continue; }
      vectors.set(d, v);
    }
  }

  // ---- WRITE ------------------------------------------------------------
  let written = 0, raced = 0, wouldWrite = 0;
  const sweptNow = [], nonSemanticNow = [];
  if (DRY) {
    for (const r of rows) { const v = vectors.get(r._d); if (v === 'zero') { nonSemantic++; } else if (v && v !== 'reject') wouldWrite++; }
  } else {
    // Backup before the first write. sqlite3 .backup semantics via the driver —
    // never `cp`, which on a live WAL store silently copies the PRE-write state.
    try {
      const bdir = path.join(PROJ, '.agentic-qe');
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
      await db.backup(path.join(bdir, `memory.db.pre-embed-sweep-${stamp}.bak`));
    } catch (e) { _err('backup failed (' + e.message + ') — refusing to write'); db.close(); out({ eligible: rows.length, written: 0, note: 'backup failed' }); return; }

    // `AND embedding IS NULL` is load-bearing: it can never overwrite a vector a
    // concurrent capture or upstream backfill just wrote. changes===0 means
    // somebody else won the row — that is `raced`, not `written`.
    const stmt = db.prepare('UPDATE captured_experiences SET embedding=?, embedding_dimension=? WHERE id=? AND embedding IS NULL');
    // One transaction PER BATCH, never one for the whole run: a kill loses at
    // most the in-flight batch, and every committed row is permanently ineligible.
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH).filter((r) => {
        const v = vectors.get(r._d);
        if (v === 'zero') { nonSemantic++; nonSemanticNow.push(r.id); return false; }
        return v && v !== 'reject';
      });
      if (!chunk.length) continue;
      const apply = db.transaction((cs) => {
        for (const r of cs) {
          const v = vectors.get(r._d);
          const info = stmt.run(Buffer.from(v.buffer, v.byteOffset, v.byteLength), v.length, r.id);
          if (info.changes === 1) { written++; sweptNow.push(r.id); } else raced++;
        }
      });
      // .immediate() takes the write lock UP FRONT. A deferred BEGIN that reads
      // before writing can fail SQLITE_BUSY_SNAPSHOT, which `busy_timeout` does
      // NOT wait on — measured against three concurrent writers: deferred
      // read-then-write 0/2650 with every retry burned, IMMEDIATE 2650/2650.
      // Our SELECT is already outside the transaction, so this is belt-and-
      // braces; it costs nothing and removes the failure mode entirely.
      try { apply.immediate(chunk); } catch (e) { _err('batch write failed (' + e.message + ') — stopping, committed batches stand'); break; }
    }
  }

  // Post-run recount FROM DISK: never trust the runtime's own claim about what
  // it wrote (the persist_check precedent in fix-learning).
  const remainingNull = db.prepare(
    'SELECT COUNT(*) c FROM captured_experiences WHERE embedding IS NULL AND consolidated_into IS NULL'
  ).get().c;
  db.close();

  if (!DRY && (sweptNow.length || nonSemanticNow.length)) {
    try {
      fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
      ledger.sweptIds = Array.from(new Set(ledger.sweptIds.concat(sweptNow)));
      ledger.nonSemanticIds = Array.from(new Set(ledger.nonSemanticIds.concat(nonSemanticNow)));
      ledger.runs = ledger.runs.concat([{ at: new Date().toISOString(), eligible: rows.length, distinctTexts: texts.size, written, raced, nonSemantic, baselineCosMin: baselineMin }]).slice(-20);
      fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
    } catch (e) { _err('ledger write failed: ' + e.message); }
  }

  _err(`[embed-sweep] the capture path is UNCHANGED — probe #15 will keep reporting it, and should`);
  out({
    eligible: rows.length, distinctTexts: texts.size,
    written, wouldWrite, raced, nonSemantic, rejectedDim, rejectedNorm,
    remainingNull, baselineCosMin: Number(baselineMin.toFixed(8)), dryRun: DRY,
  });
})().catch((e) => { _err('FATAL:', e && e.message); process.exit(1); });
