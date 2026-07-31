/**
 * Tests for lib/verify-learning.sh + the assert_vector_dim_ok helper in
 * lib/common.sh (GitHub issue #4 — "enabled-but-hollow" detection).
 *
 * Strategy: build throwaway sqlite fixtures with the sqlite3 CLI, then spawn the
 * real script against each fixture target dir. Asserts on exit status + the
 * --json verdict, so we prove the fail-loud contract without touching real
 * runtime stores. The whole point of issue #4 is "trust committed disk, not MCP
 * self-reports" — so these fixtures ARE committed sqlite rows.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const VERIFY = path.join(REPO, 'lib', 'verify-learning.sh');
const COMMON = path.join(REPO, 'lib', 'common.sh');

// Real, on-disk stand-in for "a different project's workspace" in FOREIGN
// fixtures below. DAEMON-HINT-SCOPE-V1 round 2: kit_daemon_scope_split now
// compares filesystem IDENTITY (dev, ino via fs.statSync), not path strings —
// so a fictional --workspace path that doesn't exist on disk can no longer
// be told apart from "present but un-stat-able", and correctly classifies
// UNKNOWN rather than OTHER. That is the honest behavior the fix intends,
// but it means these fixtures need a REAL directory to represent a foreign
// project, exactly as production always has one (the actual reproduction
// against PID 29640 pointed at a real, existing directory on the dev host).
const FOREIGN_WORKSPACE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-project-')));
afterAll(() => fs.rmSync(FOREIGN_WORKSPACE, { recursive: true, force: true }));

function sqlite(db, sql) {
  const r = spawnSync('sqlite3', [db, sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sqlite3 failed: ${r.stderr || r.stdout}`);
}
// Deterministic stub for the #4 oracle: `aqe ruvector status`. This decouples
// tests from the ambient global flag store.
//
// The daemon advisory used to be controlled via a fake `ruflo daemon status`
// binary, but B24 replaced that CLI call unconditionally with
// kit_daemon_ps_lines (common.sh) — a pgrep-based check, same as lib/status.sh
// and lib/proof.sh already use — because `ruflo daemon status`'s own upstream
// side effect of instantiating internal config objects just to print a table
// created .claude-flow/logs/daemon.log even on this read-only probe. A fake
// `ruflo` binary is therefore no longer consulted for this probe at all; the
// daemon case is now driven by fake `pgrep`/`ps` binaries on PATH, mirroring
// the falsification convention in tests/daemon-staleness.test.js (real
// discovery function, deterministic fixture, no dependency on the test host's
// actual process table).
//
// B24-DAEMON-SCOPE-V1 (critic-found regression, fixed): kit_daemon_ps_lines is
// UNSCOPED by design, so the daemon advisory now runs it through
// kit_daemon_scope_split (common.sh) to classify each discovered daemon as
// MINE (--workspace argv == this fixture's target dir) / FOREIGN (a DIFFERENT
// workspace — reproduced live against a real stray daemon on the dev host
// whose argv is exactly this FOREIGN shape) / UNKNOWN (no --workspace token
// at all). `daemon` selects which of these `pgrep`/`ps` simulates; `target`
// (required for 'RUNNING'/'BOTH') is the fixture's own target dir, so the
// scope-split genuinely matches instead of coincidentally landing on the old
// hardcoded '/tmp/vl-test' (which was never the real mkdtemp path, so pre-fix
// this fixture was silently exercising the wrong bucket regardless).
//
// pgrep/ps are ALWAYS faked here — including 'stopped', the default every
// hollow/healthy/primed fixture in this file uses — so nothing in this suite
// depends on the test host's real process table. (This host runs a real,
// independent ruflo daemon for an unrelated project; without a hermetic
// default every other describe() block below would silently pick it up.)
function mkPsScript(entries) {
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
function stubBin({ hnsw = 'true', daemon = 'stopped', target = '' } = {}) {
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'vlbin-'));
  fs.writeFileSync(path.join(b, 'aqe'),
    `#!/usr/bin/env bash\nif [ "$1" = ruvector ] && [ "$2" = status ]; then echo "  useNativeHNSW: ${hnsw} (set)"; fi\nexit 0\n`);

  const entries = [];
  if (daemon === 'RUNNING' || daemon === 'BOTH') {
    if (!target) throw new Error(`stubBin: daemon '${daemon}' requires a target dir`);
    entries.push({ pid: 424242, line: `424242 60 node /fake/bin/cli.js daemon start --workspace ${target}` });
  }
  if (daemon === 'FOREIGN' || daemon === 'BOTH') {
    // Realistic argv shape mirroring the actual stray daemon this bug was
    // reproduced against on the dev host (a different project's workspace).
    // Points at FOREIGN_WORKSPACE — a REAL directory, required so the
    // identity-based classifier (dev, ino) resolves it to OTHER rather than
    // UNKNOWN (see FOREIGN_WORKSPACE's own comment above).
    entries.push({
      pid: 313131,
      line: '313131 3600 node /g/ruflo/node_modules/@claude-flow/cli/bin/cli.js daemon start '
        + `--foreground --quiet --workspace ${FOREIGN_WORKSPACE}`,
    });
  }
  if (daemon === 'UNKNOWN') {
    entries.push({ pid: 515151, line: '515151 90 node /fake/bin/cli.js daemon start --foreground --quiet' });
  }

  if (entries.length > 0) {
    const pids = entries.map((e) => e.pid).join(' ');
    fs.writeFileSync(path.join(b, 'pgrep'),
      `#!/usr/bin/env bash\ncase "$*" in\n  *"bin/cli.js daemon start"*) printf '%s\\n' ${pids} ;;\n  *) exit 1 ;;\nesac\n`);
    fs.writeFileSync(path.join(b, 'ps'), mkPsScript(entries));
  } else {
    fs.writeFileSync(path.join(b, 'pgrep'), '#!/usr/bin/env bash\nexit 1\n');
  }
  fs.chmodSync(path.join(b, 'aqe'), 0o755);
  fs.chmodSync(path.join(b, 'pgrep'), 0o755);
  if (entries.length > 0) fs.chmodSync(path.join(b, 'ps'), 0o755);
  return b;
}
// A known-good dist stub carrying BOTH sona-seam sentinels, so probe #11
// (probe_seam_sentinels) is PINNED to PASS here regardless of the live global's
// patch state. These fixtures are about issue #4 hollow detection, not the seam
// probe; a dedicated suite (verify-learning-seam.test.js) exercises #11's PASS/
// FAIL/not-assessable branches. Without this pin the #4 tests would couple to
// whether the machine's global ruflo happens to be patched.
function goodDistSrc() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vldist-'));
  fs.mkdirSync(path.join(d, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(d, 'mcp-tools'), { recursive: true });
  fs.writeFileSync(path.join(d, 'memory', 'intelligence.js'), '// SONA-TRAIN-V1\n');
  fs.writeFileSync(path.join(d, 'mcp-tools', 'hooks-tools.js'), '// RUFLO-LORA-ADAPT-V1\n');
  return d;
}
function runVerify(target, extra = [], stub = {}) {
  const b = stubBin({ ...stub, target });
  const dist = goodDistSrc();
  const r = spawnSync('bash', [VERIFY, target, ...extra], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, PATH: `${b}:${process.env.PATH}`, KIT_RUFLO_DIST_SRC: dist },
  });
  fs.rmSync(b, { recursive: true, force: true });
  fs.rmSync(dist, { recursive: true, force: true });
  return r;
}
function mkTarget() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-'));
  fs.mkdirSync(path.join(d, '.swarm'), { recursive: true });
  fs.mkdirSync(path.join(d, '.agentic-qe'), { recursive: true });
  return d;
}

// Hollow fixture: genuine session evidence exists (eligible captured_experiences
// + a session record) yet nothing was learned — structured tables empty, lora
// never applied. #2/#3 must FAIL. (Post-e2e semantics: hollow is judged against
// the actual harvest source and session records, not kit-seeded flat entries.)
function buildHollow(d) {
  sqlite(path.join(d, '.swarm', 'memory.db'),
    'CREATE TABLE memory_entries(id INTEGER); INSERT INTO memory_entries VALUES (1),(2),(3);' +
    'CREATE TABLE episodes(id INTEGER); CREATE TABLE skills(id INTEGER); CREATE TABLE patterns(id INTEGER);' +
    'CREATE TABLE causal_edges(id INTEGER); CREATE TABLE reasoning_patterns(id INTEGER);' +
    'CREATE TABLE learning_experiences(id INTEGER); CREATE TABLE graph_edges(id INTEGER);');
  sqlite(path.join(d, '.agentic-qe', 'memory.db'),
    'CREATE TABLE vectors(dimensions INTEGER, embedding BLOB); INSERT INTO vectors VALUES (384, zeroblob(1536));' +
    'CREATE TABLE sona_patterns(id INTEGER); CREATE TABLE routing_outcomes(id INTEGER);' +
    // The harvest source (tools/aqe-harvest.cjs filter): eligible rows that
    // SHOULD have produced agentdb.db episodes.
    'CREATE TABLE captured_experiences(task TEXT, success INTEGER, quality REAL, embedding BLOB);' +
    "INSERT INTO captured_experiences VALUES ('t1', 1, 0.9, zeroblob(4)), ('t2', 1, 0.8, zeroblob(4));");
  // A live session routed through the stack → lora ta=0 is a real failure here.
  fs.mkdirSync(path.join(d, '.claude-flow', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(d, '.claude-flow', 'sessions', 'session-1.json'), '{"endedAt":"2026-07-18T00:00:00Z"}');
  fs.writeFileSync(path.join(d, '.agentic-qe', 'config.yaml'),
    'learning:\n  hnswConfig:\n    M: 8\n    efConstruction: 100\n');
  fs.writeFileSync(path.join(d, '.swarm', 'lora-weights.json'),
    JSON.stringify({ stats: { totalUpdates: 100, totalAdaptations: 0 } }));
}

// Healthy fixture: reflexion store (agentdb.db) populated, lora engaged,
// useNativeHNSW set, graph + sona non-empty → verdict must NOT be hollow.
function buildHealthy(d) {
  sqlite(path.join(d, '.swarm', 'memory.db'),
    'CREATE TABLE memory_entries(id INTEGER); INSERT INTO memory_entries VALUES (1),(2),(3);' +
    'CREATE TABLE graph_edges(id INTEGER); INSERT INTO graph_edges VALUES (1);');
  // #2 reads the canonical reflexion store (agentdb.db episodes+skills), NOT .swarm.
  sqlite(path.join(d, 'agentdb.db'),
    'CREATE TABLE episodes(id INTEGER); INSERT INTO episodes VALUES (1),(2);' +
    'CREATE TABLE skills(id INTEGER); INSERT INTO skills VALUES (1);');
  sqlite(path.join(d, '.agentic-qe', 'memory.db'),
    'CREATE TABLE vectors(dimensions INTEGER, embedding BLOB); INSERT INTO vectors VALUES (384, zeroblob(1536));' +
    'CREATE TABLE sona_patterns(id INTEGER); INSERT INTO sona_patterns VALUES (1);' +
    'CREATE TABLE routing_outcomes(id INTEGER); INSERT INTO routing_outcomes VALUES (1);');
  fs.writeFileSync(path.join(d, '.agentic-qe', 'config.yaml'),
    'learning:\n  hnswConfig:\n    M: 8\n    useNativeHNSW: true\n');
  fs.writeFileSync(path.join(d, '.swarm', 'lora-weights.json'),
    JSON.stringify({ stats: { totalUpdates: 100, totalAdaptations: 7 } }));
}

function parseJson(stdout) {
  const line = stdout.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(line);
}

describe('verify-learning: hollow detection (issue #4 #2/#3/#4)', () => {
  let d;
  beforeAll(() => { d = mkTarget(); buildHollow(d); });
  afterAll(() => fs.rmSync(d, { recursive: true, force: true }));

  it('exits 1 (fail-loud) on an enabled-but-hollow loop', () => {
    expect(runVerify(d).status).toBe(1);
  });

  it('--json verdict "hollow" with 2 fails (#2 controllers, #3 lora) when HNSW flag is on', () => {
    // useNativeHNSW is ON by default in the ruvector flags store, so #4 must NOT
    // fail merely because config.yaml lacks the key (the original false-positive).
    const r = runVerify(d, ['--json'], { hnsw: 'true' });
    expect(r.status).toBe(1);
    const j = parseJson(r.stdout);
    expect(j.verdict).toBe('hollow');
    expect(j.fail).toBe(2);
  });

  it('#4 FAILS only when useNativeHNSW is EXPLICITLY false (then 3 fails)', () => {
    const r = runVerify(d, ['--json'], { hnsw: 'false' });
    expect(parseJson(r.stdout).fail).toBe(3);
    expect(runVerify(d, [], { hnsw: 'false' }).stdout).toMatch(/HNSW native backend DISABLED/);
  });

  it('warns (non-fatal) when the ruflo daemon is RUNNING for THIS target', () => {
    const r = runVerify(d, [], { daemon: 'RUNNING' });
    expect(r.stdout).toMatch(/daemon is RUNNING for THIS target/);
    expect(r.status).toBe(1); // still hollow; the daemon note never changes the verdict
  });

  it('--json stdout is a single clean JSON line (no ANSI/probe leakage)', () => {
    const r = runVerify(d, ['--json']);
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\{.*\}$/);
    expect(r.stdout).not.toMatch(/\[/); // no color escapes
  });
});

// B24-DAEMON-SCOPE-V1: probe_daemon_advisory used to consume kit_daemon_ps_lines
// (an UNSCOPED pgrep over the whole process table) directly and asserted a
// target-specific causal claim ("it locks the DBs") for ANY ruflo daemon found
// ANYWHERE on the host. Reproduced live on the dev host: a real, independent
// stray daemon for a DIFFERENT project made this probe warn about DBs it does
// not lock, while `ruflo daemon status` (the call it replaced) correctly
// reported this exact target as stopped at the same moment. Fixed via
// kit_daemon_scope_split (common.sh), a genuine TRI-STATE: MINE (this target)
// gets the causal warn; FOREIGN (a different workspace) is informational only
// and must never degrade into the causal claim; UNKNOWN (no --workspace token
// visible) is hedged, never silently folded into either bucket.
describe('verify-learning: daemon advisory is workspace-scoped (tri-state)', () => {
  let d;
  beforeAll(() => { d = mkTarget(); buildHealthy(d); });
  afterAll(() => fs.rmSync(d, { recursive: true, force: true }));

  it('MINE: a daemon whose --workspace IS this target fires the causal "locks the DBs" warn', () => {
    const r = runVerify(d, [], { daemon: 'RUNNING' });
    expect(r.stdout).toMatch(/daemon is RUNNING for THIS target \(pid 424242\)/);
    expect(r.stdout).toMatch(/it locks the DBs/);
  });

  it('FOREIGN: a daemon whose --workspace is a DIFFERENT project is informational only \u2014 never the causal claim', () => {
    const r = runVerify(d, [], { daemon: 'FOREIGN' });
    expect(r.stdout).toMatch(/DIFFERENT workspace/);
    expect(r.stdout).toMatch(/do not lock this target's DBs/);
    expect(r.stdout).not.toMatch(/is RUNNING for THIS target/);
    expect(r.stdout).not.toMatch(/it locks the DBs/);
  });

  it('UNKNOWN: a daemon with no --workspace token in argv is hedged, never silently folded into MINE or FOREIGN', () => {
    const r = runVerify(d, [], { daemon: 'UNKNOWN' });
    expect(r.stdout).toMatch(/no --workspace visible in argv/);
    expect(r.stdout).toMatch(/scope could not be determined/);
    expect(r.stdout).toMatch(/MAY belong to this target/);
    expect(r.stdout).not.toMatch(/is RUNNING for THIS target/);
    expect(r.stdout).not.toMatch(/DIFFERENT workspace/);
  });

  it('BOTH: a MINE daemon alongside a FOREIGN one still fires the MINE warning', () => {
    const r = runVerify(d, [], { daemon: 'BOTH' });
    expect(r.stdout).toMatch(/daemon is RUNNING for THIS target \(pid 424242\)/);
    expect(r.stdout).toMatch(/DIFFERENT workspace/);
  });

  it('a FOREIGN daemon does not degrade the verdict away from "live"', () => {
    const r = runVerify(d, ['--json'], { daemon: 'FOREIGN' });
    expect(parseJson(r.stdout).verdict).toBe('live');
  });

  // TEETH: reconstruct the PRE-FIX probe_daemon_advisory (the B24-buggy
  // intermediate that consumed kit_daemon_ps_lines directly, no scope split —
  // see lib/verify-learning.sh's B24-DAEMON-SCOPE-V1 comment for the exact
  // body and the critic report this fixes) by splicing it into a fresh copy
  // of the CURRENT script. This stays in sync with unrelated future edits to
  // verify-learning.sh (mirrors tests/verify-learning-dryrun.test.js's
  // withPreFixScript convention, but the regression here postdates HEAD, so
  // `git show HEAD:...` would give the WRONG pre-fix baseline — it still has
  // the entirely different pre-B24 `ruflo daemon status` call).
  const PRE_FIX_PROBE_BODY = [
    'probe_daemon_advisory() {',
    '  local lines pids',
    '  lines="$(kit_daemon_ps_lines 2>/dev/null)"',
    '  [[ -z "$lines" ]] && return 0',
    '  pids="$(awk \'{print $1}\' <<< "$lines" | tr \'\\n\' \',\' | sed \'s/,$//\')"',
    '  soft "ruflo daemon is RUNNING (pid ${pids}) \u2014 it locks the DBs (fix-learning \'dream\' fails locked) and caches state; restart the daemon + Claude Code after a fix, then re-verify"',
    '}',
    '',
  ].join('\n');

  function withPreFixDaemonProbe(fn) {
    const relName = '.pretest-b24-scope-verify-learning.sh';
    const dst = path.join(REPO, 'lib', relName);
    const current = fs.readFileSync(VERIFY, 'utf8');
    const re = /probe_daemon_advisory\(\) \{[\s\S]*?\n\}\n/;
    if (!re.test(current)) throw new Error('probe_daemon_advisory() not found in lib/verify-learning.sh to splice');
    fs.writeFileSync(dst, current.replace(re, PRE_FIX_PROBE_BODY));
    fs.chmodSync(dst, 0o755);
    try { return fn(dst); } finally { fs.rmSync(dst, { force: true }); }
  }

  function runScript(scriptPath, target, extra, stub) {
    const b = stubBin({ ...stub, target });
    const dist = goodDistSrc();
    const r = spawnSync('bash', [scriptPath, target, ...extra], {
      encoding: 'utf8', timeout: 20000,
      env: { ...process.env, PATH: `${b}:${process.env.PATH}`, KIT_RUFLO_DIST_SRC: dist },
    });
    fs.rmSync(b, { recursive: true, force: true });
    fs.rmSync(dist, { recursive: true, force: true });
    return r;
  }

  it('TEETH: the pre-fix probe falsely claims a FOREIGN daemon locks THIS target\'s DBs', () => {
    withPreFixDaemonProbe((preFix) => {
      const r = runScript(preFix, d, [], { daemon: 'FOREIGN' });
      // This is the exact regression: the OLD code has no scope split at all,
      // so ANY discovered daemon — including one for a different project —
      // gets the target-specific causal claim.
      expect(r.stdout).toMatch(/daemon is RUNNING \(pid 313131\)/);
      expect(r.stdout).toMatch(/it locks the DBs/);
    });
  });

  it('TEETH: the pre-fix probe also mis-claims an UNKNOWN-scope daemon locks THIS target\'s DBs', () => {
    withPreFixDaemonProbe((preFix) => {
      const r = runScript(preFix, d, [], { daemon: 'UNKNOWN' });
      expect(r.stdout).toMatch(/daemon is RUNNING \(pid 515151\)/);
      expect(r.stdout).toMatch(/it locks the DBs/);
    });
  });

  it('TEETH (contrast): the POST-FIX probe does NOT make either false claim for the same fixtures', () => {
    const foreign = runVerify(d, [], { daemon: 'FOREIGN' });
    expect(foreign.stdout).not.toMatch(/is RUNNING for THIS target/);
    const unknown = runVerify(d, [], { daemon: 'UNKNOWN' });
    expect(unknown.stdout).not.toMatch(/is RUNNING for THIS target/);
  });
});


describe('verify-learning: healthy loop', () => {
  let d;
  beforeAll(() => { d = mkTarget(); buildHealthy(d); });
  afterAll(() => fs.rmSync(d, { recursive: true, force: true }));

  it('exits 0 and verdict is not hollow', () => {
    const r = runVerify(d, ['--json']);
    expect(r.status).toBe(0);
    expect(parseJson(r.stdout).verdict).not.toBe('hollow');
    expect(parseJson(r.stdout).fail).toBe(0);
  });
});

// #2 measures the CANONICAL reflexion store (agentdb.db), NOT .swarm/memory.db
// (which is hollow by design). This guards the gap-#2 store-divergence fix.
describe('verify-learning: #2 reads agentdb.db, not .swarm', () => {
  function base(d) {
    sqlite(path.join(d, '.swarm', 'memory.db'),
      'CREATE TABLE memory_entries(id INTEGER); INSERT INTO memory_entries VALUES (1),(2);' +
      'CREATE TABLE graph_edges(id INTEGER); INSERT INTO graph_edges VALUES (1);');
    sqlite(path.join(d, '.agentic-qe', 'memory.db'),
      'CREATE TABLE vectors(dimensions INTEGER, embedding BLOB); INSERT INTO vectors VALUES (384, zeroblob(1536));' +
      'CREATE TABLE sona_patterns(id INTEGER); INSERT INTO sona_patterns VALUES (1);' +
      'CREATE TABLE routing_outcomes(id INTEGER);');
    fs.writeFileSync(path.join(d, '.agentic-qe', 'config.yaml'), 'learning:\n  hnswConfig:\n    useNativeHNSW: true\n');
    fs.writeFileSync(path.join(d, '.swarm', 'lora-weights.json'), JSON.stringify({ stats: { totalUpdates: 5, totalAdaptations: 9 } }));
  }

  it('OK when agentdb.db has episodes even though .swarm structured tables are empty', () => {
    const d = mkTarget(); base(d);
    sqlite(path.join(d, 'agentdb.db'), 'CREATE TABLE episodes(id INTEGER); INSERT INTO episodes VALUES (1),(2),(3); CREATE TABLE skills(id INTEGER);');
    const r = runVerify(d);
    expect(r.stdout).toMatch(/reflexion store populated \(agentdb\.db: 3 episodes/);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('HOLLOW (points at harvest) when agentdb.db is absent but harvestable experiences exist — .swarm episodes are NOT counted', () => {
    const d = mkTarget(); base(d);
    // Put episodes in the WRONG store (.swarm/memory.db) — must be IGNORED for #2.
    spawnSync('sqlite3', [path.join(d, '.swarm', 'memory.db'),
      'CREATE TABLE episodes(id INTEGER); INSERT INTO episodes VALUES (1),(2);'], { encoding: 'utf8' });
    // Eligible harvest input exists → the empty canonical store is a real defect.
    sqlite(path.join(d, '.agentic-qe', 'memory.db'),
      'CREATE TABLE captured_experiences(task TEXT, success INTEGER, quality REAL, embedding BLOB);' +
      "INSERT INTO captured_experiences VALUES ('t', 1, 0.95, zeroblob(4));");
    // No agentdb.db created → the canonical reflexion store is genuinely empty.
    const r = runVerify(d);
    expect(r.stdout).toMatch(/reflexion store HOLLOW.*ruflo-kit harvest/);
    expect(r.status).toBe(1);
    fs.rmSync(d, { recursive: true, force: true });
  });
});

// Fresh post-setup target (first fresh-target e2e, 2026-07-18): the kit's own
// init/pretrain seeds flat memory_entries and neural-train writes lora updates,
// but NO session has captured experiences or routed through the adapter yet.
// That state is "primed", NOT hollow — setup must be able to PROVE it.
describe('verify-learning: fresh post-setup target is primed, not hollow', () => {
  let d;
  beforeAll(() => {
    d = mkTarget();
    sqlite(path.join(d, '.swarm', 'memory.db'),
      'CREATE TABLE memory_entries(id INTEGER); INSERT INTO memory_entries VALUES (1),(2),(3),(4),(5);' +
      'CREATE TABLE graph_edges(id INTEGER); INSERT INTO graph_edges VALUES (1);');
    sqlite(path.join(d, '.agentic-qe', 'memory.db'),
      'CREATE TABLE vectors(dimensions INTEGER, embedding BLOB); INSERT INTO vectors VALUES (384, zeroblob(1536));' +
      'CREATE TABLE sona_patterns(id INTEGER); INSERT INTO sona_patterns VALUES (1);' +
      'CREATE TABLE routing_outcomes(id INTEGER); INSERT INTO routing_outcomes VALUES (1);' +
      // Experience table exists but has nothing harvest-eligible yet.
      'CREATE TABLE captured_experiences(task TEXT, success INTEGER, quality REAL, embedding BLOB);' +
      "INSERT INTO captured_experiences VALUES ('low-quality', 1, 0.2, zeroblob(4)), ('failed', 0, 0.9, zeroblob(4));");
    fs.writeFileSync(path.join(d, '.agentic-qe', 'config.yaml'), 'learning:\n  hnswConfig:\n    useNativeHNSW: true\n');
    // Bootstrap neural-train wrote updates; the adapter was never applied — and
    // there are no session records, so this must NOT be called a JS fallback.
    fs.writeFileSync(path.join(d, '.swarm', 'lora-weights.json'),
      JSON.stringify({ stats: { totalUpdates: 200, totalAdaptations: 0 } }));
  });
  afterAll(() => fs.rmSync(d, { recursive: true, force: true }));

  it('exits 0 with no FAILs (proof P10 maps live|partial → PASS)', () => {
    const r = runVerify(d, ['--json']);
    expect(r.status).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.verdict).not.toBe('hollow');
    expect(j.fail).toBe(0);
  });

  it('names the primed states honestly (no false JS-FALLBACK / HOLLOW claims)', () => {
    const r = runVerify(d);
    expect(r.stdout).toMatch(/reflexion store not yet populated/);
    expect(r.stdout).toMatch(/lora trainer primed/);
    expect(r.stdout).not.toMatch(/JS FALLBACK/);
  });

  it('flips to HOLLOW the moment a session captures an eligible experience that is never harvested (embedding-less rows count — HARVEST-VECLESS-V1)', () => {
    // aqe 3.12.2 captures experiences with embedding=NULL; harvest's reflexion
    // sink consumes them anyway, so they are harvestable and must arm the tripwire.
    sqlite(path.join(d, '.agentic-qe', 'memory.db'),
      "INSERT INTO captured_experiences VALUES ('real work', 1, 0.9, NULL);");
    fs.mkdirSync(path.join(d, '.claude-flow', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(d, '.claude-flow', 'sessions', 'session-9.json'), '{}');
    const r = runVerify(d, ['--json']);
    expect(r.status).toBe(1);
    expect(parseJson(r.stdout).verdict).toBe('hollow');
  });
});

describe('assert_vector_dim_ok dimension guard (issue #4 #6)', () => {
  function guard(db, table, col, dimc, exp) {
    const r = spawnSync('bash', ['-c',
      `source "${COMMON}"; assert_vector_dim_ok "${db}" "${table}" "${col}" "${dimc}" "${exp}"`],
      { encoding: 'utf8' });
    return r.stdout.trim();
  }
  let d;
  beforeAll(() => {
    d = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-'));
    sqlite(path.join(d, 'ok.db'), 'CREATE TABLE vectors(dimensions INTEGER, embedding BLOB); INSERT INTO vectors VALUES (384, zeroblob(1536));');
    sqlite(path.join(d, 'baddim.db'), 'CREATE TABLE vectors(dimensions INTEGER, embedding BLOB); INSERT INTO vectors VALUES (1536, zeroblob(1536));');
    sqlite(path.join(d, 'badblob.db'), 'CREATE TABLE vectors(dimensions INTEGER, embedding BLOB); INSERT INTO vectors VALUES (384, zeroblob(999));');
    sqlite(path.join(d, 'empty.db'), 'CREATE TABLE vectors(dimensions INTEGER, embedding BLOB);');
  });
  afterAll(() => fs.rmSync(d, { recursive: true, force: true }));

  it('OK when dimensions==384 and blob==dim*4', () => {
    expect(guard(path.join(d, 'ok.db'), 'vectors', 'embedding', 'dimensions', '384')).toBe('OK');
  });
  it('DIM_MISMATCH when declared dimension != expected (the issue\'s 1536 misread, now guarded)', () => {
    expect(guard(path.join(d, 'baddim.db'), 'vectors', 'embedding', 'dimensions', '384')).toMatch(/^DIM_MISMATCH:1536/);
  });
  it('BLOB_MISMATCH when blob bytes != dimensions*4', () => {
    expect(guard(path.join(d, 'badblob.db'), 'vectors', 'embedding', 'dimensions', '384')).toMatch(/^BLOB_MISMATCH:/);
  });
  it('EMPTY on a zero-row table', () => {
    expect(guard(path.join(d, 'empty.db'), 'vectors', 'embedding', 'dimensions', '384')).toBe('EMPTY');
  });
  it('NO_TABLE on a missing db / table', () => {
    expect(guard(path.join(d, 'nope.db'), 'vectors', 'embedding', 'dimensions', '384')).toBe('NO_TABLE');
  });
});
