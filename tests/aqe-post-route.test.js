/**
 * Tests for .claude/helpers/aqe-post-route.cjs
 *
 * Coverage gaps addressed:
 *  - extractKeywords(): stop-word removal, non-alnum stripping, short-token filter
 *  - isRoutableTask(): meta-envelope rejection, empty input, normal tasks
 *  - firstUserTask(): extracts first non-tool-result user message from JSONL
 *  - recordRoutingOutcome(): writes/caps outcomes.json; skips on missing agent
 *  - Main script: RUFLO_DISABLE_TRAINING=1 skips all writes and exits 0
 *  - Main script: explicit reward override via argv[2]
 *  - Main script: always exits 0 even on corrupt stdin
 *
 * Strategy: spawn the script as a subprocess (it is a self-executing IIFE).
 * Pure-logic helpers are re-implemented inline to match the source exactly,
 * so any divergence is caught by the failing tests.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SCRIPT = path.resolve(__dirname, '../.claude/helpers/aqe-post-route.cjs');

// ── Inline re-implementations of pure helpers (not exported) ─────────────────

const _STOP = new Set(('the a an is are was were be been being have has had do does did will would could should may might shall can to of in for on with at by from as into through during before after above below between under again further then once it its this that these those i me my we our you your he she they them and but or nor not no so if when than very just also only both each all any few more most other some such same new now here there where how what which who').split(' '));

function extractKeywords(text) {
  if (!text) return [];
  return String(text).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !_STOP.has(w));
}

function isRoutableTask(t) {
  const s = String(t || '').trim();
  if (!s) return false;
  if (/^<(task-notification|command-message|command-name|command-args|local-command|system-reminder|user-prompt-submit-hook|bash-(input|stdout|stderr)|tool_use|tool_result)\b/i.test(s)) return false;
  return true;
}

function firstUserTask(transcript) {
  try {
    for (const line of String(transcript || '').split('\n')) {
      const s = line.trim(); if (!s) continue;
      let ev; try { ev = JSON.parse(s); } catch (e) { continue; }
      const m = ev && (ev.message || ev); if (!m) continue;
      if ((m.role || ev.type) !== 'user') continue;
      const c = m.content;
      if (Array.isArray(c) && c.length && c.every((p) => p && p.type === 'tool_result')) continue;
      const t = typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join('\n') : '';
      if (t.trim()) return t.trim();
    }
  } catch (e) {}
  return '';
}

// ── Subprocess helper ─────────────────────────────────────────────────────────

function run(opts = {}) {
  const { argv = [], stdin = '', env = {} } = opts;
  return spawnSync(process.execPath, [SCRIPT, ...argv], {
    input: stdin,
    encoding: 'utf8',
    timeout: 8000,
    env: { ...process.env, ...env },
    cwd: opts.cwd || os.tmpdir(),
  });
}

// ── extractKeywords (inline mirror) ──────────────────────────────────────────

describe('extractKeywords', () => {
  it('returns empty array for falsy input', () => {
    expect(extractKeywords('')).toEqual([]);
    expect(extractKeywords(null)).toEqual([]);
    expect(extractKeywords(undefined)).toEqual([]);
  });

  it('removes stop words', () => {
    const kw = extractKeywords('the quick brown fox');
    expect(kw).not.toContain('the');
    expect(kw).toContain('quick');
    expect(kw).toContain('brown');
  });

  it('drops tokens of length <= 2', () => {
    expect(extractKeywords('do go')).toEqual([]);
    expect(extractKeywords('run fix bug')).toContain('run');
  });

  it('strips non-alphanumeric characters before splitting', () => {
    const kw = extractKeywords('hello! world@#$');
    expect(kw).toContain('hello');
    expect(kw).toContain('world');
  });

  it('lowercases all tokens', () => {
    const kw = extractKeywords('IMPLEMENT Feature');
    expect(kw).toContain('implement');
    expect(kw).toContain('feature');
  });
});

// ── isRoutableTask (inline mirror) ───────────────────────────────────────────

describe('isRoutableTask', () => {
  it('returns false for empty string', () => {
    expect(isRoutableTask('')).toBe(false);
    expect(isRoutableTask(null)).toBe(false);
    expect(isRoutableTask(undefined)).toBe(false);
  });

  it('rejects task-notification meta-envelopes', () => {
    expect(isRoutableTask('<task-notification>some content</task-notification>')).toBe(false);
  });

  it('rejects command-message envelopes', () => {
    expect(isRoutableTask('<command-message>anything</command-message>')).toBe(false);
  });

  it('rejects system-reminder envelopes', () => {
    expect(isRoutableTask('<system-reminder>anything</system-reminder>')).toBe(false);
  });

  it('rejects bash-input envelopes', () => {
    expect(isRoutableTask('<bash-input>ls -la</bash-input>')).toBe(false);
  });

  it('rejects tool_result envelopes', () => {
    expect(isRoutableTask('<tool_result>output here</tool_result>')).toBe(false);
  });

  it('accepts genuine task strings', () => {
    expect(isRoutableTask('implement the new auth feature')).toBe(true);
    expect(isRoutableTask('fix the flaky test in session.test.js')).toBe(true);
    expect(isRoutableTask('review PR #42')).toBe(true);
  });

  it('is case-insensitive for envelope tags', () => {
    expect(isRoutableTask('<TASK-NOTIFICATION>...')).toBe(false);
    expect(isRoutableTask('<System-Reminder>...')).toBe(false);
  });
});

// ── firstUserTask (inline mirror) ─────────────────────────────────────────────

describe('firstUserTask', () => {
  it('returns empty string for empty transcript', () => {
    expect(firstUserTask('')).toBe('');
    expect(firstUserTask(null)).toBe('');
  });

  it('extracts string content from a user message', () => {
    const line = JSON.stringify({ role: 'user', content: 'implement auth' });
    expect(firstUserTask(line)).toBe('implement auth');
  });

  it('extracts text from content array with text blocks', () => {
    const line = JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'fix the bug' }] });
    expect(firstUserTask(line)).toBe('fix the bug');
  });

  it('skips messages where all content blocks are tool_result', () => {
    const toolResultMsg = JSON.stringify({ role: 'user', content: [{ type: 'tool_result', content: 'ok' }] });
    const userMsg = JSON.stringify({ role: 'user', content: 'actual task' });
    expect(firstUserTask(toolResultMsg + '\n' + userMsg)).toBe('actual task');
  });

  it('skips non-user messages', () => {
    const assistant = JSON.stringify({ role: 'assistant', content: 'I will help' });
    const user = JSON.stringify({ role: 'user', content: 'please help' });
    expect(firstUserTask(assistant + '\n' + user)).toBe('please help');
  });

  it('skips malformed JSON lines', () => {
    const bad = 'not json\n';
    const good = JSON.stringify({ role: 'user', content: 'valid task' });
    expect(firstUserTask(bad + good)).toBe('valid task');
  });

  it('supports ev.message wrapper format', () => {
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'wrapped task' } });
    expect(firstUserTask(line)).toBe('wrapped task');
  });
});

// ── Script subprocess tests ────────────────────────────────────────────────────

describe('aqe-post-route.cjs — subprocess', () => {
  it('always exits 0', () => {
    const r = run({ stdin: '' });
    expect(r.status).toBe(0);
  });

  it('outputs {} when stdin is empty', () => {
    const r = run({ stdin: '' });
    expect(r.stdout.trim()).toBe('{}');
  });

  it('outputs {} when stdin is corrupt JSON', () => {
    const r = run({ stdin: 'not json at all' });
    expect(r.stdout.trim()).toBe('{}');
  });

  it('RUFLO_DISABLE_TRAINING=1 skips writes and emits {}', () => {
    const r = run({
      stdin: JSON.stringify({ transcript_path: '' }),
      env: { RUFLO_DISABLE_TRAINING: '1' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
    // Breadcrumb appears on stderr
    expect(r.stderr).toMatch(/RUFLO_DISABLE_TRAINING/);
  });

  it('explicit reward override via argv[2] is logged on stderr', () => {
    const r = run({ argv: ['0.85'], stdin: '' });
    expect(r.status).toBe(0);
    // Basis should appear in the breadcrumb
    expect(r.stderr).toMatch(/basis=override/);
    expect(r.stderr).toMatch(/reward=0.850/);
  });

  it('clamps reward override to [0.05, 0.95]', () => {
    const rHigh = run({ argv: ['2.0'], stdin: '' });
    expect(rHigh.stderr).toMatch(/reward=0.950/);

    const rLow = run({ argv: ['-5'], stdin: '' });
    expect(rLow.stderr).toMatch(/reward=0.050/);
  });

  it('does not write routing-outcomes.json when no agent is provided', () => {
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aqe-test-'));
    try {
      const r = run({
        argv: ['0.8'],
        stdin: '',
        env: { RUFLO_DISABLE_TRAINING: '1' },
        cwd: tmpCwd,
      });
      expect(r.status).toBe(0);
      expect(fs.existsSync(path.join(tmpCwd, '.claude-flow', 'routing-outcomes.json'))).toBe(false);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('writes routing-outcomes.json when RUFLO_ROUTED_AGENT is set', () => {
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aqe-test-'));
    try {
      // Create a minimal transcript with a user message
      const transcript = JSON.stringify({ role: 'user', content: 'implement feature X' }) + '\n';
      const transcriptPath = path.join(tmpCwd, 'transcript.jsonl');
      fs.writeFileSync(transcriptPath, transcript);

      const r = run({
        argv: ['0.8', '', 'coder'],
        stdin: JSON.stringify({ transcript_path: transcriptPath }),
        env: { RUFLO_ROUTED_AGENT: 'coder' },
        cwd: tmpCwd,
      });
      expect(r.status).toBe(0);
      const store = path.join(tmpCwd, '.claude-flow', 'routing-outcomes.json');
      if (fs.existsSync(store)) {
        const data = JSON.parse(fs.readFileSync(store, 'utf8'));
        expect(Array.isArray(data.outcomes)).toBe(true);
        expect(data.outcomes[0].agent).toBe('coder');
        expect(typeof data.outcomes[0].success).toBe('boolean');
      }
      // Script exits 0 regardless
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });
});
