/**
 * Tests for KIT-ADOPTION-NOTE-V1 (fix-ruflo Step 5j).
 *
 * The mutation logic lives in tools/adoption-note.cjs precisely so it can be
 * driven in isolation here: fix-ruflo.sh is not sourceable standalone and its
 * Step 1 auto-upgrades the global toolchain, so the whole script is never run
 * un-dry under test (same rationale as tests/fix-ruflo-cfconfig.test.js).
 * The tool prints exactly one verdict token; the bash step maps tokens to
 * pass/fix/info/warn lines. Wiring into fix-ruflo.sh is asserted statically.
 *
 * Verdict contract:
 *   APPENDED | HEALED | UNCHANGED | SKIP_HANDWRITTEN | SKIP_NOFILE
 *   WOULD_APPEND | WOULD_HEAL   (dry-run)
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KIT_DIR = path.resolve(__dirname, '..');
const TOOL = path.join(KIT_DIR, 'tools', 'adoption-note.cjs');
const FIX_RUFLO = path.join(KIT_DIR, 'lib', 'fix-ruflo.sh');

const MARK_OPEN = '<!-- KIT-ADOPTION-NOTE-V1 -->';
const MARK_CLOSE = '<!-- /KIT-ADOPTION-NOTE-V1 -->';

let tmpRoot;
beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adoption-note-'));
});
afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

let seq = 0;
function mkClaudeMd(content) {
  const dir = path.join(tmpRoot, `case-${seq++}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'CLAUDE.md');
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
}

function runTool(file, extraArgs = []) {
  const r = spawnSync('node', [TOOL, file, KIT_DIR, ...extraArgs], {
    encoding: 'utf8',
    timeout: 30000,
  });
  return { verdict: (r.stdout || '').trim(), status: r.status, stderr: r.stderr || '' };
}

const PLAIN = '# Some project\n\nHand-rolled docs, no kit mention.\n';

describe('adoption-note.cjs (KIT-ADOPTION-NOTE-V1)', () => {
  it('(a) plain CLAUDE.md -> block appended with both markers and resolved KIT_DIR', () => {
    const file = mkClaudeMd(PLAIN);
    const { verdict, status } = runTool(file);
    expect(status).toBe(0);
    expect(verdict).toBe('APPENDED');
    const out = fs.readFileSync(file, 'utf8');
    expect(out.startsWith(PLAIN)).toBe(true); // original preserved, block at end
    expect(out).toContain(MARK_OPEN);
    expect(out).toContain(MARK_CLOSE);
    expect(out.indexOf(MARK_OPEN)).toBeLessThan(out.indexOf(MARK_CLOSE));
    // placeholder resolved to the actual kit dir
    expect(out).toContain(`ruflo-aqe-kit at \`${KIT_DIR}\``);
    // operational content: heal verbs, deliberate states, re-sync rule
    expect(out).toMatch(/ruflo-kit sync/);
    expect(out).toMatch(/ruflo-kit status/);
    expect(out).toMatch(/ruflo-kit proof/);
    expect(out).toMatch(/3\.0\.0-alpha\.10/);
    expect(out).toMatch(/never `npx`/);
    expect(out).toMatch(/ruflo daemon start/);
    expect(out).toMatch(/npm i -g ruflo/);
    // backup removed on success (rm-on-success idiom)
    expect(fs.existsSync(`${file}.fixruflo.bak`)).toBe(false);
  });

  it('(b) re-run on an already-canonical file -> UNCHANGED, byte-identical', () => {
    const file = mkClaudeMd(PLAIN);
    expect(runTool(file).verdict).toBe('APPENDED');
    const after = fs.readFileSync(file, 'utf8');
    const { verdict } = runTool(file);
    expect(verdict).toBe('UNCHANGED');
    expect(fs.readFileSync(file, 'utf8')).toBe(after);
  });

  it('(c) markers present but stale content -> healed back to canonical', () => {
    const file = mkClaudeMd(PLAIN);
    runTool(file);
    const canonical = fs.readFileSync(file, 'utf8');
    // Corrupt the managed content between the markers
    fs.writeFileSync(file, canonical.replace('do NOT "fix" these', 'feel free to fix'));
    const { verdict } = runTool(file);
    expect(verdict).toBe('HEALED');
    expect(fs.readFileSync(file, 'utf8')).toBe(canonical);
    expect(fs.existsSync(`${file}.fixruflo.bak`)).toBe(false);
    // and healing is itself idempotent
    expect(runTool(file).verdict).toBe('UNCHANGED');
  });

  it('(d) hand-written kit note (mentions ruflo-aqe-kit, no markers) -> skipped untouched', () => {
    const handWritten = '# adopted-target style\n\nManaged by the ruflo-aqe-kit clone; see docs.\n';
    const file = mkClaudeMd(handWritten);
    const { verdict } = runTool(file);
    expect(verdict).toBe('SKIP_HANDWRITTEN');
    expect(fs.readFileSync(file, 'utf8')).toBe(handWritten); // byte-identical
    expect(fs.existsSync(`${file}.fixruflo.bak`)).toBe(false);
  });

  it('(e) dry-run -> announces would-append / would-heal, file untouched', () => {
    // would-append
    const plain = mkClaudeMd(PLAIN);
    expect(runTool(plain, ['--dry-run']).verdict).toBe('WOULD_APPEND');
    expect(fs.readFileSync(plain, 'utf8')).toBe(PLAIN);

    // would-heal
    const stale = mkClaudeMd(PLAIN);
    runTool(stale);
    const corrupted = fs
      .readFileSync(stale, 'utf8')
      .replace('do NOT "fix" these', 'STALE LINE');
    fs.writeFileSync(stale, corrupted);
    expect(runTool(stale, ['--dry-run']).verdict).toBe('WOULD_HEAL');
    expect(fs.readFileSync(stale, 'utf8')).toBe(corrupted);

    // canonical stays UNCHANGED under dry-run too
    const done = mkClaudeMd(PLAIN);
    runTool(done);
    expect(runTool(done, ['--dry-run']).verdict).toBe('UNCHANGED');
  });

  it('no CLAUDE.md at all -> SKIP_NOFILE, nothing created', () => {
    const file = mkClaudeMd(undefined); // dir exists, file does not
    const { verdict, status } = runTool(file);
    expect(status).toBe(0);
    expect(verdict).toBe('SKIP_NOFILE');
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('fix-ruflo.sh Step 5j wiring (static)', () => {
  const src = fs.readFileSync(FIX_RUFLO, 'utf8');

  it('carries the KIT-ADOPTION-NOTE-V1 sentinel and invokes the tool', () => {
    expect(src).toContain('KIT-ADOPTION-NOTE-V1');
    expect(src).toContain('adoption-note.cjs');
    expect(src).toMatch(/\$KIT_DIR/); // resolved kit dir is passed through
  });

  it('handles every verdict token the tool can emit', () => {
    for (const tok of [
      'APPENDED', 'HEALED', 'UNCHANGED', 'SKIP_HANDWRITTEN',
      'SKIP_NOFILE', 'WOULD_APPEND', 'WOULD_HEAL',
    ]) {
      expect(src).toContain(tok);
    }
  });

  it('honest skip message for the hand-written case', () => {
    expect(src).toContain('hand-written kit note present — not duplicating');
  });

  it('fix-ruflo.sh stays bash -n clean', () => {
    const r = spawnSync('bash', ['-n', FIX_RUFLO], { encoding: 'utf8', timeout: 30000 });
    expect(r.status).toBe(0);
  });
});
