/**
 * WHICH LLM GATEWAY SERVES THIS TURN (SPEC §4.2a) — the `AUTO_MODEL_SELECT` ladder.
 *
 * ## Why this exists
 *
 * The platform prefers the CHEAPEST gateway that can actually serve the request, because credits are
 * cost-proportional (`credits = ceil(raw_usd / CREDIT_UNIT_COST_USD * CREDIT_MARGIN)`): a discount on
 * the wire is not margin, it is the user's pack stretching further. The owner's order is KIE (best
 * rates) → Comet (a smaller discount) → Anthropic (full price, last resort). KIE outages are what
 * made a fixed `LLM_PROVIDER` painful — a dead gateway meant editing config and redeploying.
 *
 * ## Two rules that keep it off the money path's toes
 *
 * 1. **DEFAULT OFF.** With `AUTO_MODEL_SELECT` unset, `getPlatformConfig` calls `getPlatformProvider`
 *    exactly as it always has. This module cannot change a single generation until an operator opts
 *    in — the `cache-warmer` lesson (a capability that ships on by default is a capability nobody
 *    measured before it started billing).
 * 2. **AT REQUEST START ONLY, NEVER MID-STREAM** (owner decision). One provider serves a turn from
 *    first token to settlement. Failing over mid-stream would mean tokens already billed by gateway A
 *    settling at gateway B's rates — a mis-bill with no honest answer, since `rawCostUsd` prices a
 *    turn against ONE rate table. `getPlatformConfig` picks once; `config.provider` flows to the wire
 *    AND to `settleGeneration`, which is why those two can never disagree.
 *
 * ## The three gates a candidate must pass, and why each exists
 *
 * - **Configured** — a gateway with no API key is not a gateway. `requirePlatformKey` would throw a
 *   describable 503, which is right for a fixed provider and wrong here: skipping to the next rung is
 *   the entire point.
 * - **Can price the model** — 🔴 THE MONEY GATE. `ratesFor` falls back to the provider's MOST
 *   EXPENSIVE row for an unpriced model, so failing over to a gateway that does not price
 *   `claude-sonnet-5` would run the turn and bill it at the top of that gateway's table. A cheaper
 *   provider chosen for its discount must not become the most expensive bill in the product.
 * - **Not in failure cooldown** — a gateway that just failed is skipped for a while.
 *
 * ⚠️ **COOLDOWN IS A PREFERENCE, NEVER A WALL.** If every rung is cooling, this returns the first
 * SERVEABLE one anyway rather than refusing. "All providers had a blip" must not become "the product
 * is down"; a doomed attempt costs one failed generation (refunded, §4.6) while a refusal costs every
 * generation. Same asymmetry as `resolveMediaProvider` degrading to "no media tools" instead of 500.
 *
 * ⚠️ **FLAPPING IS EXPENSIVE, AND IT IS NOT VISIBLE IN ANY ERROR.** The ~150k-token cached prefix is
 * per gateway, so every switch pays a full cache WRITE at 2x — about 8x one prefix before it warms
 * (`spec/context-budget.md`). A cooldown far shorter than a warm-up window therefore costs more in
 * cache writes than the outage costs in failures. That is why the default is minutes, not seconds,
 * and why the head of the chain is preferred the moment it is healthy again rather than after some
 * settling period: returning home is where the warm prefix already is.
 */
import type { PlatformProviderName } from './config';

export interface ProviderSelectInput {
  /** Preference order, best rate first. Empty falls straight through to `fixed`. */
  chain: PlatformProviderName[];

  /** The provider `LLM_PROVIDER` names — the answer when auto-select is off or nothing qualifies. */
  fixed: PlatformProviderName;

  /** Does this gateway have an API key? */
  isConfigured: (provider: PlatformProviderName) => boolean;

  /**
   * Does this gateway's ACTIVE price list price the model we are about to run, in its own right?
   *
   * Never "does the model exist" — `ratesFor`'s most-expensive-row fallback means an unpriced model
   * runs and bills at the top of the table, silently, which is the costly direction.
   */
  canPrice: (provider: PlatformProviderName) => boolean;

  /** Epoch ms this gateway is skippable until, or 0/undefined when healthy. */
  unhealthyUntilMs?: (provider: PlatformProviderName) => number;

  /** Injected, never `Date.now()` — the specs pin the cooldown boundary exactly. */
  nowMs: number;
}

export type ProviderSelectReason = 'auto_selected' | 'auto_selected_while_cooling' | 'no_candidate' | 'fixed';

export interface ProviderSelection {
  provider: PlatformProviderName;

  /** Why this one — logged and recorded, so a surprising bill can be traced to a choice. */
  reason: ProviderSelectReason;

  /** True when the pick differs from `LLM_PROVIDER`, i.e. the ladder actually did something. */
  switched: boolean;
}

/**
 * Pick the gateway for one turn. PURE — no env, no clock, no network.
 *
 * Always returns a provider. There is no null: a turn with no serveable gateway still has to produce
 * the SAME describable failure it produces today (`requirePlatformKey`'s 503 naming the missing
 * variable), and inventing a second "nothing to run on" error path would just make that message worse.
 */
export function selectPlatformProvider(input: ProviderSelectInput): ProviderSelection {
  const serveable = input.chain.filter((p) => input.isConfigured(p) && input.canPrice(p));

  if (serveable.length === 0) {
    return { provider: input.fixed, reason: 'no_candidate', switched: false };
  }

  const cooling = (p: PlatformProviderName) => (input.unhealthyUntilMs?.(p) ?? 0) > input.nowMs;
  const healthy = serveable.find((p) => !cooling(p));

  /*
   * `?? serveable[0]` is the cooldown-is-a-preference rule. Reaching it means every serveable rung is
   * cooling, and the honest move is to try the BEST one rather than refuse the turn — the failure is
   * one refunded generation, and it re-arms the cooldown for whichever rung actually failed.
   */
  const provider = healthy ?? serveable[0];

  return {
    provider,
    reason: healthy ? 'auto_selected' : 'auto_selected_while_cooling',
    switched: provider !== input.fixed,
  };
}

/**
 * Failure memory for the ladder — in-process, per server, deliberately not persisted.
 *
 * A gateway outage is a property of RIGHT NOW, and the platform already keeps its rolling failure
 * window this way (`monitoring/failure-rate.ts`). Persisting it would mean a deploy inheriting a stale
 * verdict about a provider that recovered hours ago, and the recovery signal — a successful
 * generation — is not something a restart can replay.
 */
const cooldownUntil = new Map<PlatformProviderName, number>();

/** Default cooldown. Minutes, not seconds — see the flapping warning in the file header. */
export const PROVIDER_COOLDOWN_MS = 5 * 60_000;

export function recordProviderFailure(
  provider: PlatformProviderName,
  nowMs: number,
  cooldownMs: number = PROVIDER_COOLDOWN_MS,
): void {
  cooldownUntil.set(provider, nowMs + cooldownMs);
}

/**
 * A gateway that just served a turn is healthy, whatever it did five minutes ago.
 *
 * Clearing on success is what stops one blip costing a provider its place in the ladder for the whole
 * cooldown: without it, a single 500 during an otherwise healthy hour would push every turn onto the
 * next rung — and each of those turns pays a cold-prefix cache write.
 */
export function recordProviderSuccess(provider: PlatformProviderName): void {
  cooldownUntil.delete(provider);
}

export function providerUnhealthyUntil(provider: PlatformProviderName): number {
  return cooldownUntil.get(provider) ?? 0;
}

/** Test seam only — the map is module state and would otherwise leak between specs. */
export function resetProviderHealth(): void {
  cooldownUntil.clear();
}
