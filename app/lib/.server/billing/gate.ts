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
import { getMonitor } from '~/lib/.server/monitoring';
import { ALERT_SIGNALS } from '~/lib/.server/monitoring/events';
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

  /**
   * Require at least this many credits instead of merely "more than zero".
   *
   * ⚠️ RETAINED, BUT NOTHING SETS IT (§4.4a, 2026-07-29). It existed for FLAT-PRICED creation turns:
   * when the price of a turn is known up front, letting a 10-credit balance start a 500-credit
   * creation is not the bounded one-generation overshoot the gate's design accepts — it is a knowable
   * deep negative. There is no such turn any more (the flat charge moved ahead of the generation, to
   * project registration under `decideProjectCreateCharge`), and `proxy.ts` passes no minimum: no
   * turn's cost is knowable pre-flight. Kept because it is a tested pure lever an operator could want
   * back; pinned uncalled by `creation-flat.spec.ts`. ⚠️ Its refusal message still says "Creating a
   * new project costs N credits" — copy written for the charge that moved. Re-enable this for
   * anything else and the wording has to move with it.
   */
  minimumCredits?: number;

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

  const minimum = Math.max(0, Math.floor(input.minimumCredits ?? 0));

  if (minimum > 0 && balance < minimum) {
    return {
      allowed: false,
      mode: 'credits',
      balance,
      message: `Creating a new project costs ${minimum} credits and you have ${balance}. Add credits to start it.`,
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

  /**
   * `creation` | `edit` | `repair` | `plan` | `enhance` — how the credits ledger LABELS this row.
   *
   * Deliberately a free string rather than `AgentStatusKind`: that union describes what the AGENT is
   * doing (it drives the heartbeat panel), and `enhance` is not an agent turn — it has no heartbeat,
   * no tools and no project. The ledger's vocabulary is a superset of the agent's, and forcing them
   * into one type would either put a non-agent kind in the agent's union or leave the enhancer
   * unlabelled.
   */
  statusKind?: string;

  usage: TokenUsage;

  /** BYOK generations are RECORDED but charged zero (§4.5.4 point 6). */
  byok?: boolean;

  /**
   * Charge EXACTLY this many credits instead of the cost-derived amount.
   *
   * ⚠️ RETAINED, BUT NOTHING PASSES IT (§4.4a, 2026-07-29) — this was the FLAT creation price;
   * `proxy.ts` now settles every turn cost-derived. `rawCostUsd` is still computed and recorded
   * unchanged whichever way this goes, so the Admin usage report keeps watching realized margin.
   * Ignored for BYOK (their key paid) and for a generation that consumed nothing (a nothing-generation
   * must stay free — a flat price charges for work, not for an instant failure). Pinned uncalled, and
   * pinned CORRECT, by `creation-flat.spec.ts`.
   */
  flatCredits?: number;

  /**
   * CAP the cost-derived charge.
   *
   * ⚠️ RETAINED, BUT NOTHING PASSES IT (§4.4a, 2026-07-29) — it was set for a STOPPED creation turn:
   * §4.12 says bill what was actually consumed, and the flat price was the advertised ceiling, so a
   * Stop charged min(consumed, flat). With no flat price there is no advertised ceiling to hold a Stop
   * to, and a Stop simply bills what it consumed. Mutually exclusive with `flatCredits` by
   * construction at any call site; if both arrive, the flat price wins.
   */
  maxCredits?: number;

  context?: unknown;
}

export interface Settlement {
  creditsCharged: number;
  rawCostUsd: number;
  balanceAfter: number;
}

/**
 * 🔴 THE CUSTOMER IS NEVER BILLED FOR THE STATE OF OUR CACHE (owner rule, 2026-08-07).
 *
 * A cache WRITE bills at 2x input; a cache READ bills at 0.1x. That is a **20x swing on the identical
 * request**, decided entirely by whether some *other* user happened to send the same prefix in the last
 * hour. Measured: the same "mario kart racer" creation is 144 credits warm and 600 cold — and
 * `gen_msixapaq_i871b6` reached **1,489** when a forced continuation wrote the ~212k prefix a second
 * time. The user did not cause that, cannot observe it, cannot avoid it, and cannot be told a story
 * about it that does not sound like a bug. One such invoice loses the account permanently.
 *
 * So the BILLED view of a turn prices cache-creation tokens at the READ rate — i.e. the customer always
 * pays the warm price, and the platform absorbs the difference. That puts the cost of a cold cache on
 * the only party that can actually do anything about it, which is the correct incentive: it is what
 * makes shrinking the prefix (`spec/context-budget.md`) an engineering problem instead of a trust one.
 *
 * ⚠️ **This must NEVER be applied to `rawCostUsd`.** That number is what the generation genuinely cost
 * us, and it is what the §4.10 Admin margin report is derived from. Route it through here and the
 * platform loses its only view of what it is absorbing — silently, and in the direction where the
 * dashboards look healthier than the bank account. `settleGeneration` deliberately computes `cost` from
 * the TRUE usage and `credits` from this view; the ledger has stored the two separately since day one.
 *
 * ⚠️ Not applied to `grantHeadroom` either, and that is deliberate: sizing the free grant against the
 * COLD price keeps that assertion conservative (it now understates the headroom, which is the safe
 * direction for a floor).
 */
export function billedUsage(usage: TokenUsage): TokenUsage {
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,

    /* Priced as if the prefix had been warm — which, for everyone but the first caller, it was. */
    cacheReadTokens: usage.cacheReadTokens + usage.cacheCreationTokens,
    cacheCreationTokens: 0,
  };
}

/**
 * What a generation is charged — cost-derived by default, overridden by the flat/cap fields.
 *
 * Pure and exported because a wrong answer here is a silent mis-bill in one direction or a silent
 * giveaway in the other (the same category as `decidePremium` / the auto-repair loop): BYOK is always
 * zero; a generation that consumed NOTHING is always zero (flat pricing must never turn an instant
 * failure into a 500-credit debit — the auto-refund would usually mask it, but "usually" is not a
 * money guarantee); a flat price replaces the formula; a cap bounds it.
 */
export function decideCredits(
  input: Pick<SettleInput, 'usage' | 'model' | 'provider' | 'byok' | 'flatCredits' | 'maxCredits' | 'context'>,
  config: ReturnType<typeof getBillingConfig>,
): number {
  if (input.byok) {
    return 0;
  }

  const consumed =
    input.usage.promptTokens +
    input.usage.completionTokens +
    input.usage.cacheReadTokens +
    input.usage.cacheCreationTokens;

  if (consumed <= 0) {
    return 0;
  }

  const flat = Math.floor(input.flatCredits ?? 0);

  if (flat > 0) {
    return flat;
  }

  /*
   * `billedUsage`, not `input.usage` — the customer pays the warm price whether or not the cache was
   * warm (see the note above). `consumed` above still reads the TRUE vector, so "this generation
   * spent nothing" stays a question about reality rather than about pricing policy.
   */
  const derived = creditsForUsage(billedUsage(input.usage), input.model, input.provider, config, input.context);
  const cap = Math.floor(input.maxCredits ?? 0);

  return cap > 0 ? Math.min(derived, cap) : derived;
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

  /*
   * TRUE usage — cache writes at the write rate. This is the honest cost, and the ONLY place the
   * platform can see what it absorbed under `billedUsage`. Never route it through that view.
   */
  const cost = rawCostUsd(input.usage, input.model, input.provider, input.context);

  /*
   * BYOK: record zero. The generation still exists in the ledger's sibling `generations` record for
   * rate limits and analytics, but the user's own key paid the provider, so charging credits as well
   * would be double-billing.
   */
  const credits = decideCredits(input, config);

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

      /*
       * WHICH GATEWAY SPENT THE MONEY. Written HERE, where settlement already knows it, rather than
       * left to each caller's enrichment step.
       *
       * It was absent from this payload while `input.provider` was used two lines below to PRICE the
       * turn — so the proxy stamped it in its own later update and the enhancer, which has no such
       * step, wrote rows with no provider at all (observed live 2026-08-11). With `AUTO_MODEL_SELECT`
       * the gateway varies per request, so a row that cannot say which one served it cannot be
       * reconciled against an invoice, and the §4.10 per-provider view silently excludes every
       * enhancement.
       */
      provider: input.provider,

      /*
       * WHAT KIND of turn this was, when the caller knows at settlement time.
       *
       * The proxy sets this in its own enrichment upsert (`statusKindFor`), but the enhancer has no
       * enrichment step — so every enhancement rendered as the generic "Generation" in the credits
       * ledger, which is the complaint that produced `status_kind` in the first place ("everything
       * cant be a Generation"). Optional and `?? null`, so a caller that does not know cannot clobber
       * a value an earlier upsert already wrote.
       */
      statusKind: input.statusKind,
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
    /*
     * The debit is now guaranteed to fail. Say so plainly rather than letting it look like bad luck —
     * and say it somewhere an operator will SEE. A log line is what this was for a year, which is
     * precisely how the original FK defect could have billed zero on every generation forever
     * (`spec/fail-loud.md` rule 4: a swallow on a money path must refund, retry, or REPORT).
     */
    logger.error(
      `Cannot anchor generation ${input.generationId} for ${input.userId} — the debit will be REJECTED ` +
        `by the foreign key and this generation will bill ZERO: ${(error as Error).message}`,
    );
    getMonitor(input.context).alert(
      ALERT_SIGNALS.LEDGER_INTEGRITY,
      `Generation ${input.generationId} could not be anchored — its debit will be rejected and this ` +
        `generation will bill ZERO: ${(error as Error).message}`,
      { severity: 'critical', scope: 'settle-generation', userId: input.userId, tags: { model: input.model } },
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

      /*
       * A flat-priced debit says so in the audit trail — a 500-credit row beside a $0.20 raw cost reads
       * as a mis-bill to anyone reconciling the ledger unless the note names the pricing model.
       */
      note:
        `${input.model}: ${input.usage.promptTokens} in / ${input.usage.completionTokens} out` +
        (Math.floor(input.flatCredits ?? 0) > 0 && credits > 0 ? ' — flat creation price' : ''),
    });

    logger.info(
      `Charged ${credits} credits to ${input.userId} for ${input.generationId} ` +
        `(raw $${cost.toFixed(4)}, balance ${entry.balanceAfter})`,
    );

    return { creditsCharged: credits, rawCostUsd: cost, balanceAfter: entry.balanceAfter };
  } catch (error) {
    // Loud, because this is money. But never fatal to the user's generation.
    logger.error(`FAILED TO CHARGE generation ${input.generationId} for ${input.userId}: ${(error as Error).message}`);
    getMonitor(input.context).alert(
      ALERT_SIGNALS.LEDGER_INTEGRITY,
      `Generation ${input.generationId} consumed ${credits} credits that could not be debited: ` +
        `${(error as Error).message}`,
      { severity: 'critical', scope: 'settle-generation', userId: input.userId, tags: { model: input.model, credits } },
    );

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
    /*
     * The user is now charged for OUR failure and nothing downstream can notice: the request has
     * already ended in an error, and this is the compensating step that was supposed to make that
     * honest. Alert — there is no other loudness left on this path.
     */
    logger.error(`Failed to refund ${generationId}: ${(error as Error).message}`);
    getMonitor(context).alert(
      ALERT_SIGNALS.LEDGER_INTEGRITY,
      `Refund of ${credits} credits for failed generation ${generationId} did NOT land — the user is ` +
        `still charged for a failure: ${(error as Error).message}`,
      { severity: 'critical', scope: 'refund-generation', userId, tags: { generationId, credits } },
    );
  }
}
