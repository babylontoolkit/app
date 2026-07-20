/**
 * The pairing token: the companion's only real authorisation wall.
 *
 * Anything running on this machine can reach 127.0.0.1 — another browser tab, another app, a script.
 * The token is what separates "the builder tab the user pasted it into" from all of that, so it is
 * compared in constant time (a naive `===` on a secret leaks its prefix through timing, and a local
 * attacker is precisely the one positioned to measure that).
 *
 * It is minted fresh per run: a token that outlives the session it authorised is a credential the
 * user never agreed to keep.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';

export function mintToken() {
  return randomUUID();
}

/**
 * Constant-time comparison of an `Authorization: Bearer <token>` header against the expected token.
 *
 * @param {string | undefined} authorizationHeader
 * @param {string} expected
 * @returns {boolean}
 */
export function checkToken(authorizationHeader, expected) {
  if (!expected) {
    // No token configured means no wall — refuse rather than silently running open.
    return false;
  }

  if (typeof authorizationHeader !== 'string') {
    return false;
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());

  if (!match) {
    return false;
  }

  const provided = Buffer.from(match[1]);
  const expectedBytes = Buffer.from(expected);

  /*
   * `timingSafeEqual` THROWS on a length mismatch, so the length must be checked first. This does
   * leak the token's length by timing — which is acceptable here and nowhere else: the token is a v4
   * UUID, so its length is fixed and publicly known, and only the 36 secret characters are compared
   * in constant time. Do not copy this into a comparison whose secret has a variable length.
   */
  if (provided.length !== expectedBytes.length) {
    return false;
  }

  return timingSafeEqual(provided, expectedBytes);
}
