#!/usr/bin/env node
/*
 * NPM-ROOT-RESOLVE-V1 — shared resolver for the GLOBAL node_modules root.
 *
 * `npm root -g` is the truth: a custom npm prefix (e.g. ~/.npm-global, or a
 * system node at /usr/bin/node with globals elsewhere) diverges from the
 * execPath-derived guess `dirname(dirname(execPath))/lib/node_modules`, which
 * silently no-op'd every helper that used it on such hosts. The execPath
 * derivation stays as the offline/no-npm fallback (it is correct under nvm
 * and the stock installers). Result is cached per-process.
 *
 * Installed into targets ALONGSIDE its consumers (lib/fix-aqe.sh helper
 * install list) so `require('./_npm-root.cjs')` resolves from
 * .claude/helpers/ too. Consumers wrap the require in try/catch and degrade
 * to the inline execPath derivation, so a target that predates this file
 * keeps working unchanged.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let _cached = null;

module.exports = function npmRootG() {
  if (_cached) return _cached;
  try {
    const out = require('child_process')
      .execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 })
      .toString()
      .trim();
    if (out && fs.existsSync(out)) {
      _cached = out;
      return _cached;
    }
  } catch (e) { /* npm missing/broken — fall through to the derivation */ }
  _cached = path.join(path.dirname(path.dirname(process.execPath)), 'lib', 'node_modules');
  return _cached;
};
