#!/usr/bin/env node
/*
 * STATUSLINE-GUARD-V1 (Patch 68) — self-healing statusline.
 *
 * Upstream session machinery rewrites .claude/helpers/statusline.cjs with its
 * stock free-running-counter bar (observed twice on a fresh target, both times
 * minutes AFTER session start via a delayed detached child — so a session-start
 * assert loses the race by design). This guard wins by placement instead of
 * timing: fix-statusbar wires it as the FIRST step of the settings statusLine
 * command, so it runs on every refresh tick (~5s). A clobber can therefore
 * never survive a single render cycle.
 *
 * Mechanism: byte-compare statusline.cjs against the pristine snapshot
 * .statusline.canonical.cjs (a dotfile — upstream installers write named
 * assets, they don't own this). On drift: restore the snapshot and append one
 * evidence line to .claude-flow/statusline-guard.log (recurrences stay
 * countable instead of anecdotal). Missing snapshot => no-op. ALWAYS exit 0 —
 * a guard must never take the statusline down with it.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

try {
  const dir = __dirname; // <project>/.claude/helpers
  const installed = path.join(dir, 'statusline.cjs');
  const canonical = path.join(dir, '.statusline.canonical.cjs');
  if (fs.existsSync(canonical)) {
    const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    const want = sha(canonical);
    const have = fs.existsSync(installed) ? sha(installed) : '(missing)';
    if (have !== want) {
      fs.copyFileSync(canonical, installed);
      try {
        const logDir = path.resolve(dir, '..', '..', '.claude-flow');
        fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(
          path.join(logDir, 'statusline-guard.log'),
          new Date().toISOString() + ' restored canonical statusline (found ' + have.slice(0, 12) + ', want ' + want.slice(0, 12) + ')\n'
        );
      } catch (e) { /* logging is best-effort */ }
    }
  }
} catch (e) { /* never block a render */ }
process.exit(0);
