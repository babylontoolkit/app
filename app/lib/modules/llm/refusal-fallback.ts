/**
 * Server-side refusal fallback for the models that ship safety classifiers (§4.2a).
 *
 * ## Why this exists — measured live, 2026-08-06
 *
 * Claude Fable 5 (and Opus 5) can DECLINE a request outright: an HTTP 200 with
 * `stop_reason: "refusal"`, empty content, 3–4 billed-but-uncharged tokens. The stop-reason tap
 * caught the platform's first-build turn being declined with category `reasoning_extraction` —
 * intermittently at step 0, usually on the continuation step after the media tool results — which
 * the `@ai-sdk/anthropic` adapter collapsed to `finishReason: 'unknown'`, so every Fable 5 creation
 * "hung" and then failed as an empty response with nothing anywhere naming the cause. Opus and
 * Sonnet have no such classifiers, which is why only Fable 5 was affected.
 *
 * ## The fix — Anthropic's own mechanism, applied at the fetch seam
 *
 * The API's server-side fallback beta (`anthropic-beta: server-side-fallback-2026-07-01` + a
 * `fallbacks` list on the body) retries a DECLINED request on a fallback model inside the same
 * call, on the same stream — including declines that fire mid-tool-loop ("completed tool work does
 * not block fallback"). The fallback target is pinned per model in {@link REFUSAL_FALLBACKS} and
 * verified against the Models API's `allowed_fallback_models` (claude-fable-5 → permits
 * claude-opus-4-8 and claude-opus-5; we use Opus 5, the platform's own Premium rung). Only a safety
 * classifier decline triggers it — rate limits, overloads and server errors pass through untouched,
 * so the retry-policy ladder is unaffected.
 *
 * ## Why the response must be FILTERED, not just passed through
 *
 * A fallback-served response marks the handoff with a `fallback` content block
 * (`content_block_start` … `content_block_stop` with `content_block.type: "fallback"`).
 * `@ai-sdk/anthropic@1.2.12` validates every chunk against a closed zod discriminated union and its
 * parser THROWS on any unknown content block type — so the raw stream would kill the exact
 * generation the fallback just saved. {@link createFallbackBlockFilter} strips those two events
 * (and only those) from the SSE stream and records the handoff so the proxy can persist and log
 * which model actually served the turn.
 *
 * Streaming contract (same as shell-strip/protocol-strip): the only text withheld is the tail of an
 * SSE event still waiting for its `\n\n` terminator — bounded by one event's length, never by the
 * response's. Everything passed through is byte-identical.
 *
 * Client-importable by construction (no node imports); the fetch executes server-side only.
 */
import type { TappedStop } from '~/lib/modules/llm/stop-reason-tap';

/**
 * Model → fallback model, applied ONLY when the primary declines via safety classifier.
 *
 * Every entry MUST be one of the primary's `allowed_fallback_models` (Models API, under the
 * fallback beta header) — an unlisted target is a hard 400 on EVERY request, before a token.
 * Verified 2026-08-06: claude-fable-5 permits ['claude-opus-4-8', 'claude-opus-5'].
 *
 * Opus 5 also carries classifiers but has not been observed refusing platform turns; it gets an
 * entry only if that changes, with its own allowed-targets check first.
 */
const REFUSAL_FALLBACKS: Record<string, string> = {
  'claude-fable-5': 'claude-opus-5',
};

export const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export function refusalFallbackModelFor(modelId: string): string | undefined {
  return REFUSAL_FALLBACKS[modelId];
}

/** One recorded handoff: the declining model → the model that served the turn. */
export interface FallbackHandoff {
  from: string;
  to: string;
}

const handoffs: FallbackHandoff[] = [];
const MAX_HANDOFFS = 20;

/**
 * Drain (and clear) every handoff observed since the last drain — the proxy calls this per
 * generation, next to `drainStopReasons`. Process-global like the stop tap: concurrent generations
 * would interleave, acceptable for a diagnostic signal.
 */
export function drainFallbackHandoffs(): FallbackHandoff[] {
  return handoffs.splice(0, handoffs.length);
}

/**
 * User-facing copy for a generation every model in the chain declined.
 *
 * Distinct from `EMPTY_RESPONSE_ERROR` ON PURPOSE: the retry ladder keys on "returned an empty
 * response", and re-sending a refused request to the same model earns another refusal — a refusal
 * must NOT quietly re-run. The category/explanation come from `stop_details`; the docs say to
 * display the explanation, never parse it.
 */
export function describeRefusal(stop: TappedStop): string {
  let category: string | undefined;
  let explanation: string | undefined;

  if (stop.detail) {
    try {
      const detail = JSON.parse(stop.detail) as { category?: string; explanation?: string };
      category = detail.category ?? undefined;
      explanation = detail.explanation ?? undefined;
    } catch {
      // stop_details we could not parse — the generic sentence still names the refusal.
    }
  }

  const label = category ? ` (category: ${category})` : '';
  const detailText = explanation ? ` ${explanation}` : '';

  return (
    `Claude declined this request via a safety classifier${label}.${detailText} ` +
    'You have not been charged for this generation. This is usually a false positive — rephrasing the request, or switching the model class for this turn, normally resolves it.'
  );
}

interface FallbackBlockFilter {
  /** Feed a decoded chunk; returns the text safe to forward NOW (complete, non-fallback events). */
  push(text: string): string;

  /** End of stream: whatever tail is still buffered (a partial event) is forwarded verbatim. */
  flush(): string;
}

/**
 * SSE-event filter that drops a `fallback` content block's start/stop pair and nothing else.
 *
 * Events are framed by a blank line (`\n\n`). Each complete event either passes through
 * byte-identical or is dropped whole; the only buffered text is the not-yet-terminated tail.
 */
export function createFallbackBlockFilter(onHandoff: (handoff: FallbackHandoff) => void): FallbackBlockFilter {
  let buffer = '';
  const droppedIndexes = new Set<number>();

  const shouldDrop = (event: string): boolean => {
    // Fast path: nothing fallback-shaped in this event.
    if (!event.includes('"content_block_start"') && !event.includes('"content_block_stop"')) {
      return false;
    }

    const dataLine = event
      .split('\n')
      .find((line) => line.startsWith('data:'))
      ?.slice('data:'.length)
      .trim();

    if (!dataLine) {
      return false;
    }

    let parsed: {
      type?: string;
      index?: number;
      content_block?: { type?: string; from?: { model?: string }; to?: { model?: string } };
    };

    try {
      parsed = JSON.parse(dataLine);
    } catch {
      // Not JSON we understand — never drop what we cannot read.
      return false;
    }

    if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'fallback') {
      if (typeof parsed.index === 'number') {
        droppedIndexes.add(parsed.index);
      }

      onHandoff({
        from: parsed.content_block.from?.model ?? 'unknown',
        to: parsed.content_block.to?.model ?? 'unknown',
      });

      return true;
    }

    if (parsed.type === 'content_block_stop' && typeof parsed.index === 'number' && droppedIndexes.has(parsed.index)) {
      droppedIndexes.delete(parsed.index);
      return true;
    }

    return false;
  };

  return {
    push(text: string): string {
      buffer += text;

      let out = '';
      let boundary: number;

      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, boundary + 2);
        buffer = buffer.slice(boundary + 2);

        if (!shouldDrop(event)) {
          out += event;
        }
      }

      return out;
    },

    flush(): string {
      const tail = buffer;
      buffer = '';

      return tail;
    },
  };
}

function appendBetaHeader(headers: HeadersInit | undefined): Headers {
  const merged = new Headers(headers);
  const existing = merged.get('anthropic-beta');

  merged.set('anthropic-beta', existing ? `${existing},${SERVER_SIDE_FALLBACK_BETA}` : SERVER_SIDE_FALLBACK_BETA);

  return merged;
}

/**
 * Wrap a fetch so requests for a classifier-refusing model carry the server-side fallback, and the
 * response stream never shows the SDK a `fallback` content block.
 *
 * Sits INSIDE `thinkingFetch` in the provider chain so it sees the finished body (thinking +
 * output_config already applied — the fallback attempt inherits them). Models with no table entry
 * pass through byte-identical on both sides.
 */
export function refusalFallbackFetch(modelId: string, baseFetch: typeof fetch = fetch): typeof fetch {
  const fallbackModel = refusalFallbackModelFor(modelId);

  if (!fallbackModel) {
    return baseFetch;
  }

  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    let request = init;

    if (init?.body && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;

        body.fallbacks = [{ model: fallbackModel }];
        request = { ...init, body: JSON.stringify(body), headers: appendBetaHeader(init.headers) };
      } catch {
        // Not JSON we understand — never let the fallback rewrite break a generation.
      }
    }

    const response = await baseFetch(input, request);
    const contentType = response.headers.get('content-type') ?? '';

    if (!response.body || !contentType.includes('event-stream')) {
      return response;
    }

    const filter = createFallbackBlockFilter((handoff) => {
      handoffs.push(handoff);

      if (handoffs.length > MAX_HANDOFFS) {
        handoffs.shift();
      }
    });

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const filtered = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          const out = filter.push(decoder.decode(chunk, { stream: true }));

          if (out) {
            controller.enqueue(encoder.encode(out));
          }
        },
        flush(controller) {
          const tail = filter.flush();

          if (tail) {
            controller.enqueue(encoder.encode(tail));
          }
        },
      }),
    );

    return new Response(filtered, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof fetch;
}
