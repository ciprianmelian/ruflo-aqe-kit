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

function _ra_intelligence() {
  // RUFLO-INTEL-V2: 🧠 is a REAL ruflo-only learning score — NOT ruflo's hardcoded
  // Routing Accuracy (0.82) or Avg Quality (0.75), which are fixed constants. We use
  // the trained micro-LoRA magnitude (sum|B| of .swarm/lora-weights.json — 0 until real
  // training lands, grows with on-device learning) plus real trajectory/pattern counts.
  let traj = 0, patterns = 0, deltaNorm = 0;
  function _pick(raw, label) {
    const i = raw.indexOf(label);
    if (i === -1) return 0;
    const seg = raw.slice(i + label.length, i + label.length + 40).replace(/[^0-9.]/g, ' ').trim().split(' ')[0];
    const v = parseFloat(seg);
    return Number.isFinite(v) ? v : 0;
  }
  try {
    const raw = require('child_process').execSync('ruflo hooks intelligence stats 2>/dev/null', { timeout: 5000, stdio: ['ignore','pipe','ignore'] }).toString();
    traj = Math.round(_pick(raw, 'Trajectories'));
    patterns = Math.round(_pick(raw, 'Patterns Learned'));
  } catch (e) {}
  if (traj === 0 && patterns === 0) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(CWD, '.claude-flow', 'neural', 'stats.json'), 'utf-8'));
      traj = j.trajectoriesRecorded || 0; patterns = j.patternsLearned || 0;
    } catch (e) {}
  }
  try {
    const w = JSON.parse(fs.readFileSync(path.join(CWD, '.swarm', 'lora-weights.json'), 'utf-8'));
    const B = (w.weights && w.weights.B) || w.B || [];
    for (let i = 0; i < B.length; i++) deltaNorm += Math.abs(B[i]);
  } catch (e) {}
  // bounded 0-99 score from real signals; trained-LoRA delta dominates (saturating),
  // trajectory + pattern maturity add the rest. Moves with genuine learning activity.
  const trainedPct = deltaNorm > 0 ? 55 * (1 - Math.exp(-deltaNorm)) : 0;
  const trajPct = 30 * Math.min(1, traj / 500);
  const patPct = 14 * Math.min(1, patterns / 50);
  const pct = Math.min(99, Math.round(trainedPct + trajPct + patPct));
  let tier = 0; for (const t of [50, 150, 350, 700, 1500]) { if (traj >= t) tier++; }
  return { pct: pct, traj: traj, patterns: patterns, deltaNorm: deltaNorm, tier: tier };
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
  let hnsw = false;
  if (_ra_tbl(db, 'vector_indexes')) hnsw = _ra_count(db, 'SELECT COALESCE(SUM(total_vectors),0) FROM vector_indexes') > 0;
  return { vectorCount: v, dbSizeKB: Math.floor(kb), hasHnsw: hnsw };
}
function _ra_swarmdb() {
  // 🗃️ Swarm DB chip = ruflo's claude-flow memory store (.swarm/memory.db).
  // This is the source the AgentDB chip used to (mis)read; split out per its own
  // label so neither chip impersonates the other.
  const db = path.join(CWD, '.swarm', 'memory.db');
  let v = _ra_count(db, 'SELECT COUNT(*) FROM memory_entries WHERE embedding IS NOT NULL');
  if (_ra_tbl(db, 'pattern_embeddings')) v += _ra_count(db, 'SELECT COUNT(*) FROM pattern_embeddings');
  if (_ra_tbl(db, 'learning_state_embeddings')) v += _ra_count(db, 'SELECT COUNT(*) FROM learning_state_embeddings');
  if (_ra_tbl(db, 'patterns')) v += _ra_count(db, 'SELECT COUNT(*) FROM patterns WHERE embedding IS NOT NULL');
  let kb = _ra_dbkb(db);
  try { kb += fs.statSync(path.join(CWD, '.swarm', 'hnsw.index')).size / 1024; } catch (e) {}
  // Honest ⚡ — same bar as _ra_agentdb: lit only when vectors are actually indexed
  // (a real hnsw.index file, or vector_indexes with SUM(total_vectors)>0). ruflo's
  // backend is "sql.js + HNSW"-capable, but empty index defs (total_vectors=0) are
  // NOT a populated index, so we do not fake ⚡ off mere row-existence.
  let hnsw = fs.existsSync(path.join(CWD, '.swarm', 'hnsw.index'));
  if (!hnsw && _ra_tbl(db, 'vector_indexes')) hnsw = _ra_count(db, 'SELECT COALESCE(SUM(total_vectors),0) FROM vector_indexes') > 0;
  return { vectorCount: v, dbSizeKB: Math.floor(kb), hasHnsw: hnsw };
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
  const db = path.join(CWD, '.agentic-qe', 'memory.db');
  let v = 0;
  if (_ra_tbl(db, 'embeddings')) v += _ra_count(db, 'SELECT COUNT(*) FROM embeddings');
  if (_ra_tbl(db, 'qe_pattern_embeddings')) v += _ra_count(db, 'SELECT COUNT(*) FROM qe_pattern_embeddings');
  for (const t of ['captured_experiences','vectors','qe_trajectories','concept_nodes','pattern_versions','hypergraph_nodes']) {
    if (_ra_tbl(db, t)) v += _ra_count(db, 'SELECT COUNT(*) FROM ' + t + ' WHERE embedding IS NOT NULL');
  }
  if (_ra_tbl(db, 'sona_patterns')) v += _ra_count(db, 'SELECT COUNT(*) FROM sona_patterns WHERE state_embedding IS NOT NULL');
  let kb = _ra_dbkb(db);
  return { vectors: v, dbSizeKB: Math.floor(kb), hasHnsw: v > 0 };
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

function getStatuslineData() {
  const cached = readCache();
  if (cached) {
    // Backfill cheap local-only fields an older cache writer may have omitted,
    // so the Tests / ADRs chips never show a stale 0 across a version upgrade
    // (the CLI JSON omits test counts entirely). No-op once a current writer has
    // cached them; both are bounded local dir-walks, no network.
    if (!cached.tests || cached.tests.testFiles === undefined) { try { cached.tests = getLocalTestCount(); } catch (e) {} }
    if (!cached.adrs || cached.adrs.count === undefined) { try { cached.adrs = getLocalADRCount(); } catch (e) {} }
    if (!cached.brain) { try { cached.brain = _ra_brain(); } catch (e) {} }
    return cached;
  }

  try {
    const raw = execSync(
      'ruflo hooks statusline --json 2>/dev/null',
      { encoding: 'utf-8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'], cwd: CWD }
    ).trim();
    // The CLI may emit preamble lines before the JSON — find the first '{'.
    const jsonStart = raw.indexOf('{');
    if (jsonStart === -1) throw new Error('no JSON in CLI output');
    const data = JSON.parse(raw.slice(jsonStart));
    // Overlay real ADR count from both local directories (fast, no network).
    data.adrs = getLocalADRCount();
    // Overlay real test-file count — the CLI JSON omits it, so without this the
    // Tests chip is a permanent 0 even on repos with hundreds of tests.
    try { data.tests = getLocalTestCount(); } catch (e) {}
    try { data.agentdb = _ra_agentdb(); } catch (e) {}
    try { data.swarmdb = _ra_swarmdb(); } catch (e) {}
    try { data.brain = _ra_brain(); } catch (e) {}
    try { const ri = _ra_intelligence(); data.system = Object.assign({}, data.system, { ruflo: ri }); if (ri.pct > 0) data.system.intelligencePct = ri.pct; } catch (e) {}
    try { data.integration = Object.assign({}, data.integration, { mcpServers: _ra_mcp() }); } catch (e) {}
    try { if (!data.hooks || data.hooks.total === undefined) data.hooks = _ra_hooks(); } catch (e) {}
    writeCache(data);
    return data;
  } catch { /* CLI unavailable or timed out */ }

  // Fallback: use local file probes only (will be less accurate, but non-zero
  // when CLI is available and accurate when it's not).
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
  let testFiles = 0;
  function countTests(dir, depth) {
    if ((depth || 0) > 5) return;
    try {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
          countTests(path.join(dir, e.name), (depth || 0) + 1);
        } else if (e.isFile() && (e.name.includes('.test.') || e.name.includes('.spec.') || e.name.startsWith('test_') || e.name.startsWith('spec_'))) {
          testFiles++;
        }
      }
    } catch { /* ignore */ }
  }
  // Cover monorepo layouts (packages/*) in addition to the common roots.
  for (const d of ['tests', 'test', '__tests__', 'src', 'v3', 'packages', 'apps']) {
    countTests(path.join(CWD, d), 0);
  }
  return { testFiles, testCases: testFiles * 4 };
}

// Minimal local fallback when the CLI is not installed or times out.
// Returns a structure that matches the CLI JSON schema so the renderer works.
function buildLocalFallback() {
  const memMB = Math.floor(process.memoryUsage().heapUsed / 1024 / 1024);
  const adrs = getLocalADRCount();
  const { testFiles } = getLocalTestCount();
  let brain = null;
  try { brain = _ra_brain(); } catch (e) {}

  return {
    brain,
    user: { name: 'user', gitBranch: '', modelName: 'Claude Code' },
    v3Progress: { domainsCompleted: 0, totalDomains: 5, dddProgress: 0, patternsLearned: 0, sessionsCompleted: 0 },
    security: { status: 'NONE', cvesFixed: 0, totalCves: 0 },
    swarm: { activeAgents: 0, maxAgents: CONFIG.maxAgents, coordinationActive: false },
    system: { memoryMB: memMB, contextPct: 0, intelligencePct: 0, subAgents: 0 },
    adrs,
    hooks: { enabled: 0, total: 0 },
    agentdb: { vectorCount: 0, dbSizeKB: 0, hasHnsw: false },
    swarmdb: { vectorCount: 0, dbSizeKB: 0, hasHnsw: false },
    tests: { testFiles, testCases: testFiles * 4 },
    lastUpdated: new Date().toISOString(),
  };
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

// Detect model name from Claude config (pure file reads, no exec)
function getModelName() {
  try {
    const claudeConfig = readJSON(path.join(os.homedir(), '.claude.json'));
    if (claudeConfig && claudeConfig.projects) {
      for (const [projectPath, projectConfig] of Object.entries(claudeConfig.projects)) {
        if (CWD === projectPath || CWD.startsWith(projectPath + '/')) {
          const usage = projectConfig.lastModelUsage;
          if (usage) {
            const ids = Object.keys(usage);
            if (ids.length > 0) {
              let modelId = ids[ids.length - 1];
              let latest = 0;
              for (const id of ids) {
                const ts = usage[id] && usage[id].lastUsedAt ? new Date(usage[id].lastUsedAt).getTime() : 0;
                if (ts > latest) { latest = ts; modelId = id; }
              }
              if (modelId.includes('opus')) return 'Opus 4.7';
              if (modelId.includes('sonnet')) return 'Sonnet 4.6';
              if (modelId.includes('haiku')) return 'Haiku 4.5';
              return modelId.split('-').slice(1, 3).join(' ');
            }
          }
          break;
        }
      }
    }
  } catch { /* ignore */ }

  // Fallback: settings.json model field
  const settings = getSettings();
  if (settings && settings.model) {
    const m = settings.model;
    if (m.includes('opus')) return 'Opus 4.7';
    if (m.includes('sonnet')) return 'Sonnet 4.6';
    if (m.includes('haiku')) return 'Haiku 4.5';
  }
  return 'Claude Code';
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
  let ver = '3.10.5';
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
  if (!fs.existsSync(dbPath)) return { available: false, patterns: 0, trajectories: 0, vectors: 0, dbSizeKB: 0, hasHnsw: false };
  let p = 0, t = 0;
  try {
    const sql = "SELECT (SELECT COUNT(*) FROM qe_patterns WHERE usage_count > 0 OR quality_score > 0 OR name NOT LIKE 'bench-%') || '|' || (SELECT COUNT(*) FROM qe_trajectories);";
    const out = execFileSync('sqlite3', ['-readonly', dbPath, sql], { timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const parts = out.split('|').map(n => parseInt(n, 10) || 0); p = parts[0] || 0; t = parts[1] || 0;
  } catch (e) { /* ignore */ }
  let vec = 0, mb = 0, hnsw = false;
  try { const av = _ra_aqevec(); vec = av.vectors || 0; mb = av.dbSizeKB || 0; hnsw = !!av.hasHnsw; } catch (e) { /* ignore */ }
  return { available: true, patterns: p, trajectories: t, vectors: vec, dbSizeKB: mb, hasHnsw: hnsw };
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
    };
  } catch { return { available: false }; }
}

function generateStatusline() {
  const d = getStatuslineData();
  const git = getGitInfo();
  const modelName = getModelFromStdin() || (d.user && d.user.modelName) || 'Claude Code';
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

  const domainsCompleted = progress.domainsCompleted || 0;
  const totalDomains = progress.totalDomains || 5;
  const dddProgress = progress.dddProgress || 0;
  const patternsLearned = progress.patternsLearned || 0;
  const activeAgents = swarm.activeAgents || 0;
  const maxAgents = swarm.maxAgents || CONFIG.maxAgents;
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
  const hooksTotal = hooks.total || 0;
  const vectorCount = agentdb.vectorCount || 0;
  const hasHnsw = agentdb.hasHnsw || false;
  const dbSizeKB = agentdb.dbSizeKB || 0;
  const swarmdb = d.swarmdb || {};
  const swVectorCount = swarmdb.vectorCount || 0;
  const swHasHnsw = swarmdb.hasHnsw || false;
  const swDbSizeKB = swarmdb.dbSizeKB || 0;
  const testFiles = tests.testFiles || 0;
  const testCases = tests.testCases || testFiles * 4;

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
  header += '  ' + c.dim + '│' + c.reset + '  ' + c.purple + modelName + c.reset;
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

  // Line 1: DDD Domains
  const domainsColor = domainsCompleted >= 3 ? c.brightGreen : domainsCompleted > 0 ? c.yellow : c.red;
  let perfIndicator;
  const hnswVecs = (hasHnsw ? vectorCount : 0) + (swHasHnsw ? swVectorCount : 0);
  if (hnswVecs > 0) {
    const speedup = hnswVecs > 10000 ? '12500x' : hnswVecs > 1000 ? '150x' : '10x';
    perfIndicator = c.brightGreen + '⚡ HNSW ' + speedup + c.reset;
  } else if (patternsLearned > 0) {
    const pk = patternsLearned >= 1000 ? (patternsLearned / 1000).toFixed(1) + 'k' : String(patternsLearned);
    perfIndicator = c.brightYellow + '📚 ' + pk + ' patterns' + c.reset;
  } else {
    perfIndicator = c.dim + '⚡ target: 150x-12500x' + c.reset;
  }
  lines.push(
    c.brightCyan + '🏗️  Learning' + c.reset + '    ' + progressBar(domainsCompleted, totalDomains) + '  ' +
    domainsColor + domainsCompleted + c.reset + '/' + c.brightWhite + totalDomains + c.reset + '    ' + perfIndicator
  );

  // Line 2: Swarm + Hooks + CVE + Memory + Intelligence
  const swarmInd = swarm.coordinationActive ? c.brightGreen + '\u25C9' + c.reset : c.dim + '\u25CB' + c.reset;
  const agentsColor = swarm.activeAgents > 0 ? c.brightGreen : c.dim;
  const secIcon = security.status === 'CLEAN' ? '\uD83D\uDFE2' : (security.status === 'IN_PROGRESS' || security.status === 'STALE') ? '\uD83D\uDFE1' : (security.status === 'NONE' ? '\u26AA' : '\uD83D\uDD34');
  const secColor = security.status === 'CLEAN' ? c.brightGreen : (security.status === 'IN_PROGRESS' || security.status === 'STALE') ? c.brightYellow : (security.status === 'NONE' ? c.dim : c.brightRed);
  const hooksColor = hooksEnabled > 0 ? c.brightGreen : c.dim;
  const intellColor = system.intelligencePct >= 80 ? c.brightGreen : system.intelligencePct >= 40 ? c.brightYellow : c.dim;
  const topoTag = swarm.topology ? ' ' + c.dim + swarm.topology.slice(0, 5) + c.reset : '';
  const subColor = system.subAgents > 0 ? c.brightPurple : c.dim;
  const subLabel = system.subAgents > 0 ? 'Sub ' + system.subAgents : 'Sub 0';

  lines.push(
    c.brightYellow + '\uD83E\uDD16 Swarm' + c.reset + '  ' + swarmInd + ' [' + agentsColor + String(swarm.activeAgents).padStart(2) + c.reset + '/' + c.brightWhite + swarm.maxAgents + c.reset + ']' + topoTag + '  ' +
    subColor + '\uD83D\uDC65 ' + subLabel + c.reset + '    ' +
    c.brightBlue + '\uD83E\uDE9D ' + hooksColor + hooksEnabled + c.reset + '/' + c.brightWhite + hooksTotal + c.reset + '    ' +
    secIcon + ' ' + secColor + 'CVE ' + security.cvesFixed + c.reset + '/' + c.brightWhite + security.totalCves + c.reset + '    ' +
    c.brightCyan + '\uD83D\uDCBE ' + system.memoryMB + 'MB' + c.reset + '    ' +
    intellColor + '\uD83E\uDDE0 ' + String(system.intelligencePct).padStart(3) + '%' + c.reset
  );

  // RUFLO-INTEL-V1: SONA/neural learning ladder (Ruflo-only intelligence chip)
  const _ri = system.ruflo || {};
  if ((_ri.traj || 0) > 0 || (_ri.patterns || 0) > 0) {
      const _rt = _ri.tier || 0;
      const _rl = '[' + '\u25CF'.repeat(_rt) + '\u25CB'.repeat(5 - _rt) + ']';
      const _rc = _rt >= 4 ? c.brightGreen : _rt >= 2 ? c.brightYellow : c.dim;
      let _rln = c.brightPurple + '\uD83D\uDCF6 SONA' + c.reset + '    ' + _rc + _rl + c.reset + '  ' + c.brightWhite + (_ri.traj || 0) + c.reset + c.dim + ' traj' + c.reset + '  ' + c.dim + '\u2502' + c.reset + '  ' + c.brightWhite + (_ri.patterns || 0) + c.reset + c.dim + ' patterns' + c.reset;
      if ((_ri.deltaNorm || 0) > 0) _rln += '  ' + c.dim + '\u2502' + c.reset + '  ' + c.cyan + '\u0394 ' + (_ri.deltaNorm).toFixed(2) + c.reset + c.dim + ' LoRA' + c.reset;
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
    lines.push(
      c.brightCyan + '\ud83d\udd2c SI' + c.reset + '       ' +
      c.cyan + 'acc' + c.reset + ' ' + _siAcc + '  ' + c.dim + '\u2502' + c.reset + '  ' +
      c.cyan + '\u25c7' + c.reset + c.brightWhite + _si.rewardDistinct + c.reset + c.dim + ' rwd' + c.reset + '  ' + c.dim + '\u2502' + c.reset + '  ' +
      c.cyan + 'Q\u00b1' + c.reset + c.brightWhite + _siQs + c.reset + '  ' + c.dim + '\u2502' + c.reset + '  ' +
      _siChip
    );
  }
    // Line 3: Architecture
  const dddColor = dddProgress >= 50 ? c.brightGreen : dddProgress > 0 ? c.yellow : c.red;
  const adrColor = adrCount > 0 ? (adrImpl === adrCount ? c.brightGreen : c.yellow) : c.dim;
  const adrDisplay = adrColor + '●' + adrImpl + '/' + adrCount + c.reset;

  lines.push(
    c.brightPurple + '🔧 Architecture' + c.reset + '    ' +
    c.cyan + 'ADRs' + c.reset + ' ' + adrDisplay + '  ' + c.dim + '│' + c.reset + '  ' +
    c.cyan + 'Learn' + c.reset + ' ' + dddColor + '●' + String(dddProgress).padStart(3) + '%' + c.reset + '  ' + c.dim + '│' + c.reset + '  ' +
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
    c.cyan + 'Tests' + c.reset + ' ' + testColor + '●' + testFiles + c.reset + ' ' + c.dim + '(~' + testCases + ' cases)' + c.reset + '  ' + c.dim + '│' + c.reset + '  ' +
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
    const vecHnsw = aqe.hasHnsw ? c.brightGreen + '\u26A1' + c.reset : '';
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
