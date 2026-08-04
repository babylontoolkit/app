/**
 * Base-prompt cache warmer (§4.2.8, `spec/context-budget.md` §"The complete lever inventory").
 *
 * WHY THIS EXISTS. Anthropic's prompt cache keys on the EXACT BYTES of the prompt prefix: a cold
 * prefix bills a cache WRITE at 2x, a warm one a READ at 0.1x — a 20x swing on the input side, and
 * KIE additionally warms PER BACKEND (measured with `scripts/cache-probe.mjs`: a new prefix misses
 * ~4-5 times before every backend holds it). The one block that is byte-identical for every user and
 * every project is system block 1 — the base prompt (`getActivePrompt().content`, sent by the proxy
 * with a 1h-TTL breakpoint). This module keeps THAT block warm by periodically sending it with
 * `max_tokens: 1`, so a user's cold creation reads it at 0.1x instead of writing it at 2x.
 *
 * WHAT IT CANNOT DO — and do not "extend" it to try: the rest of the creation prefix (routed doc
 * blocks keyed on the user's brief wording, the ~110k file context containing the project-title-named
 * scaffold class, the project CLAUDE.md) is per-project BYTES that do not exist until the project
 * does. There is nothing to warm.
 *
 * ⚠️ That variance no longer has a user-facing absorber. It used to be the FLAT creation price
 * (`creationFlatCredits`), RETIRED 2026-07-29 (§4.4a): New Project runs no generation at all now, so
 * there is no creation turn to flat-price, and the first BUILD turn bills cost-derived like any
 * other. The flat charge that remains (`PROJECT_CREATE_CREDITS`) prices the clone/install/serve work,
 * not tokens — it absorbs nothing about cache warmth. This module is therefore the ONLY thing
 * standing between a cold prefix and the user's bill, which raises its value rather than lowering it.
 *
 * MONEY SHAPE (platform ops spend — deliberately NO `generations` row, NO ledger entry, NO user):
 *   - steady state: `fanout` cache READS at 0.1x per cycle ≈ cents per day;
 *   - after a prompt promotion (new bytes): ~`fanout` full WRITES at 2x, once — prepaid off-request
 *     so no user's creation eats the first miss.
 *
 * 🔴 DRIFT GUARD: the warmer is only worth anything while its request is BYTE-IDENTICAL to the
 * proxy's block 1 — same prompt text, same `cache_control` tier/TTL, same MODEL (the cache is
 * per-model). `PROMPT_CACHE_TTL` is exported from here and imported by the proxy's `CACHE_CONTROL`
 * so the TTL cannot fork; the text comes from the same `getActivePrompt()`; the model from the same
 * `getPlatformModel()`. A warmer warming a prefix nobody sends fails as false comfort, silently.
 */
import { createScopedLogger } from '~/utils/logger';
import { env, envFlag, envNumber } from '~/lib/.server/env';
import { getMonitor } from '~/lib/.server/monitoring';
import { getPlatformModel, getPlatformProvider } from '~/lib/.server/agent/config';
import { KIE_DEFAULT_BASE_URL } from '~/lib/modules/llm/providers/kie-wire';
import { getActivePrompt } from './active';

const logger = createScopedLogger('cache-warmer');

/**
 * The ONE cache tier the platform uses (§4.2.8: 1h, because users stop to PLAY what we built — the
 * 5m default expires mid-session). The proxy's `CACHE_CONTROL` imports this; see the drift guard above.
 */
export const PROMPT_CACHE_TTL = '1h' as const;

/** Under the 1h TTL with margin — nothing verifies that a cache HIT refreshes the TTL, so assume it does not. */
export const DEFAULT_CACHE_WARMER_INTERVAL_MINUTES = 45;

/** KIE warms per backend; measured ~4-5 backends behind their balancer. Six touches covers the set. */
export const DEFAULT_CACHE_WARMER_FANOUT = 6;

/** Spacing between fanout requests — concurrent probes measured as landing on the SAME backend. */
const WARMUP_SPACING_MS = 2000;

export function cacheWarmerEnabled(context?: unknown): boolean {
  return envFlag(context, 'CACHE_WARMER_ENABLED', true);
}

export function cacheWarmerIntervalMinutes(context?: unknown): number {
  const minutes = envNumber(context, 'CACHE_WARMER_INTERVAL_MINUTES', DEFAULT_CACHE_WARMER_INTERVAL_MINUTES);

  /*
   * Ignore a bad override rather than obey it (the `sandboxHibernationSeconds` posture): an interval
   * over the TTL warms nothing (every cycle is a fresh write), and a sub-minute one is a spend loop.
   */
  return Number.isFinite(minutes) && minutes >= 1 && minutes <= 55 ? minutes : DEFAULT_CACHE_WARMER_INTERVAL_MINUTES;
}

export function cacheWarmerFanout(context?: unknown): number {
  const fanout = envNumber(context, 'CACHE_WARMER_FANOUT', DEFAULT_CACHE_WARMER_FANOUT);

  return Number.isFinite(fanout) && fanout >= 1 && fanout <= 16 ? Math.floor(fanout) : DEFAULT_CACHE_WARMER_FANOUT;
}

/**
 * The wire request, PURE so the spec can pin every byte-identity property without a network:
 * Bearer auth (KIE's quirk — not `x-api-key`), the GA `anthropic-version`, `max_tokens: 1`, and the
 * system block carrying the exact prompt text under the exact `CACHE_CONTROL` tier the proxy sends.
 *
 * 🔴 `stream: true` IS LOAD-BEARING, NOT A STYLE CHOICE (2026-08-04, measured live). KIE's Claude
 * endpoint 500s every NON-streaming request ("Server exception") while serving the identical body
 * with `stream: true` normally — probed directly with a 16-token request during an incident where
 * every warm cycle read 6 sent / 6 failures while user generations (which stream) ran fine. The
 * warmer therefore speaks the SAME mode as the traffic it warms for, which is the safer shape even
 * if KIE's non-streaming 500 turns out to be transient: a warmer exercising a request shape no
 * generation sends is one more way to warm a prefix nobody uses.
 */
export function buildWarmupRequest(input: { model: string; promptText: string; apiKey: string }): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  return {
    url: `${KIE_DEFAULT_BASE_URL}/messages`,
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      authorization: `Bearer ${input.apiKey}`,
    },
    body: {
      model: input.model,
      max_tokens: 1,
      stream: true,
      system: [
        {
          type: 'text',
          text: input.promptText,
          cache_control: { type: 'ephemeral', ttl: PROMPT_CACHE_TTL },
        },
      ],
      messages: [{ role: 'user', content: 'ok' }],
    },
  };
}

/**
 * Pull the cache counters out of an SSE response body. PURE (string in, counters out) so the spec
 * can pin it against real captured wire shapes.
 *
 * With `stream: true` the usage arrives inside `message_start`'s `message.usage` (and later deltas
 * may update it), not as a JSON body. Two wire variants observed on KIE, both handled: the classic
 * top-level `cache_creation_input_tokens`, and the tiered `cache_creation: { ephemeral_1h_input_tokens,
 * ephemeral_5m_input_tokens }` object (what their adapter actually sends — a parser reading only the
 * classic field would report every warm WRITE as zero, silently). Every `data:` event is scanned and
 * the MAX per counter kept, so it does not matter which event carries the final number.
 */
export function parseWarmupStreamUsage(sseText: string): { cacheReadTokens: number; cacheWriteTokens: number } {
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data:')) {
      continue;
    }

    try {
      const event = JSON.parse(line.slice(5).trim()) as {
        message?: { usage?: Record<string, unknown> };
        usage?: Record<string, unknown>;
      };

      for (const usage of [event.message?.usage, event.usage]) {
        if (!usage) {
          continue;
        }

        const read = usage.cache_read_input_tokens;

        if (typeof read === 'number') {
          cacheReadTokens = Math.max(cacheReadTokens, read);
        }

        const classicWrite = usage.cache_creation_input_tokens;

        if (typeof classicWrite === 'number') {
          cacheWriteTokens = Math.max(cacheWriteTokens, classicWrite);
        }

        const tiered = usage.cache_creation as Record<string, unknown> | undefined;

        if (tiered && typeof tiered === 'object') {
          const tieredTotal = Object.values(tiered).reduce<number>(
            (sum, value) => sum + (typeof value === 'number' ? value : 0),
            0,
          );
          cacheWriteTokens = Math.max(cacheWriteTokens, tieredTotal);
        }
      }
    } catch {
      // Partial or non-JSON event data ("[DONE]", a split frame) — skip, never abort the scan.
    }
  }

  return { cacheReadTokens, cacheWriteTokens };
}

interface WarmCycleDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface WarmCycleResult {
  sent: number;
  reads: number;
  writes: number;
  failures: number;
  skipped?: string;
}

/**
 * One warm cycle: `fanout` sequential touches of the base prompt. NEVER throws — a warmer that can
 * take down the doorway that started it inverts its own purpose (observability-can't-break-a-request,
 * applied to ops spend). Every skip reason is a string so the log says WHY nothing happened.
 */
export async function runWarmCycle(context?: unknown, deps?: WarmCycleDeps): Promise<WarmCycleResult> {
  const none = (skipped: string): WarmCycleResult => ({ sent: 0, reads: 0, writes: 0, failures: 0, skipped });

  try {
    if (!cacheWarmerEnabled(context)) {
      return none('disabled (CACHE_WARMER_ENABLED=false)');
    }

    /*
     * The warmer speaks KIE's wire directly; on the Anthropic provider the platform's own traffic
     * shape differs (no per-backend balancer measured) and this module has no verified value there.
     */
    if (getPlatformProvider(context) !== 'KIE') {
      return none('platform provider is not KIE');
    }

    const apiKey = env(context, 'KIE_API_KEY');

    if (!apiKey) {
      return none('KIE_API_KEY is not configured');
    }

    const active = await getActivePrompt();

    if (!active) {
      return none('no active prompt version');
    }

    /*
     * Throws only for an unpriced model — a config state the generations themselves already refuse on,
     * so the warmer staying quiet about it adds no new failure mode.
     */
    const model = getPlatformModel(context);
    const request = buildWarmupRequest({ model, promptText: active.content, apiKey });
    const fetchFn = deps?.fetchFn ?? fetch;
    const sleep = deps?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const fanout = cacheWarmerFanout(context);

    const result: WarmCycleResult = { sent: 0, reads: 0, writes: 0, failures: 0 };

    for (let i = 0; i < fanout; i++) {
      if (i > 0) {
        await sleep(WARMUP_SPACING_MS);
      }

      try {
        const response = await fetchFn(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.body),
        });
        result.sent += 1;

        if (!response.ok) {
          result.failures += 1;
          continue;
        }

        /*
         * The response is an SSE stream (`stream: true` — see `buildWarmupRequest`); a 1-token answer
         * is a handful of events, so buffering the whole body is fine HERE (never in a user path).
         */
        const usage = parseWarmupStreamUsage(await response.text());

        if (usage.cacheReadTokens > 0) {
          result.reads += 1;
        }

        if (usage.cacheWriteTokens > 0) {
          result.writes += 1;
        }
      } catch {
        result.sent += 1;
        result.failures += 1;
      }
    }

    logger.info(
      `Warm cycle: ${result.sent} sent, ${result.reads} reads, ${result.writes} writes, ${result.failures} failures ` +
        `(model ${model}, prompt ${active.id})`,
    );

    if (result.failures > 0 && result.failures === result.sent) {
      getMonitor(context).captureMessage('Cache warmer: every warm request failed', {
        scope: 'cache-warmer',
        level: 'warning',
      });
    }

    return result;
  } catch (error) {
    logger.warn(`Warm cycle aborted: ${(error as Error).message}`);
    return none(`error: ${(error as Error).message}`);
  }
}

let warmerTimer: ReturnType<typeof setInterval> | undefined;
let warmerStarted = false;

/**
 * Start the interval on first touch — called from the proxy's async doorway (beside
 * `ensureMarketPrices`) because there is no server boot hook. On the long-lived Node process the
 * interval survives between requests; on a short-lived isolate it degrades to warming at
 * doorway-touch time only, which is still the right traffic to warm for.
 *
 * ⚠️ VITEST-guarded: the documented `env()` trap means a test's "empty" context resolves the
 * developer's REAL `.env.local` — an unguarded warmer would fire real KIE spend from any spec that
 * touches the proxy. Tests drive `runWarmCycle` directly with an injected fetch.
 */
export function ensureCacheWarmer(context?: unknown): void {
  if (warmerStarted || process.env.VITEST || process.env.NODE_ENV === 'test') {
    return;
  }

  warmerStarted = true;

  if (!cacheWarmerEnabled(context)) {
    return;
  }

  // First cycle soon but off the doorway's critical path; then the steady interval.
  const kickoff = setTimeout(() => void runWarmCycle(context), 5_000);
  kickoff.unref?.();

  warmerTimer = setInterval(() => void runWarmCycle(context), cacheWarmerIntervalMinutes(context) * 60_000);
  warmerTimer.unref?.();

  logger.info(
    `Cache warmer started (every ${cacheWarmerIntervalMinutes(context)}m, fanout ${cacheWarmerFanout(context)})`,
  );
}

/**
 * Fire one cycle now — called beside `invalidateActivePrompt()` when a prompt version is promoted:
 * new bytes mean ~fanout cold writes are coming, and prepaying them here means no user eats the miss.
 * Fire-and-forget by contract (an admin promote must not block on KIE).
 */
export function warmAfterPromptChange(context?: unknown): void {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    return;
  }

  void runWarmCycle(context);
}

/** Test seam — clears the module-level interval state (the `resetRateWindows` pattern). */
export function resetCacheWarmerForTests(): void {
  if (warmerTimer) {
    clearInterval(warmerTimer);
    warmerTimer = undefined;
  }

  warmerStarted = false;
}
