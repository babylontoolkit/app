/**
 * Bill the step in flight (`_specs/no-unbilled-usage_plan.md` D7, G7).
 *
 * The AI SDK reports a step's usage only when the step FINISHES (`onStepFinish` / `result.steps`). A step
 * that breaks after the provider started it — a Stop, a dropped stream, a gateway that kills a silent think,
 * a provider retry — is reported nowhere, and yet the provider billed us for it: the whole prompt (input and
 * cache tokens) is charged the moment `message_start` is sent, and every output token generated before the
 * break is charged too. Measured 2026-10-02: a legacy turn disconnected during its first step settled ZERO
 * tokens after 61 text chunks had already streamed.
 *
 * So the Anthropic-shaped wire is tapped PER REQUEST (one request = one step attempt): `message_start`
 * carries the input + cache tokens and the message id, `message_delta` the cumulative output tokens,
 * `message_stop` marks the step complete. At settlement every attempt whose message id the SDK never
 * reported is added to the bill (`unreportedWireUsage`) — keyed by the message id the SDK also reads, so a
 * step the SDK DID report is never counted twice.
 *
 * REQUEST-SCOPED by construction, unlike `stop-reason-tap.ts`'s process-global buffer: the recorder is
 * created per generation and handed to the provider's fetch chain through `getModelInstance`, so two
 * concurrent generations can never bill each other's attempts — a property money needs and a diagnostic
 * does not.
 *
 * Client-importable (no node imports — it sits in the provider layer the client bundle can reach); the
 * fetch it wraps only ever runs server-side. The scan side of the tee never throws into the request.
 */

/** One HTTP request to the model — one step attempt — as the wire reported it. */
export interface WireAttempt {
  /** Every message id seen on this response (a server-side fallback may send a second `message_start`). */
  messageIds: string[];

  /** `message_start` arrived — the provider accepted the request and billed its input. */
  started: boolean;

  /** `message_stop` arrived — the step finished on the wire (the SDK reports it if nothing else broke). */
  complete: boolean;

  /** Anthropic's own counts (uncached input; cache classes are siblings, not a breakdown). */
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;

  /** Characters of streamed content (text, thinking, tool input) — the output floor of a broken step. */
  streamedChars: number;
}

export interface WireUsageRecorder {
  readonly attempts: readonly WireAttempt[];

  /** Start recording one request. */
  begin(): WireAttempt;

  /** Track a scan in progress, so `settled` can wait for it, and how to stop it (`close`). */
  track(scan: Promise<void>, cancel?: () => void): void;

  /**
   * Resolve once every scan started so far has finished, or after `timeoutMs` — settlement must never hang
   * on a response body that is still flowing. What has been read by then is what is billed.
   */
  settled(timeoutMs?: number): Promise<void>;

  /**
   * Stop every scan still reading — after settlement. A tee keeps its source flowing while either branch
   * reads, so a scan left running after the SDK stopped reading would keep the provider generating (and
   * billing) for nobody.
   */
  close(): void;
}

/** How long settlement waits for the scan sides to catch up with a stream that already ended. */
export const WIRE_SETTLE_TIMEOUT_MS = 1500;

export function createWireUsageRecorder(): WireUsageRecorder {
  const attempts: WireAttempt[] = [];
  const scans = new Set<Promise<void>>();
  const cancels = new Map<Promise<void>, () => void>();

  return {
    attempts,
    begin() {
      const attempt: WireAttempt = {
        messageIds: [],
        started: false,
        complete: false,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreation: 0,
        streamedChars: 0,
      };

      attempts.push(attempt);

      return attempt;
    },
    track(scan, cancel) {
      scans.add(scan);

      if (cancel) {
        cancels.set(scan, cancel);
      }

      void scan.finally(() => {
        scans.delete(scan);
        cancels.delete(scan);
      });
    },
    close() {
      for (const cancel of cancels.values()) {
        try {
          cancel();
        } catch {
          /* Already finished. */
        }
      }

      cancels.clear();
    },
    async settled(timeoutMs = WIRE_SETTLE_TIMEOUT_MS) {
      if (scans.size === 0) {
        return;
      }

      let timer: ReturnType<typeof setTimeout> | undefined;

      await Promise.race([
        Promise.allSettled([...scans]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, timeoutMs));
        }),
      ]);

      if (timer) {
        clearTimeout(timer);
      }
    },
  };
}

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

interface UsageLike {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
}

/** Fold one usage object into the attempt — max per field: Anthropic's usage counts are cumulative. */
function foldUsage(attempt: WireAttempt, usage: UsageLike | undefined | null) {
  if (!usage || typeof usage !== 'object') {
    return;
  }

  attempt.input = Math.max(attempt.input, count(usage.input_tokens));
  attempt.output = Math.max(attempt.output, count(usage.output_tokens));
  attempt.cacheRead = Math.max(attempt.cacheRead, count(usage.cache_read_input_tokens));
  attempt.cacheCreation = Math.max(attempt.cacheCreation, count(usage.cache_creation_input_tokens));
}

/** Apply one parsed Anthropic stream event (or a whole non-streamed message) to the attempt. Pure. */
export function applyWireEvent(attempt: WireAttempt, event: unknown): void {
  const e = event as {
    type?: string;
    message?: { id?: unknown; usage?: UsageLike };
    usage?: UsageLike;
    delta?: { text?: unknown; thinking?: unknown; partial_json?: unknown };
    id?: unknown;
  } | null;

  if (!e || typeof e !== 'object') {
    return;
  }

  switch (e.type) {
    case 'message_start': {
      attempt.started = true;

      if (typeof e.message?.id === 'string' && e.message.id && !attempt.messageIds.includes(e.message.id)) {
        attempt.messageIds.push(e.message.id);
      }

      foldUsage(attempt, e.message?.usage);

      return;
    }
    case 'message_delta': {
      foldUsage(attempt, e.usage);
      return;
    }
    case 'message_stop': {
      attempt.complete = true;
      return;
    }
    case 'content_block_delta': {
      const delta = e.delta ?? {};

      for (const piece of [delta.text, delta.thinking, delta.partial_json]) {
        if (typeof piece === 'string') {
          attempt.streamedChars += piece.length;
        }
      }

      return;
    }
    case 'message': {
      /* A non-streamed response: one JSON message, complete by definition. */
      attempt.started = true;
      attempt.complete = true;

      if (typeof e.id === 'string' && e.id && !attempt.messageIds.includes(e.id)) {
        attempt.messageIds.push(e.id);
      }

      foldUsage(attempt, e.usage);

      return;
    }
    default:
      return;
  }
}

/** Parse SSE `data:` lines out of a growing text buffer; returns the unconsumed tail. Pure. */
export function consumeSseLines(buffer: string, onEvent: (event: unknown) => void): string {
  let start = 0;

  for (;;) {
    const newline = buffer.indexOf('\n', start);

    if (newline < 0) {
      break;
    }

    const line = buffer.slice(start, newline).replace(/\r$/, '');

    start = newline + 1;

    if (!line.startsWith('data:')) {
      continue;
    }

    try {
      onEvent(JSON.parse(line.slice(5).trim()));
    } catch {
      /* A line that is not JSON (`[DONE]`, a keep-alive) carries no usage. */
    }
  }

  return buffer.slice(start);
}

/**
 * Wrap a fetch so every successful Anthropic-shaped response is recorded as one attempt. With no recorder
 * it returns `baseFetch` itself, so a caller that passes none keeps the exact chain it had.
 */
export function tapWireUsage(recorder: WireUsageRecorder | undefined, baseFetch: typeof fetch = fetch): typeof fetch {
  if (!recorder) {
    return baseFetch;
  }

  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await baseFetch(input, init);
    const contentType = response.headers.get('content-type') ?? '';
    const streamed = contentType.includes('event-stream');

    /* A refusal (4xx/5xx) is not billed by the provider; only an accepted request is. */
    if (!response.ok || !response.body || !(streamed || contentType.includes('json'))) {
      return response;
    }

    const attempt = recorder.begin();
    const [scanSide, passSide] = response.body.tee();
    const reader = scanSide.getReader();

    recorder.track(
      (async () => {
        const decoder = new TextDecoder();
        let buffer = '';

        try {
          for (;;) {
            const { done, value } = await reader.read();

            if (done) {
              break;
            }

            buffer += decoder.decode(value, { stream: true });

            if (streamed) {
              buffer = consumeSseLines(buffer, (event) => applyWireEvent(attempt, event));
            }
          }

          if (streamed) {
            consumeSseLines(`${buffer}\n`, (event) => applyWireEvent(attempt, event));
          } else {
            try {
              applyWireEvent(attempt, JSON.parse(buffer));
            } catch {
              /* Not a message body — nothing billable recorded. */
            }
          }
        } catch {
          /* The stream broke (an abort, a reset): what was read is what is recorded. Never surfaces. */
        }
      })(),
      () => void reader.cancel().catch(() => undefined),
    );

    return new Response(passSide, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof fetch;
}

/** The token usage of the attempts the SDK never reported — what D7 adds to a generation's bill. */
export interface UnreportedWireUsage {
  attempts: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * A broken step's output floor from its streamed characters. DECISION (D7): 4 characters per token — an
 * UNDER-estimate for the code and JSON this platform streams (~2 ch/tok measured), so the floor can only
 * under-bill, never over-bill, output the wire did not count.
 */
export const STREAMED_CHARS_PER_TOKEN = 4;

/**
 * Sum the attempts the SDK did not report. `reportedIds` are the `response.id`s of the steps the generation
 * already billed. An attempt is reported when any of its message ids is among them; an attempt with NO id
 * that completed is matched against reported steps whose ids never appeared on the wire (count only).
 * Attempts that never started (no `message_start`) cost nothing. Pure.
 */
export function unreportedWireUsage(
  attempts: readonly WireAttempt[],
  reportedIds: Iterable<string>,
): UnreportedWireUsage {
  const reported = new Set(reportedIds);
  const seenOnWire = new Set<string>();

  for (const attempt of attempts) {
    attempt.messageIds.forEach((id) => seenOnWire.add(id));
  }

  let anonymousReported = [...reported].filter((id) => !seenOnWire.has(id)).length;
  const out: UnreportedWireUsage = {
    attempts: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  for (const attempt of attempts) {
    if (!attempt.started) {
      continue;
    }

    if (attempt.messageIds.some((id) => reported.has(id))) {
      continue;
    }

    if (attempt.messageIds.length === 0 && attempt.complete && anonymousReported > 0) {
      anonymousReported -= 1;
      continue;
    }

    out.attempts += 1;
    out.promptTokens += attempt.input;
    out.cacheReadTokens += attempt.cacheRead;
    out.cacheCreationTokens += attempt.cacheCreation;
    out.completionTokens += attempt.complete
      ? attempt.output
      : Math.max(attempt.output, Math.ceil(attempt.streamedChars / STREAMED_CHARS_PER_TOKEN));
  }

  return out;
}

/** The usage fields a generation bills — structurally the server's `GenerationUsage`. */
export interface BilledUsageLike {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Add the unreported attempts to a generation's totals (in place). `totalTokens` stays prompt + completion. */
export function addUnreportedUsage(totals: BilledUsageLike, extra: UnreportedWireUsage): void {
  totals.promptTokens += extra.promptTokens;
  totals.completionTokens += extra.completionTokens;
  totals.cacheReadTokens += extra.cacheReadTokens;
  totals.cacheCreationTokens += extra.cacheCreationTokens;
  totals.totalTokens += extra.promptTokens + extra.completionTokens;
}
