#!/usr/bin/env node
// ruvnet-brain MCP launcher — INTENTIONALLY DEGRADED v1-style stdio proxy.
//
// This is the CI/clean-clone fallback that lib/fix-brain.sh uses only when the gitignored
// vendor/ruvnet-brain checkout is absent. Upstream's own plugin/mcp/server.mjs was rewritten
// in the 4.0.x line into a stateful v2 "Stable Spine" shell that owns the client MCP
// handshake itself, hot-swaps a warm child brain process between calls, tracks a lease file,
// adds a 240s timeout/outage alarm (kb/brain-alarm.mjs, with an opt-in ntfy.sh push), and
// exposes two extra tools — ruvnet_cli_help / ruvnet_cli_run, general managed-CLI execution —
// via a sibling managed-cli-interface.mjs. We deliberately do NOT vendor that v2 machinery
// here: the extra CLI-execution tools and outbound alarm widen this file's surface well past
// the kit's "one MCP tool" (search_ruvnet) design, for a fallback path that is rarely
// exercised. What THIS v1 proxy still gives you: a working search_ruvnet, because the KB's own
// forge-mcp-all.mjs (spawned below) still answers the same JSON-RPC tool contract this proxy
// relies on (initialize/tools-list/tools-call) — verified end-to-end against a fixture KB. That
// file is NOT unchanged: the same 4.0-series commits gave it a v2-only `brain/warmup` RPC (only
// v2's hot-swap shell ever calls it) plus small answer-path tweaks (answerFromCards gained
// { allowGuideAnswers: true }, searchAll gained { allowFullCorpus: false }). This v1 proxy never
// calls brain/warmup and simply forwards whatever forge-mcp-all.mjs returns, so those tweaks
// ride along transparently — the compatibility is at the protocol/tool-contract level, not
// byte-identity. What it does NOT give you vs upstream v2: hot-swap-without-restart, the
// timeout/outage alarm, and the two ruvnet_cli_* tools.
//
// Full analysis: docs/gauntlet-2026-07-31/brain-ledger.md entry E1.
// BRAIN-FALLBACK-DEGRADED-V1 — documented against upstream v4.0.2 (commit 453ae58).
// Drift tripwire: tests/brain-fallback-drift.test.js (fails if upstream moves past this
// reference point without the decision above being re-reviewed).
//
// Brain location resolution order:
//   1) $RUVNET_BRAIN_KB                          (explicit override — used for local/dev)
//   2) $RUVNET_BRAIN_HOME/kb                      (custom home)
//   3) ~/.cache/ruvnet-brain/kb                   (default install cache)
// Model cache: $KB_MODEL_CACHE, else <home>/models (first query downloads HF models there).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = process.env.RUVNET_BRAIN_HOME || path.join(os.homedir(), '.cache', 'ruvnet-brain');
const KB = process.env.RUVNET_BRAIN_KB || path.join(HOME, 'kb');
const MCP = path.join(KB, 'forge-mcp-all.mjs');

function die(msg) {
  process.stderr.write(`[ruvnet-brain] ${msg}\n`);
  process.exit(1);
}

if (!fs.existsSync(MCP)) {
  die(
    `brain not found at ${KB}.\n` +
      `  • dev/local: set RUVNET_BRAIN_KB to your brain's kb dir (the one with forge-mcp-all.mjs), or\n` +
      `    symlink it:  mkdir -p ${HOME} && ln -s /path/to/ruvnet-brain/kb ${KB}\n` +
      `  • published: this will fetch the brain bundle from the GitHub Release automatically (Phase 3).`,
  );
}

const env = { ...process.env, KB_DIR: KB };
if (!env.KB_MODEL_CACHE) env.KB_MODEL_CACHE = path.join(HOME, 'models');

// Transparent stdio proxy — the brain's MCP server speaks JSON-RPC on stdin/stdout.
const child = spawn('node', [MCP], { stdio: 'inherit', env });
child.on('error', (e) => die(`failed to launch brain MCP server: ${e.message}`));
child.on('exit', (code) => process.exit(code ?? 0));
