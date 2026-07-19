/**
 * Tests for fix-ruflo's AVGLOSS-HONESTY-V1 dist patch + a canonical-statusline
 * guard.
 *
 * The installed ruflo dist surfaces the LoRA INFERENCE adaptation norm under a
 * training-loss NAME:
 *   avgLoss: Math.round(realLora.avgAdaptationNorm * 10000) / 10000
 * The patch adds an honestly-named sibling `avgAdaptationNorm` next to it (without
 * removing avgLoss — external consumers may key on it), gated on the literal
 * mislabel so it self-retires if upstream renames the field.
 *
 * fix-ruflo.sh is not sourceable standalone (top-level code auto-upgrades the
 * global toolchain) and wire_avgloss_honesty is DRY_RUN-guarded (so a --dry-run
 * would announce nothing). So we exercise the REAL function body extracted from
 * fix-ruflo.sh (awk range → eval), with common.sh sourced for its helpers, over a
 * throwaway fixture dist tree — never touching the real global.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const FIX_RUFLO = path.join(REPO, 'lib', 'fix-ruflo.sh');
const COMMON = path.join(REPO, 'lib', 'common.sh');
const CANONICAL_STATUSLINE = path.join(REPO, 'assets', 'statusline.cjs');

// The exact mislabel line in the installed dist (16-space indent) that the patch
// anchors on, embedded in a minimal getStats() shape.
const MISLABEL_LINE = '                avgLoss: Math.round(realLora.avgAdaptationNorm * 10000) / 10000,';

// Build a fixture dist tree: <root>/@claude-flow/{memory,cli/dist/src/mcp-tools}.
// wire_avgloss_honesty("<memdir>") resolves ht = <memdir>/../cli/dist/src/mcp-tools/hooks-tools.js.
function mkDist(hooksToolsBody) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avgloss-'));
  const cf = path.join(root, '@claude-flow');
  const memdir = path.join(cf, 'memory');
  const htDir = path.join(cf, 'cli', 'dist', 'src', 'mcp-tools');
  fs.mkdirSync(memdir, { recursive: true });
  fs.mkdirSync(htDir, { recursive: true });
  const ht = path.join(htDir, 'hooks-tools.js');
  fs.writeFileSync(ht, hooksToolsBody);
  return { root, memdir, ht };
}

// hooks-tools.js WITH the mislabel (patchable), valid JS so node --check passes.
function mislabelBody() {
  return [
    'function getIntelligenceStats(lora) {',
    '    let loraStats = { rank: 8, alpha: 16, adaptations: 0, avgLoss: 0 };',
    '    if (lora) {',
    '        const realLora = lora.getStats();',
    '        loraStats = {',
    '            rank: realLora.rank,',
    '            adaptations: realLora.totalAdaptations,',
    MISLABEL_LINE,
    '            implementation: \'real-lora\',',
    '        };',
    '    }',
    '    return loraStats;',
    '}',
    'module.exports = { getIntelligenceStats };',
    '',
  ].join('\n');
}

// Run the REAL wire_avgloss_honesty body against a memdir. Returns { code, out }.
function runWire(memdir) {
  const script = [
    'set -uo pipefail',
    `source ${JSON.stringify(COMMON)}`,
    'DRY_RUN=0',
    // Extract the function definition verbatim and define it in this shell.
    `eval "$(awk '/^wire_avgloss_honesty\\(\\) \\{/,/^\\}$/' ${JSON.stringify(FIX_RUFLO)})"`,
    `wire_avgloss_honesty ${JSON.stringify(memdir)}`,
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

describe('fix-ruflo AVGLOSS-HONESTY-V1 dist patch', () => {
  it('adds an honest avgAdaptationNorm sibling and KEEPS the legacy avgLoss field', () => {
    const { root, memdir, ht } = mkDist(mislabelBody());
    runWire(memdir);
    const patched = fs.readFileSync(ht, 'utf8');
    expect(patched).toMatch(/AVGLOSS-HONESTY-V1/);
    expect(patched).toMatch(/avgAdaptationNorm: Math\.round\(realLora\.avgAdaptationNorm \* 10000\) \/ 10000,/);
    // avgLoss must NOT be removed (external consumers may still read it).
    expect(patched).toContain(MISLABEL_LINE);
    // Still valid JS.
    expect(spawnSync('node', ['--check', ht]).status).toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is idempotent — a second run makes no change and reports already-present', () => {
    const { root, memdir, ht } = mkDist(mislabelBody());
    runWire(memdir);
    const afterFirst = fs.readFileSync(ht, 'utf8');
    const second = runWire(memdir);
    expect(fs.readFileSync(ht, 'utf8')).toBe(afterFirst);
    expect(second.out).toMatch(/already present/i);
    // Exactly one sentinel occurrence (no double-application).
    expect(afterFirst.match(/AVGLOSS-HONESTY-V1/g).length).toBe(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('self-retires (no patch) when the literal mislabel is absent from dist', () => {
    const clean = 'module.exports = { getIntelligenceStats: () => ({ avgAdaptationNorm: 0.1 }) };\n';
    const { root, memdir, ht } = mkDist(clean);
    const r = runWire(memdir);
    expect(fs.readFileSync(ht, 'utf8')).toBe(clean); // untouched
    expect(r.out).toMatch(/self-retired|not found/i);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('AVGLOSS-HONESTY-V1 guard: canonical statusline never renders the mislabel', () => {
  it('assets/statusline.cjs contains no avgLoss token (a future chip cannot adopt the mislabel)', () => {
    const src = fs.readFileSync(CANONICAL_STATUSLINE, 'utf8');
    expect(/avgLoss/i.test(src)).toBe(false);
  });

  it('assets/statusline.cjs does not label any LoRA adaptation stat as a "loss"', () => {
    const src = fs.readFileSync(CANONICAL_STATUSLINE, 'utf8');
    // No occurrence of "loss" adjacent to a lora/adaptation stat render.
    expect(/lora[^\n]*loss|loss[^\n]*adapt/i.test(src)).toBe(false);
  });
});
