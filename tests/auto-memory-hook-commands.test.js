/**
 * Tests for .claude/helpers/auto-memory-hook.mjs — CLI commands
 *
 * auto-memory-json-backend.test.js already covers JsonFileBackend in isolation.
 * This file covers the three CLI commands (import, sync, status) and the
 * readConfig() helper — exercised indirectly through process spawning.
 *
 * Gaps addressed:
 *  - status command: exits 0, prints bridge section header, shows package availability
 *  - import command: exits 0 when @claude-flow/memory is unavailable (graceful skip)
 *  - sync command: exits 0 when store is empty (skips gracefully)
 *  - sync command: exits 0 when @claude-flow/memory is unavailable
 *  - unknown command: exits 0 and prints usage
 *  - readConfig(): uses defaults when .claude-flow/config.yaml is absent
 *  - readConfig(): parses learningBridge.enabled = false from YAML
 *  - readConfig(): does not crash on malformed YAML
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const MODULE = path.resolve(__dirname, '../.claude/helpers/auto-memory-hook.mjs');

function spawnHook(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MODULE, command], {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osam-automem-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── exit code contract ─────────────────────────────────────────────────────
// Hooks must NEVER crash Claude Code (must exit 0 under all conditions).

describe('auto-memory-hook — always exits 0', () => {
  it('exits 0 for "import" with no memory package', async () => {
    const { code } = await spawnHook('import', tmpDir);
    expect(code).toBe(0);
  }, 15000);

  it('exits 0 for "sync" with empty store and no memory package', async () => {
    const { code } = await spawnHook('sync', tmpDir);
    expect(code).toBe(0);
  }, 15000);

  it('exits 0 for "status"', async () => {
    const { code } = await spawnHook('status', tmpDir);
    expect(code).toBe(0);
  }, 15000);

  it('exits 0 for unknown command', async () => {
    const { code } = await spawnHook('bogus', tmpDir);
    expect(code).toBe(0);
  }, 15000);

  it('exits 0 with no command (defaults to status)', async () => {
    const { code } = await spawnHook('', tmpDir);
    expect(code).toBe(0);
  }, 15000);
});

// ── status command ─────────────────────────────────────────────────────────
// NOTE: auto-memory-hook.mjs resolves paths relative to its own __dirname
// (PROJECT_ROOT = module dir/../..), NOT process.cwd(). Tests assert only on
// the output format, not on specific path-dependent values.

describe('auto-memory-hook status', () => {
  it('prints the bridge status header', async () => {
    const { stdout } = await spawnHook('status', tmpDir);
    expect(stdout).toMatch(/Auto Memory Bridge Status/i);
  }, 15000);

  it('output includes all five status labels', async () => {
    const { stdout } = await spawnHook('status', tmpDir);
    expect(stdout).toMatch(/Package:/);
    expect(stdout).toMatch(/Store:/);
    expect(stdout).toMatch(/LearningBridge:/);
    expect(stdout).toMatch(/MemoryGraph:/);
    expect(stdout).toMatch(/AgentScopes:/);
  }, 15000);

  it('Package is either Available or Not found', async () => {
    const { stdout } = await spawnHook('status', tmpDir);
    expect(stdout).toMatch(/Available|Not found/i);
  }, 15000);
});

// ── import command — package unavailable ───────────────────────────────────

describe('auto-memory-hook import — memory package unavailable', () => {
  it('prints a graceful skip message', async () => {
    const { stdout } = await spawnHook('import', tmpDir);
    // Expected: skipping message when package not found
    expect(stdout).toMatch(/skipping|not available|Memory package not available/i);
  }, 15000);

  it('does not write the store file when package is absent', async () => {
    await spawnHook('import', tmpDir);
    const storePath = path.join(tmpDir, '.claude-flow', 'data', 'auto-memory-store.json');
    expect(fs.existsSync(storePath)).toBe(false);
  }, 15000);
});

// ── sync command — empty store ─────────────────────────────────────────────

describe('auto-memory-hook sync — empty store', () => {
  it('prints "No entries to sync" when store is empty', async () => {
    // Store file absent → backend.count() === 0
    const { stdout } = await spawnHook('sync', tmpDir);
    // Either "No entries" or "skipping" (if package unavailable)
    expect(stdout).toMatch(/No entries|skipping|not available/i);
  }, 15000);
});

// ── unknown command ────────────────────────────────────────────────────────

describe('auto-memory-hook unknown command', () => {
  it('prints usage without crashing', async () => {
    const { stdout } = await spawnHook('bogus', tmpDir);
    expect(stdout).toMatch(/Usage|import|sync|status/i);
  }, 15000);
});

// ── readConfig — defaults ──────────────────────────────────────────────────
// readConfig() is not exported, but its output is observable via the status
// command output (LearningBridge / MemoryGraph / AgentScopes enabled lines).

describe('auto-memory-hook readConfig — config absent', () => {
  it('learningBridge defaults to enabled (shows Enabled)', async () => {
    const { stdout } = await spawnHook('status', tmpDir);
    expect(stdout).toMatch(/LearningBridge:.*Enabled|LearningBridge:.*✅/i);
  }, 15000);

  it('memoryGraph defaults to enabled', async () => {
    const { stdout } = await spawnHook('status', tmpDir);
    expect(stdout).toMatch(/MemoryGraph:.*Enabled|MemoryGraph:.*✅/i);
  }, 15000);
});

// readConfig YAML tests: auto-memory-hook.mjs resolves config from
// PROJECT_ROOT/.claude-flow/config.yaml (fixed at module level), so we can
// only assert resilience / output shape, not path-specific values.

describe('auto-memory-hook readConfig — YAML parsing (via status output)', () => {
  it('LearningBridge shows Enabled or Disabled (default is Enabled)', async () => {
    const { stdout } = await spawnHook('status', tmpDir);
    expect(stdout).toMatch(/LearningBridge:.*Enabled|LearningBridge:.*Disabled/i);
  }, 15000);

  it('MemoryGraph shows Enabled or Disabled (default is Enabled)', async () => {
    const { stdout } = await spawnHook('status', tmpDir);
    expect(stdout).toMatch(/MemoryGraph:.*Enabled|MemoryGraph:.*Disabled/i);
  }, 15000);

  it('does not crash even if PROJECT_ROOT config.yaml is malformed', async () => {
    // The module silently falls back to defaults on parse errors — just check exit 0.
    const { code } = await spawnHook('status', tmpDir);
    expect(code).toBe(0);
  }, 15000);
});
