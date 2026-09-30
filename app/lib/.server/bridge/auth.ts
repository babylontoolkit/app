/**
 * Unity Bridge device authentication (SPEC §4.17, D7, D8).
 *
 * A paired Desktop Agent presents `Authorization: Bearer btkb_…` — never a query string (a credential in
 * a URL lands in access and proxy logs). The server stores only the SHA-256 hex of the token, so a
 * lookup hashes what was presented and finds the device by that hash. An unknown device, a revoked
 * device, or a missing header are the SAME refusal: a 401 telling the user to pair again.
 *
 * Nothing in this module may log a token, a secret, or a hash of either.
 */
import { createHash, randomBytes } from 'node:crypto';
import { env } from '~/lib/.server/env';
import { UnauthorizedError } from '~/lib/.server/supabase/auth';
import { getBridgeStore, type BridgeDeviceRow } from './store';

/** A refusal the caller can act on. `name` is load-bearing: http.ts SAFE_ERRORS matches on it. */
export class BridgeRefusedError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 422) {
    super(message);
    this.name = 'BridgeRefusedError';
    this.statusCode = statusCode;
  }
}

/** sha256 hex. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function mintDeviceToken(): string {
  return 'btkb_' + randomBytes(32).toString('base64url');
}

export function mintId(prefix: 'dev' | 'pair' | 'brg'): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString('hex').slice(0, 6)}`;
}

export interface BridgeDeviceAuth {
  device: BridgeDeviceRow;
}

const NOT_PAIRED =
  'This computer is not paired with this App Builder. Copy the install command from the Unity Bridge dialog again.';

function presentedToken(request: Request): string | null {
  const authorization = request.headers.get('authorization');

  if (!authorization) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());

  return match ? match[1].trim() || null : null;
}

/** Bearer → hash → device; revoked or unknown → UnauthorizedError. */
export async function requireBridgeDevice(request: Request, context: unknown): Promise<BridgeDeviceAuth> {
  const token = presentedToken(request);

  if (!token) {
    throw new UnauthorizedError(NOT_PAIRED);
  }

  const device = await getBridgeStore(context).getDeviceByTokenHash(hashSecret(token));

  if (!device || device.revokedAt) {
    throw new UnauthorizedError(NOT_PAIRED);
  }

  return { device };
}

/** On unless `UNITY_BRIDGE_ENABLED` is exactly `"false"` (D43). */
export function isBridgeEnabled(context: unknown): boolean {
  return env(context, 'UNITY_BRIDGE_ENABLED') !== 'false';
}

/**
 * The production App Builder origin — the origin of `APP_URL`, or null when it is unset or not an http(s)
 * URL (D55). The helper defaults to production, so the dialog's install command names a `--server` only
 * when the page is not on this origin.
 */
export function bridgeProductionOrigin(context: unknown): string | null {
  const appUrl = env(context, 'APP_URL');

  if (!appUrl || !appUrl.trim()) {
    return null;
  }

  try {
    const url = new URL(appUrl.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** The disabled answer every bridge route gives (except the project GET, which reports `enabled:false`). */
export const BRIDGE_DISABLED_BODY = {
  error: true,
  message: 'The Unity Bridge is not enabled on this server.',
} as const;
