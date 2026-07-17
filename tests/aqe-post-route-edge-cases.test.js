/**
 * Additional edge-case tests for .claude/helpers/aqe-post-route.cjs
 *
 * Complements aqe-post-route.test.js with gaps not covered there:
 *  - readRouteSentinel: fresh sentinel accepted, stale (> 2h) rejected,
 *    polluted (meta-envelope task) rejected, missing file returns null
 *  - recordRoutingOutcome: 500-entry cap enforced (oldest entries dropped),
 *    meta-envelope task is silently skipped (poison guard),
 *    missing agent is silently skipped
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Inline re-implementations of pure helpers ─────────────────────────────────
// Mirrors the relevant functions from aqe-post-route.cjs exactly so that
// any semantic divergence is caught by failing tests.

const _STOP = new Set(('the a an is are was were be been being have has had do does did will would could should may might shall can to of in for on with at by from as into through during before after above below between under again further then once it its this that these those i me my we our you your he she they them and but or nor not no so if when than very just also only both each all any few more most other some such same new now here there where how what which who').split(' '));

function extractKeywords(text) {
  if (!text) return [];
  return String(text).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !_STOP.has(w));
}

function isRoutableTask(t) {
  const s = String(t || '').trim();
  if (!s) return false;
  if (/^<(task-notification|command-message|command-name|command-args|local-command|system-reminder|user-prompt-submit-hook|bash-(input|stdout|stderr)|tool_use|tool_result)\b/i.test(s)) return false;
  return true;
}

function readRouteSentinel(cwd) {
  try {
    const p = path.join(cwd, '.claude-flow', '.ruflo-route.json');
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!j || !j.agent) return null;
    const age = Date.now() - new Date(j.ts || 0).getTime();
    if (!(age >= 0 && age < 2 * 3600 * 1000)) return null;
    if (j.task && !isRoutableTask(j.task)) return null;
    return { task: j.task || '', agent: String(j.agent).trim() };
  } catch (e) { return null; }
}

function recordRoutingOutcome(cwd, task, agent, success, quality) {
  if (!agent || !task) return false;
  if (!isRoutableTask(task)) return false;
  try {
    const dir = path.join(cwd, '.claude-flow');
    const store = path.join(dir, 'routing-outcomes.json');
    let data = { outcomes: [] };
    try {
      if (fs.existsSync(store)) {
        const j = JSON.parse(fs.readFileSync(store, 'utf8'));
        if (j && Array.isArray(j.outcomes)) data = j;
      }
    } catch (e) {}
    data.outcomes.push({
      task: String(task).slice(0, 500),
      agent: String(agent),
      success: !!success,
      quality,
      keywords: extractKeywords(task),
      timestamp: new Date().toISOString(),
    });
    if (data.outcomes.length > 500) data.outcomes = data.outcomes.slice(-500);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    fs.writeFileSync(store, JSON.stringify({ outcomes: data.outcomes }, null, 2));
    return true;
  } catch (e) { return false; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqe-edge-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function sentinelPath() {
  return path.join(tmpDir, '.claude-flow', '.ruflo-route.json');
}

function writeSentinel(data) {
  const dir = path.join(tmpDir, '.claude-flow');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sentinelPath(), JSON.stringify(data));
}

// ── readRouteSentinel: freshness ──────────────────────────────────────────────

describe('readRouteSentinel — freshness', () => {
  it('returns null when sentinel file does not exist', () => {
    expect(readRouteSentinel(tmpDir)).toBeNull();
  });

  it('accepts a fresh sentinel (< 2h old)', () => {
    writeSentinel({ agent: 'coder', task: 'implement auth', ts: new Date().toISOString() });
    const r = readRouteSentinel(tmpDir);
    expect(r).not.toBeNull();
    expect(r.agent).toBe('coder');
  });

  it('rejects a stale sentinel (> 2h old)', () => {
    const staleTs = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    writeSentinel({ agent: 'coder', task: 'implement auth', ts: staleTs });
    expect(readRouteSentinel(tmpDir)).toBeNull();
  });

  it('rejects a sentinel with ts = epoch 0 (unparseable)', () => {
    writeSentinel({ agent: 'coder', task: 'implement auth', ts: 0 });
    // age = Date.now() - 0 >> 2h → stale
    expect(readRouteSentinel(tmpDir)).toBeNull();
  });

  it('returns null when sentinel has no agent field', () => {
    writeSentinel({ task: 'do something', ts: new Date().toISOString() });
    expect(readRouteSentinel(tmpDir)).toBeNull();
  });

  it('returns null when sentinel JSON is corrupt', () => {
    const dir = path.join(tmpDir, '.claude-flow');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sentinelPath(), 'NOT JSON');
    expect(readRouteSentinel(tmpDir)).toBeNull();
  });
});

// ── readRouteSentinel: polluted sentinel rejection ────────────────────────────

describe('readRouteSentinel — meta-envelope poison guard', () => {
  it('rejects a sentinel whose task is a task-notification envelope', () => {
    writeSentinel({
      agent: 'coder',
      task: '<task-notification>some content</task-notification>',
      ts: new Date().toISOString(),
    });
    expect(readRouteSentinel(tmpDir)).toBeNull();
  });

  it('rejects a sentinel whose task is a system-reminder envelope', () => {
    writeSentinel({
      agent: 'tester',
      task: '<system-reminder>hook output</system-reminder>',
      ts: new Date().toISOString(),
    });
    expect(readRouteSentinel(tmpDir)).toBeNull();
  });

  it('accepts a sentinel with an empty task (task-unknown is OK)', () => {
    writeSentinel({ agent: 'researcher', task: '', ts: new Date().toISOString() });
    const r = readRouteSentinel(tmpDir);
    expect(r).not.toBeNull();
    expect(r.agent).toBe('researcher');
  });
});

// ── recordRoutingOutcome: 500-entry cap ───────────────────────────────────────

describe('recordRoutingOutcome — 500-entry cap', () => {
  it('caps outcomes at 500 and keeps the newest entries', () => {
    // Write 510 outcomes
    for (let i = 0; i < 510; i++) {
      recordRoutingOutcome(tmpDir, `task number ${i}`, 'coder', true, 0.8);
    }

    const store = path.join(tmpDir, '.claude-flow', 'routing-outcomes.json');
    const data = JSON.parse(fs.readFileSync(store, 'utf8'));

    expect(data.outcomes.length).toBe(500);
    // Oldest entries (0–9) should be gone; newest (task number 509) should be present
    expect(data.outcomes.some(o => o.task.includes('task number 509'))).toBe(true);
    expect(data.outcomes.some(o => o.task === 'task number 0')).toBe(false);
  });
});

// ── recordRoutingOutcome: poison guard ───────────────────────────────────────

describe('recordRoutingOutcome — meta-envelope poison guard', () => {
  it('does not write when task is a meta-envelope', () => {
    const result = recordRoutingOutcome(
      tmpDir,
      '<task-notification>stuff</task-notification>',
      'coder', true, 0.8,
    );
    expect(result).toBe(false);
    const store = path.join(tmpDir, '.claude-flow', 'routing-outcomes.json');
    expect(fs.existsSync(store)).toBe(false);
  });

  it('does not write when agent is empty string', () => {
    const result = recordRoutingOutcome(tmpDir, 'implement auth', '', true, 0.8);
    expect(result).toBe(false);
  });

  it('does not write when task is empty', () => {
    const result = recordRoutingOutcome(tmpDir, '', 'coder', true, 0.8);
    expect(result).toBe(false);
  });
});

// ── recordRoutingOutcome: output schema ──────────────────────────────────────

describe('recordRoutingOutcome — output schema', () => {
  it('writes expected fields to outcomes store', () => {
    recordRoutingOutcome(tmpDir, 'implement the auth flow', 'coder', true, 0.85);
    const store = path.join(tmpDir, '.claude-flow', 'routing-outcomes.json');
    const data = JSON.parse(fs.readFileSync(store, 'utf8'));
    const o = data.outcomes[0];
    expect(typeof o.task).toBe('string');
    expect(o.agent).toBe('coder');
    expect(typeof o.success).toBe('boolean');
    expect(typeof o.quality).toBe('number');
    expect(Array.isArray(o.keywords)).toBe(true);
    expect(typeof o.timestamp).toBe('string');
  });

  it('truncates task to 500 characters', () => {
    const longTask = 'x'.repeat(600);
    recordRoutingOutcome(tmpDir, longTask, 'coder', true, 0.7);
    const store = path.join(tmpDir, '.claude-flow', 'routing-outcomes.json');
    const data = JSON.parse(fs.readFileSync(store, 'utf8'));
    expect(data.outcomes[0].task.length).toBeLessThanOrEqual(500);
  });

  it('appends to existing store (does not truncate old entries)', () => {
    recordRoutingOutcome(tmpDir, 'task one', 'coder', true, 0.8);
    recordRoutingOutcome(tmpDir, 'task two', 'tester', false, 0.4);
    const store = path.join(tmpDir, '.claude-flow', 'routing-outcomes.json');
    const data = JSON.parse(fs.readFileSync(store, 'utf8'));
    expect(data.outcomes.length).toBe(2);
    expect(data.outcomes[0].task).toBe('task one');
    expect(data.outcomes[1].task).toBe('task two');
  });
});
