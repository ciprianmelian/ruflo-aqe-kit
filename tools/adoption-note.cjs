#!/usr/bin/env node
'use strict';
// ============================================================================
// tools/adoption-note.cjs — KIT-ADOPTION-NOTE-V1 (fix-ruflo Step 5j).
//
// Maintains a marker-delimited, kit-managed note at the end of the TARGET's
// CLAUDE.md telling future operators the heal/check verbs and the deliberate
// states they must NOT "fix". Extracted from fix-ruflo.sh so the mutation
// logic is testable in isolation (fix-ruflo Step 1 auto-upgrades the global
// toolchain, so tests never run the whole script un-dry).
//
// Usage:  node adoption-note.cjs <claude_md_path> <kit_dir> [--dry-run]
//
// Decision (in order):
//   1. no CLAUDE.md                       -> SKIP_NOFILE       (untouched)
//   2. both markers present:
//        between-content == canonical     -> UNCHANGED         (cmp-skip)
//        else                             -> HEALED / WOULD_HEAL
//   3. file mentions 'ruflo-aqe-kit'      -> SKIP_HANDWRITTEN  (untouched —
//        a hand-written kit note, like the adopted target's; honored, not duplicated)
//   4. else                               -> APPENDED / WOULD_APPEND
//
// stdout: exactly one verdict token from the set above. Exit 0 on every
// verdict; exit 2 on usage/IO errors. Mutations copy <file>.fixruflo.bak
// first (the script's existing backup idiom) and remove it on success.
// ============================================================================

const fs = require('fs');

const MARK_OPEN = '<!-- KIT-ADOPTION-NOTE-V1 -->';
const MARK_CLOSE = '<!-- /KIT-ADOPTION-NOTE-V1 -->';

// Canonical text BETWEEN the markers (no leading/trailing newline; the block
// builder supplies the newlines around it). Short and operational on purpose.
function canonicalInner(kitDir) {
  return [
    '## Kit-managed target (ruflo-aqe-kit)',
    '',
    `This project is adopted by the ruflo-aqe-kit at \`${kitDir}\`. This block is kit-managed — edits between the markers are re-asserted by \`fix-ruflo\`.`,
    '',
    `- Heal/check (run from the kit clone): \`bin/ruflo-kit sync ${'<target>'}\` (one-verb heal) · \`bin/ruflo-kit status ${'<target>'}\` (disk-derived truth) · \`bin/ruflo-kit proof ${'<target>'}\` (evidence-probe verdict).`,
    '- Deliberate states — do NOT "fix" these:',
    '  - **AgentDB shadow pin**: the hoisted `ruflo/node_modules/agentdb` floor and the nested `@claude-flow/memory/node_modules/agentdb` pin (`3.0.0-alpha.10`) are MEANT to differ (nearest-first resolution gives the memory layer the full controller surface).',
    '  - **MCP launch**: the claude-flow MCP server launches from the GLOBAL `ruflo` binary (`.mcp.json` -> `command: "ruflo"`), never `npx` — npx cache reconciliation would revert the AgentDB pin.',
    '  - **Daemon autostart is pinned OFF in 3 channels** (`RUFLO_DAEMON_MODE` default off; `.agentic-qe/config.yaml daemonAutoStart: false`; `claude-flow.config.json {"daemon":{"autostart":false}}`). An explicit `ruflo daemon start` is the opt-in — and then you own `ruflo daemon stop`.',
    '- Rule: re-run `ruflo-kit sync <target>` after ANY `npm i -g ruflo` or `npm i -g agentic-qe`.',
  ].join('\n');
}

function canonicalBlock(kitDir) {
  return `${MARK_OPEN}\n${canonicalInner(kitDir)}\n${MARK_CLOSE}`;
}

function run(file, kitDir, dryRun) {
  if (!fs.existsSync(file)) return 'SKIP_NOFILE';

  const src = fs.readFileSync(file, 'utf8');
  const open = src.indexOf(MARK_OPEN);
  const close = src.indexOf(MARK_CLOSE);

  if (open !== -1 && close !== -1 && close > open) {
    // Marker-managed block present: re-assert content between markers.
    const current = src.slice(open + MARK_OPEN.length, close);
    const wanted = `\n${canonicalInner(kitDir)}\n`;
    if (current === wanted) return 'UNCHANGED';
    if (dryRun) return 'WOULD_HEAL';
    const next = src.slice(0, open + MARK_OPEN.length) + wanted + src.slice(close);
    writeWithBackup(file, src, next);
    return 'HEALED';
  }

  if (src.includes('ruflo-aqe-kit')) return 'SKIP_HANDWRITTEN';

  if (dryRun) return 'WOULD_APPEND';
  const sep = src.length === 0 ? '' : src.endsWith('\n') ? '\n' : '\n\n';
  writeWithBackup(file, src, `${src}${sep}${canonicalBlock(kitDir)}\n`);
  return 'APPENDED';
}

function writeWithBackup(file, original, next) {
  const bak = `${file}.fixruflo.bak`;
  fs.writeFileSync(bak, original);
  try {
    fs.writeFileSync(file, next);
  } catch (err) {
    try { fs.copyFileSync(bak, file); } catch { /* keep .bak as evidence */ }
    throw err;
  }
  fs.unlinkSync(bak); // success: match the script's rm-on-success idiom
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const pos = args.filter((a) => a !== '--dry-run');
  if (pos.length !== 2) {
    process.stderr.write('usage: adoption-note.cjs <claude_md_path> <kit_dir> [--dry-run]\n');
    process.exit(2);
  }
  try {
    process.stdout.write(`${run(pos[0], pos[1], dryRun)}\n`);
  } catch (err) {
    process.stderr.write(`adoption-note: ${err && err.message ? err.message : err}\n`);
    process.exit(2);
  }
}

main();
