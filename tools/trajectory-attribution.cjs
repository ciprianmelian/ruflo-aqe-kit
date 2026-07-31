#!/usr/bin/env node
/*
 * trajectory-attribution.cjs — TRAJ-ATTR-V1: source attribution for SONA training writes.
 *
 * WHY (Wave 4, measurement integrity): three independent writer paths now train the same
 * durable policy sink (.swarm/lora-weights.json — the LoRA B matrix `ruflo hooks route`
 * consumes at route time via RUFLO-LORA-ADAPT-V1):
 *   1. The Stop hook (.claude/helpers/aqe-post-route.cjs → `ruflo hooks post-task`,
 *      dispatched in-process via callMCPTool). Since ruflo #2786 rewired
 *      bridgeRecordFeedback from a swallowed no-op into a real
 *      intelligence.recordTrajectory() call, ONE post-task invocation produces TWO
 *      training events (the bridge's 'action' step + the handler's own 'result' step).
 *   2. The harvester (tools/aqe-harvest.cjs Sink A) — calls getLoRAAdapter().train()
 *      DIRECTLY, bypassing recordTrajectory/endTrajectory entirely.
 *   3. Other in-process MCP surfaces (hooks_post-edit, hooks_intelligence trajectory-end,
 *      hooks_task-completed trainPatterns, agent-execute) — sporadic, unhookable from
 *      kit-owned code without a dist patch.
 * Nothing in the sink distinguishes them, so any before/after learning delta is
 * confounded across three variables. This module gives every KIT-OWNED writer a place
 * to record "I trained, here is the weights transition I caused", and gives readers a
 * conservative classifier: a transition no event covers is UNKNOWN (pre-attribution or
 * path 3) — never silently bucketed into a known source.
 *
 * DESIGN CONSTRAINTS (deliberate):
 *  • Kit-owned code only — no dist patch, so it survives every upstream bump unchanged.
 *    The cost is honesty about coverage: path 3 writers stay 'unknown'; that is recorded,
 *    not hidden. (A dist-patch variant was rejected: fix-ruflo.sh is under concurrent
 *    edit by other builders this session, and the two kit-owned writers cover the two
 *    paths that fire in normal operation — every turn's Stop hook, and harvest.)
 *  • ADDITIVE + NON-DESTRUCTIVE: appends its own JSONL ledger
 *    (.claude-flow/trajectory-attribution.jsonl); never touches learning stores.
 *  • The Stop-hook wrapper inlines a byte-compatible mini-writer (helpers must be
 *    self-contained on managed targets — they cannot require() the kit clone). The
 *    lock-step test asserts wrapper-written rows parse under THIS module's reader,
 *    so the two cannot drift silently.
 *  • #2786 detection follows the kit's defect_gate philosophy: gate on the literal
 *    behavior in the INSTALLED dist (a recordTrajectory call inside the
 *    bridgeRecordFeedback body), never on a version number — so the flag self-retires
 *    the moment upstream removes or moves the call, and every ledger row records the
 *    flag AS OF ITS WRITE TIME (per-row provenance stays honest across bumps).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = 'traj-attr-v1';
const LEDGER_REL = path.join('.claude-flow', 'trajectory-attribution.jsonl');
const WEIGHTS_REL = path.join('.swarm', 'lora-weights.json');
// Sources kit-owned writers use. Anything else in a ledger row is preserved verbatim
// (forward-compat) but classified as itself; a MISSING covering row is the unknown case.
const KNOWN_SOURCES = ['stop-hook-post-task', 'harvest-sinkA'];
const UNKNOWN_SOURCE = 'unknown (pre-attribution)';

function ledgerPath(root) { return path.join(root, LEDGER_REL); }
function weightsPath(root) { return path.join(root, WEIGHTS_REL); }

/** Content fingerprint of the LoRA weights sink. null when absent/unreadable. */
function snapshotWeights(root) {
  try {
    const p = weightsPath(root);
    const buf = fs.readFileSync(p);
    const st = fs.statSync(p);
    return { sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length, mtimeMs: Math.round(st.mtimeMs) };
  } catch (e) { return null; }
}

/**
 * Append one attribution event. Best-effort: returns true on write, false on any
 * failure (read-only fs, missing dirs) — writers must never let attribution block work.
 * `ev` should carry: source (required), and optionally weightsBefore/weightsAfter
 * (snapshotWeights shape), bridge2786, sessionId, detail.
 */
function appendEvent(root, ev) {
  if (!ev || !ev.source) return false;
  try {
    const row = Object.assign({ v: 1, schema: SCHEMA, ts: new Date().toISOString() }, ev);
    if (row.weightsBefore !== undefined && row.weightsAfter !== undefined) {
      const b = row.weightsBefore, a = row.weightsAfter;
      row.weightsChanged = (b && b.sha256) !== (a && a.sha256);
    }
    fs.mkdirSync(path.dirname(ledgerPath(root)), { recursive: true });
    fs.appendFileSync(ledgerPath(root), JSON.stringify(row) + '\n');
    return true;
  } catch (e) { return false; }
}

/** All parseable ledger rows (malformed lines skipped — history is append-only, never repaired). */
function readEvents(root) {
  try {
    return fs.readFileSync(ledgerPath(root), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter((r) => r && r.schema === SCHEMA && r.source);
  } catch (e) { return []; }
}

/**
 * Attribute one observed weights transition (beforeSha → afterSha) to the source(s)
 * whose recorded window covers it. Conservative by construction: no covering event
 * ⇒ [UNKNOWN_SOURCE]. Rows written before the ledger existed cannot match ⇒ all
 * pre-attribution history classifies unknown, never silently into a known bucket.
 */
function attributeTransition(events, beforeSha, afterSha) {
  const hits = [];
  for (const ev of events || []) {
    const b = ev.weightsBefore && ev.weightsBefore.sha256;
    const a = ev.weightsAfter && ev.weightsAfter.sha256;
    // null before = "sink did not exist yet" — matches a null/undefined beforeSha.
    if ((b || null) === (beforeSha || null) && a && a === afterSha) hits.push(ev.source);
  }
  return hits.length ? hits : [UNKNOWN_SOURCE];
}

/** Global node_modules root: env override (tests) → npm root -g → execPath-derived. */
function resolveNpmRoot() {
  if (process.env.KIT_ATTR_NODE_BASE) return process.env.KIT_ATTR_NODE_BASE;
  try {
    const out = require('child_process').execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).toString().trim();
    if (out && fs.existsSync(out)) return out;
  } catch (e) {}
  return path.join(path.dirname(path.dirname(process.execPath)), 'lib', 'node_modules');
}

/**
 * defect_gate (JS): is the ruflo #2786 bridge→trajectory write LIVE in the installed
 * dist? Gates on the BEHAVIOR — a recordTrajectory( call inside the textual body of
 * bridgeRecordFeedback in memory-bridge.js — never on a version or a comment. Returns
 * { live: true|false|null, path }. THREE-VALUED on purpose ("cannot tell" ≠ "fixed"):
 *   true  — anchor found AND the call is present (double-writes live);
 *   false — anchor found and the call is GONE (upstream genuinely removed/reverted it);
 *   null  — cannot assess: dist unreadable, OR the bridgeRecordFeedback identifier is
 *           absent entirely (renamed/moved/minified — the double-write may well
 *           CONTINUE under another name, so reporting false here would be a lie).
 */
function detectBridgeTrajectoryLive(npmRoot) {
  try {
    const root = npmRoot || resolveNpmRoot();
    const p = path.join(root, 'ruflo', 'node_modules', '@claude-flow', 'cli', 'dist', 'src', 'memory', 'memory-bridge.js');
    const src = fs.readFileSync(p, 'utf8');
    // Anchor tolerates `function`/`const`/`let`/`var` declaration forms. No scopable
    // declaration — whether the identifier is absent (renamed? deleted? can't tell)
    // or present only in an unscopable form — means the probe has lost its subject:
    // that is null, never false.
    const m = src.match(/(?:function|const|let|var)\s+bridgeRecordFeedback\b/);
    if (!m) return { live: null, path: p };
    const start = m.index;
    // Body extends to the next top-level export (or EOF) — coarse but stable across
    // minifier-free dist builds, and it can only over-scan into a NEIGHBORING export,
    // which grep-scoping the next `export` prevents.
    const end = src.indexOf('\nexport ', start + 1);
    const body = src.slice(start, end > start ? end : undefined);
    return { live: /recordTrajectory\s*\(/.test(body), path: p };
  } catch (e) { return { live: null, path: null }; }
}

module.exports = {
  SCHEMA, LEDGER_REL, WEIGHTS_REL, KNOWN_SOURCES, UNKNOWN_SOURCE,
  ledgerPath, weightsPath, snapshotWeights, appendEvent, readEvents,
  attributeTransition, resolveNpmRoot, detectBridgeTrajectoryLive,
};
