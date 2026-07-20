/**
 * Tests for the KIT-SQLITE-SHIM-V1 surface in lib/common.sh and its adoption
 * across status.sh / proof.sh (P13 + P15) / verify-learning.sh.
 *
 * The core scenario: a host WITHOUT the sqlite3 CLI must still get REAL answers
 * (via node + the global ruflo's better-sqlite3), never blind/degraded probes.
 * "Without sqlite3" is simulated with a stripped PATH: a tmp bin dir holding
 * symlinks to every executable on the real PATH EXCEPT sqlite3, plus a stub
 * `npm` whose `root -g` points at the real (or a bogus) global root. Fixture
 * dbs are seeded with the REAL sqlite3 CLI before the PATH is stripped.
 */
'use strict';

const { spawn, spawnSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'lib');
const REAL_GROOT = execSync('npm root -g', { encoding: 'utf8' }).trim();
const REAL_BSQLITE = path.join(REAL_GROOT, 'ruflo', 'node_modules', 'better-sqlite3');
const REAL_SQLITE3 = execSync('command -v sqlite3', { encoding: 'utf8', shell: 'bash' }).trim();

const worlds = [];
afterEach(() => {
  while (worlds.length) {
    const w = worlds.pop();
    try { fs.rmSync(w, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function mkBase() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sqshim-')));
  worlds.push(base);
  return base;
}

function writeExec(p, body) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
}

// Seed a db with the REAL sqlite3 (runs under the full inherited PATH).
function sqlite(db, sql) {
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const r = spawnSync(REAL_SQLITE3, [db, sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sqlite3 seed failed: ${r.stderr || r.stdout}`);
}

// A PATH dir mirroring every executable on the real PATH except sqlite3.
function mkStrippedBin(base) {
  const bin = path.join(base, 'stripped-bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const d of (process.env.PATH || '').split(':')) {
    let names;
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (n === 'sqlite3') continue;
      try { fs.symlinkSync(path.join(d, n), path.join(bin, n)); } catch { /* dup */ }
    }
  }
  return bin;
}

// A stub-bin dir that always shadows `npm` (deterministic `npm root -g`,
// decoupled from the child's npm config) plus any extra named stubs.
function mkStubBin(base, { groot = REAL_GROOT, extra = {} } = {}) {
  const bin = path.join(base, 'stub-bin');
  writeExec(path.join(bin, 'npm'), `#!/usr/bin/env bash
if [ "$1" = "root" ] && [ "$2" = "-g" ]; then echo "${groot}"; exit 0; fi
if [ "$1" = "--version" ]; then echo "9.0.0"; exit 0; fi
exit 0
`);
  for (const [name, body] of Object.entries(extra)) writeExec(path.join(bin, name), body);
  return bin;
}

// Tiny bash driver exposing the three shim functions from the REAL common.sh.
function mkDriver(base) {
  const drv = path.join(base, 'driver.sh');
  writeExec(drv, `#!/usr/bin/env bash
source "${LIB}/common.sh"
case "$1" in
  backend) kit_sqlite_backend ;;
  ro)      kit_sqlite_ro "$2" "$3" ;;
  rw)      kit_sqlite_rw_check "$2"; echo "rc=$?" ;;
esac
`);
  return drv;
}

// Environment where sqlite3 is gone but node/npm-root still resolve.
function strippedEnv(base, { groot = REAL_GROOT, extra = {} } = {}) {
  const stub = mkStubBin(base, { groot, extra });
  const stripped = mkStrippedBin(base);
  return { PATH: `${stub}:${stripped}`, HOME: process.env.HOME, RUFLO_DAEMON_AUTOSTART: '0' };
}

function runDriver(base, env, args) {
  const r = spawnSync('bash', [mkDriver(base), ...args], { encoding: 'utf8', env });
  return { code: r.status, stdout: (r.stdout || '').trim(), stderr: r.stderr || '' };
}

// ── the shim functions themselves ────────────────────────────────────────────

describe('kit_sqlite_backend', () => {
  it('reports cli when sqlite3 is on PATH', () => {
    const base = mkBase();
    const env = { PATH: process.env.PATH, HOME: process.env.HOME };
    const r = runDriver(base, env, ['backend']);
    expect(r.stdout).toBe('cli');
    expect(r.code).toBe(0);
  });

  it('reports node when sqlite3 is absent but global better-sqlite3 loads', () => {
    const base = mkBase();
    const r = runDriver(base, strippedEnv(base), ['backend']);
    expect(r.stdout).toBe('node');
    expect(r.code).toBe(0);
  });

  it('reports none (rc 1) when neither instrument exists', () => {
    const base = mkBase();
    const r = runDriver(base, strippedEnv(base, { groot: '/nonexistent-groot' }), ['backend']);
    expect(r.stdout).toBe('none');
    expect(r.code).toBe(1);
  });
});

describe('kit_sqlite_ro without sqlite3 (node fallback)', () => {
  it('returns the correct COUNT via better-sqlite3', () => {
    const base = mkBase();
    const db = path.join(base, 'fix.db');
    sqlite(db, 'CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (1),(2),(3);');
    const r = runDriver(base, strippedEnv(base), ['ro', db, 'SELECT COUNT(*) FROM t;']);
    expect(r.stdout).toBe('3');
    expect(r.code).toBe(0);
  });

  it('mirrors the CLI pipe-separated list mode for multi-column rows', () => {
    const base = mkBase();
    const db = path.join(base, 'fix.db');
    sqlite(db, "CREATE TABLE t(id INTEGER, name TEXT); INSERT INTO t VALUES (1,'a'),(2,'b');");
    const r = runDriver(base, strippedEnv(base), ['ro', db, 'SELECT id, name FROM t ORDER BY id;']);
    expect(r.stdout).toBe('1|a\n2|b');
  });

  it('CLI remains the first choice when sqlite3 IS on PATH (zero behavior change)', () => {
    const base = mkBase();
    const db = path.join(base, 'fix.db');
    const log = path.join(base, 'cli-used.log');
    sqlite(db, 'CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (1),(2);');
    // A logging sqlite3 shim that delegates to the real CLI, shadowing it.
    const stub = mkStubBin(base, {
      extra: { sqlite3: `#!/usr/bin/env bash\necho used >> "${log}"\nexec "${REAL_SQLITE3}" "$@"\n` },
    });
    const env = { PATH: `${stub}:${process.env.PATH}`, HOME: process.env.HOME };
    const r = runDriver(base, env, ['ro', db, 'SELECT COUNT(*) FROM t;']);
    expect(r.stdout).toBe('2');
    expect(fs.existsSync(log)).toBe(true); // the CLI arm ran, not the node arm
  });
});

describe('kit_sqlite_rw_check without sqlite3 (node fallback)', () => {
  it('rc 0 on an unlocked store', () => {
    const base = mkBase();
    const db = path.join(base, 'store.db');
    sqlite(db, 'CREATE TABLE t(x INTEGER);');
    const r = runDriver(base, strippedEnv(base), ['rw', db]);
    expect(r.stdout).toBe('rc=0');
  });

  it('rc 1 when another writer holds BEGIN IMMEDIATE (3s busy timeout)', async () => {
    const base = mkBase();
    const db = path.join(base, 'store.db');
    sqlite(db, 'CREATE TABLE t(x INTEGER);');
    // Hold the write lock from a separate node process (real better-sqlite3).
    const holder = spawn(process.execPath, ['-e', `
      const B = require(process.argv[1]);
      const d = new B(process.argv[2]);
      d.exec('BEGIN IMMEDIATE');
      console.log('LOCKED');
      setTimeout(() => process.exit(0), 12000);
    `, REAL_BSQLITE, db], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      holder.stdout.once('data', resolve);
      holder.once('error', reject);
      setTimeout(() => reject(new Error('lock holder never acquired the lock')), 5000);
    });
    const r = runDriver(base, strippedEnv(base), ['rw', db]);
    holder.kill('SIGKILL');
    expect(r.stdout).toBe('rc=1');
  });

  it('rc 2 (no instrument) when neither sqlite3 nor better-sqlite3 exists', () => {
    const base = mkBase();
    const db = path.join(base, 'store.db');
    sqlite(db, 'CREATE TABLE t(x INTEGER);');
    const r = runDriver(base, strippedEnv(base, { groot: '/nonexistent-groot' }), ['rw', db]);
    expect(r.stdout).toBe('rc=2');
  });
});

// ── status.sh: counts appear either way ──────────────────────────────────────

function mkStatusTarget(base) {
  const target = path.join(base, 'target');
  fs.mkdirSync(target, { recursive: true });
  sqlite(path.join(target, 'agentdb.db'),
    'CREATE TABLE episodes(id INTEGER); INSERT INTO episodes VALUES (1),(2),(3);' +
    'CREATE TABLE skills(id INTEGER); INSERT INTO skills VALUES (1);');
  sqlite(path.join(target, '.agentic-qe', 'memory.db'),
    'CREATE TABLE captured_experiences(id INTEGER); INSERT INTO captured_experiences VALUES (1),(2);' +
    'CREATE TABLE qe_patterns(id INTEGER);');
  return target;
}

describe('status.sh learning counts without sqlite3', () => {
  it('--json carries real counts via the node fallback (sqliteBackend "node")', () => {
    const base = mkBase();
    const target = mkStatusTarget(base);
    const r = spawnSync('bash', [path.join(LIB, 'status.sh'), target, '--json'],
      { encoding: 'utf8', env: strippedEnv(base) });
    const out = r.stdout || '';
    const j = JSON.parse(out.slice(out.indexOf('{')));
    expect(j.learning.episodes).toBe(3);
    expect(j.learning.skills).toBe(1);
    expect(j.learning.experiences).toBe(2);
    expect(j.learning.patterns).toBe(0);
    expect(j.learning.sqlite).toBe(true);
    expect(j.learning.sqliteBackend).toBe('node');
  });

  it('--hints prints the counts with a transparent node-fallback note', () => {
    const base = mkBase();
    const target = mkStatusTarget(base);
    const r = spawnSync('bash', [path.join(LIB, 'status.sh'), target, '--hints'],
      { encoding: 'utf8', env: strippedEnv(base) });
    expect(r.stdout).toMatch(/learning:\s+episodes 3 · skills 1 · experiences 2 · patterns 0 \(node fallback\)/);
  });

  it('--json reports null counts + sqliteBackend "none" with no instrument at all', () => {
    const base = mkBase();
    const target = mkStatusTarget(base);
    const r = spawnSync('bash', [path.join(LIB, 'status.sh'), target, '--json'],
      { encoding: 'utf8', env: strippedEnv(base, { groot: '/nonexistent-groot' }) });
    const out = r.stdout || '';
    const j = JSON.parse(out.slice(out.indexOf('{')));
    expect(j.learning.episodes).toBeNull();
    expect(j.learning.sqlite).toBe(false);
    expect(j.learning.sqliteBackend).toBe('none');
  });
});

// ── verify-learning.sh: hollow must not be masked as partial ─────────────────

describe('verify-learning.sh without sqlite3', () => {
  function mkHollowTarget(base) {
    const target = path.join(base, 'target');
    fs.mkdirSync(path.join(target, '.swarm'), { recursive: true });
    // Eligible harvestable experiences captured, but NOTHING harvested
    // (no agentdb.db episodes/skills) — the definition of HOLLOW.
    sqlite(path.join(target, '.agentic-qe', 'memory.db'),
      'CREATE TABLE captured_experiences(id INTEGER, success INTEGER, quality REAL);' +
      'INSERT INTO captured_experiences VALUES (1,1,0.9),(2,1,0.8);');
    return target;
  }
  function goodDistSrc(base) {
    const d = path.join(base, 'dist-src');
    fs.mkdirSync(path.join(d, 'memory'), { recursive: true });
    fs.mkdirSync(path.join(d, 'mcp-tools'), { recursive: true });
    fs.writeFileSync(path.join(d, 'memory', 'intelligence.js'), '// SONA-TRAIN-V1\n');
    fs.writeFileSync(path.join(d, 'mcp-tools', 'hooks-tools.js'), '// RUFLO-LORA-ADAPT-V1\n');
    return d;
  }
  const cliStubs = {
    aqe: '#!/usr/bin/env bash\nif [ "$1" = ruvector ] && [ "$2" = status ]; then echo "  useNativeHNSW: true (set)"; fi\nexit 0\n',
    ruflo: '#!/usr/bin/env bash\nif [ "$1" = daemon ] && [ "$2" = status ]; then echo "Status: stopped"; fi\nexit 0\n',
  };

  it('grades HOLLOW (exit 1) via the node fallback — the pre-shim masking read "partial"', () => {
    const base = mkBase();
    const target = mkHollowTarget(base);
    const env = { ...strippedEnv(base, { extra: cliStubs }), KIT_RUFLO_DIST_SRC: goodDistSrc(base) };
    const r = spawnSync('bash', [path.join(LIB, 'verify-learning.sh'), target, '--json'],
      { encoding: 'utf8', env, timeout: 30000 });
    const lines = (r.stdout || '').trim().split('\n');
    const j = JSON.parse(lines[lines.length - 1]);
    expect(j.verdict).toBe('hollow');
    expect(r.status).toBe(1);
  });

  it('with NO instrument at all it WARNs about masking (never better than partial)', () => {
    const base = mkBase();
    const target = mkHollowTarget(base);
    const env = { ...strippedEnv(base, { groot: '/nonexistent-groot', extra: cliStubs }), KIT_RUFLO_DIST_SRC: goodDistSrc(base) };
    const r = spawnSync('bash', [path.join(LIB, 'verify-learning.sh'), target],
      { encoding: 'utf8', env, timeout: 30000 });
    expect(r.stdout).toMatch(/no sqlite instrument .* verdict may MASK a hollow loop/);
    expect(r.stdout).toMatch(/learning loop partial/);
  });
});

// ── proof.sh P13 + P15 without sqlite3 ───────────────────────────────────────

// Compact proof world: real common.sh + proof.sh, JSON-emitting sibling stubs,
// a controllable canonical-statusline asset, real seeded sqlite stores.
function mkProofWorld(base, { groot = REAL_GROOT, vectors = 7 } = {}) {
  const kit = path.join(base, 'kit');
  const kl = path.join(kit, 'lib');
  fs.mkdirSync(kl, { recursive: true });
  fs.copyFileSync(path.join(LIB, 'common.sh'), path.join(kl, 'common.sh'));
  fs.copyFileSync(path.join(LIB, 'proof.sh'), path.join(kl, 'proof.sh'));
  writeExec(path.join(kl, 'status.sh'), `#!/usr/bin/env bash\necho '{"sentinels":{"present":6,"total":6}}'\n`);
  writeExec(path.join(kl, 'verify-learning.sh'), `#!/usr/bin/env bash\necho '{"pass":1,"warn":0,"fail":0,"info":0,"verdict":"live"}'\n`);
  writeExec(path.join(kl, 'health.sh'), `#!/usr/bin/env bash\necho '{"metrics":{"memory":{"totalEntries":100,"hnswEntries":50}}}'\n`);
  const payload = JSON.stringify({
    swarmdb: { vectorCount: vectors },
    tests: { testFiles: 2, testCases: 10, countMethod: 'regex-scan' },
  });
  writeExec(path.join(kit, 'assets', 'statusline.cjs'),
    `#!/usr/bin/env node\nif (process.argv.includes('--json')) console.log(${JSON.stringify(payload)});\n`);

  const target = path.join(base, 'target');
  fs.mkdirSync(path.join(target, '.claude', 'helpers'), { recursive: true });
  const rows = Array.from({ length: vectors }, (_, i) => `(${i + 1}, x'00')`).join(',');
  sqlite(path.join(target, '.swarm', 'memory.db'),
    'CREATE TABLE memory_entries(id INTEGER, embedding BLOB);' +
    (vectors > 0 ? ` INSERT INTO memory_entries VALUES ${rows};` : ''));
  sqlite(path.join(target, '.agentic-qe', 'memory.db'), 'CREATE TABLE t(x INTEGER);');
  sqlite(path.join(target, 'agentdb.db'), 'CREATE TABLE t(x INTEGER);');
  fs.writeFileSync(path.join(target, 'claude-flow.config.json'),
    JSON.stringify({ daemon: { autostart: false } }) + '\n');
  fs.writeFileSync(path.join(target, '.claude', 'helpers', 'statusline.cjs'),
    '// DAEMON-AUTOSTART-3-V1 pin present\n');

  const rufloStub = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "3.32.8"; exit 0; fi
if [ "$1" = "hooks" ] && [ "$2" = "route" ]; then echo "route: coder"; exit 0; fi
exit 0
`;
  const env = strippedEnv(base, {
    groot,
    extra: {
      ruflo: rufloStub,
      aqe: '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "3.12.2"; fi\nexit 0\n',
      agentdb: '#!/usr/bin/env bash\nexit 0\n',
    },
  });
  const run = () => {
    const r = spawnSync('bash', [path.join(kl, 'proof.sh'), target, '--single', '--json'],
      { encoding: 'utf8', env, timeout: 60000 });
    return JSON.parse((r.stdout || '').trim());
  };
  return { run };
}

function probeOf(j, name) { return j.probes.find((p) => p.name === name); }

describe('proof.sh P13/P15 without sqlite3', () => {
  it('P13 runs the REAL lock test on the node fallback (PASS + transparency note); P15 recounts independently', () => {
    const base = mkBase();
    const { run } = mkProofWorld(base);
    const j = run();
    const p13 = probeOf(j, 'stores-writable');
    expect(p13.verdict).toBe('PASS');
    expect(p13.detail).toMatch(/3 store\(s\) take a write lock cleanly/);
    expect(p13.detail).toMatch(/node better-sqlite3 fallback/);
    const p15 = probeOf(j, 'statusline-truth');
    expect(p15.verdict).toBe('PASS');
    expect(p15.detail).toMatch(/vectorCount 7 ~ sqlite 7/);
    expect(p15.detail).toMatch(/recount via node better-sqlite3 fallback/);
  });

  it('with NO instrument: P13 FAILs "not assessable", P15 FAILs "independent recount unavailable" (no silent-0 false-PASS)', () => {
    const base = mkBase();
    // vectors=0 so the statusline stub renders vectorCount 0 — the exact shape a
    // silent-0 recount would have false-PASSed before the honesty fix.
    const { run } = mkProofWorld(base, { groot: '/nonexistent-groot', vectors: 0 });
    const j = run();
    const p13 = probeOf(j, 'stores-writable');
    expect(p13.verdict).toBe('FAIL');
    expect(p13.detail).toMatch(/no sqlite instrument/);
    expect(p13.detail).toMatch(/not assessable/);
    const p15 = probeOf(j, 'statusline-truth');
    expect(p15.verdict).toBe('FAIL');
    expect(p15.detail).toMatch(/independent recount unavailable/);
  });
});
