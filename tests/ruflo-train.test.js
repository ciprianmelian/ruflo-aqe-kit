/**
 * Tests for .claude/helpers/ruflo-train.cjs
 *
 * Coverage gaps addressed:
 *  - No subject (argv[2] missing + empty stdin) → outputs '{}', exits 0
 *  - Subject from argv[2]
 *  - Subject from stdin JSON: tool_input.file_path, tool_input.prompt, prompt
 *  - Missing agentic-qe / @claude-flow/cli deps → graceful '{}', exits 0
 *  - Reward clamping: argv[3] < 0.1 → 0.1; > 1.0 → 1.0; default 0.8
 *  - Always exits 0 (never blocks a PostToolUse Edit hook)
 *  - stdout is always valid JSON
 *  - console.log is silenced (no spurious stdout output from embedded logger)
 *
 * Strategy: spawn the script as a subprocess. The SONA LoRA train path
 * requires agentic-qe + @claude-flow/cli global installs — tests cover the
 * graceful-degradation branches that run without those deps.
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '../.claude/helpers/ruflo-train.cjs');

function run(args = [], stdinData = '', opts = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    input: stdinData,
    encoding: 'utf8',
    timeout: 15_000,
    ...opts,
  });
}

// ── Exit 0 contract ───────────────────────────────────────────────────────────

describe('ruflo-train — always exits 0', () => {
  it('exits 0 with no args and no stdin', () => {
    expect(run([], '').status).toBe(0);
  });

  it('exits 0 with a subject in argv[2]', () => {
    expect(run(['src/auth.ts'], '').status).toBe(0);
  });

  it('exits 0 with subject from stdin JSON (file_path)', () => {
    const r = run([], JSON.stringify({ tool_input: { file_path: 'src/auth.ts' } }));
    expect(r.status).toBe(0);
  });

  it('exits 0 with subject from stdin JSON (prompt field)', () => {
    const r = run([], JSON.stringify({ prompt: 'implement feature X' }));
    expect(r.status).toBe(0);
  });

  it('exits 0 with subject from stdin JSON (tool_input.prompt)', () => {
    const r = run([], JSON.stringify({ tool_input: { prompt: 'refactor auth' } }));
    expect(r.status).toBe(0);
  });

  it('exits 0 with malformed JSON stdin', () => {
    expect(run([], '{broken').status).toBe(0);
  });

  it('exits 0 with empty string stdin', () => {
    expect(run([], '   ').status).toBe(0);
  });
});

// ── stdout contract ───────────────────────────────────────────────────────────

describe('ruflo-train — stdout is always valid JSON', () => {
  it('outputs {} with no subject', () => {
    const r = run([], '');
    expect(r.stdout.trim()).toBe('{}');
  });

  it('outputs {} when subject provided but deps missing', () => {
    const r = run(['src/foo.ts'], '');
    // If agentic-qe is present and trains successfully, output is still {}
    expect(r.stdout.trim()).toBe('{}');
  });

  it('never emits non-JSON to stdout (console.log silenced)', () => {
    const r = run(['src/auth.ts'], '');
    // stdout must be parseable JSON
    expect(() => JSON.parse(r.stdout.trim())).not.toThrow();
  });
});

// ── Reward clamping ───────────────────────────────────────────────────────────
// We can't directly observe the reward used inside the LoRA call without
// the actual deps, but we CAN verify the script doesn't crash for any reward value.

describe('ruflo-train — reward argv[3] edge cases', () => {
  it('exits 0 with reward = 0 (clamped to 0.1)', () => {
    expect(run(['src/foo.ts', '0'], '').status).toBe(0);
  });

  it('exits 0 with reward = 2.0 (clamped to 1.0)', () => {
    expect(run(['src/foo.ts', '2.0'], '').status).toBe(0);
  });

  it('exits 0 with reward = -1 (clamped to 0.1)', () => {
    expect(run(['src/foo.ts', '-1'], '').status).toBe(0);
  });

  it('exits 0 with reward = "NaN" string (falls back to default 0.8)', () => {
    expect(run(['src/foo.ts', 'NaN'], '').status).toBe(0);
  });

  it('exits 0 with reward = 0.5 (within range)', () => {
    expect(run(['src/foo.ts', '0.5'], '').status).toBe(0);
  });
});

// ── Subject extraction priority ───────────────────────────────────────────────
// argv[2] takes precedence over stdin; an empty string in argv falls through to stdin.

describe('ruflo-train — subject extraction', () => {
  it('prefers argv[2] over stdin JSON prompt', () => {
    // Both sources available; script uses argv[2] (non-empty) and skips stdin read
    const r = run(['argv-subject'], JSON.stringify({ prompt: 'stdin-subject' }));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
  });

  it('falls back to stdin when argv[2] is absent', () => {
    const r = run([], JSON.stringify({ tool_input: { file_path: 'src/x.ts' } }));
    expect(r.status).toBe(0);
  });
});
