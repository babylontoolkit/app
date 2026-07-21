/**
 * Unity Project License MONEY PATH (SPEC §4.18, §4.6.1, spec/billing.md).
 *
 * Generating a license is a FLAT credit charge per tier, debited BEFORE the license is issued and (for
 * reason 'license') never allowed to overdraw. The rules pinned here each spend or protect real money and
 * fail silently when wrong — the same category as `media.spec.ts` and the credit gate:
 *
 *   - the FIRST generation of a (unity project, tier) debits EXACTLY the tier price and records the unlock;
 *   - every later generation of that pair is FREE and returns identical bytes;
 *   - a different tier is an independent, full charge;
 *   - with billing enforced, an insufficient balance REFUSES — no unlock, nothing partial;
 *   - unmetered mode never blocks and never overdraws, but still records the unlock;
 *   - a grant failure AFTER a real debit is refunded exactly once.
 *
 * ⚠️ oauth.spec trap: `env()` falls back to `process.env` (vitest loads `.env.local`), so every var that
 * changes enforcement or the price — and the Supabase selector — is stubbed explicitly.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsLedger, setLedger, type LedgerEntry } from '~/lib/.server/billing/ledger';
import { getLicenseEntitlementStore, resetLicenseEntitlementStoreForTests } from './license-entitlements';
import { describeLicenseTiers, generateUnityLicense, type GenerateLicenseInput } from './unity-license-service';

const USER = 'user-1';
const EMAIL = 'dev@example.com';
const GUID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

const INDIE_PRICE = 500;
const SMALL_BUSINESS_PRICE = 1000;
const PREMIUM_PRICE = 2000;

let tmp: string;
let ledger: FsLedger;

const PRICE_ENV = [
  'UNITY_LICENSE_CREDITS_INDIE',
  'UNITY_LICENSE_CREDITS_SMALLBUSINESS',
  'UNITY_LICENSE_CREDITS_PREMIUMCONTENT',
] as const;

beforeEach(async () => {
  // Force the FS backends (never Supabase, never the developer's real .data/) and default prices.
  vi.stubEnv('SUPABASE_URL', undefined as unknown as string);
  vi.stubEnv('SUPABASE_ANON_KEY', undefined as unknown as string);

  for (const key of PRICE_ENV) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'unity-license-svc-'));
  vi.stubEnv('PLATFORM_DATA_DIR', tmp);

  ledger = new FsLedger(path.join(tmp, 'ledger'));
  setLedger(ledger);
  resetLicenseEntitlementStoreForTests();

  // Enforced by default; the unmetered block turns it off.
  vi.stubEnv('BILLING_ENFORCED', 'true');
});

afterEach(async () => {
  setLedger(undefined);
  resetLicenseEntitlementStoreForTests();
  await fs.rm(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function grant(credits: number) {
  await ledger.append({ userId: USER, delta: credits, reason: 'grant' });
}

function input(overrides: Partial<GenerateLicenseInput> = {}): GenerateLicenseInput {
  return {
    userId: USER,
    licensee: EMAIL,
    unityProjectId: GUID,
    projectName: 'My Game',
    tier: 'Indie',
    context: {},
    ...overrides,
  };
}

describe('generateUnityLicense — first unlock (billing enforced)', () => {
  it('debits EXACTLY the tier price, drops the balance, and records the unlock', async () => {
    await grant(2000);

    const result = await generateUnityLicense(input({ tier: 'Indie' }));

    expect(result.credits).toBe(INDIE_PRICE);
    expect(result.alreadyUnlocked).toBe(false);
    expect(result.tier).toBe('Indie');
    expect(result.license.plan).toBe('Indie');
    expect(result.license.product).toBe(GUID);

    expect(await ledger.balance(USER)).toBe(2000 - INDIE_PRICE);

    // The unlock is recorded against the UNITY project + tier.
    const store = getLicenseEntitlementStore({});
    expect(await store.has(USER, GUID, 'Indie')).toBe(true);

    // The debit landed as a 'license' row for exactly the price.
    const rows = await ledger.list(USER);
    const debit = rows.find((r: LedgerEntry) => r.reason === 'license');
    expect(debit?.delta).toBe(-INDIE_PRICE);
  });

  it('prices each tier from the ladder (SmallBusiness 1000, PremiumContent 2000)', async () => {
    await grant(5000);

    expect((await generateUnityLicense(input({ tier: 'SmallBusiness' }))).credits).toBe(SMALL_BUSINESS_PRICE);

    // PremiumContent is a separate project so it is a distinct first unlock.
    expect((await generateUnityLicense(input({ tier: 'PremiumContent' }))).credits).toBe(PREMIUM_PRICE);

    expect(await ledger.balance(USER)).toBe(5000 - SMALL_BUSINESS_PRICE - PREMIUM_PRICE);
  });
});

describe('generateUnityLicense — re-generation is free', () => {
  it('charges 0 on the second generate of the same (project, tier) and returns identical bytes', async () => {
    await grant(2000);

    const first = await generateUnityLicense(input({ tier: 'Indie' }));
    const balanceAfterFirst = await ledger.balance(USER);

    const second = await generateUnityLicense(input({ tier: 'Indie' }));

    expect(second.credits).toBe(0);
    expect(second.alreadyUnlocked).toBe(true);
    expect(await ledger.balance(USER)).toBe(balanceAfterFirst);

    // Deterministic crypto → byte-identical license.
    expect(JSON.stringify(second.license)).toBe(JSON.stringify(first.license));
  });

  it('a DIFFERENT tier for the same project is a separate, full charge', async () => {
    await grant(3000);

    await generateUnityLicense(input({ tier: 'Indie' }));

    const afterIndie = await ledger.balance(USER);

    const small = await generateUnityLicense(input({ tier: 'SmallBusiness' }));

    expect(small.credits).toBe(SMALL_BUSINESS_PRICE);
    expect(small.alreadyUnlocked).toBe(false);
    expect(await ledger.balance(USER)).toBe(afterIndie - SMALL_BUSINESS_PRICE);
  });
});

describe('generateUnityLicense — refusals', () => {
  it('REFUSES a bad tier with 400 and moves no money', async () => {
    await grant(2000);

    await expect(generateUnityLicense(input({ tier: 'bogus' as never }))).rejects.toMatchObject({
      name: 'LicenseRefusedError',
      statusCode: 400,
    });

    expect(await ledger.balance(USER)).toBe(2000);
  });

  it('REFUSES with 402 when the balance cannot cover it — no unlock, nothing partial', async () => {
    await grant(100);

    await expect(generateUnityLicense(input({ tier: 'Indie' }))).rejects.toMatchObject({
      name: 'LicenseRefusedError',
      statusCode: 402,
    });

    // The debit was refused whole: balance unchanged, no unlock recorded.
    expect(await ledger.balance(USER)).toBe(100);

    const store = getLicenseEntitlementStore({});
    expect(await store.has(USER, GUID, 'Indie')).toBe(false);
  });
});

describe('generateUnityLicense — unmetered mode', () => {
  beforeEach(() => vi.stubEnv('BILLING_ENFORCED', 'false'));

  it('issues and records the unlock WITHOUT debiting when the balance cannot cover it', async () => {
    // No grant at all — the 'license' reason may not go negative, so the debit is skipped, not overdrawn.
    const result = await generateUnityLicense(input({ tier: 'PremiumContent' }));

    expect(result.credits).toBe(0);
    expect(result.alreadyUnlocked).toBe(false);
    expect(result.license.plan).toBe('PremiumContent');

    expect(await ledger.balance(USER)).toBe(0);

    const store = getLicenseEntitlementStore({});
    expect(await store.has(USER, GUID, 'PremiumContent')).toBe(true);
  });

  it('still records the debit when the balance covers it', async () => {
    await grant(2000);

    const result = await generateUnityLicense(input({ tier: 'Indie' }));

    expect(result.credits).toBe(INDIE_PRICE);
    expect(await ledger.balance(USER)).toBe(2000 - INDIE_PRICE);
  });
});

describe('generateUnityLicense — refund path (grant fails after a real debit)', () => {
  it('appends a compensating refund and refuses with 500 when the unlock cannot be recorded', async () => {
    await grant(2000);

    const store = getLicenseEntitlementStore({});
    vi.spyOn(store, 'grant').mockRejectedValueOnce(new Error('db down'));

    await expect(generateUnityLicense(input({ tier: 'Indie' }))).rejects.toMatchObject({
      name: 'LicenseRefusedError',
      statusCode: 500,
    });

    // The debit came straight back — net zero movement.
    expect(await ledger.balance(USER)).toBe(2000);

    const rows = await ledger.list(USER);
    expect(rows.find((r: LedgerEntry) => r.reason === 'license')?.delta).toBe(-INDIE_PRICE);
    expect(rows.find((r: LedgerEntry) => r.reason === 'refund')?.delta).toBe(INDIE_PRICE);
  });
});

describe('generateUnityLicense — concurrent-unlock race (TOCTOU double-charge guard)', () => {
  it('refunds the redundant debit and reports free when a concurrent generate already unlocked the tier', async () => {
    await grant(2000);

    /*
     * Simulate the race: `has()` still says false (we got past the short-circuit), but by the time we
     * `grant()` the unique index has already recorded the unlock from a parallel generation, so grant
     * returns { granted: false } WITHOUT throwing. Our debit is redundant and must be refunded.
     */
    const store = getLicenseEntitlementStore({});
    vi.spyOn(store, 'grant').mockResolvedValueOnce({ granted: false });

    const result = await generateUnityLicense(input({ tier: 'Indie' }));

    expect(result.credits).toBe(0);
    expect(result.alreadyUnlocked).toBe(true);

    // Charged then refunded — net zero, never a silent double charge.
    expect(await ledger.balance(USER)).toBe(2000);

    const rows = await ledger.list(USER);
    expect(rows.find((r: LedgerEntry) => r.reason === 'license')?.delta).toBe(-INDIE_PRICE);
    expect(rows.find((r: LedgerEntry) => r.reason === 'refund')?.delta).toBe(INDIE_PRICE);
  });
});

describe('describeLicenseTiers', () => {
  it('returns all three tiers with ladder prices and unlocked reflecting the store', async () => {
    await grant(2000);
    await generateUnityLicense(input({ tier: 'Indie' }));

    const offers = await describeLicenseTiers(USER, GUID, {});

    expect(offers.map((o) => o.tier)).toEqual(['Indie', 'SmallBusiness', 'PremiumContent']);
    expect(offers.map((o) => o.credits)).toEqual([INDIE_PRICE, SMALL_BUSINESS_PRICE, PREMIUM_PRICE]);
    expect(offers.find((o) => o.tier === 'Indie')?.unlocked).toBe(true);
    expect(offers.find((o) => o.tier === 'SmallBusiness')?.unlocked).toBe(false);
    expect(offers.find((o) => o.tier === 'PremiumContent')?.unlocked).toBe(false);
    expect(offers.find((o) => o.tier === 'PremiumContent')?.label).toBe('Enterprise Studio');
  });

  it('reports nothing unlocked when there is no linked Unity project', async () => {
    const offers = await describeLicenseTiers(USER, null, {});

    expect(offers).toHaveLength(3);
    expect(offers.every((o) => o.unlocked === false)).toBe(true);
  });
});
