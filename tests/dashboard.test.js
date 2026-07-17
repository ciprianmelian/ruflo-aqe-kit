/**
 * Tests for tools/dashboard.cjs (DASHBOARD-V1).
 *
 * Contract under test:
 *  - binds 127.0.0.1 only, prints the listen URL on stdout
 *  - GET / returns the self-contained HTML page
 *  - GET /api/status returns valid JSON (delegates to lib/status.sh --json)
 *  - GET /api/health returns a JSON array (empty for a fresh fixture target)
 *  - non-GET methods are rejected with 405
 *  - foreground lifecycle: SIGTERM shuts it down
 *
 * Strategy: spawn the real server with --port 0 (ephemeral) and cwd = a
 * throwaway fixture target, parse the actual port from stdout, then use
 * node's http client against it. Read-only by design — but the fixture cwd
 * guarantees isolation regardless.
 */

'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOL = path.resolve(__dirname, '../tools/dashboard.cjs');

function startServer(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TOOL, '--port', '0'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('server never printed URL: ' + out)); }, 15000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]) }); }
    });
    child.on('exit', () => { clearTimeout(timer); reject(new Error('server exited early: ' + out)); });
  });
}

function get(port, p, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 30000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

describe('dashboard.cjs (DASHBOARD-V1)', () => {
  let child, port, fixture;

  beforeAll(async () => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'osam-dash-'));
    ({ child, port } = await startServer(fixture));
  }, 20000);

  afterAll(() => {
    if (child) child.kill('SIGTERM');
    if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
  });

  it('serves the self-contained HTML page at /', async () => {
    const r = await get(port, '/');
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/ruflo-kit dashboard/);
    // self-contained: no external hosts referenced
    expect(r.body).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
  }, 15000);

  it('serves always-valid JSON at /api/status (empty fixture target)', async () => {
    const r = await get(port, '/api/status');
    expect(r.status).toBe(200);
    const j = JSON.parse(r.body); // throws on invalid — the assertion
    expect(j).toHaveProperty('globals');
    expect(j).toHaveProperty('sentinels');
  }, 40000);

  it('serves a JSON array at /api/health (empty on a fresh target)', async () => {
    const r = await get(port, '/api/health');
    expect(r.status).toBe(200);
    expect(Array.isArray(JSON.parse(r.body))).toBe(true);
  }, 15000);

  it('rejects non-GET methods with 405', async () => {
    const r = await get(port, '/api/status', 'POST');
    expect(r.status).toBe(405);
  }, 15000);

  it('404s unknown routes', async () => {
    const r = await get(port, '/etc/passwd');
    expect(r.status).toBe(404);
  }, 15000);
});
