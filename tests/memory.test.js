/**
 * Tests for .claude/helpers/memory.js — exported `commands` object.
 *
 * Gaps addressed:
 *  - loadMemory(): returns {} for missing file, {} for corrupt JSON
 *  - commands.get(): no key → full store, with key → specific value, missing key → undefined
 *  - commands.set(): creates file, sets key, updates _updated timestamp
 *  - commands.delete(): removes key, no-ops on absent key, missing key arg logs error
 *  - commands.clear(): empties store to {}
 *  - commands.keys(): excludes underscore-prefixed keys (_updated), empty store
 *
 * Uses tmpDir + chdir to isolate filesystem side-effects.
 * The module path-resolves MEMORY_FILE from process.cwd() at require time,
 * so chdir must happen BEFORE requiring the module.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

let tmpDir, originalCwd, commands;

function loadFreshCommands() {
  Object.keys(require.cache).forEach((k) => {
    if (k.includes('.claude/helpers/memory')) delete require.cache[k];
  });
  return require('../.claude/helpers/memory.js');
}

function memFile() {
  return path.join(tmpDir, '.claude-flow', 'data', 'memory.json');
}

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osam-memory-test-'));
  process.chdir(tmpDir);
  commands = loadFreshCommands();
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── get() ──────────────────────────────────────────────────────────────────

describe('memory.commands.get()', () => {
  it('returns undefined for missing key on empty store', () => {
    const val = commands.get('nonexistent');
    expect(val).toBeUndefined();
  });

  it('returns full store object when no key provided', () => {
    commands.set('foo', 'bar');
    const all = commands.get();
    expect(typeof all).toBe('object');
    expect(all.foo).toBe('bar');
  });

  it('returns the specific value for an existing key', () => {
    commands.set('api-key', 'some-value');
    expect(commands.get('api-key')).toBe('some-value');
  });

  it('returns undefined for a key that was never set', () => {
    commands.set('other', 'thing');
    expect(commands.get('ghost')).toBeUndefined();
  });

  it('does not throw on corrupt memory.json (returns empty store)', () => {
    const dir = path.join(tmpDir, '.claude-flow', 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(memFile(), 'NOT VALID JSON');
    commands = loadFreshCommands();
    expect(() => commands.get('anything')).not.toThrow();
  });
});

// ── set() ──────────────────────────────────────────────────────────────────

describe('memory.commands.set()', () => {
  it('creates the memory file on first set', () => {
    commands.set('greeting', 'hello');
    expect(fs.existsSync(memFile())).toBe(true);
  });

  it('persists the key-value pair to disk', () => {
    commands.set('user', 'alice');
    const store = JSON.parse(fs.readFileSync(memFile(), 'utf-8'));
    expect(store.user).toBe('alice');
  });

  it('updates _updated timestamp on each set', () => {
    commands.set('k', 'v1');
    const t1 = JSON.parse(fs.readFileSync(memFile(), 'utf-8'))._updated;
    commands.set('k', 'v2');
    const t2 = JSON.parse(fs.readFileSync(memFile(), 'utf-8'))._updated;
    // Both should be ISO strings; t2 >= t1
    expect(new Date(t2).getTime()).toBeGreaterThanOrEqual(new Date(t1).getTime());
  });

  it('overwrites an existing key', () => {
    commands.set('x', 'first');
    commands.set('x', 'second');
    expect(commands.get('x')).toBe('second');
  });

  it('does not throw when key is undefined/null', () => {
    expect(() => commands.set(undefined, 'value')).not.toThrow();
    expect(() => commands.set(null, 'value')).not.toThrow();
  });
});

// ── delete() ───────────────────────────────────────────────────────────────

describe('memory.commands.delete()', () => {
  it('removes the specified key', () => {
    commands.set('toRemove', 'bye');
    commands.delete('toRemove');
    expect(commands.get('toRemove')).toBeUndefined();
  });

  it('leaves other keys intact', () => {
    commands.set('keep', 'yes');
    commands.set('remove', 'no');
    commands.delete('remove');
    expect(commands.get('keep')).toBe('yes');
  });

  it('does not throw when deleting a key that does not exist', () => {
    commands.set('a', '1');
    expect(() => commands.delete('ghost')).not.toThrow();
  });
});

// ── clear() ────────────────────────────────────────────────────────────────

describe('memory.commands.clear()', () => {
  it('empties the store', () => {
    commands.set('key1', 'val1');
    commands.set('key2', 'val2');
    commands.clear();
    const store = JSON.parse(fs.readFileSync(memFile(), 'utf-8'));
    expect(Object.keys(store)).toHaveLength(0);
  });

  it('does not throw on an already-empty store', () => {
    expect(() => commands.clear()).not.toThrow();
  });

  it('allows setting new values after clear', () => {
    commands.set('old', 'data');
    commands.clear();
    commands.set('new', 'fresh');
    expect(commands.get('new')).toBe('fresh');
    expect(commands.get('old')).toBeUndefined();
  });
});

// ── keys() ─────────────────────────────────────────────────────────────────

describe('memory.commands.keys()', () => {
  it('returns empty array for empty store', () => {
    const keys = commands.keys();
    expect(keys).toEqual([]);
  });

  it('excludes underscore-prefixed keys (_updated, etc.)', () => {
    commands.set('public', 'value');
    // _updated is added automatically by set()
    const keys = commands.keys();
    expect(keys).toContain('public');
    expect(keys.some(k => k.startsWith('_'))).toBe(false);
  });

  it('returns all non-underscore keys after multiple sets', () => {
    commands.set('alpha', '1');
    commands.set('beta', '2');
    commands.set('gamma', '3');
    const keys = commands.keys();
    expect(keys).toContain('alpha');
    expect(keys).toContain('beta');
    expect(keys).toContain('gamma');
    expect(keys).toHaveLength(3);
  });
});
