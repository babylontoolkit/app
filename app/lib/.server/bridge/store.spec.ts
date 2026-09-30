import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsBridgeStore, type BridgeJobRow, type BridgePairingRow } from './store';

let tmp: string;
let store: FsBridgeStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-store-'));
  store = new FsBridgeStore(tmp);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const pairing = (over: Partial<BridgePairingRow>): BridgePairingRow => ({
  id: 'pair_x',
  userId: 'u1',
  secretHash: 'h',
  status: 'pending',
  expiresAt: '2026-09-29T12:10:00.000Z',
  createdAt: '2026-09-29T12:00:00.000Z',
  ...over,
});

const job = (id: string, createdAt: string, projectId = 'prj_1'): BridgeJobRow => ({
  id,
  userId: 'u1',
  projectId,
  deviceId: 'dev_1',
  operation: 'unity_command set_transform',
  tier: 'allowed',
  status: 'succeeded',
  started: true,
  createdAt,
});

describe('FsBridgeStore', () => {
  it('putDevice/getDeviceByTokenHash round trip', async () => {
    await store.putDevice({
      id: 'dev_1',
      userId: 'u1',
      name: 'laptop',
      os: 'darwin',
      tokenHash: 'abc123',
      createdAt: '2026-09-29T12:00:00.000Z',
    });

    const found = await store.getDeviceByTokenHash('abc123');

    expect(found?.id).toBe('dev_1');
    expect(found?.name).toBe('laptop');
    expect(await store.getDeviceByTokenHash('nope')).toBeNull();
    expect((await store.listDevices('u1')).map((d) => d.id)).toEqual(['dev_1']);
    expect(await store.listDevices('u2')).toEqual([]);
  });

  it('getPairingBySecretHash finds a row by the hash of its code only', async () => {
    await store.putPairing(pairing({ id: 'pair_a', secretHash: 'hash_a' }));
    await store.putPairing(pairing({ id: 'pair_b', secretHash: 'hash_b', status: 'consumed' }));

    expect((await store.getPairingBySecretHash('hash_a'))?.id).toBe('pair_a');
    expect((await store.getPairingBySecretHash('hash_b'))?.status).toBe('consumed');
    expect(await store.getPairingBySecretHash('hash_none')).toBeNull();
  });

  it('consumePairing flips a pending row exactly once', async () => {
    await store.putPairing(pairing({ id: 'pair_a', secretHash: 'hash_a' }));

    expect(await store.consumePairing('pair_a')).toBe(true);
    expect(await store.consumePairing('pair_a')).toBe(false);
    expect((await store.getPairingBySecretHash('hash_a'))?.status).toBe('consumed');
    expect(await store.consumePairing('pair_missing')).toBe(false);
  });

  it('listJobs is newest first and respects the limit', async () => {
    await store.putJob(job('brg_a', '2026-09-29T12:00:00.000Z'));
    await store.putJob(job('brg_c', '2026-09-29T12:02:00.000Z'));
    await store.putJob(job('brg_b', '2026-09-29T12:01:00.000Z'));
    await store.putJob(job('brg_other', '2026-09-29T12:03:00.000Z', 'prj_2'));

    expect((await store.listJobs('prj_1', 10)).map((j) => j.id)).toEqual(['brg_c', 'brg_b', 'brg_a']);
    expect((await store.listJobs('prj_1', 2)).map((j) => j.id)).toEqual(['brg_c', 'brg_b']);
  });
});
