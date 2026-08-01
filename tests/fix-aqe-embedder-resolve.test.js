/**
 * Tests for lib/fix-aqe.sh Step 8b — AQE-EMBEDDER-RESOLVE-V1.
 *
 * agentic-qe's real-embeddings.js imports '@huggingface/transformers', but
 * agentic-qe declares that package in devDependencies ONLY, so `npm i -g` never
 * installs it and in-process embeddings are silently dead (the caller swallows
 * the throw at console.debug; experience rows keep landing with embedding NULL).
 * Step 8b heals it by installing the package TOP-LEVEL in the global npm root,
 * and asserts the PROPERTY — "can agentic-qe resolve it?" — never "does
 * directory X exist?", so it self-retires if upstream ever promotes the dep.
 *
 * The load-bearing detail under test is how the package's DIRECTORY and VERSION
 * are discovered. The obvious way — require.resolve('<pkg>/package.json') — is
 * WRONG for this package: its exports map denies that subpath, so the call
 * throws ERR_PACKAGE_PATH_NOT_EXPORTED. That yielded an empty version, which in
 * the first draft of Step 8b silently SKIPPED the version-floor check and made
 * Step 9 take its "not assessable" branch while the package was in fact fine.
 * `_emb_pkg_info` therefore walks up from the resolved ENTRY and confirms the
 * manifest name matches.
 *
 * Everything runs against a synthetic npm-root tree — no global installs, no
 * network, no model load. The fixture package reproduces the real exports map.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const FIX_AQE = path.join(REPO, 'lib', 'fix-aqe.sh');

// ---- extract the REAL shell function, verbatim, and run it -----------------
// Not a reimplementation: if _emb_pkg_info changes, these tests follow it.
// A naive /\n\}/ match truncates here: the embedded `node -e '...'` script has
// its own lines that are exactly "}", and cutting there yields a bash SYNTAX
// ERROR (rc 2) — which every "expect(rc).not.toBe(0)" test would have accepted
// as a pass. So track single-quote state and stop at the first top-level "}"
// that is outside the quoted script.
function extractShellFn(name) {
  const lines = fs.readFileSync(FIX_AQE, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
  if (start < 0) throw new Error(`could not find ${name}() in lib/fix-aqe.sh`);
  let inSingleQuote = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (i > start && !inSingleQuote && line === '}') return lines.slice(start, i + 1).join('\n');
    if (((line.match(/'/g) || []).length) % 2 === 1) inSingleQuote = !inSingleQuote;
  }
  throw new Error(`unterminated ${name}() in lib/fix-aqe.sh`);
}

function runEmbPkgInfo(reJsPath) {
  const script = `RE_JS=${JSON.stringify(reJsPath)}\n${extractShellFn('_emb_pkg_info')}\n_emb_pkg_info`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return { rc: r.status, out: (r.stdout || '').trim() };
}

/**
 * PRE-FIX FIXTURE — embedded as a literal, NOT reconstructed from git.
 * A teeth test pinned to HEAD expires the moment its fix is committed; this
 * one cannot. This is exactly what the first draft of Step 8b/9 ran.
 */
const PRE_FIX_RESOLVE = `
const p = require("module").createRequire(process.argv[1])
  .resolve("@huggingface/transformers/package.json");
process.stdout.write(require("path").dirname(p));
`;

function runPreFixResolve(reJsPath) {
  const r = spawnSync('node', ['-e', PRE_FIX_RESOLVE, reJsPath], { encoding: 'utf8' });
  return { rc: r.status, out: (r.stdout || '').trim(), err: r.stderr || '' };
}

// ---- synthetic global-root fixture ----------------------------------------
// Mirrors the real layout: agentic-qe nested deep, transformers TOP-LEVEL, and
// an exports map that denies "./package.json" exactly as 4.2.0's does.
function makeTree({ withPkg = true, version = '4.2.0', withCache = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-emb-'));
  const nm = path.join(root, 'node_modules');
  const reDir = path.join(nm, 'agentic-qe', 'dist', 'learning');
  fs.mkdirSync(reDir, { recursive: true });
  const reJs = path.join(reDir, 'real-embeddings.js');
  fs.writeFileSync(reJs, '// stub real-embeddings.js\n');

  let pkgDir = null;
  if (withPkg) {
    pkgDir = path.join(nm, '@huggingface', 'transformers');
    fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'dist', 'transformers.node.cjs'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: '@huggingface/transformers',
      version,
      main: 'dist/transformers.node.cjs',
      // The load-bearing bit: "." only. No "./package.json" subpath.
      exports: { '.': { require: './dist/transformers.node.cjs' } },
    }, null, 2));
    if (withCache) {
      const onnx = path.join(pkgDir, '.cache', 'Xenova', 'all-MiniLM-L6-v2', 'onnx');
      fs.mkdirSync(onnx, { recursive: true });
      fs.writeFileSync(path.join(onnx, 'model.onnx'), 'stub-weights');
    }
  }
  return { root, reJs, pkgDir };
}

const trees = [];
function tree(opts) { const t = makeTree(opts); trees.push(t); return t; }
afterAll(() => {
  for (const t of trees) { try { fs.rmSync(t.root, { recursive: true, force: true }); } catch (e) {} }
});

suite('AQE-EMBEDDER-RESOLVE-V1 — package discovery survives the exports map', () => {
  it('extracts a syntactically valid function — guards every rc!=0 test below', () => {
    // Without this, a truncated extraction yields bash rc 2 and the negative
    // tests below pass for entirely the wrong reason.
    const fn = extractShellFn('_emb_pkg_info');
    expect(fn.trimEnd().endsWith('}')).toBe(true);
    expect(fn).toMatch(/process\.exit\(1\)/);
    expect(spawnSync('bash', ['-n', '-c', fn], { encoding: 'utf8' }).status).toBe(0);
  });

  it('TEETH: the pre-fix resolve("<pkg>/package.json") FAILS on the real exports map', () => {
    const t = tree({ withPkg: true });
    const r = runPreFixResolve(t.reJs);
    // This is the defect, reproduced: the package is present and importable,
    // yet the old discovery path errors out and yields nothing.
    expect(r.rc).not.toBe(0);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/ERR_PACKAGE_PATH_NOT_EXPORTED/);
  });

  it('_emb_pkg_info discovers dir AND version on that same tree', () => {
    const t = tree({ withPkg: true, version: '4.2.0' });
    const { rc, out } = runEmbPkgInfo(t.reJs);
    expect(rc).toBe(0);
    const [dir, ver] = out.split('\t');
    expect(fs.realpathSync(dir)).toBe(fs.realpathSync(t.pkgDir));
    expect(ver).toBe('4.2.0');
  });

  it('reports a NON-EMPTY version, so the floor check cannot be silently skipped', () => {
    // The first draft passed the floor gate whenever version was '' — i.e. it
    // could not tell "floor satisfied" from "could not read the manifest".
    const t = tree({ withPkg: true, version: '3.0.0' });
    const { rc, out } = runEmbPkgInfo(t.reJs);
    expect(rc).toBe(0);
    expect(out.split('\t')[1]).toBe('3.0.0');
  });

  it('fails cleanly (rc!=0, no output) when the package is absent', () => {
    const t = tree({ withPkg: false });
    const { rc, out } = runEmbPkgInfo(t.reJs);
    expect(rc).not.toBe(0);
    expect(out).toBe('');
  });

  it('fails cleanly when real-embeddings.js itself is absent', () => {
    const t = tree({ withPkg: true });
    fs.rmSync(t.reJs);
    const { rc, out } = runEmbPkgInfo(t.reJs);
    expect(rc).not.toBe(0);
    expect(out).toBe('');
  });

  it('walks up to the OWNING package, never a parent manifest', () => {
    // The entry sits in dist/; the walk must stop at the package whose manifest
    // name matches, not at any ancestor package.json it meets first.
    const t = tree({ withPkg: true });
    fs.writeFileSync(path.join(t.root, 'package.json'),
      JSON.stringify({ name: 'some-parent', version: '9.9.9' }));
    const { rc, out } = runEmbPkgInfo(t.reJs);
    expect(rc).toBe(0);
    const [dir, ver] = out.split('\t');
    expect(ver).toBe('4.2.0');
    expect(path.basename(dir)).toBe('transformers');
  });
});

suite('AQE-EMBEDDER-RESOLVE-V1 — Step 8b/9 wiring in lib/fix-aqe.sh', () => {
  const src = fs.readFileSync(FIX_AQE, 'utf8');

  it('Step 9 derives the cache dir from the resolved package, not a hardcoded path', () => {
    // The old probe hardcoded agentic-qe/node_modules/@huggingface/transformers,
    // a path that CANNOT exist (devDependencies-only), so it took its else
    // branch unconditionally and only ever printed "weights not in cache".
    expect(src).not.toMatch(
      /MC_ONNX_DIR=.*agentic-qe\/node_modules\/@huggingface\/transformers/);
    expect(src).toMatch(/MC_PKG_DIR="\$\(_emb_pkg_info\)"/);
  });

  it('Step 9 has a distinct NOT-ASSESSABLE state separate from a cache miss', () => {
    expect(src).toMatch(/NOT ASSESSABLE/);
  });

  it('Step 8b warns rather than passing when the version cannot be determined', () => {
    expect(src).toMatch(/floor \$KIT_HF_TRANSFORMERS_MIN NOT verified/);
  });

  it('Step 8b asserts a version FLOOR, never equality', () => {
    expect(src).toMatch(/KIT_HF_TRANSFORMERS_MIN="\d+\.\d+\.\d+"/);
    expect(src).toMatch(/aqe_semver_lt "\$EMB_VER" "\$KIT_HF_TRANSFORMERS_MIN"/);
  });

  it('Step 8b is monotone — it installs, and never removes a rival copy', () => {
    const step = src.slice(src.indexOf('Step 8b'), src.indexOf('Step 9:'));
    expect(step).toMatch(/kit_npm_global_install/);
    expect(step).not.toMatch(/\brm -rf?\b|\bunlink\b/);
  });

  it('the embedder natives are in the npm allow-scripts list', () => {
    // onnxruntime-node's postinstall fetches the native dylib. Blocked, the
    // package still RESOLVES and dies at first inference — the same silent
    // failure Step 8b exists to prevent.
    const common = fs.readFileSync(path.join(REPO, 'lib', 'common.sh'), 'utf8');
    const m = common.match(/^KIT_NPM_ALLOW_LIST="([^"]*)"/m);
    expect(m).toBeTruthy();
    expect(m[1].split(',')).toEqual(expect.arrayContaining(['onnxruntime-node', 'sharp']));
  });
});
