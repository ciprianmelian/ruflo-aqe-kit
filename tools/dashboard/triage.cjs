'use strict';
/**
 * triage.cjs — pure status→rows derivation for the operator dashboard.
 *
 * DASHBOARD-TRIAGE-V1.
 *
 * This module turns the FACTS in `lib/status.sh --json` into OPERATOR ROWS:
 * a level, a human sentence, and (when action is warranted) the exact command
 * to type. It is deliberately pure — no IO, no DOM, no clock, no process —
 * so the tests exercise the same code the server ships.
 *
 * The server derives rows and sends them to the browser as JSON; the page only
 * renders. Classification therefore exists in exactly ONE place and cannot
 * drift between what is tested and what an operator sees.
 *
 * THREE DESIGN RULES, each earned from a real defect in this kit:
 *
 *  1. ABSENT IS NOT OK. A field that is missing, null, or the wrong type
 *     yields `unknown` — never `ok`. The kit's dominant defect class is a
 *     check that cannot distinguish "verified fine" from "couldn't tell"
 *     (Patch 71). `unknown` is that third state, and the rollup never counts
 *     it as healthy.
 *
 *  2. DELIBERATE IS NOT BROKEN. Several states in this stack are intentional
 *     and documented as "do NOT fix these" (CLAUDE.md): the AgentDB hoisted vs
 *     nested version mismatch, the opt-in ruvnet-brain KB, an absent daemon.
 *     They are marked `deliberate` and rendered calm. A dashboard that cries
 *     wolf about them teaches the operator to ignore it.
 *
 *  3. A FIX IS A COMMAND, NOT AN ADJECTIVE. Every actionable row carries a
 *     literal command line. "Check your config" is not a fix.
 */

/** Severity rank. Sorts worst-first; `unknown` outranks `ok` because
 *  not-assessable is strictly weaker evidence than assessed-healthy. */
const RANK = { fail: 3, warn: 2, unknown: 1, ok: 0 };

/** Display-order tiebreak within equal severity. Cost first (the daemon is the
 *  only row that can silently spend money), then integrity, then inventory. */
const PREF = ['daemon', 'sentinels', 'learning', 'versions', 'mcp', 'health'];

/** MCP servers this kit registers. A missing one is a warn, not a fail — the
 *  stack degrades rather than breaks, and some targets legitimately opt out. */
const EXPECTED_MCP = ['claude-flow', 'agentic-qe', 'agentdb', 'ruvnet-brain'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;

/** Build one row. `fix` is omitted unless there is a literal command to run. */
function row(subsystem, level, message, opts = {}) {
  const r = { subsystem, level, message };
  if (isStr(opts.fix)) r.fix = opts.fix;
  if (opts.deliberate) r.deliberate = true;
  if (isStr(opts.metric)) r.metric = opts.metric;
  return r;
}

/** `ruflo-kit <verb> <target>` — the literal line an operator types. */
function cmd(verb, target) {
  return `ruflo-kit ${verb} ${isStr(target) ? target : '<target>'}`;
}

// ── per-subsystem derivations ───────────────────────────────────────────────

function versionRows(s, target) {
  const out = [];
  const g = isObj(s.globals) ? s.globals : null;
  if (!g) {
    out.push(row('versions', 'unknown', 'no globals block in status output — versions not assessable'));
    return out;
  }

  if (isStr(g.ruflo)) out.push(row('versions', 'ok', `ruflo ${g.ruflo}`, { metric: g.ruflo }));
  else out.push(row('versions', 'fail', 'ruflo not installed or not on PATH', { fix: 'npm i -g ruflo' }));

  if (isStr(g.aqe)) out.push(row('versions', 'ok', `agentic-qe ${g.aqe}`, { metric: g.aqe }));
  else out.push(row('versions', 'warn', 'agentic-qe not detected', { fix: 'npm i -g agentic-qe' }));

  const a = isObj(g.agentdb) ? g.agentdb : null;
  if (!a) {
    out.push(row('versions', 'unknown', 'agentdb slot layout not reported — pin not assessable'));
  } else if (a.nestedPinned === true) {
    // The three-slot layout is deliberate: nearest-first resolution gives the
    // memory layer the full controller surface. hoisted != nested is CORRECT.
    out.push(row('versions', 'ok',
      `agentdb shadow pin intact — nested ${a.nested || '?'} over hoisted ${a.hoisted || '?'} (by design)`,
      { deliberate: true }));
  } else if (a.nestedPinned === false) {
    out.push(row('versions', 'fail',
      `agentdb nested pin DRIFTED — expected ${a.nestedExpected || '?'}, found ${a.nested || '?'}`,
      { fix: cmd('fix-ruflo', target) }));
  } else {
    out.push(row('versions', 'unknown', 'agentdb nested pin state not reported'));
  }
  return out;
}

function sentinelRows(s, target) {
  const out = [];
  const sen = isObj(s.sentinels) ? s.sentinels : null;
  if (!sen) {
    out.push(row('sentinels', 'unknown', 'no sentinel block — dist patches not assessable'));
    return out;
  }

  if (isNum(sen.present) && isNum(sen.total)) {
    if (sen.present === sen.total) {
      out.push(row('sentinels', 'ok', `${sen.present}/${sen.total} ruflo dist patches present`,
        { metric: `${sen.present}/${sen.total}` }));
    } else {
      const missing = (Array.isArray(sen.items) ? sen.items : [])
        .filter((i) => isObj(i) && i.present !== true).map((i) => i.name).filter(isStr);
      out.push(row('sentinels', 'fail',
        `${sen.present}/${sen.total} dist patches — MISSING: ${missing.length ? missing.join(', ') : 'unnamed'}`
        + ' (a ruflo upgrade silently reverted them)',
        { fix: cmd('fix-ruflo', target), metric: `${sen.present}/${sen.total}` }));
    }
  } else {
    out.push(row('sentinels', 'unknown', 'sentinel counts not reported'));
  }

  if (sen.hookBlockExit2 === true) out.push(row('sentinels', 'ok', 'dangerous-command hook blocks with exit 2'));
  else if (sen.hookBlockExit2 === false) {
    out.push(row('sentinels', 'fail', 'HOOK-BLOCK-EXIT2 patch absent — dangerous commands are not blocked',
      { fix: cmd('fix-ruflo', target) }));
  } else out.push(row('sentinels', 'unknown', 'hook block-exit-2 state not reported'));

  if (isNum(sen.dreamLockfix)) {
    if (sen.dreamLockfix >= 4) out.push(row('sentinels', 'ok', `dream-lockfix applied on ${sen.dreamLockfix}/4 paths`));
    else out.push(row('sentinels', 'warn', `dream-lockfix on only ${sen.dreamLockfix}/4 paths`,
      { fix: cmd('fix-aqe', target) }));
  } else out.push(row('sentinels', 'unknown', 'dream-lockfix coverage not reported'));

  return out;
}

function daemonRows(s, target) {
  const out = [];
  const d = isObj(s.daemon) ? s.daemon : null;
  const c = isObj(s.config) ? s.config : {};

  if (!d) {
    out.push(row('daemon', 'unknown', 'daemon state not reported — cost exposure not assessable'));
  } else if (d.running === true) {
    const pids = Array.isArray(d.pids) ? d.pids.join(', ') : '?';
    // The daemon spawns billed `claude --print` calls 24/7. This is the only
    // row in the dashboard that can silently spend the operator's money.
    out.push(row('daemon', 'warn',
      `daemon RUNNING (pid ${pids}) — it spawns billed LLM calls until stopped`,
      { fix: 'ruflo daemon stop', metric: 'running' }));
  } else if (d.running === false) {
    out.push(row('daemon', 'ok', 'daemon stopped — no unattended spend', { deliberate: true, metric: 'stopped' }));
  } else {
    out.push(row('daemon', 'unknown', 'daemon running-state not reported'));
  }

  if (c.daemonAutoStart === 'off') {
    out.push(row('daemon', 'ok', 'autostart pinned off', { deliberate: true }));
  } else if (isStr(c.daemonAutoStart)) {
    out.push(row('daemon', 'warn', `daemon autostart is "${c.daemonAutoStart}" — every CLI call may spawn one`,
      { fix: cmd('fix-ruflo', target) }));
  } else {
    out.push(row('daemon', 'unknown', 'daemon autostart pin not reported'));
  }
  return out;
}

function mcpRows(s, target) {
  const out = [];
  const m = isObj(s.mcp) ? s.mcp : null;
  if (!m) {
    out.push(row('mcp', 'unknown', 'no mcp block — server registration not assessable'));
    return out;
  }

  if (Array.isArray(m.servers)) {
    const have = m.servers.filter(isStr);
    const missing = EXPECTED_MCP.filter((x) => !have.includes(x));
    if (!missing.length) {
      out.push(row('mcp', 'ok', `${have.length} servers registered: ${have.join(', ')}`,
        { metric: String(have.length) }));
    } else {
      out.push(row('mcp', 'warn', `missing MCP server(s): ${missing.join(', ')}`,
        { fix: cmd('sync', target), metric: `${have.length}/${EXPECTED_MCP.length}` }));
    }
  } else {
    out.push(row('mcp', 'unknown', 'MCP server list not reported'));
  }

  const kb = isObj(m.brainKb) ? m.brainKb : null;
  if (!kb) {
    out.push(row('mcp', 'unknown', 'ruvnet-brain KB state not reported'));
  } else if (kb.present === true) {
    const gb = isNum(kb.sizeBytes) ? ` (${(kb.sizeBytes / 1e9).toFixed(1)} GB)` : '';
    out.push(row('mcp', 'ok', `ruvnet-brain KB v${kb.kbVersion || '?'} present${gb}`));
  } else {
    // Opt-in by design — an absent KB is a choice, not a defect.
    out.push(row('mcp', 'ok', 'ruvnet-brain KB not downloaded (opt-in)',
      { deliberate: true, fix: `${cmd('fix-brain', target)} --download` }));
  }
  return out;
}

function learningRows(s, target) {
  const out = [];
  const l = isObj(s.learning) ? s.learning : null;
  if (!l) {
    out.push(row('learning', 'unknown', 'no learning block — loop not assessable'));
    return out;
  }

  if (l.captureInflowWired === true) {
    out.push(row('learning', 'ok', 'capture hooks wired — new experiences still flow in'));
  } else if (l.captureInflowWired === false) {
    out.push(row('learning', 'fail',
      'capture inflow UNWIRED — the pool is frozen and every future harvest replays nothing new',
      { fix: cmd('fix-aqe', target) }));
  } else {
    out.push(row('learning', 'unknown', 'capture inflow state not reported'));
  }

  if (l.sqlite === false) {
    out.push(row('learning', 'fail', 'no sqlite instrument — learning stores cannot be read',
      { fix: cmd('sync', target) }));
  } else if (l.sqlite === true) {
    if (l.sqliteNativeGap === true) {
      const n = isNum(l.sqliteNativeRootsChecked) ? l.sqliteNativeRootsChecked : '?';
      const t = isNum(l.sqliteNativeRootsTotal) ? l.sqliteNativeRootsTotal : '?';
      out.push(row('learning', 'warn',
        `better-sqlite3 missing from some roots (${n}/${t} checked) — silent WASM fallback risk`,
        { fix: cmd('fix-ruflo', target) }));
    } else if (l.sqliteNativeVerdict === 'healthy') {
      out.push(row('learning', 'ok', `native sqlite healthy across ${l.sqliteNativeRootsTotal ?? '?'} roots`));
    }
  } else {
    out.push(row('learning', 'unknown', 'sqlite instrument state not reported'));
  }

  // Store counts are DATA, not verdicts — reported at info level via `ok` with
  // a metric, so they render as readings rather than judgements. The one
  // judgement worth making: a fresh target with nothing stored is PRIMED, not
  // hollow (Patch 63) — never alarm an operator about an empty new project.
  const counts = [
    ['episodes', l.episodes], ['skills', l.skills],
    ['experiences', l.experiences], ['patterns', l.patterns],
  ].filter(([, v]) => isNum(v));

  if (counts.length) {
    const total = counts.reduce((a, [, v]) => a + v, 0);
    if (total === 0) {
      out.push(row('learning', 'ok', 'stores empty — target is primed, not hollow (nothing learned yet)',
        { deliberate: true }));
    } else {
      // No `metric` here on purpose: the sum of episodes + skills +
      // experiences + patterns is not a quantity of anything, and a number in
      // the metric slot reads as a headline reading. The counts ARE the row.
      out.push(row('learning', 'ok', counts.map(([k, v]) => `${k} ${v.toLocaleString('en-US')}`).join(' · ')));
    }
  } else {
    out.push(row('learning', 'unknown', 'store row counts not reported'));
  }
  return out;
}

/** Health-snapshot freshness. `now` is injected so this stays pure/testable. */
function healthRows(s, target, now) {
  const c = isObj(s.config) ? s.config : {};
  const lh = isObj(c.lastHealth) ? c.lastHealth : null;
  if (!lh || !isStr(lh.iso)) {
    return [row('health', 'unknown', 'no health snapshot recorded yet',
      { fix: cmd('health', target) })];
  }
  const t = Date.parse(lh.iso);
  if (!Number.isFinite(t)) {
    return [row('health', 'unknown', `health snapshot timestamp unparseable (${lh.iso})`)];
  }
  const days = Math.floor((now - t) / 86400000);
  if (days > 14) {
    return [row('health', 'warn', `health snapshot is ${days} days old — growth deltas are stale`,
      { fix: cmd('health', target), metric: `${days}d` })];
  }
  return [row('health', 'ok', `health snapshot ${days === 0 ? 'from today' : `${days}d old`}`,
    { metric: `${days}d` })];
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Derive every operator row from a parsed `status.sh --json` object.
 * A non-object input yields a single `unknown` row — never an empty healthy
 * result, which would read as "all clear" when nothing was actually checked.
 */
function deriveRows(status, opts = {}) {
  const now = isNum(opts.now) ? opts.now : Date.now();
  if (!isObj(status)) {
    return [row('versions', 'unknown', 'status probe returned nothing parseable — no subsystem was assessed')];
  }
  // The target comes from the CALLER, never from the status payload.
  // `status.kit.dir` is the KIT CLONE's path, not the target's — reading it
  // here made every fix command name the wrong directory on any target other
  // than the kit checkout itself (where the two happen to coincide, which is
  // exactly why it looked right).
  const target = isStr(opts.target) ? opts.target : undefined;
  return [
    ...daemonRows(status, target),
    ...sentinelRows(status, target),
    ...learningRows(status, target),
    ...versionRows(status, target),
    ...mcpRows(status, target),
    ...healthRows(status, target, now),
  ];
}

/** Collapse rows into one card per subsystem; card level = worst row. */
function groupRows(rows) {
  const map = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!isObj(r) || !isStr(r.subsystem)) continue;
    if (!map.has(r.subsystem)) map.set(r.subsystem, { subsystem: r.subsystem, level: 'ok', rows: [] });
    const g = map.get(r.subsystem);
    g.rows.push(r);
    if ((RANK[r.level] || 0) > (RANK[g.level] || 0)) g.level = r.level;
  }
  const groups = [...map.values()];
  groups.sort((a, b) => {
    const d = (RANK[b.level] || 0) - (RANK[a.level] || 0);
    if (d) return d;
    const ia = PREF.indexOf(a.subsystem); const ib = PREF.indexOf(b.subsystem);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return groups;
}

/**
 * One-line verdict for the header.
 *
 * `unknown` deliberately produces its own verdict rather than folding into
 * "healthy" — the operator must be able to tell "I checked and it is fine"
 * from "I could not check". Deliberate rows never raise the verdict.
 */
function rollup(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(isObj);
  const n = (lvl) => list.filter((r) => r.level === lvl).length;
  const counts = { fail: n('fail'), warn: n('warn'), unknown: n('unknown'), ok: n('ok') };
  let verdict = 'healthy';
  if (counts.fail > 0) verdict = 'attention';
  else if (counts.warn > 0) verdict = 'degraded';
  else if (counts.unknown > 0) verdict = 'partial';
  else if (!list.length) verdict = 'partial';
  return { verdict, counts, actionable: list.filter((r) => isStr(r.fix) && r.level !== 'ok').length };
}

module.exports = { deriveRows, groupRows, rollup, RANK, PREF, EXPECTED_MCP };
