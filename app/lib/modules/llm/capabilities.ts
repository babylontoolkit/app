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
 * Claude models that REMOVED the sampling params (`temperature`, `top_p`, `top_k`).
 * Sending any of them is a hard 400 — not a silently-ignored field.
 *
 * Matched as prefixes so Bedrock's `anthropic.`-prefixed ids resolve too.
 */
const MODELS_WITHOUT_SAMPLING_PARAMS = ['claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-fable-5'];

/**
 * Whether a model still accepts `temperature`/`top_p`/`top_k`.
 * Older Claude models (Haiku 4.5, Opus 4.6, Sonnet 4.6) do; the current flagships do not.
 */
export function supportsSamplingParams(modelId: string): boolean {
  const id = modelId.startsWith('anthropic.') ? modelId.slice('anthropic.'.length) : modelId;

  return !MODELS_WITHOUT_SAMPLING_PARAMS.some((unsupported) => id.startsWith(unsupported));
}

/**
 * Claude models that take the MODERN thinking parameter (`{type: 'adaptive' | 'disabled'}`).
 *
 * On these, the legacy `{type: 'enabled', budget_tokens: N}` is a hard 400 — and that is precisely
 * what `@ai-sdk/anthropic@1.2.12` emits, unconditionally, whenever thinking is configured through
 * `providerOptions` (it hardcodes `thinking: {type: 'enabled', budget_tokens}` and *requires* a
 * budget). So on a current model the SDK's thinking option is not merely awkward — it is unusable,
 * and the only way to say anything about thinking is `thinkingFetch` below.
 */
const MODELS_WITH_ADAPTIVE_THINKING = [
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-fable-5',
];

/** Fable 5 thinks unconditionally: an explicit `{type: 'disabled'}` is a 400. Never send it one. */
const MODELS_THAT_CANNOT_DISABLE_THINKING = ['claude-fable-5'];

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

function bareModelId(modelId: string): string {
  return modelId.startsWith('anthropic.') ? modelId.slice('anthropic.'.length) : modelId;
}

export function supportsAdaptiveThinking(modelId: string): boolean {
  const id = bareModelId(modelId);
  return MODELS_WITH_ADAPTIVE_THINKING.some((supported) => id.startsWith(supported));
}

export function canDisableThinking(modelId: string): boolean {
  const id = bareModelId(modelId);
  return !MODELS_THAT_CANNOT_DISABLE_THINKING.some((locked) => id.startsWith(locked));
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
    if (mode === 'disabled' && canDisableThinking(modelId)) {
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
