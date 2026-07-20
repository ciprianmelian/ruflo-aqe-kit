/**
 * Tests for verify-learning probe #12 — capture-arm inflow liveness
 * (INFLOW-LIVENESS-V1, Patch 67) + the shared kit_aqe_capture_wired helper.
 *
 * The defect class this guards: a `--force` re-init clobbers .claude/settings.json
 * and silently kills the AQE capture hooks; every existing symptom then reads
 * healthy (pool "fully harvested", LoRA adaptations growing) while
 * captured_experiences is frozen. Observed on the Rust workflow-platform target
 * 2026-07-19/20 — found only by a manual settings-snapshot diff. These fixtures
 * pin: structural absence + non-empty pool ⇒ FAIL; wired ⇒ pass; wired-but-stale
 * vs session records ⇒ WARN; empty pool ⇒ never a FAIL.
 *
 * Fixture trick: pool rows use success=1/quality=0.5 so they are VISIBLE to #12
 * (raw count) but NOT eligible for probe #2's harvest filter (quality>=0.7) —
 * keeping #2 out of the assertions here.
 *
 * FAIL requires hook-origin PROOF (source LIKE 'cli-hook-%'): a pool fed only
 * by the ADR-051 middleware (or a pre-source schema) must WARN, not FAIL —
 * otherwise every middleware-only project false-positives (this exact miss was
 * caught by the fresh-target fixtures in verify-learning.test.js on first run).
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const VERIFY = path.join(REPO, 'lib', 'verify-learning.sh');
const COMMON = path.join(REPO, 'lib', 'common.sh');

function sqlite(db, sql) {
  const r = spawnSync('sqlite3', [db, sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sqlite3 failed: ${r.stderr || r.stdout}`);
}

// Deterministic CLI stubs (same shape as verify-learning.test.js) so the run
// decouples from the ambient global flag store / a live daemon.
function stubBin() {
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'vlinf-bin-'));
  fs.writeFileSync(path.join(b, 'aqe'),
    '#!/usr/bin/env bash\nif [ "$1" = ruvector ] && [ "$2" = status ]; then echo "  useNativeHNSW: true (set)"; fi\nexit 0\n');
  fs.writeFileSync(path.join(b, 'ruflo'),
    '#!/usr/bin/env bash\nif [ "$1" = daemon ] && [ "$2" = status ]; then echo "Status: stopped"; fi\nexit 0\n');
  fs.chmodSync(path.join(b, 'aqe'), 0o755);
  fs.chmodSync(path.join(b, 'ruflo'), 0o755);
  return b;
}
function goodDistSrc() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vlinf-dist-'));
  fs.mkdirSync(path.join(d, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(d, 'mcp-tools'), { recursive: true });
  fs.writeFileSync(path.join(d, 'memory', 'intelligence.js'), '// SONA-TRAIN-V1\n');
  fs.writeFileSync(path.join(d, 'mcp-tools', 'hooks-tools.js'), '// RUFLO-LORA-ADAPT-V1\n');
  return d;
}
function runVerify(target) {
  const b = stubBin();
  const dist = goodDistSrc();
  const r = spawnSync('bash', [VERIFY, target], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, PATH: `${b}:${process.env.PATH}`, KIT_RUFLO_DIST_SRC: dist },
  });
  fs.rmSync(b, { recursive: true, force: true });
  fs.rmSync(dist, { recursive: true, force: true });
  return r;
}

// A target fixture: .agentic-qe/memory.db with `pool` capture rows (newest at
// `completedAt`), and optionally a settings.json + a session record.
function mkTarget({ pool = 0, source = 'cli-hook-post-edit', completedAt = '2026-07-20 12:00:00', settings = null, sessionNow = false } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vlinf-tgt-'));
  fs.mkdirSync(path.join(d, '.agentic-qe'), { recursive: true });
  const db = path.join(d, '.agentic-qe', 'memory.db');
  sqlite(db, 'CREATE TABLE captured_experiences (id TEXT PRIMARY KEY, task TEXT, agent TEXT, success INTEGER, quality REAL, source TEXT, completed_at TEXT);');
  for (let i = 0; i < pool; i++) {
    sqlite(db, `INSERT INTO captured_experiences VALUES ('e${i}','t','a',1,0.5,'${source}','${completedAt}');`);
  }
  if (settings !== null) {
    fs.mkdirSync(path.join(d, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(d, '.claude', 'settings.json'), JSON.stringify(settings, null, 2));
  }
  if (sessionNow) {
    const sdir = path.join(d, '.claude-flow', 'sessions');
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, 'session-now.json'), '{}');
  }
  return d;
}

const BRIDGE_CMD = 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/aqe-hook.cjs" post-edit --file "$TOOL_INPUT_file_path" --success --json';
const LEGACY_CMD = 'f=$(jq -r ".tool_input.file_path"); aqe hooks post-edit --file "$f" --json';
const RUFLO_ONLY = { hooks: { PostToolUse: [{ matcher: '^(Write|Edit)$', hooks: [{ type: 'command', command: 'f=$(jq -r ".x"); ruflo hooks post-edit -f "$f"' }] }] } };
const wiredWith = (cmd) => ({ hooks: { PostToolUse: [{ matcher: '^(Write|Edit)$', hooks: [{ type: 'command', command: cmd }] }] } });

describe('probe #12 capture-arm inflow (INFLOW-LIVENESS-V1)', () => {
  test('hook-origin pool + no capture hook => FAIL (exit 1, UNWIRED)', () => {
    const d = mkTarget({ pool: 3, source: 'cli-hook-post-edit', settings: RUFLO_ONLY });
    const r = runVerify(d);
    expect(r.stdout).toMatch(/capture arm UNWIRED: 3 hook-captured experience/);
    expect(r.status).toBe(1);
  });

  test('middleware-only pool + no capture hook => WARN, never FAIL', () => {
    const d = mkTarget({ pool: 3, source: 'middleware', settings: RUFLO_ONLY });
    const r = runVerify(d);
    expect(r.stdout).toMatch(/none hook-originated — middleware\/fleet capture only/);
    expect(r.stdout).not.toMatch(/UNWIRED/);
    expect(r.status).toBe(0);
  });

  test('non-empty pool + bridge-shape hook (JSON-escaped quote) => live, exit 0', () => {
    const d = mkTarget({ pool: 2, settings: wiredWith(BRIDGE_CMD) });
    const r = runVerify(d);
    expect(r.stdout).toMatch(/capture inflow live: hooks wired, pool=2/);
    expect(r.stdout).not.toMatch(/UNWIRED/);
    expect(r.status).toBe(0);
  });

  test('non-empty pool + legacy direct-CLI hook shape => wired', () => {
    const d = mkTarget({ pool: 2, settings: wiredWith(LEGACY_CMD) });
    const r = runVerify(d);
    expect(r.stdout).not.toMatch(/UNWIRED/);
    expect(r.stdout).toMatch(/capture inflow live/);
  });

  test('wired but newest capture ancient vs fresh session record => STALE warn, exit 0', () => {
    const d = mkTarget({ pool: 2, completedAt: '2020-01-01 00:00:00', settings: wiredWith(BRIDGE_CMD), sessionNow: true });
    const r = runVerify(d);
    expect(r.stdout).toMatch(/capture inflow STALE/);
    expect(r.status).toBe(0); // WARN, never FAIL — a chat-only stretch is legitimate
  });

  test('empty pool + no hooks => note only, never a FAIL from #12', () => {
    const d = mkTarget({ pool: 0, settings: RUFLO_ONLY });
    const r = runVerify(d);
    expect(r.stdout).toMatch(/AQE capture not configured/);
    expect(r.stdout).not.toMatch(/UNWIRED/);
    expect(r.status).toBe(0);
  });
});

describe('kit_aqe_capture_wired (common.sh helper)', () => {
  const wired = (dir) =>
    spawnSync('bash', ['-c', `source "${COMMON}" >/dev/null 2>&1; kit_aqe_capture_wired "${dir}" && echo YES || echo NO`],
      { encoding: 'utf8', timeout: 10000 }).stdout.trim();

  test('bridge shape detected through JSON escaping', () => {
    const d = mkTarget({ pool: 0, settings: wiredWith(BRIDGE_CMD) });
    expect(wired(d)).toBe('YES');
  });
  test('ruflo-only hooks are NOT a false positive', () => {
    const d = mkTarget({ pool: 0, settings: RUFLO_ONLY });
    expect(wired(d)).toBe('NO');
  });
  test('missing settings.json => not wired', () => {
    const d = mkTarget({ pool: 0 });
    expect(wired(d)).toBe('NO');
  });
});
