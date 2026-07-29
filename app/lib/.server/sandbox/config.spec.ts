/**
 * The sandbox config numbers that cost money or leak credentials (SPEC §5, §8,
 * `spec/sandbox-codesandbox.md`).
 *
 * 🔴 `CODESANDBOX_HOST_TOKEN_MINUTES` sets the life of a BEARER credential that rides in an iframe
 * URL — the address bar of a popped-out preview, browser history, any proxy log the URL passes
 * through. Expiry is the ONLY thing that bounds the damage of one leaking, so an operator typo
 * (`60000` meaning "sixty") minting ~41-day tokens is a security regression that logs nothing and
 * shows nothing. Same posture as `sandboxHibernationSeconds`: a nonsensical override is IGNORED, not
 * obeyed.
 *
 * ⚠️ `env()` falls back to `process.env`, and vitest loads `.env.local` — so an "empty" context is
 * NOT empty. Every case stubs the variable explicitly (the `oauth.spec.ts` trap).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SANDBOX_HIBERNATION_SECONDS,
  DEFAULT_SANDBOX_HOST_TOKEN_MINUTES,
  DEFAULT_SANDBOX_VM_TIER,
  MAX_SANDBOX_HOST_TOKEN_MINUTES,
  SANDBOX_VM_TIERS,
  sandboxHibernationSeconds,
  sandboxHostTokenMinutes,
  sandboxVmTier,
} from './config';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sandboxHostTokenMinutes — the preview credential’s lifetime', () => {
  it('defaults to an hour when unset', () => {
    vi.stubEnv('CODESANDBOX_HOST_TOKEN_MINUTES', undefined as unknown as string);

    expect(sandboxHostTokenMinutes({})).toBe(DEFAULT_SANDBOX_HOST_TOKEN_MINUTES);
    expect(DEFAULT_SANDBOX_HOST_TOKEN_MINUTES).toBe(60);
  });

  it('honours a sane override', () => {
    vi.stubEnv('CODESANDBOX_HOST_TOKEN_MINUTES', '5');
    expect(sandboxHostTokenMinutes({})).toBe(5);
  });

  /** The ceiling is 24h, and the boundary itself is ACCEPTED — a clamp that rejects its own limit is off by one. */
  it('accepts exactly the 24-hour ceiling', () => {
    vi.stubEnv('CODESANDBOX_HOST_TOKEN_MINUTES', '1440');

    expect(sandboxHostTokenMinutes({})).toBe(1440);
    expect(MAX_SANDBOX_HOST_TOKEN_MINUTES).toBe(24 * 60);
  });

  /*
   * 🔴 THE TYPO. `60000` is ~41 days of a URL-borne bearer credential, minted silently. Falling back
   * to the default is the loud-by-comparison answer: the operator gets the documented behaviour
   * instead of an invisible security downgrade.
   */
  it('ignores an over-the-ceiling override rather than minting a 41-day token', () => {
    vi.stubEnv('CODESANDBOX_HOST_TOKEN_MINUTES', '60000');
    expect(sandboxHostTokenMinutes({})).toBe(DEFAULT_SANDBOX_HOST_TOKEN_MINUTES);

    vi.stubEnv('CODESANDBOX_HOST_TOKEN_MINUTES', '1441');
    expect(sandboxHostTokenMinutes({})).toBe(DEFAULT_SANDBOX_HOST_TOKEN_MINUTES);
  });

  /*
   * The other direction is just as broken and much noisier: `0` or a negative would mint a token that
   * is dead on arrival, i.e. a preview that 401s from the first frame.
   */
  it('ignores a zero, negative, or unparseable override', () => {
    for (const bad of ['0', '-5', 'sixty', '', 'NaN']) {
      vi.stubEnv('CODESANDBOX_HOST_TOKEN_MINUTES', bad);
      expect(sandboxHostTokenMinutes({})).toBe(DEFAULT_SANDBOX_HOST_TOKEN_MINUTES);
    }
  });
});

/**
 * 🔴 THE TIER SPELLING, WHICH IS A MONEY FIX (2026-07-28).
 *
 * `CODESANDBOX_VM_TIER` had two readers that disagreed about what counts as a match: `service.ts`
 * resolves it case-INSENSITIVELY, while `billing/vm-cost.ts` looks the name up EXACTLY. So a lowercase
 * value ran one tier and priced another — `micro` ran Micro ($0.298) and billed the unknown-tier
 * fallback ($0.149), a 2× UNDER-statement; `xlarge` under-stated by 32×. The fallback is conservative
 * only while the real tier is cheaper than the dearest measured one; above it the error inverts into
 * the silent direction. Normalising here is what makes the two readers agree about the VALUE.
 */
describe('sandboxVmTier — one spelling, so two readers cannot disagree', () => {
  it.each(['nano', 'NANO', '  nano  ', 'nAnO'])('normalises %j to the canonical spelling', (raw) => {
    vi.stubEnv('CODESANDBOX_VM_TIER', raw);
    expect(sandboxVmTier({})).toBe('Nano');
  });

  /*
   * The list is looped rather than spelled out so a tier added to `SANDBOX_VM_TIERS` later is covered
   * for free — the property is "every accepted spelling round-trips", not "these four strings do".
   */
  it('round-trips every canonical tier from its own lowercase form', () => {
    for (const tier of SANDBOX_VM_TIERS) {
      vi.stubEnv('CODESANDBOX_VM_TIER', tier.toLowerCase());
      expect(sandboxVmTier({})).toBe(tier);
    }

    expect(SANDBOX_VM_TIERS).toContain(DEFAULT_SANDBOX_VM_TIER);
  });

  it.each([
    ['unset', undefined as unknown as string],
    ['empty', ''],
    ['whitespace only', '   '],
  ])('falls back to the default tier when %s', (_label, raw) => {
    vi.stubEnv('CODESANDBOX_VM_TIER', raw);
    expect(sandboxVmTier({})).toBe(DEFAULT_SANDBOX_VM_TIER);
  });

  /*
   * ⚠️ An unrecognised name is returned UNCHANGED rather than coerced, deliberately. Each reader
   * already has a considered fallback for a name it does not know, and they are conservative in
   * OPPOSITE directions on purpose: the provider degrades to Pico (a typo cannot silently boot an
   * XLarge) and billing prices at the dearest measured tier (a typo cannot silently under-charge).
   * Collapsing them here would trade a loud, safe divergence for a quiet, uniform guess.
   */
  it('returns an unrecognised name unchanged rather than coercing it to a tier', () => {
    vi.stubEnv('CODESANDBOX_VM_TIER', 'Gigantic');

    expect(sandboxVmTier({})).toBe('Gigantic');
    expect(sandboxVmTier({})).not.toBe(DEFAULT_SANDBOX_VM_TIER);
  });

  it('reads the Cloudflare loader context, not only process.env', () => {
    vi.stubEnv('CODESANDBOX_VM_TIER', 'pico');
    expect(sandboxVmTier({ cloudflare: { env: { CODESANDBOX_VM_TIER: 'micro' } } })).toBe('Micro');
  });
});

/** The clamp T8 added is modelled on this one; pinned together so they cannot drift apart. */
describe('sandboxHibernationSeconds — the cost lever it is modelled on', () => {
  it('defaults, honours a sane override, and ignores a nonsensical one', () => {
    vi.stubEnv('CODESANDBOX_HIBERNATION_SECONDS', undefined as unknown as string);
    expect(sandboxHibernationSeconds({})).toBe(DEFAULT_SANDBOX_HIBERNATION_SECONDS);

    vi.stubEnv('CODESANDBOX_HIBERNATION_SECONDS', '600');
    expect(sandboxHibernationSeconds({})).toBe(600);

    for (const bad of ['0', '-1', '86401', 'soon']) {
      vi.stubEnv('CODESANDBOX_HIBERNATION_SECONDS', bad);
      expect(sandboxHibernationSeconds({})).toBe(DEFAULT_SANDBOX_HIBERNATION_SECONDS);
    }
  });
});
