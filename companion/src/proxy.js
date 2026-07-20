/**
 * The companion reverse proxy.
 *
 * Sits between the browser and the Unity MCP server, adding the two things the browser needs and the
 * MCP server does not provide: the CORS/Private-Network preflight answer, and a pairing token wall.
 *
 * Binds 127.0.0.1 ONLY — never 0.0.0.0. The upstream MCP server defaults to 0.0.0.0:8080, which is
 * reachable from the whole LAN; this process is the part the browser talks to, and it must not widen
 * that exposure. Everything it forwards is the user's own editor, on the user's own machine.
 */
import http from 'node:http';
import { buildCorsHeaders, resolveAllowOrigin } from './headers.js';
import { checkToken } from './token.js';

/**
 * Create (but do not start) the proxy server.
 *
 * @param {object} options
 * @param {number} options.upstreamPort Port of the Unity MCP server to forward to.
 * @param {string} options.token Expected pairing token.
 * @param {string} [options.allowedOrigin] Restrict to one app origin; omitted means any origin.
 * @param {string} [options.upstreamHost] Defaults to 127.0.0.1.
 * @returns {import('node:http').Server}
 */
export function createProxyServer({ upstreamPort, token, allowedOrigin, upstreamHost = '127.0.0.1' }) {
  return http.createServer((req, res) => {
    const requestOrigin = req.headers.origin;
    const allowOrigin = resolveAllowOrigin(requestOrigin, allowedOrigin);

    if (allowOrigin === null) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Origin not allowed by this companion.' }));

      return;
    }

    const isPreflight = req.method === 'OPTIONS';
    const requestsPrivateNetwork = req.headers['access-control-request-private-network'] === 'true';
    const corsHeaders = buildCorsHeaders(allowOrigin, isPreflight, requestsPrivateNetwork);

    /*
     * The preflight is answered WITHOUT a token check, deliberately: a browser never attaches
     * credentials to a preflight, so requiring one here would fail every request before the real POST
     * could present its token.
     */
    if (isPreflight) {
      res.writeHead(204, corsHeaders);
      res.end();

      return;
    }

    if (!checkToken(req.headers.authorization, token)) {
      res.writeHead(401, { ...corsHeaders, 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or invalid companion pairing token.' }));

      return;
    }

    forward(req, res, { upstreamHost, upstreamPort, corsHeaders });
  });
}

/**
 * Pipe the request upstream and the response back, layering the CORS headers on.
 *
 * The upstream's own headers are preserved (notably `Mcp-Session-Id` and the streaming content type)
 * — the proxy adds, it never rewrites the MCP protocol.
 */
function forward(req, res, { upstreamHost, upstreamPort, corsHeaders }) {
  const upstreamHeaders = { ...req.headers, host: `${upstreamHost}:${upstreamPort}` };

  const upstreamReq = http.request(
    { host: upstreamHost, port: upstreamPort, path: req.url, method: req.method, headers: upstreamHeaders },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, { ...upstreamRes.headers, ...corsHeaders });
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.on('error', (error) => {
    /*
     * Only BODY-less failures may carry a JSON explanation. Once headers are out we are mid-response
     * — an MCP body, possibly a stream — and appending an error object there does not report the
     * failure, it CORRUPTS the payload: the client parses our error as the tail of the tool result.
     * A truncated response is a failure the client can detect; a malformed one it cannot.
     */
    if (res.headersSent) {
      res.destroy(error);
      return;
    }

    res.writeHead(502, { ...corsHeaders, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `Unity MCP server unreachable: ${error.message}` }));
  });

  // A browser that navigates away mid-call must not leave the upstream request holding a socket.
  req.on('aborted', () => upstreamReq.destroy());

  req.pipe(upstreamReq);
}
