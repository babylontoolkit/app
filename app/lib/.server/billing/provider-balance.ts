/**
 * How much provider credit is left in the pool every user's generation draws from (SPEC §4.10).
 *
 * ## What this answers
 *
 * The credit ledger (§4.6) tracks what USERS owe us. This tracks what WE have left with the provider —
 * the other side of the same trade, and the one nothing on the platform could see. Every generation,
 * every media render and every enhancement debits this pool; when it hits zero the product stops for
 * everybody at once, with no warning anywhere in the app. An operator needs the runway number.
 *
 * ## Why a USD figure is derived rather than reported
 *
 * KIE's endpoint returns a bare credit count (`{"code":200,"data":87028.41}`) with no unit attached.
 * The conversion was MEASURED, not assumed (2026-07-26): a calibration run of 6 requests with a fresh
 * cacheable prefix consumed **7.78 KIE credits** for **8,818 write + 17,636 read + 6 output tokens**,
 * which at the platform's own Opus 4.8 rates ($2/M in, $10/M out, write 2x, read 0.1x) is **$0.03886**
 * — i.e. **200.2 credits per dollar**. That it lands on 200.0 to within a quarter of a percent is also
 * an independent confirmation that KIE bills the published Anthropic rates our price list charges
 * against, which until now was only inferred from their pricing feed.
 *
 * `KIE_CREDITS_PER_USD` is env-overridable because it is a fact about someone else's pricing page and
 * can change without notice. The measurement above is the default and the reason for it.
 *
 * ## Failure posture (`spec/fail-loud.md` rule 2)
 *
 * Reporting a balance we could not read as "fine" is the exact failure `premiumSessionHint` exists to
 * prevent — an operator seeing a healthy number is *more* dangerous than seeing nothing, because they
 * stop checking. So every failure returns a null balance with a stated `reason`, and the caller renders
 * "unknown", never zero and never a stale guess. It also NEVER throws: this is one field on an admin
 * dashboard, and a provider outage must not take that page down with it.
 */
import { env } from '~/lib/.server/env';
import { getBillingConfigSafe } from './rates';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('provider-balance');

/** KIE's account-credit endpoint. Bare credit count, no unit, `{code, msg, data}` envelope. */
const KIE_CREDIT_URL = 'https://api.kie.ai/api/v1/chat/credit';

/** Measured 2026-07-26 — see the module doc comment for the calibration run. */
const DEFAULT_CREDITS_PER_USD = 200;

/** A provider round trip per dashboard render would be silly; the number moves slowly. */
const CACHE_TTL_MS = 60_000;

export interface ProviderBalance {
  /** Raw credits as the provider reports them. `null` when we could not find out. */
  credits: number | null;

  /** `credits` at the measured conversion — an ESTIMATE, and labelled as one wherever it is shown. */
  usd: number | null;

  /**
   * How many PLATFORM credits that USD could still serve, at the current unit cost and margin.
   *
   * The runway number an operator actually wants: not "how much money is left" but "how much product
   * is left". Derived from the same `creditRates` the biller uses, so it cannot drift from real pricing.
   */
  platformCreditsRemaining: number | null;

  creditsPerUsd: number;
  fetchedAt: string;

  /** Present ONLY when the balance is unknown. Rendered verbatim — never swallowed into a zero. */
  reason?: string;
}

let cached: { at: number; value: ProviderBalance } | null = null;

/** Test seam — the cache is module state and would leak between cases. */
export function resetProviderBalanceCache(): void {
  cached = null;
}

/**
 * Convert a provider credit balance into the numbers an operator can act on.
 *
 * Pure and exported so the arithmetic is testable without a network: the failure modes here are a
 * wrong runway estimate, which is a number someone makes a purchasing decision on.
 */
export function describeProviderBalance(input: {
  credits: number | null;
  creditsPerUsd: number;
  creditUnitCostUsd: number;
  margin: number;
  fetchedAt: string;
  reason?: string;
}): ProviderBalance {
  const { credits, creditsPerUsd, creditUnitCostUsd, margin, fetchedAt, reason } = input;

  if (credits === null || !Number.isFinite(credits) || creditsPerUsd <= 0) {
    return {
      credits: null,
      usd: null,
      platformCreditsRemaining: null,
      creditsPerUsd,
      fetchedAt,
      reason: reason ?? 'The provider balance could not be read.',
    };
  }

  const usd = credits / creditsPerUsd;

  /*
   * The same formula the biller charges by, inverted: a platform credit retails for
   * `creditUnitCostUsd` and is priced at `margin` times raw cost, so one dollar of provider spend
   * becomes `margin / creditUnitCostUsd` platform credits of sellable product.
   */
  const platformCreditsRemaining =
    creditUnitCostUsd > 0 && margin > 0 ? Math.floor((usd / creditUnitCostUsd) * margin) : null;

  return { credits, usd, platformCreditsRemaining, creditsPerUsd, fetchedAt };
}

/**
 * Read the provider's remaining credit, cached briefly. Never throws.
 *
 * "Never throws" is a claim `api.admin.usage.ts` relies on IN A COMMENT — it wraps the VM report in a
 * try/catch and deliberately does not wrap this one. That claim quietly stopped being true when
 * `getBillingConfig` gained its retired-variable refusal (§4.4a): a leftover `CREATION_FLAT_CREDITS`
 * 500ed the whole Admin usage dashboard, i.e. the surface an operator opens to diagnose billing. The
 * config read is `getBillingConfigSafe` now, so an unreadable configuration degrades this to
 * "remaining platform credits unknown" (the margin formula needs both rates and reports `null`
 * without them) rather than taking the panel down — `premiumSessionHint`'s rule that a degraded
 * capability reports off, never on, applied to a number.
 *
 * The key is read server-side and used to make the call — it is never returned, logged, or included in
 * any part of the result (§5: a server route may ACT on a secret, never EMIT one).
 */
export async function getProviderBalance(context?: unknown): Promise<ProviderBalance> {
  const now = Date.now();

  if (cached && now - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  const billing = getBillingConfigSafe(context);
  const creditsPerUsd = Number(env(context, 'KIE_CREDITS_PER_USD')) || DEFAULT_CREDITS_PER_USD;
  const fetchedAt = new Date(now).toISOString();

  const base = {
    creditsPerUsd,

    /* 0 is the "unknown" input to `describeProviderBalance`'s guard — it yields `null`, never a lie. */
    creditUnitCostUsd: billing?.creditUnitCostUsd ?? 0,
    margin: billing?.margin ?? 0,
    fetchedAt,
  };

  const key = env(context, 'KIE_API_KEY');

  if (!key) {
    // Not configured is a legitimate state (local dev, BYOK-only deploys) — say so, do not alarm.
    return describeProviderBalance({ ...base, credits: null, reason: 'KIE_API_KEY is not configured.' });
  }

  let value: ProviderBalance;

  try {
    const response = await fetch(KIE_CREDIT_URL, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });

    /*
     * ⚠️ KIE returns its own `code` INSIDE a 200 body — an expired key comes back as
     * `HTTP 200 {"code":401,...}`. Checking `response.ok` alone reports an auth failure as a healthy
     * read of a zero balance, which is precisely the "degraded reports ON" failure this module refuses
     * to commit. Both are checked.
     */
    const payload = (await response.json()) as { code?: number; msg?: string; data?: unknown };

    if (!response.ok || (payload.code !== undefined && payload.code !== 200)) {
      value = describeProviderBalance({
        ...base,
        credits: null,
        reason: `The provider refused the balance request (${payload.code ?? response.status}${payload.msg ? `: ${payload.msg}` : ''}).`,
      });
    } else if (typeof payload.data !== 'number') {
      value = describeProviderBalance({
        ...base,
        credits: null,
        reason: 'The provider returned a balance in an unexpected shape.',
      });
    } else {
      value = describeProviderBalance({ ...base, credits: payload.data });
    }
  } catch (error) {
    /*
     * Sanctioned swallow (`spec/fail-loud.md` rule 4): this is an observability read, not a money
     * path — nothing was charged and nothing is owed. It reports "unknown" rather than a number.
     */
    value = describeProviderBalance({
      ...base,
      credits: null,
      reason: `The provider balance could not be reached: ${(error as Error).message}`,
    });
  }

  if (value.reason) {
    logger.warn(`Provider balance unavailable — ${value.reason}`);
  }

  cached = { at: now, value };

  return value;
}
