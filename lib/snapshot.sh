#!/usr/bin/env bash
set -uo pipefail
# ============================================================================
# lib/snapshot.sh — SNAPSHOT verb: the receipt half of MEMORY-PRESERVE-PROOF-V1.
# WAL-safe backup + per-table row-count manifest of a target's learning stores,
# written OUTSIDE the target repo so a later adopt/setup can be diffed against it.
#
# Usage:
#   bin/ruflo-kit snapshot <target>            # backup + manifest + baseline pointer
#   bin/ruflo-kit snapshot <target> --dry-run  # print what would be snapshotted
#   bin/ruflo-kit snapshot <target> -h|--help  # this help
#
# What it snapshots (each only if present):
#   sqlite (online backup — never a raw cp of a live db):
#     .swarm/memory.db  .agentic-qe/memory.db  agentdb.db
#   RVF-family artifacts (raw copies):
#     agentdb.rvf  agentdb.rvf.idmap.json  ruvector.db
#     .agentic-qe/aqe.rvf  .agentic-qe/patterns.rvf
#
# Destination: ~/.ruflo-kit/backups/<target-basename>-<YYYYMMDD-HHMMSS>/
# (override root with RUFLO_KIT_BACKUP_ROOT). Writes manifest.json there AND a
# pointer to <target>/.claude-flow/data/adoption-baseline.json
# ({dir, createdAt, counts}) so adopt can recount + diff later. Row counts cover
# every user table (sqlite_master type='table', name NOT LIKE 'sqlite_%').
# Pre-existing '*.corrupt-*' artifacts next to the stores are REPORTED, never
# touched. sqlite access goes through kit_sqlite_ro / kit_sqlite_backup
# (common.sh): sqlite3 CLI first, node+better-sqlite3 (global ruflo) fallback.
# ============================================================================

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

kit_resolve "$@"
[[ "$KIT_WANT_HELP" -eq 1 ]] && { sed -n '3,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }
kit_require_target

# Relative store paths (bash 3.2 — plain arrays, no assoc arrays).
SQLITE_STORES=".swarm/memory.db .agentic-qe/memory.db agentdb.db"
RVF_ARTIFACTS="agentdb.rvf agentdb.rvf.idmap.json ruvector.db .agentic-qe/aqe.rvf .agentic-qe/patterns.rvf"

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

# Per-table row counts of one sqlite db → a JSON object fragment {"tbl":N,...}.
store_counts_json() {
  local db="$1" t n first=1 out="" tq
  while IFS= read -r t; do
    [[ -z "$t" ]] && continue
    tq="$(printf '%s' "$t" | sed 's/"/""/g')"   # sqlite identifier-quote escape
    n="$(kit_sqlite_ro "$db" "SELECT COUNT(*) FROM \"$tq\";" | head -1)"
    [[ "$n" =~ ^[0-9]+$ ]] || n=0
    [[ "$first" -eq 0 ]] && out="$out,"
    out="$out\"$(json_escape "$t")\":$n"
    first=0
  done < <(kit_sqlite_ro "$db" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;")
  printf '{%s}' "$out"
}

echo "============================================"
echo " ruflo-kit snapshot (MEMORY-PRESERVE-PROOF-V1 receipt)"
kit_banner
echo "============================================"

# ── Inventory: which stores/artifacts exist; corrupt artifacts nearby ────────
PRESENT_SQLITE=""; PRESENT_RVF=""
for rel in $SQLITE_STORES; do
  [[ -f "$TARGET_DIR/$rel" ]] && PRESENT_SQLITE="$PRESENT_SQLITE $rel"
done
for rel in $RVF_ARTIFACTS; do
  [[ -f "$TARGET_DIR/$rel" ]] && PRESENT_RVF="$PRESENT_RVF $rel"
done

# Surface (report only, never touch) pre-existing '*.corrupt-*' artifacts next
# to the stores: target root, .swarm/, .agentic-qe/.
CORRUPT_LIST=()
for d in "$TARGET_DIR" "$TARGET_DIR/.swarm" "$TARGET_DIR/.agentic-qe"; do
  [[ -d "$d" ]] || continue
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    CORRUPT_LIST+=("${f#"$TARGET_DIR"/}")
  done < <(find "$d" -maxdepth 1 -name '*.corrupt-*' 2>/dev/null | sort)
done
if [[ "${#CORRUPT_LIST[@]}" -gt 0 ]]; then
  for c in "${CORRUPT_LIST[@]}"; do
    warn "pre-existing corrupt artifact (reported, NOT touched): $c"
  done
else
  info "no pre-existing *.corrupt-* artifacts next to the stores"
fi

if [[ -z "$PRESENT_SQLITE" && -z "$PRESENT_RVF" ]]; then
  warn "no learning stores found under $TARGET_DIR — nothing to snapshot"
fi

BACKUP_ROOT="${RUFLO_KIT_BACKUP_ROOT:-$HOME/.ruflo-kit/backups}"
TS="$(date +%Y%m%d-%H%M%S)"
BASE="$(basename "$TARGET_DIR")"
DEST="$BACKUP_ROOT/$BASE-$TS"
_n=2
while [[ -e "$DEST" ]]; do DEST="$BACKUP_ROOT/$BASE-$TS-$_n"; _n=$((_n + 1)); done

# ── Dry-run: print the plan, change nothing ──────────────────────────────────
if [[ "$DRY_RUN" -eq 1 ]]; then
  header "plan" "dry-run — nothing written"
  for rel in $PRESENT_SQLITE; do info "[dry-run] would sqlite-backup $rel → $DEST/$rel (+ per-table row counts)"; done
  for rel in $PRESENT_RVF;    do info "[dry-run] would raw-copy      $rel → $DEST/$rel"; done
  info "[dry-run] would write manifest: $DEST/manifest.json"
  info "[dry-run] would write baseline pointer: $TARGET_DIR/.claude-flow/data/adoption-baseline.json"
  echo ""
  echo "Backup destination (would be): $DEST"
  exit 0
fi

mkdir -p "$DEST" || { fail "cannot create backup dir: $DEST"; exit 1; }
CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ── sqlite stores: online backup + per-table counts (counted on the backup —
# the consistent copy IS the receipt) ─────────────────────────────────────────
header "1" "sqlite stores (WAL-safe online backup)"
COUNTS_JSON=""; _first=1; SNAP_FAIL=0
for rel in $PRESENT_SQLITE; do
  if kit_sqlite_backup "$TARGET_DIR/$rel" "$DEST/$rel"; then
    cj="$(store_counts_json "$DEST/$rel")"
    pass "backed up $rel ($cj)"
    [[ "$_first" -eq 0 ]] && COUNTS_JSON="$COUNTS_JSON,"
    COUNTS_JSON="$COUNTS_JSON\"$(json_escape "$rel")\":$cj"
    _first=0
  else
    fail "sqlite backup FAILED for $rel"
    SNAP_FAIL=1
  fi
done
[[ -z "$PRESENT_SQLITE" ]] && info "no sqlite stores present"

# ── RVF-family artifacts: raw copies ─────────────────────────────────────────
header "2" "RVF-family artifacts (raw copy)"
RVF_JSON=""; _first=1
for rel in $PRESENT_RVF; do
  mkdir -p "$DEST/$(dirname "$rel")"
  if cp "$TARGET_DIR/$rel" "$DEST/$rel" 2>/dev/null; then
    pass "copied $rel"
    [[ "$_first" -eq 0 ]] && RVF_JSON="$RVF_JSON,"
    RVF_JSON="$RVF_JSON\"$(json_escape "$rel")\""
    _first=0
  else
    fail "raw copy FAILED for $rel"
    SNAP_FAIL=1
  fi
done
[[ -z "$PRESENT_RVF" ]] && info "no RVF-family artifacts present"

# ── Manifest + baseline pointer ──────────────────────────────────────────────
header "3" "manifest + baseline pointer"
CORRUPT_JSON=""; _first=1
if [[ "${#CORRUPT_LIST[@]}" -gt 0 ]]; then
  for c in "${CORRUPT_LIST[@]}"; do
    [[ "$_first" -eq 0 ]] && CORRUPT_JSON="$CORRUPT_JSON,"
    CORRUPT_JSON="$CORRUPT_JSON\"$(json_escape "$c")\""
    _first=0
  done
fi

MANIFEST="$DEST/manifest.json"
{
  printf '{'
  printf '"sentinel":"MEMORY-PRESERVE-PROOF-V1",'
  printf '"kind":"snapshot-manifest",'
  printf '"target":"%s",' "$(json_escape "$TARGET_DIR")"
  printf '"dir":"%s",' "$(json_escape "$DEST")"
  printf '"createdAt":"%s",' "$CREATED_AT"
  printf '"counts":{%s},' "$COUNTS_JSON"
  printf '"rvf":[%s],' "$RVF_JSON"
  printf '"corruptArtifacts":[%s]' "$CORRUPT_JSON"
  printf '}\n'
} > "$MANIFEST"
pass "manifest written: $MANIFEST"

POINTER_DIR="$TARGET_DIR/.claude-flow/data"
mkdir -p "$POINTER_DIR"
POINTER="$POINTER_DIR/adoption-baseline.json"
{
  printf '{'
  printf '"dir":"%s",' "$(json_escape "$DEST")"
  printf '"createdAt":"%s",' "$CREATED_AT"
  printf '"counts":{%s}' "$COUNTS_JSON"
  printf '}\n'
} > "$POINTER"
pass "baseline pointer written: $POINTER"

echo ""
echo "Backup destination: $DEST"
[[ "$SNAP_FAIL" -eq 1 ]] && { fail "snapshot INCOMPLETE — at least one store failed to back up"; exit 1; }
exit 0
