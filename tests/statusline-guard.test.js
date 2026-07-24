/**
 * Tests for assets/statusline-guard.cjs (STATUSLINE-GUARD-V1, Patch 68) — the
 * self-healing statusline restorer that runs as the first step of the settings
 * statusLine command on every refresh tick.
 *
 * Defect class: upstream session machinery rewrites .claude/helpers/
 * statusline.cjs with its stock free-running-counter bar via a DELAYED
 * detached child (observed twice on a fresh target, ~2-15 min after session
 * start) — so a session-start assert loses the race, but a per-tick guard
 * cannot: no clobber survives a single render cycle.
 *
 * Contract pinned here: restore bit-identical from the pristine dotfile
 * snapshot; append one evidence line per restore; never create files when
 * nothing drifted; no-op without a snapshot; ALWAYS exit 0.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const GUARD_ASSET = path.join(REPO, 'assets', 'statusline-guard.cjs');
const FIXSB = path.join(REPO, 'lib', 'fix-statusbar.sh');

const CANON_CONTENT = '#!/usr/bin/env node\nconsole.log("canonical statusline");\n';
const CLOBBER_CONTENT = '#!/usr/bin/env node\nconsole.log("upstream stock bar");\n';

function mkFixture({ canonical = true, installed = CANON_CONTENT } = {}) {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'slguard-'));
  const helpers = path.join(proj, '.claude', 'helpers');
  fs.mkdirSync(helpers, { recursive: true });
  fs.copyFileSync(GUARD_ASSET, path.join(helpers, 'statusline-guard.cjs'));
  if (canonical) fs.writeFileSync(path.join(helpers, '.statusline.canonical.cjs'), CANON_CONTENT);
  if (installed !== null) fs.writeFileSync(path.join(helpers, 'statusline.cjs'), installed);
  return { proj, helpers };
}
function runGuard(helpers) {
  return spawnSync('node', [path.join(helpers, 'statusline-guard.cjs')], { encoding: 'utf8', timeout: 10000 });
}
const readInstalled = (h) => fs.readFileSync(path.join(h, 'statusline.cjs'), 'utf8');
const logPath = (proj) => path.join(proj, '.claude-flow', 'statusline-guard.log');

describe('statusline-guard.cjs (STATUSLINE-GUARD-V1)', () => {
  test('no drift => zero writes (mtime preserved), no log, exit 0', () => {
    const { proj, helpers } = mkFixture();
    const before = fs.statSync(path.join(helpers, 'statusline.cjs')).mtimeMs;
    const r = runGuard(helpers);
    expect(r.status).toBe(0);
    expect(fs.statSync(path.join(helpers, 'statusline.cjs')).mtimeMs).toBe(before);
    expect(fs.existsSync(logPath(proj))).toBe(false);
  });

  test('clobbered => restored bit-identical + one evidence log line', () => {
    const { proj, helpers } = mkFixture({ installed: CLOBBER_CONTENT });
    const r = runGuard(helpers);
    expect(r.status).toBe(0);
    expect(readInstalled(helpers)).toBe(CANON_CONTENT);
    const log = fs.readFileSync(logPath(proj), 'utf8');
    expect(log.trim().split('\n')).toHaveLength(1);
    expect(log).toMatch(/restored canonical statusline/);
  });

  test('statusline.cjs deleted => recreated from snapshot, logged as missing', () => {
    const { proj, helpers } = mkFixture({ installed: null });
    expect(runGuard(helpers).status).toBe(0);
    expect(readInstalled(helpers)).toBe(CANON_CONTENT);
    expect(fs.readFileSync(logPath(proj), 'utf8')).toMatch(/\(missing\)/);
  });

  test('no canonical snapshot => strict no-op, exit 0', () => {
    const { proj, helpers } = mkFixture({ canonical: false, installed: CLOBBER_CONTENT });
    expect(runGuard(helpers).status).toBe(0);
    expect(readInstalled(helpers)).toBe(CLOBBER_CONTENT); // untouched — nothing to restore FROM
    expect(fs.existsSync(logPath(proj))).toBe(false);
  });

  test('repeated clobbers each get healed and each get a log line', () => {
    const { proj, helpers } = mkFixture({ installed: CLOBBER_CONTENT });
    runGuard(helpers);
    fs.writeFileSync(path.join(helpers, 'statusline.cjs'), CLOBBER_CONTENT); // clobber again
    runGuard(helpers);
    expect(readInstalled(helpers)).toBe(CANON_CONTENT);
    expect(fs.readFileSync(logPath(proj), 'utf8').trim().split('\n')).toHaveLength(2);
  });
});

describe('fix-statusbar wiring', () => {
  test('settings statusLine command runs the guard first', () => {
    const src = fs.readFileSync(FIXSB, 'utf8');
    const line = src.split('\n').find((l) => l.includes('const desired =') && l.includes('statusline-guard.cjs'));
    expect(line).toBeTruthy();
    // Guard precedes the renderer, joined with ';' so a guard failure never blocks the render.
    expect(line.indexOf('statusline-guard.cjs')).toBeLessThan(line.indexOf('helpers/statusline.cjs" 2>/dev/null ||'));
    expect(line).toMatch(/statusline-guard\.cjs" 2>\/dev\/null;/);
  });
});
