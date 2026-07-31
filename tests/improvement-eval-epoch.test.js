/**
 * Tests for the 2026-07-31 MEASUREMENT EPOCH LINE in tools/improvement-eval.cjs
 * (Wave 4 measurement integrity). Pre-line rows were measured on an instrument now
 * known to have been misreporting (WASM-emulated sqlite backend; unattributed #2786
 * trajectory writer) — the gate must refuse to blend them with post-line rows, and
 * collection must refuse to extend a series anchored to a pre-line frozen baseline.
 *
 * Falsification duty: a historical-line guard that never fires is theater, so the
 * fixtures include straddling histories (guard must exclude), all-pre histories
 * (verdict must degrade to UNPROVEN at n=0), and a doctored pre-line baseline
 * manifest (collection must hard-refuse with exit 1).
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOL = path.resolve(__dirname, '..', 'tools', 'improvement-eval.cjs');
const evalMod = require(TOOL);

const PRE_TS = '2026-07-15T12:00:00Z';   // before the line
const POST_TS = '2026-07-31T18:00:00Z';  // after the 13:00Z line
const EVAL_TS = '2026-08-01T00:00:00Z';  // deterministic post-line stamp for hermetic collection

function analyze(rows) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-epoch-'));
  const f = path.join(d, 'eval-history.jsonl');
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(Object.assign({ scorerVersion: 'eval-v1' }, r))).join('\n') + '\n');
  const r = spawnSync(process.execPath, [TOOL, '--history-file', f, '--bench-history', '/dev/null', '--json'], { encoding: 'utf8' });
  fs.rmSync(d, { recursive: true, force: true });
  if (!r.stdout) throw new Error('no stdout; stderr=' + r.stderr);
  return { result: JSON.parse(r.stdout), code: r.status };
}
const pre = (t, c) => ({ ts: PRE_TS, treatmentAcc: t, controlAcc: c });
const post = (t, c) => ({ ts: POST_TS, treatmentAcc: t, controlAcc: c });

describe('epoch line: unit semantics (epochOf / baselinePreEpoch)', () => {
  it('classifies pre / post / no-ts rows against the hard-coded line', () => {
    expect(evalMod.epochOf({ ts: PRE_TS })).toBe('pre');
    expect(evalMod.epochOf({ ts: POST_TS })).toBe('post');
    expect(evalMod.epochOf({ ts: '2026-07-31T13:00:00Z' })).toBe('post');  // line itself is post (inclusive)
    expect(evalMod.epochOf({ ts: '2026-07-31T12:59:59Z' })).toBe('pre');   // same-day pre-repair stays pre
    expect(evalMod.epochOf({})).toBe('no-ts');
    expect(evalMod.epochOf({ ts: 'not a date' })).toBe('no-ts');
  });

  it('the line is the pre-registered constant and cannot drift silently', () => {
    // 13:00Z, not midnight: all three onsets (native rebuild, #2786 install at
    // 10:12Z, attribution wiring) happened during 2026-07-31 before 13:00Z, so a
    // midnight line admitted same-day pre-repair measurements as post-line.
    expect(evalMod.EPOCH_LINE).toBe('2026-07-31T13:00:00Z');
    expect(evalMod.EPOCH_ID).toBe('post-repair-2026-07-31');
  });

  it('flags a manifest frozen before the line; accepts post-line and absent', () => {
    expect(evalMod.baselinePreEpoch({ created: '2026-07-18T19:36:26.566Z' })).toBe(true);
    expect(evalMod.baselinePreEpoch({ created: POST_TS })).toBe(false);
    expect(evalMod.baselinePreEpoch(null)).toBe(false);
    expect(evalMod.baselinePreEpoch({})).toBe(false);
  });
});

describe('epoch line: the gate never blends across the line', () => {
  it('a straddling history counts ONLY post-line rows (pre-line excluded and reported)', () => {
    const { result } = analyze([
      pre(0.9, 0.1), pre(0.9, 0.1), pre(0.9, 0.1),        // strong pre-line separation
      post(0.7, 0.5), post(0.72, 0.5), post(0.74, 0.5),   // the real post-line series
    ]);
    expect(result.n).toBe(3);                              // NOT 6 — no blended verdict possible
    expect(result.epoch.excludedPreLine).toBe(3);
    expect(result.treatment).toEqual([0.7, 0.72, 0.74]);   // exactly the post rows
    expect(result.control).toEqual([0.5, 0.5, 0.5]);
  });

  it('an all-pre history degrades to UNPROVEN at n=0 — pre-line data can NEVER produce a verdict', () => {
    const { result, code } = analyze([pre(0.9, 0.1), pre(0.9, 0.1), pre(0.9, 0.1), pre(0.9, 0.1)]);
    expect(result.n).toBe(0);
    expect(result.epoch.excludedPreLine).toBe(4);
    expect(result.verdict).toBe('UNPROVEN');
    expect(code).toBe(1);
  });

  it('would-be-IMPROVING pre-line rows cannot rescue an insufficient post-line series', () => {
    const { result } = analyze([pre(0.9, 0.1), pre(0.92, 0.1), post(0.7, 0.5), post(0.72, 0.5)]);
    expect(result.n).toBe(2);                              // only the 2 post rows
    expect(result.verdict).toBe('UNPROVEN');               // <3 runs — pre rows didn't count
  });

  it('REPRODUCTION (round 2): stripping ts from excluded history must NOT let it back into the gate', () => {
    // Round-1 behavior: these three rows produced n=3 verdict=IMPROVING — the
    // excluded pre-line history walked straight back in by losing its timestamps.
    const { result } = analyze([
      { treatmentAcc: 0.9, controlAcc: 0.1 },
      { treatmentAcc: 0.9, controlAcc: 0.1 },
      { treatmentAcc: 0.9, controlAcc: 0.1 },
    ]);
    expect(result.n).toBe(0);
    expect(result.verdict).not.toBe('IMPROVING');
    expect(result.epoch.excludedNoTs).toBe(3);
  });

  it('unplaceable-ts rows are excluded and counted, same as pre-line rows', () => {
    const { result } = analyze([
      { treatmentAcc: 0.7, controlAcc: 0.5 },                    // no ts
      { ts: 'garbage', treatmentAcc: 0.72, controlAcc: 0.5 },    // unparseable ts
      post(0.74, 0.5),
    ]);
    expect(result.n).toBe(1);                                    // only the placeable post row
    expect(result.epoch.excludedNoTs).toBe(2);
    expect(result.epoch.excludedPreLine).toBe(0);
  });

  it('CLOCK SANITY: a far-future ts is counted but flagged suspect; near-now stamps are not', () => {
    // Round-2 follow-up: a valid far-future ts is indistinguishable in principle from
    // a forged post-line stamp (same class as forged manifest.created). The bound
    // FLAGS it (visibility) without changing the pre-registered gate: still counted.
    const { result } = analyze([
      { ts: '2099-01-01T00:00:00Z', treatmentAcc: 0.9, controlAcc: 0.1 },
      post(0.7, 0.5),
    ]);
    expect(result.n).toBe(2);                              // gate unchanged — both count
    expect(result.epoch.suspectFutureTs).toBe(1);          // but the 2099 row is flagged
    // unit bound: >24h beyond "now" is suspect, within 24h is not
    const nowMs = Date.now();
    expect(evalMod.tsSuspectFuture({ ts: new Date(nowMs + 25 * 3600 * 1000).toISOString() }, nowMs)).toBe(true);
    expect(evalMod.tsSuspectFuture({ ts: new Date(nowMs + 23 * 3600 * 1000).toISOString() }, nowMs)).toBe(false);
    expect(evalMod.tsSuspectFuture({ ts: 'garbage' }, nowMs)).toBe(false); // unplaceable is excludedNoTs's job
  });

  it('the JSON result always carries the epoch block (line + reason) for downstream readers', () => {
    const { result } = analyze([post(0.7, 0.5)]);
    expect(result.epoch.line).toBe('2026-07-31T13:00:00Z');
    expect(typeof result.epoch.reason).toBe('string');
    expect(result.epoch.reason.length).toBeGreaterThan(20);
  });
});

describe('epoch line: bench corroborating trend never blends either', () => {
  it('benchEpochOf places suffixed ts values ("…Z-run1") via their ISO prefix', () => {
    expect(evalMod.benchEpochOf({ ts: '2026-05-28T21:30:00Z-run1' })).toBe('pre');
    expect(evalMod.benchEpochOf({ ts: '2026-07-31T10:42:00Z-run7' })).toBe('pre');  // same-day pre-repair
    expect(evalMod.benchEpochOf({ ts: '2026-07-31T21:30:00Z-run9' })).toBe('post');
    expect(evalMod.benchEpochOf({ ts: 'trained-run1-1780056433' })).toBe('no-ts');  // real live-history shape
    expect(evalMod.benchEpochOf({ ts: '' })).toBe('no-ts');                          // real live-history shape
    expect(evalMod.benchEpochOf({})).toBe('no-ts');
  });

  it('readBenchTrend excludes pre-line AND unplaceable-ts rows, reporting both counts', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-bench-'));
    const f = path.join(d, 'bench.jsonl');
    try {
      fs.writeFileSync(f, [
        { ts: '2026-05-28T21:30:00Z-run1', scorerVersion: 'norm-v1', accuracyPct: 25 },
        { ts: '2026-06-01T00:00:00Z-run2', scorerVersion: 'norm-v1', accuracyPct: 90 },  // would fake +65pp if blended
        { ts: 'trained-run1-1780056433', scorerVersion: 'norm-v1', accuracyPct: 80 },    // June-era row that LOST its ts
        { ts: '', scorerVersion: 'norm-v1', accuracyPct: 85 },                            // ditto — must not count as post
        { ts: '2026-07-31T18:00:00Z-run3', scorerVersion: 'norm-v1', accuracyPct: 40 },
        { ts: '2026-08-01T10:00:00Z-run4', scorerVersion: 'norm-v1', accuracyPct: 45 },
      ].map((r) => JSON.stringify(r)).join('\n') + '\n');
      const trend = evalMod.readBenchTrend(f);
      expect(trend.excludedPreLine).toBe(2);
      expect(trend.excludedNoTs).toBe(2);
      expect(trend.runs).toBe(2);
      expect(trend.deltaPP).toBe(5);                       // 45−40 — never touches the 80/85/90 history
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });

  it('LIVE-DATA check: the real selfimprove-history yields no blended post-line bench trend', () => {
    // Round-2 defect was live-wrong: 6 real norm-v1 rows with unparseable ts counted
    // as post-line corroboration ("+0pp over 9 runs, zero exclusions"). All real rows
    // predate the line or are unplaceable, so the post-line series must be empty.
    const real = path.resolve(__dirname, '..', '.claude-flow', 'selfimprove-history.jsonl');
    if (!fs.existsSync(real)) return;                      // fresh checkout — nothing to check
    const trend = evalMod.readBenchTrend(real);
    // The June-era rows never leave the file — they must ALWAYS show as excluded.
    expect(trend.excludedPreLine + trend.excludedNoTs).toBeGreaterThan(0);
    // Until a genuine post-line series exists (runs ≥ 2 placeable-post rows), the
    // corroborating delta must be null — never a number built on excluded history.
    if (trend.runs < 2) expect(trend.deltaPP).toBeNull();
  });
});

describe('epoch line: text output reports the split loudly', () => {
  it('prints the EPOCH LINE exclusion banner when pre-line rows exist', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-epoch-'));
    const f = path.join(d, 'eval-history.jsonl');
    fs.writeFileSync(f, [pre(0.9, 0.1), post(0.7, 0.5)].map((r) => JSON.stringify(Object.assign({ scorerVersion: 'eval-v1' }, r))).join('\n') + '\n');
    const r = spawnSync(process.execPath, [TOOL, '--history-file', f, '--bench-history', '/dev/null'], { encoding: 'utf8' });
    fs.rmSync(d, { recursive: true, force: true });
    expect(r.stdout).toMatch(/EPOCH LINE 2026-07-31T13:00:00Z: 1 pre-line row\(s\) EXCLUDED/);
    expect(r.stdout).toMatch(/never blended/);
  });
});

describe('epoch line: collection refuses a pre-line frozen baseline', () => {
  // Hermetic: stub ruflo/aqe on PATH; seed a live store; freeze a baseline; then DOCTOR
  // the manifest's created to a pre-line date. Collection must refuse (exit 1) and must
  // NOT append a row. --rebaseline re-freezes (created=now, post-line) and proceeds.
  function withStubBins(fn) {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-bin-'));
    for (const name of ['ruflo', 'aqe']) {
      const stub = path.join(bin, name);
      fs.writeFileSync(stub, '#!/bin/sh\necho "| Agent: tester |"\n');
      fs.chmodSync(stub, 0o755);
    }
    try { return fn(bin); } finally { fs.rmSync(bin, { recursive: true, force: true }); }
  }
  function seedLive(dir) {
    fs.mkdirSync(path.join(dir, '.claude-flow'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude-flow', 'routing-outcomes.json'), JSON.stringify({ outcomes: [{ agent: 'coder', quality: 0.9 }] }));
    return dir;
  }
  function runEval(liveDir, binDir, baseDir, extra = []) {
    return spawnSync(process.execPath, [TOOL, '--json', '--seeds', '1', '--baseline-dir', baseDir, '--bench-history', '/dev/null'].concat(extra), {
      encoding: 'utf8', cwd: liveDir,
      // EVAL_TS pins the appended row to a deterministic post-line stamp so these
      // tests exercise the post-line path regardless of wall-clock time.
      env: Object.assign({}, process.env, { PATH: binDir + path.delimiter + process.env.PATH, EVAL_TS }),
    });
  }

  it('exit 1 + no appended row on a pre-line baseline; --rebaseline is the sanctioned recovery', () => {
    withStubBins((bin) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-epoch-c-'));
      try {
        const live = seedLive(path.join(tmp, 'live'));
        fs.mkdirSync(live, { recursive: true });
        seedLive(live);
        const base = path.join(tmp, 'base');
        // First collection freezes a (post-line) baseline and appends row #1.
        const first = runEval(live, bin, base);
        expect(JSON.parse(first.stdout).session).not.toBeNull();
        // Doctor the manifest to a pre-line freeze date.
        const mPath = evalMod.manifestPath(base);
        const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
        m.created = '2026-07-18T19:36:26.566Z';
        fs.writeFileSync(mPath, JSON.stringify(m));
        const histBefore = fs.readFileSync(path.join(live, '.claude-flow', 'improvement-eval-history.jsonl'), 'utf8');
        // Collection must now refuse.
        const refused = runEval(live, bin, base);
        expect(refused.status).toBe(1);
        expect(refused.stderr).toMatch(/REFUSING to collect/);
        expect(refused.stderr).toMatch(/--rebaseline/);
        const histAfter = fs.readFileSync(path.join(live, '.claude-flow', 'improvement-eval-history.jsonl'), 'utf8');
        expect(histAfter).toBe(histBefore);               // refusal appended NOTHING
        // --rebaseline re-freezes post-line and collection proceeds again.
        const rebased = runEval(live, bin, base, ['--rebaseline']);
        expect(rebased.status === 0 || rebased.status === 1).toBe(true); // verdict exit, not a refusal
        const out = JSON.parse(rebased.stdout);
        expect(out.session).not.toBeNull();
        expect(evalMod.baselinePreEpoch(JSON.parse(fs.readFileSync(mPath, 'utf8')))).toBe(false);
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    });
  });

  it('collected rows carry epoch + instrument provenance fields', () => {
    withStubBins((bin) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-epoch-c-'));
      try {
        const live = seedLive(path.join(tmp, 'live'));
        const base = path.join(tmp, 'base');
        const res = JSON.parse(runEval(live, bin, base).stdout);
        expect(res.session.epoch).toBe('post-repair-2026-07-31');
        expect(res.session.instrument).toBeTruthy();
        // Round 2: the fingerprint must also carry the seam sentinels (a mid-series
        // bump that wipes SONA-TRAIN-V1 pins treatment ≡ control) and stack versions.
        for (const k of ['bsqliteNativeOk', 'bridge2786', 'sonaTrainSentinel', 'loraAdaptSentinel', 'rufloVersion', 'aqeVersion', 'nodeVersion']) {
          expect(k in res.session.instrument).toBe(true);
        }
        expect(res.session.instrument.nodeVersion).toBe(process.version);
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    });
  });
});

describe('epoch line: --preflight (re-baseline readiness, no routing)', () => {
  it('emits the checklist as JSON and FAILS on a stubbed empty npm root (cannot verify native sqlite)', () => {
    const stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-npmroot-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-pf-'));
    try {
      const r = spawnSync(process.execPath, [TOOL, '--preflight', '--json', '--baseline-dir', path.join(cwd, 'base')], {
        encoding: 'utf8', cwd,
        env: Object.assign({}, process.env, { KIT_ATTR_NODE_BASE: stubRoot }),
      });
      const out = JSON.parse(r.stdout);
      expect(out.preflight).toBe(true);
      expect(out.ready).toBe(false);                       // empty root: sqlite + sentinels unverifiable
      expect(r.status).toBe(1);
      const names = out.checks.map((c) => c.name);
      expect(names.some((n) => /better-sqlite3 native/.test(n))).toBe(true);
      expect(names.some((n) => /2786/.test(n))).toBe(true);
      expect(names.some((n) => /baseline/.test(n))).toBe(true);
    } finally {
      fs.rmSync(stubRoot, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('the baseline check specifically FAILS on a pre-line manifest and points at --rebaseline', () => {
    const stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-npmroot-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-pf-'));
    try {
      const base = path.join(cwd, 'base');
      fs.mkdirSync(base, { recursive: true });
      fs.writeFileSync(path.join(base, 'manifest.json'), JSON.stringify({ created: '2026-07-01T00:00:00Z' }));
      const r = spawnSync(process.execPath, [TOOL, '--preflight', '--json', '--baseline-dir', base], {
        encoding: 'utf8', cwd,
        env: Object.assign({}, process.env, { KIT_ATTR_NODE_BASE: stubRoot }),
      });
      const out = JSON.parse(r.stdout);
      const baseCheck = out.checks.find((c) => /baseline/.test(c.name));
      expect(baseCheck.ok).toBe(false);
      expect(baseCheck.note).toMatch(/--rebaseline/);
    } finally {
      fs.rmSync(stubRoot, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
