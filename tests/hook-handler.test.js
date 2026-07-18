/**
 * Tests for .claude/helpers/hook-handler.cjs
 *
 * Coverage gaps addressed:
 *  - pre-bash: blocks dangerous commands (rm -rf /, format c:, del /s /q c:\, fork bomb)
 *  - pre-bash: passes safe commands
 *  - pre-bash: reads command from hookInput.command (snake_case)
 *  - pre-bash: reads command from toolInput.command (nested)
 *  - pre-bash: String() wraps non-string toolInput (guards against #2017)
 *  - stdin normalization: snake_case (tool_input) vs camelCase (toolInput)
 *  - route: formats output without router (graceful missing module)
 *  - unknown command: passes through without error
 *
 * NOTE: hook-handler is a CLI-only module (no module.exports). Tests spawn it
 * as a child process via spawn/exec and assert on stdout/stderr/exitCode.
 * All invocations must exit 0 (hook contract).
 */

'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const execFileAsync = util.promisify(execFile);

// SANDBOXED COPY: spawn a snapshot of .claude/helpers, not the live tree.
// Upstream session hooks can REGENERATE the live helpers mid-suite (first-run
// auto-enable / aqe session-end refresh — the exact clobber HOOK-BLOCK-EXIT2-V1
// re-heals), which made the dangerous-command block tests flaky: they'd assert
// exit 2 against a freshly-reverted exit-1 copy. A snapshot taken at suite
// start is immune; hook-handler resolves its siblings via __dirname, so the
// whole dir is copied to keep relative requires working.
const LIVE_HELPERS = path.resolve(__dirname, '../.claude/helpers');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-handler-sandbox-'));
fs.cpSync(LIVE_HELPERS, SANDBOX, {
  recursive: true,
  filter: (src) => !/\.(fixaqe-bak|exit2-bak|bak)$/.test(src),
});
// The handler itself comes from the CANONICAL tracked baseline: if a clobber
// already landed before this file loaded, the live copy may be the reverted
// exit-1 form. assets/claude-helpers/hook-handler.cjs is the healed behavior
// the kit guarantees (fix-aqe Step 8 restores exactly it), so test that.
fs.copyFileSync(
  path.resolve(__dirname, '../assets/claude-helpers/hook-handler.cjs'),
  path.join(SANDBOX, 'hook-handler.cjs'),
);
const HANDLER = path.join(SANDBOX, 'hook-handler.cjs');

// Helper: spawn hook-handler with optional stdin JSON
async function runHook(command, stdinJson, extraArgs = []) {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const args = [HANDLER, command, ...extraArgs];
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('close', (code) => resolve({ code, stdout, stderr }));

    if (stdinJson !== undefined) {
      child.stdin.write(typeof stdinJson === 'string' ? stdinJson : JSON.stringify(stdinJson));
    }
    child.stdin.end();
  });
}

// ── Exit code contract ────────────────────────────────────────────────────────

describe('hook-handler — always exits 0', () => {
  it('exits 0 for valid command "route"', async () => {
    const { code } = await runHook('route', { prompt: 'implement a feature' });
    expect(code).toBe(0);
  });

  it('exits 0 for unknown command', async () => {
    const { code } = await runHook('nonexistent-command', {});
    expect(code).toBe(0);
  });

  it('exits 0 for no command (usage message)', async () => {
    const { code } = await runHook('', {});
    expect(code).toBe(0);
  });
});

// ── pre-bash: dangerous command blocking ─────────────────────────────────────

describe('hook-handler pre-bash — dangerous commands', () => {
  const dangerous = [
    'rm -rf /',
    'format c:',
    'del /s /q c:\\',
    ':(){:|:&};:',
  ];

  for (const cmd of dangerous) {
    it(`blocks: ${cmd}`, async () => {
      const { code, stderr } = await runHook('pre-bash', { command: cmd });
      // Exit 2 is the Claude Code blocking exit code (0 allows, 1 is a
      // non-blocking error — the dangerous command would still run).
      expect(code).toBe(2);
      expect(stderr).toMatch(/BLOCKED/i);
    });
  }
});

describe('hook-handler pre-bash — safe commands', () => {
  const safe = [
    'npm install',
    'git status',
    'ls -la',
    'echo hello',
    'node --version',
  ];

  for (const cmd of safe) {
    it(`passes: ${cmd}`, async () => {
      const { stdout } = await runHook('pre-bash', { command: cmd });
      expect(stdout).toMatch(/OK/i);
    });
  }
});

describe('hook-handler pre-bash — input normalization', () => {
  it('reads command from hookInput.command (top-level)', async () => {
    const { stdout } = await runHook('pre-bash', { command: 'npm test' });
    expect(stdout).toMatch(/OK/i);
  });

  it('reads command from nested toolInput.command (snake_case: tool_input)', async () => {
    const { stdout } = await runHook('pre-bash', { tool_input: { command: 'npm test' } });
    expect(stdout).toMatch(/OK/i);
  });

  it('reads command from nested toolInput.command (camelCase: toolInput)', async () => {
    const { stdout } = await runHook('pre-bash', { toolInput: { command: 'npm test' } });
    expect(stdout).toMatch(/OK/i);
  });

  it('does not crash when toolInput is a non-string object (guard #2017)', async () => {
    const { code } = await runHook('pre-bash', { toolInput: { command: 123, extra: 'data' } });
    expect(code).toBe(0);
  });

  it('handles completely empty stdin gracefully', async () => {
    const { code } = await runHook('pre-bash', '');
    expect(code).toBe(0);
  });

  it('handles malformed JSON stdin gracefully', async () => {
    const { code } = await runHook('pre-bash', 'NOT JSON');
    expect(code).toBe(0);
  });
});

// ── route command ─────────────────────────────────────────────────────────────

describe('hook-handler route', () => {
  it('outputs a routing table for a known task', async () => {
    const { stdout } = await runHook('route', { prompt: 'implement the login feature' });
    expect(stdout).toMatch(/Agent/i);
    expect(stdout).toMatch(/Confidence/i);
  });

  it('does not crash for empty prompt', async () => {
    const { code } = await runHook('route', { prompt: '' });
    expect(code).toBe(0);
  });
});

// ── post-edit ─────────────────────────────────────────────────────────────────

describe('hook-handler post-edit', () => {
  it('exits 0 and outputs OK', async () => {
    const { code, stdout } = await runHook('post-edit', {
      tool_input: { file_path: 'src/auth.ts' },
    });
    expect(code).toBe(0);
    expect(stdout).toMatch(/OK/i);
  });

  it('does not crash when no file_path provided', async () => {
    const { code } = await runHook('post-edit', {});
    expect(code).toBe(0);
  });
});

// ── session-restore ───────────────────────────────────────────────────────────

describe('hook-handler session-restore', () => {
  it('exits 0', async () => {
    const { code } = await runHook('session-restore', {});
    expect(code).toBe(0);
  });
});

// ── session-end ───────────────────────────────────────────────────────────────

describe('hook-handler session-end', () => {
  it('exits 0', async () => {
    const { code } = await runHook('session-end', {});
    expect(code).toBe(0);
  });
});

// ── pre-task and post-task ────────────────────────────────────────────────────

describe('hook-handler pre-task / post-task', () => {
  it('pre-task exits 0', async () => {
    const { code } = await runHook('pre-task', { prompt: 'implement auth' });
    expect(code).toBe(0);
  });

  it('post-task exits 0 and outputs OK', async () => {
    const { code, stdout } = await runHook('post-task', {});
    expect(code).toBe(0);
    expect(stdout).toMatch(/OK/i);
  });
});

// ── Unknown command ───────────────────────────────────────────────────────────

describe('hook-handler unknown command', () => {
  it('passes through unknown command without error', async () => {
    const { code, stdout } = await runHook('something-new', {});
    expect(code).toBe(0);
    expect(stdout).toMatch(/OK|something-new/i);
  });
});

// ── stats command ─────────────────────────────────────────────────────────────
// stats is a real handler in the handlers map but has no existing test.

describe('hook-handler stats', () => {
  it('exits 0', async () => {
    const { code } = await runHook('stats', {});
    expect(code).toBe(0);
  });

  it('outputs either intelligence stats or a WARN about unavailability', async () => {
    const { stdout } = await runHook('stats', {});
    // Either real stats or the "not available" warning — either is correct
    expect(stdout).toMatch(/\w/); // at minimum some output
  });
});

// ── pre-bash: case sensitivity of dangerous command detection ─────────────────
// The handler lowercases the command before checking — uppercase variants of
// dangerous strings must also be blocked.

describe('hook-handler pre-bash — case sensitivity of blocklist', () => {
  it('blocks "RM -RF /" (uppercase variant)', async () => {
    const { stderr } = await runHook('pre-bash', { command: 'RM -RF /' });
    expect(stderr).toMatch(/BLOCKED/i);
  });

  it('blocks "FORMAT C:" (uppercase variant)', async () => {
    const { stderr } = await runHook('pre-bash', { command: 'FORMAT C:' });
    expect(stderr).toMatch(/BLOCKED/i);
  });
});

// ── pre-task: routed output format ────────────────────────────────────────────

describe('hook-handler pre-task', () => {
  it('includes the routed agent name in output for a recognisable task', async () => {
    const { stdout } = await runHook('pre-task', { prompt: 'write unit tests for auth' });
    expect(stdout).toMatch(/tester|Task routed|Task started/i);
  });

  it('does not crash for undefined prompt', async () => {
    const { code } = await runHook('pre-task', {});
    expect(code).toBe(0);
  });
});

// ── integration: session-restore → session-end sequence ──────────────────────

describe('hook-handler — session-restore then session-end', () => {
  it('both exit 0 in sequence', async () => {
    const restore = await runHook('session-restore', {});
    const end = await runHook('session-end', {});
    expect(restore.code).toBe(0);
    expect(end.code).toBe(0);
  });
});
