/**
 * Tests for fix-aqe's INTEL-ROOTWALK-V1 dist patch (lib/fix-aqe.sh Step 10).
 *
 * .claude/helpers/intelligence.cjs's resolveProjectRoot() walks UP from cwd
 * looking for a project marker. Revision history:
 *
 *   PRISTINE (original defect) — a bare `.claude-flow` with no corroborating
 *     `.git` is accepted at ANY ancestor depth with no further check — a
 *     shared/ancestor directory (e.g. the OS temp root, or $HOME) can
 *     accumulate a stray `.claude-flow` from an unrelated writer, and any
 *     nested fixture/subdir lacking its own marker silently inherits that
 *     ancestor's project state (B22/B23).
 *   v1 "depth-0" — fixed that by trusting a bare `.claude-flow` only at the
 *     walk's own origin. Regressed a real case: a non-git project with
 *     `.claude-flow` at its root, invoked from a subdirectory, no longer
 *     found its own project root.
 *   v2 "realpath-per-directory" — excluded $HOME/OS temp root/fs root by
 *     realpath-comparing the candidate directory against a realpath'd-only
 *     exclusion set. A caller-supplied alias-form startDir the walk never
 *     resolves could still slip past it, and it missed CI runners whose
 *     real temp root is a distinct env var from `os.tmpdir()`.
 *   v3 "boundary set, both raw+realpath string forms, +literal /tmp" —
 *     precomputed BOTH the raw and realpath'd, trailing-separator-normalized
 *     form of each boundary, string-matched at check time. Closed the v2
 *     bypass and added the literal `/tmp` + $TMPDIR/$TEMP/$TMP entries, but
 *     had two of its own real problems: (a) $TMPDIR/$TEMP/$TMP were trusted
 *     verbatim with no validation; (b) STRING comparison, even of
 *     realpath'd values, is fooled by a case-insensitive-but-preserving
 *     filesystem (macOS APFS) — realpathSync preserves input case, so a
 *     case-differing alias of a boundary never string-matched it,
 *     reproducing the ORIGINAL defect through a new alias class.
 *
 *   v4 "identity via (dev, ino)" — boundary membership decided by
 *     `fs.statSync` identity, never by comparing path strings, realpath'd or
 *     not. Closed case-aliasing, symlink-aliasing, trailing separators, and
 *     `..` segments in one mechanism, and validated $TMPDIR/$TEMP/$TMP
 *     (absolute path + existing directory) before trusting them. Had one
 *     more real problem: the boundary set is built ONCE, up front, as a
 *     one-shot snapshot with no re-check — if a single stat() failed for
 *     ANY reason during construction (EMFILE under fd pressure, an EACCES
 *     race, ENOENT/ESTALE during a remount), that boundary was silently
 *     dropped from the set for the rest of the call, even though the walk
 *     later reached that exact directory once the transient condition
 *     cleared and adopted a bare `.claude-flow` sitting there — the
 *     ORIGINAL defect, reintroduced via a construction-time race rather
 *     than an alias. This is NOT the same class as the (already-verified-
 *     safe) candidate-side fail-open: isSharedRoot's own statSync failure
 *     during the WALK is harmless because `fs.existsSync(dir/.git)`
 *     immediately after hits the identical access barrier at the identical
 *     instant, so the two failures cancel out — there is no re-check on the
 *     construction side to cancel against.
 *
 * v5 (current) — distinguishes ENOENT/ENOTDIR (genuinely absent — skip is
 * correct) from any other errno (unknown — must not silently degrade to
 * absent) while building the boundary set. An unknown failure sets a
 * `_rootwalkDegraded` flag; while degraded, the call stops trusting bare
 * `.claude-flow` entirely for its remainder (falls through to `.git` only,
 * still gated by the same isSharedRoot check as before — unchanged from the
 * disclosed, accepted yadm-dotfiles tradeoff, not a new one). Rare, and the
 * NEXT call gets a fresh boundary set and resolves correctly again — but
 * that is recovery of RESOLUTION, not of ARTIFACTS: a degraded call that
 * already wrote e.g. `.claude-flow/data` under the hook's cwd leaves that
 * directory behind. Trades occasional non-detection (and, rarely, a stray
 * write) for never adopting an unverified boundary.
 *
 * These tests extract the REAL node patcher script verbatim from its heredoc
 * in lib/fix-aqe.sh (never a hand-copied duplicate that could drift out of
 * sync) and run it against disposable fixture files — never the real
 * .claude/helpers/intelligence.cjs. They also build differential proofs
 * showing each fixed defect (including the v3 case-alias bypass specifically)
 * actually reproduces against the code it fixes.
 *
 * Assertions compare filesystem IDENTITY (dev:ino via fs.statSync), never
 * path strings — even realpath'd ones. A string comparison here can lie: on
 * a case-insensitive-but-preserving filesystem, realpathSync PRESERVES input
 * case, so two strings that look different can be the exact same directory.
 * This is not hypothetical — it produced a false "no bypass" verdict during
 * this investigation before being caught by comparing identity instead.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const FIX_AQE = path.join(REPO, 'lib', 'fix-aqe.sh');

function sameFsEntry(pathA, pathB) {
  const a = fs.statSync(pathA);
  const b = fs.statSync(pathB);
  return a.dev === b.dev && a.ino === b.ino;
}

// The exact PRISTINE (never-patched) resolveProjectRoot() body — lines 20-34
// of the real installed .claude/helpers/intelligence.cjs before any
// INTEL-ROOTWALK-V1 patch, confirmed byte-identical to the copy bundled in
// vendor/ruflo and vendor/claude-flow.
function pristineIntelligenceSource() {
  return [
    "'use strict';",
    '',
    "const fs = require('fs');",
    "const path = require('path');",
    '',
    'function resolveProjectRoot(startDir) {',
    '  if (process.env.CLAUDE_PROJECT_DIR) {',
    '    return path.resolve(process.env.CLAUDE_PROJECT_DIR);',
    '  }',
    '  let dir = path.resolve(startDir || process.cwd());',
    '  while (true) {',
    "    if (fs.existsSync(path.join(dir, '.git')) ||",
    "        fs.existsSync(path.join(dir, '.claude-flow'))) {",
    '      return dir;',
    '    }',
    '    const parent = path.dirname(dir);',
    '    if (parent === dir) return path.resolve(startDir || process.cwd());',
    '    dir = parent;',
    '  }',
    '}',
    '',
    'module.exports = { resolveProjectRoot };',
    '',
  ].join('\n');
}

// The v1 ("depth-0") patched form.
function depthZeroPatchedIntelligenceSource() {
  return [
    "'use strict';",
    '',
    "const fs = require('fs');",
    "const path = require('path');",
    '',
    'function resolveProjectRoot(startDir) {',
    '  if (process.env.CLAUDE_PROJECT_DIR) {',
    '    return path.resolve(process.env.CLAUDE_PROJECT_DIR);',
    '  }',
    '  const origin = path.resolve(startDir || process.cwd()); // INTEL-ROOTWALK-V1',
    '  let dir = origin;',
    '  while (true) {',
    "    if (fs.existsSync(path.join(dir, '.git'))) return dir;",
    '    // A bare .claude-flow with no corroborating .git is trusted only at the',
    '    // walk origin (depth 0); an ancestor bare .claude-flow (e.g. a stray',
    '    // marker left by another writer in a shared temp root) is no longer',
    '    // silently adopted while walking up.',
    "    if (dir === origin && fs.existsSync(path.join(dir, '.claude-flow'))) return dir;",
    '    const parent = path.dirname(dir);',
    '    if (parent === dir) return path.resolve(startDir || process.cwd());',
    '    dir = parent;',
    '  }',
    '}',
    '',
    'module.exports = { resolveProjectRoot };',
    '',
  ].join('\n');
}

// The v2 ("realpath-per-directory") patched form.
function realpathPerDirIntelligenceSource() {
  return [
    "'use strict';",
    '',
    "const fs = require('fs');",
    "const path = require('path');",
    '',
    'function resolveProjectRoot(startDir) {',
    '  if (process.env.CLAUDE_PROJECT_DIR) {',
    '    return path.resolve(process.env.CLAUDE_PROJECT_DIR);',
    '  }',
    '  const origin = path.resolve(startDir || process.cwd()); // INTEL-ROOTWALK-V1',
    '  // A bare .claude-flow with no corroborating .git is trusted at any walk-up',
    '  // depth EXCEPT when the candidate directory is itself shared infrastructure',
    '  // ($HOME, the OS temp root, or the filesystem root) -- those accumulate',
    '  // stray markers left by unrelated writers (the historical ~/.agentic-qe',
    '  // hijack was HOME; a stray marker at a shared OS temp root is the concrete',
    '  // case this guards). .git remains trusted at any depth -- an unambiguous',
    '  // project-root signal. A project living UNDER an excluded root (e.g.',
    '  // <tmp>/proj/.claude-flow) is unaffected -- only the root itself is',
    '  // excluded, not its children.',
    '  const _rootwalkRealpath = (p) => { try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); } };',
    '  const _rootwalkExcluded = new Set();',
    "  try { _rootwalkExcluded.add(_rootwalkRealpath(require('os').homedir())); } catch (e) {}",
    "  try { _rootwalkExcluded.add(_rootwalkRealpath(require('os').tmpdir())); } catch (e) {}",
    '  _rootwalkExcluded.add(path.resolve(path.parse(origin).root));',
    '  const isSharedRoot = (d) => _rootwalkExcluded.has(_rootwalkRealpath(d));',
    '  let dir = origin;',
    '  while (true) {',
    "    if (fs.existsSync(path.join(dir, '.git'))) return dir;",
    "    if (fs.existsSync(path.join(dir, '.claude-flow')) && !isSharedRoot(dir)) return dir;",
    '    const parent = path.dirname(dir);',
    '    if (parent === dir) return path.resolve(startDir || process.cwd());',
    '    dir = parent;',
    '  }',
    '}',
    '',
    'module.exports = { resolveProjectRoot };',
    '',
  ].join('\n');
}

// The LITERAL "realpath-only" reading of the original one-line spec ("exclude
// the realpath'd OS temp root"): the exclusion value is realpath'd, but the
// WALKED candidate directory is compared raw, un-realpath'd. This is NOT what
// was actually shipped as v2 above (which defensively realpath'd the
// candidate too, and empirically does not reproduce the alias bypass below).
// It reproduces the exact bypass named in review: a caller can pass (or the
// walk can construct, from an alias-form startDir) a candidate directory
// string that never gets resolved, so a realpath'd-only exclusion set never
// string-matches it.
function naiveRealpathOnlyIntelligenceSource() {
  return [
    "'use strict';",
    '',
    "const fs = require('fs');",
    "const path = require('path');",
    '',
    'function resolveProjectRoot(startDir) {',
    '  if (process.env.CLAUDE_PROJECT_DIR) {',
    '    return path.resolve(process.env.CLAUDE_PROJECT_DIR);',
    '  }',
    "  const _excludedTmp = fs.realpathSync(require('os').tmpdir());",
    '  let dir = path.resolve(startDir || process.cwd());',
    '  while (true) {',
    "    if (fs.existsSync(path.join(dir, '.git'))) return dir;",
    "    if (fs.existsSync(path.join(dir, '.claude-flow')) && dir !== _excludedTmp) return dir;",
    '    const parent = path.dirname(dir);',
    '    if (parent === dir) return path.resolve(startDir || process.cwd());',
    '    dir = parent;',
    '  }',
    '}',
    '',
    'module.exports = { resolveProjectRoot };',
    '',
  ].join('\n');
}

// The v3 form as it first shipped, BEFORE the literal '/tmp' boundary entry
// was added.
function v3WithoutTmpIntelligenceSource() {
  return [
    "'use strict';",
    '',
    "const fs = require('fs');",
    "const path = require('path');",
    '',
    'function resolveProjectRoot(startDir) {',
    '  if (process.env.CLAUDE_PROJECT_DIR) {',
    '    return path.resolve(process.env.CLAUDE_PROJECT_DIR);',
    '  }',
    '  const origin = path.resolve(startDir || process.cwd()); // INTEL-ROOTWALK-V1',
    '  // A bare .claude-flow OR .git is trusted at any walk-up depth EXCEPT when',
    '  // the candidate directory IS itself shared infrastructure ($HOME, the OS',
    '  // temp root incl. TMPDIR/TEMP/TMP, or the filesystem root) -- those',
    '  // accumulate stray markers left by unrelated writers (the historical',
    '  // ~/.agentic-qe hijack was HOME; a stray marker at a shared OS temp root',
    '  // is the concrete case this guards; a yadm-style dotfiles .git at $HOME',
    '  // is the same hazard through a different marker, so both markers are',
    '  // excluded uniformly at a boundary, not just .claude-flow). The boundary',
    '  // set is precomputed ONCE per call (never per directory in the walk) and',
    "  // stores BOTH the raw and the realpath'd form of each entry, normalized --",
    '  // a caller can pass an alias-form startDir, and the walk itself never',
    "  // resolves symlinks, so matching only the realpath'd form would miss it.",
    '  // A project living UNDER an excluded root is unaffected -- only the root',
    '  // itself is excluded, not its children. If the origin itself is a',
    '  // boundary, the walk exhausts and falls back to the origin.',
    '  const _rootwalkNorm = (p) => {',
    '    const s = String(p);',
    "    const stripped = s.replace(/[\\\\/]+$/, '');",
    '    return stripped.length > 0 ? stripped : s.slice(0, 1);',
    '  };',
    '  const _rootwalkBoundary = new Set();',
    '  const _rootwalkAddBoundary = (p) => {',
    '    if (!p) return;',
    '    _rootwalkBoundary.add(_rootwalkNorm(p));',
    '    try { _rootwalkBoundary.add(_rootwalkNorm(fs.realpathSync(p))); } catch (e) {}',
    '  };',
    "  try { _rootwalkAddBoundary(require('os').homedir()); } catch (e) {}",
    "  try { _rootwalkAddBoundary(require('os').tmpdir()); } catch (e) {}",
    '  try { _rootwalkAddBoundary(process.env.TMPDIR); } catch (e) {}',
    '  try { _rootwalkAddBoundary(process.env.TEMP); } catch (e) {}',
    '  try { _rootwalkAddBoundary(process.env.TMP); } catch (e) {}',
    '  try { _rootwalkAddBoundary(path.parse(origin).root); } catch (e) {}',
    '  const isSharedRoot = (d) => _rootwalkBoundary.has(_rootwalkNorm(d));',
    '  let dir = origin;',
    '  while (true) {',
    '    if (!isSharedRoot(dir)) {',
    "      if (fs.existsSync(path.join(dir, '.git'))) return dir;",
    "      if (fs.existsSync(path.join(dir, '.claude-flow'))) return dir;",
    '    }',
    '    const parent = path.dirname(dir);',
    '    if (parent === dir) return path.resolve(startDir || process.cwd());',
    '    dir = parent;',
    '  }',
    '}',
    '',
    'module.exports = { resolveProjectRoot };',
    '',
  ].join('\n');
}

// The v3 form AS ACTUALLY SHIPPED and installed on this host before the v4
// migration — with the literal '/tmp' entry, but still STRING-based
// (raw+realpath'd, normalized) boundary comparison. This is the anchor most
// likely to be encountered on a real target today, and the one whose
// case-aliasing bypass is the subject of the differential proof below.
function v3WithTmpIntelligenceSource() {
  return [
    "'use strict';",
    '',
    "const fs = require('fs');",
    "const path = require('path');",
    '',
    'function resolveProjectRoot(startDir) {',
    '  if (process.env.CLAUDE_PROJECT_DIR) {',
    '    return path.resolve(process.env.CLAUDE_PROJECT_DIR);',
    '  }',
    '  const origin = path.resolve(startDir || process.cwd()); // INTEL-ROOTWALK-V1',
    '  // A bare .claude-flow OR .git is trusted at any walk-up depth EXCEPT when',
    '  // the candidate directory IS itself shared infrastructure ($HOME, the OS',
    '  // temp root incl. TMPDIR/TEMP/TMP, or the filesystem root) -- those',
    '  // accumulate stray markers left by unrelated writers (the historical',
    '  // ~/.agentic-qe hijack was HOME; a stray marker at a shared OS temp root',
    '  // is the concrete case this guards; a yadm-style dotfiles .git at $HOME',
    '  // is the same hazard through a different marker, so both markers are',
    '  // excluded uniformly at a boundary, not just .claude-flow). The boundary',
    '  // set is precomputed ONCE per call (never per directory in the walk) and',
    "  // stores BOTH the raw and the realpath'd form of each entry, normalized --",
    '  // a caller can pass an alias-form startDir, and the walk itself never',
    "  // resolves symlinks, so matching only the realpath'd form would miss it.",
    '  // A project living UNDER an excluded root is unaffected -- only the root',
    '  // itself is excluded, not its children. If the origin itself is a',
    '  // boundary, the walk exhausts and falls back to the origin.',
    '  const _rootwalkNorm = (p) => {',
    '    const s = String(p);',
    "    const stripped = s.replace(/[\\\\/]+$/, '');",
    '    return stripped.length > 0 ? stripped : s.slice(0, 1);',
    '  };',
    '  const _rootwalkBoundary = new Set();',
    '  const _rootwalkAddBoundary = (p) => {',
    '    if (!p) return;',
    '    _rootwalkBoundary.add(_rootwalkNorm(p));',
    '    try { _rootwalkBoundary.add(_rootwalkNorm(fs.realpathSync(p))); } catch (e) {}',
    '  };',
    "  try { _rootwalkAddBoundary(require('os').homedir()); } catch (e) {}",
    "  try { _rootwalkAddBoundary(require('os').tmpdir()); } catch (e) {}",
    "  try { _rootwalkAddBoundary('/tmp'); } catch (e) {}",
    '  try { _rootwalkAddBoundary(process.env.TMPDIR); } catch (e) {}',
    '  try { _rootwalkAddBoundary(process.env.TEMP); } catch (e) {}',
    '  try { _rootwalkAddBoundary(process.env.TMP); } catch (e) {}',
    '  try { _rootwalkAddBoundary(path.parse(origin).root); } catch (e) {}',
    '  const isSharedRoot = (d) => _rootwalkBoundary.has(_rootwalkNorm(d));',
    '  let dir = origin;',
    '  while (true) {',
    '    if (!isSharedRoot(dir)) {',
    "      if (fs.existsSync(path.join(dir, '.git'))) return dir;",
    "      if (fs.existsSync(path.join(dir, '.claude-flow'))) return dir;",
    '    }',
    '    const parent = path.dirname(dir);',
    '    if (parent === dir) return path.resolve(startDir || process.cwd());',
    '    dir = parent;',
    '  }',
    '}',
    '',
    'module.exports = { resolveProjectRoot };',
    '',
  ].join('\n');
}

// The CURRENT v4 (identity-based) resolveProjectRoot body, matching the real
// installed .claude/helpers/intelligence.cjs logic exactly (comments omitted
// here since these fixtures are require()'d directly for behavior testing,
// not run through the patcher, so byte-exact anchor text is not required).
// Used as the base for the two mutation variants below, proving each of
// _rootwalkValidEnvTemp's isAbsolute() check and _rootwalkStatSafe's
// try/catch is genuinely load-bearing rather than redundant with other
// guards.
function v4CurrentIntelligenceSource() {
  return [
    "'use strict';",
    '',
    "const fs = require('fs');",
    "const path = require('path');",
    '',
    'function resolveProjectRoot(startDir) {',
    '  if (process.env.CLAUDE_PROJECT_DIR) {',
    '    return path.resolve(process.env.CLAUDE_PROJECT_DIR);',
    '  }',
    '  const origin = path.resolve(startDir || process.cwd()); // INTEL-ROOTWALK-V1',
    '  // A bare .claude-flow OR .git is trusted at any walk-up depth EXCEPT when',
    '  // the candidate directory IS itself shared infrastructure ($HOME, the OS',
    '  // temp root incl. the literal /tmp + TMPDIR/TEMP/TMP, or the filesystem',
    '  // root). Identity is compared by (dev, ino) from fs.statSync, NOT by',
    '  // string -- a prior string-based revision (even after realpath) was',
    '  // fooled by case-insensitive-but-preserving filesystems (macOS APFS):',
    '  // realpathSync preserves input case, so a case-differing alias of $HOME',
    '  // never string-matched the boundary set and a stray marker there was',
    '  // adopted anyway. Comparing filesystem identity instead closes',
    "  // case-aliasing, symlink-aliasing, trailing separators, and '..'",
    '  // segments in one move, with no platform gating and no normalization',
    '  // guesswork. TMPDIR/TEMP/TMP are validated (absolute + existing) before',
    '  // being trusted, since they are operator-controlled and a plausible CI',
    '  // misconfiguration (e.g. TMPDIR pointed at a real build/project',
    "  // directory) would otherwise exclude that project's own marker from",
    '  // every subdirectory -- validation rejects empty/relative/nonexistent',
    "  // values, but cannot distinguish 'meant as a temp root' from",
    "  // 'misconfigured to point at a real project' without guessing, so that",
    '  // residual failure mode is accepted and covered by a test, not hidden.',
    '  // A project living UNDER an excluded root is unaffected -- only the root',
    '  // itself is excluded, not its children. If the origin itself is a',
    '  // boundary, the walk exhausts and falls back to the origin. There is',
    '  // exactly one production call site (module load, below) at a depth of a',
    '  // few levels per fresh hook subprocess -- correctness, not per-level',
    '  // cost, is what matters here.',
    '  const _rootwalkStatSafe = (p) => { try { return fs.statSync(p); } catch (e) { return null; } };',
    '  const _rootwalkValidEnvTemp = (p) => !!p && path.isAbsolute(p) && fs.existsSync(p);',
    '  const _rootwalkBoundaryIds = new Set();',
    '  const _rootwalkAddBoundary = (p) => {',
    '    if (!p) return;',
    '    const st = _rootwalkStatSafe(p);',
    "    if (st) _rootwalkBoundaryIds.add(st.dev + ':' + st.ino);",
    '  };',
    "  try { _rootwalkAddBoundary(require('os').homedir()); } catch (e) {}",
    "  try { _rootwalkAddBoundary(require('os').tmpdir()); } catch (e) {}",
    "  try { _rootwalkAddBoundary('/tmp'); } catch (e) {}",
    '  try { if (_rootwalkValidEnvTemp(process.env.TMPDIR)) _rootwalkAddBoundary(process.env.TMPDIR); } catch (e) {}',
    '  try { if (_rootwalkValidEnvTemp(process.env.TEMP)) _rootwalkAddBoundary(process.env.TEMP); } catch (e) {}',
    '  try { if (_rootwalkValidEnvTemp(process.env.TMP)) _rootwalkAddBoundary(process.env.TMP); } catch (e) {}',
    '  try { _rootwalkAddBoundary(path.parse(origin).root); } catch (e) {}',
    '  const isSharedRoot = (d) => {',
    '    const st = _rootwalkStatSafe(d);',
    "    return st ? _rootwalkBoundaryIds.has(st.dev + ':' + st.ino) : false;",
    '  };',
    '  let dir = origin;',
    '  while (true) {',
    '    if (!isSharedRoot(dir)) {',
    "      if (fs.existsSync(path.join(dir, '.git'))) return dir;",
    "      if (fs.existsSync(path.join(dir, '.claude-flow'))) return dir;",
    '    }',
    '    const parent = path.dirname(dir);',
    '    if (parent === dir) return path.resolve(startDir || process.cwd());',
    '    dir = parent;',
    '  }',
    '}',
    '',
    'module.exports = { resolveProjectRoot };',
    '',
  ].join('\n');
}

// Mutation: delete _rootwalkValidEnvTemp's isAbsolute() check (keep
// existsSync). Proves the branch is load-bearing rather than redundant with
// the `if (!p) return` guard (covers empty) and statSync's try/catch
// (covers nonexistent) — those two already make the three "rejects
// empty/relative/nonexistent" tests in intelligence-utils.test.js pass
// whether or not isAbsolute() is present, which is exactly why they don't
// prove anything on their own.
function v4WithoutIsAbsoluteSource() {
  const src = v4CurrentIntelligenceSource();
  const before = '  const _rootwalkValidEnvTemp = (p) => !!p && path.isAbsolute(p) && fs.existsSync(p);';
  const after = '  const _rootwalkValidEnvTemp = (p) => !!p && fs.existsSync(p);';
  if (!src.includes(before)) throw new Error('v4WithoutIsAbsoluteSource: anchor not found in v4CurrentIntelligenceSource');
  return src.split(before).join(after);
}

// Mutation: delete _rootwalkStatSafe's internal try/catch. isSharedRoot(dir)
// calls it unguarded inside the walk loop (unlike the boundary-building
// side, which double-guards each _rootwalkAddBoundary call with its own
// outer try/catch) — proves the internal catch is load-bearing, not
// redundant defence-in-depth.
function v4WithoutStatSafeCatchSource() {
  const src = v4CurrentIntelligenceSource();
  const before = "  const _rootwalkStatSafe = (p) => { try { return fs.statSync(p); } catch (e) { return null; } };";
  const after = '  const _rootwalkStatSafe = (p) => fs.statSync(p);';
  if (!src.includes(before)) throw new Error('v4WithoutStatSafeCatchSource: anchor not found in v4CurrentIntelligenceSource');
  return src.split(before).join(after);
}

// The CURRENT v5 resolveProjectRoot body, matching the real installed
// .claude/helpers/intelligence.cjs logic exactly. Distinguishes ENOENT/
// ENOTDIR (genuinely absent) from any other errno (unknown -> sets
// _rootwalkDegraded, which disables bare .claude-flow trust for the rest
// of the call) while building the boundary set.
function v5CurrentIntelligenceSource() {
  return [
    "'use strict';",
    '',
    "const fs = require('fs');",
    "const path = require('path');",
    '',
    'function resolveProjectRoot(startDir) {',
    '  if (process.env.CLAUDE_PROJECT_DIR) {',
    '    return path.resolve(process.env.CLAUDE_PROJECT_DIR);',
    '  }',
    '  const origin = path.resolve(startDir || process.cwd());',
    '  const _rootwalkStatSafe = (p) => { try { return fs.statSync(p); } catch (e) { return null; } };',
    '  const _rootwalkValidEnvTemp = (p) => !!p && path.isAbsolute(p) && fs.existsSync(p);',
    '  const _rootwalkBoundaryIds = new Set();',
    '  let _rootwalkDegraded = false;',
    '  const _rootwalkAddBoundary = (p) => {',
    '    if (!p) return;',
    '    try {',
    '      const st = fs.statSync(p);',
    "      _rootwalkBoundaryIds.add(st.dev + ':' + st.ino);",
    '    } catch (e) {',
    "      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return;",
    '      _rootwalkDegraded = true;',
    '    }',
    '  };',
    "  try { _rootwalkAddBoundary(require('os').homedir()); } catch (e) { _rootwalkDegraded = true; }",
    "  try { _rootwalkAddBoundary(require('os').tmpdir()); } catch (e) { _rootwalkDegraded = true; }",
    "  try { _rootwalkAddBoundary('/tmp'); } catch (e) { _rootwalkDegraded = true; }",
    '  try { if (_rootwalkValidEnvTemp(process.env.TMPDIR)) _rootwalkAddBoundary(process.env.TMPDIR); } catch (e) { _rootwalkDegraded = true; }',
    '  try { if (_rootwalkValidEnvTemp(process.env.TEMP)) _rootwalkAddBoundary(process.env.TEMP); } catch (e) { _rootwalkDegraded = true; }',
    '  try { if (_rootwalkValidEnvTemp(process.env.TMP)) _rootwalkAddBoundary(process.env.TMP); } catch (e) { _rootwalkDegraded = true; }',
    '  try { _rootwalkAddBoundary(path.parse(origin).root); } catch (e) { _rootwalkDegraded = true; }',
    '  const isSharedRoot = (d) => {',
    '    const st = _rootwalkStatSafe(d);',
    "    return st ? _rootwalkBoundaryIds.has(st.dev + ':' + st.ino) : false;",
    '  };',
    '  let dir = origin;',
    '  while (true) {',
    '    if (!isSharedRoot(dir)) {',
    "      if (fs.existsSync(path.join(dir, '.git'))) return dir;",
    "      if (!_rootwalkDegraded && fs.existsSync(path.join(dir, '.claude-flow'))) return dir;",
    '    }',
    '    const parent = path.dirname(dir);',
    '    if (parent === dir) return path.resolve(startDir || process.cwd());',
    '    dir = parent;',
    '  }',
    '}',
    '',
    'module.exports = { resolveProjectRoot };',
    '',
  ].join('\n');
}

// Mutation: revert to treating ANY stat failure during boundary construction
// as "this boundary does not exist" (no ENOENT/ENOTDIR-vs-unknown
// distinction, no _rootwalkDegraded gate on bare .claude-flow). This is
// exactly the v4 shape's boundary-construction behavior. Proves the errno
// distinction + degraded-boundary handling is load-bearing, not redundant.
function v5WithoutDegradedHandlingSource() {
  const src = v5CurrentIntelligenceSource();
  const before = [
    '  let _rootwalkDegraded = false;',
    '  const _rootwalkAddBoundary = (p) => {',
    '    if (!p) return;',
    '    try {',
    '      const st = fs.statSync(p);',
    "      _rootwalkBoundaryIds.add(st.dev + ':' + st.ino);",
    '    } catch (e) {',
    "      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return;",
    '      _rootwalkDegraded = true;',
    '    }',
    '  };',
  ].join('\n');
  const after = [
    '  const _rootwalkAddBoundary = (p) => {',
    '    if (!p) return;',
    '    const st = _rootwalkStatSafe(p);',
    "    if (st) _rootwalkBoundaryIds.add(st.dev + ':' + st.ino);",
    '  };',
  ].join('\n');
  if (!src.includes(before)) throw new Error('v5WithoutDegradedHandlingSource: anchor not found in v5CurrentIntelligenceSource');
  let mutated = src.split(before).join(after);
  // Also strip the _rootwalkDegraded references from the outer try/catch
  // sites and the .claude-flow gate, so the mutated fixture is valid JS
  // with no dangling references to a flag that no longer exists.
  mutated = mutated
    .split("catch (e) { _rootwalkDegraded = true; }").join('catch (e) {}')
    .split('!_rootwalkDegraded && ').join('');
  if (mutated.includes('_rootwalkDegraded')) {
    throw new Error('v5WithoutDegradedHandlingSource: _rootwalkDegraded reference remains after mutation');
  }
  return mutated;
}

// ISOLATING mutation: keep the errno-split bookkeeping fully intact
// (ENOENT/ENOTDIR still skip correctly, any other errno still sets
// _rootwalkDegraded) but strip ONLY the flag's EFFECT on the .claude-flow
// gate. v5WithoutDegradedHandlingSource above reverts BOTH the errno-split
// AND the gate at once, so it cannot tell you which half a broken mutation
// actually touches — a change that silently drops just the gate's effect
// while leaving the bookkeeping in place would pass a mutation matrix built
// only from that one fixture. This isolates the "does the flag do anything"
// question from the "is the errno distinguished correctly" question.
function v5WithGateNeuteredSource() {
  const src = v5CurrentIntelligenceSource();
  const before = "      if (!_rootwalkDegraded && fs.existsSync(path.join(dir, '.claude-flow'))) return dir;";
  const after = "      if (fs.existsSync(path.join(dir, '.claude-flow'))) return dir;";
  if (!src.includes(before)) throw new Error('v5WithGateNeuteredSource: anchor not found in v5CurrentIntelligenceSource');
  const mutated = src.split(before).join(after);
  // The bookkeeping must survive untouched -- this mutation isolates the
  // gate, not the errno-split.
  if (!mutated.includes("e.code === 'ENOENT'") || !mutated.includes("e.code === 'ENOTDIR'")) {
    throw new Error('v5WithGateNeuteredSource: errno-split bookkeeping was unexpectedly removed');
  }
  if (!mutated.includes('_rootwalkDegraded = true;')) {
    throw new Error('v5WithGateNeuteredSource: _rootwalkDegraded assignment was unexpectedly removed');
  }
  if (mutated.includes('!_rootwalkDegraded')) {
    throw new Error('v5WithGateNeuteredSource: the gate was not actually neutered');
  }
  return mutated;
}

// Extract the patcher JS verbatim from its `cat > "$patcher" <<'PJS' ... PJS`
// heredoc in lib/fix-aqe.sh — the exact bytes bin/ruflo-kit fix-aqe runs.
function extractPatcherScript() {
  const src = fs.readFileSync(FIX_AQE, 'utf8');
  const marker = "cat > \"$patcher\" <<'PJS'";
  const start = src.indexOf(marker);
  if (start === -1) throw new Error('INTEL-ROOTWALK-V1 patcher heredoc marker not found in fix-aqe.sh');
  const heredocStart = src.indexOf('\n', start) + 1;
  const end = src.indexOf('\nPJS', heredocStart);
  if (end === -1) throw new Error('INTEL-ROOTWALK-V1 patcher heredoc close not found in fix-aqe.sh');
  return src.slice(heredocStart, end);
}

let tmpDir;
let patcherPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intel-rootwalk-patch-'));
  patcherPath = path.join(tmpDir, 'patcher.js');
  fs.writeFileSync(patcherPath, extractPatcherScript());
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runPatcher(targetFile) {
  return spawnSync(process.execPath, [patcherPath, targetFile], { encoding: 'utf8', timeout: 8000 });
}

// Build a synthetic fixture tree under /tmp (NOT os.tmpdir()) so
// boundary-exclusion behavior can be exercised deterministically without
// depending on (or interfering with) the real ambient os.tmpdir(), which is
// a directory other concurrently-running processes/tests also write into.
function freshFixtureBase() {
  return fs.mkdtempSync(path.join('/tmp', 'intel-rootwalk-fixture-'));
}

describe('INTEL-ROOTWALK-V1 patcher — applies to a pristine dist', () => {
  it('rewrites the walk-up to an identity-based (dev,ino) boundary exclusion', () => {
    const target = path.join(tmpDir, 'intelligence.cjs');
    fs.writeFileSync(target, pristineIntelligenceSource());

    const r = runPatcher(target);
    expect(r.status).toBe(0);

    const patched = fs.readFileSync(target, 'utf8');
    expect(patched).toContain('INTEL-ROOTWALK-V1');
    expect(patched).toContain('_rootwalkBoundaryIds');
    expect(patched).toContain('const origin = path.resolve(startDir || process.cwd())');
  });

  it('node --check accepts the patched output (valid JS)', () => {
    const target = path.join(tmpDir, 'intelligence.cjs');
    fs.writeFileSync(target, pristineIntelligenceSource());
    runPatcher(target);

    const check = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
    expect(check.status).toBe(0);
  });
});

describe('INTEL-ROOTWALK-V1 patcher — migrates every superseded patched form in one hop', () => {
  it('rewrites the v1 (depth-0) form forward to v4', () => {
    const target = path.join(tmpDir, 'intelligence.cjs');
    fs.writeFileSync(target, depthZeroPatchedIntelligenceSource());
    expect(fs.readFileSync(target, 'utf8')).not.toContain('_rootwalkBoundaryIds');

    const r = runPatcher(target);
    expect(r.status).toBe(0);

    const patched = fs.readFileSync(target, 'utf8');
    expect(patched).toContain('_rootwalkBoundaryIds');
    expect(patched).toContain("_rootwalkAddBoundary('/tmp')");
    expect(patched).not.toContain('dir === origin &&'); // the old depth-0 gate is gone
  });

  it('rewrites the v2 (realpath-per-directory) form forward to v4', () => {
    const target = path.join(tmpDir, 'intelligence.cjs');
    fs.writeFileSync(target, realpathPerDirIntelligenceSource());
    expect(fs.readFileSync(target, 'utf8')).not.toContain('_rootwalkBoundaryIds');

    const r = runPatcher(target);
    expect(r.status).toBe(0);

    const patched = fs.readFileSync(target, 'utf8');
    expect(patched).toContain('_rootwalkBoundaryIds');
    expect(patched).not.toContain('_rootwalkExcluded'); // the old v2 exclusion set is gone
  });

  it('rewrites the v3-without-/tmp form forward to v4', () => {
    const target = path.join(tmpDir, 'intelligence.cjs');
    fs.writeFileSync(target, v3WithoutTmpIntelligenceSource());
    expect(fs.readFileSync(target, 'utf8')).not.toContain('_rootwalkBoundaryIds');

    const r = runPatcher(target);
    expect(r.status).toBe(0);

    const patched = fs.readFileSync(target, 'utf8');
    expect(patched).toContain('_rootwalkBoundaryIds');
    expect(patched).toContain("_rootwalkAddBoundary('/tmp')");
    expect(patched).not.toContain('_rootwalkNorm'); // the old string-normalization mechanism is gone
  });

  it('rewrites the v3-with-/tmp form (the form actually installed on this host) forward to v4', () => {
    // This is the most important migration path: it is what a real target
    // running fix-aqe today actually has installed.
    const target = path.join(tmpDir, 'intelligence.cjs');
    fs.writeFileSync(target, v3WithTmpIntelligenceSource());
    expect(fs.readFileSync(target, 'utf8')).not.toContain('_rootwalkBoundaryIds');

    const r = runPatcher(target);
    expect(r.status).toBe(0);

    const patched = fs.readFileSync(target, 'utf8');
    expect(patched).toContain('_rootwalkBoundaryIds');
    expect(patched).toContain('st.dev');
    expect(patched).toContain('st.ino');
    expect(patched).not.toContain('_rootwalkNorm');
    expect(patched).not.toContain('_rootwalkBoundary.has'); // the old string-set mechanism is gone
  });

  it('rewrites the v4 form (identity-based, no degraded-boundary handling) forward to v5', () => {
    // This is the migration path required for THIS repo's own real installed
    // file as of this round: it was on v4 before this fix.
    const target = path.join(tmpDir, 'intelligence.cjs');
    const before = v4CurrentIntelligenceSource();
    fs.writeFileSync(target, before);
    expect(before).not.toContain('_rootwalkDegraded');

    const r = runPatcher(target);
    expect(r.status).toBe(0);

    const patched = fs.readFileSync(target, 'utf8');
    // Structural: the migration actually landed the new machinery.
    expect(patched).toContain('_rootwalkDegraded');
    expect(patched).toContain("e.code === 'ENOENT'");
    expect(patched).toContain("e.code === 'ENOTDIR'");
    expect(patched).toContain('!_rootwalkDegraded &&');

    // Behavioral, not just textual: the migrated FILE actually honors the
    // degraded-boundary trade-off, not merely a string that looks right.
    // A patcher that emitted the gate text in a comment, or wired it to the
    // wrong variable, would still pass the toContain() checks above but
    // fail this.
    delete require.cache[require.resolve(target)];
    const migrated = require(target);
    const base = freshFixtureBase();
    const origTmpdir = require('os').tmpdir;
    try {
      const legitProject = fs.mkdtempSync(path.join(base, 'legit-'));
      fs.mkdirSync(path.join(legitProject, '.claude-flow'), { recursive: true });
      const legitDeep = path.join(legitProject, 'sub');
      fs.mkdirSync(legitDeep, { recursive: true });
      const poisoned = fs.mkdtempSync(path.join(base, 'poisoned-'));

      require('os').tmpdir = () => poisoned;
      const origStatSync = fs.statSync;
      let thrown = false;
      fs.statSync = function (p, ...rest) {
        if (!thrown && p === poisoned) {
          thrown = true;
          const err = new Error('EMFILE');
          err.code = 'EMFILE';
          throw err;
        }
        return origStatSync.call(fs, p, ...rest);
      };
      let resolved;
      try {
        delete process.env.CLAUDE_PROJECT_DIR;
        resolved = migrated.resolveProjectRoot(legitDeep);
      } finally {
        fs.statSync = origStatSync;
      }
      expect(thrown).toBe(true);
      expect(sameFsEntry(resolved, legitDeep)).toBe(true);
      expect(sameFsEntry(resolved, legitProject)).toBe(false);
    } finally {
      require('os').tmpdir = origTmpdir;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('node --check accepts all five migrated outputs (valid JS)', () => {
    const targetV1 = path.join(tmpDir, 'v1.cjs');
    fs.writeFileSync(targetV1, depthZeroPatchedIntelligenceSource());
    runPatcher(targetV1);
    expect(spawnSync(process.execPath, ['--check', targetV1], { encoding: 'utf8' }).status).toBe(0);

    const targetV2 = path.join(tmpDir, 'v2.cjs');
    fs.writeFileSync(targetV2, realpathPerDirIntelligenceSource());
    runPatcher(targetV2);
    expect(spawnSync(process.execPath, ['--check', targetV2], { encoding: 'utf8' }).status).toBe(0);

    const targetV3NoTmp = path.join(tmpDir, 'v3notmp.cjs');
    fs.writeFileSync(targetV3NoTmp, v3WithoutTmpIntelligenceSource());
    runPatcher(targetV3NoTmp);
    expect(spawnSync(process.execPath, ['--check', targetV3NoTmp], { encoding: 'utf8' }).status).toBe(0);

    const targetV3WithTmp = path.join(tmpDir, 'v3withtmp.cjs');
    fs.writeFileSync(targetV3WithTmp, v3WithTmpIntelligenceSource());
    runPatcher(targetV3WithTmp);
    expect(spawnSync(process.execPath, ['--check', targetV3WithTmp], { encoding: 'utf8' }).status).toBe(0);

    const targetV4 = path.join(tmpDir, 'v4.cjs');
    fs.writeFileSync(targetV4, v4CurrentIntelligenceSource());
    runPatcher(targetV4);
    expect(spawnSync(process.execPath, ['--check', targetV4], { encoding: 'utf8' }).status).toBe(0);
  });
});

describe('INTEL-ROOTWALK-V1 patcher — idempotency', () => {
  it('a second run against already-v5-patched output makes no further changes', () => {
    const target = path.join(tmpDir, 'intelligence.cjs');
    fs.writeFileSync(target, pristineIntelligenceSource());

    const r1 = runPatcher(target);
    expect(r1.status).toBe(0);
    const afterFirst = fs.readFileSync(target, 'utf8');

    const r2 = runPatcher(target);
    expect(r2.status).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe(afterFirst);
  });

  it('migrating a v1 fixture then re-running is idempotent too', () => {
    const target = path.join(tmpDir, 'intelligence.cjs');
    fs.writeFileSync(target, depthZeroPatchedIntelligenceSource());
    runPatcher(target);
    const afterMigration = fs.readFileSync(target, 'utf8');
    runPatcher(target);
    expect(fs.readFileSync(target, 'utf8')).toBe(afterMigration);
  });

  it('migrating a v2 fixture then re-running is idempotent too', () => {
    const target = path.join(tmpDir, 'intelligence.cjs');
    fs.writeFileSync(target, realpathPerDirIntelligenceSource());
    runPatcher(target);
    const afterMigration = fs.readFileSync(target, 'utf8');
    runPatcher(target);
    expect(fs.readFileSync(target, 'utf8')).toBe(afterMigration);
  });

  it('migrating a v3-without-/tmp fixture then re-running is idempotent too', () => {
    const target = path.join(tmpDir, 'intelligence.cjs');
    fs.writeFileSync(target, v3WithoutTmpIntelligenceSource());
    runPatcher(target);
    const afterMigration = fs.readFileSync(target, 'utf8');
    runPatcher(target);
    expect(fs.readFileSync(target, 'utf8')).toBe(afterMigration);
  });

  it('migrating a v3-with-/tmp fixture then re-running is idempotent too', () => {
    const target = path.join(tmpDir, 'intelligence.cjs');
    fs.writeFileSync(target, v3WithTmpIntelligenceSource());
    runPatcher(target);
    const afterMigration = fs.readFileSync(target, 'utf8');
    runPatcher(target);
    expect(fs.readFileSync(target, 'utf8')).toBe(afterMigration);
  });

  it('migrating a v4 fixture then re-running is idempotent too', () => {
    const target = path.join(tmpDir, 'intelligence.cjs');
    fs.writeFileSync(target, v4CurrentIntelligenceSource());
    runPatcher(target);
    const afterMigration = fs.readFileSync(target, 'utf8');
    runPatcher(target);
    expect(fs.readFileSync(target, 'utf8')).toBe(afterMigration);
  });

  it('exits 0 immediately (no anchor lookup) when already at the current v5 form', () => {
    const target = path.join(tmpDir, 'intelligence.cjs');
    // A file that already carries _rootwalkDegraded but none of the six
    // recognized pre-patch anchors — if the patcher re-checked anchors here
    // it would wrongly report ANCHOR_NOT_FOUND. It must short-circuit on
    // that marker alone.
    fs.writeFileSync(target, '// _rootwalkDegraded already present\nmodule.exports = {};\n');
    const before = fs.readFileSync(target, 'utf8');

    const r = runPatcher(target);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
  });
});

describe('INTEL-ROOTWALK-V1 patcher — fails closed on drift (no partial application)', () => {
  it('writes NOTHING and reports ANCHOR_NOT_FOUND when the pristine anchor has drifted', () => {
    const target = path.join(tmpDir, 'intelligence.cjs');
    const drifted = pristineIntelligenceSource().replace(
      'let dir = path.resolve(startDir || process.cwd());',
      'let projectDir = path.resolve(startDir || process.cwd());'
    );
    fs.writeFileSync(target, drifted);
    const before = fs.readFileSync(target, 'utf8');

    const r = runPatcher(target);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/ANCHOR_NOT_FOUND/);

    const after = fs.readFileSync(target, 'utf8');
    expect(after).toBe(before); // byte-for-byte untouched — nothing partial written
    expect(after).not.toContain('_rootwalkDegraded');
  });

  it('writes NOTHING and reports ANCHOR_NOT_FOUND when the v1 anchor has drifted', () => {
    const target = path.join(tmpDir, 'intelligence.cjs');
    const drifted = depthZeroPatchedIntelligenceSource().replace(
      'if (dir === origin &&',
      'if (dir == origin &&' // subtly reformatted, no longer byte-exact
    );
    fs.writeFileSync(target, drifted);
    const before = fs.readFileSync(target, 'utf8');

    const r = runPatcher(target);
    expect(r.status).toBe(2);
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
  });

  it('writes NOTHING and reports ANCHOR_NOT_FOUND when the v2 anchor has drifted', () => {
    const target = path.join(tmpDir, 'intelligence.cjs');
    const drifted = realpathPerDirIntelligenceSource().replace(
      '_rootwalkExcluded.has',
      '_rootwalkExcluded  .has' // subtly reformatted, no longer byte-exact
    );
    fs.writeFileSync(target, drifted);
    const before = fs.readFileSync(target, 'utf8');

    const r = runPatcher(target);
    expect(r.status).toBe(2);
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
  });

  it('writes NOTHING and reports ANCHOR_NOT_FOUND when the v3-without-/tmp anchor has drifted', () => {
    const target = path.join(tmpDir, 'intelligence.cjs');
    const drifted = v3WithoutTmpIntelligenceSource().replace(
      "require('os').tmpdir()); } catch (e) {}\n  try { _rootwalkAddBoundary(process.env.TMPDIR",
      "require('os').tmpdir() ); } catch (e) {}\n  try { _rootwalkAddBoundary(process.env.TMPDIR" // extra space
    );
    fs.writeFileSync(target, drifted);
    const before = fs.readFileSync(target, 'utf8');

    const r = runPatcher(target);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/ANCHOR_NOT_FOUND/);
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
    expect(fs.readFileSync(target, 'utf8')).not.toContain('_rootwalkDegraded');
  });

  it('writes NOTHING and reports ANCHOR_NOT_FOUND when the v3-with-/tmp anchor has drifted', () => {
    const target = path.join(tmpDir, 'intelligence.cjs');
    const drifted = v3WithTmpIntelligenceSource().replace(
      "_rootwalkAddBoundary('/tmp')",
      "_rootwalkAddBoundary( '/tmp' )" // extra spaces, no longer byte-exact
    );
    fs.writeFileSync(target, drifted);
    const before = fs.readFileSync(target, 'utf8');

    const r = runPatcher(target);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/ANCHOR_NOT_FOUND/);
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
    expect(fs.readFileSync(target, 'utf8')).not.toContain('_rootwalkDegraded');
  });

  it('writes NOTHING and reports ANCHOR_NOT_FOUND when the v4 anchor has drifted (the form actually installed on this host before this round)', () => {
    const target = path.join(tmpDir, 'intelligence.cjs');
    const drifted = v4CurrentIntelligenceSource().replace(
      "_rootwalkBoundaryIds.add(st.dev",
      "_rootwalkBoundaryIds .add(st.dev" // extra space, no longer byte-exact
    );
    fs.writeFileSync(target, drifted);
    const before = fs.readFileSync(target, 'utf8');

    const r = runPatcher(target);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/ANCHOR_NOT_FOUND/);
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
    expect(fs.readFileSync(target, 'utf8')).not.toContain('_rootwalkDegraded');
  });

  it('handles CRLF line endings and round-trips them back on write', () => {
    const target = path.join(tmpDir, 'intelligence.cjs');
    const crlfSource = pristineIntelligenceSource().replace(/\n/g, '\r\n');
    fs.writeFileSync(target, crlfSource);

    const r = runPatcher(target);
    expect(r.status).toBe(0);

    const patched = fs.readFileSync(target, 'utf8');
    expect(patched).toContain('_rootwalkDegraded');
    expect(patched).toContain('\r\n');
    expect(patched.replace(/\r\n/g, '')).not.toMatch(/\n/);
  });
});

describe('INTEL-ROOTWALK-V1 — differential proof: each defect reproduces against the code it fixes', () => {
  // These require() the UNPATCHED fixture sources directly (not the
  // patcher's output) to prove, with real failing output, that the defect
  // this rule fixes is real — and that the real patcher resolves it. Both
  // directions matter: a suite that only catches the old bug is how the v1
  // depth-0 regression, then the v2 aliasing bypass, then the v3 case-alias
  // bypass, each shipped unnoticed in an earlier revision of this same
  // patch.

  it('ORIGINAL DEFECT reproduces against pristine code: a stray marker at an excluded boundary IS adopted', () => {
    const base = freshFixtureBase();
    try {
      const target = path.join(base, 'pristine-intel.cjs');
      fs.writeFileSync(target, pristineIntelligenceSource());
      delete require.cache[require.resolve(target)];
      const pristine = require(target);

      const sharedRoot = fs.mkdtempSync(path.join(base, 'shared-'));
      fs.mkdirSync(path.join(sharedRoot, '.claude-flow'), { recursive: true });
      const fixture = path.join(sharedRoot, 'fixture-no-marker');
      fs.mkdirSync(fixture, { recursive: true });

      delete process.env.CLAUDE_PROJECT_DIR;
      const resolved = pristine.resolveProjectRoot(fixture);
      // RED against pristine: it escapes to the shared root instead of
      // staying at the fixture.
      expect(sameFsEntry(resolved, sharedRoot)).toBe(true);
      expect(sameFsEntry(resolved, fixture)).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('V1 REGRESSION reproduces against the depth-0 patched code: a legit project subdir loses its own root', () => {
    const base = freshFixtureBase();
    try {
      const target = path.join(base, 'v1-intel.cjs');
      fs.writeFileSync(target, depthZeroPatchedIntelligenceSource());
      delete require.cache[require.resolve(target)];
      const v1 = require(target);

      const project = path.join(base, 'legit-project');
      const deepChild = path.join(project, 'src', 'nested');
      fs.mkdirSync(path.join(project, '.claude-flow'), { recursive: true });
      fs.mkdirSync(deepChild, { recursive: true });

      delete process.env.CLAUDE_PROJECT_DIR;
      const resolved = v1.resolveProjectRoot(deepChild);
      // RED against v1: depth-0 falls back to the origin instead of finding
      // the project's own root.
      expect(sameFsEntry(resolved, deepChild)).toBe(true);
      expect(sameFsEntry(resolved, project)).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('SYMLINK-ALIAS BYPASS reproduces against a literal realpath-only implementation (naive single-sided realpath)', () => {
    // Teeth proof for the exact bypass named in review. Does NOT reproduce
    // against the realpath-per-directory form actually shipped as v2
    // (verified directly against the real installed v2 file — v2
    // defensively realpaths the candidate directory too). It DOES reproduce
    // against the literal one-line reading of the original spec: a
    // boundary value that is realpath'd, compared against a candidate
    // directory that is NOT.
    const base = freshFixtureBase();
    const origTmpdir = require('os').tmpdir;
    try {
      const target = path.join(base, 'naive-intel.cjs');
      fs.writeFileSync(target, naiveRealpathOnlyIntelligenceSource());
      delete require.cache[require.resolve(target)];
      const naive = require(target);

      const sharedRootReal = fs.mkdtempSync(path.join(fs.realpathSync(base), 'aliased-'));
      const aliasedPath = path.join(base, path.basename(sharedRootReal));
      expect(sameFsEntry(aliasedPath, sharedRootReal)).toBe(true); // sanity: same dir, different string

      fs.mkdirSync(path.join(sharedRootReal, '.claude-flow'), { recursive: true });
      const fixture = path.join(aliasedPath, 'fixture-no-marker');
      fs.mkdirSync(fixture, { recursive: true });

      require('os').tmpdir = () => aliasedPath; // present the alias form
      delete process.env.CLAUDE_PROJECT_DIR;
      const resolved = naive.resolveProjectRoot(fixture);
      // RED against the naive realpath-only implementation: it does not
      // recognize the alias-form candidate directory as the boundary, so
      // the marker there is wrongly adopted.
      expect(sameFsEntry(resolved, aliasedPath)).toBe(true);
      expect(sameFsEntry(resolved, fixture)).toBe(false);
    } finally {
      require('os').tmpdir = origTmpdir;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('CASE-ALIAS BYPASS reproduces against the ACTUAL shipped v3-with-/tmp code (macOS APFS case-insensitive-but-preserving)', () => {
    // This is the teeth proof for the bug the critic found in v3: STRING
    // comparison, even of realpath'd values, is fooled by a
    // case-insensitive-but-preserving filesystem. realpathSync PRESERVES
    // input case rather than canonicalizing it, so a case-differing alias
    // of $HOME never string-matches the boundary set even after realpath —
    // a stray marker sitting there is adopted anyway. This is the ORIGINAL
    // defect reproduced through a NEW alias class, in code that was
    // actually shipped and installed on this host, not a strawman.
    const base = freshFixtureBase();
    const origHomedir = require('os').homedir;
    try {
      const target = path.join(base, 'v3-intel.cjs');
      fs.writeFileSync(target, v3WithTmpIntelligenceSource());
      delete require.cache[require.resolve(target)];
      const v3 = require(target);

      const fakeHome = fs.mkdtempSync(path.join(base, 'CaseAliasHome-'));
      fs.mkdirSync(path.join(fakeHome, '.claude-flow'), { recursive: true });
      const fixture = path.join(fakeHome, 'fixture-no-marker');
      fs.mkdirSync(fixture, { recursive: true });

      const upperCaseAlias = fakeHome.toUpperCase();
      let caseInsensitiveFs;
      try {
        caseInsensitiveFs = sameFsEntry(fakeHome, upperCaseAlias);
      } catch (e) {
        caseInsensitiveFs = false;
      }
      if (!caseInsensitiveFs) {
        // Case-sensitive filesystem: this specific bypass class doesn't
        // apply here (the alias genuinely isn't the same directory), so
        // there is nothing to reproduce — not a failure of the test.
        return;
      }

      require('os').homedir = () => upperCaseAlias;
      delete process.env.CLAUDE_PROJECT_DIR;
      const resolved = v3.resolveProjectRoot(fixture);
      // RED against v3: the case-differing alias of $HOME never
      // string-matches the boundary set, so v3 adopts the stray marker at
      // $HOME instead of staying at the fixture.
      expect(sameFsEntry(resolved, fakeHome)).toBe(true);
      expect(sameFsEntry(resolved, fixture)).toBe(false);
    } finally {
      require('os').homedir = origHomedir;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('CASE-ALIAS BYPASS is NOT $HOME-specific: reproduces against v3-with-/tmp through the literal /tmp entry too', () => {
    // The critic's finding: this bypass is systemic to the STRING
    // comparison mechanism, not a $HOME-specific quirk — it affects every
    // boundary entry the same way, including the literal /tmp entry added
    // for the CI-runner gap. Proven here through a case-differing alias of
    // /tmp itself (a synthetic one under the fixture base, not the real
    // system /tmp — this is exercised live against the real /tmp in
    // intelligence-utils.test.js instead, since that one cannot use a
    // synthetic substitute).
    const base = freshFixtureBase();
    const origTmpdir = require('os').tmpdir;
    try {
      const target = path.join(base, 'v3-tmpcase-intel.cjs');
      fs.writeFileSync(target, v3WithTmpIntelligenceSource());
      delete require.cache[require.resolve(target)];
      const v3 = require(target);

      const sharedRoot = fs.mkdtempSync(path.join(base, 'CaseAliasTmp-'));
      fs.mkdirSync(path.join(sharedRoot, '.claude-flow'), { recursive: true });
      const fixture = path.join(sharedRoot, 'fixture-no-marker');
      fs.mkdirSync(fixture, { recursive: true });

      const upperCaseAlias = sharedRoot.toUpperCase();
      let caseInsensitiveFs;
      try {
        caseInsensitiveFs = sameFsEntry(sharedRoot, upperCaseAlias);
      } catch (e) {
        caseInsensitiveFs = false;
      }
      if (!caseInsensitiveFs) {
        return; // case-sensitive filesystem: nothing to reproduce here
      }

      require('os').tmpdir = () => upperCaseAlias; // os.tmpdir() itself returns the case alias
      delete process.env.CLAUDE_PROJECT_DIR;
      const resolved = v3.resolveProjectRoot(fixture);
      // RED against v3: the case-differing alias never string-matches the
      // boundary set (the same failure mode as the $HOME case above, proving
      // it is a property of the comparison mechanism, not of any one entry).
      expect(sameFsEntry(resolved, sharedRoot)).toBe(true);
      expect(sameFsEntry(resolved, fixture)).toBe(false);
    } finally {
      require('os').tmpdir = origTmpdir;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('CI-RUNNER DIVERGENCE GAP reproduces against the ACTUAL shipped v2 code (os.tmpdir() disagreeing with $TMPDIR)', () => {
    // The genuine, confirmed gap in what was actually shipped as v2: it
    // only ever consults os.tmpdir()/os.homedir(), never $TMPDIR/$TEMP/$TMP
    // directly. Node's os.tmpdir() reads $TMPDIR live on POSIX, so merely
    // setting the env var isn't a real test — genuine divergence requires
    // os.tmpdir() itself to be monkey-patched away from what the env var
    // says (the shape of a sandboxed runtime or CI wrapper where the real
    // runner temp root, e.g. GitHub Actions' RUNNER_TEMP, is exposed via
    // env but not reflected by os.tmpdir()).
    const base = freshFixtureBase();
    const origTmpdir = require('os').tmpdir;
    const origTmpdirEnv = process.env.TMPDIR;
    try {
      const target = path.join(base, 'v2-intel.cjs');
      fs.writeFileSync(target, realpathPerDirIntelligenceSource());
      delete require.cache[require.resolve(target)];
      const v2 = require(target);

      const runnerTemp = fs.mkdtempSync(path.join(base, 'runner-temp-'));
      fs.mkdirSync(path.join(runnerTemp, '.claude-flow'), { recursive: true });
      const fixture = path.join(runnerTemp, 'workdir');
      fs.mkdirSync(fixture, { recursive: true });
      const unrelated = fs.mkdtempSync(path.join(base, 'unrelated-tmpdir-'));

      require('os').tmpdir = () => unrelated; // deliberately does NOT agree with $TMPDIR
      process.env.TMPDIR = runnerTemp;
      delete process.env.CLAUDE_PROJECT_DIR;
      const resolved = v2.resolveProjectRoot(fixture);
      // RED against v2: it never checks $TMPDIR, so the real runner-temp
      // boundary is treated as an ordinary (adoptable) project marker.
      expect(sameFsEntry(resolved, runnerTemp)).toBe(true);
      expect(sameFsEntry(resolved, fixture)).toBe(false);
    } finally {
      require('os').tmpdir = origTmpdir;
      if (origTmpdirEnv === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = origTmpdirEnv;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('BOUNDARY-CONSTRUCTION FAIL-OPEN reproduces against v5-WITHOUT-degraded-handling: a transient stat failure adopts the boundary', () => {
    // The boundary set is built ONCE, up front, with no re-check. This
    // mutation reverts to treating ANY stat failure during that
    // construction as "this boundary does not exist" (the v4 shape's
    // behavior) — proving the ENOENT/ENOTDIR-vs-unknown distinction plus
    // _rootwalkDegraded gate is load-bearing, not redundant. A stateful
    // fs.statSync monkeypatch throws EMFILE exactly once for the boundary
    // path, then behaves normally afterward (including for the walk's own
    // later re-check of that same directory) — reproducing the real timing
    // this is about.
    const base = freshFixtureBase();
    const origTmpdir = require('os').tmpdir;
    try {
      const target = path.join(base, 'v5-nodegrade-intel.cjs');
      fs.writeFileSync(target, v5WithoutDegradedHandlingSource());
      delete require.cache[require.resolve(target)];
      const mutated = require(target);

      const sharedRoot = fs.mkdtempSync(path.join(base, 'shared-'));
      fs.mkdirSync(path.join(sharedRoot, '.claude-flow'), { recursive: true });
      const fixture = path.join(sharedRoot, 'fixture-no-marker');
      fs.mkdirSync(fixture, { recursive: true });

      require('os').tmpdir = () => sharedRoot;
      const origStatSync = fs.statSync;
      let thrown = false;
      fs.statSync = function (p, ...rest) {
        if (!thrown && p === sharedRoot) {
          thrown = true;
          const err = new Error('EMFILE');
          err.code = 'EMFILE';
          throw err;
        }
        return origStatSync.call(fs, p, ...rest);
      };
      let resolved;
      try {
        delete process.env.CLAUDE_PROJECT_DIR;
        resolved = mutated.resolveProjectRoot(fixture);
      } finally {
        fs.statSync = origStatSync;
      }
      expect(thrown).toBe(true); // sanity: the transient failure actually fired
      // RED against the mutation: the boundary is wrongly adopted because
      // its identity was never added to the set (treated as absent).
      expect(sameFsEntry(resolved, sharedRoot)).toBe(true);
      expect(sameFsEntry(resolved, fixture)).toBe(false);
    } finally {
      require('os').tmpdir = origTmpdir;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('the REAL v5 patcher output does NOT reproduce the boundary-construction fail-open (green against the same transient-failure scenario)', () => {
    const base = freshFixtureBase();
    const origTmpdir = require('os').tmpdir;
    try {
      const target = path.join(base, 'v5-real-intel.cjs');
      fs.writeFileSync(target, pristineIntelligenceSource());
      const r = runPatcher(target);
      expect(r.status).toBe(0);
      delete require.cache[require.resolve(target)];
      const v5 = require(target);

      const sharedRoot = fs.mkdtempSync(path.join(base, 'shared-'));
      fs.mkdirSync(path.join(sharedRoot, '.claude-flow'), { recursive: true });
      const fixture = path.join(sharedRoot, 'fixture-no-marker');
      fs.mkdirSync(fixture, { recursive: true });

      require('os').tmpdir = () => sharedRoot;
      const origStatSync = fs.statSync;
      let thrown = false;
      fs.statSync = function (p, ...rest) {
        if (!thrown && p === sharedRoot) {
          thrown = true;
          const err = new Error('EMFILE');
          err.code = 'EMFILE';
          throw err;
        }
        return origStatSync.call(fs, p, ...rest);
      };
      let resolved;
      try {
        delete process.env.CLAUDE_PROJECT_DIR;
        resolved = v5.resolveProjectRoot(fixture);
      } finally {
        fs.statSync = origStatSync;
      }
      expect(thrown).toBe(true);
      expect(sameFsEntry(resolved, fixture)).toBe(true);
      expect(sameFsEntry(resolved, sharedRoot)).toBe(false);
    } finally {
      require('os').tmpdir = origTmpdir;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('GATE-NEUTERED BYPASS reproduces against v5-WITH-GATE-NEUTERED (errno-split bookkeeping intact, gate effect stripped): an unrelated legitimate project defeats the accepted trade-off', () => {
    // ISOLATES the two halves of the v5 fix. v5WithoutDegradedHandlingSource
    // (above) reverts BOTH the errno-split AND the gate's effect at once, so
    // it cannot tell you which half a broken change actually touches — a
    // mutation that keeps computing _rootwalkDegraded correctly (the errno
    // distinction stays intact) but silently drops its EFFECT on the
    // `.claude-flow` gate would pass a matrix built only from that fixture.
    // v5WithGateNeuteredSource isolates exactly that: bookkeeping intact,
    // gate stripped.
    //
    // The scenario has to be the CROSS-BOUNDARY one (a project with zero
    // relationship to the failing boundary), not the same-boundary one used
    // above — a mutation that only removes the gate can still coincidentally
    // fail the same-boundary scenario for an unrelated reason (isSharedRoot
    // already returns false for the un-added boundary), so that scenario
    // alone would not prove the gate's effect is what matters. This one
    // does: without the gate, the mutation "finds" the unrelated project's
    // real marker instead of honoring the accepted trade-off (fall back to
    // origin during a degraded call).
    const base = freshFixtureBase();
    const origTmpdir = require('os').tmpdir;
    try {
      const target = path.join(base, 'v5-gate-neutered-intel.cjs');
      fs.writeFileSync(target, v5WithGateNeuteredSource());
      delete require.cache[require.resolve(target)];
      const mutated = require(target);

      const legitProject = fs.mkdtempSync(path.join(base, 'legit-'));
      fs.mkdirSync(path.join(legitProject, '.claude-flow'), { recursive: true });
      const legitDeep = path.join(legitProject, 'sub');
      fs.mkdirSync(legitDeep, { recursive: true });
      const poisoned = fs.mkdtempSync(path.join(base, 'poisoned-'));

      require('os').tmpdir = () => poisoned;
      const origStatSync = fs.statSync;
      let thrown = false;
      fs.statSync = function (p, ...rest) {
        if (!thrown && p === poisoned) {
          thrown = true;
          const err = new Error('EMFILE');
          err.code = 'EMFILE';
          throw err;
        }
        return origStatSync.call(fs, p, ...rest);
      };
      let resolved;
      try {
        delete process.env.CLAUDE_PROJECT_DIR;
        resolved = mutated.resolveProjectRoot(legitDeep);
      } finally {
        fs.statSync = origStatSync;
      }
      expect(thrown).toBe(true); // sanity: the unrelated boundary's failure actually fired
      // RED against the mutation: the gate had no effect, so the unrelated
      // project's real marker was found instead of the accepted trade-off
      // (fall back to origin) firing.
      expect(sameFsEntry(resolved, legitProject)).toBe(true);
      expect(sameFsEntry(resolved, legitDeep)).toBe(false);
    } finally {
      require('os').tmpdir = origTmpdir;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('the REAL v5 patcher output does NOT reproduce the gate-neutered bypass (green against the same cross-boundary trade-off scenario)', () => {
    const base = freshFixtureBase();
    const origTmpdir = require('os').tmpdir;
    try {
      const target = path.join(base, 'v5-real-gate-intel.cjs');
      fs.writeFileSync(target, pristineIntelligenceSource());
      const r = runPatcher(target);
      expect(r.status).toBe(0);
      delete require.cache[require.resolve(target)];
      const v5 = require(target);

      const legitProject = fs.mkdtempSync(path.join(base, 'legit-'));
      fs.mkdirSync(path.join(legitProject, '.claude-flow'), { recursive: true });
      const legitDeep = path.join(legitProject, 'sub');
      fs.mkdirSync(legitDeep, { recursive: true });
      const poisoned = fs.mkdtempSync(path.join(base, 'poisoned-'));

      require('os').tmpdir = () => poisoned;
      const origStatSync = fs.statSync;
      let thrown = false;
      fs.statSync = function (p, ...rest) {
        if (!thrown && p === poisoned) {
          thrown = true;
          const err = new Error('EMFILE');
          err.code = 'EMFILE';
          throw err;
        }
        return origStatSync.call(fs, p, ...rest);
      };
      let resolved;
      try {
        delete process.env.CLAUDE_PROJECT_DIR;
        resolved = v5.resolveProjectRoot(legitDeep);
      } finally {
        fs.statSync = origStatSync;
      }
      expect(thrown).toBe(true);
      // GREEN: the real patcher output honors the accepted trade-off.
      expect(sameFsEntry(resolved, legitDeep)).toBe(true);
      expect(sameFsEntry(resolved, legitProject)).toBe(false);
    } finally {
      require('os').tmpdir = origTmpdir;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('ENV VALIDATION GAP reproduces against v4-WITHOUT-isAbsolute: a relative $TMPDIR resolving via cwd excludes a real project', () => {
    // Proves _rootwalkValidEnvTemp's isAbsolute() check is load-bearing, not
    // redundant with the `if (!p) return` guard (covers empty) or
    // statSync's own try/catch (covers nonexistent) — those two already
    // make a naive "relative/nonexistent value" test pass whether or not
    // isAbsolute() is present. The genuine failure mode requires the
    // relative value to resolve, via process.cwd() at call time, to
    // something that actually exists — os.tmpdir() is monkey-patched away
    // from $TMPDIR (it otherwise echoes it verbatim with zero validation of
    // its own, which would confound the test regardless of the fix).
    const base = freshFixtureBase();
    const origTmpdir = require('os').tmpdir;
    const origTmpdirEnv = process.env.TMPDIR;
    const origCwd = process.cwd();
    try {
      const target = path.join(base, 'v4-noabs-intel.cjs');
      fs.writeFileSync(target, v4WithoutIsAbsoluteSource());
      delete require.cache[require.resolve(target)];
      const mutated = require(target);

      const project = fs.mkdtempSync(path.join(base, 'legit-'));
      fs.mkdirSync(path.join(project, '.claude-flow'), { recursive: true });
      const deepChild = path.join(project, 'src', 'nested');
      fs.mkdirSync(deepChild, { recursive: true });
      const safeSentinel = fs.mkdtempSync(path.join(base, 'safe-unrelated-'));

      process.chdir(base);
      require('os').tmpdir = () => safeSentinel;
      process.env.TMPDIR = path.basename(project); // relative; resolves via cwd to `project`
      delete process.env.CLAUDE_PROJECT_DIR;
      const resolved = mutated.resolveProjectRoot(deepChild);
      // RED against the mutation: the real project's own marker is wrongly
      // excluded because the relative $TMPDIR resolved (via cwd) to it.
      expect(sameFsEntry(resolved, deepChild)).toBe(true);
      expect(sameFsEntry(resolved, project)).toBe(false);
    } finally {
      process.chdir(origCwd);
      require('os').tmpdir = origTmpdir;
      if (origTmpdirEnv === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = origTmpdirEnv;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('the REAL v4 patcher output does NOT reproduce the env-validation gap (green against the same scenario)', () => {
    const base = freshFixtureBase();
    const origTmpdir = require('os').tmpdir;
    const origTmpdirEnv = process.env.TMPDIR;
    const origCwd = process.cwd();
    try {
      const target = path.join(base, 'v4-real-intel.cjs');
      fs.writeFileSync(target, pristineIntelligenceSource());
      const r = runPatcher(target);
      expect(r.status).toBe(0);
      delete require.cache[require.resolve(target)];
      const v4 = require(target);

      const project = fs.mkdtempSync(path.join(base, 'legit-'));
      fs.mkdirSync(path.join(project, '.claude-flow'), { recursive: true });
      const deepChild = path.join(project, 'src', 'nested');
      fs.mkdirSync(deepChild, { recursive: true });
      const safeSentinel = fs.mkdtempSync(path.join(base, 'safe-unrelated-'));

      process.chdir(base);
      require('os').tmpdir = () => safeSentinel;
      process.env.TMPDIR = path.basename(project);
      delete process.env.CLAUDE_PROJECT_DIR;
      const resolved = v4.resolveProjectRoot(deepChild);
      expect(sameFsEntry(resolved, project)).toBe(true);
      expect(sameFsEntry(resolved, deepChild)).toBe(false);
    } finally {
      process.chdir(origCwd);
      require('os').tmpdir = origTmpdir;
      if (origTmpdirEnv === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = origTmpdirEnv;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('UNGUARDED STAT CRASH reproduces against v4-WITHOUT-statSafe-catch: EACCES propagates uncaught out of resolveProjectRoot', () => {
    // Proves _rootwalkStatSafe's internal try/catch is load-bearing.
    // isSharedRoot(dir) calls it unguarded inside the walk loop, unlike the
    // boundary-building side which double-guards each _rootwalkAddBoundary
    // call with its own outer try/catch — removing the internal catch lets
    // an EACCES from an unreadable ancestor propagate all the way out of
    // resolveProjectRoot, which runs at MODULE LOAD in the real helper,
    // taking down the whole helper for every fresh hook subprocess.
    const base = freshFixtureBase();
    try {
      const target = path.join(base, 'v4-nocatch-intel.cjs');
      fs.writeFileSync(target, v4WithoutStatSafeCatchSource());
      delete require.cache[require.resolve(target)];
      const mutated = require(target);

      const restricted = path.join(base, 'restricted');
      const deepChild = path.join(restricted, 'child', 'deep');
      fs.mkdirSync(deepChild, { recursive: true });
      fs.chmodSync(restricted, 0o000);
      try {
        delete process.env.CLAUDE_PROJECT_DIR;
        // RED against the mutation: EACCES propagates uncaught.
        expect(() => mutated.resolveProjectRoot(deepChild)).toThrow(/EACCES/);
      } finally {
        fs.chmodSync(restricted, 0o755); // restore before cleanup can remove it
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('the REAL v4 patcher output does NOT reproduce the unguarded-stat crash (green against the same EACCES scenario)', () => {
    const base = freshFixtureBase();
    try {
      const target = path.join(base, 'v4-real-nocrash-intel.cjs');
      fs.writeFileSync(target, pristineIntelligenceSource());
      const r = runPatcher(target);
      expect(r.status).toBe(0);
      delete require.cache[require.resolve(target)];
      const v4 = require(target);

      const restricted = path.join(base, 'restricted');
      const deepChild = path.join(restricted, 'child', 'deep');
      fs.mkdirSync(deepChild, { recursive: true });
      fs.chmodSync(restricted, 0o000);
      try {
        delete process.env.CLAUDE_PROJECT_DIR;
        expect(() => v4.resolveProjectRoot(deepChild)).not.toThrow();
      } finally {
        fs.chmodSync(restricted, 0o755);
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('the REAL v4 patcher fixes ALL EIGHT cases at once (green, including case-alias, symlink-alias, CI-runner gap, .git-at-boundary, literal /tmp, and env validation)', () => {
    const base = freshFixtureBase();
    const origTmpdir = require('os').tmpdir;
    const origHomedir = require('os').homedir;
    const origTmpdirEnv = process.env.TMPDIR;
    try {
      const target = path.join(base, 'v4-intel.cjs');
      fs.writeFileSync(target, pristineIntelligenceSource());
      const r = runPatcher(target);
      expect(r.status).toBe(0);
      delete require.cache[require.resolve(target)];
      const v4 = require(target);
      delete process.env.CLAUDE_PROJECT_DIR;

      // case 1: original defect — no escape to a shared root
      const sharedRoot = fs.mkdtempSync(path.join(base, 'shared-'));
      fs.mkdirSync(path.join(sharedRoot, '.claude-flow'), { recursive: true });
      const fixture1 = path.join(sharedRoot, 'fixture-no-marker');
      fs.mkdirSync(fixture1, { recursive: true });
      require('os').tmpdir = () => sharedRoot;
      expect(sameFsEntry(v4.resolveProjectRoot(fixture1), fixture1)).toBe(true);
      require('os').tmpdir = origTmpdir;

      // case 2: v1 regression — subdir of a legit project still finds its root
      const project = path.join(base, 'legit-project');
      const deepChild = path.join(project, 'src', 'nested');
      fs.mkdirSync(path.join(project, '.claude-flow'), { recursive: true });
      fs.mkdirSync(deepChild, { recursive: true });
      expect(sameFsEntry(v4.resolveProjectRoot(deepChild), project)).toBe(true);

      // case 3: symlink-aliasing bypass — alias-form boundary still excluded
      const sharedRootReal = fs.mkdtempSync(path.join(fs.realpathSync(base), 'aliased-'));
      const aliasedPath = path.join(base, path.basename(sharedRootReal));
      fs.mkdirSync(path.join(sharedRootReal, '.claude-flow'), { recursive: true });
      const fixture3 = path.join(aliasedPath, 'fixture-no-marker');
      fs.mkdirSync(fixture3, { recursive: true });
      require('os').tmpdir = () => aliasedPath;
      expect(sameFsEntry(v4.resolveProjectRoot(fixture3), fixture3)).toBe(true);
      require('os').tmpdir = origTmpdir;

      // case 4: CI-runner divergence — $TMPDIR excluded even when os.tmpdir() disagrees
      const runnerTemp = fs.mkdtempSync(path.join(base, 'runner-temp-'));
      fs.mkdirSync(path.join(runnerTemp, '.claude-flow'), { recursive: true });
      const fixture4 = path.join(runnerTemp, 'workdir');
      fs.mkdirSync(fixture4, { recursive: true });
      const unrelated = fs.mkdtempSync(path.join(base, 'unrelated-tmpdir-'));
      require('os').tmpdir = () => unrelated;
      process.env.TMPDIR = runnerTemp;
      expect(sameFsEntry(v4.resolveProjectRoot(fixture4), fixture4)).toBe(true);
      require('os').tmpdir = origTmpdir;
      if (origTmpdirEnv === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = origTmpdirEnv;

      // case 5: .git AT a boundary is not adopted from a descendant either
      const gitBoundary = fs.mkdtempSync(path.join(base, 'gitbnd-'));
      fs.mkdirSync(path.join(gitBoundary, '.git'), { recursive: true });
      const gitBoundaryChild = path.join(gitBoundary, 'sub');
      fs.mkdirSync(gitBoundaryChild, { recursive: true });
      require('os').tmpdir = () => gitBoundary;
      expect(sameFsEntry(v4.resolveProjectRoot(gitBoundaryChild), gitBoundaryChild)).toBe(true);
      require('os').tmpdir = origTmpdir;

      // case 6: literal /tmp is present in the boundary set (structural check
      // — see intelligence-utils.test.js for the live functional proof
      // against the real system /tmp, which this throwaway fixture must not
      // touch).
      const patchedSrc = fs.readFileSync(target, 'utf8');
      expect(patchedSrc).toContain("_rootwalkAddBoundary('/tmp')");

      // case 7: case-alias bypass closed
      let caseInsensitiveFs;
      const fakeHome = fs.mkdtempSync(path.join(base, 'CaseAliasHome-'));
      fs.mkdirSync(path.join(fakeHome, '.claude-flow'), { recursive: true });
      const fixture7 = path.join(fakeHome, 'fixture-no-marker');
      fs.mkdirSync(fixture7, { recursive: true });
      const upperCaseAlias = fakeHome.toUpperCase();
      try { caseInsensitiveFs = sameFsEntry(fakeHome, upperCaseAlias); } catch (e) { caseInsensitiveFs = false; }
      if (caseInsensitiveFs) {
        require('os').homedir = () => upperCaseAlias;
        expect(sameFsEntry(v4.resolveProjectRoot(fixture7), fixture7)).toBe(true);
        require('os').homedir = origHomedir;
      }

      // case 8: env validation — empty/relative/nonexistent $TMPDIR ignored
      const legitProject = fs.mkdtempSync(path.join(base, 'legit-env-'));
      fs.mkdirSync(path.join(legitProject, '.claude-flow'), { recursive: true });
      const legitDeep = path.join(legitProject, 'sub');
      fs.mkdirSync(legitDeep, { recursive: true });

      process.env.TMPDIR = '';
      expect(sameFsEntry(v4.resolveProjectRoot(legitDeep), legitProject)).toBe(true);
      process.env.TMPDIR = 'some/relative/path';
      expect(sameFsEntry(v4.resolveProjectRoot(legitDeep), legitProject)).toBe(true);
      process.env.TMPDIR = '/definitely/does/not/exist/xyz123';
      expect(sameFsEntry(v4.resolveProjectRoot(legitDeep), legitProject)).toBe(true);
      if (origTmpdirEnv === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = origTmpdirEnv;
    } finally {
      require('os').tmpdir = origTmpdir;
      require('os').homedir = origHomedir;
      if (origTmpdirEnv === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = origTmpdirEnv;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('INTEL-ROOTWALK-V1 patcher — real installed dist (bin/ruflo-kit fix-aqe)', () => {
  it('the shipped defect_gate pattern matches the real pristine anchor line', () => {
    // Guards the bash-side defect_gate pattern in fix-aqe.sh against drift:
    // if this ever stops matching the pristine fixture below, the gate would
    // silently stop firing for never-patched targets.
    const target = path.join(tmpDir, 'intelligence.cjs');
    fs.writeFileSync(target, pristineIntelligenceSource());
    const pattern = /fs\.existsSync\(path\.join\(dir, '\.claude-flow'\)\)\) \{/;
    expect(pattern.test(fs.readFileSync(target, 'utf8'))).toBe(true);
  });

  it('the bash-side migration trigger (grep INTEL-ROOTWALK-V1) matches all four pre-v4 fixtures', () => {
    const targetV1 = path.join(tmpDir, 'v1.cjs');
    fs.writeFileSync(targetV1, depthZeroPatchedIntelligenceSource());
    const srcV1 = fs.readFileSync(targetV1, 'utf8');
    expect(srcV1.includes('INTEL-ROOTWALK-V1')).toBe(true);
    expect(srcV1.includes('_rootwalkBoundaryIds')).toBe(false); // confirms it is genuinely still v1

    const targetV2 = path.join(tmpDir, 'v2.cjs');
    fs.writeFileSync(targetV2, realpathPerDirIntelligenceSource());
    const srcV2 = fs.readFileSync(targetV2, 'utf8');
    expect(srcV2.includes('INTEL-ROOTWALK-V1')).toBe(true);
    expect(srcV2.includes('_rootwalkBoundaryIds')).toBe(false); // confirms it is genuinely still v2

    const targetV3NoTmp = path.join(tmpDir, 'v3notmp.cjs');
    fs.writeFileSync(targetV3NoTmp, v3WithoutTmpIntelligenceSource());
    const srcV3NoTmp = fs.readFileSync(targetV3NoTmp, 'utf8');
    expect(srcV3NoTmp.includes('INTEL-ROOTWALK-V1')).toBe(true);
    expect(srcV3NoTmp.includes('_rootwalkBoundaryIds')).toBe(false);

    const targetV3WithTmp = path.join(tmpDir, 'v3withtmp.cjs');
    fs.writeFileSync(targetV3WithTmp, v3WithTmpIntelligenceSource());
    const srcV3WithTmp = fs.readFileSync(targetV3WithTmp, 'utf8');
    expect(srcV3WithTmp.includes('INTEL-ROOTWALK-V1')).toBe(true);
    expect(srcV3WithTmp.includes('_rootwalkBoundaryIds')).toBe(false);
  });
});
