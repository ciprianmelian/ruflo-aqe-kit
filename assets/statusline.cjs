#!/usr/bin/env node
/**
 * RuFlo V3 Statusline — delegation build (#2195)
 *
 * Fix for ruvnet/ruflo#2195: the previous version re-implemented all data
 * readers locally using fragile file probes that missed AgentDB patterns,
 * the v3/docs/adr/ ADR directory, and the real vector count.
 *
 * This version delegates to 'npx @claude-flow/cli hooks statusline --json'
 * as the single source of truth. That command queries AgentDB directly,
 * counts ADRs in both directories, and reports the real intelligence pct.
 *
 * ADR counting falls back to local file reads so the display still works
 * without network access (counts both v3/docs/adr/ and v3/implementation/adrs/).
 *
 * Cache: JSON result is cached in /tmp for 10s so rapid prompt triggers
 * (every keystroke in some shells) don't hammer the CLI on every call.
 *
 * Usage: node statusline.cjs [--json] [--compact] [--dashboard]
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const os = require('os');

// Configuration
const CONFIG = {
  maxAgents: 15,
};

const CWD = process.cwd();

// DAEMON-AUTOSTART-3-V1: ruflo >=3.32 auto-spawns a detached background daemon
// on EVERY CLI invocation (services/daemon-autostart.js via index.js) — and this
// statusline shells out to `ruflo hooks …` on a 5-second refresh, making the
// statusline itself a daemon-resurrection channel (observed: 12 daemons, one
// per cwd ever rendered, incl. test fixtures). The daemon is billed-risk and
// opt-in by project policy. Children inherit env, so pinning here gates every
// exec site below. Respects an explicit operator override.
if (process.env.RUFLO_DAEMON_AUTOSTART === undefined) process.env.RUFLO_DAEMON_AUTOSTART = '0';

// TRUTH-SL-V1: every displayed value is re-derivable from disk ("never assume,
// always prove"). The audit (docs/STATUSLINE-AUDIT-2026-07-18.md) graded ~40 chips
// and found 8 cosmetic / 2 free-running-counter / 4 stale values sourced from
// upstream `ruflo hooks statusline --json` and kit bucket-labels. This file now
// overlays those chips with measured store liveness, a real swarm registry
// (.claude-flow/swarm/swarm-state.json), stored episode/pattern counts, an indexed
// vector count (no fabricated Nx speedup), real test-case counts, and a real model
// id — deleting the intelligence-stats CLI exec (a counter source AND a
// daemon-spawn channel). Each override carries a `// TRUTH-SL-V1:` provenance note.


// ─── Delegation cache ───────────────────────────────────────────
// Cache the CLI JSON result for 10s so rapid prompt re-renders
// (e.g. every keypress in some shells) don't re-invoke npx each time.
const CACHE_FILE = path.join(os.tmpdir(), 'ruflo-statusline-cache-' + require('crypto').createHash('md5').update(CWD).digest('hex').slice(0, 8) + '.json');
const CACHE_TTL_MS = 10000;

function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      if (raw && raw._ts && (Date.now() - raw._ts) < CACHE_TTL_MS) {
        return raw.data;
      }
    }
  } catch { /* ignore */ }
  return null;
}

function writeCache(data) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ _ts: Date.now(), data }), 'utf-8'); } catch { /* ignore */ }
}

/**
 * Single source of truth: delegate to the CLI hooks statusline --json command.
 * Falls back to a minimal static object on failure so the statusline still renders.
 *
 * Fix for ruflo#2195: the previous local readers returned 0 for AgentDB patterns
 * (missed the .swarm/memory.db → AgentDB path), computed dddProgress wrong,
 * and only counted ADRs in v3/implementation/adrs/ (missed v3/docs/adr/).
 */
// AQE310-REALIGN-V1: overlay AgentDB/MCP/hooks blocks that `ruflo hooks statusline --json` omits.
function _ra_count(db, sql) {
  if (!fs.existsSync(db)) return 0;
  try { const o = execFileSync('sqlite3', ['-readonly', db, sql], { timeout: 2000, stdio: ['ignore','pipe','ignore'] }).toString(); const n = parseInt(o, 10); return Number.isFinite(n) ? n : 0; } catch (e) { return 0; }
}
function _ra_tbl(db, t) {
  if (!fs.existsSync(db)) return false;
  try { return execFileSync('sqlite3', ['-readonly', db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='" + t + "' LIMIT 1;"], { timeout: 2000, stdio: ['ignore','pipe','ignore'] }).toString().trim() === '1'; } catch (e) { return false; }
}
function _ra_dbkb(db) {
  let kb = 0;
  for (const suf of ['', '-wal', '-shm']) {
    try { kb += fs.statSync(db + suf).size / 1024; } catch (e) {}
  }
  return kb;
}

// TRUTH-SL-V1: liveness of the 5 real learning stores (replaces the cosmetic
// "5/5 domains" = floor(memory.db_KB/2) bucket). A store counts as live when its
// file is present AND non-empty (dbs: size>0; lora: a trained B vector; routing:
// a real rolling window, not just an empty scaffold). detail[] carries per-store
// truth so tests / dashboard can prove each one.
function _ra_stores() {
  const detail = [];
  function statSize(rel) { try { return fs.statSync(path.join(CWD, rel)).size; } catch (e) { return -1; } }
  function push(name, ok, size) { detail.push({ name: name, ok: ok, sizeKB: size > 0 ? Math.floor(size / 1024) : 0 }); }
  const swMem = statSize('.swarm/memory.db'); push('.swarm/memory.db', swMem > 0, swMem);
  const adb = statSize('agentdb.db'); push('agentdb.db', adb > 0, adb);
  const aqe = statSize('.agentic-qe/memory.db'); push('.agentic-qe/memory.db', aqe > 0, aqe);
  // lora is "live" only when a trained B vector exists (empty scaffold => not live)
  let loraOk = false, loraSize = statSize('.swarm/lora-weights.json');
  try {
    const w = JSON.parse(fs.readFileSync(path.join(CWD, '.swarm', 'lora-weights.json'), 'utf-8'));
    const B = (w.weights && w.weights.B) || w.B || [];
    loraOk = Array.isArray(B) && B.length > 0;
  } catch (e) {}
  push('.swarm/lora-weights.json', loraOk, loraSize);
  // routing-outcomes: a real rolling window carries >100 bytes; an empty [] does not
  const roSize = statSize('.claude-flow/routing-outcomes.json'); push('.claude-flow/routing-outcomes.json', roSize > 100, roSize);
  const live = detail.filter(function (d) { return d.ok; }).length;
  return { live: live, total: 5, detail: detail };
}

// TRUTH-SL-V1: real swarm registry (replaces the `◉ N/15` produced by
// `ps aux | grep -c agentic-flow`, which counted unrelated processes incl. the
// audit's own grep). Reads .claude-flow/swarm/swarm-state.json; an entry is
// genuinely running only when status==='running' AND its pid is alive
// (process.kill(pid,0)) AND updatedAt is within 24h (guards pid reuse). Absent
// file => null so the renderer can say "no registry".
function _ra_swarmreg() {
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(CWD, '.claude-flow', 'swarm', 'swarm-state.json'), 'utf-8')); }
  catch (e) { return null; }
  const swarms = (s && s.swarms && typeof s.swarms === 'object') ? Object.values(s.swarms) : [];
  const now = Date.now();
  const DAY = 24 * 3600 * 1000;
  const running = [];
  let terminated = 0, lastUpdatedAt = 0;
  for (const sw of swarms) {
    if (!sw || typeof sw !== 'object') continue;
    const upd = sw.updatedAt ? new Date(sw.updatedAt).getTime() : 0;
    if (upd > lastUpdatedAt) lastUpdatedAt = upd;
    if (sw.status === 'terminated') terminated++;
    if (sw.status !== 'running') continue;
    let alive = false;
    try { process.kill(sw.pid, 0); alive = true; } catch (e) {}
    if (!alive) continue;
    if (!(upd > 0 && (now - upd) < DAY)) continue;
    running.push({ id: sw.swarmId, agents: Array.isArray(sw.agents) ? sw.agents.length : 0, maxAgents: sw.maxAgents || 0, pid: sw.pid });
  }
  return { running: running, total: swarms.length, terminated: terminated, lastUpdatedAt: lastUpdatedAt || null };
}

// TRUTH-SL-V1: real completed-session count (replaces upstream sessionsCompleted =
// floor(patternsLearned/10) = db-size/20). Counts session-*.json files in
// .claude-flow/sessions; absent dir => 0.
function _ra_sessions() {
  try {
    const dir = path.join(CWD, '.claude-flow', 'sessions');
    return fs.readdirSync(dir).filter(function (n) { return /^session-.*\.json$/.test(n); }).length;
  } catch (e) { return 0; }
}

// TRUTH-SL-V1: 🧠 composite from measured, saturating signals only. DELETED the
// former intelligence-stats CLI exec — it was both a free-running
// event-counter source (SONA showed "traj" that were really events, stored reality
// far fewer episodes) AND a daemon-resurrection channel (every exec spawns the billed
// daemon). Inputs now: storedEpisodes (agentdb + .swarm episodes), storedPatterns
// (neural/patterns.json + .swarm pattern_embeddings), deltaNorm (Σ|B| of the trained
// LoRA), plus the neural/stats.json event counters DEMOTED to a dim `ev` chip
// (never labeled traj). Score dominated by trained-LoRA magnitude; caller supplies
// stored counts so no sqlite call is duplicated.
function _ra_intelligence(opts) {
  opts = opts || {};
  const storedEpisodes = opts.storedEpisodes || 0;
  const storedPatterns = opts.storedPatterns || 0;
  let deltaNorm = 0;
  try {
    const w = JSON.parse(fs.readFileSync(path.join(CWD, '.swarm', 'lora-weights.json'), 'utf-8'));
    const B = (w.weights && w.weights.B) || w.B || [];
    for (let i = 0; i < B.length; i++) deltaNorm += Math.abs(B[i]);
  } catch (e) {}
  let events = 0, eventPatterns = 0;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CWD, '.claude-flow', 'neural', 'stats.json'), 'utf-8'));
    events = j.trajectoriesRecorded || 0; eventPatterns = j.patternsLearned || 0;
  } catch (e) {}
  const trainedPct = deltaNorm > 0 ? 55 * (1 - Math.exp(-deltaNorm)) : 0;
  const epPct = 30 * Math.min(1, storedEpisodes / 1000);
  const patPct = 14 * Math.min(1, storedPatterns / 50);
  const pct = Math.min(99, Math.round(trainedPct + epPct + patPct));
  let tier = 0; for (const t of [50, 150, 350, 700, 1500]) { if (storedEpisodes >= t) tier++; }
  return {
    pct: pct, storedEpisodes: storedEpisodes, storedPatterns: storedPatterns,
    deltaNorm: deltaNorm, events: events, eventPatterns: eventPatterns, tier: tier,
    // legacy keys for JSON compat — now point at STORED values, never the counters
    traj: storedEpisodes, patterns: storedPatterns,
  };
}
function _ra_agentdb() {
  // AGENTDB-SPLIT-V1: 📊 AgentDB chip = the standalone agentdb.db store (the file
  // literally named agentdb.db — agentdb MCP server + reflexion harvest sink).
  const db = path.join(CWD, 'agentdb.db');
  let v = 0;
  for (const t of ['episode_embeddings', 'pattern_embeddings', 'learning_state_embeddings', 'skill_embeddings', 'note_embeddings', 'exp_node_embeddings']) {
    if (_ra_tbl(db, t)) v += _ra_count(db, 'SELECT COUNT(*) FROM ' + t);
  }
  let kb = _ra_dbkb(db);
  // TRUTH-SL-V1: expose the indexed-vector sum (0 here — agentdb.db has no
  // vector_indexes table) and the stored episode count (feeds storedEpisodes).
  let indexedVectors = 0;
  if (_ra_tbl(db, 'vector_indexes')) indexedVectors = _ra_count(db, 'SELECT COALESCE(SUM(total_vectors),0) FROM vector_indexes');
  const episodes = _ra_tbl(db, 'episodes') ? _ra_count(db, 'SELECT COUNT(*) FROM episodes') : 0;
  return { vectorCount: v, dbSizeKB: Math.floor(kb), hasHnsw: indexedVectors > 0, indexedVectors: indexedVectors, episodes: episodes };
}
function _ra_swarmdb() {
  // 🗃️ Swarm DB chip = ruflo's claude-flow memory store (.swarm/memory.db).
  // This is the source the AgentDB chip used to (mis)read; split out per its own
  // label so neither chip impersonates the other.
  const db = path.join(CWD, '.swarm', 'memory.db');
  let v = _ra_count(db, 'SELECT COUNT(*) FROM memory_entries WHERE embedding IS NOT NULL');
  const patternEmbeddings = _ra_tbl(db, 'pattern_embeddings') ? _ra_count(db, 'SELECT COUNT(*) FROM pattern_embeddings') : 0;
  v += patternEmbeddings;
  if (_ra_tbl(db, 'learning_state_embeddings')) v += _ra_count(db, 'SELECT COUNT(*) FROM learning_state_embeddings');
  if (_ra_tbl(db, 'patterns')) v += _ra_count(db, 'SELECT COUNT(*) FROM patterns WHERE embedding IS NOT NULL');
  let kb = _ra_dbkb(db);
  try { kb += fs.statSync(path.join(CWD, '.swarm', 'hnsw.index')).size / 1024; } catch (e) {}
  // Honest ⚡ — same bar as _ra_agentdb: lit only when vectors are actually indexed
  // (a real hnsw.index file, or vector_indexes with SUM(total_vectors)>0). ruflo's
  // backend is "sql.js + HNSW"-capable, but empty index defs (total_vectors=0) are
  // NOT a populated index, so we do not fake ⚡ off mere row-existence.
  // TRUTH-SL-V1: expose the indexed-vector sum (drives the Learning-row `⚡ N indexed`
  // chip in place of the fabricated speedup label), plus the stored episode + standalone
  // pattern_embeddings counts (feed storedEpisodes / storedPatterns).
  let indexedVectors = 0;
  if (_ra_tbl(db, 'vector_indexes')) indexedVectors = _ra_count(db, 'SELECT COALESCE(SUM(total_vectors),0) FROM vector_indexes');
  let hnsw = fs.existsSync(path.join(CWD, '.swarm', 'hnsw.index')) || indexedVectors > 0;
  const episodes = _ra_tbl(db, 'episodes') ? _ra_count(db, 'SELECT COUNT(*) FROM episodes') : 0;
  return { vectorCount: v, dbSizeKB: Math.floor(kb), hasHnsw: hnsw, indexedVectors: indexedVectors, episodes: episodes, patternEmbeddings: patternEmbeddings };
}
// BRAIN-STATUSLINE-V1: 🧿 Ruflo Brain chip — the MCP-only ruvnet-brain knowledge
// base (BRAIN-MCP-V1, Patch 53). Cheap filesystem-only probe: top-level readdir
// + stat of the KB dir (never walks the 1.7GB tree), one JSON read of .mcp.json.
// The row is hidden entirely when neither registered nor cached, so non-brain
// targets see zero clutter. Repo count = distinct <repo> prefixes of *.rvf files.
function _ra_brain() {
  const kbDir = process.env.RUVNET_BRAIN_KB
    || path.join(os.homedir(), '.cache', 'ruvnet-brain', 'kb');
  let registered = false;
  try {
    const mcp = JSON.parse(fs.readFileSync(path.join(CWD, '.mcp.json'), 'utf8'));
    registered = !!(mcp.mcpServers && mcp.mcpServers['ruvnet-brain']);
  } catch (e) {}
  let kbPresent = false, repos = 0, sizeKB = 0, readerOk = false;
  try {
    kbPresent = fs.existsSync(path.join(kbDir, 'forge-mcp-all.mjs'));
    if (kbPresent) {
      const repoSet = new Set();
      for (const n of fs.readdirSync(kbDir)) {
        if (n.endsWith('.rvf')) repoSet.add(n.split('.')[0]);
        // Size = all top-level KB content files (rvf + passages + meta), so the
        // chip matches the documented KB size; deps (node_modules) excluded.
        try {
          const st = fs.statSync(path.join(kbDir, n));
          if (st.isFile()) sizeKB += st.size / 1024;
        } catch (e) {}
      }
      repos = repoSet.size;
      readerOk = fs.existsSync(path.join(kbDir, 'node_modules', '@xenova', 'transformers', 'package.json'));
    }
  } catch (e) {}
  return { registered, kbPresent, repos, sizeKB: Math.floor(sizeKB), readerOk };
}
function _ra_aqevec() {
  // TRUTH-SL-V1: split the vec sum so the footer stops double-counting the traj
  // rows (the row already shows them as `N traj`). `vectors` = non-traj embeddings
  // only; `vectorsTotal` = incl. qe_trajectories. And ⚡ is lit ONLY on a real index
  // artifact (a non-empty .agentic-qe/data/hnsw dir, or a vector_indexes table with
  // SUM>0) — NOT on mere row-existence (`v>0`), which the audit flagged as cosmetic
  // (hnsw dir is empty here, so ⚡ stays unlit).
  const db = path.join(CWD, '.agentic-qe', 'memory.db');
  let vectors = 0;
  if (_ra_tbl(db, 'embeddings')) vectors += _ra_count(db, 'SELECT COUNT(*) FROM embeddings');
  if (_ra_tbl(db, 'qe_pattern_embeddings')) vectors += _ra_count(db, 'SELECT COUNT(*) FROM qe_pattern_embeddings');
  for (const t of ['captured_experiences','vectors','concept_nodes','pattern_versions','hypergraph_nodes']) {
    if (_ra_tbl(db, t)) vectors += _ra_count(db, 'SELECT COUNT(*) FROM ' + t + ' WHERE embedding IS NOT NULL');
  }
  if (_ra_tbl(db, 'sona_patterns')) vectors += _ra_count(db, 'SELECT COUNT(*) FROM sona_patterns WHERE state_embedding IS NOT NULL');
  const trajVecs = _ra_tbl(db, 'qe_trajectories') ? _ra_count(db, 'SELECT COUNT(*) FROM qe_trajectories WHERE embedding IS NOT NULL') : 0;
  const vectorsTotal = vectors + trajVecs;
  let hasIndex = false;
  try { hasIndex = fs.readdirSync(path.join(CWD, '.agentic-qe', 'data', 'hnsw')).length > 0; } catch (e) {}
  if (!hasIndex && _ra_tbl(db, 'vector_indexes')) hasIndex = _ra_count(db, 'SELECT COALESCE(SUM(total_vectors),0) FROM vector_indexes') > 0;
  let kb = _ra_dbkb(db);
  return { vectors: vectors, vectorsTotal: vectorsTotal, dbSizeKB: Math.floor(kb), hasIndex: hasIndex, hasHnsw: hasIndex };
}
function _ra_mcp() {
  const settings = readJSON(path.join(CWD, '.claude', 'settings.json')) || {};
  const ss = (settings.mcpServers && typeof settings.mcpServers === 'object') ? Object.keys(settings.mcpServers) : [];
  const mcp = readJSON(path.join(CWD, '.mcp.json')) || {};
  const ps = (mcp.mcpServers && typeof mcp.mcpServers === 'object') ? Object.keys(mcp.mcpServers) : [];
  const en = Array.isArray(settings.enabledMcpjsonServers) ? settings.enabledMcpjsonServers : [];
  const total = new Set(ss.concat(ps)).size;
  const enabled = new Set(ss.concat(ps.filter(function (s) { return en.indexOf(s) >= 0; }))).size;
  return { total: total, enabled: enabled };
}
function _ra_hooks() {
  const settings = readJSON(path.join(CWD, '.claude', 'settings.json')) || {};
  const h = (settings.hooks && typeof settings.hooks === 'object') ? Object.keys(settings.hooks).length : 0;
  return { enabled: h, total: h };
}

// TRUTH-SL-V1: single source for the disk-truth overlay. Applied over whatever base
// object we have (upstream CLI JSON, a cached copy, or the local fallback) so every
// cosmetic/counter field the audit flagged is replaced by a measured value and the
// additive truth keys are always present. Runs on EVERY render (both cache hit and
// miss): the probes are cheap readonly sqlite/stat reads, and the whole point of the
// contract is freshness — the 10s cache only spares the expensive `ruflo hooks
// statusline` exec, never the local truth. Every field is guarded (try per probe) so
// a single failing store degrades one chip, not the line.
function applyTruthOverlay(data) {
  data = data || {};
  // Cheap local overlays (ADRs, real test cases, brain, MCP, hooks).
  try { data.adrs = getLocalADRCount(); } catch (e) {}
  try { data.tests = getLocalTestCount(); } catch (e) {}
  try { data.brain = _ra_brain(); } catch (e) {}
  try { data.integration = Object.assign({}, data.integration, { mcpServers: _ra_mcp() }); } catch (e) {}
  try { data.hooks = _ra_hooks(); } catch (e) {}

  // Store liveness → replaces "5/5 domains" / dddProgress (both were memory.db-size
  // buckets). domainsCompleted/totalDomains/dddProgress become the honest N-of-5.
  let stores = null;
  try { stores = _ra_stores(); } catch (e) {}
  if (stores) {
    data.stores = stores;
    data.v3Progress = Object.assign({}, data.v3Progress, {
      domainsCompleted: stores.live,
      totalDomains: 5,
      dddProgress: Math.round(100 * stores.live / 5),
    });
    const storesKB = stores.detail.reduce(function (a, d) { return a + (d.sizeKB || 0); }, 0);
    data.system = Object.assign({}, data.system, { memoryMB: Math.round(storesKB / 1024), storesMB: Math.round(storesKB / 1024) });
  }

  // Extended DB probes (episodes + indexedVectors folded in).
  let agentdb = null, swarmdb = null;
  try { agentdb = _ra_agentdb(); data.agentdb = agentdb; } catch (e) {}
  try { swarmdb = _ra_swarmdb(); data.swarmdb = swarmdb; } catch (e) {}

  // Intelligence 🧠 + SONA — driven by STORED counts, no exec, no counters.
  const storedEpisodes = (agentdb ? agentdb.episodes : 0) + (swarmdb ? swarmdb.episodes : 0);
  let neuralPatterns = 0;
  try {
    const p = JSON.parse(fs.readFileSync(path.join(CWD, '.claude-flow', 'neural', 'patterns.json'), 'utf-8'));
    neuralPatterns = Array.isArray(p) ? p.length : Object.keys(p).length;
  } catch (e) {}
  const storedPatterns = neuralPatterns + (swarmdb ? (swarmdb.patternEmbeddings || 0) : 0);
  try {
    const ri = _ra_intelligence({ storedEpisodes: storedEpisodes, storedPatterns: storedPatterns });
    data.system = Object.assign({}, data.system, { ruflo: ri });
    if (ri.pct > 0) data.system.intelligencePct = ri.pct;
  } catch (e) {}

  // Sessions + patternsLearned → real records / stored counts.
  try {
    data.v3Progress = Object.assign({}, data.v3Progress, {
      sessionsCompleted: _ra_sessions(),
      patternsLearned: storedPatterns,
    });
  } catch (e) {}

  // Swarm registry → replaces the ps|grep `◉ N/15`.
  let registry = null;
  try { registry = _ra_swarmreg(); } catch (e) {}
  const running = (registry && Array.isArray(registry.running)) ? registry.running : [];
  data.swarm = Object.assign({}, data.swarm, {
    registry: registry,
    activeAgents: running.length > 0 ? running[0].agents : 0,
    maxAgents: running.length > 0 ? (running[0].maxAgents || CONFIG.maxAgents) : (data.swarm && data.swarm.maxAgents ? data.swarm.maxAgents : CONFIG.maxAgents),
    coordinationActive: running.length > 0,
  });

  // AQE footer stats wired into JSON (were render-only).
  try {
    const aqe = getAQEStats();
    if (aqe.available) {
      data.aqe = {
        patterns: aqe.patterns, trajectories: aqe.trajectories,
        vectors: aqe.vectors, vectorsTotal: aqe.vectorsTotal,
        hasIndex: aqe.hasIndex, dbSizeKB: aqe.dbSizeKB,
      };
    }
  } catch (e) {}

  // Self-improvement snapshot into JSON.
  try {
    const si = getSelfImprove();
    if (si.available) {
      data.selfImprove = {
        accLast: si.accLast, rewardDistinct: si.rewardDistinct,
        qSpread: si.qSpread, ageDays: (typeof si.ageDays === 'number') ? si.ageDays : null,
      };
    }
  } catch (e) {}

  return data;
}

function getStatuslineData() {
  const cached = readCache();
  if (cached) return applyTruthOverlay(cached);

  try {
    const raw = execSync(
      'ruflo hooks statusline --json 2>/dev/null',
      { encoding: 'utf-8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'], cwd: CWD }
    ).trim();
    // The CLI may emit preamble lines before the JSON — find the first '{'.
    const jsonStart = raw.indexOf('{');
    if (jsonStart === -1) throw new Error('no JSON in CLI output');
    const data = JSON.parse(raw.slice(jsonStart));
    // Cache the RAW CLI base only — the truth overlay is cheap and must be re-derived
    // fresh each render, so it is never frozen into the 10s cache.
    writeCache(data);
    return applyTruthOverlay(data);
  } catch { /* CLI unavailable or timed out */ }

  // Fallback: local file probes only (accurate when the CLI is unavailable).
  return buildLocalFallback();
}

// Count ADRs from BOTH known directories (fix for ruflo#2195: old code missed
// v3/docs/adr/ which holds ADR-088..ADR-137, i.e. 41 of the 128 total ADRs).
function getLocalADRCount() {
  const adrDirs = [
    path.join(CWD, 'v3', 'implementation', 'adrs'),
    path.join(CWD, 'v3', 'docs', 'adr'),
    path.join(CWD, 'docs', 'adr'),     // singular — the conventional MADR/adr-tools layout
    path.join(CWD, 'docs', 'adrs'),
    path.join(CWD, 'docs', 'decisions'),
    path.join(CWD, '.claude-flow', 'adrs'),
  ];
  let total = 0;
  for (const dir of adrDirs) {
    try {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter(function(f) {
          return f.endsWith('.md') && (f.startsWith('ADR-') || f.startsWith('adr-') || /^\d{4}-/.test(f));
        });
        total += files.length;
      }
    } catch { /* ignore */ }
  }
  return { count: total, implemented: total, compliance: 0 };
}

// Count test files via a pure directory walk (no file reads). Used by BOTH the
// primary-data overlay and the local fallback so the Tests chip is never a
// false 0 — `ruflo hooks statusline --json` does not report test counts, so the
// previous code (countTests only in the fallback) always showed 0 whenever the
// CLI succeeded, even with hundreds of tests on disk (monorepos, .spec.ts, etc).
function getLocalTestCount() {
  // TRUTH-SL-V1: real `it()`/`test()` case count (replaces the `testFiles * 4`
  // multiplier the audit flagged — it understated the ~806-case suite 4.3×). The
  // walk collects matched files' `path:mtimeMs:size` fingerprints; an md5 of the
  // sorted list keys a tmpdir cache, so the files are only re-read (regex-scanned)
  // when the suite actually changes — amortized ~0 on the hot render path.
  const matched = [];
  function walk(dir, depth) {
    if ((depth || 0) > 5) return;
    try {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
          walk(path.join(dir, e.name), (depth || 0) + 1);
        } else if (e.isFile() && (e.name.includes('.test.') || e.name.includes('.spec.') || e.name.startsWith('test_') || e.name.startsWith('spec_'))) {
          matched.push(path.join(dir, e.name));
        }
      }
    } catch { /* ignore */ }
  }
  // Cover monorepo layouts (packages/*) in addition to the common roots.
  for (const d of ['tests', 'test', '__tests__', 'src', 'v3', 'packages', 'apps']) {
    walk(path.join(CWD, d), 0);
  }
  const testFiles = matched.length;
  // Fingerprint the matched set (path + mtime + size) so a code-free render reuses
  // the cached counts; any add/remove/edit changes the key and forces a recount.
  const fps = [];
  for (const f of matched) {
    try { const st = fs.statSync(f); fps.push(f + ':' + st.mtimeMs + ':' + st.size); } catch (e) {}
  }
  fps.sort();
  const cwdHash = require('crypto').createHash('md5').update(CWD).digest('hex').slice(0, 8);
  const key = require('crypto').createHash('md5').update(fps.join('\n')).digest('hex');
  const cacheFile = path.join(os.tmpdir(), 'ruflo-testcases-' + cwdHash + '.json');
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    if (cached && cached.key === key) {
      return { testFiles: testFiles, testCases: cached.cases, describes: cached.describes, countMethod: 'regex-scan' };
    }
  } catch (e) { /* miss */ }
  let cases = 0, describes = 0;
  const itRe = /\b(?:it|test)\s*\(/g;
  const descRe = /\bdescribe\s*\(/g;
  for (const f of matched) {
    try {
      const src = fs.readFileSync(f, 'utf-8');
      const im = src.match(itRe); if (im) cases += im.length;
      const dm = src.match(descRe); if (dm) describes += dm.length;
    } catch (e) {}
  }
  try { fs.writeFileSync(cacheFile, JSON.stringify({ key: key, cases: cases, describes: describes }), 'utf-8'); } catch (e) {}
  return { testFiles: testFiles, testCases: cases, describes: describes, countMethod: 'regex-scan' };
}

// Minimal local fallback when the CLI is not installed or times out. Builds a
// schema-shaped skeleton, then runs the SAME truth overlay so the offline line is
// as real as the delegated one (TRUTH-SL-V1: no memoryMB=heap, no modelName literal).
function buildLocalFallback() {
  const base = {
    brain: null,
    user: { name: 'user', gitBranch: '', modelName: '' },
    v3Progress: { domainsCompleted: 0, totalDomains: 5, dddProgress: 0, patternsLearned: 0, sessionsCompleted: 0 },
    security: { status: 'NONE', cvesFixed: 0, totalCves: 0 },
    swarm: { activeAgents: 0, maxAgents: CONFIG.maxAgents, coordinationActive: false },
    system: { memoryMB: 0, contextPct: 0, intelligencePct: 0, subAgents: 0 },
    adrs: { count: 0, implemented: 0, compliance: 0 },
    hooks: { enabled: 0, total: 0 },
    agentdb: { vectorCount: 0, dbSizeKB: 0, hasHnsw: false },
    swarmdb: { vectorCount: 0, dbSizeKB: 0, hasHnsw: false },
    tests: { testFiles: 0, testCases: 0 },
    lastUpdated: new Date().toISOString(),
  };
  return applyTruthOverlay(base);
}

// ANSI colors
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[0;31m',
  green: '\x1b[0;32m',
  yellow: '\x1b[0;33m',
  blue: '\x1b[0;34m',
  purple: '\x1b[0;35m',
  cyan: '\x1b[0;36m',
  brightRed: '\x1b[1;31m',
  brightGreen: '\x1b[1;32m',
  brightYellow: '\x1b[1;33m',
  brightBlue: '\x1b[1;34m',
  brightPurple: '\x1b[1;35m',
  brightCyan: '\x1b[1;36m',
  brightWhite: '\x1b[1;37m',
};

// Safe execSync with strict timeout (returns empty string on failure)
function safeExec(cmd, timeoutMs) {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: timeoutMs || 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

// Safe JSON file reader (returns null on failure)
function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch { /* ignore */ }
  return null;
}

// ─── Git info (pure-Node / single exec — needed for branch display) ──────────

function getGitInfo() {
  const result = {
    name: 'user', gitBranch: '', modified: 0, untracked: 0,
    staged: 0, ahead: 0, behind: 0,
  };

  const script = [
    'git config user.name 2>/dev/null || echo user',
    'echo "---SEP---"',
    'git branch --show-current 2>/dev/null',
    'echo "---SEP---"',
    'git status --porcelain 2>/dev/null',
    'echo "---SEP---"',
    'git rev-list --left-right --count HEAD...@{upstream} 2>/dev/null || echo "0 0"',
  ].join('; ');

  const raw = safeExec("sh -c '" + script + "'", 3000);
  if (!raw) return result;

  const parts = raw.split('---SEP---').map(function(s) { return s.trim(); });
  if (parts.length >= 4) {
    result.name = parts[0] || 'user';
    result.gitBranch = parts[1] || '';

    if (parts[2]) {
      for (const line of parts[2].split('\n')) {
        if (!line || line.length < 2) continue;
        const x = line[0], y = line[1];
        if (x === '?' && y === '?') { result.untracked++; continue; }
        if (x !== ' ' && x !== '?') result.staged++;
        if (y !== ' ' && y !== '?') result.modified++;
      }
    }

    const ab = (parts[3] || '0 0').split(/\s+/);
    result.ahead = parseInt(ab[0]) || 0;
    result.behind = parseInt(ab[1]) || 0;
  }

  return result;
}

// TRUTH-SL-V1: real model id for stdin-less invocations (replaces the dead
// hardcoded mapping that emitted a flat 'Opus 4.7'/'Claude Code' literal regardless
// of the actual model). Reads ~/.claude.json projects[CWD].lastModelUsage, picks the
// most-recently-used id, and renders its tail (strips the 'claude-' prefix, keeping
// e.g. 'fable-5', 'opus-4-8[1m]'). Returns '' when nothing is knowable — the render
// then OMITS the model segment rather than inventing one. Real Claude Code renders
// pass the true name via stdin display_name, which always wins upstream of this.
function getModelFallback() {
  try {
    const claudeConfig = readJSON(path.join(os.homedir(), '.claude.json'));
    if (claudeConfig && claudeConfig.projects) {
      // Pick the MOST-SPECIFIC (longest) matching project path — both CWD and its
      // parents can be keys, and a parent entry without lastModelUsage must not
      // shadow the exact-match repo entry.
      let bestPath = null;
      for (const projectPath of Object.keys(claudeConfig.projects)) {
        if (CWD === projectPath || CWD.startsWith(projectPath + '/')) {
          if (!bestPath || projectPath.length > bestPath.length) bestPath = projectPath;
        }
      }
      const usage = bestPath ? claudeConfig.projects[bestPath].lastModelUsage : null;
      if (usage) {
        const ids = Object.keys(usage);
        if (ids.length > 0) {
          let modelId = ids[ids.length - 1];
          let latest = 0;
          for (const id of ids) {
            const ts = usage[id] && usage[id].lastUsedAt ? new Date(usage[id].lastUsedAt).getTime() : 0;
            if (ts > latest) { latest = ts; modelId = id; }
          }
          return modelId.replace(/^claude-/, '');
        }
      }
    }
  } catch { /* ignore */ }
  return '';
}

// ─── Stdin reader (Claude Code pipes session JSON) ──────────────
// Claude Code sends session JSON via stdin. Read synchronously so the
// script works both when invoked by Claude Code (stdin has JSON) and
// when run manually from terminal (stdin is empty/tty).
let _stdinData = null;
function getStdinData() {
  if (_stdinData !== undefined && _stdinData !== null) return _stdinData;
  try {
    if (process.stdin.isTTY) { _stdinData = null; return null; }
    const chunks = [];
    const buf = Buffer.alloc(4096);
    let bytesRead;
    try {
      while ((bytesRead = fs.readSync(0, buf, 0, buf.length, null)) > 0) {
        chunks.push(buf.slice(0, bytesRead));
      }
    } catch { /* EOF or read error */ }
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    _stdinData = (raw && raw.startsWith('{')) ? JSON.parse(raw) : null;
  } catch {
    _stdinData = null;
  }
  return _stdinData;
}

function getModelFromStdin() {
  const data = getStdinData();
  return (data && data.model && data.model.display_name) ? data.model.display_name : null;
}

function getContextFromStdin() {
  const data = getStdinData();
  if (data && data.context_window) {
    return { usedPct: Math.floor(data.context_window.used_percentage || 0) };
  }
  return null;
}

function getCostFromStdin() {
  const data = getStdinData();
  if (data && data.cost) {
    const durationMs = data.cost.total_duration_ms || 0;
    const mins = Math.floor(durationMs / 60000);
    const secs = Math.floor((durationMs % 60000) / 1000);
    return {
      costUsd: data.cost.total_cost_usd || 0,
      duration: mins > 0 ? mins + 'm' + secs + 's' : secs + 's',
    };
  }
  return null;
}

// Read package version from the first package.json we find.
function getPkgVersion() {
  let ver = '0.0.0';   // TRUTH-SL-V1: neutral fallback — live detection below always wins
  try {
    const home = os.homedir();
    // live-detect the GLOBAL ruflo (the kit launches from the global binary, per
    // CLAUDE.md) — derive lib/node_modules from the node execPath so it tracks real
    // upgrades instead of returning the baked-in default.
    const globalNm = path.join(path.dirname(path.dirname(process.execPath)), 'lib', 'node_modules');
    const pkgPaths = [
      path.join(globalNm, 'ruflo', 'package.json'),
      path.join(home, '.claude', 'plugins', 'marketplaces', 'ruflo', 'package.json'),
      path.join(CWD, 'node_modules', '@claude-flow', 'cli', 'package.json'),
      path.join(CWD, 'node_modules', 'ruflo', 'package.json'),
      path.join(CWD, 'v3', '@claude-flow', 'cli', 'package.json'),
    ];
    for (const p of pkgPaths) {
      if (!fs.existsSync(p)) continue;
      try {
        const pkg = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (pkg && typeof pkg.version === 'string' && pkg.version.length > 0) { ver = pkg.version; break; }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return ver;
}

// ─── Rendering ──────────────────────────────────────────────────

function progressBar(current, total) {
  const width = 5;
  const filled = Math.round((current / total) * width);
  return '[' + '●'.repeat(filled) + '○'.repeat(width - filled) + ']';
}


// Plugin detection (scans node_modules for @claude-flow/plugin-* packages)
function getPluginStatus() {
  const plugins = [];
  try {
    const pluginDir = path.join(CWD, 'node_modules', '@claude-flow');
    if (!fs.existsSync(pluginDir)) return plugins;
    const entries = fs.readdirSync(pluginDir).filter(d => d.startsWith('plugin-'));
    for (const entry of entries) {
      try {
        const pkgPath = path.join(pluginDir, entry, 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const manifestPath = path.join(pluginDir, entry, 'plugin.yaml');
        const hasManifest = fs.existsSync(manifestPath);
        const distPath = path.join(pluginDir, entry, 'dist', 'index.js');
        const hasDist = fs.existsSync(distPath);
        plugins.push({
          name: entry.replace('plugin-', ''),
          version: pkg.version || '?',
          status: hasDist && hasManifest ? 'installed' : 'partial',
        });
      } catch { /* skip broken packages */ }
    }
  } catch { /* ignore */ }
  return plugins;
}

function getAQEStats() {
  // self-contained (fix-statusbar runtime backstop): no safeStat/safeExec/getAgentDBStats hard-dep
  const dbPath = path.join(CWD, '.agentic-qe', 'memory.db');
  if (!fs.existsSync(dbPath)) return { available: false, patterns: 0, trajectories: 0, vectors: 0, vectorsTotal: 0, dbSizeKB: 0, hasHnsw: false, hasIndex: false };
  let p = 0, t = 0;
  try {
    const sql = "SELECT (SELECT COUNT(*) FROM qe_patterns WHERE usage_count > 0 OR quality_score > 0 OR name NOT LIKE 'bench-%') || '|' || (SELECT COUNT(*) FROM qe_trajectories);";
    const out = execFileSync('sqlite3', ['-readonly', dbPath, sql], { timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const parts = out.split('|').map(n => parseInt(n, 10) || 0); p = parts[0] || 0; t = parts[1] || 0;
  } catch (e) { /* ignore */ }
  // TRUTH-SL-V1: non-traj `vectors` (footer chip) split from `vectorsTotal`, and ⚡
  // gated on a real index (hasIndex) not row-existence.
  let vec = 0, vecTotal = 0, mb = 0, idx = false;
  try { const av = _ra_aqevec(); vec = av.vectors || 0; vecTotal = av.vectorsTotal || 0; mb = av.dbSizeKB || 0; idx = !!av.hasIndex; } catch (e) { /* ignore */ }
  return { available: true, patterns: p, trajectories: t, vectors: vec, vectorsTotal: vecTotal, dbSizeKB: mb, hasHnsw: idx, hasIndex: idx };
}

// RUFLO-INTEL-V3: self-IMPROVEMENT snapshot from the precomputed bench history.
// Pure-Node read of .claude-flow/selfimprove-history.jsonl (NO sqlite/subprocess) — cheap on
// the hot render path. HONEST framing: latest-only accuracy; a delta renders ONLY when >=2
// rows share the latest scorerVersion (mirrors selfimprove-bench's same-scorer guard) so a
// cross-scorer normalization artifact can never read as "improvement". Efficacy is reported
// NEUTRAL (loop:closed eff:flat) — never green / up-arrow. Hidden entirely when the file is
// missing/empty/unparseable. See scripts/docs/whats-genuinely-left-rnd.md.
function getSelfImprove() {
  try {
    const p = path.join(CWD, '.claude-flow', 'selfimprove-history.jsonl');
    if (!fs.existsSync(p)) return { available: false };
    // TRUTH-SL-V1: bench staleness — the SI row was frozen ~7 weeks (audit). ageDays
    // from the file mtime drives a `bench Nd⚠` chip when the bench hasn't been re-run.
    let ageDays = null;
    try { ageDays = (Date.now() - fs.statSync(p).mtimeMs) / 86400000; } catch (e) {}
    const rows = fs.readFileSync(p, 'utf-8').split('\n').map(s => s.trim()).filter(Boolean)
      .map(s => { try { return JSON.parse(s); } catch { return null; } })
      .filter(r => r && typeof r === 'object');
    if (!rows.length) return { available: false };
    const last = rows[rows.length - 1];
    if (typeof last.accuracyPct !== 'number') return { available: false };
    // Same-scorer delta guard: only compare rows sharing the latest scorerVersion. A
    // cross-scorer comparison (e.g. raw 25 -> normalized 33) is a metric redefinition, NOT
    // learning — so accFirst stays null unless >=2 rows share scorerVersion (today: none do).
    let accFirst = null;
    if (last.scorerVersion) {
      const same = rows.filter(r => r.scorerVersion === last.scorerVersion && typeof r.accuracyPct === 'number');
      if (same.length >= 2) accFirst = same[0].accuracyPct;
    }
    return {
      available: true,
      runs: rows.length,
      accLast: last.accuracyPct,
      accFirst,
      rewardDistinct: (typeof last.rewardDistinct === 'number') ? last.rewardDistinct : 0,
      rewardConstant: last.rewardConstant === true,
      qSpread: (typeof last.qSpread === 'number') ? last.qSpread : 0,
      ageDays: ageDays,
    };
  } catch { return { available: false }; }
}

function generateStatusline() {
  const d = getStatuslineData();
  const git = getGitInfo();
  // TRUTH-SL-V1: real model — stdin display_name (real Claude Code renders), else the
  // id-tail from ~/.claude.json. NEVER upstream's d.user.modelName literal. Empty =>
  // the model segment is omitted rather than fabricated.
  const modelName = getModelFromStdin() || getModelFallback();
  const ctxInfo = getContextFromStdin();
  const costInfo = getCostFromStdin();
  const pkgVersion = getPkgVersion();

  const progress = d.v3Progress || {};
  const security = d.security || {};
  const swarm = d.swarm || {};
  const system = d.system || {};
  const adrs = d.adrs || {};
  const hooks = d.hooks || {};
  const agentdb = d.agentdb || {};
  const tests = d.tests || {};

  const coordinationActive = swarm.coordinationActive || false;
  const intelligencePct = system.intelligencePct || 0;
  const memoryMB = system.memoryMB || 0;
  const subAgents = system.subAgents || 0;
  const cvesFixed = security.cvesFixed || 0;
  const totalCves = security.totalCves || 0;
  const secStatus = security.status || 'NONE';
  const adrCount = adrs.count || 0;
  const adrImpl = adrs.implemented || 0;
  const hooksEnabled = hooks.enabled || 0;
  const vectorCount = agentdb.vectorCount || 0;
  const hasHnsw = agentdb.hasHnsw || false;
  const dbSizeKB = agentdb.dbSizeKB || 0;
  const swarmdb = d.swarmdb || {};
  const swVectorCount = swarmdb.vectorCount || 0;
  const swHasHnsw = swarmdb.hasHnsw || false;
  const swDbSizeKB = swarmdb.dbSizeKB || 0;
  const testFiles = tests.testFiles || 0;
  const testCases = tests.testCases || 0;
  // TRUTH-SL-V1 render inputs: store liveness, indexed-vector total, swarm registry.
  const stores = d.stores || {};
  const storesLive = (typeof stores.live === 'number') ? stores.live : (progress.domainsCompleted || 0);
  const indexedVectors = (agentdb.indexedVectors || 0) + (swarmdb.indexedVectors || 0);
  const registry = swarm.registry; // null when no swarm-state.json

  const lines = [];

  // Header
  let header = c.bold + c.brightPurple + '▊ RuFlo V' + pkgVersion + ' ' + c.reset;
  header += (coordinationActive ? c.brightCyan : c.dim) + '● ' + c.brightCyan + git.name + c.reset;
  if (git.gitBranch) {
    header += '  ' + c.dim + '│' + c.reset + '  ' + c.brightBlue + '⏇ ' + git.gitBranch + c.reset;
    const changes = git.modified + git.staged + git.untracked;
    if (changes > 0) {
      let ind = '';
      if (git.staged > 0) ind += c.brightGreen + '+' + git.staged + c.reset;
      if (git.modified > 0) ind += c.brightYellow + '~' + git.modified + c.reset;
      if (git.untracked > 0) ind += c.dim + '?' + git.untracked + c.reset;
      header += ' ' + ind;
    }
    if (git.ahead > 0) header += ' ' + c.brightGreen + '↑' + git.ahead + c.reset;
    if (git.behind > 0) header += ' ' + c.brightRed + '↓' + git.behind + c.reset;
  }
  if (modelName) header += '  ' + c.dim + '│' + c.reset + '  ' + c.purple + modelName + c.reset;
  const duration = costInfo ? costInfo.duration : '';
  if (duration) header += '  ' + c.dim + '│' + c.reset + '  ' + c.cyan + '⏱ ' + duration + c.reset;
  if (ctxInfo && ctxInfo.usedPct > 0) {
    const ctxColor = ctxInfo.usedPct >= 90 ? c.brightRed : ctxInfo.usedPct >= 70 ? c.brightYellow : c.brightGreen;
    header += '  ' + c.dim + '│' + c.reset + '  ' + ctxColor + '● ' + ctxInfo.usedPct + '% ctx' + c.reset;
  }
  if (costInfo && costInfo.costUsd > 0) {
    header += '  ' + c.dim + '│' + c.reset + '  ' + c.brightYellow + '$' + costInfo.costUsd.toFixed(2) + c.reset;
  }
  lines.push(header);

  // Separator
  lines.push(c.dim + '─'.repeat(53) + c.reset);

  // Line 1: Learning stores + indexed vectors
  // TRUTH-SL-V1: `N/5 stores` (live count, gauge dots = live) replaces the "5/5
  // domains" memory.db-size bucket; `⚡ N indexed` = the measured indexed-vector total
  // (swarmdb + agentdb vector_indexes SUM) replaces the fabricated `HNSW Nx` speedup label.
  const domainsColor = storesLive >= 3 ? c.brightGreen : storesLive > 0 ? c.yellow : c.red;
  const perfIndicator = indexedVectors > 0
    ? c.brightGreen + '⚡ ' + indexedVectors + ' indexed' + c.reset
    : c.dim + '⚡ no index' + c.reset;
  lines.push(
    c.brightCyan + '🏗️  Learning' + c.reset + '    ' + progressBar(storesLive, 5) + '  ' +
    domainsColor + storesLive + c.reset + '/' + c.brightWhite + '5' + c.reset + c.dim + ' stores' + c.reset + '    ' + perfIndicator
  );

  // Line 2: Swarm registry + Sub + Hooks + CVE + store bytes + Intelligence
  // TRUTH-SL-V1: registry chip from .claude-flow/swarm/swarm-state.json (running =
  // status running + pid alive + updatedAt<24h) replaces the `ps|grep` \u25C9 N/15;
  // `\uD83E\uDE9D N` drops the tautological /N denominator (no per-hook disable exists);
  // `\uD83D\uDCBE NMB stores` is the real \u03A3 store bytes, not the renderer's heap.
  const running = (registry && Array.isArray(registry.running)) ? registry.running : [];
  let swarmChip;
  if (running.length > 0) {
    const r0 = running[0];
    swarmChip = c.brightGreen + '\u25C9 ' + running.length + ' swarm' + c.reset + ' ' + c.brightWhite + r0.agents + '/' + r0.maxAgents + c.reset;
  } else if (registry) {
    const h = registry.lastUpdatedAt ? Math.round((Date.now() - registry.lastUpdatedAt) / 3600000) : '?';
    swarmChip = c.dim + '\u25CB idle (last ' + h + 'h)' + c.reset;
  } else {
    swarmChip = c.dim + '\u25CB no registry' + c.reset;
  }
  const secIcon = security.status === 'CLEAN' ? '\uD83D\uDFE2' : (security.status === 'IN_PROGRESS' || security.status === 'STALE') ? '\uD83D\uDFE1' : (security.status === 'NONE' ? '\u26AA' : '\uD83D\uDD34');
  const secColor = security.status === 'CLEAN' ? c.brightGreen : (security.status === 'IN_PROGRESS' || security.status === 'STALE') ? c.brightYellow : (security.status === 'NONE' ? c.dim : c.brightRed);
  const hooksColor = hooksEnabled > 0 ? c.brightGreen : c.dim;
  const intellColor = system.intelligencePct >= 80 ? c.brightGreen : system.intelligencePct >= 40 ? c.brightYellow : c.dim;
  const subColor = system.subAgents > 0 ? c.brightPurple : c.dim;
  const subLabel = system.subAgents > 0 ? 'Sub ' + system.subAgents : 'Sub 0';

  lines.push(
    c.brightYellow + '\uD83E\uDD16 Swarm' + c.reset + '  ' + swarmChip + '  ' +
    subColor + '\uD83D\uDC65 ' + subLabel + c.reset + '    ' +
    c.brightBlue + '\uD83E\uDE9D ' + hooksColor + hooksEnabled + c.reset + '    ' +
    secIcon + ' ' + secColor + 'CVE ' + security.cvesFixed + c.reset + '/' + c.brightWhite + security.totalCves + c.reset + '    ' +
    c.brightCyan + '\uD83D\uDCBE ' + system.memoryMB + 'MB' + c.reset + c.dim + ' stores' + c.reset + '    ' +
    intellColor + '\uD83E\uDDE0 ' + String(system.intelligencePct).padStart(3) + '%' + c.reset
  );

  // TRUTH-SL-V1: SONA row now renders STORED artifacts, not free-running counters.
  // `{storedEpisodes} ep \u2502 {storedPatterns} pat \u2502 \u0394 {..} LoRA \u2502 {events} ev` \u2014 the
  // neural/stats.json event counter is DEMOTED to a dim `ev` chip (never labeled
  // traj) and omitted when 0/absent. Gauge tier is keyed on storedEpisodes.
  const _ri = system.ruflo || {};
  const _riEp = _ri.storedEpisodes || 0;
  const _riPat = _ri.storedPatterns || 0;
  if (_riEp > 0 || _riPat > 0) {
      const _rt = _ri.tier || 0;
      const _rl = '[' + '\u25CF'.repeat(_rt) + '\u25CB'.repeat(5 - _rt) + ']';
      const _rc = _rt >= 4 ? c.brightGreen : _rt >= 2 ? c.brightYellow : c.dim;
      let _rln = c.brightPurple + '\uD83D\uDCF6 SONA' + c.reset + '    ' + _rc + _rl + c.reset + '  ' + c.brightWhite + _riEp + c.reset + c.dim + ' ep' + c.reset + '  ' + c.dim + '\u2502' + c.reset + '  ' + c.brightWhite + _riPat + c.reset + c.dim + ' pat' + c.reset;
      if ((_ri.deltaNorm || 0) > 0) _rln += '  ' + c.dim + '\u2502' + c.reset + '  ' + c.cyan + '\u0394 ' + (_ri.deltaNorm).toFixed(2) + c.reset + c.dim + ' LoRA' + c.reset;
      if ((_ri.events || 0) > 0) _rln += '  ' + c.dim + '\u2502' + c.reset + '  ' + c.dim + _ri.events + ' ev' + c.reset;
      lines.push(_rln);
    }

  // RUFLO-INTEL-V3: self-IMPROVEMENT row (efficacy snapshot \u2014 honest/NEUTRAL, never "improving").
  // SONA above = self-LEARNING (artifacts grew); this row = did learning change behavior? The
  // verdict chip is capped at loop:closed/eff:flat: NO green, NO up-arrow, NO eff:+N. Hidden
  // when .claude-flow/selfimprove-history.jsonl is absent (matches the hide-on-absence convention).
  const _si = getSelfImprove();
  if (_si.available) {
    const _siQs = _si.qSpread.toFixed(2).replace(/^0/, '');
    const _siAcc = (_si.accFirst != null && _si.accFirst !== _si.accLast)
      ? c.brightWhite + _si.accLast + '%' + c.reset + c.dim + ' (' + _si.accFirst + '\u2192' + _si.accLast + ')' + c.reset
      : c.brightWhite + _si.accLast + '%' + c.reset;
    const _siChip = _si.rewardConstant
      ? c.dim + '\u26aa loop:open' + c.reset
      : c.brightYellow + '\u25c8 loop:closed eff:flat' + c.reset;
    // TRUTH-SL-V1: bench staleness chip \u2014 the SI row was frozen ~7 weeks (audit).
    // Warn (brightYellow) when the bench file hasn't been re-run in >7 days.
    const _siBench = (typeof _si.ageDays === 'number' && _si.ageDays > 7)
      ? '  ' + c.dim + '\u2502' + c.reset + '  ' + c.brightYellow + 'bench ' + Math.round(_si.ageDays) + 'd\u26a0' + c.reset
      : '';
    lines.push(
      c.brightCyan + '\ud83d\udd2c SI' + c.reset + '       ' +
      c.cyan + 'acc' + c.reset + ' ' + _siAcc + '  ' + c.dim + '\u2502' + c.reset + '  ' +
      c.cyan + '\u25c7' + c.reset + c.brightWhite + _si.rewardDistinct + c.reset + c.dim + ' rwd' + c.reset + '  ' + c.dim + '\u2502' + c.reset + '  ' +
      c.cyan + 'Qsprd ' + c.reset + c.brightWhite + _siQs + c.reset + '  ' + c.dim + '\u2502' + c.reset + '  ' +
      _siChip + _siBench
    );
  }
    // Line 3: Architecture
  // TRUTH-SL-V1: `Stores ●N/5` (same store-liveness measure) replaces the cosmetic
  // `Learn ●100%` (which was the memory.db-size bucket restated as dddProgress).
  const storesColor = storesLive >= 5 ? c.brightGreen : storesLive > 0 ? c.brightYellow : c.brightRed;
  const adrColor = adrCount > 0 ? (adrImpl === adrCount ? c.brightGreen : c.yellow) : c.dim;
  const adrDisplay = adrColor + '●' + adrImpl + '/' + adrCount + c.reset;

  lines.push(
    c.brightPurple + '🔧 Architecture' + c.reset + '    ' +
    c.cyan + 'ADRs' + c.reset + ' ' + adrDisplay + '  ' + c.dim + '│' + c.reset + '  ' +
    c.cyan + 'Stores' + c.reset + ' ' + storesColor + '●' + storesLive + '/5' + c.reset + '  ' + c.dim + '│' + c.reset + '  ' +
    c.cyan + 'Security' + c.reset + ' ' + secColor + '●' + secStatus + c.reset
  );

  // Plugins line
  const plugins = getPluginStatus();
  if (plugins.length > 0) {
    let pluginLine = c.brightGreen + '\uD83E\uDDE9 Plugins' + c.reset + '    ';
    pluginLine += plugins.map(p => {
      const stInd = p.status === 'active' ? c.brightGreen + '\u25CF' : p.status === 'installed' ? c.brightYellow + '\u25CB' : c.red + '\u25CB';
      return stInd + c.reset + ' ' + c.cyan + p.name + c.reset + ' ' + c.dim + p.version + c.reset;
    }).join('  ' + c.dim + '\u2502' + c.reset + '  ');
    lines.push(pluginLine);
  }

  // Line 4: AgentDB, Tests, Integration
  const hnswInd = hasHnsw ? c.brightGreen + '⚡' + c.reset : '';
  const sizeDisp = dbSizeKB >= 1024 ? (dbSizeKB / 1024).toFixed(1) + 'MB' : dbSizeKB + 'KB';
  const vectorColor = vectorCount > 0 ? c.brightGreen : c.dim;
  const testColor = testFiles > 0 ? c.brightGreen : c.dim;

  // MCP / DB integration from data
  const integration = d.integration || {};
  const mcpServers = (integration.mcpServers) || {};
  let integStr = '';
  if (mcpServers.total > 0) {
    const mcpCol = mcpServers.enabled === mcpServers.total ? c.brightGreen : mcpServers.enabled > 0 ? c.brightYellow : c.red;
    integStr += c.cyan + 'MCP' + c.reset + ' ' + mcpCol + '●' + mcpServers.enabled + '/' + mcpServers.total + c.reset;
  }
  if (integration.hasDatabase) integStr += (integStr ? '  ' : '') + c.brightGreen + '◆' + c.reset + 'DB';
  if (!integStr) integStr = c.dim + '● none' + c.reset;

  lines.push(
    c.brightCyan + '📊 AgentDB' + c.reset + '    ' +
    c.cyan + 'Vectors' + c.reset + ' ' + vectorColor + '●' + vectorCount + hnswInd + c.reset + '  ' + c.dim + '│' + c.reset + '  ' +
    c.cyan + 'Size' + c.reset + ' ' + c.brightWhite + sizeDisp + c.reset + '  ' + c.dim + '│' + c.reset + '  ' +
    c.cyan + 'Tests' + c.reset + ' ' + testColor + '●' + testFiles + c.reset + ' ' + c.dim + '(' + testCases + ' cases)' + c.reset + '  ' + c.dim + '│' + c.reset + '  ' +
    integStr
  );

  // Line 4b: Swarm DB — ruflo's .swarm/memory.db store (split from the AgentDB chip)
  const swHnswInd = swHasHnsw ? c.brightGreen + '⚡' + c.reset : '';
  const swSizeDisp = swDbSizeKB >= 1024 ? (swDbSizeKB / 1024).toFixed(1) + 'MB' : swDbSizeKB + 'KB';
  const swVectorColor = swVectorCount > 0 ? c.brightGreen : c.dim;
  lines.push(
    c.brightCyan + '🗃️  Swarm DB' + c.reset + '    ' +
    c.cyan + 'Vectors' + c.reset + ' ' + swVectorColor + '●' + swVectorCount + swHnswInd + c.reset + '  ' + c.dim + '│' + c.reset + '  ' +
    c.cyan + 'Size' + c.reset + ' ' + c.brightWhite + swSizeDisp + c.reset
  );

  // Line 4c: Ruflo Brain (BRAIN-STATUSLINE-V1) — the MCP-only knowledge base
  // (search_ruvnet). Rendered ONLY when the brain is registered in .mcp.json or
  // the KB cache exists; non-brain targets keep their current line count.
  const brain = d.brain || {};
  if (brain.registered || brain.kbPresent) {
    const bSize = brain.sizeKB >= 1048576
      ? (brain.sizeKB / 1048576).toFixed(1) + 'GB'
      : Math.floor(brain.sizeKB / 1024) + 'MB';
    const kbChip = brain.kbPresent
      ? c.brightGreen + '●' + brain.repos + ' repos' + c.reset + '  ' + c.dim + '│' + c.reset + '  ' +
        c.cyan + 'Size' + c.reset + ' ' + c.brightWhite + bSize + c.reset
      : c.brightYellow + '●missing' + c.reset + ' ' + c.dim + '(fix-brain --download)' + c.reset;
    const mcpChip = brain.registered
      ? c.brightGreen + '●registered' + c.reset
      : c.dim + '○unregistered' + c.reset;
    const readerChip = brain.kbPresent
      ? (brain.readerOk ? c.brightGreen + '●ok' + c.reset : c.brightYellow + '●missing' + c.reset)
      : c.dim + '○n/a' + c.reset;
    lines.push(
      c.brightCyan + '🧿 Ruflo Brain' + c.reset + '  ' +
      c.cyan + 'KB' + c.reset + ' ' + kbChip + '  ' + c.dim + '│' + c.reset + '  ' +
      c.cyan + 'MCP' + c.reset + ' ' + mcpChip + '  ' + c.dim + '│' + c.reset + '  ' +
      c.cyan + 'Reader' + c.reset + ' ' + readerChip
    );
  }


  // Line 6: Agentic QE v3 footer (AQE-FOOTER-V2 — enriched with vec + MB chips)
  const aqe = getAQEStats();
  if (aqe.available) {
    const patColor = aqe.patterns > 0 ? c.brightGreen : c.dim;
    const trajStr = aqe.trajectories > 0
      ? '  ' + c.dim + '\u2502' + c.reset + '  ' + c.brightYellow + '\uD83E\uDDED ' + aqe.trajectories + ' traj' + c.reset
      : '';
    // TRUTH-SL-V1: `N vec` = non-traj embeddings only (the row already shows traj
    // separately); \u26A1 lit ONLY on a real index (hasIndex), unlit here (empty hnsw dir).
    const vecHnsw = aqe.hasIndex ? c.brightGreen + '\u26A1' + c.reset : '';
    const vecStr = aqe.vectors > 0
      ? '  ' + c.dim + '\u2502' + c.reset + '  ' + c.brightCyan + '\uD83E\uDDEC ' + aqe.vectors + ' vec' + c.reset + vecHnsw
      : '';
    const sizeStr = aqe.dbSizeKB > 0
      ? '  ' + c.dim + '\u2502' + c.reset + '  ' + c.brightCyan + '\uD83D\uDCBE ' + (aqe.dbSizeKB / 1024).toFixed(1) + 'MB' + c.reset
      : '';
    const aqeBranch = git.gitBranch
      ? '  ' + c.brightBlue + '\u23C7 ' + git.gitBranch + c.reset
      : '';
    lines.push(
      c.bold + c.brightPurple + '\u258A Agentic QE v3' + c.reset + aqeBranch +
      '  ' + patColor + '\uD83C\uDF93 ' + aqe.patterns + ' patterns' + c.reset + trajStr + vecStr + sizeStr
    );
  }

  return lines.join('\n');
}

// JSON output — delegates to CLI for accuracy; caller can use --json flag
function generateJSON() {
  const d = getStatuslineData();
  // Schema guarantee (ported from the installed helper, SCHEMA-NORM): chip keys must
  // exist no matter which branch produced d (a 10s cache written by an older writer,
  // upstream CLI schema drift, or an overlay probe failure). getStatuslineData already
  // applies the truth overlay, so these are normally present; this is the defensive
  // backstop consumers (dashboard, tests) rely on. TRUTH-SL-V1 additive keys (stores,
  // swarm.registry, aqe, selfImprove, system.ruflo.*) come through the overlay itself.
  if (!d.swarmdb) { try { d.swarmdb = _ra_swarmdb(); } catch (e) { d.swarmdb = { vectorCount: 0, dbSizeKB: 0, hasHnsw: false }; } }
  if (!d.agentdb) { try { d.agentdb = _ra_agentdb(); } catch (e) { d.agentdb = { vectorCount: 0, dbSizeKB: 0, hasHnsw: false }; } }
  if (!d.tests)   { try { d.tests   = getLocalTestCount(); } catch (e) { d.tests = { testFiles: 0, testCases: 0 }; } }
  if (!d.adrs)    { try { d.adrs    = getLocalADRCount(); } catch (e) { d.adrs = { count: 0, implemented: 0, compliance: 0 }; } }
  if (!d.hooks)   { try { d.hooks   = _ra_hooks(); } catch (e) { d.hooks = { enabled: 0, total: 0 }; } }
  const git = getGitInfo();
  return Object.assign({}, d, {
    user: Object.assign({ name: git.name, gitBranch: git.gitBranch }, d.user || {}),
    git: { modified: git.modified, untracked: git.untracked, staged: git.staged, ahead: git.ahead, behind: git.behind },
    lastUpdated: new Date().toISOString(),
  });
}

// ─── Main ───────────────────────────────────────────────────────
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(generateJSON(), null, 2));
} else if (process.argv.includes('--compact')) {
  console.log(JSON.stringify(generateJSON()));
} else {
  console.log(generateStatusline());
}
