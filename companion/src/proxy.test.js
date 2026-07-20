/**
 * The proxy driven end-to-end over real sockets: a real stub upstream, the real proxy, real `fetch`.
 *
 * The property that matters most here is NEGATIVE and invisible from a status code alone — an
 * unauthorised request must never REACH the editor. So the stub counts every request it receives and
 * the refusal tests assert that count stayed at zero; a proxy that forwarded first and refused
 * afterwards would still return 401 and pass a status-only test.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxyServer } from './proxy.js';

const TOKEN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const UPSTREAM_BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } });
const SESSION_ID = 'session-abc-123';

/** Everything opened by a test, torn down in `after` so the test process can exit. */
const openServers = [];

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      openServers.push(server);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/** A stub Unity MCP server that records what actually reached it. */
async function startUpstream() {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];

    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'content-type': 'application/json', 'Mcp-Session-Id': SESSION_ID });
      res.end(UPSTREAM_BODY);
    });
  });

  const port = await listen(server);

  return { server, port, received };
}

async function startProxy(options) {
  const server = createProxyServer(options);
  const port = await listen(server);

  return { server, port, url: `http://127.0.0.1:${port}` };
}

/**
 * Let anything already in flight reach the stub before a "nothing arrived" assertion is made.
 *
 * The refusals below are written SYNCHRONOUSLY, so they come back before a forwarded request would
 * have finished — asserting `received.length` the instant `fetch` resolves passes even on a proxy
 * that forwards first and refuses afterwards, which is the exact pathology these tests exist to
 * catch. Verified by mutation: without this settle, the forward-before-auth mutant survived them.
 */
function settle(ms = 150) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A port nothing is listening on: bind then release it. */
async function closedPort() {
  const server = http.createServer();
  const port = await listen(server);

  openServers.splice(openServers.indexOf(server), 1);
  await close(server);

  return port;
}

after(async () => {
  await Promise.all(openServers.map(close));
});

test('OPTIONS preflight is answered locally: 204 + PNA/CORS headers, upstream untouched', async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy({ upstreamPort: upstream.port, token: TOKEN });

  const res = await fetch(`${proxy.url}/mcp`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://app.example.com',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Private-Network': 'true',
    },
  });

  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-private-network'), 'true');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('access-control-expose-headers'), 'mcp-session-id');
  assert.match(res.headers.get('access-control-allow-methods') ?? '', /POST/);

  await settle();
  assert.equal(upstream.received.length, 0, 'the preflight must never be forwarded to the editor');
});

test('POST without Authorization is refused BEFORE the forward', async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy({ upstreamPort: upstream.port, token: TOKEN });

  const res = await fetch(`${proxy.url}/mcp`, {
    method: 'POST',
    headers: { Origin: 'https://app.example.com', 'content-type': 'application/json' },
    body: '{"jsonrpc":"2.0","method":"tools/list","id":1}',
  });

  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /token/i);

  await settle();
  assert.equal(upstream.received.length, 0, 'an unauthorised request reached the editor');
});

test('POST with the wrong token is refused BEFORE the forward', async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy({ upstreamPort: upstream.port, token: TOKEN });

  const res = await fetch(`${proxy.url}/mcp`, {
    method: 'POST',
    headers: { Origin: 'https://app.example.com', Authorization: 'Bearer not-the-token' },
    body: '{}',
  });

  assert.equal(res.status, 401);

  await settle();
  assert.equal(upstream.received.length, 0);
});

test('POST with the correct token forwards, and the upstream body + Mcp-Session-Id survive', async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy({ upstreamPort: upstream.port, token: TOKEN });
  const body = '{"jsonrpc":"2.0","method":"tools/list","id":7}';

  const res = await fetch(`${proxy.url}/mcp`, {
    method: 'POST',
    headers: { Origin: 'https://app.example.com', Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body,
  });

  assert.equal(res.status, 200);
  assert.equal(await res.text(), UPSTREAM_BODY, 'the proxy must not rewrite the MCP payload');
  assert.equal(
    res.headers.get('mcp-session-id'),
    SESSION_ID,
    'losing the session header silently restarts the MCP session on every request',
  );
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('access-control-expose-headers'), 'mcp-session-id');

  assert.equal(upstream.received.length, 1);
  assert.equal(upstream.received[0].method, 'POST');
  assert.equal(upstream.received[0].url, '/mcp');
  assert.equal(upstream.received[0].body, body, 'the request body must reach the editor byte-identical');
});

test('an unreachable upstream is a 502 JSON error, not a crash', async () => {
  const proxy = await startProxy({ upstreamPort: await closedPort(), token: TOKEN });

  const res = await fetch(`${proxy.url}/mcp`, {
    method: 'POST',
    headers: { Origin: 'https://app.example.com', Authorization: `Bearer ${TOKEN}` },
    body: '{}',
  });

  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /unreachable/i);

  // The server survived: a second request still gets an answer rather than a dead socket.
  const again = await fetch(`${proxy.url}/mcp`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://app.example.com' },
  });

  assert.equal(again.status, 204);
});

test('with allowedOrigin configured, a foreign Origin is refused before the forward', async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    token: TOKEN,
    allowedOrigin: 'https://app.example.com',
  });

  const res = await fetch(`${proxy.url}/mcp`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example', Authorization: `Bearer ${TOKEN}` },
    body: '{}',
  });

  assert.equal(res.status, 403);

  await settle();
  assert.equal(upstream.received.length, 0);
  assert.equal(
    res.headers.get('access-control-allow-origin'),
    null,
    'a refusal must not echo the origin it just refused',
  );
});

test('with allowedOrigin configured, the paired Origin is echoed and forwarded', async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    token: TOKEN,
    allowedOrigin: 'https://app.example.com',
  });

  const res = await fetch(`${proxy.url}/mcp`, {
    method: 'POST',
    headers: { Origin: 'https://app.example.com', Authorization: `Bearer ${TOKEN}` },
    body: '{}',
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example.com');
  assert.equal(upstream.received.length, 1);
});

test('GET and DELETE (the MCP stream + session-teardown verbs) are forwarded too', async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy({ upstreamPort: upstream.port, token: TOKEN });

  for (const method of ['GET', 'DELETE']) {
    const res = await fetch(`${proxy.url}/mcp`, {
      method,
      headers: { Origin: 'https://app.example.com', Authorization: `Bearer ${TOKEN}` },
    });

    assert.equal(res.status, 200, `${method} was not forwarded`);
  }

  assert.deepEqual(
    upstream.received.map((r) => r.method),
    ['GET', 'DELETE'],
  );
});
