/**
 * Tests for bin/ruflo-kit's VERB-SAFETY-V1 dispatcher guarantees (B7):
 *
 *  1. Every verb recognizes -h/--help and NEVER performs its real work when
 *     given it — regardless of where the flag appears, and regardless of
 *     whether the verb's own lib/*.sh script would have honored it.
 *  2. A downstream reader closing the pipe early (`| head -N`) must not kill
 *     the dispatcher (or anything it execs) via SIGPIPE.
 *  3. An unknown verb and a missing target argument both fail/behave
 *     predictably rather than doing something surprising.
 *
 * Field incident this guards against: `ruflo-kit upgrade --help` executed a
 * full global `npm install -g ruflo` (Phase A) because upgrade.sh never
 * checked KIT_WANT_HELP; piping that through `head -50` then SIGPIPE-killed
 * the in-flight native build, leaving a broken global install.
 */
'use strict';

const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KIT = path.resolve(__dirname, '..', 'bin', 'ruflo-kit');

const worlds = [];
afterEach(() => {
  while (worlds.length) {
    const w = worlds.pop();
    try { fs.rmSync(w, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// A throwaway, empty target + HOME per call — if a verb's --help ever slips
// past the guard and does real work, this is where it would land.
function freshWorld() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verbsafety-')));
  worlds.push(base);
  const target = path.join(base, 'target');
  fs.mkdirSync(target, { recursive: true });
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { base, target, home };
}

function run(args, { cwd, home, timeout = 20000 } = {}) {
  const r = spawnSync('bash', [KIT, ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, HOME: home || os.tmpdir() },
    timeout,
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, signal: r.signal };
}

// `dashboard` is a foreground server (Ctrl-C to stop) — spawnSync would hang
// forever, so start it async, capture output for a short window, then kill
// it. Returns the captured stdout+stderr text.
function runDashboardBriefly(args, { home, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn('bash', [KIT, 'dashboard', ...args], {
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

// Every file under `dir`, relative paths, sorted — used to prove a --help
// call left a target directory byte-for-byte untouched.
function snapshotTree(dir) {
  const out = [];
  (function walk(d, prefix) {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p, rel);
      else out.push(`${rel}:${st.size}`);
    }
  })(dir, '');
  return out;
}

// Verbs that take a <target> argument. `realWorkMarker` is a string that only
// ever appears in that verb's REAL (non-help) first output — used as a second,
// independent signal alongside "the target directory was not touched".
const TARGET_VERBS = [
  { verb: 'setup', realWorkMarker: 'prerequisites' },
  { verb: 'adopt', realWorkMarker: null },
  { verb: 'snapshot', realWorkMarker: 'MEMORY-PRESERVE-PROOF-V1 receipt' },
  { verb: 'status', realWorkMarker: null },
  { verb: 'sync', realWorkMarker: null },
  { verb: 'proof', realWorkMarker: null },
  { verb: 'init', realWorkMarker: null },
  { verb: 'fix-ruflo', realWorkMarker: null },
  { verb: 'fix-aqe', realWorkMarker: null },
  { verb: 'fix-brain', realWorkMarker: null },
  { verb: 'fix-statusbar', realWorkMarker: null },
  { verb: 'session', realWorkMarker: null },
  { verb: 'health', realWorkMarker: null },
  { verb: 'upgrade', realWorkMarker: 'Pre-flight' },
  { verb: 'verify-learning', realWorkMarker: null },
  { verb: 'fix-learning', realWorkMarker: null },
  { verb: 'bench', realWorkMarker: null },
  { verb: 'dashboard', realWorkMarker: null },
  { verb: 'harvest', realWorkMarker: null },
];

describe('VERB-SAFETY-V1: --help never performs real work', () => {
  it.each(TARGET_VERBS)('$verb --help exits 0, prints usage, mutates nothing', ({ verb, realWorkMarker }) => {
    const { target, home } = freshWorld();
    const before = snapshotTree(target);
    const { code, out } = run([verb, target, '--help'], { home });
    expect(code).toBe(0);
    expect(out.toLowerCase()).toMatch(/usage: ruflo-kit/);
    expect(snapshotTree(target)).toEqual(before); // byte-for-byte untouched
    if (realWorkMarker) expect(out).not.toContain(realWorkMarker);
  });

  it.each(TARGET_VERBS)('$verb <target> -h (flag AFTER the target) is honored the same way', ({ verb }) => {
    const { target, home } = freshWorld();
    const before = snapshotTree(target);
    const { code, out } = run([verb, target, '-h'], { home });
    expect(code).toBe(0);
    expect(out.toLowerCase()).toMatch(/usage: ruflo-kit/);
    expect(snapshotTree(target)).toEqual(before);
  });

  it('upgrade --help never touches the machine\'s global npm state (no Phase A banner, no daemon stop)', () => {
    const { target, home } = freshWorld();
    const { code, out } = run(['upgrade', target, '--help'], { home });
    expect(code).toBe(0);
    expect(out).not.toMatch(/ruflo 3\.6\.12/); // upgrade.sh's real, version-specific banner
    expect(out).not.toMatch(/Daemon stop \(release npx cache handles\)/); // real header string
    expect(out).not.toMatch(/npm view ruflo version/); // upgrade.sh's real pre-flight registry check
  });

  it('self-update --help never runs git pull on the kit clone', () => {
    const { home } = freshWorld();
    const { code, out } = run(['self-update', '--help'], { home });
    expect(code).toBe(0);
    expect(out.toLowerCase()).toMatch(/usage: ruflo-kit self-update/);
    expect(out).not.toMatch(/Updating kit at/);
  });

  it('version --help prints usage instead of the real sha/version probe', () => {
    const { home } = freshWorld();
    const { code, out } = run(['version', '--help'], { home });
    expect(code).toBe(0);
    expect(out.toLowerCase()).toMatch(/usage: ruflo-kit version/);
    expect(out).not.toMatch(/\(global\)/); // real version's own output shape
  });
});

describe('VERB-SAFETY-V1: unknown verb / missing target fail predictably', () => {
  it('an unknown verb prints "unknown command" and exits 1 (not a crash, not silently OK)', () => {
    const { home } = freshWorld();
    const { code, out } = run(['bogus-verb-xyz'], { home });
    expect(code).toBe(1);
    expect(out).toMatch(/unknown command 'bogus-verb-xyz'/);
  });

  it('an unknown verb + --help still reports "unknown command" (help does not mask an invalid verb)', () => {
    const { home } = freshWorld();
    const { code, out } = run(['bogus-verb-xyz', '--help'], { home });
    expect(code).toBe(1);
    expect(out).toMatch(/unknown command/);
  });

  it('a read-only verb with NO target argument defaults to cwd rather than crashing', () => {
    const { target, home } = freshWorld();
    // status is read-only, so this is safe to actually run (not --help) —
    // it must resolve $(pwd) as the documented default and exit cleanly.
    const { code, signal } = run(['status', '--json'], { cwd: target, home, timeout: 15000 });
    expect(signal).toBeNull(); // no crash/timeout-kill
    expect(typeof code).toBe('number');
  });
});

describe('VERB-SAFETY-V1 round 2 (B7b): target-resolution safety', () => {
  // Field incident: something of the shape `<verb> help` (e.g. `init help`) —
  // "help" typed bare, no dashes — was NOT recognized as a help request, so
  // lib/common.sh's kit_resolve() silently accepted "help" AS THE TARGET
  // PATH. For init/setup (the only two verbs without a kit_require_target
  // guard, since they must be able to bootstrap a brand-new codebase), a
  // REAL project tree got written to ./help/: .agentic-qe/, .claude/,
  // .claude-flow/, .swarm/, .mcp.json, agentdb.db, ruvector.db. Confirmed via
  // sandbox repro even under --dry-run (lib/init.sh:36 does an unconditional
  // `mkdir -p "$TARGET_DIR"` before its own dry-run gate).

  it('help sync shows sync-specific usage (first-class `help <verb>` form)', () => {
    const { home } = freshWorld();
    const { code, out } = run(['help', 'sync'], { home });
    expect(code).toBe(0);
    expect(out).toMatch(/Usage: ruflo-kit sync <target>/);
  });

  it('help (bare) still prints the full command list', () => {
    const { home } = freshWorld();
    const { code, out } = run(['help'], { home });
    expect(code).toBe(0);
    expect(out).toMatch(/Commands:/);
  });

  it('help <unknown-verb> falls back to the full command list, no crash', () => {
    const { home } = freshWorld();
    const { code, out } = run(['help', 'totally-not-a-verb'], { home });
    expect(code).toBe(0);
    expect(out).toMatch(/Commands:/);
  });

  // The actual field incident, reproduced exactly: `init help` / `setup help`
  // — "help" landing in the TARGET slot of an already-recognized verb.
  it.each(['init', 'setup'])(
    '%s help creates NOTHING at ./help — refused, not silently bootstrapped',
    (verb) => {
      const { base, home } = freshWorld();
      const helpDir = path.join(base, 'help');
      const { code, out } = run([verb, 'help'], { cwd: base, home, timeout: 30000 });
      expect(code).not.toBe(0);
      expect(out).toMatch(/does not exist as a directory/);
      expect(fs.existsSync(helpDir)).toBe(false); // the exact phantom-project path from the incident
    },
  );

  it.each(['init', 'setup'])(
    '%s help --dry-run ALSO creates nothing (dry-run must not bypass the refusal)',
    (verb) => {
      const { base, home } = freshWorld();
      const helpDir = path.join(base, 'help');
      const { code } = run([verb, 'help', '--dry-run'], { cwd: base, home, timeout: 30000 });
      expect(code).not.toBe(0);
      expect(fs.existsSync(helpDir)).toBe(false);
    },
  );

  // A typo'd nonexistent target for verbs that were ALREADY guarded by
  // kit_require_target inside their own script (sync, fix-ruflo) — the
  // dispatcher-level check now fails faster and with a clearer message, and
  // this proves the guard is uniform across verbs, not special-cased to
  // init/setup only.
  it.each(['sync', 'fix-ruflo'])(
    '%s <typo> (nonexistent relative target) is refused, creates nothing',
    (verb) => {
      const { base, home } = freshWorld();
      const typoDir = path.join(base, 'sycn-target-typo');
      const { code, out } = run([verb, 'sycn-target-typo'], { cwd: base, home, timeout: 30000 });
      expect(code).not.toBe(0);
      expect(out).toMatch(/does not exist as a directory/);
      expect(out).toMatch(/never creates one/);
      expect(fs.existsSync(typoDir)).toBe(false);
    },
  );

  it('an existing directory target needs no opt-in and is unaffected by the guard', () => {
    const { target, home } = freshWorld();
    const { code, signal } = run(['status', target, '--json'], { home, timeout: 15000 });
    expect(signal).toBeNull();
    expect(typeof code).toBe('number'); // reaches the real (read-only) script, not refused
  });

  it('an absolute path to a nonexistent target is always allowed (init --dry-run)', () => {
    const { base, home } = freshWorld();
    const absNew = path.join(base, 'brand-new-abs');
    const { code, out } = run(['init', absNew, '--dry-run'], { home, timeout: 30000 });
    expect(code).toBe(0);
    expect(out).toContain(`target: ${absNew}`);
  });

  it('--new-target opts a relative nonexistent path into init (explicit, not implicit)', () => {
    const { base, home } = freshWorld();
    const relNew = path.join(base, 'brand-new-rel');
    const { code, out } = run(['init', 'brand-new-rel', '--new-target', '--dry-run'], { cwd: base, home, timeout: 30000 });
    expect(code).toBe(0);
    expect(out).toContain(`target: ${relNew}`);
  });

  it('--new-target does NOT opt a nonexistent target into a non-bootstrap verb (sync)', () => {
    const { base, home } = freshWorld();
    const relNew = path.join(base, 'brand-new-rel');
    const { code, out } = run(['sync', 'brand-new-rel', '--new-target'], { cwd: base, home, timeout: 30000 });
    expect(code).not.toBe(0);
    expect(out).toMatch(/does not exist as a directory/);
    expect(fs.existsSync(relNew)).toBe(false);
  });

  // Reserved/ambiguous-word audit (round 2 requirement #3).
  it('a bare "version" as a target is refused the same as "help" (generic fix, not word-specific)', () => {
    const { base, home } = freshWorld();
    const { code, out } = run(['sync', 'version'], { cwd: base, home, timeout: 30000 });
    expect(code).not.toBe(0);
    expect(out).toMatch(/does not exist as a directory/);
    expect(fs.existsSync(path.join(base, 'version'))).toBe(false);
  });

  it('a stray "-v" as a target argument is refused rather than silently becoming the target', () => {
    const { base, home } = freshWorld();
    const { code, out } = run(['sync', '-v'], { cwd: base, home, timeout: 30000 });
    expect(code).not.toBe(0);
    expect(out).toMatch(/does not exist as a directory/);
    expect(fs.existsSync(path.join(base, '-v'))).toBe(false);
  });

  it('a lone "-" as a target argument is refused rather than silently becoming the target', () => {
    const { base, home } = freshWorld();
    const { code, out } = run(['sync', '-'], { cwd: base, home, timeout: 30000 });
    expect(code).not.toBe(0);
    expect(out).toMatch(/does not exist as a directory/);
    expect(fs.existsSync(path.join(base, '-'))).toBe(false);
  });

  it('--version as a trailing flag is treated as an unrecognized flag, not a target (matches kit_resolve)', () => {
    const { target, home } = freshWorld();
    // A real flag-shaped token must still resolve the target normally and
    // reach the underlying (read-only) script rather than being refused.
    const { code, signal } = run(['status', target, '--version'], { home, timeout: 15000 });
    expect(signal).toBeNull();
    expect(typeof code).toBe('number');
  });

  it('an empty-string target argument falls back to the default (matches kit_resolve, not refused)', () => {
    const { target, home } = freshWorld();
    const { code, signal } = run(['status', '', '--json'], { cwd: target, home, timeout: 15000 });
    expect(signal).toBeNull();
    expect(typeof code).toBe('number');
  });
});

describe('VERB-SAFETY-V1 round 3: bench/dashboard/harvest do not use kit_resolve\'s scan', () => {
  // Regression found by the round-2 critic: bench/dashboard/harvest bypass
  // kit_resolve entirely and have their OWN, simpler rule (only $1 is ever
  // considered the target; anything else defaults to cwd) — already written
  // inline at each call site before round 2 ever existed. Round 2's guard
  // used the kit_resolve-STYLE multi-arg scan for these three too, which
  // finds the first non-flag token ANYWHERE in the args. For
  // `dashboard --port 3939 .`, that scan hit "3939" (dashboard.cjs's own
  // `process.argv.indexOf('--port')` consumes it as the port value — a scan
  // of the whole argv, not a positional walk) and misread it as the target,
  // falsely refusing a command that worked before the guard existed.
  //
  // The fix (bin/ruflo-kit's _kit_firstarg_is_target/_kit_firstarg_resolve)
  // makes the guard and the REAL cd-target/shift logic call the exact same
  // one predicate — not a second, separately-maintained "flags that take a
  // value" list, which is exactly the kind of duplicated knowledge that
  // caused this regression in the first place (a new flag on any of these
  // three tools could silently reopen the same hole if the guard had its own
  // list to fall out of sync with).

  it('dashboard <target> --port N (target first) starts and picks the given target', async () => {
    const { target, home } = freshWorld();
    const out = await runDashboardBriefly([target, '--port', '0'], { home });
    expect(out).not.toMatch(/does not exist as a directory/);
    expect(out).toMatch(/ruflo-kit dashboard listening on/);
    expect(out).toContain(`target: ${target}`);
  });

  it('dashboard --port N <target> (flag first — the exact critic repro) is NOT falsely refused', async () => {
    const { target, home } = freshWorld();
    // Pin cwd to the isolated target: with a leading flag, $1 is never a
    // target candidate (matches the real firstarg rule), so this shape
    // resolves to cwd — pinning it keeps the test hermetic instead of
    // accidentally exercising the real repo as a fallback.
    const out = await runDashboardBriefly(['--port', '0', target], { home, cwd: target });
    expect(out).not.toMatch(/does not exist as a directory/);
    expect(out).toMatch(/ruflo-kit dashboard listening on/);
  });

  it('dashboard --port N . (flag first, "." target, run FROM the target — critic\'s literal repro) picks that directory', async () => {
    const { target, home } = freshWorld();
    const out = await runDashboardBriefly(['--port', '0', '.'], { home, cwd: target });
    expect(out).not.toMatch(/does not exist as a directory/);
    expect(out).toContain(`target: ${target}`);
  });

  it('dashboard <nonexistent-RELATIVE-typo> --port N (target first, but bogus) is still refused', async () => {
    // A RELATIVE typo, not absolute — an absolute path is unconditionally
    // allowed by design (unambiguous intent), so the refusal case must use a
    // bare relative word resolved against a known cwd, same as round 2.
    const { base, home } = freshWorld();
    const out = await runDashboardBriefly(['totally-bogus-dashboard-target', '--port', '0'], { home, cwd: base });
    expect(out).toMatch(/does not exist as a directory/);
    expect(fs.existsSync(path.join(base, 'totally-bogus-dashboard-target'))).toBe(false);
  });

  it.each([
    ['bench', 'target-first', (t) => [t, '--json']],
    ['bench', 'flag-first', (t) => ['--json', t]],
    ['harvest', 'target-first', (t) => [t]],
  ])('%s (%s order) is not falsely refused for an existing target', (verb, _label, buildArgs) => {
    const { target, home } = freshWorld();
    // cwd pinned to the isolated target: the flag-first case falls back to
    // cwd (matches the real firstarg rule) and must never fall through to
    // whatever directory the test runner itself happens to be in.
    const { out } = run([verb, ...buildArgs(target)], { cwd: target, home, timeout: 15000 });
    expect(out).not.toMatch(/does not exist as a directory/);
  });

  it('bench/harvest still refuse a genuinely nonexistent RELATIVE target (guard not disabled, just fixed)', () => {
    const { base, home } = freshWorld();
    const relBogus = 'nonexistent-bench-target';
    const benchResult = run(['bench', relBogus], { cwd: base, home, timeout: 15000 });
    expect(benchResult.out).toMatch(/does not exist as a directory/);
    expect(fs.existsSync(path.join(base, relBogus))).toBe(false);
    const harvestResult = run(['harvest', relBogus], { cwd: base, home, timeout: 15000 });
    expect(harvestResult.out).toMatch(/does not exist as a directory/);
    expect(fs.existsSync(path.join(base, relBogus))).toBe(false);
  });

  // Round-2 cases must still hold after the round-3 refactor (regression
  // guard on the refactor itself, not just the new behavior).
  it('init help / setup help still refuse and create nothing (round 2 unaffected by round 3)', () => {
    const { base, home } = freshWorld();
    for (const verb of ['init', 'setup']) {
      const helpDir = path.join(base, 'help');
      const { code, out } = run([verb, 'help'], { cwd: base, home, timeout: 30000 });
      expect(code).not.toBe(0);
      expect(out).toMatch(/does not exist as a directory/);
      expect(fs.existsSync(helpDir)).toBe(false);
    }
  });

  it('-v, lone -, --version, and empty-string still resolve identically to kit_resolve (round 2 unaffected)', () => {
    const { base, target, home } = freshWorld();
    expect(run(['sync', '-v'], { cwd: base, home, timeout: 30000 }).out).toMatch(/does not exist as a directory/);
    expect(run(['sync', '-'], { cwd: base, home, timeout: 30000 }).out).toMatch(/does not exist as a directory/);
    const versionFlagResult = run(['status', target, '--version'], { home, timeout: 15000 });
    expect(versionFlagResult.out).not.toMatch(/does not exist as a directory/);
    const emptyResult = run(['status', '', '--json'], { cwd: target, home, timeout: 15000 });
    expect(emptyResult.out).not.toMatch(/does not exist as a directory/);
  });

  it('--new-target is still honored only by init/setup, not by bench/dashboard/harvest', () => {
    const { base, home } = freshWorld();
    const relNew = path.join(base, 'brand-new-rel');
    const { out } = run(['bench', 'brand-new-rel', '--new-target'], { cwd: base, home, timeout: 15000 });
    expect(out).toMatch(/does not exist as a directory/);
    expect(fs.existsSync(relNew)).toBe(false);
  });
});

describe('VERB-SAFETY-V1: pipe-safety (SIGPIPE)', () => {
  it('upgrade --help | head -1 does not SIGPIPE the dispatcher (PIPESTATUS[0] must not be 141)', () => {
    const { target, home } = freshWorld();
    const script = `set -o pipefail; bash "${KIT}" upgrade "${target}" --help | head -1; echo "RC=\${PIPESTATUS[0]}"`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 30000 });
    expect(r.status).toBe(0);
    // 141 == 128+SIGPIPE — the exact failure class from commit 3cff08e's
    // sibling bug and this incident's field report. Must be 0 (help printed
    // fully before head closed) — never a signal-death code.
    expect(r.stdout).toMatch(/RC=0/);
    expect(snapshotTree(target)).toEqual([]); // still untouched
  });

  it('bare invocation (long usage text) piped through head -1 does not hang or SIGPIPE-fail', () => {
    const { home } = freshWorld();
    const script = `set -o pipefail; bash "${KIT}" | head -1; echo "RC=\${PIPESTATUS[0]}"`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 30000 });
    expect(r.signal).toBeNull();
    expect(r.stdout).toMatch(/RC=0/);
  });
});
