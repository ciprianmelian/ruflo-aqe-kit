#!/usr/bin/env node
'use strict';
/**
 * PLUGIN-VENDOR-V1 — fix-ruflo Step 5n's worker.
 *
 * Turns Step 5m's (PLUGIN-NS-ADVISORY-V1) read-only advisory into action,
 * strictly opt-in (bash gates this on --vendor-plugins before ever invoking
 * this file — see docs/_INSTRUCTIONS.md Patch 80 + docs/audit-ruflo-init-
 * scaffold-drift.md F4 for why the mismatch exists).
 *
 * WHAT: enabled marketplace plugins (ruflo-sparc, ruflo-adr, ...) call MCP
 * tools under mcp__plugin_<plugin>_<server>__<suffix> — a namespace that only
 * resolves if the separate, unpinned "ruflo-core" plugin is ALSO installed
 * (Patch 18 anti-pattern). This project's real, pinned server is registered
 * as "claude-flow" (mcp__claude-flow__*). This script vendors a copy of the
 * plugin's skills/commands/agents into the target's own .claude/, rewriting
 * ONLY the tool refs on a VERIFIED allowlist (audited against the live
 * claude-flow v3.34.0 server) — everything else is left untouched and
 * reported, never guessed at ("surface, don't guess", Patch 78's principle
 * extended to tool names instead of command docs).
 *
 * NEVER writes under ~/.claude/plugins/ (the host-global marketplace cache
 * shared by every other project on the host) — reads only, always.
 *
 * Usage: node plugin-vendor.cjs <target-dir> [--dry-run]
 * Env:   HOME — resolves ~/.claude/plugins/marketplaces; tests override this
 *        so a fixture marketplace can be exercised hermetically.
 *
 * Output contract (stdout, one line per event; fix-ruflo.sh dispatches on the
 * prefix to its own pass/info/fix/warn so the report reads like every other
 * step): "PASS:", "INFO:" (includes every "[dry-run] Would: ..." line),
 * "FIX:", "WARN:". Exits 0 unless an unexpected internal error occurs.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const TARGET = path.resolve(process.argv[2] || process.cwd());
const DRY = process.argv.includes('--dry-run');
const HOME = process.env.HOME || os.homedir();

function say(tag, msg) { process.stdout.write(`${tag}:${msg}\n`); }

// ---------------------------------------------------------------------------
// Verified tool-name allowlist — each confirmed present on the live
// claude-flow v3.34.0 server during the audit session (docs/_INSTRUCTIONS.md
// Patch 80). Hardcoded, same style as Step 5l's DRC dataset — never inferred.
// ---------------------------------------------------------------------------
const ALLOWLIST = [
  'memory_store', 'memory_search', 'memory_retrieve', 'memory_list', 'memory_delete', 'memory_export',
  'session_save', 'session_restore', 'task_create', 'task_update', 'task_complete',
  'hooks_intelligence_trajectory-start', 'hooks_intelligence_trajectory-step', 'neural_predict',
  'agentdb_hierarchical-store', 'agentdb_causal-edge', 'agent_status', 'agent_health', 'agent_spawn',
  'agent_list', 'swarm_init', 'swarm_status', 'github_repo_analyze', 'github_issue_track', 'github_pr_manage',
];
// Confirmed ABSENT from the live server — if referenced, always FLAG, never
// rewrite-and-hope (kept as its own list purely so the FLAG reason can say so
// explicitly, rather than "not in the allowlist" — a different confidence).
const KNOWN_DEAD = [
  'memory_usage', 'context_restore', 'memory_backup', 'agent_metrics', 'task_orchestrate',
  'swarm_monitor', 'sparc_mode',
];
// Known semantic mismatch: the name plugin docs use has no live tool at all,
// but a DIFFERENTLY-named live tool covers similar ground — renaming cannot
// fix a semantic difference, so this still goes to FLAG, just with the
// counterpart named for the human/agent who verifies it.
const SEMANTIC_MISMATCH = { 'agentdb_hierarchical-query': 'agentdb_hierarchical-recall' };

const PROVENANCE_MARKER = 'PLUGIN-VENDOR-V1';
const NOW_ISO = new Date().toISOString();

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// enabledPlugins: settings.local.json is primary; settings.json is the
// fallback ONLY when the primary is absent or carries no enabled entries
// (spec-specified precedence — deliberately not a union, unlike Step 5m).
function enabledPlugins() {
  const local = readJsonSafe(path.join(TARGET, '.claude', 'settings.local.json'));
  let ep = (local && local.enabledPlugins) || {};
  if (Object.keys(ep).length === 0) {
    const proj = readJsonSafe(path.join(TARGET, '.claude', 'settings.json'));
    ep = (proj && proj.enabledPlugins) || {};
  }
  return Object.keys(ep).filter((k) => ep[k] === true);
}

function marketplaceSha(marketplace) {
  const dir = path.join(HOME, '.claude', 'plugins', 'marketplaces', marketplace);
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 3000 }).trim();
  } catch { return 'unknown'; }
}

function pluginVersion(pluginDir) {
  const pj = readJsonSafe(path.join(pluginDir, '.claude-plugin', 'plugin.json'));
  return (pj && pj.version) || 'unknown';
}

function findFilesRecursive(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findFilesRecursive(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const NAMESPACE_SCOPE_RE = /mcp__plugin_[A-Za-z0-9-]+_[A-Za-z0-9-]+__/;

function pluginHasNamespaceRefs(pluginDir) {
  for (const f of findFilesRecursive(pluginDir)) {
    let content;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; } // binary/unreadable — not a text ref carrier
    if (NAMESPACE_SCOPE_RE.test(content)) return true;
  }
  return false;
}

// Comment style for the provenance header, by extension. Rewriting +
// header-prepending is scoped to these known-text kinds — a plugin's
// skills/<name>/ dir may carry non-text support files (images, binaries),
// which are still COPIED (collision policy still applies) but left byte-
// identical: there is no safe universal "matching comment style" for an
// arbitrary/binary extension, and the mcp__plugin_*__ refs this step exists
// to fix only ever appear in the plugin's markdown/doc/script surface anyway.
function commentStyle(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.md' || ext === '.markdown' || ext === '.html') return { open: '<!--', close: ' -->' };
  if (['.sh', '.bash', '.py', '.rb', '.yml', '.yaml'].includes(ext)) return { open: '#', close: '' };
  if (['.js', '.cjs', '.mjs', '.ts', '.tsx'].includes(ext)) return { open: '//', close: '' };
  return null;
}

function flagReasonFor(suffix) {
  if (SEMANTIC_MISMATCH[suffix]) {
    return `semantic mismatch — plugin calls "${suffix}"; live server exposes "${SEMANTIC_MISMATCH[suffix]}", but renaming alone cannot fix a semantic difference — verify manually before using either`;
  }
  if (KNOWN_DEAD.includes(suffix)) {
    return 'confirmed absent from the live claude-flow server — no mapping exists, do not rewrite';
  }
  return 'no verified mcp__claude-flow__ equivalent — do not assume one exists';
}

// Rewrite/flag the mcp__plugin_<plugin>_<server>__<suffix> refs for ONE known
// plugin name (server is captured dynamically — a plugin may bundle more than
// one server). Returns { content, rewritten, flags: [{ref, reason}] }.
function rewriteToolRefs(content, plugin) {
  let rewritten = 0;
  const flags = [];
  const re = new RegExp(`mcp__plugin_${escapeRegExp(plugin)}_([A-Za-z0-9-]+)__([A-Za-z0-9_-]+)`, 'g');
  const out = content.replace(re, (full, _server, suffix) => {
    if (ALLOWLIST.includes(suffix)) { rewritten++; return `mcp__claude-flow__${suffix}`; }
    flags.push({ ref: full, reason: flagReasonFor(suffix) });
    return full;
  });
  return { content: out, rewritten, flags };
}

function collectVendorCandidates(pluginDir) {
  const files = [];
  const skillsDir = path.join(pluginDir, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const name of fs.readdirSync(skillsDir)) {
      const srcDir = path.join(skillsDir, name);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      for (const f of findFilesRecursive(srcDir)) {
        files.push({ src: f, destRel: path.join('skills', name, path.relative(srcDir, f)) });
      }
    }
  }
  for (const kind of ['commands', 'agents']) {
    const dir = path.join(pluginDir, kind);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const full = path.join(dir, f);
      if (fs.statSync(full).isFile()) files.push({ src: full, destRel: path.join(kind, f) });
    }
  }
  return files;
}

function hasProvenanceMarker(destFile) {
  try { return fs.readFileSync(destFile, 'utf8').includes(PROVENANCE_MARKER); } catch { return false; }
}

function main() {
  const claudeDir = path.join(TARGET, '.claude');
  const marketplacesRoot = path.join(HOME, '.claude', 'plugins', 'marketplaces');
  const manifestPath = path.join(claudeDir, '.plugin-vendor-manifest.json');
  const reportPath = path.join(claudeDir, 'PLUGIN-VENDOR-REPORT.md');

  const plugins = enabledPlugins();
  if (plugins.length === 0) {
    say('PASS', 'No marketplace plugins enabled for this project (enabledPlugins empty/absent) — nothing to vendor');
    return;
  }
  if (!fs.existsSync(marketplacesRoot)) {
    say('PASS', 'No marketplace plugin cache found at ~/.claude/plugins/marketplaces — nothing to vendor');
    return;
  }

  const existingManifest = readJsonSafe(manifestPath) || {};
  const manifest = DRY ? existingManifest : { ...existingManifest };

  const reportVendored = [];      // { pluginKey, files, rewritten, flaggedCount }
  const reportFlagged = [];       // { pluginKey, file, ref, reason }
  const reportSkippedNoNs = [];   // pluginKey
  const reportCollisions = [];    // { pluginKey, file }
  let anyMutation = false;

  for (const pluginKey of plugins) {
    const at = pluginKey.indexOf('@');
    if (at < 1) { say('WARN', `enabledPlugins key "${pluginKey}" is not in <plugin>@<marketplace> form — skipping`); continue; }
    const plugin = pluginKey.slice(0, at);
    const marketplace = pluginKey.slice(at + 1);
    const pluginDir = path.join(marketplacesRoot, marketplace, 'plugins', plugin);

    if (!fs.existsSync(pluginDir)) {
      say('WARN', `${pluginKey}: not found under ~/.claude/plugins/marketplaces/${marketplace}/plugins/${plugin} — skipping`);
      continue;
    }
    if (!pluginHasNamespaceRefs(pluginDir)) {
      reportSkippedNoNs.push(pluginKey);
      say('PASS', `${pluginKey}: no namespace fix needed — not vendored`);
      continue;
    }

    const version = pluginVersion(pluginDir);
    const sha = marketplaceSha(marketplace);
    const prior = existingManifest[pluginKey];
    if (prior && prior.version === version && prior.marketplaceSha === sha) {
      say('PASS', `${pluginKey}: already vendored at current version (sha match) — v${version} @ ${sha.slice(0, 7)}`);
      continue;
    }

    const candidates = collectVendorCandidates(pluginDir);
    if (candidates.length === 0) {
      say('WARN', `${pluginKey}: namespace refs detected but no skills/commands/agents content found to vendor`);
      continue;
    }

    if (DRY) {
      say('INFO', `[dry-run] Would: vendor ${candidates.length} file(s) from ${pluginKey} (v${version}, sha ${sha === 'unknown' ? 'unknown' : sha.slice(0, 7)}) into .claude/{skills,commands,agents}, rewriting verified tool refs to mcp__claude-flow__*`);
      for (const { destRel } of candidates) {
        const dest = path.join(claudeDir, destRel);
        if (fs.existsSync(dest) && !hasProvenanceMarker(dest)) {
          say('INFO', `[dry-run] Would flag collision: .claude/${destRel} exists and is not a previous vendor copy — would be skipped (user-owned)`);
        } else {
          say('INFO', `[dry-run] Would: write .claude/${destRel}`);
        }
      }
      continue;
    }

    let pluginRewritten = 0;
    const pluginFlags = [];
    const pluginFiles = [];
    fs.mkdirSync(claudeDir, { recursive: true });

    for (const { src, destRel } of candidates) {
      const dest = path.join(claudeDir, destRel);
      if (fs.existsSync(dest) && !hasProvenanceMarker(dest)) {
        reportCollisions.push({ pluginKey, file: destRel });
        say('WARN', `${pluginKey}: collision — .claude/${destRel} exists and is not a previous vendor copy (user-owned); skipped`);
        continue;
      }

      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const style = commentStyle(src);
      if (!style) {
        fs.copyFileSync(src, dest); // binary/unknown-kind support file: copy verbatim, no header
        pluginFiles.push(destRel);
        continue;
      }

      const raw = fs.readFileSync(src, 'utf8');
      const { content, rewritten, flags } = rewriteToolRefs(raw, plugin);
      for (const fl of flags) pluginFlags.push({ file: destRel, ref: fl.ref, reason: fl.reason });
      const header = `${style.open} ${PROVENANCE_MARKER}: vendored from ${pluginKey} v${version} (marketplace sha ${sha}) on ${NOW_ISO} by ruflo-kit fix-ruflo Step 5n. Substitutions: ${rewritten} tool refs rewritten to mcp__claude-flow__*, ${flags.length} flagged. Do not edit the upstream plugin cache; re-run with --vendor-plugins to refresh.${style.close}\n`;
      fs.writeFileSync(dest, header + content, 'utf8');
      pluginFiles.push(destRel);
      pluginRewritten += rewritten;
    }

    if (pluginFiles.length === 0) {
      // every candidate collided — nothing actually written for this plugin.
      continue;
    }

    manifest[pluginKey] = {
      version,
      marketplaceSha: sha,
      vendoredAt: NOW_ISO,
      files: pluginFiles,
      rewritten: pluginRewritten,
      flagged: pluginFlags,
    };
    anyMutation = true;
    say('FIX', `${pluginKey}: vendored ${pluginFiles.length} file(s) (${pluginRewritten} tool ref(s) rewritten, ${pluginFlags.length} flagged) -> .claude/{skills,commands,agents}`);
  }

  if (DRY) return; // dry-run never writes the manifest or report

  if (!anyMutation && reportSkippedNoNs.length === plugins.length) {
    // Nothing to vendor at all this run and nothing was vendored previously —
    // skip creating an empty manifest/report noise.
    if (Object.keys(existingManifest).length === 0) return;
  }

  // Report "vendored"/"flagged" sections reflect the FINAL manifest state
  // (pre-existing entries carried over + anything this run touched), not just
  // this run's deltas — otherwise a no-op idempotent re-run (sha match, no
  // candidates touched) would overwrite a populated report with an empty one.
  for (const pluginKey of Object.keys(manifest)) {
    const m = manifest[pluginKey];
    reportVendored.push({ pluginKey, files: m.files || [], rewritten: m.rewritten || 0, flaggedCount: (m.flagged || []).length });
    for (const fl of (m.flagged || [])) reportFlagged.push({ pluginKey, file: fl.file, ref: fl.ref, reason: fl.reason });
  }

  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const lines = [];
  lines.push('# Marketplace-plugin vendoring report (PLUGIN-VENDOR-V1)');
  lines.push('');
  lines.push('Generated by fix-ruflo.sh Step 5n (--vendor-plugins) — see docs/_INSTRUCTIONS.md Patch 80.');
  lines.push('');
  lines.push('## Vendored this run');
  lines.push('');
  if (reportVendored.length === 0) {
    lines.push('- (none — either already vendored at current version, or nothing needed vendoring)');
  } else {
    for (const v of reportVendored) {
      lines.push(`- **${v.pluginKey}** — ${v.files.length} file(s), ${v.rewritten} tool ref(s) rewritten, ${v.flaggedCount} flagged`);
      for (const f of v.files) lines.push(`  - .claude/${f}`);
    }
  }
  lines.push('');
  lines.push('## FLAGGED refs (no verified live substitution — untouched, needs a human/agent to verify)');
  lines.push('');
  if (reportFlagged.length === 0) {
    lines.push('- (none)');
  } else {
    lines.push('| Plugin | File | Ref | Reason |');
    lines.push('|---|---|---|---|');
    for (const f of reportFlagged) {
      lines.push(`| ${f.pluginKey} | .claude/${f.file} | \`${f.ref}\` | ${f.reason} |`);
    }
  }
  lines.push('');
  lines.push('## Skipped plugins (no mcp__plugin_*__ namespace references found — nothing to vendor)');
  lines.push('');
  if (reportSkippedNoNs.length === 0) {
    lines.push('- (none)');
  } else {
    for (const p of reportSkippedNoNs) lines.push(`- ${p}`);
  }
  lines.push('');
  lines.push('## Collision skips (destination already exists and is not a previous vendor copy — never overwritten)');
  lines.push('');
  if (reportCollisions.length === 0) {
    lines.push('- (none)');
  } else {
    for (const c of reportCollisions) lines.push(`- ${c.pluginKey}: .claude/${c.file}`);
  }
  lines.push('');
  lines.push('## Recommended follow-up');
  lines.push('');
  lines.push('Vendored copies are now project-scoped and reproducible, but the original marketplace plugin(s)');
  lines.push('above are still enabled in `.claude/settings.local.json` — Claude Code will surface BOTH the');
  lines.push('vendored and the original skill/command/agent unless the plugin is disabled. Consider setting the');
  lines.push('corresponding `enabledPlugins` entry to `false` once you have confirmed the vendored copy works,');
  lines.push('to avoid a duplicate skill/command surface. This step never changes `enabledPlugins` itself —');
  lines.push('that is the user\'s call, not this script\'s.');
  lines.push('');
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

  if (anyMutation) {
    say('FIX', `Wrote plugin-vendor manifest + report (.claude/.plugin-vendor-manifest.json, .claude/PLUGIN-VENDOR-REPORT.md)`);
  } else {
    say('PASS', 'Plugin vendoring: everything already vendored at current version (sha match) — report refreshed');
  }
}

try {
  main();
} catch (e) {
  say('WARN', `plugin-vendor.cjs internal error: ${e && e.message ? e.message : e}`);
}
