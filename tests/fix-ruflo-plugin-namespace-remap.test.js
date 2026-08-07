/**
 * Tests for fix-ruflo's PLUGIN-NS-ADVISORY-V1 sentinel (Step 5m).
 *
 * Step 5m detects marketplace-plugin content calling MCP tools under the dead
 * mcp__plugin_<plugin>_<server>__* namespace and writes an advisory report
 * suggesting mcp__claude-flow__* substitutions — it never writes to the
 * host-global ~/.claude/plugins/marketplaces/ cache and never rewrites
 * project files itself (that's Step 5l's job for the unrelated dead/remap
 * command corpus) — see docs/_INSTRUCTIONS.md Patch 79.
 *
 * fix-ruflo.sh is not sourceable standalone and its Step 1 auto-UPGRADES the
 * global toolchain, so these tests NEVER run it without --dry-run (same
 * constraint documented in tests/fix-ruflo-cfconfig.test.js). --dry-run is
 * read-only by contract, which lets us prove two things honestly and cheaply:
 *   - the sentinel ANNOUNCES itself in the dry-run plan (integration signal), and
 *   - the dry-run touches NOTHING — neither the project target nor a fixture
 *     "marketplace cache" (pointed to via HOME) is modified.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIX_RUFLO = path.resolve(__dirname, '..', 'lib', 'fix-ruflo.sh');

function mkPlainTarget() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pns-plain-target-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

// A target with an enabled marketplace plugin + a fixture $HOME carrying a
// fake installed plugin whose skill content calls the dead mcp__plugin_*__
// prefix — the shape Step 5m is meant to detect.
function mkPluginFixture() {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'pns-target-'));
  fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(target, '.claude', 'settings.local.json'),
    JSON.stringify({ enabledPlugins: { 'ruflo-sparc@ruflo-marketplace': true } }, null, 2) + '\n'
  );

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pns-fakehome-'));
  const pluginDir = path.join(
    fakeHome, '.claude', 'plugins', 'marketplaces', 'ruflo-marketplace', 'plugins', 'ruflo-sparc', 'skills'
  );
  fs.mkdirSync(pluginDir, { recursive: true });
  const skillFile = path.join(pluginDir, 'example.md');
  fs.writeFileSync(
    skillFile,
    'Call mcp__plugin_ruflo-sparc_ruflo__memory_store to persist.\n' +
    'Call mcp__plugin_ruflo-sparc_ruflo__agent_spawn to start.\n'
  );

  return { target, fakeHome, skillFile };
}

function snapshotFile(f) {
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}

function dryRun(target, homeOverride) {
  const env = homeOverride ? { ...process.env, HOME: homeOverride } : process.env;
  const r = spawnSync('bash', [FIX_RUFLO, target, '--dry-run'], {
    encoding: 'utf8',
    timeout: 120000,
    env,
  });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

describe('fix-ruflo PLUGIN-NS-ADVISORY-V1 (--dry-run only)', () => {
  let plainTarget, plainOut;
  let fixture, fixtureOut, skillBefore;

  beforeAll(() => {
    plainTarget = mkPlainTarget();
    plainOut = dryRun(plainTarget);

    fixture = mkPluginFixture();
    skillBefore = snapshotFile(fixture.skillFile);
    fixtureOut = dryRun(fixture.target, fixture.fakeHome);
  }, 300000);

  afterAll(() => {
    for (const d of [plainTarget, fixture && fixture.target, fixture && fixture.fakeHome]) {
      if (!d) continue;
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('announces the PLUGIN-NS-ADVISORY-V1 step in the dry-run plan for a target with no plugins enabled', () => {
    expect(/PLUGIN-NS-ADVISORY-V1/.test(plainOut)).toBe(true);
    expect(/5m\/11/.test(plainOut)).toBe(true);
  });

  it('does NOT create a plugin-namespace report for a target with no enabled plugins', () => {
    expect(fs.existsSync(path.join(plainTarget, '.claude', 'commands', 'plugin-namespace-report.md'))).toBe(false);
  });

  it('announces the PLUGIN-NS-ADVISORY-V1 step for a target with an enabled plugin carrying the dead namespace', () => {
    expect(/PLUGIN-NS-ADVISORY-V1/.test(fixtureOut)).toBe(true);
  });

  it('announces it would write the advisory report without creating it in dry-run', () => {
    expect(/Would: write plugin-namespace advisory report/.test(fixtureOut)).toBe(true);
    expect(fs.existsSync(path.join(fixture.target, '.claude', 'commands', 'plugin-namespace-report.md'))).toBe(false);
  });

  it('does NOT modify the host-global marketplace plugin cache in dry-run (byte-identical)', () => {
    expect(snapshotFile(fixture.skillFile)).toBe(skillBefore);
  });
});
