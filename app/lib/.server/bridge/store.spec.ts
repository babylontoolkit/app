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
  code: 'ABCDEFGH',
  secretHash: 'h',
  deviceName: 'laptop',
  os: 'darwin',
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
  credits: 1,
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

  it('findPendingPairingByCode ignores expired and consumed rows', async () => {
    const now = '2026-09-29T12:05:00.000Z';

    await store.putPairing(pairing({ id: 'pair_expired', code: 'AAAAAAAA', expiresAt: '2026-09-29T12:04:00.000Z' }));
    await store.putPairing(pairing({ id: 'pair_consumed', code: 'BBBBBBBB', status: 'consumed' }));
    await store.putPairing(pairing({ id: 'pair_live', code: 'CCCCCCCC' }));

    expect(await store.findPendingPairingByCode('AAAAAAAA', now)).toBeNull();
    expect(await store.findPendingPairingByCode('BBBBBBBB', now)).toBeNull();
    expect((await store.findPendingPairingByCode('CCCCCCCC', now))?.id).toBe('pair_live');
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
