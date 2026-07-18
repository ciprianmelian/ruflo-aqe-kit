/**
 * Tests for lib/proof.sh (marker PROOF-V1).
 *
 * proof.sh runs 13 disk-evidence probes and, by default, runs them TWICE (x2)
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
function mkBin(base, groot, callLog, { ruflo = 'normal' } = {}) {
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
  writeExec(path.join(bin, 'sqlite3'), `#!/usr/bin/env bash\n${logLine('sqlite3')}\nexit 0\n`);
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
  return kit;
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
  return target;
}

function build({ ruflo = 'normal' } = {}) {
  // realpathSync canonicalizes /var → /private/var on macOS so the fake global
  // root matches the realpath require.resolve() returns (global_bsqlite_loads
  // asserts the module resolves UNDER the global root).
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prooftest-')));
  worlds.push(base);
  const groot = mkGroot(base);
  const callLog = path.join(base, 'calls.log');
  fs.writeFileSync(callLog, '');
  const bin = mkBin(base, groot, callLog, { ruflo });
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
  it('reports 13 probes with 0 failed and exits 0', () => {
    const { run } = build();
    const { code, stdout } = run(['--single', '--json']);
    const j = JSON.parse(stdout.trim());
    expect(j.probes.length).toBe(13);
    expect(j.failed).toBe(0);
    expect(code).toBe(0);
  });
});

describe('proof.sh x2: two passes, stable → PROVED', () => {
  it('emits pass1 + pass2, verdict PROVED, exit 0', () => {
    const { run } = build();
    const { code, stdout } = run(['--json']);
    const j = JSON.parse(stdout.trim());
    expect(j.pass1.probes.length).toBe(13);
    expect(j.pass2.probes.length).toBe(13);
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
