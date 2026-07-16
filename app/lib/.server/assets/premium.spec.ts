import { describe, expect, it } from 'vitest';
import { decidePremiumAssetAdd } from './premium';
import type { CatalogItem } from './catalog';

const free: CatalogItem = { id: 'a', title: 'Free', kind: 'scene', premium: false };
const premium: CatalogItem = { id: 'b', title: 'Premium', kind: 'prefab', premium: true, priceCents: 900 };

describe('decidePremiumAssetAdd', () => {
  it('allows a free item regardless of entitlement or Stripe state', () => {
    expect(decidePremiumAssetAdd({ item: free, entitled: false, stripeConfigured: false })).toEqual({
      allow: true,
      reason: 'free',
    });
  });

  it('allows a premium item the user already owns', () => {
    expect(decidePremiumAssetAdd({ item: premium, entitled: true, stripeConfigured: true })).toEqual({
      allow: true,
      reason: 'entitled',
    });
  });

  it('refuses an unowned premium item with a purchase prompt when Stripe is configured', () => {
    expect(decidePremiumAssetAdd({ item: premium, entitled: false, stripeConfigured: true })).toEqual({
      allow: false,
      reason: 'needs-purchase',
      priceCents: 900,
    });
  });

  it('refuses with a not-configured state when Stripe is off (never a stub, never a free pass)', () => {
    expect(decidePremiumAssetAdd({ item: premium, entitled: false, stripeConfigured: false })).toEqual({
      allow: false,
      reason: 'payments-not-configured',
    });
  });

  it('never lets an unowned premium item through — the only allow paths are free or entitled', () => {
    for (const stripeConfigured of [true, false]) {
      const decision = decidePremiumAssetAdd({ item: premium, entitled: false, stripeConfigured });
      expect(decision.allow).toBe(false);
    }
  });
});
