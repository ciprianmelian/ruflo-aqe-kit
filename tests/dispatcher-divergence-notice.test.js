/**
 * Tests for bin/ruflo-kit's B20 dispatcher-divergence protection.
 *
 * Background (B14, confirmed): bench/dashboard/harvest resolve their target
 * via `_kit_firstarg_resolve`, which ONLY ever looks at $1 (VERB-SAFETY-V1
 * round 3). If $1 is flag-shaped, resolution silently falls back to
 * cwd/$RUFLO_KIT_TARGET even when a LATER argument is a real, existing
 * directory the user plainly meant as the target — e.g.
 * `harvest --status /other/project` quietly operates on cwd's
 * `.agentic-qe/memory.db` instead. B14's fix made bench/harvest echo their
 * resolved target unconditionally ("[tool] target: <dir>"), which turns a
 * silent wrong target into a VISIBLE one for an interactive user — but the
 * tools themselves never see the user's ORIGINAL argv, only the
 * already-resolved cwd, so they cannot say "you typed X, we used Y", and a
 * visible-but-stderr-only signal is invisible to any `2>/dev/null` / CI
 * consumer while the tool still writes underneath it.
 *
 * B20 round 1 added an stderr notice naming both paths at the one place
 * that holds them simultaneously (bin/ruflo-kit's bench/dashboard/harvest
 * case arms, right after `t` is resolved from the still-unshifted "$@").
 * B14's critic reproduced exactly the gap that leaves open: from a
 * different cwd, `harvest --status <other-dir> 2>/dev/null` produces no
 * captured output AT ALL and still mutates the ambient cwd's stores. A
 * notice inherits that blind spot for any verb whose real work WRITES.
 *
 * Round 2 (this file) therefore splits the ONE shared predicate
 * (`_kit_dispatcher_divergent_path`) into two different RESPONSES:
 *   - dashboard (read-only, foreground, already self-reports its target on
 *     STDOUT in its own "listening on" banner) keeps the stderr NOTICE.
 *   - bench / harvest (both WRITE into the resolved target's persistent
 *     stores) now REFUSE outright — nonzero exit, no cd, no exec, nothing
 *     written — because a discarded stderr stream can't hide a nonzero
 *     exit code, and refusing before any work runs is the only way to make
 *     that guarantee absolute rather than advisory.
 *
 * This file proves, for every scenario:
 *   (a) the correct response fires for a genuine divergence (refuse for
 *       bench/harvest, notice for dashboard), naming both paths;
 *   (b) silence/non-refusal in every non-divergent shape (target-first,
 *       flag-only, "." already equal to cwd, a nonexistent trailing path);
 *   (c) the exact critic repro (`2>/dev/null`) is closed for the mutating
 *       verbs: nonzero exit AND zero bytes changed on disk;
 *   (d) teeth — none of this existed before (git HEAD, rebuilt runnable);
 *   (e) resolution is UNCHANGED in every NON-divergent case (old vs new,
 *       compared via the tool's own independent banner, never the
 *       notice/refusal text) — this file's addition only ever adds a new
 *       response to an already-existing observation, it never touches
 *       which directory gets used when there is nothing to react to.
 */
'use strict';

const { spawnSync, spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const KIT = path.join(REPO_ROOT, 'bin', 'ruflo-kit');

// ── Pre-change dispatcher (git HEAD, before EITHER B20 round), rebuilt with
// the real tools/lib/assets symlinked alongside it so KIT_DIR resolution
// (bin/ruflo-kit:67, which walks up from the script's OWN location) still
// finds them — without ever writing into the real repo tree. This is what
// makes the "teeth" tests meaningful (proves neither notice nor refusal
// existed before) and the "resolution unchanged" tests meaningful (proves
// old and new cd into the identical directory before exec'ing the
// identical tool, in every case that isn't a genuine divergence).
let OLD_KIT_DIR;
let OLD_KIT;

// PINNED TO A SHA, NOT `HEAD`. This read `HEAD:bin/ruflo-kit`, which was a
// correct pre-change baseline only while B20 was uncommitted. Once it landed
// (ac124a8) HEAD became the FIXED dispatcher, so the three "teeth" tests below
// — which assert the OLD dispatcher produces NO notice and NO refusal — began
// failing against a dispatcher that now correctly produces both.
//
// 0561b7c = Patch 71, the last commit before B20. Verified to contain ZERO
// occurrences of `_kit_dispatcher_divergent_path` (HEAD has 4), so it is a
// genuine pre-change baseline. Do not "modernise" this back to HEAD: a teeth
// test pointed at post-fix code either fails loudly or, worse, passes while
// proving nothing.
const PRE_CHANGE_REF = '0561b7c';

beforeAll(() => {
  const oldSrc = execFileSync('git', ['show', `${PRE_CHANGE_REF}:bin/ruflo-kit`], { cwd: REPO_ROOT, encoding: 'utf8' });
  OLD_KIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ruflo-kit-prechange-'));
  fs.mkdirSync(path.join(OLD_KIT_DIR, 'bin'));
  OLD_KIT = path.join(OLD_KIT_DIR, 'bin', 'ruflo-kit');
  fs.writeFileSync(OLD_KIT, oldSrc, { mode: 0o755 });
  for (const d of ['tools', 'lib', 'assets']) {
    const src = path.join(REPO_ROOT, d);
    if (fs.existsSync(src)) fs.symlinkSync(src, path.join(OLD_KIT_DIR, d));
  }
});
afterAll(() => {
  try { fs.rmSync(OLD_KIT_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

const worlds = [];
afterEach(() => {
  while (worlds.length) {
    const w = worlds.pop();
    try { fs.rmSync(w, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// Two real, existing, DISTINCT directories per test: `target` (what gets
// resolved when $1 is a flag) and `other` (what the user actually pointed
// at, later in argv) — this is the exact shape of the B14 gap.
function freshWorld() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dispdiv-')));
  worlds.push(base);
  const target = path.join(base, 'target');
  const other = path.join(base, 'other-project');
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { base, target, other, home };
}

function run(kit, args, { cwd, home, timeout = 20000, ignoreStderr = false } = {}) {
  const r = spawnSync('bash', [kit, ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, HOME: home || os.tmpdir() },
    timeout,
    stdio: ['ignore', 'pipe', ignoreStderr ? 'ignore' : 'pipe'],
  });
  return {
    code: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    out: `${r.stdout || ''}${r.stderr || ''}`,
    signal: r.signal,
  };
}

// dashboard is a foreground server (Ctrl-C to stop) — capture a short
// window then kill it, same pattern as tests/verb-safety.test.js.
function runDashboardBriefly(kit, args, { home, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn('bash', [kit, 'dashboard', ...args], {
      cwd,
      env: { ...process.env, HOME: home || os.tmpdir() },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const finish = () => resolve(out);
    child.on('exit', finish);
    setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      setTimeout(finish, 200);
    }, 900);
  });
}

// Every file under `dir`, relative paths + size — proves a directory was
// (or was not) touched at all, independent of which specific files a tool
// happens to write today (borrowed convention from verb-safety.test.js).
function snapshotTree(dir) {
  const out = [];
  (function walk(d, prefix) {
    let names;
    try { names = fs.readdirSync(d); } catch { return; }
    for (const name of names.sort()) {
      const p = path.join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p, rel);
      else out.push(`${rel}:${st.size}`);
    }
  })(dir, '');
  return out;
}

const NOTICE_RE = /ruflo-kit (\w+): note — '(.+?)' is an existing directory but was NOT treated as the target \(resolved target: '(.+?)'\)/;
const REFUSAL_RE = /ruflo-kit (\w+): refused — '(.+?)' is an existing directory but was NOT treated as the target/;

// The tool's OWN, independent echo of its resolved target — NOT the
// dispatcher's notice/refusal text. bench/harvest print
// "[tool] target: <dir>" (B14, TARGET-ECHO-V1) as the very FIRST thing they
// do, before any read or write; dashboard prints "(target: <dir>)" in its
// "listening on" banner. Its PRESENCE means the tool actually started
// (i.e. a refusal did NOT happen); reading resolution from here (rather
// than from the dispatcher's own text) is what lets the "resolution
// unchanged" tests be an independent check, not a tautology.
function toolResolvedTarget(out) {
  const m1 = out.match(/\[(?:aqe-harvest|selfimprove-bench)\] target: (\S+)/);
  if (m1) return m1[1];
  const m2 = out.match(/\(target: (\S+)\)/);
  if (m2) return m2[1];
  return null;
}

describe('B20: dashboard (read-only) gets a NOTICE on genuine divergence, names both paths', () => {
  it('dashboard --port 0 <other-existing-dir> (flag-first) fires the notice', async () => {
    const { target, other, home } = freshWorld();
    const out = await runDashboardBriefly(KIT, ['--port', '0', other], { home, cwd: target });
    const m = out.match(NOTICE_RE);
    expect(m).not.toBeNull();
    expect(m[1]).toBe('dashboard');
    expect(m[2]).toBe(other);   // what they passed
    expect(m[3]).toBe(target);  // what was used
    // Never blocked: dashboard still starts and shows (the wrong) target —
    // read-only, so this is a warning, not a mistake worth stopping.
    expect(out).toMatch(/ruflo-kit dashboard listening on/);
  });
});

describe('B20: bench/harvest (MUTATING) REFUSE outright on genuine divergence', () => {
  it('harvest --status <other-existing-dir> (flag-first) is refused, names both paths, spells out the escape hatch', () => {
    const { target, other, home } = freshWorld();
    const { code, stderr, stdout } = run(KIT, ['harvest', '--status', other], { cwd: target, home, timeout: 15000 });
    expect(code).not.toBe(0);
    const m = stderr.match(REFUSAL_RE);
    expect(m).not.toBeNull();
    expect(m[1]).toBe('harvest');
    expect(m[2]).toBe(other);
    expect(stderr).toContain(target);                       // the resolved target is also named
    expect(stderr).toMatch(new RegExp(`ruflo-kit harvest ${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)); // the escape-hatch command
    expect(stdout).toBe('');
    // The tool itself must NEVER have started — refusal happens before cd/exec.
    expect(stderr).not.toMatch(/\[aqe-harvest\] target:/);
  });

  it('bench --json <other-existing-dir> (flag-first) is refused, names both paths, spells out the escape hatch', () => {
    const { target, other, home } = freshWorld();
    const { code, stderr, stdout } = run(KIT, ['bench', '--json', other], { cwd: target, home, timeout: 15000 });
    expect(code).not.toBe(0);
    const m = stderr.match(REFUSAL_RE);
    expect(m).not.toBeNull();
    expect(m[1]).toBe('bench');
    expect(m[2]).toBe(other);
    expect(stderr).toContain(target);
    expect(stderr).toMatch(new RegExp(`ruflo-kit bench ${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(stdout).toBe('');
    expect(stderr).not.toMatch(/\[selfimprove-bench\] target:/); // tool never started
  });

  it('the refusal is nearly instant (proves it happens BEFORE the 12 real `ruflo hooks route` calls bench would otherwise make)', () => {
    const { target, other, home } = freshWorld();
    const started = Date.now();
    run(KIT, ['bench', '--json', other], { cwd: target, home, timeout: 15000 });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('B20: the critic\'s exact repro is closed — 2>/dev/null still yields nonzero exit AND zero bytes changed on disk', () => {
  it('harvest --status <other-dir> 2>/dev/null: nonzero exit, empty captured stream, ambient cwd byte-for-byte untouched', () => {
    const { target, other, home } = freshWorld();
    const before = snapshotTree(target);
    const { code, stdout } = run(KIT, ['harvest', '--status', other], { cwd: target, home, timeout: 15000, ignoreStderr: true });
    expect(code).not.toBe(0);           // machine-checkable even with stderr discarded
    expect(stdout).toBe('');            // nothing on the captured stream at all
    expect(snapshotTree(target)).toEqual(before); // the ambient cwd is provably untouched
  });

  it('bench --json <other-dir> 2>/dev/null: nonzero exit, empty captured stream, ambient cwd byte-for-byte untouched', () => {
    const { target, other, home } = freshWorld();
    const before = snapshotTree(target);
    const { code, stdout } = run(KIT, ['bench', '--json', other], { cwd: target, home, timeout: 15000, ignoreStderr: true });
    expect(code).not.toBe(0);
    expect(stdout).toBe('');
    expect(snapshotTree(target)).toEqual(before); // in particular: no .claude-flow/selfimprove-history.jsonl
  });
});

describe('B20: silence/non-refusal is mandatory in every non-divergent shape', () => {
  it('target-first (harvest <target> --status) is not refused, not noticed', () => {
    const { target, home } = freshWorld();
    const { stderr } = run(KIT, ['harvest', target, '--status'], { home, timeout: 15000 });
    expect(stderr).not.toMatch(REFUSAL_RE);
    expect(stderr).not.toMatch(NOTICE_RE);
  });

  it('target-first (bench <target> --json) is not refused, not noticed', () => {
    const { target, home } = freshWorld();
    const { stderr } = run(KIT, ['bench', target, '--json'], { home, timeout: 15000 });
    expect(stderr).not.toMatch(REFUSAL_RE);
    expect(stderr).not.toMatch(NOTICE_RE);
  });

  it('flag-only, no positional argument at all (harvest --status) is not refused, not noticed', () => {
    const { target, home } = freshWorld();
    const { stderr } = run(KIT, ['harvest', '--status'], { cwd: target, home, timeout: 15000 });
    expect(stderr).not.toMatch(REFUSAL_RE);
    expect(stderr).not.toMatch(NOTICE_RE);
  });

  it('dashboard --port N . where "." IS cwd (equals the resolved target) is not noticed — mirrors the task\'s literal "--port 3939 ." shape', async () => {
    const { target, home } = freshWorld();
    // Port 0 (OS-assigned free port), not the literal 3939 from the task's
    // example: the port NUMBER is irrelevant to this predicate (it only
    // reads argv shape and directory identity), and a fixed port risks a
    // flaky EADDRINUSE/TIME_WAIT race against other dashboard invocations
    // in this same file (observed directly during development).
    const out = await runDashboardBriefly(KIT, ['--port', '0', '.'], { home, cwd: target });
    expect(out).not.toMatch(NOTICE_RE);
  });

  it('a NONEXISTENT trailing path (harvest --status <bogus>) is not refused, not noticed — decision below', () => {
    const { target, base, home } = freshWorld();
    const bogus = path.join(base, 'does-not-exist-anywhere');
    expect(fs.existsSync(bogus)).toBe(false);
    const { stderr } = run(KIT, ['harvest', '--status', bogus], { cwd: target, home, timeout: 15000 });
    expect(stderr).not.toMatch(REFUSAL_RE);
    expect(stderr).not.toMatch(NOTICE_RE);
    // Decision + why: an existing directory is POSITIVE evidence the user
    // pointed at a real project; a nonexistent string is not — it could be
    // a typo aimed at the target, but it could just as easily be an
    // unrelated flag value (an output path, a label, anything) that was
    // never meant as a target at all. Firing (or worse, REFUSING) here
    // would trade a rare true positive for a routine false one on any flag
    // that happens to take a path-shaped value — exactly the failure mode
    // "silence is mandatory in the normal case" rules out, and it would be
    // far worse for a refusal than a notice (a false refusal blocks real
    // work outright). The existing-directory check is therefore the whole
    // predicate, not an incidental detail of it.
  });
});

describe('B20: teeth — neither the notice nor the refusal existed before this change', () => {
  it('the same dashboard divergence produces NO note under the pre-change (git HEAD) dispatcher', async () => {
    const { target, other, home } = freshWorld();
    const out = await runDashboardBriefly(OLD_KIT, ['--port', '0', other], { home, cwd: target });
    expect(out).not.toMatch(NOTICE_RE);
  });

  it('the same harvest divergence was NOT refused under the pre-change dispatcher — the tool actually STARTED with the wrong (ambient) target', () => {
    const { target, other, home } = freshWorld();
    const { code, stderr } = run(OLD_KIT, ['harvest', '--status', other], { cwd: target, home, timeout: 15000 });
    expect(stderr).not.toMatch(REFUSAL_RE);
    // The tool ran (proves the OLD dispatcher let it through) and used the
    // ambient cwd (`target`), exactly the silent-wrong-target bug B14/B20
    // exist to close — it then exits 1 for its OWN reason (no memory.db in
    // this throwaway target), which is why `code` alone can't distinguish
    // "refused" from "ran and failed"; the echoed target is what does.
    expect(stderr).toMatch(/\[aqe-harvest\] target:/);
    expect(toolResolvedTarget(stderr)).toBe(target);
    expect(code).not.toBe(0);
  });

  it('the same bench divergence was NOT refused under the pre-change dispatcher — it actually ran and WROTE selfimprove-history.jsonl into the ambient cwd', () => {
    const { target, other, home } = freshWorld();
    const before = snapshotTree(target);
    run(OLD_KIT, ['bench', '--json', other], { cwd: target, home, timeout: 15000 });
    const after = snapshotTree(target);
    expect(after).not.toEqual(before); // real mutation happened
    expect(fs.existsSync(path.join(target, '.claude-flow', 'selfimprove-history.jsonl'))).toBe(true);
  });
});

describe('B20: resolution is UNCHANGED in every NON-divergent case — before/after comparison of which directory the tool actually operates in', () => {
  // Each case below runs the identical (non-divergent) invocation through
  // OLD_KIT (pre-B20) and KIT (post-B20) and compares the TOOL's own
  // independent banner (not any dispatcher text) — proving the addition
  // only reacts to an ALREADY-genuine divergence and never shifts,
  // reorders, or otherwise changes resolution when there is none.
  it('target-first case (no divergence): identical resolved target old vs new', () => {
    const { target, home } = freshWorld();
    const oldRun = run(OLD_KIT, ['harvest', target, '--status'], { home, timeout: 15000 });
    const newRun = run(KIT, ['harvest', target, '--status'], { home, timeout: 15000 });
    const oldTgt = toolResolvedTarget(oldRun.stderr);
    const newTgt = toolResolvedTarget(newRun.stderr);
    expect(oldTgt).not.toBeNull();
    expect(newTgt).toBe(oldTgt);
    expect(newTgt).toBe(target);
  });

  it('flag-only case, no positional argument at all (no divergence): identical resolved target old vs new', () => {
    const { target, home } = freshWorld();
    const oldRun = run(OLD_KIT, ['harvest', '--status'], { cwd: target, home, timeout: 15000 });
    const newRun = run(KIT, ['harvest', '--status'], { cwd: target, home, timeout: 15000 });
    const oldTgt = toolResolvedTarget(oldRun.stderr);
    const newTgt = toolResolvedTarget(newRun.stderr);
    expect(oldTgt).not.toBeNull();
    expect(newTgt).toBe(oldTgt);
    expect(newTgt).toBe(target);
  });

  it('dashboard divergence case (notice only, never blocked): identical resolved target old vs new', async () => {
    const { target, other, home } = freshWorld();
    const oldOut = await runDashboardBriefly(OLD_KIT, ['--port', '0', other], { home, cwd: target });
    const newOut = await runDashboardBriefly(KIT, ['--port', '0', other], { home, cwd: target });
    const oldTgt = toolResolvedTarget(oldOut);
    const newTgt = toolResolvedTarget(newOut);
    expect(oldTgt).not.toBeNull();
    expect(newTgt).toBe(oldTgt);
    expect(newTgt).toBe(target);
  });

  it('"--port N ." case (dot == cwd, no divergence): identical resolved target old vs new', async () => {
    const { target, home } = freshWorld();
    const oldOut = await runDashboardBriefly(OLD_KIT, ['--port', '0', '.'], { home, cwd: target });
    const newOut = await runDashboardBriefly(KIT, ['--port', '0', '.'], { home, cwd: target });
    const oldTgt = toolResolvedTarget(oldOut);
    const newTgt = toolResolvedTarget(newOut);
    expect(oldTgt).not.toBeNull();
    expect(newTgt).toBe(oldTgt);
    expect(newTgt).toBe(target);
  });

  it('nonexistent-trailing-path case (no divergence): identical resolved target old vs new', () => {
    const { target, base, home } = freshWorld();
    const bogus = path.join(base, 'does-not-exist-anywhere');
    const oldRun = run(OLD_KIT, ['harvest', '--status', bogus], { cwd: target, home, timeout: 15000 });
    const newRun = run(KIT, ['harvest', '--status', bogus], { cwd: target, home, timeout: 15000 });
    const oldTgt = toolResolvedTarget(oldRun.stderr);
    const newTgt = toolResolvedTarget(newRun.stderr);
    expect(oldTgt).not.toBeNull();
    expect(newTgt).toBe(oldTgt);
    expect(newTgt).toBe(target);
  });
});
