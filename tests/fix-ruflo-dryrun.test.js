/**
 * Tests for fix-ruflo.sh --dry-run determinism (DRYRUN-PROBE-NONFATAL-V1).
 *
 * Defect (reproduced against the pre-fix script): Step 6's Connected/Failed
 * check reads `claude mcp list`, a LIVE connectivity probe whose verdict
 * depends on transient server state. In dry-run a "Failed" reading incremented
 * ERRORS and flipped the exit code to 1 — so two back-to-back
 * `sync --dry-run` runs on an identical target disagreed (run A "completed
 * with manual actions (exit 1)", run B clean).
 *
 * Fix under test: in dry-run the Failed verdict is reported as an explicitly
 * live-state-dependent warning and never contributes to the exit code. Live
 * (non-dry-run) escalation is unchanged.
 *
 * Harness: hermetic fixture — fake HOME, fake `claude` (mcp list health
 * controlled via CLAUDE_MCP_HEALTH), fake `npm` (no network; `npm root -g`
 * points into the fixture), fake `ruflo`/`agentdb` binaries, and a fake global
 * @claude-flow/memory tree whose controller-registry already carries the
 * upstream fixes (so no other manual-action path fires). The REAL
 * lib/fix-ruflo.sh + lib/common.sh run unmodified.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const FIX_RUFLO = path.join(REPO, 'lib', 'fix-ruflo.sh');

let work, fakebin, fakehome, groot, target;

function writeExec(p, body) {
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
}

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'fixruflo-dry-'));
  fakebin = path.join(work, 'bin');
  fakehome = path.join(work, 'home');
  groot = path.join(work, 'groot');
  target = path.join(work, 'target');
  fs.mkdirSync(fakebin, { recursive: true });
  fs.mkdirSync(fakehome, { recursive: true });
  fs.mkdirSync(path.join(target, '.claude', 'helpers'), { recursive: true });

  // fake claude: `mcp list` health verdict controlled by CLAUDE_MCP_HEALTH.
  writeExec(path.join(fakebin, 'claude'), `#!/usr/bin/env bash
if [ "\${1:-}" = "mcp" ] && [ "\${2:-}" = "list" ]; then
  echo "claude-flow: ruflo mcp start - \${CLAUDE_MCP_HEALTH:-Connected}"
fi
exit 0
`);
  // fake npm: hermetic, no network, global root inside the fixture.
  writeExec(path.join(fakebin, 'npm'), `#!/usr/bin/env bash
cmd="\${1:-}"; shift 2>/dev/null || true
case "$cmd" in
  root) echo "\${FAKE_GROOT:?}" ;;
  view) echo "9.9.9" ;;
  list) case "$*" in *" ruflo"*) echo "ruflo@9.9.9" ;; *) : ;; esac ;;
  *) : ;;
esac
exit 0
`);
  writeExec(path.join(fakebin, 'ruflo'), '#!/usr/bin/env bash\necho "9.9.9"\nexit 0\n');
  writeExec(path.join(fakebin, 'agentdb'), '#!/usr/bin/env bash\nexit 0\n');

  // fake global @claude-flow/memory with an already-healthy controller-registry
  // (carries the strings Step 10's Patch 0/2 checks look for, so they pass).
  const mem = path.join(groot, 'ruflo', 'node_modules', '@claude-flow', 'memory');
  fs.mkdirSync(path.join(mem, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(mem, 'dist', 'controller-registry.js'), [
    '// fixture registry: already healthy',
    '// pathResolve',
    '// ReasoningBank',
    '// return new RB(this.agentdb.database, embedder)',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(mem, 'package.json'),
    JSON.stringify({ name: '@claude-flow/memory', version: '3.0.0-alpha.18' }) + '\n');

  // target fixture: canonical .mcp.json, minimal settings.json, trivial statusline.
  fs.writeFileSync(path.join(target, '.mcp.json'), JSON.stringify({
    mcpServers: { 'claude-flow': { command: 'ruflo', args: ['mcp', 'start'] } },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(target, '.claude', 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: 'node x' },
    hooks: {},
    permissions: { allow: [] },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(target, '.claude', 'helpers', 'statusline.cjs'),
    'console.log("Swarm ok");\n');
});

afterAll(() => {
  if (work) fs.rmSync(work, { recursive: true, force: true });
});

function runDry(health) {
  const r = spawnSync('bash', [FIX_RUFLO, target, '--dry-run'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fakehome,
      PATH: `${fakebin}:${process.env.PATH}`,
      FAKE_GROOT: groot,
      CLAUDE_MCP_HEALTH: health,
      TMPDIR: work,
    },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// One dry-run per health verdict, on the SAME target — the determinism claim.
describe('fix-ruflo.sh --dry-run: DRYRUN-PROBE-NONFATAL-V1', () => {
  let connected, failed;

  beforeAll(() => {
    connected = runDry('Connected');
    failed = runDry('Failed to connect');
  }, 240000);

  it('exits 0 in dry-run when the live MCP probe reads Connected', () => {
    expect(connected.code).toBe(0);
  });

  it('exits 0 in dry-run even when the live MCP probe reads Failed (no exit flap)', () => {
    // Pre-fix this was exit 1 (ERRORS++) — the reproduced sync --dry-run flap.
    expect(failed.code).toBe(0);
    expect(failed.code).toBe(connected.code);
  });

  it('labels the Failed reading as live-state-dependent instead of a manual action', () => {
    expect(failed.out).toMatch(/live-state-dependent/);
    expect(failed.out).toMatch(/DRYRUN-PROBE-NONFATAL-V1/);
    // and the manual-actions counter stays 0 (ANSI codes sit between label and number)
    expect(failed.out).toMatch(/Manual actions:\s+(?:\[[0-9;]*m)*0/);
  });

  it('makes no writes to the target in dry-run (both probes)', () => {
    // The fixture files are the only content; assert nothing appeared.
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const files = walk(target).map((f) => path.relative(target, f)).sort();
    expect(files).toEqual([
      '.claude/helpers/statusline.cjs',
      '.claude/settings.json',
      '.mcp.json',
    ]);
  });

  it('live (non-dry-run) escalation on a Failed probe is still present in the source', () => {
    // Guard against the fix accidentally removing the real-run error path: the
    // Failed branch must still escalate (fail + ERRORS++) outside dry-run.
    const src = fs.readFileSync(FIX_RUFLO, 'utf8');
    const branch = src.split('DRYRUN-PROBE-NONFATAL-V1').pop();
    expect(branch).toMatch(/MCP server failed — restart Claude Code after fixes/);
    expect(branch).toMatch(/\(\(ERRORS\+\+\)\)/);
  });
});
