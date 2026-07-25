/**
 * Generation liveness heartbeat (SPEC §4.2a).
 *
 * ## Why this exists
 *
 * A thinking model's stream can be legitimately SILENT for minutes: the provider buffers the whole
 * reasoning window and sends nothing until the first content block. Measured live against KIE
 * (2026-07-24): `message_start` at ~2s, then no events except a single ping until the (empty)
 * thinking block and the first text arrive together at the END of the think. On a creation-sized
 * think that silence is minutes long, and the only thing the user saw was a generic dots spinner —
 * indistinguishable from frozen, hung, or silently failed, while their credits were genuinely
 * being spent on reasoning.
 *
 * The fix is a LIVENESS signal, not a fake thinking channel: while the model stream is quiet, the
 * proxy (which holds the open SSE response the whole time) emits a small `agent-status` data part
 * on its own timer. Its continued arrival proves the server↔model↔browser pipe is alive end to
 * end; if it stops, something actually died and the existing fail→refund machinery applies.
 *
 * ## What this deliberately is NOT
 *
 * - NOT model output. It rides the DATA channel (like `media-task`), never `text` (artifact parser)
 *   or `reasoning` (`g:`). When a provider streams real thinking text, that flows down the existing
 *   reasoning pipe untouched — real reasoning resets the quiet clock, so heartbeats go silent on
 *   their own the moment there is something better to show. No code change is needed here when KIE
 *   fixes their adapter (see `kie-wire.ts` — their adapter currently returns EMPTY thinking text
 *   for every model while still billing the thinking tokens).
 * - NOT context. Data parts never reach the model, so this costs zero tokens and cannot touch the
 *   §4.2.8 cache budget.
 * - NOT allowed to break a generation. Every write is wrapped; a throwing writer is dropped, never
 *   propagated (same rule as monitoring: a status channel must not take down the money path).
 *
 * ## The streaming contract (same family as `shell-strip`/`protocol-strip`)
 *
 * The wrapper WITHHOLDS NOTHING: every source chunk is yielded through byte-identical, immediately.
 * The heartbeat is purely additive, on a timer that runs beside the drain loop.
 */

import type { AgentChunk } from './proxy';

/** How often the quiet-check timer fires while a generation is in flight. */
export const HEARTBEAT_INTERVAL_MS = 3000;

/**
 * How long the stream must have been silent before a tick emits a status. Below this, content is
 * flowing (or just flowed) and the client has something real to render — a heartbeat would only
 * flicker a "still working" panel over live output.
 */
export const HEARTBEAT_QUIET_MS = 2500;

export type AgentStatusPhase = 'thinking' | 'generating';

/**
 * The wire shape of one heartbeat. `seq` exists for the CLIENT's replay problem: the `useChat`
 * data array is re-scanned from the top on every stream chunk, so without a monotonic key the
 * client would re-ingest old heartbeats each pass and a stale status would look forever fresh.
 * The client keeps only `(generationId, seq)` it has not seen yet.
 */
export interface AgentStatusPart {
  type: 'agent-status';
  generationId: string;
  seq: number;
  phase: AgentStatusPhase;

  /** Wall time since the generation's stream began, per the SERVER's clock — never a client guess. */
  elapsedMs: number;

  /** How long the stream had been silent when this heartbeat fired. */
  silentMs: number;

  [key: string]: string | number;
}

export interface HeartbeatController {
  /**
   * Record real stream activity. ONLY call for chunks with actual content — an empty delta (KIE's
   * empty thinking blocks) must not reset the quiet clock, or a stream of nothing would suppress
   * the very signal that exists to cover it.
   */
  activity(kind: AgentChunk['type']): void;

  stop(): void;
}

export interface HeartbeatOptions {
  intervalMs?: number;
  quietMs?: number;
}

export function createHeartbeat(
  generationId: string,
  write: (status: AgentStatusPart) => void,
  options: HeartbeatOptions = {},
): HeartbeatController {
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const quietMs = options.quietMs ?? HEARTBEAT_QUIET_MS;

  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  let sawText = false;
  let seq = 0;
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped) {
      return;
    }

    const now = Date.now();
    const silentMs = now - lastActivityAt;

    if (silentMs < quietMs) {
      return;
    }

    try {
      write({
        type: 'agent-status',
        generationId,
        seq: ++seq,

        /*
         * `thinking` until the first real text chunk: before that, the silence IS the think (or the
         * provider connection settling). After text has streamed once, a quiet spell reads as the
         * model pausing mid-answer — different message, same liveness guarantee.
         */
        phase: sawText ? 'generating' : 'thinking',
        elapsedMs: now - startedAt,
        silentMs,
      });
    } catch {
      // A status channel must never break the generation it narrates.
    }
  }, intervalMs);

  return {
    activity(kind) {
      lastActivityAt = Date.now();

      if (kind === 'text') {
        sawText = true;
      }
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * Drain `source` with a live heartbeat: chunks pass through untouched and immediately; while the
 * source is quiet, `write` receives `agent-status` parts on a timer. The route's whole wiring lives
 * here so it is covered by `heartbeat.spec.ts` — the repeated lesson (§4.14 relay, §4.5.6) is that
 * defects live in the wiring the unit tests drove around.
 */
export async function* withGenerationHeartbeat(
  source: AsyncIterable<AgentChunk>,
  generationId: string,
  write: (status: AgentStatusPart) => void,
  options: HeartbeatOptions = {},
): AsyncGenerator<AgentChunk> {
  const heartbeat = createHeartbeat(generationId, write, options);

  try {
    for await (const chunk of source) {
      if (chunk.value.length > 0) {
        heartbeat.activity(chunk.type);
      }

      yield chunk;
    }
  } finally {
    heartbeat.stop();
  }
}
