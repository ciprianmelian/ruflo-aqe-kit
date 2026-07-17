#!/usr/bin/env node
/**
 * dashboard.cjs — on-demand LOCAL dashboard for the ruflo-aqe-kit stack.
 *
 * Cost/philosophy contract (DASHBOARD-V1):
 *   - FOREGROUND only: starts when you run it, dies on Ctrl-C. Never detaches,
 *     never installs launchd/cron, never spawns billed work. $0 by construction
 *     (the daemon lesson — Patch 50 — applies to unattended processes; this is
 *     an attended one).
 *   - READ-ONLY: serves disk-derived truth (lib/status.sh --json + the history
 *     JSONL files). It never writes to any store.
 *   - LOCALHOST-ONLY: binds 127.0.0.1 explicitly; GET only.
 *
 * Usage: bin/ruflo-kit dashboard <target> [--port N]
 *        (dispatcher cd's into the target; this script resolves the kit's
 *         lib/status.sh relative to its own location)
 *   --port N   listen port (default 7431; 0 = ephemeral, printed on start)
 *
 * Routes:
 *   /            self-contained HTML (inline CSS/JS, no CDN), polls /api/status
 *   /api/status  lib/status.sh --json for the cwd target (cached 3s)
 *   /api/health  last 50 entries of .claude-flow/data/health-history.jsonl
 *   /api/bench   selfimprove + improvement-eval history JSONL (if present)
 */

'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const TARGET = process.cwd();
const KIT_LIB = path.resolve(__dirname, '..', 'lib');
const STATUS_SH = path.join(KIT_LIB, 'status.sh');

let port = 7431;
const pi = process.argv.indexOf('--port');
if (pi !== -1 && process.argv[pi + 1] !== undefined) port = Number(process.argv[pi + 1]);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`invalid --port: ${process.argv[pi + 1]}`);
  process.exit(1);
}

// ── /api/status: spawn status.sh --json, cache briefly ───────────────────────
let statusCache = { at: 0, body: null };
function getStatus(cb) {
  const now = Date.now();
  if (statusCache.body && now - statusCache.at < 3000) return cb(null, statusCache.body);
  execFile('bash', [STATUS_SH, TARGET, '--json'], { timeout: 30000 }, (err, stdout) => {
    if (err && !stdout) return cb(err);
    try {
      JSON.parse(stdout); // status.sh's contract: always valid JSON
      statusCache = { at: Date.now(), body: stdout };
      cb(null, stdout);
    } catch (e) { cb(e); }
  });
}

function readJsonl(file, limit) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

// ── the page (fully inline: no CDN, works offline) ───────────────────────────
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>ruflo-kit dashboard</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, "Segoe UI", sans-serif; margin: 2rem; max-width: 72rem; }
  h1 { font-size: 1.2rem; } h2 { font-size: 1rem; margin: 1.2rem 0 .4rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr)); gap: 1rem; }
  .card { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: .5rem; padding: .8rem 1rem; }
  .ok { color: #2da44e; } .warn { color: #bf8700; } .bad { color: #cf222e; } .dim { opacity: .6; }
  table { border-collapse: collapse; width: 100%; } td, th { text-align: left; padding: .1rem .6rem .1rem 0; }
  code { font-size: .85em; }
  #ts { float: right; }
</style></head><body>
<h1>ruflo-kit dashboard <span id="ts" class="dim"></span></h1>
<div class="dim">read-only · localhost · foreground (Ctrl-C in the terminal to stop) · target: <code>${TARGET}</code></div>
<div class="grid" id="cards"></div>
<h2>Health history (growth deltas)</h2><div id="health" class="card dim">loading…</div>
<h2>Routing improvement (bench / eval)</h2><div id="bench" class="card dim">loading…</div>
<script>
const dot = (good, txt) => '<span class="' + (good === true ? 'ok' : good === false ? 'bad' : 'warn') + '">●</span> ' + txt;
function card(title, rowsHtml) { return '<div class="card"><h2>' + title + '</h2><table>' + rowsHtml + '</table></div>'; }
const row = (k, v) => '<tr><td class="dim">' + k + '</td><td>' + v + '</td></tr>';
async function refresh() {
  try {
    const s = await (await fetch('/api/status')).json();
    const g = s.globals || {}, a = g.agentdb || {}, sen = s.sentinels || {}, d = s.daemon || {},
          m = s.mcp || {}, l = s.learning || {}, c = s.config || {};
    document.getElementById('cards').innerHTML =
      card('Versions', row('ruflo', g.ruflo || 'n/a') + row('aqe', g.aqe || 'n/a')
        + row('agentdb', (a.hoisted || '?') + ' hoisted / ' + (a.nested || '?') + ' nested'
        + (a.nestedPinned ? ' ' + dot(true, 'pinned') : ' ' + dot(false, 'DRIFTED'))))
      + card('Sentinels', row('ruflo dist', dot(sen.present === sen.total, (sen.present || 0) + '/' + (sen.total || 0)))
        + row('exit-2 block', dot(!!sen.hookBlockExit2, sen.hookBlockExit2 ? 'yes' : 'no'))
        + row('dream-lockfix', dot(sen.dreamLockfix >= 4, (sen.dreamLockfix || 0) + '/4 paths')))
      + card('Daemon', row('process', dot(!d.running, d.running ? 'RUNNING (pids ' + (d.pids || []).join(',') + ')' : 'stopped — cost-safe'))
        + row('autostart', dot(c.daemonAutoStart !== 'true', String(c.daemonAutoStart || 'off'))))
      + card('MCP + Brain', row('servers', (m.servers || []).map(x => '<code>' + x + '</code>').join(' '))
        + row('brain KB', m.brainKb ? dot(true, m.brainKb) : dot(null, 'missing')))
      + card('Learning stores', row('episodes', l.episodes ?? 'n/a') + row('skills', l.skills ?? 'n/a')
        + row('experiences', l.experiences ?? 'n/a') + row('patterns', l.patterns ?? 'n/a'));
    document.getElementById('ts').textContent = new Date().toLocaleTimeString();
  } catch (e) { document.getElementById('ts').textContent = 'status fetch failed'; }
}
async function once() {
  try {
    const h = await (await fetch('/api/health')).json();
    document.getElementById('health').innerHTML = h.length
      ? '<table><tr><th>when</th><th>metrics snapshot</th></tr>' + h.slice(-8).reverse().map(e =>
          '<tr><td class="dim">' + (e.iso || e.timestamp) + '</td><td><code>' +
          Object.entries(e.metrics || {}).slice(0, 5).map(([k, v]) => k + '=' + JSON.stringify(v)).join(' · ') +
          '</code></td></tr>').join('') + '</table>'
      : 'no health history yet — run: ruflo-kit health <target>';
    const b = await (await fetch('/api/bench')).json();
    document.getElementById('bench').innerHTML = (b.bench.length || b.eval.length)
      ? 'bench runs: ' + b.bench.length + ' · eval runs: ' + b.eval.length + ' — latest: <code>' +
        JSON.stringify((b.eval[b.eval.length - 1] || b.bench[b.bench.length - 1] || {})).slice(0, 300) + '</code>'
      : 'no bench/eval history yet — run: ruflo-kit bench <target>';
  } catch (e) { /* leave loading text */ }
}
refresh(); once(); setInterval(refresh, 5000);
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  const u = (req.url || '/').split('?')[0];
  if (u === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
  if (u === '/api/status') {
    return getStatus((err, body) => {
      if (err) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":"status probe failed"}'); }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(body);
    });
  }
  if (u === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(readJsonl(path.join(TARGET, '.claude-flow', 'data', 'health-history.jsonl'), 50)));
  }
  if (u === '/api/bench') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      bench: readJsonl(path.join(TARGET, '.claude-flow', 'selfimprove-history.jsonl'), 50),
      eval: readJsonl(path.join(TARGET, '.claude-flow', 'improvement-eval-history.jsonl'), 50),
    }));
  }
  res.writeHead(404); res.end();
});

server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port;
  console.log(`ruflo-kit dashboard listening on http://127.0.0.1:${actual}  (target: ${TARGET})`);
  console.log('read-only · localhost-only · foreground — Ctrl-C to stop');
});
process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
