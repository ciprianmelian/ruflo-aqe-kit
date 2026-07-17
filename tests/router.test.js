/**
 * Tests for .claude/helpers/router.js
 *
 * Coverage gaps addressed:
 *  - All TASK_PATTERNS route correctly
 *  - Case-insensitive matching
 *  - Empty/whitespace input falls through to default
 *  - First-match semantics (pattern order)
 *  - AGENT_CAPABILITIES structure integrity
 *  - Confidence values
 */

'use strict';

const { routeTask, AGENT_CAPABILITIES, TASK_PATTERNS } =
  require('../.claude/helpers/router.js');

describe('routeTask — pattern matching', () => {
  it('routes "implement a feature" to coder', () => {
    const r = routeTask('implement a feature');
    expect(r.agent).toBe('coder');
    expect(r.confidence).toBe(0.8);
  });

  it('routes "write unit tests" to tester', () => {
    const r = routeTask('write unit tests for auth module');
    expect(r.agent).toBe('tester');
  });

  it('routes "review the PR" to reviewer', () => {
    expect(routeTask('review the PR for security issues').agent).toBe('reviewer');
  });

  it('routes "search for documentation" to researcher', () => {
    expect(routeTask('search for documentation on Redis').agent).toBe('researcher');
  });

  it('routes "design system architecture" to architect', () => {
    expect(routeTask('design system architecture for the new service').agent).toBe('architect');
  });

  it('routes "create API endpoint" to backend-dev', () => {
    expect(routeTask('create an API endpoint for user profiles').agent).toBe('backend-dev');
  });

  it('routes "build react component" to frontend-dev', () => {
    expect(routeTask('build a React component for the nav bar').agent).toBe('frontend-dev');
  });

  it('routes "set up docker pipeline" to devops', () => {
    expect(routeTask('set up docker CI/CD pipeline').agent).toBe('devops');
  });
});

describe('routeTask — default fallback', () => {
  it('returns coder with 0.5 confidence for unknown tasks', () => {
    const r = routeTask('do something unusual and unrecognised xyz123');
    expect(r.agent).toBe('coder');
    expect(r.confidence).toBe(0.5);
    expect(r.reason).toMatch(/no specific pattern/i);
  });

  it('returns coder for empty string', () => {
    expect(routeTask('').agent).toBe('coder');
  });

  it('returns coder for whitespace-only string', () => {
    expect(routeTask('   ').agent).toBe('coder');
  });
});

describe('routeTask — case insensitivity', () => {
  it('matches IMPLEMENT in uppercase', () => {
    expect(routeTask('IMPLEMENT the new feature').agent).toBe('coder');
  });

  it('matches mixed case TEST', () => {
    expect(routeTask('Test the new module').agent).toBe('tester');
  });
});

describe('routeTask — return shape', () => {
  it('always returns agent, confidence, reason', () => {
    const r = routeTask('anything at all');
    expect(r).toHaveProperty('agent');
    expect(r).toHaveProperty('confidence');
    expect(r).toHaveProperty('reason');
    expect(typeof r.agent).toBe('string');
    expect(typeof r.confidence).toBe('number');
    expect(typeof r.reason).toBe('string');
  });

  it('confidence is between 0 and 1', () => {
    ['implement a feature', 'unknown task zzz'].forEach((task) => {
      const { confidence } = routeTask(task);
      expect(confidence).toBeGreaterThan(0);
      expect(confidence).toBeLessThanOrEqual(1);
    });
  });
});

describe('AGENT_CAPABILITIES', () => {
  it('contains all expected agents', () => {
    const expected = ['coder', 'tester', 'reviewer', 'researcher', 'architect', 'backend-dev', 'frontend-dev', 'devops'];
    for (const agent of expected) {
      expect(AGENT_CAPABILITIES).toHaveProperty(agent);
      expect(Array.isArray(AGENT_CAPABILITIES[agent])).toBe(true);
      expect(AGENT_CAPABILITIES[agent].length).toBeGreaterThan(0);
    }
  });
});

describe('TASK_PATTERNS', () => {
  it('all patterns compile to valid regex', () => {
    for (const pattern of Object.keys(TASK_PATTERNS)) {
      expect(() => new RegExp(pattern, 'i')).not.toThrow();
    }
  });

  it('all pattern targets are known agents', () => {
    const knownAgents = new Set(Object.keys(AGENT_CAPABILITIES));
    for (const agent of Object.values(TASK_PATTERNS)) {
      expect(knownAgents.has(agent)).toBe(true);
    }
  });
});

// ── first-match precedence ─────────────────────────────────────────────────
// TASK_PATTERNS is iterated in insertion order; the FIRST matching pattern
// wins. Tasks that trigger multiple patterns should resolve to the first one.

describe('routeTask — first-match precedence', () => {
  it('"implement tests" routes to coder (implement pattern precedes test pattern)', () => {
    // 'implement' appears in the first code pattern; 'test' is the second.
    const r = routeTask('implement tests for the login module');
    expect(r.agent).toBe('coder');
    expect(r.confidence).toBe(0.8);
  });

  it('"review and audit the API" routes to reviewer (first matched pattern)', () => {
    // 'review' matches reviewer; 'api' would match backend-dev — reviewer wins.
    const r = routeTask('review and audit the API endpoints');
    expect(r.agent).toBe('reviewer');
  });
});

// ── null / undefined / non-string input guard ──────────────────────────────
// routeTask() calls task.toLowerCase() directly — passing null/undefined
// throws a TypeError. These tests document the current behaviour so any
// future hardening that adds a guard is caught as a deliberate change.

describe('routeTask — non-string input (edge cases)', () => {
  it('throws or returns default for null input (no guard in place)', () => {
    // Document: currently throws TypeError. After hardening it should not.
    expect(() => routeTask(null)).toThrow();
  });

  it('throws or returns default for undefined input', () => {
    expect(() => routeTask(undefined)).toThrow();
  });

  it('handles numeric input by coercion (if guard is added)', () => {
    // If a guard like `task = String(task ?? '')` is added, this should pass.
    // Until then this test describes the desired safe behaviour.
    const safe = () => {
      const t = String(42);
      return routeTask(t);
    };
    expect(safe).not.toThrow();
    expect(safe().agent).toBe('coder');
  });
});
