/**
 * Regression coverage for fix-ruflo's RUFLO-ROUTE-EXPLORE-V2 dual anchor
 * (wire_route_exploration, Patch 70 — see docs/_INSTRUCTIONS.md Tier 24 item 70a).
 *
 * Patch 70 re-anchored the ε-greedy exploration seam after ruflo 3.33.0's #2864
 * replaced Router B's `semanticResult[0].score > 0.4` pick with an
 * `eligibleSemantic` find() (learned patterns gated on support/reliability).
 * The patcher now tries the >=3.33 ELIG anchor first, falling back to the
 * <=3.32 LEGACY anchor, so it applies across both dist generations without a
 * version-number gate. This function shipped with NO dedicated test coverage
 * (verified: no existing test file references RUFLO-ROUTE-EXPLORE or
 * wire_route_exploration before this one) — gauntlet-2026-07-31 B6 item 2a
 * re-verified the anchor against the installed 3.33.0 dist (which already
 * contains d783b623c "route --mode moa", 78/80 commits pre-release) and found
 * NO drift: d783b623c only touches `commands/hooks.ts` (the CLI `hooks route`
 * decorator that splices in a `moaPlan` field AFTER routing already ran) — a
 * different compiled file from `mcp-tools/hooks-tools.js`, where Router B's
 * `eligibleSemantic`/`semanticResult` selection (and this anchor) actually
 * live. Live proof on this host: the installed hooks-tools.js already carries
 * the RUFLO-ROUTE-EXPLORE-V2 sentinel via the ELIG branch, and its
 * `.explore-bak` sibling (the genuine pre-patch capture) confirms a real
 * transformation occurred. This test file locks that verified-clean state in
 * as an automated regression: both anchor generations must keep matching, and
 * a fixture with neither must fail closed (dist-drift warning, untouched
 * file) rather than silently no-op.
 *
 * fix-ruflo.sh is not sourceable standalone and wire_route_exploration is
 * DRY_RUN-guarded, so — matching the AVGLOSS-HONESTY-V1 test's approach — the
 * REAL function body is extracted verbatim from fix-ruflo.sh (awk range) and
 * exercised over a throwaway fixture dist tree; common.sh supplies pass/warn/
 * info/fix. Never touches the real global install.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const FIX_RUFLO = path.join(REPO, 'lib', 'fix-ruflo.sh');
const COMMON = path.join(REPO, 'lib', 'common.sh');

// Byte-exact anchor literals, copied from the patcher embedded in fix-ruflo.sh
// (wire_route_exploration's LEGACY_OLD / ELIG_OLD JS template strings) — kept
// here as plain strings (not re-extracted) so a change to either literal in
// fix-ruflo.sh shows up as a real test failure, not a silently-updated copy.
const LEGACY_OLD = `        if (semanticResult.length > 0 && semanticResult[0].score > 0.4) {
            const topMatch = semanticResult[0];
            agents = topMatch.metadata.agents || ['coder', 'researcher'];
            confidence = topMatch.score;
            matchedPattern = topMatch.intent;
        }`;

const ELIG_OLD = `        if (eligibleSemantic) {
            const topMatch = eligibleSemantic;
            agents = topMatch.metadata.agents || ['coder', 'researcher'];
            confidence = topMatch.score;
            matchedPattern = topMatch.intent;
        }`;

function wrapInRouterFn(anchorBlock) {
  return [
    'function routeTask(semanticResult, eligibleSemantic) {',
    '    let agents = [];',
    '    let confidence = 0;',
    '    let matchedPattern = null;',
    anchorBlock,
    '    return { agents, confidence, matchedPattern };',
    '}',
    'module.exports = { routeTask };',
    '',
  ].join('\n');
}

// Build a fixture dist tree: <root>/@claude-flow/{memory,cli/dist/src/mcp-tools}.
// wire_route_exploration("<memdir>") resolves ht = <memdir>/../cli/dist/src/mcp-tools/hooks-tools.js
// — same layout wire_avgloss_honesty uses (fix-ruflo-avgloss.test.js).
function mkDist(hooksToolsBody) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'route-explore-'));
  const cf = path.join(root, '@claude-flow');
  const memdir = path.join(cf, 'memory');
  const htDir = path.join(cf, 'cli', 'dist', 'src', 'mcp-tools');
  fs.mkdirSync(memdir, { recursive: true });
  fs.mkdirSync(htDir, { recursive: true });
  const ht = path.join(htDir, 'hooks-tools.js');
  fs.writeFileSync(ht, hooksToolsBody);
  return { root, memdir, ht };
}

// Run the REAL wire_route_exploration body against a memdir.
function runWire(memdir) {
  const script = [
    'set -uo pipefail',
    `source ${JSON.stringify(COMMON)}`,
    'DRY_RUN=0',
    'FIXES=0',
    'FIX_LOG=()',
    // Extract the function definition verbatim and define it in this shell —
    // exercises exactly what fix-ruflo.sh ships, not a hand-written stand-in.
    `eval "$(awk '/^wire_route_exploration\\(\\) \\{/,/^\\}$/' ${JSON.stringify(FIX_RUFLO)})"`,
    `wire_route_exploration ${JSON.stringify(memdir)}`,
    // fix() only records to FIX_LOG (no echo) — surface it the same way
    // fix-ruflo.sh's own Summary section does, so a successful application
    // is observable in captured output, not just via file-content assertions.
    'for _e in "${FIX_LOG[@]:-}"; do echo "FIXLOG: $_e"; done',
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

describe('fix-ruflo RUFLO-ROUTE-EXPLORE-V2 dual anchor (wire_route_exploration)', () => {
  it('applies against the >=3.33.0 ELIG anchor (post-#2864 eligibleSemantic shape)', () => {
    const before = wrapInRouterFn(ELIG_OLD);
    const { root, memdir, ht } = mkDist(before);
    const r = runWire(memdir);
    const patched = fs.readFileSync(ht, 'utf8');
    expect(patched).toMatch(/RUFLO-ROUTE-EXPLORE-V2/);
    expect(patched).not.toBe(before); // a real transformation occurred
    // The reversible .explore-bak sibling must hold the exact pre-patch content.
    expect(fs.readFileSync(`${ht}.explore-bak`, 'utf8')).toBe(before);
    expect(spawnSync('node', ['--check', ht]).status).toBe(0);
    expect(r.out).toMatch(/FIXLOG: Wired ε-greedy route exploration/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('applies against the <=3.32.x LEGACY anchor (pre-#2864 semanticResult[0] shape)', () => {
    const { root, memdir, ht } = mkDist(wrapInRouterFn(LEGACY_OLD));
    const r = runWire(memdir);
    const patched = fs.readFileSync(ht, 'utf8');
    expect(patched).toMatch(/RUFLO-ROUTE-EXPLORE-V2/);
    expect(spawnSync('node', ['--check', ht]).status).toBe(0);
    expect(r.out).toMatch(/FIXLOG: Wired ε-greedy route exploration/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is idempotent for the ELIG anchor — re-run is a no-op, single sentinel, reports "already present"', () => {
    const { root, memdir, ht } = mkDist(wrapInRouterFn(ELIG_OLD));
    runWire(memdir);
    const afterFirst = fs.readFileSync(ht, 'utf8');
    const second = runWire(memdir);
    expect(fs.readFileSync(ht, 'utf8')).toBe(afterFirst);
    expect(second.out).toMatch(/already present/i);
    expect(afterFirst.match(/RUFLO-ROUTE-EXPLORE-V2/g).length).toBeGreaterThanOrEqual(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fails closed (dist-drift warning, file untouched) when NEITHER anchor generation matches', () => {
    // Replace ALL occurrences (function param + anchor body) so the anchor
    // literal itself is genuinely gone — a single-occurrence replace here
    // previously hit only the function signature and left the ELIG_OLD
    // anchor text intact, silently testing the happy path instead of drift.
    const drifted = wrapInRouterFn(ELIG_OLD).split('eligibleSemantic').join('somethingElseEntirely');
    const { root, memdir, ht } = mkDist(drifted);
    const before = fs.readFileSync(ht, 'utf8');
    const r = runWire(memdir);
    expect(r.out).toMatch(/anchor not found in hooks-tools\.js \(dist drift\) — NOT applied/);
    expect(fs.readFileSync(ht, 'utf8')).toBe(before); // untouched
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('the ELIG anchor guarantees the explore scan replicates the eligibility gate (support>=2 && reliability>=0.75) — never resurrects a filtered candidate', () => {
    const { root, memdir, ht } = mkDist(wrapInRouterFn(ELIG_OLD));
    runWire(memdir);
    const patched = fs.readFileSync(ht, 'utf8');
    expect(patched).toMatch(/support\)\s*\?\?\s*0\)\s*>=\s*2/);
    expect(patched).toMatch(/reliability\)\s*\?\?\s*0\)\s*>=\s*0\.75/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// NOTE: an earlier revision of this file also asserted that the LIVE installed
// dist carries the RUFLO-ROUTE-EXPLORE-V2 sentinel. That assertion was removed
// after it flipped from pass to fail mid-session with no code change on our
// side — a concurrent process (another gauntlet builder re-running `npm i -g
// ruflo` / fix-ruflo against the SAME shared global install this host uses)
// reset hooks-tools.js to its pristine, unpatched state between two otherwise
// identical `grep -c RUFLO-ROUTE-EXPLORE-V2` checks (2 -> 0), and the
// `.explore-bak` sibling disappeared with it. Whether our patch is CURRENTLY
// applied to the shared global install is operational state, not a property
// of the code under test — asserting it here would make this suite flaky
// under any concurrent installer/fixer activity, which is expected in this
// multi-agent session. The synthetic-fixture tests above are the real
// regression coverage; this describe block keeps only the one invariant that
// does NOT depend on whether our patch happens to be applied right now.
describe('RUFLO-ROUTE-EXPLORE-V2 anchor vs the live installed 3.33.0 dist (if present)', () => {
  const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout.trim();
  const cliHooks = npmRoot
    ? path.join(npmRoot, 'ruflo', 'node_modules', '@claude-flow', 'cli', 'dist', 'src', 'commands', 'hooks.js')
    : null;
  const hasLive = cliHooks && fs.existsSync(cliHooks);

  (hasLive ? it : it.skip)('d783b623c ("route --mode moa") does not introduce a competing eligibleSemantic/semanticResult[0] selection block in the CLI hooks command file — this is upstream file content, independent of whether our own patch is currently applied', () => {
    const src = fs.readFileSync(cliHooks, 'utf8');
    // The CLI route command only splices a moaPlan onto an ALREADY-COMPUTED
    // result; it must not duplicate Router B's own candidate-selection logic
    // (that lives only in mcp-tools/hooks-tools.js, where our anchor patches).
    expect(src).not.toMatch(/eligibleSemantic/);
    expect(src).not.toMatch(/semanticResult\[0\]\.score/);
    // ...but the MoA feature itself should be present, confirming we diffed the right file.
    expect(src).toMatch(/moaPlan/);
  });
});
