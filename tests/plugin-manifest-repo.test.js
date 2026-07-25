/**
 * Tests for tools/plugin-manifest-fix.cjs (PLUGIN-MANIFEST-REPO-V1, Patch 69).
 *
 * Defect class: the skills.sh-installed skill folder ships a plugin.json with
 * an npm-shaped `repository` OBJECT; Claude Code's plugin manifest schema
 * requires a STRING, so the whole skill folder refuses to load. The sweep
 * normalizes object→url across the known plugin roots, touches nothing else,
 * and self-retires (NOFILES / UNCHANGED) when there is nothing to fix.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOL = path.join(path.resolve(__dirname, '..'), 'tools', 'plugin-manifest-fix.cjs');

const NPM_SHAPE = {
  name: 'ruflo',
  author: { name: 'rUv', email: 'ruv@ruv.net' },
  homepage: 'https://github.com/ruvnet/claude-flow',
  repository: { type: 'git', url: 'https://github.com/ruvnet/claude-flow.git' },
  bugs: { url: 'https://github.com/ruvnet/claude-flow/issues' },
};

function mkTarget() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pmfix-'));
}
function writeManifest(target, root, skill, content) {
  const dir = path.join(target, root, skill, '.claude-plugin');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'plugin.json');
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  return p;
}
function run(target, extra = []) {
  const r = spawnSync('node', [TOOL, target, ...extra], { encoding: 'utf8', timeout: 10000 });
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  return { status: r.status, lines, verdict: lines[lines.length - 1] };
}

describe('plugin-manifest-fix.cjs (PLUGIN-MANIFEST-REPO-V1)', () => {
  test('npm-shaped repository object => rewritten to its url string, other fields untouched', () => {
    const t = mkTarget();
    const p = writeManifest(t, '.claude/skills', 'ruflo', NPM_SHAPE);
    const r = run(t);
    expect(r.status).toBe(0);
    expect(r.verdict).toBe('RESULT:FIXED:1');
    const after = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(after.repository).toBe('https://github.com/ruvnet/claude-flow.git');
    expect(after.author).toEqual(NPM_SHAPE.author); // author object is schema-legal — untouched
    expect(after.bugs).toEqual(NPM_SHAPE.bugs);
  });

  test('already-string repository => bit-identical file, RESULT:UNCHANGED', () => {
    const t = mkTarget();
    const p = writeManifest(t, '.claude/skills', 'ruflo', { ...NPM_SHAPE, repository: 'https://x.git' });
    const before = fs.readFileSync(p, 'utf8');
    const r = run(t);
    expect(r.verdict).toBe('RESULT:UNCHANGED');
    expect(fs.readFileSync(p, 'utf8')).toBe(before);
  });

  test('no plugin roots at all => RESULT:NOFILES, exit 0 (transient folder is normal)', () => {
    const r = run(mkTarget());
    expect(r.status).toBe(0);
    expect(r.verdict).toBe('RESULT:NOFILES');
  });

  test('--dry-run reports WOULD_FIX and leaves the file untouched', () => {
    const t = mkTarget();
    const p = writeManifest(t, '.claude/skills', 'ruflo', NPM_SHAPE);
    const before = fs.readFileSync(p, 'utf8');
    const r = run(t, ['--dry-run']);
    expect(r.verdict).toBe('RESULT:WOULD_FIX:1');
    expect(r.lines).toContain('WOULD_FIX:' + path.join('.claude', 'skills', 'ruflo', '.claude-plugin', 'plugin.json'));
    expect(fs.readFileSync(p, 'utf8')).toBe(before);
  });

  test('malformed JSON => SKIP_BAD, file untouched, exit 0', () => {
    const t = mkTarget();
    const p = writeManifest(t, '.claude/skills', 'broken', '{ not json');
    const r = run(t);
    expect(r.status).toBe(0);
    expect(r.lines.some((l) => l.startsWith('SKIP_BAD:'))).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).toBe('{ not json');
  });

  test('object repository without url => SKIP_NOURL, never invents a value', () => {
    const t = mkTarget();
    const p = writeManifest(t, '.claude/skills', 'nourl', { ...NPM_SHAPE, repository: { type: 'git' } });
    const r = run(t);
    expect(r.lines.some((l) => l.startsWith('SKIP_NOURL:'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(p, 'utf8')).repository).toEqual({ type: 'git' });
  });

  test('sweeps all four roots and counts each fix', () => {
    const t = mkTarget();
    writeManifest(t, '.claude/skills', 'a', NPM_SHAPE);
    writeManifest(t, '.agents/skills', 'b', NPM_SHAPE);
    writeManifest(t, 'plugins', 'c', NPM_SHAPE);
    writeManifest(t, 'v3/plugins', 'd', NPM_SHAPE);
    expect(run(t).verdict).toBe('RESULT:FIXED:4');
    // Second run: everything already normalized — idempotent.
    expect(run(t).verdict).toBe('RESULT:UNCHANGED');
  });

  test('missing/bad target dir => RESULT:BADTARGET, exit 2', () => {
    const r = spawnSync('node', [TOOL, '/nonexistent-pmfix-target'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/RESULT:BADTARGET/);
  });
});
