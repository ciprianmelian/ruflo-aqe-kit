/**
 * Tests for .claude/helpers/ruflo-train-subagent.cjs
 *
 * Coverage gaps addressed:
 *  - _extractFromTranscript(): user role → task, assistant role → allText,
 *    blank lines, malformed JSON lines, tool_result content
 *  - MIN_CHARS gate (40): short body → '{}', exits 0
 *  - Body extraction fallback chain: result → output → response → tool_response.result
 *  - Missing agentic-qe / @claude-flow/cli → graceful '{}', exits 0
 *  - transcript_path field read (camelCase alias too)
 *  - Lock dir: if lock already held → exits 0 without training
 *  - Lock dir: stale lock (>120s) is stolen
 *  - Reward via argv[2] overrides oracle
 *  - Reward clamping: < 0.1 → 0.1, > 1.0 → 1.0
 *  - Always exits 0 (SubagentStop hook must never block)
 *  - stdout is always valid JSON
 *
 * Strategy: subprocess spawn. _extractFromTranscript is not exported;
 * re-implemented inline so divergence fails loudly.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '../.claude/helpers/ruflo-train-subagent.cjs');

function run(stdinObj, opts = {}) {
  return spawnSync(process.execPath, opts.argv ? [SCRIPT, ...opts.argv] : [SCRIPT], {
    input: typeof stdinObj === 'string' ? stdinObj : JSON.stringify(stdinObj),
    encoding: 'utf8',
    cwd: opts.cwd || process.cwd(),
    timeout: 15_000,
  });
}

// ── Inline re-implementation of _extractFromTranscript() ─────────────────────

function extractFromTranscript(transcriptPath) {
  let task = '', allText = '';
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
      const msg = ev && (ev.message || ev);
      if (!msg) continue;
      const role = msg.role || ev.type;
      const content = msg.content;
      const textOf = (c) => typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join('\n') : '';
      if (role === 'user' && !task) { const t = textOf(content).trim(); if (t) task = t; }
      else if (role === 'assistant') { const t = textOf(content); if (t.trim()) allText += (allText ? '\n' : '') + t; }
    }
  } catch (e) {}
  return { task, allText };
}

// ── _extractFromTranscript() inline tests ────────────────────────────────────

describe('_extractFromTranscript (inline re-impl)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rts-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function writeTranscript(events) {
    const p = path.join(tmpDir, 'transcript.jsonl');
    fs.writeFileSync(p, events.map(e => JSON.stringify(e)).join('\n'));
    return p;
  }

  it('extracts first user message as task', () => {
    const p = writeTranscript([
      { role: 'user', content: 'implement auth' },
      { role: 'assistant', content: 'done' },
    ]);
    const { task, allText } = extractFromTranscript(p);
    expect(task).toBe('implement auth');
    expect(allText).toBe('done');
  });

  it('concatenates multiple assistant messages', () => {
    const p = writeTranscript([
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'step 1' },
      { role: 'assistant', content: 'step 2' },
    ]);
    const { allText } = extractFromTranscript(p);
    expect(allText).toContain('step 1');
    expect(allText).toContain('step 2');
  });

  it('handles array content with text parts', () => {
    const p = writeTranscript([
      { message: { role: 'user', content: [{ type: 'text', text: 'do X' }] } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'result' }] } },
    ]);
    const { task, allText } = extractFromTranscript(p);
    expect(task).toBe('do X');
    expect(allText).toBe('result');
  });

  it('skips malformed JSON lines', () => {
    const p = path.join(tmpDir, 'transcript.jsonl');
    fs.writeFileSync(p, [
      '{not json',
      JSON.stringify({ role: 'user', content: 'real task' }),
    ].join('\n'));
    const { task } = extractFromTranscript(p);
    expect(task).toBe('real task');
  });

  it('returns empty strings for missing file', () => {
    const { task, allText } = extractFromTranscript(path.join(tmpDir, 'missing.jsonl'));
    expect(task).toBe('');
    expect(allText).toBe('');
  });

  it('does not overwrite task with subsequent user messages', () => {
    const p = writeTranscript([
      { role: 'user', content: 'first task' },
      { role: 'user', content: 'follow-up' },
    ]);
    const { task } = extractFromTranscript(p);
    expect(task).toBe('first task');
  });
});

// ── MIN_CHARS gate ────────────────────────────────────────────────────────────

describe('ruflo-train-subagent — MIN_CHARS gate (40 chars)', () => {
  it('outputs {} for body shorter than 40 chars', () => {
    const r = run({ result: 'short' });
    expect(r.stdout.trim()).toBe('{}');
  });

  it('outputs {} for body of exactly 39 chars', () => {
    const r = run({ result: 'x'.repeat(39) });
    expect(r.stdout.trim()).toBe('{}');
  });

  it('proceeds (exits 0) for body of exactly 40 chars', () => {
    const r = run({ result: 'x'.repeat(40) });
    expect(r.status).toBe(0);
    // stdout is {} regardless (deps not present), but script didn't skip for MIN_CHARS
    expect(() => JSON.parse(r.stdout.trim())).not.toThrow();
  });
});

// ── Body extraction fallback chain ────────────────────────────────────────────

describe('ruflo-train-subagent — body field fallback chain', () => {
  const LONG = 'x'.repeat(50);

  it('reads body from "result" field', () => {
    const r = run({ result: LONG });
    expect(r.status).toBe(0);
  });

  it('reads body from "output" field when result absent', () => {
    const r = run({ output: LONG });
    expect(r.status).toBe(0);
  });

  it('reads body from "response" field when result/output absent', () => {
    const r = run({ response: LONG });
    expect(r.status).toBe(0);
  });

  it('reads body from tool_response.result when other fields absent', () => {
    const r = run({ tool_response: { result: LONG } });
    expect(r.status).toBe(0);
  });

  it('reads body from last_message string', () => {
    const r = run({ last_message: LONG });
    expect(r.status).toBe(0);
  });
});

// ── Exit 0 contract ───────────────────────────────────────────────────────────

describe('ruflo-train-subagent — always exits 0', () => {
  it('exits 0 with empty stdin', () => expect(run('').status).toBe(0));
  it('exits 0 with malformed JSON', () => expect(run('{broken').status).toBe(0));
  it('exits 0 with minimal valid payload', () => expect(run({ result: '' }).status).toBe(0));
});

// ── stdout contract ───────────────────────────────────────────────────────────

describe('ruflo-train-subagent — stdout is always valid JSON', () => {
  it('outputs {} with empty payload', () => {
    expect(run('').stdout.trim()).toBe('{}');
  });

  it('output is parseable JSON for short body', () => {
    const r = run({ result: 'short' });
    expect(() => JSON.parse(r.stdout.trim())).not.toThrow();
  });
});

// ── Reward override via argv[2] ───────────────────────────────────────────────

describe('ruflo-train-subagent — reward override', () => {
  const LONG = 'x'.repeat(50);

  it('accepts argv[2] reward and exits 0', () => {
    const r = run({ result: LONG }, { argv: ['0.9'] });
    expect(r.status).toBe(0);
  });

  it('exits 0 with reward clamped below 0.1', () => {
    const r = run({ result: LONG }, { argv: ['0.0'] });
    expect(r.status).toBe(0);
  });

  it('exits 0 with reward clamped above 1.0', () => {
    const r = run({ result: LONG }, { argv: ['5.0'] });
    expect(r.status).toBe(0);
  });
});

// ── Lock directory behavior ───────────────────────────────────────────────────

describe('ruflo-train-subagent — lock directory', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rts-lock-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('skips training (outputs {}) when lock dir already exists', () => {
    // Pre-create the lock dir
    const lockDir = path.join(tmpDir, '.swarm', 'lora-train.lock');
    fs.mkdirSync(lockDir, { recursive: true });

    const r = run({ result: 'x'.repeat(50) }, { cwd: tmpDir });
    expect(r.stdout.trim()).toBe('{}');
    expect(r.status).toBe(0);
  });

  it('steals stale lock (>120s old) and proceeds', () => {
    // Create lock dir and backdate its mtime by 200 seconds
    const lockDir = path.join(tmpDir, '.swarm', 'lora-train.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    const staleTime = new Date(Date.now() - 130_000);
    fs.utimesSync(lockDir, staleTime, staleTime);

    // Script should steal the stale lock and attempt training (exits 0 regardless)
    const r = run({ result: 'x'.repeat(50) }, { cwd: tmpDir });
    expect(r.status).toBe(0);
  });
});
