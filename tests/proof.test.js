/**
 * Tests for lib/proof.sh (marker PROOF-V1).
 *
 * proof.sh runs 15 disk-evidence probes and, by default, runs them TWICE (x2)
 * under different environments — verdict PROVED only when both passes are clean
 * AND their per-probe verdict vectors are byte-identical. These tests build a
 * throwaway kit (real common.sh + proof.sh, JSON-emitting stubs for the sibling
 * lib scripts it parses) plus a PATH shim dir of fake executables that log every
 * call. Nothing here touches the network or the real global toolchain.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIB = path.resolve(__dirname, '..', 'lib');

// Must match common.sh's KIT_AGENTDB_PIN / KIT_AGENTDB_HOISTED.
const PIN = '3.0.0-alpha.10';
const HOISTED = '3.0.0-alpha.17';

const worlds = [];
afterEach(() => {
  while (worlds.length) {
    const w = worlds.pop();
    try { fs.rmSync(w, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function writeExec(p, body) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
}

// A fake global npm root with the three agentdb slots, a require-able nested
// module exposing >=23 classes, and a better-sqlite3 fixture under agentdb.
function mkGroot(base) {
  const groot = path.join(base, 'groot');
  const pkg = (rel, ver, extra) => {
    const d = path.join(groot, rel);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'agentdb', version: ver, ...(extra || {}) }));
    return d;
  };
  pkg('agentdb', PIN);
  pkg('ruflo/node_modules/agentdb', HOISTED);
  const nested = pkg('ruflo/node_modules/@claude-flow/memory/node_modules/agentdb', PIN, { main: 'index.js' });
  let src = '';
  const names = [];
  for (let i = 0; i < 25; i++) { src += `class C${i} {}\n`; names.push(`C${i}`); }
  fs.writeFileSync(path.join(nested, 'index.js'), src + `module.exports = { ${names.join(', ')} };\n`);
  // better-sqlite3 resolvable from agentdb's context (global_bsqlite_loads).
  const bs = path.join(groot, 'agentdb', 'node_modules', 'better-sqlite3');
  fs.mkdirSync(bs, { recursive: true });
  fs.writeFileSync(path.join(bs, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '11.8.1', main: 'index.js' }));
  fs.writeFileSync(path.join(bs, 'index.js'), 'module.exports = {};\n');
  return groot;
}

// PATH shim dir. Every shim appends "<argv> :: RUVNET_BRAIN_KB=<value>" to the
// call-log so tests can (a) assert call order and (b) prove pass 2 ran under a
// clean env (the var reads <unset>). node is NOT shimmed — real node is needed.
function mkBin(base, groot, callLog, { ruflo = 'normal', sqlite = 'shim' } = {}) {
  const bin = path.join(base, 'bin');
  const logLine = (name) => `echo "${name} $* :: RUVNET_BRAIN_KB=\${RUVNET_BRAIN_KB:-<unset>}" >> "${callLog}"`;

  let rufloBody;
  if (ruflo === 'fail') {
    rufloBody = `#!/usr/bin/env bash\n${logLine('ruflo')}\nexit 1\n`;
  } else if (ruflo === 'flip') {
    // hooks route flips: first invocation across the whole run returns a
    // decision (PASS in pass 1); every later one is empty (WARN in pass 2).
    const counter = path.join(base, 'route-counter');
    rufloBody = `#!/usr/bin/env bash
${logLine('ruflo')}
if [ "$1" = "--version" ]; then echo "3.32.2"; exit 0; fi
if [ "$1" = "mcp" ] && [ "$2" = "start" ]; then sleep 0.3; exit 0; fi
if [ "$1" = "hooks" ] && [ "$2" = "route" ]; then
  n=$(( $(cat "${counter}" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${counter}"
  if [ "$n" -eq 1 ]; then echo "route: coder"; fi
  exit 0
fi
exit 0
`;
  } else {
    rufloBody = `#!/usr/bin/env bash
${logLine('ruflo')}
if [ "$1" = "--version" ]; then echo "3.32.2"; exit 0; fi
if [ "$1" = "mcp" ] && [ "$2" = "start" ]; then sleep 0.3; exit 0; fi
if [ "$1" = "hooks" ] && [ "$2" = "route" ]; then echo "route: coder → hierarchical"; exit 0; fi
exit 0
`;
  }
  writeExec(path.join(bin, 'ruflo'), rufloBody);

  writeExec(path.join(bin, 'aqe'), `#!/usr/bin/env bash
${logLine('aqe')}
if [ "$1" = "--version" ]; then echo "3.12.2"; exit 0; fi
exit 0
`);
  writeExec(path.join(bin, 'agentdb'), `#!/usr/bin/env bash\n${logLine('agentdb')}\nexit 0\n`);
  // sqlite3 is shimmed to a no-op by default (deterministic, binary-free). P15
  // statusline-truth tests need REAL counts, so they build with { sqlite: 'real' }
  // and let the real sqlite3 resolve from the inherited PATH.
  if (sqlite !== 'real') {
    writeExec(path.join(bin, 'sqlite3'), `#!/usr/bin/env bash\n${logLine('sqlite3')}\nexit 0\n`);
  }
  writeExec(path.join(bin, 'npm'), `#!/usr/bin/env bash
${logLine('npm')}
if [ "$1" = "root" ] && [ "$2" = "-g" ]; then echo "${groot}"; exit 0; fi
if [ "$1" = "--version" ]; then echo "10.8.0"; exit 0; fi
exit 0
`);
  return bin;
}

// Throwaway kit: real common.sh + proof.sh, JSON-emitting sibling stubs.
function mkKit(base) {
  const kit = path.join(base, 'kit');
  const lib = path.join(kit, 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.copyFileSync(path.join(LIB, 'common.sh'), path.join(lib, 'common.sh'));
  fs.copyFileSync(path.join(LIB, 'proof.sh'), path.join(lib, 'proof.sh'));
  // Sibling scripts proof.sh parses — stubbed to emit the JSON shapes the
  // probes read (present==total sentinels, live verdict, sane memory totals).
  writeExec(path.join(lib, 'status.sh'), `#!/usr/bin/env bash\necho '{"sentinels":{"present":6,"total":6}}'\n`);
  writeExec(path.join(lib, 'verify-learning.sh'), `#!/usr/bin/env bash\necho '{"pass":1,"warn":0,"fail":0,"info":0,"verdict":"live"}'\n`);
  writeExec(path.join(lib, 'health.sh'), `#!/usr/bin/env bash\necho '{"metrics":{"memory":{"totalEntries":100,"hnswEntries":50}}}'\n`);
  // P15 statusline-truth renders $KIT_ASSETS/statusline.cjs (the canonical asset).
  // The default stub emits vectorCount 0 — which matches the shimmed sqlite3's
  // indep sum of 0 (the shim prints nothing → every COUNT parses to 0) within the
  // ±5 tolerance — plus a valid tests block (countMethod 'regex-scan',
  // testCases>=testFiles), so P15 is PASS in the default build. P15-specific tests
  // overwrite this asset (writeKitAsset) and use a real sqlite3 db.
  writeKitAsset(kit, { vectorCount: 0, testFiles: 2, testCases: 10, countMethod: 'regex-scan' });
  return kit;
}

// Write kit/assets/statusline.cjs as a stub whose --json emits a controllable
// swarmdb/tests shape. `opts.omit` (array) drops keys (e.g. 'countMethod') to
// exercise P15's failure branches.
function writeKitAsset(kit, opts) {
  const omit = new Set(opts.omit || []);
  const tests = { testFiles: opts.testFiles, testCases: opts.testCases };
  if (!omit.has('countMethod')) tests.countMethod = opts.countMethod;
  const payload = { swarmdb: { vectorCount: opts.vectorCount }, tests };
  const asset = path.join(kit, 'assets', 'statusline.cjs');
  fs.mkdirSync(path.dirname(asset), { recursive: true });
  fs.writeFileSync(asset,
    '#!/usr/bin/env node\n' +
    `if (process.argv.includes('--json')) console.log(${JSON.stringify(JSON.stringify(payload))});\n`);
  fs.chmodSync(asset, 0o755);
  return asset;
}

// Populate a target's .swarm/memory.db with M memory_entries rows that have a
// non-null embedding — the dominant term of P15's independent audit sum (the
// other three tables are absent → 0). Uses the REAL sqlite3 (build with
// { sqlite: 'real' }). Returns M.
function seedSwarmVectors(target, m) {
  const db = path.join(target, '.swarm', 'memory.db');
  try { fs.rmSync(db, { force: true }); } catch { /* ignore */ }
  const rows = Array.from({ length: m }, (_, i) => `(${i + 1}, x'00')`).join(',');
  const sql = `CREATE TABLE memory_entries(id INTEGER, embedding BLOB); INSERT INTO memory_entries(id, embedding) VALUES ${rows};`;
  const r = spawnSync('sqlite3', [db, sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('sqlite3 seed failed: ' + (r.stderr || r.error));
  return m;
}

// A target codebase fixture: .mcp.json with ruvnet-brain (launcher + KB on
// disk), a statusLine command, and the three sqlite stores present.
function mkTarget(base) {
  const target = path.join(base, 'target');
  fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
  const launcher = path.join(target, 'vendor', 'server.mjs');
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, '// launcher\n');
  const kb = path.join(base, 'kb');
  fs.mkdirSync(kb, { recursive: true });
  fs.writeFileSync(path.join(kb, 'forge-mcp-all.mjs'), '// forge\n');
  fs.writeFileSync(path.join(kb, 'package.json'), JSON.stringify({ name: 'ruvnet-brain-kb', version: '2.9.0' }));
  fs.writeFileSync(path.join(target, '.mcp.json'), JSON.stringify({
    mcpServers: { 'ruvnet-brain': { command: 'node', args: [launcher], env: { RUVNET_BRAIN_KB: kb } } },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(target, '.claude', 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: 'echo PROOF_SL_OK' },
  }, null, 2) + '\n');
  fs.mkdirSync(path.join(target, '.swarm'), { recursive: true });
  fs.mkdirSync(path.join(target, '.agentic-qe'), { recursive: true });
  for (const db of ['.swarm/memory.db', '.agentic-qe/memory.db', 'agentdb.db']) {
    fs.writeFileSync(path.join(target, db), '');
  }
  // P14 daemon-gates: the daemon three-channel opt-out must be intact — the
  // project-root config with daemon.autostart:false (CF-CONFIG-AUTOSTART-OFF-V1)
  // and the installed statusline carrying the DAEMON-AUTOSTART-3-V1 child-env pin.
  fs.writeFileSync(path.join(target, 'claude-flow.config.json'),
    JSON.stringify({ daemon: { autostart: false } }, null, 2) + '\n');
  fs.mkdirSync(path.join(target, '.claude', 'helpers'), { recursive: true });
  fs.writeFileSync(path.join(target, '.claude', 'helpers', 'statusline.cjs'),
    '// installed statusline stub — DAEMON-AUTOSTART-3-V1 child-env pin present\n');
  return target;
}

function build({ ruflo = 'normal', sqlite = 'shim' } = {}) {
  // realpathSync canonicalizes /var → /private/var on macOS so the fake global
  // root matches the realpath require.resolve() returns (global_bsqlite_loads
  // asserts the module resolves UNDER the global root).
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prooftest-')));
  worlds.push(base);
  const groot = mkGroot(base);
  const callLog = path.join(base, 'calls.log');
  fs.writeFileSync(callLog, '');
  const bin = mkBin(base, groot, callLog, { ruflo, sqlite });
  const kit = mkKit(base);
  const target = mkTarget(base);
  const run = (args = [], extraEnv = {}) => {
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME || base, ...extraEnv };
    const r = spawnSync('bash', [path.join(kit, 'lib', 'proof.sh'), target, ...args],
      { encoding: 'utf8', env });
    return { code: r.status, stdout: r.stdout || '', out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  return { base, kit, target, bin, callLog, run };
}

describe('proof.sh --single: one pass, all probes green', () => {
  it('reports 15 probes with 0 failed and exits 0', () => {
    const { run } = build();
    const { code, stdout } = run(['--single', '--json']);
    const j = JSON.parse(stdout.trim());
    expect(j.probes.length).toBe(15);
    expect(j.failed).toBe(0);
    expect(code).toBe(0);
  });
});

describe('proof.sh x2: two passes, stable → PROVED', () => {
  it('emits pass1 + pass2, verdict PROVED, exit 0', () => {
    const { run } = build();
    const { code, stdout } = run(['--json']);
    const j = JSON.parse(stdout.trim());
    expect(j.pass1.probes.length).toBe(15);
    expect(j.pass2.probes.length).toBe(15);
    expect(j.stable).toBe(true);
    expect(j.verdict).toBe('PROVED');
    expect(code).toBe(0);
  });
});

describe('proof.sh x2: a probe that flips between passes → UNSTABLE', () => {
  it('detects the flip (stable false) and exits 1', () => {
    const { run } = build({ ruflo: 'flip' });
    const { code, stdout } = run(['--json']);
    const j = JSON.parse(stdout.trim());
    expect(j.stable).toBe(false);
    expect(j.verdict).toBe('UNSTABLE');
    expect(code).toBe(1);
  });
});

describe('proof.sh: a real FAIL fails the proof', () => {
  it('ruflo --version exiting 1 makes ruflo-cli FAIL and exits 1', () => {
    const { run } = build({ ruflo: 'fail' });
    const { code, stdout } = run(['--single', '--json']);
    const j = JSON.parse(stdout.trim());
    expect(j.failed).toBeGreaterThanOrEqual(1);
    expect(j.probes.find((p) => p.name === 'ruflo-cli').verdict).toBe('FAIL');
    expect(code).toBe(1);
  });
});

describe('proof.sh x2: pass 2 re-derives everything under a CLEAN env', () => {
  it('a bogus RUVNET_BRAIN_KB in the parent env is absent from pass-2 shim calls', () => {
    const { run, callLog } = build();
    const bogus = '/BOGUS/kb/path';
    const { code } = run(['--json'], { RUVNET_BRAIN_KB: bogus });
    const log = fs.readFileSync(callLog, 'utf8');
    // pass 1 inherited the bogus value; pass 2 (env -i) must show it unset.
    expect(log).toMatch(new RegExp(`RUVNET_BRAIN_KB=${bogus.replace(/\//g, '\\/')}`));
    expect(log).toMatch(/RUVNET_BRAIN_KB=<unset>/);
    expect(code).toBe(0);
  });
});

// Find a probe by name in a --single --json result.
function probe(j, name) { return j.probes.find((p) => p.name === name); }

// ── P14 daemon-gates ─────────────────────────────────────────────────────────
// The daemon three-channel opt-out: project-root claude-flow.config.json with
// daemon.autostart:false AND the installed statusline carrying the
// DAEMON-AUTOSTART-3-V1 child-env pin. Config missing / autostart!=false / pin
// absent are each a FAIL. (Running `cli.js daemon start` processes only WARN —
// process-level shimming is out of scope, so those cases are not exercised here;
// the PASS case tolerates an environmental WARN by asserting NOT-FAIL + detail.)

describe('proof.sh P14 daemon-gates', () => {
  it('config daemon.autostart:false + statusline pinned → not FAIL (both gates satisfied)', () => {
    const { run } = build(); // mkTarget provides both by default
    const j = JSON.parse(run(['--single', '--json']).stdout.trim());
    const p = probe(j, 'daemon-gates');
    // A running operator daemon can downgrade PASS→WARN environmentally; the gate
    // truth is in the detail, which must show config-off AND statusline-pinned.
    expect(p.verdict).not.toBe('FAIL');
    expect(p.detail).toMatch(/config:off/);
    expect(p.detail).toMatch(/statusline pinned/);
  });

  it('claude-flow.config.json absent → FAIL', () => {
    const { run, target } = build();
    fs.rmSync(path.join(target, 'claude-flow.config.json'), { force: true });
    const j = JSON.parse(run(['--single', '--json']).stdout.trim());
    const p = probe(j, 'daemon-gates');
    expect(p.verdict).toBe('FAIL');
    expect(p.detail).toMatch(/MISSING/i);
  });

  it('claude-flow.config.json present but daemon.autostart:true → FAIL', () => {
    const { run, target } = build();
    fs.writeFileSync(path.join(target, 'claude-flow.config.json'),
      JSON.stringify({ daemon: { autostart: true } }, null, 2) + '\n');
    const j = JSON.parse(run(['--single', '--json']).stdout.trim());
    const p = probe(j, 'daemon-gates');
    expect(p.verdict).toBe('FAIL');
    expect(p.detail).toMatch(/autostart != false/);
  });

  it('installed statusline lacking the DAEMON-AUTOSTART-3-V1 pin → FAIL', () => {
    const { run, target } = build();
    // config stays off; drop the pin from the installed statusline.
    fs.writeFileSync(path.join(target, '.claude', 'helpers', 'statusline.cjs'),
      '// unpinned statusline stub — no child-env gate\n');
    const j = JSON.parse(run(['--single', '--json']).stdout.trim());
    const p = probe(j, 'daemon-gates');
    expect(p.verdict).toBe('FAIL');
    expect(p.detail).toMatch(/lacks DAEMON-AUTOSTART-3-V1/);
  });
});

// ── P15 statusline-truth ─────────────────────────────────────────────────────
// The TRUTH-STATUSLINE-V1 contract: the canonical statusline's --json must
// re-derive from disk. P15 renders $KIT_ASSETS/statusline.cjs and cross-checks
// swarmdb.vectorCount against a fresh sqlite audit sum over .swarm/memory.db
// (±5), and requires tests.testCases>=testFiles with countMethod 'regex-scan'.
// These build with REAL sqlite3 so the ground-truth sum is meaningful; the
// canonical asset is a controllable stub (writeKitAsset).

describe('proof.sh P15 statusline-truth', () => {
  it('vectorCount == sqlite sum (N==M) + valid tests block → PASS', () => {
    const { run, kit, target } = build({ sqlite: 'real' });
    const m = seedSwarmVectors(target, 7);
    writeKitAsset(kit, { vectorCount: m, testFiles: 2, testCases: 10, countMethod: 'regex-scan' });
    const j = JSON.parse(run(['--single', '--json']).stdout.trim());
    const p = probe(j, 'statusline-truth');
    expect(p.verdict).toBe('PASS');
  });

  it('vectorCount drifted N+50 beyond the ±5 tolerance → FAIL', () => {
    const { run, kit, target } = build({ sqlite: 'real' });
    const m = seedSwarmVectors(target, 7);
    writeKitAsset(kit, { vectorCount: m + 50, testFiles: 2, testCases: 10, countMethod: 'regex-scan' });
    const j = JSON.parse(run(['--single', '--json']).stdout.trim());
    const p = probe(j, 'statusline-truth');
    expect(p.verdict).toBe('FAIL');
    expect(p.detail).toMatch(/drift/i);
  });

  it('tests block without countMethod=regex-scan → FAIL', () => {
    const { run, kit, target } = build({ sqlite: 'real' });
    const m = seedSwarmVectors(target, 7);
    writeKitAsset(kit, { vectorCount: m, testFiles: 2, testCases: 10, omit: ['countMethod'] });
    const j = JSON.parse(run(['--single', '--json']).stdout.trim());
    const p = probe(j, 'statusline-truth');
    expect(p.verdict).toBe('FAIL');
    expect(p.detail).toMatch(/countMethod/);
  });

  it('no .swarm/memory.db → fresh-target WARN (not FAIL)', () => {
    const { run, target } = build({ sqlite: 'real' });
    fs.rmSync(path.join(target, '.swarm', 'memory.db'), { force: true });
    const j = JSON.parse(run(['--single', '--json']).stdout.trim());
    const p = probe(j, 'statusline-truth');
    expect(p.verdict).toBe('WARN');
  });
});
