/**
 * Model capability shims that sit at the `LanguageModelV1` boundary — after the `ai` SDK builds
 * its call options, before the provider serializes the request body. Both fixes below are
 * IMPOSSIBLE to apply from a call site; see `spec/anthropic-models.md` §3 for the full rationale.
 *
 * This file must stay OUTSIDE `~/lib/.server/**`: the provider registry is imported by client code
 * (model pickers), so a provider importing a `.server` module breaks the client bundle.
 */
import type { LanguageModelV1, LanguageModelV1StreamPart } from 'ai';

/**
 * The LEGACY Claude models that still accept the sampling params (`temperature`, `top_p`, `top_k`).
 *
 * On every current model, sending any of them is a hard 400 — not a silently-ignored field — so the
 * DEFAULT here is "strip them", and this list is the shrinking set of exceptions.
 *
 * 🔴 **THE DIRECTION OF THIS LIST IS THE POINT — do not invert it back.** It used to name the models
 * that had REMOVED sampling params, i.e. an allow-list of *modern* ids. That set is open and grows with
 * every Anthropic release, so a model the constant had never heard of — exactly what `LLM_MODEL` is for
 * (§"config, never hardcoded") — fell through to the legacy branch and got `temperature: 0` injected by
 * `ai@4`, which is a **400 on every generation before a token is emitted**. Setting `LLM_MODEL` to a new
 * model therefore required a code change and a redeploy, which is precisely what that knob exists to
 * avoid. This complement is CLOSED: no future Claude model will re-add sampling params, so the list can
 * only shrink, and a brand-new id is handled correctly with no code change at all.
 *
 * The residual cost is a genuinely ancient id getting modern treatment → a 400 on the FIRST request:
 * loud, immediate, free, and self-describing. The failure it replaces was silent and open-ended. Same
 * fail-loud preference as `assertNotLocalInProduction` and `NotConfiguredError`.
 *
 * Matched as prefixes so Bedrock's `anthropic.`-prefixed ids resolve too (`claude-3` covers the whole
 * 3.x family, dated snapshots included).
 */
const MODELS_WITH_SAMPLING_PARAMS = ['claude-haiku-4-5', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-3'];

/**
 * Whether a model still accepts `temperature`/`top_p`/`top_k`.
 * Older Claude models (Haiku 4.5, Opus 4.6, Sonnet 4.6, the 3.x family) do; every current model does not.
 */
export function supportsSamplingParams(modelId: string): boolean {
  const id = bareModelId(modelId);

  return MODELS_WITH_SAMPLING_PARAMS.some((supported) => id.startsWith(supported));
}

/**
 * The LEGACY Claude models that do NOT take the modern thinking parameter (`{type: 'adaptive' | 'disabled'}`).
 *
 * Everything current does, so the DEFAULT here is "modern", and this list is the shrinking set of
 * exceptions. On a modern model the legacy `{type: 'enabled', budget_tokens: N}` is a hard 400 — and that
 * is precisely what `@ai-sdk/anthropic@1.2.12` emits, unconditionally, whenever thinking is configured
 * through `providerOptions` (it hardcodes `thinking: {type: 'enabled', budget_tokens}` and *requires* a
 * budget). So on a current model the SDK's thinking option is not merely awkward — it is unusable, and
 * the only way to say anything about thinking is `thinkingFetch` below.
 *
 * 🔴 **DIRECTION, again — see `MODELS_WITH_SAMPLING_PARAMS` above; this list failed the same way but
 * SILENTLY, which is worse.** As an allow-list of modern ids, an unrecognised model made `thinkingFetch`
 * early-return, so the request carried neither `display: 'summarized'` NOR `output_config.effort`. That
 * buys the server-side default effort (`high`, the second-most-expensive setting) on every turn and
 * returns thinking blocks whose text is EMPTY — i.e. it silently re-creates BOTH pathologies this file
 * exists to prevent (§4.2a: the 90s dead spinner, and paying full output rate for reasoning we cannot
 * show). Nothing throws, no test fails, and the token count goes DOWN, which reads like a cheaper turn.
 */
const MODELS_WITHOUT_ADAPTIVE_THINKING = ['claude-3'];

/** Fable 5 thinks unconditionally: an explicit `{type: 'disabled'}` is a 400. Never send it one. */
const MODELS_THAT_CANNOT_DISABLE_THINKING = ['claude-fable-5'];

/**
 * Models that accept `{type: 'disabled'}` only up to a CEILING effort — above it, it is a 400.
 *
 * Opus 5 is the first model to gate the two parameters against each other: `thinking: {type:'disabled'}`
 * is accepted at effort `high` and below, and rejected at `xhigh`/`max`. `MODELS_THAT_CANNOT_DISABLE_THINKING`
 * above cannot express that — it is unconditional — so the rule needs its own table.
 *
 * ⚠️ This is REACHABLE FROM AN ENV FILE ALONE, and at the worst possible moment: `effort-policy.ts` only
 * ever escalates, taking a 2nd repair attempt to `xhigh`. So an operator running `THINKING_MODE=disabled`
 * would get a hard 400 on the turn that had already failed twice — the generation least able to afford it.
 */
const THINKING_DISABLED_EFFORT_CEILING: Record<string, EffortLevel> = {
  'claude-opus-5': 'high',
};

export type ThinkingMode = 'adaptive' | 'disabled';

/**
 * How hard the model works before it answers — the dial that actually controls thinking SPEND.
 *
 * `effort` is GA (no beta header) and lives inside `output_config`. **The API default is `high`**, so
 * a request that never mentions effort — like every one of ours until now — is silently buying the
 * second-most-expensive setting. That is how one project creation came to spend ~15,000 thinking
 * tokens to emit ~5,500 tokens of landing page: we were paying for deep deliberation on a task that
 * did not need it, and we never asked for it.
 *
 * These are billed as OUTPUT tokens, at the full output rate. Thinking is not free and it is not
 * "dead time" — it is the model planning, and it does improve the result — but the depth has to be
 * matched to the job, and only this parameter does that. `budget_tokens` is gone (a hard 400 on
 * current models); `effort` replaced it.
 */
export const EFFORT_LEVELS = ['medium', 'high', 'xhigh', 'max'] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * `low` is DELIBERATELY ABSENT, and this is a correctness decision, not a style one.
 *
 * The API accepts `low`; we refuse to send it. On a real substantial edit ("add a boost mechanic")
 * against a real project, `low` edited `src/routing/router.tsx` — READ-ONLY SHELL (§4.4c) — and
 * rewrote whole files instead of patching them. `medium`, on the same prompt, created
 * `src/scripts/BoostController.ts` in the correct zone and landed 5/5 clean search-replace blocks.
 *
 * So `low` is not a cheaper tier, it is a WRONG one: it buys a 58-credit saving with a never-violate
 * zone breach. Excluding it from the union means no config value, no policy branch, and no future
 * "let's save a bit here" refactor can reach it without deleting this comment first.
 */
export const REJECTED_EFFORT = 'low';

/** Overridable with `THINKING_EFFORT`. See `spec/anthropic-models.md` §3.5 for the measurements. */
export const DEFAULT_EFFORT: EffortLevel = 'medium';

/**
 * Validate an operator-supplied `THINKING_EFFORT`, returning `undefined` when there is nothing usable
 * to say (so the caller falls back to `DEFAULT_EFFORT`).
 *
 * A raw `as EffortLevel` cast on an env var is a lie the type system cannot catch: `.env.local` is a
 * string file, so a typo (`hgih`) or the banned `low` would sail through the cast and onto the wire.
 * Both are clamped here, loudly, at the one place the string becomes a typed value.
 */
export function parseEffort(raw: string | undefined): EffortLevel | undefined {
  if (!raw) {
    return undefined;
  }

  const value = raw.trim().toLowerCase();

  if (!value) {
    return undefined;
  }

  if (value === REJECTED_EFFORT) {
    console.warn(
      `[capabilities] THINKING_EFFORT=low is not supported — it breaches read-only project zones ` +
        `(see the note above EFFORT_LEVELS). Clamping to "${DEFAULT_EFFORT}".`,
    );

    return DEFAULT_EFFORT;
  }

  if (!(EFFORT_LEVELS as readonly string[]).includes(value)) {
    console.warn(
      `[capabilities] THINKING_EFFORT="${raw}" is not one of ${EFFORT_LEVELS.join('|')}. ` +
        `Falling back to "${DEFAULT_EFFORT}".`,
    );

    return undefined;
  }

  return value as EffortLevel;
}

/**
 * The two levels a USER may choose as the base effort for their session (SPEC §4.2a, §4.2.9).
 *
 * Deliberately a STRICT SUBSET of `EFFORT_LEVELS`, not the whole union:
 *
 *  - Below `medium` there is nothing — `low` is a correctness bug, not a discount (see `REJECTED_EFFORT`).
 *  - Above `high` there is `xhigh`/`max`, which `effort-policy.ts` spends ONLY on evidence (a repair that
 *    has already failed twice). Handing those to a user as a session default turns the escalation ladder
 *    into a floor — every ordinary edit would start where a twice-failed build ends, on the operator's
 *    credit pool, with no signal that the turn needed it. The ceiling stays earned, never chosen.
 *
 * So the user picks the FLOOR (`medium` or `high`); the policy still escalates above it on evidence.
 */
export const USER_EFFORT_LEVELS = ['medium', 'high'] as const;

export type UserEffortLevel = (typeof USER_EFFORT_LEVELS)[number];

/** The base effort a session starts at when the user has not chosen. Matches `DEFAULT_EFFORT`. */
export const DEFAULT_USER_EFFORT: UserEffortLevel = 'medium';

/**
 * Validate a CLIENT-SUPPLIED base effort, returning `undefined` for anything that is not one of the two
 * user-selectable levels.
 *
 * This is a request from a browser, so it is untrusted in exactly the way `THINKING_EFFORT` is not: a
 * tampered body asking for `max` on every turn is a request to multiply the thinking bill on the
 * platform's credit pool. Anything unrecognised — `max`, `xhigh`, `low`, a typo, a number, an object —
 * resolves to `undefined`, which means "no user choice" and falls back to the operator default. It never
 * throws and never clamps upward: an unusable value must cost nothing, not buy the expensive setting.
 */
export function parseUserEffort(raw: unknown): UserEffortLevel | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }

  const value = raw.trim().toLowerCase();

  return (USER_EFFORT_LEVELS as readonly string[]).includes(value) ? (value as UserEffortLevel) : undefined;
}

function bareModelId(modelId: string): string {
  return modelId.startsWith('anthropic.') ? modelId.slice('anthropic.'.length) : modelId;
}

export function supportsAdaptiveThinking(modelId: string): boolean {
  const id = bareModelId(modelId);
  return !MODELS_WITHOUT_ADAPTIVE_THINKING.some((legacy) => id.startsWith(legacy));
}

/**
 * Whether `{type: 'disabled'}` may be sent for this model AT THIS EFFORT.
 *
 * Two independent reasons to say no, and the second is why `effort` is a parameter here at all:
 *   1. The model cannot disable thinking at any effort (Fable 5).
 *   2. The model allows it only up to a ceiling effort (Opus 5: `high`; `xhigh`/`max` are a 400).
 *
 * ⚠️ **The caller CLAMPS on a `false` — it must never throw or propagate the 400.** `thinkingFetch` falls
 * back to `adaptive`, which every model accepts. That mirrors `parseEffort`, which clamps a bad operator
 * value at the boundary rather than failing mid-generation: an operator's `THINKING_MODE=disabled` is a
 * preference, and a preference that cannot be honoured on this turn is not a reason to burn the turn.
 */
export function canDisableThinking(modelId: string, effort: EffortLevel = DEFAULT_EFFORT): boolean {
  const id = bareModelId(modelId);

  if (MODELS_THAT_CANNOT_DISABLE_THINKING.some((locked) => id.startsWith(locked))) {
    return false;
  }

  const ceiling = Object.entries(THINKING_DISABLED_EFFORT_CEILING).find(([model]) => id.startsWith(model))?.[1];

  if (!ceiling) {
    return true;
  }

  return EFFORT_LEVELS.indexOf(effort) <= EFFORT_LEVELS.indexOf(ceiling);
}

/**
 * Set `thinking` on the request body, at the ONLY layer that can reach it.
 *
 * ## Why a `fetch` wrapper and not `providerOptions`
 *
 * `@ai-sdk/anthropic@1.2.12` predates adaptive thinking. Its thinking option emits
 * `{type: 'enabled', budget_tokens: N}` — the legacy shape, which current models reject with a 400 —
 * and it throws if you omit the budget. There is no value of `providerOptions` that produces
 * `{type: 'adaptive'}` or `{type: 'disabled'}`. The `LanguageModelV1` shims above cannot help either:
 * they see the SDK's call options, not the JSON body. The body is assembled inside the provider and
 * handed straight to `fetch`, so `fetch` is the seam.
 *
 * ## Why this matters enough to justify the seam
 *
 * OMITTING `thinking` is not "thinking off" — on Sonnet 5 and the 4.6+ family it means **adaptive
 * thinking ON**, and `thinking.display` defaults to `"omitted"`, so the model streams thinking blocks
 * whose text is EMPTY. We measured one project creation: **54 seconds of total silence** — no text, not
 * even HTTP headers — before the first byte, which is 46% of the wall clock; and of 20,565 output
 * tokens, only ~5,500 became visible artifact. The rest was thinking we paid full output rate for and
 * literally could not show anyone. To the user that is a dead spinner, and it is what they reported as
 * the app "just sitting there".
 *
 * So thinking is now an explicit, configurable decision instead of an accident of an omitted field.
 */
export function thinkingFetch(
  mode: ThinkingMode,
  effort: EffortLevel,
  modelId: string,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    if (!init?.body || typeof init.body !== 'string' || !supportsAdaptiveThinking(modelId)) {
      return baseFetch(input, init);
    }

    let body: Record<string, unknown>;

    try {
      body = JSON.parse(init.body);
    } catch {
      // Not JSON we understand — never let a body rewrite be the thing that breaks a generation.
      return baseFetch(input, init);
    }

    /*
     * `display: 'summarized'` is the whole point of turning thinking on.
     *
     * The default is `display: 'omitted'`: the model reasons, we are billed for every token at the
     * full output rate, and the API sends back a thinking block whose text is EMPTY. There is
     * literally nothing to show — which is why a 90-second think looked like a hung app.
     *
     * `summarized` costs NOTHING extra (thinking is billed identically under every display setting)
     * and turns those tokens into a readable stream we can put on screen. Paying for reasoning and
     * then throwing it away was the actual bug; disabling thinking was only ever a workaround for it.
     */
    if (mode === 'disabled' && canDisableThinking(modelId, effort)) {
      body.thinking = { type: 'disabled' };
    } else {
      body.thinking = { type: 'adaptive', display: 'summarized' };
    }

    /*
     * Effort is what actually bounds the SPEND, and it must be set explicitly.
     *
     * `output_config.effort` defaults to `high` server-side, so omitting it is not "no opinion" — it
     * is an expensive opinion we never knowingly gave. Setting it is the difference between the model
     * deliberating like the task is a compiler and deliberating like the task is a landing page.
     *
     * Merged, not overwritten: `output_config` may already carry other fields.
     */
    body.output_config = { ...((body.output_config as Record<string, unknown>) ?? {}), effort };

    return baseFetch(input, { ...init, body: JSON.stringify(body) });
  };
}

/**
 * Delete sampling params from the call options before the provider serializes them.
 *
 * `ai@4` INJECTS `temperature: 0` when the caller supplies none
 * (`temperature: temperature != null ? temperature : 0`), so passing `undefined` from a call site
 * still puts `0` on the wire. The only reliable removal point is here.
 */
export function stripSamplingParams(model: LanguageModelV1): LanguageModelV1 {
  const strip = <T extends Record<string, any>>(options: T): T => {
    const { temperature: _t, topP: _p, topK: _k, ...rest } = options;

    return rest as unknown as T;
  };

  return new Proxy(model, {
    get(target, prop, receiver) {
      if (prop === 'doGenerate' || prop === 'doStream') {
        const original = Reflect.get(target, prop, receiver) as (options: any) => any;

        return (options: any) => original.call(target, strip(options));
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * Drop `reasoning-signature` stream parts that no `reasoning` part precedes.
 *
 * Current Claude models default `thinking.display` to `"omitted"`: the wire carries a thinking
 * block whose text is EMPTY plus a signature. `@ai-sdk/anthropic` emits `reasoning` only on a
 * `thinking_delta` but emits `reasoning-signature` unconditionally on a `signature_delta`, while
 * `ai@4` throws `InvalidStreamPart` on any signature it cannot pair with a preceding reasoning
 * part. An empty thinking block produces exactly that orphan.
 *
 * This mirrors ai's own state machine: `reasoning` arms the signature, `reasoning-signature`
 * consumes it, an unarmed signature is dropped. Real reasoning and its legitimate signature pass
 * through untouched. Applied to EVERY Claude model — any thinking-capable model can emit an empty
 * thinking block, and it cannot be avoided by disabling thinking (Fable 5 forbids that).
 */
export function dropOrphanReasoningSignatures(model: LanguageModelV1): LanguageModelV1 {
  return new Proxy(model, {
    get(target, prop, receiver) {
      if (prop !== 'doStream') {
        return Reflect.get(target, prop, receiver);
      }

      const doStream = Reflect.get(target, prop, receiver) as LanguageModelV1['doStream'];

      return async (options: Parameters<LanguageModelV1['doStream']>[0]) => {
        const result = await doStream.call(target, options);

        let signatureArmed = false;

        const filter = new TransformStream<LanguageModelV1StreamPart, LanguageModelV1StreamPart>({
          transform(part, controller) {
            if (part.type === 'reasoning') {
              signatureArmed = true;
            } else if (part.type === 'reasoning-signature') {
              if (!signatureArmed) {
                return; // orphan — ai@4 would throw on it
              }

              signatureArmed = false;
            }

            controller.enqueue(part);
          },
        });

        return { ...result, stream: result.stream.pipeThrough(filter) };
      };
    },
  });
}
