/**
 * Tests for fix-ruflo's DEAD-REMAP-CLASSIFICATION-V1 sentinel (Step 5l).
 *
 * Step 5l applies the double-Fable-audited DELETE/REMAP classification to
 * commands/{automation,github,analysis,optimization,monitoring}/ and surfaces
 * every FLAGged (genuinely disputed) file in a generated report instead of
 * guessing — see docs/_INSTRUCTIONS.md Patch 78.
 *
 * fix-ruflo.sh is not sourceable standalone and its Step 1 auto-UPGRADES the
 * global toolchain, so these tests NEVER run it without --dry-run (same
 * constraint documented in tests/fix-ruflo-cfconfig.test.js). --dry-run is
 * read-only by contract (every mutation is DRY_RUN-guarded), which lets us
 * prove two things honestly and cheaply:
 *   - the sentinel ANNOUNCES itself in the dry-run plan (integration signal), and
 *   - the dry-run touches NOTHING — a fixture target's files (present or
 *     absent) are byte-identical afterward.
 *
 * One shared dry-run per fixture shape in beforeAll (see cfconfig test's
 * rationale for why: three overlapping full-script dry-runs raced and one
 * produced truncated output under contention — one dry-run per shape avoids
 * the window entirely).
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIX_RUFLO = path.resolve(__dirname, '..', 'lib', 'fix-ruflo.sh');

function mkPlainTarget() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-plain-target-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

function mkPopulatedTarget() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-full-target-'));
  const cmdRoot = path.join(dir, '.claude', 'commands');
  for (const sub of ['automation', 'github', 'analysis', 'optimization', 'monitoring']) {
    fs.mkdirSync(path.join(cmdRoot, sub), { recursive: true });
  }
  // One DELETE-set file.
  fs.writeFileSync(path.join(cmdRoot, 'automation', 'README.md'), 'legacy automation index\n');
  // One REMAP-set file with a verified legacy invocation.
  fs.writeFileSync(
    path.join(cmdRoot, 'automation', 'session-memory.md'),
    'Run: npx claude-flow hook session-restore --session-id abc123\n'
  );
  // One FLAG-set file (genuine auditor disagreement) — must stay untouched.
  fs.writeFileSync(path.join(cmdRoot, 'automation', 'auto-agent.md'), 'flagged content\n');
  return dir;
}

function snapshot(dir) {
  const out = {};
  const cmdRoot = path.join(dir, '.claude', 'commands');
  if (!fs.existsSync(cmdRoot)) return out;
  for (const sub of fs.readdirSync(cmdRoot)) {
    const subDir = path.join(cmdRoot, sub);
    if (!fs.statSync(subDir).isDirectory()) continue;
    for (const f of fs.readdirSync(subDir)) {
      out[path.join(sub, f)] = fs.readFileSync(path.join(subDir, f), 'utf8');
    }
  }
  return out;
}

function dryRun(target) {
  const r = spawnSync('bash', [FIX_RUFLO, target, '--dry-run'], {
    encoding: 'utf8',
    timeout: 120000,
  });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

describe('fix-ruflo DEAD-REMAP-CLASSIFICATION-V1 (--dry-run only)', () => {
  let plainTarget, plainOut, plainBefore;
  let fullTarget, fullOut, fullBefore;

  beforeAll(() => {
    plainTarget = mkPlainTarget();
    plainBefore = snapshot(plainTarget);
    plainOut = dryRun(plainTarget);

    fullTarget = mkPopulatedTarget();
    fullBefore = snapshot(fullTarget);
    fullOut = dryRun(fullTarget);
  }, 300000);

  afterAll(() => {
    for (const d of [plainTarget, fullTarget]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('announces the DEAD-REMAP-CLASSIFICATION-V1 step in the dry-run plan for a fresh target', () => {
    expect(/DEAD-REMAP-CLASSIFICATION-V1/.test(plainOut)).toBe(true);
    expect(/5l\/11/.test(plainOut)).toBe(true);
  });

  it('does NOT modify a fresh target directory in dry-run (no commands/ tree created)', () => {
    expect(snapshot(plainTarget)).toEqual(plainBefore);
  });

  it('announces the DEAD-REMAP-CLASSIFICATION-V1 step for a target carrying real classification hits', () => {
    expect(/DEAD-REMAP-CLASSIFICATION-V1/.test(fullOut)).toBe(true);
  });

  it('announces the DELETE and REMAP actions it would take, by name, without performing them', () => {
    expect(/Would: delete confirmed-dead command doc commands\/automation\/README\.md/.test(fullOut)).toBe(true);
    expect(/Would: remap verified legacy invocation.*commands\/automation\/session-memory\.md/.test(fullOut)).toBe(true);
  });

  it('does NOT delete, remap, or otherwise touch any file in a populated target (byte-identical)', () => {
    expect(snapshot(fullTarget)).toEqual(fullBefore);
  });

  it('does NOT write the classification report in dry-run', () => {
    expect(fs.existsSync(path.join(fullTarget, '.claude', 'DEAD-REMAP-CLASSIFICATION-REPORT.md'))).toBe(false);
  });
});
