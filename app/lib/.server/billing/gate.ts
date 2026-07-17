/**
 * The credit gate and settlement (SPEC §4.2 steps 1 & 6, §4.6, §4.6.1).
 *
 * Two moments, and the asymmetry between them is the whole design:
 *
 * - **The GATE runs once, BEFORE the model is called.** It is a cheap balance check at a single choke
 *   point. It can refuse to start.
 * - **SETTLEMENT runs once, AFTER the stream is drained**, against tokens the model ACTUALLY spent.
 *   It can never refuse — the money is already gone. It just records the truth.
 *
 * That is why the gate is not a reservation system. Reserving credits up-front would mean estimating
 * a generation's cost before it runs (we cannot: the tool loop's length is not knowable in advance)
 * and would strand credits on every crash. Instead we let a generation that overshoots drive the
 * balance negative and refuse the NEXT one — §4.2.1's "in-flight generations are never killed for
 * balance". The exposure is bounded by one generation, which is a price worth paying to never yank a
 * game out from under a user mid-build.
 */
import { createScopedLogger } from '~/utils/logger';
import { getLedger } from './ledger';
import { getGenerationStore } from './generations';
import { creditsForUsage, getBillingConfig, rawCostUsd, type TokenUsage } from './rates';

const logger = createScopedLogger('credit-gate');

/**
 * - `byok` — a verified Pro entitlement; the user's own key pays, so no credits are charged (§4.6.1).
 * - `unmetered` — `BILLING_ENFORCED=false`, the beta default. Usage is fully recorded; nobody is blocked.
 * - `credits` — the launch mode. A zero balance is the one thing that can refuse a generation.
 */
export type CreditGateResult =
  | { allowed: true; mode: 'byok' }
  | { allowed: true; mode: 'unmetered'; balance: number }
  | { allowed: true; mode: 'credits'; balance: number }
  | { allowed: false; mode: 'credits'; balance: number; message: string };

export interface CreditGateInput {
  userId: string;

  /** Set only when the server has VERIFIED an active Pro entitlement. Never trusted from the client. */
  byok?: boolean;

  context?: unknown;
}

export async function checkCreditGate(input: CreditGateInput): Promise<CreditGateResult> {
  const config = getBillingConfig(input.context);

  /*
   * BYOK short-circuits the balance entirely — their key pays for the tokens, so a zero platform
   * balance is irrelevant. `byok` reaching here already means the entitlement was server-verified
   * (see `entitlements.ts`); this function does not re-check it.
   */
  if (input.byok) {
    return { allowed: true, mode: 'byok' };
  }

  const balance = await getLedger(input.context).balance(input.userId);

  if (!config.enforced) {
    return { allowed: true, mode: 'unmetered', balance };
  }

  if (balance <= 0) {
    return {
      allowed: false,
      mode: 'credits',
      balance,
      message:
        balance < 0
          ? 'You are out of credits. Add more to keep building.'
          : 'You are out of credits. Add more to keep building.',
    };
  }

  return { allowed: true, mode: 'credits', balance };
}

export interface SettleInput {
  userId: string;
  generationId: string;
  model: string;

  /**
   * The provider that ACTUALLY served this generation — it decides the rates (`ratesFor`).
   *
   * Required, with no default, on purpose: the same model id costs 2.5x more on Anthropic than on KIE,
   * so a defaulted provider here would over-bill every user the day the platform switches, silently.
   */
  provider: string;

  usage: TokenUsage;

  /** BYOK generations are RECORDED but charged zero (§4.5.4 point 6). */
  byok?: boolean;

  context?: unknown;
}

export interface Settlement {
  creditsCharged: number;
  rawCostUsd: number;
  balanceAfter: number;
}

/**
 * Charge for a completed generation.
 *
 * Called from the proxy's `finally`, so it runs for stopped and failed generations too — and that is
 * correct. A user who hits Stop after 30 seconds consumed real tokens, and §4.12 is explicit: bill
 * for what was actually consumed to the abort point, never the full estimate. The usage totals the
 * proxy accumulated ARE what was consumed.
 *
 * Never throws. A generation that succeeded must not be reported to the user as failed because our
 * bookkeeping hiccuped — we log loudly and move on, and the ledger's append-only history is what we
 * reconcile against later.
 */
export async function settleGeneration(input: SettleInput): Promise<Settlement | null> {
  const config = getBillingConfig(input.context);
  const cost = rawCostUsd(input.usage, input.model, input.provider, input.context);

  /*
   * BYOK: record zero. The generation still exists in the ledger's sibling `generations` record for
   * rate limits and analytics, but the user's own key paid the provider, so charging credits as well
   * would be double-billing.
   */
  const credits = input.byok ? 0 : creditsForUsage(input.usage, input.model, input.provider, config, input.context);

  /*
   * ⚠️ THE FOREIGN-KEY ANCHOR. This MUST happen before the debit, and it lives here rather than in the
   * caller because `credit_ledger.generation_id` REFERENCES `generations(id)` — Postgres rejects a
   * debit whose row does not exist yet, and the catch below would swallow that rejection and bill the
   * user zero. Forever, on every generation, silently. See `generations.ts`.
   *
   * Written even when `credits` is zero (BYOK, unmetered, a generation that produced nothing): the
   * generation HAPPENED, the admin cost dashboards are derived from these rows, and a later refund
   * names the same id.
   */
  try {
    await getGenerationStore(input.context).upsert({
      id: input.generationId,
      userId: input.userId,
      model: input.model,
      promptTokens: input.usage.promptTokens,
      completionTokens: input.usage.completionTokens,
      cacheReadTokens: input.usage.cacheReadTokens,
      cacheCreationTokens: input.usage.cacheCreationTokens,
      totalTokens: input.usage.promptTokens + input.usage.completionTokens,
      creditsCharged: credits,
      rawCostUsd: cost,

      /*
       * `completed`, not `running` — settlement runs AFTER the stream is drained, so by the time we
       * are here the generation is over. The proxy overwrites this with `failed` when it was. Callers
       * with no enrichment step (the prompt enhancer) would otherwise leave every row `running`
       * forever, and the admin cost dashboards are derived from these rows.
       */
      status: 'completed',
    });
  } catch (error) {
    // The debit is now guaranteed to fail. Say so plainly rather than letting it look like bad luck.
    logger.error(
      `Cannot anchor generation ${input.generationId} for ${input.userId} — the debit will be REJECTED ` +
        `by the foreign key and this generation will bill ZERO: ${(error as Error).message}`,
    );
  }

  if (credits <= 0) {
    return { creditsCharged: 0, rawCostUsd: cost, balanceAfter: await getLedger(input.context).balance(input.userId) };
  }

  try {
    const entry = await getLedger(input.context).append({
      userId: input.userId,
      delta: -credits,
      reason: 'generation',
      generationId: input.generationId,
      note: `${input.model}: ${input.usage.promptTokens} in / ${input.usage.completionTokens} out`,
    });

    logger.info(
      `Charged ${credits} credits to ${input.userId} for ${input.generationId} ` +
        `(raw $${cost.toFixed(4)}, balance ${entry.balanceAfter})`,
    );

    return { creditsCharged: credits, rawCostUsd: cost, balanceAfter: entry.balanceAfter };
  } catch (error) {
    // Loud, because this is money. But never fatal to the user's generation.
    logger.error(`FAILED TO CHARGE generation ${input.generationId} for ${input.userId}: ${(error as Error).message}`);

    return null;
  }
}

/**
 * Refund a generation that failed (§4.6: "failed generations auto-refund").
 *
 * A compensating row, never a deletion — the debit stays in the history and the refund sits beside
 * it, so the ledger still reconstructs to the right balance and the audit trail shows what happened.
 */
export async function refundGeneration(
  userId: string,
  generationId: string,
  credits: number,
  reason: string,
  context?: unknown,
): Promise<void> {
  if (credits <= 0) {
    return;
  }

  try {
    await getLedger(context).append({
      userId,
      delta: credits,
      reason: 'refund',
      generationId,
      note: reason,
    });

    logger.info(`Refunded ${credits} credits to ${userId} for failed generation ${generationId}`);
  } catch (error) {
    logger.error(`Failed to refund ${generationId}: ${(error as Error).message}`);
  }
}
