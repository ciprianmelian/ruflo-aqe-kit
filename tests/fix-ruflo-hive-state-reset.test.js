/**
 * Tests for lib/fix-ruflo.sh Step 8 — HIVE-STATE-RESET-V1 (issue #7).
 *
 * THE DEFECT
 * ----------
 * The kit's ghost-worker reset wrote:
 *
 *   echo '{"queen":null,"workers":{},"consensus":{},"kvStore":{}}' > state.json
 *
 * `.claude-flow/hive-mind/state.json` is owned exclusively by the MCP
 * hive-mind_* handlers (@claude-flow/cli dist/src/mcp-tools/hive-mind-tools.js
 * is the only module in the entire dist that names HIVE_DIR), and its loader
 * merges NO defaults — if the file parses, it is used AS-IS:
 *
 *   function loadHiveState() {
 *       try { ... if (existsSync(path)) return JSON.parse(readFileSync(path)); }
 *       catch { }
 *       return {
 *           initialized: false,
 *           topology: 'mesh',
 *           workers: [],                                 // ARRAY
 *           consensus: { pending: [], history: [] },     // ARRAYS
 *           sharedMemory: {},                            // NOT "kvStore"
 *           createdAt: new Date().toISOString(),
 *           updatedAt: new Date().toISOString(),
 *       };
 *   }
 *
 * So `workers: {}` made every hive-mind_status call die with
 * `state.workers.map is not a function`, and it was PERMANENT: the old
 * ghost-count probe read 0 workers off that shape, so the reset never re-fired
 * to correct its own damage.
 *
 * THE FIX, AND WHY DELETE
 * -----------------------
 * The reset now REMOVES the file. loadHiveState() synthesises the correct
 * default when the file is absent and saveHiveState() mkdir -p's on the next
 * write, so deletion is self-maintaining — it cannot drift from upstream's
 * schema, whereas a hand-written literal must be re-verified against the dist
 * on every ruflo bump (which is precisely how this bug happened).
 *
 * TEST DESIGN
 * -----------
 * - The REAL block is extracted verbatim from lib/fix-ruflo.sh (between its
 *   HIVE-STATE-RESET-V1 BEGIN/END sentinels) and executed. Not a
 *   reimplementation: if the block changes, these tests follow it.
 * - Assertions are on the PROPERTY — "is the resulting state consumable by the
 *   handler?" — never on the presence of a string in the source. Where the
 *   installed ruflo is present the REAL `hive-mind_status` handler is driven
 *   (pointed at a fixture via CLAUDE_FLOW_CWD, which is how getProjectCwd()
 *   resolves); where it is not, an equivalent harness transcribed from the
 *   handler body stands in, and a drift test asserts the transcription still
 *   matches the installed dist.
 * - Every negative assertion has a positive control on the same harness.
 * - The pre-fix baseline is read at a PINNED SHA (never HEAD, which becomes
 *   the fixed code the moment this lands), with an embedded literal fallback.
 */
'use strict';

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const FIX_RUFLO = path.join(REPO, 'lib', 'fix-ruflo.sh');

// ── the pre-fix baseline ────────────────────────────────────────────────────
// fbcff73 is Patch 71 — a fixed point in history that predates this fix and
// stays the correct "before" no matter what lands on top. HEAD would silently
// become the FIXED code the instant this commit exists, turning every TEETH
// assertion below into a tautology.
const PRE_FIX_REF = 'fbcff73';

// Literal fallback for environments without the git history (shallow clone,
// exported tarball). Byte-identical to what PRE_FIX_REF's fix-ruflo.sh echoes.
const PRE_FIX_STATE_LITERAL = '{"queen":null,"workers":{},"consensus":{},"kvStore":{}}';

function preFixState() {
  try {
    const src = execFileSync('git', ['show', `${PRE_FIX_REF}:lib/fix-ruflo.sh`], {
      cwd: REPO, encoding: 'utf8',
    });
    const m = src.match(/echo '(\{"queen".*?\})' > "\$CF_DIR\/hive-mind\/state\.json"/);
    if (m) return { json: m[1], fromGit: true };
  } catch (e) { /* fall through to the literal */ }
  return { json: PRE_FIX_STATE_LITERAL, fromGit: false };
}

// ── the upstream contract, and a consumer that exercises it ─────────────────
const RUFLO_DIST = (() => {
  let root;
  try {
    root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  } catch (e) { return null; }
  const p = path.join(root, 'ruflo', 'node_modules', '@claude-flow', 'cli',
    'dist', 'src', 'mcp-tools', 'hive-mind-tools.js');
  return fs.existsSync(p) ? p : null;
})();

/**
 * Mirrors loadHiveState() — file present => parse it as-is (NO default merge,
 * which is the whole bug); file absent or unparseable => upstream's default.
 */
function loadLikeUpstream(targetDir) {
  const p = path.join(targetDir, '.claude-flow', 'hive-mind', 'state.json');
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) { /* upstream swallows too */ }
  return {
    initialized: false,
    topology: 'mesh',
    workers: [],
    consensus: { pending: [], history: [] },
    sharedMemory: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * The state-consuming expressions of hive-mind_status's handler, transcribed
 * from ruflo 3.34.0 (dist/src/mcp-tools/hive-mind-tools.js, the `const status
 * = {...}` literal). Decoration that does not touch `state` (task store, agent
 * store) is omitted. `driftGuard` below asserts this stays faithful.
 */
function consumeAsStatusHandler(state) {
  return {
    workers: state.workers.map((w) => ({ id: w })),
    workerCount: state.workers.length,
    consensusRounds: state.consensus.history.length,
    pendingConsensus: state.consensus.pending.length,
    sharedMemoryKeys: Object.keys(state.sharedMemory).length,
  };
}

/** Drives the REAL installed handler against `targetDir`. Returns {ok, err}. */
function runRealStatusHandler(targetDir) {
  const script = `
    const m = await import(${JSON.stringify(RUFLO_DIST)});
    const t = m.hiveMindTools.find((x) => x.name === 'hive-mind_status');
    if (!t) { console.log(JSON.stringify({ ok: false, err: 'tool not found' })); }
    else {
      try {
        const r = await t.handler({ verbose: true });
        console.log(JSON.stringify({ ok: true, workersIsArray: Array.isArray(r.workers),
          workerCount: r.workerCount, sharedMemoryKeys: r.sharedMemoryKeys,
          pendingConsensus: r.pendingConsensus, status: r.status }));
      } catch (e) {
        console.log(JSON.stringify({ ok: false, err: String(e && e.message) }));
      }
    }
  `;
  const r = spawnSync('node', ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_FLOW_CWD: targetDir },
    timeout: 60000,
  });
  const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
  if (!line) return { ok: false, err: `no output (rc=${r.status}): ${r.stderr}` };
  return JSON.parse(line);
}

// ── running the REAL reset block out of lib/fix-ruflo.sh ────────────────────
function extractResetBlock() {
  const src = fs.readFileSync(FIX_RUFLO, 'utf8');
  const b = src.indexOf('# HIVE-STATE-RESET-V1 BEGIN');
  const e = src.indexOf('# HIVE-STATE-RESET-V1 END');
  if (b < 0 || e < 0) throw new Error('HIVE-STATE-RESET-V1 sentinels not found in lib/fix-ruflo.sh');
  return src.slice(b, e + '# HIVE-STATE-RESET-V1 END'.length);
}

function runResetBlock(targetDir, { dryRun = 0, pathOverride = null } = {}) {
  const script = [
    'set -uo pipefail',
    'info() { echo "INFO $1"; }',
    'pass() { echo "PASS $1"; }',
    'warn() { echo "WARN $1"; }',
    'fix()  { echo "FIX $1"; }',
    `CF_DIR=${JSON.stringify(path.join(targetDir, '.claude-flow'))}`,
    `DRY_RUN=${dryRun}`,
    extractResetBlock(),
  ].join('\n');
  const env = { ...process.env };
  if (pathOverride !== null) env.PATH = pathOverride;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env, timeout: 60000 });
  return { rc: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// ── fixtures ────────────────────────────────────────────────────────────────
const tmps = [];
function mkTarget() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-hive-'));
  tmps.push(d);
  fs.mkdirSync(path.join(d, '.claude-flow', 'hive-mind'), { recursive: true });
  return d;
}
function statePath(d) { return path.join(d, '.claude-flow', 'hive-mind', 'state.json'); }
function writeState(d, obj) {
  fs.writeFileSync(statePath(d), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
}
/** A CONTRACT-SHAPED state with n workers — what upstream itself would write. */
function contractState(n) {
  return {
    initialized: true,
    topology: 'hierarchical-mesh',
    queen: { agentId: 'queen-1', electedAt: '2026-01-01T00:00:00.000Z', term: 1 },
    workers: Array.from({ length: n }, (_, i) => `worker-${i}`),
    consensus: { pending: [], history: [] },
    sharedMemory: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

afterAll(() => {
  for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
});

// ═══════════════════════════════════════════════════════════════════════════
suite('HIVE-STATE-RESET-V1 — harness integrity (guards every test below)', () => {
  it('extracts a syntactically valid block from lib/fix-ruflo.sh', () => {
    // Without this, a botched extraction yields bash rc 2 and every
    // "the file was not touched" assertion passes for the wrong reason.
    const block = extractResetBlock();
    expect(block).toMatch(/HIVE-STATE-RESET-V1 BEGIN/);
    expect(block).toMatch(/HIVE-STATE-RESET-V1 END$/);
    expect(spawnSync('bash', ['-n', '-c', block], { encoding: 'utf8' }).status).toBe(0);
  });

  it('POSITIVE CONTROL: the consumer accepts upstream\'s own default state', () => {
    // If this ever fails, the "throws" assertions below prove nothing.
    const empty = mkTarget();
    fs.rmSync(statePath(empty), { force: true });
    const out = consumeAsStatusHandler(loadLikeUpstream(empty));
    expect(out.workers).toEqual([]);
    expect(out.workerCount).toBe(0);
    expect(out.sharedMemoryKeys).toBe(0);
  });

  it('TEETH: the pre-fix state literal is NOT consumable — this is issue #7', () => {
    const { json } = preFixState();
    expect(json).toBe(PRE_FIX_STATE_LITERAL); // git and the literal agree
    expect(() => consumeAsStatusHandler(JSON.parse(json)))
      .toThrow(/workers\.map is not a function/);
  });
});

suite('HIVE-STATE-RESET-V1 — the reset yields CONSUMABLE state', () => {
  it('clears a ghost-worker state, and what remains loads as the upstream default', () => {
    const t = mkTarget();
    writeState(t, contractState(25));

    const { rc, out } = runResetBlock(t);

    expect(rc).toBe(0);
    expect(out).toMatch(/INFO hive-mind has 25 ghost workers/);
    expect(out).toMatch(/^FIX /m);
    expect(fs.existsSync(statePath(t))).toBe(false);

    // The property, not the string: is the post-reset state consumable?
    const state = loadLikeUpstream(t);
    expect(Array.isArray(state.workers)).toBe(true);
    expect(Array.isArray(state.consensus.pending)).toBe(true);
    expect(Array.isArray(state.consensus.history)).toBe(true);
    expect(state.sharedMemory).toBeTypeOf('object');
    expect(Array.isArray(state.sharedMemory)).toBe(false);
    expect(() => consumeAsStatusHandler(state)).not.toThrow();
    expect(consumeAsStatusHandler(state).workerCount).toBe(0);
  });

  it('HEALS an already-poisoned state file — the recurrence in issue #7', () => {
    // A target reset by the OLD code carries the broken shape with 0 "workers".
    // The old ghost-count probe (Object.keys(d.workers||{}).length) reads 0 off
    // it, so the old reset could never fire again: broken forever.
    const t = mkTarget();
    writeState(t, preFixState().json);

    const oldProbe = JSON.parse(spawnSync('node', ['-e',
      'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));' +
      'console.log(JSON.stringify(Object.keys(d.workers||{}).length))',
      statePath(t)], { encoding: 'utf8' }).stdout.trim());
    expect(oldProbe).toBe(0);        // <= 20, so the old code would do nothing
    expect(() => consumeAsStatusHandler(loadLikeUpstream(t)))
      .toThrow(/workers\.map is not a function/);   // ...while it stays broken

    const { rc, out } = runResetBlock(t);

    expect(rc).toBe(0);
    expect(out).toMatch(/off the hive-mind_status contract/);
    expect(fs.existsSync(statePath(t))).toBe(false);
    expect(() => consumeAsStatusHandler(loadLikeUpstream(t))).not.toThrow();
  });

  it('leaves a healthy contract-shaped state byte-identical (no over-eager delete)', () => {
    // Positive control against an implementation that just deletes everything.
    const t = mkTarget();
    writeState(t, contractState(3));
    const before = fs.readFileSync(statePath(t));

    const { rc, out } = runResetBlock(t);

    expect(rc).toBe(0);
    expect(out).toMatch(/PASS hive-mind state OK \(3 workers\)/);
    expect(fs.readFileSync(statePath(t))).toEqual(before);
  });

  it('reports a clean pass when there is no state file at all', () => {
    const t = mkTarget();
    fs.rmSync(statePath(t), { force: true });
    const { rc, out } = runResetBlock(t);
    expect(rc).toBe(0);
    expect(out).toMatch(/PASS No hive-mind state \(clean\)/);
  });

  it('is IDEMPOTENT: a second run is a clean no-op, not an error', () => {
    const t = mkTarget();
    writeState(t, contractState(25));

    const first = runResetBlock(t);
    const second = runResetBlock(t);

    expect(first.rc).toBe(0);
    expect(second.rc).toBe(0);
    expect(second.out).toMatch(/PASS No hive-mind state \(clean\)/);
    expect(second.out).not.toMatch(/^FIX /m);
    expect(() => consumeAsStatusHandler(loadLikeUpstream(t))).not.toThrow();
  });

  it('DRY-RUN mutates nothing and says what it would do', () => {
    const t = mkTarget();
    writeState(t, contractState(25));
    const before = fs.readFileSync(statePath(t));

    const { rc, out } = runResetBlock(t, { dryRun: 1 });

    expect(rc).toBe(0);
    expect(out).toMatch(/\[dry-run\] Would: remove hive-mind\/state\.json/);
    expect(out).not.toMatch(/^FIX /m);
    expect(fs.existsSync(statePath(t))).toBe(true);
    expect(fs.readFileSync(statePath(t))).toEqual(before);
  });

  it('NOT ASSESSABLE (no node) leaves the file alone instead of deleting it', () => {
    // The third state the kit keeps re-learning it needs: "could not tell" is
    // not "broken". Without it, a host without node would lose a good state
    // file, because an unrunnable probe reads exactly like a corrupt one.
    const noNodePath = '/usr/bin:/bin';
    expect(spawnSync('bash', ['-c', 'command -v node'],
      { encoding: 'utf8', env: { ...process.env, PATH: noNodePath } }).status).not.toBe(0);

    const t = mkTarget();
    writeState(t, contractState(25));           // would otherwise be cleared
    const before = fs.readFileSync(statePath(t));

    const { rc, out } = runResetBlock(t, { pathOverride: noNodePath });

    expect(rc).toBe(0);
    expect(out).toMatch(/WARN hive-mind state NOT ASSESSABLE/);
    expect(fs.readFileSync(statePath(t))).toEqual(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Everything below drives the REAL installed handler. Skipped — loudly, with
// the reason recorded — when ruflo is not installed on this host.
const withDist = RUFLO_DIST ? suite : suite.skip;

withDist('HIVE-STATE-RESET-V1 — against the REAL installed hive-mind_status', () => {
  it('TEETH: the pre-fix state makes the real handler throw the issue-#7 error', () => {
    const t = mkTarget();
    writeState(t, preFixState().json);
    const r = runRealStatusHandler(t);
    expect(r.ok).toBe(false);
    expect(r.err).toMatch(/state\.workers\.map is not a function/);
  });

  it('POSITIVE CONTROL: a contract-shaped state makes the real handler succeed', () => {
    const t = mkTarget();
    writeState(t, contractState(3));
    const r = runRealStatusHandler(t);
    expect(r.ok).toBe(true);
    expect(r.workersIsArray).toBe(true);
    expect(r.workerCount).toBe(3);
  });

  it('after the REAL reset block runs, the REAL handler answers cleanly', () => {
    const t = mkTarget();
    writeState(t, contractState(25));

    const { rc } = runResetBlock(t);
    expect(rc).toBe(0);

    const r = runRealStatusHandler(t);
    expect(r.ok).toBe(true);
    expect(r.workersIsArray).toBe(true);
    expect(r.workerCount).toBe(0);
    expect(r.sharedMemoryKeys).toBe(0);
    expect(r.pendingConsensus).toBe(0);
    expect(r.status).toBe('offline');   // == "reset to empty state"
  });

  it('DRIFT GUARD: the installed loadHiveState() default still has this shape', () => {
    // The transcription in consumeAsStatusHandler()/loadLikeUpstream() above is
    // the only hand-written copy of upstream's schema left in this repo (the
    // fix itself carries none — it deletes). If a ruflo bump changes the
    // default, this fails and points at what to re-read.
    const src = fs.readFileSync(RUFLO_DIST, 'utf8');
    const m = src.match(/function loadHiveState\(\)[\s\S]*?\n\}/);
    expect(m).toBeTruthy();
    const fn = m[0];
    expect(fn).toMatch(/workers:\s*\[\]/);
    expect(fn).toMatch(/consensus:\s*\{\s*pending:\s*\[\],\s*history:\s*\[\]\s*\}/);
    expect(fn).toMatch(/sharedMemory:\s*\{\}/);
    expect(fn).toMatch(/initialized:\s*false/);
    expect(fn).toMatch(/topology:/);
    expect(fn).toMatch(/createdAt:/);
    expect(fn).toMatch(/updatedAt:/);
    // And the field the kit used to invent is still nowhere in the module.
    expect(src).not.toMatch(/kvStore/);
  });

  it('DRIFT GUARD: the handler still consumes state exactly as transcribed', () => {
    const src = fs.readFileSync(RUFLO_DIST, 'utf8');
    expect(src).toMatch(/state\.workers\.map\(/);
    expect(src).toMatch(/state\.workers\.length/);
    expect(src).toMatch(/state\.consensus\.history\.length/);
    expect(src).toMatch(/state\.consensus\.pending\.length/);
    expect(src).toMatch(/Object\.keys\(state\.sharedMemory\)/);
  });
});
