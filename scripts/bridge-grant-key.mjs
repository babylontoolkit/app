#!/usr/bin/env node
/**
 * Unity automation grant keys (SPEC §4.17, D47–D49).
 *
 *   node scripts/bridge-grant-key.mjs generate
 *     → prints the server secret (`BRIDGE_GRANT_PRIVATE_KEY=…`, base64 PKCS#8 DER) and the two PUBLIC
 *       constants (modulus, exponent) to paste into the exporter's `UnityTools_HX.cs`.
 *
 *   node scripts/bridge-grant-key.mjs sign --guid <32hex> [--hours N] [--iat <unix>]
 *     → reads `BRIDGE_GRANT_PRIVATE_KEY` from the environment and prints ONE grant, in exactly the format
 *       `app/lib/.server/bridge/grant.ts` `signGrant` produces. It exists for the live checks.
 *
 * The private key is a SECRET: it goes into `.env.local` (gitignored) and SSM, never into a commit, a
 * log, or a response. The public constants are public material — the DLL holds them so it can VERIFY a
 * grant, and nothing extractable from it can forge one.
 *
 * Node built-ins only; the functions are exported so a spec can prove the two signers agree.
 */
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const GRANT_ISSUER = 'babylon-toolkit-app-builder';

/** base64url → standard base64 with padding. */
function base64UrlToBase64(value) {
  const b = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b.length % 4 === 2 ? '==' : b.length % 4 === 3 ? '=' : '';

  return b + pad;
}

/** A fresh RSA-2048 key pair: `{ privateKeyB64, publicJwk }`. */
export function generateKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

  return {
    privateKeyB64: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicJwk: publicKey.export({ format: 'jwk' }),
  };
}

/** The public JWK as the two C# constants (standard base64, padded). */
export function jwkToCsharp(jwk) {
  return {
    modulus: base64UrlToBase64(jwk.n),
    exponent: base64UrlToBase64(jwk.e),
  };
}

/** Sign a payload with a base64 PKCS#8 DER private key — the same format as `signGrant`. */
export function signGrantWith(privateKeyB64, payload) {
  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  const head = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

  return `${head}.${sign('sha256', Buffer.from(head, 'ascii'), key).toString('base64url')}`;
}

function argValue(args, name) {
  const index = args.indexOf(name);

  return index >= 0 ? args[index + 1] : undefined;
}

function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === 'generate') {
    const { privateKeyB64, publicJwk } = generateKeys();
    const { modulus, exponent } = jwkToCsharp(publicJwk);

    console.log('# server secret — .env.local and SSM, never commit');
    console.log(`BRIDGE_GRANT_PRIVATE_KEY=${privateKeyB64}`);
    console.log('');
    console.log('// paste into UnityTools_HX.cs');
    console.log(`private const string AUTOMATION_KEY_MODULUS = "${modulus}";`);
    console.log(`private const string AUTOMATION_KEY_EXPONENT = "${exponent}";`);

    return;
  }

  if (command === 'sign') {
    const privateKeyB64 = process.env.BRIDGE_GRANT_PRIVATE_KEY;

    if (!privateKeyB64) {
      throw new Error('BRIDGE_GRANT_PRIVATE_KEY is not set in the environment.');
    }

    const guid = (argValue(args, '--guid') ?? '').toLowerCase();

    if (!/^[0-9a-f]{32}$/.test(guid)) {
      throw new Error('--guid must be 32 hex characters.');
    }

    const hours = Number(argValue(args, '--hours') ?? 12);
    const iatRaw = argValue(args, '--iat');
    const iat = iatRaw === undefined ? Math.floor(Date.now() / 1000) : Number(iatRaw);

    if (!Number.isFinite(hours) || !Number.isFinite(iat)) {
      throw new Error('--hours and --iat must be numbers.');
    }

    const payload = {
      v: 1,
      iss: GRANT_ISSUER,
      sub: 'cli',
      dev: 'cli',
      prj: guid,
      iat: Math.floor(iat),
      exp: Math.floor(iat) + Math.floor(hours * 3600),
    };

    console.log(signGrantWith(privateKeyB64, payload));

    return;
  }

  throw new Error('Usage: bridge-grant-key.mjs generate | sign --guid <32hex> [--hours N] [--iat <unix>]');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(`🔴 bridge-grant-key: ${error.message}`);
    process.exit(1);
  }
}
