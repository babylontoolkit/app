/**
 * Unity Project Licenser — tier mapping + license assembly (SPEC §4.18).
 *
 * The crypto primitives are pinned separately by the live vector (`unity-license-crypto.spec.ts`); this
 * spec pins the PURE layer above them: the plan→tier map (with its no-throw contract), the tier validator,
 * and the license field contract — including the project lock (a license for project A must not validate
 * for project B, which here means a different `key`).
 *
 * Tier is now a paid SELECTION (the §4.18 credit price ladder), no longer derived from a Stripe plan —
 * so `buildUnityLicense` takes a `plan`, and `tierForPlanName` maps the plan STRING to its seat values.
 */
import { describe, expect, it } from 'vitest';
import { decryptLicenseSecret } from './unity-license-crypto';
import {
  buildUnityLicense,
  isValidLicenseTier,
  isValidUnityProjectId,
  tierForPlanName,
  UNITY_LICENSE_PLANS,
  UNITY_LICENSE_PLAN_LABELS,
  type BuildUnityLicenseInput,
} from './unity-license';

const GUID_A = '0123456789abcdef0123456789abcdef';
const GUID_B = 'fedcba9876543210fedcba9876543210';

describe('tierForPlanName', () => {
  it('maps SmallBusiness → blank editable seats', () => {
    expect(tierForPlanName('SmallBusiness')).toEqual({ plan: 'SmallBusiness', s1: '', s2: '' });
  });

  it('maps PremiumContent → unlimited seats', () => {
    expect(tierForPlanName('PremiumContent')).toEqual({ plan: 'PremiumContent', s1: 'unlimited', s2: 'unlimited' });
  });

  it('maps Indie → locked seats', () => {
    expect(tierForPlanName('Indie')).toEqual({ plan: 'Indie', s1: 'locked', s2: 'locked' });
  });

  it('degrades an unrecognised value to Indie (never throws)', () => {
    expect(() => tierForPlanName('sub_bogus' as never)).not.toThrow();
    expect(tierForPlanName('sub_bogus' as never)).toEqual({ plan: 'Indie', s1: 'locked', s2: 'locked' });
    expect(tierForPlanName('' as never)).toEqual({ plan: 'Indie', s1: 'locked', s2: 'locked' });
  });
});

describe('isValidLicenseTier', () => {
  it('accepts exactly the three issued plans', () => {
    for (const plan of UNITY_LICENSE_PLANS) {
      expect(isValidLicenseTier(plan)).toBe(true);
    }

    expect(isValidLicenseTier('Indie')).toBe(true);
    expect(isValidLicenseTier('SmallBusiness')).toBe(true);
    expect(isValidLicenseTier('PremiumContent')).toBe(true);
  });

  it('rejects junk, empty, wrong-case, and non-strings', () => {
    expect(isValidLicenseTier('indie')).toBe(false);
    expect(isValidLicenseTier('premiumcontent')).toBe(false);
    expect(isValidLicenseTier('sub_pro')).toBe(false);
    expect(isValidLicenseTier('')).toBe(false);
    expect(isValidLicenseTier(null)).toBe(false);
    expect(isValidLicenseTier(undefined)).toBe(false);
    expect(isValidLicenseTier(42)).toBe(false);
    expect(isValidLicenseTier({ plan: 'Indie' })).toBe(false);
  });
});

describe('UNITY_LICENSE_PLAN_LABELS', () => {
  it('shows "Enterprise Studio" for PremiumContent while the plan STRING stays byte-compat', () => {
    expect(UNITY_LICENSE_PLAN_LABELS.PremiumContent).toBe('Enterprise Studio');
    expect(UNITY_LICENSE_PLAN_LABELS.Indie).toBe('Indie');
    expect(UNITY_LICENSE_PLAN_LABELS.SmallBusiness).toBe('Small Business');
  });

  it('lists the plans cheapest-first', () => {
    expect(UNITY_LICENSE_PLANS).toEqual(['Indie', 'SmallBusiness', 'PremiumContent']);
  });
});

describe('isValidUnityProjectId', () => {
  it('accepts exactly 32 hex chars (either case, surrounding whitespace)', () => {
    expect(isValidUnityProjectId(GUID_A)).toBe(true);
    expect(isValidUnityProjectId(GUID_A.toUpperCase())).toBe(true);
    expect(isValidUnityProjectId(`  ${GUID_A}  `)).toBe(true);
  });

  it('rejects empty / 31 / 33 / non-hex', () => {
    expect(isValidUnityProjectId('')).toBe(false);
    expect(isValidUnityProjectId('   ')).toBe(false);
    expect(isValidUnityProjectId(GUID_A.slice(0, 31))).toBe(false);
    expect(isValidUnityProjectId(`${GUID_A}a`)).toBe(false);
    expect(isValidUnityProjectId('0123456789abcdef0123456789abcdeg')).toBe(false);
    expect(isValidUnityProjectId(undefined as unknown as string)).toBe(false);
  });
});

describe('buildUnityLicense — field contract', () => {
  const base: BuildUnityLicenseInput = {
    plan: 'SmallBusiness',
    licensee: 'dev@example.com',
    unityProjectId: GUID_A,
    projectName: 'My Game',
  };

  it('sets server-derived fields and the SmallBusiness tier', () => {
    const lic = buildUnityLicense(base);
    expect(lic.licensee).toBe('dev@example.com');
    expect(lic.product).toBe(GUID_A);
    expect(lic.project).toBe('My Game');
    expect(lic.plan).toBe('SmallBusiness');
    expect(lic.org).toBe('*');
    expect(lic.trial).toBe(false);
    expect(lic.expires).toBe('never');
    expect(lic.s1).toBe('');
    expect(lic.s2).toBe('');
  });

  it('encodes the secret as plan|licensee|org|product|project|expires', () => {
    const lic = buildUnityLicense(base);
    expect(decryptLicenseSecret(lic.secret)).toBe(`SmallBusiness|dev@example.com|*|${GUID_A}|My Game|never`);
  });

  it('normalises the Unity project id to lowercase in product, secret, and key seed', () => {
    const lic = buildUnityLicense({ ...base, unityProjectId: `  ${GUID_A.toUpperCase()}  ` });
    expect(lic.product).toBe(GUID_A);
    expect(decryptLicenseSecret(lic.secret)).toContain(`|${GUID_A}|`);

    // The lowercased key equals a license built from the already-lowercased id.
    expect(lic.key).toBe(buildUnityLicense(base).key);
  });

  it('carries Indie tier fields for an Indie selection', () => {
    const lic = buildUnityLicense({ ...base, plan: 'Indie' });
    expect(lic.plan).toBe('Indie');
    expect(lic.s1).toBe('locked');
    expect(lic.s2).toBe('locked');
    expect(decryptLicenseSecret(lic.secret).startsWith('Indie|')).toBe(true);
  });

  it('carries PremiumContent tier fields for a studio selection', () => {
    const lic = buildUnityLicense({ ...base, plan: 'PremiumContent' });
    expect(lic.plan).toBe('PremiumContent');
    expect(lic.s1).toBe('unlimited');
    expect(lic.s2).toBe('unlimited');
  });

  it('locks the key to the Unity project — two different ids yield different keys', () => {
    const a = buildUnityLicense({ ...base, unityProjectId: GUID_A });
    const b = buildUnityLicense({ ...base, unityProjectId: GUID_B });
    expect(a.key).not.toBe(b.key);
  });

  it('is deterministic — the same inputs produce byte-identical license bytes', () => {
    expect(JSON.stringify(buildUnityLicense(base))).toBe(JSON.stringify(buildUnityLicense(base)));
  });
});
