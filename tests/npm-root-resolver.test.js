/**
 * Tests for assets/claude-helpers/_npm-root.cjs (NPM-ROOT-RESOLVE-V1).
 *
 * The defect class this resolver closes: helpers derived the global
 * node_modules as dirname(dirname(execPath))/lib/node_modules, which is WRONG
 * on hosts with a custom npm prefix (e.g. system node at /usr/bin/node with
 * `npm root -g` = ~/.npm-global/lib/node_modules — this CI host). Contract:
 *   1. `npm root -g` wins when it succeeds and the path exists;
 *   2. a fake npm printing a nonexistent path is DISTRUSTED (existsSync gate)
 *      → falls back to the execPath derivation;
 *   3. npm missing entirely → execPath derivation;
 *   4. the result is cached per-process (npm invoked at most once).
 *
 * Strategy: spawn node subprocesses with a controlled PATH (fake `npm` stubs,
 * spawn-bash style per tests/statusline-local-probes.test.js) so each case is
 * hermetic regardless of this host's real npm.
 */
'use strict';

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RESOLVER = path.resolve(__dirname, '..', 'assets', 'claude-helpers', '_npm-root.cjs');

// Run a node -e snippet that requires the resolver, with an optional fake-npm bin dir.
function runWith(fakeNpmScript, snippet) {
  let bin = null;
  const env = { ...process.env };
  if (fakeNpmScript !== null) {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'npmroot-bin-'));
    // absolute shebang: PATH is stripped to the fake bin dir, so /usr/bin/env
    // could not find bash there
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/bash\n' + fakeNpmScript);
    fs.chmodSync(path.join(bin, 'npm'), 0o755);
    env.PATH = bin;            // fake npm is the ONLY npm; node is invoked by abspath
    env.NPMROOT_BIN = bin;
  } else {
    env.PATH = '/nonexistent'; // no npm at all
  }
  const r = spawnSync(process.execPath, ['-e', snippet], {
    encoding: 'utf8', timeout: 15000, env,
  });
  if (bin) fs.rmSync(bin, { recursive: true, force: true });
  return r;
}

const DERIVED = path.join(path.dirname(path.dirname(process.execPath)), 'lib', 'node_modules');

describe('_npm-root.cjs — npm root -g is the truth', () => {
  it('returns the real `npm root -g` on this host (existsSync-gated)', () => {
    const real = execSync('npm root -g', { encoding: 'utf8' }).trim();
    // hermetic only if the host truly has this dir (it does on this CI host)
    if (!fs.existsSync(real)) return; // cannot assert here — environment lacks a global root
    const r = spawnSync(process.execPath, ['-e',
      `process.stdout.write(require(${JSON.stringify(RESOLVER)})());`],
      { encoding: 'utf8', timeout: 15000 });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(real);
  });

  it('uses the fake npm output when it prints an EXISTING dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npmroot-g-'));
    const r = runWith(`echo "${dir}"\n`,
      `process.stdout.write(require(${JSON.stringify(RESOLVER)})());`);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('_npm-root.cjs — execPath fallback', () => {
  it('falls back to the execPath derivation when npm is absent', () => {
    const r = runWith(null,
      `process.stdout.write(require(${JSON.stringify(RESOLVER)})());`);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(DERIVED);
  });

  it('distrusts npm output pointing at a NONEXISTENT path (existsSync gate)', () => {
    const r = runWith('echo /definitely/not/a/real/node_modules/xyz\n',
      `process.stdout.write(require(${JSON.stringify(RESOLVER)})());`);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(DERIVED);
  });

  it('falls back when npm exits nonzero', () => {
    const r = runWith('exit 3\n',
      `process.stdout.write(require(${JSON.stringify(RESOLVER)})());`);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(DERIVED);
  });
});

describe('_npm-root.cjs — per-process cache', () => {
  it('invokes npm at most once across repeated calls', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npmroot-c-'));
    // fake npm counts invocations into a file next to itself, then prints dir
    const r = runWith(
      `echo x >> "$NPMROOT_BIN/calls"\necho "${dir}"\n`,
      `const f = require(${JSON.stringify(RESOLVER)});` +
      `const a = f(); const b = f(); const c = f();` +
      `const n = require('fs').readFileSync(process.env.NPMROOT_BIN + '/calls', 'utf8').trim().split('\\n').length;` +
      `process.stdout.write(JSON.stringify({ a, b, c, n }));`);
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.a).toBe(dir);
    expect(j.b).toBe(dir);
    expect(j.c).toBe(dir);
    expect(j.n).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('_npm-root.cjs — installed-location contract', () => {
  it('is on the fix-aqe install list (installs alongside its consumers)', () => {
    const fixAqe = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'fix-aqe.sh'), 'utf8');
    const m = fixAqe.match(/for h in ([^;]*); do/);
    expect(m).toBeTruthy();
    expect(m[1]).toContain('_npm-root.cjs');
  });

  it('consumers require it relative to __dirname with an inline fallback', () => {
    for (const f of ['ruflo-train.cjs', 'ruflo-train-subagent.cjs', 'aqe-rag-inject.cjs']) {
      const s = fs.readFileSync(path.resolve(__dirname, '..', 'assets', 'claude-helpers', f), 'utf8');
      expect(s).toContain("require(path.join(__dirname, '_npm-root.cjs'))");
      // the bad pattern must survive ONLY inside the wrapped-require fallback line
      const bare = s.split('\n').filter((l) =>
        l.includes("path.dirname(path.dirname(process.execPath)), 'lib', 'node_modules'")
        && !l.includes('npmRootG = ()'));
      expect(bare).toEqual([]);
    }
  });
});
