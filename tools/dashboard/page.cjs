'use strict';
/**
 * page.cjs — the self-contained operator page.
 *
 * DASHBOARD-PAGE-V1.
 *
 * Everything is inline: no CDN, no webfont, no external image. The server's
 * CSP forbids every off-origin fetch, and `tests/dashboard.test.js` asserts no
 * external host appears in the markup — this dashboard must work on a laptop
 * with no internet, because that is exactly when an operator is debugging.
 *
 * The page performs NO classification. Levels, messages and fix commands all
 * arrive pre-derived from tools/dashboard/triage.cjs, which the unit tests
 * exercise directly. The browser only renders. That is the anti-drift
 * property: there is no second copy of the rules to fall out of step.
 *
 * Visual grammar, chosen for a console that gets scanned under pressure:
 *   - severity is carried by a SHAPE (stripe weight + dot fill) as well as a
 *     hue, so it survives colour-blindness and a dimmed screen;
 *   - `unknown` is desaturated and hollow — "no reading" must not look like a
 *     fifth kind of alarm, it must look like an instrument that isn't lit;
 *   - `deliberate` rows carry a quiet "by design" tag, because this stack has
 *     documented states that LOOK wrong and must never be "fixed".
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

const STYLES = `
:root{
  --bg:#f2f5f6; --surface:#ffffff; --surface-2:#e8eeef; --ink:#0f1c1f; --ink-dim:#5a6e73;
  --line:#d3dedf; --accent:#0e6b74; --accent-ink:#ffffff;
  --ok:#2f7a52; --warn:#9a6510; --fail:#b32828; --unknown:#7a8f95;
  --ok-bg:#e6f2ea; --warn-bg:#fbf1dd; --fail-bg:#fbe9e9; --unknown-bg:#eef2f3;
  --radius:10px; --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0b1315; --surface:#131e21; --surface-2:#1a282c; --ink:#e6eef0; --ink-dim:#8ba1a7;
    --line:#243438; --accent:#4fd1c5; --accent-ink:#04211f;
    --ok:#63c48d; --warn:#e0b25c; --fail:#f08a8a; --unknown:#7f959b;
    --ok-bg:#13291d; --warn-bg:#2c2415; --fail-bg:#2e1919; --unknown-bg:#1a2427;
  }
}
:root[data-theme="dark"]{
  --bg:#0b1315; --surface:#131e21; --surface-2:#1a282c; --ink:#e6eef0; --ink-dim:#8ba1a7;
  --line:#243438; --accent:#4fd1c5; --accent-ink:#04211f;
  --ok:#63c48d; --warn:#e0b25c; --fail:#f08a8a; --unknown:#7f959b;
  --ok-bg:#13291d; --warn-bg:#2c2415; --fail-bg:#2e1919; --unknown-bg:#1a2427;
}
:root[data-theme="light"]{
  --bg:#f2f5f6; --surface:#ffffff; --surface-2:#e8eeef; --ink:#0f1c1f; --ink-dim:#5a6e73;
  --line:#d3dedf; --accent:#0e6b74; --accent-ink:#ffffff;
  --ok:#2f7a52; --warn:#9a6510; --fail:#b32828; --unknown:#7a8f95;
  --ok-bg:#e6f2ea; --warn-bg:#fbf1dd; --fail-bg:#fbe9e9; --unknown-bg:#eef2f3;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  font-variant-numeric:tabular-nums;}
.wrap{max-width:82rem;margin:0 auto;padding:1.25rem 1.25rem 4rem}
header{display:flex;flex-wrap:wrap;gap:.75rem 1rem;align-items:baseline;
  padding-bottom:.9rem;border-bottom:1px solid var(--line);margin-bottom:1.1rem}
h1{font-size:1.05rem;margin:0;letter-spacing:.02em;font-weight:650}
h1 .k{color:var(--accent)}
.target{font:12px/1.4 var(--mono);color:var(--ink-dim);word-break:break-all}
.spacer{flex:1 1 auto}
.verdict{display:inline-flex;align-items:center;gap:.5rem;padding:.3rem .7rem;border-radius:999px;
  font-size:.8rem;font-weight:650;letter-spacing:.04em;text-transform:uppercase;
  border:1px solid transparent}
.verdict[data-v="healthy"]{background:var(--ok-bg);color:var(--ok);border-color:var(--ok)}
.verdict[data-v="degraded"]{background:var(--warn-bg);color:var(--warn);border-color:var(--warn)}
.verdict[data-v="attention"]{background:var(--fail-bg);color:var(--fail);border-color:var(--fail)}
.verdict[data-v="partial"]{background:var(--unknown-bg);color:var(--unknown);border-color:var(--unknown);
  border-style:dashed}
.counts{font:12px/1 var(--mono);color:var(--ink-dim)}
.counts b{color:var(--ink);font-weight:600}
button{font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--line);
  border-radius:7px;padding:.35rem .7rem;cursor:pointer}
button:hover{border-color:var(--accent)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button[disabled]{opacity:.5;cursor:not-allowed}
button.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent);font-weight:600}
nav{display:flex;gap:.25rem;margin-bottom:1.1rem;flex-wrap:wrap}
nav button{border-radius:7px;background:transparent;border-color:transparent;color:var(--ink-dim)}
nav button[aria-selected="true"]{background:var(--surface);border-color:var(--line);color:var(--ink);font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(23rem,1fr));gap:.9rem}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);
  overflow:hidden;position:relative}
.card::before{content:"";position:absolute;inset:0 auto 0 0;width:3px;background:var(--unknown)}
.card[data-level="ok"]::before{background:var(--ok)}
.card[data-level="warn"]::before{background:var(--warn);width:5px}
.card[data-level="fail"]::before{background:var(--fail);width:7px}
.card[data-level="unknown"]::before{background:repeating-linear-gradient(
  180deg,var(--unknown) 0 4px,transparent 4px 8px)}
.card-top{display:flex;align-items:center;gap:.55rem;padding:.65rem .9rem .55rem 1.1rem;
  border-bottom:1px solid var(--line);background:var(--surface-2)}
.card-name{font:12px/1 var(--mono);letter-spacing:.06em;text-transform:uppercase;font-weight:600}
.card-level{margin-left:auto;font-size:.68rem;letter-spacing:.08em;text-transform:uppercase;
  font-weight:700;padding:.15rem .45rem;border-radius:4px}
.card[data-level="warn"] .card-level{background:var(--warn-bg);color:var(--warn)}
.card[data-level="fail"] .card-level{background:var(--fail-bg);color:var(--fail)}
.card[data-level="unknown"] .card-level{background:var(--unknown-bg);color:var(--unknown)}
.dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;background:var(--unknown)}
.dot[data-level="ok"]{background:var(--ok)}
.dot[data-level="warn"]{background:var(--warn)}
.dot[data-level="fail"]{background:var(--fail)}
/* hollow, not filled: an unlit instrument, not a fifth alarm colour */
.dot[data-level="unknown"]{background:transparent;border:1.5px dashed var(--unknown)}
ul.rows{list-style:none;margin:0;padding:.3rem 0}
li.row{display:flex;gap:.55rem;padding:.35rem .9rem .35rem 1.1rem;align-items:flex-start}
li.row+li.row{border-top:1px solid color-mix(in srgb,var(--line) 55%,transparent)}
.row-dot{margin-top:.45rem}
.row-body{flex:1 1 auto;min-width:0}
.row-msg{display:block}
.row[data-level="unknown"] .row-msg{color:var(--ink-dim)}
.tag{display:inline-block;font-size:.64rem;letter-spacing:.07em;text-transform:uppercase;
  font-weight:700;padding:.1rem .35rem;border-radius:4px;margin-left:.4rem;vertical-align:.08em;
  background:var(--surface-2);color:var(--ink-dim);border:1px solid var(--line)}
.metric{font:12px/1 var(--mono);color:var(--ink-dim);margin-left:auto;padding-left:.5rem;white-space:nowrap}
.fix{display:flex;align-items:center;gap:.4rem;margin-top:.3rem;min-width:0}
/* min-width:0 is load-bearing: without it the flex item refuses to shrink
   below its content width and the command is silently CLIPPED rather than
   scrolled — an operator would copy a truncated path. */
/* WRAP rather than scroll. A horizontally-scrolling command hides its own
   tail, and the tail is the target path — the part an operator most needs to
   read before running it. (The copy button always carries the full string
   either way, but "looks complete but isn't" is the failure to avoid.) */
.fix code{font:12px/1.5 var(--mono);background:var(--surface-2);border:1px solid var(--line);
  border-radius:5px;padding:.15rem .4rem;white-space:pre-wrap;overflow-wrap:anywhere;
  flex:1 1 auto;min-width:0}
.fix{align-items:flex-start}
.fix .copy{flex:0 0 auto;margin-top:.1rem}
.copy{font-size:.68rem;padding:.1rem .35rem;border-radius:4px;letter-spacing:.04em}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:1rem 1.1rem}
.panel h2{font-size:.78rem;letter-spacing:.07em;text-transform:uppercase;margin:0 0 .3rem;
  color:var(--ink-dim);font-family:var(--mono);font-weight:600}
.panel+.panel{margin-top:.9rem}
.muted{color:var(--ink-dim);font-size:.86rem}
.evidence-head{display:flex;flex-wrap:wrap;gap:.6rem;align-items:center;margin-bottom:.6rem}
.stamp{font:12px/1 var(--mono);color:var(--ink-dim)}
table.probes{width:100%;border-collapse:collapse;font-size:.86rem}
table.probes td{padding:.28rem .5rem .28rem 0;border-top:1px solid var(--line);vertical-align:top}
table.probes tr:first-child td{border-top:0}
td.pname{font:12px/1.5 var(--mono);white-space:nowrap;width:1%}
td.pv{width:1%;white-space:nowrap;font-size:.68rem;font-weight:700;letter-spacing:.06em}
td.pv[data-v="PASS"]{color:var(--ok)} td.pv[data-v="WARN"]{color:var(--warn)}
td.pv[data-v="FAIL"]{color:var(--fail)}
td.pd{color:var(--ink-dim);word-break:break-word}
pre.log{font:12px/1.5 var(--mono);background:var(--surface-2);border:1px solid var(--line);
  border-radius:7px;padding:.7rem .8rem;overflow-x:auto;max-height:26rem;margin:.6rem 0 0}
svg.spark{display:block;width:100%;height:56px;overflow:visible}
.legend{display:flex;gap:1rem;flex-wrap:wrap;font-size:.78rem;color:var(--ink-dim);margin-top:.5rem}
.legend span{display:inline-flex;align-items:center;gap:.35rem}
.hidden{display:none}
.err{color:var(--fail)}
@media (prefers-reduced-motion:no-preference){.card{transition:border-color .15s ease}}
`;

/** The browser-side application. Renders only — never classifies. */
const CLIENT = String.raw`
const $ = (s) => document.querySelector(s);
const ESC={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
const esc=(s)=>String(s==null?'':s).replace(/[&<>"']/g,(c)=>ESC[c]);

// The session token arrives in the URL fragment (never sent to a server,
// never logged, never leaked via Referer). Move it into sessionStorage and
// scrub the address bar so a screenshot or a shoulder cannot capture it.
// The fragment carries either a bare tab name (#evidence, from a bookmark) or
// key=value pairs (#t=<token>&tab=evidence, from the launch URL).
const RAW_HASH = location.hash.slice(1);
const FRAG = new URLSearchParams(RAW_HASH.includes('=') ? RAW_HASH : '');
let TOKEN = sessionStorage.getItem('kitDashToken') || '';
if (FRAG.get('t')) {
  TOKEN = FRAG.get('t');
  sessionStorage.setItem('kitDashToken', TOKEN);
}
const WANT_TAB = FRAG.get('tab') || (RAW_HASH.includes('=') ? '' : RAW_HASH);
if (FRAG.get('t')) history.replaceState(null, '', location.pathname);

async function api(path, init) {
  const r = await fetch(path, Object.assign({
    headers: { 'x-kit-dashboard-token': TOKEN },
    cache: 'no-store',
  }, init || {}));
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

function rowHtml(r) {
  const tag = r.deliberate ? '<span class="tag" title="documented as intentional — do not &quot;fix&quot; it">by design</span>' : '';
  const metric = r.metric ? '<span class="metric">' + esc(r.metric) + '</span>' : '';
  const fix = r.fix
    ? '<div class="fix"><code>' + esc(r.fix) + '</code>'
      + '<button class="copy" data-copy="' + esc(r.fix) + '">copy</button></div>'
    : '';
  return '<li class="row" data-level="' + esc(r.level) + '">'
    + '<span class="dot row-dot" data-level="' + esc(r.level) + '"></span>'
    + '<span class="row-body"><span class="row-msg">' + esc(r.message) + tag + '</span>' + fix + '</span>'
    + metric + '</li>';
}

function cardHtml(g) {
  const badge = (g.level === 'ok') ? '' : '<span class="card-level">' + esc(g.level) + '</span>';
  return '<article class="card" data-level="' + esc(g.level) + '">'
    + '<div class="card-top"><span class="dot" data-level="' + esc(g.level) + '"></span>'
    + '<span class="card-name">' + esc(g.subsystem) + '</span>' + badge + '</div>'
    + '<ul class="rows">' + g.rows.map(rowHtml).join('') + '</ul></article>';
}

/** Sparkline over one numeric series. Returns '' when there is nothing real
 *  to draw — an invented flat line would imply data we do not have. */
function spark(values) {
  const v = values.filter((x) => typeof x === 'number' && isFinite(x));
  if (v.length < 2) return '';
  const min = Math.min(...v), max = Math.max(...v), span = (max - min) || 1;
  const W = 100, H = 20;
  const pts = v.map((y, i) => [(i / (v.length - 1)) * W, H - ((y - min) / span) * H]);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join(' ');
  const area = d + ' L' + W + ' ' + H + ' L0 ' + H + ' Z';
  const last = pts[pts.length - 1];
  return '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">'
    + '<path d="' + area + '" fill="var(--accent)" opacity=".13"/>'
    + '<path d="' + d + '" fill="none" stroke="var(--accent)" stroke-width="1" '
    + 'vector-effect="non-scaling-stroke" stroke-linejoin="round"/>'
    + '<circle cx="' + last[0].toFixed(2) + '" cy="' + last[1].toFixed(2) + '" r="2" fill="var(--accent)" '
    + 'vector-effect="non-scaling-stroke"/></svg>';
}

let lastStatus = null;

async function refreshStatus() {
  try {
    const d = await api('/api/status');
    lastStatus = d;
    $('#verdict').textContent = d.rollup.verdict;
    $('#verdict').dataset.v = d.rollup.verdict;
    const c = d.rollup.counts;
    $('#counts').innerHTML = '<b>' + c.fail + '</b> fail · <b>' + c.warn + '</b> warn · <b>'
      + c.unknown + '</b> unknown · <b>' + c.ok + '</b> ok';
    $('#cards').innerHTML = d.groups.map(cardHtml).join('');
    $('#stamp').textContent = 'status read ' + new Date(d.at).toLocaleTimeString();
    $('#status-error').classList.add('hidden');
    renderFacts(d.status);
  } catch (e) {
    $('#status-error').textContent = 'status unavailable: ' + e.message;
    $('#status-error').classList.remove('hidden');
  }
}

function renderFacts(s) {
  if (!s) return;
  const rows = [];
  const push = (k, v) => rows.push('<tr><td class="pname">' + esc(k) + '</td><td class="pd">' + esc(v) + '</td></tr>');
  const g = s.globals || {}, a = g.agentdb || {}, m = s.mcp || {}, l = s.learning || {}, k = s.kit || {};
  push('kit', (k.version || '?') + '  (' + (k.date || '?') + ')');
  push('ruflo', g.ruflo || 'n/a');
  push('agentic-qe', g.aqe || 'n/a');
  push('agentdb', 'standalone ' + (a.standalone || '?') + ' · hoisted ' + (a.hoisted || '?') + ' · nested ' + (a.nested || '?'));
  push('mcp servers', (m.servers || []).join(', ') || 'none');
  push('sqlite backend', l.sqliteBackend || 'n/a');
  push('native roots', (l.sqliteNativeRootsChecked ?? '?') + '/' + (l.sqliteNativeRootsTotal ?? '?') + ' ' + (l.sqliteNativeVerdict || ''));
  $('#facts').innerHTML = '<table class="probes">' + rows.join('') + '</table>';
}

async function refreshHistory() {
  try {
    const h = await api('/api/history');
    const series = h.health.map((e) => ((e.metrics || {}).dbRows || {}).swarmMemoryEntries).filter((x) => typeof x === 'number');
    $('#spark').innerHTML = spark(series)
      || '<p class="muted">not enough health snapshots to plot a trend yet — run <code>ruflo-kit health</code> a few times.</p>';
    $('#spark-meta').textContent = series.length
      ? series.length + ' snapshots · latest swarm memory entries: ' + series[series.length - 1].toLocaleString()
      : '';
    $('#bench').innerHTML = (h.bench.length || h.eval.length)
      ? '<p class="muted">' + h.bench.length + ' bench run(s) · ' + h.eval.length + ' eval run(s)</p>'
      : '<p class="muted">no bench or eval history yet — run <code>ruflo-kit bench</code>.</p>';
  } catch (e) { /* history is optional; leave the placeholder */ }
}

function probeTable(pass) {
  if (!pass || !Array.isArray(pass.probes)) return '<p class="muted">no probe detail returned.</p>';
  return '<table class="probes">' + pass.probes.map((p) =>
    '<tr><td class="pname">' + esc(p.name) + '</td>'
    + '<td class="pv" data-v="' + esc(p.verdict) + '">' + esc(p.verdict) + '</td>'
    + '<td class="pd">' + esc(p.detail) + '</td></tr>').join('') + '</table>';
}

function renderEvidence(kind, job) {
  const el = $('#ev-' + kind);
  if (!job || job.state === 'idle') {
    el.innerHTML = '<p class="muted">not run in this session.</p>';
    return;
  }
  if (job.state === 'running') {
    el.innerHTML = '<p class="muted">running since ' + new Date(job.startedAt).toLocaleTimeString()
      + '… this blocks nothing else; leave the tab open.</p>';
    return;
  }
  // done
  const age = '<span class="stamp">evidence produced ' + new Date(job.finishedAt).toLocaleString()
    + ' · took ' + Math.round(job.ms / 1000) + 's</span>';
  if (job.error) {
    el.innerHTML = '<p class="err">' + esc(job.error) + '</p>' + age
      + (job.log ? '<pre class="log">' + esc(job.log) + '</pre>' : '');
    return;
  }
  const r = job.result || {};
  let head = '';
  if (kind === 'proof') {
    head = '<p><strong>' + esc(r.verdict || '?') + '</strong>'
      + (r.stable === false ? ' — passes disagreed (UNSTABLE)' : '')
      + (Array.isArray(r.escalated) && r.escalated.length
        ? ' — escalated: ' + esc(r.escalated.join(', ')) : '') + '</p>';
  } else {
    head = '<p><strong>' + esc(r.verdict || '?') + '</strong> — '
      + esc(r.pass ?? '?') + ' pass · ' + esc(r.warn ?? '?') + ' warn · '
      + esc(r.fail ?? '?') + ' fail · ' + esc(r.info ?? '?') + ' info</p>';
  }
  const detail = kind === 'proof'
    ? '<h2>pass 1 (inherited env)</h2>' + probeTable(r.pass1)
      + '<h2>pass 2 (clean env)</h2>' + probeTable(r.pass2)
    : '';
  el.innerHTML = head + age + detail + (job.log ? '<pre class="log">' + esc(job.log) + '</pre>' : '');
}

async function pollEvidence(kind) {
  try {
    const job = await api('/api/evidence/' + kind);
    renderEvidence(kind, job);
    if (job.state === 'running') setTimeout(() => pollEvidence(kind), 2000);
    else $('#run-' + kind).disabled = false;
  } catch (e) {
    $('#ev-' + kind).innerHTML = '<p class="err">' + esc(e.message) + '</p>';
    $('#run-' + kind).disabled = false;
  }
}

async function runEvidence(kind) {
  $('#run-' + kind).disabled = true;
  $('#ev-' + kind).innerHTML = '<p class="muted">starting…</p>';
  try {
    await api('/api/evidence/' + kind, { method: 'POST' });
  } catch (e) {
    $('#ev-' + kind).innerHTML = '<p class="err">' + esc(e.message) + '</p>';
    $('#run-' + kind).disabled = false;
    return;
  }
  pollEvidence(kind);
}

/** Show one tab and record it in the hash, so a reload (or a bookmark) comes
 *  back to the panel the operator was actually working in. The token has
 *  already been scrubbed out of the hash by the time this can run. */
function selectTab(name) {
  const tabs = [...document.querySelectorAll('nav button')].map((b) => b.dataset.tab);
  const pick = tabs.includes(name) ? name : tabs[0];
  document.querySelectorAll('nav button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === pick)));
  document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== pick));
  history.replaceState(null, '', pick === tabs[0] ? location.pathname : '#' + pick);
}

// ── wiring ──────────────────────────────────────────────────────────────────
document.addEventListener('click', (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    navigator.clipboard?.writeText(copy.dataset.copy);
    const t = copy.textContent; copy.textContent = 'copied'; setTimeout(() => { copy.textContent = t; }, 1200);
    return;
  }
  const tab = e.target.closest('nav button');
  if (tab) { selectTab(tab.dataset.tab); return; }
  const run = e.target.closest('[data-run]');
  if (run) runEvidence(run.dataset.run);
});

$('#refresh').addEventListener('click', refreshStatus);
$('#theme').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = cur === 'dark' ? 'light' : 'dark';
});

selectTab(WANT_TAB);
refreshStatus();
refreshHistory();
pollEvidence('verify-learning');
pollEvidence('proof');
setInterval(refreshStatus, 30000);
`;

/**
 * Render the page. `target` is the absolute path this dashboard is reporting
 * on — shown verbatim so an operator with several checkouts open can never
 * confuse two windows.
 */
function renderPage(target) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>ruflo-kit console</title>
<style>${STYLES}</style>
</head><body>
<div class="wrap">
<header>
  <div>
    <h1><span class="k">ruflo-kit</span> operator console</h1>
    <div class="target">${esc(target)}</div>
  </div>
  <div class="spacer"></div>
  <span class="verdict" id="verdict" data-v="partial">reading…</span>
  <span class="counts" id="counts"></span>
  <span class="stamp" id="stamp"></span>
  <button id="refresh" title="re-read status from disk now">refresh</button>
  <button id="theme" title="toggle light / dark">theme</button>
</header>

<p class="err hidden" id="status-error"></p>

<nav role="tablist">
  <button data-tab="triage" aria-selected="true">Triage</button>
  <button data-tab="evidence" aria-selected="false">Evidence</button>
  <button data-tab="history" aria-selected="false">History</button>
  <button data-tab="facts" aria-selected="false">Raw facts</button>
</nav>

<section data-panel="triage">
  <div class="grid" id="cards"></div>
  <div class="legend">
    <span><span class="dot" data-level="fail"></span> fail — broken, act now</span>
    <span><span class="dot" data-level="warn"></span> warn — degraded or costing money</span>
    <span><span class="dot" data-level="unknown"></span> unknown — could not be measured</span>
    <span><span class="dot" data-level="ok"></span> ok — verified healthy</span>
    <span><span class="tag">by design</span> intentional; do not "fix"</span>
  </div>
</section>

<section data-panel="evidence" class="hidden">
  <div class="panel">
    <div class="evidence-head">
      <h2>verify-learning</h2>
      <button data-run="verify-learning" id="run-verify-learning" class="primary">run</button>
      <span class="muted">read-only · ~3s · 16 liveness probes over the learning loop</span>
    </div>
    <div id="ev-verify-learning"></div>
  </div>
  <div class="panel">
    <div class="evidence-head">
      <h2>proof</h2>
      <button data-run="proof" id="run-proof" class="primary">run</button>
      <span class="muted">read-only · <strong>slow (minutes)</strong> · 16 disk-evidence probes run twice,
        the second pass under a clean env · spawns MCP handshakes, no billed LLM calls</span>
    </div>
    <div id="ev-proof"></div>
  </div>
  <p class="muted">Evidence is never auto-refreshed and always carries the time it was produced —
    a stale verdict must not be mistaken for a current one.</p>
</section>

<section data-panel="history" class="hidden">
  <div class="panel">
    <h2>swarm memory growth</h2>
    <div id="spark"></div>
    <p class="muted" id="spark-meta"></p>
  </div>
  <div class="panel"><h2>bench / eval</h2><div id="bench"></div></div>
</section>

<section data-panel="facts" class="hidden">
  <div class="panel">
    <h2>disk-derived facts</h2>
    <div id="facts"></div>
    <p class="muted">Verbatim from <code>ruflo-kit status --json</code>. The Triage tab is this same
      data with the kit's rules applied; nothing here is self-reported by a running component.</p>
  </div>
</section>

<p class="muted">read-only · 127.0.0.1 only · foreground — Ctrl-C in the terminal stops it</p>
</div>
<script>${CLIENT}</script>
</body></html>`;
}

module.exports = { renderPage, esc };
