/**
 * Tests for ensure_agentdb_schema (lib/common.sh).
 *
 * Issue #4 gap #1, confirmed ephemeral in the field: the standalone agentdb MCP
 * store boots in-memory (sql.js) and loses its schema on every session restart
 * unless ./agentdb.db holds the schema on disk. The MCP `agentdb_init` tool only
 * writes the server's memory; the CLI `agentdb init` writes the FILE. This fn
 * idempotently ensures the on-disk schema exists so db_stats survives restarts.
 *
 * Strategy: source common.sh and run the fn against throwaway temp dirs. The
 * INITIALIZED case shells out to the real `agentdb` CLI (a few seconds).
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const COMMON = path.resolve(__dirname, '..', 'lib', 'common.sh');
const hasAgentdb = spawnSync('bash', ['-lc', 'command -v agentdb'], { encoding: 'utf8' }).status === 0;

// Run ensure_agentdb_schema. DRY_RUN / a stripped PATH are injected as command
// prefixes (common.sh resets DRY_RUN at source; a prefix survives that).
function ensure(target, { dryRun = false, noCli = false } = {}) {
  const pre = [dryRun ? 'DRY_RUN=1' : '', noCli ? 'PATH=/usr/bin:/bin' : ''].filter(Boolean).join(' ');
  const r = spawnSync('bash', ['-c',
    `source "${COMMON}"; ${pre ? pre + ' ' : ''}ensure_agentdb_schema "${target}"`],
    { encoding: 'utf8', timeout: 30000 });
  return { code: r.status, out: r.stdout.trim() };
}
function mkdtemp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'adb-')); }

describe('ensure_agentdb_schema: guards', () => {
  it('NO_DIR when the target does not exist', () => {
    expect(ensure(path.join(os.tmpdir(), 'nope-' + process.pid)).out).toBe('NO_DIR');
  });

  it('PRESENT (and untouched) when agentdb.db is already non-empty', () => {
    const d = mkdtemp();
    fs.writeFileSync(path.join(d, 'agentdb.db'), 'EXISTING-DATA');
    expect(ensure(d).out).toBe('PRESENT');
    expect(fs.readFileSync(path.join(d, 'agentdb.db'), 'utf8')).toBe('EXISTING-DATA'); // not wiped
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('DRYRUN writes nothing for a 0-byte/missing db', () => {
    const d = mkdtemp();
    expect(ensure(d, { dryRun: true }).out).toBe('DRYRUN');
    expect(fs.existsSync(path.join(d, 'agentdb.db'))).toBe(false);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('NO_CLI when the agentdb binary is not on PATH', () => {
    const d = mkdtemp();
    expect(ensure(d, { noCli: true }).out).toBe('NO_CLI');
    expect(fs.existsSync(path.join(d, 'agentdb.db'))).toBe(false);
    fs.rmSync(d, { recursive: true, force: true });
  });
});

(hasAgentdb ? describe : describe.skip)('ensure_agentdb_schema: real init (durable on-disk schema)', () => {
  it('INITIALIZES a missing db, then is idempotent (PRESENT) on re-run', () => {
    const d = mkdtemp();
    const db = path.join(d, 'agentdb.db');
    const first = ensure(d);
    expect(first.out).toBe('INITIALIZED');
    expect(fs.existsSync(db)).toBe(true);
    expect(fs.statSync(db).size).toBeGreaterThan(0);          // schema written to DISK (was the 0-byte symptom)
    expect(fs.readFileSync(db).slice(0, 16).toString()).toMatch(/^SQLite format 3/); // real sqlite file

    const sizeAfterInit = fs.statSync(db).size;
    const second = ensure(d);                                  // re-run must NOT wipe / re-init
    expect(second.out).toBe('PRESENT');
    expect(fs.statSync(db).size).toBe(sizeAfterInit);
    fs.rmSync(d, { recursive: true, force: true });
  }, 30000);
});
