/**
 * Tests for the tabular-output number parsers in lib/common.sh (HEALTH-COMMA-V1):
 * extract_number_after, extract_paren_count, extract_percent.
 *
 * Regression driver: ruflo >=3.32 prints thousands separators in its stats tables
 * (e.g. `| Total Entries |  1,921 |`). The original digit-grep returned the `1`
 * before the comma; the fix strips commas AFTER the label match. These tests pin
 * both the new (comma) and legacy (no-comma) formats, plus decimals, percents,
 * paren-counted cells, and the label-absent guard.
 *
 * Each parser is exercised by sourcing common.sh in a bash subshell and calling
 * the function with the label/text passed as ARGV ($1/$2) — never interpolated
 * into the script string — mirroring the source-then-call pattern in
 * helper-module-pinning.test.js.
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const COMMON = path.resolve(__dirname, '..', 'lib', 'common.sh');

// Call one parser with label/text as positional args ($1,$2). Returns trimmed stdout.
function parse(fn, label, text) {
  const r = spawnSync(
    'bash',
    ['-c', `source "${COMMON}"; ${fn} "$1" "$2"`, 'kit', label, text],
    { encoding: 'utf8' }
  );
  return (r.stdout || '').trim();
}

describe('extract_number_after', () => {
  it('reads the comma-separated thousands cell (the 3.32.2 bug: returned 1)', () => {
    expect(parse('extract_number_after', 'Total Entries', '| Total Entries |  1,921 |')).toBe('1921');
  });

  it('reads a legacy no-comma cell', () => {
    expect(parse('extract_number_after', 'Total Entries', '| Total Entries | 921 |')).toBe('921');
  });

  it('reads a decimal value', () => {
    expect(parse('extract_number_after', 'Latency', 'Latency 12.5 ms')).toBe('12.5');
  });

  it('label absent → empty/zero guard', () => {
    expect(parse('extract_number_after', 'Missing Label', '| Total Entries | 5 |')).toMatch(/^0?$/);
  });

  it('matches the label line even when it is not the first line', () => {
    const text = 'memory stats\n===============\n| Total Entries |  1,921 |\n| Namespaces | 4 |';
    expect(parse('extract_number_after', 'Total Entries', text)).toBe('1921');
  });

  it('picks the number even when it follows other non-digit chars on the label line', () => {
    expect(parse('extract_number_after', 'Total Entries', '| Total Entries | approx ~ 777 |')).toBe('777');
  });
});

describe('extract_paren_count', () => {
  it('reads the paren-counted, comma-separated cell (active (1,008 entries) → 1008)', () => {
    expect(parse('extract_paren_count', 'HNSW Index', '| HNSW Index | active (1,008 entries) |')).toBe('1008');
  });

  it('reads a bare "(N entries)" span', () => {
    expect(parse('extract_paren_count', '.', '(42 entries)')).toBe('42');
  });

  it('label present but no parens → empty/zero guard', () => {
    expect(parse('extract_paren_count', 'HNSW Index', '| HNSW Index | active |')).toMatch(/^0?$/);
  });
});

describe('extract_percent', () => {
  it('reads a percentage value', () => {
    expect(parse('extract_percent', 'Avg Quality', 'Avg Quality  75.0%')).toBe('75.0');
  });

  it('reads a comma-separated percentage', () => {
    expect(parse('extract_percent', '.', '1,234.5%')).toBe('1234.5');
  });

  it('label absent → empty/zero guard', () => {
    expect(parse('extract_percent', 'Nope', 'Avg Quality 75.0%')).toMatch(/^0?$/);
  });
});
