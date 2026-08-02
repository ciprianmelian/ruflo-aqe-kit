'use strict';
/**
 * security.cjs — the browser-facing request gate for the operator dashboard.
 *
 * DASHBOARD-GUARD-V1.
 *
 * WHY THIS EXISTS. Binding to 127.0.0.1 keeps the socket off the network, and
 * that is where DASHBOARD-V1 stopped. It is not sufficient:
 *
 *   - DNS REBINDING. A page on the public internet can resolve its own
 *     hostname to 127.0.0.1 and then fetch this server. The socket sees a
 *     perfectly ordinary loopback connection. What gives the attacker away is
 *     the `Host` header, which still carries their domain — so we require it
 *     to be a loopback name.
 *
 *   - ANY OTHER LOCAL PROCESS. Every user-level process on this machine can
 *     reach 127.0.0.1. This server reports installed versions, absolute paths,
 *     store row counts, and can start subprocesses; that is not something to
 *     hand out to whatever else happens to be running. Hence the token.
 *
 *   - CROSS-SITE GETs. Even when the same-origin policy stops an attacker
 *     READING our response, the request still executes — and one of our routes
 *     starts a minutes-long probe run. `Sec-Fetch-Site` and `Origin` reject
 *     those before any work happens.
 *
 * The token is minted per run, delivered in the launch URL's `#fragment`
 * (fragments are never sent to a server, never logged in access logs, and
 * never leak via Referer), moved by the page into sessionStorage, and sent
 * back as a request header. A cross-origin caller cannot set a custom header
 * without a CORS preflight, and this server answers no preflight — so the
 * header doubles as the CSRF defense for the one route that has an effect.
 *
 * Pure functions only: no IO, no server, no globals. Tested directly.
 */

const crypto = require('crypto');

/** Loopback names a browser can legitimately put in `Host` for this server. */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/;

/** Header the page sends the session token in. */
const TOKEN_HEADER = 'x-kit-dashboard-token';

/** Mint a fresh, unguessable per-run session token. */
function mintToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Constant-time token comparison.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself leak length
 * and crash the route — so lengths are checked first and a mismatch returns
 * false rather than throwing. Both operands are hex of known length in normal
 * use; anything else is simply not equal.
 */
function tokenMatches(expected, presented) {
  if (typeof expected !== 'string' || typeof presented !== 'string') return false;
  if (expected.length === 0 || expected.length !== presented.length) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Decide whether to serve a request.
 *
 * Returns `null` when the request may proceed, otherwise
 * `{ status, reason }` describing the refusal. Order matters: transport-level
 * checks (who is asking) run before the credential check, so a rebinding or
 * cross-site attempt is refused without revealing whether a token was valid.
 *
 * @param {object} req         node request-ish: { method, url, headers }
 * @param {object} opts        { token, requireToken }
 */
function gate(req, opts = {}) {
  const headers = (req && req.headers) || {};
  const host = String(headers.host || '').toLowerCase();

  if (!LOOPBACK_HOST.test(host)) {
    return { status: 403, reason: 'unexpected Host header (possible DNS rebinding)' };
  }

  const site = String(headers['sec-fetch-site'] || '').toLowerCase();
  if (site && site !== 'same-origin' && site !== 'none') {
    return { status: 403, reason: 'cross-site request' };
  }

  const origin = String(headers.origin || '').toLowerCase();
  if (origin) {
    let parsed;
    try { parsed = new URL(origin); } catch { return { status: 403, reason: 'unparseable Origin' }; }
    // This server speaks plain HTTP on an exact host:port. Accepting any
    // loopback origin would let a different local web app drive it.
    if (parsed.protocol !== 'http:' || parsed.host !== host) {
      return { status: 403, reason: 'foreign Origin' };
    }
  }

  if (opts.requireToken) {
    if (!tokenMatches(opts.token, String(headers[TOKEN_HEADER] || ''))) {
      return { status: 401, reason: 'missing or invalid session token' };
    }
  }

  return null;
}

/** Headers sent on every response: deny embedding, sniffing, and referrers. */
function hardeningHeaders() {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    // The page is fully self-contained; forbid every external fetch outright
    // so a future edit cannot quietly introduce a CDN dependency.
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
      + "img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
}

module.exports = { gate, mintToken, tokenMatches, hardeningHeaders, LOOPBACK_HOST, TOKEN_HEADER };
