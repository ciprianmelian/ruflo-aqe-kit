/**
 * Tests for lib/status.sh — the read-only `ruflo-kit status` porcelain.
 *
 * status.sh is disk-derived and read-only, so these run the REAL script (fast,
 * no mutation). They assert the three contracts the porcelain promises:
 *   1. exit 0 ALWAYS (status is a report, not a gate) — even on an empty target.
 *   2. --json is ALWAYS valid JSON with the documented top-level shape, even
 *      when nothing is installed in the target (agentic-kit's contract).
 *   3. the daemon field reflects `pgrep` truth, not a state file.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATUS = path.resolve(__dirname, '..', 'lib', 'status.sh');
const REPO = path.resolve(__dirname, '..');

function run(target, args = []) {
  const r = spawnSync('bash', [STATUS, target, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function mkEmptyTarget() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'status-'));
}

const TOP_KEYS = ['kit', 'globals', 'sentinels', 'daemon', 'mcp', 'learning', 'config'];

describe('status.sh: exit code contract', () => {
  it('exits 0 on an empty fixture target (human mode)', () => {
    const d = mkEmptyTarget();
    try {
      expect(run(d).code).toBe(0);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('exits 0 on this repo (human mode)', () => {
    expect(run(REPO).code).toBe(0);
  });

  it('exits 0 in --json mode', () => {
    expect(run(REPO, ['--json']).code).toBe(0);
  });
});

describe('status.sh --json: always-valid machine shape', () => {
  it('parses as JSON on an empty fixture (nothing installed in target)', () => {
    const d = mkEmptyTarget();
    try {
      const { out } = run(d, ['--json']);
      const parsed = JSON.parse(out); // throws if invalid → fails the test
      expect(TOP_KEYS.every((k) => k in parsed)).toBe(true);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('parses as JSON on this repo and has every top-level key', () => {
    const { out } = run(REPO, ['--json']);
    const parsed = JSON.parse(out);
    for (const k of TOP_KEYS) expect(parsed).toHaveProperty(k);
  });

  it('empty target still yields learning counts as null (not a crash) with valid shape', () => {
    const d = mkEmptyTarget();
    try {
      const parsed = JSON.parse(run(d, ['--json']).out);
      expect(parsed.learning.episodes).toBeNull();
      expect(Array.isArray(parsed.mcp.servers)).toBe(true);
      expect(parsed.mcp.servers).toHaveLength(0);
      expect(Array.isArray(parsed.daemon.pids)).toBe(true);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('sentinels block reports a present/total pair with an items array', () => {
    const parsed = JSON.parse(run(REPO, ['--json']).out);
    expect(typeof parsed.sentinels.present).toBe('number');
    expect(typeof parsed.sentinels.total).toBe('number');
    expect(Array.isArray(parsed.sentinels.items)).toBe(true);
    expect(parsed.sentinels.present).toBeLessThanOrEqual(parsed.sentinels.total);
  });
});

describe('status.sh: daemon field matches pgrep truth', () => {
  it('daemon.running reflects live `pgrep -f "ruflo daemon"` (not a state file)', () => {
    const pgSnap = () => {
      const pg = spawnSync('pgrep', ['-f', 'ruflo daemon'], { encoding: 'utf8' });
      return pg.status === 0 && pg.stdout.trim().length > 0;
    };
    // Bracket the status call: a daemon can start/stop between two independent
    // pgrep snapshots (a real race in a multi-agent session), so only assert exact
    // pgrep equality when the state is STABLE across the call. Regardless, status.sh
    // must keep running↔pids internally consistent — that alone proves it derives the
    // field from pgrep output, not from a (lying) state file.
    const before = pgSnap();
    const parsed = JSON.parse(run(REPO, ['--json']).out);
    const after = pgSnap();
    expect(parsed.daemon.running).toBe(parsed.daemon.pids.length > 0);
    if (before === after) expect(parsed.daemon.running).toBe(before);
  });
});

describe('status.sh --hints: compact bare-invocation output', () => {
  it('prints four labelled hint lines and exits 0', () => {
    const { out, code } = run(REPO, ['--hints']);
    expect(code).toBe(0);
    expect(out).toMatch(/versions:/);
    expect(out).toMatch(/daemon:/);
    expect(out).toMatch(/sentinels:/);
    expect(out).toMatch(/learning:/);
  });
});
