#!/usr/bin/env node
/**
 * dashboard.cjs — on-demand LOCAL operator console for the ruflo-aqe-kit stack.
 *
 * DASHBOARD-V2 (supersedes DASHBOARD-V1's single-page status dump).
 *
 * COST / PHILOSOPHY CONTRACT — unchanged from V1 and still load-bearing:
 *   - FOREGROUND only: starts when you run it, dies on Ctrl-C. Never detaches,
 *     never installs launchd/cron, never spawns billed work. $0 by
 *     construction (the daemon lesson, Patch 50, is about UNATTENDED
 *     processes; this is an attended one).
 *   - READ-ONLY: every route reads disk-derived truth or runs a read-only kit
 *     verb. Nothing here writes to any store, ever.
 *   - LOCALHOST-ONLY: binds 127.0.0.1 explicitly.
 *
 * WHAT V2 ADDS
 *   1. A REQUEST GATE (tools/dashboard/security.cjs). V1 bound to loopback and
 *      stopped there, which leaves DNS rebinding and every other local process
 *      with full read access. V2 checks Host/Origin/Sec-Fetch-Site and requires
 *      a per-run session token on every data route.
 *   2. TRIAGE (tools/dashboard/triage.cjs). V1 printed raw fields and left the
 *      operator to interpret them. V2 derives levels, sentences and literal fix
 *      commands SERVER-SIDE, so the shipped rules are the tested rules.
 *   3. EVIDENCE ON DEMAND. verify-learning and proof can be run from the page,
 *      single-flight, with the time the evidence was produced always shown.
 *
 * Usage: bin/ruflo-kit dashboard <target> [--port N]
 *   (the dispatcher cd's into the target; this script resolves the kit's lib/
 *    relative to its own location)
 *
 * It never launches a browser: it prints a URL carrying a one-time session
 * token in the # fragment. Copy it, or add `#tab=evidence` to land on a
 * specific panel.
 *
 * Routes — `/` is public (it carries no data); every /api/ route needs the token:
 *   GET  /                      self-contained HTML
 *   GET  /api/status            derived rows + groups + rollup + raw status
 *   GET  /api/history           health / bench / eval JSONL tails
 *   GET  /api/evidence/:kind    job state for verify-learning | proof
 *   POST /api/evidence/:kind    start that job (single-flight)
 */

'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const { gate, mintToken, hardeningHeaders } = require('./dashboard/security.cjs');
const { deriveRows, groupRows, rollup } = require('./dashboard/triage.cjs');
const { renderPage } = require('./dashboard/page.cjs');

const TARGET = process.cwd();
const KIT_LIB = path.resolve(__dirname, '..', 'lib');
const TOKEN = mintToken();

// ── argv ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let port = 7431;
const pi = argv.indexOf('--port');
if (pi !== -1 && argv[pi + 1] !== undefined) {
  const raw = argv[pi + 1];
  port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`invalid --port: ${raw}`);
    process.exit(1);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Strip ANSI SGR sequences so a terminal transcript is safe to show in HTML.
 *  Display only — no claim is ever DERIVED from decorated text (this kit has
 *  already shipped one bug from counting escape digits as data). */
const stripAnsi = (s) => String(s).replace(/\[[0-9;]*[A-Za-z]/g, '');

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, Object.assign({ 'content-type': type }, hardeningHeaders()));
  res.end(body);
}

const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj));

function readJsonl(file, limit) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n')
      .slice(-limit)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ── /api/status: run status.sh --json, cache briefly ────────────────────────
let statusCache = { at: 0, payload: null };

function getStatus(cb) {
  const now = Date.now();
  if (statusCache.payload && now - statusCache.at < 3000) return cb(null, statusCache.payload);

  execFile('bash', [path.join(KIT_LIB, 'status.sh'), TARGET, '--json'],
    { timeout: 120000, maxBuffer: 8 << 20 }, (err, stdout) => {
      let status = null;
      try { status = JSON.parse(stdout); } catch { status = null; }

      // A failed probe must NOT yield an empty-but-healthy page. deriveRows()
      // turns a null status into explicit `unknown` rows, so the operator sees
      // "could not measure" rather than a reassuring blank.
      const rows = deriveRows(status, { target: TARGET });
      const payload = {
        at: Date.now(),
        status,
        rows,
        groups: groupRows(rows),
        rollup: rollup(rows),
        probeError: status ? null : (err ? String(err.message).slice(0, 300) : 'status.sh emitted unparseable JSON'),
      };
      statusCache = { at: Date.now(), payload };
      cb(null, payload);
    });
}

// ── evidence jobs (single-flight per kind) ──────────────────────────────────
//
// Both verbs are READ-ONLY. `proof` is slow (16 probes twice, the second pass
// under a clean env) and spawns MCP handshakes, so it is never automatic and
// never polled — an operator asks for it explicitly, and the result always
// carries the time it was produced so a stale PROVED cannot pass for current.

const JOBS = {
  'verify-learning': {
    script: 'verify-learning.sh',
    timeout: 180000,
    // --json exposes counters only; a second plain-text pass supplies the
    // per-probe transcript the operator actually needs to see WHICH probe
    // failed. Both passes are read-only and each is labelled with its own
    // role in the UI — no claim is parsed out of the decorated text.
    transcript: true,
  },
  proof: { script: 'proof.sh', timeout: 900000, transcript: false },
};

const jobState = {};
for (const k of Object.keys(JOBS)) jobState[k] = { state: 'idle' };

/** Evidence subprocesses currently in flight, so shutdown can take them with
 *  it. `proof` runs for minutes; without this, Ctrl-C would leave a detached
 *  probe run behind — the same "nothing survives the foreground session"
 *  contract the orphan guard enforces for the server itself. */
const RUNNING_CHILDREN = new Set();

function runVerb(script, args, timeout, cb) {
  const child = execFile('bash', [path.join(KIT_LIB, script), TARGET, ...args],
    { timeout, maxBuffer: 32 << 20 },
    (err, stdout, stderr) => {
      RUNNING_CHILDREN.delete(child);
      cb(err, String(stdout || ''), String(stderr || ''));
    });
  RUNNING_CHILDREN.add(child);
}

function startJob(kind) {
  const spec = JOBS[kind];
  const startedAt = Date.now();
  jobState[kind] = { state: 'running', startedAt };

  runVerb(spec.script, ['--json'], spec.timeout, (err, stdout, stderr) => {
    let result = null;
    // The verbs print the JSON as their last line; tolerate leading noise.
    const line = stdout.trim().split('\n').filter(Boolean).pop() || '';
    try { result = JSON.parse(line); } catch { result = null; }

    const finish = (log) => {
      jobState[kind] = {
        state: 'done',
        startedAt,
        finishedAt: Date.now(),
        ms: Date.now() - startedAt,
        result,
        log: log ? stripAnsi(log).slice(-20000) : '',
        // A non-zero exit is EXPECTED here: these verbs exit 1 to signal a
        // real finding (hollow loop, failed proof). Only an unparseable
        // result is an error of the dashboard's own making.
        error: result ? null
          : `could not parse ${spec.script} output${err ? ` (${String(err.message).slice(0, 160)})` : ''}`,
      };
    };

    if (!spec.transcript) return finish(stderr);
    // Second read-only pass, plain output, purely for human-readable detail.
    runVerb(spec.script, [], spec.timeout, (_e, out, serr) => finish(`${out}${serr}`));
  });
}

// ── routes ──────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  const method = (req.method || 'GET').toUpperCase();

  // `/` carries no operator data and must be reachable to bootstrap the token
  // (which travels in the URL fragment and is therefore never sent here), so
  // it is gated on transport only. Every data route additionally needs it.
  const isApi = url.startsWith('/api/');
  const refusal = gate(req, { token: TOKEN, requireToken: isApi });
  if (refusal) return send(res, refusal.status, refusal.reason, 'text/plain; charset=utf-8');

  if (url === '/' && method === 'GET') {
    return send(res, 200, renderPage(TARGET), 'text/html; charset=utf-8');
  }

  if (url === '/api/status' && method === 'GET') {
    return getStatus((_e, payload) => sendJson(res, 200, payload));
  }

  if (url === '/api/history' && method === 'GET') {
    return sendJson(res, 200, {
      health: readJsonl(path.join(TARGET, '.claude-flow', 'data', 'health-history.jsonl'), 60),
      bench: readJsonl(path.join(TARGET, '.claude-flow', 'selfimprove-history.jsonl'), 60),
      eval: readJsonl(path.join(TARGET, '.claude-flow', 'improvement-eval-history.jsonl'), 60),
    });
  }

  const ev = /^\/api\/evidence\/([a-z-]+)$/.exec(url);
  if (ev) {
    const kind = ev[1];
    if (!JOBS[kind]) return sendJson(res, 404, { error: 'unknown evidence kind' });
    if (method === 'GET') return sendJson(res, 200, jobState[kind]);
    if (method === 'POST') {
      if (jobState[kind].state === 'running') {
        return sendJson(res, 409, { error: 'already running', ...jobState[kind] });
      }
      startJob(kind);
      return sendJson(res, 202, jobState[kind]);
    }
    return send(res, 405, 'method not allowed', 'text/plain; charset=utf-8');
  }

  if (method !== 'GET' && method !== 'POST') {
    return send(res, 405, 'method not allowed', 'text/plain; charset=utf-8');
  }
  return send(res, 404, 'not found', 'text/plain; charset=utf-8');
});

server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port;
  const base = `http://127.0.0.1:${actual}`;
  // Banner wording is a contract: tests/verb-safety.test.js and
  // tests/dispatcher-divergence-notice.test.js both match on it to prove the
  // dispatcher resolved the right target. Do not reword it casually.
  console.log(`ruflo-kit dashboard listening on ${base}  (target: ${TARGET})`);
  console.log('read-only · localhost-only · foreground — Ctrl-C to stop');
  console.log('open this URL — it carries a one-time session token in the # fragment:');
  console.log(`  ${base}/#t=${TOKEN}`);
});

const shutdown = () => {
  for (const c of RUNNING_CHILDREN) { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
  RUNNING_CHILDREN.clear();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── FOREGROUND enforcement (DASHBOARD-ORPHAN-GUARD-V1) ──────────────────────
//
// The header above promises this process is foreground-only and never
// outlives its session. Signal handlers alone do not deliver that: if the
// parent dies WITHOUT sending a signal — a test runner interrupted mid-suite,
// a crashed shell, a `beforeAll` that throws before teardown is registered —
// this server is reparented to init and listens forever.
//
// That is not hypothetical. Building V2 found 371 orphaned V1 servers on this
// machine, the oldest nearly two days old, each still holding a listening TCP
// port; every one carried the test harness's `--port 0`. The contract was
// documented but unenforced.
//
// A changed ppid is the portable reparenting signal on macOS and Linux, but
// comparing only against the ORIGINAL parent has a race: if the parent dies
// while this module is still loading, `process.ppid` is ALREADY 1 when we
// capture it, and 1 === 1 forever after — the orphan never notices. So all
// three conditions are checked.
const PARENT_PID = process.ppid;

function parentGone() {
  // Reparented away from whoever launched us.
  if (process.ppid !== PARENT_PID) return true;
  // Already an orphan at load time (the startup race above). This tool is
  // documented as never detaching and never running as a service, so init as
  // the original parent means the launcher is already gone.
  if (PARENT_PID <= 1) return true;
  // Original pid still ours? ESRCH means it exited; EPERM means the pid was
  // recycled by another user's process, which is equally "not our parent".
  try { process.kill(PARENT_PID, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
}

const orphanGuard = setInterval(() => {
  if (parentGone()) {
    console.error('parent process exited — shutting down (foreground-only contract)');
    shutdown();
  }
}, 2000);
orphanGuard.unref();
