#!/usr/bin/env bash
set -uo pipefail
# Note: -e intentionally omitted — ((var++)) returns 1 when var=0 under set -e,
# and node-edit helpers signal state through tokens, not exit codes.

# ============================================================================
# fix-brain.sh — integrate ruvnet-brain as an MCP-ONLY server (marker BRAIN-MCP-V1).
# Run from anywhere: bin/ruflo-kit fix-brain <target> [--download] [--refresh] [--allow-unsigned] [--dry-run]
#
# BRAIN-KB-REFRESH-V1: Step 1.5 compares the installed KB version against the
# newest GitHub Release (6s budget, offline → UNKNOWN, never fatal). A
# present-but-stale KB is refreshed ONLY behind the explicit --refresh flag
# (implies --download) — a GB-class download must never happen implicitly.
#
# ruvnet-brain (github.com/stuinfla/ruvnet-brain) is a Claude Code plugin whose
# core value is ONE MCP tool — search_ruvnet — served by kb/forge-mcp-all.mjs out
# of a ~736MB, Ed25519-signed knowledge-base bundle (published as a GitHub Release,
# unpacked to ~/.cache/ruvnet-brain/kb, overridable via $RUVNET_BRAIN_KB). The kit
# vendors the thin stdio launcher at vendor/ruvnet-brain/plugin/mcp/server.mjs,
# which resolves the KB dir and spawns the real server.
#
# DELIBERATELY MCP-ONLY (user decision): this script installs NO Claude Code hooks,
# NO launchd/LaunchAgent jobs, and never runs `claude plugin install`. It only:
#   [1] locates the KB (env/default). Missing → reports MISSING + how to fetch;
#       with --download it replicates bin/install.mjs's download + Ed25519 verify +
#       unzip (fail-closed on a missing/invalid signature — see --allow-unsigned).
#   [2] ensures the local reader deps (@ruvector/rvf, @xenova/transformers) are
#       installed inside the KB dir so vector reads run offline.
#   [3] registers the launcher in the TARGET's .mcp.json as server "ruvnet-brain"
#       (idempotent, .bak first) with env RUVNET_BRAIN_KB pinned to the resolved KB.
#   [4] health-probes: node-loads forge-mcp-all.mjs and (when the reader is present)
#       attempts one MCP `initialize` handshake — pass/warn, never fatal.
#
# Idempotent (value checks / sentinel), reversible (.bak), honors DRY_RUN.
# ============================================================================

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# ── Pre-parse fix-brain-only flags, then hand the rest to kit_resolve ────────
# kit_resolve() warns on flags it doesn't know, so strip ours out first. The
# `${ARR[@]+...}` form is the bash-3.2-safe empty-array expansion under `set -u`.
BRAIN_DOWNLOAD=0; BRAIN_ALLOW_UNSIGNED=0; BRAIN_REFRESH=0
_KR_ARGS=()
for _a in "$@"; do
  case "$_a" in
    --download)       BRAIN_DOWNLOAD=1 ;;
    --refresh)        BRAIN_REFRESH=1; BRAIN_DOWNLOAD=1 ;;
    --allow-unsigned) BRAIN_ALLOW_UNSIGNED=1 ;;
    *)                _KR_ARGS+=("$_a") ;;
  esac
done
kit_resolve ${_KR_ARGS[@]+"${_KR_ARGS[@]}"}
kit_require_target
cd "$TARGET_DIR"

# ── Resolution (mirrors plugin/mcp/server.mjs + bin/install.mjs) ─────────────
BRAIN_HOME="${RUVNET_BRAIN_HOME:-$HOME/.cache/ruvnet-brain}"
KB_DIR="${RUVNET_BRAIN_KB:-$BRAIN_HOME/kb}"
MCP_MARKER="$KB_DIR/forge-mcp-all.mjs"                 # the "brain is unpacked" marker install.mjs uses
SERVER_MJS="$KIT_DIR/vendor/ruvnet-brain/plugin/mcp/server.mjs"   # vendored thin stdio launcher
# vendor/ is a local-only checkout (gitignored) — on a clean clone/CI fall back
# to the kit-tracked copy of the same MIT-licensed 2KB launcher (verified
# byte-identical to upstream at vendor sync; re-sync when upstream changes it).
[[ -f "$SERVER_MJS" ]] || SERVER_MJS="$KIT_ASSETS/brain/server.mjs"
MCP_JSON="$TARGET_DIR/.mcp.json"

echo "============================================"
echo " fix-brain — ruvnet-brain MCP-only integration"
echo " kit:    $KIT_DIR"
echo " target: $TARGET_DIR"
echo " KB dir: $KB_DIR"
[[ "$DRY_RUN" -eq 1 ]] && echo " MODE: dry-run (no changes)"
echo "============================================"

# ── Step 1: locate the KB (optional gated download) ─────────────────────────
header "1" "Locate the ruvnet-brain KB"
KB_PRESENT=0; KB_REFRESHED=0
if [[ -f "$MCP_MARKER" && "$BRAIN_REFRESH" -ne 1 ]]; then
  KB_PRESENT=1
  pass "KB present (forge-mcp-all.mjs found in $KB_DIR)"
  [[ -n "${RUVNET_BRAIN_KB:-}" ]] && info "(from your RUVNET_BRAIN_KB override)"
elif [[ "$BRAIN_DOWNLOAD" -ne 1 ]]; then
  warn "KB MISSING — no brain at $KB_DIR (forge-mcp-all.mjs absent)"
  info "The KB is a ~736MB signed Release bundle; the download is opt-in. To fetch it:"
  info "  bin/ruflo-kit fix-brain $TARGET_DIR --download        # kit path (Ed25519-verified)"
  info "  npx ruvnet-brain                                       # upstream installer"
  info "Or point at an existing brain: export RUVNET_BRAIN_KB=/path/to/kb"
elif [[ "$DRY_RUN" -eq 1 ]]; then
  info "[dry-run] would download + Ed25519-verify + unpack the GB-class brain bundle into $KB_DIR"
  [[ -f "$MCP_MARKER" ]] && { KB_PRESENT=1; info "[dry-run] existing KB would be replaced in place (--refresh)"; }
else
  [[ "$BRAIN_REFRESH" -eq 1 && -f "$MCP_MARKER" ]] && info "refreshing existing KB in place (--refresh)"
  info "downloading + verifying the brain (GB-class) — replicating bin/install.mjs …"
  DL="$(mktemp)"
  cat > "$DL" <<'NODE'
'use strict';
// Replicate bin/install.mjs: resolve latest Release (fallback v2.9.0), download the
// ruvnet-brain.zip + its .sig, verify the Ed25519 signature FAIL-CLOSED, then unzip +
// flatten into the KB dir. The signing PUBLIC key is embedded so the trust root travels
// with this code (an attacker who swaps the bundle can't also swap the key we check it against).
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPO = 'stuinfla/ruvnet-brain';
const ASSET = 'ruvnet-brain.zip';
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const FALLBACK_TAG = 'v2.9.0';
const fallbackUrl = (tag) => `https://github.com/${REPO}/releases/download/${tag}/${ASSET}`;
const KB = process.env.KB_DIR;
const ALLOW_UNSIGNED = process.env.ALLOW_UNSIGNED === '1';
const SIGNING_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAgse9TAtehXUvUfTrJFY2CCHiCbmelR8yCgS//sen5/w=
-----END PUBLIC KEY-----`;

function die(m) { console.error(`[fix-brain] ${m}`); process.exit(1); }

function getJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error('too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'ruflo-kit-fix-brain', Accept: 'application/vnd.github+json' }, timeout: 15000 }, (res) => {
      const { statusCode = 0, headers } = res;
      if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) { res.resume(); return resolve(getJson(new URL(headers.location, url).toString(), redirects + 1)); }
      if (statusCode !== 200) { res.resume(); return reject(new Error(`GitHub API HTTP ${statusCode}`)); }
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('timeout', function () { this.destroy(new Error('GitHub API timeout')); }).on('error', reject);
  });
}
function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error('too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'ruflo-kit-fix-brain', Accept: 'application/octet-stream' } }, (res) => {
      const { statusCode = 0, headers } = res;
      if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) { res.resume(); return resolve(download(new URL(headers.location, url).toString(), dest, redirects + 1)); }
      if (statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${statusCode}`)); }
      const total = Number(headers['content-length'] || 0); let got = 0, shown = -1;
      const out = fs.createWriteStream(dest);
      res.on('data', (ch) => { got += ch.length; if (total) { const p = Math.floor((got / total) * 100); if (p !== shown && p % 10 === 0) { process.stdout.write(`\r    …${p}%`); shown = p; } } });
      res.pipe(out); out.on('finish', () => out.close(() => { process.stdout.write('\n'); resolve(); })); out.on('error', reject);
    }).on('error', reject);
  });
}
function verify(zip, sig) {
  if (!fs.existsSync(sig)) return { ok: false, reason: 'signature missing (fail-closed)' };
  try {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
    const ok = crypto.verify(null, Buffer.from(digest, 'hex'), crypto.createPublicKey(SIGNING_PUBKEY_PEM), fs.readFileSync(sig));
    return ok ? { ok: true, reason: `signature valid (sha256 ${digest.slice(0, 12)}…)` } : { ok: false, reason: 'signature does NOT match — bundle may be tampered' };
  } catch (e) { return { ok: false, reason: `verify error: ${e.message}` }; }
}

(async () => {
  let url = fallbackUrl(FALLBACK_TAG), tag = FALLBACK_TAG;
  try {
    const rel = await getJson(RELEASE_API);
    if (rel && rel.tag_name) { tag = rel.tag_name; const a = Array.isArray(rel.assets) ? rel.assets.find((x) => x.name === ASSET) : null; url = (a && a.browser_download_url) || fallbackUrl(tag); }
    console.log(`    latest Release: ${tag}`);
  } catch (e) { console.log(`    could not reach GitHub (${e.message}) — using known-good ${FALLBACK_TAG}`); }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ruflo-brain-'));
  process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ } });
  const zip = path.join(tmp, ASSET), sig = `${zip}.sig`;
  console.log(`    from: ${url}`);
  try { await download(url, zip); } catch (e) { die(`download failed (${e.message}) — check your connection and re-run`); }
  try { await download(`${url}.sig`, sig); } catch (_) { /* no sig published */ }

  // FAIL-CLOSED: a missing OR invalid signature refuses extraction unless --allow-unsigned.
  const v = verify(zip, sig);
  if (!v.ok) {
    if (v.reason.startsWith('signature missing') && ALLOW_UNSIGNED) { console.log('    ! signature missing — proceeding under --allow-unsigned'); }
    else die(`bundle signature check FAILED — ${v.reason}. Refusing to extract. (Override a MISSING sig with --allow-unsigned.)`);
  } else { console.log(`    ✓ ${v.reason}`); }

  fs.mkdirSync(KB, { recursive: true });
  const uz = spawnSync('unzip', ['-q', '-o', zip, '-d', KB], { stdio: 'inherit' });
  if (uz.error || uz.status !== 0) die(`unzip failed (${uz.error ? uz.error.message : 'exit ' + uz.status}) — is \`unzip\` installed?`);

  // The archive extracts a top-level ruvnet-brain/ folder; lift its contents up one level.
  const nested = path.join(KB, 'ruvnet-brain');
  if (fs.existsSync(path.join(nested, 'forge-mcp-all.mjs'))) {
    for (const e of fs.readdirSync(nested)) { const to = path.join(KB, e); fs.rmSync(to, { recursive: true, force: true }); fs.renameSync(path.join(nested, e), to); }
    fs.rmdirSync(nested);
  }
  if (!fs.existsSync(path.join(KB, 'forge-mcp-all.mjs'))) die(`unpacked but forge-mcp-all.mjs is missing from ${KB} — archive layout may have changed`);
  // Record WHICH release we installed: the bundle's inner package.json can lag
  // the release tag (v3.3.1 ships version 3.3.0), which would read as
  // permanently-STALE. The tag we downloaded is the authoritative identity.
  try { fs.writeFileSync(path.join(KB, '.release-tag'), tag + '\n'); } catch (_) { /* freshness falls back to package.json */ }
  console.log('    ✓ brain unpacked');
})();
NODE
  if KB_DIR="$KB_DIR" ALLOW_UNSIGNED="$BRAIN_ALLOW_UNSIGNED" node "$DL"; then
    KB_PRESENT=1; KB_REFRESHED="$BRAIN_REFRESH"
    fix "Downloaded + verified + unpacked ruvnet-brain KB into $KB_DIR"; pass "KB installed at $KB_DIR"
  else
    if [[ -f "$MCP_MARKER" ]]; then
      KB_PRESENT=1
      warn "brain refresh download/verify failed — existing KB left as-is (see messages above)"
    else
      warn "brain download/verify failed — KB still MISSING (see messages above)"
    fi
  fi
  rm -f "$DL"
fi

# ── Step 1.5: KB freshness (BRAIN-KB-REFRESH-V1) ────────────────────────────
# Compare the installed KB's package.json version against the newest GitHub
# Release tag. Network-gated (6s), NON-fatal: offline/API failure reads as
# UNKNOWN (info, exit unchanged). Test/offline override: KIT_TEST_BRAIN_LATEST.
brain_latest_tag() {
  [[ -n "${KIT_TEST_BRAIN_LATEST:-}" ]] && { echo "${KIT_TEST_BRAIN_LATEST#v}"; return; }
  curl -fsSL --max-time 6 -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/stuinfla/ruvnet-brain/releases/latest" 2>/dev/null \
    | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name"[^"]*"v?([^"]+)".*/\1/'
}

header "1.5" "KB freshness (BRAIN-KB-REFRESH-V1)"
if [[ "$KB_PRESENT" -ne 1 ]]; then
  info "KB not present — freshness not applicable"
else
  # Prefer the kit's .release-tag marker (written at download time): the bundle's
  # inner package.json can lag the release tag (v3.3.1 ships version 3.3.0 → a
  # false permanent STALE). Upstream-installed KBs have no marker → package.json.
  KB_LOCAL_VER="$(head -1 "$KB_DIR/.release-tag" 2>/dev/null | tr -d '[:space:]')"
  KB_LOCAL_VER="${KB_LOCAL_VER#v}"
  [[ -z "$KB_LOCAL_VER" ]] && KB_LOCAL_VER="$(node -p "require('$KB_DIR/package.json').version" 2>/dev/null || echo '')"
  BRAIN_LATEST="$(brain_latest_tag)"
  if [[ -z "$KB_LOCAL_VER" ]]; then
    info "KB has no readable package.json version — freshness unknown"
  elif [[ -z "$BRAIN_LATEST" ]]; then
    info "could not reach GitHub — freshness UNKNOWN (offline is fine; installed KB v$KB_LOCAL_VER)"
  elif aqe_semver_lt "$KB_LOCAL_VER" "$BRAIN_LATEST"; then
    warn "KB v$KB_LOCAL_VER is STALE — released v$BRAIN_LATEST is newer"
    info "refresh: bin/ruflo-kit fix-brain $TARGET_DIR --refresh    (or: npx ruvnet-brain --update)"
  else
    pass "KB v$KB_LOCAL_VER is current (latest release v$BRAIN_LATEST)"
  fi
fi

# ── Step 2: ensure the local reader deps live in the KB dir ─────────────────
header "2" "Local reader deps (@ruvector/rvf + @xenova/transformers)"
reader_ok() { [[ -d "$KB_DIR/node_modules/@ruvector" && -f "$KB_DIR/node_modules/@xenova/transformers/package.json" ]]; }
if [[ "$KB_PRESENT" -ne 1 ]]; then
  info "KB not present — nothing to install into yet (run with --download or set RUVNET_BRAIN_KB)"
elif [[ "$KB_REFRESHED" -ne 1 ]] && reader_ok; then
  # after a --refresh the bundle ships a new package-lock — presence of an OLD
  # node_modules must not skip the reinstall, so the early-pass is refresh-gated
  pass "reader deps present (vector reads run offline — no cloud, no API key)"
elif [[ "$DRY_RUN" -eq 1 ]]; then
  info "[dry-run] would run npm install in $KB_DIR to add the reader deps"
elif ! command -v npm >/dev/null 2>&1; then
  warn "npm not found — cannot install the reader; install Node.js (includes npm) and re-run"
else
  info "installing the local reader in $KB_DIR (pins from its package-lock.json when present) …"
  if [[ -f "$KB_DIR/package-lock.json" ]]; then _NPM=(ci); else _NPM=(i); fi
  if ( cd "$KB_DIR" && npm "${_NPM[@]}" --no-audit --no-fund --loglevel=error \
         >/tmp/fix-brain-reader.log 2>&1 ) && reader_ok; then
    fix "Installed ruvnet-brain reader deps in $KB_DIR"; pass "reader installed"
  elif [[ "${_NPM[0]}" == "ci" ]] && ( cd "$KB_DIR" && npm i --no-audit --no-fund --loglevel=error \
         >/tmp/fix-brain-reader.log 2>&1 ) && reader_ok; then
    fix "Installed ruvnet-brain reader deps in $KB_DIR (npm i fallback)"; pass "reader installed"
  else
    warn "reader install did not complete (see /tmp/fix-brain-reader.log) — searches will fail until fixed"
  fi
fi

# ── Step 3: register the MCP server in the target .mcp.json ──────────────────
header "3" "Register ruvnet-brain MCP server (.mcp.json)"
if [[ ! -f "$SERVER_MJS" ]]; then
  warn "vendored launcher missing: $SERVER_MJS — cannot register (is vendor/ruvnet-brain present?)"
elif [[ ! -f "$MCP_JSON" ]]; then
  warn "no .mcp.json at $TARGET_DIR — run ruflo/aqe init first, then re-run fix-brain"
elif [[ "$DRY_RUN" -eq 1 ]]; then
  info "[dry-run] would register server 'ruvnet-brain' → node $SERVER_MJS (env RUVNET_BRAIN_KB=$KB_DIR)"
else
  backup "$MCP_JSON" fixbrain-bak
  RES="$(SERVER_MJS="$SERVER_MJS" KB_DIR="$KB_DIR" node -e '
    const fs=require("fs"),F=process.argv[1];
    let s; try{s=JSON.parse(fs.readFileSync(F,"utf8"))}catch(e){console.log("INVALID_JSON");process.exit(0)}
    s.mcpServers=s.mcpServers||{};
    const want={command:"node",args:[process.env.SERVER_MJS],env:{RUVNET_BRAIN_KB:process.env.KB_DIR}};
    const cur=s.mcpServers["ruvnet-brain"];
    if(cur&&JSON.stringify(cur)===JSON.stringify(want)){console.log("UNCHANGED");process.exit(0)}
    s.mcpServers["ruvnet-brain"]=want;
    fs.writeFileSync(F,JSON.stringify(s,null,2)+"\n");console.log(cur?"UPDATED":"CHANGED");
  ' "$MCP_JSON" 2>/dev/null)"
  if node -e "JSON.parse(require('fs').readFileSync('$MCP_JSON','utf8'))" 2>/dev/null; then
    case "$RES" in
      CHANGED)   fix "Registered ruvnet-brain MCP server in .mcp.json (BRAIN-MCP-V1)"; pass "ruvnet-brain MCP registered (node $SERVER_MJS)";;
      UPDATED)   fix "Updated ruvnet-brain MCP server entry in .mcp.json (BRAIN-MCP-V1)"; pass "ruvnet-brain MCP entry updated (KB/launcher path changed)";;
      UNCHANGED) pass "ruvnet-brain MCP server already registered";;
      INVALID_JSON) warn ".mcp.json is not valid JSON — cannot register; fix it and re-run";;
      *)         warn ".mcp.json registration inconclusive ($RES)";;
    esac
  else
    warn ".mcp.json became invalid — restoring backup"; [[ -e "$MCP_JSON.fixbrain-bak" ]] && cp "$MCP_JSON.fixbrain-bak" "$MCP_JSON"
  fi

  # settings.json enablement: project-scope MCP servers are gated by the
  # enabledMcpjsonServers allowlist (MCP-COUNT-PATCH-V1 semantics) — without
  # this the statusline MCP chip counts ruvnet-brain as registered-but-disabled
  # (●3/4) and older Claude Code builds may not load it at all. Mirrors
  # fix-aqe's claude-flow enablement; idempotent membership check.
  BRAIN_SETTINGS="$TARGET_DIR/.claude/settings.json"
  if [[ -f "$BRAIN_SETTINGS" ]]; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] would ensure enabledMcpjsonServers includes ruvnet-brain"
    else
      RESEN="$(node -e '
        const fs=require("fs"),F=process.argv[1];
        let s;try{s=JSON.parse(fs.readFileSync(F,"utf8"))}catch(e){console.log("INVALID_JSON");process.exit(0)}
        const arr=Array.isArray(s.enabledMcpjsonServers)?s.enabledMcpjsonServers:null;
        if(!arr){console.log("NO_ALLOWLIST");process.exit(0)}
        if(arr.includes("ruvnet-brain")){console.log("UNCHANGED");process.exit(0)}
        arr.push("ruvnet-brain");
        fs.writeFileSync(F,JSON.stringify(s,null,2)+"\n");console.log("CHANGED");
      ' "$BRAIN_SETTINGS" 2>/dev/null)"
      case "$RESEN" in
        CHANGED)      fix "enabledMcpjsonServers += ruvnet-brain (MCP chip 4/4)"; pass "ruvnet-brain enabled in settings.json";;
        UNCHANGED)    pass "ruvnet-brain already in enabledMcpjsonServers";;
        NO_ALLOWLIST) pass "no enabledMcpjsonServers allowlist — all project servers load (nothing to do)";;
        INVALID_JSON) warn ".claude/settings.json is not valid JSON — cannot enable ruvnet-brain";;
        *)            warn "settings.json enablement inconclusive ($RESEN)";;
      esac
    fi
  fi
fi

# ── Step 4: health probe (node-loads the MCP server; optional handshake) ─────
header "4" "Health probe"
if [[ "$KB_PRESENT" -ne 1 ]]; then
  info "KB not present — skipping probe (install the KB first)"
elif ! node --check "$MCP_MARKER" 2>/dev/null; then
  warn "forge-mcp-all.mjs did not parse under node --check — the KB may be incomplete"
else
  pass "forge-mcp-all.mjs loads (node --check clean)"
  if [[ -f "$SERVER_MJS" ]] && reader_ok; then
    # shared handshake probe (common.sh) — timeout is soft: the first run may be
    # warming the local model, so NORESP is a warn, never a fail
    case "$(RUVNET_BRAIN_KB="$KB_DIR" mcp_initialize_probe 6 node "$SERVER_MJS")" in
      PROBE_OK)     pass "MCP initialize handshake answered — search_ruvnet server is live";;
      PROBE_NORESP) warn "server launched but did not answer initialize in time (first-run model warmup?) — verify in a live session";;
      *)            warn "MCP server probe inconclusive — verify search_ruvnet in a live Claude Code session";;
    esac
  else
    info "reader deps absent — skipped the live MCP handshake (node-load check passed)"
  fi
fi

echo -e "\n============================================"
echo " fix-brain complete — ${FIXES} change(s)"
for l in "${FIX_LOG[@]:-}"; do [[ -n "$l" ]] && echo "   • $l"; done
[[ "$KB_PRESENT" -ne 1 ]] && echo "   → KB still MISSING — re-run with --download to fetch it"
echo "============================================"
