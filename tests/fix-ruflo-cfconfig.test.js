/**
 * Tests for fix-ruflo's CF-CONFIG-AUTOSTART-OFF-V1 sentinel.
 *
 * The sentinel idempotently merges {"daemon":{"autostart":false}} into the
 * TARGET's claude-flow.config.json (create if absent; preserve other keys), the
 * upstream-honored project opt-out for the daemon that ruflo >=3.32 auto-spawns
 * on every CLI call (services/daemon-autostart.js). This is the THIRD daemon
 * resurrection channel the audit found (statusline pin + AQE config were the
 * first two).
 *
 * fix-ruflo.sh is not sourceable standalone and its Step 1 auto-UPGRADES the
 * global toolchain, so these tests NEVER run it without --dry-run. --dry-run is
 * read-only by contract (every mutation is DRY_RUN-guarded), which lets us prove
 * two things honestly and cheaply:
 *   - the sentinel ANNOUNCES itself in the dry-run plan (integration signal), and
 *   - the dry-run touches NOTHING — an existing config is byte-identical after,
 *     and an absent config is not created.
 *
 * A full fix-ruflo --dry-run walks the real global toolchain read-only (~10-30s
 * depending on load and npm-registry latency) and proved flaky when THREE such
 * runs raced the rest of the suite (observed: a parallel-run pass produced
 * truncated output missing the 8b step while passing in isolation). So the
 * suite performs ONE shared dry-run per fixture shape in beforeAll and asserts
 * against the captured output/filesystem — same coverage, one-third the cost,
 * no contention window.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIX_RUFLO = path.resolve(__dirname, '..', 'lib', 'fix-ruflo.sh');

function mkTarget({ config } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfcfg-target-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  if (config !== undefined) {
    fs.writeFileSync(path.join(dir, 'claude-flow.config.json'), config);
  }
  return dir;
}

function dryRun(target) {
  const r = spawnSync('bash', [FIX_RUFLO, target, '--dry-run'], {
    encoding: 'utf8',
    timeout: 120000,
  });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

describe('fix-ruflo CF-CONFIG-AUTOSTART-OFF-V1 (--dry-run only)', () => {
  const ORIGINAL = JSON.stringify({ other: 1, keep: ['a', 'b'] }, null, 2) + '\n';
  let withConfig, withConfigOut, withoutConfig, withoutConfigOut;

  beforeAll(() => {
    withConfig = mkTarget({ config: ORIGINAL });
    withConfigOut = dryRun(withConfig);
    withoutConfig = mkTarget(); // no config file
    withoutConfigOut = dryRun(withoutConfig);
  }, 300000);

  afterAll(() => {
    for (const d of [withConfig, withoutConfig]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('announces the CF-CONFIG daemon-autostart opt-out in the dry-run plan', () => {
    // The sentinel names itself (CF-CONFIG-AUTOSTART-OFF-V1) and/or describes the
    // merge into claude-flow.config.json. Accept either provenance form.
    const mentioned = /CF-CONFIG/i.test(withConfigOut) ||
      (/claude-flow\.config\.json/i.test(withConfigOut) && /autostart/i.test(withConfigOut));
    expect(mentioned).toBe(true);
  });

  it('announces creation when the config file is absent', () => {
    const mentioned = /CF-CONFIG/i.test(withoutConfigOut) ||
      (/claude-flow\.config\.json/i.test(withoutConfigOut) && /autostart/i.test(withoutConfigOut));
    expect(mentioned).toBe(true);
  });

  it('does NOT modify an existing claude-flow.config.json in dry-run (byte-identical)', () => {
    const cfg = path.join(withConfig, 'claude-flow.config.json');
    expect(fs.readFileSync(cfg, 'utf8')).toBe(ORIGINAL);
  });

  it('does NOT create claude-flow.config.json in dry-run when it is absent', () => {
    expect(fs.existsSync(path.join(withoutConfig, 'claude-flow.config.json'))).toBe(false);
  });
});
