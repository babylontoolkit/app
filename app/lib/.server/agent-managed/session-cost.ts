/**
 * What a managed session cost, and what to charge for it (owner, 2026-10-02). Pure.
 *
 * > *"Fix overcharge but make sure we NEVER UNDERCHARGE… NO SUB AGENTS UNLESS WE CAN BILL FOR SUB AGENT
 * > USE AND WE DON'T EAT THAT COST… DOUBLE CHECK WE CAN ACTUALLY TRACK AND BILL FOR SUBAGENT."*
 *
 * ## Why settlement is built on the session's CUMULATIVE totals, not on request events
 *
 * Measured live 2026-10-02 (a Haiku coordinator + one subagent, `.probe` in this session's notes):
 *
 *   - the primary event stream carried the coordinator's 3 `span.model_request_end` events and NONE of the
 *     subagent's 2 — so the old settlement, which summed primary-stream spans, would have billed ZERO for
 *     every subagent token: the platform eating it, silently;
 *   - every thread reports its own model and cumulative usage (`threads.list` → `agent.model`, `usage`),
 *     and the SESSION's usage is the sum across all threads (12,816 = 9,584 + 3,232 input);
 *   - session usage splits cache writes by TTL (`cache_creation.ephemeral_5m/_1h`) — the request events do
 *     not — and Managed Agents writes the 5-MINUTE tier (1.25× input), where our rate table's
 *     `cacheWritePerMTok` is the 1-hour tier (2×). That 2× made the recorded cost of a real Opus session
 *     $5.23 against Anthropic's $4.68;
 *   - `session.usage.list_cost` (integer cents) includes the session RUNTIME: $4.68 = tokens at the 5-minute
 *     write rate + 1,066 s × $0.08/h, exactly.
 *
 * ## The three numbers, all CUMULATIVE for the session
 *
 *   - **True cost** — every thread's tokens at its own model's rates with the cache writes split by TTL,
 *     plus any session-level tokens NO thread accounts for (a thread whose usage is not reported yet),
 *     priced at the most expensive model in the session with writes at the 1-hour rate, plus runtime —
 *     and never below Anthropic's own `list_cost`. This is what the Admin margin report sees.
 *   - **Warm basis** — the same tokens with every cache write priced at the READ rate: the owner rule of
 *     2026-08-07 (`billedUsage` in `gate.ts`), "the customer is never billed for the state of our cache".
 *     Credits come from this through the one formula (× margin).
 *   - **The floor** — the credits charged for a session, in total, are never worth less than its true cost
 *     at `CREDIT_UNIT_COST_USD`. The warm rule can never push a session below cost, a rate-table gap can
 *     never under-bill, and a thread we could not price is still covered by `list_cost`.
 *
 * Each settlement charges the difference between these cumulative numbers and what the cursor says was
 * already charged, so detach / resume / Stop tails are billed exactly once, and usage reported late (a
 * thread's usage appears only when it first idles) is caught up by the next settlement rather than lost.
 */
import type { GenerationUsage } from '~/lib/.server/agent/step-usage';
import type { ModelRates } from '~/lib/.server/billing/rates';

/** Tokens by billing class. Cache writes are split by TTL because the two tiers bill differently. */
export interface TierTokens {
  input: number;
  output: number;
  cacheRead: number;
  cache5m: number;
  cache1h: number;
}

export const ZERO_TOKENS: TierTokens = { input: 0, output: 0, cacheRead: 0, cache5m: 0, cache1h: 0 };

/** The 5-minute cache write is 1.25× base input (Anthropic's published tiering). */
export const CACHE_5M_WRITE_MULTIPLIER = 1.25;

const n = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/** A `usage` object as the API reports it for a session or a thread. */
export interface ApiUsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
  active_seconds?: number | null;
  list_cost?: { amount?: string | null; currency?: string | null } | null;
}

export function tokensOf(usage: ApiUsageLike | null | undefined): TierTokens {
  return {
    input: n(usage?.input_tokens),
    output: n(usage?.output_tokens),
    cacheRead: n(usage?.cache_read_input_tokens),
    cache5m: n(usage?.cache_creation?.ephemeral_5m_input_tokens),
    cache1h: n(usage?.cache_creation?.ephemeral_1h_input_tokens),
  };
}

/** `list_cost` in cents, or null when the session does not report one (yet) or not in USD. */
export function listCostCents(usage: ApiUsageLike | null | undefined): number | null {
  const amount = usage?.list_cost?.amount;

  if (typeof amount !== 'string' || !/^\d+$/.test(amount) || (usage?.list_cost?.currency ?? 'USD') !== 'USD') {
    return null;
  }

  return Number(amount);
}

function add(a: TierTokens, b: TierTokens): TierTokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cache5m: a.cache5m + b.cache5m,
    cache1h: a.cache1h + b.cache1h,
  };
}

function minus(a: TierTokens, b: TierTokens): TierTokens {
  return {
    input: Math.max(0, a.input - b.input),
    output: Math.max(0, a.output - b.output),
    cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
    cache5m: Math.max(0, a.cache5m - b.cache5m),
    cache1h: Math.max(0, a.cache1h - b.cache1h),
  };
}

const total = (t: TierTokens) => t.input + t.output + t.cacheRead + t.cache5m + t.cache1h;

/** What these tokens cost us: each TTL at its own write rate. */
export function trueTokenCostUsd(t: TierTokens, rates: ModelRates): number {
  return (
    (t.input * rates.inputPerMTok +
      t.output * rates.outputPerMTok +
      t.cacheRead * rates.cacheReadPerMTok +
      t.cache5m * rates.inputPerMTok * CACHE_5M_WRITE_MULTIPLIER +
      t.cache1h * rates.cacheWritePerMTok) /
    1_000_000
  );
}

/** What the customer's credits are based on: every cache write at the READ rate (owner rule, 2026-08-07). */
export function warmTokenCostUsd(t: TierTokens, rates: ModelRates): number {
  return (
    (t.input * rates.inputPerMTok +
      t.output * rates.outputPerMTok +
      (t.cacheRead + t.cache5m + t.cache1h) * rates.cacheReadPerMTok) /
    1_000_000
  );
}

export interface ThreadUsage {
  id: string;
  model: string;

  /** The thread's cumulative usage, or null when the API has not reported it yet. */
  tokens: TierTokens | null;
}

export interface SessionCostInput {
  threads: ThreadUsage[];

  /** The session's cumulative usage across ALL threads — the authority on how many tokens there were. */
  sessionTokens: TierTokens;
  activeSeconds: number;
  listCostCents: number | null;

  /** The session agent's model — prices tokens no thread accounts for when no thread reported a model. */
  fallbackModel: string;
  ratesOf: (model: string) => ModelRates;
  sessionHourUsd: number;
}

export interface SessionCost {
  tokens: TierTokens;
  trueCostUsd: number;
  warmBasisUsd: number;

  /** Models that ran in this session (one per thread) — more than one means a subagent ran. */
  models: string[];
  threads: number;
}

/** The session's cumulative cost. Pure. */
export function sessionCost(input: SessionCostInput): SessionCost {
  let accounted = { ...ZERO_TOKENS };
  let trueCost = 0;
  let warm = 0;

  for (const thread of input.threads) {
    if (!thread.tokens) {
      continue;
    }

    const rates = input.ratesOf(thread.model);

    accounted = add(accounted, thread.tokens);
    trueCost += trueTokenCostUsd(thread.tokens, rates);
    warm += warmTokenCostUsd(thread.tokens, rates);
  }

  /*
   * Session tokens no thread accounts for (a thread still running has no usage yet). Priced at the MOST
   * expensive model in the session, every write at the 1-hour rate, so an unattributed token can only ever
   * be over-priced, never under.
   */
  const unattributed = minus(input.sessionTokens, accounted);

  if (total(unattributed) > 0) {
    const candidates = [input.fallbackModel, ...input.threads.map((t) => t.model)].map((m) => input.ratesOf(m));
    const priciest = candidates.reduce((a, b) => (b.outputPerMTok > a.outputPerMTok ? b : a));
    const conservative = { ...unattributed, cache1h: unattributed.cache1h + unattributed.cache5m, cache5m: 0 };

    trueCost += trueTokenCostUsd(conservative, priciest);
    warm += warmTokenCostUsd(unattributed, priciest);
  }

  const runtime = input.sessionHourUsd > 0 ? (n(input.activeSeconds) / 3600) * input.sessionHourUsd : 0;
  const tokens = add(accounted, unattributed);

  return {
    tokens,
    trueCostUsd: Math.max(trueCost + runtime, input.listCostCents === null ? 0 : input.listCostCents / 100),
    warmBasisUsd: warm + runtime,
    models: [...new Set(input.threads.map((t) => t.model))],
    threads: input.threads.length,
  };
}

/** What has already been charged for this session — the settlement cursor, version 2. */
export interface CostCursor {
  v: 2;
  tokens: TierTokens;
  trueCostUsd: number;
  warmBasisUsd: number;

  /** Credits charged for this session so far (all settlements). */
  credits: number;
}

export const EMPTY_COST_CURSOR: CostCursor = {
  v: 2,
  tokens: { ...ZERO_TOKENS },
  trueCostUsd: 0,
  warmBasisUsd: 0,
  credits: 0,
};

export function parseCostCursor(text: string | null | undefined): CostCursor | null {
  if (!text) {
    return null;
  }

  try {
    const value = JSON.parse(text) as Partial<CostCursor>;

    if (value?.v !== 2) {
      return null;
    }

    return {
      v: 2,
      tokens: { ...ZERO_TOKENS, ...tokensFromCursor(value.tokens) },
      trueCostUsd: n(value.trueCostUsd),
      warmBasisUsd: n(value.warmBasisUsd),
      credits: n(value.credits),
    };
  } catch {
    return null;
  }
}

function tokensFromCursor(value: unknown): TierTokens {
  const t = (value ?? {}) as Partial<TierTokens>;

  return {
    input: n(t.input),
    output: n(t.output),
    cacheRead: n(t.cacheRead),
    cache5m: n(t.cache5m),
    cache1h: n(t.cache1h),
  };
}

export function serializeCostCursor(cursor: CostCursor): string {
  return JSON.stringify(cursor);
}

export interface BillingRates {
  creditUnitCostUsd: number;
  margin: number;
}

export interface ManagedCharge {
  credits: number;

  /** True cost added since the cursor — the generation row's `rawCostUsd`. */
  trueCostUsd: number;

  /** Tokens added since the cursor, as a generation records them. */
  usage: GenerationUsage;
  next: CostCursor;

  /** Did the never-below-cost floor decide this charge (rather than the warm-price formula)? */
  floorApplied: boolean;
}

/**
 * The charge for everything since the cursor, or `null` when no new tokens were used — session-hours are
 * never settled alone (a zero-token Stop tail carries its seconds to the next settlement). Pure.
 *
 *   credits = max( ceil(warm delta / unit × margin),            ← the price (owner's warm rule)
 *                  ceil(true cost so far / unit) − credits so far ) ← the floor: never below cost
 */
export function decideManagedCharge(
  cost: SessionCost,
  cursor: CostCursor,
  billing: BillingRates,
): ManagedCharge | null {
  const added = minus(cost.tokens, cursor.tokens);

  if (total(added) <= 0) {
    return null;
  }

  const unit = billing.creditUnitCostUsd > 0 ? billing.creditUnitCostUsd : 0.01;
  const warmDelta = Math.max(0, cost.warmBasisUsd - cursor.warmBasisUsd);
  const priced = warmDelta > 0 ? Math.max(1, Math.ceil((warmDelta / unit) * billing.margin)) : 0;

  /* A tiny epsilon so float noise on an exact cent never rounds the floor UP by a whole credit. */
  const floor = Math.max(0, Math.ceil(cost.trueCostUsd / unit - 1e-9) - cursor.credits);
  const credits = Math.max(priced, floor, 1);

  return {
    credits,
    trueCostUsd: Math.max(0, cost.trueCostUsd - cursor.trueCostUsd),
    usage: {
      promptTokens: added.input,
      completionTokens: added.output,
      totalTokens: added.input + added.output,
      cacheReadTokens: added.cacheRead,
      cacheCreationTokens: added.cache5m + added.cache1h,
    },
    next: {
      v: 2,
      tokens: { ...cost.tokens },
      trueCostUsd: Math.max(cursor.trueCostUsd, cost.trueCostUsd),
      warmBasisUsd: Math.max(cursor.warmBasisUsd, cost.warmBasisUsd),
      credits: cursor.credits + credits,
    },
    floorApplied: floor > priced,
  };
}
