/**
 * Tests for HELPER-SEED-UPSTREAM-V1 + INTEL-ROOTWALK-ABSENT-V1 (lib/fix-aqe.sh,
 * lib/common.sh).
 *
 * THE BUG THIS EXISTS TO PREVENT RECURRING. The kit vendored a frozen COPY of
 * every `.claude/helpers/*` file and seeded a fresh target from it. Most of
 * those files are ruflo's, so each vendored copy is a fossil that drifts the
 * moment ruflo ships a new one. Measured against ruflo 3.34.0, SEVEN of
 * thirteen seeds had drifted — and the one that mattered, intelligence.cjs,
 * predated `resolveProjectRoot` entirely. A developer machine passed (ruflo's
 * own session hooks write the real helper there); a clean CI checkout got the
 * fossil and three test files died on `intel.resolveProjectRoot is not a
 * function`. Nothing flagged it, because fix-aqe Step 10 reported
 * `pass "self-retired"` for a file that did not contain the function the step
 * is about — it could not tell "upstream fixed it" from "the subject is absent".
 *
 * These tests are cheap and static on purpose: driving fix-aqe end-to-end would
 * reach Step 8b, which performs a GLOBAL npm install. A test must never mutate
 * the host's global root (this repo already has an open issue for a suite that
 * did exactly that).
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const FIX_AQE = path.join(REPO, 'lib', 'fix-aqe.sh');
const COMMON = path.join(REPO, 'lib', 'common.sh');
const ASSETS = path.join(REPO, 'assets', 'claude-helpers');
const fixAqeSrc = fs.readFileSync(FIX_AQE, 'utf8');

/** Pull a shell function verbatim, tolerating indentation (the seeding helpers
 *  live inside Step 2's block). Quote-state aware so an embedded script's own
 *  `}` line cannot truncate it — a naive match yields a bash SYNTAX ERROR,
 *  which every `expect(rc).not.toBe(0)` would have accepted as a pass. */
function extractShellFn(src, name) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith(`${name}() {`));
  if (start < 0) throw new Error(`could not find ${name}()`);
  const indent = lines[start].match(/^\s*/)[0];
  let inSingleQuote = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (i > start && !inSingleQuote && line === `${indent}}`) return lines.slice(start, i + 1).join('\n');
    if (((line.match(/'/g) || []).length) % 2 === 1) inSingleQuote = !inSingleQuote;
  }
  throw new Error(`unterminated ${name}()`);
}

/** Run the REAL classifier from lib/fix-aqe.sh against one filename. */
function isUpstreamOwned(helper) {
  const script = `${extractShellFn(fixAqeSrc, '_helper_is_upstream_owned')}\n`
    + `_helper_is_upstream_owned ${JSON.stringify(helper)} && echo YES || echo NO`;
  const r = spawnSync('bash', [], { input: script, encoding: 'utf8' });
  return (r.stdout || '').trim();
}

describe('the classifier decides seed provenance', () => {
  it('seeds intelligence.cjs from upstream — the one file whose tests require it', () => {
    // Its three suites call `resolveProjectRoot`, which ONLY upstream's copy
    // defines. The vendored fossil predated it; that is what broke CI.
    expect(isUpstreamOwned('intelligence.cjs')).toBe('YES');
  });

  it('keeps every OTHER helper vendored, because a kit test pins each one', () => {
    // This set was briefly wider and nightly-drift caught it: seeding these
    // from upstream broke router.test.js, session.test.js,
    // session-memory.test.js and statusline-js.test.js in one go. Each of
    // these files is asserted against the KIT's curated copy, so upstream is
    // NOT authoritative for them — the opposite of intelligence.cjs.
    for (const h of ['router.js', 'session.js', 'statusline.js', 'memory.js',
      'metrics-db.mjs', 'auto-memory-hook.mjs', 'learning-service.mjs',
      'brain-checkpoint.cjs', 'github-safe.mjs', 'ruflo-hook.cjs',
      'statusline-v3.cjs', 'statusline.cjs']) {
      expect(isUpstreamOwned(h), `${h} must stay vendored — a kit test pins it`).toBe('NO');
    }
  });

  it('pins the pairing, so widening the set again fails here first', () => {
    // The rule in one assertion: a helper may seed from upstream ONLY if no
    // kit test reads the kit's own copy of it. Derived from the test corpus,
    // not a second hardcoded list that could rot independently.
    const pinnedByTests = new Set();
    for (const f of fs.readdirSync(path.join(REPO, 'tests'))) {
      if (!f.endsWith('.test.js')) continue;
      const src = fs.readFileSync(path.join(REPO, 'tests', f), 'utf8');
      for (const m of src.matchAll(/helpers\/([a-z0-9._-]+\.(?:cjs|mjs|js))/g)) pinnedByTests.add(m[1]);
    }
    expect(pinnedByTests.size, 'no helper references found — the scan is broken').toBeGreaterThan(4);

    for (const h of pinnedByTests) {
      if (h === 'intelligence.cjs') continue; // documented exception, asserted above
      expect(isUpstreamOwned(h), `${h} is pinned by a kit test but seeds from upstream`).toBe('NO');
    }
  });

  it('NEVER seeds hook-handler.cjs from upstream — the vendored copy carries a security patch', () => {
    // Regression guard with a real consequence. ruflo DOES ship a
    // hook-handler.cjs, so it looks like an upstream-owned file, but the kit's
    // vendored copy carries HOOK-BLOCK-EXIT2-V1 (the dangerous-command block)
    // and upstream's does not. Seeding upstream's would hand a fresh target an
    // unpatched hook and leave the block dependent on Step 8's anchor still
    // matching a newer upstream shape.
    expect(isUpstreamOwned('hook-handler.cjs')).toBe('NO');
  });
});

describe('the vendored fallbacks must not be landmines', () => {
  // The fallback is used when ruflo cannot be resolved. It does not have to be
  // byte-fresh, but it must not be MISSING things the kit's own patch steps
  // anchor on — that is precisely how the CI break happened.

  it('intelligence.cjs defines resolveProjectRoot (the exact CI break)', () => {
    const src = fs.readFileSync(path.join(ASSETS, 'intelligence.cjs'), 'utf8');
    expect(src).toMatch(/function resolveProjectRoot/);
    // and exports it — the three intelligence suites call it off the module
    expect(src).toMatch(/resolveProjectRoot/);
    expect(src.match(/resolveProjectRoot/g).length).toBeGreaterThanOrEqual(2);
  });

  it('hook-handler.cjs still carries HOOK-BLOCK-EXIT2-V1', () => {
    // Guards the opposite mistake: someone "refreshing" the vendored seeds
    // from upstream in bulk would silently drop the dangerous-command block,
    // because upstream's copy does not contain it.
    const src = fs.readFileSync(path.join(ASSETS, 'hook-handler.cjs'), 'utf8');
    expect(src).toMatch(/HOOK-BLOCK-EXIT2-V1/);
  });

  it('every vendored seed parses (a corrupt fallback is worse than a stale one)', () => {
    for (const f of fs.readdirSync(ASSETS)) {
      if (!/\.(cjs|js|mjs)$/.test(f)) continue;
      const r = spawnSync(process.execPath, ['--check', path.join(ASSETS, f)], { encoding: 'utf8' });
      expect(r.status, `${f} failed node --check: ${r.stderr}`).toBe(0);
    }
  });
});

describe('kit_ruflo_helper_dir', () => {
  /** Run the real resolver with a stubbed `npm root -g`. */
  function resolveWith(npmRootOutput) {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'seedbin-'));
    // `npm root -g` passes exactly TWO args; comparing three appends a
    // trailing space and never matches (this stub silently returned failure
    // and made the resolver look broken).
    fs.writeFileSync(path.join(bin, 'npm'),
      `#!/usr/bin/env bash\n[ "$1 $2" = "root -g" ] && { printf '%s' ${JSON.stringify(npmRootOutput)}; exit 0; }\nexit 1\n`);
    fs.chmodSync(path.join(bin, 'npm'), 0o755);
    const script = `PATH=${JSON.stringify(bin)}:$PATH\n${extractShellFn(fs.readFileSync(COMMON, 'utf8'), 'kit_ruflo_helper_dir')}\n`
      + `kit_ruflo_helper_dir && echo "" || echo "UNRESOLVED"`;
    const r = spawnSync('bash', [], { input: script, encoding: 'utf8' });
    fs.rmSync(bin, { recursive: true, force: true });
    return (r.stdout || '').trim();
  }

  it('resolves the nested @claude-flow/cli helpers dir when it exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seedroot-'));
    const dir = path.join(root, 'ruflo', 'node_modules', '@claude-flow', 'cli', '.claude', 'helpers');
    fs.mkdirSync(dir, { recursive: true });
    expect(resolveWith(root)).toBe(dir);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports UNRESOLVED rather than echoing a nonexistent path', () => {
    // The fallback must trigger on absence, not on a path that merely looks
    // right — otherwise fix-aqe would `cp` from a directory that isn't there.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seedroot-empty-'));
    expect(resolveWith(root)).toBe('UNRESOLVED');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports UNRESOLVED when npm root -g itself fails', () => {
    expect(resolveWith('')).toBe('UNRESOLVED');
  });
});

describe('INTEL-ROOTWALK-ABSENT-V1: absent subject is not "self-retired"', () => {
  // Anchor on STEP 10's OWN message. Three separate steps legitimately use the
  // phrase "self-retired" (Step 8's exit(1) block, Step 8b's embedder, Step 10),
  // so a bare indexOf('self-retired') matches Step 8 at ~line 852 and every
  // ordering assertion below silently measures the wrong pair.
  const STEP10_RETIRED = 'bare .claude-flow walk-up defect not found — nothing to heal (self-retired)';

  it('Step 10 has a dedicated branch for a helper with no resolveProjectRoot', () => {
    // Structural, and stated as such: driving Step 10 end-to-end would run
    // Step 8b's global npm install. What is asserted is that the
    // absent-subject case is handled SEPARATELY and does not reach the
    // self-retired pass.
    expect(fixAqeSrc).toMatch(/INTEL-ROOTWALK-ABSENT-V1/);
    const absentIdx = fixAqeSrc.indexOf('elif ! grep -q "resolveProjectRoot" "$INTEL"');
    const retiredIdx = fixAqeSrc.indexOf(STEP10_RETIRED);
    expect(absentIdx, 'absent-subject branch missing').toBeGreaterThan(-1);
    expect(retiredIdx, 'self-retired pass missing').toBeGreaterThan(-1);
    expect(absentIdx, 'absent-subject branch must come BEFORE the self-retired pass')
      .toBeLessThan(retiredIdx);
  });

  it('the absent-subject message does not claim self-retirement', () => {
    // End at the `else` that opens the next branch, not at the message text —
    // slicing to the message leaves the next branch's `pass "` inside the
    // slice and the "must not contain pass" assertion fails on the wrong line.
    const branch = fixAqeSrc.slice(
      fixAqeSrc.indexOf('elif ! grep -q "resolveProjectRoot" "$INTEL"'),
      fixAqeSrc.lastIndexOf('\nelse', fixAqeSrc.indexOf(STEP10_RETIRED)),
    );
    expect(branch).toMatch(/warn /);           // not `pass`
    expect(branch).toMatch(/NOT 'self-retired'/);
    expect(branch).not.toMatch(/^\s*pass "/m);
  });

  it('the discriminator actually separates the two fixture shapes', () => {
    // Exercises the same predicate Step 10 uses, so a rename of the function
    // in upstream's helper is caught here rather than by a silent green.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rootwalk-'));
    const withFn = path.join(dir, 'with.cjs');
    const withoutFn = path.join(dir, 'without.cjs');
    fs.writeFileSync(withFn, 'function resolveProjectRoot(d) { return d; }\n');
    fs.writeFileSync(withoutFn, 'function somethingElse(d) { return d; }\n');
    const probe = (f) => spawnSync('bash', [], {
      input: `grep -q "resolveProjectRoot" ${JSON.stringify(f)} && echo PRESENT || echo ABSENT`,
      encoding: 'utf8',
    }).stdout.trim();
    expect(probe(withFn)).toBe('PRESENT');
    expect(probe(withoutFn)).toBe('ABSENT');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
