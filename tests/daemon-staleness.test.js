/**
 * Tests for DAEMON-STALE-DIST-V1 (detection-only daemon staleness audit).
 *
 * A running daemon keeps the dist it loaded at spawn time, so the kit dist
 * patches (SONA-TRAIN-V1 / RUFLO-LORA-ADAPT-V1) are inert inside any daemon
 * that started before the patch landed. The classification logic lives in
 * tools/daemon-staleness.cjs (pure: fake ps lines in, verdict lines out) and
 * lib/common.sh only does discovery (kit_daemon_ps_lines, overridable) plus
 * dist-mtime resolution (kit_daemon_dist_newest_mtime, KIT_RUFLO_DIST_SRC
 * override). Nothing here touches real processes, pgrep, or the global npm
 * root — and the audit NEVER kills anything (every path exits 0).
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOL = path.resolve(__dirname, '..', 'tools', 'daemon-staleness.cjs');
const COMMON = path.resolve(__dirname, '..', 'lib', 'common.sh');
const PROOF = path.resolve(__dirname, '..', 'lib', 'proof.sh');
const { parseElapsed, parseWorkspace, parseLines, classify, formatReport, REMEDY } = require(TOOL);

const worlds = [];
afterEach(() => {
  while (worlds.length) {
    const w = worlds.pop();
    try { fs.rmSync(w, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// Fixed clock + patch time for deterministic classification.
const NOW = 1_800_000_000;          // "now" in epoch seconds
const PATCH = NOW - 1000;           // newest dist-patch mtime

// ps line helper: pid, elapsed(seconds|etime string), argv tail.
const psLine = (pid, elapsed, args) => `${pid} ${elapsed} node /g/ruflo/bin/cli.js daemon ${args}`;

function runTool(stdin, args) {
  const r = spawnSync('node', [TOOL, ...args], { input: stdin, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').trimEnd(), lines: (r.stdout || '').trimEnd().split('\n').filter(Boolean) };
}

describe('daemon-staleness.cjs: parsing', () => {
  it('parses etimes (plain seconds) and BSD etime ([[dd-]hh:]mm:ss) shapes', () => {
    expect(parseElapsed('90')).toBe(90);
    expect(parseElapsed('05:33')).toBe(333);
    expect(parseElapsed('12:05:33')).toBe(43533);
    expect(parseElapsed('1-02:03:04')).toBe(93784);
    expect(Number.isNaN(parseElapsed('junk'))).toBe(true);
  });

  it('extracts --workspace in both "--workspace X" and "--workspace=X" forms, else "?"', () => {
    expect(parseWorkspace(['daemon', 'start', '--workspace', '/a/b'])).toBe('/a/b');
    expect(parseWorkspace(['daemon', 'start', '--workspace=/x/y'])).toBe('/x/y');
    expect(parseWorkspace(['daemon', 'start'])).toBe('?');
  });

  it('parseLines derives startEpoch = now - elapsed and skips blank/garbage lines', () => {
    const d = parseLines(`${psLine(11, 100, 'start --workspace /p')}\n\nnot a ps line\n`, NOW);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ pid: 11, startEpoch: NOW - 100, workspace: '/p' });
  });
});

describe('daemon-staleness.cjs: STALE vs FRESH by timestamps', () => {
  it('started strictly before the newest dist mtime => STALE; after => FRESH', () => {
    const rows = classify(parseLines(
      psLine(1, 2000, 'start --workspace /w/a') + '\n' +   // start = NOW-2000 < PATCH
      psLine(2, 500, 'start --workspace /w/b'), NOW), PATCH, '/home/x');
    expect(rows.find((r) => r.pid === 1).state).toBe('STALE');
    expect(rows.find((r) => r.pid === 2).state).toBe('FRESH');
  });

  it('started exactly AT the patch mtime is FRESH (strictly-before semantics)', () => {
    const rows = classify(parseLines(psLine(3, NOW - PATCH, 'start'), NOW), PATCH, '');
    expect(rows[0].state).toBe('FRESH');
  });

  it('no newest-mtime => everything FRESH (never claim staleness it cannot prove)', () => {
    const rows = classify(parseLines(psLine(4, 999999, 'start'), NOW), undefined, '');
    expect(rows[0].state).toBe('FRESH');
  });
});

describe('daemon-staleness.cjs: auto-spawn suspicion tags', () => {
  it('tags a $HOME workspace with suspect:home-workspace (trailing-slash tolerant)', () => {
    const rows = classify(parseLines(psLine(5, 10, 'start --workspace /home/u/'), NOW), PATCH, '/home/u');
    expect(rows[0].tags).toContain('suspect:home-workspace');
  });

  it('tags a workspace that is a SUBDIRECTORY of another daemon workspace', () => {
    const rows = classify(parseLines(
      psLine(10, 10, 'start --workspace /srv/proj') + '\n' +
      psLine(20, 10, 'start --workspace /srv/proj/packages/api'), NOW), PATCH, '/home/u');
    expect(rows.find((r) => r.pid === 20).tags).toContain('suspect:subdir-of-pid-10');
    expect(rows.find((r) => r.pid === 10).tags).toEqual([]);
  });

  it('does NOT tag sibling prefixes (/srv/proj2 is not a subdir of /srv/proj)', () => {
    const rows = classify(parseLines(
      psLine(10, 10, 'start --workspace /srv/proj') + '\n' +
      psLine(20, 10, 'start --workspace /srv/proj2'), NOW), PATCH, '/home/u');
    expect(rows.find((r) => r.pid === 20).tags).toEqual([]);
  });

  it('unknown workspaces ("?") never participate in tagging', () => {
    const rows = classify(parseLines(
      psLine(10, 10, 'start') + '\n' + psLine(20, 10, 'start --workspace /a'), NOW), PATCH, '/home/u');
    expect(rows.find((r) => r.pid === 10).tags).toEqual([]);
    expect(rows.find((r) => r.pid === 20).tags).toEqual([]);
  });
});

describe('daemon-staleness.cjs: report + CLI', () => {
  it('appends ONE consequence+remedy WARNING line iff >=1 daemon is STALE', () => {
    const stale = classify(parseLines(psLine(1, 5000, 'start'), NOW), PATCH, '');
    const staleReport = formatReport(stale);
    expect(staleReport[staleReport.length - 1]).toBe(`WARNING: 1 stale-dist daemon(s) ${REMEDY}`);
    expect(REMEDY).toContain('running pre-patch code — dist patches inert in it until: ruflo daemon stop && ruflo daemon start');
    expect(REMEDY).toContain('(deliberate starts are yours; auto-spawned strays are safe to stop)');

    const fresh = classify(parseLines(psLine(2, 5, 'start'), NOW), PATCH, '');
    expect(formatReport(fresh).join('\n')).not.toContain('WARNING');
  });

  it('CLI: fake ps lines in, one verdict line per daemon out, exit 0', () => {
    const stdin = psLine(101, 2000, 'start --workspace /w/a') + '\n' +
                  psLine(202, 500, 'start --workspace /w/a/sub') + '\n';
    const { code, lines } = runTool(stdin, ['--newest-mtime', String(PATCH), '--now', String(NOW), '--home', '/home/x']);
    expect(code).toBe(0);
    expect(lines).toHaveLength(3); // 2 daemons + 1 WARNING
    expect(lines[0]).toMatch(/^pid 101 ws=\/w\/a started=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z STALE$/);
    expect(lines[1]).toMatch(/^pid 202 ws=\/w\/a\/sub started=.* FRESH suspect:subdir-of-pid-101$/);
    expect(lines[2]).toMatch(/^WARNING: 1 stale-dist daemon\(s\) running pre-patch code/);
  });

  it('CLI: empty stdin prints nothing and exits 0 (detection-only, never fails)', () => {
    const { code, out } = runTool('', ['--newest-mtime', String(PATCH)]);
    expect(code).toBe(0);
    expect(out).toBe('');
  });
});

// ── bash side: kit_daemon_staleness / kit_daemon_dist_newest_mtime ──────────
// Discovery (kit_daemon_ps_lines) is overridden in-shell with fake ps output;
// the dist root is a fixture whose mtimes we control via fs.utimesSync.

function mkDist(patchEpoch) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dstale-'));
  worlds.push(base);
  const dist = path.join(base, 'dist');
  fs.mkdirSync(path.join(dist, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(dist, 'mcp-tools'), { recursive: true });
  const intel = path.join(dist, 'memory', 'intelligence.js');
  const ht = path.join(dist, 'mcp-tools', 'hooks-tools.js');
  fs.writeFileSync(intel, '// SONA-TRAIN-V1\n');
  fs.writeFileSync(ht, '// RUFLO-LORA-ADAPT-V1\n');
  // hooks-tools.js is the NEWER of the two — newest-mtime must pick it.
  fs.utimesSync(intel, patchEpoch - 500, patchEpoch - 500);
  fs.utimesSync(ht, patchEpoch, patchEpoch);
  return dist;
}

function runBash(script, env = {}) {
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: (r.stdout || '').trimEnd(), err: r.stderr || '' };
}

describe('common.sh: kit_daemon_dist_newest_mtime', () => {
  it('returns the NEWEST mtime among the two kit-patched dist files', () => {
    const patch = Math.floor(Date.now() / 1000) - 3600;
    const dist = mkDist(patch);
    const { code, out } = runBash(`source '${COMMON}'; kit_daemon_dist_newest_mtime`, { KIT_RUFLO_DIST_SRC: dist });
    expect(code).toBe(0);
    expect(Number(out)).toBe(patch);
  });

  it('rc 1 when neither dist file exists (offline / no global install)', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dstale-empty-'));
    worlds.push(empty);
    const { code } = runBash(`source '${COMMON}'; kit_daemon_dist_newest_mtime`, { KIT_RUFLO_DIST_SRC: empty });
    expect(code).toBe(1);
  });
});

describe('common.sh: kit_daemon_staleness (discovery overridden)', () => {
  it('classifies fake daemons STALE/FRESH against real fixture mtimes, with tags', () => {
    const patch = Math.floor(Date.now() / 1000) - 3600; // patched 1h ago
    const dist = mkDist(patch);
    const script = `
      source '${COMMON}'
      kit_daemon_ps_lines() {
        echo '111 86400 node /g/ruflo/bin/cli.js daemon start --workspace '"$HOME"
        echo '222 10 node /g/ruflo/bin/cli.js daemon start --workspace /tmp/projX'
      }
      kit_daemon_staleness
      echo "rc=$?"
    `;
    const { out } = runBash(script, { KIT_RUFLO_DIST_SRC: dist });
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^pid 111 ws=.* STALE suspect:home-workspace$/);   // started 1 day ago < patch
    expect(lines[1]).toMatch(/^pid 222 ws=\/tmp\/projX started=.* FRESH$/);     // started 10s ago > patch
    expect(lines[2]).toMatch(/^WARNING: 1 stale-dist daemon\(s\) running pre-patch code — dist patches inert in it until: ruflo daemon stop && ruflo daemon start \(deliberate starts are yours; auto-spawned strays are safe to stop\)$/);
    expect(lines[3]).toBe('rc=0');
  });

  it('prints NOTHING (rc 0) when no daemon is discovered', () => {
    const dist = mkDist(Math.floor(Date.now() / 1000));
    const { out } = runBash(
      `source '${COMMON}'; kit_daemon_ps_lines() { :; }; kit_daemon_staleness; echo "rc=$?"`,
      { KIT_RUFLO_DIST_SRC: dist });
    expect(out).toBe('rc=0');
  });

  it('no resolvable dist => daemons classify FRESH, still rc 0 (fail-safe)', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dstale-none-'));
    worlds.push(empty);
    const script = `
      source '${COMMON}'
      kit_daemon_ps_lines() { echo '9 999999 node /g/ruflo/bin/cli.js daemon start --workspace /a'; }
      kit_daemon_staleness
      echo "rc=$?"
    `;
    const { out } = runBash(script, { KIT_RUFLO_DIST_SRC: empty });
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^pid 9 ws=\/a started=.* FRESH$/);
    expect(lines[1]).toBe('rc=0');
    expect(out).not.toContain('WARNING');
  });
});

// ── F1 falsification: macOS `ps -o etimes=` does not fail-empty ────────────
// BSD/macOS ps prints "ps: etimes: keyword not found" to STDERR but still
// emits the line with the etimes column simply missing (args shift into its
// slot), and exits rc=1. The OLD `[[ -z "$line" ]]` gate in kit_daemon_ps_lines
// never caught this (non-empty but malformed), so the etime fallback was dead
// code on macOS and every row failed parseElapsed downstream. Captured
// VERBATIM on a real macOS host via:
//   sleep 300 & ps -o pid= -o etimes= -o args= -p $!
// -> "32984 sleep 300" style output — reproduced below with a realistic
// daemon argv tail.

describe('daemon-staleness.cjs: F1 macOS malformed-etimes line (falsification fixture)', () => {
  // A literal capture shape: `ps -o pid= -o etimes= -o args=` on macOS emits
  // "<pid> <first-arg-token> <rest-of-args...>" — the etimes column vanished,
  // NOT a blank/placeholder, so token 2 is the daemon's own argv[0]-ish token.
  const macMalformedLine =
    '32984 node /var/folders/pb/x9zzt6713n749nmmpqdxtzbm0000gn/T/tmp.qmqf2nJ3t6/bin/cli.js daemon start --workspace /tmp/fakeproj';

  it('a real macOS malformed-etimes row is NEVER silently dropped — it surfaces as UNPARSABLE', () => {
    const parsed = parseLines(macMalformedLine, NOW);
    expect(parsed).toHaveLength(1); // NOT zero — the pre-fix behavior was to `continue` and vanish
    expect(parsed[0]).toMatchObject({ pid: 32984, unparsable: true });

    const rows = classify(parsed, PATCH, '');
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('UNPARSABLE');

    const report = formatReport(rows);
    expect(report).toHaveLength(2); // the row itself + a NOTE — never empty output
    expect(report[0]).toBe(`pid 32984 UNPARSABLE (raw: ${macMalformedLine})`);
    expect(report[1]).toBe('NOTE: 1 daemon row(s) UNPARSABLE — staleness not assessable for them (see raw above)');
  });

  it('CLI end-to-end: piping the real malformed line in still exits 0 with non-empty, non-silent output', () => {
    const { code, lines } = runTool(macMalformedLine + '\n', ['--newest-mtime', String(PATCH)]);
    expect(code).toBe(0);
    expect(lines.length).toBeGreaterThan(0); // the pre-fix regression was EXACTLY zero lines here
    expect(lines[0]).toContain('UNPARSABLE');
  });

  it('contrast: the SAME daemon via a well-formed etime line classifies normally (STALE), not UNPARSABLE', () => {
    const wellFormed = '32984 01:40 node /fake/bin/cli.js daemon start --workspace /tmp/fakeproj';
    const rows = classify(parseLines(wellFormed, NOW), NOW + 1, ''); // patch newer than start => STALE
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('STALE');
  });
});

// ── F1 falsification: kit_daemon_ps_lines gates on ps's exit status ─────────
// Exercises the ACTUAL bash function (not a stand-in) against fake `pgrep`/`ps`
// executables placed first on PATH, so the fixture is deterministic and
// platform-independent (doesn't depend on the test host's own ps dialect).

function mkFakeBin(scripts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakebin-'));
  worlds.push(dir);
  for (const [name, body] of Object.entries(scripts)) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
  }
  return dir;
}

describe('common.sh: kit_daemon_ps_lines — F1 rc-gated etimes/etime fallback (falsification)', () => {
  it('macOS shape: etimes exits rc=1 with a malformed-but-non-empty line -> falls back to etime, NOT the malformed line', () => {
    const fakeBin = mkFakeBin({
      pgrep: '#!/usr/bin/env bash\ncase "$*" in\n  *"bin/cli.js daemon start"*) echo 777777 ;;\n  *) exit 1 ;;\nesac\n',
      ps: [
        '#!/usr/bin/env bash',
        'if [[ "$*" == *"etimes="* ]]; then',
        '  echo "ps: etimes: keyword not found" >&2',
        '  echo "777777 node /fake/bin/cli.js daemon start --workspace /tmp/fakeproj"',
        '  exit 1',
        'fi',
        'if [[ "$*" == *"etime="* ]]; then',
        '  echo "777777 01:40 node /fake/bin/cli.js daemon start --workspace /tmp/fakeproj"',
        '  exit 0',
        'fi',
        'exit 1',
      ].join('\n') + '\n',
    });
    const { code, out } = runBash(`source '${COMMON}'; kit_daemon_ps_lines`, { PATH: `${fakeBin}:${process.env.PATH}` });
    expect(code).toBe(0);
    // Must be the WELL-FORMED etime line (pid, elapsed, args...) — the old
    // emptiness-only gate would have kept the malformed etimes-shaped line
    // instead, since it was non-empty.
    expect(out).toBe('777777 01:40 node /fake/bin/cli.js daemon start --workspace /tmp/fakeproj');

    // and downstream it actually classifies (not UNPARSABLE).
    const parsed = parseLines(out, NOW);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ pid: 777777, unparsable: false });
  });

  it('GNU/Linux shape: etimes succeeds (rc=0) -> used as-is, no fallback invoked', () => {
    const fakeBin = mkFakeBin({
      pgrep: '#!/usr/bin/env bash\ncase "$*" in\n  *"bin/cli.js daemon start"*) echo 888888 ;;\n  *) exit 1 ;;\nesac\n',
      ps: [
        '#!/usr/bin/env bash',
        'if [[ "$*" == *"etimes="* ]]; then',
        '  echo "888888 120 node /fake/bin/cli.js daemon start --workspace /tmp/y"',
        '  exit 0',
        'fi',
        'echo "FALLBACK-SHOULD-NOT-HAPPEN"; exit 1',
      ].join('\n') + '\n',
    });
    const { out } = runBash(`source '${COMMON}'; kit_daemon_ps_lines`, { PATH: `${fakeBin}:${process.env.PATH}` });
    expect(out).toBe('888888 120 node /fake/bin/cli.js daemon start --workspace /tmp/y');
    expect(out).not.toContain('FALLBACK-SHOULD-NOT-HAPPEN');
  });
});

// ── F7 falsification: proof P14 must not reintroduce the fcaec68 blindspot ──
// commit fcaec68 documented that a SINGLE-pattern `pgrep -f 'bin/cli.js daemon
// start'` "missed EVERY real daemon" whose surviving argv is `ruflo daemon
// start` with no cli.js visible — status.sh was fixed to merge both patterns
// (kit_daemon_ps_lines); proof.sh P14 had kept the narrow single pattern for
// itself, silently disagreeing with status.sh's daemon count.

describe('kit_daemon_ps_lines vs a narrow single-pattern pgrep (F7 falsification)', () => {
  it('a daemon visible ONLY via the "ruflo daemon" pattern is missed by the old narrow pgrep but caught by the shared helper', () => {
    const fakeBin = mkFakeBin({
      // Only matches 'ruflo daemon' — simulates argv with no 'bin/cli.js daemon start' substring.
      pgrep: '#!/usr/bin/env bash\ncase "$*" in\n  *"ruflo daemon"*) echo 555555 ;;\n  *) exit 1 ;;\nesac\n',
      ps: [
        '#!/usr/bin/env bash',
        'if [[ "$*" == *"etimes="* ]]; then',
        '  echo "555555 42 ruflo daemon start --workspace /tmp/x"',
        '  exit 0',
        'fi',
        'exit 1',
      ].join('\n') + '\n',
    });
    const env = { PATH: `${fakeBin}:${process.env.PATH}` };
    const oldNarrow = runBash(`pgrep -f "bin/cli.js daemon start" 2>/dev/null | grep -c .`, env);
    const sharedHelper = runBash(`source '${COMMON}'; kit_daemon_ps_lines | grep -c .`, env);
    expect(Number(oldNarrow.out)).toBe(0);      // the exact fcaec68 blindspot, reproduced
    expect(Number(sharedHelper.out)).toBe(1);   // the shared dual-pattern helper does not miss it
  });
});

describe('lib/proof.sh: P14 wiring (F7 — must consume the shared helper, not its own pgrep)', () => {
  it('the daemon-gates probe computes dcount via kit_daemon_ps_lines, not a standalone single-pattern pgrep', () => {
    const src = fs.readFileSync(PROOF, 'utf8');
    const fnStart = src.indexOf('probe_daemon_gates()');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = src.indexOf('\n}', fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    expect(fnBody).toMatch(/dcount="\$\(kit_daemon_ps_lines/);
    // the pre-fix line computed dcount straight from a narrow single-pattern
    // pgrep; that standalone invocation must be gone from this probe body.
    expect(fnBody).not.toMatch(/dcount="\$\(pgrep -f "bin\/cli\.js daemon start"/);
  });
});
