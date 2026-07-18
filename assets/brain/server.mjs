#!/usr/bin/env node
// ruvnet-brain MCP launcher.
// Resolves (or, when published, fetches) the RuvNet brain bundle, then runs the brain's own
// stdio MCP server (forge-mcp-all.mjs, tool: search_ruvnet) as a transparent stdio proxy.
//
// Brain location resolution order:
//   1) $RUVNET_BRAIN_KB                          (explicit override — used for local/dev)
//   2) $RUVNET_BRAIN_HOME/kb                      (custom home)
//   3) ~/.cache/ruvnet-brain/kb                   (default install cache)
// Model cache: $KB_MODEL_CACHE, else <home>/models (first query downloads HF models there).
//
// Phase 3 (publish): if the brain is absent and $RUVNET_BRAIN_RELEASE is set, download+unzip
// the release bundle into the cache before launching. Until then we fail loudly with guidance.
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
