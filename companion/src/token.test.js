/**
 * The pairing token is the companion's ONLY authorisation wall — anything on this machine can reach
 * 127.0.0.1. Two failure shapes are pinned here because both would run open rather than throw: an
 * empty expected token (no wall configured), and the `timingSafeEqual` length trap (a different-length
 * token must return false, never throw — a throw here becomes a 500 and a length oracle).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkToken, mintToken } from './token.js';

const TOKEN = '11111111-2222-3333-4444-555555555555';

test('a valid Bearer token is accepted', () => {
  assert.equal(checkToken(`Bearer ${TOKEN}`, TOKEN), true);
});

test('the wrong token of the same length is rejected', () => {
  const wrong = '11111111-2222-3333-4444-555555555556';

  assert.equal(wrong.length, TOKEN.length, 'this case must exercise the equal-length compare path');
  assert.equal(checkToken(`Bearer ${wrong}`, TOKEN), false);
});

test('a token of a DIFFERENT length is rejected without throwing (timingSafeEqual length trap)', () => {
  assert.equal(checkToken('Bearer short', TOKEN), false);
  assert.equal(checkToken(`Bearer ${TOKEN}${TOKEN}`, TOKEN), false);
});

test('a missing Authorization header is rejected', () => {
  assert.equal(checkToken(undefined, TOKEN), false);
  assert.equal(checkToken(null, TOKEN), false);
});

test('a malformed Authorization header is rejected', () => {
  assert.equal(checkToken('', TOKEN), false);
  assert.equal(checkToken(TOKEN, TOKEN), false, 'a bare token with no scheme is not a Bearer header');
  assert.equal(checkToken('Bearer', TOKEN), false, '"Bearer" alone carries no credential');
  assert.equal(checkToken('Bearer ', TOKEN), false);
  assert.equal(checkToken(`Basic ${TOKEN}`, TOKEN), false);
});

test('the Bearer scheme is matched case-insensitively', () => {
  assert.equal(checkToken(`bearer ${TOKEN}`, TOKEN), true);
  assert.equal(checkToken(`BEARER ${TOKEN}`, TOKEN), true);
});

test('surrounding and inner whitespace is tolerated', () => {
  assert.equal(checkToken(`  Bearer ${TOKEN}  `, TOKEN), true);
  assert.equal(checkToken(`Bearer   ${TOKEN}`, TOKEN), true);
});

test('an empty expected token refuses everything rather than running open', () => {
  assert.equal(checkToken('Bearer anything', ''), false);
  assert.equal(checkToken('Bearer anything', undefined), false);
  assert.equal(checkToken('Bearer ', ''), false);
});

test('mintToken returns a fresh uuid each call', () => {
  const minted = new Set();

  for (let i = 0; i < 100; i++) {
    const token = mintToken();

    assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    minted.add(token);
  }

  assert.equal(minted.size, 100, 'a repeated token would hand a later session an earlier session credential');
});
