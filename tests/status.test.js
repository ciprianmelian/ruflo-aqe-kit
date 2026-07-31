/**
 * Tests for lib/status.sh — the read-only `ruflo-kit status` porcelain.
 *
 * status.sh is disk-derived and read-only, so these run the REAL script (fast,
 * no mutation). They assert the three contracts the porcelain promises:
 *   1. exit 0 ALWAYS (status is a report, not a gate) — even on an empty target.
 *   2. --json is ALWAYS valid JSON with the documented top-level shape, even
 *      when nothing is installed in the target (agentic-kit's contract).
 *   3. the daemon field reflects `pgrep` truth, not a state file.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATUS = path.resolve(__dirname, '..', 'lib', 'status.sh');
const REPO = path.resolve(__dirname, '..');

// Real, on-disk stand-in for "a different project's workspace" in the OTHER
// fixture below. DAEMON-HINT-SCOPE-V1 round 2: kit_daemon_scope_split now
// compares filesystem IDENTITY (dev, ino via fs.statSync), not path strings —
// a fictional --workspace path that doesn't exist on disk can no longer be
// told apart from "present but un-stat-able" and correctly classifies
// UNKNOWN rather than OTHER (the honest behavior the fix intends). A real
// directory is required to actually exercise the OTHER bucket, matching
// production, where the foreign daemon's workspace always exists on disk.
const FOREIGN_WORKSPACE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-project-')));
afterAll(() => fs.rmSync(FOREIGN_WORKSPACE, { recursive: true, force: true }));

function run(target, args = []) {
  const r = spawnSync('bash', [STATUS, target, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function mkEmptyTarget() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'status-'));
}

const TOP_KEYS = ['kit', 'globals', 'sentinels', 'daemon', 'mcp', 'learning', 'config'];

describe('status.sh: exit code contract', () => {
  it('exits 0 on an empty fixture target (human mode)', () => {
    const d = mkEmptyTarget();
    try {
      expect(run(d).code).toBe(0);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('exits 0 on this repo (human mode)', () => {
    expect(run(REPO).code).toBe(0);
  });

  it('exits 0 in --json mode', () => {
    expect(run(REPO, ['--json']).code).toBe(0);
  });
});

describe('status.sh --json: always-valid machine shape', () => {
  it('parses as JSON on an empty fixture (nothing installed in target)', () => {
    const d = mkEmptyTarget();
    try {
      const { out } = run(d, ['--json']);
      const parsed = JSON.parse(out); // throws if invalid → fails the test
      expect(TOP_KEYS.every((k) => k in parsed)).toBe(true);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('parses as JSON on this repo and has every top-level key', () => {
    const { out } = run(REPO, ['--json']);
    const parsed = JSON.parse(out);
    for (const k of TOP_KEYS) expect(parsed).toHaveProperty(k);
  });

  it('empty target still yields learning counts as null (not a crash) with valid shape', () => {
    const d = mkEmptyTarget();
    try {
      const parsed = JSON.parse(run(d, ['--json']).out);
      expect(parsed.learning.episodes).toBeNull();
      expect(Array.isArray(parsed.mcp.servers)).toBe(true);
      expect(parsed.mcp.servers).toHaveLength(0);
      expect(Array.isArray(parsed.daemon.pids)).toBe(true);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('sentinels block reports a present/total pair with an items array', () => {
    const parsed = JSON.parse(run(REPO, ['--json']).out);
    expect(typeof parsed.sentinels.present).toBe('number');
    expect(typeof parsed.sentinels.total).toBe('number');
    expect(Array.isArray(parsed.sentinels.items)).toBe(true);
    expect(parsed.sentinels.present).toBeLessThanOrEqual(parsed.sentinels.total);
  });
});

describe('status.sh: daemon field matches pgrep truth', () => {
  it('daemon.running reflects live pgrep truth (dual pattern, not a state file)', () => {
    // Oracle mirrors status.sh's dual pattern: the real daemon cmdline is
    // `node .../bin/cli.js daemon start` — 'ruflo daemon' alone never matches it
    // (the 2026-07-20 blindspot; the old single-pattern oracle shared it).
    const pgSnap = () => {
      const hit = (args) => {
        const pg = spawnSync('pgrep', args, { encoding: 'utf8' });
        return pg.status === 0 && pg.stdout.trim().length > 0;
      };
      return hit(['-f', 'bin/cli.js daemon start']) || hit(['-f', 'ruflo daemon']);
    };
    // Bracket the status call: a daemon can start/stop between two independent
    // pgrep snapshots (a real race in a multi-agent session), so only assert exact
    // pgrep equality when the state is STABLE across the call. Regardless, status.sh
    // must keep running↔pids internally consistent — that alone proves it derives the
    // field from pgrep output, not from a (lying) state file.
    const before = pgSnap();
    const parsed = JSON.parse(run(REPO, ['--json']).out);
    const after = pgSnap();
    expect(parsed.daemon.running).toBe(parsed.daemon.pids.length > 0);
    if (before === after) expect(parsed.daemon.running).toBe(before);
  });
});

// DAEMON-HINT-SCOPE-V1 scope-wording pin. status.sh's own detection
// (DAEMON_PIDS) stays real/unstubbed elsewhere in this file — this block
// specifically hermetic-stubs pgrep/ps to drive MINE vs OTHER deterministically
// (mirrors the stub convention in tests/verify-learning.test.js), because the
// property under test here is not "is a daemon detected" but "does a FOREIGN
// daemon get MINE's actionable phrasing" — something the host's real process
// table can't reliably exercise (this dev host's own stray daemon is a fixed,
// unstubbable OTHER case, not something we can flip to MINE on demand).
function mkPsScriptFor(entries) {
  const cases = entries.map(({ pid, line }) => `  ${pid}) echo "${line}" ;;`).join('\n');
  return [
    '#!/usr/bin/env bash',
    'pid=""; prev=""',
    'for a in "$@"; do',
    '  if [[ "$prev" == "-p" ]]; then pid="$a"; fi',
    '  prev="$a"',
    'done',
    'if [[ "$*" != *"etimes="* ]]; then exit 1; fi',
    'case "$pid" in',
    cases,
    '  *) exit 1 ;;',
    'esac',
  ].join('\n') + '\n';
}
function stubDaemonBin({ mode, target = '' } = {}) {
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'statusdaemonbin-'));
  const entries = [];
  if (mode === 'MINE') {
    if (!target) throw new Error("stubDaemonBin: mode 'MINE' requires a target dir");
    entries.push({ pid: 424242, line: `424242 60 node /fake/bin/cli.js daemon start --workspace ${target}` });
  } else if (mode === 'OTHER') {
    // Realistic shape mirroring the actual stray daemon this fix was
    // reproduced against on the dev host (a different project's workspace).
    // Points at FOREIGN_WORKSPACE — a REAL directory, required so the
    // identity-based classifier resolves it to OTHER rather than UNKNOWN.
    entries.push({
      pid: 313131,
      line: '313131 3600 node /g/ruflo/node_modules/@claude-flow/cli/bin/cli.js daemon start '
        + `--foreground --quiet --workspace ${FOREIGN_WORKSPACE}`,
    });
  }
  if (entries.length > 0) {
    const pids = entries.map((e) => e.pid).join(' ');
    fs.writeFileSync(path.join(b, 'pgrep'),
      `#!/usr/bin/env bash\ncase "$*" in\n  *"bin/cli.js daemon start"*) printf '%s\\n' ${pids} ;;\n  *) exit 1 ;;\nesac\n`);
    fs.writeFileSync(path.join(b, 'ps'), mkPsScriptFor(entries));
    fs.chmodSync(path.join(b, 'ps'), 0o755);
  } else {
    fs.writeFileSync(path.join(b, 'pgrep'), '#!/usr/bin/env bash\nexit 1\n');
  }
  fs.chmodSync(path.join(b, 'pgrep'), 0o755);
  return b;
}
function runStatusWithBin(target, bindir) {
  return spawnSync('bash', [STATUS, target], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bindir}:${process.env.PATH}` },
  });
}

describe('status.sh: daemon scope wording is distinguished, not just counted (DAEMON-HINT-SCOPE-V1)', () => {
  let target;
  beforeAll(() => { target = mkEmptyTarget(); });
  afterAll(() => fs.rmSync(target, { recursive: true, force: true }));

  it('MINE: a daemon for THIS target gets the actionable "stop with" claim', () => {
    const b = stubDaemonBin({ mode: 'MINE', target });
    const r = runStatusWithBin(target, b);
    fs.rmSync(b, { recursive: true, force: true });
    expect(r.stdout).toMatch(/running for THIS target/);
    expect(r.stdout).toMatch(/stop with: ruflo daemon stop/);
  });

  it('OTHER: a FOREIGN daemon must NOT receive MINE\'s phrasing — no "running for THIS target", no unconditional "stop with" claim', () => {
    const b = stubDaemonBin({ mode: 'OTHER', target });
    const r = runStatusWithBin(target, b);
    fs.rmSync(b, { recursive: true, force: true });
    expect(r.stdout).toMatch(/running for a DIFFERENT workspace/);
    expect(r.stdout).toMatch(/will NOT reach it/);
    // The actual pin: MINE's wording must be ABSENT, not just OTHER's present.
    expect(r.stdout).not.toMatch(/running for THIS target/);
    expect(r.stdout).not.toMatch(/stop with: ruflo daemon stop/);
  });

  // TEETH: reconstruct the PRE-FIX daemon section (the exact single-bucket
  // wording B24-DAEMON-SCOPE-V1 replaced — see lib/status.sh's own comment for
  // the literal before-text) in a SCRATCH directory that never touches any
  // tracked repo file — not even briefly. common.sh and tools/daemon-
  // staleness.cjs are copied alongside so kit_daemon_scope_split still
  // resolves correctly relative to the mutated script's own location.
  const PRE_FIX_DAEMON_SECTION = [
    'header "daemon" "process truth (pgrep, not state files)"',
    'if [[ "$DAEMON_RUNNING" -eq 1 ]]; then',
    '  warn "running (pid ${DAEMON_PIDS// /, }) — BILLED; stop with: ruflo daemon stop"',
    'else',
    '  pass "stopped (cost-safe default)"',
    'fi',
  ].join('\n');

  function withPreFixStatusScript(fn) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'status-prefix-'));
    const scratchLib = path.join(scratch, 'lib');
    const scratchTools = path.join(scratch, 'tools');
    fs.mkdirSync(scratchLib, { recursive: true });
    fs.mkdirSync(scratchTools, { recursive: true });
    fs.copyFileSync(path.join(REPO, 'lib', 'common.sh'), path.join(scratchLib, 'common.sh'));
    fs.copyFileSync(path.join(REPO, 'tools', 'daemon-staleness.cjs'), path.join(scratchTools, 'daemon-staleness.cjs'));

    const current = fs.readFileSync(STATUS, 'utf8');
    const re = /header "daemon" "process truth \(pgrep, not state files\)"[\s\S]*?\nfi\n/;
    if (!re.test(current)) throw new Error('daemon section not found in lib/status.sh to splice');
    const mutated = current.replace(re, PRE_FIX_DAEMON_SECTION + '\n');
    const dst = path.join(scratchLib, 'status.sh');
    fs.writeFileSync(dst, mutated);
    fs.chmodSync(dst, 0o755);
    try {
      return fn(dst);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  it('TEETH: the pre-fix daemon section wrongly claims a FOREIGN daemon is actionable-stoppable from here', () => {
    withPreFixStatusScript((preFixScript) => {
      const b = stubDaemonBin({ mode: 'OTHER', target });
      const r = spawnSync('bash', [preFixScript, target], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${b}:${process.env.PATH}` },
      });
      fs.rmSync(b, { recursive: true, force: true });
      // This IS the regression: the old code has no scope split, so a daemon
      // for an entirely different project gets the exact same unconditional
      // "stop with: ruflo daemon stop" claim a MINE daemon would.
      expect(r.stdout).toMatch(/running \(pid 313131\) — BILLED; stop with: ruflo daemon stop/);
    });
  });

  it('TEETH (contrast): the POST-FIX (real) status.sh does NOT make that claim for the same FOREIGN fixture', () => {
    const b = stubDaemonBin({ mode: 'OTHER', target });
    const r = runStatusWithBin(target, b);
    fs.rmSync(b, { recursive: true, force: true });
    expect(r.stdout).not.toMatch(/running for THIS target/);
    expect(r.stdout).not.toMatch(/stop with: ruflo daemon stop/);
  });
});

describe('status.sh --hints: compact bare-invocation output', () => {
  it('prints four labelled hint lines and exits 0', () => {
    const { out, code } = run(REPO, ['--hints']);
    expect(code).toBe(0);
    expect(out).toMatch(/versions:/);
    expect(out).toMatch(/daemon:/);
    expect(out).toMatch(/sentinels:/);
    expect(out).toMatch(/learning:/);
  });
});
