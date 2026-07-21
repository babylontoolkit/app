/**
 * Unity Project License price ladder (SPEC §4.18, §4.6.1).
 *
 * Generating a project license is a FLAT credit charge per tier — the credits-based replacement for the
 * retired PayPal annual Pro Tools subscription (owner decision 2026-07-20). Each tier is a one-time,
 * perpetual unlock of THAT Unity project at THAT tier ("once per project+tier, re-download free").
 *
 * Rates are CONFIG, never hardcoded at the call site (the standing billing rule): the ladder below is the
 * default, overridable per-deploy by env. The value is credits, not dollars — the whole point is that the
 * license charge rides the same credit balance as everything else, so it needs no USD→credit conversion.
 */
import { envNumber } from '~/lib/.server/env';
import type { UnityLicensePlan } from './unity-license';

/** The default price ladder, in credits. Enterprise Studio is the display name for `PremiumContent`. */
export const UNITY_LICENSE_TIER_DEFAULT_CREDITS: Record<UnityLicensePlan, number> = {
  Indie: 500,
  SmallBusiness: 1000,
  PremiumContent: 2000,
};

/** The env var that overrides each tier's price (credits). Absent/invalid → the default above. */
const ENV_KEY: Record<UnityLicensePlan, string> = {
  Indie: 'UNITY_LICENSE_CREDITS_INDIE',
  SmallBusiness: 'UNITY_LICENSE_CREDITS_SMALLBUSINESS',
  PremiumContent: 'UNITY_LICENSE_CREDITS_PREMIUMCONTENT',
};

/**
 * The flat credit price to generate a license at `tier`. Reads the env override, falling back to the
 * default ladder; a negative or non-finite override is ignored (a mis-set price must never become a
 * free or negative charge silently).
 */
export function unityLicensePriceCredits(tier: UnityLicensePlan, context?: unknown): number {
  const value = envNumber(context, ENV_KEY[tier], UNITY_LICENSE_TIER_DEFAULT_CREDITS[tier]);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : UNITY_LICENSE_TIER_DEFAULT_CREDITS[tier];
}
