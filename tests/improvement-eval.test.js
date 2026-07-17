/**
 * Tests for tools/improvement-eval.cjs — the cross-session ≥2σ self-improvement
 * proof (learning gate #4 / G3). Exercises the statistics and verdict ladder
 * through the tool's --history-file analysis-only mode (fixtures injected as
 * JSONL, NO live `ruflo hooks route` invocation) plus the --selftest self-check.
 *
 * The pre-registered gate (≥2σ separation + ≥3 paired runs + flat control) is
 * asserted at its edges — per the Integrity Rule it must not silently relax.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOL = path.resolve(__dirname, '..', 'tools', 'improvement-eval.cjs');

// Analyze an injected eval-history fixture; returns parsed JSON result. Bench
// history is pinned to /dev/null so only the fixture drives the verdict, and
// --history-file forces analysis-only mode (no ruflo, no append).
function analyze(rows) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-'));
  const f = path.join(d, 'eval-history.jsonl');
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(Object.assign({ scorerVersion: 'eval-v1' }, r))).join('\n') + '\n');
  const r = spawnSync(process.execPath, [TOOL, '--history-file', f, '--bench-history', '/dev/null', '--json'], { encoding: 'utf8' });
  fs.rmSync(d, { recursive: true, force: true });
  if (!r.stdout) throw new Error('no stdout; stderr=' + r.stderr);
  return { result: JSON.parse(r.stdout), code: r.status };
}
const pair = (t, c) => ({ treatmentAcc: t, controlAcc: c });

describe('improvement-eval: statistics', () => {
  it('permutation p is the exact 1/C(6,3)=0.05 for [1,1,1] vs [0,0,0]', () => {
    const { result } = analyze([pair(1, 0), pair(1, 0), pair(1, 0)]);
    expect(result.permP).toBe(0.05);
  });

  it("Cohen's d is exact (μΔ=0.2 / pooled sd=0.1 → d=2.0)", () => {
    const { result } = analyze([pair(0.6, 0.4), pair(0.7, 0.5), pair(0.8, 0.6)]);
    expect(result.cohensD).toBe(2);
  });

  it('reports the pre-registered gate constants (2σ, 3 runs)', () => {
    const { result } = analyze([pair(0.7, 0.5), pair(0.72, 0.5), pair(0.74, 0.5)]);
    expect(result.sigmaMin).toBe(2);
    expect(result.minRuns).toBe(3);
  });

  it('does NOT invoke ruflo in analysis-only mode (session is null)', () => {
    const { result } = analyze([pair(0.7, 0.5), pair(0.72, 0.5), pair(0.74, 0.5)]);
    expect(result.session).toBeNull();
  });
});

describe('improvement-eval: verdict ladder edges', () => {
  it('IMPROVING — ≥3 runs, ≥2σ separation, flat control', () => {
    const { result, code } = analyze([pair(0.70, 0.5), pair(0.72, 0.5), pair(0.74, 0.5)]);
    expect(result.verdict).toBe('IMPROVING');
    expect(result.sigma).toBeGreaterThanOrEqual(2);
    expect(result.controlFlat).toBe(true);
    expect(code).toBe(0); // IMPROVING is the only zero-exit verdict
  });

  it('NOT-IMPROVING — trained arm at/below control', () => {
    const { result, code } = analyze([pair(0.5, 0.6), pair(0.5, 0.6), pair(0.5, 0.6)]);
    expect(result.verdict).toBe('NOT-IMPROVING');
    expect(result.deltaPP).toBeLessThanOrEqual(0);
    expect(code).toBe(1);
  });

  it('UNPROVEN — fewer than 3 paired runs (gate is hard on run count)', () => {
    const { result } = analyze([pair(0.7, 0.5), pair(0.74, 0.5)]);
    expect(result.verdict).toBe('UNPROVEN');
    expect(result.n).toBe(2);
  });

  it('UNPROVEN — positive delta but below 2σ', () => {
    const { result } = analyze([pair(0.6, 0.5), pair(0.4, 0.5), pair(0.6, 0.5)]);
    expect(result.verdict).toBe('UNPROVEN');
    expect(result.deltaPP).toBeGreaterThan(0);
    expect(result.sigma).toBeLessThan(2);
  });

  it('UNPROVEN — strong separation but control arm NOT flat (drift unattributable)', () => {
    const { result } = analyze([pair(0.70, 0.4), pair(0.72, 0.5), pair(0.74, 0.6)]);
    expect(result.verdict).toBe('UNPROVEN');
    expect(result.controlFlat).toBe(false);
  });

  it('a 2σ separation cannot pass on only 2 runs (gate does not relax below MIN_RUNS)', () => {
    const { result } = analyze([pair(0.9, 0.5), pair(0.92, 0.5)]);
    expect(result.verdict).toBe('UNPROVEN');
  });
});

describe('improvement-eval: history hygiene', () => {
  it('ignores rows written under a different scorerVersion', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-'));
    const f = path.join(d, 'eval-history.jsonl');
    fs.writeFileSync(f, [
      JSON.stringify({ scorerVersion: 'old-v0', treatmentAcc: 0.9, controlAcc: 0.1 }),
      JSON.stringify({ scorerVersion: 'eval-v1', treatmentAcc: 0.7, controlAcc: 0.5 }),
      JSON.stringify({ scorerVersion: 'eval-v1', treatmentAcc: 0.72, controlAcc: 0.5 }),
    ].join('\n') + '\n');
    const r = spawnSync(process.execPath, [TOOL, '--history-file', f, '--bench-history', '/dev/null', '--json'], { encoding: 'utf8' });
    fs.rmSync(d, { recursive: true, force: true });
    const result = JSON.parse(r.stdout);
    expect(result.n).toBe(2); // the old-v0 row is excluded from the paired arms
  });

  it('tolerates blank and malformed lines without throwing', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-'));
    const f = path.join(d, 'eval-history.jsonl');
    fs.writeFileSync(f, '\n{ not json }\n' + JSON.stringify({ scorerVersion: 'eval-v1', treatmentAcc: 0.7, controlAcc: 0.5 }) + '\n\n');
    const r = spawnSync(process.execPath, [TOOL, '--history-file', f, '--bench-history', '/dev/null', '--json'], { encoding: 'utf8' });
    fs.rmSync(d, { recursive: true, force: true });
    expect(r.status).not.toBeNull();
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });
});

describe('improvement-eval: --selftest', () => {
  it('exits 0 with all stats self-checks passing', () => {
    const r = spawnSync(process.execPath, [TOOL, '--selftest'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/selftest OK/);
    expect(r.stdout).not.toMatch(/✗/);
  });
});
