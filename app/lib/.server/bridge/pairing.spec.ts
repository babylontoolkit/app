/**
 * Install-code pairing (SPEC §4.17, D55 — the only pairing flow): a signed-in user mints a single-use
 * code in the dialog, the helper claims it once with `--pair <code>`.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryUserRateLimitStore, setUserRateLimitStore } from '~/lib/.server/security/user-rate-limit';
import { resetBridgeRelayForTests } from './relay';
import { INVALID_INSTALL_CODE, claimInstallCode, createInstallCode, formatCode, normalizeCode } from './pairing';
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
  resetBridgeRelayForTests();
});

afterEach(async () => {
  setBridgeStore(null);
  setUserRateLimitStore(undefined);
  resetBridgeRelayForTests();
  vi.unstubAllEnvs();
  await fs.rm(tmp, { recursive: true, force: true });
});

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const claim = (code: string, now = T0 + 1000, deviceName = 'laptop', osName = 'darwin') =>
  claimInstallCode({ code, deviceName, os: osName, context: ctx, now });

async function pairingFiles(): Promise<string[]> {
  const dir = path.join(tmp, 'pairings');
  const names = await fs.readdir(dir).catch(() => [] as string[]);

  return Promise.all(names.map((name) => fs.readFile(path.join(dir, name), 'utf8')));
}

describe('createInstallCode', () => {
  it('mints XXXX-XXXX from the pairing alphabet, 10-minute expiry, and stores only its hash', async () => {
    const { code, expiresAt } = await createInstallCode({ userId: 'u1', context: ctx, now: T0 });

    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(code).not.toMatch(/[IO01]/);
    expect(expiresAt).toBe(new Date(T0 + 600_000).toISOString());
    expect(formatCode(normalizeCode(code))).toBe(code);

    const row = await store.getPairingBySecretHash(sha256(normalizeCode(code)));
    expect(row).toMatchObject({ userId: 'u1', status: 'pending', expiresAt });

    const raw = (await pairingFiles()).join('\n');
    expect(raw).not.toContain(normalizeCode(code));
    expect(raw).not.toContain(code);
  });

  it('is rate-limited per user: the 11th code in 10 minutes → 429, another user unaffected', async () => {
    for (let i = 0; i < 10; i++) {
      await createInstallCode({ userId: 'u1', context: ctx, now: T0 + i });
    }

    await expect(createInstallCode({ userId: 'u1', context: ctx, now: T0 + 20 })).rejects.toMatchObject({
      statusCode: 429,
    });
    await expect(createInstallCode({ userId: 'u2', context: ctx, now: T0 + 20 })).resolves.toBeTruthy();
  });
});

describe('claimInstallCode', () => {
  it('claims once → a btkb_ token for the MINTING user; the device stores only the token hash', async () => {
    const { code } = await createInstallCode({ userId: 'u1', context: ctx, now: T0 });
    const claimed = await claim(code);

    expect(claimed.token).toMatch(/^btkb_[A-Za-z0-9_-]{43}$/);

    const device = await store.getDevice(claimed.deviceId);
    expect(device).toMatchObject({ userId: 'u1', name: 'laptop', os: 'darwin', tokenHash: sha256(claimed.token) });
    expect(JSON.stringify(device)).not.toContain(claimed.token);
    expect((await store.getPairingBySecretHash(sha256(normalizeCode(code))))?.status).toBe('consumed');
  });

  it('accepts the code in lower case with extra dashes and spaces', async () => {
    const { code } = await createInstallCode({ userId: 'u1', context: ctx, now: T0 });

    await expect(claim(` ${code.toLowerCase().replace('-', '--')} `)).resolves.toHaveProperty('token');
  });

  it('is single use: a second claim of the same code → 410, and creates no second device', async () => {
    const { code } = await createInstallCode({ userId: 'u1', context: ctx, now: T0 });

    await claim(code, T0 + 1000, 'laptop');
    await expect(claim(code, T0 + 2000, 'desk', 'linux')).rejects.toMatchObject({
      name: 'BridgeRefusedError',
      statusCode: 410,
      message: INVALID_INSTALL_CODE,
    });

    expect(await store.listDevices('u1')).toHaveLength(1);
  });

  it('two concurrent claims of one code → exactly one device', async () => {
    const { code } = await createInstallCode({ userId: 'u1', context: ctx, now: T0 });
    const results = await Promise.allSettled([claim(code, T0 + 1000, 'a'), claim(code, T0 + 1000, 'b', 'linux')]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await store.listDevices('u1')).toHaveLength(1);
  });

  it('an expired code → 410 (CONTROL: the same code one ms earlier works)', async () => {
    const late = await createInstallCode({ userId: 'u1', context: ctx, now: T0 });
    await expect(claim(late.code, T0 + 600_000)).rejects.toMatchObject({ statusCode: 410 });

    const onTime = await createInstallCode({ userId: 'u1', context: ctx, now: T0 });
    await expect(claim(onTime.code, T0 + 599_999)).resolves.toHaveProperty('token');
  });

  it('an unknown or malformed code → 410', async () => {
    await createInstallCode({ userId: 'u1', context: ctx, now: T0 });

    await expect(claim('ZZZZ-ZZZZ')).rejects.toMatchObject({ statusCode: 410 });
    await expect(claim('ABC')).rejects.toMatchObject({ statusCode: 410 });
  });

  it("a code is bound to the user who minted it — another user's code pairs to THEM, never to the claimer", async () => {
    const theirs = await createInstallCode({ userId: 'u2', context: ctx, now: T0 });
    const claimed = await claim(theirs.code);

    expect((await store.getDevice(claimed.deviceId))?.userId).toBe('u2');
    expect(await store.listDevices('u1')).toEqual([]);
  });

  it('a 6th distinct computer → 409, the code stays usable; a revoked device frees the slot (CONTROL)', async () => {
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

    const { code } = await createInstallCode({ userId: 'u1', context: ctx, now: T0 });

    await expect(claim(code, T0 + 1000, 'sixth', 'linux')).rejects.toMatchObject({
      name: 'BridgeRefusedError',
      statusCode: 409,
    });

    const d0 = await store.getDevice('dev_0');
    await store.putDevice({ ...d0!, revokedAt: new Date(T0).toISOString() });

    await expect(claim(code, T0 + 2000, 'sixth', 'linux')).resolves.toHaveProperty('token');
  });

  it('re-pairing the SAME computer (name + os) replaces its old pairing instead of adding a device', async () => {
    const first = await createInstallCode({ userId: 'u1', context: ctx, now: T0 });
    const old = await claim(first.code, T0 + 1000, 'Studio Mac');
    const second = await createInstallCode({ userId: 'u1', context: ctx, now: T0 + 2000 });
    const fresh = await claim(second.code, T0 + 3000, 'Studio Mac');

    const active = (await store.listDevices('u1')).filter((d) => !d.revokedAt);
    expect(active.map((d) => d.id)).toEqual([fresh.deviceId]);
    expect((await store.getDevice(old.deviceId))?.revokedAt).toBeTruthy();
  });
});
