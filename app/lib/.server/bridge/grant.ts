/**
 * Unity automation grants (SPEC §4.17, D47–D50).
 *
 * The exporter DLL switches automation mode on only for a grant signed by the App Builder's PRIVATE
 * key; the DLL holds the public key, so nothing extractable from the binary can forge one (D47). The
 * grant is `base64url(JSON payload) + '.' + base64url(RSA-SHA256 PKCS#1 v1.5 signature over the ASCII
 * bytes of the first segment)` (D48).
 *
 * `verifyGrant` is the C# `UnityTools.EnableAutomation` check list, in the same order with the same
 * reason strings, so a spec here proves what the DLL will accept.
 *
 * 🔴 The private key and every grant are secrets in transit: nothing in this module logs either, and
 * `BRIDGE_GRANT_PRIVATE_KEY` is server-only (never `VITE_`-prefixed).
 */
import { createPrivateKey, sign, verify, type KeyObject } from 'node:crypto';
import { env, NotConfiguredError } from '~/lib/.server/env';
import { checkAccessForUser } from '~/lib/.server/licensing/subscriber-status';
import { BridgeRefusedError } from './auth';
import { deviceHello } from './relay';

export const GRANT_ISSUER = 'babylon-toolkit-app-builder';
export const DEFAULT_GRANT_TTL_HOURS = 12;
export const MAX_GRANT_TTL_SECONDS = 86_400;
export const GRANT_RATE_LIMIT = { windowMs: 3_600_000, max: 60 };

/** How far in the future an `iat` may sit before the DLL refuses it (clock skew allowance). */
const MAX_FUTURE_IAT_SECONDS = 300;

export interface AutomationGrantPayload {
  v: 1;
  iss: string;
  sub: string;
  dev: string;
  prj: string;
  iat: number;
  exp: number;
}

/** BRIDGE_GRANT_TTL_HOURS, floored, clamped to 1..24; non-numeric → 12. Returns seconds. */
export function grantTtlSeconds(context: unknown): number {
  const raw = env(context, 'BRIDGE_GRANT_TTL_HOURS');
  const parsed = raw === undefined ? NaN : Number(raw);
  const hours = Number.isFinite(parsed) ? Math.min(24, Math.max(1, Math.floor(parsed))) : DEFAULT_GRANT_TTL_HOURS;

  return hours * 3600;
}

/**
 * BRIDGE_GRANT_PRIVATE_KEY (base64 PKCS#8 DER) → KeyObject. Missing/invalid → NotConfiguredError.
 * The parse error is NOT included in the message — it could echo key material.
 */
export function loadGrantPrivateKey(context: unknown): KeyObject {
  const raw = env(context, 'BRIDGE_GRANT_PRIVATE_KEY');
  const notConfigured = () =>
    new NotConfiguredError(
      'Unity automation grants',
      'set BRIDGE_GRANT_PRIVATE_KEY — node scripts/bridge-grant-key.mjs generate',
    );

  if (!raw || !raw.trim()) {
    throw notConfigured();
  }

  let key: KeyObject;

  try {
    key = createPrivateKey({ key: Buffer.from(raw.trim(), 'base64'), format: 'der', type: 'pkcs8' });
  } catch {
    throw notConfigured();
  }

  if (key.asymmetricKeyType !== 'rsa') {
    throw notConfigured();
  }

  return key;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

export function signGrant(payload: AutomationGrantPayload, key: KeyObject): string {
  const head = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${head}.${b64url(sign('sha256', Buffer.from(head, 'ascii'), key))}`; // RSA key → PKCS#1 v1.5
}

/** Mirrors the C# `AutomationBase64Url` (base64url → bytes); throws on garbage like Convert.FromBase64String. */
function fromBase64Url(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(segment) || segment.length % 4 === 1) {
    throw new Error('The input is not a valid Base-64 string.');
  }

  return Buffer.from(segment, 'base64url');
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

/** Same checks as the DLL (test parity): payload, or a reason string. */
export function verifyGrant(
  grant: string,
  publicKey: KeyObject,
  productGuid: string,
  nowSec: number,
): AutomationGrantPayload | string {
  try {
    if (!grant || !grant.trim()) {
      return 'no grant';
    }

    const parts = grant.trim().split('.');

    if (parts.length !== 2) {
      return 'malformed grant';
    }

    const signedBytes = Buffer.from(parts[0], 'ascii');
    const signature = fromBase64Url(parts[1]);

    if (!verify('sha256', signedBytes, publicKey, signature)) {
      return 'signature does not match';
    }

    const payload = JSON.parse(fromBase64Url(parts[0]).toString('utf8')) as Record<string, unknown>;

    if (payload.v !== 1) {
      return 'unsupported grant version';
    }

    if (payload.iss !== GRANT_ISSUER) {
      return 'wrong issuer';
    }

    const iat = asNumber(payload.iat);
    const exp = asNumber(payload.exp);
    const now = Math.floor(nowSec);

    if (exp <= now) {
      return 'grant expired';
    }

    if (iat > now + MAX_FUTURE_IAT_SECONDS) {
      return 'grant issued in the future';
    }

    if (exp - iat > MAX_GRANT_TTL_SECONDS) {
      return 'grant lifetime too long';
    }

    const prj = typeof payload.prj === 'string' ? payload.prj : '';

    if (prj.toLowerCase() !== productGuid.toLowerCase()) {
      return 'grant is for a different project';
    }

    return payload as unknown as AutomationGrantPayload;
  } catch (error) {
    return 'invalid grant: ' + (error as Error).message;
  }
}

/** Entitlement (D50) + advertised-project check + sign. */
export async function issueAutomationGrant(input: {
  userId: string;
  deviceId: string;
  productGuid: string;
  context: unknown;
  nowSec?: number;
}): Promise<{ grant: string; expiresAt: string }> {
  const raw = typeof input.productGuid === 'string' ? input.productGuid.trim() : '';

  if (!/^[0-9a-f]{32}$/i.test(raw)) {
    throw new BridgeRefusedError('productGuid must be 32 hex characters.', 400);
  }

  const productGuid = raw.toLowerCase();
  const advertised = deviceHello(input.deviceId)?.unityProjects ?? [];

  if (!advertised.some((project) => (project.productGuid ?? '').toLowerCase() === productGuid)) {
    throw new BridgeRefusedError('This computer has not offered that Unity project to the App Builder.', 403);
  }

  const access = await checkAccessForUser(input.userId, input.context);

  if (!access.active) {
    throw new BridgeRefusedError(
      'Unity automation needs an active subscription or credits on your App Builder account.',
      403,
    );
  }

  const key = loadGrantPrivateKey(input.context);
  const iat = Math.floor(input.nowSec ?? Date.now() / 1000);
  const exp = iat + grantTtlSeconds(input.context);
  const grant = signGrant(
    { v: 1, iss: GRANT_ISSUER, sub: input.userId, dev: input.deviceId, prj: productGuid, iat, exp },
    key,
  );

  return { grant, expiresAt: new Date(exp * 1000).toISOString() };
}
