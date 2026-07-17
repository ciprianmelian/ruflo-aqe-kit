/**
 * CLI-mode tests for .claude/helpers/_derive-outcome.cjs
 *
 * Coverage gaps addressed:
 *  - --selftest flag: internal oracle self-test exits 0 (all 11 assertions pass)
 *  - Override mode: bare number argv[0] → basis:'override', reward clamped
 *  - Override clamping: values outside [0.05, 0.95] are clamped before output
 *  - Fallback mode: no stdin, no readable transcript → basis:'fallback', reward:0.7
 *  - File-based transcript: argv[0]=path → reads file, outputs valid JSON
 *
 * None of these paths are reachable through the exported API since they only
 * run when the module is invoked as require.main === module.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '../.claude/helpers/_derive-outcome.cjs');

function run(args = [], opts = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 8_000,
    input: opts.stdin,
    stdio: opts.stdin !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    ...opts.spawnOpts,
  });
}

function parseOutput(r) {
  return JSON.parse(r.stdout.trim());
}

// ── --selftest ────────────────────────────────────────────────────────────────

describe('_derive-outcome.cjs --selftest', () => {
  it('exits 0 (all internal assertions pass)', () => {
    const r = run(['--selftest']);
    expect(r.status).toBe(0);
  });

  it('prints "ALL PASS" to stdout', () => {
    const r = run(['--selftest']);
    expect(r.stdout).toMatch(/ALL PASS/);
  });

  it('prints DERIVE-OUTCOME-V2 header', () => {
    const r = run(['--selftest']);
    expect(r.stdout).toMatch(/DERIVE-OUTCOME-V2/);
  });
});

// ── Override mode ─────────────────────────────────────────────────────────────

describe('_derive-outcome.cjs override mode (bare number argv)', () => {
  it('returns basis:"override" for a bare float arg', () => {
    const r = run(['0.8']);
    expect(parseOutput(r).basis).toBe('override');
  });

  it('echoes the provided reward value', () => {
    const r = run(['0.8']);
    expect(parseOutput(r).reward).toBe(0.8);
  });

  it('success=true when override >= 0.5', () => {
    expect(parseOutput(run(['0.6'])).success).toBe(true);
    expect(parseOutput(run(['0.5'])).success).toBe(true);
  });

  it('success=false when override < 0.5', () => {
    expect(parseOutput(run(['0.3'])).success).toBe(false);
  });

  it('clamps override > 0.95 to 0.95', () => {
    expect(parseOutput(run(['1.5'])).reward).toBe(0.95);
  });

  it('clamps override < 0.05 to 0.05', () => {
    expect(parseOutput(run(['-1'])).reward).toBe(0.05);
  });

  it('clamps override of exactly 0 to 0.05', () => {
    expect(parseOutput(run(['0'])).reward).toBe(0.05);
  });

  it('exits 0 in override mode', () => {
    expect(run(['0.7']).status).toBe(0);
  });
});

// ── Fallback mode ─────────────────────────────────────────────────────────────
// When there is no readable transcript file and stdin is empty/closed,
// the script should output basis:'fallback', reward:0.7.

describe('_derive-outcome.cjs fallback mode (no readable input)', () => {
  it('outputs basis:"fallback" when stdin is empty', () => {
    // Pass empty stdin so the process doesn't hang waiting for input
    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      timeout: 5_000,
      input: '',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // The process may return fallback or neutral — check it exits 0 and parses
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(typeof out.reward).toBe('number');
    expect(typeof out.success).toBe('boolean');
  });

  it('fallback output has reward:0.7 and success:true', () => {
    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      timeout: 5_000,
      input: '',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = JSON.parse(r.stdout.trim());
    expect(out.basis).toBe('fallback');
    expect(out.reward).toBe(0.7);
    expect(out.success).toBe(true);
  });
});

// ── File-based transcript mode ────────────────────────────────────────────────

describe('_derive-outcome.cjs file-based transcript', () => {
  let tmpFile;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `derive-outcome-test-${process.pid}.jsonl`);
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch { /* ok */ }
  });

  function userMsg(text) {
    return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
  }
  function toolUse(id, name) {
    return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] } };
  }
  function toolResult(id, isError, text) {
    return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] } };
  }

  it('reads a clean transcript file and returns success', () => {
    const events = [
      userMsg('do work'),
      toolUse('a', 'Read'), toolResult('a', false, 'file content'),
    ];
    fs.writeFileSync(tmpFile, events.map(e => JSON.stringify(e)).join('\n'), 'utf8');

    const r = run([tmpFile]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.success).toBe(true);
    expect(out.basis).toBe('transcript');
  });

  it('reads a failing transcript file and returns failure', () => {
    const events = [
      userMsg('run build'),
      toolUse('a', 'Bash'),
      toolResult('a', true, 'Exit code 1\nBuild failed'),
    ];
    fs.writeFileSync(tmpFile, events.map(e => JSON.stringify(e)).join('\n'), 'utf8');

    const r = run([tmpFile]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.success).toBe(false);
    expect(out.reward).toBeLessThan(0.5);
  });

  it('non-existent file path falls through to stdin (not a crash)', () => {
    // Passing a non-existent path → falls back to stdin (empty → fallback)
    const r = spawnSync(process.execPath, [SCRIPT, '/tmp/definitely-does-not-exist-xyzabc.jsonl'], {
      encoding: 'utf8',
      timeout: 5_000,
      input: '',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(typeof out.reward).toBe('number');
  });
});
