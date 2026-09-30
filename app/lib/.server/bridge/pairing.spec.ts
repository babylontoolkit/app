import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryUserRateLimitStore, setUserRateLimitStore } from '~/lib/.server/security/user-rate-limit';
import { approvePairing, formatCode, normalizeCode, redeemPairing, startPairing } from './pairing';
import { FsBridgeStore, setBridgeStore } from './store';

const T0 = Date.parse('2026-09-29T12:00:00.000Z');
const ctx = {};
let tmp: string;
let store: FsBridgeStore;

beforeEach(async () => {
  vi.stubEnv('UNITY_BRIDGE_ENABLED', undefined as unknown as string);
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-pairing-'));
  store = new FsBridgeStore(tmp);
  setBridgeStore(store);
  setUserRateLimitStore(new MemoryUserRateLimitStore());
});

afterEach(async () => {
  setBridgeStore(null);
  setUserRateLimitStore(undefined);
  vi.unstubAllEnvs();
  await fs.rm(tmp, { recursive: true, force: true });
});

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('device-code pairing', () => {
  it('start → code matches XXXX-XXXX from the pairing alphabet', async () => {
    const started = await startPairing({ deviceName: 'laptop', os: 'darwin', context: ctx, now: T0 });

    expect(started.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(started.code).not.toMatch(/[IO01]/);
    expect(started.expiresAt).toBe(new Date(T0 + 600_000).toISOString());
    expect(formatCode(normalizeCode(started.code))).toBe(started.code);
  });

  it('approve with lower-case and dashes → ok', async () => {
    const started = await startPairing({ deviceName: 'laptop', os: 'darwin', context: ctx, now: T0 });
    const messy = ` ${started.code.toLowerCase().replace('-', '--')} `;

    await expect(approvePairing({ userId: 'u1', code: messy, context: ctx, now: T0 + 1000 })).resolves.toEqual({
      deviceName: 'laptop',
    });
  });

  it('redeem before approve → pending; after → approved with a btkb_ token; again → expired', async () => {
    const started = await startPairing({ deviceName: 'laptop', os: 'darwin', context: ctx, now: T0 });
    const redeem = () =>
      redeemPairing({ pairingId: started.pairingId, secret: started.secret, context: ctx, now: T0 + 2000 });

    expect(await redeem()).toEqual({ status: 'pending' });

    await approvePairing({ userId: 'u1', code: started.code, context: ctx, now: T0 + 1000 });

    const approved = await redeem();
    expect(approved.status).toBe('approved');

    if (approved.status !== 'approved') {
      throw new Error('unreachable');
    }

    expect(approved.token).toMatch(/^btkb_[A-Za-z0-9_-]{43}$/);

    const device = await store.getDevice(approved.deviceId);
    expect(device?.tokenHash).toBe(sha256(approved.token));
    expect(device?.userId).toBe('u1');
    expect(JSON.stringify(device)).not.toContain(approved.token);

    expect(await redeem()).toEqual({ status: 'expired' });
  });

  it('wrong secret → expired', async () => {
    const started = await startPairing({ deviceName: 'laptop', os: 'darwin', context: ctx, now: T0 });
    await approvePairing({ userId: 'u1', code: started.code, context: ctx, now: T0 + 1000 });

    expect(
      await redeemPairing({ pairingId: started.pairingId, secret: 'not-the-secret', context: ctx, now: T0 + 2000 }),
    ).toEqual({ status: 'expired' });
  });

  it('approve after 10 min → 404 error', async () => {
    const started = await startPairing({ deviceName: 'laptop', os: 'darwin', context: ctx, now: T0 });

    await expect(
      approvePairing({ userId: 'u1', code: started.code, context: ctx, now: T0 + 600_001 }),
    ).rejects.toMatchObject({ name: 'BridgeRefusedError', statusCode: 404 });
  });

  it('6th device → 409', async () => {
    for (let i = 0; i < 5; i++) {
      await store.putDevice({
        id: `dev_${i}`,
        userId: 'u1',
        name: `d${i}`,
        os: 'darwin',
        tokenHash: `h${i}`,
        createdAt: new Date(T0).toISOString(),
      });
    }

    const started = await startPairing({ deviceName: 'sixth', os: 'linux', context: ctx, now: T0 });

    await expect(
      approvePairing({ userId: 'u1', code: started.code, context: ctx, now: T0 + 1000 }),
    ).rejects.toMatchObject({ name: 'BridgeRefusedError', statusCode: 409 });

    // CONTROL — a revoked device frees its slot.
    const d0 = await store.getDevice('dev_0');
    await store.putDevice({ ...d0!, revokedAt: new Date(T0).toISOString() });

    await expect(approvePairing({ userId: 'u1', code: started.code, context: ctx, now: T0 + 2000 })).resolves.toEqual({
      deviceName: 'sixth',
    });
  });
});
