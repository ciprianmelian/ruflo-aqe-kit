/**
 * Tests for dist_defect_present + defect_gate (lib/common.sh).
 *
 * Adoption of vendor/agentic-kit's upstreamCveCounterFabricated() pattern: patch
 * only after grepping the INSTALLED dist for the literal defect, so a stopgap
 * self-retires the moment upstream ships the fix. These tests build throwaway dist
 * fixtures and assert the PRESENT/ABSENT/NO_FILE tokens, the two defect_gate log
 * messages + return codes, and that the read-only probe is inert under DRY_RUN.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const COMMON = path.resolve(__dirname, '..', 'lib', 'common.sh');

// Run a snippet with common.sh sourced. DRY_RUN is a command PREFIX (common.sh
// resets DRY_RUN=0 at source time, clobbering a process-env var) — matches the
// convention in helper-module-pinning.test.js.
function runShell(snippet, { dryRun = false, strict = false } = {}) {
  const head = strict ? 'set -uo pipefail; ' : '';
  const prefix = dryRun ? 'DRY_RUN=1 ' : '';
  const r = spawnSync('bash', ['-c', `${head}source "${COMMON}"; ${prefix}${snippet}`], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function mkFile(contents) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ddg-'));
  const f = path.join(d, 'dist-chunk.js');
  fs.writeFileSync(f, contents);
  return { d, f };
}

describe('dist_defect_present: token classification', () => {
  it('PRESENT when the literal defect pattern matches', () => {
    const { d, f } = mkFile('const totalCves = 3;\nconst fixed = scans.length;\n');
    expect(runShell(`dist_defect_present "${f}" "const totalCves = 3\\b"`).out).toBe('PRESENT');
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('ABSENT when the file exists but the pattern does not match (upstream fixed)', () => {
    const { d, f } = mkFile('const totalCves = countFindings(scans);\n');
    expect(runShell(`dist_defect_present "${f}" "const totalCves = 3\\b"`).out).toBe('ABSENT');
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('NO_FILE when the target does not exist (fail-safe: never patch the unverifiable)', () => {
    expect(runShell(`dist_defect_present "/no/such/dist/chunk.js" "anything"`).out).toBe('NO_FILE');
  });

  it('supports grep -E alternation patterns', () => {
    const { d, f } = mkFile('autoSaveInterval: 1,\n');
    expect(runShell(`dist_defect_present "${f}" "autoSaveInterval: 1,|saveModel\\(\\)"`).out).toBe('PRESENT');
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe('defect_gate: decision + logging', () => {
  it('PRESENT → return 0 and logs "defect confirmed in dist"', () => {
    const { d, f } = mkFile('const totalCves = 3;\n');
    const r = runShell(`defect_gate "${f}" "const totalCves = 3\\b" "cve-counter"; echo "rc=$?"`);
    expect(r.out).toMatch(/defect confirmed in dist/);
    expect(r.out).toMatch(/cve-counter/);
    expect(r.out).toMatch(/rc=0/);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('ABSENT → return 1 and logs "skipping (self-retired)"', () => {
    const { d, f } = mkFile('already fixed upstream\n');
    const r = runShell(`defect_gate "${f}" "const totalCves = 3\\b" "cve-counter"; echo "rc=$?"`);
    expect(r.out).toMatch(/defect not found/);
    expect(r.out).toMatch(/skipping \(self-retired\)/);
    expect(r.out).toMatch(/rc=1/);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('NO_FILE → return 1 and logs the skip message (fail-safe)', () => {
    const r = runShell(`defect_gate "/no/such/file" "x" "missing-target"; echo "rc=$?"`);
    expect(r.out).toMatch(/skipping \(self-retired\)/);
    expect(r.out).toMatch(/rc=1/);
  });

  it('label defaults to the file path when omitted', () => {
    const { d, f } = mkFile('const totalCves = 3;\n');
    const r = runShell(`defect_gate "${f}" "const totalCves = 3\\b"`);
    expect(r.out).toContain(f);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('gates a patch: `defect_gate ... && patch` no-ops once upstream is fixed', () => {
    const fixedFile = mkFile('const totalCves = countFindings(scans);\n');
    const r = runShell(`defect_gate "${fixedFile.f}" "const totalCves = 3\\b" lbl && echo PATCHED || echo SKIPPED`);
    expect(r.out).toMatch(/SKIPPED/);
    expect(r.out).not.toMatch(/PATCHED/);
    fs.rmSync(fixedFile.d, { recursive: true, force: true });
  });
});

describe('defect_gate: safety', () => {
  it('is inert under DRY_RUN (read-only probe, no mutation, same decision)', () => {
    const { d, f } = mkFile('const totalCves = 3;\n');
    const before = fs.readFileSync(f, 'utf8');
    const r = runShell(`defect_gate "${f}" "const totalCves = 3\\b" lbl; echo "rc=$?"`, { dryRun: true });
    expect(r.out).toMatch(/rc=0/); // decision unchanged by dry-run
    expect(fs.readFileSync(f, 'utf8')).toBe(before); // target untouched
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('runs clean under `set -u` (no unbound-variable crash)', () => {
    const { d, f } = mkFile('const totalCves = 3;\n');
    const r = runShell(`defect_gate "${f}" "const totalCves = 3\\b"; echo "rc=$?"`, { strict: true });
    expect(r.err).toBe('');
    expect(r.out).toMatch(/rc=0/);
    fs.rmSync(d, { recursive: true, force: true });
  });
});
