/**
 * Unity Bridge pairing by install code (SPEC §4.17, D55 — the ONLY pairing flow).
 *
 *   1. A signed-in user opens the Unity Bridge dialog, which mints an install code (`createInstallCode`).
 *      The dialog shows ONE command with the code built in:
 *        npx @babylonjs-toolkit/agent bridge --install-service --pair XXXX-XXXX
 *   2. The helper claims it (`claimInstallCode`) and receives its device token ONCE.
 *
 * The direction is deliberate (owner, 2026-09-29: "if we use a service, how would we see the code?"): a
 * start-at-login service has no terminal for a human to read a code from, so the code is created where a
 * person is looking — the dialog — and consumed where nobody is.
 *
 * Only SHA-256 hashes are stored: of the NORMALISED code, and of the device token. Codes are single use and
 * expire in 10 minutes. Limits: 5 active devices per user (checked at claim time); minting is rate-limited
 * per user; claiming per caller fingerprint (in the route).
 *
 * Re-pairing the SAME computer (same name and OS) replaces its earlier pairing rather than adding a
 * device: the dialog no longer lists devices, so a computer that lost its credentials and re-ran the
 * install command must not quietly fill the 5-device cap with copies of itself.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { enforceUserRateLimit } from '~/lib/.server/security/user-rate-limit';
import { BridgeRefusedError, hashSecret, mintDeviceToken, mintId } from './auth';
import { dropDevice } from './relay';
import { settleDropped } from './service';
import { getBridgeStore } from './store';

export const PAIRING_TTL_MS = 600_000;
export const MAX_ACTIVE_DEVICES = 5;
export const INVITE_RATE_LIMIT = { windowMs: 600_000, max: 10 };
export const CLAIM_RATE_LIMIT = { windowMs: 3_600_000, max: 20 };
export const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const INVALID_INSTALL_CODE =
  'That install code is not valid or has expired. Copy a fresh command from the Unity Bridge dialog.';

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

/** Mint a single-use install code for a signed-in user. Rate-limited per user (10 / 10 min). */
export async function createInstallCode(input: {
  userId: string;
  context: unknown;
  now?: number;
}): Promise<{ code: string; expiresAt: string }> {
  const now = input.now ?? Date.now();

  await enforceUserRateLimit({
    userId: input.userId,
    bucket: 'bridge-invite',
    rule: INVITE_RATE_LIMIT,
    subject: 'bridge install codes',
    now,
  });

  const code = mintCode();
  const expiresAt = new Date(now + PAIRING_TTL_MS).toISOString();

  await getBridgeStore(input.context).putPairing({
    id: mintId('pair'),
    userId: input.userId,
    secretHash: hashSecret(code),
    status: 'pending',
    expiresAt,
    createdAt: new Date(now).toISOString(),
  });

  return { code: formatCode(code), expiresAt };
}

/*
 * Claims in flight in THIS process, by pairing id. The store's `consumePairing` is the real single-use
 * guarantee (a conditional update on Postgres); this closes the await gap in the filesystem store.
 */
const claiming = new Set<string>();

/**
 * Claim an install code for a helper → `{deviceId, token}` once.
 * Throws BridgeRefusedError: unknown / used / expired code (410), device cap reached (409).
 */
export async function claimInstallCode(input: {
  code: string;
  deviceName: string;
  os: string;
  context: unknown;
  now?: number;
}): Promise<{ deviceId: string; token: string }> {
  const now = input.now ?? Date.now();
  const store = getBridgeStore(input.context);
  const code = normalizeCode(input.code);
  const presentedHash = hashSecret(code);
  const pairing = code.length === CODE_LENGTH ? await store.getPairingBySecretHash(presentedHash) : null;

  if (
    !pairing ||
    !hashesMatch(presentedHash, pairing.secretHash) ||
    pairing.status !== 'pending' ||
    Date.parse(pairing.expiresAt) <= now ||
    claiming.has(pairing.id)
  ) {
    throw new BridgeRefusedError(INVALID_INSTALL_CODE, 410);
  }

  claiming.add(pairing.id);

  try {
    const active = (await store.listDevices(pairing.userId)).filter((device) => !device.revokedAt);
    const replaced = active.filter((device) => device.name === input.deviceName && device.os === input.os);

    if (active.length - replaced.length >= MAX_ACTIVE_DEVICES) {
      throw new BridgeRefusedError(
        `This account already has ${MAX_ACTIVE_DEVICES} Unity Bridge computers paired, which is the limit.`,
        409,
      );
    }

    // Consume BEFORE creating the device: a claim that loses the race creates nothing.
    if (!(await store.consumePairing(pairing.id))) {
      throw new BridgeRefusedError(INVALID_INSTALL_CODE, 410);
    }

    for (const device of replaced) {
      await store.putDevice({ ...device, revokedAt: new Date(now).toISOString() });
      await settleDropped(dropDevice(device.id), input.context);
    }

    const token = mintDeviceToken();
    const deviceId = mintId('dev');

    await store.putDevice({
      id: deviceId,
      userId: pairing.userId,
      name: input.deviceName,
      os: input.os,
      tokenHash: hashSecret(token),
      createdAt: new Date(now).toISOString(),
    });

    return { deviceId, token };
  } finally {
    claiming.delete(pairing.id);
  }
}
