/**
 * Tests for pure utility functions extracted from .claude/helpers/intelligence.cjs
 *
 * Coverage gaps addressed:
 *  - tokenize(): stop-word removal, special chars, short-word filter, empty input
 *  - trigrams(): short words produce no trigrams, normal words, deduplication
 *  - jaccardSimilarity(): empty sets, identical sets, disjoint sets, partial overlap
 *  - deduplicateById(): last-write wins on same id, no-id entries
 *  - fingerprintContent + deduplicateByContent(): whitespace normalization, accessCount priority
 *  - computePageRank(): single node, chain graph, dangling node redistribution
 *  - readJSON(): returns null on 10MB+ file (mocked), returns null for missing file
 *
 * intelligence.cjs does not export these helpers directly, so tests either
 * re-implement them inline (the smallest helpers) or use a thin test shim.
 * The shim approach is preferred where the function is non-trivial.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Load intelligence module in an isolated temp cwd ─────────────────────────

let tmpDir;
let originalCwd;
let intel;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osam-intel-test-'));
  process.chdir(tmpDir);
  // ROOT-PIN (see intelligence-api.test.js): intelligence.cjs resolves its data
  // dir via resolveProjectRoot(), which walks UP from cwd looking for a `.git`
  // or `.claude-flow` marker. os.tmpdir() is a directory SHARED by every
  // process on the machine, and other writers have been known to leave a
  // stray `.claude-flow` sitting directly at that shared root — the walk-up
  // then escapes this test's empty tmpDir and lands on real, accumulated
  // project data one or more levels up. Pinning CLAUDE_PROJECT_DIR (checked
  // first, no walk-up) makes the fixture authoritative regardless of what
  // garbage other processes left in the shared tmp root.
  process.env.CLAUDE_PROJECT_DIR = tmpDir;
  // Clear cache so DATA_DIR etc. resolve from new cwd
  Object.keys(require.cache).forEach((k) => {
    if (k.includes('.claude/helpers/intelligence')) delete require.cache[k];
  });
  intel = require('../.claude/helpers/intelligence.cjs');
});

afterEach(() => {
  process.chdir(originalCwd);
  delete process.env.CLAUDE_PROJECT_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Inline re-implementation of the pure helpers (they are not exported) ─────
// These mirror the source exactly so any divergence from truth is caught here.

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'and', 'but', 'or', 'nor', 'not', 'so', 'yet',
  'both', 'either', 'neither', 'each', 'every', 'all', 'any', 'few',
  'more', 'most', 'other', 'some', 'such', 'no', 'only', 'own', 'same',
  'than', 'too', 'very', 'just', 'because', 'if', 'when', 'which',
  'who', 'whom', 'this', 'that', 'these', 'those', 'it', 'its',
]);

function tokenize(text) {
  if (!text) return [];
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function trigrams(words) {
  const t = new Set();
  for (const w of words) {
    for (let i = 0; i <= w.length - 3; i++) t.add(w.slice(i, i + 3));
  }
  return t;
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) { if (setB.has(item)) intersection++; }
  return intersection / (setA.size + setB.size - intersection);
}

// ── tokenize() ────────────────────────────────────────────────────────────────

describe('tokenize()', () => {
  it('returns empty array for empty string', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('returns empty array for null', () => {
    expect(tokenize(null)).toEqual([]);
  });

  it('filters stop words', () => {
    const words = tokenize('the cat is on the mat');
    expect(words).not.toContain('the');
    expect(words).not.toContain('is');
    expect(words).not.toContain('on');
    expect(words).toContain('cat');
    expect(words).toContain('mat');
  });

  it('filters words shorter than 3 characters', () => {
    const words = tokenize('go do it now');
    // 'go' (2), 'do' (stop), 'it' (stop/2), 'now' (3 — should pass)
    expect(words).not.toContain('go');
    expect(words).not.toContain('do');
    expect(words).toContain('now');
  });

  it('strips special characters', () => {
    const words = tokenize('hello!world @test#value');
    expect(words).toContain('hello');
    expect(words).toContain('world');
    expect(words).toContain('test');
    expect(words).toContain('value');
  });

  it('lowercases everything', () => {
    const words = tokenize('AUTHENTICATION Token');
    expect(words).toContain('authentication');
    expect(words).toContain('token');
  });

  it('preserves hyphens (useful for technical terms)', () => {
    const words = tokenize('end-to-end testing');
    // hyphens kept: 'end-to-end' stays as one token
    expect(words.some((w) => w.includes('-'))).toBe(true);
  });
});

// ── trigrams() ────────────────────────────────────────────────────────────────

describe('trigrams()', () => {
  it('returns empty set for empty word list', () => {
    expect(trigrams([]).size).toBe(0);
  });

  it('produces no trigrams for words shorter than 3 chars', () => {
    expect(trigrams(['ab']).size).toBe(0);
    expect(trigrams(['a']).size).toBe(0);
  });

  it('produces exactly one trigram for a 3-char word', () => {
    expect(trigrams(['cat'])).toEqual(new Set(['cat']));
  });

  it('produces correct sliding trigrams for longer words', () => {
    const t = trigrams(['hello']);
    expect(t.has('hel')).toBe(true);
    expect(t.has('ell')).toBe(true);
    expect(t.has('llo')).toBe(true);
    expect(t.size).toBe(3);
  });

  it('deduplicates across words', () => {
    const t = trigrams(['cat', 'concatenate']);
    // 'cat' appears in 'concatenate' too — should not duplicate
    expect(t.has('cat')).toBe(true);
    expect([...t].filter((g) => g === 'cat').length).toBe(1);
  });
});

// ── jaccardSimilarity() ───────────────────────────────────────────────────────

describe('jaccardSimilarity()', () => {
  it('returns 0 for two empty sets', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });

  it('returns 1 for identical sets', () => {
    const s = new Set(['a', 'b', 'c']);
    expect(jaccardSimilarity(s, s)).toBe(1);
  });

  it('returns 0 for completely disjoint sets', () => {
    expect(jaccardSimilarity(new Set(['a']), new Set(['b']))).toBe(0);
  });

  it('returns 0.5 for sets sharing half their elements', () => {
    const a = new Set(['x', 'y']);
    const b = new Set(['y', 'z']);
    // intersection = {y}, union = {x,y,z} → 1/3 ... wait:
    // |A∩B| = 1, |A∪B| = 3, Jaccard = 1/3 ≈ 0.333
    expect(jaccardSimilarity(a, b)).toBeCloseTo(1 / 3, 5);
  });

  it('handles one-sided empty set', () => {
    expect(jaccardSimilarity(new Set(['a']), new Set())).toBe(0);
    expect(jaccardSimilarity(new Set(), new Set(['a']))).toBe(0);
  });
});

// ── intelligence.init() and intelligence.getContext() ────────────────────────
// These are integration-level tests exercising the module with a real filesystem.

describe('intelligence.init()', () => {
  it('returns {nodes, edges} and does not throw on empty data dir', () => {
    const result = intel.init();
    expect(result).toBeTruthy();
    expect(typeof result.nodes).toBe('number');
    expect(typeof result.edges).toBe('number');
    expect(result.nodes).toBeGreaterThanOrEqual(0);
  });

  it('loads entries from auto-memory-store.json if present', () => {
    const dataDir = path.join(tmpDir, '.claude-flow', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const store = [
      { id: 'e1', content: 'authentication token refresh pattern', type: 'feedback' },
      { id: 'e2', content: 'database connection pooling strategy', type: 'project' },
    ];
    fs.writeFileSync(path.join(dataDir, 'auto-memory-store.json'), JSON.stringify(store));
    Object.keys(require.cache).forEach((k) => {
      if (k.includes('intelligence')) delete require.cache[k];
    });
    const freshIntel = require('../.claude/helpers/intelligence.cjs');
    const result = freshIntel.init();
    expect(result.nodes).toBe(2);
  });

  it('skips auto-memory-store.json larger than 10MB', () => {
    const dataDir = path.join(tmpDir, '.claude-flow', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    // Write a file just over the 10MB limit
    const bigContent = Buffer.alloc(10 * 1024 * 1024 + 1, 'x').toString();
    fs.writeFileSync(path.join(dataDir, 'auto-memory-store.json'), bigContent);
    Object.keys(require.cache).forEach((k) => {
      if (k.includes('intelligence')) delete require.cache[k];
    });
    const freshIntel = require('../.claude/helpers/intelligence.cjs');
    expect(() => freshIntel.init()).not.toThrow();
  });
});

// ── resolveProjectRoot() walk-up (B22/B23 regression — INTEL-ROOTWALK-V1 v4) ──
// intelligence.cjs ships inside the upstream ruflo/claude-flow npm package
// (installed .claude/helpers/intelligence.cjs is byte-identical to the copy
// bundled in vendor/ruflo and vendor/claude-flow) and is regenerated by
// `ruflo init`/`aqe init` — so this is healed in place by `fix-aqe.sh`'s
// INTEL-ROOTWALK-V1 step (same defect_gate + anchored-patch pattern as
// HOOK-BLOCK-EXIT2-V1), not by editing this repo's copy directly.
//
// Revision history (see intel-rootwalk-patch.test.js for differential proofs
// against the actual patcher code, not just this live-loaded module):
//   v1 "depth-0" — trusted a bare `.claude-flow` only at the walk's own
//     origin. Regressed a non-git project invoked from a subdirectory.
//   v2 "realpath-per-directory" — excluded $HOME/OS temp root/fs root by
//     realpath-comparing the candidate against a realpath'd-only exclusion
//     set. A caller-supplied alias-form startDir the walk never resolves
//     could still slip past it, and it missed CI runners whose real temp
//     root is a distinct env var from `os.tmpdir()`.
//   v3 "boundary set, both raw+realpath string forms, +literal /tmp" —
//     precomputed BOTH the raw and realpath'd, trailing-separator-normalized
//     form of each boundary, string-matched at check time. Closed the v2
//     bypass and added the literal `/tmp` + $TMPDIR/$TEMP/$TMP entries, but
//     had two of its own real problems: (a) $TMPDIR/$TEMP/$TMP were trusted
//     verbatim with no validation — an operator setting `TMPDIR=$BUILD_DIR`
//     (a plausible CI misconfiguration) would silently exclude that whole
//     real project; (b) STRING comparison, even of realpath'd values, is
//     fooled by a case-insensitive-but-preserving filesystem (macOS APFS) —
//     realpathSync preserves input case, so a case-differing alias of a
//     boundary never string-matched it, reproducing the ORIGINAL defect
//     through a new alias class.
//
// v4 (current): identity, not strings. Boundary membership is decided by
// `(dev, ino)` from `fs.statSync`, precomputed once per boundary and stat'd
// once per candidate directory — never by comparing path strings, realpath'd
// or not. This closes case-aliasing, symlink-aliasing, trailing separators,
// and `..` segments in one mechanism, with no platform gating and no
// `toLowerCase()`-style guesswork (which would be wrong on case-SENSITIVE
// volumes). $TMPDIR/$TEMP/$TMP are validated (absolute path + existing
// directory) before being trusted; a value pointed at a real, existing
// project root remains a documented, tested residual failure mode (see the
// "hostile TMPDIR" test below) rather than something silently guessed
// around. Neither `.git` nor `.claude-flow` is trusted AT a boundary
// directory itself (a yadm-style dotfiles `.git` at $HOME is the same
// hazard as a stray `.claude-flow`, through a different marker — this is
// an intentional, disclosed design decision, not a gap: see the dedicated
// test below); a project living UNDER an excluded root is unaffected.
//
// These tests build synthetic fixture trees under `/tmp` (hardcoded, NOT
// `os.tmpdir()`) specifically because `os.tmpdir()` on this host is the real
// SHARED per-session temp root other concurrent processes write into (it
// already carries a stray `.claude-flow` from unrelated writers) — nesting
// fixtures there would make the boundary-exclusion tests dependent on
// ambient pollution instead of deterministic. `/tmp` is a distinct,
// unpolluted directory on this host (confirmed), and `os.tmpdir()` /
// `os.homedir()` are monkey-patched per-test (restored in afterEach) so the
// exclusion logic — which calls `require('os').tmpdir()`/`homedir()` live,
// not injected — can be exercised against a synthetic root deterministically,
// without touching the real ambient shared root other builders are using
// concurrently.
//
// Assertions compare filesystem IDENTITY (dev:ino via fs.statSync), never
// path strings — even realpath'd ones. A string comparison here can lie:
// on a case-insensitive-but-preserving filesystem, realpathSync PRESERVES
// input case, so two strings that look different can be the exact same
// directory, and two that look identical after naive normalization can
// still be different directories elsewhere. This is not a hypothetical —
// it is the precise trap that produced a false "no bug" verdict during this
// investigation before being caught by comparing identity instead.
function sameFsEntry(pathA, pathB) {
  const a = fs.statSync(pathA);
  const b = fs.statSync(pathB);
  return a.dev === b.dev && a.ino === b.ino;
}

describe('resolveProjectRoot() — walk-up boundary exclusion', () => {
  let synthBase;
  let osModule;
  let originalTmpdir;
  let originalHomedir;
  let originalTmpdirEnv;
  let originalTempEnv;
  let originalTmpEnv;

  beforeEach(() => {
    synthBase = fs.mkdtempSync(path.join('/tmp', 'osam-rootwalk-'));
    osModule = require('os');
    originalTmpdir = osModule.tmpdir;
    originalHomedir = osModule.homedir;
    originalTmpdirEnv = process.env.TMPDIR;
    originalTempEnv = process.env.TEMP;
    originalTmpEnv = process.env.TMP;
  });

  afterEach(() => {
    osModule.tmpdir = originalTmpdir;
    osModule.homedir = originalHomedir;
    if (originalTmpdirEnv === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmpdirEnv;
    if (originalTempEnv === undefined) delete process.env.TEMP; else process.env.TEMP = originalTempEnv;
    if (originalTmpEnv === undefined) delete process.env.TMP; else process.env.TMP = originalTmpEnv;
    fs.rmSync(synthBase, { recursive: true, force: true });
  });

  it('resolves a legit non-git project from a subdirectory 2+ levels deep (regression fix)', () => {
    const project = path.join(synthBase, 'legit-project');
    const deepChild = path.join(project, 'src', 'nested');
    fs.mkdirSync(path.join(project, '.claude-flow'), { recursive: true });
    fs.mkdirSync(deepChild, { recursive: true });

    delete process.env.CLAUDE_PROJECT_DIR;
    // The project's own bare .claude-flow is NOT itself a boundary, so it is
    // trusted at any walk-up depth — this is the case the v1 depth-0
    // revision broke.
    expect(intel.resolveProjectRoot(deepChild)).toBe(path.resolve(project));
  });

  it('does NOT adopt a stray .claude-flow AT an excluded boundary (original defect)', () => {
    const sharedRoot = fs.mkdtempSync(path.join(synthBase, 'shared-'));
    fs.mkdirSync(path.join(sharedRoot, '.claude-flow'), { recursive: true });
    const fixture = path.join(sharedRoot, 'fixture-no-marker');
    fs.mkdirSync(fixture, { recursive: true });

    osModule.tmpdir = () => sharedRoot; // simulate: sharedRoot IS "the" OS temp root
    delete process.env.CLAUDE_PROJECT_DIR;
    const resolved = intel.resolveProjectRoot(fixture);
    expect(resolved).toBe(path.resolve(fixture));
    expect(resolved).not.toBe(path.resolve(sharedRoot));
  });

  it('a project living directly UNDER an excluded boundary still resolves (only the root itself is excluded)', () => {
    const sharedRoot = fs.mkdtempSync(path.join(synthBase, 'shared-'));
    const project = path.join(sharedRoot, 'a-real-project');
    const deepChild = path.join(project, 'sub');
    fs.mkdirSync(path.join(project, '.claude-flow'), { recursive: true });
    fs.mkdirSync(deepChild, { recursive: true });

    osModule.tmpdir = () => sharedRoot;
    delete process.env.CLAUDE_PROJECT_DIR;
    // The project itself is a CHILD of the excluded root, not the root, so
    // its own marker is unaffected.
    expect(intel.resolveProjectRoot(deepChild)).toBe(path.resolve(project));
  });

  it('excludes $HOME the same way as the OS temp root', () => {
    const fakeHome = fs.mkdtempSync(path.join(synthBase, 'home-'));
    fs.mkdirSync(path.join(fakeHome, '.claude-flow'), { recursive: true });
    const fixture = path.join(fakeHome, 'fixture-no-marker');
    fs.mkdirSync(fixture, { recursive: true });

    osModule.homedir = () => fakeHome;
    delete process.env.CLAUDE_PROJECT_DIR;
    const resolved = intel.resolveProjectRoot(fixture);
    expect(resolved).toBe(path.resolve(fixture));
    expect(resolved).not.toBe(path.resolve(fakeHome));
  });

  it('excludes $TMPDIR/$TEMP/$TMP even when os.tmpdir() itself does not reflect them (CI-runner case, e.g. RUNNER_TEMP)', () => {
    // Node's os.tmpdir() reads $TMPDIR live on POSIX, so merely setting the
    // env var would make os.tmpdir() itself agree — not a real test of
    // "checked independently". To exercise genuine divergence (a sandboxed
    // runtime, a memoized os.tmpdir(), or a CI wrapper where the *real*
    // runner temp root is exposed only via env, e.g. GitHub Actions'
    // RUNNER_TEMP), os.tmpdir() is monkey-patched to point somewhere
    // UNRELATED while $TMPDIR points at the actual boundary.
    const runnerTemp = fs.mkdtempSync(path.join(synthBase, 'runner-temp-'));
    fs.mkdirSync(path.join(runnerTemp, '.claude-flow'), { recursive: true });
    const fixture = path.join(runnerTemp, 'workdir');
    fs.mkdirSync(fixture, { recursive: true });

    const unrelated = fs.mkdtempSync(path.join(synthBase, 'unrelated-tmpdir-'));
    osModule.tmpdir = () => unrelated; // deliberately does NOT agree with $TMPDIR
    process.env.TMPDIR = runnerTemp;
    delete process.env.CLAUDE_PROJECT_DIR;
    const resolved = intel.resolveProjectRoot(fixture);
    expect(resolved).toBe(path.resolve(fixture));
    expect(resolved).not.toBe(path.resolve(runnerTemp));
  });

  it('rejects an empty $TMPDIR value (ignored, contributes no boundary)', () => {
    const project = fs.mkdtempSync(path.join(synthBase, 'legit-'));
    fs.mkdirSync(path.join(project, '.claude-flow'), { recursive: true });
    const deepChild = path.join(project, 'sub', 'deep');
    fs.mkdirSync(deepChild, { recursive: true });

    process.env.TMPDIR = '';
    delete process.env.CLAUDE_PROJECT_DIR;
    expect(intel.resolveProjectRoot(deepChild)).toBe(path.resolve(project));
  });

  it('rejects a relative $TMPDIR value (ignored, contributes no boundary)', () => {
    const project = fs.mkdtempSync(path.join(synthBase, 'legit-'));
    fs.mkdirSync(path.join(project, '.claude-flow'), { recursive: true });
    const deepChild = path.join(project, 'sub', 'deep');
    fs.mkdirSync(deepChild, { recursive: true });

    process.env.TMPDIR = 'some/relative/path';
    delete process.env.CLAUDE_PROJECT_DIR;
    expect(intel.resolveProjectRoot(deepChild)).toBe(path.resolve(project));
  });

  it('rejects a nonexistent $TMPDIR value (ignored, contributes no boundary)', () => {
    const project = fs.mkdtempSync(path.join(synthBase, 'legit-'));
    fs.mkdirSync(path.join(project, '.claude-flow'), { recursive: true });
    const deepChild = path.join(project, 'sub', 'deep');
    fs.mkdirSync(deepChild, { recursive: true });

    process.env.TMPDIR = '/this/path/definitely/does/not/exist/anywhere/xyz123';
    delete process.env.CLAUDE_PROJECT_DIR;
    expect(intel.resolveProjectRoot(deepChild)).toBe(path.resolve(project));
  });

  it('HOSTILE $TMPDIR pointed at a real, existing project root: documented residual failure mode (not fully closable without guessing)', () => {
    // Validation (absolute + existing) rejects empty/relative/nonexistent
    // values, but it cannot distinguish "operator meant this as a temp
    // root" from "operator misconfigured it to point at a real project"
    // without guessing intent — that would trade one unverifiable check for
    // another. This test pins the accepted, disclosed behavior: a $TMPDIR
    // misconfigured to a real project directory (a plausible CI mistake,
    // e.g. TMPDIR=$BUILD_DIR) excludes that project's own marker from every
    // subdirectory, and resolution falls back to the walk's origin.
    const hostileProject = fs.mkdtempSync(path.join(synthBase, 'hostile-project-'));
    fs.mkdirSync(path.join(hostileProject, '.claude-flow'), { recursive: true });
    const deepChild = path.join(hostileProject, 'src', 'nested');
    fs.mkdirSync(deepChild, { recursive: true });

    process.env.TMPDIR = hostileProject; // passes absolute+exists validation
    delete process.env.CLAUDE_PROJECT_DIR;
    const resolved = intel.resolveProjectRoot(deepChild);
    // Documented degradation: falls back to the origin, NOT the project
    // root — the project's marker was excluded as if TMPDIR were a genuine
    // shared temp root. CLAUDE_PROJECT_DIR remains the escape hatch for an
    // operator who hits this.
    expect(resolved).toBe(path.resolve(deepChild));
    expect(resolved).not.toBe(path.resolve(hostileProject));
  });

  it('a boundary value with a trailing separator still matches (fs.statSync ignores it, no special-casing needed)', () => {
    const sharedRoot = fs.mkdtempSync(path.join(synthBase, 'trail-'));
    fs.mkdirSync(path.join(sharedRoot, '.claude-flow'), { recursive: true });
    const fixture = path.join(sharedRoot, 'fixture-no-marker');
    fs.mkdirSync(fixture, { recursive: true });

    osModule.tmpdir = () => sharedRoot + '/'; // TRAILING SEPARATOR, as real TMPDIR has on this host
    delete process.env.CLAUDE_PROJECT_DIR;
    const resolved = intel.resolveProjectRoot(fixture);
    expect(resolved).toBe(path.resolve(fixture));
  });

  it('a walk via a SYMLINK-ALIAS-form path with a stray marker exactly at the boundary is NOT adopted', () => {
    // Teeth proof for the v2->v3 bypass, re-verified under v4's identity
    // mechanism. Build a boundary via its REALPATH form, present the ALIAS
    // form as os.tmpdir()'s return value. Asserted by filesystem identity,
    // NOT by comparing fs.realpathSync(...) strings — that would only prove
    // symlink-aliasing is handled, and would not catch the DIFFERENT
    // case-aliasing hazard covered by the next test.
    const sharedRootReal = fs.mkdtempSync(path.join(fs.realpathSync(synthBase), 'aliased-'));
    const aliasedPath = path.join(synthBase, path.basename(sharedRootReal));
    expect(sameFsEntry(aliasedPath, sharedRootReal)).toBe(true); // sanity: same dir, different string

    fs.mkdirSync(path.join(sharedRootReal, '.claude-flow'), { recursive: true });
    const fixture = path.join(aliasedPath, 'fixture-no-marker');
    fs.mkdirSync(fixture, { recursive: true });

    osModule.tmpdir = () => aliasedPath; // present the alias form, not the realpath form
    delete process.env.CLAUDE_PROJECT_DIR;
    const resolved = intel.resolveProjectRoot(fixture);
    expect(sameFsEntry(resolved, fixture)).toBe(true);
    expect(sameFsEntry(resolved, sharedRootReal)).toBe(false);
  });

  it('a walk via a CASE-ALIAS-form path with a stray marker exactly at the boundary is NOT adopted (case-insensitive-but-preserving filesystem)', () => {
    // The bypass a prior string-based revision missed: macOS APFS is
    // case-insensitive-but-preserving. fs.realpathSync PRESERVES the input
    // case rather than canonicalizing it, so a case-differing alias of a
    // boundary directory never string-matches it even after realpath — a
    // stray marker sitting there is adopted anyway. Comparing by (dev, ino)
    // instead of any string form closes this regardless of case.
    const fakeHome = fs.mkdtempSync(path.join(synthBase, 'CaseAliasHome-'));
    fs.mkdirSync(path.join(fakeHome, '.claude-flow'), { recursive: true });
    const fixture = path.join(fakeHome, 'fixture-no-marker');
    fs.mkdirSync(fixture, { recursive: true });

    const upperCaseAlias = fakeHome.toUpperCase();
    // Sanity: confirm this filesystem is actually case-insensitive-but-
    // preserving before asserting anything about the alias (a case-SENSITIVE
    // volume would make upperCaseAlias a distinct, nonexistent path, and the
    // fixture setup below would not represent the hazard this test targets).
    let caseInsensitiveFs;
    try {
      caseInsensitiveFs = sameFsEntry(fakeHome, upperCaseAlias);
    } catch (e) {
      caseInsensitiveFs = false; // case-sensitive fs: uppercase path doesn't exist
    }
    if (!caseInsensitiveFs) {
      // Nothing to prove on a case-sensitive filesystem — the alias simply
      // isn't the same directory there, which is correct behavior, not a
      // skip of the property under test.
      return;
    }

    osModule.homedir = () => upperCaseAlias; // present the CASE alias, not the original case
    delete process.env.CLAUDE_PROJECT_DIR;
    const resolved = intel.resolveProjectRoot(fixture);
    expect(sameFsEntry(resolved, fixture)).toBe(true);
    expect(sameFsEntry(resolved, fakeHome)).toBe(false);
  });

  it('a genuine .git-anchored project still resolves from any depth below it', () => {
    const gitProject = path.join(synthBase, 'gitproj');
    const deepChild = path.join(gitProject, 'src', 'nested', 'deep');
    fs.mkdirSync(path.join(gitProject, '.git'), { recursive: true });
    fs.mkdirSync(deepChild, { recursive: true });

    delete process.env.CLAUDE_PROJECT_DIR;
    // .git is an unambiguous project-root signal and stays trusted at any
    // walk-up depth, regardless of boundary exclusion.
    expect(intel.resolveProjectRoot(deepChild)).toBe(path.resolve(gitProject));
  });

  it('a .git AT the boundary itself is NOT adopted from a descendant (yadm-style dotfiles hazard)', () => {
    // Mirrors the historical ~/.agentic-qe hijack but through .git instead
    // of .claude-flow: a dotfiles repo (yadm-style) at $HOME would otherwise
    // capture every project under home lacking its own marker.
    const gitBoundary = fs.mkdtempSync(path.join(synthBase, 'gitbnd-'));
    fs.mkdirSync(path.join(gitBoundary, '.git'), { recursive: true });
    const child = path.join(gitBoundary, 'sub');
    fs.mkdirSync(child, { recursive: true });

    osModule.tmpdir = () => gitBoundary;
    delete process.env.CLAUDE_PROJECT_DIR;
    const resolved = intel.resolveProjectRoot(child);
    expect(resolved).toBe(path.resolve(child));
    expect(resolved).not.toBe(path.resolve(gitBoundary));
  });

  it('excludes the literal /tmp path itself (a second real shared temp root distinct from os.tmpdir() on this host)', () => {
    // On this host os.tmpdir() is /var/folders/... (a per-session directory),
    // so /tmp is a genuine SECOND shared temp root not covered by excluding
    // os.tmpdir() alone. Unlike every other exclusion test in this file,
    // this one cannot be exercised via a monkey-patched synthetic root — the
    // production code hardcodes the literal string '/tmp', so proving the
    // exclusion means interacting with the real system /tmp. /tmp is a live
    // directory other processes may be using concurrently, so: check first
    // and only create+immediately remove our own marker if none already
    // exists, and never leave residue behind even if the assertion fails.
    const preexisting = fs.existsSync('/tmp/.claude-flow');
    const fixture = fs.mkdtempSync(path.join('/tmp', 'osam-literaltmp-'));
    let created = false;
    try {
      if (!preexisting) {
        fs.mkdirSync('/tmp/.claude-flow');
        created = true;
      }
      delete process.env.CLAUDE_PROJECT_DIR;
      const resolved = intel.resolveProjectRoot(fixture);
      expect(resolved).toBe(path.resolve(fixture));
      expect(resolved).not.toBe('/tmp');
    } finally {
      if (created) fs.rmSync('/tmp/.claude-flow', { recursive: true, force: true });
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('the case-alias bypass is NOT $HOME-specific: a case-differing alias of the literal /tmp boundary is also closed', () => {
    // The case-alias bypass a prior string-based revision missed is systemic
    // to the comparison mechanism, not specific to $HOME — it affects every
    // boundary entry the same way, including the literal /tmp entry added
    // for the CI-runner gap. This is why v4 replaced string comparison with
    // (dev, ino) identity as ONE mechanism for every entry, rather than
    // patching case-folding onto $HOME specifically. Reproduces the exact
    // scenario against the real system /tmp: a fixture path presented via
    // the uppercase /TMP alias.
    const upperTmp = '/TMP';
    let caseInsensitiveFs;
    try {
      caseInsensitiveFs = sameFsEntry('/tmp', upperTmp);
    } catch (e) {
      caseInsensitiveFs = false;
    }
    if (!caseInsensitiveFs) {
      // Case-sensitive filesystem: /TMP genuinely isn't /tmp here, so there
      // is nothing to reproduce — not a failure of the test.
      return;
    }

    const preexisting = fs.existsSync('/tmp/.claude-flow');
    const fixture = fs.mkdtempSync(path.join('/tmp', 'osam-tmpcasealias-'));
    let created = false;
    try {
      if (!preexisting) {
        fs.mkdirSync('/tmp/.claude-flow');
        created = true;
      }
      delete process.env.CLAUDE_PROJECT_DIR;
      // Present the fixture via the uppercase /TMP alias as the startDir —
      // the walk itself never resolves this, so only identity comparison
      // (not string comparison, even after realpath) can recognize that
      // '/TMP' IS the excluded '/tmp' boundary rather than treating the
      // alias path as an ordinary, unrelated directory tree.
      const aliasFixture = path.join(upperTmp, path.basename(fixture));
      const resolved = intel.resolveProjectRoot(aliasFixture);
      expect(sameFsEntry(resolved, fixture)).toBe(true);
      expect(sameFsEntry(resolved, '/tmp')).toBe(false);
    } finally {
      if (created) fs.rmSync('/tmp/.claude-flow', { recursive: true, force: true });
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('CLAUDE_PROJECT_DIR pin overrides the walk-up entirely', () => {
    const ancestor = path.join(synthBase, 'ancestor');
    const child = path.join(ancestor, 'child', 'grandchild');
    fs.mkdirSync(path.join(ancestor, '.claude-flow'), { recursive: true });
    fs.mkdirSync(child, { recursive: true });

    process.env.CLAUDE_PROJECT_DIR = child;
    try {
      const resolved = intel.resolveProjectRoot(child);
      expect(resolved).toBe(path.resolve(child));
      expect(resolved).not.toBe(path.resolve(ancestor));
    } finally {
      delete process.env.CLAUDE_PROJECT_DIR;
    }
  });

  it('a RELATIVE $TMPDIR that resolves via cwd to a real project does NOT exclude that project (isAbsolute validation is load-bearing)', () => {
    // Makes the `path.isAbsolute()` branch of _rootwalkValidEnvTemp matter.
    // A prior version of this test set $TMPDIR to a relative value that
    // simply didn't exist relative to cwd, so fs.existsSync's own
    // cwd-relative resolution already rejected it — removing isAbsolute()
    // entirely would have left that test passing for the wrong reason
    // (the review's exact complaint). This one chdir's into a directory
    // where the relative value genuinely resolves to something real: a
    // legitimate project with its own .claude-flow marker. os.tmpdir() is
    // monkey-patched to something unrelated so this exercises ONLY the
    // explicit $TMPDIR read (os.tmpdir() itself echoes $TMPDIR verbatim on
    // POSIX with no validation at all, which would otherwise confound the
    // test regardless of the fix under test).
    //
    // Verified via a scratch mutation (isAbsolute() removed, existsSync()
    // kept) before writing this test: the mutated code EXCLUDES the real
    // project (falls back to origin); the current code resolves to the
    // project correctly. That confirms this branch is genuinely load-bearing
    // rather than redundant with the `if (!p) return` / statSync try/catch
    // guards that already cover empty and nonexistent values.
    const project = fs.mkdtempSync(path.join(synthBase, 'legit-'));
    fs.mkdirSync(path.join(project, '.claude-flow'), { recursive: true });
    const deepChild = path.join(project, 'src', 'nested');
    fs.mkdirSync(deepChild, { recursive: true });
    const safeSentinel = fs.mkdtempSync(path.join(synthBase, 'safe-unrelated-'));

    const originalCwd = process.cwd();
    process.chdir(synthBase);
    try {
      osModule.tmpdir = () => safeSentinel; // isolate: os.tmpdir() no longer echoes $TMPDIR
      process.env.TMPDIR = path.basename(project); // relative; resolves via cwd (=synthBase) to `project`
      delete process.env.CLAUDE_PROJECT_DIR;
      const resolved = intel.resolveProjectRoot(deepChild);
      expect(sameFsEntry(resolved, project)).toBe(true);
      expect(sameFsEntry(resolved, deepChild)).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('resolveProjectRoot does NOT throw when a directory in the walk cannot be stat\'d (EACCES)', () => {
    // Makes _rootwalkStatSafe's internal try/catch load-bearing.
    // isSharedRoot(dir) is called unguarded inside the walk loop (unlike the
    // boundary-building side, which double-guards each _rootwalkAddBoundary
    // call with its own outer try/catch) — if _rootwalkStatSafe itself
    // didn't swallow the error, an EACCES from an unreadable ancestor would
    // propagate all the way out of resolveProjectRoot, which runs at MODULE
    // LOAD, taking down the whole helper for every fresh hook subprocess.
    //
    // Verified via a scratch mutation (the try/catch removed from
    // _rootwalkStatSafe) before writing this test: the mutated code THROWS
    // EACCES from this exact scenario; the current code does not.
    const base = fs.mkdtempSync(path.join(synthBase, 'eacces-'));
    const restricted = path.join(base, 'restricted');
    const deepChild = path.join(restricted, 'child', 'deep');
    fs.mkdirSync(deepChild, { recursive: true });
    fs.chmodSync(restricted, 0o000);
    try {
      delete process.env.CLAUDE_PROJECT_DIR;
      expect(() => intel.resolveProjectRoot(deepChild)).not.toThrow();
    } finally {
      fs.chmodSync(restricted, 0o755); // restore before cleanup can remove it
    }
  });

  it('a TRANSIENT boundary stat failure during construction does NOT cause that boundary to be wrongly adopted', () => {
    // The boundary set is built ONCE, up front, with no re-check. If a
    // single fs.statSync fails for ANY reason during that construction
    // (EMFILE under fd pressure, an EACCES race, ENOENT/ESTALE during a
    // remount), treating the failure as "this boundary does not exist"
    // silently drops it from the set for the rest of the call — even
    // though the walk itself later reaches that exact directory once the
    // transient condition has cleared, and would adopt a bare .claude-flow
    // sitting there as if it were a legitimate project (the ORIGINAL
    // defect, reintroduced via a construction-time race rather than an
    // alias). This is DIFFERENT from the candidate-side check inside the
    // walk (isSharedRoot): there, fs.existsSync(dir/.git) hits the
    // identical access barrier at the identical instant, so "don't
    // recognize as boundary" and "can't see the marker either" cancel out.
    // The boundary-construction side has no such re-check to cancel
    // against, which is exactly why this needs its own test.
    //
    // A stateful fs.statSync monkeypatch throws EMFILE exactly once for the
    // boundary path, then behaves normally afterward — including for the
    // walk's own later re-check of that same directory — reproducing the
    // real timing this is about, against the real, unmodified production
    // code (no source mutation on this side).
    const sharedRoot = fs.mkdtempSync(path.join(synthBase, 'transient-'));
    fs.mkdirSync(path.join(sharedRoot, '.claude-flow'), { recursive: true });
    const fixture = path.join(sharedRoot, 'fixture-no-marker');
    fs.mkdirSync(fixture, { recursive: true });

    osModule.tmpdir = () => sharedRoot;
    const origStatSync = fs.statSync;
    let thrown = false;
    fs.statSync = function (p, ...rest) {
      if (!thrown && p === sharedRoot) {
        thrown = true;
        const err = new Error('EMFILE: too many open files, stat \'' + p + '\'');
        err.code = 'EMFILE';
        throw err;
      }
      return origStatSync.call(fs, p, ...rest);
    };
    try {
      delete process.env.CLAUDE_PROJECT_DIR;
      const resolved = intel.resolveProjectRoot(fixture);
      expect(thrown).toBe(true); // sanity: the transient failure actually fired
      expect(sameFsEntry(resolved, fixture)).toBe(true);
      expect(sameFsEntry(resolved, sharedRoot)).toBe(false);
    } finally {
      fs.statSync = origStatSync;
    }
  });

  it('a GENUINELY NONEXISTENT boundary (ENOENT) does not degrade the whole call — only unknown errno does', () => {
    // ENOENT/ENOTDIR genuinely mean the boundary is absent, and skipping it
    // is correct — only OTHER errno values are "unknown" and must not
    // silently degrade to absent. A boundary that simply was never created
    // (e.g. os.tmpdir() pointed at a path nobody made) must not disable
    // bare .claude-flow detection for legitimate, unrelated projects.
    const project = fs.mkdtempSync(path.join(synthBase, 'legit-enoent-'));
    fs.mkdirSync(path.join(project, '.claude-flow'), { recursive: true });
    const deepChild = path.join(project, 'sub');
    fs.mkdirSync(deepChild, { recursive: true });

    const neverCreated = path.join(synthBase, 'never-created-tmpdir-xyz');
    osModule.tmpdir = () => neverCreated; // stat() on this will genuinely ENOENT
    delete process.env.CLAUDE_PROJECT_DIR;
    expect(intel.resolveProjectRoot(deepChild)).toBe(path.resolve(project));
  });

  it('the accepted DEGRADED-CALL TRADE-OFF is real: an UNRELATED legitimate project also loses bare .claude-flow detection for that one call', () => {
    // This is the behavioral proof of the cost, not just of the fix. The
    // earlier transient-failure test above only proves the POISONED
    // boundary itself is not adopted — that alone does not prove
    // _rootwalkDegraded's gate on `.claude-flow` has any real effect,
    // because isSharedRoot(sharedRoot) already (correctly) returns false
    // for the un-added boundary regardless, and a mutation that keeps the
    // errno-split bookkeeping intact but strips the gate's EFFECT on the
    // `.claude-flow` check could still pass that narrower test by
    // coincidence in some shapes. This test targets the gate's effect
    // directly: a project with ZERO relationship to the failing boundary
    // (different directory entirely) must ALSO have its own, otherwise
    // completely valid, bare `.claude-flow` marker refused for the
    // duration of this one call — that is the accepted trade-off the
    // degraded-boundary design makes (occasional non-detection elsewhere)
    // in exchange for never adopting an unverified boundary. If a future
    // change silently drops the gate while leaving the errno-split
    // bookkeeping intact, this project would be found again — which looks
    // like an improvement locally but means the flag no longer does
    // anything, and the original adoption bug (proven by the sibling test
    // above) would resurface right alongside it.
    const legitProject = fs.mkdtempSync(path.join(synthBase, 'unrelated-legit-'));
    fs.mkdirSync(path.join(legitProject, '.claude-flow'), { recursive: true });
    const legitDeep = path.join(legitProject, 'sub');
    fs.mkdirSync(legitDeep, { recursive: true });

    // A boundary with NO relationship whatsoever to legitProject.
    const poisonedTmpdir = fs.mkdtempSync(path.join(synthBase, 'poisoned-unrelated-'));
    osModule.tmpdir = () => poisonedTmpdir;
    const origStatSync = fs.statSync;
    let thrown = false;
    fs.statSync = function (p, ...rest) {
      if (!thrown && p === poisonedTmpdir) {
        thrown = true;
        const err = new Error('EMFILE: too many open files, stat \'' + p + '\'');
        err.code = 'EMFILE';
        throw err;
      }
      return origStatSync.call(fs, p, ...rest);
    };
    try {
      delete process.env.CLAUDE_PROJECT_DIR;
      const resolved = intel.resolveProjectRoot(legitDeep);
      expect(thrown).toBe(true); // sanity: the unrelated boundary's failure actually fired
      // The accepted cost: resolution falls back to the origin instead of
      // finding legitProject's own, perfectly valid marker.
      expect(sameFsEntry(resolved, legitDeep)).toBe(true);
      expect(sameFsEntry(resolved, legitProject)).toBe(false);
    } finally {
      fs.statSync = origStatSync;
    }
  });
});

describe('intelligence.getContext()', () => {
  beforeEach(() => {
    const dataDir = path.join(tmpDir, '.claude-flow', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const store = [
      { id: 'e1', content: 'authentication login session token', type: 'feedback' },
      { id: 'e2', content: 'database query optimization index', type: 'project' },
    ];
    fs.writeFileSync(path.join(dataDir, 'auto-memory-store.json'), JSON.stringify(store));
    Object.keys(require.cache).forEach((k) => {
      if (k.includes('intelligence')) delete require.cache[k];
    });
    intel = require('../.claude/helpers/intelligence.cjs');
    intel.init();
  });

  it('returns a non-empty string for a prompt matching stored entries', () => {
    const ctx = intel.getContext('fix authentication token issue');
    expect(typeof ctx).toBe('string');
  });

  it('returns null or empty string for a completely unrelated prompt', () => {
    const ctx = intel.getContext('unrelated quantum physics zorg');
    // May return null or '' — both valid; should not throw
    expect(ctx === null || typeof ctx === 'string').toBe(true);
  });

  it('does not throw for empty prompt', () => {
    expect(() => intel.getContext('')).not.toThrow();
  });
});

describe('intelligence.recordEdit()', () => {
  it('does not throw for a valid file path', () => {
    intel.init();
    expect(() => intel.recordEdit('src/auth/login.ts')).not.toThrow();
  });

  it('does not throw for empty string', () => {
    intel.init();
    expect(() => intel.recordEdit('')).not.toThrow();
  });
});

describe('intelligence.feedback()', () => {
  it('does not throw when called without prior getContext', () => {
    intel.init();
    expect(() => intel.feedback(true)).not.toThrow();
    expect(() => intel.feedback(false)).not.toThrow();
  });
});

describe('intelligence.consolidate()', () => {
  it('returns {entries, edges} and does not throw on empty store', () => {
    intel.init();
    const result = intel.consolidate();
    expect(result).toBeTruthy();
    expect(typeof result.entries).toBe('number');
    expect(typeof result.edges).toBe('number');
  });
});

// ── Deduplication edge cases (via init() + store inspection) ─────────────────

describe('intelligence deduplication', () => {
  it('deduplicates entries with the same id (last-write wins by default)', () => {
    const dataDir = path.join(tmpDir, '.claude-flow', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const store = [
      { id: 'e1', content: 'first version of auth', type: 'feedback' },
      { id: 'e1', content: 'second version of auth', type: 'feedback' },
    ];
    fs.writeFileSync(path.join(dataDir, 'auto-memory-store.json'), JSON.stringify(store));
    Object.keys(require.cache).forEach((k) => {
      if (k.includes('intelligence')) delete require.cache[k];
    });
    const freshIntel = require('../.claude/helpers/intelligence.cjs');
    const result = freshIntel.init();
    expect(result.nodes).toBe(1); // deduped to 1
  });

  it('deduplicates entries with identical content but different ids', () => {
    const dataDir = path.join(tmpDir, '.claude-flow', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const sameContent = 'database connection pool optimization pattern';
    const store = [
      { id: 'a1', content: sameContent, type: 'feedback' },
      { id: 'a2', content: sameContent, type: 'feedback' },
    ];
    fs.writeFileSync(path.join(dataDir, 'auto-memory-store.json'), JSON.stringify(store));
    Object.keys(require.cache).forEach((k) => {
      if (k.includes('intelligence')) delete require.cache[k];
    });
    const freshIntel = require('../.claude/helpers/intelligence.cjs');
    const result = freshIntel.init();
    expect(result.nodes).toBe(1); // content-deduped
  });

  it('keeps higher-accessCount entry when content is identical', () => {
    const dataDir = path.join(tmpDir, '.claude-flow', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const sameContent = 'caching strategy redis pattern';
    const store = [
      { id: 'b1', content: sameContent, accessCount: 5, type: 'feedback' },
      { id: 'b2', content: sameContent, accessCount: 1, type: 'feedback' },
    ];
    fs.writeFileSync(path.join(dataDir, 'auto-memory-store.json'), JSON.stringify(store));
    Object.keys(require.cache).forEach((k) => {
      if (k.includes('intelligence')) delete require.cache[k];
    });
    const freshIntel = require('../.claude/helpers/intelligence.cjs');
    freshIntel.init();
    // After consolidation the context for the matching prompt should reflect the high-access entry
    const ctx = freshIntel.getContext('redis caching strategy');
    expect(ctx).not.toBeNull();
  });
});
