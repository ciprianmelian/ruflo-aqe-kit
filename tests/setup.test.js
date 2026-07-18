/**
 * Tests for lib/setup.sh (marker SETUP-V1).
 *
 * setup.sh's job is ORCHESTRATION: S1 prereqs → S2 global installs → S3 init →
 * S4 heal → S5 brain KB → S6 daemon policy (no action) → S7 proof x2, with
 * setup's exit code == proof's exit code. The sibling lib scripts have their own
 * tests, so here they are STUBBED (each echoes a completion token and drops a
 * marker unless --dry-run). A PATH shim dir of fake globals logs every call so
 * we can assert stage order, that no install runs when tools are present, and
 * that the daemon is NEVER started.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIB = path.resolve(__dirname, '..', 'lib');
const PIN = '3.0.0-alpha.10';

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

// A stubbed sibling lib script: appends "<name> <argv>" to the call-log, drops a
// marker file into the target unless --dry-run, prints a completion token, and
// exits with `code`.
function libStub(name, callLog, { code = 0 } = {}) {
  return `#!/usr/bin/env bash
echo "${name} $*" >> "${callLog}"
target="$1"; dry=0
for a in "$@"; do [ "$a" = "--dry-run" ] && dry=1; done
if [ "$dry" -eq 0 ] && [ -d "$target" ]; then : > "$target/${name}.marker"; fi
echo "${name} complete"
exit ${code}
`;
}

// A global-tool shim: logs every call, and answers the handful of probes setup
// makes (command -v hits the file; npm root -g / --version return fixtures).
function mkBin(base, groot, callLog, { present = true, proofCode = 0 } = {}) {
  const bin = path.join(base, 'bin');
  const log = (n) => `echo "${n} $*" >> "${callLog}"`;
  if (present) {
    writeExec(path.join(bin, 'ruflo'), `#!/usr/bin/env bash\n${log('ruflo')}\n[ "$1" = "--version" ] && echo 3.32.2\nexit 0\n`);
    writeExec(path.join(bin, 'aqe'), `#!/usr/bin/env bash\n${log('aqe')}\n[ "$1" = "--version" ] && echo 3.12.2\nexit 0\n`);
    writeExec(path.join(bin, 'agentdb'), `#!/usr/bin/env bash\n${log('agentdb')}\nexit 0\n`);
  }
  // sqlite3/unzip/git present so S1 stays green; node/npm come from the real env
  // but npm is shimmed here so `npm root -g` points at the fake global root and a
  // better-sqlite3 fixture makes global_bsqlite_loads succeed (no agentdb install).
  writeExec(path.join(bin, 'sqlite3'), `#!/usr/bin/env bash\n${log('sqlite3')}\nexit 0\n`);
  writeExec(path.join(bin, 'unzip'), `#!/usr/bin/env bash\n${log('unzip')}\nexit 0\n`);
  writeExec(path.join(bin, 'npm'), `#!/usr/bin/env bash
${log('npm')}
if [ "$1" = "root" ] && [ "$2" = "-g" ]; then echo "${groot}"; exit 0; fi
if [ "$1" = "--version" ]; then echo "10.8.0"; exit 0; fi
if [ "$1" = "install" ]; then exit 0; fi
exit 0
`);
  return bin;
}

// Fake global root with a better-sqlite3 fixture under agentdb, so
// global_bsqlite_loads() succeeds and S2 skips the agentdb install.
function mkGroot(base) {
  const groot = path.join(base, 'groot');
  const bs = path.join(groot, 'agentdb', 'node_modules', 'better-sqlite3');
  fs.mkdirSync(bs, { recursive: true });
  fs.writeFileSync(path.join(bs, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '11.8.1', main: 'index.js' }));
  fs.writeFileSync(path.join(bs, 'index.js'), 'module.exports = {};\n');
  return groot;
}

function mkKit(base, callLog, { proofCode = 0 } = {}) {
  const kit = path.join(base, 'kit');
  const lib = path.join(kit, 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.copyFileSync(path.join(LIB, 'common.sh'), path.join(lib, 'common.sh'));
  fs.copyFileSync(path.join(LIB, 'setup.sh'), path.join(lib, 'setup.sh'));
  for (const s of ['init.sh', 'sync.sh', 'fix-brain.sh']) {
    writeExec(path.join(lib, s), libStub(s, callLog));
  }
  writeExec(path.join(lib, 'proof.sh'), libStub('proof.sh', callLog, { code: proofCode }));
  return kit;
}

function build({ present = true, proofCode = 0 } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'setuptest-')));
  worlds.push(base);
  const groot = mkGroot(base);
  const callLog = path.join(base, 'calls.log');
  fs.writeFileSync(callLog, '');
  const bin = mkBin(base, groot, callLog, { present });
  const kit = mkKit(base, callLog, { proofCode });
  const target = path.join(base, 'target');
  fs.mkdirSync(target, { recursive: true });
  const run = (args = []) => {
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME || base };
    const r = spawnSync('bash', [path.join(kit, 'lib', 'setup.sh'), target, ...args],
      { encoding: 'utf8', env });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '' };
  };
  return { base, kit, target, bin, callLog, run };
}

const marker = (target, name) => fs.existsSync(path.join(target, `${name}.marker`));

describe('setup.sh: stage order', () => {
  it('runs init → sync → proof in that order (from the call-log)', () => {
    const { run, callLog, target } = build();
    const { code } = run();
    const log = fs.readFileSync(callLog, 'utf8');
    const iInit = log.indexOf('init.sh');
    const iSync = log.indexOf('sync.sh');
    const iProof = log.indexOf('proof.sh');
    expect(iInit).toBeGreaterThanOrEqual(0);
    expect(iSync).toBeGreaterThan(iInit);
    expect(iProof).toBeGreaterThan(iSync);
    // markers prove the stubs actually ran (S3/S4 write real markers).
    expect(marker(target, 'init.sh')).toBe(true);
    expect(marker(target, 'sync.sh')).toBe(true);
    expect(code).toBe(0);
  });
});

describe('setup.sh --dry-run: no markers, no installs, exit 0', () => {
  it('propagates --dry-run so nothing is written or installed', () => {
    const { run, callLog, target } = build();
    const { code } = run(['--dry-run']);
    expect(marker(target, 'init.sh')).toBe(false);
    expect(marker(target, 'sync.sh')).toBe(false);
    expect(marker(target, 'proof.sh')).toBe(false); // S7 skipped under --dry-run
    expect(fs.readFileSync(callLog, 'utf8')).not.toMatch(/npm install -g/);
    expect(code).toBe(0);
  });
});

describe('setup.sh S2: no install when the tools are already present', () => {
  it('does not run npm install -g when ruflo/aqe/agentdb are all present', () => {
    const { run, callLog } = build({ present: true });
    run();
    expect(fs.readFileSync(callLog, 'utf8')).not.toMatch(/npm install -g/);
  });
});

describe('setup.sh S5: brain KB is opt-in', () => {
  it('passes --download to fix-brain only with --with-brain-kb', () => {
    const withKb = build();
    withKb.run(['--with-brain-kb']);
    const wlog = fs.readFileSync(withKb.callLog, 'utf8');
    expect(wlog).toMatch(/fix-brain\.sh .*--download/);

    const withoutKb = build();
    withoutKb.run();
    const nlog = fs.readFileSync(withoutKb.callLog, 'utf8');
    expect(nlog).not.toMatch(/fix-brain\.sh .*--download/);
  });
});

describe('setup.sh S7: exit code mirrors proof', () => {
  it('exits 1 when proof exits 1', () => {
    const { run } = build({ proofCode: 1 });
    const { code } = run();
    expect(code).toBe(1);
  });
});

describe('setup.sh S6: never starts the daemon', () => {
  it('the call-log never contains a daemon start', () => {
    const { run, callLog } = build();
    run();
    expect(fs.readFileSync(callLog, 'utf8')).not.toMatch(/daemon start/);
  });
});

describe('setup.sh --skip-install: S2 skipped even when tools are absent', () => {
  it('runs no install even though ruflo/aqe/agentdb are missing', () => {
    const { run, callLog } = build({ present: false });
    run(['--skip-install']);
    const log = fs.readFileSync(callLog, 'utf8');
    expect(log).not.toMatch(/npm install -g/);
    // and it still proceeds to init/sync/proof.
    expect(log).toMatch(/init\.sh/);
    expect(log).toMatch(/proof\.sh/);
  });
});
