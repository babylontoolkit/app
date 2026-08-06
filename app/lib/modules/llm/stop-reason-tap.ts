/**
 * Wire tap for the RAW Anthropic `stop_reason` — because the SDK throws it away.
 *
 * `@ai-sdk/anthropic@1.2.12` maps `end_turn`/`stop_sequence`/`tool_use`/`max_tokens` and turns
 * EVERYTHING else into finishReason `'unknown'`, discarding the raw value (dist mapAnthropicStopReason).
 * That is how a Fable 5 first-build turn died with `finish=unknown` on 3–4-token steps after its media
 * tool results (2026-08-06) and the step log could not say why: the raw reason — `pause_turn`?
 * `refusal`? — never survived the adapter. This tap tees the response body, scans it for
 * `stop_reason` (and `stop_details`, which a refusal carries), and keeps the strings in a small
 * module buffer that the proxy drains into the generation record after each turn.
 *
 * Client-importable by construction (no node imports — this module sits in the provider layer the
 * client bundle can reach); the fetch it wraps only ever executes server-side. Entries are process-
 * global, not request-scoped: on a multi-user deployment concurrent generations would interleave,
 * which is acceptable for a diagnostic ORDER-ONLY signal and is capped at {@link MAX_ENTRIES}.
 * The scan side of the tee never throws into the request — a diagnostic must not break the money path.
 */

export interface TappedStop {
  stopReason: string;

  /** The raw `stop_details` object text when present beside the reason (refusals carry a category). */
  detail?: string;
}

const MAX_ENTRIES = 50;
const buffer: TappedStop[] = [];

/**
 * Pure extractor: every `"stop_reason":"…"` whose match ENDS beyond `minEndIndex`.
 *
 * The tap re-scans a trailing overlap window so a reason split across two network chunks is still
 * seen; `minEndIndex` (the overlap length) is what stops a match that fully sat inside the previous
 * window from being counted twice — an already-counted match ends inside the overlap, a straddling
 * or new match ends beyond it. `"stop_reason":null` (message_start) never matches — the value must
 * be a quoted word.
 */
export function extractStopReasons(text: string, minEndIndex = 0): TappedStop[] {
  const out: TappedStop[] = [];

  for (const m of text.matchAll(/"stop_reason"\s*:\s*"([a-z_]+)"/g)) {
    if ((m.index ?? 0) + m[0].length <= minEndIndex) {
      continue;
    }

    const entry: TappedStop = { stopReason: m[1] };
    const detail = text.match(/"stop_details"\s*:\s*(\{[^{}]*\})/);

    if (detail) {
      entry.detail = detail[1];
    }

    out.push(entry);
  }

  return out;
}

/** Drain (and clear) everything tapped since the last drain — the proxy calls this per generation. */
export function drainStopReasons(): TappedStop[] {
  return buffer.splice(0, buffer.length);
}

/**
 * Non-destructive read, for the error path: the `!producedText` guard needs to know whether a
 * refusal ended this generation, but the drain must stay in the `finally` so the generation record
 * still captures every entry. Same process-global caveat as the buffer itself.
 */
export function peekStopReasons(): TappedStop[] {
  return [...buffer];
}

/** How much trailing text to re-scan so a chunk-boundary split cannot hide a reason. */
const OVERLAP_CHARS = 200;

/**
 * Wrap a fetch so every SSE/JSON response body is scanned for raw stop reasons as it streams.
 * The passthrough side is byte-identical; the scan runs on the other half of a `tee()`.
 */
export function tapStopReasons(baseFetch: typeof fetch = fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await baseFetch(input, init);
    const contentType = response.headers.get('content-type') ?? '';

    if (!response.body || !(contentType.includes('event-stream') || contentType.includes('json'))) {
      return response;
    }

    const [scanSide, passSide] = response.body.tee();

    void (async () => {
      const reader = scanSide.getReader();
      const decoder = new TextDecoder();
      let tail = '';

      try {
        for (;;) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          const text = tail + decoder.decode(value, { stream: true });

          for (const entry of extractStopReasons(text, tail.length)) {
            buffer.push(entry);

            if (buffer.length > MAX_ENTRIES) {
              buffer.shift();
            }
          }

          tail = text.slice(-OVERLAP_CHARS);
        }
      } catch {
        // Diagnostic only — never let the scan side surface an error.
      }
    })();

    return new Response(passSide, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof fetch;
}
