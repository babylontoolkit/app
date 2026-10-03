/**
 * "~N credits so far" for a running managed turn (`_specs/managed-billing-visibility_plan.md` D1).
 *
 * Owner, 2026-10-02: *"I see a bunch of media render, but no AI TIME for actually creating the game… if
 * this was live I would basically have eaten that cost."* Nothing was eaten — a managed turn settles ONCE,
 * at its end — but for half an hour a build looked free, because nothing on screen said otherwise.
 *
 * The estimate is what settlement WOULD charge right now: the session's cumulative usage priced through
 * the SAME functions `settle.ts` uses (`sessionCost` → `decideManagedCharge`) against the chat's cursor
 * as it stood when the turn started. It writes nothing — the settled number is what the ledger shows.
 *
 * ## Sources
 *
 *   - `session.usage` events on the live stream — the session's cumulative usage, sent at each idle;
 *   - otherwise a throttled `sessions.retrieve` (at most once per {@link USAGE_REFRESH_MS}), kicked from
 *     the heartbeat's read so a long think still moves the number.
 *
 * ## What it assumes (DECISION lines)
 *
 *   - The session is ONE thread on the session's model — exact for the sessions this engine creates
 *     (no subagents); a subagent's tokens would be priced at the session model. It is an estimate.
 *   - A cursor in the PRE-v2 format (a session settled under the old design) shows no estimate: pricing it
 *     needs the legacy event walk, and an estimate that includes already-billed usage is worse than none.
 *   - A failed cursor read shows no estimate (we cannot know what was already charged).
 *
 * Never throws: the heartbeat that reads it is a liveness signal first.
 */
import type { ModelRates } from '~/lib/.server/billing/rates';
import type { SessionEventLike } from './events';
import {
  decideManagedCharge,
  EMPTY_COST_CURSOR,
  listCostCents,
  parseCostCursor,
  sessionCost,
  tokensOf,
  type ApiUsageLike,
  type BillingRates,
  type CostCursor,
} from './session-cost';

/** The fallback `sessions.retrieve` runs at most this often (D1: ≥ 15 s apart). */
export const USAGE_REFRESH_MS = 15_000;

export interface EstimateInput {
  usage: ApiUsageLike | null | undefined;
  cursor: CostCursor;
  model: string;
  ratesOf: (model: string) => ModelRates;
  billing: BillingRates;
  sessionHourUsd: number;
}

/** What settlement would charge for this cumulative usage against this cursor. Pure. */
export function estimateManagedCredits(input: EstimateInput): number {
  const tokens = tokensOf(input.usage);
  const cost = sessionCost({
    threads: [{ id: 'primary', model: input.model, tokens }],
    sessionTokens: tokens,
    activeSeconds: Number(input.usage?.active_seconds ?? 0) || 0,
    listCostCents: listCostCents(input.usage),
    fallbackModel: input.model,
    ratesOf: input.ratesOf,
    sessionHourUsd: input.sessionHourUsd,
  });

  return decideManagedCharge(cost, input.cursor, input.billing)?.credits ?? 0;
}

export interface CreditsEstimator {
  /** Feed every live session event; only `session.usage` is read. */
  observe(event: SessionEventLike): void;

  /** The estimate now, or null when it cannot be known. May kick a throttled refresh. */
  current(): number | null;
}

export interface CreditsEstimatorInput {
  /** The chat's stored settlement cursor (read once, at turn start). */
  cursor: () => Promise<string | null>;
  model: string;
  ratesOf: (model: string) => ModelRates;
  billing: BillingRates;
  sessionHourUsd: number;

  /** The session's cumulative usage now (`sessions.retrieve`). Absent → events only. */
  refresh?: () => Promise<ApiUsageLike | null | undefined>;
  refreshMs?: number;
  now?: () => number;
}

const total = (usage: ApiUsageLike) => {
  const t = tokensOf(usage);

  return t.input + t.output + t.cacheRead + t.cache5m + t.cache1h;
};

export function createCreditsEstimator(input: CreditsEstimatorInput): CreditsEstimator {
  const now = input.now ?? Date.now;
  const refreshMs = input.refreshMs ?? USAGE_REFRESH_MS;

  /* `undefined` = still reading; `null` = cannot know (legacy format or a failed read). */
  let cursor: CostCursor | null | undefined;
  let usage: ApiUsageLike | null = null;
  let usageAt = Number.NEGATIVE_INFINITY;
  let refreshedAt = Number.NEGATIVE_INFINITY;
  let refreshing = false;

  input
    .cursor()
    .then((text) => {
      cursor = text ? parseCostCursor(text) : EMPTY_COST_CURSOR;
    })
    .catch(() => {
      cursor = null;
    });

  function take(next: ApiUsageLike | null | undefined) {
    if (!next || typeof next !== 'object') {
      return;
    }

    /* Cumulative usage only grows: a late, older snapshot never replaces a newer one. */
    if (!usage || total(next) >= total(usage)) {
      usage = next;
      usageAt = now();
    }
  }

  function maybeRefresh() {
    const at = now();

    if (!input.refresh || refreshing || at - usageAt < refreshMs || at - refreshedAt < refreshMs) {
      return;
    }

    refreshedAt = at;
    refreshing = true;

    try {
      input
        .refresh()
        .then(take)
        .catch(() => undefined)
        .finally(() => {
          refreshing = false;
        });
    } catch {
      refreshing = false;
    }
  }

  return {
    observe(event) {
      try {
        if (event?.type === 'session.usage') {
          take(event.usage as ApiUsageLike | undefined);
        }
      } catch {
        // An estimate never breaks the turn it narrates.
      }
    },
    current() {
      try {
        maybeRefresh();

        if (!cursor || !usage) {
          return null;
        }

        return estimateManagedCredits({
          usage,
          cursor,
          model: input.model,
          ratesOf: input.ratesOf,
          billing: input.billing,
          sessionHourUsd: input.sessionHourUsd,
        });
      } catch {
        return null;
      }
    },
  };
}
