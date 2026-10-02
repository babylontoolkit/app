/**
 * The managed engine's usage arithmetic (`_specs/managed-agents-engine_plan.md` D7, T7). Pure.
 *
 * A Managed Agents session reports usage PER MODEL REQUEST (`span.model_request_end.model_usage`) and
 * the session's active time as a running total (`session.usage.active_seconds`). A user turn's bill is
 * the sum of the requests it made plus the active seconds it added, priced through the ONE credit
 * formula (`settleGeneration` with `extraRawCostUsd`).
 *
 * ## The cursor
 *
 * A turn is not always settled by one request: a closed tab DETACHES the turn (it keeps running on
 * Anthropic's side, waiting on our tool results), a reopened tab RESUMES it, and a Stop's tail lands
 * after the stopped request has already settled. So settlement is by CURSOR, never by "this request's
 * events": every settlement charges exactly the usage events processed after the chat's cursor and
 * advances it. A second settlement with nothing new charges nothing — idempotent by construction.
 *
 * The cursor is JSON text in `chats.managed_settled_at` (`{"at": <processed_at>, "activeSeconds": n}`).
 * Timestamps are compared PARSED, never as text: two RFC 3339 spellings of one instant (`Z` vs
 * `+00:00`, a different count of fractional digits) sort differently as strings.
 */
import type { GenerationUsage } from '~/lib/.server/agent/step-usage';

/** The four counters a `span.model_request_end` carries (`BetaManagedAgentsSpanModelUsage`). */
export interface ModelUsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function emptyUsage(): GenerationUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

const n = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * Fold one request's usage into a total.
 *
 * `promptTokens` is the UNCACHED input: Anthropic reports `input_tokens` exclusive of the two cache
 * classes (they are siblings, not a breakdown), which is the convention `GenerationUsage` requires.
 */
export function addModelUsage(total: GenerationUsage, usage: ModelUsageLike | null | undefined): GenerationUsage {
  const u = usage ?? {};

  total.promptTokens += n(u.input_tokens);
  total.completionTokens += n(u.output_tokens);
  total.cacheReadTokens += n(u.cache_read_input_tokens);
  total.cacheCreationTokens += n(u.cache_creation_input_tokens);
  total.totalTokens = total.promptTokens + total.completionTokens;

  return total;
}

export interface SettleCursor {
  /** `processed_at` of the newest usage event already billed, or null when nothing has been. */
  at: string | null;

  /** `session.usage.active_seconds` at the last settlement. */
  activeSeconds: number;
}

export const EMPTY_CURSOR: SettleCursor = { at: null, activeSeconds: 0 };

/** Read the stored cursor. A bare timestamp (an earlier shape) is accepted; garbage reads as empty. */
export function parseCursor(text: string | null | undefined): SettleCursor {
  if (!text) {
    return { ...EMPTY_CURSOR };
  }

  try {
    const value = JSON.parse(text) as { at?: unknown; activeSeconds?: unknown };

    return {
      at: typeof value.at === 'string' && Number.isFinite(Date.parse(value.at)) ? value.at : null,
      activeSeconds: n(typeof value.activeSeconds === 'number' ? value.activeSeconds : 0),
    };
  } catch {
    return Number.isFinite(Date.parse(text)) ? { at: text, activeSeconds: 0 } : { ...EMPTY_CURSOR };
  }
}

export function serializeCursor(cursor: SettleCursor): string {
  return JSON.stringify({ at: cursor.at, activeSeconds: cursor.activeSeconds });
}

/** Is `time` strictly after the cursor's instant? A null cursor is before everything. */
export function isAfterCursor(time: string | null | undefined, cursorAt: string | null): boolean {
  if (!time) {
    return false;
  }

  if (!cursorAt) {
    return true;
  }

  const a = Date.parse(time);
  const b = Date.parse(cursorAt);

  return Number.isFinite(a) && Number.isFinite(b) ? a > b : time > cursorAt;
}

/** The later of two timestamps, compared parsed. */
export function laterOf(a: string | null, b: string | null): string | null {
  if (!a) {
    return b;
  }

  if (!b) {
    return a;
  }

  return isAfterCursor(b, a) ? b : a;
}

/** One `span.model_request_end` as settlement reads it. */
export interface UsageEventLike {
  id?: string;
  type?: string;
  processed_at?: string;
  is_error?: boolean | null;
  model_usage?: ModelUsageLike | null;
}

export interface UnsettledUsage {
  usage: GenerationUsage;

  /** How many model requests were summed. */
  requests: number;

  /** The cursor's next `at` — the newest `processed_at` summed, or the old one when nothing was. */
  latestAt: string | null;
}

/**
 * Sum every usage event strictly after the cursor. Events at or before it were billed already; an id
 * seen twice (a page overlap) is counted once.
 */
export function unsettledUsage(events: UsageEventLike[], cursor: SettleCursor): UnsettledUsage {
  const usage = emptyUsage();
  const seen = new Set<string>();
  let requests = 0;
  let latestAt = cursor.at;

  for (const event of events) {
    if (event.type !== 'span.model_request_end' || !isAfterCursor(event.processed_at, cursor.at)) {
      continue;
    }

    if (event.id) {
      if (seen.has(event.id)) {
        continue;
      }

      seen.add(event.id);
    }

    addModelUsage(usage, event.model_usage);
    requests++;
    latestAt = laterOf(latestAt, event.processed_at ?? null);
  }

  return { usage, requests, latestAt };
}

/**
 * The session-hour charge for the active seconds added since the cursor (D7). Never negative: a session
 * total that went DOWN (a different session, a reset) charges nothing rather than crediting the user.
 */
export function sessionHoursCostUsd(activeSecondsNow: number, cursor: SettleCursor, hourUsd: number): number {
  const delta = n(activeSecondsNow) - n(cursor.activeSeconds);

  return delta > 0 && hourUsd > 0 ? (delta / 3600) * hourUsd : 0;
}

/**
 * The session budget for a turn (D13): what the session has already cost plus this turn's ceiling, as
 * the integer-cents string `budget.max_list_cost.amount` takes. Rounded UP — a ceiling rounded down
 * could pause a turn a cent short of what the user was allowed.
 */
export function budgetAmountCents(listCostCents: number, ceilingUsd: number): string {
  return String(Math.max(1, Math.ceil(n(listCostCents) + n(ceilingUsd) * 100)));
}

/** A turn's credit ceiling in USD list cost: credits × unit cost ÷ margin (the inverse of the formula). */
export function ceilingUsdForCredits(credits: number, creditUnitCostUsd: number, margin: number): number {
  return margin > 0 ? (n(credits) * n(creditUnitCostUsd)) / margin : 0;
}
