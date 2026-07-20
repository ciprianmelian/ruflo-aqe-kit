/**
 * Tests for lib/fix-learning.sh step 12 — LORA-APPLY-PRIME-V1.
 *
 * Harvest/train can leave .swarm/lora-weights.json with totalUpdates>0 but
 * totalAdaptations==0 (adapter trained, never applied); one real
 * `ruflo hooks route` from the target cwd flips it. Step 12 automates that,
 * gated on the RUFLO-LORA-ADAPT-V1 dist sentinel (KIT_RUFLO_DIST_SRC override,
 * mirroring verify-learning probe #11). Everything here runs against a FULL
 * ruflo/aqe stub on PATH inside throwaway temp dirs — no real binary, no
 * network, no global toolchain.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const FIX = path.join(REPO, 'lib', 'fix-learning.sh');

let d, bin, dist;

function mkTarget() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'flprime-'));
  fs.mkdirSync(path.join(t, '.swarm'), { recursive: true });
  fs.mkdirSync(path.join(t, '.agentic-qe'), { recursive: true });
  fs.writeFileSync(path.join(t, '.agentic-qe', 'config.yaml'),
    'learning:\n  hnswConfig:\n    M: 8\n');
  return t;
}

function writeLora(target, stats) {
  fs.writeFileSync(path.join(target, '.swarm', 'lora-weights.json'),
    JSON.stringify({ stats }));
}

function readLora(target) {
  return JSON.parse(
    fs.readFileSync(path.join(target, '.swarm', 'lora-weights.json'), 'utf8'));
}

// Fake installed dist carrying (or missing) the consumption-seam sentinel.
function mkDist(withSentinel) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flprime-dist-'));
  const mt = path.join(root, 'mcp-tools');
  fs.mkdirSync(mt, { recursive: true });
  fs.writeFileSync(path.join(mt, 'hooks-tools.js'),
    withSentinel
      ? '// RUFLO-LORA-ADAPT-V1: route-time adapt() consumes the trained delta\n'
      : '// upstream dist without the kit patch\n');
  return root;
}

// PATH stub dir. `ruflo hooks route` behavior is selectable:
//   bump  — increments stats.totalAdaptations in the target's lora-weights.json
//   noop  — succeeds but applies nothing (the stays-0 WARN path)
function mkBin(target, routeMode) {
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'flprime-bin-'));
  const lora = path.join(target, '.swarm', 'lora-weights.json');
  const bump = routeMode === 'bump'
    ? `node -e 'const fs=require("fs"),f=process.argv[1];const j=JSON.parse(fs.readFileSync(f,"utf8"));j.stats.totalAdaptations=(j.stats.totalAdaptations||0)+1;fs.writeFileSync(f,JSON.stringify(j))' "${lora}"`
    : ':';
  fs.writeFileSync(path.join(b, 'ruflo'), [
    '#!/usr/bin/env bash',
    'if [ "$1" = daemon ] && [ "$2" = status ]; then echo "Status: stopped"; fi',
    'if [ "$1" = hooks ] && [ "$2" = route ]; then',
    `  ${bump}`,
    'fi',
    'exit 0',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(b, 'aqe'), '#!/usr/bin/env bash\nexit 0\n');
  fs.chmodSync(path.join(b, 'ruflo'), 0o755);
  fs.chmodSync(path.join(b, 'aqe'), 0o755);
  return b;
}

function runChain(extraArgs = [], env = {}) {
  return spawnSync('bash', [FIX, d, ...extraArgs], {
    encoding: 'utf8', timeout: 30000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      KIT_RUFLO_DIST_SRC: dist,
      FIXLEARN_BACKOFF: '0',
      FIXLEARN_HARVEST: '0',   // unit tests never invoke the real harvest tool
      ...env,
    },
  });
}

afterEach(() => {
  for (const p of [d, bin, dist]) {
    if (p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
  d = bin = dist = undefined;
});

describe('fix-learning step 12: LORA-APPLY-PRIME-V1 fires and reports', () => {
  it('runs one priming route and reports totalAdaptations 0 -> 1', () => {
    d = mkTarget();
    writeLora(d, { totalUpdates: 3736, totalAdaptations: 0 });
    dist = mkDist(true);
    bin = mkBin(d, 'bump');
    const r = runChain();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/12: running: one priming route/);
    expect(r.stdout).toMatch(/12: adapter applied — totalAdaptations 0 -> 1/);
    expect(readLora(d).stats.totalAdaptations).toBe(1);
  });

  it('is skipped on re-run once totalAdaptations > 0', () => {
    d = mkTarget();
    writeLora(d, { totalUpdates: 3736, totalAdaptations: 0 });
    dist = mkDist(true);
    bin = mkBin(d, 'bump');
    const first = runChain();
    expect(first.stdout).toMatch(/12: adapter applied — totalAdaptations 0 -> 1/);
    const second = runChain();
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/12: already satisfied \(totalUpdates=3736, totalAdaptations=1\) — skipping/);
    expect(readLora(d).stats.totalAdaptations).toBe(1); // no second route fired
  });

  it('is skipped when totalUpdates == 0 (nothing trained to apply)', () => {
    d = mkTarget();
    writeLora(d, { totalUpdates: 0, totalAdaptations: 0 });
    dist = mkDist(true);
    bin = mkBin(d, 'bump');
    const r = runChain();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/12: already satisfied \(totalUpdates=0, totalAdaptations=0\) — skipping/);
    expect(readLora(d).stats.totalAdaptations).toBe(0);
  });
});

describe('fix-learning step 12: honest WARN paths (never hard-fail)', () => {
  it('WARNs when the route runs but totalAdaptations stays 0 (no-op stub)', () => {
    d = mkTarget();
    writeLora(d, { totalUpdates: 3736, totalAdaptations: 0 });
    dist = mkDist(true);
    bin = mkBin(d, 'noop');
    const r = runChain();
    expect(r.status).toBe(0); // step 12 is diagnostic — never flips the exit code
    expect(r.stdout).toMatch(/12: running: one priming route/);
    expect(r.stdout).toMatch(/12: priming route ran but totalAdaptations stayed 0 — adapter present but the route path did not apply it/);
    expect(readLora(d).stats.totalAdaptations).toBe(0);
  });

  it('WARNs and skips the route when the RUFLO-LORA-ADAPT-V1 sentinel is missing', () => {
    d = mkTarget();
    writeLora(d, { totalUpdates: 3736, totalAdaptations: 0 });
    dist = mkDist(false); // dist present, sentinel absent
    bin = mkBin(d, 'bump');
    const r = runChain();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/12: adapter trained but unapplied — RUFLO-LORA-ADAPT-V1 sentinel MISSING/);
    expect(r.stdout).not.toMatch(/12: running: one priming route/);
    expect(readLora(d).stats.totalAdaptations).toBe(0); // route never fired
  });
});

describe('fix-learning step 12: --dry-run', () => {
  it('prints would-run and does not touch lora-weights.json', () => {
    d = mkTarget();
    writeLora(d, { totalUpdates: 3736, totalAdaptations: 0 });
    dist = mkDist(true);
    bin = mkBin(d, 'bump');
    const r = runChain(['--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/12: \[dry-run\] would run: .*RUFLO_DAEMON_AUTOSTART=0 ruflo hooks route -t "kit adapter priming probe \(LORA-APPLY-PRIME-V1\)"/);
    expect(readLora(d).stats.totalAdaptations).toBe(0);
  });
});
