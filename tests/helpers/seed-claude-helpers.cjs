/**
 * Vitest globalSetup — HELPER-SEED-V1 for the kit's OWN test run.
 *
 * 23 suites spawn/require `.claude/helpers/*` — copies that `fix-aqe` normally
 * installs/seeds from `assets/claude-helpers/` on a live target. On a clean
 * clone (or any host where fix-aqe was never run against the kit repo itself)
 * that directory does not exist and every one of those suites fails with
 * "Cannot find module". This setup mirrors fix-aqe's HELPER-SEED-V1 so the
 * suite is meaningful anywhere, with one data-protection rule:
 *
 *   - a destination file the harness itself wrote earlier (tracked by sha256
 *     in `.claude/helpers/.vitest-seeded.json`) is refreshed when the asset
 *     changes — so tests always exercise CURRENT kit sources;
 *   - a destination file the harness did NOT write (a live `aqe init` /
 *     fix-aqe healed copy on a dogfooded machine) is NEVER touched.
 *
 * statusline.cjs is deliberately NOT seeded: the canonical rule
 * (TRUTH-STATUSLINE-V1) says only fix-statusbar installs it, no suite spawns
 * the installed copy, and tests/statusline-canonical.test.js sha-compares any
 * installed copy against the asset — a harness-seeded copy would become a
 * false drift signal after the next asset edit.
 *
 * `.claude/` is gitignored (dogfood runtime state), so seeding never dirties
 * the working tree.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SRC = path.join(REPO, 'assets', 'claude-helpers');
const DST = path.join(REPO, '.claude', 'helpers');
const MANIFEST = path.join(DST, '.vitest-seeded.json');

// Mirror lib/fix-aqe.sh: the always-install list + the HELPER-SEED list
// (minus statusline.cjs — see header).
const HELPERS = [
  '_derive-outcome.cjs',
  '_npm-root.cjs',
  'ruflo-train.cjs',
  'ruflo-train-subagent.cjs',
  'aqe-rag-inject.cjs',
  'aqe-post-route.cjs',
  'ruflo-route-capture.cjs',
  'auto-memory-hook.mjs',
  'brain-checkpoint.cjs',
  'github-safe.mjs',
  'hook-handler.cjs',
  'intelligence.cjs',
  'learning-service.mjs',
  'memory.js',
  'metrics-db.mjs',
  'router.js',
  'ruflo-hook.cjs',
  'session.js',
  'statusline-v3.cjs',
  'statusline.js',
  'v3/advisor-call.cjs',
];

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

module.exports = async function seedClaudeHelpers() {
  fs.mkdirSync(DST, { recursive: true });

  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) || {}; } catch (e) {}

  for (const h of HELPERS) {
    const src = path.join(SRC, h);
    const dst = path.join(DST, h);
    if (!fs.existsSync(src)) continue;                    // asset retired — nothing to seed
    if (fs.existsSync(dst)) {
      const dstSha = sha256(dst);
      if (manifest[h] !== dstSha) continue;               // live/healed copy — never touch
      if (dstSha === sha256(src)) continue;               // already current
      // harness-seeded and the asset moved on — refresh so tests test SOURCE
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    manifest[h] = sha256(dst);
  }

  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
};
