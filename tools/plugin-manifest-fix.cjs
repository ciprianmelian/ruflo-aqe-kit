#!/usr/bin/env node
/*
 * PLUGIN-MANIFEST-REPO-V1 (Patch 69) — normalize skill-plugin manifests that
 * Claude Code's plugin schema rejects.
 *
 * Root cause: `ruflo init` registers the core skill via the external skills.sh
 * CLI (`npx skills add ruvnet/ruflo --skill ruflo` — see the installed dist's
 * commands/init.js maybeInstallSkillsSh), which installs the skill folder from
 * repo content carrying an npm-package.json-shaped manifest. Claude Code's
 * plugin manifest schema wants `repository` as a plain STRING; the npm object
 * form ({"type":"git","url":...}) fails validation and the whole skill folder
 * refuses to load ("Plugin ruflo has an invalid manifest file... repository:
 * Invalid input: expected string, received object").
 *
 * The generator is NOT patchable by the kit (content arrives from GitHub via a
 * third-party CLI at install time), so this is a target-side normalization
 * sweep: for every <root>/<skill>/.claude-plugin/plugin.json under the known
 * plugin roots, rewrite an object-shaped `repository` to its `.url` string. Nothing
 * else is touched. Self-retiring: no manifests / already-string => no-op, so
 * the sweep dies quietly the day upstream ships a schema-valid manifest.
 *
 * Usage: node plugin-manifest-fix.cjs <targetDir> [--dry-run]
 * Stdout protocol (adoption-note.cjs convention — LAST line is the verdict):
 *   FIXED:<relpath> | WOULD_FIX:<relpath> | SKIP_BAD:<relpath> | SKIP_NOURL:<relpath>
 *   RESULT:FIXED:<n> | RESULT:WOULD_FIX:<n> | RESULT:UNCHANGED | RESULT:NOFILES
 * Always exits 0 unless the target dir itself is unusable (exit 2).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const target = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!target || !fs.existsSync(target)) {
  console.log('RESULT:BADTARGET');
  process.exit(2);
}

// The plugin roots Claude Code (and ruflo's own reader, wasm-agent-tools.js)
// resolve manifests from, plus the skills.sh install locations observed live.
const ROOTS = [
  path.join('.claude', 'skills'),
  path.join('.agents', 'skills'),
  'plugins',
  path.join('v3', 'plugins'),
];

let found = 0;
let fixed = 0;

for (const root of ROOTS) {
  const rootAbs = path.join(target, root);
  let entries = [];
  try {
    entries = fs.readdirSync(rootAbs, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (e) { continue; }
  for (const ent of entries) {
    const manifest = path.join(rootAbs, ent.name, '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(manifest)) continue;
    found++;
    const rel = path.relative(target, manifest);
    let raw;
    let data;
    try {
      raw = fs.readFileSync(manifest, 'utf8');
      data = JSON.parse(raw);
    } catch (e) {
      console.log('SKIP_BAD:' + rel); // unparseable — never "fix" what we can't read
      continue;
    }
    const repo = data.repository;
    if (typeof repo !== 'object' || repo === null || Array.isArray(repo)) continue; // string/absent — schema-fine
    if (typeof repo.url !== 'string' || !repo.url) {
      console.log('SKIP_NOURL:' + rel); // object with no url — nothing truthful to write
      continue;
    }
    if (dryRun) {
      console.log('WOULD_FIX:' + rel);
      fixed++;
      continue;
    }
    data.repository = repo.url;
    fs.writeFileSync(manifest, JSON.stringify(data, null, 2) + '\n');
    console.log('FIXED:' + rel);
    fixed++;
  }
}

if (found === 0) console.log('RESULT:NOFILES');
else if (fixed === 0) console.log('RESULT:UNCHANGED');
else console.log('RESULT:' + (dryRun ? 'WOULD_FIX' : 'FIXED') + ':' + fixed);
process.exit(0);
