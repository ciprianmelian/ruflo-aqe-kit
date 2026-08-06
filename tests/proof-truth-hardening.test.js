/**
 * Falsification + absent-subject fixtures for the Wave-2 B1+B2 ("proof truth")
 * hardening of lib/proof.sh (marker PROOF-V1), per the gauntlet self-audit
 * (the gauntlet 2026-07-31 kit self-audit, findings F3/F5/F6).
 *
 * This file is deliberately self-contained (its own harness, not shared with
 * tests/proof.test.js) so it can be added without touching any existing test
 * file's internals beyond the minimal fixture fix already made in
 * tests/proof.test.js (mkTarget's installed statusline, required because P15
 * now renders that file — see F6 below).
 *
 * Every scenario here demonstrates the property FAILING/escalating on a
 * deliberately broken fixture, and — where applicable — the absent-subject
 * shape (subject legitimately missing must never be silently treated as
 * broken).
 *
 *   F6 (P15 statusline-truth): a hacked INSTALLED statusline with a fake
 *       vectorCount must FAIL even when the (unrendered) kit asset would have
 *       honestly PASSed — proving P15 no longer verifies a proxy artifact.
 *   F3 (x2 escalation): a permanently non-answering ruflo-mcp escalates a
 *       stable WARN to FAILED, WITHOUT any single-pass probe raw-FAILing —
 *       and a legitimately empty (absent-by-design-shaped) hooks-route result
 *       must NOT escalate, staying PROVED-eligible.
 *   F5 (P9 HOOK-BLOCK-EXIT2-V1 behavioral): a sentinel string surviving in
 *       unreachable ("dead") code must FAIL the behavioral drive even though
 *       a grep would have said "present"; a reverted patch (sentinel gone)
 *       must FAIL too; an absent hook-handler.cjs (aqe hooks not installed)
 *       must NOT fail merely because the subject doesn't exist.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIB = path.resolve(__dirname, '..', 'lib');
const PIN = '3.0.0-alpha.10';
const HOISTED = '3.0.0-alpha.17';

const worlds = [];
afterEach(() => {
  while (worlds.length) {
    const w = worlds.pop();
    try { fs.rmSync(w, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function writeExec(p, body) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
}

// P16 memory-roundtrip: shared `ruflo memory {init,store,retrieve,purge}`
// handling for every ruflo shim body in this file (mirrors tests/proof.test.js's
// MEMORY_SHIM_BLOCK). Backed by the REAL sqlite3 CLI — this file no longer
// shims sqlite3 as a no-op logger (nothing here ever asserted on its call
// log), so the real system CLI resolves for both this block's own backing
// AND kit_memory_roundtrip_check's independent on-disk read.
const MEMORY_SHIM_BLOCK = `if [ "$1" = "memory" ]; then
  shift
  msub="$1"; shift
  mpath=""; mkey=""; mns=""; mval=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --path) mpath="$2"; shift 2 ;;
      -k) mkey="$2"; shift 2 ;;
      -n|--namespace) mns="$2"; shift 2 ;;
      --value) mval="$2"; shift 2 ;;
      --force|--value-only) shift ;;
      --backend) shift 2 ;;
      *) shift ;;
    esac
  done
  case "$msub" in
    init)     sqlite3 "$mpath" "CREATE TABLE IF NOT EXISTS memory_entries (namespace TEXT, key TEXT, content TEXT);"; exit $? ;;
    store)    sqlite3 "$mpath" "DELETE FROM memory_entries WHERE namespace='$mns' AND key='$mkey'; INSERT INTO memory_entries (namespace,key,content) VALUES ('$mns','$mkey','$mval');"; exit $? ;;
    retrieve) sqlite3 "$mpath" "SELECT content FROM memory_entries WHERE namespace='$mns' AND key='$mkey' LIMIT 1;"; exit 0 ;;
    purge)    sqlite3 "$mpath" "DELETE FROM memory_entries WHERE namespace='$mns';"; exit $? ;;
    *)        exit 0 ;;
  esac
fi`;

function mkGroot(base) {
  const groot = path.join(base, 'groot');
  const pkg = (rel, ver, extra) => {
    const d = path.join(groot, rel);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'agentdb', version: ver, ...(extra || {}) }));
    return d;
  };
  pkg('agentdb', PIN);
  pkg('ruflo/node_modules/agentdb', HOISTED);
  const nested = pkg('ruflo/node_modules/@claude-flow/memory/node_modules/agentdb', PIN, { main: 'index.js' });
  let src = '';
  const names = [];
  for (let i = 0; i < 25; i++) { src += `class C${i} {}\n`; names.push(`C${i}`); }
  fs.writeFileSync(path.join(nested, 'index.js'), src + `module.exports = { ${names.join(', ')} };\n`);
  const bs = path.join(groot, 'agentdb', 'node_modules', 'better-sqlite3');
  fs.mkdirSync(bs, { recursive: true });
  fs.writeFileSync(path.join(bs, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '11.8.1', main: 'index.js' }));
  // P6 bsqlite (SQLITE-DEEP-V1) deep-probes resolve -> require() -> `new
  // Database(':memory:')` -> `SELECT 1` -> close — a bare `module.exports =
  // {}` (require()-only healthy) would read as 'broken' (not a constructor)
  // and wrongly FAIL every all-green-fixture test in this file.
  fs.writeFileSync(path.join(bs, 'index.js'), [
    "module.exports = function FakeDatabase(file) {",
    "  return { prepare(sql) { return { get() { return { ok: 1 }; } }; }, close() {} };",
    "};",
  ].join('\n') + '\n');
  return groot;
}

// mcpMode: 'answer' (real JSON-RPC reply — healthy) | 'silent' (spawns, prints
// nothing, exits fast — the F3 "permanently no answer" fixture).
// hooksRouteMode: 'answer' (a real decision) | 'empty' (rc 0, empty output —
// the F3 "legitimately nothing to route" control, must NOT escalate).
function mkBin(base, groot, callLog, { mcpMode = 'answer', hooksRouteMode = 'answer' } = {}) {
  const bin = path.join(base, 'bin');
  const logLine = (name) => `echo "${name} $* :: RUVNET_BRAIN_KB=\${RUVNET_BRAIN_KB:-<unset>}" >> "${callLog}"`;

  const mcpLine = mcpMode === 'silent'
    ? `if [ "$1" = "mcp" ] && [ "$2" = "start" ]; then exit 0; fi`
    : `if [ "$1" = "mcp" ] && [ "$2" = "start" ]; then echo '{"jsonrpc":"2.0","id":1,"result":{}}'; sleep 0.1; exit 0; fi`;
  const routeLine = hooksRouteMode === 'empty'
    ? `if [ "$1" = "hooks" ] && [ "$2" = "route" ]; then exit 0; fi`
    : `if [ "$1" = "hooks" ] && [ "$2" = "route" ]; then echo "route: coder -> hierarchical"; exit 0; fi`;

  writeExec(path.join(bin, 'ruflo'), `#!/usr/bin/env bash
${logLine('ruflo')}
if [ "$1" = "--version" ]; then echo "3.32.2"; exit 0; fi
${mcpLine}
${routeLine}
${MEMORY_SHIM_BLOCK}
exit 0
`);
  writeExec(path.join(bin, 'aqe'), `#!/usr/bin/env bash\n${logLine('aqe')}\nif [ "$1" = "--version" ]; then echo "3.12.2"; exit 0; fi\nexit 0\n`);
  writeExec(path.join(bin, 'agentdb'), `#!/usr/bin/env bash\n${logLine('agentdb')}\nexit 0\n`);
  // sqlite3 is left unshimmed so the real system CLI resolves (P16
  // memory-roundtrip needs a genuinely working sqlite3 — see MEMORY_SHIM_BLOCK
  // above); nothing in this file ever asserted on a sqlite3 call-log line.
  writeExec(path.join(bin, 'npm'), `#!/usr/bin/env bash
${logLine('npm')}
if [ "$1" = "root" ] && [ "$2" = "-g" ]; then echo "${groot}"; exit 0; fi
if [ "$1" = "--version" ]; then echo "10.8.0"; exit 0; fi
exit 0
`);
  return bin;
}

function writeKitAsset(kit, opts) {
  const omit = new Set(opts.omit || []);
  const tests = { testFiles: opts.testFiles, testCases: opts.testCases };
  if (!omit.has('countMethod')) tests.countMethod = opts.countMethod;
  const payload = { swarmdb: { vectorCount: opts.vectorCount }, tests };
  const asset = path.join(kit, 'assets', 'statusline.cjs');
  fs.mkdirSync(path.dirname(asset), { recursive: true });
  fs.writeFileSync(asset,
    '#!/usr/bin/env node\n' +
    `if (process.argv.includes('--json')) console.log(${JSON.stringify(JSON.stringify(payload))});\n`);
  fs.chmodSync(asset, 0o755);
  return asset;
}

function writeInstalledStatusline(target, opts) {
  const omit = new Set((opts && opts.omit) || []);
  const tests = { testFiles: opts.testFiles, testCases: opts.testCases };
  if (!omit.has('countMethod')) tests.countMethod = opts.countMethod;
  const payload = { swarmdb: { vectorCount: opts.vectorCount }, tests };
  const sl = path.join(target, '.claude', 'helpers', 'statusline.cjs');
  fs.mkdirSync(path.dirname(sl), { recursive: true });
  fs.writeFileSync(sl,
    '#!/usr/bin/env node\n' +
    '// DAEMON-AUTOSTART-3-V1 child-env pin present (test fixture)\n' +
    `if (process.argv.includes('--json')) console.log(${JSON.stringify(JSON.stringify(payload))});\n`);
  fs.chmodSync(sl, 0o755);
  return sl;
}

function seedSwarmVectors(target, m) {
  const db = path.join(target, '.swarm', 'memory.db');
  try { fs.rmSync(db, { force: true }); } catch { /* ignore */ }
  const rows = Array.from({ length: m }, (_, i) => `(${i + 1}, x'00')`).join(',');
  const sql = `CREATE TABLE memory_entries(id INTEGER, embedding BLOB); INSERT INTO memory_entries(id, embedding) VALUES ${rows};`;
  const r = spawnSync('sqlite3', [db, sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('sqlite3 seed failed: ' + (r.stderr || r.error));
  return m;
}

// hookHandler: 'absent' | 'working' | 'dead-code' | 'reverted'.
//   working    — real substring-match contract: exits 2 on a recognized
//                dangerous command, 0 otherwise. Sentinel present + reachable.
//   dead-code  — sentinel comment textually present (passes a grep) but the
//                block that would exit(2) is wrapped in `if (false)` — the
//                exact F4/F5 "sentinel survives, code path doesn't" shape.
//   reverted   — sentinel entirely absent (patch never applied / stripped),
//                dangerous commands fall through to a non-blocking exit(1).
//   absent     — no hook-handler.cjs installed at all (aqe hooks not present).
function writeHookHandler(target, variant) {
  const hh = path.join(target, '.claude', 'helpers', 'hook-handler.cjs');
  if (variant === 'absent') { try { fs.rmSync(hh, { force: true }); } catch { /* ignore */ } return hh; }
  fs.mkdirSync(path.dirname(hh), { recursive: true });
  const preamble = `#!/usr/bin/env node
'use strict';
let data = '';
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  let hookInput = {};
  try { hookInput = JSON.parse(data); } catch (e) { /* ignore */ }
  const toolInput = hookInput.tool_input || hookInput.toolInput || {};
  const cmd = String(hookInput.command || toolInput.command || '').toLowerCase();
  const dangerous = ['rm -rf /', 'format c:', 'del /s /q c:\\\\', ':(){:|:&};:'];
`;
  let body;
  if (variant === 'working') {
    body = `  for (const d of dangerous) {
    if (cmd.includes(d)) {
      console.error('[BLOCKED] Dangerous command detected: ' + d);
      // Exit 2 = blocking per the Claude Code hook contract (exit 1 is non-blocking). HOOK-BLOCK-EXIT2-V1
      process.exit(2);
    }
  }
  console.log('[OK] Command validated');
  process.exit(0);
`;
  } else if (variant === 'dead-code') {
    // F4/F5 fixture: the sentinel string SURVIVES textually (a grep would say
    // "present") but the block containing process.exit(2) is unreachable.
    body = `  if (false) {
    for (const d of dangerous) {
      if (cmd.includes(d)) {
        console.error('[BLOCKED] Dangerous command detected: ' + d);
        // Exit 2 = blocking per the Claude Code hook contract (exit 1 is non-blocking). HOOK-BLOCK-EXIT2-V1
        process.exit(2);
      }
    }
  }
  console.log('[OK] Command validated (unreachable block never runs)');
  process.exit(0);
`;
  } else if (variant === 'reverted') {
    // Patch never applied / stripped: no sentinel anywhere, non-blocking exit(1).
    body = `  for (const d of dangerous) {
    if (cmd.includes(d)) {
      console.error('[BLOCKED] Dangerous command detected: ' + d);
      process.exit(1);
    }
  }
  console.log('[OK] Command validated');
  process.exit(0);
`;
  } else {
    throw new Error('unknown hookHandler variant: ' + variant);
  }
  fs.writeFileSync(hh, preamble + body + '});\n');
  fs.chmodSync(hh, 0o755);
  return hh;
}

// A fake installed ruvector MCP server, planted under a global-package-style
// nested node_modules (mirroring the real "under agentdb / under ruflo"
// shape — the find pattern proof.sh uses only cares that the path SUFFIX is
// ".../node_modules/ruvector/bin/mcp-server.js", not what precedes it).
// variant: 'vulnerable' (still shells out via a template-string execSync,
// the exact pre-9612e8e3 injection shape) | 'clean' (execFileSync, argv-only,
// zero execSync( occurrences anywhere in the file — the post-fix shape).
function writeRuvectorMcpServer(groot, underPkg, variant) {
  const f = path.join(groot, underPkg, 'node_modules', 'ruvector', 'bin', 'mcp-server.js');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const body = variant === 'vulnerable'
    ? "const { execSync } = require('child_process');\n" +
      "function hooksInit(args) {\n" +
      "  const cmd = `npx ruvector hooks init ${sanitizeShellArg(args.task)}`;\n" +
      "  return execSync(cmd, { encoding: 'utf-8' });\n" +
      "}\n" +
      "module.exports = { hooksInit };\n"
    : "const { execFileSync } = require('child_process');\n" +
      "function hooksInit(args) {\n" +
      "  return execFileSync('npx', ['ruvector', 'hooks', 'init', args.task], { encoding: 'utf-8' });\n" +
      "}\n" +
      "module.exports = { hooksInit };\n";
  fs.writeFileSync(f, body);
  return f;
}

function mkKit(base) {
  const kit = path.join(base, 'kit');
  const lib = path.join(kit, 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.copyFileSync(path.join(LIB, 'common.sh'), path.join(lib, 'common.sh'));
  fs.copyFileSync(path.join(LIB, 'proof.sh'), path.join(lib, 'proof.sh'));
  writeExec(path.join(lib, 'status.sh'), `#!/usr/bin/env bash\necho '{"sentinels":{"present":6,"total":6}}'\n`);
  writeExec(path.join(lib, 'verify-learning.sh'), `#!/usr/bin/env bash\necho '{"pass":1,"warn":0,"fail":0,"info":0,"verdict":"live"}'\n`);
  writeExec(path.join(lib, 'health.sh'), `#!/usr/bin/env bash\necho '{"metrics":{"memory":{"totalEntries":100,"hnswEntries":50}}}'\n`);
  writeKitAsset(kit, { vectorCount: 0, testFiles: 2, testCases: 10, countMethod: 'regex-scan' });
  return kit;
}

function mkTarget(base) {
  const target = path.join(base, 'target');
  fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
  const launcher = path.join(target, 'vendor', 'server.mjs');
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, '// launcher\n');
  const kb = path.join(base, 'kb');
  fs.mkdirSync(kb, { recursive: true });
  fs.writeFileSync(path.join(kb, 'forge-mcp-all.mjs'), '// forge\n');
  fs.writeFileSync(path.join(kb, 'package.json'), JSON.stringify({ name: 'ruvnet-brain-kb', version: '2.9.0' }));
  fs.writeFileSync(path.join(target, '.mcp.json'), JSON.stringify({
    mcpServers: { 'ruvnet-brain': { command: 'node', args: [launcher], env: { RUVNET_BRAIN_KB: kb } } },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(target, '.claude', 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: 'echo PROOF_SL_OK' },
  }, null, 2) + '\n');
  fs.mkdirSync(path.join(target, '.swarm'), { recursive: true });
  fs.mkdirSync(path.join(target, '.agentic-qe'), { recursive: true });
  for (const db of ['.swarm/memory.db', '.agentic-qe/memory.db', 'agentdb.db']) {
    fs.writeFileSync(path.join(target, db), '');
  }
  fs.writeFileSync(path.join(target, 'claude-flow.config.json'),
    JSON.stringify({ daemon: { autostart: false } }, null, 2) + '\n');
  writeInstalledStatusline(target, { vectorCount: 0, testFiles: 2, testCases: 10, countMethod: 'regex-scan' });
  return target;
}

function build({ mcpMode = 'answer', hooksRouteMode = 'answer', hookHandler = 'working' } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prooftruth-')));
  worlds.push(base);
  const groot = mkGroot(base);
  const callLog = path.join(base, 'calls.log');
  fs.writeFileSync(callLog, '');
  const bin = mkBin(base, groot, callLog, { mcpMode, hooksRouteMode });
  const kit = mkKit(base);
  const target = mkTarget(base);
  writeHookHandler(target, hookHandler);
  const run = (args = []) => {
    // HOME is pinned to the isolated fixture `base`, NOT the real developer
    // machine's $HOME: the ruvector-execsafe check in probe_sentinels searches
    // "$HOME/.nvm" for installed ruvector copies, and a real dev machine's nvm
    // tree would otherwise leak real installed state into these fixtures'
    // otherwise-fully-controlled results (non-determinism, not a fixture bug).
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: base };
    const r = spawnSync('bash', [path.join(kit, 'lib', 'proof.sh'), target, ...args], { encoding: 'utf8', env });
    return { code: r.status, stdout: r.stdout || '', out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  return { base, kit, target, bin, groot, run };
}

function probe(j, name) { return j.probes.find((p) => p.name === name); }

// ── F6: P15 must verify the INSTALLED statusline, not a proxy asset ─────────
describe('F6 falsification: P15 renders the installed statusline, not the kit asset', () => {
  it('a hacked installed statusline (fake vectorCount) FAILs even when the unrendered kit asset would have honestly PASSed', () => {
    const { run, kit, target } = build();
    const m = seedSwarmVectors(target, 5);
    // The kit asset — if this were still rendered (the pre-fix behavior) —
    // reports the HONEST count and would PASS.
    writeKitAsset(kit, { vectorCount: m, testFiles: 2, testCases: 10, countMethod: 'regex-scan' });
    // The INSTALLED file is hacked: keeps the shape but hardcodes a fake count.
    writeInstalledStatusline(target, { vectorCount: 500, testFiles: 2, testCases: 10, countMethod: 'regex-scan' });
    const j = JSON.parse(run(['--single', '--json']).stdout.trim());
    const p = probe(j, 'statusline-truth');
    expect(p.verdict).toBe('FAIL');
    expect(p.detail).toMatch(/^\[installed\]/);
    expect(p.detail).toMatch(/drift/i);
  });

  it('absent-subject: no installed file at all falls back to the kit asset (fresh target), not a FAIL', () => {
    const { run, kit, target } = build();
    const m = seedSwarmVectors(target, 4);
    fs.rmSync(path.join(target, '.claude', 'helpers', 'statusline.cjs'), { force: true });
    writeKitAsset(kit, { vectorCount: m, testFiles: 2, testCases: 10, countMethod: 'regex-scan' });
    const j = JSON.parse(run(['--single', '--json']).stdout.trim());
    const p = probe(j, 'statusline-truth');
    expect(p.verdict).toBe('PASS');
    expect(p.detail).toMatch(/^\[kit-asset-fallback/);
  });
});

// ── F3: escalate a stable, marked NORESP-WARN; never invent FAILs for what's ─
// legitimately absent/empty ──────────────────────────────────────────────────
describe('F3 falsification: PROVED must not tolerate a permanently dead MCP server', () => {
  it('ruflo-mcp answers with NORESP identically in both passes -> x2 verdict FAILED via escalation (no probe raw-FAILed)', () => {
    const { run } = build({ mcpMode: 'silent' });

    const single = JSON.parse(run(['--single', '--json']).stdout.trim());
    const singleP = probe(single, 'ruflo-mcp');
    // Single pass: this is a WARN, never a raw FAIL — escalation is an x2-only concept.
    expect(singleP.verdict).toBe('WARN');
    expect(singleP.detail).toMatch(/\[noresp-timeout\]/);
    expect(single.failed).toBe(0);

    const x2 = JSON.parse(run(['--json']).stdout.trim());
    expect(x2.stable).toBe(true);
    expect(x2.pass1.failed).toBe(0);
    expect(x2.pass2.failed).toBe(0);
    expect(x2.escalated).toContain('ruflo-mcp');
    expect(x2.verdict).toBe('FAILED');
  });

  it('absent-subject / non-escalation control: hooks route legitimately empty (rc 0) on both passes stays PROVED, not escalated', () => {
    const { run } = build({ hooksRouteMode: 'empty' });
    const single = JSON.parse(run(['--single', '--json']).stdout.trim());
    const swarmSmoke = probe(single, 'swarm-smoke');
    expect(swarmSmoke.verdict).toBe('WARN');
    expect(swarmSmoke.detail).not.toMatch(/\[noresp-timeout\]/);

    const x2 = JSON.parse(run(['--json']).stdout.trim());
    expect(x2.stable).toBe(true);
    expect(x2.escalated).not.toContain('swarm-smoke');
    expect(x2.escalated.length).toBe(0);
    expect(x2.verdict).toBe('PROVED');
  });
});

// ── F5: P9's HOOK-BLOCK-EXIT2-V1 check must be behavioral, not a sentinel grep
describe('F5 falsification: the dangerous-command block must actually block', () => {
  it('dead-code fixture: sentinel string survives (would pass a grep) but the guarded exit(2) is unreachable -> P9 FAILs behaviorally', () => {
    const { run } = build({ hookHandler: 'dead-code' });
    const j = JSON.parse(run(['--single', '--json']).stdout.trim());
    const p = probe(j, 'sentinels');
    expect(p.verdict).toBe('FAIL');
    expect(p.detail).toMatch(/would NOT actually block/i);
  });

  it('reverted-patch fixture: sentinel absent entirely -> P9 FAILs on the missing sentinel', () => {
    const { run } = build({ hookHandler: 'reverted' });
    const j = JSON.parse(run(['--single', '--json']).stdout.trim());
    const p = probe(j, 'sentinels');
    expect(p.verdict).toBe('FAIL');
    expect(p.detail).toMatch(/HOOK-BLOCK-EXIT2-V1 sentinel absent/);
  });

  it('absent-subject: no hook-handler.cjs installed at all (aqe hooks not present) does not FAIL merely for being absent', () => {
    const { run } = build({ hookHandler: 'absent' });
    const j = JSON.parse(run(['--single', '--json']).stdout.trim());
    const p = probe(j, 'sentinels');
    expect(p.verdict).toBe('PASS');
  });

  it('positive control: a working, reachable exit(2) block PASSes with behavioral confirmation in the detail', () => {
    const { run } = build({ hookHandler: 'working' });
    const j = JSON.parse(run(['--single', '--json']).stdout.trim());
    const p = probe(j, 'sentinels');
    expect(p.verdict).toBe('PASS');
    expect(p.detail).toMatch(/verified behaviorally/i);
  });
});

// ── F5 addendum: RUVECTOR-EXECSAFE-V1 asserted as a PROPERTY, not a sentinel ─
// A concrete instance of "sentinel grep is the weak form": the probe must
// assert zero remaining shell-interpolated execSync( calls, not the presence
// of a RUVECTOR-EXECSAFE-V1 comment (which a partially-patched or reverted
// copy could still carry).
describe('F5 addendum: ruvector MCP shell-injection (RUVECTOR-EXECSAFE-V1) asserted as a property', () => {
  it('falsification: a vulnerable installed copy (shell-interpolated execSync) FAILs sentinels', () => {
    const { run, groot } = build();
    writeRuvectorMcpServer(groot, 'agentdb', 'vulnerable');
    const j = JSON.parse(run(['--single', '--json']).stdout.trim());
    const p = probe(j, 'sentinels');
    expect(p.verdict).toBe('FAIL');
    expect(p.detail).toMatch(/RUVECTOR-EXECSAFE-V1/);
    expect(p.detail).toMatch(/execSync\(/);
  });

  it('a copy carrying a RUVECTOR-EXECSAFE-V1-shaped comment but still containing execSync( still FAILs (property, not a sentinel grep)', () => {
    const { run, groot } = build();
    const f = path.join(groot, 'agentdb', 'node_modules', 'ruvector', 'bin', 'mcp-server.js');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f,
      "// RUVECTOR-EXECSAFE-V1 patch marker present\n" +
      "const { execSync } = require('child_process');\n" +
      "function hooksDoctor() { return execSync('npx ruvector hooks doctor', { encoding: 'utf-8' }); }\n" +
      "module.exports = { hooksDoctor };\n");
    const j = JSON.parse(run(['--single', '--json']).stdout.trim());
    const p = probe(j, 'sentinels');
    expect(p.verdict).toBe('FAIL');
    expect(p.detail).toMatch(/RUVECTOR-EXECSAFE-V1/);
  });

  it('a clean installed copy (execFileSync, zero execSync() PASSes with a verified-clean note', () => {
    const { run, groot } = build();
    writeRuvectorMcpServer(groot, 'agentdb', 'clean');
    const j = JSON.parse(run(['--single', '--json']).stdout.trim());
    const p = probe(j, 'sentinels');
    expect(p.verdict).toBe('PASS');
    expect(p.detail).toMatch(/ruvector MCP shell-injection verified clean/i);
  });

  it('multiple installed copies (agentdb + ruflo) are ALL checked — one vulnerable copy still FAILs even if another is clean', () => {
    const { run, groot } = build();
    writeRuvectorMcpServer(groot, 'ruflo', 'clean');
    writeRuvectorMcpServer(groot, 'agentdb', 'vulnerable');
    const j = JSON.parse(run(['--single', '--json']).stdout.trim());
    const p = probe(j, 'sentinels');
    expect(p.verdict).toBe('FAIL');
    expect(p.detail).toMatch(/agentdb.*node_modules.*ruvector.*mcp-server\.js/);
  });

  it('absent-subject: no ruvector installed anywhere does not FAIL merely for being absent', () => {
    const { run } = build();
    // mkGroot's fixture never installs ruvector — this is the baseline "not a
    // dependency here" case, matching fix-ruflo's own "nothing to patch" path.
    const j = JSON.parse(run(['--single', '--json']).stdout.trim());
    const p = probe(j, 'sentinels');
    expect(p.verdict).toBe('PASS');
    expect(p.detail).not.toMatch(/ruvector/i);
  });
});

// ── F3 round 2: P3 (aqe-mcp) spawn-failure (ENOENT-class) must escalate too ──
// A REGISTERED agentic-qe entry whose command cannot even be spawned (a stale
// absolute path after an nvm/node-root switch is the realistic real-world
// shape) previously landed in P3's catch-all case branch, which was untagged
// — a permanently unlaunchable registered server graded a stable, silent
// WARN and PROVED. Fixed by marking that branch [noresp-timeout] too. This
// dedicated harness registers an "agentic-qe" MCP entry directly (the shared
// build()/mkTarget() above never does), so it is self-contained rather than
// threaded through the main harness's option set.
function mkGrootP3(base) {
  const groot = path.join(base, 'groot');
  const pkg = (rel, ver, extra) => {
    const d = path.join(groot, rel);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'agentdb', version: ver, ...(extra || {}) }));
    return d;
  };
  pkg('agentdb', PIN);
  pkg('ruflo/node_modules/agentdb', HOISTED);
  const nested = pkg('ruflo/node_modules/@claude-flow/memory/node_modules/agentdb', PIN, { main: 'index.js' });
  let src = ''; const names = [];
  for (let i = 0; i < 25; i++) { src += `class C${i} {}\n`; names.push(`C${i}`); }
  fs.writeFileSync(path.join(nested, 'index.js'), src + `module.exports = { ${names.join(', ')} };\n`);
  const bs = path.join(groot, 'agentdb', 'node_modules', 'better-sqlite3');
  fs.mkdirSync(bs, { recursive: true });
  fs.writeFileSync(path.join(bs, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '11.8.1', main: 'index.js' }));
  // P6 bsqlite (SQLITE-DEEP-V1) deep-probes resolve -> require() -> `new
  // Database(':memory:')` -> `SELECT 1` -> close — a bare `module.exports =
  // {}` (require()-only healthy) would read as 'broken' (not a constructor)
  // and wrongly FAIL every all-green-fixture test in this file.
  fs.writeFileSync(path.join(bs, 'index.js'), [
    "module.exports = function FakeDatabase(file) {",
    "  return { prepare(sql) { return { get() { return { ok: 1 }; } }; }, close() {} };",
    "};",
  ].join('\n') + '\n');
  return groot;
}

// variant: 'enoent' (registered command path does not exist — the round-2
// gap) | 'crash' (registered command exists but exits 1 instantly — was
// already caught pre-fix, kept as a permanent regression control) | 'absent'
// (no agentic-qe entry registered at all — the control that must stay a
// plain PASS so the two states remain distinguishable).
function buildP3(variant) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p3enoent-')));
  worlds.push(base);
  const groot = mkGrootP3(base);
  const bin = path.join(base, 'bin');
  writeExec(path.join(bin, 'ruflo'), `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "3.32.2"; exit 0; fi
if [ "$1" = "mcp" ] && [ "$2" = "start" ]; then echo '{"jsonrpc":"2.0","id":1,"result":{}}'; sleep 0.1; exit 0; fi
if [ "$1" = "hooks" ] && [ "$2" = "route" ]; then echo "route: coder"; exit 0; fi
${MEMORY_SHIM_BLOCK}
exit 0
`);
  writeExec(path.join(bin, 'aqe'), `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "3.12.2"; exit 0; fi\nexit 0\n`);
  writeExec(path.join(bin, 'agentdb'), `#!/usr/bin/env bash\nexit 0\n`);
  // sqlite3 left unshimmed — see the identical note in mkBin above.
  writeExec(path.join(bin, 'npm'), `#!/usr/bin/env bash
if [ "$1" = "root" ] && [ "$2" = "-g" ]; then echo "${groot}"; exit 0; fi
if [ "$1" = "--version" ]; then echo "10.8.0"; exit 0; fi
exit 0
`);

  const kit = path.join(base, 'kit');
  const klib = path.join(kit, 'lib');
  fs.mkdirSync(klib, { recursive: true });
  fs.copyFileSync(path.join(LIB, 'common.sh'), path.join(klib, 'common.sh'));
  fs.copyFileSync(path.join(LIB, 'proof.sh'), path.join(klib, 'proof.sh'));
  writeExec(path.join(klib, 'status.sh'), `#!/usr/bin/env bash\necho '{"sentinels":{"present":6,"total":6}}'\n`);
  writeExec(path.join(klib, 'verify-learning.sh'), `#!/usr/bin/env bash\necho '{"pass":1,"warn":0,"fail":0,"info":0,"verdict":"live"}'\n`);
  writeExec(path.join(klib, 'health.sh'), `#!/usr/bin/env bash\necho '{"metrics":{"memory":{"totalEntries":100,"hnswEntries":50}}}'\n`);
  const payload = JSON.stringify({ swarmdb: { vectorCount: 0 }, tests: { testFiles: 2, testCases: 10, countMethod: 'regex-scan' } });
  writeExec(path.join(kit, 'assets', 'statusline.cjs'),
    `#!/usr/bin/env node\nif (process.argv.includes('--json')) console.log(${JSON.stringify(payload)});\n`);

  const target = path.join(base, 'target');
  fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
  const launcher = path.join(target, 'vendor', 'server.mjs');
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, '// launcher\n');
  const kb = path.join(base, 'kb');
  fs.mkdirSync(kb, { recursive: true });
  fs.writeFileSync(path.join(kb, 'forge-mcp-all.mjs'), '// forge\n');
  fs.writeFileSync(path.join(kb, 'package.json'), JSON.stringify({ name: 'ruvnet-brain-kb', version: '2.9.0' }));

  let aqeCmd = null;
  if (variant === 'enoent') {
    aqeCmd = { command: path.join(base, 'DOES-NOT-EXIST', 'aqe-mcp') };
  } else if (variant === 'crash') {
    const c = path.join(bin, 'aqe-mcp-crash');
    writeExec(c, '#!/usr/bin/env bash\nexit 1\n');
    aqeCmd = { command: c };
  } // 'absent' -> aqeCmd stays null: no agentic-qe entry registered at all.
  const servers = { 'ruvnet-brain': { command: 'node', args: [launcher], env: { RUVNET_BRAIN_KB: kb } } };
  if (aqeCmd) servers['agentic-qe'] = aqeCmd;
  fs.writeFileSync(path.join(target, '.mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2) + '\n');

  fs.writeFileSync(path.join(target, '.claude', 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: 'echo PROOF_SL_OK' },
  }, null, 2) + '\n');
  fs.mkdirSync(path.join(target, '.swarm'), { recursive: true });
  fs.mkdirSync(path.join(target, '.agentic-qe'), { recursive: true });
  for (const db of ['.swarm/memory.db', '.agentic-qe/memory.db', 'agentdb.db']) {
    fs.writeFileSync(path.join(target, db), '');
  }
  fs.writeFileSync(path.join(target, 'claude-flow.config.json'),
    JSON.stringify({ daemon: { autostart: false } }, null, 2) + '\n');
  writeInstalledStatusline(target, { vectorCount: 0, testFiles: 2, testCases: 10, countMethod: 'regex-scan' });

  const run = (args = []) => {
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: base };
    const r = spawnSync('bash', [path.join(kit, 'lib', 'proof.sh'), target, ...args], { encoding: 'utf8', env });
    return { code: r.status, stdout: r.stdout || '', out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  return { base, run };
}

describe('F3 round 2: P3 (aqe-mcp) spawn-failure closes the last unmarked no-answer branch', () => {
  it('registered agentic-qe entry with an ENOENT command -> escalates -> x2 FAILED, zero raw probe FAILs', () => {
    const { run } = buildP3('enoent');
    const single = JSON.parse(run(['--single', '--json']).stdout.trim());
    const p = probe(single, 'aqe');
    expect(p.verdict).toBe('WARN');
    expect(p.detail).toMatch(/\[noresp-timeout\]/);
    expect(single.failed).toBe(0);

    const x2r = run(['--json']);
    const x2 = JSON.parse(x2r.stdout.trim());
    expect(x2.stable).toBe(true);
    expect(x2.pass1.failed).toBe(0);
    expect(x2.pass2.failed).toBe(0);
    expect(x2.escalated).toContain('aqe');
    expect(x2.verdict).toBe('FAILED');
    expect(x2r.code).toBe(1);
  });

  it('regression control: registered agentic-qe entry that spawns and exits 1 instantly was already caught pre-fix — still escalates', () => {
    const { run } = buildP3('crash');
    const x2 = JSON.parse(run(['--json']).stdout.trim());
    expect(x2.escalated).toContain('aqe');
    expect(x2.verdict).toBe('FAILED');
  });

  it('control: no agentic-qe entry registered at all stays a plain PASS (absent-by-design, never reaches the marked branches)', () => {
    const { run } = buildP3('absent');
    const single = JSON.parse(run(['--single', '--json']).stdout.trim());
    const p = probe(single, 'aqe');
    expect(p.verdict).toBe('PASS');
    expect(p.detail).toMatch(/no agentic-qe entry/);
    expect(p.detail).not.toMatch(/\[noresp-timeout\]/);

    const x2 = JSON.parse(run(['--json']).stdout.trim());
    expect(x2.escalated).not.toContain('aqe');
    expect(x2.verdict).toBe('PROVED');
  });
});
