#!/usr/bin/env bash
set -uo pipefail

# ============================================================================
# fix-statusbar.sh — Restore ruflo + Agentic QE v3 coexistence in status bar
#
# Idempotent. Safe to re-run after `aqe init` or any tool that resets
# .claude/helpers/statusline-v3.cjs to the minimal stub.
#
# What it does:
#   1. Patches .claude/helpers/statusline.cjs:
#        - Header label → "RuFlo V<major>.<minor>" (detected from the installed
#          ruflo binary, e.g. "V3.10" for ruflo 3.10.3)
#        - Adds getAQEStats() helper + "Agentic QE v3" footer line
#   2. Writes .claude/helpers/statusline-v3.cjs as a dual ruflo+AQE fallback.
#   3. Patches .claude/settings.json statusLine.command to use the rich script
#      with the v3 stub as fallback.
#   4. Removes legacy @claude-flow/plugin-agentic-qe (alpha) from package.json.
#
# Usage: bin/ruflo-kit fix-statusbar <target>
# ============================================================================

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
info() { echo -e "  ${CYAN}→${NC} $1"; }

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
kit_resolve "$@"
kit_require_target
cd "$TARGET_DIR"

echo "============================================"
echo " fix-statusbar.sh"
echo " kit:    $KIT_DIR"
echo " target: $TARGET_DIR"
echo "============================================"

mkdir -p .claude/helpers

# ── Detect installed ruflo version → "V<major>.<minor>" (e.g. "V3.10") ─────
# Tries (in order): `ruflo --version`, then `npx ruflo@latest --version`.
# Output of `ruflo --version` looks like "ruflo v3.10.3" — we extract "3.10".
# If detection fails completely, we fall back to "V3" so the regex still
# matches any "▊ RuFlo V3.X " in the template.
detect_ruflo_version() {
  local raw
  raw="$(ruflo --version 2>/dev/null || true)"
  if [[ -z "$raw" ]]; then
    raw="$(npx -y ruflo@latest --version 2>/dev/null || true)"
  fi
  # Match the first <major>.<minor>(.<patch>)? token in the output
  # (e.g. "ruflo v3.10.3" → "3.10.3").
  echo "$raw" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1
}

RUFLO_VERSION_FULL="$(detect_ruflo_version)"
if [[ -z "$RUFLO_VERSION_FULL" ]]; then
  warn "Could not detect ruflo version — using fallback 'V3'"
  RUFLO_VERSION_FULL="3"
  RUFLO_VERSION_LABEL="V3"
else
  # Label uses major.minor only (e.g. "V3.10" for 3.10.3).
  RUFLO_VERSION_MM="$(echo "$RUFLO_VERSION_FULL" | grep -oE '^[0-9]+\.[0-9]+' || echo "3")"
  RUFLO_VERSION_LABEL="V$RUFLO_VERSION_MM"
fi
info "Detected ruflo version: $RUFLO_VERSION_FULL (label: $RUFLO_VERSION_LABEL)"

# ── Step 1: Patch the rich statusline (statusline.cjs) ─────────────────────
echo -e "\n${CYAN}[1/4]${NC} Patching .claude/helpers/statusline.cjs"

STATUSLINE_FILE=".claude/helpers/statusline.cjs"
STATUSLINE_BAK="${STATUSLINE_FILE}.bak"

if [[ ! -f "$STATUSLINE_FILE" ]]; then
  warn "statusline.cjs not found — skipping (re-run \`npx ruflo init\` to regenerate)"
else
  # Defense-in-depth: snapshot before patching so a broken write can be
  # restored from .bak after `node --check` fails.
  cp "$STATUSLINE_FILE" "$STATUSLINE_BAK"

  RUFLO_VERSION_LABEL="$RUFLO_VERSION_LABEL" \
  RUFLO_VERSION_FULL="$RUFLO_VERSION_FULL" \
  node - <<'NODE' || fail "statusline.cjs patch failed"
const fs = require('fs');
const file = '.claude/helpers/statusline.cjs';
let src = fs.readFileSync(file, 'utf-8');
let changed = false;

// Version values are passed from bash. Label = "V<major>.<minor>" for any
// hardcoded literal headers; Full = "<major>.<minor>(.<patch>)?" for the
// runtime fallback default inside the generator.
const versionLabel = (process.env.RUFLO_VERSION_LABEL || 'V3').trim();
const versionFull  = (process.env.RUFLO_VERSION_FULL  || '3').trim();

// (1a) Literal-header patch — for older templates that hardcode "▊ RuFlo V3.X "
// directly in the rendered string. Modern templates concatenate the version at
// runtime, so this branch is a no-op there (kept for backwards compat).
const desiredHeader = '▊ RuFlo ' + versionLabel + ' ';
const headerRe = /▊ RuFlo V\d+(?:\.\d+)? /;
if (headerRe.test(src) && !src.includes(desiredHeader)) {
  src = src.replace(headerRe, desiredHeader);
  changed = true;
  console.log('  patched: literal header → ' + versionLabel);
}

// (1b) Runtime-fallback patch — the generator reads ruflo's package.json from a
// list of locations; if none is found it falls back to `let pkgVersion = '3.X';`
// (a hardcoded default that goes stale across ruflo releases). Update that
// default to the actually-installed version so users without a plugin-style
// install still see the right number.
const fallbackRe = /let pkgVersion = '([^']+)';/;
const fallbackMatch = src.match(fallbackRe);
if (fallbackMatch) {
  if (fallbackMatch[1] !== versionFull) {
    src = src.replace(fallbackRe, "let pkgVersion = '" + versionFull + "';");
    changed = true;
    console.log('  patched: runtime fallback ' + fallbackMatch[1] + ' → ' + versionFull);
  } else {
    console.log('  runtime fallback already at ' + versionFull);
  }
}

// (1c) AQE stats helper — insert before "// Test stats (count files only" comment.
if (!src.includes('function getAQEStats')) {
  const helper = `// Agentic QE v3 stats — query via sqlite3 CLI (better-sqlite3 binding may be stale)
function getAQEStats() {
  const dbPath = path.join(CWD, '.agentic-qe', 'memory.db');
  if (!safeStat(dbPath)) return { available: false, patterns: 0, trajectories: 0 };
  const sql = "SELECT (SELECT COUNT(*) FROM qe_patterns WHERE usage_count > 0 OR quality_score > 0 OR name NOT LIKE 'bench-%') || '|' || (SELECT COUNT(*) FROM qe_trajectories);";
  const out = safeExec(\`sqlite3 -readonly "\${dbPath}" "\${sql}"\`, 2000);
  if (!out) return { available: true, patterns: 0, trajectories: 0 };
  const [p, t] = out.split('|').map(n => parseInt(n, 10) || 0);
  return { available: true, patterns: p, trajectories: t };
}

`;
  const anchor = '// Test stats (count files only';
  if (src.includes(anchor)) {
    src = src.replace(anchor, helper + anchor);
    changed = true;
    console.log('  patched: inserted getAQEStats()');
  } else {
    console.log('  WARN: anchor for getAQEStats not found');
  }
}

// (1d) AQE footer render — insert before "return lines.join('\\n');" in generateStatusline
if (!src.includes('Line 6: Agentic QE v3 footer')) {
  const footer = `  // Line 6: Agentic QE v3 footer
  const aqe = getAQEStats();
  if (aqe.available) {
    const patColor = aqe.patterns > 0 ? c.brightGreen : c.dim;
    const trajStr = aqe.trajectories > 0
      ? '  ' + c.dim + '│' + c.reset + '  ' + c.brightYellow + '🧭 ' + aqe.trajectories + ' traj' + c.reset
      : '';
    const aqeBranch = git.gitBranch
      ? '  ' + c.brightBlue + '⏇ ' + git.gitBranch + c.reset
      : '';
    lines.push(
      c.bold + c.brightPurple + '▊ Agentic QE v3' + c.reset + aqeBranch +
      '  ' + patColor + '🎓 ' + aqe.patterns + ' patterns' + c.reset + trajStr
    );
  }

`;
  // Anchor: the return statement at the end of generateStatusline (after the AgentDB push).
  // We match the closing of the AgentDB lines.push and the following return.
  const anchorRe = /(\bintegStr\s*\n\s*\);\s*\n)\s*(return lines\.join\('\\n'\);)/;
  if (anchorRe.test(src)) {
    src = src.replace(anchorRe, '$1\n' + footer + '  $2');
    changed = true;
    console.log('  patched: inserted AQE footer render');
  } else {
    console.log('  WARN: anchor for AQE footer not found');
  }
}

// (1f) Repair known corruption from a prior gist version of fix-ruflo.sh:
// the slash-escaping in `CWD.replace(/\\//g, '-')` was double-stripped (bash +
// template literal) and ended up written as `CWD.replace(///g, '-')`, where
// `//` is parsed as a single-line comment — breaking the file with a
// SyntaxError. If we see that pattern, repair it.
const brokenRe = /\.replace\(\/\/\/g,\s*'-'\)/;
if (brokenRe.test(src)) {
  src = src.replace(brokenRe, ".replace(/\\//g, '-')");
  changed = true;
  console.log('  repaired: CWD.replace(///g) → CWD.replace(/\\//g)');
}

// (1g) MCP integration counter — repairs the "MCP ●0/1 (red)" regression.
// The default getIntegrationStatus() in newer ruflo statusline.cjs builds
// (>= 3.10.x) treats `enabledMcpjsonServers` as the *enabled* list and
// `settings.mcpServers` (object) as the *total* list. That intersection is
// almost always empty on real installs:
//   - `settings.mcpServers` carries user-scope servers (ruflo)
//   - `enabledMcpjsonServers` carries project-scope .mcp.json enables
//     (agentic-qe in our case)
// Result: enabled=0, total=1, "MCP ●0/1" in red, even though both servers
// are actually live. Replace the helper with a corrected one that unions
// settings.mcpServers + .mcp.json mcpServers for `total` and counts
// settings.mcpServers (always-on) + enabledMcpjsonServers ∩ .mcp.json for
// `enabled`. Idempotent via the marker comment "MCP-COUNT-PATCH-V1".
if (!src.includes('MCP-COUNT-PATCH-V1')) {
  const oldMcpRe = /(\/\/ Integration status[\s\S]*?\bfunction getIntegrationStatus\(\)\s*\{)[\s\S]*?(\n\s*const hasDatabase = \[)/;
  const newHead = "$1\n  // MCP-COUNT-PATCH-V1: union settings.mcpServers + .mcp.json for total;\n  // count always-on settings.mcpServers + (enabledMcpjsonServers ∩ .mcp.json) for enabled.\n  const settings = getSettings();\n  const settingsServers = (settings && settings.mcpServers && typeof settings.mcpServers === 'object')\n    ? Object.keys(settings.mcpServers) : [];\n  const mcpConfig = readJSON(path.join(CWD, '.mcp.json'))\n                 || readJSON(path.join(os.homedir(), '.claude', 'mcp.json'));\n  const projectServers = (mcpConfig && mcpConfig.mcpServers && typeof mcpConfig.mcpServers === 'object')\n    ? Object.keys(mcpConfig.mcpServers) : [];\n  const enabledList = (settings && Array.isArray(settings.enabledMcpjsonServers))\n    ? settings.enabledMcpjsonServers : [];\n  const totalSet = new Set([...settingsServers, ...projectServers]);\n  const enabledSet = new Set([\n    ...settingsServers, // settings-scope servers are always considered enabled\n    ...projectServers.filter(s => enabledList.includes(s)),\n  ]);\n  const mcpServers = { total: totalSet.size, enabled: enabledSet.size };\n$2";
  if (oldMcpRe.test(src)) {
    src = src.replace(oldMcpRe, newHead);
    // Now strip the legacy total/enabled computation block that lived between
    // the function signature and "const hasDatabase = [...]" — our new block
    // already defines `mcpServers`, so any remaining `mcpServers.total = ...`
    // / `mcpServers.enabled = ...` lines would shadow or double-write. The
    // regex above swallowed them because [\s\S]*? is non-greedy to the
    // hasDatabase line.
    changed = true;
    console.log('  patched: getIntegrationStatus MCP counter (MCP-COUNT-PATCH-V1)');
  } else {
    console.log('  WARN: anchor for MCP counter patch not found');
  }
}

// (1h) Vectors + HNSW indicator — repairs "Vectors ●0" and missing "⚡ HNSW"
// chip. The default getAgentDBStats() in statusline.cjs counts vectors from
// JSON files (auto-memory-store.json, ranked-context.json) but never reads
// the real row counts from the sqlite-backed DBs — and detects HNSW only via
// a `.swarm/hnsw.index` file that does not exist on modern ruflo (HNSW is
// stored in-DB via the `vector_indexes` table; see docs/_INSTRUCTIONS.md
// Local Patch #7C). Replace with a corrected helper that:
//   - sums row counts across memory_entries / pattern_embeddings /
//     learning_state_embeddings (.swarm/memory.db) AND embeddings /
//     qe_pattern_embeddings (.agentic-qe/memory.db);
//   - flags HNSW active when either an on-disk hnsw.index exists OR the
//     `vector_indexes` table has at least one row (the in-DB form).
// Uses the sqlite3 CLI (already a project dep — see getAQEStats) instead of
// better-sqlite3 (ABI drift across Node versions).
// Idempotent via the marker comment "VECTORS-HNSW-PATCH-V1".
if (!src.includes('VECTORS-HNSW-PATCH-V1')) {
  const oldStatsRe = /(\/\/ AgentDB stats[\s\S]*?\bfunction getAgentDBStats\(\)\s*\{)[\s\S]*?(\n\}\n)/;
  const newStats = "$1\n  // VECTORS-HNSW-PATCH-V1: real vector counts via sqlite3 CLI + in-DB HNSW detection.\n  let vectorCount = 0;\n  let dbSizeKB = 0;\n  let namespaces = 0;\n  let hasHnsw = false;\n\n  function sqliteCountSafe(dbPath, sql) {\n    if (!safeStat(dbPath)) return 0;\n    const out = safeExec('sqlite3 -readonly \"' + dbPath + '\" \"' + sql + '\"', 2000);\n    const n = parseInt((out || '').trim(), 10);\n    return Number.isFinite(n) ? n : 0;\n  }\n\n  function tableExists(dbPath, table) {\n    if (!safeStat(dbPath)) return false;\n    const out = safeExec('sqlite3 -readonly \"' + dbPath + '\" \"SELECT 1 FROM sqlite_master WHERE type=\\'table\\' AND name=\\'' + table + '\\' LIMIT 1;\"', 2000);\n    return (out || '').trim() === '1';\n  }\n\n  // (a) JSON store fallbacks — preserved for projects without a sqlite memory.db\n  const storePath = path.join(CWD, '.claude-flow', 'data', 'auto-memory-store.json');\n  const storeStat = safeStat(storePath);\n  if (storeStat) {\n    dbSizeKB += storeStat.size / 1024;\n    try {\n      const store = JSON.parse(fs.readFileSync(storePath, 'utf-8'));\n      if (Array.isArray(store)) vectorCount += store.length;\n      else if (store && store.entries) vectorCount += store.entries.length;\n    } catch { /* ignore */ }\n  }\n  const hooksStorePath = path.join(CWD, '.claude-flow', 'memory', 'store.json');\n  const hooksStoreStat = safeStat(hooksStorePath);\n  if (hooksStoreStat) {\n    dbSizeKB += hooksStoreStat.size / 1024;\n    try {\n      const store = JSON.parse(fs.readFileSync(hooksStorePath, 'utf-8'));\n      if (store && store.entries) {\n        const entryCount = Object.keys(store.entries).length;\n        vectorCount = Math.max(vectorCount, entryCount);\n        if (entryCount > 0) namespaces++;\n      }\n    } catch { /* ignore */ }\n  }\n  try {\n    const ranked = readJSON(path.join(CWD, '.claude-flow', 'data', 'ranked-context.json'));\n    if (ranked && ranked.entries && ranked.entries.length > vectorCount) vectorCount = ranked.entries.length;\n  } catch { /* ignore */ }\n\n  // (b) Real DB vector counts (the source of truth on modern ruflo + AQE)\n  const swarmDb = path.join(CWD, '.swarm', 'memory.db');\n  const aqeDb = path.join(CWD, '.agentic-qe', 'memory.db');\n  let dbVectors = 0;\n  dbVectors += sqliteCountSafe(swarmDb, 'SELECT COUNT(*) FROM memory_entries');\n  if (tableExists(swarmDb, 'pattern_embeddings'))\n    dbVectors += sqliteCountSafe(swarmDb, 'SELECT COUNT(*) FROM pattern_embeddings');\n  if (tableExists(swarmDb, 'learning_state_embeddings'))\n    dbVectors += sqliteCountSafe(swarmDb, 'SELECT COUNT(*) FROM learning_state_embeddings');\n  if (tableExists(aqeDb, 'embeddings'))\n    dbVectors += sqliteCountSafe(aqeDb, 'SELECT COUNT(*) FROM embeddings');\n  if (tableExists(aqeDb, 'qe_pattern_embeddings'))\n    dbVectors += sqliteCountSafe(aqeDb, 'SELECT COUNT(*) FROM qe_pattern_embeddings');\n  if (dbVectors > vectorCount) vectorCount = dbVectors;\n\n  // (c) DB file sizes\n  const dbFiles = [\n    path.join(CWD, 'data', 'memory.db'),\n    path.join(CWD, '.claude-flow', 'memory.db'),\n    swarmDb,\n    aqeDb,\n  ];\n  for (const f of dbFiles) {\n    const stat = safeStat(f);\n    if (stat) {\n      dbSizeKB += stat.size / 1024;\n      namespaces++;\n    }\n  }\n  const graphStat = safeStat(path.join(CWD, 'data', 'memory.graph'));\n  if (graphStat) dbSizeKB += graphStat.size / 1024;\n\n  // (d) HNSW detection — file form OR in-DB vector_indexes table form\n  const hnswPaths = [\n    path.join(CWD, '.swarm', 'hnsw.index'),\n    path.join(CWD, '.claude-flow', 'hnsw.index'),\n  ];\n  for (const p of hnswPaths) {\n    if (safeStat(p)) { hasHnsw = true; break; }\n  }\n  if (!hasHnsw && tableExists(swarmDb, 'vector_indexes')) {\n    if (sqliteCountSafe(swarmDb, 'SELECT COUNT(*) FROM vector_indexes') > 0) hasHnsw = true;\n  }\n  if (!hasHnsw) {\n    const memPkgPaths = [\n      path.join(CWD, 'v3', '@claude-flow', 'memory', 'dist'),\n      path.join(CWD, 'node_modules', '@claude-flow', 'memory'),\n    ];\n    for (const p of memPkgPaths) {\n      if (fs.existsSync(p)) { hasHnsw = true; break; }\n    }\n  }\n\n  return { vectorCount, dbSizeKB: Math.floor(dbSizeKB), namespaces, hasHnsw };\n$2";
  if (oldStatsRe.test(src)) {
    src = src.replace(oldStatsRe, newStats);
    changed = true;
    console.log('  patched: getAgentDBStats vectors+HNSW (VECTORS-HNSW-PATCH-V1)');
  } else {
    console.log('  WARN: anchor for vectors+HNSW patch not found');
  }
}

// (1i) Subagent file-scan counter — repairs "Sub 0" with active background
// subagents. Two compounding bugs in the original code (originally written by
// fix-ruflo.sh step 11d, sentinel-less V1):
//   (A) Claude Code mangles BOTH `/` AND `_` to `-` when deriving the
//       ~/.claude/projects/<key> directory name. The old regex
//       `CWD.replace(/\//g, '-')` only handled `/` — any project path with an
//       underscore (e.g. `/Users/cm/THE_AI/...`) silently failed to match its
//       actual CC dir (`-Users-cm-THE-AI-...`).
//   (B) Wrong path depth. Old code looked at `<projDir>/<key>/subagents/*.jsonl`
//       but the real layout is `<projDir>/<key>/<sessionUUID>/subagents/*.jsonl`.
//       The shallow dir doesn't exist → loop skipped → count stayed 0.
// Also tightens the projDir filter from substring (`includes`) to exact
// equality, since the corrected `[\/_]` regex produces an exact key (substring
// would only allow cross-project leakage).
// Idempotent via the sentinel comment "SUBAGENTS-SCAN-V2".
// The existing step 1d `.bak` + `node --check` guard validates the write.
if (!src.includes('SUBAGENTS-SCAN-V2')) {
  const oldSubRe = /  \/\/ Sub-agents: prefer Claude Code stdin data, fallback to file scan[\s\S]*?\n  return \{ memoryMB, contextPct, intelligencePct, subAgents \};/;
  const newSub = `  // SUBAGENTS-SCAN-V2: count Claude Code Agent-tool background subagents.
  // Fixes two bugs that left Sub stuck at 0:
  //   (A) Claude Code mangles BOTH \`/\` and \`_\` to \`-\` in project-key dirs;
  //       the old \`/\\//g\` regex missed \`_\`, so projects with underscores
  //       (like THE_AI) never matched their CC directory.
  //   (B) Real jsonl layout is <projDir>/<key>/<sessionUUID>/subagents/*.jsonl
  //       — the old code looked one level too shallow.
  // Also tightens the substring match to exact equality (post-regex-fix the
  // derivation is exact, so substring would only allow cross-project leakage).
  let subAgents = 0;
  const stdinData = getStdinData();
  if (stdinData && stdinData.subagents !== undefined) {
    subAgents = stdinData.subagents;
  } else if (stdinData && stdinData.num_subagents !== undefined) {
    subAgents = stdinData.num_subagents;
  } else {
    try {
      const projKey = CWD.replace(/[\\/_]/g, '-').replace(/^-/, '-');
      const projDir = path.join(os.homedir(), '.claude', 'projects');
      if (fs.existsSync(projDir)) {
        const projDirs = fs.readdirSync(projDir).filter(d => d === projKey);
        for (const pd of projDirs) {
          const pdPath = path.join(projDir, pd);
          let sessionDirs = [];
          try {
            sessionDirs = fs.readdirSync(pdPath, { withFileTypes: true })
              .filter(e => e.isDirectory()).map(e => e.name);
          } catch { continue; }
          for (const sd of sessionDirs) {
            const subDir = path.join(pdPath, sd, 'subagents');
            if (!fs.existsSync(subDir)) continue;
            const files = fs.readdirSync(subDir).filter(f => f.endsWith('.jsonl'));
            for (const f of files) {
              try {
                const st = fs.statSync(path.join(subDir, f));
                if (Date.now() - st.mtimeMs < 10 * 60 * 1000) subAgents++;
              } catch { /* skip */ }
            }
          }
        }
      }
    } catch { /* ignore */ }
    const activityData = readJSON(path.join(CWD, '.claude-flow', 'metrics', 'swarm-activity.json'));
    if (activityData && activityData.processes && activityData.processes.estimated_agents) {
      subAgents = Math.max(subAgents, activityData.processes.estimated_agents);
    }
  }

  return { memoryMB, contextPct, intelligencePct, subAgents };`;
  if (oldSubRe.test(src)) {
    src = src.replace(oldSubRe, newSub);
    changed = true;
    console.log('  patched: subagent file-scan (SUBAGENTS-SCAN-V2)');
  } else {
    console.log('  WARN: anchor for subagent scan patch not found');
  }
}

// (1j) Vectors chip — extend V1 to count the 8 additional vector-bearing tables
// the Tier 4 audit discovered. V1 sums 5 tables (memory_entries,
// pattern_embeddings, learning_state_embeddings, embeddings, qe_pattern_embeddings)
// → 9 vectors on this project. The real count across all embedding-bearing
// tables is ~192 (the difference is mostly aqe.captured_experiences=106 +
// aqe.vectors=61 + aqe.qe_trajectories=16, plus 5 currently-empty tables that
// will grow over time). The fix injects an idempotent extra-sum block right
// before V1's "if (dbVectors > vectorCount)" merge line, adding the 8 missed
// tables under the existing tableExists() guard so schema bumps don't crash.
// Sentinel "VECTORS-HNSW-PATCH-V2" (supersedes V1; V1 sentinel still gates V1
// idempotency on installs that haven't run this script since the V2 ship).
if (!src.includes('VECTORS-HNSW-PATCH-V2')) {
  const v2Anchor = '  if (dbVectors > vectorCount) vectorCount = dbVectors;';
  const v2Block = `  // VECTORS-HNSW-PATCH-V2: extend V1 sum with the 8 additional vector-bearing
  // tables found in the Tier 4 audit (live counts on this project: +106 +61 +16).
  // All wrapped in tableExists() so AQE/ruflo schema bumps fail soft.
  if (tableExists(aqeDb, 'captured_experiences'))
    dbVectors += sqliteCountSafe(aqeDb, 'SELECT COUNT(*) FROM captured_experiences WHERE embedding IS NOT NULL');
  if (tableExists(aqeDb, 'vectors'))
    dbVectors += sqliteCountSafe(aqeDb, 'SELECT COUNT(*) FROM vectors WHERE embedding IS NOT NULL');
  if (tableExists(aqeDb, 'qe_trajectories'))
    dbVectors += sqliteCountSafe(aqeDb, 'SELECT COUNT(*) FROM qe_trajectories WHERE embedding IS NOT NULL');
  if (tableExists(swarmDb, 'patterns'))
    dbVectors += sqliteCountSafe(swarmDb, 'SELECT COUNT(*) FROM patterns WHERE embedding IS NOT NULL');
  if (tableExists(aqeDb, 'concept_nodes'))
    dbVectors += sqliteCountSafe(aqeDb, 'SELECT COUNT(*) FROM concept_nodes WHERE embedding IS NOT NULL');
  if (tableExists(aqeDb, 'pattern_versions'))
    dbVectors += sqliteCountSafe(aqeDb, 'SELECT COUNT(*) FROM pattern_versions WHERE embedding IS NOT NULL');
  if (tableExists(aqeDb, 'hypergraph_nodes'))
    dbVectors += sqliteCountSafe(aqeDb, 'SELECT COUNT(*) FROM hypergraph_nodes WHERE embedding IS NOT NULL');
  if (tableExists(aqeDb, 'sona_patterns'))
    dbVectors += sqliteCountSafe(aqeDb, 'SELECT COUNT(*) FROM sona_patterns WHERE state_embedding IS NOT NULL');
` + v2Anchor;
  if (src.includes(v2Anchor)) {
    src = src.replace(v2Anchor, v2Block);
    changed = true;
    console.log('  patched: vectors-chip extended sum (VECTORS-HNSW-PATCH-V2)');
  } else {
    console.log('  WARN: anchor for VECTORS-HNSW-PATCH-V2 not found (V1 must run first)');
  }
}

// (1k) Memory chip — replace process.memoryUsage().heapUsed (which measures
// the statusline renderer's own Node V8 heap, useless) with the sum of on-disk
// DB footprints. The chip's intent has always been "how much memory is ruflo
// using"; the implementation drifted into "how warm is V8 right now". Real DB
// footprint on this project is ~3.8MB (.swarm/memory.db 200KB + .agentic-qe/
// memory.db 2.1MB + .swarm/hnsw.index 1.5MB); chip currently shows 4MB only
// because V8 happens to allocate that. Uses safeStat (already in scope from
// the existing patches). Icon 💾 and "MB" label preserved.
// Sentinel "MEMORYMB-DBSIZE-V1".
if (!src.includes('MEMORYMB-DBSIZE-V1')) {
  const oldMem = 'const memoryMB = Math.floor(process.memoryUsage().heapUsed / 1024 / 1024);';
  const newMem = `// MEMORYMB-DBSIZE-V1: real on-disk footprint of ruflo + AQE state, not
  // the statusline renderer's own V8 heap. Sums .swarm/memory.db + .agentic-qe/
  // memory.db + .swarm/hnsw.index when present.
  const _memBytes = (
    (safeStat(path.join(CWD, '.swarm', 'memory.db')) || { size: 0 }).size +
    (safeStat(path.join(CWD, '.agentic-qe', 'memory.db')) || { size: 0 }).size +
    (safeStat(path.join(CWD, '.swarm', 'hnsw.index')) || { size: 0 }).size
  );
  const memoryMB = Math.floor(_memBytes / 1024 / 1024);`;
  if (src.includes(oldMem)) {
    src = src.replace(oldMem, newMem);
    changed = true;
    console.log('  patched: memoryMB → on-disk DB footprint (MEMORYMB-DBSIZE-V1)');
  } else {
    console.log('  WARN: anchor for MEMORYMB-DBSIZE-V1 not found');
  }
}

// (1l) Brain chip — replace the SQLite-page-count heuristic (step 3 of
// getLearningStats) with a real COUNT(*) against the patterns tables. The
// old code, when patterns.json and auto-memory-store.json don't exist (the
// normal case on a v3 ruflo install), opened .swarm/memory.db, read bytes
// 28-31 of the SQLite header as a uint32 page-count, and reported that minus
// 2 as the "pattern count". On a 200KB DB with 4096-byte pages that's
// (~50-2)=48; downstream `floor(48/20)*5 = 5%` math turned it into the
// chip's percentage. The number has nothing to do with actual learned
// patterns. Real count: `swarm.patterns` + `aqe.qe_patterns` (both wrapped
// in tableExists guards). On this project today: swarm.patterns=0,
// aqe.qe_patterns=3 → real patterns=3, intelligencePct = floor(3/20)*5 = 0%.
// That 0% is honest — there really are no SONA-derived patterns yet because
// neural training hasn't accumulated enough trajectories. Real growth still
// shows up via the fromVectors branch (line 403) once vectors > 20, which
// after VECTORS-HNSW-PATCH-V2 they already are.
// Sentinel "LEARNING-PATTERNS-V1".
if (!src.includes('LEARNING-PATTERNS-V1')) {
  // The original step-3 block starts at the comment "// 3. Count patterns
  // from memory.db using row count" and ends at the closing brace of the
  // outer `if (patterns === 0)` block, just before "// 4. Count real session
  // files". Replace the whole block with a sqlite COUNT() lookup.
  const oldRe = /  \/\/ 3\. Count patterns from memory\.db using row count[\s\S]*?\n  \/\/ 4\. Count real session files/;
  const newBlock = `  // LEARNING-PATTERNS-V1: real pattern count from sqlite, not a page-count heuristic.
  // The prior step 3 read bytes 28-31 of .swarm/memory.db (SQLite page count)
  // and reported (pageCount - 2) as the pattern count. That number is the
  // file's page count, not the table's row count — bore no relation to
  // learned patterns. See _INSTRUCTIONS.md Local Patch 15.
  if (patterns === 0) {
    function _le_safeExec(cmd, ms) {
      try { return require('child_process').execSync(cmd, { timeout: ms || 2000, stdio: ['ignore','pipe','ignore'] }).toString(); }
      catch { return ''; }
    }
    function _le_count(db, table) {
      if (!fs.existsSync(db)) return 0;
      try {
        const tex = _le_safeExec('sqlite3 -readonly "' + db + '" "SELECT 1 FROM sqlite_master WHERE type=' + "'table'" + ' AND name=' + "'" + table + "'" + ' LIMIT 1;"', 1500).trim();
        if (tex !== '1') return 0;
        const n = parseInt(_le_safeExec('sqlite3 -readonly "' + db + '" "SELECT COUNT(*) FROM ' + table + ';"', 1500).trim(), 10);
        return Number.isFinite(n) ? n : 0;
      } catch { return 0; }
    }
    let real = 0;
    real += _le_count(path.join(CWD, '.swarm', 'memory.db'), 'patterns');
    real += _le_count(path.join(CWD, '.agentic-qe', 'memory.db'), 'qe_patterns');
    patterns = real;
  }

  // 4. Count real session files`;
  if (oldRe.test(src)) {
    src = src.replace(oldRe, newBlock);
    changed = true;
    console.log('  patched: getLearningStats real pattern count (LEARNING-PATTERNS-V1)');
  } else {
    console.log('  WARN: anchor for LEARNING-PATTERNS-V1 not found');
  }
}

// (1m) Tier 5 atomic V3: domain-separate the AgentDB chip + enrich AQE footer +
// rewire brain input. Three idempotent sub-patches under one umbrella step.
//
// Problem (Tier 4 left this latent): the AgentDB Vectors/Size chips were
// kit-total (ruflo + AQE) — they grew when AQE accumulated experiences, even
// though the chip's label "AgentDB" + the row's 📊 icon implied "ruflo's
// AgentDB state". The AQE row, meanwhile, only showed patterns + trajectories
// — no vector or size signal at all. Tier 5 separates the two domains:
//   • AgentDB Vectors / Size chips → ruflo-only (.swarm/* tables + files)
//   • AQE footer → new 🧬 vec ⚡ + 💾 MB chips (.agentic-qe/* tables + file)
//   • 🧠 brain chip → kit-total (intentionally cross-domain summary signal)
//
// V3 supersedes V2 supersedes V1 — all three sentinels are kept in the
// patcher's idempotency checks so older installs upgrade cleanly through
// the chain.
// V3 (re-)applies when:
//   (a) V3 sentinel absent — first install, OR
//   (b) V3 present but legacy V1/V2 sentinels missing — heals the
//       initial V3 ship (which dropped V1+V2 sentinels and let V1's
//       comment-anchored regex match V3's function, causing a destructive
//       cycle on every re-run). The V3 body now contains the legacy
//       sentinel strings so V1/V2 idempotency checks short-circuit
//       cleanly after this one-shot heal.
if (!src.includes('VECTORS-HNSW-PATCH-V3') ||
    !src.includes('VECTORS-HNSW-PATCH-V1') ||
    !src.includes('VECTORS-HNSW-PATCH-V2')) {
  // Rewrite the entire `getAgentDBStats()` body. Anchor directly on the
  // function declaration (lesson from prior swarm rounds: comment anchors
  // break when AQE clobbers the file).
  const oldFnRe = /function getAgentDBStats\(\)\s*\{[\s\S]*?\n\}/;
  const newFn = `function getAgentDBStats() {
  // VECTORS-HNSW-PATCH-V3: domain-separated counters.
  // - vectorCount / dbSizeKB / hasHnsw   → ruflo-only (.swarm/*)
  // - aqeVectorCount / aqeDbSizeKB / aqeHasHnsw → AQE-only (.agentic-qe/*)
  // - totalVectorCount = vectorCount + aqeVectorCount (consumed by Brain chip)
  // V3 supersedes V2 (8-table cross-domain sum) which superseded V1 (file-only
  // counts). V2's table-discovery is preserved verbatim — just relocated to
  // the right field per domain.
  // Legacy sentinels retained for idempotency-check short-circuit on re-run:
  //   VECTORS-HNSW-PATCH-V1, VECTORS-HNSW-PATCH-V2

  function sqliteCountSafe(dbPath, sql) {
    if (!safeStat(dbPath)) return 0;
    const out = safeExec('sqlite3 -readonly "' + dbPath + '" "' + sql + '"', 2000);
    const n = parseInt((out || '').trim(), 10);
    return Number.isFinite(n) ? n : 0;
  }
  function tableExists(dbPath, table) {
    if (!safeStat(dbPath)) return false;
    const out = safeExec('sqlite3 -readonly "' + dbPath + '" "SELECT 1 FROM sqlite_master WHERE type=' + "'table'" + ' AND name=' + "'" + table + "'" + ' LIMIT 1;"', 2000);
    return (out || '').trim() === '1';
  }

  const swarmDb = path.join(CWD, '.swarm', 'memory.db');
  const aqeDb   = path.join(CWD, '.agentic-qe', 'memory.db');

  // ── ruflo-only vector count (4 tables) ────────────────────────────────────
  let vectorCount = 0;
  vectorCount += sqliteCountSafe(swarmDb, 'SELECT COUNT(*) FROM memory_entries WHERE embedding IS NOT NULL');
  if (tableExists(swarmDb, 'pattern_embeddings'))
    vectorCount += sqliteCountSafe(swarmDb, 'SELECT COUNT(*) FROM pattern_embeddings');
  if (tableExists(swarmDb, 'learning_state_embeddings'))
    vectorCount += sqliteCountSafe(swarmDb, 'SELECT COUNT(*) FROM learning_state_embeddings');
  if (tableExists(swarmDb, 'patterns'))
    vectorCount += sqliteCountSafe(swarmDb, 'SELECT COUNT(*) FROM patterns WHERE embedding IS NOT NULL');

  // ── AQE-only vector count (9 tables) ──────────────────────────────────────
  let aqeVectorCount = 0;
  if (tableExists(aqeDb, 'embeddings'))
    aqeVectorCount += sqliteCountSafe(aqeDb, 'SELECT COUNT(*) FROM embeddings');
  if (tableExists(aqeDb, 'qe_pattern_embeddings'))
    aqeVectorCount += sqliteCountSafe(aqeDb, 'SELECT COUNT(*) FROM qe_pattern_embeddings');
  if (tableExists(aqeDb, 'captured_experiences'))
    aqeVectorCount += sqliteCountSafe(aqeDb, 'SELECT COUNT(*) FROM captured_experiences WHERE embedding IS NOT NULL');
  if (tableExists(aqeDb, 'vectors'))
    aqeVectorCount += sqliteCountSafe(aqeDb, 'SELECT COUNT(*) FROM vectors WHERE embedding IS NOT NULL');
  if (tableExists(aqeDb, 'qe_trajectories'))
    aqeVectorCount += sqliteCountSafe(aqeDb, 'SELECT COUNT(*) FROM qe_trajectories WHERE embedding IS NOT NULL');
  if (tableExists(aqeDb, 'concept_nodes'))
    aqeVectorCount += sqliteCountSafe(aqeDb, 'SELECT COUNT(*) FROM concept_nodes WHERE embedding IS NOT NULL');
  if (tableExists(aqeDb, 'pattern_versions'))
    aqeVectorCount += sqliteCountSafe(aqeDb, 'SELECT COUNT(*) FROM pattern_versions WHERE embedding IS NOT NULL');
  if (tableExists(aqeDb, 'hypergraph_nodes'))
    aqeVectorCount += sqliteCountSafe(aqeDb, 'SELECT COUNT(*) FROM hypergraph_nodes WHERE embedding IS NOT NULL');
  if (tableExists(aqeDb, 'sona_patterns'))
    aqeVectorCount += sqliteCountSafe(aqeDb, 'SELECT COUNT(*) FROM sona_patterns WHERE state_embedding IS NOT NULL');

  const totalVectorCount = vectorCount + aqeVectorCount;

  // ── ruflo-only DB size: swarm/memory.db + swarm/hnsw.index ────────────────
  let dbSizeKB = 0;
  const swarmStat = safeStat(swarmDb);
  if (swarmStat) dbSizeKB += swarmStat.size / 1024;
  const swarmHnswStat = safeStat(path.join(CWD, '.swarm', 'hnsw.index'));
  if (swarmHnswStat) dbSizeKB += swarmHnswStat.size / 1024;

  // ── AQE-only DB size ──────────────────────────────────────────────────────
  let aqeDbSizeKB = 0;
  const aqeStat = safeStat(aqeDb);
  if (aqeStat) aqeDbSizeKB += aqeStat.size / 1024;

  // ── HNSW indicators (ruflo + AQE) ─────────────────────────────────────────
  let hasHnsw = false;
  if (swarmHnswStat) hasHnsw = true;
  if (!hasHnsw && tableExists(swarmDb, 'vector_indexes')) {
    if (sqliteCountSafe(swarmDb, 'SELECT COUNT(*) FROM vector_indexes') > 0) hasHnsw = true;
  }

  // AQE HNSW indicator — proxy: qe_pattern_embeddings has rows AND aqe has
  // any vectors. Avoids the same overhead as ruflo's HNSW lookup.
  let aqeHasHnsw = false;
  if (aqeVectorCount > 0 && tableExists(aqeDb, 'qe_pattern_embeddings')) {
    if (sqliteCountSafe(aqeDb, 'SELECT COUNT(*) FROM qe_pattern_embeddings') > 0) aqeHasHnsw = true;
  }

  // Namespace counter (cosmetic; unchanged semantics from V1)
  let namespaces = 0;
  if (swarmStat) namespaces++;
  if (aqeStat)   namespaces++;

  return {
    vectorCount,
    aqeVectorCount,
    totalVectorCount,
    dbSizeKB: Math.floor(dbSizeKB),
    aqeDbSizeKB: Math.floor(aqeDbSizeKB),
    namespaces,
    hasHnsw,
    aqeHasHnsw,
  };
}`;
  if (oldFnRe.test(src)) {
    src = src.replace(oldFnRe, newFn);
    changed = true;
    console.log('  patched: getAgentDBStats domain-separated (VECTORS-HNSW-PATCH-V3)');
  } else {
    console.log('  WARN: anchor for VECTORS-HNSW-PATCH-V3 not found');
  }
}

// (1m.2) AQE-FOOTER-V2 — enrich the AQE footer with 🧬 vec + 💾 MB chips that
// reflect AQE's domain only. Rewrites getAQEStats() to return the V3 fields
// and rewrites the Line-6 render block to emit the enriched footer.
// Idempotent via sentinel "AQE-FOOTER-V2".
if (!src.includes('AQE-FOOTER-V2')) {
  // Rewrite getAQEStats() — preserves the "available/patterns/trajectories"
  // shape and adds vectors / dbSizeKB / hasHnsw sourced from getAgentDBStats's
  // V3 fields. Single getAgentDBStats() call avoids double sqlite spawns.
  const oldAqeFnRe = /function getAQEStats\(\)\s*\{[\s\S]*?\n\}/;
  const newAqeFn = `function getAQEStats() {
  // AQE-FOOTER-V2: enriched footer reads vectors/dbSize/hasHnsw from the
  // V3 domain-separated getAgentDBStats. The original patterns/trajectories
  // query stays (uses qe_patterns-specific filter on usage_count/quality).
  const dbPath = path.join(CWD, '.agentic-qe', 'memory.db');
  if (!safeStat(dbPath)) {
    return { available: false, patterns: 0, trajectories: 0, vectors: 0, dbSizeKB: 0, hasHnsw: false };
  }
  const sql = "SELECT (SELECT COUNT(*) FROM qe_patterns WHERE usage_count > 0 OR quality_score > 0 OR name NOT LIKE 'bench-%') || '|' || (SELECT COUNT(*) FROM qe_trajectories);";
  const out = safeExec('sqlite3 -readonly "' + dbPath + '" "' + sql + '"', 2000);
  let p = 0, t = 0;
  if (out) { const parts = out.split('|').map(n => parseInt(n, 10) || 0); p = parts[0] || 0; t = parts[1] || 0; }
  // Re-use V3 counters from getAgentDBStats (single SQL spawn already done there).
  const ag = getAgentDBStats();
  return {
    available: true,
    patterns: p,
    trajectories: t,
    vectors: ag.aqeVectorCount,
    dbSizeKB: ag.aqeDbSizeKB,
    hasHnsw: ag.aqeHasHnsw,
  };
}`;
  if (oldAqeFnRe.test(src)) {
    src = src.replace(oldAqeFnRe, newAqeFn);
    changed = true;
    console.log('  patched: getAQEStats enriched (AQE-FOOTER-V2)');
  } else {
    console.log('  WARN: anchor for AQE-FOOTER-V2 getAQEStats not found');
  }

  // Rewrite the Line-6 footer render to consume the enriched fields.
  const oldFooterRe = /  \/\/ Line 6: Agentic QE v3 footer[\s\S]*?\n {2}\}/;
  const newFooter = `  // Line 6: Agentic QE v3 footer (AQE-FOOTER-V2 — enriched with vec + MB chips)
  const aqe = getAQEStats();
  if (aqe.available) {
    const patColor = aqe.patterns > 0 ? c.brightGreen : c.dim;
    const trajStr = aqe.trajectories > 0
      ? '  ' + c.dim + '\\u2502' + c.reset + '  ' + c.brightYellow + '\\uD83E\\uDDED ' + aqe.trajectories + ' traj' + c.reset
      : '';
    const vecHnsw = aqe.hasHnsw ? c.brightGreen + '\\u26A1' + c.reset : '';
    const vecStr = aqe.vectors > 0
      ? '  ' + c.dim + '\\u2502' + c.reset + '  ' + c.brightCyan + '\\uD83E\\uDDEC ' + aqe.vectors + ' vec' + c.reset + vecHnsw
      : '';
    const sizeStr = aqe.dbSizeKB > 0
      ? '  ' + c.dim + '\\u2502' + c.reset + '  ' + c.brightCyan + '\\uD83D\\uDCBE ' + (aqe.dbSizeKB / 1024).toFixed(1) + 'MB' + c.reset
      : '';
    const aqeBranch = git.gitBranch
      ? '  ' + c.brightBlue + '\\u23C7 ' + git.gitBranch + c.reset
      : '';
    lines.push(
      c.bold + c.brightPurple + '\\u258A Agentic QE v3' + c.reset + aqeBranch +
      '  ' + patColor + '\\uD83C\\uDF93 ' + aqe.patterns + ' patterns' + c.reset + trajStr + vecStr + sizeStr
    );
  }`;
  if (oldFooterRe.test(src)) {
    src = src.replace(oldFooterRe, newFooter);
    changed = true;
    console.log('  patched: Line-6 AQE footer render (AQE-FOOTER-V2)');
  } else {
    console.log('  WARN: anchor for AQE-FOOTER-V2 render not found');
  }
}

// (1m.3) BRAIN-INPUT-TOTAL-V1 — swap brain's vector source from agentdb.vectorCount
// (which V3 narrows to ruflo-only) to agentdb.totalVectorCount (kit-total).
// Without this, the brain chip would drop from 10% to 0% on V3 ship because
// totalVectors=201 → 9, but narrowed vectorCount=6 → 0. The brain chip is
// intentionally a kit-wide intelligence summary, not a ruflo-specific signal.
// Idempotent via sentinel "BRAIN-INPUT-TOTAL-V1".
if (!src.includes('BRAIN-INPUT-TOTAL-V1')) {
  const oldBrain = 'const fromVectors = agentdb.vectorCount > 0 ? Math.min(100, Math.floor(agentdb.vectorCount / 20)) : 0;';
  const newBrain = '// BRAIN-INPUT-TOTAL-V1: brain reads kit-total (ruflo + AQE) vectors — see _INSTRUCTIONS.md Local Patch 16.\n    const fromVectors = agentdb.totalVectorCount > 0 ? Math.min(100, Math.floor(agentdb.totalVectorCount / 20)) : 0;';
  if (src.includes(oldBrain)) {
    src = src.replace(oldBrain, newBrain);
    changed = true;
    console.log('  patched: brain input → totalVectorCount (BRAIN-INPUT-TOTAL-V1)');
  } else {
    console.log('  WARN: anchor for BRAIN-INPUT-TOTAL-V1 not found');
  }
}

if (changed) {
  fs.writeFileSync(file, src);
  console.log('  → wrote ' + file);
} else {
  console.log('  already up to date');
}
NODE

  # ── Step 1d: Post-write syntax check ────────────────────────────────────
  # Cheap defense against template-literal / regex escape bugs like the
  # `///g` corruption that broke statusline.cjs once before. If `node
  # --check` fails, restore the .bak and surface the failure.
  if node --check "$STATUSLINE_FILE" 2>/tmp/statusline-check.log; then
    pass "statusline.cjs syntax OK"
    rm -f "$STATUSLINE_BAK"
  else
    fail "statusline.cjs failed node --check — restoring backup"
    cat /tmp/statusline-check.log >&2 || true
    if [[ -f "$STATUSLINE_BAK" ]]; then
      mv "$STATUSLINE_BAK" "$STATUSLINE_FILE"
      info "restored from .bak"
    fi
  fi

  # ── Step 1d.2: Runtime smoke + self-contained getAQEStats backstop ──────
  # `node --check` validates SYNTAX only — it cannot catch a missing-symbol
  # ReferenceError. When `aqe init --upgrade` regenerates statusline.cjs, its
  # internal structure changes: the `getAQEStats` definition is dropped (and the
  # `getAgentDBStats`/`safeStat` helpers the V3 patches assumed may be absent),
  # yet AQE-FOOTER-V2's Line-6 render still CALLS getAQEStats() → a runtime
  # ReferenceError, silently swallowed by settings.json's statusLine `|| echo`
  # fallback (user loses the rich line). This backstop is NOT sentinel-gated: if
  # the file fails to render, it (re)writes a SELF-CONTAINED getAQEStats that uses
  # only module-level primitives (fs/path/CWD/execSync) and guards the optional
  # getAgentDBStats call — so it works regardless of which helpers the regenerated
  # file kept. Verified: the regenerated statusline lacks safeStat + getAgentDBStats.
  if [[ -f "$STATUSLINE_FILE" ]]; then
    if node "$STATUSLINE_FILE" >/dev/null 2>&1; then
      pass "statusline.cjs runtime smoke OK (renders without error)"
    else
      info "runtime smoke: statusline.cjs fails to render — installing self-contained getAQEStats"
      AQE_FN_TMP="$(mktemp)"
      cat > "$AQE_FN_TMP" <<'AQEFN'
function getAQEStats() {
  // self-contained (fix-statusbar runtime backstop): no safeStat/safeExec/getAgentDBStats hard-dep
  const dbPath = path.join(CWD, '.agentic-qe', 'memory.db');
  if (!fs.existsSync(dbPath)) return { available: false, patterns: 0, trajectories: 0, vectors: 0, dbSizeKB: 0, hasHnsw: false };
  let p = 0, t = 0;
  try {
    const sql = "SELECT (SELECT COUNT(*) FROM qe_patterns WHERE usage_count > 0 OR quality_score > 0 OR name NOT LIKE 'bench-%') || '|' || (SELECT COUNT(*) FROM qe_trajectories);";
    const out = require('child_process').execSync('sqlite3 -readonly "' + dbPath + '" "' + sql + '"', { timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const parts = out.split('|').map(n => parseInt(n, 10) || 0); p = parts[0] || 0; t = parts[1] || 0;
  } catch (e) { /* ignore */ }
  let vec = 0, mb = 0, hnsw = false;
  try { if (typeof getAgentDBStats === 'function') { const ag = getAgentDBStats(); vec = ag.aqeVectorCount || 0; mb = ag.aqeDbSizeKB || 0; hnsw = !!ag.aqeHasHnsw; } } catch (e) { /* ignore */ }
  return { available: true, patterns: p, trajectories: t, vectors: vec, dbSizeKB: mb, hasHnsw: hnsw };
}
AQEFN
      node -e '
        const fs = require("fs"); const f = process.argv[1]; const fnFile = process.argv[2];
        let s = fs.readFileSync(f, "utf-8"); const fn = fs.readFileSync(fnFile, "utf-8").trim();
        const re = /function getAQEStats\(\)\s*\{[\s\S]*?\n\}/;
        if (re.test(s)) { s = s.replace(re, fn); }
        else if (s.includes("function generateStatusline")) { s = s.replace("function generateStatusline", fn + "\n\nfunction generateStatusline"); }
        else { process.exit(2); }
        fs.writeFileSync(f, s);
      ' "$STATUSLINE_FILE" "$AQE_FN_TMP"
      rm -f "$AQE_FN_TMP"
      if node --check "$STATUSLINE_FILE" 2>/dev/null && node "$STATUSLINE_FILE" >/dev/null 2>&1; then
        pass "runtime smoke: self-contained getAQEStats installed — statusline renders again"
      else
        fail "runtime smoke: backstop did not resolve the crash — the statusLine -v3.cjs fallback still covers it; inspect statusline.cjs"
      fi
    fi
  fi

  # ── Step 1n: aqe-3.10.x chip-data realignment (AQE310-REALIGN-V1) ────────
  # The aqe-3.10.x statusline RENDERS the full ruflo+AQE chip set, but its data
  # source (getStatuslineData) calls the DEAD `npx @claude-flow/cli@latest hooks
  # statusline` → fails → fallback zeros. And `ruflo hooks statusline --json`
  # (the correct source) omits the agentdb/integration/hooks blocks. This step
  # realigns the DATA (not the render): (a) point the source at global `ruflo`;
  # (b) fix the hooks render bug (raw hooks.enabled → defaulted hooksEnabled);
  # (c) make getPkgVersion report the real ruflo version; (d) overlay real
  # agentdb (vectors/size/HNSW) + MCP count + hooks count into getStatuslineData,
  # and enrich getAQEStats with AQE-domain vec/MB. Patches stable function names
  # (getStatuslineData/getAQEStats/getPkgVersion), not fragile render anchors.
  if [[ -f "$STATUSLINE_FILE" ]]; then
    _ra_sed() { if [[ "$(uname)" == "Darwin" ]]; then sed -i '' "$1" "$STATUSLINE_FILE"; else sed -i "$1" "$STATUSLINE_FILE"; fi; }
    # (a) data source → global ruflo
    grep -q "@claude-flow/cli@latest hooks statusline" "$STATUSLINE_FILE" && \
      _ra_sed 's|npx --yes @claude-flow/cli@latest hooks statusline|ruflo hooks statusline|g'
    # (b) hooks render: raw hooks.enabled/.total (undefined when CLI omits hooks) → defaulted vars
    _ra_sed 's|hooksColor + hooks.enabled + c.reset|hooksColor + hooksEnabled + c.reset|g'
    _ra_sed "s|c.brightWhite + hooks.total + c.reset + '    ' +|c.brightWhite + hooksTotal + c.reset + '    ' +|g"
    _ra_sed 's|const hooksColor = hooks.enabled > 0|const hooksColor = hooksEnabled > 0|g'
    # (c) real version (RUFLO_VERSION_FULL detected at script top)
    _ra_sed "s|let ver = '[0-9][^']*';|let ver = '${RUFLO_VERSION_FULL}';|"
    # (d) data overlay + getAQEStats enrichment (idempotent via sentinel)
    if ! grep -q "AQE310-REALIGN-V1" "$STATUSLINE_FILE"; then
      RA_HELP="$(mktemp)"
      cat > "$RA_HELP" <<'RAJS'
// AQE310-REALIGN-V1: overlay AgentDB/MCP/hooks blocks that `ruflo hooks statusline --json` omits.
function _ra_count(db, sql) {
  if (!fs.existsSync(db)) return 0;
  try { const o = require('child_process').execSync('sqlite3 -readonly "' + db + '" "' + sql + '"', { timeout: 2000, stdio: ['ignore','pipe','ignore'] }).toString(); const n = parseInt(o, 10); return Number.isFinite(n) ? n : 0; } catch (e) { return 0; }
}
function _ra_tbl(db, t) {
  if (!fs.existsSync(db)) return false;
  try { return require('child_process').execSync('sqlite3 -readonly "' + db + '" "SELECT 1 FROM sqlite_master WHERE type=' + "'table'" + ' AND name=' + "'" + t + "'" + ' LIMIT 1;"', { timeout: 2000, stdio: ['ignore','pipe','ignore'] }).toString().trim() === '1'; } catch (e) { return false; }
}
// WAL-aware on-disk footprint: SQLite in WAL mode keeps most recent writes in
// the -wal sidecar until checkpoint, so the main .db file alone undercounts the
// real size (often by 10x). Sum main + -wal + -shm for an honest footprint.
function _ra_dbkb(db) {
  let kb = 0;
  for (const suf of ['', '-wal', '-shm']) {
    try { kb += fs.statSync(db + suf).size / 1024; } catch (e) {}
  }
  return kb;
}
function _ra_agentdb() {
  const db = path.join(CWD, '.swarm', 'memory.db');
  let v = _ra_count(db, 'SELECT COUNT(*) FROM memory_entries WHERE embedding IS NOT NULL');
  if (_ra_tbl(db, 'pattern_embeddings')) v += _ra_count(db, 'SELECT COUNT(*) FROM pattern_embeddings');
  if (_ra_tbl(db, 'learning_state_embeddings')) v += _ra_count(db, 'SELECT COUNT(*) FROM learning_state_embeddings');
  if (_ra_tbl(db, 'patterns')) v += _ra_count(db, 'SELECT COUNT(*) FROM patterns WHERE embedding IS NOT NULL');
  let kb = _ra_dbkb(db);
  try { kb += fs.statSync(path.join(CWD, '.swarm', 'hnsw.index')).size / 1024; } catch (e) {}
  let hnsw = fs.existsSync(path.join(CWD, '.swarm', 'hnsw.index'));
  if (!hnsw && _ra_tbl(db, 'vector_indexes')) hnsw = _ra_count(db, 'SELECT COUNT(*) FROM vector_indexes') > 0;
  return { vectorCount: v, dbSizeKB: Math.floor(kb), hasHnsw: hnsw };
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
RAJS
      node -e '
        const fs = require("fs"); const f = process.argv[1]; const helpers = fs.readFileSync(process.argv[2], "utf-8");
        let s = fs.readFileSync(f, "utf-8");
        if (s.indexOf("AQE310-REALIGN-V1") === -1 && s.indexOf("function getStatuslineData") !== -1) {
          s = s.replace("function getStatuslineData()", helpers + "\nfunction getStatuslineData()");
        }
        const overlay = "data.adrs = getLocalADRCount();\n    try { data.agentdb = _ra_agentdb(); } catch (e) {}\n    try { data.integration = Object.assign({}, data.integration, { mcpServers: _ra_mcp() }); } catch (e) {}\n    try { if (!data.hooks || data.hooks.total === undefined) data.hooks = _ra_hooks(); } catch (e) {}";
        if (s.indexOf("data.agentdb = _ra_agentdb()") === -1) s = s.replace("data.adrs = getLocalADRCount();", overlay);
        // enrich getAQEStats vec/MB: swap the vec/mb computation for direct AQE counts
        // (quote-agnostic regex: matches the getAQEStats backstop body regardless of
        //  whether it used a getAgentDBStats guard or single/double quotes).
        s = s.replace(
          /let vec = 0, mb = 0, hnsw = false;\n\s*try \{[\s\S]*?\} catch \(e\) \{ \/\* ignore \*\/ \}/,
          "let vec = 0, mb = 0, hnsw = false;\n  try { const av = _ra_aqevec(); vec = av.vectors || 0; mb = av.dbSizeKB || 0; hnsw = !!av.hasHnsw; } catch (e) { /* ignore */ }"
        );
        fs.writeFileSync(f, s);
      ' "$STATUSLINE_FILE" "$RA_HELP"
      rm -f "$RA_HELP"
      if node --check "$STATUSLINE_FILE" 2>/dev/null && node "$STATUSLINE_FILE" >/dev/null 2>&1; then
        fix "Realigned statusline data to aqe-3.10.x (ruflo source + agentdb/MCP/hooks overlay + AQE vec/MB)"
        pass "aqe-3.10.x chip-data realignment applied (AQE310-REALIGN-V1)"
      else
        warn "AQE310-REALIGN produced an invalid statusline — check; the -v3.cjs fallback still renders"
      fi
    else
      pass "aqe-3.10.x chip-data realignment already present"
    fi
    # (e) WAL-aware size self-heal: pre-WAL realignments sized only the main .db
    # (undercounts ~10x while writes sit in -wal). Idempotent — runs on any file
    # that has the realignment but lacks the _ra_dbkb helper.
    if grep -q "AQE310-REALIGN-V1" "$STATUSLINE_FILE" && ! grep -q "_ra_dbkb" "$STATUSLINE_FILE"; then
      RA_UP="$(mktemp)"
      cat > "$RA_UP" <<'RAUP'
const fs = require('fs'); const f = process.argv[2];
let s = fs.readFileSync(f, 'utf-8');
const helper = `
function _ra_dbkb(db) {
  let kb = 0;
  for (const suf of ['', '-wal', '-shm']) {
    try { kb += fs.statSync(db + suf).size / 1024; } catch (e) {}
  }
  return kb;
}
`;
if (s.indexOf('function _ra_dbkb') === -1) s = s.replace('function _ra_agentdb()', helper + 'function _ra_agentdb()');
s = s.split('let kb = 0; try { kb += fs.statSync(db).size / 1024; } catch (e) {}').join('let kb = _ra_dbkb(db);');
fs.writeFileSync(f, s);
RAUP
      node "$RA_UP" "$STATUSLINE_FILE"; rm -f "$RA_UP"
      if node --check "$STATUSLINE_FILE" 2>/dev/null && node "$STATUSLINE_FILE" >/dev/null 2>&1; then
        fix "Upgraded statusline realignment to WAL-aware DB size (_ra_dbkb)"
      else
        warn "WAL-aware size upgrade produced an invalid statusline — check"
      fi
    fi
    # (f) RUFLO-INTEL-V1: wire the 🧠 chip to a REAL ruflo intelligence metric
    # and add a SONA learning-ladder chip. Upstream ruflo never produces
    # system.intelligencePct from real signal — it reads a never-written
    # .claude-flow/learning.json then falls back to a .swarm/memory.db file-size
    # proxy (floor(KB/20)). We overlay it with live MoE routing-accuracy from
    # `ruflo hooks intelligence stats` (fallback: .claude-flow/neural/stats.json
    # counts). Ruflo-only — no AQE inputs. Idempotent; needs the realignment base.
    if grep -q "AQE310-REALIGN-V1" "$STATUSLINE_FILE" && ! grep -q "RUFLO-INTEL-V2" "$STATUSLINE_FILE"; then
      RA_IN="$(mktemp)"
      cat > "$RA_IN" <<'RAIN'
const fs = require('fs'); const f = process.argv[2];
let s = fs.readFileSync(f, 'utf-8');
const helper = `
function _ra_intelligence() {
  // RUFLO-INTEL-V2: real ruflo-only learning score — trained micro-LoRA delta (sum|B| of
  // .swarm/lora-weights.json) + real trajectory/pattern counts. NOT ruflo's hardcoded
  // Routing Accuracy (0.82) / Avg Quality (0.75), which are fixed constants.
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
  const pct = Math.min(99, Math.round((deltaNorm > 0 ? 55 * (1 - Math.exp(-deltaNorm)) : 0) + 30 * Math.min(1, traj / 500) + 14 * Math.min(1, patterns / 50)));
  let tier = 0; for (const t of [50, 150, 350, 700, 1500]) { if (traj >= t) tier++; }
  return { pct: pct, traj: traj, patterns: patterns, deltaNorm: deltaNorm, tier: tier };
}
`;
if (/function _ra_intelligence\(\)/.test(s)) { s = s.replace(/function _ra_intelligence\(\)[\s\S]*?\n\}/, helper.trim()); } else { s = s.replace('function _ra_agentdb()', helper + 'function _ra_agentdb()'); }
const ov = "try { const ri = _ra_intelligence(); data.system = Object.assign({}, data.system, { ruflo: ri }); if (ri.pct > 0) data.system.intelligencePct = ri.pct; } catch (e) {}";
if (s.indexOf('{ ruflo: ri }') === -1) s = s.replace('try { data.agentdb = _ra_agentdb(); } catch (e) {}', 'try { data.agentdb = _ra_agentdb(); } catch (e) {}\n    ' + ov);
const render = [
  "// RUFLO-INTEL-V2: SONA/neural learning ladder (Ruflo-only, real signals)",
  "const _ri = system.ruflo || {};",
  "if ((_ri.traj || 0) > 0 || (_ri.patterns || 0) > 0) {",
  "    const _rt = _ri.tier || 0;",
  "    const _rl = '[' + '\\u25CF'.repeat(_rt) + '\\u25CB'.repeat(5 - _rt) + ']';",
  "    const _rc = _rt >= 4 ? c.brightGreen : _rt >= 2 ? c.brightYellow : c.dim;",
  "    let _rln = c.brightPurple + '\\uD83D\\uDCF6 SONA' + c.reset + '    ' + _rc + _rl + c.reset + '  ' + c.brightWhite + (_ri.traj || 0) + c.reset + c.dim + ' traj' + c.reset + '  ' + c.dim + '\\u2502' + c.reset + '  ' + c.brightWhite + (_ri.patterns || 0) + c.reset + c.dim + ' patterns' + c.reset;",
  "    if ((_ri.deltaNorm || 0) > 0) _rln += '  ' + c.dim + '\\u2502' + c.reset + '  ' + c.cyan + '\\u0394 ' + (_ri.deltaNorm).toFixed(2) + c.reset + c.dim + ' LoRA' + c.reset;",
  "    lines.push(_rln);",
  "  }",
  "  "
].join('\n  ');
if (s.indexOf('RUFLO-INTEL-V') === -1) s = s.replace('// Line 3: Architecture', render + '// Line 3: Architecture');
// upgrade a pre-existing V1 render's hardcoded Q chip -> real trained-LoRA delta
s = s.replace(/if \(\(_ri\.quality \|\| 0\) > 0\) _rln \+= [^\n]*/, "if ((_ri.deltaNorm || 0) > 0) _rln += '  ' + c.dim + '\\u2502' + c.reset + '  ' + c.cyan + '\\u0394 ' + (_ri.deltaNorm).toFixed(2) + c.reset + c.dim + ' LoRA' + c.reset;");
// relabel the pattern-count proxy from "DDD Domains"/"DDD" to honest "Learning"/"Learn"
s = s.split('DDD Domains').join('Learning');
s = s.split("c.cyan + 'DDD' + c.reset").join("c.cyan + 'Learn' + c.reset");
// live-detect the GLOBAL ruflo version (add it first in getPkgVersion pkgPaths)
if (s.indexOf('const pkgPaths = [') !== -1 && s.indexOf("path.join(_gnm, 'ruflo'") === -1) {
  s = s.replace('const pkgPaths = [', "const _gnm = path.join(path.dirname(path.dirname(process.execPath)), 'lib', 'node_modules');\n    const pkgPaths = [\n      path.join(_gnm, 'ruflo', 'package.json'),");
}
fs.writeFileSync(f, s);
RAIN
      node "$RA_IN" "$STATUSLINE_FILE"; rm -f "$RA_IN"
      if node --check "$STATUSLINE_FILE" 2>/dev/null && node "$STATUSLINE_FILE" >/dev/null 2>&1; then
        fix "Wired 🧠 to real trained-LoRA learning score + SONA Δ chip; relabeled DDD->Learning; live version (RUFLO-INTEL-V2)"
      else
        warn "RUFLO-INTEL-V2 produced an invalid statusline — check"
      fi
    fi

    # (g) AGENTDB-SPLIT-V1: the 📊 AgentDB chip read .swarm/memory.db (ruflo's
    # store) and so UNDERCOUNTED — it ignored the file literally named agentdb.db
    # (the standalone AgentDB MCP store + reflexion harvest sink, e.g. 236 episode
    # embeddings). This step repoints _ra_agentdb at agentdb.db, adds a dedicated
    # 🗃️ Swarm DB chip (the old .swarm logic via _ra_swarmdb), and de-fakes the ⚡
    # HNSW glyph (lit only when an index actually holds vectors, not when an empty
    # vector_indexes table merely has rows). Idempotent; needs the realignment base.
    if grep -q "AQE310-REALIGN-V1" "$STATUSLINE_FILE" && ! grep -q "AGENTDB-SPLIT-V1" "$STATUSLINE_FILE"; then
      RA_SP="$(mktemp)"
      cat > "$RA_SP" <<'RASP'
const fs = require('fs'); const f = process.argv[2];
let s = fs.readFileSync(f, 'utf-8');

// 1) repoint _ra_agentdb at the real agentdb.db (honest HNSW). Regex-replaces the
//    whole body (matches whether the install still has the old .swarm version).
const agentdbFn = `function _ra_agentdb() {
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
}`;
s = s.replace(/function _ra_agentdb\(\)[\s\S]*?\n\}/, agentdbFn);

// 2) add _ra_swarmdb (the old .swarm/memory.db logic) before _ra_agentdb
const swarmFn = `function _ra_swarmdb() {
  // AGENTDB-SPLIT-V1: 🗃️ Swarm DB chip = ruflo's .swarm/memory.db store.
  const db = path.join(CWD, '.swarm', 'memory.db');
  let v = _ra_count(db, 'SELECT COUNT(*) FROM memory_entries WHERE embedding IS NOT NULL');
  if (_ra_tbl(db, 'pattern_embeddings')) v += _ra_count(db, 'SELECT COUNT(*) FROM pattern_embeddings');
  if (_ra_tbl(db, 'learning_state_embeddings')) v += _ra_count(db, 'SELECT COUNT(*) FROM learning_state_embeddings');
  if (_ra_tbl(db, 'patterns')) v += _ra_count(db, 'SELECT COUNT(*) FROM patterns WHERE embedding IS NOT NULL');
  let kb = _ra_dbkb(db);
  try { kb += fs.statSync(path.join(CWD, '.swarm', 'hnsw.index')).size / 1024; } catch (e) {}
  // Honest ⚡ — same bar as _ra_agentdb: only when vectors are actually indexed
  // (real hnsw.index file, or vector_indexes with SUM(total_vectors)>0). Empty
  // index defs (total_vectors=0) are NOT a populated index — no faked ⚡.
  let hnsw = fs.existsSync(path.join(CWD, '.swarm', 'hnsw.index'));
  if (!hnsw && _ra_tbl(db, 'vector_indexes')) hnsw = _ra_count(db, 'SELECT COALESCE(SUM(total_vectors),0) FROM vector_indexes') > 0;
  return { vectorCount: v, dbSizeKB: Math.floor(kb), hasHnsw: hnsw };
}
`;
if (s.indexOf('function _ra_swarmdb') === -1) s = s.replace('function _ra_agentdb()', swarmFn + 'function _ra_agentdb()');

// 3) overlay data.swarmdb in getStatuslineData (next to data.agentdb)
if (s.indexOf('data.swarmdb = _ra_swarmdb()') === -1) s = s.replace('try { data.agentdb = _ra_agentdb(); } catch (e) {}', 'try { data.agentdb = _ra_agentdb(); } catch (e) {}\n    try { data.swarmdb = _ra_swarmdb(); } catch (e) {}');

// 4) fallback default object
if (s.indexOf('swarmdb: {') === -1) s = s.replace('agentdb: { vectorCount: 0, dbSizeKB: 0, hasHnsw: false },', 'agentdb: { vectorCount: 0, dbSizeKB: 0, hasHnsw: false },\n    swarmdb: { vectorCount: 0, dbSizeKB: 0, hasHnsw: false },');

// 5) swarm-db render scalars (after the agentdb scalars)
if (s.indexOf('const swVectorCount') === -1) s = s.replace('const dbSizeKB = agentdb.dbSizeKB || 0;', "const dbSizeKB = agentdb.dbSizeKB || 0;\n  const swarmdb = d.swarmdb || {};\n  const swVectorCount = swarmdb.vectorCount || 0;\n  const swHasHnsw = swarmdb.hasHnsw || false;\n  const swDbSizeKB = swarmdb.dbSizeKB || 0;");

// 6) perfIndicator: drive ⚡ HNSW off the REAL indexed-vector count (either store)
if (s.indexOf('hnswVecs') === -1) s = s.replace(
  "  if (hasHnsw && vectorCount > 0) {\n    const speedup = vectorCount > 10000 ? '12500x' : vectorCount > 1000 ? '150x' : '10x';",
  "  const hnswVecs = (hasHnsw ? vectorCount : 0) + (swHasHnsw ? swVectorCount : 0);\n  if (hnswVecs > 0) {\n    const speedup = hnswVecs > 10000 ? '12500x' : hnswVecs > 1000 ? '150x' : '10x';"
);

// 7) render the 🗃️ Swarm DB chip right after the 📊 AgentDB lines.push
const chip = [
  "",
  "  // Line 4b: Swarm DB — ruflo's .swarm/memory.db store (AGENTDB-SPLIT-V1)",
  "  const swHnswInd = swHasHnsw ? c.brightGreen + '\\u26A1' + c.reset : '';",
  "  const swSizeDisp = swDbSizeKB >= 1024 ? (swDbSizeKB / 1024).toFixed(1) + 'MB' : swDbSizeKB + 'KB';",
  "  const swVectorColor = swVectorCount > 0 ? c.brightGreen : c.dim;",
  "  lines.push(",
  "    c.brightCyan + '\\uD83D\\uDDC3\\uFE0F  Swarm DB' + c.reset + '    ' +",
  "    c.cyan + 'Vectors' + c.reset + ' ' + swVectorColor + '\\u25CF' + swVectorCount + swHnswInd + c.reset + '  ' + c.dim + '\\u2502' + c.reset + '  ' +",
  "    c.cyan + 'Size' + c.reset + ' ' + c.brightWhite + swSizeDisp + c.reset",
  "  );"
].join('\n');
const adbRe = /(lines\.push\(\s*\n\s*c\.brightCyan \+ '📊 AgentDB'[\s\S]*?\n\s*\);)/;
// Guard on the render-only marker ("Line 4b") — NOT "Swarm DB", which already
// appears in the _ra_swarmdb helper comment added above and would falsely skip.
if (s.indexOf('Line 4b: Swarm DB') === -1 && adbRe.test(s)) s = s.replace(adbRe, '$1\n' + chip);

fs.writeFileSync(f, s);
RASP
      node "$RA_SP" "$STATUSLINE_FILE"; rm -f "$RA_SP"
      if ! node --check "$STATUSLINE_FILE" 2>/dev/null || ! node "$STATUSLINE_FILE" >/dev/null 2>&1; then
        warn "AGENTDB-SPLIT-V1 produced an invalid statusline — check"
      elif ! grep -q "Line 4b: Swarm DB" "$STATUSLINE_FILE"; then
        # _ra_agentdb was repointed, but the render anchor ('📊 AgentDB' lines.push)
        # didn't match — likely a ruflo upgrade reformatted it. Don't claim the chip
        # was added when it wasn't.
        warn "AGENTDB-SPLIT-V1: repointed AgentDB data but could NOT find the render anchor — 🗃️ Swarm DB chip NOT added (statusline render format changed; re-check)"
      else
        fix "Pointed 📊 AgentDB chip at real agentdb.db + added 🗃️ Swarm DB chip; de-faked ⚡ HNSW (AGENTDB-SPLIT-V1)"
      fi
    fi
  fi

  # (h) RUFLO-INTEL-V3: self-IMPROVEMENT row (🔬 SI). Surfaces the precomputed efficacy
  #     snapshot from .claude-flow/selfimprove-history.jsonl (pure-Node tail read — NO sqlite
  #     on the render path). HONEST/NEUTRAL by construction: latest-only accuracy (a delta
  #     renders only when >=2 rows share the latest scorerVersion — a cross-scorer normalization
  #     artifact can never read as "improvement"), verdict capped at loop:closed/eff:flat (never
  #     green / up-arrow / eff:+N). Needs the V2 SONA chip as the render anchor. Idempotent
  #     (gated on getSelfImprove absence), .bak + node --check + restore-on-failure.
  if [[ -f "$STATUSLINE_FILE" ]] && grep -q "RUFLO-INTEL-V2" "$STATUSLINE_FILE" && ! grep -q "function getSelfImprove" "$STATUSLINE_FILE"; then
    cp "$STATUSLINE_FILE" "$STATUSLINE_FILE.intelv3-bak"
    RA_SI="$(mktemp)"
    cat > "$RA_SI" <<'RASI'
const fs = require('fs'); const f = process.argv[2];
let s = fs.readFileSync(f, 'utf-8');

// 1) getSelfImprove() inserted before generateStatusline(). Pure-Node jsonl read; newline
//    split via String.fromCharCode(10) to avoid any escape ambiguity in this codifier.
const siFn = `// RUFLO-INTEL-V3: self-IMPROVEMENT snapshot from the precomputed bench history.
// Pure-Node read of .claude-flow/selfimprove-history.jsonl (no sqlite/subprocess). HONEST:
// latest-only accuracy; a delta renders only when >=2 rows share the latest scorerVersion
// (same-scorer guard) so a cross-scorer normalization artifact can never read as improvement.
function getSelfImprove() {
  try {
    const p = path.join(CWD, '.claude-flow', 'selfimprove-history.jsonl');
    if (!fs.existsSync(p)) return { available: false };
    const rows = fs.readFileSync(p, 'utf-8').split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(r => r && typeof r === 'object');
    if (!rows.length) return { available: false };
    const last = rows[rows.length - 1];
    if (typeof last.accuracyPct !== 'number') return { available: false };
    let accFirst = null;
    if (last.scorerVersion) {
      const same = rows.filter(r => r.scorerVersion === last.scorerVersion && typeof r.accuracyPct === 'number');
      if (same.length >= 2) accFirst = same[0].accuracyPct;
    }
    return { available: true, runs: rows.length, accLast: last.accuracyPct, accFirst: accFirst, rewardDistinct: (typeof last.rewardDistinct === 'number') ? last.rewardDistinct : 0, rewardConstant: last.rewardConstant === true, qSpread: (typeof last.qSpread === 'number') ? last.qSpread : 0 };
  } catch (e) { return { available: false }; }
}

`;
if (s.indexOf('function getSelfImprove') === -1) s = s.replace('function generateStatusline() {', siFn + 'function generateStatusline() {');

// 2) the 🔬 SI render row, inserted before the Architecture line (stable anchor).
const siRow = [
  "",
  "  // RUFLO-INTEL-V3: self-IMPROVEMENT row (honest/neutral efficacy snapshot; never 'improving')",
  "  const _si = getSelfImprove();",
  "  if (_si.available) {",
  "    const _siQs = _si.qSpread.toFixed(2).replace(/^0/, '');",
  "    const _siAcc = (_si.accFirst != null && _si.accFirst !== _si.accLast)",
  "      ? c.brightWhite + _si.accLast + '%' + c.reset + c.dim + ' (' + _si.accFirst + '\\u2192' + _si.accLast + ')' + c.reset",
  "      : c.brightWhite + _si.accLast + '%' + c.reset;",
  "    const _siChip = _si.rewardConstant",
  "      ? c.dim + '\\u26AA loop:open' + c.reset",
  "      : c.brightYellow + '\\u25C8 loop:closed eff:flat' + c.reset;",
  "    lines.push(",
  "      c.brightCyan + '\\uD83D\\uDD2C SI' + c.reset + '       ' +",
  "      c.cyan + 'acc' + c.reset + ' ' + _siAcc + '  ' + c.dim + '\\u2502' + c.reset + '  ' +",
  "      c.cyan + '\\u25C7' + c.reset + c.brightWhite + _si.rewardDistinct + c.reset + c.dim + ' rwd' + c.reset + '  ' + c.dim + '\\u2502' + c.reset + '  ' +",
  "      c.cyan + 'Q\\u00B1' + c.reset + c.brightWhite + _siQs + c.reset + '  ' + c.dim + '\\u2502' + c.reset + '  ' +",
  "      _siChip",
  "    );",
  "  }"
].join('\n');
if (s.indexOf('RUFLO-INTEL-V3: self-IMPROVEMENT row') === -1) s = s.replace('    // Line 3: Architecture', siRow + '\n    // Line 3: Architecture');

fs.writeFileSync(f, s);
RASI
    node "$RA_SI" "$STATUSLINE_FILE"; rm -f "$RA_SI"
    if ! node --check "$STATUSLINE_FILE" 2>/dev/null || ! node "$STATUSLINE_FILE" </dev/null >/dev/null 2>&1; then
      warn "RUFLO-INTEL-V3 produced an invalid statusline — restoring"; cp "$STATUSLINE_FILE.intelv3-bak" "$STATUSLINE_FILE"
    elif ! grep -q "RUFLO-INTEL-V3: self-IMPROVEMENT row" "$STATUSLINE_FILE"; then
      warn "RUFLO-INTEL-V3: getSelfImprove added but render anchor (// Line 3: Architecture) not found — 🔬 SI row NOT added (statusline format changed; re-check)"
    else
      fix "Added 🔬 SI self-improvement row (honest/neutral, latest-only acc) (RUFLO-INTEL-V3)"
    fi
  fi

  # ── Step 1e: Verify stdin header field wiring (no auto-inject) ──────────
  # Modern statusline.cjs (>= v3.10.3) ships with getStdinData() + the four
  # field readers (model.display_name, cost.total_cost_usd,
  # context_window.used_percentage, plus the cost.total_duration_ms-derived
  # `duration`). We do NOT auto-inject if these are missing — a future
  # ruflo upgrade may have customised the file in incompatible ways, and
  # silent injection has been the source of past corruption (#1c). Warn
  # loudly so the user can decide.
  if [[ -f "$STATUSLINE_FILE" ]]; then
    missing=()
    grep -qE 'getStdinData[[:space:]]*\([[:space:]]*\)' "$STATUSLINE_FILE" \
      || missing+=("getStdinData()")
    grep -qE 'data\.model\.display_name' "$STATUSLINE_FILE" \
      || missing+=("data.model.display_name")
    grep -qE 'data\.cost\.total_cost_usd' "$STATUSLINE_FILE" \
      || missing+=("data.cost.total_cost_usd")
    grep -qE 'data\.context_window\.used_percentage' "$STATUSLINE_FILE" \
      || missing+=("data.context_window.used_percentage")

    if [[ "${#missing[@]}" -eq 0 ]]; then
      pass "stdin header fields wired (4/4: model, cost, ctx, uptime)"
    else
      warn "stdin header fields missing in statusline.cjs: ${missing[*]}"
      info "model/cost/ctx/uptime will be absent from the header until restored"
      info "to repair: re-run \`npx ruflo init --force\` then re-run this script"
    fi
  fi
fi

# ── Step 2: Write the dual-display fallback (statusline-v3.cjs) ────────────
echo -e "\n${CYAN}[2/4]${NC} Installing dual fallback .claude/helpers/statusline-v3.cjs"

needs_write=1
if [[ -f .claude/helpers/statusline-v3.cjs ]] && grep -q "ruflo + Agentic QE v3" .claude/helpers/statusline-v3.cjs; then
  needs_write=0
fi

if [[ $needs_write -eq 1 ]]; then
  cat > .claude/helpers/statusline-v3.cjs <<'CJS'
#!/usr/bin/env node
/**
 * Statusline: ruflo + Agentic QE v3 (compact, single line, fallback)
 * Reads counts via sqlite3 CLI (avoids better-sqlite3 NODE_MODULE_VERSION drift).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function q(bin, args, d) {
  try {
    return execFileSync(bin, args, { encoding: 'utf-8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { return d || ''; }
}

function sqliteCount(dbPath, sql) {
  if (!fs.existsSync(dbPath)) return null;
  const out = q('sqlite3', ['-readonly', dbPath, sql]);
  const n = parseInt(out, 10);
  return Number.isFinite(n) ? n : null;
}

const dir = path.resolve(__dirname, '..', '..');

const rufloDb = path.join(dir, '.swarm', 'memory.db');
const rufloMem = sqliteCount(rufloDb, 'SELECT COUNT(*) FROM memory_entries');
const rufloHnsw = fs.existsSync(path.join(dir, '.swarm', 'hnsw.index'));

const aqeDb = path.join(dir, '.agentic-qe', 'memory.db');
const aqePat = sqliteCount(aqeDb, "SELECT COUNT(*) FROM qe_patterns WHERE usage_count > 0 OR quality_score > 0 OR name NOT LIKE 'bench-%'");
const aqeTraj = sqliteCount(aqeDb, 'SELECT COUNT(*) FROM qe_trajectories');

const branch = q('git', ['branch', '--show-current']);

const RESET = '\x1b[0m', BOLD = '\x1b[1m', DIM = '\x1b[2m';
const CYAN = '\x1b[36m', PURPLE = '\x1b[35m', GREEN = '\x1b[32m', BLUE = '\x1b[34m', YELLOW = '\x1b[33m';

const rufloStatus = rufloMem !== null
  ? `${GREEN}●${RESET} ${rufloMem}mem${rufloHnsw ? ` ${YELLOW}⚡HNSW${RESET}` : ''}`
  : `${DIM}○ offline${RESET}`;

const aqeStatus = (aqePat !== null || aqeTraj !== null)
  ? `${GREEN}●${RESET} ${aqePat || 0}pat${aqeTraj ? ` ${aqeTraj}traj` : ''}`
  : `${DIM}○ offline${RESET}`;

const sep = `  ${DIM}│${RESET}  `;
const branchStr = branch ? `${sep}${BLUE}⎇ ${branch}${RESET}` : '';

// RUFLO-INTEL-V3: compact self-improvement cell — latest-only acc + reward-distinct, honest
// (NO trend arrow, never "improving"). Hidden on missing/empty/unparseable history.
let siStr = '';
try {
  const siPath = path.join(dir, '.claude-flow', 'selfimprove-history.jsonl');
  if (fs.existsSync(siPath)) {
    const siRows = fs.readFileSync(siPath, 'utf-8').split('\n').map(x => x.trim()).filter(Boolean);
    if (siRows.length) {
      const siLast = JSON.parse(siRows[siRows.length - 1]);
      if (typeof siLast.accuracyPct === 'number') {
        siStr = `${sep}${CYAN}🔬 SI${RESET} acc ${siLast.accuracyPct}% ◇${siLast.rewardDistinct || 0}`;
      }
    }
  }
} catch { /* hide on absence/parse-fail */ }

console.log(
  `${BOLD}${CYAN}▊ ruflo${RESET} ${rufloStatus}${sep}${BOLD}${PURPLE}Agentic QE v3${RESET} ${aqeStatus}${branchStr}${siStr}`
);
CJS
  pass "wrote dual statusline-v3.cjs fallback"
else
  pass "statusline-v3.cjs already dual (skipped)"
fi

# ── Step 3: Patch .claude/settings.json statusLine.command ────────────────
echo -e "\n${CYAN}[3/4]${NC} Patching .claude/settings.json statusLine command"

if [[ ! -f .claude/settings.json ]]; then
  warn ".claude/settings.json not found — nothing to patch"
else
  node - <<'NODE' || fail "settings.json patch failed"
const fs = require('fs');
const file = '.claude/settings.json';
const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
const desired = 'sh -c \'node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/statusline.cjs" 2>/dev/null || node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/statusline-v3.cjs" 2>/dev/null || echo "▊ RuFlo + Agentic QE v3"\'';
s.statusLine = s.statusLine || { type: 'command', refreshMs: 5000, enabled: true };
if (s.statusLine.command !== desired) {
  s.statusLine.command = desired;
  s.statusLine.type = s.statusLine.type || 'command';
  s.statusLine.refreshMs = s.statusLine.refreshMs || 5000;
  s.statusLine.enabled = s.statusLine.enabled !== false;
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
  console.log('  patched statusLine.command');
} else {
  console.log('  already correct');
}
NODE
  pass "settings.json"
fi

# ── Step 4: Remove legacy plugin if present ────────────────────────────────
echo -e "\n${CYAN}[4/4]${NC} Removing legacy @claude-flow/plugin-agentic-qe"

if [[ -f package.json ]] && grep -q '"@claude-flow/plugin-agentic-qe"' package.json; then
  info "found legacy plugin in package.json — uninstalling"
  npm uninstall @claude-flow/plugin-agentic-qe >/dev/null 2>&1 && pass "uninstalled" || fail "npm uninstall failed"
elif [[ -d node_modules/@claude-flow/plugin-agentic-qe ]]; then
  info "found stray node_modules dir — removing"
  rm -rf node_modules/@claude-flow/plugin-agentic-qe
  rmdir node_modules/@claude-flow 2>/dev/null || true
  pass "removed"
else
  pass "not present"
fi

# ── Render test ──────────────────────────────────────────────────────────
echo -e "\n${CYAN}── Result ──────────────────────────────────${NC}"
if node .claude/helpers/statusline.cjs 2>/dev/null; then
  echo ""
  pass "rich statusline renders OK"
elif node .claude/helpers/statusline-v3.cjs 2>/dev/null; then
  echo ""
  warn "rich statusline failed — fallback renders OK"
else
  fail "both statuslines failed"
fi

echo ""
echo "Restart Claude Code (Ctrl+C then \`claude\`) for the new statusline to appear."
