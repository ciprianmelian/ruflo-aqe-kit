/**
 * Tests for lib/common.sh find_stray_aqe_dirs() — FIND-PRUNE-V1 (issue #8).
 *
 * The pre-fix implementation excluded node_modules with a POST-MATCH filter —
 * `-not -path` against the glob STAR/node_modules/STAR (written out here because
 * the literal glob would close this block comment; see PRE_FIX_IMPL below for the
 * verbatim baseline).
 *
 * `-not -path` drops entries from the RESULTS; it does not stop the walk. find
 * still descended through every node_modules in full. On a monorepo with several
 * worktrees each carrying independent node_modules that is millions of stat()
 * calls — the reporter measured >10 minutes on a WSL2 9p mount, wedged in
 * uninterruptible D-state so it could not even be Ctrl-C'd. The fix is a real
 * prune, which cuts the subtree before descending.
 *
 * WHY THIS IS HARD TO TEST: the fix is a pure performance change. Old and new
 * return byte-identical result sets by design, so no assertion on the OUTPUT can
 * ever have teeth. Wall-clock assertions would have teeth but flake.
 *
 * So the teeth come from a deterministic traversal probe instead: an unreadable
 * (mode 000) directory planted inside node_modules. If find descends, it cannot
 * read the dir and emits "Permission denied" to stderr — one line per unreadable
 * dir. If find prunes, it never touches them and stderr stays empty. That is a
 * direct, non-timing, exactly-countable observation of whether the walk happened.
 * Verified to behave identically on BSD find (macOS) and GNU findutils 4.10.0.
 *
 * Every probe here is paired with a POSITIVE CONTROL, because "stderr was empty"
 * and "returned nothing" are both satisfied by a broken harness:
 *   - the canary itself is proven live by an unreadable dir OUTSIDE node_modules,
 *     which MUST still produce the error under the fixed code;
 *   - the exclusion tests are paired with dirs that MUST be returned;
 *   - the whole suite is re-run against a literal PRE-FIX fixture, which MUST
 *     pass the parity tests and MUST FAIL the prune tests. If it ever passes
 *     them, this file has stopped testing anything.
 *
 * TEETH: the pre-fix baseline is an embedded literal (PRE_FIX_IMPL below), not a
 * git SHA and never `HEAD` — nothing to expire, nothing to rewrite.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const COMMON_SH = path.join(REPO, 'lib', 'common.sh');

// ---- extract the REAL shell functions, verbatim -----------------------------
// Not a reimplementation: if find_stray_aqe_dirs changes, these tests follow it.
// Quote-state tracking (not a naive /^\}/ scan) so an embedded line that is
// exactly "}" inside a quoted script cannot truncate the body — a truncated
// body is a bash syntax error, which every "expected no output" assertion here
// would otherwise have happily accepted as a pass.
function extractShellFn(file, name) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
  if (start < 0) throw new Error(`could not find ${name}() in ${file}`);
  let inSingleQuote = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (i > start && !inSingleQuote && line === '}') return lines.slice(start, i + 1).join('\n');
    if (((line.match(/'/g) || []).length) % 2 === 1) inSingleQuote = !inSingleQuote;
  }
  throw new Error(`unterminated ${name}() in ${file}`);
}

const IS_STRAY_FN = extractShellFn(COMMON_SH, 'is_stray_aqe_dir');
const FIND_STRAY_FN = extractShellFn(COMMON_SH, 'find_stray_aqe_dirs');

/**
 * Pre-fix baseline, embedded literally. This is the exact body that shipped
 * before FIND-PRUNE-V1 — the `-not -path` post-match filter.
 */
const PRE_FIX_IMPL = [
  'find_stray_aqe_dirs() {',
  '  local target="$1" d',
  '  while IFS= read -r d; do',
  '    [[ "$d" == "$target/.agentic-qe" ]] && continue',
  '    is_stray_aqe_dir "$d" && echo "$d"',
  "  done < <(find \"$target\" -type d -name '.agentic-qe' \\",
  "             -not -path '*/node_modules/*' \\",
  "             -not -path '*/agentic-qe-src/*' 2>/dev/null)",
  '}',
].join('\n');

/**
 * Unmask the inner find's stderr so the traversal canary is observable.
 * The real source suppresses it with 2>/dev/null; strip exactly that one
 * occurrence and assert the strip happened, so a silent no-op transformation
 * cannot leave the canary permanently blind (and thus permanently "passing").
 */
function unmaskStderr(fnText) {
  const occurrences = (fnText.match(/2>\/dev\/null/g) || []).length;
  if (occurrences !== 1) {
    throw new Error(`expected exactly 1 "2>/dev/null" in find_stray_aqe_dirs, found ${occurrences}`);
  }
  return fnText.replace('2>/dev/null', '');
}

const tmps = [];
function mkTmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'find-prune-'));
  tmps.push(d);
  return d;
}

function runFn(fnText, target) {
  const script = `set -u\n${IS_STRAY_FN}\n${fnText}\nfind_stray_aqe_dirs ${JSON.stringify(target)}\n`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return {
    rc: r.status,
    out: (r.stdout || '').split('\n').filter(Boolean),
    err: (r.stderr || '').split('\n').filter(Boolean),
  };
}

/** A .agentic-qe that is_stray_aqe_dir() classifies as a stray: RVF payload, no canonical marker. */
function mkStray(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.rvf'), 'x');
}

/**
 * The full correctness fixture. Returns { target, expected } where `expected`
 * is the exact set of paths find_stray_aqe_dirs must print, relative to target.
 */
function buildParityFixture() {
  const t = mkTmp();
  const J = (...p) => path.join(t, ...p);

  // MUST be returned (positive controls — a harness that returns nothing fails these)
  mkStray(J('packages', 'app', 'deep', 'nest', '.agentic-qe')); // nested deep
  mkStray(J('a dir with spaces', '.agentic-qe'));               // path containing spaces
  mkStray(J('realtarget', '.agentic-qe'));                      // symlink target (see below)
  mkStray(J('xnode_modules', '.agentic-qe'));                   // NOT node_modules — must survive the prune

  // MUST NOT be returned
  mkStray(J('.agentic-qe'));                                    // canonical root, skipped by design
  mkStray(J('node_modules', 'somepkg', '.agentic-qe'));         // inside root node_modules
  mkStray(J('packages', 'app', 'node_modules', 'x', '.agentic-qe')); // inside nested node_modules
  mkStray(J('vendor', 'agentic-qe-src', '.agentic-qe'));        // inside vendored source clone
  mkStray(J('vendor', 'agentic-qe-src', 'sub', 'deep', '.agentic-qe')); // deeper inside it

  // NOT strays by classification (guards is_stray_aqe_dir, not the prune)
  mkStray(J('hasmarker', '.agentic-qe'));
  fs.writeFileSync(J('hasmarker', '.agentic-qe', 'memory.db'), 'x'); // canonical marker => real root
  fs.mkdirSync(J('norvf', '.agentic-qe'), { recursive: true });      // no RVF payload

  // a symlinked dir: find must not follow it, so realtarget appears exactly once
  fs.symlinkSync(J('realtarget'), J('linked'));

  const expected = [
    path.join(t, 'a dir with spaces', '.agentic-qe'),
    path.join(t, 'packages', 'app', 'deep', 'nest', '.agentic-qe'),
    path.join(t, 'realtarget', '.agentic-qe'),
    path.join(t, 'xnode_modules', '.agentic-qe'),
  ].sort();

  return { target: t, expected };
}

const BLOCKED_INSIDE = 5; // number of unreadable dirs planted inside node_modules

/**
 * Traversal-canary fixture. `blockedOutside` plants an unreadable dir OUTSIDE
 * any pruned subtree — the positive control that proves the canary is live.
 */
function buildCanaryFixture({ blockedOutside }) {
  const t = mkTmp();
  const J = (...p) => path.join(t, ...p);
  mkStray(J('keep', '.agentic-qe'));                 // something real to find
  const blocked = [];
  for (let i = 0; i < BLOCKED_INSIDE; i++) {
    const d = J('node_modules', `pkg${i}`, 'blocked');
    fs.mkdirSync(d, { recursive: true });
    blocked.push(d);
  }
  if (blockedOutside) {
    const d = J('outside', 'blocked');
    fs.mkdirSync(d, { recursive: true });
    blocked.push(d);
  }
  for (const d of blocked) fs.chmodSync(d, 0o000);
  return { target: t, blocked };
}

function countPermissionDenied(lines) {
  return lines.filter((l) => /Permission denied/i.test(l)).length;
}

afterAll(() => {
  for (const d of tmps) {
    // restore modes first or rm -rf cannot descend
    try {
      spawnSync('chmod', ['-R', 'u+rwX', d]);
    } catch (e) {}
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch (e) {}
  }
});

describe('FIND-PRUNE-V1: extraction guards', () => {
  it('extracts a syntactically valid find_stray_aqe_dirs from lib/common.sh', () => {
    expect(FIND_STRAY_FN.startsWith('find_stray_aqe_dirs() {')).toBe(true);
    expect(FIND_STRAY_FN.endsWith('\n}')).toBe(true);
    expect(FIND_STRAY_FN).toContain('find "$target"');
    const r = spawnSync('bash', ['-n'], { input: `${IS_STRAY_FN}\n${FIND_STRAY_FN}\n`, encoding: 'utf8' });
    expect(r.status).toBe(0);   // a truncated extraction is a syntax error, not a silent pass
  });

  it('the embedded pre-fix fixture is itself valid bash and uses the post-match filter', () => {
    const r = spawnSync('bash', ['-n'], { input: `${IS_STRAY_FN}\n${PRE_FIX_IMPL}\n`, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(PRE_FIX_IMPL).toContain("-not -path '*/node_modules/*'");
    expect(PRE_FIX_IMPL).not.toContain('-prune');
  });
});

describe('FIND-PRUNE-V1: result parity (the fix must not change WHAT is found)', () => {
  it('returns exactly the expected stray set', () => {
    const { target, expected } = buildParityFixture();
    const r = runFn(FIND_STRAY_FN, target);
    expect(r.out.sort()).toEqual(expected);
    expect(r.out.length).toBe(4);           // positive control: the harness really does find things
  });

  it('agrees path-for-path AND in exit status with the pre-fix implementation', () => {
    const { target } = buildParityFixture();
    const now = runFn(FIND_STRAY_FN, target);
    const before = runFn(PRE_FIX_IMPL, target);
    expect(before.out.length).toBeGreaterThan(0);   // positive control: baseline isn't vacuously empty
    expect(now.out.sort()).toEqual(before.out.sort());
    // NOTE: the status is whatever the loop's final `is_stray_aqe_dir && echo`
    // left behind, so it is 1 whenever the last dir walked was not a stray.
    // That quirk predates FIND-PRUNE-V1 and every caller consumes this through
    // process substitution, which discards it. Asserted as PARITY, not as 0, so
    // the test pins "the fix changed nothing here" without blessing rc==0.
    expect(now.rc).toBe(before.rc);
  });

  it('excludes .agentic-qe nested inside node_modules and agentic-qe-src', () => {
    const { target } = buildParityFixture();
    const out = runFn(FIND_STRAY_FN, target).out;
    expect(out.some((p) => p.includes(`${path.sep}node_modules${path.sep}`))).toBe(false);
    expect(out.some((p) => p.includes(`${path.sep}agentic-qe-src${path.sep}`))).toBe(false);
    // positive control for the two negatives above: those dirs DO exist and ARE strays,
    // so they were excluded by the prune, not by never having been created.
    expect(fs.existsSync(path.join(target, 'node_modules', 'somepkg', '.agentic-qe', 'store.rvf'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'vendor', 'agentic-qe-src', '.agentic-qe', 'store.rvf'))).toBe(true);
  });

  it('does not over-match: a dir merely ENDING in node_modules is still searched', () => {
    const { target } = buildParityFixture();
    const out = runFn(FIND_STRAY_FN, target);
    expect(out.out).toContain(path.join(target, 'xnode_modules', '.agentic-qe'));
  });

  it('skips the canonical root and non-stray .agentic-qe dirs', () => {
    const { target } = buildParityFixture();
    const out = runFn(FIND_STRAY_FN, target).out;
    expect(out).not.toContain(path.join(target, '.agentic-qe'));        // canonical root
    expect(out).not.toContain(path.join(target, 'hasmarker', '.agentic-qe')); // has memory.db
    expect(out).not.toContain(path.join(target, 'norvf', '.agentic-qe'));     // no RVF payload
  });
});

describe('FIND-PRUNE-V1: traversal (the teeth)', () => {
  it('CONTROL: the unreadable-dir canary is live — a blocked dir outside node_modules still errors', () => {
    // If this fails, every "stderr was empty" assertion below is meaningless
    // (running as root, or a find that ignores unreadable dirs).
    const { target } = buildCanaryFixture({ blockedOutside: true });
    const r = runFn(unmaskStderr(FIND_STRAY_FN), target);
    expect(countPermissionDenied(r.err)).toBe(1);
    expect(r.out).toContain(path.join(target, 'keep', '.agentic-qe')); // and it still works
  });

  it('never descends into node_modules: zero permission errors from the pruned subtree', () => {
    const { target } = buildCanaryFixture({ blockedOutside: false });
    const r = runFn(unmaskStderr(FIND_STRAY_FN), target);
    expect(countPermissionDenied(r.err)).toBe(0);
    expect(r.err).toEqual([]);
    expect(r.out).toContain(path.join(target, 'keep', '.agentic-qe')); // positive control
  });

  it('TEETH: the pre-fix implementation DOES descend, hitting every blocked dir', () => {
    // This is the assertion that fails against the pre-fix function and passes
    // against the fixed one. If it ever reports 0, the prune has been reverted
    // or this probe has gone blind.
    const { target } = buildCanaryFixture({ blockedOutside: false });
    const before = runFn(unmaskStderr(PRE_FIX_IMPL), target);
    expect(countPermissionDenied(before.err)).toBe(BLOCKED_INSIDE);

    const now = runFn(unmaskStderr(FIND_STRAY_FN), target);
    expect(countPermissionDenied(now.err)).toBe(0);

    // and the walk difference did NOT change the answer
    expect(now.out.sort()).toEqual(before.out.sort());
  });
});

describe('FIND-PRUNE-V1: lib/fix-learning.sh stray-*.db sweep (same defect class)', () => {
  const FIX_LEARNING = path.join(REPO, 'lib', 'fix-learning.sh');

  it('prunes node_modules rather than post-filtering it', () => {
    const src = fs.readFileSync(FIX_LEARNING, 'utf8');
    expect(src).not.toContain("-name '*.db' -not -path '*/node_modules/*'");
    expect(src).toContain("-prune");
  });

  it('the pruned sweep returns the same *.db set as the post-filter form', () => {
    const t = mkTmp();
    const J = (...p) => path.join(t, ...p);
    for (const d of [['vendor', 'sub'], ['.claude', 'agents'], ['.claude', 'a dir', 'x']]) {
      fs.mkdirSync(J(...d), { recursive: true });
    }
    fs.writeFileSync(J('vendor', 'sub', 'nested.db'), 'x');
    fs.writeFileSync(J('.claude', 'agents', 'keep.db'), 'x');
    fs.writeFileSync(J('.claude', 'a dir', 'x', 'spaced.db'), 'x');
    fs.mkdirSync(J('vendor', 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(J('.claude', 'worktrees', 'wt1', 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(J('vendor', 'node_modules', 'pkg', 'hidden.db'), 'x');
    fs.writeFileSync(J('.claude', 'worktrees', 'wt1', 'node_modules', 'pkg', 'hidden2.db'), 'x');

    const run = (expr) => {
      const r = spawnSync('bash', ['-c', `cd ${JSON.stringify(t)} && ${expr}`], { encoding: 'utf8' });
      return (r.stdout || '').split('\n').filter(Boolean).sort();
    };
    const before = run("find ./vendor ./.claude -name '*.db' -not -path '*/node_modules/*' 2>/dev/null");
    const after = run("find ./vendor ./.claude \\( -path '*/node_modules' \\) -prune -o -name '*.db' -print 2>/dev/null");

    expect(before.length).toBe(3);      // positive control: three real strays, two hidden ones excluded
    expect(after).toEqual(before);
    expect(after.some((p) => p.includes('node_modules'))).toBe(false);
  });
});
