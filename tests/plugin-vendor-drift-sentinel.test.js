/**
 * Tests for assets/plugin-vendor-drift-sentinel.cjs — the SessionStart hook
 * fix-ruflo Step 5n (--vendor-plugins) seeds into a target's
 * .claude/helpers/. See docs/_INSTRUCTIONS.md Patch 80.
 *
 * Tested directly against the canonical tracked asset (same precedent as the
 * statusline suites testing assets/statusline.cjs rather than an
 * installed/copied target instance — see tests/statusline.test.js's header
 * comment for why: the canonical file is ground truth, an installed copy can
 * drift or get clobbered).
 *
 * The sentinel's whole contract is "never break a session": no manifest, no
 * git, no marketplace, or a malformed manifest must all be silent + exit 0.
 * Only a genuine version/sha mismatch between the manifest and the live
 * marketplace clone may print — exactly one line per drifted plugin.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SENTINEL = path.resolve(__dirname, '..', 'assets', 'plugin-vendor-drift-sentinel.cjs');

function mkProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvds-project-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

function writeManifest(projectDir, manifestObj) {
  fs.writeFileSync(
    path.join(projectDir, '.claude', '.plugin-vendor-manifest.json'),
    typeof manifestObj === 'string' ? manifestObj : JSON.stringify(manifestObj, null, 2) + '\n'
  );
}

// Builds a fixture $HOME with a tiny real git repo standing in for a
// marketplace clone, one plugin with a plugin.json version, returns the sha.
function mkMarketplace(home, marketplace, plugin, version) {
  const pluginDir = path.join(home, '.claude', 'plugins', 'marketplaces', marketplace, 'plugins', plugin);
  fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: plugin, version }, null, 2) + '\n'
  );
  const repoDir = path.join(home, '.claude', 'plugins', 'marketplaces', marketplace);
  const g = (args) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
  g(['init', '-q']);
  g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A']);
  g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  const sha = g(['rev-parse', 'HEAD']).stdout.trim();
  return { pluginDir, repoDir, sha };
}

function touchAndCommit(repoDir, pluginDir) {
  fs.writeFileSync(path.join(pluginDir, 'drift-marker.txt'), String(Date.now()));
  const g = (args) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
  g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A']);
  g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'drift']);
  return g(['rev-parse', 'HEAD']).stdout.trim();
}

function runSentinel(projectDir, home) {
  const r = spawnSync('node', [SENTINEL], {
    cwd: projectDir,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, HOME: home || process.env.HOME },
  });
  return r;
}

describe('plugin-vendor-drift-sentinel.cjs', () => {
  let cleanupDirs = [];

  afterEach(() => {
    for (const d of cleanupDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    cleanupDirs = [];
  });

  it('is silent and exits 0 when no manifest exists', () => {
    const project = mkProject();
    cleanupDirs.push(project);

    const r = runSentinel(project, os.tmpdir()); // no .claude/plugins under this "home"
    expect(r.status).toBe(0);
    expect((r.stdout || '').trim()).toBe('');
  });

  it('is silent and exits 0 when manifest version+sha match the live marketplace', () => {
    const project = mkProject();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pvds-home-'));
    cleanupDirs.push(project, home);

    const { sha } = mkMarketplace(home, 'mkt', 'p1', '1.0.0');
    writeManifest(project, { 'p1@mkt': { version: '1.0.0', marketplaceSha: sha, files: [] } });

    const r = runSentinel(project, home);
    expect(r.status).toBe(0);
    expect((r.stdout || '').trim()).toBe('');
  });

  it('prints exactly one drift line naming the plugin when the marketplace sha has moved', () => {
    const project = mkProject();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pvds-home-'));
    cleanupDirs.push(project, home);

    const { pluginDir, repoDir, sha } = mkMarketplace(home, 'mkt', 'p1', '1.0.0');
    writeManifest(project, { 'p1@mkt': { version: '1.0.0', marketplaceSha: sha, files: [] } });
    const newSha = touchAndCommit(repoDir, pluginDir);
    expect(newSha).not.toBe(sha);

    const r = runSentinel(project, home);
    expect(r.status).toBe(0);
    const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^PLUGIN-VENDOR drift: p1 /);
    expect(lines[0]).toContain('bin/ruflo-kit fix-ruflo');
    expect(lines[0]).toContain('--vendor-plugins');
  });

  it('is silent and exits 0 when the marketplace directory is missing entirely', () => {
    const project = mkProject();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pvds-home-'));
    cleanupDirs.push(project, home);

    // Manifest references a marketplace that was never cloned on this host.
    writeManifest(project, { 'p1@ghost-mkt': { version: '1.0.0', marketplaceSha: 'deadbeef', files: [] } });

    const r = runSentinel(project, home);
    expect(r.status).toBe(0);
    expect((r.stdout || '').trim()).toBe('');
  });

  it('is silent and exits 0 when the manifest JSON is malformed', () => {
    const project = mkProject();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pvds-home-'));
    cleanupDirs.push(project, home);

    writeManifest(project, '{ this is not valid json');

    const r = runSentinel(project, home);
    expect(r.status).toBe(0);
    expect((r.stdout || '').trim()).toBe('');
  });
});
