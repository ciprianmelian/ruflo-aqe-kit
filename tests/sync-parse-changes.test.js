/**
 * PARSE-CHANGES-ANSI-V1 — lib/sync.sh's parse_changes() counted ANSI escape
 * digits instead of the change count.
 *
 * THE DEFECT (found live during the ruflo 3.33.0 -> 3.34.0 upgrade):
 * fix-ruflo prints its tally COLOURED. The literal bytes are:
 *
 *     Fixes applied:    <ESC>[0;32m1<ESC>[0m
 *
 * The old parser did `grep -oE '[0-9]+' | head -1`, which matches the digits
 * in the SGR sequence `[0;32m` before ever reaching the count — the first
 * match is the `0` of `0;32m`. So `sync` reported fix-ruflo as
 * "0 change(s)" ALWAYS, independent of how much work the stage did.
 *
 * WHY IT MATTERED: the moment an operator most needs this number is straight
 * after a version bump, when fix-ruflo has just re-applied every dist patch
 * the bump wiped. Observed exactly that on 3.34.0: all 5 sentinels + the
 * nested agentdb pin were gone, fix-ruflo restored them, and sync printed
 * `fix-ruflo  ok  0`. A bare "0 changes" there reads as "the bump disturbed
 * nothing" — the precise opposite of what happened. It was caught only
 * because the sentinels were counted on disk before and after.
 *
 * The `complete — N change(s)` branch (fix-aqe/fix-brain) was never affected:
 * it anchors on literal text, so the captured substring holds only the real
 * number. That asymmetry is why the bug hid — three of four stages reported
 * correctly.
 *
 * TEETH, AND WHY THEY ARE EMBEDDED RATHER THAN PINNED:
 * the pre-fix function is embedded below as a literal string, NOT recovered
 * via `git show <ref>:lib/sync.sh`. Earlier today four suites in this repo
 * broke the instant their fix was committed, because they reconstructed
 * "pre-fix" code from `git show HEAD:` and HEAD moved past the fix — turning
 * genuine teeth into tautologies. An embedded fixture cannot expire: it is
 * commit-stable, history-rewrite-stable, and needs no ref kept in sync.
 * See tests/intel-rootwalk-patch.test.js for the same choice.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SYNC_SH = path.resolve(__dirname, '..', 'lib', 'sync.sh');

// The REAL current parse_changes, extracted verbatim from lib/sync.sh so this
// test can never drift from what actually ships. A hand-copied duplicate would
// pass forever while the real function regressed.
function currentParseChanges() {
  const src = fs.readFileSync(SYNC_SH, 'utf8');
  const start = src.indexOf('parse_changes() {');
  if (start === -1) throw new Error('parse_changes() not found in lib/sync.sh');
  const end = src.indexOf('\n}', start);
  if (end === -1) throw new Error('parse_changes() body not terminated');
  return src.slice(start, end + 2);
}

// The PRE-FIX body, embedded (see header for why not git).
const PRE_FIX_PARSE_CHANGES = [
  'parse_changes() {',
  '  local out="$1" n',
  `  n="$(grep -oE 'complete — [0-9]+ change' <<< "$out" | grep -oE '[0-9]+' | head -1)"`,
  `  [[ -z "$n" ]] && n="$(grep -E 'Fixes applied:' <<< "$out" | grep -oE '[0-9]+' | head -1)"`,
  '  [[ -z "$n" ]] && n="-"',
  '  echo "$n"',
  '}',
].join('\n');

// Run a given parse_changes body against a stage-output string. `input` is
// emitted with printf so ANSI escapes survive into the function unchanged.
function runParse(fnBody, printfFormat) {
  const script = `${fnBody}\nout="$(printf '${printfFormat}')"\nparse_changes "$out"\n`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
}

// The exact byte sequence fix-ruflo emits (green count).
const COLOURED_ONE = '  Fixes applied:    \\033[0;32m1\\033[0m';
const COLOURED_TWELVE = '  Fixes applied:    \\033[0;32m12\\033[0m';
const PLAIN_SEVEN = '  Fixes applied:    7';
const COMPLETE_LINE = '  fix-aqe complete — 4 change(s)';

describe('PARSE-CHANGES-ANSI-V1: parse_changes() must count changes, not escape codes', () => {
  it('should_return1_when_fixRufloReportsAColouredCountOfOne', () => {
    expect(runParse(currentParseChanges(), COLOURED_ONE)).toBe('1');
  });

  it('should_return12_when_theColouredCountIsMultiDigit', () => {
    // Guards a naive fix that grabs only the last single digit.
    expect(runParse(currentParseChanges(), COLOURED_TWELVE)).toBe('12');
  });

  it('should_return7_when_theCountIsNotColouredAtAll', () => {
    // The strip must be a no-op on plain output, not a new failure mode.
    expect(runParse(currentParseChanges(), PLAIN_SEVEN)).toBe('7');
  });

  it('should_return4_when_theStageUsesTheCompleteChangeSForm', () => {
    // fix-aqe/fix-brain branch — was never broken, must stay unbroken.
    expect(runParse(currentParseChanges(), COMPLETE_LINE)).toBe('4');
  });

  it('should_returnDash_when_theOutputCarriesNoCountAtAll', () => {
    expect(runParse(currentParseChanges(), 'nothing countable here')).toBe('-');
  });

  it('TEETH: should_proveTheBugWasReal_byShowingPreFixCodeReturns0ForAColouredCountOf1', () => {
    // The whole defect in one assertion: the pre-fix parser reads the `0` out
    // of the SGR sequence `[0;32m` and reports zero work done.
    expect(runParse(PRE_FIX_PARSE_CHANGES, COLOURED_ONE)).toBe('0');
  });

  it('TEETH: should_proveTheEmbeddedPreFixFixtureIsFaithful_byShowingItStillHandlesThePlainCaseCorrectly', () => {
    // Guards the fixture itself: if the embedded "pre-fix" body were mangled
    // into something that fails everything, the teeth test above would pass
    // for the wrong reason. The pre-fix code was only broken for COLOURED
    // input — it handled plain input fine, and must still demonstrate that.
    expect(runParse(PRE_FIX_PARSE_CHANGES, PLAIN_SEVEN)).toBe('7');
  });
});
