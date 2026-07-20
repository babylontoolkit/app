/**
 * The two header rules that fail SILENTLY in a browser, pinned as pure functions.
 *
 * A missing `Access-Control-Allow-Private-Network` surfaces as a generic network error (looks like
 * "the companion isn't running"); a missing `Access-Control-Expose-Headers: mcp-session-id` makes the
 * MCP session restart on every request with nothing thrown. Neither is visible from the server side,
 * so they are asserted here rather than left to a live browser run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCorsHeaders, resolveAllowOrigin } from './headers.js';

test('preflight requesting private network gets Access-Control-Allow-Private-Network: true', () => {
  const headers = buildCorsHeaders('https://app.example.com', true, true);

  assert.equal(headers['Access-Control-Allow-Private-Network'], 'true');
});

test('preflight NOT requesting private network omits the PNA header entirely', () => {
  const headers = buildCorsHeaders('https://app.example.com', true, false);

  assert.ok(
    !('Access-Control-Allow-Private-Network' in headers),
    'PNA header must be absent, not empty — it is only valid as an answer to the matching request header',
  );
});

test('every response exposes mcp-session-id and echoes the allow-origin', () => {
  for (const isPreflight of [true, false]) {
    const headers = buildCorsHeaders('https://app.example.com', isPreflight, false);

    assert.equal(
      headers['Access-Control-Expose-Headers'],
      'mcp-session-id',
      `expose-headers missing on ${isPreflight ? 'preflight' : 'normal'} response`,
    );
    assert.equal(headers['Access-Control-Allow-Origin'], 'https://app.example.com');
  }
});

test('wildcard origin is echoed verbatim', () => {
  assert.equal(buildCorsHeaders('*', false, false)['Access-Control-Allow-Origin'], '*');
});

test('preflight advertises the methods and headers the MCP transport needs', () => {
  const headers = buildCorsHeaders('*', true, false);

  for (const method of ['POST', 'GET', 'DELETE', 'OPTIONS']) {
    assert.ok(headers['Access-Control-Allow-Methods'].includes(method), `Allow-Methods missing ${method}`);
  }

  const allowedHeaders = headers['Access-Control-Allow-Headers'].toLowerCase();

  for (const header of ['content-type', 'authorization', 'mcp-session-id']) {
    assert.ok(allowedHeaders.includes(header), `Allow-Headers missing ${header}`);
  }

  assert.ok('Access-Control-Max-Age' in headers);
});

test('non-preflight response carries no preflight-only headers', () => {
  const headers = buildCorsHeaders('*', false, true);

  assert.ok(!('Access-Control-Allow-Methods' in headers));
  assert.ok(!('Access-Control-Allow-Headers' in headers));
  assert.ok(!('Access-Control-Max-Age' in headers));
  assert.ok(
    !('Access-Control-Allow-Private-Network' in headers),
    'PNA is a preflight answer; it must not leak onto a normal response even if the flag is set',
  );
});

test('resolveAllowOrigin: no configured origin answers *', () => {
  assert.equal(resolveAllowOrigin('https://anything.example', undefined), '*');
  assert.equal(resolveAllowOrigin(undefined, undefined), '*');
  assert.equal(resolveAllowOrigin(undefined, ''), '*');
});

test('resolveAllowOrigin: a matching origin is echoed back', () => {
  assert.equal(resolveAllowOrigin('https://app.example.com', 'https://app.example.com'), 'https://app.example.com');
});

test('resolveAllowOrigin: a mismatched origin is refused (never reflected)', () => {
  assert.equal(resolveAllowOrigin('https://evil.example', 'https://app.example.com'), null);
});

test('resolveAllowOrigin: an absent request Origin is refused when an origin is configured', () => {
  assert.equal(
    resolveAllowOrigin(undefined, 'https://app.example.com'),
    null,
    'a same-origin/non-browser caller must not bypass the configured restriction by omitting Origin',
  );
});
