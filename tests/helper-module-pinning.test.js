/**
 * Tests for pin_helpers_module_type (lib/common.sh).
 *
 * Bug: when a project's root package.json is "type":"module", Node loads the
 * CommonJS .claude/helpers (router.js etc., required by hook-handler.cjs) as ES
 * modules, so PreCompact/SessionEnd hooks crash with "require is not defined".
 * The fix pins the helper dir to commonjs and relocates the genuinely-ESM
 * github-safe.js to .mjs. These tests build throwaway fixtures and assert the
 * pin both produces the right files AND actually unbreaks `require()`.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const COMMON = path.resolve(__dirname, '..', 'lib', 'common.sh');

// Run pin_helpers_module_type against <target>, return {status, out}.
// DRY_RUN must be injected as a command PREFIX on the function call — common.sh
// resets DRY_RUN=0 at source time, so a process-env var would be clobbered.
function pin(target, { dryRun = false } = {}) {
  const prefix = dryRun ? 'DRY_RUN=1 ' : '';
  const r = spawnSync('bash', ['-c',
    `source "${COMMON}"; ${prefix}pin_helpers_module_type "${target}"`],
    { encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim() };
}

// A minimal mixed-module .claude/helpers + a hook-handler.cjs that require()s
// router.js — the exact shape that crashes in an ESM project.
function mkProject(rootType /* 'module' | 'commonjs' | null */) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-'));
  if (rootType) fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ type: rootType }));
  const h = path.join(d, '.claude', 'helpers');
  fs.mkdirSync(h, { recursive: true });
  fs.writeFileSync(path.join(h, 'router.js'),
    'function routeTask(t){return "x";}\nmodule.exports = { routeTask };\nif (require.main === module) { console.log("cli"); }\n');
  fs.writeFileSync(path.join(h, 'github-safe.js'),
    "import os from 'node:os';\nexport const V = '1';\nif (process.argv[1]) console.log('Usage', os.platform());\n");
  fs.writeFileSync(path.join(h, 'hook-handler.cjs'),
    "const path = require('path');\nconst r = require(path.join(__dirname, 'router.js'));\nconsole.log('OK', r.routeTask('t'));\n");
  return { d, h };
}

function nodeRun(file) {
  return spawnSync(process.execPath, [file], { encoding: 'utf8' });
}

describe('pin_helpers_module_type: ESM project (the bug)', () => {
  let d, h;
  beforeEach(() => ({ d, h } = mkProject('module')));
  afterEach(() => fs.rmSync(d, { recursive: true, force: true }));

  it('hook-handler.cjs require() CRASHES before the pin (repro)', () => {
    const r = nodeRun(path.join(h, 'hook-handler.cjs'));
    expect(r.status).not.toBe(0);
    // ESM context: `module`/`require` are undefined → ReferenceError (the carousel bug).
    expect(r.stderr).toMatch(/is not defined|Cannot use import|ES Module/i);
  });

  it('pins to commonjs + relocates github-safe.js -> .mjs', () => {
    const r = pin(d);
    expect(r.out).toBe('PINNED');
    expect(JSON.parse(fs.readFileSync(path.join(h, 'package.json'), 'utf8')).type).toBe('commonjs');
    expect(fs.existsSync(path.join(h, 'github-safe.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(h, 'github-safe.js'))).toBe(false);
  });

  it('hook-handler.cjs require() WORKS after the pin (fix verified)', () => {
    pin(d);
    const r = nodeRun(path.join(h, 'hook-handler.cjs'));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/OK x/);
  });

  it('github-safe.mjs still loads as a real ES module after the pin', () => {
    pin(d);
    const r = nodeRun(path.join(h, 'github-safe.mjs'));
    expect(r.status).toBe(0); // no "Cannot use import" — it is unambiguously ESM
  });

  it('is idempotent (second run reports ALREADY, changes nothing)', () => {
    expect(pin(d).out).toBe('PINNED');
    expect(pin(d).out).toBe('ALREADY');
  });

  it('--dry-run (DRY_RUN=1) writes nothing', () => {
    const r = pin(d, { dryRun: true });
    expect(r.out).toBe('DRYRUN');
    expect(fs.existsSync(path.join(h, 'package.json'))).toBe(false);
    expect(fs.existsSync(path.join(h, 'github-safe.js'))).toBe(true);
  });
});

describe('pin_helpers_module_type: surgical (no false touches)', () => {
  it('MJS_ONLY on a commonjs-root project: relocates ESM github-safe.js, no pkg pin', () => {
    const { d, h } = mkProject('commonjs');
    expect(pin(d).out).toBe('MJS_ONLY');
    // ESM-syntax github-safe.js crashes under a CJS root too — rename is the fix.
    expect(fs.existsSync(path.join(h, 'package.json'))).toBe(false);
    expect(fs.existsSync(path.join(h, 'github-safe.js'))).toBe(false);
    expect(fs.existsSync(path.join(h, 'github-safe.mjs'))).toBe(true);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('NOT_ESM_PROJECT on a commonjs-root project with nothing to relocate', () => {
    const { d, h } = mkProject('commonjs');
    fs.rmSync(path.join(h, 'github-safe.js'));
    expect(pin(d).out).toBe('NOT_ESM_PROJECT');
    expect(fs.existsSync(path.join(h, 'package.json'))).toBe(false);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('MJS_ONLY when there is no root package.json but an ESM github-safe.js exists', () => {
    const { d, h } = mkProject(null);
    expect(pin(d).out).toBe('MJS_ONLY');
    expect(fs.existsSync(path.join(h, 'github-safe.mjs'))).toBe(true);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('NO_DIR when .claude/helpers does not exist', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-'));
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ type: 'module' }));
    expect(pin(d).out).toBe('NO_DIR');
    fs.rmSync(d, { recursive: true, force: true });
  });
});
