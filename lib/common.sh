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
