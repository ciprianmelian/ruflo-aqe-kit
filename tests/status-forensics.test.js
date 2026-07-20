/**
 * Tests for `ruflo-kit status <target> --forensics` (STATUS-FORENSICS-V1,
 * lib/status.sh) — the READ-ONLY manual-install evidence appendix.
 *
 * Contracts under test:
 *  1. History scan: fingerprint categories fire with their one-line
 *     "why it matters" annotations, matches are deduped, capped at the LAST 20
 *     per category, zsh EXTENDED_HISTORY prefixes are stripped, noise is absent.
 *  2. `ruflo init --force` is reported in its own category, separate from plain
 *     `ruflo init`.
 *  3. Target-side evidence: daemon-state.json / daemon.pid / CLAUDE.md.pre-ruflo*
 *     leftovers and stale ~/.npm/_npx caches are reported (list-only).
 *  4. ZERO writes: the fixture HOME and target trees (file list + mtimes) are
 *     bit-identical before/after a --forensics run. npm's own debug logging
 *     (from the pre-existing `npm root -g` in status.sh) is redirected outside
 *     the fixtures via npm_config_cache so the assertion stays strict.
 *  5. Unreadable/absent history files are reported, never fatal.
 *  6. --json ignores --forensics: stdout is the unchanged valid-JSON shape
 *     (note goes to stderr).
 *
 * Strategy (mkProject/spawn-bash style, cf. statusline-local-probes.test.js):
 * point HOME at a crafted tmp dir and run the REAL lib/status.sh.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATUS = path.resolve(__dirname, '..', 'lib', 'status.sh');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(base, rel, content) {
  const f = path.join(base, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content || '');
}

// A HOME with every fingerprint category + noise + a duplicate + an npx cache.
function mkForensicHome() {
  const home = mkTmp('forhome-');
  write(home, '.bash_history', [
    'claude mcp add claude-flow -- npx -y claude-flow@alpha mcp start',
    'npx -y ruflo@latest swarm init',
    'ruflo init --force',
    'ruflo init --wizard',
    'ruflo daemon start',
    'ruflo doctor --fix',
    'npm i -g ruflo',
    'npm install -g agentic-qe',
    'ls -la', // noise — must NOT appear in the report
    'npm i -g ruflo', // duplicate — must be deduped
    '',
  ].join('\n'));
  // zsh EXTENDED_HISTORY format — the ': ts:elapsed;' prefix must be stripped.
  write(home, '.zsh_history', ': 1700000000:0;aqe init\n');
  write(home, '.npm/_npx/abc123/node_modules/claude-flow/package.json',
    JSON.stringify({ name: 'claude-flow', version: '2.0.0' }));
  return home;
}

function mkForensicTarget() {
  const target = mkTmp('fortgt-');
  write(target, '.claude-flow/daemon-state.json', '{}');
  write(target, '.claude-flow/daemon.pid', '12345\n');
  write(target, 'CLAUDE.md.pre-ruflo-20260101', '# old claude.md\n');
  return target;
}

function run(target, args, home, npmCache) {
  const r = spawnSync('bash', [STATUS, target, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      HOME: home,
      // Keep npm's own debug-log writes OUT of the fixture HOME (status.sh's
      // pre-existing `npm root -g` triggers them under an overridden HOME).
      npm_config_cache: npmCache,
    },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// Recursive [relpath, size, mtimeMs] snapshot — proves zero writes.
function snapshot(dir) {
  const rows = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      rows.push([path.relative(dir, p), st.isDirectory() ? 'dir' : st.size, st.mtimeMs]);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return rows;
}

describe('status.sh --forensics: history scan categories + annotations', () => {
  let home, target, npmCache, res;

  beforeAll(() => {
    home = mkForensicHome();
    target = mkForensicTarget();
    npmCache = mkTmp('fornpm-');
    res = run(target, ['--forensics'], home, npmCache);
  });
  afterAll(() => {
    for (const d of [home, target, npmCache]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('exits 0 and appends the forensics section AFTER the normal status output', () => {
    expect(res.code).toBe(0);
    const iStatus = res.out.indexOf('ruflo-kit status');
    const iForensics = res.out.indexOf('STATUS-FORENSICS-V1');
    expect(iStatus).toBeGreaterThanOrEqual(0);
    expect(iForensics).toBeGreaterThan(iStatus);
  });

  it('reports every fingerprint category with its matched line', () => {
    const cases = [
      ['[mcp-add-npx]', 'claude mcp add claude-flow -- npx -y claude-flow@alpha mcp start'],
      ['[npx-stack-invoke]', 'npx -y ruflo@latest swarm init'],
      ['[ruflo-init-force]', 'ruflo init --force'],
      ['[ruflo-init]', 'ruflo init --wizard'],
      ['[aqe-init]', 'aqe init'],
      ['[daemon-ctl]', 'ruflo daemon start'],
      ['[ruflo-doctor]', 'ruflo doctor --fix'],
      ['[npm-global-install]', 'npm i -g ruflo'],
    ];
    for (const [cat, line] of cases) {
      expect(res.out).toContain(cat);
      expect(res.out).toContain(`$ ${line}`);
    }
  });

  it('carries a one-line why-it-matters annotation per category', () => {
    expect(res.out).toMatch(/reverts the AgentDB alpha\.10 pin/); // mcp-add-npx
    expect(res.out).toMatch(/CACHE copy of the stack/); // npx-stack-invoke
    expect(res.out).toMatch(/CLOBBERS CLAUDE\.md/); // ruflo-init-force
    expect(res.out).toMatch(/merge-safe setup/); // ruflo-init
    expect(res.out).toMatch(/stripped foreign hooks/); // aqe-init
    expect(res.out).toMatch(/BILLED 'claude --print' calls/); // daemon-ctl
    expect(res.out).toMatch(/resurrected the gated daemon/); // ruflo-doctor
    expect(res.out).toMatch(/WIPES kit dist patches/); // npm-global-install
  });

  it('dedupes repeated history lines (npm i -g ruflo appears exactly once)', () => {
    const hits = res.out.split('\n').filter((l) => l.trim() === '$ npm i -g ruflo');
    expect(hits).toHaveLength(1);
  });

  it('separates --force: ruflo init --force is NOT double-reported under plain ruflo-init', () => {
    const hits = res.out.split('\n').filter((l) => l.includes('$ ruflo init --force'));
    expect(hits).toHaveLength(1); // only in [ruflo-init-force]
    expect(res.out).toContain('$ ruflo init --wizard'); // plain category still fires
  });

  it('strips the zsh EXTENDED_HISTORY prefix', () => {
    expect(res.out).toContain('$ aqe init');
    expect(res.out).not.toContain('1700000000');
  });

  it('does not report noise commands', () => {
    expect(res.out).not.toContain('ls -la');
  });

  it('reports target-side evidence: daemon state files + CLAUDE.md.pre-ruflo leftover', () => {
    expect(res.out).toMatch(/daemon-state\.json present \(mtime /);
    expect(res.out).toMatch(/daemon\.pid present \(mtime /);
    expect(res.out).toMatch(/CLAUDE\.md\.pre-ruflo-20260101 \(mtime .*ruflo init/);
  });

  it('lists the stale npx cache mentioning claude-flow (fix-ruflo Step 7 shape, list-only)', () => {
    expect(res.out).toContain('claude-flow@2.0.0');
    expect(res.out).toContain(path.join(home, '.npm/_npx/abc123'));
  });
});

describe('status.sh --forensics: zero writes (read-only proof)', () => {
  it('leaves HOME and target file lists + mtimes bit-identical', () => {
    const home = mkForensicHome();
    const target = mkForensicTarget();
    const npmCache = mkTmp('fornpm-');
    try {
      const before = { home: snapshot(home), target: snapshot(target) };
      const res = run(target, ['--forensics'], home, npmCache);
      expect(res.code).toBe(0);
      const after = { home: snapshot(home), target: snapshot(target) };
      expect(after).toEqual(before);
    } finally {
      for (const d of [home, target, npmCache]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('status.sh --forensics: dedup + last-20 cap per category', () => {
  it('caps a flooded category at the LAST 20 distinct matches', () => {
    const home = mkTmp('forhome-');
    const npmCache = mkTmp('fornpm-');
    const target = mkTmp('fortgt-');
    const lines = [];
    for (let i = 1; i <= 25; i++) lines.push(`ruflo daemon start # run${i}`);
    write(home, '.bash_history', lines.join('\n') + '\n');
    try {
      const res = run(target, ['--forensics'], home, npmCache);
      expect(res.code).toBe(0);
      expect(res.out).toMatch(/\[daemon-ctl\] 20 command/);
      expect(res.out).not.toContain('# run5'); // 1..5 dropped (last 20 kept)
      expect(res.out).toContain('# run6');
      expect(res.out).toContain('# run25');
    } finally {
      for (const d of [home, target, npmCache]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('status.sh --forensics: history availability honesty', () => {
  it('says so when no history file is readable, and reports clean fixtures as clean', () => {
    const home = mkTmp('forhome-'); // no history files at all
    const npmCache = mkTmp('fornpm-');
    const target = mkTmp('fortgt-');
    try {
      const res = run(target, ['--forensics'], home, npmCache);
      expect(res.code).toBe(0);
      expect(res.out).toMatch(/no readable shell history/);
      expect(res.out).toMatch(/no CLAUDE\.md\.pre-ruflo\* leftovers/);
      expect(res.out).toMatch(/no npx caches mentioning/);
    } finally {
      for (const d of [home, target, npmCache]) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('reports a clean history (only noise) as fingerprint-free', () => {
    const home = mkTmp('forhome-');
    const npmCache = mkTmp('fornpm-');
    const target = mkTmp('fortgt-');
    write(home, '.bash_history', 'ls\ncd /tmp\ngit status\n');
    try {
      const res = run(target, ['--forensics'], home, npmCache);
      expect(res.code).toBe(0);
      expect(res.out).toMatch(/no manual-install fingerprints found/);
    } finally {
      for (const d of [home, target, npmCache]) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('flags an unreadable history file instead of failing (skipped as root)', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root reads anything
    const home = mkTmp('forhome-');
    const npmCache = mkTmp('fornpm-');
    const target = mkTmp('fortgt-');
    write(home, '.bash_history', 'npm i -g ruflo\n');
    fs.chmodSync(path.join(home, '.bash_history'), 0o000);
    try {
      const res = run(target, ['--forensics'], home, npmCache);
      expect(res.code).toBe(0);
      expect(res.out).toMatch(/\.bash_history exists but is not readable/);
    } finally {
      fs.chmodSync(path.join(home, '.bash_history'), 0o600);
      for (const d of [home, target, npmCache]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('status.sh --json ignores --forensics (contract: JSON unchanged)', () => {
  it('stdout stays valid JSON with the documented shape; note goes to stderr', () => {
    const home = mkForensicHome();
    const npmCache = mkTmp('fornpm-');
    const target = mkForensicTarget();
    try {
      const res = run(target, ['--json', '--forensics'], home, npmCache);
      expect(res.code).toBe(0);
      const parsed = JSON.parse(res.out); // throws if forensics leaked into stdout
      for (const k of ['kit', 'globals', 'sentinels', 'daemon', 'mcp', 'learning', 'config']) {
        expect(parsed).toHaveProperty(k);
      }
      expect(res.out).not.toContain('STATUS-FORENSICS-V1');
      expect(res.err).toMatch(/--forensics is plain-text only/);
    } finally {
      for (const d of [home, target, npmCache]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
