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
 * ⚠️ **The user's bill no longer depends on this** (2026-08-07, `_specs/creation-cost_plan.md` Phase 1):
 * `decideCredits` prices cache-CREATION tokens at the READ rate, so a customer is charged the same
 * whether their turn was warm or ice cold, while `raw_cost_usd` keeps recording the truth. That moved
 * the cold start from a trust problem onto the platform's margin — which is exactly where it belongs,
 * since the platform is the only party that can prevent it, and it is why this module is now a
 * COST optimisation rather than a fairness mechanism. It ships OFF (see `cacheWarmerEnabled`).
 *
 * 🔴 **BOTH PROVIDERS since 2026-08-08.** `runWarmCycle` used to bail with
 * `none('platform provider is not KIE')`, so it did nothing for the entire time the platform has run
 * on Anthropic — the module was present, tested, green, and inert. Anthropic and KIE serve the SAME
 * Messages API; they differ only in base URL and auth header, which is the whole reason the platform
 * can swap providers with a config change. A guard that says "I only understand one provider" in a
 * codebase built to swap providers is a guard that will be wrong by default.
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
import {
  getPlatformModel,
  platformKeyEnvFor,
  resolvePlatformProvider,
  type PlatformProviderName,
} from '~/lib/.server/agent/config';
import { familyOf } from '~/lib/modules/llm/model-families';
import { KIE_DEFAULT_BASE_URL } from '~/lib/modules/llm/providers/kie-wire';
import { COMET_DEFAULT_BASE_URL } from '~/lib/modules/llm/providers/comet-wire';
import { getActivePrompt } from './active';

const logger = createScopedLogger('cache-warmer');

/**
 * Anthropic's Messages API root — the twin of `KIE_DEFAULT_BASE_URL`.
 *
 * Declared here rather than imported because this module is the platform's only server-side RAW-wire
 * caller for Anthropic; every other path goes through `@ai-sdk/anthropic`, which owns its own base URL.
 * If a second raw caller ever appears, move this beside `KIE_DEFAULT_BASE_URL` rather than copying it.
 */
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';

/**
 * The ONE cache tier the platform uses (§4.2.8: 1h, because users stop to PLAY what we built — the
 * 5m default expires mid-session). The proxy's `CACHE_CONTROL` imports this; see the drift guard above.
 */
export const PROMPT_CACHE_TTL = '1h' as const;

/** Under the 1h TTL with margin — nothing verifies that a cache HIT refreshes the TTL, so assume it does not. */
export const DEFAULT_CACHE_WARMER_INTERVAL_MINUTES = 45;

/** KIE warms per backend; measured ~4-5 backends behind their balancer. Six touches covers the set. */
export const DEFAULT_CACHE_WARMER_FANOUT = 6;

/**
 * Anthropic direct has NO balancer to cover, so one touch warms the prefix.
 *
 * Measured 2026-08-08 with `PROBE_PROVIDER=Anthropic node scripts/cache-probe.mjs 3 4000`: request 1
 * wrote 5,420 tokens, requests 2 and 3 both read 5,420. **First-request warm**, against KIE's measured
 * `1-4 MISS, 5-10 HIT` curve. Sending six is six times the bill for nothing — and the bill is real,
 * because a fanout touch on a cold prefix is a 2x WRITE, not a read.
 */
export const DEFAULT_ANTHROPIC_FANOUT = 1;

/**
 * Comet — **5, MEASURED 2026-08-11 over three cold probes plus a warm re-probe** (spec AC6 / T11).
 *
 * Comet warms PER BACKEND like KIE, not first-request like Anthropic direct, and the evidence is a
 * clustered warmup rather than a rate — which is the only reading that is safe to act on:
 *
 * ```
 * 30 req  claude-sonnet-5   writes at 1, 2, 4        then 26 consecutive HITs   (27/30)
 * 20 req  claude-opus-4-8   writes at 1, 2, 3, 4     then 16 consecutive HITs   (16/20)
 * 12 req  claude-sonnet-5   writes at 1, 3, 5        then hits                  (T3, 2026-08-10)
 * 12 req  claude-sonnet-5   warm re-probe            12/12 HIT, zero writes
 * ```
 *
 * Three DISTINCT writes in two samples and four in the third, all landing inside the first five
 * requests, with a HIT appearing mid-warmup (request 3 of the first sample) — i.e. requests are spread
 * across a small pool of backends, each needing its own write, and a request can land on one already
 * warmed. **5 is the deepest index at which any sample still wrote**, so it covers all three; every
 * sample was fully warm by then and stayed warm.
 *
 * ⚠️ **Do not read the "27/30" or "16/20" ratios as a hit RATE.** Both are 100% after the warmup and
 * 0% inside it. This is the mistake that cost a day on KIE: a miss rate measured over a warmup is not
 * a miss rate, and reading it as one came within an env var of buying a 2.5x more expensive provider
 * to fix a defect that did not exist. Read the distribution.
 *
 * ⚠️ **The honest residual: if the pool is really 4 backends with random assignment, 5 touches is not
 * a guarantee** — coupon-collector says covering 4 uniformly needs ~8 on average, and we observed full
 * warmth by 4-5 three times out of three. So either the pool is ~3, or assignment is not uniform. The
 * response to that gap is to MEASURE again, never to inflate the number: a fanout touch on a cold
 * prefix is a **2x WRITE**, so guessing high bills real money on every cycle forever, while guessing
 * low costs one avoidable cold read that the NEXT cycle (every 45 min, against a 1h TTL) fixes by
 * itself. The asymmetry points at the measured value.
 *
 * ⚠️ Pinned in the spec as a **LITERAL**, not as a reference to this constant — an assertion that
 * reads the value it is checking passes for any value (the `PROGRESS_CAP` vacuity trap).
 */
export const DEFAULT_COMET_FANOUT = 5;

/**
 * The fanout DEFAULT per provider — a record, so a new provider is a **compile** error, not a guess.
 *
 * ⚠️ The `?? DEFAULT_ANTHROPIC_FANOUT` at the read site is a runtime belt that this exhaustiveness
 * makes unreachable, kept only because the lookup key can arrive from a resolver. Do not read it as
 * the real default for an unknown provider — there is no such thing here, by type.
 */
const FANOUT_BY_PROVIDER: Record<PlatformProviderName, number> = {
  Anthropic: DEFAULT_ANTHROPIC_FANOUT,
  KIE: DEFAULT_CACHE_WARMER_FANOUT,
  Comet: DEFAULT_COMET_FANOUT,
};

/** Spacing between fanout requests — concurrent probes measured as landing on the SAME backend. */
const WARMUP_SPACING_MS = 2000;

/**
 * 🔴 **DEFAULT OFF since 2026-08-08 — owner decision, and the reason is arithmetic nobody had done.**
 *
 * The warmer can only warm blocks that are byte-identical for every user: the base prompt, and (not yet
 * built) the starter file block. The per-project half of the prefix does not exist until the project
 * does. So the saving is not "a cold start avoided", it is "the SHARED FRACTION of a cold start
 * avoided" — measured live at ~31k of a ~40k prefix, worth about **$0.18** each.
 *
 * Against that, a cycle every 45 minutes costs ~$0.30/day. Which side wins depends entirely on **how
 * many cold starts a day the platform actually has** — a number nobody has measured:
 *
 *   - 3/day  → the warmer nets ~$7/month.   Not worth a background timer.
 *   - 20/day → the warmer nets ~$100/month. Clearly worth it.
 *
 * And the value moves the WRONG way with success: once there is organic traffic the shared prefix
 * stays warm by itself, so the warmer matters most when there are no users and least when there are.
 *
 * So it ships off, correct and ready, and the decision waits for data instead of a guess.
 * **`generations.cacheCreationTokens > 0` is a cold start** — count them for a week, then flip
 * `CACHE_WARMER_ENABLED=true` if the number says so. That is a five-minute decision with a real
 * input, which is what this default is buying.
 */
export function cacheWarmerEnabled(context?: unknown): boolean {
  return envFlag(context, 'CACHE_WARMER_ENABLED', false);
}

export function cacheWarmerIntervalMinutes(context?: unknown): number {
  const minutes = envNumber(context, 'CACHE_WARMER_INTERVAL_MINUTES', DEFAULT_CACHE_WARMER_INTERVAL_MINUTES);

  /*
   * Ignore a bad override rather than obey it (the `sandboxHibernationSeconds` posture): an interval
   * over the TTL warms nothing (every cycle is a fresh write), and a sub-minute one is a spend loop.
   */
  return Number.isFinite(minutes) && minutes >= 1 && minutes <= 55 ? minutes : DEFAULT_CACHE_WARMER_INTERVAL_MINUTES;
}

/**
 * How many touches per cycle — **defaulted PER PROVIDER**, because the number exists to cover KIE's
 * load balancer and Anthropic direct has none (see {@link DEFAULT_ANTHROPIC_FANOUT}).
 *
 * ⚠️ An explicit `CACHE_WARMER_FANOUT` still wins on any provider. The provider only chooses the
 * DEFAULT: a single constant meant one of the providers was always wrong, and the wrong direction
 * (6 on Anthropic) is the expensive one.
 *
 * 🔴 It reads a RECORD, not `=== 'KIE' ? 6 : 1`. That ternary put every provider it had not heard of
 * on the Anthropic branch — which is the cheap direction here and therefore harmless by luck, not by
 * design. The same shape one file over (`platformKeyFor`) resolved the WRONG KEY. A record makes the
 * question "what is this provider's default" impossible to answer by accident.
 *
 * ---
 *
 * 🔴 **THE WARMER WARMS THE GATEWAY THAT WOULD ACTUALLY SERVE, NOT `LLM_PROVIDER` (2026-08-10).**
 *
 * This function and `runWarmCycle` both used `getPlatformProvider`, which was exactly right while the
 * provider was fixed — fixed WAS serving, by construction. `AUTO_MODEL_SELECT` broke that identity:
 * a turn can be served by any rung in `LLM_PROVIDER_CHAIN`, and the cached prefix is **per gateway**.
 * So during precisely the outage the ladder exists to survive, the warmer would have been warming a
 * prefix nobody was sending, at a fanout tuned for a gateway nobody was using — this file's own
 * documented failure mode ("a warmer warming a prefix nobody sends is false comfort, silently"),
 * arriving through a door that did not exist when it was written. It is the `getPlatformProvider`
 * defect one layer up from the one this file already records: a guard that names a fixed vendor stops
 * being true the next time the config changes.
 *
 * `resolvePlatformProvider` is the SAME function `getPlatformConfig` calls, so the warmer and the
 * proxy cannot disagree about who is serving — which is the only property that makes a warmer worth
 * running at all. With `AUTO_MODEL_SELECT` off it IS `getPlatformProvider`, so this is byte-identical
 * to the old behaviour on every deploy that has not opted in.
 *
 * ⚠️ **It warms ONE gateway — the current head of the ladder — never the whole chain.** Warming the
 * chain would multiply a spend already documented as unmeasured (~$0.30/day per prefix against ~$0.18
 * per cold start avoided) by the ladder's length, for gateways most turns never touch. Following the
 * ladder costs the same as before and is simply pointed at the right place.
 *
 * ⚠️ **Consequence worth knowing before enabling it:** a failover REPOINTS the warmer, so the rung the
 * ladder just left goes cold while it is cooling. That is correct — a prefix nobody sends is what this
 * is designed not to pay for — but it means the first turn after a failback pays a cold start. The
 * measurement pass this file owes (`generations.cacheCreationTokens > 0` counts cold starts) should
 * count those separately once the ladder is live, or a laddered deploy will read as warmer-ineffective
 * when it is doing exactly what it should.
 */
export function cacheWarmerFanout(context?: unknown, providerOverride?: PlatformProviderName): number {
  const fallback = FANOUT_BY_PROVIDER[providerOverride ?? resolvePlatformProvider(context)] ?? DEFAULT_ANTHROPIC_FANOUT;
  const fanout = envNumber(context, 'CACHE_WARMER_FANOUT', fallback);

  return Number.isFinite(fanout) && fanout >= 1 && fanout <= 16 ? Math.floor(fanout) : fallback;
}

/**
 * When the platform last saw a cache READ on the shared prefix — stamped by the proxy after settlement.
 *
 * 🔴 The warmer exists to cover IDLE gaps, and during a busy hour every cycle is pure waste: the users'
 * own traffic has already kept the entry warm, and the warmer pays a read to discover that. Skipping a
 * cycle whose work organic traffic already did is what makes the steady-state cost proportional to how
 * QUIET the platform is — which is the only shape under which warming is ever worth running.
 *
 * Module-level rather than persisted on purpose: it is a within-process hint about the last few
 * minutes, and a stale value from another instance would suppress a cycle this one needed. Losing it
 * on restart costs exactly one extra warm read.
 */
let lastCacheReadAtMs = 0;

/** Stamp a successful cache read. Called by the proxy on any generation that read the cache (§4.2.8). */
export function recordCacheRead(atMs: number = Date.now()): void {
  if (atMs > lastCacheReadAtMs) {
    lastCacheReadAtMs = atMs;
  }
}

/** The last recorded cache read, for tests and for the cycle's own skip decision. */
export function lastCacheReadAt(): number {
  return lastCacheReadAtMs;
}

/**
 * Pure so the skip rule is testable without a clock or a network: has organic traffic already warmed
 * the prefix inside this cycle's window?
 *
 * `lastReadAt === 0` means "nothing seen yet" and must NOT count as recent — a fresh process has warmed
 * nothing, and treating unknown as warm is how a warmer silently never runs.
 */
export function shouldSkipWarmCycle(input: { nowMs: number; lastReadAtMs: number; intervalMinutes: number }): boolean {
  if (input.lastReadAtMs <= 0) {
    return false;
  }

  return input.nowMs - input.lastReadAtMs < input.intervalMinutes * 60_000;
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
export function buildWarmupRequest(input: {
  model: string;
  promptText: string;
  apiKey: string;

  /**
   * Which wire to speak. Anthropic direct and KIE serve the SAME Messages API — they differ only in
   * base URL and auth header, which is exactly why the platform can swap providers with a config
   * change. Hardcoding KIE here is what left this module dead for the whole time the platform has been
   * on Anthropic (`runWarmCycle` bailed with `'platform provider is not KIE'` rather than sending a
   * request to the wrong host, so it failed quietly and correctly — and did nothing).
   */
  provider: PlatformProviderName;
}): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  /*
   * 🔴 A RECORD, not `provider === 'Anthropic' ? … : …`.
   *
   * That binary meant "Anthropic, or ELSE KIE" — so the moment a third provider existed, a Comet
   * deploy would have POSTed a Comet API key to `api.kie.ai`. Not a no-op: a real credential sent to
   * the wrong vendor, on a timer, warming a prefix nobody sends. Exactly the false comfort this
   * module's header warns about, and the same shape as the `platformKeyFor` ternary one file over.
   *
   * Every entry speaks the SAME Anthropic Messages wire and differs only in origin and auth header —
   * which is the entire reason `LLM_PROVIDER` can be a config swap.
   */
  const wire: Record<PlatformProviderName, { url: string; auth: Record<string, string> }> = {
    Anthropic: {
      url: `${ANTHROPIC_DEFAULT_BASE_URL}/messages`,
      auth: { 'x-api-key': input.apiKey },
    },

    /* KIE and Comet both proxy the same wire behind a bearer token; Comet accepts either header. */
    KIE: {
      url: `${KIE_DEFAULT_BASE_URL}/messages`,
      auth: { authorization: `Bearer ${input.apiKey}` },
    },
    Comet: {
      url: `${COMET_DEFAULT_BASE_URL}/messages`,
      auth: { authorization: `Bearer ${input.apiKey}` },
    },
  };

  const { url, auth } = wire[input.provider];

  return {
    url,
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...auth,
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

  /** Injected clock, so the skip rule is testable without waiting out a 45-minute interval. */
  now?: () => number;
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
     * 🔴 Skip a cycle organic traffic already did. The warmer covers IDLE gaps; during a busy hour the
     * users' own generations have kept the entry warm and a cycle would pay a read to learn that. This
     * is what makes the steady-state cost proportional to how QUIET the platform is — the only shape
     * under which running a warmer is ever worth it.
     */
    if (
      shouldSkipWarmCycle({
        nowMs: deps?.now?.() ?? Date.now(),
        lastReadAtMs: lastCacheReadAtMs,
        intervalMinutes: cacheWarmerIntervalMinutes(context),
      })
    ) {
      return none('organic traffic read the cache within the interval');
    }

    /*
     * The key env var comes from the SAME table the rest of the platform uses (`platformKeyEnvFor`),
     * not from a local ternary. It was `provider === 'KIE' ? 'KIE_API_KEY' : 'ANTHROPIC_API_KEY'` —
     * a second copy of a rule that already had a home, and one that would have read the ANTHROPIC key
     * on a Comet deploy. Two writers of one fact is how they start disagreeing.
     */
    /*
     * The LADDER's answer, not `LLM_PROVIDER` — see `cacheWarmerFanout` above. Resolved ONCE here and
     * threaded to the key, the model and the fanout below, so a cycle cannot warm one gateway's prefix
     * with another gateway's key or model. (The ladder is cheap and deterministic, but it reads a
     * cooldown map that organic traffic mutates, so two calls in one cycle really could differ.)
     */
    const provider = resolvePlatformProvider(context);
    const keyEnvVar = platformKeyEnvFor(provider);
    const apiKey = env(context, keyEnvVar);

    if (!apiKey) {
      return none(`${keyEnvVar} is not configured`);
    }

    const active = await getActivePrompt();

    if (!active) {
      return none('no active prompt version');
    }

    /*
     * Throws only for an unpriced model — a config state the generations themselves already refuse on,
     * so the warmer staying quiet about it adds no new failure mode.
     */
    const model = getPlatformModel(context, provider);

    /*
     * 🔴 CLAUDE ONLY — and the guard sits HERE, not in `ensureCacheWarmer`, on purpose.
     *
     * Breakpoint warming is an Anthropic mechanism end to end: it works by re-sending a prefix marked
     * with `cache_control` so the vendor materialises the entry, and `buildWarmupRequest` speaks the
     * Messages wire (`/claude/v1/messages` + `anthropic-version`) to do it. Against a `gpt-*` or
     * `gemini-*` platform model that request warms NOTHING — it is a POST to the wrong endpoint for a
     * model that is not running there — and the other two families have nothing to warm anyway:
     * OpenAI-style prefix caching is automatic and unwarmable, and KIE prices no Gemini caching at all
     * (`model-families.ts` `cacheProfile: 'none'`).
     *
     * ⚠️ `runWarmCycle` is the guard point rather than `ensureCacheWarmer` because it is the ONE choke
     * point every door passes through — the interval, the kickoff, AND `warmAfterPromptChange` (fired
     * on every prompt promotion). Guarding only the starter would leave the promotion path spending
     * real money on a request that warms nothing, which is the exact false-comfort failure this
     * module's own header warns about: "a warmer warming a prefix nobody sends fails silently".
     */
    const family = familyOf(model);

    if (family !== 'claude') {
      return none(`platform model "${model}" is not a Claude model — breakpoint warming is Anthropic-only`);
    }

    const request = buildWarmupRequest({ model, promptText: active.content, apiKey, provider });
    const fetchFn = deps?.fetchFn ?? fetch;
    const sleep = deps?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const fanout = cacheWarmerFanout(context, provider);

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

  /*
   * The read stamp is module state too, and a leaked one makes the NEXT test's cycle skip for a reason
   * that test never set up — a flake whose cause is in a different file.
   */
  lastCacheReadAtMs = 0;
}
