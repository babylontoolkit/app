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
