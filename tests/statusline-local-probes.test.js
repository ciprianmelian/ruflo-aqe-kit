/**
 * Tests for the statusline.cjs local probes that back the ADR and Tests chips
 * (assets/statusline.cjs — the canonical source installed by fix-statusbar.sh).
 *
 * Regressions fixed (reported from carousel-studio's statusbar):
 *  - ADRs chip showed ●0/0 with 9 ADRs on disk: getLocalADRCount() searched
 *    `docs/adrs` (plural) but not `docs/adr` (singular, the MADR/adr-tools layout).
 *  - Tests chip showed ●0 with hundreds of tests: countTests ran only in the
 *    fallback path, so whenever `ruflo hooks statusline --json` succeeded the
 *    Tests count was never applied. Now overlaid on the primary path too, and
 *    monorepo `packages/*` / `apps/*` are scanned.
 *
 * Strategy: run the canonical asset with --json against a throwaway fixture cwd.
 * A `ruflo` stub that fails fast forces the local-fallback path (no 8s CLI wait),
 * and a unique temp cwd means a unique cache key (no cross-session contamination).
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ASSET = path.resolve(__dirname, '..', 'assets', 'statusline.cjs');

function mkBin() {
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'slbin-'));
  // Force the local-fallback path: a ruflo that emits no JSON.
  fs.writeFileSync(path.join(b, 'ruflo'), '#!/usr/bin/env bash\nexit 1\n');
  fs.chmodSync(path.join(b, 'ruflo'), 0o755);
  return b;
}

function renderJSON(cwd) {
  const bin = mkBin();
  const r = spawnSync(process.execPath, [ASSET, '--json'], {
    encoding: 'utf8', cwd, timeout: 15000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  fs.rmSync(bin, { recursive: true, force: true });
  try { return JSON.parse(r.stdout); } catch (e) { throw new Error('bad JSON: ' + r.stdout + ' ERR ' + r.stderr); }
}

function mkProject(build) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'slproj-'));
  build(d);
  return d;
}
function write(d, rel, content) {
  const f = path.join(d, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content || '');
}

describe('statusline ADR probe (getLocalADRCount)', () => {
  it('counts ADRs in docs/adr (singular) — the carousel regression', () => {
    const d = mkProject((d) => {
      write(d, 'docs/adr/0001-foo.md', '# adr');
      write(d, 'docs/adr/0002-bar.md', '# adr');
      write(d, 'docs/adr/0003-baz.md', '# adr');
      write(d, 'docs/adr/README.md', 'not an adr');   // must NOT count (no NNNN- prefix)
    });
    const j = renderJSON(d);
    expect(j.adrs.count).toBe(3);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('also counts ADR-NNN.md and docs/decisions, and is 0 when none exist', () => {
    const withAdrs = mkProject((d) => {
      write(d, 'docs/decisions/ADR-001-x.md', '# adr');
      write(d, 'docs/adr/0001-y.md', '# adr');
    });
    expect(renderJSON(withAdrs).adrs.count).toBe(2);
    fs.rmSync(withAdrs, { recursive: true, force: true });

    const none = mkProject(() => {});
    expect(renderJSON(none).adrs.count).toBe(0);
    fs.rmSync(none, { recursive: true, force: true });
  });
});

describe('statusline Tests probe (getLocalTestCount)', () => {
  it('counts tests across tests/ and monorepo packages/* (the carousel regression)', () => {
    // TRUTH-SL-V1: testCases is a REAL regex-scan of it()/test() calls in the
    // matched files (was the dishonest testFiles*4 multiplier — audit Patch 61).
    const d = mkProject((d) => {
      write(d, 'tests/a.test.js', "it('one', () => {});\nit('two', () => {});\n");
      write(d, 'tests/visual/b.spec.ts', "test('three', () => {});\n");
      write(d, 'packages/ui/src/c.test.ts', "describe('x', () => { it('four', () => {}); });\n");
      write(d, 'apps/web/d.spec.tsx', '// no cases in this stub\n');
      write(d, 'src/notatest.ts');                     // must NOT count
      write(d, 'node_modules/pkg/x.test.js', "it('never', () => {});\n"); // must NOT count (excluded)
    });
    const j = renderJSON(d);
    expect(j.tests.testFiles).toBe(4);
    expect(j.tests.testCases).toBe(4); // 2 + 1 + 1 + 0 real it()/test() calls
    expect(j.tests.countMethod).toBe('regex-scan');
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('is a non-negative integer and 0 for a project with no tests', () => {
    const d = mkProject((d) => write(d, 'src/index.ts', 'export {}'));
    const j = renderJSON(d);
    expect(typeof j.tests.testFiles).toBe('number');
    expect(j.tests.testFiles).toBe(0);
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe('statusline --json always carries adrs + tests keys', () => {
  it('both keys present even on an empty project (no stale-missing chip)', () => {
    const d = mkProject(() => {});
    const j = renderJSON(d);
    expect(j.adrs).toBeTruthy();
    expect(typeof j.adrs.count).toBe('number');
    expect(j.tests).toBeTruthy();
    expect(typeof j.tests.testFiles).toBe('number');
    fs.rmSync(d, { recursive: true, force: true });
  });
});
