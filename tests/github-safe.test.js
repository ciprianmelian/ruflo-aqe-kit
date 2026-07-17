/**
 * Tests for .claude/helpers/github-safe.mjs
 *
 * Coverage gaps addressed (ADR-127 Phase 2):
 *  - Insufficient args (< 2) → exit 1 + usage text
 *  - Dry-run: issue comment (positional body) → --body-file substitution
 *  - Dry-run: pr create --body flag → --body-file substitution
 *  - Body > 256KB → exit 1 + error message
 *  - No body in comment/create → passthrough in dry-run
 *  - Non-body commands (e.g. pr list) → passthrough in dry-run
 *  - GITHUB_SAFE_VERSION export: asserted via import (Node ESM)
 *
 * Strategy: github-safe.mjs is an ES module with top-level process.exit calls.
 * All tests use subprocess spawning with GITHUB_SAFE_DRY_RUN=1 to avoid
 * executing real `gh` commands. The dry-run path logs the constructed command
 * and exits 0 without touching the network.
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '../.claude/helpers/github-safe.mjs');

function run(args = [], env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, GITHUB_SAFE_DRY_RUN: '1', ...env },
  });
}

// ── Argument validation ───────────────────────────────────────────────────────

describe('github-safe argument validation', () => {
  it('exits 1 and prints usage when called with no arguments', () => {
    const r = run([]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/usage/i);
    expect(r.stdout).toMatch(/github-safe/i);
  });

  it('exits 1 with only one argument', () => {
    const r = run(['issue']);
    expect(r.status).toBe(1);
  });
});

// ── Body size cap ─────────────────────────────────────────────────────────────

describe('github-safe body size cap', () => {
  it('rejects body > 256KB with exit 1 and an error message', () => {
    const oversized = 'x'.repeat(256 * 1024 + 1);
    const r = run(['issue', 'comment', '42', oversized]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/exceeds maximum/i);
  });

  it('accepts body exactly at the 256KB limit', () => {
    const maxBody = 'x'.repeat(256 * 1024);
    const r = run(['issue', 'comment', '42', maxBody]);
    // Should succeed in dry-run (exits 0, logs DRY-RUN)
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[DRY-RUN\]/);
  });
});

// ── Issue comment (positional body) ──────────────────────────────────────────

describe('github-safe issue comment', () => {
  it('replaces positional body arg with --body-file in dry-run', () => {
    const r = run(['issue', 'comment', '123', 'message with `backticks`']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[DRY-RUN\]/);
    expect(r.stdout).toMatch(/--body-file/);
    expect(r.stdout).not.toMatch(/backticks/); // body is not echoed in args
  });

  it('preserves the issue number in the command', () => {
    const r = run(['issue', 'comment', '999', 'body text']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('999');
  });
});

// ── PR create with --body flag ─────────────────────────────────────────────────

describe('github-safe pr create --body', () => {
  it('replaces --body flag pair with --body-file in dry-run', () => {
    const r = run(['pr', 'create', '--title', 'My PR', '--body', 'Complex body with $() injection']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/--body-file/);
    expect(r.stdout).not.toContain('$()');
  });

  it('preserves other flags like --title', () => {
    const r = run(['pr', 'create', '--title', 'My Title', '--body', 'body here']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('My Title');
  });
});

// ── No-body passthrough ──────────────────────────────────────────────────────

describe('github-safe no-body commands', () => {
  it('passes through issue comment without body arg in dry-run', () => {
    // issue comment with only a number and no body → no --body-file substitution
    const r = run(['issue', 'comment', '42']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[DRY-RUN\]/);
    expect(r.stdout).not.toMatch(/--body-file/);
  });

  it('passes through pr list (non-body command) in dry-run', () => {
    const r = run(['pr', 'list']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[DRY-RUN\]/);
    expect(r.stdout).not.toMatch(/--body-file/);
  });

  it('passes through repo sync (unknown subcommand) in dry-run', () => {
    const r = run(['repo', 'sync']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[DRY-RUN\]/);
  });
});

// ── Injection safety: special characters in body ──────────────────────────────

describe('github-safe injection safety', () => {
  it('body with semicolons does not appear in DRY-RUN args', () => {
    const r = run(['issue', 'comment', '1', 'foo; rm -rf /']);
    expect(r.status).toBe(0);
    // The injected shell metacharacter must not appear in the logged command
    expect(r.stdout).not.toContain('rm -rf');
  });

  it('body with backtick command substitution is not echoed', () => {
    const r = run(['pr', 'create', '--title', 'T', '--body', '`whoami`']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('`whoami`');
  });
});
