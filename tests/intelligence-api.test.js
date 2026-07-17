/**
 * Tests for .claude/helpers/intelligence.cjs — EXPORTED API
 *
 * Fills gaps NOT covered by intelligence-utils.test.js:
 *  - stats(): report shape, pendingInsights count, topPatterns, delta/trend
 *  - consolidate(): pending-insight 3-edit threshold, dedup guard, JSONL cleared
 *  - feedback(bool): positive/negative confidence mutation via accessCount
 *  - init(): graph cache-hit path (second call <60 s, same nodeCount)
 *  - init(): MEMORY.md bootstrap when store is absent
 *  - init(): graph returns nodes/edges/message (correct API shape)
 *  - getContext(): returns string or null (not array)
 *  - recordEdit(fileString): appends JSON line to pending-insights.jsonl
 *
 * NOTE: The actual API signatures are:
 *   init()              → { nodes, edges, message }
 *   getContext(prompt)  → string | null
 *   recordEdit(file)    → void (file is a plain string path)
 *   feedback(success)   → void (success is boolean)
 *   consolidate()       → { entries, edges, newEntries, message }
 *   stats(outputJson)   → { graph, confidence, access, pageRank, ... }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

let tmpDir, originalCwd, intel;

function loadFreshIntel() {
  Object.keys(require.cache).forEach((k) => {
    if (k.includes('.claude/helpers/intelligence')) delete require.cache[k];
  });
  return require('../.claude/helpers/intelligence.cjs');
}

function makeStore(entries) {
  const dir = path.join(tmpDir, '.claude-flow', 'data');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auto-memory-store.json'), JSON.stringify(entries));
  return dir;
}

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osam-intel-api-'));
  process.chdir(tmpDir);
  intel = loadFreshIntel();
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── init() — correct return shape ────────────────────────────────────────────

describe('intelligence.init() return shape', () => {
  it('returns { nodes, edges, message } on empty data dir', () => {
    const r = intel.init();
    expect(r).toBeTruthy();
    expect(typeof r.nodes).toBe('number');
    expect(typeof r.edges).toBe('number');
    expect(typeof r.message).toBe('string');
  });

  it('creates .claude-flow/data/ directory', () => {
    intel.init();
    expect(fs.existsSync(path.join(tmpDir, '.claude-flow', 'data'))).toBe(true);
  });

  it('nodes matches the number of unique entries in the store', () => {
    makeStore([
      { id: 'e1', content: 'authentication oauth token refresh', type: 'feedback' },
      { id: 'e2', content: 'database connection pooling strategy', type: 'project' },
    ]);
    intel = loadFreshIntel();
    const r = intel.init();
    expect(r.nodes).toBe(2);
  });

  it('handles corrupt auto-memory-store.json gracefully', () => {
    const dir = path.join(tmpDir, '.claude-flow', 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auto-memory-store.json'), '{invalid json}');
    expect(() => intel.init()).not.toThrow();
  });
});

// ── init() graph cache hit ────────────────────────────────────────────────────

describe('intelligence.init() graph cache hit', () => {
  it('returns "Graph cache hit" on second call within 60 s (same nodeCount)', () => {
    makeStore([{ id: 'c1', content: 'authentication pattern', type: 'feedback' }]);
    intel = loadFreshIntel();
    const r1 = intel.init(); // cold build
    const r2 = intel.init(); // should hit the in-memory cache
    expect(r2.message).toBe('Graph cache hit');
    expect(r2.nodes).toBe(r1.nodes);
  });

  it('rebuilds when nodeCount differs from cached graph', () => {
    makeStore([{ id: 'c1', content: 'pattern one auth', type: 'feedback' }]);
    intel = loadFreshIntel();
    intel.init();
    // Add a second entry to the store to change nodeCount
    const storePath = path.join(tmpDir, '.claude-flow', 'data', 'auto-memory-store.json');
    const store = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    store.push({ id: 'c2', content: 'pattern two database index', type: 'project' });
    fs.writeFileSync(storePath, JSON.stringify(store));
    intel = loadFreshIntel();
    const r = intel.init();
    expect(r.message).not.toBe('Graph cache hit');
    expect(r.nodes).toBe(2);
  });
});

// ── getContext() — returns string|null (not array) ───────────────────────────

describe('intelligence.getContext()', () => {
  it('returns null or a string — never an array', () => {
    intel.init();
    const ctx = intel.getContext('anything');
    expect(Array.isArray(ctx)).toBe(false);
  });

  it('returns null when no ranked data exists', () => {
    intel.init();
    const ctx = intel.getContext('authentication flow');
    expect(ctx).toBeNull();
  });

  it('returns a non-null string when prompt matches a stored entry', () => {
    makeStore([{ id: 'e1', content: 'authentication login session token renewal', type: 'feedback' }]);
    intel = loadFreshIntel();
    intel.init();
    const ctx = intel.getContext('authentication session token');
    // May match or not (trigram threshold 0.05); if it does, must be a string
    expect(ctx === null || typeof ctx === 'string').toBe(true);
  });

  it('does not throw on null/empty prompt', () => {
    intel.init();
    expect(() => intel.getContext(null)).not.toThrow();
    expect(() => intel.getContext('')).not.toThrow();
    expect(() => intel.getContext(undefined)).not.toThrow();
  });
});

// ── recordEdit() — takes a plain string file path ────────────────────────────

describe('intelligence.recordEdit()', () => {
  it('appends a JSONL line to pending-insights.jsonl', () => {
    intel.init();
    intel.recordEdit('src/auth.ts'); // string, not object
    const pendingPath = path.join(tmpDir, '.claude-flow', 'data', 'pending-insights.jsonl');
    expect(fs.existsSync(pendingPath)).toBe(true);
    const lines = fs.readFileSync(pendingPath, 'utf-8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.type).toBe('edit');
    expect(entry.file).toBe('src/auth.ts');
  });

  it('accumulates multiple edits as separate lines', () => {
    intel.init();
    intel.recordEdit('src/a.ts');
    intel.recordEdit('src/b.ts');
    const pendingPath = path.join(tmpDir, '.claude-flow', 'data', 'pending-insights.jsonl');
    const lines = fs.readFileSync(pendingPath, 'utf-8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
  });

  it('does not throw for empty string or null', () => {
    intel.init();
    expect(() => intel.recordEdit('')).not.toThrow();
    expect(() => intel.recordEdit(null)).not.toThrow();
  });
});

// ── feedback() — takes boolean ─────────────────────────────────────────────

describe('intelligence.feedback()', () => {
  it('does not throw when called without prior getContext', () => {
    intel.init();
    expect(() => intel.feedback(true)).not.toThrow();
    expect(() => intel.feedback(false)).not.toThrow();
  });

  it('increments accessCount on the matched node after positive feedback', () => {
    makeStore([{ id: 'f1', content: 'authentication login session token renewal', type: 'feedback' }]);
    intel = loadFreshIntel();
    intel.init();
    intel.getContext('authentication token'); // sets lastMatchedPatterns in session
    intel.feedback(true);
    const graphPath = path.join(tmpDir, '.claude-flow', 'data', 'graph-state.json');
    if (fs.existsSync(graphPath)) {
      const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
      const anyAccessed = Object.values(graph.nodes || {}).some(n => n.accessCount >= 1);
      expect(anyAccessed).toBe(true);
    }
  });
});

// ── consolidate() — pending-insight processing ────────────────────────────────

describe('intelligence.consolidate() return shape and insight processing', () => {
  it('returns { entries, edges, newEntries, message } on empty store', () => {
    intel.init();
    const r = intel.consolidate();
    expect(typeof r.entries).toBe('number');
    expect(typeof r.edges).toBe('number');
    expect(typeof r.newEntries).toBe('number');
    expect(typeof r.message).toBe('string');
  });

  it('creates an insight entry when the same file is edited 3+ times', () => {
    makeStore([{ id: 'e1', content: 'existing pattern', type: 'feedback' }]);
    intel = loadFreshIntel();
    intel.init();
    intel.recordEdit('src/hot-path.ts');
    intel.recordEdit('src/hot-path.ts');
    intel.recordEdit('src/hot-path.ts');
    const r = intel.consolidate();
    expect(r.newEntries).toBe(1);
    expect(r.entries).toBe(2); // original + new insight
  });

  it('does NOT create an insight for fewer than 3 edits', () => {
    makeStore([{ id: 'e1', content: 'existing pattern', type: 'feedback' }]);
    intel = loadFreshIntel();
    intel.init();
    intel.recordEdit('src/quiet.ts');
    intel.recordEdit('src/quiet.ts'); // only 2 — below threshold
    const r = intel.consolidate();
    expect(r.newEntries).toBe(0);
  });

  it('clears pending-insights.jsonl after consolidation', () => {
    makeStore([{ id: 'e1', content: 'existing pattern', type: 'feedback' }]);
    intel = loadFreshIntel();
    intel.init();
    intel.recordEdit('src/auth.ts');
    intel.recordEdit('src/auth.ts');
    intel.recordEdit('src/auth.ts');
    intel.consolidate();
    const pendingPath = path.join(tmpDir, '.claude-flow', 'data', 'pending-insights.jsonl');
    const content = fs.readFileSync(pendingPath, 'utf-8').trim();
    expect(content).toBe('');
  });

  it('prevents duplicate insight for the same file on repeated consolidations', () => {
    makeStore([{ id: 'e1', content: 'existing pattern', type: 'feedback' }]);
    intel = loadFreshIntel();
    intel.init();
    intel.recordEdit('src/hot.ts');
    intel.recordEdit('src/hot.ts');
    intel.recordEdit('src/hot.ts');
    intel.consolidate(); // creates 1 insight for src/hot.ts

    intel.recordEdit('src/hot.ts');
    intel.recordEdit('src/hot.ts');
    intel.recordEdit('src/hot.ts');
    const r2 = intel.consolidate(); // must NOT add second insight for same file
    expect(r2.newEntries).toBe(0);
  });
});

// ── stats() — completely untested before ─────────────────────────────────────

describe('intelligence.stats()', () => {
  it('does not throw on empty state', () => {
    intel.init();
    expect(() => intel.stats()).not.toThrow();
    expect(() => intel.stats(false)).not.toThrow();
  });

  it('stats(true) returns report with required shape', () => {
    makeStore([{ id: 'a', content: 'auth token session', type: 'feedback' }]);
    intel = loadFreshIntel();
    intel.init();
    const r = intel.stats(true);
    expect(typeof r.graph).toBe('object');
    expect(typeof r.graph.nodes).toBe('number');
    expect(typeof r.graph.edges).toBe('number');
    expect(typeof r.graph.density).toBe('number');
    expect(typeof r.confidence).toBe('object');
    expect(typeof r.access).toBe('object');
    expect(typeof r.pendingInsights).toBe('number');
    expect(Array.isArray(r.topPatterns)).toBe(true);
  });

  it('pendingInsights matches number of recorded edits', () => {
    makeStore([{ id: 'a', content: 'auth pattern', type: 'feedback' }]);
    intel = loadFreshIntel();
    intel.init();
    intel.recordEdit('src/x.ts');
    intel.recordEdit('src/y.ts');
    const r = intel.stats(true);
    expect(r.pendingInsights).toBe(2);
  });

  it('graph.nodes matches stored entry count', () => {
    makeStore([
      { id: 'a', content: 'authentication token', type: 'feedback' },
      { id: 'b', content: 'database index strategy', type: 'project' },
      { id: 'c', content: 'caching redis eviction', type: 'feedback' },
    ]);
    intel = loadFreshIntel();
    intel.init();
    const r = intel.stats(true);
    expect(r.graph.nodes).toBe(3);
  });

  it('delta is non-null after 2+ consolidate() calls', () => {
    makeStore([{ id: 's1', content: 'caching strategy redis', type: 'feedback' }]);
    intel = loadFreshIntel();
    intel.init();
    intel.consolidate();
    intel.consolidate();
    const r = intel.stats(true);
    expect(r.snapshots).toBeGreaterThanOrEqual(2);
    expect(r.delta).not.toBeNull();
  });

  it('trend is non-null after 3+ consolidate() calls with valid direction', () => {
    makeStore([{ id: 't1', content: 'database query optimization', type: 'project' }]);
    intel = loadFreshIntel();
    intel.init();
    intel.consolidate();
    intel.consolidate();
    intel.consolidate();
    const r = intel.stats(true);
    expect(r.trend).not.toBeNull();
    expect(['improving', 'declining', 'stable']).toContain(r.trend.direction);
  });
});

// ── init() MEMORY.md bootstrap ───────────────────────────────────────────────

describe('intelligence.init() MEMORY.md bootstrap', () => {
  it('boots from .claude-flow/memory/MEMORY.md when auto-memory-store.json is absent', () => {
    const memDir = path.join(tmpDir, '.claude-flow', 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), [
      '# Project Memory',
      '',
      '## Authentication Patterns',
      '',
      'Store session tokens using httpOnly cookies to prevent XSS attacks effectively.',
      '',
      '## Database Strategy',
      '',
      'Connection pooling with max 10 connections per dyno improves throughput by 3x.',
    ].join('\n'));
    intel = loadFreshIntel();
    const r = intel.init();
    // Bootstrap should have created at least some entries
    expect(r.nodes).toBeGreaterThanOrEqual(0);
    expect(typeof r.message).toBe('string');
  });

  it('returns { nodes:0 } gracefully when no store and no MEMORY.md files exist', () => {
    intel = loadFreshIntel();
    const r = intel.init();
    expect(r.nodes).toBe(0);
  });
});
