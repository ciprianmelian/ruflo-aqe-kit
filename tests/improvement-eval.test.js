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

// Requiring the tool returns its pure helpers WITHOUT running main (no ruflo spawn).
const evalMod = require(TOOL);

// A live policy-store tree with one learned artifact; returns its root dir.
function makeLiveStore(dir, outcomes) {
  fs.mkdirSync(path.join(dir, '.claude-flow'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-flow', 'routing-outcomes.json'), JSON.stringify({ outcomes }));
  return dir;
}

describe('improvement-eval: frozen baseline (counterfactual store)', () => {
  it('freezeBaseline writes a manifest with a content-addressed baselineId + source sha256s', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-b-'));
    try {
      const live = makeLiveStore(path.join(tmp, 'live'), [{ agent: 'coder', quality: 0.9 }]);
      const base = path.join(tmp, 'base');
      const m = evalMod.freezeBaseline(live, base, { stack: { ruflo: '3.32.7' } });
      expect(m.baselineId).toMatch(/^[0-9a-f]{64}$/);
      expect(m.sources['.claude-flow/routing-outcomes.json']).toMatch(/^[0-9a-f]{64}$/);
      expect(m.stack.ruflo).toBe('3.32.7');
      expect(JSON.parse(fs.readFileSync(evalMod.manifestPath(base), 'utf8')).baselineId).toBe(m.baselineId);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it('is idempotent for identical content — same baselineId across re-freezes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-b-'));
    try {
      const live = makeLiveStore(path.join(tmp, 'live'), [{ agent: 'coder', quality: 0.9 }]);
      const base = path.join(tmp, 'base');
      const id1 = evalMod.freezeBaseline(live, base, {}).baselineId;
      const id2 = evalMod.freezeBaseline(live, base, {}).baselineId; // re-freeze, unchanged live
      expect(id2).toBe(id1);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it('a re-freeze after the live policy changes yields a DIFFERENT baselineId (rebaseline resets the series)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-b-'));
    try {
      const live = path.join(tmp, 'live'), base = path.join(tmp, 'base');
      makeLiveStore(live, [{ agent: 'coder', quality: 0.9 }]);
      const id1 = evalMod.freezeBaseline(live, base, {}).baselineId;
      makeLiveStore(live, [{ agent: 'tester', quality: 0.1 }]); // policy trained forward
      const id2 = evalMod.freezeBaseline(live, base, {}).baselineId;
      expect(id2).not.toBe(id1);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it('the control arm reads EXACTLY the frozen store — its snapshot hash === baselineId', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-b-'));
    try {
      const live = makeLiveStore(path.join(tmp, 'live'), [{ agent: 'coder', quality: 0.9 }]);
      const base = path.join(tmp, 'base'), ctrl = path.join(tmp, 'ctrl');
      const m = evalMod.freezeBaseline(live, base, {});
      evalMod.snapshotState(base, ctrl); // control sandbox = fresh copy of the frozen baseline
      expect(evalMod.hashState(ctrl).hash).toBe(m.baselineId);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it('treatment vs control read DIFFERENT state once the live policy diverges from the baseline', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-b-'));
    try {
      const live = path.join(tmp, 'live'), base = path.join(tmp, 'base');
      makeLiveStore(live, [{ agent: 'coder', quality: 0.9 }]);
      evalMod.freezeBaseline(live, base, {});              // control frozen here
      makeLiveStore(live, [{ agent: 'tester', quality: 0.1 }]); // live trains on
      const treat = path.join(tmp, 'treat'), ctrl = path.join(tmp, 'ctrl');
      evalMod.snapshotState(live, treat);
      evalMod.snapshotState(base, ctrl);
      expect(evalMod.hashState(treat).hash).not.toBe(evalMod.hashState(ctrl).hash);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it('snapshotState never writes under the source root (copy, never move)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-b-'));
    try {
      const live = makeLiveStore(path.join(tmp, 'live'), [{ agent: 'coder', quality: 0.9 }]);
      const before = fs.readdirSync(path.join(live, '.claude-flow')).sort();
      evalMod.snapshotState(live, path.join(tmp, 'dst'));
      expect(fs.readdirSync(path.join(live, '.claude-flow')).sort()).toEqual(before);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('improvement-eval: paired-row collection (hermetic, stubbed ruflo)', () => {
  // A fake `ruflo` on PATH prints a fixed routing line, so collectSession runs end-to-end
  // (freeze → sandbox both arms → append a paired row) with NO real routing and NO network.
  function withStubRuflo(fn) {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-bin-'));
    for (const name of ['ruflo', 'aqe']) { // stub both so captureStack() never hits a real binary
      const stub = path.join(bin, name);
      fs.writeFileSync(stub, '#!/bin/sh\necho "| Agent: tester |"\n');
      fs.chmodSync(stub, 0o755);
    }
    try { return fn(bin); } finally { fs.rmSync(bin, { recursive: true, force: true }); }
  }
  function runCollect(liveDir, binDir, baseDir) {
    const r = spawnSync(process.execPath, [TOOL, '--json', '--seeds', '1', '--baseline-dir', baseDir, '--bench-history', '/dev/null'], {
      encoding: 'utf8', cwd: liveDir,
      env: Object.assign({}, process.env, { PATH: binDir + path.delimiter + process.env.PATH }),
    });
    return JSON.parse(r.stdout);
  }

  it('freezes once, records baseline provenance + per-arm store hashes on the paired row', () => {
    withStubRuflo((bin) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-c-'));
      try {
        const live = makeLiveStore(path.join(tmp, 'live'), [{ agent: 'coder', quality: 0.9 }]);
        const base = path.join(tmp, 'base');
        const res = runCollect(live, bin, base);
        const row = res.session;
        expect(row).not.toBeNull();
        expect(row.baselineId).toMatch(/^[0-9a-f]{64}$/);
        expect(row.controlStateHash).toBe(row.baselineId);          // control read the frozen store
        expect(row.treatmentStateHash).toBe(row.baselineId);        // n=1: just froze → arms identical
        expect(row.stateDiffers).toBe(false);                        // honest tie at freeze time
        expect(typeof row.treatmentAcc).toBe('number');
        expect(fs.existsSync(evalMod.manifestPath(base))).toBe(true);
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    });
  });

  it('after the live policy diverges, the SAME baseline is reused and the arms read different state', () => {
    withStubRuflo((bin) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-c-'));
      try {
        const live = makeLiveStore(path.join(tmp, 'live'), [{ agent: 'coder', quality: 0.9 }]);
        const base = path.join(tmp, 'base');
        const first = runCollect(live, bin, base);              // freezes baseline
        makeLiveStore(live, [{ agent: 'tester', quality: 0.1 }]); // live trains forward
        const second = runCollect(live, bin, base);             // reuses baseline
        expect(second.session.baselineId).toBe(first.session.baselineId); // baseline NOT re-frozen
        expect(second.session.controlStateHash).toBe(first.session.baselineId);
        expect(second.session.treatmentStateHash).not.toBe(second.session.controlStateHash);
        expect(second.session.stateDiffers).toBe(true);          // arms now read distinct policy
        expect(second.n).toBe(2);                                // both rows share the baseline → series of 2
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    });
  });

  it('--rebaseline re-freezes against current live and warns on stderr', () => {
    withStubRuflo((bin) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-c-'));
      try {
        const live = makeLiveStore(path.join(tmp, 'live'), [{ agent: 'coder', quality: 0.9 }]);
        const base = path.join(tmp, 'base');
        const first = runCollect(live, bin, base);
        makeLiveStore(live, [{ agent: 'tester', quality: 0.1 }]);
        const r = spawnSync(process.execPath, [TOOL, '--json', '--seeds', '1', '--rebaseline', '--baseline-dir', base, '--bench-history', '/dev/null'], {
          encoding: 'utf8', cwd: live,
          env: Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH }),
        });
        expect(r.stderr).toMatch(/rebaseline/i);
        expect(r.stderr).toMatch(/RESETS/);
        const rebased = JSON.parse(r.stdout);
        expect(rebased.session.baselineId).not.toBe(first.session.baselineId); // new frozen point
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    });
  });
});
