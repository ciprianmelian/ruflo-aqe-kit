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
    const siRows = fs.readFileSync(siPath, 'utf-8').split('\n').map(s => s.trim()).filter(Boolean);
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
