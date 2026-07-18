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
KIT_NPM_ALLOW_LIST="better-sqlite3,sqlite3"   # only boot-path native builds
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
# Pure read-only (sqlite3 -readonly). Self-contained (inlines the table check) so
# it works from common.sh without depending on health.sh's table_exists.
assert_vector_dim_ok() {
  local db="$1" tbl="$2" col="$3" dimc="$4" exp="$5"
  [[ -f "$db" ]] || { echo "NO_TABLE"; return; }
  sqlite3 -readonly "$db" \
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='$tbl' LIMIT 1;" \
    2>/dev/null | grep -q 1 || { echo "NO_TABLE"; return; }
  local n; n="$(sqlite3 -readonly "$db" "SELECT COUNT(*) FROM $tbl;" 2>/dev/null || echo 0)"
  [[ "${n:-0}" -eq 0 ]] && { echo "EMPTY"; return; }
  local baddim
  baddim="$(sqlite3 -readonly "$db" "SELECT $dimc FROM $tbl WHERE $dimc<>$exp LIMIT 1;" 2>/dev/null)"
  [[ -n "$baddim" ]] && { echo "DIM_MISMATCH:$baddim"; return; }
  local badblob
  badblob="$(sqlite3 -readonly "$db" "SELECT COUNT(*) FROM $tbl WHERE length($col)<>$dimc*4;" 2>/dev/null || echo 0)"
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
find_stray_aqe_dirs() {
  local target="$1" d
  while IFS= read -r d; do
    [[ "$d" == "$target/.agentic-qe" ]] && continue            # canonical root, never a stray
    is_stray_aqe_dir "$d" && echo "$d"
  done < <(find "$target" -type d -name '.agentic-qe' \
             -not -path '*/node_modules/*' \
             -not -path '*/agentic-qe-src/*' 2>/dev/null)
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
