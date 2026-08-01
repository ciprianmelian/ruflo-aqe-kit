#!/usr/bin/env node
/*
 * AQE-HARVEST-V1 — batch-replay AQE's recorded experiences into the dormant ruflo
 * substrate, WITHOUT a second live hook competing for events.
 *   Sink A: ruflo SONA LoRA  — getLoRAAdapter().train(emb, emb, quality) -> .swarm/lora-weights.json
 *   Sink B: AgentDB          — reflexion.storeEpisode + skills.createSkill -> agentdb.db
 * Source DB (.agentic-qe/memory.db) is opened READ-ONLY. Idempotent via a writable
 * .swarm/harvest-state.json ledger (source stays read-only). Causal edges are SKIPPED
 * (no real cause->effect pairs in the data — Integrity Rule: no fabricated relations).
 * HARVEST-EMBED-V1: embedding-NULL rows (capture's async embed lost the race with
 * subprocess exit) get their vector DERIVED here with the exact upstream recipe, so
 * ledger consumption no longer turns a timing gap into a train-never for Sink A.
 * Run from the project root. Usage: node scripts/aqe-harvest.cjs
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const _err = (...a) => { try { process.stderr.write(a.map(String).join(' ') + '\n'); } catch (e) {} };
console.log = _err; console.info = _err; console.warn = _err; console.debug = _err; // keep stdout clean for the summary

(async () => {
  const PROJ = process.cwd();
  // TARGET-ECHO-V1 (B14 silent-wrong-target): bench/dashboard/harvest resolve
  // their target by inspecting ONLY $1 (bin/ruflo-kit _kit_firstarg_resolve) —
  // a flag-first invocation (e.g. `harvest --status <target>`) silently falls
  // back to cwd instead of the intended target, and this tool has no way to
  // tell that fallback apart from an explicit `.` (the dispatcher has already
  // cd'd us into whatever it resolved by the time we run). Printing the
  // resolved directory unconditionally, before any read or write, is what
  // turns a silent wrong-target into a visible one — dashboard.cjs already
  // does this in its startup banner; harvest previously echoed nothing.
  // Stderr (not stdout): the tool's stdout contract is exactly one JSON
  // summary line consumed by callers (see the `console.log = _err` override
  // above and tests/harvest-embed.test.js's `.split('\n').pop()` parse) —
  // stderr keeps that contract untouched while still reaching an interactive
  // terminal, which is the actual failure mode this fixes.
  _err(`[aqe-harvest] target: ${PROJ}`);
  _err('[aqe-harvest] writes: .swarm/lora-weights.json (Sink A: ruflo LoRA), agentdb.db (Sink B: reflexion+skills), .swarm/harvest-state.json (ledger)  |  reads read-only: .agentic-qe/memory.db');
  // Global node_modules: `npm root -g` is the truth (a custom npm prefix like
  // ~/.npm-global diverges from the execPath-derived guess, e.g. system node at
  // /usr/bin/node with globals elsewhere); execPath stays as the offline fallback.
  // KIT_HARVEST_NODE_BASE overrides for the kit's own tests (stub toolchain tree,
  // KIT_RUFLO_DIST_SRC precedent) — never set it in live operation.
  let nodeBase = process.env.KIT_HARVEST_NODE_BASE || '';
  try {
    if (!nodeBase) nodeBase = require('child_process').execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).toString().trim();
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

  // HARVEST-LEDGER-V2: three outcomes, not two. v1 wrote EVERY fresh row's id
  // into `ids` regardless of whether Sink A trained it, and `ids` is the sole
  // eligibility filter — so a row that produced no vector was consumed forever
  // and could never train, even once the embedder was repaired. Measured at the
  // time of the fix: 957 such rows on this repo, 589 on the gauntlet target.
  //
  //   trained   -> ids           (its text digest is recorded in trainedTexts)
  //   redundant -> ids           TERMINAL: a duplicate text today is a duplicate
  //                              forever, so re-offering it can never help
  //   deferred  -> pendingSinkA  RETRIED: no vector obtainable YET; a working
  //                              embedder makes it useful, so it must not burn
  //
  // Migration is additive and lossless: a v1 ledger (no `v`) reads as v2 with
  // empty pendingSinkA/trainedTexts, so the burn stops from the next run with
  // zero risk and nothing re-harvested. Rewinding already-burned ids is a
  // separate, explicit opt-in (--reclaim) — never automatic.
  let ledger = { v: 2, ids: [], pendingSinkA: [], trainedTexts: {}, lastRowid: 0 };
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    ledger = {
      v: 2,
      ids: Array.isArray(raw.ids) ? raw.ids : [],
      pendingSinkA: Array.isArray(raw.pendingSinkA) ? raw.pendingSinkA : [],
      trainedTexts: (raw.trainedTexts && typeof raw.trainedTexts === 'object') ? raw.trainedTexts : {},
      lastRowid: raw.lastRowid || 0,
    };
  } catch (e) {}
  const RECLAIM = process.argv.slice(2).includes('--reclaim');

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
  // HARVEST-VECLESS-V1: aqe's capture paths write the experience row FIRST and
  // embed async-after (hook subprocess + middleware, both fire-and-forget with a
  // bare catch) — the freshest rows lose that race and read embedding-NULL here.
  // Sink B (reflexion.storeEpisode) needs no vector — the task/output/reward/
  // success columns are complete real data — so vecless rows always harvest to
  // Sink B. Sink A keeps its per-row vector guard (never train on a missing or
  // wrong-dim vector); since HARVEST-EMBED-V1 (below, in the Sink A loop) a
  // vecless row's vector is DERIVED at harvest time with the exact upstream
  // recipe instead of being skipped — because the ledger consumes rows
  // permanently, a skip here was a train-never for that row even after
  // upstream's lazy backfill filled the pool column. verify-learning probe #2
  // mirrors the SELECT filter below — keep the two byte-identical.
  const rows = db.prepare(
    'SELECT rowid, id, task, agent, domain, success, quality, result_json, embedding ' +
    'FROM captured_experiences WHERE success=1 AND quality>=0.7 ORDER BY rowid'
  ).all();
  db.close();
  // HARVEST-RECLAIM-V1 (opt-in, --reclaim): rewind rows that v1 burned. A row
  // still holding embedding NULL provably never trained Sink A — v1's own guard
  // skipped it — so moving it ids -> pendingSinkA re-offers it for Sink A only,
  // with no Sink B replay and therefore no duplicate episodes.
  //
  // GATED, because the premise is checkable and must not be assumed: if ANY past
  // run reported trainedEmbeddedAtHarvest > 0, then some NULL-embedding row WAS
  // derived and trained, and the attribution log records only a COUNT — not
  // which ids. That is exactly a "cannot tell", so refuse rather than guess.
  if (RECLAIM) {
    let derivedEver = 0, gateReadable = false;
    try {
      const lines = fs.readFileSync(path.join(PROJ, '.claude-flow', 'trajectory-attribution.jsonl'), 'utf8')
        .split('\n').filter(Boolean);
      gateReadable = true;
      for (const ln of lines) {
        try { const j = JSON.parse(ln); if (j.source === 'harvest-sinkA') derivedEver += (j.trainedEmbeddedAtHarvest || 0); } catch (e) {}
      }
    } catch (e) { gateReadable = false; }
    const ledgered = (ledger.ids || []).length;
    if (!gateReadable && ledgered > 0) {
      _err('RECLAIM REFUSED: no readable .claude-flow/trajectory-attribution.jsonl, so it cannot be shown that the burned rows never trained. Not guessing.');
    } else if (derivedEver > 0) {
      _err(`RECLAIM REFUSED: ${derivedEver} row(s) were previously derived-and-trained at harvest time, and attribution records only counts, not ids — the untrained set cannot be identified. Not guessing.`);
    } else {
      const vecless = new Set(rows.filter(r => !(r.embedding && r.embedding.byteLength >= 4)).map(r => r.id));
      const moved = [];
      ledger.ids = (ledger.ids || []).filter(id => (vecless.has(id) ? (moved.push(id), false) : true));
      ledger.pendingSinkA = Array.from(new Set((ledger.pendingSinkA || []).concat(moved)));
      _err(`RECLAIM: ${moved.length} burned vecless row(s) returned to pendingSinkA (Sink A retry only)`);
    }
  }

  const done = new Set(ledger.ids || []);
  const pending = new Set(ledger.pendingSinkA || []);
  const fresh = rows.filter(r => !done.has(r.id) && !pending.has(r.id));
  // Deferred rows get a Sink A RETRY only. Sink B already stored them and its
  // storeEpisode is a bare INSERT with no unique constraint (verified against
  // agentdb's ReflexionMemory dist: episodes.id is AUTOINCREMENT, the harvester
  // passes no id), so replaying them through Sink B would duplicate 1:1 —
  // episodes count equals ledger size exactly on both live targets today.
  const retry = rows.filter(r => pending.has(r.id));
  _err(`harvestable=${rows.length} fresh=${fresh.length} retrySinkA=${retry.length}`);
  if (!fresh.length && !retry.length) { process.stdout.write(JSON.stringify({ trained: 0, skills: 0, episodes: 0, note: 'nothing fresh' }) + '\n'); return; }

  // ---- Sink A: ruflo SONA LoRA (proven direct primitive) ----
  // TRAJ-ATTR-V1: the harvester is one of the writer paths into .swarm/lora-weights.json
  // (direct adapter.train(), bypassing recordTrajectory). Bracket the Sink A pass with a
  // weights fingerprint and append one attribution row, so an eval-side learning delta
  // can be attributed to harvest-replay vs the per-turn Stop hook instead of confounded.
  // Best-effort: a missing module or read-only fs must never break the harvest.
  let trajAttr = null;
  try { trajAttr = require(path.join(__dirname, 'trajectory-attribution.cjs')); } catch (e) {}
  const trajAttrBefore = trajAttr ? trajAttr.snapshotWeights(PROJ) : null;
  let trained = 0, trainedEmbeddedAtHarvest = 0, redundantSinkA = 0, deferredSinkA = 0, degenerateSinkA = 0;
  const outcomeTerminal = new Set();   // trained | redundant | degenerate  -> ids
  const outcomeDeferred = new Set();   // no usable vector YET              -> pendingSinkA
  try {
    const lora = await import('file://' + path.join(cliBase, 'dist', 'src', 'ruvector', 'lora-adapter.js'));
    const adapter = await lora.getLoRAAdapter();
    const dim = adapter.config && adapter.config.inputDim;
    // HARVEST-EMBED-V1: lazy singleton for the MiniLM embedder — loaded only if a
    // vecless row is actually encountered, and only tried once per run.
    let embedFn = null, embedTried = false;
    const getEmbedder = async () => {
      if (embedTried) return embedFn;
      embedTried = true;
      try {
        const m = await import('file://' + path.join(aqeBase, 'dist', 'learning', 'real-embeddings.js'));
        if (m && typeof m.computeRealEmbedding === 'function') embedFn = m.computeRealEmbedding;
        else _err('HARVEST-EMBED-V1: real-embeddings.js exports no computeRealEmbedding — vecless rows stay SinkB-only');
      } catch (e) { _err('HARVEST-EMBED-V1: embedder unavailable (' + e.message + ') — vecless rows stay SinkB-only'); }
      return embedFn;
    };
    // Retry first: deferred rows owe Sink A a pass, and they are older, so they
    // should claim a text digest before a newer duplicate does.
    for (const r of retry.concat(fresh)) {
      const embedText = (String(r.domain || '') + ': ' + String(r.task || '')).slice(0, 512);
      const digest = crypto.createHash('sha256').update(embedText).digest('hex').slice(0, 32);
      // HARVEST-DEDUPE-V1: train at most ONCE per distinct embed text, cumulative
      // across runs. Sink A's objective is adapter.train(v, v, quality) — a
      // RECONSTRUCTION, input === target — so the 2nd..Nth presentation of an
      // identical vector contributes zero new information and only reweights that
      // one direction against every other. Measured consequence of not doing
      // this: a target whose capture hook wrote 3137 identical content-free rows
      // accumulated 5611 updates on ~1 direction, 25x this repo's adaptation-norm
      // sum and 43x its max |B|. If duplicate frequency should ever count as
      // importance, it belongs in the bounded `quality` arg — never as unbounded
      // repetition. Keyed on the input STRING, so it never depends on float
      // stability (the pipeline is deterministic, but the guard does not rely on it).
      if (ledger.trainedTexts[digest]) {
        ledger.trainedTexts[digest]++;
        redundantSinkA++; outcomeTerminal.add(r.id);
        continue;
      }
      let v = null, derived = false;
      const b = r.embedding;
      if (b && b.byteLength >= 4) {
        v = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
      } else {
        // HARVEST-EMBED-V1: derive the missing vector with the EXACT upstream
        // recipe — real-embeddings.js MiniLM over `${domain}: ${task}`.slice(0,512),
        // the same model/text/dim the middleware backfill writes to the pool. A
        // deterministic derivation from the row's real text, not a fabricated
        // vector. Source db stays read-only: the pool's embedding column remains
        // upstream's to fill. On any failure the row degrades to SinkB-only,
        // exactly the pre-V1 behavior.
        const embed = await getEmbedder();
        if (embed) {
          try {
            const out = await embed(embedText);
            const arr = (out && (out.embedding || out.vector || out.data)) || out;
            if (arr && arr.length) { v = Float32Array.from(arr); derived = true; }
          } catch (e) { _err('HARVEST-EMBED-V1: embed failed for ' + r.id + ' (' + e.message + ')'); }
        }
      }
      // DEFERRED, not burned: no usable vector YET. A repaired embedder (or
      // upstream's lazy backfill) makes this row trainable, so it must stay
      // eligible instead of being consumed for nothing — the v1 defect.
      if (!v || (dim && v.length !== dim)) { deferredSinkA++; outcomeDeferred.add(r.id); continue; }
      // TERMINAL: computeRealEmbedding returns an all-zero vector for text it
      // deems non-semantic (JSON metrics, UUIDs, low alpha-ratio). It does not
      // throw, so without this guard a zero vector reads as a valid derivation
      // and trains the adapter toward the origin. Deterministic in the text, so
      // it can never become useful — consume it rather than retry forever.
      if (!v.some((x) => x !== 0)) { degenerateSinkA++; outcomeTerminal.add(r.id); continue; }
      adapter.train(v, v, r.quality);
      ledger.trainedTexts[digest] = 1;
      trained++;
      if (derived) trainedEmbeddedAtHarvest++;
      outcomeTerminal.add(r.id);
    }
    adapter.saveWeights();
  } catch (e) { _err('SinkA(LoRA) failed:', e.message); }
  // TRAJ-ATTR-V1: record the Sink A pass (even trained=0 — "harvest ran, trained
  // nothing" is itself attribution: a weights change in that window is NOT ours).
  if (trajAttr) {
    trajAttr.appendEvent(PROJ, {
      source: 'harvest-sinkA',
      trained, trainedEmbeddedAtHarvest, freshRows: fresh.length,
      weightsBefore: trajAttrBefore,
      weightsAfter: trajAttr.snapshotWeights(PROJ),
    });
  }

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
    const idSet = new Set(ledger.ids || []);
    const stillPending = new Set();
    // A previously-deferred row is promoted to terminal only if this run settled
    // it; otherwise it stays pending for the next attempt.
    for (const id of ledger.pendingSinkA || []) {
      if (outcomeTerminal.has(id)) idSet.add(id); else stillPending.add(id);
    }
    // A fresh row Sink A never REACHED (e.g. the adapter import threw) is
    // deferred, never dropped: Sink B has already stored its episode, and
    // storeEpisode is a bare INSERT, so re-offering it as fresh would duplicate.
    for (const r of fresh) {
      if (outcomeTerminal.has(r.id)) idSet.add(r.id); else stillPending.add(r.id);
    }
    const seen = retry.concat(fresh);
    const lastRowid = seen.length
      ? Math.max(ledger.lastRowid || 0, ...seen.map(r => r.rowid))
      : (ledger.lastRowid || 0);
    fs.writeFileSync(ledgerPath, JSON.stringify({
      v: 2,
      ids: Array.from(idSet),
      pendingSinkA: Array.from(stillPending),
      trainedTexts: ledger.trainedTexts,
      lastRowid,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  } catch (e) { _err('ledger write failed:', e.message); }

  process.stdout.write(JSON.stringify({
    trained, trainedEmbeddedAtHarvest,
    redundantSinkA, degenerateSinkA, deferredSinkA,
    skills, episodes,
    freshConsumed: fresh.length, retriedSinkA: retry.length,
  }) + '\n');
})().catch(e => { _err('FATAL:', e.message); process.exit(1); });
