/**
 * Tests for lib/sync.sh — the one-verb `ruflo-kit sync` heal cascade.
 *
 * sync.sh's own job is ORCHESTRATION: run the fix cascade in order, propagate
 * --dry-run to every stage, print a summary table, and own the exit contract
 * (nonzero only on a HARD fix-stage failure). The real fix-*.sh scripts have
 * their own tests and scaffold files independent of --dry-run, so here they are
 * replaced with STUBS — isolating sync.sh's behavior from theirs. Each stub
 * honors --dry-run (writes a marker into the target only when NOT dry-run) and
 * prints the completion marker sync.sh greps for.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIB = path.resolve(__dirname, '..', 'lib');

// Completion tokens sync.sh greps for, per stage (must match run_fix regexes).
const COMPLETE = {
  'fix-ruflo.sh': 'Log: /tmp/stub.log',
  'fix-aqe.sh': 'fix-aqe complete',
  'fix-statusbar.sh': 'Restart Claude Code',
  'fix-brain.sh': 'fix-brain complete',
};

// A fix-stage stub: honors --dry-run (writes <marker> only when not dry-run),
// prints its completion line + a parseable change count, exits with `code`.
// When `omitComplete` is set the completion marker is suppressed (to simulate a
// crash that never reached the end → sync must treat a nonzero exit as HARD).
function fixStub(name, { code = 0, changes = 1, omitComplete = false } = {}) {
  const token = omitComplete ? 'partial output only' : COMPLETE[name];
  return `#!/usr/bin/env bash
target="$1"; dry=0
for a in "$@"; do [ "$a" = "--dry-run" ] && dry=1; done
if [ "$dry" -eq 0 ]; then : > "$target/${name}.touched"; fi
echo "${token} — ${changes} change(s)"
echo "Fixes applied:    ${changes}"
exit ${code}
`;
}

function vlStub(verdict = 'live') {
  return `#!/usr/bin/env bash
echo '{"pass":1,"warn":0,"fail":0,"info":0,"verdict":"${verdict}"}'
exit 0
`;
}

// Build a throwaway kit dir: real common.sh + sync.sh, stubbed fix cascade.
// common.sh resolves KIT_DIR from its own path, so sync.sh calls OUR stubs.
function mkKit(overrides = {}) {
  const kit = fs.mkdtempSync(path.join(os.tmpdir(), 'synckit-'));
  const lib = path.join(kit, 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.copyFileSync(path.join(LIB, 'common.sh'), path.join(lib, 'common.sh'));
  fs.copyFileSync(path.join(LIB, 'sync.sh'), path.join(lib, 'sync.sh'));
  const stubs = {
    'fix-ruflo.sh': fixStub('fix-ruflo.sh', overrides['fix-ruflo.sh']),
    'fix-aqe.sh': fixStub('fix-aqe.sh', overrides['fix-aqe.sh']),
    'fix-statusbar.sh': fixStub('fix-statusbar.sh', overrides['fix-statusbar.sh']),
    'fix-brain.sh': fixStub('fix-brain.sh', overrides['fix-brain.sh']),
    'verify-learning.sh': vlStub(overrides.verdict),
    ...(overrides.files || {}),
  };
  for (const [n, body] of Object.entries(stubs)) {
    if (body === null) continue; // caller can drop a stage (e.g. fix-brain absent)
    fs.writeFileSync(path.join(lib, n), body);
    fs.chmodSync(path.join(lib, n), 0o755);
  }
  return kit;
}

function runSync(kit, target, args = []) {
  const r = spawnSync('bash', [path.join(kit, 'lib', 'sync.sh'), target, ...args],
    { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

// A stable content+entry snapshot of a directory tree.
function snapshot(dir) {
  const entries = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { entries.push('D ' + p); walk(p); }
      else entries.push('F ' + p + ' ' + fs.readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return entries.join('\n');
}

let target;
beforeEach(() => { target = fs.mkdtempSync(path.join(os.tmpdir(), 'synctgt-')); });
afterEach(() => fs.rmSync(target, { recursive: true, force: true }));

describe('sync.sh --dry-run: propagates the flag and makes no writes', () => {
  it('leaves the target byte-identical when every stage honors --dry-run', () => {
    const kit = mkKit();
    try {
      const before = snapshot(target);
      const { code } = runSync(kit, target, ['--dry-run']);
      const after = snapshot(target);
      expect(after).toBe(before);
      expect(code).toBe(0);
    } finally {
      fs.rmSync(kit, { recursive: true, force: true });
    }
  });

  it('WITHOUT --dry-run the same stubs DO write (guards against a vacuous no-write test)', () => {
    const kit = mkKit();
    try {
      runSync(kit, target);
      // Every fix stub dropped its marker → proves the dry-run test above is meaningful.
      expect(fs.existsSync(path.join(target, 'fix-ruflo.sh.touched'))).toBe(true);
      expect(fs.existsSync(path.join(target, 'fix-aqe.sh.touched'))).toBe(true);
    } finally {
      fs.rmSync(kit, { recursive: true, force: true });
    }
  });
});

describe('sync.sh: summary table', () => {
  it('prints a summary header and one row per stage', () => {
    const kit = mkKit();
    try {
      const { out } = runSync(kit, target, ['--dry-run']);
      expect(out).toMatch(/sync summary/);
      expect(out).toMatch(/STAGE\s+RESULT\s+CHANGES\s+DETAIL/);
      for (const stage of ['fix-ruflo', 'fix-aqe', 'fix-statusbar', 'fix-brain', 'verify-learning']) {
        expect(out).toMatch(new RegExp(stage));
      }
    } finally {
      fs.rmSync(kit, { recursive: true, force: true });
    }
  });

  it('parses the change count from a stage completion line', () => {
    const kit = mkKit({ 'fix-aqe.sh': { changes: 7 } });
    try {
      const { out } = runSync(kit, target, ['--dry-run']);
      // fix-aqe row should carry its parsed change count (7). Strip ANSI first
      // so the column colouring doesn't break the row match.
      const plain = out.replace(/\[[0-9;]*m/g, '');
      expect(plain).toMatch(/fix-aqe\s+ok\s+7/);
    } finally {
      fs.rmSync(kit, { recursive: true, force: true });
    }
  });
});

describe('sync.sh: exit-code contract', () => {
  it('exits 0 when all fix stages succeed', () => {
    const kit = mkKit();
    try {
      expect(runSync(kit, target).code).toBe(0);
    } finally {
      fs.rmSync(kit, { recursive: true, force: true });
    }
  });

  it('exits 1 when a fix stage HARD-fails (nonzero exit, no completion marker)', () => {
    const kit = mkKit({ 'fix-ruflo.sh': { code: 3, omitComplete: true } });
    try {
      const { code, out } = runSync(kit, target);
      expect(code).toBe(1);
      expect(out).toMatch(/hard-failed/);
    } finally {
      fs.rmSync(kit, { recursive: true, force: true });
    }
  });

  it('exits 0 when a stage completes with manual-action warnings (nonzero exit WITH marker)', () => {
    const kit = mkKit({ 'fix-ruflo.sh': { code: 1, omitComplete: false } });
    try {
      const { code, out } = runSync(kit, target);
      expect(code).toBe(0);
      expect(out).toMatch(/manual actions/);
    } finally {
      fs.rmSync(kit, { recursive: true, force: true });
    }
  });

  it('does NOT flip the exit code on a hollow learning verdict (verify-learning is non-fatal)', () => {
    const kit = mkKit({ verdict: 'hollow' });
    try {
      const { code, out } = runSync(kit, target);
      expect(code).toBe(0);
      expect(out).toMatch(/HOLLOW/);
    } finally {
      fs.rmSync(kit, { recursive: true, force: true });
    }
  });
});

describe('sync.sh: fix-brain absence is handled cleanly', () => {
  it('skips fix-brain when its script is absent and still exits 0', () => {
    const kit = mkKit({ files: { 'fix-brain.sh': null } });
    // Remove the stub so the script is genuinely absent.
    fs.rmSync(path.join(kit, 'lib', 'fix-brain.sh'), { force: true });
    try {
      const { code, out } = runSync(kit, target);
      expect(code).toBe(0);
      expect(out).toMatch(/fix-brain.*(not present|skip)/i);
    } finally {
      fs.rmSync(kit, { recursive: true, force: true });
    }
  });
});
