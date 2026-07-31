#!/usr/bin/env node
'use strict';
// ============================================================================
// tools/daemon-staleness.cjs — DAEMON-STALE-DIST-V1 (detection-only).
//
// A running ruflo daemon keeps the dist it loaded at spawn time: the kit dist
// patches fix-ruflo applies (SONA-TRAIN-V1 in memory/intelligence.js,
// RUFLO-LORA-ADAPT-V1 in mcp-tools/hooks-tools.js) are INERT inside any daemon
// that started BEFORE the patch landed — the on-disk greps (status sentinels,
// proof P10/P14, verify-learning #11) read green while the resident process
// still executes pre-patch code. This tool CLASSIFIES running daemons against
// the newest patched-dist mtime; it NEVER kills anything.
//
// stdin  — one line per daemon, `ps -o pid= -o etimes= -o args=` shape:
//            "<pid> <etimes|etime> <args...>"
//          (etimes = elapsed seconds; BSD ps only has etime `[[dd-]hh:]mm:ss`
//           — both token shapes are parsed.)
// flags  — --newest-mtime <epoch>  newest mtime among the kit-patched dist
//                                  files; omitted => staleness not assessable,
//                                  everything classifies FRESH (fail-safe)
//          --now <epoch>           clock override (tests); default: wall clock
//          --home <path>           home dir for the suspicion tag; default $HOME
//
// stdout — one line per daemon:
//            pid <pid> ws=<workspace> started=<ISO8601> STALE|FRESH [tags...]
//          suspicion tags (auto-spawn signature — Patch 60's stray daemons):
//            suspect:home-workspace       workspace is exactly $HOME
//            suspect:subdir-of-pid-<N>    workspace is a SUBDIRECTORY of
//                                         another daemon's workspace
//          plus, when >=1 daemon is STALE, one trailing warning line stating
//          consequence + remedy (deliberate starts are the operator's; strays
//          are safe to stop).
//
// Pure parse/classify/format — separable from process discovery (lib/common.sh
// kit_daemon_ps_lines does the pgrep/ps side) so vitest can drive it with fake
// ps output. Exports the internals for direct unit testing too.
// ============================================================================

// "[[dd-]hh:]mm:ss" or plain seconds -> elapsed seconds (NaN when unparsable).
function parseElapsed(tok) {
  if (/^\d+$/.test(tok)) return Number(tok);
  const m = tok.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return NaN;
  const [, dd, hh, mm, ss] = m;
  return (Number(dd || 0) * 86400) + (Number(hh || 0) * 3600) + (Number(mm) * 60) + Number(ss);
}

// argv tokens -> the --workspace value ('--workspace <p>' or '--workspace=<p>'),
// else '?'.
function parseWorkspace(toks) {
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] === '--workspace' && toks[i + 1]) return toks[i + 1];
    if (toks[i].startsWith('--workspace=')) return toks[i].slice('--workspace='.length) || '?';
  }
  return '?';
}

// stdin text -> [{pid, startEpoch, workspace, unparsable}] (now = current
// epoch seconds). A line that doesn't even have the pid-plus-token shape
// (blank noise, a stray non-ps line) is still silently skipped — that is a
// distinct, harmless robustness concern. What must NEVER be dropped (F1's
// honesty doctrine: surface as NOT-ASSESSABLE, never silent absence) is a
// row that DID come from `ps` (leading pid + a token) but whose token isn't a
// valid elapsed shape — the macOS malformed-etimes case, where `ps` drops the
// unrecognized column yet still prints the line, shifting args into that
// slot. Those come back with unparsable:true and a raw string so
// classify()/formatRow() can report them explicitly instead of vanishing.
function parseLines(text, now) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const elapsed = parseElapsed(m[2]);
    if (!Number.isFinite(elapsed)) {
      // pid parsed, but the second token isn't a valid elapsed shape — the
      // macOS malformed-etimes case (ps drops the unrecognized column but
      // still prints the line, shifting args into m[2]'s position).
      out.push({ pid: Number(m[1]), startEpoch: NaN, workspace: '?', raw: t, unparsable: true });
      continue;
    }
    out.push({
      pid: Number(m[1]),
      startEpoch: now - elapsed,
      workspace: parseWorkspace(m[3].split(/\s+/)),
      unparsable: false,
    });
  }
  return out;
}

const normPath = (p) => (p && p !== '?' ? p.replace(/\/+$/, '') || '/' : p);

// [{pid, startEpoch, workspace}] + newestMtime(|null) + home ->
// [{pid, workspace, startEpoch, state, tags}]. STALE iff the daemon started
// strictly BEFORE the newest patched-dist mtime; no mtime => FRESH (fail-safe:
// detection-only, never claim staleness we cannot prove).
//
// KNOWN LIMITATION (deliberate, not an oversight — DAEMON-HINT-SCOPE-V1
// round 4): the suspect:home-workspace (below) and suspect:subdir-of-pid-N
// tags compare workspace paths LEXICALLY via normPath (a string transform —
// trailing-slash strip, no realpath, no stat), the exact same class of
// comparison that was WRONG in lib/common.sh's kit_daemon_scope_split before
// it was fixed to compare filesystem IDENTITY, (dev, ino) from fs.statSync.
// On a case-insensitive-but-preserving filesystem (macOS APFS) or across a
// symlink alias, two workspace strings that are the SAME directory can fail
// to string-match here, and a genuine home-workspace or subdir relationship
// is silently MISSED.
//
// This is NOT converted to identity comparison, on purpose: (1) this module
// is a PURE function over already-parsed argv strings, deliberately
// filesystem-free so it stays unit-testable with fake ps lines and no
// fixtures — kit_daemon_scope_split's fs.statSync calls would require real
// directories on disk, destroying that property; (2) the output here is an
// ADVISORY TAG ("suspect:..."), not a confident scope decision — a missed
// tag under case/symlink aliasing is a false NEGATIVE in a hint, not the
// confident false claim kit_daemon_scope_split's bug produced (that one told
// an operator a daemon does NOT lock their target's DBs when it actually
// does; missing a "this looks like a stray home-workspace daemon" tag is a
// strictly lower-severity miss). If this function's tags are ever consumed
// to make a confident MINE/OTHER-style claim rather than an advisory
// suggestion, it should switch to identity comparison the same way
// kit_daemon_scope_split did — not before, since that would trade away
// purity/testability for a property this output doesn't currently need.
function classify(daemons, newestMtime, home) {
  const nhome = normPath(home || '');
  return daemons.map((d) => {
    if (d.unparsable) {
      return { pid: d.pid, workspace: d.workspace, startEpoch: d.startEpoch, state: 'UNPARSABLE', tags: [], raw: d.raw };
    }
    const state = (Number.isFinite(newestMtime) && d.startEpoch < newestMtime) ? 'STALE' : 'FRESH';
    const tags = [];
    const ws = normPath(d.workspace);
    if (ws !== '?' && nhome && ws === nhome) tags.push('suspect:home-workspace');
    for (const o of daemons) {
      if (o === d) continue;
      const ows = normPath(o.workspace);
      if (ws === '?' || ows === '?' || !ws || !ows) continue;
      if (ws !== ows && ws.startsWith(ows === '/' ? '/' : ows + '/')) {
        tags.push(`suspect:subdir-of-pid-${o.pid}`);
        break; // one subdir tag is enough of a signature
      }
    }
    return { pid: d.pid, workspace: d.workspace, startEpoch: d.startEpoch, state, tags };
  });
}

function formatRow(r) {
  if (r.state === 'UNPARSABLE') {
    return `pid ${Number.isFinite(r.pid) ? r.pid : '?'} UNPARSABLE (raw: ${r.raw})`;
  }
  const started = new Date(r.startEpoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `pid ${r.pid} ws=${r.workspace} started=${started} ${r.state}${r.tags.length ? ' ' + r.tags.join(' ') : ''}`;
}

// The consequence + remedy, verbatim (load-bearing for sync/proof surfacing).
const REMEDY = 'running pre-patch code — dist patches inert in it until: ' +
  'ruflo daemon stop && ruflo daemon start ' +
  '(deliberate starts are yours; auto-spawned strays are safe to stop)';

function formatReport(rows) {
  const lines = rows.map(formatRow);
  const stale = rows.filter((r) => r.state === 'STALE').length;
  const unparsable = rows.filter((r) => r.state === 'UNPARSABLE').length;
  if (stale > 0) lines.push(`WARNING: ${stale} stale-dist daemon(s) ${REMEDY}`);
  if (unparsable > 0) {
    lines.push(`NOTE: ${unparsable} daemon row(s) UNPARSABLE — staleness not assessable for them (see raw above)`);
  }
  return lines;
}

function main() {
  const argv = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--newest-mtime') opt.newestMtime = Number(argv[++i]);
    else if (argv[i] === '--now') opt.now = Number(argv[++i]);
    else if (argv[i] === '--home') opt.home = argv[++i];
  }
  const now = Number.isFinite(opt.now) ? opt.now : Math.floor(Date.now() / 1000);
  const home = opt.home !== undefined ? opt.home : (process.env.HOME || '');
  let input = '';
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    const rows = classify(parseLines(input, now), opt.newestMtime, home);
    for (const l of formatReport(rows)) console.log(l);
    process.exit(0); // detection-only: never a failing exit
  });
}

if (require.main === module) main();

// normPath: lib/common.sh's kit_daemon_scope_split no longer imports this
// (its identity-based (dev,ino) classifier doesn't need it) — its ONLY
// consumer is tests/daemon-staleness.test.js's TEETH test, which requires it
// to reconstruct the PRE-FIX kit_daemon_scope_split body verbatim. Do NOT
// drop this as an "unused export" — doing so silently breaks that test's
// ability to prove the case-aliasing regression against the old code.
module.exports = { parseElapsed, parseWorkspace, parseLines, classify, formatRow, formatReport, normPath, REMEDY };
