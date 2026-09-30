import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashSecret, isBridgeEnabled, mintDeviceToken, mintId, requireBridgeDevice } from './auth';
import { FsBridgeStore, setBridgeStore } from './store';

let tmp: string;
let store: FsBridgeStore;
const token = mintDeviceToken();

beforeEach(async () => {
  vi.stubEnv('UNITY_BRIDGE_ENABLED', undefined as unknown as string);
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-auth-'));
  store = new FsBridgeStore(tmp);
  setBridgeStore(store);
  await store.putDevice({
    id: 'dev_1',
    userId: 'u1',
    name: 'laptop',
    os: 'darwin',
    tokenHash: hashSecret(token),
    createdAt: '2026-09-29T12:00:00.000Z',
  });
});

afterEach(async () => {
  setBridgeStore(null);
  vi.unstubAllEnvs();
  await fs.rm(tmp, { recursive: true, force: true });
});

const req = (authorization?: string) =>
  new Request('http://localhost/api/bridge/poll', {
    method: 'POST',
    headers: authorization ? { authorization } : {},
  });

describe('requireBridgeDevice', () => {
  it('a valid token → the device', async () => {
    const { device } = await requireBridgeDevice(req(`Bearer ${token}`), {});
    expect(device.id).toBe('dev_1');
  });

  it('a revoked device → throws 401', async () => {
    const device = await store.getDevice('dev_1');
    await store.putDevice({ ...device!, revokedAt: '2026-09-29T13:00:00.000Z' });

    await expect(requireBridgeDevice(req(`Bearer ${token}`), {})).rejects.toMatchObject({
      statusCode: 401,
      message:
        'This computer is not paired with this App Builder. Copy the install command from the Unity Bridge dialog again.',
    });
  });

  it('no header → 401', async () => {
    await expect(requireBridgeDevice(req(), {})).rejects.toMatchObject({ statusCode: 401 });
  });

  it('an unknown token → 401', async () => {
    await expect(requireBridgeDevice(req(`Bearer ${mintDeviceToken()}`), {})).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});

describe('ids and the enable switch', () => {
  it('mintId carries the prefix and a base36 time', () => {
    expect(mintId('brg')).toMatch(/^brg_[0-9a-z]+_[0-9a-f]{6}$/);
  });

  it('only the exact string "false" disables the bridge', () => {
    expect(isBridgeEnabled({})).toBe(true);
    vi.stubEnv('UNITY_BRIDGE_ENABLED', 'false');
    expect(isBridgeEnabled({})).toBe(false);
    vi.stubEnv('UNITY_BRIDGE_ENABLED', 'FALSE');
    expect(isBridgeEnabled({})).toBe(true);
  });
});
