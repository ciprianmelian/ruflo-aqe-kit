/**
 * Doc-truthfulness guard (DOC-SURFACE-GUARD-V1).
 *
 * This gauntlet run found the same defect shape four times in one session, all in the doc
 * corpus, never in code: a description of a kit verb, sentinel, or vendored artifact went stale
 * after the thing it described changed, and nothing caught it.
 *
 *   1. docs/OPERATIONS.md + docs/_INSTRUCTIONS.md both asserted `ruflo init` vendors ~19.5k
 *      tests into `.agents/skills` — upstream #2777 slimmed that to a single ~2KB SKILL.md.
 *   2. lib/fix-brain.sh + assets/brain/server.mjs claimed the vendored brain launcher was
 *      "verified byte-identical to upstream" long after upstream rewrote it (v1 proxy -> v2
 *      "Stable Spine"). Already tripwired by tests/brain-fallback-drift.test.js for those two
 *      files specifically.
 *   3. docs/_INSTRUCTIONS.md described the same launcher's size as "2 KB" — a byte count that
 *      drifted 58% once the provenance comment grew.
 *   4. A comment cited "upstream v4.0.2 (commit e20cdf2)" where e20cdf2 is actually the 4.0.0
 *      release commit, and a captured "the 4.0.0 release" reference that was never published
 *      under that exact tag at the time.
 *
 * This file is the corpus-wide, code-derived guard against the same class recurring:
 *
 *   Rule 1 — RETIRED SURFACES: every `ruflo-kit <verb>` and every KIT-SENTINEL-SHAPED-V<n>
 *            token in the doc corpus must resolve against the LIVE surface, derived from the
 *            code itself (bin/ruflo-kit's dispatcher, and a grep of lib/assets/tools/
 *            bin/ruflo-kit/install.sh) — never a second hardcoded list, which would rot exactly
 *            like the thing it's meant to catch.
 *   Rule 2 — UNVERIFIABLE-CLAIM SHAPES: "byte-identical"/"identical to upstream"/"same as
 *            upstream" claims about a vendored asset, and fixed byte/file/test counts describing
 *            the two artifacts that have already drifted once (the .agents/skills tree, the
 *            brain launcher), must sit next to a verifiable anchor or a historical marker.
 *   Rule 3 — VERSION/COMMIT CITATIONS: any "vX.Y.Z (commit HASH)" shaped citation anywhere in the
 *            corpus must carry a well-formed hash, and — when a matching vendor/* git checkout is
 *            present locally — that hash must actually resolve to a commit whose package.json
 *            reads the cited version. Generalizes the REFERENCE_RE / HASH_SHAPE_RE technique from
 *            tests/brain-fallback-drift.test.js across the whole corpus; skips cleanly when no
 *            local vendor/* checkout can resolve a given hash, since vendor/ is gitignored and not
 *            guaranteed on every machine or in CI.
 *
 * CORPUS (round 3): every tracked `*.md` file in the repo (`git ls-files -- '*.md'`), no inclusion
 * allowlist. Round 2 scoped to README.md/CLAUDE.md/docs/**, which silently missed
 * assets/claude-commands/analysis/COMMAND_COMPLIANCE_REPORT.md — a tracked doc that discusses
 * exactly this guard's subject matter (the ruflo rename, the global-binary-not-npx rule, and cites
 * docs/_INSTRUCTIONS.md Patch numbers by number). No exclude list is needed: every currently
 * untracked doc (docs/NPM-DISTRIBUTION-RESEARCH-2026-07-18.md, docs/vendor/**, etc.) is already
 * excluded by not being tracked — see the correction below.
 *
 * CORRECTION (round 3): earlier revisions of this file claimed docs/vendor/** was a "tracked,
 * git-visible" ledger directory distinct from the gitignored top-level vendor/. That was WRONG —
 * `.gitignore:13`'s bare `vendor/` pattern matches a directory named "vendor" at ANY depth, so
 * docs/vendor/** is ALSO gitignored (confirmed: `git ls-files -- 'docs/vendor/**'` returns nothing;
 * `git check-ignore -v -- docs/vendor` reports `.gitignore:13:vendor/`). The former "Tier A" ledger
 * exemption was therefore dead code justified by a false premise — the guard's own comment made
 * exactly the kind of unverified claim this guard exists to catch. It is REMOVED, not fixed: since
 * corpusFiles() is git-scoped, every gitignored doc (docs/vendor/** included) is already outside
 * the corpus by construction, with no separate directory-tier needed.
 *
 * HISTORICAL-CONTEXT CONVENTION, round 3 (real resolution, not shape-matching):
 *
 * Round 2 added "anchors" to tiers B/C/D, but every anchor was a SHAPE check (does this look like a
 * commit hash / issue number / date?), never a RESOLUTION check (does it refer to something real?).
 * A critic defeated all three with fabricated content in minutes: a `.repeat()`-padded Lorem Ipsum
 * block cleared tier B's size+title-length gate; a fabricated hash (`abc1234`) and an impossible
 * future date (`2099-01-01`) both satisfied tier C; a nonexistent issue number, a nonexistent patch
 * number, a backwards-in-time date, and an unreleased version all satisfied tier D. Round 3 makes
 * each anchor form either REAL (resolved against something on disk/in git) or explicitly DROPPED —
 * no decorative anchors remain:
 *
 *   - Commit hash (`` `[0-9a-f]{7,40}` ``): REAL. Resolved via `resolveHashAnywhere()`, which checks
 *     this repo's OWN git history first (always present, never gitignored, so this check is
 *     deterministic on every machine and in CI — confirmed the real case,
 *     self-improvement-next-steps.md's `9d5bffe`, resolves here) and then any locally-present
 *     vendor/* checkout (best-effort, same as Rule 3). A fabricated hash like `abc1234` resolves
 *     nowhere and is rejected.
 *   - "Patch N": REAL. Resolved against `validPatchNumbers()` — the actual `**(N)` entries present
 *     in whichever corpus file(s) are structurally patch-log-shaped (see tier B below), derived
 *     from the corpus itself, never a hardcoded number list. "Patch 9999" does not exist in
 *     docs/_INSTRUCTIONS.md's real entries and is rejected.
 *   - Guarding test-file reference (`tests/*.test.js`): REAL. The referenced path must exist on
 *     disk (`fs.existsSync`). This verifies the file exists, not that it actually guards the
 *     specific claim next to it — a real, but partial, check, stated as such.
 *   - Date (`YYYY-MM-DD`): PARTIAL-REAL. Bounded to a plausible range — not in the future (rejects
 *     `2099-01-01`) and not before this repo's own first commit (rejects `2020-01-01`, which
 *     predates this repo's 2026-05-29 start). This bounds plausibility; it does NOT prove the date
 *     is when a specific correction actually happened — a plausible-but-wrong date inside the
 *     repo's real history could still slip through. Documented as a real but incomplete check, not
 *     silently assumed solved.
 *   - Issue/PR number (`#\d+`): DROPPED. No local, network-free way to confirm a GitHub issue or PR
 *     actually exists — hitting the GitHub API from a unit test would be flaky, rate-limitable, and
 *     wrong for a suite that must run offline. A bare `#2777` no longer counts as an anchor by
 *     itself (the real docs/OPERATIONS.md paragraph that cites it also carries a real date, so it
 *     still passes on that anchor alone).
 *   - Bare version number (`vX.Y.Z` with no accompanying commit): DROPPED. Unlike a citation paired
 *     with a hash (Rule 3, which resolves against a specific vendor/* checkout), a bare version
 *     number names no single resolvable target — verifying "v9.9.9 was never released" would
 *     require knowing which upstream project it names and walking that project's tag history, which
 *     isn't a reliable, general check.
 *
 *   Tier B (patch-log whole-file exemption), re-hardened: content shape alone (entry count + title
 *   length + file size) was defeated by padding a Lorem Ipsum block past the size gate — a real
 *   barrier requires SOME real signal a fake block can't cheaply claim, and bare content can always
 *   be faked given enough padding. Whole-file exemption now ALSO requires the file's basename to use
 *   this repo's own leading-underscore governance-doc convention (`docs/_INSTRUCTIONS.md` is the
 *   only tracked `.md` file that does — confirmed: `git ls-files -- '*.md' | xargs -n1 basename |
 *   grep '^_'` returns exactly one file) — the same class of signal as the old Tier A (a real,
 *   meaningfully-separated location, not blanket content shape). This does not make new-file
 *   padding attacks impossible — an attacker can still create a NEW underscore-prefixed file — but
 *   it changes the threat model from "an invisible addition to an existing ordinary doc" to "a new,
 *   conspicuously-named file appearing in a diff," which invites the review scrutiny the old,
 *   content-only gate did not.
 *
 *   Tier C (snapshot disclaimer) and tier D (paragraph-level corrective marker) now require the
 *   SAME real anchor set above (hash/Patch-N/test-file/plausible-date) instead of shape-only
 *   regexes — see `hasRealAnchor()`.
 *
 * FALSE-POSITIVE ANALYSIS: re-ran across the WIDENED (all-tracked-.md) corpus with the re-hardened
 * tiers — see the "current corpus" tests below for each rule; all pass clean, including the newly
 * included assets/claude-commands/analysis/COMMAND_COMPLIANCE_REPORT.md and
 * docs/CHANGELOG-2026-07-17.md (neither carries a matching claim shape today).
 *
 * ROUND 4 — Tier E, dated session-ledger directory: this session's own Wave-2 audit ledgers
 * (docs/gauntlet-2026-07-31/*.md) were relocated out of docs/vendor/ (gitignored, per the round-3
 * correction above) directly into docs/, making them real tracked corpus members for the first
 * time — and they legitimately quote retired sentinels and the exact "byte-identical" claim this
 * session found and fixed, in order to DOCUMENT that history, not assert it as current. The old
 * removed "tier A" tried to cover this via docs/vendor/** and never actually worked (that path was
 * never tracked). Tier E is a real, verified replacement: the file's immediate parent directory
 * under docs/ must match a dated-session naming convention (`<name>-YYYY-MM-DD`) — confirmed unique
 * among tracked docs/ subdirectories (only "gauntlet-2026-07-31" matches; "reference" does not) —
 * AND that date must be plausible by the same real check Tier D's dates use (not future, not
 * before this repo's first commit), so a fabricated `docs/lies-2099-01-01/` does not qualify. Same
 * class of signal as Tier B's leading-underscore convention: a real, meaningfully-separated
 * location, verified against actual repo state via `git ls-files`, not assumed — and, like Tier B,
 * not airtight against someone naming a brand-new dated directory for the same purpose, but that
 * shifts the threat model to a conspicuous new directory in a diff rather than an invisible
 * addition to an ordinary file.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// ─── corpus enumeration ─────────────────────────────────────────────────────

function walkFiles(dir, extension) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, extension));
    else if (entry.isFile() && (!extension || entry.name.endsWith(extension))) out.push(full);
  }
  return out;
}

// git-scoped, not a filesystem walk, and not an inclusion allowlist: the
// corpus this guard protects is EVERY tracked `.md` file, not just the ones
// under three specific paths. Round 2 scoped this to README.md/CLAUDE.md/docs
// and missed a tracked doc living at a fourth path
// (assets/claude-commands/analysis/COMMAND_COMPLIANCE_REPORT.md) — a coverage
// hole that was luck (no matching claim shape yet), not a structural
// guarantee. `git ls-files -- '*.md'` matches every tracked markdown file at
// any depth (verified empirically: returns all 12, including nested
// docs/reference/*.md and the assets/claude-commands path). No exclude list
// is needed: every currently-untracked doc (docs/NPM-DISTRIBUTION-RESEARCH-
// 2026-07-18.md, docs/vendor/**, docs/INTELLIGENCE-EXEC-SUMMARY.*, docs/
// KIT-MEMORY-GROUNDED-2PAGER.md) is already excluded by not being tracked —
// see the header comment's CORRECTION note on docs/vendor/'s gitignore status.
function corpusFiles() {
  const r = spawnSync('git', ['ls-files', '--', '*.md'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(
      `doc-surface-guard: \`git ls-files\` failed (status ${r.status}) — is ${ROOT} a git ` +
      `checkout? stderr: ${r.stderr || '(none)'}`
    );
  }
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith('.md'))
    .map((rel) => path.join(ROOT, rel))
    // Defensive, not load-bearing: git ls-files only lists what HEAD's index
    // tracks, which is always present in a checkout — but every read site in
    // this file guards existence anyway, so a mid-run deletion can't crash it.
    .filter((f) => fs.existsSync(f));
}

// ─── live-surface derivation (never a hardcoded second list) ───────────────

// Parses bin/ruflo-kit's REAL dispatch case block (keyed on "$cmd") — not the
// help-text block inside _kit_verb_help (keyed on "$1", which duplicates verb
// names for usage strings and is not the authority on what actually runs).
function liveVerbs() {
  const src = fs.readFileSync(path.join(ROOT, 'bin', 'ruflo-kit'), 'utf8');
  const marker = 'case "$cmd" in';
  const start = src.indexOf(marker);
  if (start === -1) {
    throw new Error(
      'bin/ruflo-kit: dispatch case block (`case "$cmd" in`) not found — the parser in ' +
      'tests/doc-surface-guard.test.js needs updating to match a dispatcher refactor.'
    );
  }
  const endMarker = src.indexOf('\nesac', start);
  const block = src.slice(start, endMarker === -1 ? undefined : endMarker);
  const verbs = new Set();
  const armRe = /^ {2}([a-z][a-z0-9-]*(?:\|[a-z][a-z0-9-]*)*)\)\s*$/gm;
  let m;
  while ((m = armRe.exec(block))) {
    for (const alt of m[1].split('|')) verbs.add(alt);
  }
  return verbs;
}

const RUNTIME_SOURCE_DIRS = ['lib', 'assets', 'tools'];
const RUNTIME_SOURCE_FILES = ['bin/ruflo-kit', 'install.sh'];

function runtimeSourceText() {
  const parts = [];
  for (const dir of RUNTIME_SOURCE_DIRS) {
    const full = path.join(ROOT, dir);
    for (const f of walkFiles(full)) parts.push(fs.readFileSync(f, 'utf8'));
  }
  for (const rel of RUNTIME_SOURCE_FILES) {
    const f = path.join(ROOT, rel);
    if (fs.existsSync(f)) parts.push(fs.readFileSync(f, 'utf8'));
  }
  return parts.join('\n');
}

const SENTINEL_RE = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+){1,6}-V[0-9]+\b/g;

function liveSentinels(sourceText) {
  const sentinels = new Set();
  SENTINEL_RE.lastIndex = 0;
  let m;
  while ((m = SENTINEL_RE.exec(sourceText))) sentinels.add(m[0]);
  return sentinels;
}

// ─── historical-context convention, round 3: real anchors, not shapes ──────

// Tier B content shape: a bare "**(N)**" is not enough — five one-word fake
// entries ("**(1)**a" ... "**(5)**e") used to earn a whole-file blanket pass
// in round 1. A real patch-log entry (docs/_INSTRUCTIONS.md, 63 of them)
// always carries a substantial bolded title on the SAME line before the
// closing "**" — this requires >=40 chars between the number and the close.
// Round 2 ALSO required the whole file to be >=10,000 chars, reasoning that
// real patch logs accrete size — a critic defeated that with a single
// `'Lorem ipsum...'.repeat(120)` padding call, proving size-without-content
// is not a real barrier. Content shape (title length + count + file size)
// remains here as a corroborating signal, but is no longer sufficient by
// itself — see isPatchLogShaped() below, which additionally requires the
// path convention.
const PATCH_ENTRY_RE = /^\*\*\(\d+(?:\.\d+)?\)\s+.{40,}?\*\*/gm;
const PATCH_LOG_MIN_ENTRIES = 5;
const PATCH_LOG_MIN_FILE_SIZE = 10_000;
function isPatchLogContentShaped(text) {
  if (text.length < PATCH_LOG_MIN_FILE_SIZE) return false;
  const matches = text.match(PATCH_ENTRY_RE);
  return !!matches && matches.length >= PATCH_LOG_MIN_ENTRIES;
}

// Tier B whole-file exemption: content shape AND a real structural signal a
// padded fake can't cheaply claim — this repo's own leading-underscore
// governance-doc naming convention. docs/_INSTRUCTIONS.md is the only tracked
// `.md` file that uses it (verified: `git ls-files -- '*.md' | xargs -n1
// basename | grep '^_'` returns exactly one match). A new file can still be
// given an underscore-prefixed name, but doing so is a conspicuous act a
// reviewer will question — unlike silently padding an existing ordinary doc.
function isPatchLogShaped(file, text) {
  return path.basename(file).startsWith('_') && isPatchLogContentShaped(text);
}

const SNAPSHOT_DISCLAIMER_RE =
  /\bdated snapshot\b|\bhistorical\b[^.\n]{0,80}\bno longer\b|\bdo not treat this (?:file|doc(?:ument)?) as current\b/i;

function hasSnapshotDisclaimer(text) {
  const head = text.slice(0, 800);
  return SNAPSHOT_DISCLAIMER_RE.test(head) && hasRealAnchor(head);
}

// Tier E (round 4): dated session-ledger directory. This session's Wave-2
// audit ledgers (docs/gauntlet-2026-07-31/*.md) are dated, historical
// investigation records — quoting a retired sentinel or the exact
// "byte-identical" claim IN ORDER TO DOCUMENT that it was found and fixed is
// legitimate and must not require rewording the record. The OLD "tier A"
// tried to grant this via docs/vendor/** and turned out to rest on a false
// premise (that path was never tracked, so it never actually reached real
// corpus files) — round 3 removed it rather than patch a lie. This ledger
// directory is different: it IS tracked (`git ls-files -- 'docs/**'` lists it
// directly under docs/, confirmed below) and genuinely reached the corpus the
// moment the ledger was relocated out of the gitignored docs/vendor/ path.
//
// The exemption is anchored the same way Tier B's underscore convention is —
// a real naming convention, verified against actual repo state, not assumed:
// the file's immediate parent directory under docs/ must match
// `<name>-YYYY-MM-DD` (a real dated-session convention: confirmed unique
// among tracked docs/ subdirectories — `git ls-files -- 'docs/**' | sed -E
// 's|^docs/([^/]+)/.*|\1|' | sort -u` returns only "gauntlet-2026-07-31" and
// "reference", and only the former matches) — AND that date must be
// PLAUSIBLE by the same real check tier D uses (not in the future, not
// before this repo's own first commit), so a fabricated
// `docs/lies-2099-01-01/` directory does not qualify. This does not make a
// brand-new dated directory impossible to create for the same purpose — an
// attacker can still name one — but, as with Tier B, it changes the threat
// model from "an invisible addition to an existing ordinary doc" to "a new,
// conspicuously-dated directory appearing in a diff," and the date itself is
// checked against reality rather than merely shaped like one.
const DATED_LEDGER_DIR_RE = /^[a-z][a-z0-9]*-(\d{4})-(\d{2})-(\d{2})$/;
function isDatedLedgerPath(file) {
  const rel = path.relative(ROOT, file);
  const parts = rel.split(path.sep);
  if (parts[0] !== 'docs' || parts.length < 3) return false;
  const m = parts[1].match(DATED_LEDGER_DIR_RE);
  if (!m) return false;
  return isPlausibleDate(m[1], m[2], m[3]);
}

function isWholeFileExempt(file, text) {
  return isPatchLogShaped(file, text) || hasSnapshotDisclaimer(text) || isDatedLedgerPath(file);
}

const CORRECTIVE_KEYWORD_RE =
  /\b(?:STALE|corrected|no longer (?:true|current|the case|in the code)|now false|is now false|was (?:false|wrong|inaccurate)|superseded|retired|deprecated|research only|not implemented|historical(?:ly)?)\b/i;

// Real-anchor forms — see the header comment's "round 3" section for the
// per-form real/partial/dropped rationale. #issue-numbers and bare version
// numbers are deliberately NOT matched here anymore: neither has a local,
// network-free resolution target, so round 2's acceptance of them was
// decoration, not verification.
const HASH_TOKEN_RE = /`([0-9a-f]{7,40})`/g;
const PATCH_REF_RE = /\bPatch\s*(\d+(?:\.\d+)?)\b/gi;
const TEST_FILE_REF_RE = /\btests\/[\w.-]+\.test\.m?js\b/g;
const DATE_TOKEN_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

// A commit hash is a real anchor only if it resolves somewhere checkable:
// this repo's OWN history first (always present, never gitignored, so this
// half of the check is deterministic on every machine and in CI), then any
// locally-present vendor/* checkout (best-effort, same as Rule 3).
function resolveHashAnywhere(hash) {
  if (commitExists(ROOT, hash)) return true;
  return vendorDirs().some((dir) => commitExists(dir, hash));
}

// A cited "Patch N" is real only if that number is an actual entry in
// whichever corpus file(s) are structurally patch-log-shaped — derived from
// the corpus itself every call, never a hardcoded number list.
function validPatchNumbers() {
  const nums = new Set();
  for (const file of corpusFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    if (!isPatchLogShaped(file, text)) continue;
    PATCH_ENTRY_RE.lastIndex = 0;
    let m;
    while ((m = PATCH_ENTRY_RE.exec(text))) {
      const num = m[0].match(/\((\d+(?:\.\d+)?)\)/);
      if (num) nums.add(num[1]);
    }
  }
  return nums;
}

// A date is a real anchor only within a plausible range: not in the future
// (rejects "2099-01-01"), and not before this repo's own first commit
// (rejects "2020-01-01", which predates this repo entirely). This bounds
// plausibility; it does NOT prove a date is when a specific correction
// actually happened — a plausible-but-wrong date inside the repo's real
// history could still pass. Documented as real-but-partial, not solved.
let _repoFirstCommitDateCache;
function repoFirstCommitDate() {
  if (_repoFirstCommitDateCache !== undefined) return _repoFirstCommitDateCache;
  const r = spawnSync('git', ['-C', ROOT, 'log', '--reverse', '--format=%cI'], { encoding: 'utf8' });
  const line = (r.stdout || '').split('\n')[0];
  _repoFirstCommitDateCache = line ? new Date(line) : null;
  return _repoFirstCommitDateCache;
}
function isPlausibleDate(y, mo, d) {
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (Number.isNaN(date.getTime())) return false;
  if (date.getTime() > Date.now()) return false;
  const floor = repoFirstCommitDate();
  if (floor && date.getTime() < floor.getTime()) return false;
  return true;
}

// The union: a paragraph (or, for tier C, the document head) has a real
// anchor if ANY cited hash resolves, ANY cited "Patch N" is a real entry, ANY
// cited test file exists on disk, or ANY cited date is plausible.
function hasRealAnchor(text) {
  let m;
  HASH_TOKEN_RE.lastIndex = 0;
  while ((m = HASH_TOKEN_RE.exec(text))) {
    if (resolveHashAnywhere(m[1])) return true;
  }
  const validPatches = validPatchNumbers();
  PATCH_REF_RE.lastIndex = 0;
  while ((m = PATCH_REF_RE.exec(text))) {
    if (validPatches.has(m[1])) return true;
  }
  TEST_FILE_REF_RE.lastIndex = 0;
  while ((m = TEST_FILE_REF_RE.exec(text))) {
    if (fs.existsSync(path.join(ROOT, m[0]))) return true;
  }
  DATE_TOKEN_RE.lastIndex = 0;
  while ((m = DATE_TOKEN_RE.exec(text))) {
    if (isPlausibleDate(m[1], m[2], m[3])) return true;
  }
  return false;
}

function hasAnchoredHistoricalMarker(paragraph) {
  return CORRECTIVE_KEYWORD_RE.test(paragraph) && hasRealAnchor(paragraph);
}

function paragraphAround(text, index) {
  const start = text.lastIndexOf('\n\n', index);
  const end = text.indexOf('\n\n', index);
  return text.slice(start === -1 ? 0 : start, end === -1 ? text.length : end);
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

// ─── Rule 1: retired verbs / sentinels ──────────────────────────────────────

// A single literal space, not \s+: a real invocation always reads "ruflo-kit
// <verb>" with one space (`ruflo-kit sync <target>`); multiple spaces/tabs
// show up only in layout diagrams / table padding (e.g. README.md's "Layout"
// tree: "bin/      ruflo-kit          single entrypoint dispatcher" — that
// "single" is prose, not a verb, and false-matched before this was tightened).
const VERB_MENTION_RE = /\bruflo-kit ([a-z][a-z0-9-]*)\b/g;

function checkRetiredSurfaces(files, liveVerbSet, liveSentinelSet) {
  const violations = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    const wholeExempt = isWholeFileExempt(file, text);

    VERB_MENTION_RE.lastIndex = 0;
    let m;
    while ((m = VERB_MENTION_RE.exec(text))) {
      const verb = m[1];
      if (liveVerbSet.has(verb)) continue;
      if (wholeExempt) continue;
      if (hasAnchoredHistoricalMarker(paragraphAround(text, m.index))) continue;
      violations.push(
        `${rel}:${lineOf(text, m.index)} references "ruflo-kit ${verb}", which is not a verb ` +
        `bin/ruflo-kit's dispatcher recognizes today. Fix: update to a live verb (` +
        `${[...liveVerbSet].sort().join(', ')}), or if this is deliberate history, add a ` +
        `historical marker ("STALE", "corrected", "no longer …") anchored to a real commit hash, ` +
        `"Patch N", plausible date, or guarding test file in this same paragraph.`
      );
    }

    SENTINEL_RE.lastIndex = 0;
    while ((m = SENTINEL_RE.exec(text))) {
      const token = m[0];
      if (liveSentinelSet.has(token)) continue;
      if (wholeExempt) continue;
      if (hasAnchoredHistoricalMarker(paragraphAround(text, m.index))) continue;
      violations.push(
        `${rel}:${lineOf(text, m.index)} references sentinel "${token}", which greps nowhere in ` +
        `lib/, assets/, tools/, bin/ruflo-kit, or install.sh — it looks retired or renamed. ` +
        `Fix: update to the current sentinel name, or add a historical marker to this paragraph ` +
        `if the reference is deliberate history.`
      );
    }
  }
  return violations;
}

// ─── Rule 2a: unverifiable identity claims ─────────────────────────────────

const IDENTITY_CLAIM_RE = /\b(?:byte-identical|identical to upstream|same as upstream)\b/gi;
// Two tiers, honestly distinguished: hasRealAnchor() (round 3) is the same
// resolved-hash / verified-Patch-N / existing-test-file / plausible-date
// check tiers B-D use. VERIFICATION_ANCHOR_RE below is what's left that this
// guard CANNOT verify without either re-deriving a diff/hash itself (a git/
// diff/sha256/cmp command mention, or the BRAIN-FALLBACK-DEGRADED-V1 sentinel
// name) or trusting a bare timestamp shape — these remain STATED-METHODOLOGY
// HINTS for a human reviewer, not resolution checks, and are kept narrow
// (unchanged from round 2) rather than expanded, since widening them further
// would just be more decoration.
const VERIFICATION_ANCHOR_RE =
  /`(?:git\s+(?:diff|show|log)|diff\s|sha256|cmp\s)|tests\/[\w.-]+\.test\.m?js|BRAIN-FALLBACK-DEGRADED-V1|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function checkIdentityClaims(files) {
  const violations = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    if (isWholeFileExempt(file, text)) continue;

    IDENTITY_CLAIM_RE.lastIndex = 0;
    let m;
    while ((m = IDENTITY_CLAIM_RE.exec(text))) {
      const para = paragraphAround(text, m.index);
      if (hasAnchoredHistoricalMarker(para)) continue;
      if (hasRealAnchor(para)) continue; // round-3: real resolution, checked first
      if (VERIFICATION_ANCHOR_RE.test(para)) continue; // unverified methodology hint, see above
      violations.push(
        `${rel}:${lineOf(text, m.index)} claims "${m[0]}" with no verifiable anchor in the same ` +
        `paragraph (a git/diff/sha256 command, a guarding test file, or a live-check timestamp). ` +
        `This is the exact shape that burned lib/fix-brain.sh's "verified byte-identical to ` +
        `upstream" comment (now false — see BRAIN-FALLBACK-DEGRADED-V1). Fix: attach a re-check ` +
        `command/test reference, or soften to a hedged, dated claim.`
      );
    }
  }
  return violations;
}

// ─── Rule 2b: hard-coded counts for known-drifting vendored assets ─────────

const SKILLS_TREE_COUNT_RE =
  /(?:\.agents\/skills[^.\n]{0,200}?~?\d[\d,.]*\s*(?:k\b|KB|MB|tests?|files?)|~?\d[\d,.]*\s*(?:k\b|KB|MB|tests?|files?)[^.\n]{0,200}?\.agents\/skills)/gi;
const LAUNCHER_SIZE_RE =
  /(?:assets\/brain\/server\.mjs|brain launcher)[^.\n]{0,150}?~?\d[\d,.]*\s*(?:KB|MB)\b|~?\d[\d,.]*\s*(?:KB|MB)\b[^.\n]{0,150}?(?:assets\/brain\/server\.mjs|brain launcher)/gi;

function checkDriftingCounts(files) {
  const violations = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    if (isWholeFileExempt(file, text)) continue;

    for (const [label, re] of [
      ['ruflo init .agents/skills size/count', SKILLS_TREE_COUNT_RE],
      ['brain launcher byte size', LAUNCHER_SIZE_RE],
    ]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const para = paragraphAround(text, m.index);
        if (hasAnchoredHistoricalMarker(para)) continue;
        violations.push(
          `${rel}:${lineOf(text, m.index)} states a fixed ${label} ` +
          `("${m[0].replace(/\s+/g, ' ').slice(0, 80)}") — this describes upstream's own artifact ` +
          `and has already drifted once (~19.5k tests -> a single SKILL.md via #2777; the "2 KB" ` +
          `launcher comment drifted 58%). Fix: drop the number, or hedge it with a historical ` +
          `marker and a command to re-derive the current value (e.g. wc -l / du -sh).`
        );
      }
    }
  }
  return violations;
}

// ─── Rule 3: version/commit citations (generalized from ────────────────────
//              tests/brain-fallback-drift.test.js's REFERENCE_RE/HASH_SHAPE_RE) ──

const CITATION_RE = /\bv?(\d+\.\d+\.\d+)\s*\(commit ([^)\n]*)\)/gi;
const HASH_SHAPE_RE = /^[0-9a-f]{7,40}$/;

function vendorDirs() {
  const vendorRoot = path.join(ROOT, 'vendor');
  if (!fs.existsSync(vendorRoot)) return [];
  return fs.readdirSync(vendorRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(vendorRoot, e.name))
    .filter((d) => fs.existsSync(path.join(d, '.git')));
}

function commitExists(repoDir, hash) {
  const r = spawnSync('git', ['-C', repoDir, 'cat-file', '-e', `${hash}^{commit}`], { encoding: 'utf8' });
  return r.status === 0;
}

function versionAtCommit(repoDir, hash) {
  const r = spawnSync('git', ['-C', repoDir, 'show', `${hash}:package.json`], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout).version || null;
  } catch {
    return null;
  }
}

function checkVersionCitations(files) {
  const violations = [];
  const vdirs = vendorDirs();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);

    CITATION_RE.lastIndex = 0;
    let m;
    while ((m = CITATION_RE.exec(text))) {
      const [, citedVersion, hash] = m;
      const line = lineOf(text, m.index);

      // Pure string validation, no historical exemption: a malformed hash was
      // never a trustworthy citation, past or present (mirrors
      // brain-fallback-drift.test.js section 6's "never silently skipped").
      if (!HASH_SHAPE_RE.test(hash)) {
        violations.push(
          `${rel}:${line} cites "v${citedVersion} (commit ${hash})" — "${hash}" is not a valid ` +
          `7-40 char hex hash (too short/ambiguous, or not hex). Fix the hash or drop the ` +
          `"(commit …)" parenthetical entirely.`
        );
        continue;
      }

      for (const dir of vdirs) {
        if (!commitExists(dir, hash)) continue;
        const v = versionAtCommit(dir, hash);
        if (v && v !== citedVersion) {
          violations.push(
            `${rel}:${line} cites "v${citedVersion} (commit ${hash})", but that commit's ` +
            `package.json in ${path.relative(ROOT, dir)} reads v${v} — wrong commit for that ` +
            `version. Re-verify with: git -C ${path.relative(ROOT, dir)} show ${hash}:package.json`
          );
        }
        break; // resolved in this checkout; no need to try the others
      }
      // Unresolved in every local vendor/* checkout: skip cleanly. vendor/ is
      // gitignored, so a citation's own repo may simply not be checked out
      // here or in CI — that is not evidence the citation is wrong.
    }
  }
  return violations;
}

// ─── test fixture helper ────────────────────────────────────────────────────

function writeTempCopy(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-surface-guard-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

// ═════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════

describe('doc-surface guard — live-surface derivation (sanity, guards against a silent parser regression)', () => {
  it('derives a non-trivial live verb set from bin/ruflo-kit\'s real dispatch block', () => {
    const verbs = liveVerbs();
    expect(verbs.has('setup')).toBe(true);
    expect(verbs.has('sync')).toBe(true);
    expect(verbs.has('fix-brain')).toBe(true);
    expect(verbs.size).toBeGreaterThanOrEqual(20);
  });

  it('derives a non-trivial live sentinel set from lib/assets/tools/bin/install.sh', () => {
    const sentinels = liveSentinels(runtimeSourceText());
    expect(sentinels.has('STATUSLINE-GUARD-V1')).toBe(true);
    expect(sentinels.has('AQE-ROOT-INHERIT-GUARD-V1')).toBe(true);
    expect(sentinels.size).toBeGreaterThanOrEqual(30);
  });

  it('the patch-log shape detector fires ONLY on docs/_INSTRUCTIONS.md across the whole corpus', () => {
    const hits = corpusFiles()
      .filter((f) => isPatchLogShaped(f, fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f));
    expect(hits).toEqual(['docs/_INSTRUCTIONS.md']);
  });

  it('the underscore-prefix naming convention is unique to docs/_INSTRUCTIONS.md in the tracked corpus', () => {
    const hits = corpusFiles()
      .filter((f) => path.basename(f).startsWith('_'))
      .map((f) => path.relative(ROOT, f));
    expect(hits).toEqual(['docs/_INSTRUCTIONS.md']);
  });
});

describe('doc-surface guard — Rule 1: retired verbs and sentinels', () => {
  it('the current corpus references only live verbs/sentinels, or carries a historical marker', () => {
    const violations = checkRetiredSurfaces(corpusFiles(), liveVerbs(), liveSentinels(runtimeSourceText()));
    expect(violations.join('\n\n')).toBe('');
  });

  it('falsification: a retired verb reference is caught when planted', () => {
    const tmp = writeTempCopy('CLAUDE.md', 'Run `ruflo-kit provision <target>` first.\n');
    const violations = checkRetiredSurfaces([tmp], liveVerbs(), liveSentinels(runtimeSourceText()));
    expect(violations.length).toBe(1);
    expect(violations[0]).toMatch(/ruflo-kit provision/);
    expect(violations[0]).toMatch(/^.+:\d+ /); // Rule 4: file:line prefix
    expect(violations[0]).toMatch(/Fix:/); // Rule 4: suggested fix
  });

  it('falsification: a retired sentinel reference is caught when planted', () => {
    const tmp = writeTempCopy('CLAUDE.md', 'Guarded by sentinel `TOTALLY-MADE-UP-V9`.\n');
    const violations = checkRetiredSurfaces([tmp], liveVerbs(), liveSentinels(runtimeSourceText()));
    expect(violations.length).toBe(1);
    expect(violations[0]).toMatch(/TOTALLY-MADE-UP-V9/);
  });

  it('the SAME retired sentinel is NOT flagged once its paragraph carries a REAL, resolvable anchor (Patch 41 genuinely exists)', () => {
    // "Patch 41" is a real entry in docs/_INSTRUCTIONS.md (verified:
    // `grep -n '\*\*(41)' docs/_INSTRUCTIONS.md`) — round 2's fixture used the
    // fabricated "Patch 12" (no such entry exists), which round-3's real
    // Patch-N resolution would now correctly reject; this fixture uses a
    // number confirmed to actually exist.
    const tmp = writeTempCopy(
      'CLAUDE.md',
      'STALE note (Patch 41): this used to be guarded by sentinel `TOTALLY-MADE-UP-V9`, since retired.\n'
    );
    const violations = checkRetiredSurfaces([tmp], liveVerbs(), liveSentinels(runtimeSourceText()));
    expect(violations.join('\n')).toBe('');
  });

  it('a FABRICATED "Patch N" that does not exist in the real patch log no longer exempts (round-3 real resolution)', () => {
    const tmp = writeTempCopy(
      'CLAUDE.md',
      'STALE note (Patch 9999): this used to be guarded by sentinel `TOTALLY-MADE-UP-V9`, since retired.\n'
    );
    const violations = checkRetiredSurfaces([tmp], liveVerbs(), liveSentinels(runtimeSourceText()));
    expect(violations.length).toBe(1);
    expect(violations[0]).toMatch(/TOTALLY-MADE-UP-V9/);
  });

  it('a BARE "STALE"/"retired" keyword with no anchor no longer exempts (round-2 tightening, Attack C class)', () => {
    const tmp = writeTempCopy(
      'CLAUDE.md',
      'STALE note: this used to be guarded by sentinel `TOTALLY-MADE-UP-V9`, since retired.\n'
    );
    const violations = checkRetiredSurfaces([tmp], liveVerbs(), liveSentinels(runtimeSourceText()));
    expect(violations.length).toBe(1);
    expect(violations[0]).toMatch(/TOTALLY-MADE-UP-V9/);
  });

  it(
    'docs/vendor/** is out of scope structurally (gitignored, same as the top-level vendor/) — ' +
    'a retired sentinel there is never even scanned, not exempted by a directory-tier',
    () => {
      // Round-2 claimed docs/vendor/** was a TRACKED ledger directory and gave it its own
      // whole-file exemption tier. That was factually wrong: `.gitignore:13`'s bare `vendor/`
      // pattern matches "vendor" at any depth, so docs/vendor/** is untracked too — confirmed
      // both ways below, against the REAL repo (docs/gauntlet-2026-07-31/ exists on disk
      // right now from concurrent wave-2 work, so this is not a hypothetical).
      const real = path.join(ROOT, 'docs', 'vendor');
      expect(fs.existsSync(real)).toBe(true); // it's really there on disk
      const ignored = spawnSync('git', ['check-ignore', '--', 'docs/vendor'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      expect(ignored.status).toBe(0); // git confirms it's ignored
      const tracked = spawnSync('git', ['ls-files', '--', 'docs/vendor/**'], {
        cwd: ROOT,
        encoding: 'utf8',
      }).stdout.trim();
      expect(tracked).toBe(''); // nothing under it is tracked
      // Consequence: corpusFiles() (git-ls-files-backed) never returns anything under
      // docs/vendor/, so a retired sentinel planted there is invisible to this guard by
      // construction — not because of a directory-tier exemption (there is no such tier anymore).
      for (const f of corpusFiles()) {
        expect(path.relative(ROOT, f).startsWith(`docs${path.sep}vendor${path.sep}`)).toBe(false);
      }
    }
  );
});

describe('doc-surface guard — Rule 2a: unverifiable "byte-identical to upstream" claims', () => {
  it('the current corpus has no unverifiable identity claims', () => {
    const violations = checkIdentityClaims(corpusFiles());
    expect(violations.join('\n\n')).toBe('');
  });

  it('falsification: reproduces the real lib/fix-brain.sh comment shape and catches it', () => {
    const tmp = writeTempCopy(
      'OPS.md',
      'the kit-tracked copy of the same MIT-licensed 2KB launcher (verified byte-identical to ' +
      'upstream at vendor sync; re-sync when upstream changes it).\n'
    );
    const violations = checkIdentityClaims([tmp]);
    expect(violations.length).toBe(1);
    expect(violations[0]).toMatch(/byte-identical/);
  });

  it('does NOT flag a claim sitting next to a real verification anchor (live-check timestamp)', () => {
    const tmp = writeTempCopy(
      'OPS.md',
      'Confirmed against the real GitHub API right now, published 2026-07-31T07:22:51Z: the asset ' +
      'layout is byte-identical to upstream.\n'
    );
    const violations = checkIdentityClaims([tmp]);
    expect(violations.join('\n')).toBe('');
  });

  it('does NOT flag a claim sitting next to a guarding test-file reference', () => {
    const tmp = writeTempCopy(
      'OPS.md',
      'This fallback is byte-identical to upstream at vendor-sync time; drift is caught by ' +
      'tests/brain-fallback-drift.test.js.\n'
    );
    const violations = checkIdentityClaims([tmp]);
    expect(violations.join('\n')).toBe('');
  });
});

describe('doc-surface guard — Rule 2b: hard-coded counts for known-drifting vendored assets', () => {
  it('the current corpus has no unhedged fixed counts for the .agents/skills tree or the brain launcher', () => {
    const violations = checkDriftingCounts(corpusFiles());
    expect(violations.join('\n\n')).toBe('');
  });

  it('falsification: reproduces the "~19.5k tests" claim and catches it', () => {
    const tmp = writeTempCopy(
      'OPS.md',
      'ruflo init vendors an upstream ruflo tree under .agents/skills (~19.5k of its own tests).\n'
    );
    const violations = checkDriftingCounts([tmp]);
    expect(violations.length).toBe(1);
  });

  it('falsification: reproduces the "2 KB launcher" claim and catches it', () => {
    const tmp = writeTempCopy(
      'OPS.md',
      'the brain launcher is a 2 KB file, unchanged from upstream.\n'
    );
    const violations = checkDriftingCounts([tmp]);
    expect(violations.length).toBe(1);
  });

  it('does NOT flag the same claim once corrected with a marker anchored to a real, plausible date', () => {
    // "#2777" alone is deliberately NOT enough post-round-3 (issue numbers were dropped as an
    // accepted anchor — no local, network-free way to confirm one exists). The real
    // docs/OPERATIONS.md paragraph that cites "#2777" also carries a real date
    // ("first fresh-target e2e 2026-07-18") in the same paragraph — mirrored here.
    const tmp = writeTempCopy(
      'OPS.md',
      'STALE (corrected 2026-07-20): ruflo init used to vendor ~19.5k tests into .agents/skills; ' +
      'see #2777.\n'
    );
    const violations = checkDriftingCounts([tmp]);
    expect(violations.join('\n')).toBe('');
  });

  it('a bare "#2777" with no date/hash/Patch-N/test-file anchor no longer exempts on its own (round-3 tightening)', () => {
    const tmp = writeTempCopy(
      'OPS.md',
      'STALE: ruflo init used to vendor ~19.5k tests into .agents/skills; corrected, see #2777.\n'
    );
    const violations = checkDriftingCounts([tmp]);
    expect(violations.length).toBe(1);
  });
});

describe('doc-surface guard — Rule 3: version/commit citations (generalized from brain-fallback-drift.test.js)', () => {
  it(
    'the current corpus carries zero "vX.Y.Z (commit HASH)" citations (the one known instance ' +
    'lives in lib/fix-brain.sh + assets/brain/server.mjs, already tripwired by ' +
    'tests/brain-fallback-drift.test.js, outside this file\'s corpus/footprint)',
    () => {
      const violations = checkVersionCitations(corpusFiles());
      expect(violations.join('\n\n')).toBe('');
    }
  );

  it('falsification: a malformed/truncated hash citation fails unconditionally, even with no vendor/ present', () => {
    const tmp = writeTempCopy('L.md', 'documented against upstream v4.0.2 (commit e20cdf).\n');
    const violations = checkVersionCitations([tmp]);
    expect(violations.length).toBe(1);
    expect(violations[0]).toMatch(/e20cdf/);
    expect(violations[0]).toMatch(/not a valid/);
  });

  it('falsification: a well-formed hash paired with the WRONG version is caught against a real vendor/* checkout', () => {
    const dirs = vendorDirs();
    if (dirs.length === 0) {
      // Skips cleanly: no local vendor/* git checkout to resolve against on
      // this machine (vendor/ is gitignored) — never a CI failure.
      return;
    }
    // vendor/ruvnet-brain's first commit reads package.json version 0.4.0-dev
    // (confirmed live: `git -C vendor/ruvnet-brain show <first-commit>:package.json`).
    // Citing it as v4.0.2 reproduces the exact defect class this rule exists for.
    const ruvnetBrain = dirs.find((d) => path.basename(d) === 'ruvnet-brain');
    if (!ruvnetBrain) return; // skip cleanly if this particular checkout isn't present
    const firstCommit = spawnSync(
      'git', ['-C', ruvnetBrain, 'log', '--reverse', '--format=%H'], { encoding: 'utf8' }
    ).stdout.trim().split('\n')[0];
    if (!firstCommit) return;
    const tmp = writeTempCopy('L.md', `documented against upstream v4.0.2 (commit ${firstCommit}).\n`);
    const violations = checkVersionCitations([tmp]);
    expect(violations.length).toBe(1);
    expect(violations[0]).toMatch(/wrong commit for that version/);
  });
});

describe('doc-surface guard — round-2 bypass hardening (still holds: shape-only attacks fail)', () => {
  it('Attack A (round 1): five one-word "**(N)**" lines still fail content shape alone', () => {
    const bait = [
      '**(1)**a', '**(2)**b', '**(3)**c', '**(4)**d', '**(5)**e', '',
      'The brain launcher is byte-identical to upstream.',
    ].join('\n');
    expect(isPatchLogContentShaped(bait)).toBe(false); // fails BOTH title-length and file-size gates
    const tmp = writeTempCopy('BAIT-A.md', bait);
    expect(isPatchLogShaped(tmp, bait)).toBe(false);
    const violations = checkIdentityClaims([tmp]);
    expect(violations.length).toBe(1);
    expect(violations[0]).toMatch(/byte-identical/);
  });
});

describe('doc-surface guard — round-3 bypass hardening (critic-reported, real-anchor gap now closed)', () => {
  it(
    'Attack A\' (round 2): a Lorem-Ipsum-padded file clears content shape (size + title length) but ' +
    'is STILL caught — it is not named with the governance underscore convention',
    () => {
      const padding = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(200);
      const fakeEntry = (n) =>
        `**(${n}) This is a filler patch title padded past forty characters for the gate.**`;
      const bait = [
        fakeEntry(1), fakeEntry(2), fakeEntry(3), fakeEntry(4), fakeEntry(5),
        padding, '', 'The brain launcher is byte-identical to upstream.',
      ].join('\n');
      expect(bait.length).toBeGreaterThanOrEqual(10_000); // clears round-2's size gate
      expect(isPatchLogContentShaped(bait)).toBe(true); // content shape alone: satisfied
      const tmp = writeTempCopy('OPS.md', bait); // ordinary name — NOT underscore-prefixed
      expect(isPatchLogShaped(tmp, bait)).toBe(false); // whole-file exemption: still denied
      const violations = checkIdentityClaims([tmp]);
      expect(violations.length).toBe(1); // the planted claim is still caught
      expect(violations[0]).toMatch(/byte-identical/);
    }
  );

  it(
    'Attack B (Tier C): a fabricated hash and an impossible future date both fail real resolution',
    () => {
      const fakeHash = writeTempCopy(
        'FAKE-HASH.md',
        'This is a dated snapshot at commit `abc1234` (totally made up, never a real commit).\n\n' +
        'The kit repo brain launcher is byte-identical to upstream, no caveats.\n'
      );
      expect(resolveHashAnywhere('abc1234')).toBe(false);
      expect(checkIdentityClaims([fakeHash]).length).toBe(1);

      const futureDate = writeTempCopy(
        'FUTURE-DATE.md',
        'This is a dated snapshot as of 2099-01-01 (a date in the far future, never checked).\n\n' +
        'The kit repo brain launcher is byte-identical to upstream, no caveats.\n'
      );
      expect(isPlausibleDate('2099', '01', '01')).toBe(false);
      expect(checkIdentityClaims([futureDate]).length).toBe(1);

      const backwardsDate = writeTempCopy(
        'BACKWARDS-DATE.md',
        'This is a dated snapshot as of 2020-01-01 (predates this repo entirely).\n\n' +
        'The kit repo brain launcher is byte-identical to upstream, no caveats.\n'
      );
      expect(isPlausibleDate('2020', '01', '01')).toBe(false); // before this repo's first commit
      expect(checkIdentityClaims([backwardsDate]).length).toBe(1);

      // Round-1/2 regression: zero anchor at all (the original bypass) must still fail too.
      const noAnchor = writeTempCopy(
        'NO-ANCHOR.md',
        'This is a dated snapshot; treat contents accordingly.\n\n' +
        'The kit repo brain launcher is byte-identical to upstream, no caveats.\n'
      );
      expect(hasSnapshotDisclaimer(fs.readFileSync(noAnchor, 'utf8'))).toBe(false);
      expect(checkIdentityClaims([noAnchor]).length).toBe(1);
    }
  );

  it(
    'Attack C (Tier D): a nonexistent issue number, a nonexistent Patch N, a backwards date, and an ' +
    'unreleased version all now fail — none resolve to anything real',
    () => {
      const cases = [
        'The brain launcher is byte-identical to upstream — corrected, see #99999999 (an issue that does not exist).\n',
        'The brain launcher is byte-identical to upstream — corrected (Patch 9999, which was never actually made).\n',
        'The brain launcher is byte-identical to upstream — corrected as of 2020-01-01 (predates the claim itself).\n',
        'The brain launcher is byte-identical to upstream — corrected in v9.9.9 (a version that was never released).\n',
      ];
      for (const text of cases) {
        expect(hasAnchoredHistoricalMarker(text)).toBe(false);
        const tmp = writeTempCopy('BAIT-D.md', text);
        const violations = checkIdentityClaims([tmp]);
        expect(violations.length).toBe(1);
      }
    }
  );

  it(
    'a REAL correction with a REAL, resolvable anchor still passes on each accepted anchor form',
    () => {
      // Hash: resolves in THIS repo's own history (9d5bffe is the real anchor
      // self-improvement-next-steps.md uses; verified it resolves via `git cat-file -e`).
      expect(resolveHashAnywhere('9d5bffe')).toBe(true);
      const byHash = 'The brain launcher claim was corrected, see commit `9d5bffe`: no longer byte-identical to upstream.\n';
      expect(hasAnchoredHistoricalMarker(byHash)).toBe(true);
      expect(checkIdentityClaims([writeTempCopy('BY-HASH.md', byHash)]).join('\n')).toBe('');

      // Patch N: dynamically pulled from the REAL corpus so this test can't rot if patch
      // numbers change — not hardcoded to a specific number.
      const realPatch = [...validPatchNumbers()][0];
      expect(realPatch).toBeTruthy();
      const byPatch = `The brain launcher claim was corrected (Patch ${realPatch}): no longer byte-identical to upstream.\n`;
      expect(hasAnchoredHistoricalMarker(byPatch)).toBe(true);
      expect(checkIdentityClaims([writeTempCopy('BY-PATCH.md', byPatch)]).join('\n')).toBe('');

      // Test-file reference: must exist on disk — this one does.
      const byTestFile = 'The brain launcher claim was corrected — no longer byte-identical to upstream, see tests/brain-fallback-drift.test.js.\n';
      expect(hasAnchoredHistoricalMarker(byTestFile)).toBe(true);
      expect(checkIdentityClaims([writeTempCopy('BY-TESTFILE.md', byTestFile)]).join('\n')).toBe('');

      // Plausible date: within [repo's first commit, today].
      const byDate = 'The brain launcher claim was corrected 2026-07-31: no longer byte-identical to upstream.\n';
      expect(hasAnchoredHistoricalMarker(byDate)).toBe(true);
      expect(checkIdentityClaims([writeTempCopy('BY-DATE.md', byDate)]).join('\n')).toBe('');
    }
  );

  it('re-run of the full false-positive analysis: every rule is still clean on the real, widened, re-hardened corpus', () => {
    const verbs = liveVerbs();
    const sentinels = liveSentinels(runtimeSourceText());
    const files = corpusFiles();
    const violations = [
      ...checkRetiredSurfaces(files, verbs, sentinels),
      ...checkIdentityClaims(files),
      ...checkDriftingCounts(files),
      ...checkVersionCitations(files),
    ];
    expect(violations.join('\n\n')).toBe('');
  });
});

describe('doc-surface guard — round-4: dated session-ledger directory (Tier E)', () => {
  it('the real docs/gauntlet-2026-07-31/ ledgers ARE tracked and reach the corpus (the old tier A never did)', () => {
    const tracked = spawnSync('git', ['ls-files', '--', 'docs/gauntlet-2026-07-31/**'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).stdout.trim();
    expect(tracked).not.toBe('');
    const inCorpus = corpusFiles().some((f) =>
      path.relative(ROOT, f).startsWith(`docs${path.sep}gauntlet-2026-07-31${path.sep}`)
    );
    expect(inCorpus).toBe(true);
  });

  it('the dated-directory naming convention is unique among tracked docs/ subdirectories', () => {
    const subdirs = new Set(
      spawnSync('git', ['ls-files', '--', 'docs/**'], { cwd: ROOT, encoding: 'utf8' }).stdout
        .trim()
        .split('\n')
        .map((f) => f.split('/')[1])
        .filter((d) => d && !d.endsWith('.md'))
    );
    const matching = [...subdirs].filter((d) => DATED_LEDGER_DIR_RE.test(d));
    expect(matching).toEqual(['gauntlet-2026-07-31']);
  });

  it('a quoted retired sentinel and the exact "byte-identical" claim inside the real ledger are exempt (documenting history, not asserting it)', () => {
    const violations = [
      ...checkRetiredSurfaces(corpusFiles(), liveVerbs(), liveSentinels(runtimeSourceText())),
      ...checkIdentityClaims(corpusFiles()),
    ].filter((v) => v.includes('gauntlet-2026-07-31'));
    expect(violations.join('\n')).toBe('');
  });

  it('falsification: a FABRICATED dated directory with an IMPLAUSIBLE (future) date is NOT exempted', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-surface-guard-'));
    const fakeLedgerDir = path.join(dir, 'docs', 'fake-2099-01-01');
    fs.mkdirSync(fakeLedgerDir, { recursive: true });
    const file = path.join(fakeLedgerDir, 'notes.md');
    fs.writeFileSync(file, 'The brain launcher is byte-identical to upstream.\n');
    // Simulate the path shape relative to ROOT, the way isDatedLedgerPath() checks it.
    const relStyled = path.join(ROOT, 'docs', 'fake-2099-01-01', 'notes.md');
    expect(DATED_LEDGER_DIR_RE.test('fake-2099-01-01')).toBe(true); // shape matches
    expect(isDatedLedgerPath(relStyled)).toBe(false); // but the date is not plausible
    const text = fs.readFileSync(file, 'utf8');
    expect(isWholeFileExempt(relStyled, text)).toBe(false);
    expect(checkIdentityClaims([file]).length).toBe(1); // the planted claim is still caught
  });

  it('falsification: an ordinary, non-dated docs/ subdirectory name does not qualify', () => {
    const relStyled = path.join(ROOT, 'docs', 'reference', 'notes.md');
    expect(isDatedLedgerPath(relStyled)).toBe(false);
  });

  it('the three round-3 bypasses are still caught after adding Tier E (Tier E is path-based, not a new shape-only escape)', () => {
    // Lorem-Ipsum padding (Attack A'): still needs the underscore convention, unaffected by Tier E.
    const padding = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(200);
    const fakeEntry = (n) => `**(${n}) This is a filler patch title padded past forty characters for the gate.**`;
    const bait = [fakeEntry(1), fakeEntry(2), fakeEntry(3), fakeEntry(4), fakeEntry(5), padding, '',
      'The brain launcher is byte-identical to upstream.'].join('\n');
    const tmpA = writeTempCopy('OPS.md', bait);
    expect(isWholeFileExempt(tmpA, bait)).toBe(false);
    expect(checkIdentityClaims([tmpA]).length).toBe(1);

    // Fabricated hash / impossible date (Attack B): unaffected, still fails real resolution.
    expect(resolveHashAnywhere('abc1234')).toBe(false);
    expect(isPlausibleDate('2099', '01', '01')).toBe(false);

    // Fake issue/Patch/date/version anchors (Attack C): unaffected.
    const attackC = 'The brain launcher is byte-identical to upstream — corrected, see #99999999 (an issue that does not exist).\n';
    expect(hasAnchoredHistoricalMarker(attackC)).toBe(false);
  });
});

describe('doc-surface guard — corpus is git-scoped (fresh-clone / gitignored-doc safety)', () => {
  it('corpusFiles() never returns an untracked or gitignored file', () => {
    const tracked = new Set(
      spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n')
    );
    for (const f of corpusFiles()) {
      expect(tracked.has(path.relative(ROOT, f))).toBe(true);
    }
  });

  it(
    'simulates a fresh clone: the previously-crashing gitignored doc is absent from the corpus, ' +
    'and every check function runs clean instead of throwing ENOENT',
    () => {
      const untracked = path.join(ROOT, 'docs', 'NPM-DISTRIBUTION-RESEARCH-2026-07-18.md');
      // Confirmed out-of-scope by construction, not by this test hiding it:
      // untracked + gitignored, so corpusFiles() (git-ls-files-backed) already
      // excludes it — this assertion documents WHY, it does not create the
      // exclusion.
      const tracked = new Set(
        spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n')
      );
      expect(tracked.has(path.relative(ROOT, untracked))).toBe(false);
      expect(corpusFiles().includes(untracked)).toBe(false);

      // The actual fresh-clone reproduction: hide the file (rename, not
      // delete — restored in `finally`) and re-run every check function
      // end-to-end. Round 1 crashed here (ENOENT inside checkIdentityClaims,
      // via a test that hardcoded this exact path with no existence guard).
      const existed = fs.existsSync(untracked);
      const backup = `${untracked}.doc-surface-guard-hidden`;
      if (existed) fs.renameSync(untracked, backup);
      try {
        const verbs = liveVerbs();
        const sentinels = liveSentinels(runtimeSourceText());
        const files = corpusFiles();
        expect(() => {
          checkRetiredSurfaces(files, verbs, sentinels);
          checkIdentityClaims(files);
          checkDriftingCounts(files);
          checkVersionCitations(files);
        }).not.toThrow();
      } finally {
        if (existed) fs.renameSync(backup, untracked);
      }
    }
  );
});
