/**
 * Tests for tools/dashboard.cjs (DASHBOARD-V2).
 *
 * Contract under test:
 *  - binds 127.0.0.1 only and prints the listen URL + a token fragment
 *  - `/` is public (it carries no data); every /api/ route requires the token
 *  - the transport gate refuses rebinding and cross-site callers
 *  - /api/status returns DERIVED rows, not raw fields
 *  - evidence jobs are single-flight and always timestamped
 *  - the process does not outlive its parent (DASHBOARD-ORPHAN-GUARD-V1)
 *
 * TEARDOWN IS PART OF THE CONTRACT HERE. Building V2 found 371 orphaned V1
 * servers left by earlier runs of this very file, the oldest nearly two days
 * old, each holding a listening port. So every child spawned by this suite is
 * registered in one place and killed from both `afterAll` and a process-exit
 * hook — a `beforeAll` that throws must not be able to leak a server.
 */

'use strict';

const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOL = path.resolve(__dirname, '../tools/dashboard.cjs');

/** Every child this suite spawns, so none can escape teardown. */
const SPAWNED = new Set();
function reap() {
  for (const c of SPAWNED) { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
  SPAWNED.clear();
}
process.on('exit', reap);

function startServer(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TOOL, '--port', '0'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    SPAWNED.add(child);
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`no URL: ${out}`)); }, 20000);
    child.stdout.on('data', (d) => {
      out += d;
      const port = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      const token = out.match(/#t=([0-9a-f]{64})/);
      if (port && token) { clearTimeout(timer); resolve({ child, port: Number(port[1]), token: token[1] }); }
    });
    child.on('exit', () => { clearTimeout(timer); reject(new Error(`exited early: ${out}`)); });
  });
}

/** Issue a request, defaulting to a well-formed same-origin call. */
function req(port, p, opts = {}) {
  const headers = Object.assign(
    { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' },
    opts.token ? { 'x-kit-dashboard-token': opts.token } : {},
    opts.headers || {},
  );
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, path: p, method: opts.method || 'GET', headers, timeout: opts.timeout || 60000 },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      },
    );
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.end();
  });
}

describe('dashboard.cjs (DASHBOARD-V2)', () => {
  let child; let port; let token; let fixture;

  beforeAll(async () => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'osam-dash-'));
    ({ child, port, token } = await startServer(fixture));
  }, 30000);

  afterAll(() => {
    if (child) child.kill('SIGTERM');
    reap();
    if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
  });

  describe('the page', () => {
    it('serves a self-contained page at / without a token', async () => {
      const r = await req(port, '/');
      expect(r.status).toBe(200);
      expect(r.body).toMatch(/ruflo-kit/);
      // Offline by contract: no external host may appear in the markup.
      expect(r.body).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
    }, 20000);

    it('never embeds the session token in the served HTML', async () => {
      // The token reaches the browser ONLY via the URL fragment printed on
      // stdout. If it appeared in the body, every reader of the page — and
      // any cache — would have it.
      const r = await req(port, '/');
      expect(r.body).not.toContain(token);
    }, 20000);

    it('sends the hardening headers on every response', async () => {
      const r = await req(port, '/');
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['content-security-policy']).toMatch(/default-src 'none'/);
    }, 20000);
  });

  describe('the request gate', () => {
    it('refuses /api/ routes with no token', async () => {
      expect((await req(port, '/api/status')).status).toBe(401);
      expect((await req(port, '/api/history')).status).toBe(401);
      expect((await req(port, '/api/evidence/proof')).status).toBe(401);
    }, 20000);

    it('refuses a wrong token', async () => {
      expect((await req(port, '/api/history', { token: 'f'.repeat(64) })).status).toBe(401);
    }, 20000);

    it('refuses a foreign Host even with a valid token (DNS rebinding)', async () => {
      const r = await req(port, '/api/history', { token, headers: { host: 'attacker.example.com' } });
      expect(r.status).toBe(403);
    }, 20000);

    it('refuses a cross-site fetch even with a valid token', async () => {
      const r = await req(port, '/api/history', { token, headers: { 'sec-fetch-site': 'cross-site' } });
      expect(r.status).toBe(403);
    }, 20000);

    it('accepts the same request once the hostile header is corrected', async () => {
      // Positive control for the three refusals above: proves the gate is
      // discriminating, not simply closed.
      expect((await req(port, '/api/history', { token })).status).toBe(200);
    }, 20000);
  });

  describe('/api/status', () => {
    it('returns derived rows, groups and a rollup — not raw fields alone', async () => {
      const r = await req(port, '/api/status', { token });
      expect(r.status).toBe(200);
      const j = JSON.parse(r.body);

      expect(Array.isArray(j.rows)).toBe(true);
      expect(j.rows.length).toBeGreaterThan(0);
      expect(Array.isArray(j.groups)).toBe(true);
      expect(j.rollup).toHaveProperty('verdict');
      expect(j.rollup).toHaveProperty('counts');
      expect(typeof j.at).toBe('number');

      for (const row of j.rows) {
        expect(row).toHaveProperty('subsystem');
        expect(['ok', 'warn', 'fail', 'unknown']).toContain(row.level);
        expect(typeof row.message).toBe('string');
      }
    }, 90000);

    it('grades an empty fixture target as something other than healthy', async () => {
      // A throwaway directory has no ruflo stack in it. The one outcome that
      // would be a defect is a confident "healthy" derived from nothing.
      const j = JSON.parse((await req(port, '/api/status', { token })).body);
      expect(j.rollup.verdict).not.toBe('healthy');
    }, 90000);

    it('sorts the worst group first', async () => {
      const j = JSON.parse((await req(port, '/api/status', { token })).body);
      const RANK = { fail: 3, warn: 2, unknown: 1, ok: 0 };
      const ranks = j.groups.map((g) => RANK[g.level]);
      expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
    }, 90000);
  });

  describe('/api/history', () => {
    it('returns the three JSONL series as arrays', async () => {
      const j = JSON.parse((await req(port, '/api/history', { token })).body);
      expect(Array.isArray(j.health)).toBe(true);
      expect(Array.isArray(j.bench)).toBe(true);
      expect(Array.isArray(j.eval)).toBe(true);
    }, 20000);
  });

  describe('evidence jobs', () => {
    it('starts idle and 404s an unknown kind', async () => {
      const j = JSON.parse((await req(port, '/api/evidence/verify-learning', { token })).body);
      expect(j.state).toBe('idle');
      expect((await req(port, '/api/evidence/nonsense', { token })).status).toBe(404);
    }, 20000);

    it('is single-flight: a second start while running is refused with 409', async () => {
      // Deliberately the CHEAP verb. Driving this with `proof` left a
      // minutes-long probe run in flight for the remainder of the suite, and
      // the load made tests/proof.test.js's own x2 run report `stable: false`
      // — two passes disagreeing purely because the machine was busy. The
      // single-flight property is generic; it does not need the heavy verb.
      const first = await req(port, '/api/evidence/verify-learning', { token, method: 'POST' });
      expect(first.status).toBe(202);
      expect(JSON.parse(first.body).state).toBe('running');

      const second = await req(port, '/api/evidence/verify-learning', { token, method: 'POST' });
      expect(second.status).toBe(409);

      const peek = JSON.parse((await req(port, '/api/evidence/verify-learning', { token })).body);
      expect(peek.state).toBe('running');
      // Evidence must always be attributable to a moment in time.
      expect(typeof peek.startedAt).toBe('number');
    }, 30000);

    it('rejects methods other than GET and POST', async () => {
      const r = await req(port, '/api/evidence/proof', { token, method: 'DELETE' });
      expect(r.status).toBe(405);
    }, 20000);
  });

  it('404s unknown routes', async () => {
    expect((await req(port, '/etc/passwd', { token })).status).toBe(404);
  }, 20000);
});

describe('DASHBOARD-ORPHAN-GUARD-V1: the server does not outlive its parent', () => {
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitGone(pid, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && alive(pid)) await sleep(500);
    return !alive(pid);
  }

  /**
   * Spawn an intermediate parent that starts the dashboard and writes its
   * output to a log. SIGKILLing that parent gives the dashboard no signal and
   * no chance to clean up — exactly the shape that leaked 371 servers.
   * `linger` controls whether the parent stays alive after spawning, which is
   * what separates the two failure modes below.
   */
  function spawnVia(fixture, { linger }) {
    const log = path.join(fixture, 'dash.log');
    const runner = path.join(fixture, 'runner.cjs');
    fs.writeFileSync(runner, `
      const fs = require('fs');
      const { spawn } = require('child_process');
      const fd = fs.openSync(${JSON.stringify(log)}, 'a');
      const c = spawn(process.execPath, [${JSON.stringify(TOOL)}, '--port', '0'],
        { cwd: ${JSON.stringify(fixture)}, stdio: ['ignore', fd, fd] });
      console.error('DASHBOARD_PID=' + c.pid);
      ${linger ? 'setInterval(() => {}, 3600000);' : 'process.exit(0);'}
    `);
    const parent = spawn(process.execPath, [runner], { stdio: ['ignore', 'pipe', 'pipe'] });
    SPAWNED.add(parent);
    const pid = new Promise((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error(`no pid: ${buf}`)), 20000);
      parent.stderr.on('data', (d) => {
        buf += d;
        const m = buf.match(/DASHBOARD_PID=(\d+)/);
        if (m) { clearTimeout(t); resolve(Number(m[1])); }
      });
    });
    return { parent, pid, log };
  }

  it('exits when its parent is killed after it has fully started', async () => {
    // The realistic leak: a test runner interrupted mid-suite, long after the
    // servers came up holding their ports.
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'osam-orphan-late-'));
    const { parent, pid: pidP, log } = spawnVia(fixture, { linger: true });
    const dashPid = await pidP;

    // Positive control: wait until it is genuinely serving before killing the
    // parent. Without this, a dashboard that crashed on boot would "pass".
    const upBy = Date.now() + 20000;
    let up = false;
    while (Date.now() < upBy && !up) {
      up = /http:\/\/127\.0\.0\.1:\d+/.test(fs.readFileSync(log, 'utf8').toString());
      if (!up) await sleep(250);
    }
    expect(up, 'dashboard never finished starting — nothing was proved').toBe(true);
    expect(alive(dashPid)).toBe(true);

    parent.kill('SIGKILL');

    expect(await waitGone(dashPid, 25000),
      'dashboard outlived its parent — the orphan guard is not working').toBe(true);
    fs.rmSync(fixture, { recursive: true, force: true });
  }, 90000);

  it('takes its in-flight evidence subprocess down with it on shutdown', async () => {
    // `proof` runs for minutes. Ctrl-C during one must not leave a detached
    // probe run chewing CPU — the same contract, one level down.
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'osam-dash-child-'));
    const started = await startServer(fixture);
    const r = await req(started.port, '/api/evidence/proof', { token: started.token, method: 'POST' });
    expect(r.status).toBe(202);

    // Positive control: wait until the subprocess genuinely exists. Without
    // it, "no proof.sh running" after the kill would prove nothing at all.
    // The dashboard passes its RESOLVED cwd to the verb, and on macOS
    // os.tmpdir() hands back /var/folders/... which is a symlink to
    // /private/var/folders/... — matching on the unresolved path finds nothing.
    const real = fs.realpathSync(fixture);
    const findChild = () => {
      try {
        return execFileSync('pgrep', ['-f', `proof.sh ${real}`], { encoding: 'utf8' })
          .trim().split('\n').filter(Boolean).map(Number);
      } catch { return []; }
    };
    const upBy = Date.now() + 20000;
    let kids = [];
    while (Date.now() < upBy && !kids.length) { kids = findChild(); if (!kids.length) await sleep(300); }
    expect(kids.length, 'proof subprocess never started — nothing was proved').toBeGreaterThan(0);

    started.child.kill('SIGTERM');

    const goneBy = Date.now() + 15000;
    while (Date.now() < goneBy && findChild().length) await sleep(300);
    expect(findChild().length, 'evidence subprocess survived the dashboard').toBe(0);

    fs.rmSync(fixture, { recursive: true, force: true });
  }, 60000);

  it('exits when its parent dies DURING its own startup', async () => {
    // The race that a naive `ppid !== originalPpid` guard misses entirely:
    // the parent is already gone before this module loads, so the "original"
    // parent it captures is init, and it compares 1 to 1 forever.
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'osam-orphan-race-'));
    const { pid: pidP } = spawnVia(fixture, { linger: false });
    const dashPid = await pidP;

    expect(await waitGone(dashPid, 25000),
      'dashboard orphaned during startup never noticed — the startup race is open').toBe(true);
    fs.rmSync(fixture, { recursive: true, force: true });
  }, 90000);
});
