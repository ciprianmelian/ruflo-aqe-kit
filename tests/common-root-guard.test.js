/**
 * AQE-ROOT-INHERIT-GUARD-V1 (lib/common.sh kit_resolve).
 *
 * The caller's shell can carry AQE_PROJECT_ROOT pinned to a DIFFERENT project —
 * the kit repo's own .claude/settings.json exports it, so running
 * `ruflo-kit setup <fresh-target>` from a Claude session inside the kit repo
 * inherits the kit's pin. aqe honors the env var over findProjectRoot, so the
 * target's `aqe init` refused its own .agentic-qe/memory.db path and the
 * database phase died (observed on the first fresh-target e2e: learning
 * HOLLOW + store absent while every other probe passed).
 *
 * kit_resolve must therefore export AQE_PROJECT_ROOT=<target> unconditionally.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const COMMON = path.resolve(__dirname, '..', 'lib', 'common.sh');

function resolveWith(envRoot, target) {
  const r = spawnSync('bash', ['-c',
    `source "${COMMON}" 2>/dev/null; kit_resolve "${target}"; printf '%s' "$AQE_PROJECT_ROOT"`,
  ], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ...(envRoot === undefined ? {} : { AQE_PROJECT_ROOT: envRoot }) },
  });
  return r.stdout;
}

describe('kit_resolve AQE-ROOT-INHERIT-GUARD-V1', () => {
  let target;
  beforeAll(() => { target = fs.mkdtempSync(path.join(os.tmpdir(), 'rootguard-')); });
  afterAll(() => { try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('overrides an inherited AQE_PROJECT_ROOT pointing at another project', () => {
    expect(resolveWith('/some/other/project', target)).toBe(target);
  });

  it('sets AQE_PROJECT_ROOT to the target when none was inherited', () => {
    const env = { ...process.env };
    delete env.AQE_PROJECT_ROOT;
    const r = spawnSync('bash', ['-c',
      `unset AQE_PROJECT_ROOT; source "${COMMON}" 2>/dev/null; kit_resolve "${target}"; printf '%s' "$AQE_PROJECT_ROOT"`,
    ], { encoding: 'utf8', timeout: 15000, env });
    expect(r.stdout).toBe(target);
  });
});
