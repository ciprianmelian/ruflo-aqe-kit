/**
 * Falsification tests for lib/proof.sh P6 "bsqlite" (SQLITE-DEEP-V1, Wave-2 B16).
 *
 * THE LIVE DEFECT this closes: the prior P6 (`probe_bsqlite`) called
 * `global_bsqlite_loads` — a require()-only check — and recorded PASS
 * ("better-sqlite3 loads from agentdb context") as long as `require()`
 * didn't throw. On this host, `$(npm root -g)/ruflo/node_modules/agentdb/
 * node_modules/better-sqlite3` has NO compiled binding (its `build/Release/`
 * directory doesn't exist): `require()` succeeds (the JS wrapper loads
 * fine), but `new Database(':memory:')` throws "Could not locate the
 * bindings file." P6 was PASSing while that property was false — the exact
 * class of false-positive this whole hardening pass exists to close, and it
 * matters because AgentDB's own core silently falls back to sql.js/WASM in
 * precisely this state (a console.log, never a throw), and
 * @claude-flow/neural's reasoning-bank (behind the SONA training pipeline)
 * resolves straight to that same hoisted floor.
 *
 * probe_bsqlite (lib/proof.sh) now delegates to kit_bsqlite_verdict /
 * kit_bsqlite_native_status (lib/common.sh, SQLITE-ROOTS-V1 deepened
 * per-root: resolve -> require() -> `new Database(':memory:')` ->
 * `SELECT 1` -> close). This file falsifies the probe end-to-end (through
 * the real proof.sh, not just the common.sh helper — tests/kit-bsqlite-
 * roots.test.js already covers that layer directly) across its THREE
 * possible tri-state outcomes:
 *
 *   healthy        -> PASS  (every resolvable root opens a database cleanly)
 *   gap            -> FAIL  (a root resolves+requires but can't OPEN a
 *                     database — the real, currently-live shape on this host)
 *   not-assessable -> FAIL, never a silent PASS (zero roots had anything to
 *                     load-test) — sqlite is not optional for agentdb/ruflo
 *                     memory, so this follows P13 stores-writable's "PROVED
 *                     must not be earned blind" precedent, not P7 brain's
 *                     WARN-on-legitimately-optional precedent.
 *
 * Self-contained harness (own mkGroot/mkBin/mkKit/mkTarget), matching this
 * repo's established per-file-fixture convention (tests/proof.test.js,
 * tests/proof-truth-hardening.test.js, tests/kit-bsqlite-roots.test.js all
 * do the same rather than sharing a fixture module).
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIB = path.resolve(__dirname, '..', 'lib');

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

// Three-state fake better-sqlite3 body, matching the shapes
// kit_bsqlite_native_status's deep probe (resolve -> require -> `new
// Database(':memory:')` -> `SELECT 1 AS ok` -> close) must tell apart —
// same fixture shape tests/kit-bsqlite-roots.test.js uses for the
// common.sh-level tests, reproduced here (this file stands alone) for the
// proof.sh-level (end-to-end) falsification:
//   'healthy'     — requires cleanly AND opens/answers/closes like real sqlite.
//   'opensThrows' — requires FINE (JS wrapper loads) but the constructor
//                   throws the moment something tries to open a database —
//                   THE live shape confirmed on this host.
function writeFakeBetterSqlite3(dir, version, state) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'better-sqlite3', version, main: 'index.js' }));
  let body;
  if (state === 'opensThrows') {
    body = [
      "module.exports = function FakeDatabase(file) {",
      "  throw new Error('Could not locate the bindings file (simulated open-time break)');",
      "};",
    ].join('\n') + '\n';
  } else {
    body = [
      "module.exports = function FakeDatabase(file) {",
      "  return { prepare(sql) { return { get() { return { ok: 1 }; } }; }, close() {} };",
      "};",
    ].join('\n') + '\n';
  }
  fs.writeFileSync(path.join(dir, 'index.js'), body);
}

// Fake global npm root with the three agentdb slots + a require()-able
// nested module exposing >=23 classes (so P4/P5 don't spuriously FAIL and
// muddy the JSON this test parses) plus a controllable better-sqlite3
// fixture at the ONE slot that actually resolves in this layout
// (groot/agentdb/node_modules/better-sqlite3 — mirrors tests/proof.test.js's
// mkGroot). `bsqliteState`: 'healthy' | 'opensThrows' | 'absent' (no
// better-sqlite3 anywhere — the not-assessable shape).
function mkGroot(base, bsqliteState) {
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
  // The other candidate roots (@claude-flow/cli, sibling node_modules) don't
  // need to exist as real directories for kit_bsqlite_candidate_roots to
  // list them — kit_bsqlite_native_status reads a missing dir as 'missing'.
  if (bsqliteState !== 'absent') {
    const bs = path.join(groot, 'agentdb', 'node_modules', 'better-sqlite3');
    writeFakeBetterSqlite3(bs, '11.10.0', bsqliteState);
  }
  return groot;
}

function mkBin(base, groot, callLog) {
  const bin = path.join(base, 'bin');
  const logLine = (name) => `echo "${name} $*" >> "${callLog}"`;
  writeExec(path.join(bin, 'ruflo'), `#!/usr/bin/env bash
${logLine('ruflo')}
if [ "$1" = "--version" ]; then echo "3.32.2"; exit 0; fi
if [ "$1" = "mcp" ] && [ "$2" = "start" ]; then echo '{"jsonrpc":"2.0","id":1,"result":{}}'; sleep 0.2; exit 0; fi
if [ "$1" = "hooks" ] && [ "$2" = "route" ]; then echo "route: coder → hierarchical"; exit 0; fi
exit 0
`);
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

// Throwaway kit: real common.sh + proof.sh, JSON-emitting sibling stubs
// (this test only inspects the "bsqlite" entry of the JSON array — the
// other 14 probes are free to PASS/FAIL/WARN independently and don't affect
// these assertions).
function mkKit(base) {
  const kit = path.join(base, 'kit');
  const lib = path.join(kit, 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.copyFileSync(path.join(LIB, 'common.sh'), path.join(lib, 'common.sh'));
  fs.copyFileSync(path.join(LIB, 'proof.sh'), path.join(lib, 'proof.sh'));
  writeExec(path.join(lib, 'status.sh'), `#!/usr/bin/env bash\necho '{"sentinels":{"present":6,"total":6}}'\n`);
  writeExec(path.join(lib, 'verify-learning.sh'), `#!/usr/bin/env bash\necho '{"pass":1,"warn":0,"fail":0,"info":0,"verdict":"live"}'\n`);
  writeExec(path.join(lib, 'health.sh'), `#!/usr/bin/env bash\necho '{"metrics":{"memory":{"totalEntries":100,"hnswEntries":50}}}'\n`);
  const asset = path.join(kit, 'assets', 'statusline.cjs');
  fs.mkdirSync(path.dirname(asset), { recursive: true });
  fs.writeFileSync(asset,
    '#!/usr/bin/env node\n' +
    `if (process.argv.includes('--json')) console.log(${JSON.stringify(JSON.stringify({ swarmdb: { vectorCount: 0 }, tests: { testFiles: 2, testCases: 10, countMethod: 'regex-scan' } }))});\n`);
  fs.chmodSync(asset, 0o755);
  return kit;
}

function mkTarget(base) {
  const target = path.join(base, 'target');
  fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
  const launcher = path.join(target, 'vendor', 'server.mjs');
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, '// launcher\n');
  fs.writeFileSync(path.join(target, '.mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2) + '\n');
  fs.writeFileSync(path.join(target, '.claude', 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: 'echo PROOF_SL_OK' },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(target, 'claude-flow.config.json'),
    JSON.stringify({ daemon: { autostart: false } }, null, 2) + '\n');
  const sl = path.join(target, '.claude', 'helpers', 'statusline.cjs');
  fs.mkdirSync(path.dirname(sl), { recursive: true });
  fs.writeFileSync(sl,
    '#!/usr/bin/env node\n' +
    '// DAEMON-AUTOSTART-3-V1 child-env pin present (test fixture)\n' +
    `if (process.argv.includes('--json')) console.log(${JSON.stringify(JSON.stringify({ swarmdb: { vectorCount: 0 }, tests: { testFiles: 2, testCases: 10, countMethod: 'regex-scan' } }))});\n`);
  fs.chmodSync(sl, 0o755);
  return target;
}

// bsqliteState: 'healthy' | 'opensThrows' | 'absent'.
function build(bsqliteState) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'proof-bsqlite-')));
  worlds.push(base);
  const groot = mkGroot(base, bsqliteState);
  const callLog = path.join(base, 'calls.log');
  fs.writeFileSync(callLog, '');
  const bin = mkBin(base, groot, callLog);
  const kit = mkKit(base);
  const target = mkTarget(base);
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME || base };
  const r = spawnSync('bash', [path.join(kit, 'lib', 'proof.sh'), target, '--single', '--json'],
    { encoding: 'utf8', env });
  let json = null;
  try { json = JSON.parse((r.stdout || '').trim()); } catch { /* leave null, asserted below */ }
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}

function bsqliteProbe(json) {
  return json.probes.find((p) => p.name === 'bsqlite');
}

describe('probe_bsqlite (P6) — healthy layout', () => {
  it('should_PASS_when_theResolvableRootOpensAndAnswersCleanly', () => {
    const { json } = build('healthy');
    expect(json).not.toBeNull();
    const p = bsqliteProbe(json);
    expect(p).toBeDefined();
    expect(p.verdict).toBe('PASS');
    // Detail carries the checked/total counts — not just a bare "loads".
    expect(p.detail).toMatch(/opens :memory:/);
    expect(p.detail).toMatch(/answers SELECT 1/);
  });
});

describe('probe_bsqlite (P6) — falsification: require-ok, open-failed (THE live defect shape)', () => {
  it('should_FAIL_notPass_when_bindingRequiresCleanlyButThrowsOnOpen', () => {
    const { json } = build('opensThrows');
    expect(json).not.toBeNull();
    const p = bsqliteProbe(json);
    expect(p).toBeDefined();
    // THE regression this whole probe deepening exists to close: the OLD
    // require()-only check (global_bsqlite_loads) would have PASSed this
    // exact fixture, because require() never throws here — only the
    // constructor does.
    expect(p.verdict).toBe('FAIL');
  });

  it('should_nameWhichRootFailedAndHow_distinguishingOpenFailedFromMissing', () => {
    const { json } = build('opensThrows');
    const p = bsqliteProbe(json);
    // The detail must name the failing candidate root...
    expect(p.detail).toContain(path.join('groot', 'agentdb'));
    // ...AND the exact resolved file that root requires (an operator needs
    // the physical path to act, e.g. `npm rebuild better-sqlite3` there).
    expect(p.detail).toContain(path.join('node_modules', 'better-sqlite3', 'index.js'));
    // ...and must say it's a require-ok/open-failed diagnosis, not the vague
    // "not loadable" phrasing that used to hide this (which reads
    // indistinguishable from "missing entirely").
    expect(p.detail).toMatch(/require-ok, open-failed/);
    expect(p.detail).not.toMatch(/^better-sqlite3 not loadable/);
  });
});

describe('probe_bsqlite (P6) — falsification: not-assessable must never silently PASS', () => {
  it('should_FAIL_notPass_when_noCandidateRootHasAnyBetterSqlite3AtAll', () => {
    const { json } = build('absent');
    expect(json).not.toBeNull();
    const p = bsqliteProbe(json);
    expect(p).toBeDefined();
    // Precedent: P13 stores-writable FAILs when totally unassessable
    // ("PROVED must not be earned blind") rather than P7 brain's WARN (a
    // legitimately optional component) — sqlite is not optional here.
    expect(p.verdict).toBe('FAIL');
    expect(p.detail).toMatch(/not optional/);
    expect(p.detail).toMatch(/PROVED must not be earned blind/);
  });
});
