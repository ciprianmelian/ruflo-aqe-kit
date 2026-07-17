/**
 * Tests for .claude/helpers/_derive-outcome.cjs
 *
 * Coverage gaps addressed:
 *  - resultText() edge cases (null, array variants)
 *  - parseEvents() malformed JSONL tolerance
 *  - lastTurnEvents() turn-boundary logic
 *  - deriveOutcome() reward clamping, flailing, tool-spam, all signal tags
 *  - IEEE-754 boundary stability at 0.5
 */

'use strict';

const { deriveOutcome, parseEvents, lastTurnEvents, resultText } =
  require('../.claude/helpers/_derive-outcome.cjs');

// ── Fixtures ──────────────────────────────────────────────────────────────────

function userMsg(text) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
}
function toolUse(id, name, input) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: input || {} }] } };
}
function toolResult(id, isError, text) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] } };
}
function jsonl(events) {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

// ── resultText() ──────────────────────────────────────────────────────────────

describe('resultText', () => {
  it('returns string content unchanged', () => {
    expect(resultText('hello world')).toBe('hello world');
  });

  it('joins text parts from array content', () => {
    const content = [
      { type: 'text', text: 'line1' },
      { type: 'text', text: 'line2' },
    ];
    expect(resultText(content)).toBe('line1\nline2');
  });

  it('ignores non-text parts in array', () => {
    const content = [
      { type: 'image', url: 'x' },
      { type: 'text', text: 'only-this' },
    ];
    expect(resultText(content)).toBe('only-this');
  });

  it('returns empty string for empty array', () => {
    expect(resultText([])).toBe('');
  });

  it('returns empty string for null', () => {
    expect(resultText(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(resultText(undefined)).toBe('');
  });

  it('returns empty string for non-string, non-array input', () => {
    expect(resultText(42)).toBe('');
    expect(resultText({})).toBe('');
  });
});

// ── parseEvents() ─────────────────────────────────────────────────────────────

describe('parseEvents', () => {
  it('passes arrays straight through', () => {
    const arr = [{ type: 'user' }];
    expect(parseEvents(arr)).toBe(arr);
  });

  it('parses well-formed JSONL', () => {
    const events = [{ a: 1 }, { b: 2 }];
    const jsonlStr = events.map((e) => JSON.stringify(e)).join('\n');
    expect(parseEvents(jsonlStr)).toEqual(events);
  });

  it('skips malformed lines without throwing', () => {
    const input = '{"a":1}\nnot-json\n{"b":2}';
    expect(parseEvents(input)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('skips blank lines', () => {
    const input = '{"a":1}\n\n\n{"b":2}';
    expect(parseEvents(input)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('returns empty array for empty string', () => {
    expect(parseEvents('')).toEqual([]);
  });

  it('returns empty array for null', () => {
    expect(parseEvents(null)).toEqual([]);
  });

  it('handles JSONL with trailing newline', () => {
    expect(parseEvents('{"a":1}\n')).toEqual([{ a: 1 }]);
  });
});

// ── lastTurnEvents() ──────────────────────────────────────────────────────────

describe('lastTurnEvents', () => {
  it('returns all events when no user-prompt boundary exists', () => {
    const events = [toolUse('a', 'Bash'), toolResult('a', false, 'ok')];
    expect(lastTurnEvents(events)).toEqual(events);
  });

  it('skips a tool-less closing turn and returns the prior tool-working turn', () => {
    const events = [
      userMsg('do work'),
      toolUse('a', 'Bash'), toolResult('a', false, 'done'),
      userMsg('ok looks good'),
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Great!' }] } },
    ];
    const slice = lastTurnEvents(events);
    // Should be the turn starting at userMsg('do work') since the closing turn has no tools
    expect(slice.some((e) => {
      const c = (e.message || e).content;
      return Array.isArray(c) && c.some((p) => p.type === 'tool_result');
    })).toBe(true);
  });

  it('treats tool_result echo user events as non-boundaries', () => {
    const toolResultEcho = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'x', content: 'out' }],
      },
    };
    const events = [userMsg('prompt'), toolUse('x', 'Bash'), toolResultEcho];
    const slice = lastTurnEvents(events);
    // tool_result echo should NOT be treated as a new turn boundary
    expect(slice.length).toBeGreaterThan(0);
  });
});

// ── deriveOutcome() ───────────────────────────────────────────────────────────

describe('deriveOutcome — reward band invariants', () => {
  it('clean single tool → success band (>= 0.55)', () => {
    const r = deriveOutcome(jsonl([
      userMsg('do something'),
      toolUse('a', 'Read'), toolResult('a', false, 'contents'),
    ]));
    expect(r.success).toBe(true);
    expect(r.reward).toBeGreaterThanOrEqual(0.55);
  });

  it('is_error=true → failure band (< 0.5)', () => {
    const r = deriveOutcome(jsonl([
      userMsg('build'),
      toolUse('a', 'Bash', { command: 'make' }), toolResult('a', true, 'Exit code 1'),
    ]));
    expect(r.success).toBe(false);
    expect(r.reward).toBeLessThan(0.5);
  });

  it('test runner FAIL pattern → failure band without is_error', () => {
    const r = deriveOutcome(jsonl([
      userMsg('run tests'),
      toolUse('a', 'Bash', { command: 'npm test' }),
      toolResult('a', false, 'Tests: 3 failed, 5 passed'),
    ]));
    expect(r.success).toBe(false);
  });

  it('"FAIL" keyword in result → failure band', () => {
    const r = deriveOutcome(jsonl([
      userMsg('run tests'),
      toolUse('a', 'Bash', { command: 'npm test' }),
      toolResult('a', false, 'FAIL src/foo.test.ts\n3 failing'),
    ]));
    expect(r.success).toBe(false);
  });

  it('"failed, N passed" pattern → failure band', () => {
    const r = deriveOutcome(jsonl([
      userMsg('run tests'),
      toolUse('a', 'Bash'), toolResult('a', false, '2 failed, 8 passed'),
    ]));
    expect(r.success).toBe(false);
  });

  it('vitest PASS keyword → success', () => {
    const r = deriveOutcome(jsonl([
      userMsg('run tests'),
      toolUse('a', 'Bash'), toolResult('a', false, 'PASS  src/foo.test.ts\nTests: 5 passed'),
    ]));
    expect(r.success).toBe(true);
  });

  it('"all tests passed" pattern → success', () => {
    const r = deriveOutcome(jsonl([
      userMsg('run tests'),
      toolUse('a', 'Bash'), toolResult('a', false, 'all tests passed'),
    ]));
    expect(r.success).toBe(true);
  });

  it('reward is clamped to [0.05, 0.95]', () => {
    // Generate maximum failure scenario
    const events = [userMsg('do things')];
    for (let i = 0; i < 10; i++) {
      events.push(toolUse(`t${i}`, 'Bash', { command: `cmd${i}` }));
      events.push(toolResult(`t${i}`, true, 'Exit code 1'));
    }
    const r = deriveOutcome(jsonl(events));
    expect(r.reward).toBeGreaterThanOrEqual(0.05);
    expect(r.reward).toBeLessThanOrEqual(0.95);
  });

  it('reward rounds to 4 decimal places (IEEE-754 boundary stability)', () => {
    const r = deriveOutcome(jsonl([
      userMsg('x'), toolUse('a', 'Read'), toolResult('a', false, 'ok'),
    ]));
    const decimals = (r.reward.toString().split('.')[1] || '').length;
    expect(decimals).toBeLessThanOrEqual(4);
  });
});

describe('deriveOutcome — V2 efficiency ordering', () => {
  const efficientEvents = jsonl([
    userMsg('apply fix'),
    toolUse('a', 'Edit'), toolResult('a', false, 'ok'),
    toolUse('b', 'Bash', { command: 'build' }), toolResult('b', false, 'Build OK'),
  ]);

  const churnyEvents = jsonl([
    userMsg('refactor'),
    ...Array.from({ length: 8 }, (_, i) => [
      toolUse(`e${i}`, 'Edit'), toolResult(`e${i}`, false, 'ok'),
    ]).flat(),
  ]);

  const recoveredEvents = jsonl([
    userMsg('fix it'),
    toolUse('a', 'Bash', { command: 'make' }), toolResult('a', true, 'Exit code 1'),
    toolUse('b', 'Bash', { command: 'make' }), toolResult('b', false, 'OK'),
  ]);

  const hardFailEvents = jsonl([
    userMsg('break it'),
    toolUse('a', 'Bash', { command: 'deploy' }), toolResult('a', true, 'Exit code 1'),
    toolUse('b', 'Bash', { command: 'rollback' }), toolResult('b', true, 'Exit code 2'),
  ]);

  it('efficient > churny', () => {
    expect(deriveOutcome(efficientEvents).reward).toBeGreaterThan(deriveOutcome(churnyEvents).reward);
  });

  it('churny-success > recovered-failure', () => {
    expect(deriveOutcome(churnyEvents).reward).toBeGreaterThan(deriveOutcome(recoveredEvents).reward);
  });

  it('recovered-failure > hard-failure', () => {
    expect(deriveOutcome(recoveredEvents).reward).toBeGreaterThan(deriveOutcome(hardFailEvents).reward);
  });
});

describe('deriveOutcome — flailing penalty (repeated identical failure)', () => {
  it('penalises the same failing command repeated 3 times', () => {
    const flailling = jsonl([
      userMsg('try'),
      toolUse('a', 'Bash', { command: 'make test' }), toolResult('a', true, 'Exit code 1'),
      toolUse('b', 'Bash', { command: 'make test' }), toolResult('b', true, 'Exit code 1'),
      toolUse('c', 'Bash', { command: 'make test' }), toolResult('c', true, 'Exit code 1'),
    ]);
    const single = jsonl([
      userMsg('try'),
      toolUse('a', 'Bash', { command: 'make test' }), toolResult('a', true, 'Exit code 1'),
    ]);
    expect(deriveOutcome(flailling).reward).toBeLessThanOrEqual(deriveOutcome(single).reward);
  });
});

describe('deriveOutcome — tool-spam penalty', () => {
  it('penalises turns with > 12 tool calls on a clean turn', () => {
    const spamEvents = [userMsg('lots of reads')];
    for (let i = 0; i < 20; i++) {
      spamEvents.push(toolUse(`r${i}`, 'Read'));
      spamEvents.push(toolResult(`r${i}`, false, 'content'));
    }
    const leanEvents = [
      userMsg('one read'), toolUse('r0', 'Read'), toolResult('r0', false, 'content'),
    ];
    const spam = deriveOutcome(jsonl(spamEvents));
    const lean = deriveOutcome(jsonl(leanEvents));
    expect(lean.reward).toBeGreaterThan(spam.reward);
  });
});

describe('deriveOutcome — failure tags', () => {
  it('tags test-failure correctly', () => {
    const r = deriveOutcome(jsonl([
      userMsg('test'), toolUse('a', 'Bash'), toolResult('a', false, 'Tests: 2 failed'),
    ]));
    expect(r.signals.failureTag).toBe('test-failure');
  });

  it('tags tool-failure for is_error', () => {
    const r = deriveOutcome(jsonl([
      userMsg('build'), toolUse('a', 'Bash'), toolResult('a', true, 'error'),
    ]));
    expect(r.signals.failureTag).toBe('tool-failure');
  });

  it('tags recovered-failure when tool recovers', () => {
    const r = deriveOutcome(jsonl([
      userMsg('retry'),
      toolUse('a', 'Bash', { command: 'x' }), toolResult('a', true, 'error'),
      toolUse('b', 'Bash', { command: 'x' }), toolResult('b', false, 'ok'),
    ]));
    expect(r.signals.failureTag).toBe('recovered-failure');
  });

  it('failureTag is null for clean turn', () => {
    const r = deriveOutcome(jsonl([
      userMsg('read'), toolUse('a', 'Read'), toolResult('a', false, 'ok'),
    ]));
    expect(r.signals.failureTag).toBeNull();
  });
});

describe('deriveOutcome — no-tool turns', () => {
  it('empty events returns neutral (>= 0.5)', () => {
    const r = deriveOutcome('');
    expect(r.success).toBe(true);
  });

  it('text-only assistant turn returns neutral (>= 0.5)', () => {
    const events = jsonl([
      userMsg('what is 2+2?'),
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '4' }] } },
    ]);
    const r = deriveOutcome(events);
    expect(r.reward).toBeGreaterThanOrEqual(0.5);
  });
});

describe('deriveOutcome — Exit code regex variants', () => {
  it('detects "Exit code 1" in result text (no is_error)', () => {
    const r = deriveOutcome(jsonl([
      userMsg('run'),
      toolUse('a', 'Bash', { command: 'fail' }),
      toolResult('a', false, 'some output\n  Exit code 1\nmore output'),
    ]));
    expect(r.success).toBe(false);
  });

  it('does NOT trigger on "Exit code 0"', () => {
    const r = deriveOutcome(jsonl([
      userMsg('run'),
      toolUse('a', 'Bash'), toolResult('a', false, 'Exit code 0\nDone'),
    ]));
    expect(r.success).toBe(true);
  });
});
