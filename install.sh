#!/usr/bin/env bash
# ============================================================================
# install.sh — one-line installer for the ruflo + Agentic QE kit.
#
#   curl -fsSL https://raw.githubusercontent.com/ciprianmelian/ruflo-aqe-kit/main/install.sh | bash
#
# What it does (and prints before doing):
#   1. Clones (or `git pull` if already present) the kit into
#      ${RUFLO_KIT_HOME:-$HOME/.ruflo-kit}.
#   2. Symlinks `ruflo-kit` into a bin dir on your PATH (~/.local/bin preferred,
#      else /usr/local/bin with a sudo prompt).
#   3. Preflights bash / node / git (warn-not-fail on optional jq / sqlite3).
#
# Re-running is the upgrade path (git pull + relink). `--uninstall` removes the
# symlink and the clone. No npm publish, no build step; tracks `main`.
# ============================================================================
set -euo pipefail

REPO_URL="${RUFLO_KIT_REPO:-https://github.com/ciprianmelian/ruflo-aqe-kit.git}"
KIT_HOME="${RUFLO_KIT_HOME:-$HOME/.ruflo-kit}"
BRANCH="${RUFLO_KIT_BRANCH:-main}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
say()  { echo -e "${CYAN}==>${NC} $1"; }
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
die()  { echo -e "  ${RED}✗${NC} $1" >&2; exit 1; }

# ── Uninstall ───────────────────────────────────────────────────────────────
if [ "${1:-}" = "--uninstall" ]; then
  say "Uninstalling ruflo-kit"
  for d in "$HOME/.local/bin" /usr/local/bin; do
    link="$d/ruflo-kit"
    if [ -L "$link" ]; then
      if rm "$link" 2>/dev/null; then ok "removed symlink $link"
      elif sudo rm "$link" 2>/dev/null; then ok "removed symlink $link (sudo)"
      else warn "could not remove $link"; fi
    fi
  done
  if [ -d "$KIT_HOME" ]; then
    rm -rf "$KIT_HOME" && ok "removed clone $KIT_HOME"
  fi
  say "Done. (Remove any PATH line you added for ~/.local/bin manually.)"
  exit 0
fi

# ── Preflight ─────────────────────────────────────────────────────────────--
say "Preflight"
command -v git  >/dev/null 2>&1 || die "git not found — install git first"
command -v bash >/dev/null 2>&1 || die "bash not found"
ok "git $(git --version | awk '{print $3}')"

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${NODE_MAJOR:-0}" -ge 18 ]; then ok "node $(node --version)"
  else warn "node $(node --version) — ruflo recommends >= 20 (the kit's node tools may misbehave)"; fi
else
  warn "node not found — install Node.js >= 20 before running the kit (ruflo/aqe need it)"
fi
command -v jq      >/dev/null 2>&1 && ok "jq present" || warn "jq not found — some steps skip gracefully (brew install jq)"
command -v sqlite3 >/dev/null 2>&1 && ok "sqlite3 present" || warn "sqlite3 not found — health/seed steps skip gracefully (brew install sqlite3)"

# ── Clone or update ───────────────────────────────────────────────────────--
if [ -d "$KIT_HOME/.git" ]; then
  say "Updating existing clone at $KIT_HOME"
  git -C "$KIT_HOME" fetch --quiet origin "$BRANCH"
  git -C "$KIT_HOME" checkout --quiet "$BRANCH"
  git -C "$KIT_HOME" pull --ff-only --quiet origin "$BRANCH" && ok "updated to $(git -C "$KIT_HOME" rev-parse --short HEAD)"
else
  say "Cloning $REPO_URL → $KIT_HOME"
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$KIT_HOME" && ok "cloned $(git -C "$KIT_HOME" rev-parse --short HEAD)"
fi
chmod +x "$KIT_HOME/bin/ruflo-kit" 2>/dev/null || true

# ── Symlink onto PATH ─────────────────────────────────────────────────────--
say "Linking ruflo-kit onto your PATH"
TARGET="$KIT_HOME/bin/ruflo-kit"
LINK_DIR=""
case ":$PATH:" in
  *":$HOME/.local/bin:"*) LINK_DIR="$HOME/.local/bin" ;;
  *":/usr/local/bin:"*)   LINK_DIR="/usr/local/bin" ;;
esac
# Prefer ~/.local/bin even if not yet on PATH (we'll print the PATH hint).
[ -z "$LINK_DIR" ] && LINK_DIR="$HOME/.local/bin"
mkdir -p "$LINK_DIR" 2>/dev/null || true

if [ -w "$LINK_DIR" ]; then
  ln -sf "$TARGET" "$LINK_DIR/ruflo-kit" && ok "linked $LINK_DIR/ruflo-kit"
elif [ "$LINK_DIR" = "/usr/local/bin" ]; then
  warn "$LINK_DIR not writable — using sudo"
  sudo ln -sf "$TARGET" "$LINK_DIR/ruflo-kit" && ok "linked $LINK_DIR/ruflo-kit (sudo)"
else
  die "cannot write $LINK_DIR — set RUFLO_KIT_HOME or add $KIT_HOME/bin to PATH manually"
fi

# ── PATH hint ─────────────────────────────────────────────────────────────--
case ":$PATH:" in
  *":$LINK_DIR:"*) ;;
  *) warn "$LINK_DIR is not on your PATH yet. Add this to your shell profile:"
     echo "      export PATH=\"$LINK_DIR:\$PATH\"" ;;
esac

# ── Done ──────────────────────────────────────────────────────────────────--
echo
say "Installed. The kit ships Apple-Silicon (darwin-arm64) native SONA/GNN builds;"
echo "    other platforms run with upstream fallbacks (the native step skips cleanly)."
echo
ok "Try it:"
echo "      ruflo-kit help"
echo "      ruflo-kit init /path/to/your/codebase"
echo
echo "    Upgrade later:   ruflo-kit self-update   (or re-run this installer)"
echo "    Uninstall:       curl -fsSL <installer-url> | bash -s -- --uninstall"
