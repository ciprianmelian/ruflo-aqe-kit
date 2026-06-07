/**
 * Tests for the RVF-only stray .agentic-qe sweep (RVF-STRAY-SWEEP-V1) in
 * lib/common.sh, and the AQE-PROJECT-ROOT-PIN-V1 settings.json env pin in
 * lib/fix-aqe.sh.
 *
 * Background: the AQE RVF substrate resolves its store path from a CWD-RELATIVE
 * '.agentic-qe' default instead of findProjectRoot(), so an aqe/hook/worker run
 * with cwd != project root scatters stray '.agentic-qe' dirs that hold ONLY .rvf
 * files (never memory.db/config.yaml). The sweep classifies by the ABSENCE of the
 * canonical SQLite markers — never by location — so the project root is
 * structurally safe.
 *
 * Safety: the sweep tests run entirely in throwaway temp dirs. The fix-aqe pin
 * test sandboxes the global-dist steps by stubbing `npm root -g` to an empty temp
 * prefix that carries a fake agentic-qe/package.json with NO dist/ — so every dist
 * step finds its target absent and skips, and the REAL global install is never
 * touched. Only Step 2 (settings.json wiring, which sets the pin) does real work.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const COMMON = path.join(REPO, 'lib', 'common.sh');
const FIXAQE = path.join(REPO, 'lib', 'fix-aqe.sh');

// ── helpers ──────────────────────────────────────────────────────────────────
function mkStray(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
}

// Source common.sh, run sweep_stray_aqe_dirs, print the result globals.
function sweep(target, mode, dryRun = 0) {
  const script =
    `source "${COMMON}"\n` +
    `export DRY_RUN=${dryRun}\n` +
    `sweep_stray_aqe_dirs "${target}" "${mode}"\n` +
    `echo "RESULT count=$SWEEP_STRAY_COUNT removed=$SWEEP_REMOVED"`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20000 });
  const m = (r.stdout || '').match(/RESULT count=(\d+) removed=(\d+)/);
  return { ...r, count: m ? +m[1] : -1, removed: m ? +m[2] : -1 };
}

function mkSweepTarget() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
  // canonical root — has the SQLite markers: must NEVER be swept
  mkStray(path.join(d, '.agentic-qe'), {
    'memory.db': 'CANON', 'config.yaml': 'learning:\n', 'patterns.rvf': 'RVF', 'brain.rvf': 'RVF',
  });
  // stray under vendor/ — RVF-only
  mkStray(path.join(d, 'vendor', 'ruvector', '.agentic-qe'), { 'patterns.rvf': 'RVF', 'brain.rvf': 'RVF' });
  // stray under docs/ — brain.rvf only
  mkStray(path.join(d, 'docs', '.agentic-qe'), { 'brain.rvf': 'RVF' });
  // stray nested deeper
  mkStray(path.join(d, 'vendor', 'ruvector', 'crates', 'sona', '.agentic-qe'), { 'patterns.rvf': 'RVF' });
  // NOT a stray: nested .agentic-qe that has memory.db (a real nested store)
  mkStray(path.join(d, 'packages', 'app', '.agentic-qe'), { 'memory.db': 'X', 'patterns.rvf': 'RVF' });
  // NOT a stray: empty-ish .agentic-qe with no .rvf payload (not our signature)
  mkStray(path.join(d, 'tmp', '.agentic-qe'), { 'notes.txt': 'x' });
  // excluded: under node_modules
  mkStray(path.join(d, 'node_modules', 'pkg', '.agentic-qe'), { 'patterns.rvf': 'RVF' });
  return d;
}

// ── sweep classification + list mode ─────────────────────────────────────────
describe('sweep_stray_aqe_dirs: classification (list mode)', () => {
  let d;
  beforeEach(() => { d = mkSweepTarget(); });
  afterEach(() => fs.rmSync(d, { recursive: true, force: true }));

  it('counts exactly the 3 RVF-only strays (root/nested-with-db/no-rvf/node_modules excluded)', () => {
    const r = sweep(d, 'list');
    expect(r.status).toBe(0);
    expect(r.count).toBe(3);
    expect(r.removed).toBe(0);
  });

  it('list mode deletes NOTHING', () => {
    sweep(d, 'list');
    expect(fs.existsSync(path.join(d, 'vendor', 'ruvector', '.agentic-qe'))).toBe(true);
    expect(fs.existsSync(path.join(d, 'docs', '.agentic-qe'))).toBe(true);
  });

  it('names the stray dirs (relative) in its output', () => {
    const r = sweep(d, 'list');
    expect(r.stdout).toMatch(/vendor\/ruvector\/\.agentic-qe/);
    expect(r.stdout).toMatch(/docs\/\.agentic-qe/);
  });
});

// ── remove mode ──────────────────────────────────────────────────────────────
describe('sweep_stray_aqe_dirs: remove mode', () => {
  let d;
  beforeEach(() => { d = mkSweepTarget(); });
  afterEach(() => fs.rmSync(d, { recursive: true, force: true }));

  it('moves each stray to .cleanup-bak and preserves the canonical root + nested-with-db', () => {
    const r = sweep(d, 'remove');
    expect(r.count).toBe(3);
    expect(r.removed).toBe(3);
    // strays gone, backups present
    expect(fs.existsSync(path.join(d, 'vendor', 'ruvector', '.agentic-qe'))).toBe(false);
    expect(fs.existsSync(path.join(d, 'vendor', 'ruvector', '.agentic-qe.cleanup-bak'))).toBe(true);
    expect(fs.existsSync(path.join(d, 'docs', '.agentic-qe.cleanup-bak'))).toBe(true);
    // canonical + legit nested store untouched
    expect(fs.existsSync(path.join(d, '.agentic-qe', 'memory.db'))).toBe(true);
    expect(fs.existsSync(path.join(d, 'packages', 'app', '.agentic-qe', 'memory.db'))).toBe(true);
    // node_modules never touched
    expect(fs.existsSync(path.join(d, 'node_modules', 'pkg', '.agentic-qe'))).toBe(true);
  });

  it('DRY_RUN forces list mode even when remove is requested', () => {
    const r = sweep(d, 'remove', /* dryRun */ 1);
    expect(r.removed).toBe(0);
    expect(fs.existsSync(path.join(d, 'vendor', 'ruvector', '.agentic-qe'))).toBe(true);
  });

  it('is idempotent: a second remove finds zero strays', () => {
    sweep(d, 'remove');
    const r2 = sweep(d, 'remove');
    expect(r2.count).toBe(0);
    expect(r2.removed).toBe(0);
  });
});

// ── canonical-root safety (the critical invariant) ───────────────────────────
describe('sweep_stray_aqe_dirs: never removes a store with SQLite markers', () => {
  it('a root holding ONLY config.yaml (+rvf) is not a stray', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep2-'));
    mkStray(path.join(d, '.agentic-qe'), { 'config.yaml': 'x', 'patterns.rvf': 'RVF' });
    const r = sweep(d, 'remove');
    expect(r.count).toBe(0);
    expect(fs.existsSync(path.join(d, '.agentic-qe'))).toBe(true);
    fs.rmSync(d, { recursive: true, force: true });
  });
});

// ── fix-aqe AQE-PROJECT-ROOT-PIN-V1 (sandboxed behavioral) ───────────────────
describe('fix-aqe: AQE-PROJECT-ROOT-PIN-V1 pins env.AQE_PROJECT_ROOT', () => {
  let d, bin, fakeGlobal;

  beforeEach(() => {
    d = fs.mkdtempSync(path.join(os.tmpdir(), 'fxaqe-'));
    fs.mkdirSync(path.join(d, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(d, '.claude', 'settings.json'), '{}\n');
    // fake global prefix: `npm root -g` -> this dir; it carries agentic-qe/package.json
    // with NO dist/, so every fix-aqe dist step finds its target absent and skips —
    // the REAL global agentic-qe is never touched.
    fakeGlobal = fs.mkdtempSync(path.join(os.tmpdir(), 'fxg-'));
    fs.mkdirSync(path.join(fakeGlobal, 'agentic-qe'), { recursive: true });
    fs.writeFileSync(path.join(fakeGlobal, 'agentic-qe', 'package.json'), '{"name":"agentic-qe"}');
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fxbin-'));
    fs.writeFileSync(path.join(bin, 'npm'),
      `#!/usr/bin/env bash\nif [ "$1" = root ] && [ "$2" = "-g" ]; then echo "${fakeGlobal}"; exit 0; fi\nexit 0\n`);
    fs.chmodSync(path.join(bin, 'npm'), 0o755);
  });
  afterEach(() => {
    for (const p of [d, bin, fakeGlobal]) fs.rmSync(p, { recursive: true, force: true });
  });

  function runFixAqe() {
    return spawnSync('bash', [FIXAQE, d], {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  }

  it('sets env.AQE_PROJECT_ROOT to the target dir', () => {
    const r = runFixAqe();
    expect(r.status).toBe(0);
    const s = JSON.parse(fs.readFileSync(path.join(d, '.claude', 'settings.json'), 'utf8'));
    expect(s.env && s.env.AQE_PROJECT_ROOT).toBe(d);
  });

  it('is idempotent and preserves other env keys', () => {
    fs.writeFileSync(path.join(d, '.claude', 'settings.json'),
      JSON.stringify({ env: { KEEP_ME: '1' } }) + '\n');
    runFixAqe();
    runFixAqe();
    const s = JSON.parse(fs.readFileSync(path.join(d, '.claude', 'settings.json'), 'utf8'));
    expect(s.env.AQE_PROJECT_ROOT).toBe(d);
    expect(s.env.KEEP_ME).toBe('1');
  });

  it('reports the stray advisory step (RVF-STRAY-SWEEP-V1)', () => {
    const r = runFixAqe();
    expect(r.stdout).toMatch(/Stray RVF \.agentic-qe advisory/);
  });
});
