/**
 * Tests for tools/dashboard/page.cjs (DASHBOARD-PAGE-V1).
 *
 * Two properties that no other test would catch:
 *
 *  1. THEME PARITY. The palette is declared three times — the
 *     prefers-color-scheme media query, and the two explicit
 *     :root[data-theme=...] overrides the viewer's toggle needs in order to
 *     win in BOTH directions. A token defined in one block but forgotten in
 *     another renders a card with a light border on a dark ground, and only a
 *     human looking at the right tab would ever notice.
 *
 *  2. SELF-CONTAINMENT. The page must work on a laptop with no internet —
 *     which is exactly when an operator is debugging. No CDN, no webfont, no
 *     remote image.
 */

'use strict';

const path = require('path');
const { renderPage, esc } = require(path.resolve(__dirname, '../tools/dashboard/page.cjs'));

const HTML = renderPage('/some/target/path');

/** Pull the custom properties declared inside one CSS block.
 *  `pattern` is a regex SOURCE for the selector — callers escape it, so the
 *  media-query block can be matched too. */
function tokensIn(pattern) {
  const m = HTML.match(new RegExp(`${pattern}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`no CSS block matching /${pattern}/`);
  return new Set([...m[1].matchAll(/(--[a-z0-9-]+)\s*:/g)].map((x) => x[1]));
}

const DARK_SEL = ':root\\[data-theme="dark"\\]';
const LIGHT_SEL = ':root\\[data-theme="light"\\]';
const MEDIA_SEL = '@media \\(prefers-color-scheme:dark\\)\\s*\\{\\s*:root';

describe('theme parity', () => {
  // `^:root` anchored at a line start so it matches the FIRST (base) block
  // and not the themed overrides.
  const base = tokensIn('\\n:root');

  it('defines a palette on :root at all (control)', () => {
    expect(base.size).toBeGreaterThan(10);
    for (const need of ['--bg', '--ink', '--accent', '--ok', '--warn', '--fail', '--unknown']) {
      expect(base.has(need), `:root is missing ${need}`).toBe(true);
    }
  });

  for (const [name, sel] of [['media query', MEDIA_SEL], ['data-theme=dark', DARK_SEL], ['data-theme=light', LIGHT_SEL]]) {
    it(`redefines every themed token in the ${name} block`, () => {
      const block = tokensIn(sel);
      // Every colour token on :root must be answered here. Layout tokens
      // (--radius, --mono) are theme-independent and correctly absent.
      const themed = [...base].filter((t) => !['--radius', '--mono'].includes(t));
      for (const t of themed) {
        expect(block.has(t), `${name} is missing ${t} — it would inherit the light value`).toBe(true);
      }
    });
  }

  it('gives dark and light overrides an identical token set', () => {
    expect([...tokensIn(DARK_SEL)].sort()).toEqual([...tokensIn(LIGHT_SEL)].sort());
  });

  it('actually differs between themes (not three copies of one palette)', () => {
    // Positive control: parity above would be satisfied by pasting the light
    // palette into all three blocks.
    const darkBlock = HTML.match(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/)[1];
    const lightBlock = HTML.match(/:root\[data-theme="light"\]\s*\{([^}]*)\}/)[1];
    expect(darkBlock.trim()).not.toBe(lightBlock.trim());
  });
});

describe('self-containment', () => {
  it('references no external host', () => {
    expect(HTML).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
  });

  it('loads no external stylesheet, script, font or image', () => {
    expect(HTML).not.toMatch(/<link[^>]+rel=["']?stylesheet/i);
    expect(HTML).not.toMatch(/<script[^>]+src=/i);
    expect(HTML).not.toMatch(/@import/i);
    expect(HTML).not.toMatch(/url\(\s*["']?(?!data:)https?:/i);
  });

  it('inlines its own style and script', () => {
    expect(HTML).toMatch(/<style>/);
    expect(HTML).toMatch(/<script>/);
  });
});

describe('rendering the target', () => {
  it('shows the target path verbatim so two windows cannot be confused', () => {
    expect(HTML).toContain('/some/target/path');
  });

  it('escapes a hostile target path instead of injecting markup', () => {
    const nasty = renderPage('/tmp/<script>alert(1)</script>&"x');
    expect(nasty).not.toContain('<script>alert(1)</script>');
    expect(nasty).toContain('&lt;script&gt;');
  });
});

describe('esc', () => {
  it('escapes every HTML-significant character', () => {
    expect(esc(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
  });

  it('renders null and undefined as empty, never as the words', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
    expect(esc(0)).toBe('0');
  });
});
