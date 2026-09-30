/**
 * Unity Bridge device-code pairing (SPEC §4.17, D7).
 *
 *   1. The helper `start`s a pairing → `{pairingId, secret, code}` (code shown as `XXXX-XXXX`).
 *   2. The user approves the code in the builder's Connect dialog (a verified session).
 *   3. The helper `redeem`s with `pairingId + secret` and receives its device token ONCE.
 *
 * Only SHA-256 hashes of the secret and the token are stored. Codes expire in 10 minutes. Limits: 5
 * active devices per user; approve is rate-limited per user, start per caller fingerprint (in the route).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { enforceUserRateLimit } from '~/lib/.server/security/user-rate-limit';
import { BridgeRefusedError, hashSecret, mintDeviceToken, mintId } from './auth';
import { getBridgeStore } from './store';

export const PAIRING_TTL_MS = 600_000;
export const MAX_ACTIVE_DEVICES = 5;
export const PAIR_APPROVE_RATE_LIMIT = { windowMs: 600_000, max: 10 };
export const PAIR_START_RATE_LIMIT = { windowMs: 3_600_000, max: 20 };
export const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const CODE_LENGTH = 8;

/** uppercase, strip non-alphabet chars. */
export function normalizeCode(input: string): string {
  return [...String(input ?? '').toUpperCase()].filter((ch) => PAIRING_ALPHABET.includes(ch)).join('');
}

/** 'ABCDEFGH' → 'ABCD-EFGH'. */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/*
 * Unbiased pick: reject bytes ≥ 256 − (256 % alphabet length). The alphabet has 32 characters, so the
 * bound is 256 and nothing is ever rejected — the loop stays so a future alphabet change cannot bias it.
 */
function mintCode(): string {
  const limit = 256 - (256 % PAIRING_ALPHABET.length);
  let code = '';

  while (code.length < CODE_LENGTH) {
    const byte = randomBytes(1)[0];

    if (byte < limit) {
      code += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length];
    }
  }

  return code;
}

function hashesMatch(presentedHash: string, storedHash: string): boolean {
  const a = Buffer.from(presentedHash, 'utf8');
  const b = Buffer.from(storedHash, 'utf8');

  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startPairing(input: {
  deviceName: string;
  os: string;
  context: unknown;
  now?: number;
}): Promise<{ pairingId: string; secret: string; code: string; expiresAt: string }> {
  const now = input.now ?? Date.now();
  const pairingId = mintId('pair');
  const secret = randomBytes(32).toString('base64url');
  const code = mintCode();
  const expiresAt = new Date(now + PAIRING_TTL_MS).toISOString();

  await getBridgeStore(input.context).putPairing({
    id: pairingId,
    code,
    secretHash: hashSecret(secret),
    deviceName: input.deviceName,
    os: input.os,
    status: 'pending',
    expiresAt,
    createdAt: new Date(now).toISOString(),
  });

  return { pairingId, secret, code: formatCode(code), expiresAt };
}

/** Throws BridgeRefusedError: unknown/expired code (404), device cap reached (409). */
export async function approvePairing(input: {
  userId: string;
  code: string;
  context: unknown;
  now?: number;
}): Promise<{ deviceName: string }> {
  const now = input.now ?? Date.now();

  await enforceUserRateLimit({
    userId: input.userId,
    bucket: 'bridge-pair-approve',
    rule: PAIR_APPROVE_RATE_LIMIT,
    subject: 'pairing approvals',
    now,
  });

  const store = getBridgeStore(input.context);
  const code = normalizeCode(input.code);
  const pairing =
    code.length === CODE_LENGTH ? await store.findPendingPairingByCode(code, new Date(now).toISOString()) : null;

  if (!pairing) {
    throw new BridgeRefusedError(
      'That pairing code is not valid or has expired. Run the helper again for a new code.',
      404,
    );
  }

  const active = (await store.listDevices(input.userId)).filter((device) => !device.revokedAt);

  if (active.length >= MAX_ACTIVE_DEVICES) {
    throw new BridgeRefusedError(
      `You already have ${MAX_ACTIVE_DEVICES} Unity Bridge devices paired. Remove one in the Unity Bridge panel first.`,
      409,
    );
  }

  await store.putPairing({ ...pairing, userId: input.userId, status: 'approved' });

  return { deviceName: pairing.deviceName };
}

export async function redeemPairing(input: {
  pairingId: string;
  secret: string;
  context: unknown;
  now?: number;
}): Promise<{ status: 'pending' } | { status: 'expired' } | { status: 'approved'; deviceId: string; token: string }> {
  const now = input.now ?? Date.now();
  const store = getBridgeStore(input.context);
  const pairing = typeof input.pairingId === 'string' ? await store.getPairing(input.pairingId) : null;

  if (!pairing || typeof input.secret !== 'string' || !hashesMatch(hashSecret(input.secret), pairing.secretHash)) {
    return { status: 'expired' };
  }

  if (pairing.status === 'consumed' || Date.parse(pairing.expiresAt) <= now) {
    return { status: 'expired' };
  }

  if (pairing.status === 'pending' || !pairing.userId) {
    return { status: 'pending' };
  }

  const token = mintDeviceToken();
  const deviceId = mintId('dev');

  await store.putDevice({
    id: deviceId,
    userId: pairing.userId,
    name: pairing.deviceName,
    os: pairing.os,
    tokenHash: hashSecret(token),
    createdAt: new Date(now).toISOString(),
  });
  await store.putPairing({ ...pairing, status: 'consumed' });

  return { status: 'approved', deviceId, token };
}
