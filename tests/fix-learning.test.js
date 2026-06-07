/**
 * Tests for lib/fix-learning.sh (GitHub issue #4 populate/unlock + cleanup).
 *
 * Safety: the populate chain is only ever exercised with --dry-run here, so NO
 * real ruflo/aqe command runs (run() prints, never evals in dry-run). The
 * cleanup tests operate exclusively inside throwaway temp dirs.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const FIX = path.join(REPO, 'lib', 'fix-learning.sh');

function run(target, extra = []) {
  return spawnSync('bash', [FIX, target, ...extra], { encoding: 'utf8', timeout: 20000 });
}
function mkTarget() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-'));
  fs.mkdirSync(path.join(d, '.swarm'), { recursive: true });
  fs.mkdirSync(path.join(d, '.agentic-qe'), { recursive: true });
  fs.writeFileSync(path.join(d, '.agentic-qe', 'config.yaml'),
    'learning:\n  hnswConfig:\n    M: 8\n');
  return d;
}

describe('fix-learning: --dry-run is a true no-op', () => {
  let d;
  beforeAll(() => { d = mkTarget(); });
  afterAll(() => fs.rmSync(d, { recursive: true, force: true }));

  it('prints the full 10-step chain and exits 0', () => {
    const r = run(d, ['--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/1: running: .*doctor --fix/);
    expect(r.stdout).toMatch(/10: running: .*neural train/);
    expect(r.stdout).toMatch(/\[dry-run\]/);
  });

  it('writes NOTHING to the target config during dry-run', () => {
    const before = fs.readFileSync(path.join(d, '.agentic-qe', 'config.yaml'), 'utf8');
    run(d, ['--dry-run']);
    const after = fs.readFileSync(path.join(d, '.agentic-qe', 'config.yaml'), 'utf8');
    expect(after).toBe(before);
    expect(after).not.toMatch(/useNativeHNSW/); // fix-learning never writes config (that's fix-aqe's job)
  });
});

describe('fix-learning --cleanup: gated, non-destructive by default', () => {
  let d;
  beforeEach(() => {
    d = mkTarget();
    // canonical (must be preserved)
    fs.writeFileSync(path.join(d, 'agentdb.db'), 'CANON');
    fs.writeFileSync(path.join(d, '.swarm', 'memory.db'), 'CANON');
    fs.writeFileSync(path.join(d, '.agentic-qe', 'memory.db'), 'CANON');
    // strays under vendor/ and .claude/ (candidates)
    fs.mkdirSync(path.join(d, 'vendor', 'ruflo'), { recursive: true });
    fs.writeFileSync(path.join(d, 'vendor', 'ruflo', 'ruvector.db'), 'STRAY');
    fs.mkdirSync(path.join(d, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(d, '.claude', 'memory.db'), 'STRAY');
  });
  afterEach(() => fs.rmSync(d, { recursive: true, force: true }));

  it('without --confirm: lists strays and deletes NOTHING', () => {
    const r = run(d, ['--cleanup']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/WOULD remove stray store/);
    expect(fs.existsSync(path.join(d, 'vendor', 'ruflo', 'ruvector.db'))).toBe(true);
    expect(fs.existsSync(path.join(d, '.claude', 'memory.db'))).toBe(true);
  });

  it('with --confirm: removes strays (with .cleanup-bak) but preserves canonical roots', () => {
    const r = run(d, ['--cleanup', '--confirm']);
    expect(r.status).toBe(0);
    // strays gone, backups kept
    expect(fs.existsSync(path.join(d, 'vendor', 'ruflo', 'ruvector.db'))).toBe(false);
    expect(fs.existsSync(path.join(d, 'vendor', 'ruflo', 'ruvector.db.cleanup-bak'))).toBe(true);
    expect(fs.existsSync(path.join(d, '.claude', 'memory.db'))).toBe(false);
    expect(fs.existsSync(path.join(d, '.claude', 'memory.db.cleanup-bak'))).toBe(true);
    // canonical untouched
    expect(fs.existsSync(path.join(d, 'agentdb.db'))).toBe(true);
    expect(fs.existsSync(path.join(d, '.swarm', 'memory.db'))).toBe(true);
    expect(fs.existsSync(path.join(d, '.agentic-qe', 'memory.db'))).toBe(true);
  });

  it('--cleanup --dry-run --confirm still deletes nothing (run() suppressed)', () => {
    const r = run(d, ['--cleanup', '--confirm', '--dry-run']);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(d, 'vendor', 'ruflo', 'ruvector.db'))).toBe(true);
  });
});
