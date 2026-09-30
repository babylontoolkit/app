import { createPublicKey, createPrivateKey, type KeyObject } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- the key tool lives outside app/; this spec proves the two signers agree
import { generateKeys, signGrantWith } from '../../../../scripts/bridge-grant-key.mjs';
import { NotConfiguredError } from '~/lib/.server/env';
import { BridgeRefusedError } from './auth';
import {
  GRANT_ISSUER,
  grantTtlSeconds,
  issueAutomationGrant,
  loadGrantPrivateKey,
  signGrant,
  verifyGrant,
  type AutomationGrantPayload,
} from './grant';
import { resetBridgeRelayForTests, touchDevice } from './relay';

const checkAccessForUser = vi.fn();

vi.mock('~/lib/.server/licensing/subscriber-status', () => ({
  checkAccessForUser: (...args: unknown[]) => checkAccessForUser(...args),
}));

const GUID = 'f435f3e6ae3b441248ae556fc2ef566e';
const OTHER_GUID = '0123456789abcdef0123456789abcdef';
const NOW = 1_800_000_000;

let privateKeyB64: string;
let privateKey: KeyObject;
let publicKey: KeyObject;
let otherPrivateKey: KeyObject;

function payload(overrides: Partial<AutomationGrantPayload> = {}): AutomationGrantPayload {
  return { v: 1, iss: GRANT_ISSUER, sub: 'user-1', dev: 'dev_1', prj: GUID, iat: NOW, exp: NOW + 43_200, ...overrides };
}

function ctx(vars: Record<string, string> = {}) {
  return { cloudflare: { env: vars } };
}

function hello(productGuid: string) {
  touchDevice('dev_1', {
    protocol: 1,
    helperVersion: '1.0.0',
    os: 'darwin',
    scriptsDisabledLocally: false,
    unityProjects: [{ key: 'k1', name: 'BabylonToolkit-2024', productGuid }],
  });
}

beforeAll(() => {
  const keys = generateKeys();
  privateKeyB64 = keys.privateKeyB64;
  privateKey = createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  publicKey = createPublicKey(privateKey);

  const other = generateKeys();
  otherPrivateKey = createPrivateKey({
    key: Buffer.from(other.privateKeyB64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
});

beforeEach(() => {
  // The env() fallback trap: .env.local is loaded into process.env, so "unset" must be made true.
  vi.stubEnv('BRIDGE_GRANT_PRIVATE_KEY', undefined as unknown as string);
  vi.stubEnv('BRIDGE_GRANT_TTL_HOURS', undefined as unknown as string);
  resetBridgeRelayForTests();
  checkAccessForUser.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetBridgeRelayForTests();
});

describe('signGrant / verifyGrant', () => {
  it('round-trips to the payload', () => {
    const p = payload();
    expect(verifyGrant(signGrant(p, privateKey), publicKey, GUID, NOW)).toEqual(p);
  });

  it('rejects a grant with one payload character flipped', () => {
    const grant = signGrant(payload(), privateKey);
    const [head, sig] = grant.split('.');
    const flipped = head.slice(0, 5) + (head[5] === 'A' ? 'B' : 'A') + head.slice(6);
    expect(verifyGrant(`${flipped}.${sig}`, publicKey, GUID, NOW)).toBe('signature does not match');
  });

  it('rejects a grant signed by a different key', () => {
    expect(verifyGrant(signGrant(payload(), otherPrivateKey), publicKey, GUID, NOW)).toBe('signature does not match');
  });

  it('rejects a malformed grant', () => {
    expect(verifyGrant('abc', publicKey, GUID, NOW)).toBe('malformed grant');
    expect(verifyGrant('a.b.c', publicKey, GUID, NOW)).toBe('malformed grant');
  });

  it('rejects an expired grant', () => {
    const p = payload({ iat: NOW - 50_000, exp: NOW - 1 });
    expect(verifyGrant(signGrant(p, privateKey), publicKey, GUID, NOW)).toBe('grant expired');
  });

  it('rejects a grant issued 10 minutes in the future', () => {
    const p = payload({ iat: NOW + 600, exp: NOW + 600 + 3600 });
    expect(verifyGrant(signGrant(p, privateKey), publicKey, GUID, NOW)).toBe('grant issued in the future');
  });

  it('rejects a lifetime over 24 hours', () => {
    const p = payload({ iat: NOW, exp: NOW + 90_000 });
    expect(verifyGrant(signGrant(p, privateKey), publicKey, GUID, NOW)).toBe('grant lifetime too long');
  });

  it('rejects a grant for another project', () => {
    const p = payload({ prj: OTHER_GUID });
    expect(verifyGrant(signGrant(p, privateKey), publicKey, GUID, NOW)).toBe('grant is for a different project');
  });

  it('rejects a wrong version and a wrong issuer', () => {
    const v2 = { ...payload(), v: 2 } as unknown as AutomationGrantPayload;
    expect(verifyGrant(signGrant(v2, privateKey), publicKey, GUID, NOW)).toBe('unsupported grant version');
    expect(verifyGrant(signGrant(payload({ iss: 'someone-else' }), privateKey), publicKey, GUID, NOW)).toBe(
      'wrong issuer',
    );
  });
});

describe('grantTtlSeconds', () => {
  it('defaults to 12 hours when unset', () => {
    expect(grantTtlSeconds(ctx())).toBe(43_200);
  });

  it('clamps to 1..24 hours and falls back on garbage', () => {
    expect(grantTtlSeconds(ctx({ BRIDGE_GRANT_TTL_HOURS: '48' }))).toBe(86_400);
    expect(grantTtlSeconds(ctx({ BRIDGE_GRANT_TTL_HOURS: '0' }))).toBe(3600);
    expect(grantTtlSeconds(ctx({ BRIDGE_GRANT_TTL_HOURS: 'x' }))).toBe(43_200);
  });
});

describe('loadGrantPrivateKey', () => {
  it('throws NotConfiguredError when the env is unset', () => {
    expect(() => loadGrantPrivateKey(ctx())).toThrow(NotConfiguredError);
  });

  it('throws NotConfiguredError for garbage without echoing it', () => {
    let caught: unknown;

    try {
      loadGrantPrivateKey(ctx({ BRIDGE_GRANT_PRIVATE_KEY: 'bm90LWEta2V5' }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(NotConfiguredError);
    expect((caught as Error).message).not.toContain('bm90LWEta2V5');
  });
});

describe('issueAutomationGrant', () => {
  const input = () => ({
    userId: 'user-1',
    deviceId: 'dev_1',
    productGuid: GUID,
    context: ctx({ BRIDGE_GRANT_PRIVATE_KEY: privateKeyB64 }),
    nowSec: NOW,
  });

  it('refuses an inactive account with a 403 and no grant', async () => {
    hello(GUID);
    checkAccessForUser.mockResolvedValue({ active: false, reason: 'none' });

    const result = issueAutomationGrant(input());
    await expect(result).rejects.toBeInstanceOf(BridgeRefusedError);
    await expect(result).rejects.toMatchObject({ statusCode: 403 });
    expect(checkAccessForUser).toHaveBeenCalledWith('user-1', input().context);
  });

  it('refuses a productGuid the device never advertised with a 403', async () => {
    hello(OTHER_GUID);
    checkAccessForUser.mockResolvedValue({ active: true, reason: 'credits' });

    await expect(issueAutomationGrant(input())).rejects.toMatchObject({
      name: 'BridgeRefusedError',
      statusCode: 403,
    });
    expect(checkAccessForUser).not.toHaveBeenCalled();
  });

  it('refuses a malformed productGuid with a 400', async () => {
    hello(GUID);
    checkAccessForUser.mockResolvedValue({ active: true, reason: 'credits' });

    await expect(issueAutomationGrant({ ...input(), productGuid: 'xyz' })).rejects.toMatchObject({
      name: 'BridgeRefusedError',
      statusCode: 400,
    });
  });

  it('issues a grant verifyGrant accepts, with sub/dev/prj set', async () => {
    hello(GUID);
    checkAccessForUser.mockResolvedValue({ active: true, reason: 'credits' });

    const { grant, expiresAt } = await issueAutomationGrant({ ...input(), productGuid: GUID.toUpperCase() });
    const verified = verifyGrant(grant, publicKey, GUID, NOW);

    expect(typeof verified).toBe('object');
    expect(verified).toMatchObject({ sub: 'user-1', dev: 'dev_1', prj: GUID, iat: NOW, exp: NOW + 43_200 });
    expect(expiresAt).toBe(new Date((NOW + 43_200) * 1000).toISOString());
  });

  it('answers NotConfiguredError when entitled but the key is unset', async () => {
    hello(GUID);
    checkAccessForUser.mockResolvedValue({ active: true, reason: 'credits' });

    await expect(issueAutomationGrant({ ...input(), context: ctx() })).rejects.toBeInstanceOf(NotConfiguredError);
  });
});

describe('the key tool', () => {
  it('signGrantWith produces a grant verifyGrant accepts (the two signers agree)', () => {
    const p = payload();
    const grant = signGrantWith(privateKeyB64, p);

    expect(grant).toBe(signGrant(p, privateKey));
    expect(verifyGrant(grant, publicKey, GUID, NOW)).toEqual(p);
  });
});
