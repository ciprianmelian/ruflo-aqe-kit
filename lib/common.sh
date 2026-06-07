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
# Surgical: acts ONLY on "type":"module" projects (a commonjs/absent root already
# loads the .js helpers as CJS, so there is nothing to fix and we touch nothing).
# Idempotent; honors DRY_RUN. Echoes one status token:
#   NO_DIR | NOT_ESM_PROJECT | DRYRUN | PINNED | ALREADY
pin_helpers_module_type() {
  local target="$1" hdir="$1/.claude/helpers"
  [[ -d "$hdir" ]] || { echo "NO_DIR"; return; }
  grep -qE '"type"[[:space:]]*:[[:space:]]*"module"' "$target/package.json" 2>/dev/null \
    || { echo "NOT_ESM_PROJECT"; return; }
  local need_pkg=0 need_mjs=0
  [[ -f "$hdir/package.json" ]] && grep -q '"type"[[:space:]]*:[[:space:]]*"commonjs"' "$hdir/package.json" 2>/dev/null || need_pkg=1
  [[ -f "$hdir/github-safe.js" ]] && grep -qE '^[[:space:]]*(import |export )' "$hdir/github-safe.js" 2>/dev/null && need_mjs=1
  if [[ "$need_pkg" -eq 0 && "$need_mjs" -eq 0 ]]; then echo "ALREADY"; return; fi
  if [[ "${DRY_RUN:-0}" -eq 1 ]]; then echo "DRYRUN"; return; fi
  [[ "$need_pkg" -eq 1 ]] && printf '{\n  "type": "commonjs"\n}\n' > "$hdir/package.json"
  [[ "$need_mjs" -eq 1 ]] && mv -f "$hdir/github-safe.js" "$hdir/github-safe.mjs"
  echo "PINNED"
}
