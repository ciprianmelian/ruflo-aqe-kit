#!/usr/bin/env bash
# ============================================================================
# lib/common.sh — shared library for the ruflo + AQE kit.
# Sourced by every lib/*.sh. Provides the KIT_DIR / TARGET_DIR decoupling so the
# kit can be cloned once and run against ANY codebase path.
#
#   KIT_DIR     where the kit (this repo) lives — resolved from BASH_SOURCE.
#   TARGET_DIR  the codebase to operate on — first positional arg, else
#               $RUFLO_KIT_TARGET, else $(pwd).
#
# Also centralizes flag parsing (--dry-run/--force/--reactivate), logging, and
# the dry-run-aware run() + backup() helpers that were duplicated across scripts.
# ============================================================================

# ── Kit location (independent of cwd / target) ──────────────────────────────
# common.sh lives in <KIT_DIR>/lib/, so KIT_DIR is its parent's parent.
# Resolve through symlinks: a global install puts `ruflo-kit` on PATH as a
# symlink into the real clone, so a naive `dirname $BASH_SOURCE` would point at
# the symlink's dir, not the clone. Walk the link chain by hand — macOS bash 3.2
# has no `readlink -f`, so we don't depend on GNU coreutils.
_kit_resolve_dir() {
  local src="$1" dir
  while [ -h "$src" ]; do
    dir="$(cd -P "$(dirname "$src")" 2>/dev/null && pwd)"
    src="$(readlink "$src")"
    case "$src" in /*) ;; *) src="$dir/$src" ;; esac
  done
  cd -P "$(dirname "$src")" 2>/dev/null && pwd
}
KIT_DIR="$(cd "$(_kit_resolve_dir "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)"
KIT_LIB="$KIT_DIR/lib"
KIT_ASSETS="$KIT_DIR/assets"
KIT_TOOLS="$KIT_DIR/tools"

# ── Daemon-safety for every kit child process (DAEMON-AUTOSTART-3-V1) ───────
# ruflo >=3.32 auto-spawns a detached background daemon on EVERY CLI invocation
# (services/daemon-autostart.js) — so any kit script that shells out to `ruflo`
# (proof P2/P8/P12, health's ruflo_timeout, init/session activation steps, …)
# would silently CREATE the daemons the kit polices. Pin the upstream-honored
# opt-out for all children of every lib/ script. An explicit operator value is
# respected; an explicit `ruflo daemon start` is unaffected (the daemon command
# itself is exempt from autostart, so this never blocks deliberate use).
[[ -z "${RUFLO_DAEMON_AUTOSTART:-}" ]] && export RUFLO_DAEMON_AUTOSTART=0

# ── Logging (single source of truth) ────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
pass()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail()   { echo -e "  ${RED}✗${NC} $1"; }
warn()   { echo -e "  ${YELLOW}!${NC} $1"; }
info()   { echo -e "  ${CYAN}→${NC} $1"; }
header() { echo -e "\n${CYAN}[$1]${NC} $2"; }
FIXES=0; FIX_LOG=()
fix() { FIXES=$((FIXES + 1)); FIX_LOG+=("$1"); }

# ── Flags + target resolution ───────────────────────────────────────────────
# Usage:  kit_resolve "$@"
# Sets: DRY_RUN / FORCE / REACTIVATE (0|1), KIT_WANT_HELP, and TARGET_DIR (abspath).
# The first non-flag argument is the target; flags may appear before or after it.
DRY_RUN=0; FORCE=0; REACTIVATE=0; KIT_WANT_HELP=0; TARGET_DIR=""
kit_resolve() {
  local a tgt=""
  for a in "$@"; do
    case "$a" in
      --dry-run)        DRY_RUN=1 ;;
      --force)          FORCE=1 ;;
      --reactivate)     REACTIVATE=1 ;;
      --json)           : ;;   # several verbs (status/health/verify-learning/proof/setup) parse --json themselves — not "unknown"
      -h|--help)        KIT_WANT_HELP=1 ;;
      --*)              warn "ignoring unknown flag: $a" ;;
      *)                [[ -z "$tgt" ]] && tgt="$a" ;;
    esac
  done
  [[ -z "$tgt" ]] && tgt="${RUFLO_KIT_TARGET:-$(pwd)}"
  # Absolute path — works even if the dir does not exist yet (init may create it).
  if [[ -d "$tgt" ]]; then
    TARGET_DIR="$(cd "$tgt" && pwd)"
  else
    case "$tgt" in
      /*) TARGET_DIR="$tgt" ;;
      *)  TARGET_DIR="$(pwd)/$tgt" ;;
    esac
  fi
  # AQE-ROOT-INHERIT-GUARD-V1: the caller's shell may carry AQE_PROJECT_ROOT
  # pinned to a DIFFERENT project (the kit repo's own settings.json exports it,
  # so running `ruflo-kit setup B` from a Claude session in project A inherits
  # A's pin). aqe honors the env var over findProjectRoot, so `aqe init` on the
  # target then refuses/redirects its own memory.db ("points to a production
  # .agentic-qe/ while AQE_PROJECT_ROOT=<other>") and the database phase dies —
  # observed on the first fresh-target e2e (learning HOLLOW, store absent).
  # Unconditional override: for kit verbs the target IS the project root.
  export AQE_PROJECT_ROOT="$TARGET_DIR"
}

# Require the target to already exist (most subcommands operate on a real codebase).
kit_require_target() {
  [[ -d "$TARGET_DIR" ]] || { fail "target codebase not found: $TARGET_DIR"; exit 1; }
}

# Print the resolved context (called by scripts after kit_resolve).
kit_banner() {
  echo "  kit:    $KIT_DIR"
  echo "  target: $TARGET_DIR"
  [[ "$DRY_RUN" -eq 1 ]] && echo "  MODE:   dry-run (no changes)"
}

# ── Helpers ─────────────────────────────────────────────────────────────────
# Dry-run-aware executor: run <command...>
run() { if [[ "${DRY_RUN:-0}" -eq 1 ]]; then info "[dry-run] $*"; else eval "$@"; fi; }
# Timestamped-once backup before mutating a file: backup <file> [suffix]
backup() { local f="$1" sfx="${2:-bak}"; [[ -f "$f" && ! -e "$f.$sfx" ]] && cp "$f" "$f.$sfx"; return 0; }

# Dotted numeric semver compare (3 components, no external deps beyond sort -V):
# aqe_semver_lt <a> <b> -> exit 0 iff a < b. Equal versions are NOT less-than.
aqe_semver_lt() {
  local a="$1" b="$2"
  [[ "$a" != "$b" ]] || return 1
  [[ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -1)" == "$a" ]]
}
# Installed aqe version (dotted string, whitespace-stripped; empty if aqe unavailable).
aqe_installed_version() { aqe --version 2>/dev/null | tr -d '[:space:]'; }

# ── Version pins (single source of truth — fix-ruflo, setup and proof read these)
# Three-slot AgentDB layout (Patch 52): standalone global + nested shadow stay on
# the pin; ruflo hoists the upstream floor. proof asserts all three + the
# controller surface, so a deliberate pin bump is a one-place edit here.
KIT_AGENTDB_PIN="3.0.0-alpha.10"          # standalone global MCP + nested shadow (memory layer)
# The HOISTED slot is upstream's to move (alpha.17 shipped with ruflo 3.32.2,
# alpha.18 with 3.32.7 a week later) — the kit asserts a FLOOR, never equality:
# hoisted >= MIN proves we're past the 8-controller removal watershed; the exact
# version is upstream's business. Pinning equality here would re-break proof on
# every routine upstream bump.
KIT_AGENTDB_HOISTED_MIN="3.0.0-alpha.17"
KIT_AGENTDB_CONTROLLERS=23              # controller classes the nested alpha.10 must expose

# ── Global npm installs (NPM-ALLOW-SCRIPTS-V1) ──────────────────────────────
# npm >=11.17 refuses package lifecycle (postinstall) scripts unless a curated
# allowlist is passed — without it the better-sqlite3 native build is silently
# skipped and the agentdb MCP dies with -32000. The flag is GLOBAL-install-only
# (project installs reject it with EALLOWSCRIPTS — Patch 54). Dual gate makes
# this self-retiring by construction: the version must be new enough to need it
# AND the installed npm must actually document the flag.
# onnxruntime-node/sharp are here for AQE-EMBEDDER-RESOLVE-V1: onnxruntime-node's
# postinstall FETCHES the native libonnxruntime dylib. Blocked, the package still
# RESOLVES and dies at first inference — a silent-embeddings failure identical to
# the one that step exists to fix, so the allowlist gap would have re-created it
# on any npm >=11.17 host.
KIT_NPM_ALLOW_LIST="better-sqlite3,sqlite3,onnxruntime-node,sharp"   # boot-path + embedder natives
npm_wants_allow_scripts() {
  local v; v="$(npm --version 2>/dev/null | tr -d '[:space:]')"
  [[ -n "$v" ]] || return 1
  aqe_semver_lt "$v" "11.17.0" && return 1
  npm install --help 2>&1 | grep -q -- 'allow-scripts' || return 1
  return 0
}

# kit_npm_global_install <pkg-spec>...  — the ONE way the kit installs globals.
# DRY_RUN-aware; log path overridable via KIT_NPM_LOG; retries WITHOUT the
# allow-scripts flag once if the flagged form fails (flag-syntax drift guard).
# Returns npm's rc; callers own their pass/fail messaging (those strings are
# load-bearing for sync's parse_changes and the nightly-drift CI greps).
kit_npm_global_install() {
  local log="${KIT_NPM_LOG:-/tmp/ruflo-kit-npm-global.log}" flags=()
  [[ "${DRY_RUN:-0}" -eq 1 ]] && { info "[dry-run] Would: npm install -g $*"; return 0; }
  npm_wants_allow_scripts && flags=(--allow-scripts="$KIT_NPM_ALLOW_LIST")
  npm install -g ${flags[@]+"${flags[@]}"} "$@" >"$log" 2>&1 && return 0
  [[ ${#flags[@]} -gt 0 ]] && npm install -g "$@" >>"$log" 2>&1 && return 0
  return 1
}

# ── SQLite access shims (seed of the sqlite shim — snapshot/adopt use these;
# a later task extends them). Primary: the sqlite3 CLI when `command -v sqlite3`
# hits. Fallback: node + better-sqlite3 resolved from the GLOBAL ruflo install
# ("$(npm root -g)/ruflo/node_modules/better-sqlite3") — the one native build
# the kit already guarantees (NPM-ALLOW-SCRIPTS-V1). Both are WAL-safe: reads
# open readonly; backup uses the sqlite online-backup API (never a raw cp of a
# live db). Return nonzero on any failure; callers own their messaging.
#
# kit_sqlite_ro "<db>" "<sql>" — read-only query; rows to stdout, '|'-separated
# columns (sqlite3 CLI default list mode; the node arm mirrors it).
kit_sqlite_ro() {
  local db="$1" sql="$2"
  [[ -f "$db" ]] || return 1
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 -readonly "$db" "$sql" 2>/dev/null
  else
    local bs; bs="$(npm root -g 2>/dev/null)/ruflo/node_modules/better-sqlite3"
    [[ -d "$bs" ]] || return 1
    node -e '
      const B = require(process.argv[1]);
      const db = new B(process.argv[2], { readonly: true, fileMustExist: true });
      const st = db.prepare(process.argv[3]);
      if (st.reader) {
        const out = [];
        for (const row of st.raw().iterate()) out.push(row.map((v) => (v === null ? "" : String(v))).join("|"));
        if (out.length) console.log(out.join("\n"));
      }
      db.close();
    ' "$bs" "$db" "$sql" 2>/dev/null
  fi
}

# kit_sqlite_backup "<db>" "<dest>" — WAL-safe online backup of <db> to <dest>
# (parent dirs created).
#
# Tri-state exit code (B17 fix — matches this file's existing 0/1/2
# convention, e.g. kit_sqlite_rw_check / kit_memory_roundtrip_check, rather
# than inventing a fourth style). This is the COMPLETE, real contract as of
# round 4 — every path through this function returns exactly one of these
# three values, never anything else, AND it never crashes its (sourcing)
# caller even when called with too few arguments under `set -u` (round 4;
# see the explicit clamps and the "${1:-}"/"${2:-}" guard below):
#   0 success         — the backup command itself reported success AND the
#                       copy is non-empty AND the copy opens and answers a
#                       trivial query (READBACK-CHECK-V1, below). `dest` is
#                       only ever replaced with this verified-good copy —
#                       see the atomic temp+rename note.
#   1 genuine failure — a backup was ATTEMPTED (input existed, an instrument
#                       was available) but the command itself failed, OR the
#                       copy ended up empty/missing, OR the copy is present
#                       but not a valid, openable sqlite file — "it looked
#                       like it worked and didn't." This is the dangerous
#                       case: a bad backup silently reporting the same code
#                       as a typo'd path is how a restore discovers there was
#                       nothing to restore. `dest` is left UNTOUCHED on this
#                       path (see below) — whatever was there before this
#                       call, valid or not, survives unchanged.
#   2 usage/precondition — the backup was NEVER attempted: either the input
#                       `db` (or `dest`) was never given at all (round 4 —
#                       see below), the input `db` doesn't exist (a bad-input/
#                       usage condition — the caller asked for a file that
#                       isn't there), or this host has no instrument at all to
#                       back up WITH (no sqlite3 CLI and no loadable global
#                       better-sqlite3). Previously both of these AND the
#                       rc=1 genuine-failure case above all returned the
#                       same bare `1`, so a caller could not distinguish
#                       "you asked for a file that isn't there" from "the
#                       backup silently produced nothing" — the second being
#                       the one that matters.
#
# B17 ROUND 2: the round-1 fix above only replaced the two precondition
# `return 1`s with `return 2` — it never touched the SUCCESS gate, which was
# `[[ -s "$dest" ]]` alone, never checking whether the backup COMMAND itself
# actually reported success. A critic reproduced live: point `db` at a file
# that isn't a valid sqlite database at all (`sqlite3 .backup` then fails
# with a printed error AND a non-zero exit) while `dest` already has stale
# non-empty content sitting there (e.g. a leftover from a previous run at a
# reused path) — the old code returned 0 ("success"), because it never looked
# at sqlite3's exit status, only at whether *some* non-empty file happened to
# exist afterward. The dangerous live sibling: sqlite3 dying mid-copy (I/O
# error, disk full, killed) leaves a partial/corrupt but still non-empty file
# at a genuinely FRESH destination — same false-positive shape, no stale
# leftover required. Fixed by checking the command's own exit status FIRST,
# THEN the non-empty check, THEN a cheap sanity read (`SELECT 1`, not a full
# `PRAGMA integrity_check` — a page-by-page scan is disproportionate cost for
# every routine backup call) confirming the copy is actually openable as a
# database, matching this file's existing "resolve -> open -> query"
# precedent (kit_bsqlite_native_status) rather than trusting a bare
# non-empty byte count.
#
# B17 ROUND 3 (adversarial critic, three more findings, all fixed here):
#  (a) The round-2 CLI-arm readback (`sqlite3 "$dest" "SELECT 1;"`) was the
#      function's LAST command with no `|| return 1` — bash returns a
#      function's last command's own exit status when nothing overrides it,
#      so a corrupt-but-openable db (sqlite3 reports SQLITE_CORRUPT = 11 on
#      that query) made this function return 11, silently violating its own
#      documented 0/1/2 contract for any caller that matches rc strictly (the
#      node arm never had this bug — its script explicitly `process.exit
#      (0)`/`process.exit(1)`, so arm parity was genuinely broken, not just
#      theoretical). Fixed: both arms' readback now sets an explicit
#      `check_rc` variable, clamped with `[[ "$check_rc" -eq 0 ]] || return 1`
#      — no raw command exit code can escape this function on ANY path.
#  (b) The round-2 readback had ZERO test coverage: the round-2 regression
#      fixture uses literal garbage text as the "corrupt source", which fails
#      at the cmd_rc gate and returns before the readback line is ever
#      reached — so round 2's actual new code path shipped untested (see
#      tests/kit-sqlite-backup-rc.test.js for the fake-`sqlite3`-shim fixture
#      that finally reaches it: reports success on `.backup` while writing a
#      deliberately corrupt destination, then fails the readback query).
#  (c) A failing backup could destroy a previously-valid, non-empty `dest`
#      before discovering the source/copy was bad (the round-2 fix wrote
#      directly to the final `dest` path and only checked afterward).
#      Unreachable via the sole caller today (lib/snapshot.sh always builds a
#      fresh timestamped `dest` and never reuses one), but this helper stands
#      between adopt/snapshot and a user's real learning database, so
#      "unreachable today" is exactly the kind of latent risk that becomes
#      live later. Fixed by writing to a `$dest.tmp.$$` sibling in the same
#      directory and promoting it onto `dest` ONLY after every check above
#      has passed — non-destruction of a pre-existing `dest` on any failure
#      path is now true BY CONSTRUCTION, not by accident of which failure
#      mode happened to be hit first. The temp file is removed on every
#      failure path, so nothing is left behind either. HOW that promotion
#      happens was itself wrong on the first attempt — see ROUND 4 (a).
#
# B17 ROUND 4 (adversarial critic, two more findings):
#  (a) Round 3(c)'s promotion step shelled out to `node -e fs.renameSync`
#      UNCONDITIONALLY on both arms, justified by a claim — "this function
#      already depends unconditionally on node" — that was simply wrong: the
#      CLI arm's readback uses `sqlite3`, not `node`, and this codebase's own
#      convention already treats bare `mv` as safe everywhere else with no
#      guard. Confirmed live: `PATH=/usr/bin:/bin` (sqlite3 present, node
#      absent), a genuinely valid source and a successful backup+readback,
#      still returned rc=1 with NO `dest` created — a worse outcome than the
#      round-3(c) destruction it was meant to prevent, and reachable on any
#      host with sqlite3 but no node. The test that motivated the swap
#      (tests/adopt-snapshot.test.js's minimal-PATH fixture) only ever
#      exercises the NODE arm (its PATH has no sqlite3 at all), so it was
#      structurally incapable of catching a new CLI-arm dependency — the
#      exact same "fixture never reaches the line it's meant to protect"
#      shape as round 3(b)'s readback-coverage gap, one layer up. Fixed:
#      prefer `mv` (this file's own established unconditional dependency),
#      falling back to node's `renameSync` only when `mv` itself is
#      genuinely unavailable — restores the CLI arm's node-independence
#      while keeping the minimal-PATH node-arm case working.
#  (b) Calling this function with fewer than 2 arguments crashed the CALLING
#      (sourcing) script under `set -u` with bash's own "unbound variable"
#      error, rather than returning cleanly — pre-existing, not introduced by
#      rounds 1-3, but the round-3 docstring asserted an absolute "never
#      anything else" 0/1/2 guarantee that this falsified. A helper this
#      load-bearing must not be able to take its caller down over a missing
#      argument. Fixed: `local db="${1:-}" dest="${2:-}"` plus an explicit
#      `[[ -n "$db" && -n "$dest" ]] || return 2` guard — missing/empty
#      arguments now join "input db doesn't exist" in the same rc=2
#      usage/precondition bucket, and the 0/1/2 claim is now actually true.
kit_sqlite_backup() {
  # "${1:-}"/"${2:-}", not "$1"/"$2": a caller under `set -u` invoking this
  # with zero or one argument must get a clean rc=2 (usage/precondition —
  # the same bucket "input db missing" already lives in), never crash the
  # CALLING script with bash's own "unbound variable" error. Confirmed live
  # pre-fix: `kit_sqlite_backup realsource.db` (dest omitted) under `set -u`
  # aborted the sourcing script entirely before this function could return
  # anything at all — a helper this load-bearing must not be able to take
  # its caller down over a missing argument.
  local db="${1:-}" dest="${2:-}"
  [[ -n "$db" && -n "$dest" ]] || return 2
  [[ -f "$db" ]] || return 2
  mkdir -p "$(dirname "$dest")" 2>/dev/null
  local tmp="${dest}.tmp.$$"
  rm -f "$tmp" 2>/dev/null
  local cmd_rc arm
  if command -v sqlite3 >/dev/null 2>&1; then
    arm=cli
    sqlite3 "$db" ".backup '$tmp'" 2>/dev/null
    cmd_rc=$?
  else
    local bs; bs="$(npm root -g 2>/dev/null)/ruflo/node_modules/better-sqlite3"
    [[ -d "$bs" ]] || return 2
    arm=node
    node -e '
      const B = require(process.argv[1]);
      const db = new B(process.argv[2], { readonly: true, fileMustExist: true });
      db.backup(process.argv[3]).then(() => { db.close(); process.exit(0); })
        .catch(() => { process.exit(1); });
    ' "$bs" "$db" "$tmp" 2>/dev/null
    cmd_rc=$?
  fi
  if [[ "$cmd_rc" -ne 0 ]]; then rm -f "$tmp" 2>/dev/null; return 1; fi
  if [[ ! -s "$tmp" ]]; then rm -f "$tmp" 2>/dev/null; return 1; fi
  # READBACK-CHECK-V1: confirm the fresh copy is an openable database before
  # ever promoting it onto `dest`. `check_rc` is explicitly set to exactly 0
  # or 1 on both arms — no raw sqlite3/node exit code (e.g. SQLITE_CORRUPT=11)
  # can escape this function on any path.
  local check_rc
  if [[ "$arm" == cli ]]; then
    sqlite3 "$tmp" "SELECT 1;" >/dev/null 2>&1
    check_rc=$?
  else
    local bs2; bs2="$(npm root -g 2>/dev/null)/ruflo/node_modules/better-sqlite3"
    node -e '
      try {
        const B = require(process.argv[1]);
        const db = new B(process.argv[2], { readonly: true, fileMustExist: true });
        db.prepare("SELECT 1").get();
        db.close();
        process.exit(0);
      } catch (e) { process.exit(1); }
    ' "$bs2" "$tmp" 2>/dev/null
    check_rc=$?
  fi
  if [[ "$check_rc" -ne 0 ]]; then rm -f "$tmp" 2>/dev/null; return 1; fi
  # Promote via `mv` FIRST (round 4 fix — round 3 had this backwards). `mv`
  # is this codebase's own established unconditional dependency: bare,
  # unguarded `mv` appears throughout this file and its callers with no
  # `command -v mv` check anywhere, and the CLI arm above (readback via
  # `sqlite3`, not `node`) never needed `node` at all before round 3 — the
  # earlier "node already unconditional" justification was wrong, confirmed
  # live: `PATH=/usr/bin:/bin` (sqlite3 present, node absent) made a
  # perfectly valid backup return failure and produce nothing, purely
  # because promotion couldn't run. Only fall back to node's
  # `fs.renameSync` when `mv` itself is genuinely unavailable — the shape
  # tests/adopt-snapshot.test.js's minimal-PATH fixture (node/npm/dirname/
  # mkdir, no sqlite3, no `mv`) actually is, which is why that regression
  # surfaced there and nowhere else: it never exercises the CLI arm at all.
  if command -v mv >/dev/null 2>&1; then
    if ! mv -f "$tmp" "$dest" 2>/dev/null; then rm -f "$tmp" 2>/dev/null; return 1; fi
  else
    if ! node -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$tmp" "$dest" 2>/dev/null; then
      rm -f "$tmp" 2>/dev/null; return 1
    fi
  fi
  return 0
}

# kit_sqlite_backend — which sqlite instrument this host has (KIT-SQLITE-SHIM-V1).
# Echoes exactly one of: cli | node | none. `node` means the global ruflo's
# better-sqlite3 actually require()s (a dir with a broken/ABI-stale native build
# reads as none, not node). Exit 0 for cli/node, 1 for none.
kit_sqlite_backend() {
  if command -v sqlite3 >/dev/null 2>&1; then echo cli; return 0; fi
  local bs; bs="$(npm root -g 2>/dev/null)/ruflo/node_modules/better-sqlite3"
  if [[ -d "$bs" ]] && node -e 'require(process.argv[1])' "$bs" >/dev/null 2>&1; then
    echo node; return 0
  fi
  echo none; return 1
}

# kit_sqlite_rw_check "<db>" — momentary write-lock test: BEGIN IMMEDIATE;
# ROLLBACK (zero mutation), 3s busy timeout on EITHER arm (KIT-SQLITE-SHIM-V1).
# rc 0 = lock acquired + released cleanly
# rc 1 = lock NOT acquirable within 3s (busy/locked/corrupt) or db missing
# rc 2 = no instrument on this host (no sqlite3 CLI, global better-sqlite3
#        absent or unloadable) — "not assessable", distinct from "locked"
kit_sqlite_rw_check() {
  local db="$1"
  [[ -f "$db" ]] || return 1
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 -cmd ".timeout 3000" "$db" "BEGIN IMMEDIATE; ROLLBACK;" >/dev/null 2>&1
    return $?
  fi
  local bs; bs="$(npm root -g 2>/dev/null)/ruflo/node_modules/better-sqlite3"
  [[ -d "$bs" ]] || return 2
  node -e '
    let B; try { B = require(process.argv[1]); } catch (e) { process.exit(2); }
    try {
      const db = new B(process.argv[2], { timeout: 3000, fileMustExist: true });
      db.exec("BEGIN IMMEDIATE; ROLLBACK;");
      db.close();
      process.exit(0);
    } catch (e) { process.exit(1); }
  ' "$bs" "$db" 2>/dev/null
}

# ── MCP stdio handshake probe (generalized from fix-brain Step 4) ────────────
# mcp_initialize_probe <timeout-s> <cmd> [args...] — spawn the server, send ONE
# JSON-RPC `initialize`, echo exactly one token: PROBE_OK | PROBE_NORESP |
# PROBE_ERR. Env passes through (export RUVNET_BRAIN_KB etc. before calling).
mcp_initialize_probe() {
  local secs="$1"; shift
  local probe; probe="$(mktemp)"
  cat > "$probe" <<'NODE'
'use strict';
// Spawn an MCP stdio server, send ONE `initialize`; a JSON-RPC reply with id 1
// proves the server answers. Timeout is soft (first run may warm a local model).
const { spawn } = require('node:child_process');
const secs = Number(process.argv[2]) || 6;
const child = spawn(process.argv[3], process.argv.slice(4), { stdio: ['pipe', 'pipe', 'ignore'] });
let out = '', done = false;
const finish = (tok) => { if (done) return; done = true; try { child.kill('SIGKILL'); } catch (_) {} console.log(tok); process.exit(0); };
const timer = setTimeout(() => finish('PROBE_NORESP'), secs * 1000);
child.stdout.on('data', (d) => {
  out += d.toString();
  for (const line of out.split('\n')) { if (!line.trim()) continue; try { const m = JSON.parse(line); if (m && m.id === 1 && (m.result || m.error)) { clearTimeout(timer); return finish(m.result ? 'PROBE_OK' : 'PROBE_NORESP'); } } catch (_) { /* partial line */ } }
});
child.on('error', () => { clearTimeout(timer); finish('PROBE_ERR'); });
child.on('exit', () => { clearTimeout(timer); finish('PROBE_NORESP'); });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ruflo-kit-probe', version: '1.0' } } }) + '\n');
NODE
  node "$probe" "$secs" "$@" 2>/dev/null || echo "PROBE_ERR"
  rm -f "$probe"
}

# ── Global better-sqlite3 load test (extracted from fix-ruflo Step 5b.0) ─────
# require() (not just resolve) from agentdb's own context, and assert the
# resolved path is UNDER the global root — a stray ~/node_modules copy or an
# ABI-stale build after a node upgrade must read as NOT-ok. Exit 0 iff loadable.
global_bsqlite_loads() {
  local groot; groot="$(npm root -g 2>/dev/null || echo '')"
  [[ -n "$groot" ]] || return 1
  node -e "const p=require.resolve('better-sqlite3',{paths:['$groot/agentdb','$groot']});if(!p.startsWith('$groot'))process.exit(3);require(p)" >/dev/null 2>&1
}

# ── better-sqlite3 native-resolution candidate roots (SQLITE-ROOTS-V1) ──────
# `ruflo memory` does not resolve its native sqlite binding from one place.
# Empirically traced (Wave-2 B3, 2026-07-31 — `require.resolve('better-sqlite3',
# {paths:[<dir>]})` from each real call-site's own directory, matching Node's
# actual nearest-wins resolution for the `require()`/dynamic `import()` calls
# in the installed dist):
#   - ControllerRegistry.initAgentDB() (@claude-flow/memory/dist/
#     controller-registry.js) — the PRIMARY `ruflo memory store/search/get`
#     path — does `await import('agentdb')` from its OWN directory, which
#     finds the NESTED alpha.10 shadow at
#     @claude-flow/memory/node_modules/agentdb first. That nested package has
#     no local better-sqlite3 of its own, so IT walks up to the sibling
#     ruflo/node_modules/better-sqlite3 — the same build kit_sqlite_backend
#     already checks. No gap found on this path.
#   - AgentDB's own core (agentdb/dist/src/core/AgentDB.js) does
#     `import('better-sqlite3')` from ITS OWN directory. When the HOISTED
#     agentdb floor (ruflo/node_modules/agentdb — the upstream floor Patch 52
#     keeps distinct from the nested shadow) is the one in play (agentdb's own
#     bundled CLI, or any consumer that reaches the hoisted class directly),
#     this resolves to agentdb's OWN nested better-sqlite3 copy — CONFIRMED on
#     this host to be a different version AND a different physical file
#     (11.10.0 vs the sibling ruflo/node_modules/better-sqlite3's 12.11.1,
#     distinct inodes). AgentDB's core tries native first and silently drops
#     to sql.js WASM on failure (a console.log line, no throw) — exactly the
#     blind spot none of the existing checks (kit_sqlite_backend,
#     global_bsqlite_loads) look at, since both hardcode a path that is never
#     the hoisted floor's own nested copy. This root is not hypothetical: the
#     independent gauntlet critic (round 1) traced a REAL exercised consumer of
#     exactly this resolution — @claude-flow/neural/dist/reasoning-bank.js
#     (behind the hooks_intelligence_* MCP tools / SONA training pipeline)
#     imports 'agentdb' with no local copy of its own, so it lands on this same
#     hoisted floor (currently usingWasm:false — healthy today, same as the
#     rest of this root, but a live call site, not just agentdb's bundled CLI).
#   - memory-bridge.js (@claude-flow/cli/dist/src/memory/memory-bridge.js)
#     does its own `createRequire(import.meta.url)('better-sqlite3')` (for
#     AttestationLog) from ITS OWN directory — resolves up to the same
#     ruflo/node_modules/better-sqlite3 sibling build. No gap found there.
#   - The standalone agentdb MCP server slot ($groot/agentdb) is already
#     covered by global_bsqlite_loads (paths=[groot/agentdb, groot]); included
#     here too so every real resolution root lives in ONE reusable list
#     instead of scattered bespoke path checks (agentic-kit #101 pattern).
#
# Deliberately EXCLUDED: ruflo/node_modules/agentic-flow/node_modules/agentdb
# (a fourth, undocumented agentdb copy, v1.6.1, ~10 importers under
# agentic-flow) — the critic verified its db-fallback.js never attempts a
# native require at all and logs "Using sql.js" unconditionally: WASM-only BY
# DESIGN, so it cannot exhibit the silent-native-then-WASM defect this helper
# targets. It is an inventory gap in the general "how many agentdb copies
# exist" sense, not a detection miss for THIS check — do not add it here, a
# future reader would start generating false "gap" reports against a build
# that was never meant to load native.
kit_bsqlite_candidate_roots() {
  local groot; groot="$(npm root -g 2>/dev/null || echo '')"
  [[ -n "$groot" ]] || return 1
  printf '%s\n' \
    "$groot/ruflo/node_modules" \
    "$groot/ruflo/node_modules/agentdb" \
    "$groot/ruflo/node_modules/@claude-flow/memory/node_modules/agentdb" \
    "$groot/ruflo/node_modules/@claude-flow/cli" \
    "$groot/agentdb" \
    "$groot"
}

# kit_bsqlite_native_status — per-root resolve+DEEP-load-test of better-sqlite3
# AS THAT ROOT'S OWN CONSUMER CODE WOULD SEE IT (nearest-wins from that dir,
# not from npm root). One line per candidate root on stdout:
#   "<root>|<ok|broken|missing>|<resolved-path-or-->"
#   ok      — resolves, require()s, opens a real `:memory:` database, and
#             answers `SELECT 1` correctly.
#   broken  — resolves to a real file but ANY of: require() throws (ABI-stale
#             build, corrupted install), the constructor/open throws, or the
#             query doesn't come back as expected. This is deliberately wider
#             than "require() throws": a binding that resolves and require()s
#             cleanly and STILL cannot actually open a database is the exact
#             silent-degradation state that makes a consumer fall back to
#             sql.js/WASM while looking "present" on disk (adopted from
#             agentic-kit's natives.mjs probeBsq3Runtime, vendor/agentic-kit/
#             src/lib/natives.mjs:132-150 — "running SELECT 1 in a child
#             process is the real WASM-vs-native answer — not a file-existence
#             guess"; a require()-only check, which is what this function did
#             before this deepening, cannot see that class at all).
#   missing — nothing named better-sqlite3 anywhere up that root's
#             node_modules chain (nothing to load — not necessarily an error,
#             e.g. a host with no npm root at all).
# Never throws; a missing/unreadable root just reads as "missing".
#
# Crash isolation: the deep probe (require -> new Database(':memory:') ->
# `SELECT 1 AS ok` -> close) runs inside its own `node -e` CHILD PROCESS per
# root — already true of every candidate here, since this function spawns a
# fresh `node` for each one. A native addon that segfaults on open only kills
# that one child; bash's `if node -e ...; then` reads a non-zero/signal exit
# status (e.g. 139 for SIGSEGV) like any other failure and moves on to the
# next root. It can never crash or hang kit_bsqlite_native_status itself —
# mirrors agentic-kit's own rationale for keeping its probe in a child process
# ("Kept in a child process so a broken addon can't crash ak").
#
# agentic-kit's bsq3Root (natives.mjs:20-26) also flags a distinct staleness
# risk: Node's process-wide require.resolve cache (Module._pathCache /
# _realpathCache) can go stale mid-process after an in-process `npm install`
# reshapes a tree, so agentic-kit deliberately re-walks the filesystem by hand
# instead of using createRequire().resolve(). Evaluated for this codebase and
# judged NOT APPLICABLE: this function (and every caller of it) already
# resolves via a brand-new `node -e` subprocess per root, once per invocation
# — there is no long-lived Node process here to accumulate a stale resolution
# cache in the first place, so there is nothing for that staleness class to
# attach to. Recorded here so a future reader doesn't reintroduce the same
# investigation.
kit_bsqlite_native_status() {
  local root
  while IFS= read -r root; do
    [[ -n "$root" ]] || continue
    if [[ ! -d "$root" ]]; then
      printf '%s|missing|-\n' "$root"
      continue
    fi
    local resolved
    resolved="$(node -e "try{process.stdout.write(require.resolve('better-sqlite3',{paths:[process.argv[1]]}))}catch(e){}" "$root" 2>/dev/null)"
    if [[ -z "$resolved" ]]; then
      printf '%s|missing|-\n' "$root"
      continue
    fi
    if node -e "
      const D = require(process.argv[1]);
      const db = new D(':memory:');
      const row = db.prepare('SELECT 1 AS ok').get();
      db.close();
      process.exit(row && row.ok === 1 ? 0 : 3);
    " "$resolved" >/dev/null 2>&1; then
      printf '%s|ok|%s\n' "$root" "$resolved"
    else
      printf '%s|broken|%s\n' "$root" "$resolved"
    fi
  done < <(kit_bsqlite_candidate_roots)
}

# kit_bsqlite_verdict — TRI-STATE rollup of kit_bsqlite_native_status. Echoes
# exactly one line "<verdict>|<checked>|<total>" and exits 0 for healthy/gap,
# 1 for not-assessable:
#   healthy        — >=1 candidate root had a better-sqlite3 to load-test AND
#                     none of them were broken.
#   gap            — >=1 candidate root resolved to better-sqlite3 but failed
#                     to require() (the silent-WASM-fallback-risk state).
#   not-assessable — ZERO candidate roots had anything to load-test (every
#                     root read "missing", or there was no npm root at all —
#                     e.g. `npm` itself is broken/absent). MUST NOT collapse
#                     into "healthy": round-2 critic repro proved a caller
#                     that only reads a flat gap boolean cannot tell "all 6
#                     roots verified" from "0 roots ever checked" —
#                     `bash -c 'source lib/common.sh; npm(){ return 1; };
#                     export -f npm; kit_bsqlite_gap; echo rc=$?'` read rc=1
#                     ("no gap") with nothing assessed. `checked` (ok+broken
#                     roots — the ones that actually had a build to test) and
#                     `total` (every candidate kit_bsqlite_candidate_roots
#                     produced, 0 if no groot) let a caller show that
#                     honestly instead of rendering it as clean.
kit_bsqlite_verdict() {
  local state ok=0 broken=0 total=0
  while IFS='|' read -r _root state _resolved; do
    total=$((total + 1))
    case "$state" in
      ok)     ok=$((ok + 1)) ;;
      broken) broken=$((broken + 1)) ;;
    esac
  done < <(kit_bsqlite_native_status 2>/dev/null)
  local checked=$((ok + broken))
  if [[ "$broken" -gt 0 ]]; then
    printf 'gap|%d|%d\n' "$checked" "$total"
    return 0
  elif [[ "$ok" -gt 0 ]]; then
    printf 'healthy|%d|%d\n' "$checked" "$total"
    return 0
  else
    printf 'not-assessable|%d|%d\n' "$checked" "$total"
    return 1
  fi
}

# kit_bsqlite_gap — legacy BOOLEAN surface (rc 0 = gap present, rc 1 = no
# gap). KNOWN LIMITATION (round 2, critic-confirmed): rc 1 does not
# distinguish "every root verified healthy" from "zero roots were ever
# assessable" — see kit_bsqlite_verdict above for the fix. Kept only for a
# caller pinned to this exact rc contract; status.sh (this kit's only
# in-tree caller) reads kit_bsqlite_verdict directly instead so it can render
# the honest tri-state.
kit_bsqlite_gap() {
  local verdict; verdict="$(kit_bsqlite_verdict 2>/dev/null)"
  [[ "${verdict%%|*}" == "gap" ]]
}

# kit_run_timeout <secs> <cmd> [args...] — portable hard timeout (no `timeout`
# binary on stock macOS). Mirrors the exact idiom health.sh's ruflo_timeout
# already uses ("Uses `perl` for portable timeout (no `timeout` on stock
# macOS)"); pulled here as a shared primitive so kit_memory_roundtrip_check
# below doesn't duplicate it. Exit code is the wrapped command's own exit
# code; a command killed by the alarm just reads as a normal non-zero/signal
# exit to the caller, never a hang.
kit_run_timeout() {
  local secs="$1"; shift
  perl -e 'alarm shift; exec @ARGV' "$secs" "$@"
}

# ── Memory round-trip probe (behavioral, MEMORY-ROUNDTRIP-V1, Wave-2 B13) ────
# agentic-kit's `ak x verify memory` (vendor/agentic-kit/src/commands/x/
# verify.mjs:63-115, verifyMemory) proved a drift class none of our 15 proof
# probes see: every existing memory/store check in this kit (kit_sqlite_
# rw_check, the AQE capture-arm wiring check, `stores-writable`) only ever
# asserts PRESENCE — a store file exists, accepts a momentary write lock,
# holds rows — never that a value written through the real CLI actually comes
# back out, or that a purge actually removes it. A backend that silently
# no-ops a write (or whose CLI serves a stale/cached answer on retrieve while
# the disk write itself failed) reads healthy to every existing probe. This
# is the same silent-degradation shape as kit_bsqlite_native_status's "requires
# fine but can't open a database" class above — just one layer up the stack.
#
# kit_memory_roundtrip_check runs store -> retrieve -> identify-the-writer ->
# purge entirely inside a throwaway `mktemp -d`, using a random
# namespace/key/value tuple, an explicit `--path` pin on every `ruflo memory`
# invocation, AND cwd=<tmp dir>. Both are required: `--path` alone does not
# contain every side effect — empirically, `ruflo memory init --path X` also
# writes .claude/, .claude-flow/, ruvector.db, schema.sql and *.graph files
# relative to CWD, not next to X. Running with cwd=<tmp> (matching agentic-
# kit's own `{ cwd: tmp }` protection) keeps ALL of that inside the disposable
# directory. This function NEVER touches the real .agentic-qe/, .swarm/, or
# agentdb.db — the tmp dir is the only DB `ruflo` is ever pointed at — and the
# tmp dir is unconditionally removed before this function returns, on every
# exit path (single cleanup point below, not a per-branch rm).
#
# "Identify the writer" step: the CLI's own `retrieve` could in principle be
# answered from something other than durable disk state (a cache, a stale
# read path) even when the underlying write silently failed — exactly the
# class this probe exists to catch. After a CLI-level retrieve looks correct,
# this independently opens the SAME pinned DB file with a SEPARATE reader
# (the sqlite3 CLI, or the global better-sqlite3 build via kit_sqlite_backend
# as a fallback) and queries `memory_entries` directly, so the proof of
# persistence does not depend on the same code path that claims success.
#
# Echoes exactly one line "<verdict>|<detail>" and returns:
#   0 healthy        — full round trip verified: CLI store, CLI retrieve,
#                       independent on-disk confirmation via a SEPARATE reader
#                       (mandatory — see the "no instrument" gap case below),
#                       CLI purge, and a post-purge CLI retrieve that
#                       correctly finds nothing.
#   1 gap            — `ruflo` IS present but the round trip did not hold at
#                       some step (a "genuine failure", not a missing
#                       instrument) — INCLUDING when `kit_sqlite_backend`
#                       returns anything other than `cli`/`node` (no sqlite3
#                       CLI, global better-sqlite3 unloadable): a CLI-only
#                       round trip (store, then retrieve, matches) is exactly
#                       what the side-channel-echo defect this probe exists
#                       to catch would also produce, so the absence of a
#                       second, independent reader is a genuine gap in what
#                       could be verified, not a pass by default — the same
#                       "absent instrument is not a pass" precedent
#                       kit_sqlite_rw_check (rc 2) and kit_bsqlite_verdict
#                       (not-assessable) already set in this file.
#   2 not-assessable — no memory layer to test at all (`ruflo` not on PATH, or
#                       the host cannot even provide a `mktemp -d`). MUST NOT
#                       collapse into "healthy" — mirrors the exact tri-state
#                       lesson kit_bsqlite_verdict already learned above (a
#                       caller reading only a flat boolean cannot tell
#                       "verified clean" from "nothing was ever assessed").
#
# Exit-code discipline note (agentic-kit's `ak x verify` CLI entry point,
# verify.mjs:218, separates a USAGE error — unknown suite name — from a
# GENUINE proof failure by returning 2 vs 1): this helper takes no arguments,
# so it has no user-supplied-argument surface to misuse and therefore no
# direct "usage error" of its own. The more relevant split for a no-argument
# shell helper is the one this codebase already uses for kit_sqlite_rw_check
# (rc 2 = no instrument to test with at all, rc 1 = a real failure, rc 0 =
# pass) — that is the discipline adopted here. Checked for the conflation
# agentic-kit's own memory suite still has: verifyMemory's only "absent
# instrument" path (`ruflo` CLI not installed) calls the SAME `fail()` used
# for every genuine mid-proof failure and returns `false` either way — their
# `ak x verify` overall exit code cannot distinguish "no ruflo to test" from
# "ruflo is broken", the identical conflation kit_bsqlite_gap's round-1
# boolean had before kit_bsqlite_verdict fixed it. This helper's rc=2 avoids
# reintroducing that. (Also flagged elsewhere in this file at the time: a
# real instance of the same conflation in kit_sqlite_backup — rc=1 shared
# between "no such input file" and "backup ran but produced an empty file" —
# fixed in B17, same rc convention as here: 0/1/2 = success/genuine
# failure/usage-precondition.)
kit_memory_roundtrip_check() {
  if ! command -v ruflo >/dev/null 2>&1; then
    printf 'not-assessable|ruflo not on PATH\n'
    return 2
  fi

  local tmp; tmp="$(mktemp -d 2>/dev/null)"
  if [[ -z "$tmp" || ! -d "$tmp" ]]; then
    printf 'not-assessable|mktemp -d failed\n'
    return 2
  fi

  local ns="kit-roundtrip-$$-$RANDOM"
  local key="roundtrip"
  local val; val="probe-$$-$RANDOM-$(date +%s 2>/dev/null || echo 0)"
  local db="$tmp/probe.db"
  local secs=30
  local verdict detail rc

  # Single-exit-point control flow (a one-pass `while` used only for early
  # `break`, bash's usual stand-in for try/finally): every path below sets
  # verdict/detail/rc and breaks, so the tmp dir is always cleaned up exactly
  # once, right after the loop, regardless of which step failed.
  while true; do
    if ! ( cd "$tmp" && RUFLO_DAEMON_AUTOSTART=0 kit_run_timeout "$secs" \
        ruflo memory init --path "$db" --force --backend sqlite ) >/dev/null 2>&1; then
      verdict=gap; detail="ruflo memory init failed"; rc=1; break
    fi
    if [[ ! -f "$db" ]]; then
      verdict=gap; detail="ruflo memory init produced no db file at the pinned --path"; rc=1; break
    fi

    if ! ( cd "$tmp" && RUFLO_DAEMON_AUTOSTART=0 kit_run_timeout "$secs" \
        ruflo memory store -k "$key" -n "$ns" --value "$val" --path "$db" ) >/dev/null 2>&1; then
      verdict=gap; detail="ruflo memory store failed"; rc=1; break
    fi

    local got
    got="$( ( cd "$tmp" && RUFLO_DAEMON_AUTOSTART=0 kit_run_timeout "$secs" \
        ruflo memory retrieve -k "$key" -n "$ns" --value-only --path "$db" ) 2>/dev/null )"
    if [[ "$got" != *"$val"* ]]; then
      verdict=gap; detail="CLI retrieve did not return the exact stored value (accepted write, silent read failure)"; rc=1; break
    fi

    # Identify the writer: an independent reader, not the CLI that just
    # claimed success. This step is MANDATORY, not best-effort (fixed —
    # B19/round-2): a CLI-only round trip (store, then retrieve, matches) is
    # exactly what a store that echoes a cached value back on retrieve, while
    # never actually writing to disk, would also produce — the precise
    # side-channel-echo defect this whole probe exists to catch. Skipping
    # this step on an instrument-less host would silently degrade the probe
    # back to that same CLI-only check it was built to move past, so the
    # `else` branch below treats "neither instrument available" as a genuine
    # gap, never a pass — the same "absent instrument is not a pass"
    # precedent kit_sqlite_rw_check (rc 2) and kit_bsqlite_verdict
    # (not-assessable) already set in this file.
    local backend; backend="$(kit_sqlite_backend 2>/dev/null)"
    if [[ "$backend" == "cli" ]]; then
      local row
      row="$(sqlite3 "$db" "SELECT content FROM memory_entries WHERE namespace='${ns}' AND key='${key}' LIMIT 1;" 2>/dev/null)"
      if [[ "$row" != "$val" ]]; then
        verdict=gap; detail="independent sqlite3 read of memory_entries did not show the stored value on disk"; rc=1; break
      fi
    elif [[ "$backend" == "node" ]]; then
      local bs; bs="$(npm root -g 2>/dev/null)/ruflo/node_modules/better-sqlite3"
      local row
      row="$(node -e '
        try {
          const B = require(process.argv[1]);
          const db = new B(process.argv[2], { readonly: true, fileMustExist: true });
          const r = db.prepare("SELECT content FROM memory_entries WHERE namespace = ? AND key = ? LIMIT 1").get(process.argv[3], process.argv[4]);
          db.close();
          process.stdout.write(r && r.content != null ? r.content : "");
        } catch (e) { /* leave stdout empty -> treated as a miss below */ }
      ' "$bs" "$db" "$ns" "$key" 2>/dev/null)"
      if [[ "$row" != "$val" ]]; then
        verdict=gap; detail="independent better-sqlite3 read of memory_entries did not show the stored value on disk"; rc=1; break
      fi
    else
      # Neither a sqlite3 CLI nor a loadable global better-sqlite3: there is
      # no second reader to identify the writer with. The detail says so
      # explicitly — "no independent verification performed" — so this can
      # never be misread as a completed, honest confirmation the way
      # "on-disk confirm (none)" previously could.
      verdict=gap; detail="no independent verification performed: neither the sqlite3 CLI nor a loadable global better-sqlite3 is available to confirm the write on disk (CLI-only claims are not sufficient proof)"; rc=1; break
    fi

    if ! ( cd "$tmp" && RUFLO_DAEMON_AUTOSTART=0 kit_run_timeout "$secs" \
        ruflo memory purge --namespace "$ns" --force --path "$db" ) >/dev/null 2>&1; then
      verdict=gap; detail="ruflo memory purge failed"; rc=1; break
    fi

    local after
    after="$( ( cd "$tmp" && RUFLO_DAEMON_AUTOSTART=0 kit_run_timeout "$secs" \
        ruflo memory retrieve -k "$key" -n "$ns" --value-only --path "$db" ) 2>/dev/null )"
    if [[ "$after" == *"$val"* ]]; then
      verdict=gap; detail="purge reported success but the proof namespace is still retrievable"; rc=1; break
    fi

    verdict=healthy; detail="store -> CLI retrieve -> on-disk confirm ($backend) -> purge all verified"; rc=0
    break
  done

  rm -rf "$tmp" 2>/dev/null
  printf '%s|%s\n' "$verdict" "$detail"
  return "$rc"
}

# ── AQE capture-arm wiring check (INFLOW-LIVENESS-V1, Patch 67) ──────────────
# The AQE experience pool (.agentic-qe/memory.db captured_experiences) only
# grows while a capture hook is WIRED in the target's .claude/settings.json.
# A `--force` re-init that clobbers settings kills the arm silently: every
# existing symptom then reads healthy ("pool fully harvested", adaptations
# growing) while the pool is actually FROZEN (observed on an adopted target: hooks died
# 2026-07-19 17:42, found only through a manual forensic diff). This helper is
# the shared structural check for verify-learning #12, status, and adopt.
# Matches BOTH generations of the stock shape: the aqe ≥3.13 bridge
# (`aqe-hook.cjs" post-edit ...`) and the legacy direct CLI
# (`aqe|agentic-qe hooks post-edit ...`), any of post-edit/post-task/post-command.
# Exit 0 = wired, 1 = not wired (or no settings.json).
kit_aqe_capture_wired() {
  local tdir="${1:-$TARGET_DIR}" settings
  settings="$tdir/.claude/settings.json"
  [[ -f "$settings" ]] || return 1
  # NB: in the JSON file the quote after aqe-hook.cjs is escaped (\") — match it optionally.
  grep -qE 'aqe-hook\.cjs\\?" +(post-edit|post-task|post-command)|(aqe|agentic-qe) +hooks +post-(edit|task|command)' "$settings"
}

# ── Daemon staleness audit (DAEMON-STALE-DIST-V1 — detection-only) ───────────
# A running daemon keeps the dist it loaded at SPAWN time: the kit dist patches
# fix-ruflo applies (SONA-TRAIN-V1 / RUFLO-LORA-ADAPT-V1) are INERT inside any
# daemon that started before the patch landed — every on-disk grep (status
# sentinels, proof, verify-learning #11) reads green while the resident process
# still runs pre-patch code. These helpers DETECT that; they NEVER kill anything
# (a deliberate operator daemon is allowed — Patch 50 semantics). Parse +
# classification live in tools/daemon-staleness.cjs (pure, unit-testable);
# discovery is this small function, overridable in tests.
#
# kit_daemon_ps_lines — one "<pid> <etimes|etime> <args...>" line per running
# daemon. Discovery mirrors BOTH existing sites: status.sh's 'ruflo daemon' and
# proof P14's argv-anchored 'bin/cli.js daemon start'; pids merged + deduped.
#
# macOS/BSD `ps` does NOT fail-empty on an unrecognized -o keyword (F1): `ps -o
# etimes=` prints "ps: etimes: keyword not found" to stderr (suppressed below)
# but STILL emits the line with the remaining columns — "<pid> <args...>",
# missing the time token entirely — and exits rc=1. The old emptiness-only
# gate (`[[ -z "$line" ]]`) never caught this: `line` was non-empty but
# malformed, so the etime fallback was dead code on macOS and every row
# downstream failed to parse an elapsed time and was silently dropped
# (tools/daemon-staleness.cjs). Gate on `ps`'s own exit status instead —
# GNU ps (Linux) supports etimes natively and exits 0; BSD ps (macOS) always
# exits non-zero for it, so this correctly selects etime there every time.
kit_daemon_ps_lines() {
  local pids p line rc
  pids="$( { pgrep -f 'bin/cli.js daemon start' 2>/dev/null; pgrep -f 'ruflo daemon' 2>/dev/null; } | sort -un)"
  [[ -n "$pids" ]] || return 0
  for p in $pids; do
    # $? after a bare command substitution (no trailing pipe inside it)
    # reflects ps's own exit status, not a downstream sed/pipeline stage.
    line="$(ps -o pid= -o etimes= -o args= -p "$p" 2>/dev/null)"
    rc=$?
    if [[ $rc -ne 0 || -z "$line" ]]; then
      # BSD ps only has etime ([[dd-]hh:]mm:ss) — the cjs classifier parses
      # both token shapes.
      line="$(ps -o pid= -o etime= -o args= -p "$p" 2>/dev/null)"
    fi
    line="$(printf '%s' "$line" | sed 's/^[[:space:]]*//')"
    [[ -n "$line" ]] && printf '%s\n' "$line"
  done
  return 0
}

# kit_daemon_scope_split <target_dir> — TRI-STATE classification of every
# daemon line from kit_daemon_ps_lines against <target_dir> (B24-DAEMON-
# SCOPE-V1). Fixes a real regression: probe_daemon_advisory used to consume
# kit_daemon_ps_lines directly and asserted a target-specific causal claim
# ("it locks the DBs") for ANY ruflo daemon found ANYWHERE on the host —
# kit_daemon_ps_lines is deliberately UNSCOPED (it "mirrors BOTH existing
# sites", status.sh/proof.sh, which want the global view), so on any dev
# machine running two or more kit-managed projects at once that claim was
# false for every daemon that belonged to a DIFFERENT project. This helper
# restores workspace scoping, reusing tools/daemon-staleness.cjs's pure
# parseWorkspace (handles both '--workspace <p>' and '--workspace=<p>' argv
# forms) instead of hand-rolling awk/sed.
#
# Buckets:
#   MINE    — the daemon's --workspace argv identifies the SAME directory as
#             <target_dir>, compared by FILESYSTEM IDENTITY — (dev, ino) from
#             fs.statSync — never by comparing path strings, even realpath'd
#             ones (DAEMON-HINT-SCOPE-V1 round 2, mirrors lib/fix-aqe.sh's
#             INTEL-ROOTWALK-V1 v5, the same identity-not-strings fix already
#             established for the resolveProjectRoot walk-up boundary). A
#             realpath'd STRING compare was tried first and was wrong: on a
#             case-insensitive-but-preserving filesystem (macOS APFS),
#             realpathSync PRESERVES input case, so a daemon's --workspace
#             differing from the target only in case string-mismatched and
#             classified OTHER — telling an operator a daemon that ACTUALLY
#             locks their DBs does not, which is worse than the original bug
#             (that one told them to stop a daemon they couldn't reach; this
#             one tells them to ignore one that's locking their database).
#             Comparing identity instead closes case-aliasing, symlink-
#             aliasing, trailing separators, and '..' segments in one move.
#             If EITHER side cannot be stat'd (the daemon already exited
#             between discovery and classification, or --workspace points
#             somewhere no longer on disk), identity is genuinely
#             undeterminable — classify UNKNOWN, never guess MINE or OTHER
#             from a string fallback. A daemon whose workspace is a PARENT or
#             SUBDIRECTORY of the target is still classified OTHER, not MINE,
#             by design: `ruflo daemon status --workspace <dir>` (the call
#             this helper's caller replaces) is itself exact-match scoped per
#             its own --help, and each daemon process locks the DBs of the
#             ONE workspace directory it was started with — a parent-
#             workspace daemon does not necessarily even touch a specific
#             subdirectory's DBs, and a subdirectory-workspace daemon cannot
#             lock files that live only in the parent. Treating an
#             ancestor/descendant match as "mine" would just resurrect the
#             false-positive class this fix closes, with a narrower but
#             still-wrong blast radius instead of an unscoped one.
#   OTHER   — --workspace argv present, parsed, stat'd, and identity-confirmed
#             NOT the target. Informational only — must NEVER fire the "it
#             locks the DBs" causal claim.
#   UNKNOWN — no --workspace token in argv at all (parseWorkspace's own '?'
#             sentinel — e.g. a daemon started without --workspace, or an
#             ancient/foreign argv shape), OR a --workspace token that IS
#             present but whose identity could not be established (stat
#             failure on either side). Scope is genuinely undeterminable;
#             hedge, never silently fold into MINE or OTHER.
#
# stdout: one tab-separated line per daemon: "<pid>\t<MINE|OTHER|UNKNOWN>\t<ws-or-?>"
# rc: 0 always (detection-only, matches kit_daemon_ps_lines's own contract).
kit_daemon_scope_split() {
  local target="$1" lines cjs
  lines="$(kit_daemon_ps_lines 2>/dev/null)"
  [[ -n "$lines" ]] || return 0
  cjs="$KIT_TOOLS/daemon-staleness.cjs"
  if [[ ! -f "$cjs" ]] || ! command -v node >/dev/null 2>&1; then
    # Can't parse --workspace argv without the shared parser or a JS runtime —
    # every row is genuinely UNKNOWN, never guessed via ad-hoc bash parsing.
    awk '{print $1"\tUNKNOWN\t?"}' <<< "$lines"
    return 0
  fi
  KIT_SCOPE_TARGET="$target" node -e '
    const { parseWorkspace } = require(process.argv[1]);
    const fs = require("fs");
    const target = process.env.KIT_SCOPE_TARGET;
    // Identity, not strings (see the MINE bucket doc above for why). A stat
    // failure on either side is NOT a string fallback in disguise — it is
    // mapped straight to UNKNOWN by sameDir returning null.
    const statSafe = (p) => { try { return fs.statSync(p); } catch (e) { return null; } };
    const targetSt = statSafe(target);
    const sameDir = (p) => {
      const st = statSafe(p);
      if (!st || !targetSt) return null; // undeterminable
      return st.dev === targetSt.dev && st.ino === targetSt.ino;
    };
    let input = "";
    process.stdin.on("data", (d) => { input += d; });
    process.stdin.on("end", () => {
      for (const raw of input.split("\n")) {
        const t = raw.trim();
        if (!t) continue;
        const m = t.match(/^(\d+)\s+(\S+)\s+(.*)$/);
        if (!m) continue;
        const ws = parseWorkspace(m[3].split(/\s+/));
        let state;
        if (ws === "?") {
          state = "UNKNOWN";
        } else {
          const same = sameDir(ws);
          state = same === null ? "UNKNOWN" : (same ? "MINE" : "OTHER");
        }
        process.stdout.write(m[1] + "\t" + state + "\t" + ws + "\n");
      }
    });
  ' -- "$cjs" <<< "$lines"
}

# kit_daemon_dist_newest_mtime — newest mtime (epoch) among the kit-patched
# dist files fix-ruflo owns (the SAME files verify-learning probe #11 greps:
# memory/intelligence.js + mcp-tools/hooks-tools.js). Root resolves via
# KIT_RUFLO_DIST_SRC (test override) else `npm root -g`. rc 1 when neither
# file is found (offline / no global install).
kit_daemon_dist_newest_mtime() {
  local root g f m best=""
  if [[ -n "${KIT_RUFLO_DIST_SRC:-}" ]]; then
    root="$KIT_RUFLO_DIST_SRC"
  else
    g="$(npm root -g 2>/dev/null || echo '')"
    [[ -n "$g" ]] || return 1
    root="$g/ruflo/node_modules/@claude-flow/cli/dist/src"
  fi
  for f in "$root/memory/intelligence.js" "$root/mcp-tools/hooks-tools.js"; do
    [[ -f "$f" ]] || continue
    # GNU stat (-c) first, BSD stat (-f) fallback — no readlink -f / coreutils dep.
    m="$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null)"
    [[ "$m" =~ ^[0-9]+$ ]] || continue
    if [[ -z "$best" || "$m" -gt "$best" ]]; then best="$m"; fi
  done
  [[ -n "$best" ]] || return 1
  echo "$best"
}

# kit_daemon_staleness — the audit: one line per running daemon (pid, workspace,
# started-at, STALE|FRESH, suspicion tags) plus one consequence+remedy WARNING
# line when >=1 daemon is STALE. Prints NOTHING when no daemon runs. No dist
# mtime resolvable => everything classifies FRESH (never claim staleness we
# cannot prove). Detection-only: exit 0 always, kills nothing.
kit_daemon_staleness() {
  local cjs="$KIT_TOOLS/daemon-staleness.cjs" lines newest
  [[ -f "$cjs" ]] || return 0
  lines="$(kit_daemon_ps_lines)"
  [[ -n "$lines" ]] || return 0
  newest="$(kit_daemon_dist_newest_mtime 2>/dev/null || echo '')"
  local dsargs=(--home "$HOME")
  [[ -n "$newest" ]] && dsargs=(--newest-mtime "$newest" "${dsargs[@]}")
  printf '%s\n' "$lines" | node "$cjs" "${dsargs[@]}" 2>/dev/null
  return 0
}

# ── Tabular-output number parsers (HEALTH-COMMA-V1) ──────────────────────────
# ruflo >=3.32 prints thousands separators in `memory stats` / intelligence
# tables (`| Total Entries |  1,921 |`): the old digit-grep returned the `1`
# before the comma. Strip commas AFTER the label match (labels never contain
# commas; the number cells do). Unconditional — kit-owned parsing, correct for
# both old (no-comma) and new output, so no defect gate.
extract_number_after() {
  local label="$1" text="$2"
  echo "$text" | grep -m1 -E "$label" | tr -d ',' | grep -oE '[0-9]+(\.[0-9]+)?' | head -1 || echo 0
}
extract_percent() {
  local label="$1" text="$2"
  echo "$text" | grep -m1 -E "$label" | tr -d ',' | grep -oE '[0-9]+(\.[0-9]+)?%' | head -1 | tr -d '%' || echo 0
}
# Count inside "(N entries)" cells — `active (1,008 entries)` must read 1008.
extract_paren_count() {
  local label="$1" text="$2"
  echo "$text" | grep -m1 -E "$label" | tr -d ',' | grep -oE '\([0-9]+ entries\)' | grep -oE '[0-9]+' | head -1 || echo 0
}

# ── Dist-defect gate (agentic-kit adoption: patch only what's confirmed broken) ─
# Version gates (aqe_semver_lt) answer "is the installed release old enough to
# still carry bug X?" — but a release NUMBER is only a proxy for the bug. The
# stronger pattern, ported from agentic-kit's upstreamCveCounterFabricated()
# (statusline.mjs): grep the INSTALLED dist for the LITERAL defect and patch only
# when the bug is actually present in the code we're about to modify. Fail-safe —
# an unreadable/absent/changed target reads as NOT-broken, so the kit never patches
# what it cannot confirm is broken (worst case: upstream's own unmodified
# behavior), and the stopgap self-retires the moment upstream ships the fix, with
# no release-number tracking required. Pairs WITH the version gate, not instead of
# it (cheap version pre-check, then confirm the literal bug before mutating).
#
#   dist_defect_present <file> <grep -E pattern>
# Echoes exactly one token (no exit — caller decides severity):
#   PRESENT | ABSENT | NO_FILE
# Read-only. Pure bash + grep, no eval.
dist_defect_present() {
  local file="$1" pattern="$2"
  [[ -f "$file" ]] || { echo "NO_FILE"; return; }
  if grep -Eq -- "$pattern" "$file" 2>/dev/null; then echo "PRESENT"; else echo "ABSENT"; fi
}

# defect_gate <file> <grep -E pattern> [label] -> exit 0 iff the defect is
# CONFIRMED present in dist (caller should patch), 1 otherwise. Logs the decision
# with the self-retirement rationale so `defect_gate f p && apply_patch` naturally
# no-ops the day upstream fixes the bug. Makes no changes itself, so it is
# DRY_RUN-safe by construction (the read-only probe runs identically in dry-run).
defect_gate() {
  local file="$1" pattern="$2"
  local label="${3:-$file}"   # separate line: $file must be assigned before it's referenced
  case "$(dist_defect_present "$file" "$pattern")" in
    PRESENT) info "defect confirmed in dist — patching: $label"; return 0 ;;
    *)       info "defect not found — skipping (self-retired): $label"; return 1 ;;
  esac
}

# RuVector native-binary platform tag, matching @ruvector's NAPI naming.
# Use node's view (process.platform/arch), NOT `uname -m`: under Rosetta on
# Apple Silicon `uname -m` says x86_64 while node says arm64, and `uname` can't
# tell us the libc. @ruvector names binaries `<rvf-node|sona|attention>.<tag>.node`:
#   darwin → darwin-arm64 / darwin-x64        (NO libc suffix)
#   linux  → linux-arm64-gnu / linux-x64-gnu  (libc suffix; -musl on Alpine)
# The old darwin-only mapping (`arm64`→`darwin-arm64`) produced false "native not
# found" warnings on linux-arm64 hosts (e.g. DGX Spark) even with the binary present.
ruvector_platform_tag() {
  local p a libc=gnu
  p="$(node -e 'process.stdout.write(process.platform)' 2>/dev/null || echo "$(uname -s | tr 'A-Z' 'a-z')")"
  a="$(node -e 'process.stdout.write(process.arch)' 2>/dev/null || uname -m)"
  case "$a" in arm64|aarch64) a=arm64 ;; x64|x86_64|amd64) a=x64 ;; esac
  case "$p" in
    darwin) echo "darwin-$a" ;;                                   # no libc suffix on macOS
    linux)  [[ "$(ldd --version 2>&1 | head -1)" == *musl* ]] && libc=musl; echo "linux-$a-$libc" ;;
    win32)  echo "win32-$a-msvc" ;;
    *)      echo "$p-$a" ;;
  esac
}

# Search roots where @ruvector .node binaries live: the npx cache AND the GLOBAL
# ruflo install's nested node_modules (where a `npm i -g ruflo` lands them). The
# old probes searched only ~/.npm/_npx and missed the global-nested path.
ruvector_search_roots() {
  local groot; groot="$(npm root -g 2>/dev/null)"
  printf '%s\n' "$HOME/.npm/_npx" "$HOME/node_modules/@ruvector" \
    ${groot:+"$groot/ruflo/node_modules" "$groot/@ruvector"}
}

# ── Vector dimension guard (issue #4 gap #6 — defensive assertion) ───────────
# Issue #4 claimed AQE `vectors` were 1536-dim vs a 384-dim system. Ground-truth
# disproved it: `dimensions=384`, blob `length(embedding)=1536 bytes = 384 × 4`
# float32. So this is NOT a fix — it's a guard that asserts the invariant the
# whole stack relies on: the declared dimension equals the embedder dimension AND
# the BLOB byte-length equals dimensions × 4. A real future regression (a 1536-dim
# embedder swapped under a 384-dim index, or a truncated blob) trips it loudly.
#
#   assert_vector_dim_ok <db> <table> <embedding_col> <dim_col> <expected_dim>
# Echoes exactly one token (no exit — caller decides severity):
#   OK | EMPTY | NO_TABLE | DIM_MISMATCH:<first-offending-dim> | BLOB_MISMATCH:<rows>
# Pure read-only (kit_sqlite_ro: sqlite3 -readonly when the CLI exists, else the
# node better-sqlite3 arm — KIT-SQLITE-SHIM-V1). Self-contained (inlines the
# table check) so it works from common.sh without depending on health.sh's
# table_exists.
assert_vector_dim_ok() {
  local db="$1" tbl="$2" col="$3" dimc="$4" exp="$5"
  [[ -f "$db" ]] || { echo "NO_TABLE"; return; }
  kit_sqlite_ro "$db" \
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='$tbl' LIMIT 1;" \
    2>/dev/null | grep -q 1 || { echo "NO_TABLE"; return; }
  local n; n="$(kit_sqlite_ro "$db" "SELECT COUNT(*) FROM $tbl;" 2>/dev/null || echo 0)"
  [[ "${n:-0}" -eq 0 ]] && { echo "EMPTY"; return; }
  local baddim
  baddim="$(kit_sqlite_ro "$db" "SELECT $dimc FROM $tbl WHERE $dimc<>$exp LIMIT 1;" 2>/dev/null)"
  [[ -n "$baddim" ]] && { echo "DIM_MISMATCH:$baddim"; return; }
  local badblob
  badblob="$(kit_sqlite_ro "$db" "SELECT COUNT(*) FROM $tbl WHERE length($col)<>$dimc*4;" 2>/dev/null || echo 0)"
  [[ "${badblob:-0}" -ne 0 ]] && { echo "BLOB_MISMATCH:$badblob"; return; }
  echo "OK"
}

# ── .claude/helpers module-type pin (fix the "require is not defined" hook crash)
# When a project's root package.json declares "type":"module", Node treats the
# kit/CLI-generated CommonJS helpers (router.js, memory.js, session.js,
# statusline.js — required by hook-handler.cjs) as ES modules, so their
# `require.main === module` / `module.exports` throw "require is not defined" on
# every PreCompact / SessionEnd hook. Pin the helper dir to CommonJS with a local
# package.json, and relocate the ONE genuinely-ESM helper (github-safe.js, which
# uses import/export) to github-safe.mjs so it stays an ES module under the pin.
#
# The github-safe.mjs relocation is UNCONDITIONAL: an ESM-syntax github-safe.js
# is broken under a commonjs/absent root too ("Cannot use import statement
# outside a module" on every invocation), not just under the pin. The
# package.json pin itself stays surgical: only "type":"module" projects need it
# (a commonjs/absent root already loads the .js helpers as CJS).
# Idempotent; honors DRY_RUN. Echoes one status token:
#   NO_DIR | NOT_ESM_PROJECT | MJS_ONLY | DRYRUN | PINNED | ALREADY
pin_helpers_module_type() {
  local target="$1" hdir="$1/.claude/helpers"
  [[ -d "$hdir" ]] || { echo "NO_DIR"; return; }
  local is_esm=0 need_pkg=0 need_mjs=0
  grep -qE '"type"[[:space:]]*:[[:space:]]*"module"' "$target/package.json" 2>/dev/null && is_esm=1
  [[ -f "$hdir/github-safe.js" ]] && grep -qE '^[[:space:]]*(import |export )' "$hdir/github-safe.js" 2>/dev/null && need_mjs=1
  if [[ "$is_esm" -eq 1 ]]; then
    [[ -f "$hdir/package.json" ]] && grep -q '"type"[[:space:]]*:[[:space:]]*"commonjs"' "$hdir/package.json" 2>/dev/null || need_pkg=1
  fi
  if [[ "$is_esm" -eq 0 && "$need_mjs" -eq 0 ]]; then echo "NOT_ESM_PROJECT"; return; fi
  if [[ "$need_pkg" -eq 0 && "$need_mjs" -eq 0 ]]; then echo "ALREADY"; return; fi
  if [[ "${DRY_RUN:-0}" -eq 1 ]]; then echo "DRYRUN"; return; fi
  [[ "$need_pkg" -eq 1 ]] && printf '{\n  "type": "commonjs"\n}\n' > "$hdir/package.json"
  [[ "$need_mjs" -eq 1 ]] && mv -f "$hdir/github-safe.js" "$hdir/github-safe.mjs"
  if [[ "$is_esm" -eq 1 ]]; then echo "PINNED"; else echo "MJS_ONLY"; fi
}

# ── Standalone agentdb MCP: durable on-disk schema (fix #1 ephemerality) ──────
# The agentdb stdio MCP server (sql.js backend) boots with an IN-MEMORY schema
# that is lost on every session restart unless ./agentdb.db already holds the
# schema on disk — so `db_stats`/`agentdb_stats` error after each restart until
# `agentdb_init` (the MCP tool) is re-run. That MCP tool only writes the server's
# memory, never the file, so the fix evaporates every session (issue #4 gap #1,
# confirmed ephemeral in the field). The durable fix is the CLI `agentdb init`,
# which writes the agentdb-native schema (agentdb_config, dimension 384) to the
# on-disk file so it survives restarts. Idempotent: skips a non-empty db (and
# `agentdb init` itself preserves existing rows). Echoes:
#   INITIALIZED | PRESENT | NO_CLI | NO_DIR | DRYRUN | FAILED
ensure_agentdb_schema() {
  local target="$1" db="$1/agentdb.db"
  [[ -d "$target" ]] || { echo "NO_DIR"; return; }
  [[ -s "$db" ]] && { echo "PRESENT"; return; }            # 0-byte/missing is the ephemeral symptom
  command -v agentdb >/dev/null 2>&1 || { echo "NO_CLI"; return; }
  [[ "${DRY_RUN:-0}" -eq 1 ]] && { echo "DRYRUN"; return; }
  ( cd "$target" && agentdb init ./agentdb.db --dimension 384 >/tmp/agentdb-init-schema.log 2>&1 )
  [[ -s "$db" ]] && echo "INITIALIZED" || echo "FAILED"
}

# ── Stray RVF-only .agentic-qe sweep (RVF-STRAY-SWEEP-V1) ────────────────────
# The AQE RVF substrate (shared-rvf-adapter / shared-rvf-dual-writer): on ≤3.10.3 it
# resolved its store path from a CWD-RELATIVE default ('.agentic-qe/patterns.rvf' and
# '.agentic-qe/brain.rvf') instead of findProjectRoot() — the resolver the SQLite
# memory.db DOES use. So any aqe/hook/worker invoked with cwd != project root dropped
# a stray '.agentic-qe' holding ONLY the .rvf files (never memory.db/config.yaml).
# Fixed upstream in aqe 3.10.4: RVF now routes through the same AQE_PROJECT_ROOT ??
# findProjectRoot resolver; this helper is retained for historical-stray cleanup.
# Those strays are orphaned (every reader walks up to the real root), gitignored,
# harmless-but-messy, and silently fragment learning. We classify by the absence of
# the canonical SQLite markers + presence of an RVF payload — never by location, so
# a real project root is structurally safe (it always has memory.db/config.yaml).
#
# is_stray_aqe_dir <dir> -> exit 0 iff dir is an RVF-only stray.
is_stray_aqe_dir() {
  local d="$1"
  [[ -d "$d" ]] || return 1
  [[ -e "$d/memory.db" || -e "$d/config.yaml" ]] && return 1   # canonical marker => NOT a stray
  [[ -n "$(find "$d" -maxdepth 1 -name '*.rvf' -print -quit 2>/dev/null)" ]] || return 1  # no RVF payload
  return 0
}

# find_stray_aqe_dirs <target> -> prints one stray dir (absolute) per line. Excludes
# the canonical root, node_modules, and any vendored agentic-qe source clone.
#
# FIND-PRUNE-V1 (issue #8): the exclusions MUST be a -prune, never a `-not -path`
# post-match filter. `-not -path '*/node_modules/*'` only drops matches from the
# RESULTS — find still descends through every node_modules in full. On a monorepo
# with several worktrees each carrying independent node_modules that is millions of
# stat() calls; the reporter measured >10 minutes on a WSL2 9p mount, stuck in
# uninterruptible D-state so it could not even be Ctrl-C'd. `-prune` cuts the
# subtree before descending, making the cost independent of node_modules size.
#
# The pattern is `-path '*/node_modules'` (the dir ITSELF), not '*/node_modules/*'
# (its contents) and not `-name node_modules`. Verified identical to the old result
# set on BSD find, GNU findutils 4.10.0 and bfs 4.1.1 — including that a .agentic-qe
# nested inside a pruned dir stays excluded, and that `-name` is NOT a substitute
# (it would prune a root spelled as a bare relative `node_modules`, which the old
# filter deliberately kept, since '*/node_modules/*' needs a leading slash).
find_stray_aqe_dirs() {
  local target="$1" d
  while IFS= read -r d; do
    [[ "$d" == "$target/.agentic-qe" ]] && continue            # canonical root, never a stray
    is_stray_aqe_dir "$d" && echo "$d"
  done < <(find "$target" \
             \( -path '*/node_modules' -o -path '*/agentic-qe-src' \) -prune \
             -o -type d -name '.agentic-qe' -print 2>/dev/null)
}

# sweep_stray_aqe_dirs <target> <mode>   mode: list | remove
# Sets globals SWEEP_STRAY_COUNT and SWEEP_REMOVED. In remove mode each stray is
# moved to '<dir>.cleanup-bak' (recoverable); DRY_RUN forces list mode. Prints one
# human line per stray; callers read the globals for a machine-readable result.
sweep_stray_aqe_dirs() {
  local target="$1" mode="${2:-list}" d
  SWEEP_STRAY_COUNT=0; SWEEP_REMOVED=0
  [[ "${DRY_RUN:-0}" -eq 1 ]] && mode="list"
  while IFS= read -r d; do
    [[ -z "$d" ]] && continue
    SWEEP_STRAY_COUNT=$((SWEEP_STRAY_COUNT + 1))
    if [[ "$mode" == "remove" ]]; then
      rm -rf "$d.cleanup-bak" 2>/dev/null
      if mv "$d" "$d.cleanup-bak" 2>/dev/null; then
        SWEEP_REMOVED=$((SWEEP_REMOVED + 1))
        fix "removed stray RVF .agentic-qe: ${d#$target/} (moved to .cleanup-bak)"
        pass "removed stray RVF store: ${d#$target/}"
      else
        warn "could not remove stray: ${d#$target/}"
      fi
    else
      warn "stray RVF .agentic-qe (RVF-only, no memory.db/config.yaml): ${d#$target/}"
    fi
  done < <(find_stray_aqe_dirs "$target")
}

# ── ONNX model-cache vault (MODEL-CACHE-SEED-V1) ─────────────────────────────
# transformers.js NEVER reads TRANSFORMERS_CACHE — both installed majors
# (@xenova v2 on the ruflo side, @huggingface v3 on the AQE side) hard-default
# their weights cache to a dir INSIDE the package (env.js DEFAULT_CACHE_DIR =
# <pkg>/.cache; the env-var string is absent from both dists), and AQE's
# pipeline() call passes no cache_dir. So every `npm i -g ruflo|agentic-qe`
# wipes the ~25MB MiniLM weights and the next embed re-downloads them (observed:
# agentic-qe's @huggingface/transformers/.cache recreated on the 2026-07-17
# 3.12.2 upgrade — exactly what the old Tier-6.5 TRANSFORMERS_CACHE export was
# meant to prevent, but that export is inert for these loaders). These helpers
# preserve/restore the PACKAGE-LOCAL caches through a per-user vault instead.
# The ruvector loader ($HOME/.ruvector/models) is already HOME-anchored and
# upgrade-proof — deliberately not managed here.
#   vault layout: $RUFLO_MODEL_CACHE/hf-v3/  ← @huggingface/transformers (AQE)
#                 $RUFLO_MODEL_CACHE/Xenova/ ← @xenova/transformers (ruflo; the
#                 legacy npx-harvest also merged into the vault root, so Xenova/
#                 doubles as the v2 namespace)
# Best-effort + idempotent (merge-update, never deletes); honor DRY_RUN.
kit_model_vault() { echo "${RUFLO_MODEL_CACHE:-$HOME/.cache/ruflo-models}"; }
_kit_cache_sync() {  # <src-dir> <dst-dir> — merge-update copy; exit 1 if src absent
  local src="$1" dst="$2"
  [[ -d "$src" ]] || return 1
  [[ "${DRY_RUN:-0}" -eq 1 ]] && { echo "[dry-run] would sync $src → $dst"; return 0; }
  mkdir -p "$dst"
  if command -v rsync >/dev/null 2>&1; then rsync -a --update "$src/" "$dst/" 2>/dev/null
  else cp -R "$src/." "$dst/" 2>/dev/null; fi
}
kit_preserve_model_caches() {  # live package caches → vault. Echoes: PRESERVED:n
  local gnm n=0; gnm="$(npm root -g 2>/dev/null)" || { echo "PRESERVED:0"; return 0; }
  # AQE-EMBEDDER-RESOLVE-V1 installs @huggingface/transformers TOP-LEVEL (the dep
  # is devDependencies-only upstream, so it is never nested under agentic-qe).
  # Before that step existed this vault knew only the nested path, which cannot
  # exist — so the ONE cache actually on disk (ruflo's, via agentdb's optional
  # dep) was never preserved. Sweep every real location; hf-v3 is one namespace
  # because all of them are the same v3+ layout for the same model.
  _kit_cache_sync "$gnm/@huggingface/transformers/.cache" \
                  "$(kit_model_vault)/hf-v3" && n=$((n+1))
  _kit_cache_sync "$gnm/ruflo/node_modules/@huggingface/transformers/.cache" \
                  "$(kit_model_vault)/hf-v3" && n=$((n+1))
  _kit_cache_sync "$gnm/agentic-qe/node_modules/@huggingface/transformers/.cache" \
                  "$(kit_model_vault)/hf-v3" && n=$((n+1))
  _kit_cache_sync "$gnm/ruflo/node_modules/@xenova/transformers/.cache/Xenova" \
                  "$(kit_model_vault)/Xenova" && n=$((n+1))
  echo "PRESERVED:$n"
}
kit_restore_model_caches() {   # vault → freshly-installed package caches. Echoes: RESTORED:n
  local gnm n=0; gnm="$(npm root -g 2>/dev/null)" || { echo "RESTORED:0"; return 0; }
  local top="$gnm/@huggingface/transformers"
  local aqe="$gnm/agentic-qe/node_modules/@huggingface/transformers"
  local ruf="$gnm/ruflo/node_modules/@xenova/transformers"
  # Restore only into packages that exist (never mkdir a package dir), and only
  # from the matching vault namespace (v2/v3 layouts are similar but not mixed).
  # -d follows symlinks, so a SYMLINKED package dir passes the gate and we would
  # rsync through it into a tree the kit does not own (bytes another package's
  # upgrade then silently deletes). Own-the-target check: restore only into a
  # real directory. Never restore into ruflo's @huggingface copy for the same
  # reason — it belongs to agentdb's optional dep, not to us.
  [[ -d "$top" && ! -L "$top" ]] && _kit_cache_sync "$(kit_model_vault)/hf-v3"  "$top/.cache" && n=$((n+1))
  [[ -d "$aqe" && ! -L "$aqe" ]] && _kit_cache_sync "$(kit_model_vault)/hf-v3"  "$aqe/.cache" && n=$((n+1))
  [[ -d "$ruf" && ! -L "$ruf" ]] && _kit_cache_sync "$(kit_model_vault)/Xenova" "$ruf/.cache/Xenova" && n=$((n+1))
  echo "RESTORED:$n"
}
