/**
 * CORS + Private Network Access headers for the companion proxy.
 *
 * The browser is on an HTTPS page and the companion is on plain-HTTP loopback. Browsers permit that
 * (loopback is a potentially-trustworthy origin, exempt from mixed-content blocking) but only through
 * a stricter door than ordinary CORS:
 *
 *  - The PREFLIGHT carries `Access-Control-Request-Private-Network: true` when a public-origin page
 *    reaches into a private/loopback address. Answering without
 *    `Access-Control-Allow-Private-Network: true` fails the request before the real POST is sent —
 *    and the failure surfaces in the browser as a generic network error, which is why this header
 *    being missing looks exactly like "the companion isn't running".
 *  - `Mcp-Session-Id` must be EXPOSED, not merely allowed. It is a response header, and a
 *    cross-origin reader cannot see one that is not in `Access-Control-Expose-Headers` — the MCP
 *    session would silently restart on every request.
 *
 * Pure functions so both rules are testable without opening a socket.
 */

/** Request/response headers the MCP streamable-HTTP transport needs to cross the origin boundary. */
const ALLOWED_HEADERS = 'content-type, authorization, mcp-session-id, mcp-protocol-version';
const EXPOSED_HEADERS = 'mcp-session-id';
const ALLOWED_METHODS = 'POST, GET, DELETE, OPTIONS';

/**
 * Build the response headers for one request.
 *
 * @param {string} allowOrigin The app origin the user paired with, or `*` for any.
 * @param {boolean} isPreflight Whether this is the OPTIONS preflight.
 * @param {boolean} requestsPrivateNetwork Whether the preflight asked for private-network access.
 * @returns {Record<string, string>}
 */
export function buildCorsHeaders(allowOrigin, isPreflight, requestsPrivateNetwork) {
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Expose-Headers': EXPOSED_HEADERS,
    Vary: 'Origin',
  };

  if (isPreflight) {
    headers['Access-Control-Allow-Methods'] = ALLOWED_METHODS;
    headers['Access-Control-Allow-Headers'] = ALLOWED_HEADERS;
    headers['Access-Control-Max-Age'] = '600';

    if (requestsPrivateNetwork) {
      headers['Access-Control-Allow-Private-Network'] = 'true';
    }
  }

  return headers;
}

/**
 * Which origin to echo back.
 *
 * With `--origin` set we echo only that exact origin (and refuse to reflect anything else, so a
 * random page cannot talk to the editor). With no restriction configured we answer `*` — acceptable
 * only because the pairing TOKEN, not the origin, is what actually authorises a request.
 *
 * @param {string | undefined} requestOrigin
 * @param {string | undefined} allowedOrigin
 * @returns {string | null} The value to send, or null when the origin is not allowed.
 */
export function resolveAllowOrigin(requestOrigin, allowedOrigin) {
  if (!allowedOrigin) {
    return '*';
  }

  return requestOrigin === allowedOrigin ? allowedOrigin : null;
}
