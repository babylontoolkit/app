/**
 * Unity Project License unlock records (SPEC §4.18) — the FS backend, against a temp dir.
 *
 * One row per (user, unity project, tier) the user has PAID to unlock, so "once per project+tier,
 * re-download free" holds. The unlock is keyed to the UNITY project id (the productGUID the license is
 * locked to), NOT the App Builder project — the independence tests below are that rule.
 *
 * ⚠️ ISOLATION: the FS store writes `license_entitlements.jsonl` under `platformDataDir()`, which honors
 * `PLATFORM_DATA_DIR`. Stubbing that to a temp dir (and NOT Supabase) is what keeps this out of the
 * developer's real `.data/` — the same seam trap `message-store.spec.ts` and `oauth.spec.ts` document.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getLicenseEntitlementStore,
  resetLicenseEntitlementStoreForTests,
  type LicenseEntitlementStore,
} from './license-entitlements';

const USER = 'user-1';
const OTHER = 'user-2';
const GUID_A = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const GUID_B = '00112233445566778899aabbccddeeff';

let tmp: string;
let store: LicenseEntitlementStore;

beforeEach(async () => {
  // Force the FS backend and point it at a throwaway dir — never Supabase, never real .data/.
  vi.stubEnv('SUPABASE_URL', undefined as unknown as string);
  vi.stubEnv('SUPABASE_ANON_KEY', undefined as unknown as string);

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'license-ent-'));
  vi.stubEnv('PLATFORM_DATA_DIR', tmp);

  resetLicenseEntitlementStoreForTests();
  store = getLicenseEntitlementStore({});
});

afterEach(async () => {
  resetLicenseEntitlementStoreForTests();
  await fs.rm(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('has / grant', () => {
  it('has() is false before anything is granted', async () => {
    expect(await store.has(USER, GUID_A, 'Indie')).toBe(false);
  });

  it('grant() records the unlock and flips has() to true', async () => {
    const result = await store.grant(USER, GUID_A, 'Indie');

    expect(result).toEqual({ granted: true });
    expect(await store.has(USER, GUID_A, 'Indie')).toBe(true);
  });

  it('grant() is idempotent — a second grant of the same tuple returns { granted: false }', async () => {
    expect(await store.grant(USER, GUID_A, 'SmallBusiness')).toEqual({ granted: true });
    expect(await store.grant(USER, GUID_A, 'SmallBusiness')).toEqual({ granted: false });

    // Still exactly one row (no duplicate append).
    expect(await store.listTiers(USER, GUID_A)).toEqual(['SmallBusiness']);
  });

  it('persists the ledger entry id when provided', async () => {
    await store.grant(USER, GUID_A, 'PremiumContent', 'led_123');

    const raw = await fs.readFile(path.join(tmp, 'license_entitlements.jsonl'), 'utf8');
    expect(JSON.parse(raw.trim())).toMatchObject({
      userId: USER,
      unityProjectId: GUID_A,
      tier: 'PremiumContent',
      ledgerEntryId: 'led_123',
    });
  });
});

describe('listTiers', () => {
  it('returns every tier a user has unlocked for a given project', async () => {
    await store.grant(USER, GUID_A, 'Indie');
    await store.grant(USER, GUID_A, 'PremiumContent');

    const tiers = await store.listTiers(USER, GUID_A);
    expect(tiers.sort()).toEqual(['Indie', 'PremiumContent']);
  });

  it('is empty for a project with no unlocks', async () => {
    expect(await store.listTiers(USER, GUID_A)).toEqual([]);
  });
});

describe('keys are independent across (user, unityProjectId, tier)', () => {
  it('a different tier for the same project is a separate unlock', async () => {
    await store.grant(USER, GUID_A, 'Indie');

    expect(await store.has(USER, GUID_A, 'Indie')).toBe(true);
    expect(await store.has(USER, GUID_A, 'SmallBusiness')).toBe(false);
  });

  it('a different Unity project is a separate unlock', async () => {
    await store.grant(USER, GUID_A, 'Indie');

    expect(await store.has(USER, GUID_B, 'Indie')).toBe(false);
    expect(await store.listTiers(USER, GUID_B)).toEqual([]);
  });

  it('a different user does not see another user unlock', async () => {
    await store.grant(USER, GUID_A, 'Indie');

    expect(await store.has(OTHER, GUID_A, 'Indie')).toBe(false);
    expect(await store.listTiers(OTHER, GUID_A)).toEqual([]);
  });
});
