/**
 * Tests for fix-ruflo's PLUGIN-VENDOR-V1 sentinel (Step 5n).
 *
 * Step 5n is Step 5m's (PLUGIN-NS-ADVISORY-V1) advisory turned into ACTION,
 * strictly opt-in via --vendor-plugins (off by default): it vendors a
 * namespace-corrected copy of an enabled marketplace plugin's
 * skills/commands/agents into the target's own .claude/, rewriting only
 * VERIFIED mcp__claude-flow__* substitutions and flagging everything else —
 * see docs/_INSTRUCTIONS.md Patch 80.
 *
 * fix-ruflo.sh is not sourceable standalone and its Step 1 auto-UPGRADES the
 * global toolchain, so these tests NEVER run it without --dry-run (same
 * constraint documented in tests/fix-ruflo-cfconfig.test.js and
 * tests/fix-ruflo-plugin-namespace-remap.test.js). --dry-run is read-only by
 * contract (every mutation in Step 5n is DRY_RUN-guarded, including the
 * tools/plugin-vendor.cjs worker it shells out to), which lets us prove:
 *   - without --vendor-plugins, the step announces the opt-out and does
 *     nothing else (not even a plugin scan);
 *   - with --vendor-plugins, the step announces itself and per-plugin
 *     "[dry-run] Would: ..." lines, while STILL touching nothing — neither
 *     the project target nor the fixture "marketplace cache" (pointed to via
 *     HOME, proving the implementation resolves ~ from $HOME, not a
 *     hardcoded path) is modified.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIX_RUFLO = path.resolve(__dirname, '..', 'lib', 'fix-ruflo.sh');

function mkPlainTarget() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-plain-target-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

// A target with an enabled marketplace plugin + a fixture $HOME carrying a
// fake installed plugin whose skill content calls the dead mcp__plugin_*__
// prefix — the shape Step 5n is meant to vendor.
function mkPluginFixture() {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-target-'));
  fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(target, '.claude', 'settings.local.json'),
    JSON.stringify({ enabledPlugins: { 'ruflo-sparc@ruflo-marketplace': true } }, null, 2) + '\n'
  );

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-fakehome-'));
  const pluginRoot = path.join(
    fakeHome, '.claude', 'plugins', 'marketplaces', 'ruflo-marketplace', 'plugins', 'ruflo-sparc'
  );
  const skillDir = path.join(pluginRoot, 'skills', 'sparc-init');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'ruflo-sparc', version: '0.2.1' }, null, 2) + '\n'
  );
  const skillFile = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(
    skillFile,
    'Call mcp__plugin_ruflo-sparc_ruflo__memory_store to persist.\n' +
    'Call mcp__plugin_ruflo-sparc_ruflo__sparc_mode to switch (dead).\n'
  );

  return { target, fakeHome, skillFile, pluginRoot };
}

function snapshotTree(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else out[p] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

function run(target, extraArgs, homeOverride) {
  const env = homeOverride ? { ...process.env, HOME: homeOverride } : process.env;
  const r = spawnSync('bash', [FIX_RUFLO, target, ...extraArgs], {
    encoding: 'utf8',
    timeout: 120000,
    env,
  });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

describe('fix-ruflo PLUGIN-VENDOR-V1 (--dry-run only)', () => {
  let plainTarget, plainOut, plainBefore;
  let fixture, fixtureOut, targetBefore, marketplaceBefore;

  beforeAll(() => {
    plainTarget = mkPlainTarget();
    plainBefore = snapshotTree(plainTarget);
    plainOut = run(plainTarget, ['--dry-run']);

    fixture = mkPluginFixture();
    targetBefore = snapshotTree(fixture.target);
    marketplaceBefore = snapshotTree(fixture.pluginRoot);
    fixtureOut = run(fixture.target, ['--vendor-plugins', '--dry-run'], fixture.fakeHome);
  }, 300000);

  afterAll(() => {
    for (const d of [plainTarget, fixture && fixture.target, fixture && fixture.fakeHome]) {
      if (!d) continue;
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('announces the opt-out when --vendor-plugins is not passed', () => {
    expect(/PLUGIN-VENDOR-V1/.test(plainOut)).toBe(true);
    expect(/5n\/11/.test(plainOut)).toBe(true);
    expect(/not requested/.test(plainOut)).toBe(true);
  });

  it('leaves a plain target byte-identical when --vendor-plugins is not passed', () => {
    expect(snapshotTree(plainTarget)).toEqual(plainBefore);
  });

  it('announces the PLUGIN-VENDOR-V1 step when --vendor-plugins IS passed', () => {
    expect(/PLUGIN-VENDOR-V1/.test(fixtureOut)).toBe(true);
    expect(/5n\/11/.test(fixtureOut)).toBe(true);
  });

  it('announces per-plugin dry-run intent for a fixture plugin needing vendoring', () => {
    expect(/\[dry-run\] Would: vendor \d+ file\(s\) from ruflo-sparc@ruflo-marketplace/.test(fixtureOut)).toBe(true);
    expect(/\[dry-run\] Would: write \.claude\/skills\/sparc-init\/SKILL\.md/.test(fixtureOut)).toBe(true);
  });

  it('does NOT modify the target in dry-run, even with --vendor-plugins', () => {
    expect(snapshotTree(fixture.target)).toEqual(targetBefore);
  });

  it('does NOT modify the fixture marketplace cache in dry-run (resolves ~ from $HOME, never writes there)', () => {
    expect(snapshotTree(fixture.pluginRoot)).toEqual(marketplaceBefore);
  });

  it('does NOT create the vendor manifest or report in dry-run', () => {
    expect(fs.existsSync(path.join(fixture.target, '.claude', '.plugin-vendor-manifest.json'))).toBe(false);
    expect(fs.existsSync(path.join(fixture.target, '.claude', 'PLUGIN-VENDOR-REPORT.md'))).toBe(false);
  });

  it('does NOT seed the drift-sentinel helper in dry-run', () => {
    expect(fs.existsSync(path.join(fixture.target, '.claude', 'helpers', 'plugin-vendor-drift-sentinel.cjs'))).toBe(false);
  });
});

// Patch 81 (B): previously-vendored plugins stay refreshable even when their
// enablement is false — the step's own report recommends disabling the
// originals after vendoring, so refresh-on-drift must not require re-enabling
// them. Tested against the worker directly (node tools/plugin-vendor.cjs) —
// no fix-ruflo run needed, the union logic lives entirely in the worker.
describe('plugin-vendor.cjs manifest-refresh (disabled plugin, --dry-run only)', () => {
  const WORKER = path.resolve(__dirname, '..', 'tools', 'plugin-vendor.cjs');
  let fixture, out;

  beforeAll(() => {
    fixture = mkPluginFixture();
    // Flip the plugin to DISABLED (the post-vendor recommended state) …
    fs.writeFileSync(
      path.join(fixture.target, '.claude', 'settings.local.json'),
      JSON.stringify({ enabledPlugins: { 'ruflo-sparc@ruflo-marketplace': false } }, null, 2) + '\n'
    );
    // … but record it as previously vendored, at a STALE version+sha so the
    // idempotency check cannot short-circuit the refresh.
    fs.writeFileSync(
      path.join(fixture.target, '.claude', '.plugin-vendor-manifest.json'),
      JSON.stringify({
        'ruflo-sparc@ruflo-marketplace': {
          version: '0.0.0-stale', marketplaceSha: 'stale', vendoredAt: '2020-01-01T00:00:00Z',
          files: [], rewritten: 0, flagged: [],
        },
      }, null, 2) + '\n'
    );
    const r = require('child_process').spawnSync(
      'node', [WORKER, fixture.target, '--dry-run'],
      { encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: fixture.fakeHome } }
    );
    out = `${r.stdout || ''}${r.stderr || ''}`;
  }, 120000);

  afterAll(() => {
    for (const d of [fixture && fixture.target, fixture && fixture.fakeHome]) {
      if (!d) continue;
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('still announces vendoring intent for a manifest-listed plugin whose enablement is false', () => {
    expect(/Would: vendor \d+ file\(s\) from ruflo-sparc@ruflo-marketplace/.test(out)).toBe(true);
  });

  it('does not write anything in dry-run (manifest byte-identical, no vendored files)', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(fixture.target, '.claude', '.plugin-vendor-manifest.json'), 'utf8')
    );
    expect(manifest['ruflo-sparc@ruflo-marketplace'].version).toBe('0.0.0-stale');
    expect(fs.existsSync(path.join(fixture.target, '.claude', 'skills', 'sparc-init', 'SKILL.md'))).toBe(false);
  });
});

// Patch 81 (A): a scaffolded agent that collides BY NAME with a vendored
// plugin agent shadows it — the curated supersedence table retires the
// scaffolded copy (rename, recoverable). Dry-run announces without touching.
describe('fix-ruflo Step 5n scaffold-supersedence sweep (--dry-run only)', () => {
  let target, fakeHome, out;
  const MARKER = 'PLUGIN-VENDOR-V1';

  beforeAll(() => {
    target = mkPlainTarget();
    // Vendored agent (carries the provenance marker) + colliding scaffolded one.
    fs.mkdirSync(path.join(target, '.claude', 'agents', 'v3'), { recursive: true });
    fs.writeFileSync(
      path.join(target, '.claude', 'agents', 'adr-architect.md'),
      `---\nname: adr-architect\n---\n<!-- ${MARKER}: vendored from ruflo-adr@x v0 (marketplace sha 0) on 2020-01-01 by test -->\nbody\n`
    );
    fs.writeFileSync(
      path.join(target, '.claude', 'agents', 'v3', 'adr-architect.md'),
      '---\nname: adr-architect\n---\nold scaffolded agent with dead memory_usage refs\n'
    );
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-supersede-home-'));
    out = run(target, ['--vendor-plugins', '--dry-run'], fakeHome);
  }, 300000);

  afterAll(() => {
    for (const d of [target, fakeHome]) {
      if (!d) continue;
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('announces the retirement of the colliding scaffolded agent in dry-run', () => {
    expect(/Would: retire scaffolded \.claude\/agents\/v3\/adr-architect\.md/.test(out)).toBe(true);
  });

  it('touches neither file in dry-run', () => {
    expect(fs.existsSync(path.join(target, '.claude', 'agents', 'v3', 'adr-architect.md'))).toBe(true);
    expect(fs.existsSync(path.join(target, '.claude', 'agents', 'adr-architect.md'))).toBe(true);
    expect(fs.existsSync(path.join(target, '.claude', 'agents', 'v3', 'adr-architect.md.superseded-by-ruflo-adr-vendored'))).toBe(false);
  });
});
