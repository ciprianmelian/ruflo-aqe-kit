#!/usr/bin/env node
'use strict';
/**
 * PLUGIN-VENDOR drift sentinel — SessionStart hook seeded by fix-ruflo Step 5n
 * (PLUGIN-VENDOR-V1, --vendor-plugins) — see docs/_INSTRUCTIONS.md Patch 80.
 *
 * WHAT: Step 5n vendors namespace-corrected copies of marketplace plugin
 * content into <target>/.claude/{skills,commands,agents}, freezing them at a
 * plugin version + marketplace git sha recorded in
 * .claude/.plugin-vendor-manifest.json. The marketplace clone (~/.claude/
 * plugins/marketplaces/<marketplace>) moves independently of that frozen
 * copy. This sentinel runs once per session and says so when it has.
 *
 * WHY SessionStart, deliberately NOT a realtime watcher/daemon: this kit
 * pins daemon autostart OFF across three separate channels
 * (RUFLO_DAEMON_MODE default off, .agentic-qe/config.yaml daemonAutoStart:
 * false, claude-flow.config.json daemon.autostart:false — see CLAUDE.md's
 * "Kit-managed target" block). A background watcher process for this would
 * reopen exactly the channel those three pins exist to keep shut. A
 * per-session, sub-second, zero-network check is the deliberate tradeoff:
 * drift is caught at the next session start, not the instant it happens.
 *
 * CONTRACT: never throws past main(), never blocks (short git timeout),
 * never touches the network, ALWAYS exits 0 — a broken sentinel must never
 * break a Claude Code session. No manifest / no git / no marketplace /
 * malformed manifest JSON are all silent, not errors.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// Mirrors .claude/helpers/intelligence.cjs's resolveProjectRoot exactly
// (CLAUDE_PROJECT_DIR env wins; otherwise walk up looking for a project
// marker) so this sentinel resolves the same root every other hook does.
function resolveProjectRoot(startDir) {
  if (process.env.CLAUDE_PROJECT_DIR) return path.resolve(process.env.CLAUDE_PROJECT_DIR);
  let dir = path.resolve(startDir || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.claude'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir || process.cwd());
    dir = parent;
  }
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function currentSha(marketplace, home) {
  try {
    const dir = path.join(home, '.claude', 'plugins', 'marketplaces', marketplace);
    const r = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 2000 });
    if (r.error || r.status !== 0 || !r.stdout) return null;
    return r.stdout.trim();
  } catch { return null; }
}

function currentVersion(marketplace, plugin, home) {
  let pj = readJsonSafe(path.join(home, '.claude', 'plugins', 'marketplaces', marketplace, 'plugins', plugin, '.claude-plugin', 'plugin.json'));
  if (!pj) {
    // Single-plugin marketplace layout: marketplace root IS the plugin
    // (same fallback as tools/plugin-vendor.cjs — name must match).
    const rootPj = readJsonSafe(path.join(home, '.claude', 'plugins', 'marketplaces', marketplace, '.claude-plugin', 'plugin.json'));
    if (rootPj && rootPj.name === plugin) pj = rootPj;
  }
  return (pj && pj.version) || null;
}

function short(sha) { return sha && sha !== 'unknown' ? sha.slice(0, 7) : 'unknown'; }

function main() {
  const root = resolveProjectRoot(process.cwd());
  const manifest = readJsonSafe(path.join(root, '.claude', '.plugin-vendor-manifest.json'));
  if (!manifest || typeof manifest !== 'object') return; // no manifest — nothing was ever vendored

  const home = process.env.HOME || os.homedir();

  for (const pluginKey of Object.keys(manifest)) {
    const entry = manifest[pluginKey];
    if (!entry || typeof entry !== 'object') continue;
    const at = pluginKey.indexOf('@');
    if (at < 1) continue;
    const plugin = pluginKey.slice(0, at);
    const marketplace = pluginKey.slice(at + 1);

    const nowSha = currentSha(marketplace, home);
    const nowVer = currentVersion(marketplace, plugin, home);
    if (nowSha === null || nowVer === null) continue; // marketplace/git unavailable — silent, never an error

    if (nowSha === entry.marketplaceSha && nowVer === entry.version) continue; // no drift

    process.stdout.write(
      `PLUGIN-VENDOR drift: ${plugin} vendored at ${entry.version}/${short(entry.marketplaceSha)}, ` +
      `marketplace now ${nowVer}/${short(nowSha)} — re-run: bin/ruflo-kit fix-ruflo ${root} --vendor-plugins\n`
    );
  }
}

try { main(); } catch { /* a broken sentinel must never break a session */ }
process.exit(0);
