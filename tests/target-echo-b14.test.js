/**
 * Tests for B14 (silent-wrong-target): tools/aqe-harvest.cjs and
 * tools/selfimprove-bench.cjs are the two MUTATING verbs among bench/
 * dashboard/harvest, and (unlike dashboard.cjs, which already prints its
 * resolved directory in its startup banner) they previously echoed NOTHING
 * about which directory they were about to write into.
 *
 * bin/ruflo-kit resolves these three verbs' target from $1 ONLY
 * (_kit_firstarg_resolve / _kit_firstarg_is_target, bin/ruflo-kit:233-238) —
 * a flag-first invocation (`harvest --status <target>`, `bench --json
 * <target>`) does not match "$1 looks like a target" and silently falls back
 * to ${RUFLO_KIT_TARGET:-$(pwd)} instead of the supplied path. The dispatcher
 * then `cd`s into whatever it resolved BEFORE exec'ing the node tool, so by
 * the time either tool runs, process.cwd() genuinely IS the directory about
 * to be mutated — these tools never parse a target path themselves. The fix
 * is not to reparse args (that would risk diverging from the dispatcher's own
 * resolution, the exact class of bug VERB-SAFETY-V1 round 3 already fixed
 * once) but simply to print that directory, unconditionally, before any
 * read/write — turning a silent wrong-target into a visible one.
 *
 * SUPERSEDED BY B20 for one specific case, on purpose — record both behaviors
 * and the boundary between them, not just the newer one:
 *
 *   B20 (bin/ruflo-kit's _kit_refuse_on_dispatcher_divergence, wired into the
 *   bench/harvest case arms) now REFUSES outright — exits nonzero BEFORE the
 *   node tool is ever exec'd — whenever the dispatcher can see a genuine
 *   divergence: $1 is flag-shaped (not the target) AND some LATER argument is
 *   a real, existing directory different from the resolved target. That is
 *   exactly the flag-first scenario this file originally exercised (`bench
 *   --json <target>`, `harvest --status <target>`), because only the
 *   dispatcher ever holds both "what the user typed" and "what got resolved"
 *   at once (tools/aqe-harvest.cjs and tools/selfimprove-bench.cjs never see
 *   the user's original argv — see below). For a MUTATING verb, "you pointed
 *   at X, we'd write to Y" is treated as a mistake worth stopping, not
 *   narrating — so the refusal supersedes this file's own echo for that one
 *   case: the tool's banner never appears because the tool never runs.
 *
 *   The echo added here is NOT redundant, though, and must not be removed:
 *   it is the ONLY signal for every case B20 does not refuse — no target
 *   argument at all (resolves to cwd, no divergence to detect), target-first
 *   invocations, and any future verb with the same $1-only resolution shape
 *   but no divergence guard. B20 answers "you asked for somewhere else";
 *   this file's fix answers "here is where I am operating" — different
 *   questions, both needed.
 *
 * Two layers:
 *  - unit: spawn the .cjs tool directly (bypassing bash/the dispatcher) and
 *    assert the banner is the FIRST thing printed, before any exit or write.
 *    B20 lives entirely in bin/ruflo-kit, so these are unaffected by it.
 *  - integration: spawn the REAL bin/ruflo-kit dispatcher and prove, for both
 *    verbs: (a) target-first still resolves to and echoes the supplied
 *    target; (b) no-target-given still resolves to and echoes the ambient
 *    cwd (the echo's surviving job); (c) flag-first-with-a-real-divergent-
 *    directory is now REFUSED before the tool ever runs, with no echo and no
 *    mutation anywhere (B20's job, verified from this side too).
 *
 * Fixtures are throwaway dirs under os.tmpdir() (same convention as
 * harvest-embed.test.js / dashboard.test.js) — never a real project, and
 * nothing here touches this repo's own .agentic-qe/, .swarm/, or agentdb.db.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const HARVEST_TOOL = path.join(REPO, 'tools', 'aqe-harvest.cjs');
const BENCH_TOOL = path.join(REPO, 'tools', 'selfimprove-bench.cjs');
const DISPATCHER = path.join(REPO, 'bin', 'ruflo-kit');

function mkFixture(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.RUFLO_KIT_TARGET; // must never leak in and mask the fallback-to-cwd behavior under test
  delete env.KIT_HARVEST_NODE_BASE;
  return env;
}

describe('B14 silent-wrong-target — target echo (unit: direct tool invocation)', () => {
  let fixture;
  beforeEach(() => { fixture = mkFixture('b14-unit-'); });
  afterEach(() => { fs.rmSync(fixture, { recursive: true, force: true }); });

  it('aqe-harvest.cjs prints the resolved target on stderr before the "no memory.db" exit', () => {
    const res = spawnSync(process.execPath, [HARVEST_TOOL], { cwd: fixture, env: cleanEnv(), encoding: 'utf8', timeout: 20000 });
    const lines = (res.stderr || '').split('\n').filter(Boolean);
    expect(lines[0]).toBe(`[aqe-harvest] target: ${fixture}`);
    expect(lines[1]).toMatch(/^\[aqe-harvest\] writes: .*\.swarm\/lora-weights\.json.*agentdb\.db.*harvest-state\.json.*read-only: \.agentic-qe\/memory\.db/);
    // the banner must precede the (later) fatal line about the missing store
    const bannerIdx = lines.findIndex((l) => l.startsWith('[aqe-harvest] target:'));
    const fatalIdx = lines.findIndex((l) => l.includes('no AQE memory.db'));
    expect(bannerIdx).toBeGreaterThanOrEqual(0);
    expect(fatalIdx).toBeGreaterThan(bannerIdx);
    expect(res.status).toBe(1); // no memory.db in a bare fixture — exits, but only AFTER the banner
    // no mutation happened in the fixture despite the run
    expect(fs.existsSync(path.join(fixture, '.swarm'))).toBe(false);
  });

  it('selfimprove-bench.cjs prints the resolved target on stderr before appending history, in --json mode', () => {
    const res = spawnSync(process.execPath, [BENCH_TOOL, '--json'], { cwd: fixture, env: cleanEnv(), encoding: 'utf8', timeout: 30000 });
    const errLines = (res.stderr || '').split('\n').filter(Boolean);
    expect(errLines[0]).toBe(`[selfimprove-bench] target: ${fixture}`);
    expect(errLines[1]).toBe('[selfimprove-bench] writes: .claude-flow/selfimprove-history.jsonl');
    // --json's documented contract (README/CHEATSHEET) is a single JSON blob on stdout —
    // the banner must live on stderr, never polluting that contract.
    expect(() => JSON.parse(res.stdout)).not.toThrow();
    // the history write is real and lands in the printed target, not somewhere else
    expect(fs.existsSync(path.join(fixture, '.claude-flow', 'selfimprove-history.jsonl'))).toBe(true);
  });

  it('selfimprove-bench.cjs still prints the banner on stderr under --quiet (whose contract is a single stdout verdict line)', () => {
    const res = spawnSync(process.execPath, [BENCH_TOOL, '--quiet'], { cwd: fixture, env: cleanEnv(), encoding: 'utf8', timeout: 30000 });
    const errLines = (res.stderr || '').split('\n').filter(Boolean);
    expect(errLines[0]).toBe(`[selfimprove-bench] target: ${fixture}`);
    // --quiet's documented "suppress chatter" contract is about stdout, not stderr
    const stdoutLines = res.stdout.trim().split('\n').filter(Boolean);
    expect(stdoutLines).toHaveLength(1);
    expect(stdoutLines[0]).toMatch(/IMPROVING|blocked/);
  });
});

describe('B14 silent-wrong-target — integration: real bin/ruflo-kit dispatcher, both argument orders', () => {
  let target, ambientCwd;
  beforeEach(() => {
    target = mkFixture('b14-target-');
    ambientCwd = mkFixture('b14-ambient-');
  });
  afterEach(() => {
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(ambientCwd, { recursive: true, force: true });
  });

  function runKit(args) {
    return spawnSync(DISPATCHER, args, { cwd: ambientCwd, env: cleanEnv(), encoding: 'utf8', timeout: 30000 });
  }

  it('harvest: target-first resolves to (and echoes) the supplied target', () => {
    const res = runKit(['harvest', target]);
    expect(res.stderr).toContain(`[aqe-harvest] target: ${target}`);
    expect(res.stderr).not.toContain(`[aqe-harvest] target: ${ambientCwd}`);
  });

  it('harvest: no target argument at all still resolves to (and echoes) the ambient cwd — the echo\'s surviving job once B20 handles the divergent case', () => {
    const res = runKit(['harvest']);
    // no divergence is possible with zero args (nothing for _kit_dispatcher_divergent_path to find),
    // so B20 never engages here — this is the case the echo alone still has to cover.
    expect(res.stderr).not.toMatch(/ruflo-kit harvest: refused/);
    expect(res.stderr).toContain(`[aqe-harvest] target: ${ambientCwd}`);
  });

  it('harvest: flag-first with a real divergent directory ("--status" before the target, mirroring the ledger example) is now REFUSED by B20 before the tool ever runs', () => {
    const res = runKit(['harvest', '--status', target]);
    // B20 (_kit_refuse_on_dispatcher_divergence) supersedes this file's echo for exactly this
    // case: it exits nonzero BEFORE cd/exec, so the tool's own banner never has a chance to print.
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/ruflo-kit harvest: refused — '.*' is an existing directory but was NOT treated as the target/);
    expect(res.stderr).toContain(target); // names the ignored path
    expect(res.stderr).toContain(ambientCwd); // names the resolved (would-be) target
    // the tool never ran: neither its stderr banner nor any mutation appears anywhere
    expect(res.stderr).not.toContain('[aqe-harvest] target:');
    expect(fs.existsSync(path.join(target, '.swarm'))).toBe(false);
    expect(fs.existsSync(path.join(ambientCwd, '.swarm'))).toBe(false);
  });

  it('bench: target-first resolves to (and echoes) the supplied target', () => {
    const res = runKit(['bench', target, '--quiet']);
    expect(res.stderr).toContain(`[selfimprove-bench] target: ${target}`);
    expect(res.stderr).not.toContain(`[selfimprove-bench] target: ${ambientCwd}`);
    expect(fs.existsSync(path.join(target, '.claude-flow', 'selfimprove-history.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(ambientCwd, '.claude-flow', 'selfimprove-history.jsonl'))).toBe(false);
  });

  it('bench: no target argument at all still resolves to (and echoes) the ambient cwd — the echo\'s surviving job once B20 handles the divergent case', () => {
    const res = runKit(['bench', '--quiet']);
    expect(res.stderr).not.toMatch(/ruflo-kit bench: refused/);
    expect(res.stderr).toContain(`[selfimprove-bench] target: ${ambientCwd}`);
    expect(fs.existsSync(path.join(ambientCwd, '.claude-flow', 'selfimprove-history.jsonl'))).toBe(true);
  });

  it('bench: flag-first with a real divergent directory ("--json" before the target, the ledger\'s own example) is now REFUSED by B20 before the tool ever runs', () => {
    const res = runKit(['bench', '--json', target]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/ruflo-kit bench: refused — '.*' is an existing directory but was NOT treated as the target/);
    expect(res.stderr).toContain(target);
    expect(res.stderr).toContain(ambientCwd);
    expect(res.stderr).not.toContain('[selfimprove-bench] target:');
    // reproduce the ABSENCE of the old harm: neither directory's history file gets written
    expect(fs.existsSync(path.join(ambientCwd, '.claude-flow', 'selfimprove-history.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(target, '.claude-flow', 'selfimprove-history.jsonl'))).toBe(false);
  });
});
