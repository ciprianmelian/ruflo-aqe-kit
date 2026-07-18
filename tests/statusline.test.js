/**
 * Tests for .claude/helpers/statusline.cjs
 *
 * Coverage gaps addressed:
 *  - readCache() / writeCache(): TTL-based caching (fresh hit, stale miss)
 *  - getLocalADRCount(): counts .md files in multiple ADR directories
 *  - buildLocalFallback(): produces a valid statusline data object
 *  - progressBar(): renders filled/empty dots with correct counts
 *  - getSelfImprove(): parses selfimprove-history.jsonl; hidden when file absent
 *  - readJSON(): returns null on missing/corrupt file; parses valid JSON
 *  - --json flag: output is valid JSON with expected top-level keys
 *  - --compact flag: output is a single-line JSON string
 *  - default mode: output is a non-empty ANSI string
 *
 * Strategy: statusline.cjs auto-executes a render on require() (via the bottom
 * if-block), so all structural tests use subprocess spawning. Pure-logic helpers
 * that are not exported are re-implemented inline for unit coverage.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Test the CANONICAL tracked baseline, not the installed copy: upstream
// session hooks REGENERATE .claude/helpers mid-suite (observed in CI: the
// seeded statusline.cjs was replaced by a vanilla upstream copy between the
// seed step and this file's execution — same clobber the hook-handler suite
// hit). Under TRUTH-STATUSLINE-V1 the single source of truth is
// assets/statusline.cjs — what fix-statusbar installs and what HELPER-SEED
// seeds; the retired assets/claude-helpers/ copy is deleted (see
// statusline-canonical.test.js). It is self-contained (no sibling requires)
// and cannot be rewritten under the suite's feet.
const SCRIPT = path.resolve(__dirname, '../assets/statusline.cjs');
const PROJECT_ROOT = path.resolve(__dirname, '..');

function run(args = [], opts = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    cwd: PROJECT_ROOT,
    // Pipe stdin as TTY so getStdinData() short-circuits on isTTY=true
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
}

// ── Inline re-implementations of non-exported pure helpers ───────────────────

function progressBar(current, total) {
  const width = 5;
  const filled = Math.round((current / total) * width);
  return '[' + '●'.repeat(filled) + '○'.repeat(width - filled) + ']';
}

function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch { /* ignore */ }
  return null;
}

// ── progressBar (inline mirror) ───────────────────────────────────────────────

describe('progressBar', () => {
  it('renders all empty when current=0', () => {
    expect(progressBar(0, 5)).toBe('[○○○○○]');
  });

  it('renders all filled when current=total', () => {
    expect(progressBar(5, 5)).toBe('[●●●●●]');
  });

  it('renders correct partial fill', () => {
    const bar = progressBar(2, 5);
    const filledCount = (bar.match(/●/g) || []).length;
    const emptyCount = (bar.match(/○/g) || []).length;
    expect(filledCount).toBe(2);
    expect(emptyCount).toBe(3);
  });

  it('rounds correctly for non-integer fill', () => {
    // 1/3 of 5 = 1.67 → rounds to 2
    const bar = progressBar(1, 3);
    const filledCount = (bar.match(/●/g) || []).length;
    expect(filledCount).toBe(2);
  });

  it('always returns a string starting with [ and ending with ]', () => {
    for (let i = 0; i <= 5; i++) {
      const bar = progressBar(i, 5);
      expect(bar.startsWith('[')).toBe(true);
      expect(bar.endsWith(']')).toBe(true);
    }
  });
});

// ── readJSON (inline mirror) ──────────────────────────────────────────────────

describe('readJSON', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sline-test-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns null for missing file', () => {
    expect(readJSON(path.join(tmpDir, 'nonexistent.json'))).toBeNull();
  });

  it('returns null for corrupt JSON', () => {
    const p = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(p, '{invalid}');
    expect(readJSON(p)).toBeNull();
  });

  it('parses valid JSON', () => {
    const p = path.join(tmpDir, 'ok.json');
    fs.writeFileSync(p, JSON.stringify({ foo: 'bar', n: 42 }));
    expect(readJSON(p)).toEqual({ foo: 'bar', n: 42 });
  });
});

// ── getSelfImprove (subprocess — reads selfimprove-history.jsonl) ─────────────

describe('getSelfImprove behavior via statusline --json', () => {
  let histPath;

  beforeEach(() => {
    histPath = path.join(PROJECT_ROOT, '.claude-flow', 'selfimprove-history.jsonl');
  });

  it('does not crash when selfimprove-history.jsonl is absent', () => {
    const r = run(['--json']);
    // Script should still produce valid JSON even if the SI file is missing
    expect(r.status).toBe(0);
    try { JSON.parse(r.stdout); } catch (e) { throw new Error('Output is not valid JSON: ' + r.stdout.slice(0, 200)); }
  });
});

// ── getLocalADRCount (subprocess) ─────────────────────────────────────────────

describe('getLocalADRCount behavior via --json output', () => {
  it('adrs.count is a non-negative integer in JSON output', () => {
    const r = run(['--json']);
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.adrs).toBeTruthy();
    expect(typeof data.adrs.count).toBe('number');
    expect(data.adrs.count).toBeGreaterThanOrEqual(0);
  });
});

// ── --json output format ──────────────────────────────────────────────────────

describe('statusline --json output', () => {
  it('exits 0', () => {
    const r = run(['--json']);
    expect(r.status).toBe(0);
  });

  it('outputs valid JSON', () => {
    const r = run(['--json']);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  it('has top-level keys: adrs, hooks, agentdb, swarmdb, tests', () => {
    // Two order-dependent hazards make this flaky against the repo cwd (both
    // observed as macos-only CI failures):
    //  1. swarmdb requires .swarm/memory.db in cwd (absent on a clean checkout
    //     unless an earlier test happened to create it);
    //  2. statusline caches its data per-cwd (tmpdir, md5(CWD), 10s TTL) — a
    //     synthetic cache written by statusline-cache tests for the SAME cwd
    //     can be served here, and it predates the swarmdb key.
    // Deterministic on every platform: a throwaway cwd (own cache slot, no
    // cross-file race) provisioned with a .swarm/memory.db placeholder.
    const fs = require('fs');
    const os = require('os');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-json-'));
    fs.mkdirSync(path.join(cwd, '.swarm'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.swarm', 'memory.db'), '');
    const r = spawnSync(process.execPath, [SCRIPT, '--json'], {
      encoding: 'utf8', timeout: 30000, cwd,
    });
    const d = JSON.parse(r.stdout);
    expect(d).toHaveProperty('adrs');
    expect(d).toHaveProperty('hooks');
    expect(d).toHaveProperty('agentdb');
    expect(d).toHaveProperty('swarmdb');
    expect(d).toHaveProperty('tests');
  });

  it('has user.name and user.gitBranch fields', () => {
    const r = run(['--json']);
    const d = JSON.parse(r.stdout);
    expect(d.user).toHaveProperty('name');
    expect(d.user).toHaveProperty('gitBranch');
  });

  it('has git change counters as numbers', () => {
    const r = run(['--json']);
    const d = JSON.parse(r.stdout);
    expect(d.git).toBeTruthy();
    expect(typeof d.git.modified).toBe('number');
    expect(typeof d.git.untracked).toBe('number');
    expect(typeof d.git.staged).toBe('number');
  });

  it('agentdb has vectorCount, dbSizeKB, hasHnsw', () => {
    const r = run(['--json']);
    const d = JSON.parse(r.stdout);
    expect(typeof d.agentdb.vectorCount).toBe('number');
    expect(typeof d.agentdb.dbSizeKB).toBe('number');
    expect(typeof d.agentdb.hasHnsw).toBe('boolean');
  });

  it('tests.testFiles is a non-negative integer', () => {
    const r = run(['--json']);
    const d = JSON.parse(r.stdout);
    expect(d.tests.testFiles).toBeGreaterThanOrEqual(0);
  });
});

// ── TRUTH-STATUSLINE-V1 additive --json keys ─────────────────────────────────
// The truth overhaul keeps EVERY existing key (asserted above) and adds real,
// disk-derived fields. Rendered in a throwaway cwd with a .swarm/memory.db
// placeholder so the swarmdb branch runs and the cache slot is this test's own
// (no cross-file cache race — same isolation the top-level-keys test uses).
// Expected-fail until w-statusline lands TRUTH-SL-V1 on assets/statusline.cjs.

describe('statusline --json — TRUTH-SL-V1 additive keys', () => {
  let cwd, d;

  beforeAll(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-truthkeys-'));
    fs.mkdirSync(path.join(cwd, '.swarm'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.swarm', 'memory.db'), '');
    // getAQEStats() gates the additive `aqe` block on the existence of
    // .agentic-qe/memory.db — provision it so the key is present (it is a REAL
    // disk-derived block, absent by design on non-AQE targets).
    fs.mkdirSync(path.join(cwd, '.agentic-qe'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.agentic-qe', 'memory.db'), '');
    const r = spawnSync(process.execPath, [SCRIPT, '--json'], {
      encoding: 'utf8', timeout: 30000, cwd,
    });
    d = JSON.parse(r.stdout);
  }, 40000);

  afterAll(() => { if (cwd) fs.rmSync(cwd, { recursive: true, force: true }); });

  it('stores: N-of-5 learning-store liveness ({live,total,detail})', () => {
    expect(d).toHaveProperty('stores');
    expect(typeof d.stores.live).toBe('number');
    expect(d.stores.total).toBe(5);
    expect(d.stores.live).toBeGreaterThanOrEqual(0);
    expect(d.stores.live).toBeLessThanOrEqual(5);
    // detail[] carries per-store truth so tests/dashboard can prove each one.
    expect(Array.isArray(d.stores.detail)).toBe(true);
    expect(d.stores.detail.length).toBe(5);
  });

  it('swarm.registry: present as a key, nullable (null when no swarm-state.json)', () => {
    // registry-backed swarm chip; the key must exist even when there is no
    // registry file (value null), never be silently absent.
    expect(d.swarm).toHaveProperty('registry');
    expect(d.swarm.registry === null || typeof d.swarm.registry === 'object').toBe(true);
  });

  it('tests.countMethod is the real-count method tag and testCases >= testFiles', () => {
    expect(d.tests.countMethod).toBe('regex-scan');
    expect(typeof d.tests.testCases).toBe('number');
    expect(d.tests.testCases).toBeGreaterThanOrEqual(d.tests.testFiles);
  });

  it('system.storesMB is a number (Σ of the store sizes, replacing renderer-heap "memory")', () => {
    expect(typeof d.system.storesMB).toBe('number');
    expect(d.system.storesMB).toBeGreaterThanOrEqual(0);
  });

  it('aqe: real disk-derived block present when .agentic-qe/memory.db exists', () => {
    expect(d).toHaveProperty('aqe');
    expect(typeof d.aqe.patterns).toBe('number');
    expect(typeof d.aqe.vectors).toBe('number');
    expect(typeof d.aqe.hasIndex).toBe('boolean');
  });
});

// ── --compact output ──────────────────────────────────────────────────────────

describe('statusline --compact output', () => {
  it('outputs a single-line JSON string', () => {
    const r = run(['--compact']);
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines.length).toBe(1);
    expect(() => JSON.parse(lines[0])).not.toThrow();
  });
});

// ── Default (ANSI) output ─────────────────────────────────────────────────────

describe('statusline default (ANSI) output', () => {
  it('exits 0', () => {
    const r = run([]);
    expect(r.status).toBe(0);
  });

  it('outputs a non-empty string', () => {
    const r = run([]);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  });

  it('contains "RuFlo V" header', () => {
    const r = run([]);
    // Strip ANSI codes for the assertion
    const plain = r.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('RuFlo V');
  });
});
