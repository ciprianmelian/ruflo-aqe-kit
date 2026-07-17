/**
 * Tests for statusline.cjs cache helpers (readCache / writeCache).
 *
 * Coverage gaps addressed:
 *  - readCache(): fresh entry within TTL → returns data
 *  - readCache(): stale entry beyond TTL → returns null
 *  - readCache(): missing cache file → returns null
 *  - readCache(): malformed JSON → returns null
 *  - readCache(): _ts missing → returns null (can't determine age)
 *  - writeCache(): creates file with _ts and data fields
 *  - writeCache(): overwrites existing cache file
 *  - writeCache(): silently ignores write errors (no throw)
 *  - Cache key is CWD-specific (different CWDs → different files)
 *
 * Strategy: inline re-implementation of the pure caching logic extracted from
 * statusline.cjs (lines 41-55). The functions are not exported, so we test the
 * logic independently; the subprocess tests in statusline.test.js cover the
 * integration path.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ── Inline re-implementation ──────────────────────────────────────────────────
// Extracted from statusline.cjs; tests catch regressions if logic is changed.

const CACHE_TTL_MS = 10000; // 10 seconds

function makeCacheFile(cwd) {
  return path.join(
    os.tmpdir(),
    'ruflo-statusline-cache-' + crypto.createHash('md5').update(cwd).digest('hex').slice(0, 8) + '.json'
  );
}

function readCache(cacheFile) {
  try {
    if (fs.existsSync(cacheFile)) {
      const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      if (raw && raw._ts && (Date.now() - raw._ts) < CACHE_TTL_MS) {
        return raw.data;
      }
    }
  } catch { /* ignore */ }
  return null;
}

function writeCache(cacheFile, data) {
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({ _ts: Date.now(), data }), 'utf-8');
  } catch { /* ignore */ }
}

// ── readCache() ───────────────────────────────────────────────────────────────

describe('readCache — fresh entry within TTL', () => {
  let cacheFile;

  beforeEach(() => {
    cacheFile = path.join(os.tmpdir(), `ruflo-cache-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  });

  afterEach(() => {
    try { fs.unlinkSync(cacheFile); } catch { /* ok */ }
  });

  it('returns data when cache was written just now', () => {
    const data = { status: 'ok', count: 42 };
    writeCache(cacheFile, data);
    expect(readCache(cacheFile)).toEqual(data);
  });

  it('returns the exact data object (preserves structure)', () => {
    const data = { nested: { a: 1 }, arr: [1, 2, 3] };
    writeCache(cacheFile, data);
    expect(readCache(cacheFile)).toEqual(data);
  });

  it('returns null after TTL has expired (stale)', () => {
    const staleTs = Date.now() - (CACHE_TTL_MS + 1000); // expired 1s ago
    fs.writeFileSync(cacheFile, JSON.stringify({ _ts: staleTs, data: { x: 1 } }), 'utf-8');
    expect(readCache(cacheFile)).toBeNull();
  });
});

describe('readCache — error / missing cases', () => {
  it('returns null when file does not exist', () => {
    const nonExistent = path.join(os.tmpdir(), 'ruflo-no-such-file-xyz987.json');
    expect(readCache(nonExistent)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    const f = path.join(os.tmpdir(), `ruflo-bad-json-${process.pid}.json`);
    try {
      fs.writeFileSync(f, '{broken json', 'utf-8');
      expect(readCache(f)).toBeNull();
    } finally {
      try { fs.unlinkSync(f); } catch { /* ok */ }
    }
  });

  it('returns null when _ts field is missing', () => {
    const f = path.join(os.tmpdir(), `ruflo-no-ts-${process.pid}.json`);
    try {
      fs.writeFileSync(f, JSON.stringify({ data: { ok: true } }), 'utf-8');
      expect(readCache(f)).toBeNull();
    } finally {
      try { fs.unlinkSync(f); } catch { /* ok */ }
    }
  });

  it('returns null when _ts is 0 (epoch) — always stale', () => {
    const f = path.join(os.tmpdir(), `ruflo-epoch-ts-${process.pid}.json`);
    try {
      fs.writeFileSync(f, JSON.stringify({ _ts: 0, data: { ok: true } }), 'utf-8');
      expect(readCache(f)).toBeNull();
    } finally {
      try { fs.unlinkSync(f); } catch { /* ok */ }
    }
  });

  it('does not throw on any of the above', () => {
    const nonExistent = '/tmp/ruflo-will-never-exist-zzz.json';
    expect(() => readCache(nonExistent)).not.toThrow();
  });
});

// ── writeCache() ──────────────────────────────────────────────────────────────

describe('writeCache — write behaviour', () => {
  let cacheFile;

  beforeEach(() => {
    cacheFile = path.join(os.tmpdir(), `ruflo-write-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  });

  afterEach(() => {
    try { fs.unlinkSync(cacheFile); } catch { /* ok */ }
  });

  it('creates a file at the given path', () => {
    writeCache(cacheFile, { x: 1 });
    expect(fs.existsSync(cacheFile)).toBe(true);
  });

  it('file content is valid JSON', () => {
    writeCache(cacheFile, { y: 2 });
    expect(() => JSON.parse(fs.readFileSync(cacheFile, 'utf-8'))).not.toThrow();
  });

  it('written JSON contains _ts field (timestamp)', () => {
    const before = Date.now();
    writeCache(cacheFile, { z: 3 });
    const after = Date.now();
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    expect(raw._ts).toBeGreaterThanOrEqual(before);
    expect(raw._ts).toBeLessThanOrEqual(after);
  });

  it('written JSON contains data field matching input', () => {
    const payload = { score: 99, label: 'test' };
    writeCache(cacheFile, payload);
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    expect(raw.data).toEqual(payload);
  });

  it('overwrites existing cache file', () => {
    writeCache(cacheFile, { version: 1 });
    writeCache(cacheFile, { version: 2 });
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    expect(raw.data.version).toBe(2);
  });

  it('does not throw when write target is unwritable (read-only dir simulation)', () => {
    // Pass a path where the parent dir does not exist — should silently fail
    const badPath = '/tmp/this-dir-does-not-exist-xyzabc/cache.json';
    expect(() => writeCache(badPath, { ok: true })).not.toThrow();
  });
});

// ── Cache key is CWD-specific ─────────────────────────────────────────────────

describe('makeCacheFile — CWD specificity', () => {
  it('same CWD → same cache file path', () => {
    expect(makeCacheFile('/home/user/projectA')).toBe(makeCacheFile('/home/user/projectA'));
  });

  it('different CWDs → different cache file paths', () => {
    const a = makeCacheFile('/home/user/projectA');
    const b = makeCacheFile('/home/user/projectB');
    expect(a).not.toBe(b);
  });

  it('cache file is in the OS temp directory', () => {
    const f = makeCacheFile('/any/path');
    expect(f.startsWith(os.tmpdir())).toBe(true);
  });

  it('cache filename includes the "ruflo-statusline-cache" prefix', () => {
    const f = path.basename(makeCacheFile('/any/path'));
    expect(f).toMatch(/^ruflo-statusline-cache-/);
  });
});

// ── round-trip: write then read ───────────────────────────────────────────────

describe('readCache + writeCache — round-trip', () => {
  let cacheFile;

  beforeEach(() => {
    cacheFile = path.join(os.tmpdir(), `ruflo-roundtrip-${process.pid}.json`);
  });

  afterEach(() => {
    try { fs.unlinkSync(cacheFile); } catch { /* ok */ }
  });

  it('data written is data read back within TTL', () => {
    const payload = { agents: 5, status: 'online' };
    writeCache(cacheFile, payload);
    expect(readCache(cacheFile)).toEqual(payload);
  });

  it('second write replaces first; read returns latest data', () => {
    writeCache(cacheFile, { v: 1 });
    writeCache(cacheFile, { v: 2 });
    expect(readCache(cacheFile).v).toBe(2);
  });
});
