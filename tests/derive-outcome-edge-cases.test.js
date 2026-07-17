/**
 * Additional edge-case tests for .claude/helpers/_derive-outcome.cjs
 *
 * Complements derive-outcome.test.js with gaps not covered there:
 *  - deriveOutcome(null) and deriveOutcome(undefined): must not throw
 *  - basis field: values for clean / failure / override / no-events cases
 *  - Multi-failure: 3 simultaneous tool errors, reward still in [0.05, 0.95]
 *  - Recovery cycling: fail → recover → fail → still counts failure
 *  - Exit-code in result text that also has is_error: not double-charged
 *  - lastTurnEvents: multiple user turns, pick the last one with tool work
 *  - Bash key null-safety: tool_use with non-object input
 */

'use strict';

const { deriveOutcome, parseEvents, lastTurnEvents } =
  require('../.claude/helpers/_derive-outcome.cjs');

function userMsg(text) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
}
function toolUse(id, name, input) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: input || {} }] } };
}
function toolResult(id, isError, text) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] } };
}
function jsonl(events) { return events.map(e => JSON.stringify(e)).join('\n'); }

// ── null / undefined input ────────────────────────────────────────────────────

describe('deriveOutcome — null and undefined input', () => {
  it('does not throw on null input', () => {
    expect(() => deriveOutcome(null)).not.toThrow();
  });

  it('does not throw on undefined input', () => {
    expect(() => deriveOutcome(undefined)).not.toThrow();
  });

  it('returns a valid result shape for null', () => {
    const r = deriveOutcome(null);
    expect(typeof r.reward).toBe('number');
    expect(typeof r.success).toBe('boolean');
    expect(typeof r.basis).toBe('string');
    expect(r.signals).toBeDefined();
  });

  it('null input yields success=true (no failures detected)', () => {
    expect(deriveOutcome(null).success).toBe(true);
  });
});

// ── basis field values ────────────────────────────────────────────────────────

describe('deriveOutcome — basis field', () => {
  it('basis is a non-empty string for any input', () => {
    const cases = [
      jsonl([userMsg('x'), toolUse('a', 'Read'), toolResult('a', false, 'ok')]),
      jsonl([userMsg('x'), toolUse('a', 'Bash'), toolResult('a', true, 'err')]),
      '',
    ];
    for (const c of cases) {
      const { basis } = deriveOutcome(c);
      expect(typeof basis).toBe('string');
      expect(basis.length).toBeGreaterThan(0);
    }
  });
});

// ── multi-failure: 3 simultaneous errors ─────────────────────────────────────

describe('deriveOutcome — 3 simultaneous tool errors', () => {
  it('stays within [0.05, 0.95] even with 3 hard errors', () => {
    const r = deriveOutcome(jsonl([
      userMsg('deploy'),
      toolUse('a', 'Bash', { command: 'step1' }), toolResult('a', true, 'err'),
      toolUse('b', 'Bash', { command: 'step2' }), toolResult('b', true, 'err'),
      toolUse('c', 'Bash', { command: 'step3' }), toolResult('c', true, 'err'),
    ]));
    expect(r.reward).toBeGreaterThanOrEqual(0.05);
    expect(r.reward).toBeLessThanOrEqual(0.95);
    expect(r.success).toBe(false);
  });

  it('3 errors score lower than 1 error', () => {
    const three = deriveOutcome(jsonl([
      userMsg('x'),
      toolUse('a', 'Bash'), toolResult('a', true, 'err'),
      toolUse('b', 'Bash'), toolResult('b', true, 'err'),
      toolUse('c', 'Bash'), toolResult('c', true, 'err'),
    ]));
    const one = deriveOutcome(jsonl([
      userMsg('x'),
      toolUse('a', 'Bash'), toolResult('a', true, 'err'),
    ]));
    expect(three.reward).toBeLessThanOrEqual(one.reward);
  });
});

// ── recovery cycling: fail → recover → fail again ────────────────────────────

describe('deriveOutcome — recovery cycling', () => {
  it('fail → recover → fail again: still in failure band', () => {
    const r = deriveOutcome(jsonl([
      userMsg('cycle'),
      toolUse('a', 'Bash', { command: 'x' }), toolResult('a', true, 'err'),   // fail
      toolUse('b', 'Bash', { command: 'x' }), toolResult('b', false, 'ok'),   // recover
      toolUse('c', 'Bash', { command: 'x' }), toolResult('c', true, 'err'),   // fail again
    ]));
    expect(r.success).toBe(false);
    expect(r.reward).toBeLessThan(0.5);
  });

  it('two different tools: one recovers, one does not → failure band', () => {
    const r = deriveOutcome(jsonl([
      userMsg('mixed'),
      toolUse('a', 'Bash', { command: 'build' }), toolResult('a', true, 'err'),
      toolUse('b', 'Bash', { command: 'build' }), toolResult('b', false, 'ok'),  // build recovers
      toolUse('c', 'Bash', { command: 'test' }), toolResult('c', true, 'err'),   // test fails, no retry
    ]));
    expect(r.success).toBe(false);
  });
});

// ── Exit-code + is_error: no double-charging ─────────────────────────────────

describe('deriveOutcome — exit-code text with is_error (no double-charge)', () => {
  it('is_error=true and "Exit code 1" in text: charged once not twice', () => {
    // A single hard failure (is_error + "Exit code 1") should be floor-bounded at 0.05
    // and NOT penalise more than two distinct failures would.
    const doubleCharged = deriveOutcome(jsonl([
      userMsg('run'),
      toolUse('a', 'Bash', { command: 'cmd' }),
      toolResult('a', true, 'Exit code 1'),  // both is_error AND "Exit code 1"
    ]));
    const twoDistinct = deriveOutcome(jsonl([
      userMsg('run'),
      toolUse('a', 'Bash', { command: 'cmd1' }), toolResult('a', true, 'failure'),
      toolUse('b', 'Bash', { command: 'cmd2' }), toolResult('b', true, 'Exit code 1'),
    ]));
    // Single event should not penalise more than two distinct failures
    expect(doubleCharged.reward).toBeGreaterThanOrEqual(twoDistinct.reward);
  });
});

// ── lastTurnEvents: multiple turns, picks last tool-working turn ──────────────

describe('lastTurnEvents — multi-turn selection', () => {
  it('with 3 turns, picks the last one that has tool work', () => {
    const events = [
      userMsg('turn 1'),
      toolUse('a', 'Bash'), toolResult('a', false, 'ok'),

      userMsg('turn 2'),
      toolUse('b', 'Read'), toolResult('b', false, 'content'),

      userMsg('turn 3 — no tools'),
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ];
    const slice = lastTurnEvents(events);
    // Should include turn 2's tool_result, not turn 1's
    const hasB = slice.some(e => {
      const c = (e.message || e).content;
      return Array.isArray(c) && c.some(p => p.type === 'tool_result' && p.tool_use_id === 'b');
    });
    expect(hasB).toBe(true);
  });

  it('when no turn has tool work, returns the last turn', () => {
    const events = [
      userMsg('q1'),
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '42' }] } },
      userMsg('q2'),
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ];
    const slice = lastTurnEvents(events);
    expect(slice.length).toBeGreaterThan(0);
  });
});

// ── Bash key null-safety ──────────────────────────────────────────────────────

describe('deriveOutcome — Bash tool_use with non-object input', () => {
  it('does not throw when tool_use input is null', () => {
    // Some events may have null/missing input (edge case in real transcripts)
    const events = [
      userMsg('do it'),
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: null }] } },
      toolResult('x', false, 'ok'),
    ];
    expect(() => deriveOutcome(jsonl(events))).not.toThrow();
  });

  it('does not throw when tool_use input is a number', () => {
    const events = [
      userMsg('do it'),
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'y', name: 'Bash', input: 42 }] } },
      toolResult('y', false, 'ok'),
    ];
    expect(() => deriveOutcome(jsonl(events))).not.toThrow();
  });
});
