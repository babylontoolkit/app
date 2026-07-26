/**
 * Unity Project License money path (SPEC §4.18, §4.6.1).
 *
 * Generating a license is a FLAT credit charge per tier (the price ladder) — the credits-based
 * replacement for the retired PayPal annual Pro Tools subscription. The billing shape follows 'media'
 * (debit BEFORE issue, may never overdraw), but simpler: issuing a license is pure, deterministic crypto,
 * so there is nothing async to poll and nothing to refund on a "render failure".
 *
 *   choose tier → already unlocked? → issue FREE
 *                 not unlocked?     → DEBIT flat price (refused on insufficient balance) → record unlock → issue
 *
 * "Once per project+tier, re-download free" (owner decision 2026-07-20): the unlock is recorded against
 * the UNITY project id + tier, so re-generating or re-downloading the same pair never charges again, and
 * choosing a higher tier is a separate, full charge. The credit gate is the entitlement — no credits, no
 * Pro Tools. This module does no HTTP and no auth; the route owns the two walls.
 */
import { createScopedLogger } from '~/utils/logger';
import { getMonitor } from '~/lib/.server/monitoring';
import { recordRefundOutcome } from '~/lib/.server/monitoring/paid-path-rates';
import { ALERT_SIGNALS } from '~/lib/.server/monitoring/events';
import { getLedger } from '~/lib/.server/billing/ledger';
import { getBillingConfig } from '~/lib/.server/billing/rates';
import {
  buildUnityLicense,
  isValidLicenseTier,
  tierForPlanName,
  UNITY_LICENSE_PLANS,
  UNITY_LICENSE_PLAN_LABELS,
  type UnityLicense,
  type UnityLicensePlan,
} from './unity-license';
import { unityLicensePriceCredits } from './unity-license-pricing';
import { getLicenseEntitlementStore } from './license-entitlements';

const logger = createScopedLogger('unity-license-service');

export class LicenseRefusedError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 422) {
    super(message);
    this.name = 'LicenseRefusedError';
    this.statusCode = statusCode;
  }
}

export interface GenerateLicenseInput {
  userId: string;

  /** The authenticated platform user's email (Supabase-verified — becomes `licensee`). */
  licensee: string;

  /** The linked Unity project GUID (already validated by the route). */
  unityProjectId: string;

  /** The App Builder project name (display/free text — becomes `project`). */
  projectName: string;

  /** The chosen tier (the paid ladder selection). */
  tier: UnityLicensePlan;

  context?: unknown;
}

export interface GeneratedLicense {
  license: UnityLicense;
  tier: UnityLicensePlan;

  /** Credits debited for THIS generation — 0 when the pair was already unlocked (free re-download). */
  credits: number;

  /** True when no charge was made because the (unity project, tier) was already unlocked. */
  alreadyUnlocked: boolean;
}

/**
 * Issue a license, charging the flat tier price the first time a (unity project, tier) is unlocked and
 * free every time after. Throws `LicenseRefusedError` on an invalid tier or (with billing enforced) an
 * insufficient balance.
 */
export async function generateUnityLicense(input: GenerateLicenseInput): Promise<GeneratedLicense> {
  if (!isValidLicenseTier(input.tier)) {
    throw new LicenseRefusedError(`"${input.tier}" is not a valid license tier.`, 400);
  }

  const unlocks = getLicenseEntitlementStore(input.context);
  const unityProjectId = input.unityProjectId.trim().toLowerCase();

  const license = buildUnityLicense({
    plan: input.tier,
    licensee: input.licensee,
    unityProjectId,
    projectName: input.projectName,
  });

  // Already paid for this exact (unity project, tier) → re-issue for free (deterministic, same bytes).
  if (await unlocks.has(input.userId, unityProjectId, input.tier)) {
    return { license, tier: input.tier, credits: 0, alreadyUnlocked: true };
  }

  const price = unityLicensePriceCredits(input.tier, input.context);
  const config = getBillingConfig(input.context);
  const ledger = getLedger(input.context);

  /*
   * DEBIT BEFORE ISSUE — reason 'license' may never overdraw (migration 0012), so with billing enforced
   * an insufficient balance throws here and no license is issued. Unmetered mode (beta/local) records the
   * debit when the balance covers it and otherwise charges nothing (must not block, must not overdraw).
   */
  let ledgerEntryId: string | undefined;
  let debited = 0;

  try {
    const entry = await ledger.append({
      userId: input.userId,
      delta: -price,
      reason: 'license',
      note: `unity license: ${input.tier} for ${unityProjectId}`,
    });
    ledgerEntryId = entry.id;
    debited = price;
  } catch (error) {
    if (config.enforced) {
      throw new LicenseRefusedError(
        `Not enough credits: a ${UNITY_LICENSE_PLAN_LABELS[input.tier]} license costs ${price} credits. ` +
          `Add credits to generate it.`,
        402,
      );
    }

    logger.warn(`Unmetered license (${input.tier}/${unityProjectId}) not debited (${(error as Error).message}).`);
  }

  /*
   * Record the unlock so every future generation of this pair is free. If this fails AFTER a real debit,
   * refund — otherwise the user paid and the next generation would charge again.
   */
  let granted = true;

  try {
    ({ granted } = await unlocks.grant(input.userId, unityProjectId, input.tier, ledgerEntryId));
  } catch (error) {
    if (debited > 0) {
      await refundLicense(input.userId, debited, (error as Error).message, input.context);
    }

    recordRefundOutcome(getMonitor(input.context), 'license', true);

    throw new LicenseRefusedError(`Could not record the license unlock: ${(error as Error).message}`, 500);
  }

  /*
   * The unlock ALREADY EXISTED even though `has()` said it did not — a concurrent generation of the same
   * (user, unity project, tier) raced us between the check and the grant (double-click, parallel tabs), or
   * a replay. The unique index (migration 0012) kept exactly ONE unlock, so OUR debit is redundant: refund
   * it and report the generation as free. Without this the loser of the race is charged twice for one
   * perpetual unlock, silently — the TOCTOU hole the flat-fee model would otherwise open.
   */
  if (!granted && debited > 0) {
    await refundLicense(input.userId, debited, 'a concurrent generation already unlocked this tier', input.context);
    recordRefundOutcome(getMonitor(input.context), 'license', true);

    return { license, tier: input.tier, credits: 0, alreadyUnlocked: true };
  }

  logger.info(`Issued ${input.tier} license for ${unityProjectId} to ${input.userId} (${debited} credits).`);
  recordRefundOutcome(getMonitor(input.context), 'license', false);

  return { license, tier: input.tier, credits: debited, alreadyUnlocked: false };
}

/** The compensating row for the rare grant-after-debit failure (mirrors media's refund rule). */
async function refundLicense(userId: string, credits: number, reason: string, context?: unknown): Promise<void> {
  try {
    await getLedger(context).append({
      userId,
      delta: credits,
      reason: 'refund',
      note: `unity license refund: ${reason.slice(0, 200)}`,
    });
    logger.info(`Refunded ${credits} credits to ${userId} for a license that could not be recorded.`);
  } catch (error) {
    // Charged for a license that was never unlocked, and the request already failed. Alert (rule 4).
    logger.error(`FAILED TO REFUND license charge for ${userId}: ${(error as Error).message}`);
    getMonitor(context).alert(
      ALERT_SIGNALS.LEDGER_INTEGRITY,
      `Refund of ${credits} credits for an unrecorded Unity license did NOT land — the user is still ` +
        `charged for an unlock they do not have: ${(error as Error).message}`,
      { severity: 'critical', scope: 'license-refund', userId, tags: { credits } },
    );
  }
}

export interface LicenseTierOffer {
  tier: UnityLicensePlan;
  label: string;
  credits: number;
  seats: { s1: string; s2: string };

  /** True when the user has already unlocked this (unity project, tier) — the UI shows "re-download free". */
  unlocked: boolean;
}

/**
 * The tier ladder to show for a linked Unity project: each tier's price and whether it is already
 * unlocked. When there is no linked project, `unlocked` is false for every tier (nothing to key against).
 */
export async function describeLicenseTiers(
  userId: string,
  unityProjectId: string | null,
  context?: unknown,
): Promise<LicenseTierOffer[]> {
  const unlockedTiers = unityProjectId
    ? new Set(await getLicenseEntitlementStore(context).listTiers(userId, unityProjectId.trim().toLowerCase()))
    : new Set<UnityLicensePlan>();

  return UNITY_LICENSE_PLANS.map((tier) => {
    const seats = tierForPlanName(tier);

    return {
      tier,
      label: UNITY_LICENSE_PLAN_LABELS[tier],
      credits: unityLicensePriceCredits(tier, context),
      seats: { s1: seats.s1, s2: seats.s2 },
      unlocked: unlockedTiers.has(tier),
    };
  });
}
