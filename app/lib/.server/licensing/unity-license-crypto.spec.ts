/**
 * Unity Project Licenser crypto core — pinned by the LIVE license vector (SPEC §4.18, plan T1).
 *
 * The single live `license.json` at the repo root is the ground truth for all three primitives. Because
 * the AES key + IV are fixed, encryption is deterministic: decrypting the vector's `secret` yields the
 * observed pipe-delimited payload, and re-encrypting that payload MUST reproduce the exact base64. If
 * any of these assertions ever fail, the crypto has drifted from `licenser.cs` and every generated
 * license would be rejected by the unchanged Unity Editor — so this spec is a hard gate, not a sample.
 *
 * Observed by decrypting the live vector during T1 (never assumed blind):
 *   secret  → "EnterprisePartner|Mackey Kinard|*|*|*|never"
 *   key     → "CFA7-9108-9069-F09C-ED6F-1A68-8AB7" == hash("EnterprisePartner-Mackey Kinard")
 */
import { describe, expect, it } from 'vitest';
import {
  computeProjectLicenseKeyHash,
  decryptLicenseSecret,
  dotnetPasswordDeriveBytes,
  encryptLicenseSecret,
} from './unity-license-crypto';

// The live vector (repo-root license.json).
const LIVE_SECRET = 'Q1BnvaTaoQ3Bx4ym/C5e3tB10OVxgOmloIrUh8wt7sXom6aq6A46JF3eV9VSBodT';
const LIVE_KEY = 'CFA7-9108-9069-F09C-ED6F-1A68-8AB7';
const OBSERVED_PAYLOAD = 'EnterprisePartner|Mackey Kinard|*|*|*|never';

describe('unity-license-crypto: live vector', () => {
  it('decrypts the live secret to the observed pipe-delimited payload', () => {
    expect(decryptLicenseSecret(LIVE_SECRET)).toBe(OBSERVED_PAYLOAD);
  });

  it('re-encrypts the observed payload to the exact live base64 (deterministic key+IV)', () => {
    expect(encryptLicenseSecret(OBSERVED_PAYLOAD)).toBe(LIVE_SECRET);
  });

  it('computes the live license key hash from the plan-product seed', () => {
    expect(computeProjectLicenseKeyHash('EnterprisePartner-Mackey Kinard')).toBe(LIVE_KEY);
  });
});

describe('unity-license-crypto: round-trips', () => {
  it('round-trips an ASCII payload', () => {
    const payload = 'SmallBusiness|dev@example.com|*|0123456789abcdef0123456789abcdef|My Game|never';
    expect(decryptLicenseSecret(encryptLicenseSecret(payload))).toBe(payload);
  });

  it('round-trips a non-ASCII payload (UTF-8 fidelity)', () => {
    const payload = 'PremiumContent|dévélopëur@münchen.de|*|abcdefabcdefabcdefabcdefabcdef12|Jörð 世界|never';
    expect(decryptLicenseSecret(encryptLicenseSecret(payload))).toBe(payload);
  });

  it('round-trips an empty payload', () => {
    expect(decryptLicenseSecret(encryptLicenseSecret(''))).toBe('');
  });
});

describe('unity-license-crypto: key derivation', () => {
  it('derives a stable 32-byte key from the fixed key phrase', () => {
    const key = dotnetPasswordDeriveBytes('12bucklemyshoe', 32);
    expect(key).toHaveLength(32);

    // Pinned: the exact derived key that produces the live vector.
    expect(key.toString('hex')).toBe('77229a4c66dc7b439648899e28d520c51dd136016e252e2a54748cf38c7b0f5e');
  });

  it('is deterministic', () => {
    expect(dotnetPasswordDeriveBytes('12bucklemyshoe', 32).toString('hex')).toBe(
      dotnetPasswordDeriveBytes('12bucklemyshoe', 32).toString('hex'),
    );
  });
});

describe('unity-license-crypto: key hash formatting', () => {
  it('emits 28 hex chars in seven dash-grouped quads', () => {
    const key = computeProjectLicenseKeyHash('Indie-0123456789abcdef0123456789abcdef');
    expect(key).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){6}$/);
  });

  it('locks the key to the seed — different products differ', () => {
    const a = computeProjectLicenseKeyHash('Indie-0123456789abcdef0123456789abcdef');
    const b = computeProjectLicenseKeyHash('Indie-fedcba9876543210fedcba9876543210');
    expect(a).not.toBe(b);
  });
});
