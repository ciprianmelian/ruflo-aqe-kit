/**
 * Tests for lib/fix-brain.sh (marker BRAIN-MCP-V1).
 *
 * fix-brain integrates ruvnet-brain as an MCP-ONLY server: it (1) locates the KB
 * (env/default) and only downloads the ~736MB bundle behind --download, (2) ensures
 * reader deps, (3) registers server "ruvnet-brain" in the target .mcp.json, and (4)
 * health-probes. The user decision is MCP-ONLY: NO hooks, NO launchd, NO plugin
 * install. These tests build throwaway fixtures and assert exactly that contract —
 * they never touch the network and never fetch a bundle.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const FIX_BRAIN = path.join(REPO, 'lib', 'fix-brain.sh');
const SERVER_MJS = path.join(REPO, 'vendor', 'ruvnet-brain', 'plugin', 'mcp', 'server.mjs');

// Run fix-brain.sh against <target> with a fixture KB (via RUVNET_BRAIN_KB) and
// return {code, out}. Never passes --download, so nothing is ever fetched.
function runFixBrain(target, { kbDir, dryRun = false, extraArgs = [] } = {}) {
  const args = [FIX_BRAIN, target, ...extraArgs];
  if (dryRun) args.push('--dry-run');
  const env = { ...process.env };
  if (kbDir) env.RUVNET_BRAIN_KB = kbDir;
  const r = spawnSync('bash', args, { encoding: 'utf8', env });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// A target codebase fixture: just enough for fix-brain to act on — a .mcp.json.
function mkTarget(withMcpJson = true) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fixbrain-tgt-'));
  if (withMcpJson) {
    fs.writeFileSync(path.join(d, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'agentic-qe': { command: 'aqe-mcp', args: [] } } }, null, 2) + '\n');
  }
  return d;
}

// A fully "installed" KB fixture — deliberately self-contained so tests NEVER shell
// out to npm or the network: (a) a forge-mcp-all.mjs that answers a real MCP
// `initialize` on stdin (so the health handshake resolves instantly), and (b) faked
// reader-dep dirs so Step 2 sees the reader as present and skips `npm install`.
function mkKb() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fixbrain-kb-'));
  fs.writeFileSync(path.join(d, 'forge-mcp-all.mjs'),
    "process.stdin.on('data', (buf) => {\n" +
    "  for (const line of buf.toString().split('\\n')) {\n" +
    "    if (!line.trim()) continue;\n" +
    "    try { const m = JSON.parse(line); if (m && m.method === 'initialize') {\n" +
    "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { serverInfo: { name: 'fixture' } } }) + '\\n');\n" +
    "    } } catch (_) { /* partial */ }\n" +
    "  }\n" +
    "});\n");
  fs.writeFileSync(path.join(d, 'package.json'),
    JSON.stringify({ name: 'ruvnet-brain-kb', type: 'module', dependencies: { '@ruvector/rvf': '0.2.3', '@xenova/transformers': '2.17.2' } }));
  // Faked reader deps: exactly what reader_ok() in fix-brain.sh checks for.
  fs.mkdirSync(path.join(d, 'node_modules', '@ruvector'), { recursive: true });
  fs.mkdirSync(path.join(d, 'node_modules', '@xenova', 'transformers'), { recursive: true });
  fs.writeFileSync(path.join(d, 'node_modules', '@xenova', 'transformers', 'package.json'), '{"name":"@xenova/transformers"}');
  return d;
}

function readMcp(target) {
  return JSON.parse(fs.readFileSync(path.join(target, '.mcp.json'), 'utf8'));
}

// Recursively assert no LaunchAgent/launchd plist and no Claude Code hooks file was created.
function assertNoHooksOrLaunchd(target) {
  const settings = path.join(target, '.claude', 'settings.json');
  expect(fs.existsSync(settings)).toBe(false); // fix-brain never writes hooks
  const plists = [];
  (function walk(dir) {
    for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.plist$/.test(e.name) || /LaunchAgents/.test(p)) plists.push(p);
    }
  })(target);
  expect(plists).toEqual([]);
}

describe('fix-brain: KB missing (no download)', () => {
  let target, kb;
  beforeEach(() => {
    target = mkTarget();
    kb = path.join(os.tmpdir(), `fixbrain-absent-${process.pid}-${Math.random().toString(36).slice(2)}`);
  });
  afterEach(() => fs.rmSync(target, { recursive: true, force: true }));

  it('reports MISSING and does NOT create/download the KB without --download', () => {
    const r = runFixBrain(target, { kbDir: kb });
    expect(r.out).toMatch(/KB MISSING/);
    expect(fs.existsSync(kb)).toBe(false); // nothing fetched, no dir created
  });

  it('still registers the MCP server even when the KB is absent (KB can be fetched later)', () => {
    runFixBrain(target, { kbDir: kb });
    const brain = readMcp(target).mcpServers['ruvnet-brain'];
    expect(brain.command).toBe('node');
    expect(brain.args[0]).toBe(SERVER_MJS);
    expect(brain.env.RUVNET_BRAIN_KB).toBe(kb);
  });

  it('never writes hooks or launchd jobs', () => {
    runFixBrain(target, { kbDir: kb });
    assertNoHooksOrLaunchd(target);
  });
});

describe('fix-brain: .mcp.json registration (idempotency)', () => {
  let target, kb;
  beforeEach(() => { target = mkTarget(); kb = mkKb(); });
  afterEach(() => {
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(kb, { recursive: true, force: true });
  });

  it('registers ruvnet-brain → node <server.mjs> with the pinned KB env', () => {
    const r = runFixBrain(target, { kbDir: kb });
    expect(r.out).toMatch(/ruvnet-brain MCP registered/);
    const brain = readMcp(target).mcpServers['ruvnet-brain'];
    expect(brain).toEqual({ command: 'node', args: [SERVER_MJS], env: { RUVNET_BRAIN_KB: kb } });
    // Pre-existing servers are preserved.
    expect(readMcp(target).mcpServers['agentic-qe']).toBeTruthy();
    // With a complete KB fixture, Step 2 sees the reader (no npm) and Step 4's
    // MCP initialize handshake resolves against the fixture server.
    expect(r.out).toMatch(/reader deps present/);
    expect(r.out).toMatch(/handshake answered/);
  });

  it('is idempotent: a second run reports already-registered and changes nothing', () => {
    runFixBrain(target, { kbDir: kb });
    const after1 = fs.readFileSync(path.join(target, '.mcp.json'), 'utf8');
    const r2 = runFixBrain(target, { kbDir: kb });
    expect(r2.out).toMatch(/already registered/);
    expect(fs.readFileSync(path.join(target, '.mcp.json'), 'utf8')).toBe(after1);
  });

  it('never writes hooks or launchd jobs (KB present path)', () => {
    runFixBrain(target, { kbDir: kb });
    assertNoHooksOrLaunchd(target);
  });
});

describe('fix-brain: dry-run writes nothing', () => {
  let target, kb;
  beforeEach(() => { target = mkTarget(); kb = mkKb(); });
  afterEach(() => {
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(kb, { recursive: true, force: true });
  });

  it('--dry-run leaves .mcp.json untouched and creates no backup', () => {
    const before = fs.readFileSync(path.join(target, '.mcp.json'), 'utf8');
    const r = runFixBrain(target, { kbDir: kb, dryRun: true });
    expect(r.out).toMatch(/\[dry-run\]/);
    expect(fs.readFileSync(path.join(target, '.mcp.json'), 'utf8')).toBe(before);
    expect(readMcp(target).mcpServers['ruvnet-brain']).toBeUndefined();
    expect(fs.existsSync(path.join(target, '.mcp.json.fixbrain-bak'))).toBe(false);
    assertNoHooksOrLaunchd(target);
  });
});

describe('fix-brain: missing .mcp.json', () => {
  it('warns and does not create a .mcp.json out of nowhere', () => {
    const target = mkTarget(false); // no .mcp.json
    const kb = mkKb();
    const r = runFixBrain(target, { kbDir: kb });
    expect(r.out).toMatch(/no \.mcp\.json/);
    expect(fs.existsSync(path.join(target, '.mcp.json'))).toBe(false);
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(kb, { recursive: true, force: true });
  });
});
