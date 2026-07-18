/**
 * Tests for fix-brain.sh Step 1.5 — KB freshness (BRAIN-KB-REFRESH-V1).
 *
 * Step 1.5 compares the installed KB's package.json version against the newest
 * GitHub Release tag. It is network-gated (6s) and NON-fatal: offline/API failure
 * reads as UNKNOWN, a missing KB as "not applicable", and staleness never fails
 * the script. The test/offline override KIT_TEST_BRAIN_LATEST short-circuits the
 * network call so these tests NEVER hit GitHub; the one offline case shims `curl`.
 *
 * All KB fixtures are throwaway and RUVNET_BRAIN_KB is always overridden, so the
 * real ~/.cache/ruvnet-brain KB is never read or touched.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const FIX_BRAIN = path.join(REPO, 'lib', 'fix-brain.sh');

// Run fix-brain.sh against <target>. `latest` sets KIT_TEST_BRAIN_LATEST (the
// offline freshness override); `unsetLatest` forces it absent (the true-offline
// case, paired with a curl shim via `pathPrepend`). Never passes --download.
function runBrain(target, { kbDir, latest, unsetLatest = false, dryRun = false, extraArgs = [], pathPrepend } = {}) {
  const args = [FIX_BRAIN, target, ...extraArgs];
  if (dryRun) args.push('--dry-run');
  const env = { ...process.env };
  if (kbDir) env.RUVNET_BRAIN_KB = kbDir;
  if (latest !== undefined) env.KIT_TEST_BRAIN_LATEST = latest;
  if (unsetLatest) delete env.KIT_TEST_BRAIN_LATEST;
  if (pathPrepend) env.PATH = `${pathPrepend}:${env.PATH}`;
  const r = spawnSync('bash', args, { encoding: 'utf8', env });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// Minimal valid target: just a .mcp.json so registration has something to act on.
function mkTarget() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'brainstale-tgt-'));
  fs.writeFileSync(path.join(d, '.mcp.json'), '{}\n');
  return d;
}

// A self-contained KB fixture: a forge-mcp-all.mjs that answers a real MCP
// `initialize` (so Step 4's handshake resolves instantly instead of blocking 6s
// on the soft probe timeout), a package.json with the given version, and faked
// reader-dep dirs so Step 2 sees the reader as present and never shells out to npm
// (keeps every test offline). withPkg:false omits package.json (the unreadable case).
function mkKb(version = '3.1.0', { withPkg = true } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'brainstale-kb-'));
  fs.writeFileSync(path.join(d, 'forge-mcp-all.mjs'),
    "process.stdin.on('data', (buf) => {\n" +
    "  for (const line of buf.toString().split('\\n')) {\n" +
    "    if (!line.trim()) continue;\n" +
    "    try { const m = JSON.parse(line); if (m && m.method === 'initialize') {\n" +
    "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { serverInfo: { name: 'fixture' } } }) + '\\n');\n" +
    "    } } catch (_) { /* partial */ }\n" +
    "  }\n" +
    "});\n");
  if (withPkg) {
    fs.writeFileSync(path.join(d, 'package.json'),
      JSON.stringify({ name: 'ruvnet-brain-kb', version, type: 'module' }));
  }
  fs.mkdirSync(path.join(d, 'node_modules', '@ruvector'), { recursive: true });
  fs.mkdirSync(path.join(d, 'node_modules', '@xenova', 'transformers'), { recursive: true });
  fs.writeFileSync(path.join(d, 'node_modules', '@xenova', 'transformers', 'package.json'), '{"name":"@xenova/transformers"}');
  return d;
}

describe('fix-brain Step 1.5: KB freshness', () => {
  const trash = [];
  const track = (...ds) => { trash.push(...ds); return ds[ds.length - 1]; };
  afterEach(() => { while (trash.length) fs.rmSync(trash.pop(), { recursive: true, force: true }); });

  it('reports STALE with a --refresh hint when a newer release exists', () => {
    const target = track(mkTarget());
    const kb = track(mkKb('3.1.0'));
    const r = runBrain(target, { kbDir: kb, latest: '3.3.1' });
    expect(r.out).toMatch(/STALE/);
    expect(r.out).toMatch(/--refresh/);
  });

  it('does not fail the script on staleness (exit code matches the current-KB baseline)', () => {
    const baseTarget = track(mkTarget());
    const baseKb = track(mkKb('3.1.0'));
    const baseline = runBrain(baseTarget, { kbDir: baseKb, latest: '3.1.0' }); // current

    const target = track(mkTarget());
    const kb = track(mkKb('3.1.0'));
    const stale = runBrain(target, { kbDir: kb, latest: '3.3.1' }); // stale

    expect(stale.out).toMatch(/STALE/);
    expect(stale.code).toBe(baseline.code);
  });

  it('reports current when the installed version equals the latest release', () => {
    const target = track(mkTarget());
    const kb = track(mkKb('3.1.0'));
    const r = runBrain(target, { kbDir: kb, latest: '3.1.0' });
    expect(r.out).toMatch(/is current/);
  });

  it('strips a leading "v" from the release tag (v3.3.1 still reads as newer)', () => {
    const target = track(mkTarget());
    const kb = track(mkKb('3.1.0'));
    const r = runBrain(target, { kbDir: kb, latest: 'v3.3.1' });
    expect(r.out).toMatch(/STALE/);
  });

  it('offline (curl fails, no override) → freshness UNKNOWN, never fatal', () => {
    const target = track(mkTarget());
    const kb = track(mkKb('3.1.0'));
    const binDir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'brainstale-bin-')));
    fs.writeFileSync(path.join(binDir, 'curl'), '#!/bin/sh\nexit 6\n', { mode: 0o755 });
    const r = runBrain(target, { kbDir: kb, unsetLatest: true, pathPrepend: binDir });
    expect(r.out).toMatch(/freshness UNKNOWN/);
  });

  it('no KB present → freshness not applicable', () => {
    const target = track(mkTarget());
    const emptyKb = track(fs.mkdtempSync(path.join(os.tmpdir(), 'brainstale-empty-')));
    const r = runBrain(target, { kbDir: emptyKb, latest: '3.3.1' });
    expect(r.out).toMatch(/freshness not applicable/);
  });

  it('--refresh --dry-run with KB present → dry-run download plan, KB untouched', () => {
    const target = track(mkTarget());
    const kb = track(mkKb('3.1.0'));
    const pkg = path.join(kb, 'package.json');
    const before = { body: fs.readFileSync(pkg, 'utf8'), mtime: fs.statSync(pkg).mtimeMs };

    const r = runBrain(target, { kbDir: kb, latest: '3.1.0', dryRun: true, extraArgs: ['--refresh'] });
    expect(r.out).toMatch(/\[dry-run\]/);
    expect(r.out).toMatch(/would download/);
    expect(r.out).toMatch(/replaced in place|--refresh/);

    const after = { body: fs.readFileSync(pkg, 'utf8'), mtime: fs.statSync(pkg).mtimeMs };
    expect(after.body).toBe(before.body);
    expect(after.mtime).toBe(before.mtime);
  });

  it('KB present but package.json unreadable → freshness unknown, no crash', () => {
    const target = track(mkTarget());
    const kb = track(mkKb('3.1.0', { withPkg: false }));
    const r = runBrain(target, { kbDir: kb, latest: '3.3.1' });
    expect(r.out).toMatch(/freshness unknown/i);
  });
});
