/**
 * Tests for MEMORY-ROUNDTRIP-V1 (lib/common.sh): kit_memory_roundtrip_check.
 *
 * Background (Wave-2 B13, 2026-07-31): agentic-kit's `ak x verify memory`
 * (vendor/agentic-kit/src/commands/x/verify.mjs:63-115) proved a drift class
 * none of this kit's 15 proof probes see — every existing memory/store check
 * (kit_sqlite_rw_check, the AQE capture-arm wiring check, `stores-writable`)
 * only ever asserts PRESENCE (a store file exists, accepts a write lock,
 * holds rows), never that a value written through the real CLI actually comes
 * back out, or that a purge actually removes it. kit_memory_roundtrip_check
 * runs store -> retrieve -> identify-the-writer -> purge inside a throwaway
 * temp dir using the real `ruflo memory` CLI surface.
 *
 * These tests drive it against a STUB `ruflo` (deterministic, fast, no
 * dependency on a real global install or its ~1s ONNX/GNN warm-up) so the
 * failure fixtures below are reproducible on any host. A final smoke-test
 * block also drives the REAL global `ruflo`, when present, as end-to-end
 * confirmation — skipped (never failed) when `ruflo` is not installed.
 *
 * The centerpiece fixture is "phantom": store silently writes to a side
 * channel instead of the real memory_entries table, and retrieve echoes that
 * side channel back — so a CLI-only store->retrieve check would read this as
 * a perfectly healthy round trip. Only kit_memory_roundtrip_check's
 * independent "identify the writer" step (a second reader, sqlite3, querying
 * the SAME pinned db file directly) catches it. This is the exact class the
 * adoption exists for: a memory layer that accepts a write and returns
 * something plausible on read, without the write ever actually landing.
 */
'use strict';

const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'lib');

const worlds = [];
afterEach(() => {
  while (worlds.length) {
    const w = worlds.pop();
    try { fs.rmSync(w, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function mkBase() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memrt-')));
  worlds.push(base);
  return base;
}

function writeExec(p, body) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
}

// A stub `ruflo` implementing just enough of `memory init/store/retrieve/
// purge` to drive kit_memory_roundtrip_check, backed by a REAL sqlite3 file
// so the independent-reader step is exercised for real (not mocked away).
// Behavior varies by $STUB_RUFLO_VARIANT (set per-test, read at call time —
// NOT baked into the script — so one stub covers every scenario below):
//   healthy       - honest insert / honest read / honest delete.
//   silent-noop   - store claims success (exit 0) but never writes the row;
//                   retrieve is honest, so it correctly finds nothing.
//   phantom       - store claims success but writes the value to a SIDE
//                   FILE instead of memory_entries; retrieve echoes that
//                   side file back regardless of the real table's contents.
//                   A CLI-only round trip (store -> retrieve) looks perfect;
//                   only an independent read of memory_entries sees the row
//                   was never actually stored.
//   phantom-purge - store/retrieve honest; purge claims success (exit 0)
//                   without deleting the row.
const STUB_RUFLO = `#!/usr/bin/env bash
set -u
sub="\${2:-}"
shift 2 2>/dev/null || true
db=""; key=""; ns=""; val=""
while [[ \$# -gt 0 ]]; do
  case "\$1" in
    --path) db="\$2"; shift 2 ;;
    -k|--key) key="\$2"; shift 2 ;;
    -n|--namespace) ns="\$2"; shift 2 ;;
    --value) val="\$2"; shift 2 ;;
    *) shift ;;
  esac
done
variant="\${STUB_RUFLO_VARIANT:-healthy}"
side="\$(dirname "\$db")/.phantom-cache"
case "\$sub" in
  init)
    sqlite3 "\$db" "CREATE TABLE IF NOT EXISTS memory_entries (namespace TEXT, key TEXT, content TEXT, status TEXT DEFAULT 'active');"
    exit 0 ;;
  store)
    case "\$variant" in
      silent-noop) exit 0 ;;
      phantom) printf '%s' "\$val" > "\$side"; exit 0 ;;
      *) sqlite3 "\$db" "INSERT INTO memory_entries(namespace,key,content,status) VALUES('\$ns','\$key','\$val','active');"; exit 0 ;;
    esac ;;
  retrieve)
    case "\$variant" in
      phantom)
        if [[ -f "\$side" ]]; then cat "\$side"; exit 0; fi
        exit 1 ;;
      *)
        row="\$(sqlite3 "\$db" "SELECT content FROM memory_entries WHERE namespace='\$ns' AND key='\$key' AND status='active' LIMIT 1;" 2>/dev/null)"
        if [[ -n "\$row" ]]; then printf '%s' "\$row"; exit 0; else exit 1; fi ;;
    esac ;;
  purge)
    case "\$variant" in
      phantom-purge) exit 0 ;;
      *) sqlite3 "\$db" "DELETE FROM memory_entries WHERE namespace='\$ns';"; exit 0 ;;
    esac ;;
  *) exit 0 ;;
esac
`;

// A PATH dir mirroring every executable on the real PATH except `ruflo` —
// the "no memory layer installed at all" scenario for the not-assessable test.
function mkStrippedOfRuflo(base) {
  const bin = path.join(base, 'stripped-bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const d of (process.env.PATH || '').split(':')) {
    let names;
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (n === 'ruflo') continue;
      try { fs.symlinkSync(path.join(d, n), path.join(bin, n)); } catch { /* dup */ }
    }
  }
  return bin;
}

function mkStubBin(base) {
  const bin = path.join(base, 'stub-bin');
  writeExec(path.join(bin, 'ruflo'), STUB_RUFLO);
  return bin;
}

function mkDriver(base) {
  const drv = path.join(base, 'driver.sh');
  writeExec(drv, `#!/usr/bin/env bash
source "${LIB}/common.sh"
kit_memory_roundtrip_check
echo "rc=$?"
`);
  return drv;
}

function run(base, env, variant) {
  const stub = mkStubBin(base);
  const fullEnv = {
    PATH: `${stub}:${process.env.PATH}`,
    HOME: process.env.HOME,
    RUFLO_DAEMON_AUTOSTART: '0',
    ...(variant ? { STUB_RUFLO_VARIANT: variant } : {}),
    ...env,
  };
  const r = spawnSync('bash', [mkDriver(base)], { encoding: 'utf8', env: fullEnv });
  const lines = (r.stdout || '').trim().split('\n');
  return { code: r.status, verdictLine: lines[0] || '', rcLine: lines[1] || '', stderr: r.stderr || '' };
}

describe('kit_memory_roundtrip_check — stub ruflo (deterministic)', () => {
  it('should_reportHealthy_when_storeRetrieveIndependentReadAndPurgeAllRoundTrip', () => {
    const base = mkBase();

    const r = run(base, {}, 'healthy');

    const [verdict] = r.verdictLine.split('|');
    expect(verdict).toBe('healthy');
    expect(r.rcLine).toBe('rc=0');
  });

  it('should_reportGap_when_storeClaimsSuccessButRetrieveFindsNothing', () => {
    // Falsification #1 (task requirement, literally): a memory layer that
    // accepts a write but returns nothing on read must FAIL the probe.
    const base = mkBase();

    const r = run(base, {}, 'silent-noop');

    const [verdict, detail] = r.verdictLine.split('|');
    expect(verdict).toBe('gap');
    expect(detail).toMatch(/retrieve did not return/i);
    expect(r.rcLine).toBe('rc=1');
  });

  it('should_reportGap_when_theCliRoundTripLooksHealthyButTheRowNeverActuallyLandedOnDisk', () => {
    // Falsification #2, the centerpiece: store->retrieve via the CLI alone
    // looks perfect (retrieve echoes back exactly what was "stored") — only
    // the independent on-disk reader (querying memory_entries directly, a
    // DIFFERENT code path than the one that just claimed success) reveals
    // the write never actually happened. This is the exact "identify the
    // writer" step agentic-kit's verifyMemory (findMemoryEntry) has and a
    // CLI-only round trip does not.
    const base = mkBase();

    const r = run(base, {}, 'phantom');

    const [verdict, detail] = r.verdictLine.split('|');
    expect(verdict).toBe('gap');
    expect(detail).toMatch(/independent sqlite3 read/i);
    expect(r.rcLine).toBe('rc=1');
  });

  it('should_reportGap_when_purgeClaimsSuccessButTheRowIsStillRetrievableAfterward', () => {
    const base = mkBase();

    const r = run(base, {}, 'phantom-purge');

    const [verdict, detail] = r.verdictLine.split('|');
    expect(verdict).toBe('gap');
    expect(detail).toMatch(/purge reported success but/i);
    expect(r.rcLine).toBe('rc=1');
  });

  it('should_reportNotAssessable_notAFalseFail_when_noMemoryLayerIsInstalledAtAll', () => {
    // Falsification #3 (task requirement): an absent memory layer must
    // report not-assessable, never a false FAIL.
    const base = mkBase();
    const stripped = mkStrippedOfRuflo(base);

    const r = spawnSync('bash', [mkDriver(base)], {
      encoding: 'utf8',
      env: { PATH: stripped, HOME: process.env.HOME, RUFLO_DAEMON_AUTOSTART: '0' },
    });
    const lines = (r.stdout || '').trim().split('\n');
    const [verdict] = (lines[0] || '').split('|');

    expect(verdict).toBe('not-assessable');
    expect(verdict).not.toBe('gap'); // never a false FAIL
    expect(lines[1]).toBe('rc=2');
  });
});

describe('kit_memory_roundtrip_check — real global ruflo (smoke test)', () => {
  let hasRuflo = false;
  try {
    execSync('command -v ruflo', { encoding: 'utf8', shell: 'bash', stdio: 'pipe' });
    hasRuflo = true;
  } catch { hasRuflo = false; }

  const maybeIt = hasRuflo ? it : it.skip;

  maybeIt('should_reportHealthy_against_theActualInstalledRufloMemoryCli', () => {
    const base = mkBase();
    const drv = mkDriver(base);
    const r = spawnSync('bash', [drv], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, RUFLO_DAEMON_AUTOSTART: '0' },
      timeout: 120_000,
    });
    const lines = (r.stdout || '').trim().split('\n');
    const [verdict, detail] = (lines[0] || '').split('|');

    expect(verdict).toBe('healthy');
    expect(detail).toMatch(/store -> CLI retrieve -> on-disk confirm/);
    expect(lines[1]).toBe('rc=0');
  }, 120_000);
});
