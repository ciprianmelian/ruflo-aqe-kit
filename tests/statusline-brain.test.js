/**
 * Tests for the 🧿 Ruflo Brain statusline row (BRAIN-STATUSLINE-V1).
 *
 * The row must:
 *  - stay HIDDEN when the target has no ruvnet-brain registration and no KB
 *  - render repo count / size / MCP / reader chips from a fixture KB
 *  - honor the RUVNET_BRAIN_KB env override (test isolation depends on it)
 *  - report KB missing (with the fix-brain hint) when registered but not cached
 *
 * Strategy: statusline.cjs auto-renders on execution, so tests spawn the
 * TRACKED ASSET (assets/statusline.cjs — the canonical copy fix-statusbar
 * ships) with cwd = a throwaway fixture project and RUVNET_BRAIN_KB pointed
 * into the fixture. HOME is also sandboxed so the default KB path cannot leak
 * to the real ~/.cache. stdin gets a minimal claude-code payload.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ASSET = path.resolve(__dirname, '../assets/statusline.cjs');

function runStatusline(cwd, env = {}) {
  return spawnSync(process.execPath, [ASSET], {
    cwd,
    input: JSON.stringify({ model: { display_name: 'Test' }, workspace: { current_dir: cwd } }),
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, HOME: cwd, ...env },
  });
}

function mkFixture({ registered = false, kb = false, reader = false } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'osam-brainrow-'));
  if (registered) {
    fs.writeFileSync(path.join(d, '.mcp.json'), JSON.stringify({
      mcpServers: { 'ruvnet-brain': { command: 'node', args: ['server.mjs'] } },
    }));
  }
  const kbDir = path.join(d, 'kb');
  if (kb) {
    fs.mkdirSync(kbDir, { recursive: true });
    fs.writeFileSync(path.join(kbDir, 'forge-mcp-all.mjs'), '// fixture server\n');
    // two repos, three rvf files (repo count must dedupe big/small variants)
    fs.writeFileSync(path.join(kbDir, 'alpha.big.rvf'), Buffer.alloc(2048));
    fs.writeFileSync(path.join(kbDir, 'alpha.small.rvf'), Buffer.alloc(1024));
    fs.writeFileSync(path.join(kbDir, 'beta.big.rvf'), Buffer.alloc(4096));
    fs.writeFileSync(path.join(kbDir, 'alpha.big.passages.jsonl'), Buffer.alloc(1024));
    if (reader) {
      const tf = path.join(kbDir, 'node_modules', '@xenova', 'transformers');
      fs.mkdirSync(tf, { recursive: true });
      fs.writeFileSync(path.join(tf, 'package.json'), '{"name":"@xenova/transformers"}');
    }
  }
  return { d, kbDir };
}

describe('Ruflo Brain statusline row (BRAIN-STATUSLINE-V1)', () => {
  let fixtures = [];
  afterEach(() => {
    for (const f of fixtures) fs.rmSync(f, { recursive: true, force: true });
    fixtures = [];
  });

  it('stays hidden when neither registered nor KB present', () => {
    const { d, kbDir } = mkFixture();
    fixtures.push(d);
    const r = runStatusline(d, { RUVNET_BRAIN_KB: kbDir });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/Ruflo Brain/);
  }, 40000);

  it('renders repo count, MCP and reader chips from a fixture KB', () => {
    const { d, kbDir } = mkFixture({ registered: true, kb: true, reader: true });
    fixtures.push(d);
    const r = runStatusline(d, { RUVNET_BRAIN_KB: kbDir });
    expect(r.status).toBe(0);
    const out = r.stdout;
    expect(out).toMatch(/Ruflo Brain/);
    expect(out).toMatch(/●2 repos/);          // alpha + beta, variants deduped
    expect(out).toMatch(/registered/);
    expect(out).toMatch(/Reader.*●ok/);
  }, 40000);

  it('reports KB missing with the fix-brain hint when registered but not cached', () => {
    const { d, kbDir } = mkFixture({ registered: true, kb: false });
    fixtures.push(d);
    const r = runStatusline(d, { RUVNET_BRAIN_KB: kbDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Ruflo Brain/);
    expect(r.stdout).toMatch(/missing/);
    expect(r.stdout).toMatch(/fix-brain --download/);
  }, 40000);

  it('flags reader deps missing when KB present without node_modules', () => {
    const { d, kbDir } = mkFixture({ registered: true, kb: true, reader: false });
    fixtures.push(d);
    const r = runStatusline(d, { RUVNET_BRAIN_KB: kbDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Reader.*●missing/);
  }, 40000);
});
