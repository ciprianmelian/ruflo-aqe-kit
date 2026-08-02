/**
 * Tests for tools/dashboard/security.cjs (DASHBOARD-GUARD-V1).
 *
 * The gate is the only thing standing between this server — which reports
 * absolute paths, installed versions and store contents, and can start
 * minutes-long subprocesses — and every other process on the machine, plus
 * any website that points a hostname at 127.0.0.1.
 *
 * ANTI-GOODHART: a gate that refused EVERYTHING would pass every "must be
 * rejected" assertion here. So every rejection test is anchored by an
 * allow-case proving the same input shape is accepted when the one hostile
 * field is corrected.
 */

'use strict';

const path = require('path');
const {
  gate, mintToken, tokenMatches, hardeningHeaders, TOKEN_HEADER,
} = require(path.resolve(__dirname, '../tools/dashboard/security.cjs'));

const TOKEN = 'a'.repeat(64);

/** A well-formed same-origin request from the dashboard's own page. */
function goodReq(extra = {}) {
  return {
    method: 'GET',
    url: '/api/status',
    headers: Object.assign({
      host: '127.0.0.1:7431',
      'sec-fetch-site': 'same-origin',
      origin: 'http://127.0.0.1:7431',
      [TOKEN_HEADER]: TOKEN,
    }, extra),
  };
}

const withToken = { token: TOKEN, requireToken: true };

describe('gate: the allow-case anchor', () => {
  it('allows a well-formed same-origin request carrying the token', () => {
    // THE control. If this ever fails, every rejection test below is
    // satisfied by a gate that simply says no to everything.
    expect(gate(goodReq(), withToken)).toBeNull();
  });

  it('allows every loopback spelling a browser may legitimately send', () => {
    for (const host of ['127.0.0.1:7431', 'localhost:7431', '[::1]:7431', '127.0.0.1', 'localhost']) {
      const req = goodReq({ host });
      delete req.headers.origin; // origin must match host exactly; drop it here
      expect(gate(req, withToken), `rejected ${host}`).toBeNull();
    }
  });

  it('allows a direct navigation (no Origin, Sec-Fetch-Site: none)', () => {
    const req = goodReq({ 'sec-fetch-site': 'none' });
    delete req.headers.origin;
    expect(gate(req, withToken)).toBeNull();
  });
});

describe('gate: DNS rebinding', () => {
  it('rejects a foreign Host even though the socket is loopback', () => {
    // The attack: attacker.com resolves to 127.0.0.1, the browser connects
    // locally, but the Host header still names the attacker's domain.
    const r = gate(goodReq({ host: 'attacker.example.com' }), withToken);
    expect(r.status).toBe(403);
    expect(r.reason).toMatch(/Host/);
  });

  it('rejects hosts that merely embed a loopback substring', () => {
    for (const host of ['127.0.0.1.evil.com', 'localhost.attacker.net', 'notlocalhost', 'evil.com:7431']) {
      expect(gate(goodReq({ host }), withToken), `allowed ${host}`).not.toBeNull();
    }
  });

  it('rejects a missing Host header outright', () => {
    const req = goodReq(); delete req.headers.host;
    expect(gate(req, withToken).status).toBe(403);
  });
});

describe('gate: cross-site requests', () => {
  it('rejects cross-site and same-site fetches before any work happens', () => {
    for (const site of ['cross-site', 'same-site']) {
      const r = gate(goodReq({ 'sec-fetch-site': site }), withToken);
      expect(r.status).toBe(403);
      expect(r.reason).toMatch(/cross-site/);
    }
  });

  it('rejects a foreign Origin on an otherwise perfect request', () => {
    const r = gate(goodReq({ origin: 'http://evil.example.com' }), withToken);
    expect(r.status).toBe(403);
    expect(r.reason).toMatch(/Origin/);
  });

  it('rejects another local app on a DIFFERENT loopback port', () => {
    // Same machine, same loopback, different origin — still not us.
    const r = gate(goodReq({ origin: 'http://127.0.0.1:9999' }), withToken);
    expect(r.status).toBe(403);
  });

  it('rejects an https Origin (this server is plain http)', () => {
    expect(gate(goodReq({ origin: 'https://127.0.0.1:7431' }), withToken).status).toBe(403);
  });

  it('rejects an unparseable Origin', () => {
    expect(gate(goodReq({ origin: 'not a url' }), withToken).status).toBe(403);
  });
});

describe('gate: the session token', () => {
  it('rejects a missing, empty, wrong, or truncated token', () => {
    const bad = [undefined, '', 'b'.repeat(64), TOKEN.slice(0, 63), `${TOKEN}x`];
    for (const t of bad) {
      const req = goodReq();
      if (t === undefined) delete req.headers[TOKEN_HEADER];
      else req.headers[TOKEN_HEADER] = t;
      const r = gate(req, withToken);
      expect(r, `accepted token ${JSON.stringify(t)}`).not.toBeNull();
      expect(r.status).toBe(401);
    }
  });

  it('skips the token check only where the caller opts out (the page itself)', () => {
    const req = goodReq(); delete req.headers[TOKEN_HEADER];
    expect(gate(req, { token: TOKEN, requireToken: false })).toBeNull();
    expect(gate(req, withToken).status).toBe(401);
  });

  it('refuses transport-level attackers BEFORE checking credentials', () => {
    // A valid token must not rescue a rebinding attempt, and the refusal must
    // not reveal whether the token was right.
    const r = gate(goodReq({ host: 'evil.example.com' }), withToken);
    expect(r.status).toBe(403);
    expect(r.reason).not.toMatch(/token/);
  });
});

describe('tokenMatches', () => {
  it('accepts an exact match and rejects everything else', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(TOKEN, TOKEN.toUpperCase())).toBe(false);
    expect(tokenMatches(TOKEN, `${TOKEN} `)).toBe(false);
  });

  it('never throws on length mismatch or non-strings', () => {
    // crypto.timingSafeEqual throws on unequal lengths; an unguarded call
    // would turn a wrong-length token into a 500 instead of a 401.
    for (const [a, b] of [[TOKEN, 'short'], ['', ''], [null, TOKEN], [TOKEN, undefined], [{}, []]]) {
      expect(() => tokenMatches(a, b)).not.toThrow();
      expect(tokenMatches(a, b)).toBe(false);
    }
  });

  it('never treats an empty expected token as a wildcard', () => {
    expect(tokenMatches('', '')).toBe(false);
    expect(tokenMatches('', 'anything')).toBe(false);
  });
});

describe('mintToken', () => {
  it('produces a long, unguessable, unique hex token each run', () => {
    const a = mintToken(); const b = mintToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    const many = new Set(Array.from({ length: 50 }, mintToken));
    expect(many.size).toBe(50);
  });
});

describe('hardeningHeaders', () => {
  it('denies framing, sniffing, referrers, and caching', () => {
    const h = hardeningHeaders();
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['cache-control']).toBe('no-store');
  });

  it('ships a CSP that forbids every off-origin fetch', () => {
    const csp = hardeningHeaders()['content-security-policy'];
    expect(csp).toMatch(/default-src 'none'/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    // connect-src must stay 'self' — the page is self-contained by contract,
    // and a future edit adding a CDN should fail here first.
    expect(csp).toMatch(/connect-src 'self'/);
    expect(csp).not.toMatch(/https?:\/\//);
  });
});
