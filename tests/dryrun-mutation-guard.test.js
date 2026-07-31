/**
 * Tests for B11 (dryrun-mutates): a --dry-run must never mutate the
 * filesystem. Confirmed live by the B7 critic: `sync --dry-run` against a
 * fresh target physically created `.agentic-qe/`, `.claude/` (incl.
 * proven-config.json + helpers/), and `.claude-flow/` — because two sites ran
 * a filesystem mutation BEFORE their own dry-run gate:
 *
 *   - lib/init.sh:36        `mkdir -p "$TARGET_DIR"` (unconditional bootstrap)
 *   - lib/fix-aqe.sh:98     `mkdir -p "$CLAUDE_HELPERS"` (ahead of the
 *                           per-file dry-run checks in the loop below it)
 *
 * The full-file survey for this fix (grep for mkdir/touch/cp/mv/rm/sed -i/cat>
 * across every lib/*.sh, cross-referenced against each file's own DRY_RUN
 * gating) found two further sites of the exact same family:
 *
 *   - lib/init.sh:121       `mkdir -p "$RUFLO_MODEL_CACHE"` (ONNX vault dir,
 *                           created unconditionally during the prereq step)
 *   - lib/fix-statusbar.sh:40   `mkdir -p .claude/helpers` (unconditional, at
 *                           the very top of the script, ~130 lines before its
 *                           first DRY_RUN check)
 *   - lib/fix-statusbar.sh:~1259  `cat > .claude/helpers/statusline-v3.cjs`
 *                           (a real file-content write, completely
 *                           unconditional — this one was previously MASKED by
 *                           the :40 mkdir bug silently creating its parent
 *                           directory; fixing :40 alone would have turned a
 *                           silent write into a hard "No such file or
 *                           directory" error, so both had to be fixed together)
 *   - lib/fix-statusbar.sh Step 3  a `node - <<'NODE' ... fs.writeFileSync(...)`
 *                           heredoc that rewrites .claude/settings.json's
 *                           statusLine.command unconditionally — caught by
 *                           this suite's own full-content-hash comparison
 *                           (a spot-check on directory listing alone would
 *                           have missed it, since no NEW file appears)
 *   - lib/fix-statusbar.sh Step 4  `npm uninstall ...` / `rm -rf
 *                           node_modules/@claude-flow/plugin-agentic-qe`,
 *                           also unconditional (inert on the fixtures used
 *                           elsewhere in this file since they carry neither
 *                           the package.json entry nor the node_modules dir;
 *                           covered by its own dedicated fixture below)
 *
 * All four are fixed in the same commit under test. Each fix follows the
 * convention already used correctly elsewhere in the kit (see e.g.
 * lib/snapshot.sh's dry-run branch, or lib/upgrade.sh's per-step
 * `[[ "$DRY_RUN" -eq 1 ]] ... info "[dry-run] Would: ..."` gating): a dry-run
 * only ever PRINTS what it would do.
 *
 * Harness: hermetic. Fake `ruflo`/`aqe` stub binaries on PATH (no network, no
 * real installs) so the real, unmodified lib/init.sh, lib/fix-aqe.sh, and
 * lib/fix-statusbar.sh run end-to-end quickly and deterministically. Each
 * assertion is a full recursive listing (or content hash) of the relevant
 * directory taken before and after the run — not a spot check.
 *
 * Teeth: every "fixed" assertion is paired with a "TEETH" test that runs the
 * exact pre-fix script content (`git show <PRE_FIX_REF>:lib/X.sh` — a FIXED
 * commit, not HEAD; see PRE_FIX_REF's own comment below for why a moving
 * HEAD silently turns this into a tautology the instant the fix is
 * committed) against the same fixture shape and asserts the OLD defect (the
 * mutation happens). A pre-fix
 * script must run from inside the kit's real lib/ directory (never a copied
 * "fakelib") so its `KIT_DIR`/`KIT_ASSETS` resolution (common.sh derives both
 * from the running script's own path) still finds the real assets/ tree —
 * otherwise steps that legitimately depend on assets/ existing would skip for
 * an unrelated reason and the teeth test would give a false negative. The
 * pre-fix copy is written to a dotfile temp script inside the real lib/,
 * executed, then removed — it is never left behind and never committed.
 */
'use strict';

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const INIT_SH = path.join(REPO, 'lib', 'init.sh');
const FIX_AQE_SH = path.join(REPO, 'lib', 'fix-aqe.sh');
const FIX_STATUSBAR_SH = path.join(REPO, 'lib', 'fix-statusbar.sh');
const SESSION_INIT_SH = path.join(REPO, 'lib', 'session-init.sh');

let work, fakebin, fakehome;

function writeExec(p, body) {
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
}

function walk(d) {
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
}

function snapshot(d) {
  // Full recursive listing, not a spot check — path + content sha256 for
  // every file under d, so both "extra file appeared" and "existing file's
  // content changed in place" are caught.
  return walk(d).map((f) => {
    const rel = path.relative(d, f);
    const sha = require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    return `${rel}  ${sha}`;
  }).sort();
}

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'b11-dryrun-'));
  fakebin = path.join(work, 'bin');
  fakehome = path.join(work, 'home');
  fs.mkdirSync(fakebin, { recursive: true });
  fs.mkdirSync(fakehome, { recursive: true });

  // fake ruflo/aqe: hermetic, no network. `--version` returns a fixed string
  // (so the prereq step reports "installed" and never falls back to
  // `npx -y ruflo@latest`, which would try the network); every other
  // subcommand is a silent no-op success (status/detection calls throughout
  // init.sh's activation table treat empty output as "not yet active" and
  // continue — never a hard failure, and critically never a file write).
  writeExec(path.join(fakebin, 'ruflo'), [
    '#!/usr/bin/env bash',
    'case "${1:-}" in',
    '  --version) echo "ruflo v9.9.9" ;;',
    '  *) exit 0 ;;',
    'esac',
  ].join('\n') + '\n');
  writeExec(path.join(fakebin, 'aqe'), [
    '#!/usr/bin/env bash',
    'case "${1:-}" in',
    '  --version) echo "aqe v9.9.9" ;;',
    '  *) exit 0 ;;',
    'esac',
  ].join('\n') + '\n');
  // Same hermetic shape, for the session-init.sh suite below (its Step 3b/
  // agentdb-schema checks call `agentdb`; --version answers the presence
  // check, everything else is a silent no-op — never a file write).
  writeExec(path.join(fakebin, 'agentdb'), [
    '#!/usr/bin/env bash',
    'case "${1:-}" in',
    '  --version) echo "agentdb v9.9.9" ;;',
    '  *) exit 0 ;;',
    'esac',
  ].join('\n') + '\n');
});

afterAll(() => {
  if (work) fs.rmSync(work, { recursive: true, force: true });
});

function runScript(scriptPath, args, extraEnv) {
  const r = spawnSync('bash', [scriptPath, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      HOME: fakehome,
      PATH: `${fakebin}:${process.env.PATH}`,
      TMPDIR: work,
      RUFLO_DAEMON_AUTOSTART: '0',
      ...extraEnv,
    },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), signal: r.signal };
}

// PRE_FIX_REF: the specific commit these B11 pre-fix reconstructions read
// from — NOT HEAD. HEAD is a MOVING target: the instant this session's fixes
// land in a commit, `git show HEAD:lib/<name>` starts returning the FIXED
// code, and every "TEETH: pre-fix ... DOES <bad thing>" assertion below
// starts comparing fixed-to-fixed and fails — not because the fix broke, but
// because the test's own premise (HEAD = old code) silently stopped being
// true. This is not hypothetical: it happened for real when Waves 4+5 landed
// as commit ac124a8 — this exact suite went from 19/19 to 12/19, all 7
// failures in this one helper, nowhere else. `0561b7c` is Patch 71, the
// commit immediately BEFORE ac124a8 (and therefore before every fix this
// file's B11 suite exercises) — a fixed point in history that stays the
// correct "before" baseline no matter how many further commits land on top.
// If you are tempted to "modernise" this back to HEAD: don't — that
// reintroduces the exact bug this comment documents.
//
// The OTHER valid pattern, used by withPreFixSessionInit()/
// withPreFixSessionInitDaemon() further below in this same file: when the
// pre-fix body can be derived by splicing a known-old snippet back INTO a
// fresh copy of the CURRENT file (rather than fetching a whole historical
// file from git), that splice is commit-stable by construction — it never
// consults git at all, so there is no ref to keep in sync. That pattern was
// worked out mid-session for the session-init.sh case specifically because
// HEAD predated the whole session and was already the wrong baseline for a
// different reason; it just was not retrofitted onto this older helper at
// the time. Prefer it when the pre-fix body is a small, literal, known-in-
// advance change to today's file; use a pinned SHA (this constant) when
// reconstructing the pre-fix body requires the historical FILE, not just a
// known snippet reversed.
const PRE_FIX_REF = '0561b7c';

// Writes `git show <PRE_FIX_REF>:lib/<name>` into a dotfile temp script
// INSIDE the real lib/ directory (so KIT_DIR/KIT_ASSETS resolve against the
// real kit, exactly like the post-fix script does), runs it, then removes
// the temp script unconditionally (even on assertion failure, via
// try/finally at each call site).
function withPreFixScript(name, fn) {
  const relName = `.pretest-b11-${name}`;
  const dst = path.join(REPO, 'lib', relName);
  const content = execFileSync('git', ['show', `${PRE_FIX_REF}:lib/${name}`], { cwd: REPO, encoding: 'utf8' });
  fs.writeFileSync(dst, content);
  fs.chmodSync(dst, 0o755);
  try {
    return fn(dst);
  } finally {
    fs.rmSync(dst, { force: true });
  }
}

describe('B11 dryrun-mutates: lib/init.sh (mkdir -p "$TARGET_DIR")', () => {
  it('POST-FIX: --dry-run against a NONEXISTENT target does not create it', () => {
    const parent = fs.mkdtempSync(path.join(work, 'init-postfix-'));
    const target = path.join(parent, 'fresh-target');
    const before = snapshot(parent);

    const r = runScript(INIT_SH, [target, '--dry-run']);

    expect(fs.existsSync(target)).toBe(false);
    expect(snapshot(parent)).toEqual(before); // nothing else in the parent changed either
    expect(r.out).toMatch(/\[dry-run\] would create target directory/);
  });

  it('POST-FIX: --dry-run against an EXISTING empty target creates no new files', () => {
    const target = fs.mkdtempSync(path.join(work, 'init-postfix-existing-'));
    const before = snapshot(target);

    runScript(INIT_SH, [target, '--dry-run']);

    expect(snapshot(target)).toEqual(before);
  });

  it('TEETH: pre-fix init.sh --dry-run against a NONEXISTENT target DOES create it', () => {
    withPreFixScript('init.sh', (preFixScript) => {
      const parent = fs.mkdtempSync(path.join(work, 'init-prefix-'));
      const target = path.join(parent, 'fresh-target');

      expect(fs.existsSync(target)).toBe(false); // sanity: didn't exist before
      runScript(preFixScript, [target, '--dry-run']);
      // This is the confirmed pre-fix defect: the directory gets created even
      // though --dry-run was passed.
      expect(fs.existsSync(target)).toBe(true);
    });
  }, 60000);
});

describe('B11 dryrun-mutates: lib/init.sh (mkdir -p "$RUFLO_MODEL_CACHE")', () => {
  it('POST-FIX: --dry-run does not create the ONNX model vault directory', () => {
    const target = fs.mkdtempSync(path.join(work, 'init-vault-postfix-'));
    const vaultParent = fs.mkdtempSync(path.join(work, 'vault-postfix-'));
    const vault = path.join(vaultParent, 'ruflo-models'); // does not exist yet

    const r = runScript(INIT_SH, [target, '--dry-run'], { RUFLO_MODEL_CACHE: vault });

    expect(fs.existsSync(vault)).toBe(false);
    expect(r.out).toMatch(/\[dry-run\] would create ONNX model vault/);
  });

  it('TEETH: pre-fix init.sh --dry-run DOES create the ONNX model vault directory', () => {
    withPreFixScript('init.sh', (preFixScript) => {
      const target = fs.mkdtempSync(path.join(work, 'init-vault-prefix-'));
      const vaultParent = fs.mkdtempSync(path.join(work, 'vault-prefix-'));
      const vault = path.join(vaultParent, 'ruflo-models');

      expect(fs.existsSync(vault)).toBe(false);
      runScript(preFixScript, [target, '--dry-run'], { RUFLO_MODEL_CACHE: vault });
      expect(fs.existsSync(vault)).toBe(true);
    });
  }, 60000);
});

// Fixture matching fix-aqe.sh's/fix-statusbar.sh's own precondition
// (kit_require_target): the target directory must already exist, with a
// minimal .claude/settings.json, but WITHOUT .claude/helpers yet — exactly
// the shape the B7 critic reproduced against a freshly `init`-ed target
// before .claude/helpers had been populated.
function makeBareTarget(dir) {
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({
    hooks: {}, permissions: { allow: [] }, statusLine: { type: 'command', command: 'node x' },
  }, null, 2) + '\n');
}

describe('B11 dryrun-mutates: lib/fix-aqe.sh (mkdir -p "$CLAUDE_HELPERS")', () => {
  it('POST-FIX: --dry-run against a target lacking .claude/helpers does not create it', () => {
    const target = fs.mkdtempSync(path.join(work, 'fixaqe-postfix-'));
    makeBareTarget(target);
    const before = snapshot(target);

    const r = runScript(FIX_AQE_SH, [target, '--dry-run']);

    expect(fs.existsSync(path.join(target, '.claude', 'helpers'))).toBe(false);
    expect(snapshot(target)).toEqual(before);
    expect(r.out).toMatch(/\[dry-run\] would create directory:.*\.claude\/helpers/);
  });

  it('TEETH: pre-fix fix-aqe.sh --dry-run DOES create .claude/helpers', () => {
    withPreFixScript('fix-aqe.sh', (preFixScript) => {
      const target = fs.mkdtempSync(path.join(work, 'fixaqe-prefix-'));
      makeBareTarget(target);

      expect(fs.existsSync(path.join(target, '.claude', 'helpers'))).toBe(false);
      runScript(preFixScript, [target, '--dry-run']);
      expect(fs.existsSync(path.join(target, '.claude', 'helpers'))).toBe(true);
    });
  }, 60000);
});

describe('B11 dryrun-mutates: lib/fix-statusbar.sh (mkdir -p .claude/helpers, top of script)', () => {
  it('POST-FIX: --dry-run against a target lacking .claude/helpers does not create it', () => {
    const target = fs.mkdtempSync(path.join(work, 'fixsb-postfix-'));
    makeBareTarget(target);
    const before = snapshot(target);

    const r = runScript(FIX_STATUSBAR_SH, [target, '--dry-run']);

    expect(fs.existsSync(path.join(target, '.claude', 'helpers'))).toBe(false);
    expect(snapshot(target)).toEqual(before);
    expect(r.out).toMatch(/\[dry-run\] would create directory: \.claude\/helpers/);
  });

  it('TEETH: pre-fix fix-statusbar.sh --dry-run DOES create .claude/helpers', () => {
    withPreFixScript('fix-statusbar.sh', (preFixScript) => {
      const target = fs.mkdtempSync(path.join(work, 'fixsb-prefix-'));
      makeBareTarget(target);

      expect(fs.existsSync(path.join(target, '.claude', 'helpers'))).toBe(false);
      runScript(preFixScript, [target, '--dry-run']);
      expect(fs.existsSync(path.join(target, '.claude', 'helpers'))).toBe(true);
    });
  }, 60000);
});

describe('B11 dryrun-mutates: lib/fix-statusbar.sh (cat > .claude/helpers/statusline-v3.cjs)', () => {
  // This site was masked by the :40 mkdir bug (it silently created the parent
  // dir the heredoc wrote into) until that was fixed — then it surfaced as a
  // hard "No such file or directory" write failure under --dry-run, proving
  // it had never itself checked DRY_RUN. Reproduce it directly, independent
  // of the :40 fix, by pre-creating .claude/helpers so the heredoc's `cat >`
  // has a valid parent directory to write into either way.
  it('POST-FIX: --dry-run does not write statusline-v3.cjs', () => {
    const target = fs.mkdtempSync(path.join(work, 'fixsb-v3-postfix-'));
    makeBareTarget(target);
    fs.mkdirSync(path.join(target, '.claude', 'helpers'), { recursive: true });
    const v3Path = path.join(target, '.claude', 'helpers', 'statusline-v3.cjs');

    const r = runScript(FIX_STATUSBAR_SH, [target, '--dry-run']);

    expect(fs.existsSync(v3Path)).toBe(false);
    expect(r.out).toMatch(/\[dry-run\] would write dual fallback: \.claude\/helpers\/statusline-v3\.cjs/);
  });

  it('TEETH: pre-fix fix-statusbar.sh --dry-run DOES write statusline-v3.cjs', () => {
    withPreFixScript('fix-statusbar.sh', (preFixScript) => {
      const target = fs.mkdtempSync(path.join(work, 'fixsb-v3-prefix-'));
      makeBareTarget(target);
      fs.mkdirSync(path.join(target, '.claude', 'helpers'), { recursive: true });
      const v3Path = path.join(target, '.claude', 'helpers', 'statusline-v3.cjs');

      expect(fs.existsSync(v3Path)).toBe(false);
      runScript(preFixScript, [target, '--dry-run']);
      expect(fs.existsSync(v3Path)).toBe(true);
    });
  }, 60000);
});

describe('B11 dryrun-mutates: lib/fix-statusbar.sh Step 3 (.claude/settings.json statusLine rewrite)', () => {
  // Caught by the full-content-hash comparison in the "top of script mkdir"
  // block above (no NEW file appears — settings.json is rewritten IN PLACE,
  // so a directory-listing-only check would have missed it). Isolated here
  // with its own dedicated before/after content comparison for a direct,
  // unambiguous regression signal on this specific site.
  it('POST-FIX: --dry-run does not rewrite .claude/settings.json', () => {
    const target = fs.mkdtempSync(path.join(work, 'fixsb-settings-postfix-'));
    makeBareTarget(target);
    fs.mkdirSync(path.join(target, '.claude', 'helpers'), { recursive: true });
    const settingsPath = path.join(target, '.claude', 'settings.json');
    const before = fs.readFileSync(settingsPath, 'utf8');

    const r = runScript(FIX_STATUSBAR_SH, [target, '--dry-run']);

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
    expect(r.out).toMatch(/\[dry-run\] would patch \.claude\/settings\.json statusLine\.command/);
  });

  it('TEETH: pre-fix fix-statusbar.sh --dry-run DOES rewrite .claude/settings.json', () => {
    withPreFixScript('fix-statusbar.sh', (preFixScript) => {
      const target = fs.mkdtempSync(path.join(work, 'fixsb-settings-prefix-'));
      makeBareTarget(target);
      fs.mkdirSync(path.join(target, '.claude', 'helpers'), { recursive: true });
      const settingsPath = path.join(target, '.claude', 'settings.json');
      const before = fs.readFileSync(settingsPath, 'utf8');

      runScript(preFixScript, [target, '--dry-run']);

      expect(fs.readFileSync(settingsPath, 'utf8')).not.toBe(before);
    });
  }, 60000);
});

describe('B11 dryrun-mutates: lib/fix-statusbar.sh Step 4 (legacy plugin uninstall/rm -rf)', () => {
  function makeTargetWithLegacyPlugin(dir) {
    makeBareTarget(dir);
    fs.mkdirSync(path.join(dir, '.claude', 'helpers'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules', '@claude-flow', 'plugin-agentic-qe'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'node_modules', '@claude-flow', 'plugin-agentic-qe', 'package.json'),
      '{"name":"@claude-flow/plugin-agentic-qe"}\n',
    );
  }

  it('POST-FIX: --dry-run does not remove the stray legacy plugin dir', () => {
    const target = fs.mkdtempSync(path.join(work, 'fixsb-legacy-postfix-'));
    makeTargetWithLegacyPlugin(target);
    const pluginDir = path.join(target, 'node_modules', '@claude-flow', 'plugin-agentic-qe');

    const r = runScript(FIX_STATUSBAR_SH, [target, '--dry-run']);

    expect(fs.existsSync(pluginDir)).toBe(true);
    expect(r.out).toMatch(/\[dry-run\] would remove stray node_modules\/@claude-flow\/plugin-agentic-qe/);
  });

  it('TEETH: pre-fix fix-statusbar.sh --dry-run DOES remove the stray legacy plugin dir', () => {
    withPreFixScript('fix-statusbar.sh', (preFixScript) => {
      const target = fs.mkdtempSync(path.join(work, 'fixsb-legacy-prefix-'));
      makeTargetWithLegacyPlugin(target);
      const pluginDir = path.join(target, 'node_modules', '@claude-flow', 'plugin-agentic-qe');

      expect(fs.existsSync(pluginDir)).toBe(true);
      runScript(preFixScript, [target, '--dry-run']);
      expect(fs.existsSync(pluginDir)).toBe(false);
    });
  }, 60000);
});

// ── lib/session-init.sh: the SAME class of bug (DAEMON-HINT-SCOPE-V1 round 5,
// coordinator-confirmed live) — Steps 1/2/3b called fix-ruflo.sh/fix-
// statusbar.sh directly with no run()-style dry-run gate, AND Step 9 called
// verify-learning.sh without forwarding --dry-run (verify-learning.sh
// already supports it — see VL-DRYRUN-FORWARD-V1 in lib/sync.sh, the
// identical fix for the identical reason: a separate bash process can't
// inherit $DRY_RUN, so the flag has to be passed explicitly). Confirmed live
// before this fix: `bin/ruflo-kit session <fresh-target> --dry-run` left 4
// real artifacts in a fully hermetic fixture (.agentic-qe/, and — depending
// on the exact fixture — the fix-ruflo.sh/fix-statusbar.sh/agentdb-schema
// side effects); on the real dev machine (non-hermetic, real global tools)
// it was 14.
//
// git show HEAD:lib/session-init.sh is NOT usable here as the "pre-fix"
// baseline the way withPreFixScript() uses it for init.sh/fix-aqe.sh/
// fix-statusbar.sh above: HEAD predates this entire session's work, so it
// would reconstruct a much older, unrelated version rather than isolating
// THIS regression. Instead, withPreFixSessionInit() splices the exact 4
// changes back out of a fresh copy of the CURRENT script (verified byte-for-
// byte identical to the real pre-fix source at the time these fixes were
// written), staged the same way withPreFixScript() stages its own pre-fix
// copies: as a dotfile temp script INSIDE the real lib/ directory (so
// KIT_DIR/KIT_LIB/KIT_ASSETS resolve against the real kit), removed
// unconditionally in a finally block.
function withPreFixSessionInit(fn) {
  const relName = '.pretest-b24r5-session-init.sh';
  const dst = path.join(REPO, 'lib', relName);
  let cur = fs.readFileSync(SESSION_INIT_SH, 'utf8');

  const runBlock = cur.match(/\n# DRY-RUN-SESSION-V1:[\s\S]*?\nrun\(\) \{\n(?:.*\n)*?\}\n/);
  if (!runBlock) throw new Error('DRY-RUN-SESSION-V1 run() block not found to splice out');
  cur = cur.replace(runBlock[0], '\n');

  const dryflagBlock = cur.match(/\n# _dryflag: forwarded to verify-learning\.sh[\s\S]*?\n_dryflag=\(\)\n\[\[ "\$DRY_RUN" -eq 1 \]\] && _dryflag=\(--dry-run\)\n/);
  if (!dryflagBlock) throw new Error('_dryflag block not found to splice out');
  cur = cur.replace(dryflagBlock[0], '\n');

  const step1Old = 'if [[ -f "$KIT_LIB/fix-ruflo.sh" ]]; then\n  if [[ "$DRY_RUN" -eq 1 ]]; then\n    run bash "$KIT_LIB/fix-ruflo.sh" "$TARGET_DIR"\n  else\n    # Run fix-ruflo.sh silently, only show fixes\n    FIXES=$(bash "$KIT_LIB/fix-ruflo.sh" "$TARGET_DIR" 2>&1 | grep -c "✓" || true)\n    FIXES=${FIXES:-0}\n    pass "fix-ruflo.sh completed ($FIXES checks passed)"\n  fi\nelse\n  warn "fix-ruflo.sh not found"\n  ((ERRORS++)) || true\nfi';
  const step1New = 'if [[ -f "$KIT_LIB/fix-ruflo.sh" ]]; then\n  # Run fix-ruflo.sh silently, only show fixes\n  FIXES=$(bash "$KIT_LIB/fix-ruflo.sh" "$TARGET_DIR" 2>&1 | grep -c "✓" || true)\n  FIXES=${FIXES:-0}\n  pass "fix-ruflo.sh completed ($FIXES checks passed)"\nelse\n  warn "fix-ruflo.sh not found"\n  ((ERRORS++)) || true\nfi';
  if (!cur.includes(step1Old)) throw new Error('Step 1 block not found to splice out');
  cur = cur.replace(step1Old, step1New);

  const step2Old = 'if [[ -f "$KIT_LIB/fix-statusbar.sh" ]]; then\n  if [[ "$DRY_RUN" -eq 1 ]]; then\n    run bash "$KIT_LIB/fix-statusbar.sh" "$TARGET_DIR"\n  else\n    STATUS_FIXES=$(bash "$KIT_LIB/fix-statusbar.sh" "$TARGET_DIR" 2>&1 | grep -c "✓" || true)\n    STATUS_FIXES=${STATUS_FIXES:-0}\n    pass "fix-statusbar.sh completed ($STATUS_FIXES checks passed)"\n  fi\nelse\n  warn "fix-statusbar.sh not found"\n  ((ERRORS++)) || true';
  const step2New = 'if [[ -f "$KIT_LIB/fix-statusbar.sh" ]]; then\n  STATUS_FIXES=$(bash "$KIT_LIB/fix-statusbar.sh" "$TARGET_DIR" 2>&1 | grep -c "✓" || true)\n  STATUS_FIXES=${STATUS_FIXES:-0}\n  pass "fix-statusbar.sh completed ($STATUS_FIXES checks passed)"\nelse\n  warn "fix-statusbar.sh not found"\n  ((ERRORS++)) || true';
  if (!cur.includes(step2Old)) throw new Error('Step 2 block not found to splice out');
  cur = cur.replace(step2Old, step2New);

  const step3bOld = 'warn "Global nested agentdb is $NESTED_VER (expected $EXPECT_AGENTDB) — 7 controllers will be dormant"\n    if [[ "$DRY_RUN" -eq 1 ]]; then\n      run bash "$KIT_LIB/fix-ruflo.sh" "$TARGET_DIR"\n    else\n      info "Re-applying via fix-ruflo.sh (Step 3b)..."\n      bash "$KIT_LIB/fix-ruflo.sh" "$TARGET_DIR" 2>&1 | grep -E "3b/11|controller|alpha\\.10" | head -5\n    fi\n    ((ERRORS++)) || true';
  const step3bNew = 'warn "Global nested agentdb is $NESTED_VER (expected $EXPECT_AGENTDB) — 7 controllers will be dormant"\n    info "Re-applying via fix-ruflo.sh (Step 3b)..."\n    bash "$KIT_LIB/fix-ruflo.sh" "$TARGET_DIR" 2>&1 | grep -E "3b/11|controller|alpha\\.10" | head -5\n    ((ERRORS++)) || true';
  if (!cur.includes(step3bOld)) throw new Error('Step 3b block not found to splice out');
  cur = cur.replace(step3bOld, step3bNew);

  const vlOld = 'VL_JSON="$(bash "$KIT_LIB/verify-learning.sh" "$TARGET_DIR" --json ${_dryflag[@]+"${_dryflag[@]}"} 2>/dev/null | tail -1)"';
  const vlNew = 'VL_JSON="$(bash "$KIT_LIB/verify-learning.sh" "$TARGET_DIR" --json 2>/dev/null | tail -1)"';
  if (!cur.includes(vlOld)) throw new Error('verify-learning call not found to splice out');
  cur = cur.replace(vlOld, vlNew);

  fs.writeFileSync(dst, cur);
  fs.chmodSync(dst, 0o755);
  try {
    return fn(dst);
  } finally {
    fs.rmSync(dst, { force: true });
  }
}

describe('B24-round-5 dryrun-mutates: lib/session-init.sh (fix-ruflo/fix-statusbar/verify-learning forwarding)', () => {
  it('POST-FIX: --dry-run against a fresh target leaves it completely empty', () => {
    const target = fs.mkdtempSync(path.join(work, 'session-postfix-'));
    const before = snapshot(target);

    const r = runScript(SESSION_INIT_SH, [target, '--dry-run']);

    expect(snapshot(target)).toEqual(before); // byte-identical, not a count
    expect(r.out).toMatch(/\[dry-run\] bash .*fix-ruflo\.sh/);
    expect(r.out).toMatch(/\[dry-run\] bash .*fix-statusbar\.sh/);
  });

  it('TEETH: pre-fix session-init.sh --dry-run DOES leave real artifacts behind', () => {
    withPreFixSessionInit((preFixScript) => {
      const target = fs.mkdtempSync(path.join(work, 'session-prefix-'));
      const before = snapshot(target);

      runScript(preFixScript, [target, '--dry-run']);

      // This is the confirmed pre-fix defect: real artifacts appear even
      // though --dry-run was passed. Assert on the full snapshot changing,
      // not a specific filename — the exact set depends on which of the two
      // sub-scripts' effects survive this hermetic fixture, and the point is
      // "something changed under --dry-run", which must never be true.
      expect(snapshot(target)).not.toEqual(before);
    });
  }, 60000);
});

// ── lib/session-init.sh: DAEMON-HINT-SCOPE-V1 round 6 (coordinator-reopened
// after declaring round 5 the last item — different severity class). Step 5's
// `ruflo daemon start` / `ruflo daemon trigger` (RUFLO_DAEMON_MODE=auto/once)
// were NOT gated on $DRY_RUN at all, so `session --dry-run` with
// RUFLO_DAEMON_MODE=auto would spawn a REAL, billed background daemon —
// unlike every other residual accepted this session (a missed advisory tag,
// an imprecise comment), this one is a live process with a real bill, not a
// file or a claim, so it gets fixed rather than documented.
//
// A daemon is a PROCESS, not a file — snapshot()-based assertions (used
// above for the artifact leaks) cannot prove one was or wasn't spawned, so
// this suite asserts by pgrep instead, exactly as requested. Safety: a
// dedicated fake `ruflo` intercepts `daemon start`/`daemon trigger` via PATH
// (real ruflo is never reached — this is not a race, it's normal PATH
// resolution) and, instead of exiting immediately, sleeps briefly so a
// concurrent pgrep can observe it while it runs, before self-terminating.
// Nothing here ever touches real daemon infrastructure (no launchd, no
// `ruflo` binary invocation reaches past the fake), and the marker string
// polled for is the fake binary's own mkdtemp'd path — unique per test run,
// so it can never coincide with a real process on the host (this session's
// own investigation found a real stray daemon, PID 29640, for an unrelated
// project; that PID's argv does not and cannot contain this test's tmpdir
// path). Cleanup runs in a finally block regardless of assertion outcome,
// on top of the fake process's own 4s self-termination as a second layer.
function mkDaemonFakeBin() {
  const dir = fs.mkdtempSync(path.join(work, 'daemon-fake-'));
  writeExec(path.join(dir, 'ruflo'), [
    '#!/usr/bin/env bash',
    'case "${1:-} ${2:-}" in',
    '  "daemon start"|"daemon trigger")',
    '    sleep 4',
    '    exit 0',
    '    ;;',
    'esac',
    'case "${1:-}" in',
    '  --version) echo "ruflo v9.9.9" ;;',
    '  *) exit 0 ;;',
    'esac',
  ].join('\n') + '\n');
  return { dir, marker: path.join(dir, 'ruflo daemon') };
}

// Runs `scriptPath args...` ASYNCHRONOUSLY (spawnSync would block for the
// full 4s sleep before returning, by which time the fake process has already
// self-terminated — there would be nothing left to pgrep) and polls
// `pgrep -f marker` every 200ms until the child exits. Returns whether the
// marker was EVER observed, not just at one instant.
function runAsyncPollDaemon(scriptPath, args, extraEnv, marker) {
  return new Promise((resolve) => {
    const proc = require('child_process').spawn('bash', [scriptPath, ...args], {
      env: { ...process.env, HOME: fakehome, PATH: `${fakebin}:${process.env.PATH}`, TMPDIR: work, ...extraEnv },
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    let sawDaemon = false;
    const poll = setInterval(() => {
      const r = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim().length > 0) sawDaemon = true;
    }, 150);
    proc.on('close', (code) => {
      clearInterval(poll);
      // One final check between the child exiting and us checking — the 4s
      // sleep comfortably outlives the whole script, so this is belt-and-
      // suspenders, not load-bearing.
      const r = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim().length > 0) sawDaemon = true;
      resolve({ sawDaemon, out, code });
    });
  });
}

// Reverses ONLY the round-6 daemon-gate change (leaves round-5's fixes
// intact) — the minimal, precise pre-fix baseline for THIS regression,
// spliced from the current script (git show HEAD predates this session, same
// reasoning as withPreFixSessionInit above), staged as a dotfile inside the
// real lib/ so KIT_DIR/KIT_LIB resolve correctly, removed unconditionally.
// NOTE: async, and AWAITS fn(dst) before cleanup — fn() here runs an async
// pgrep-polling body (runAsyncPollDaemon), unlike withPreFixSessionInit()
// above whose callback is synchronous. A plain try/finally without awaiting
// an async fn would run `finally` (deleting the reconstructed script)
// immediately after fn() returns its pending promise, not after it settles —
// deleting the script out from under the still-running bash child. Caught
// this exact way: the first version of this test asserted false instead of
// true against a splice already confirmed correct by hand.
async function withPreFixSessionInitDaemon(fn) {
  const relName = '.pretest-b24r6-session-init.sh';
  const dst = path.join(REPO, 'lib', relName);
  let cur = fs.readFileSync(SESSION_INIT_SH, 'utf8');

  const autoOld = 'case "$RUFLO_DAEMON_MODE" in\n  auto)\n    if [[ "$DAEMON_RUNNING" -eq 1 ]]; then\n      pass "daemon already running"\n    elif [[ "$DRY_RUN" -eq 1 ]]; then\n      # DAEMON-HINT-SCOPE-V1 round 6 (coordinator-reopened): this call was\n      # ungated — RUFLO_DAEMON_MODE=auto + --dry-run would spawn a REAL,\n      # billed daemon in direct contradiction of a flag whose entire meaning\n      # is "do nothing." Every other residual accepted this session was a\n      # missed advisory tag or a narrow misclassification; this one is a\n      # billed background process, hence gated rather than left as a\n      # documented gap. Only reachable when an operator has already opted\n      # into RUFLO_DAEMON_MODE=auto for REAL runs — --dry-run must still\n      # mean "do nothing" on top of that opt-in, not override it.\n      run ruflo daemon start\n    else\n      info "daemon stopped — starting (RUFLO_DAEMON_MODE=auto, AQE_PROJECT_ROOT pinned)"\n      if ruflo daemon start >/tmp/ruflo-session-daemon-start.log 2>&1; then\n        pass "daemon started"\n      else\n        warn "ruflo daemon start failed (see /tmp/ruflo-session-daemon-start.log)"\n        ((ERRORS++)) || true\n      fi\n    fi\n    ;;\n  once)\n    if [[ "$DRY_RUN" -eq 1 ]]; then\n      run ruflo daemon trigger -w audit\n    else\n      info "single worker pass (RUFLO_DAEMON_MODE=once) — no persistent loop"\n      if ruflo daemon trigger -w audit >/tmp/ruflo-session-daemon-trigger.log 2>&1; then\n        pass "worker pass complete"\n      else\n        warn "daemon trigger failed (see /tmp/ruflo-session-daemon-trigger.log)"\n      fi\n    fi\n    ;;';
  const autoNew = 'case "$RUFLO_DAEMON_MODE" in\n  auto)\n    if [[ "$DAEMON_RUNNING" -eq 1 ]]; then\n      pass "daemon already running"\n    else\n      info "daemon stopped — starting (RUFLO_DAEMON_MODE=auto, AQE_PROJECT_ROOT pinned)"\n      if ruflo daemon start >/tmp/ruflo-session-daemon-start.log 2>&1; then\n        pass "daemon started"\n      else\n        warn "ruflo daemon start failed (see /tmp/ruflo-session-daemon-start.log)"\n        ((ERRORS++)) || true\n      fi\n    fi\n    ;;\n  once)\n    info "single worker pass (RUFLO_DAEMON_MODE=once) — no persistent loop"\n    if ruflo daemon trigger -w audit >/tmp/ruflo-session-daemon-trigger.log 2>&1; then\n      pass "worker pass complete"\n    else\n      warn "daemon trigger failed (see /tmp/ruflo-session-daemon-trigger.log)"\n    fi\n    ;;';
  if (!cur.includes(autoOld)) throw new Error('daemon-mode case block not found to splice out');
  cur = cur.replace(autoOld, autoNew);

  fs.writeFileSync(dst, cur);
  fs.chmodSync(dst, 0o755);
  try {
    return await fn(dst);
  } finally {
    fs.rmSync(dst, { force: true });
  }
}

describe('B24-round-6 dryrun-mutates: lib/session-init.sh (RUFLO_DAEMON_MODE=auto daemon start/trigger)', () => {
  it('POST-FIX: --dry-run with RUFLO_DAEMON_MODE=auto never spawns a daemon process (asserted by pgrep, not by exit code or artifact)', async () => {
    const { dir: daemonBin, marker } = mkDaemonFakeBin();
    const target = fs.mkdtempSync(path.join(work, 'session-daemon-postfix-'));
    try {
      const { sawDaemon, out } = await runAsyncPollDaemon(
        SESSION_INIT_SH, [target, '--dry-run'],
        { PATH: `${daemonBin}:${fakebin}:${process.env.PATH}`, RUFLO_DAEMON_MODE: 'auto' },
        marker,
      );
      expect(sawDaemon).toBe(false);
      expect(out).toMatch(/\[dry-run\] ruflo daemon start/);
    } finally {
      spawnSync('pkill', ['-f', marker]); // belt-and-suspenders; the fake also self-exits after 4s
    }
  }, 20000);

  it('TEETH: pre-fix session-init.sh DOES spawn a real (fake-intercepted) daemon process under --dry-run + RUFLO_DAEMON_MODE=auto', async () => {
    await withPreFixSessionInitDaemon(async (preFixScript) => {
      const { dir: daemonBin, marker } = mkDaemonFakeBin();
      const target = fs.mkdtempSync(path.join(work, 'session-daemon-prefix-'));
      try {
        const { sawDaemon } = await runAsyncPollDaemon(
          preFixScript, [target, '--dry-run'],
          { PATH: `${daemonBin}:${fakebin}:${process.env.PATH}`, RUFLO_DAEMON_MODE: 'auto' },
          marker,
        );
        // This is the confirmed pre-fix defect: a daemon-shaped process gets
        // spawned even though --dry-run was passed.
        expect(sawDaemon).toBe(true);
      } finally {
        spawnSync('pkill', ['-f', marker]);
      }
    });
  }, 20000);
});
