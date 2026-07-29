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
 * WHAT this turn is — so the panel can say something instead of "Thinking".
 *
 * Reported live (2026-07-27): *"That 2-3min of empty is a killer… thinking about what???"* The panel
 * answered "is it alive" (its job) and nothing else, and on a creation — the longest wait in the
 * product, minutes on a hard brief — an anonymous "Thinking" is the least informative thing we could
 * put in front of someone watching their first project get built.
 *
 * 🔴 **These are FACTS THE PROXY ALREADY HOLDS, never a guess about what the model is doing.** The turn
 * kind is decided before a token is spent (`isCreationTurn`, `isRepair`, the discuss note) — exactly the
 * signals `effort-policy.ts` uses, and for the same reason: the alternative is inferring activity from
 * the stream and narrating a story we cannot see. This says "we asked it to build your project", which
 * is true for the whole turn; it never says "it is writing Home.tsx now", which we do not know.
 */
export type AgentStatusKind = 'creation' | 'repair' | 'plan' | 'edit';

/**
 * WHAT IS HAPPENING TO THE REQUEST, as opposed to what the turn is FOR (`kind`) or where the stream
 * is (`phase`). Orthogonal to both on purpose — a retry is a fact about the provider connection that
 * can occur during a `thinking` phase of a `creation` turn.
 *
 * 🔴 **`retrying` exists because the panel was lying by omission.** Measured live 2026-07-28 on a real
 * creation: step 1 ran **239 seconds to emit 553 characters** (0.30 chars/output-token — thinking and
 * tool JSON, no artifact), `finishReason: stop+provider-retry`, and the whole 387s turn billed 54
 * credits. The user watching it reported: *"a lot of spinning, thinking, burning credits for nothing…
 * like we are just gouging the user"*. Both halves of that were understandable and one was wrong — the
 * retries bill ZERO (`shouldRetryGeneration` gates on `outTokens === 0`, so a billed step is never
 * re-run) — but the panel said "Thinking" for four minutes, so the only story available to the user was
 * that they were paying for it.
 *
 * A stalled provider being retried is not thinking, and calling it thinking converts our own resilience
 * into apparent gouging. Naming it turns the same four minutes into visible recovery.
 */
export type AgentStatusActivity = 'retrying';

/**
 * The retry fact, as the proxy holds it.
 *
 * `since` is what makes this SELF-CLEARING and is the reason this is a pull-getter rather than a
 * callback: the heartbeat already tracks when content last arrived, so it reports `retrying` only while
 * the retry began at-or-after the last real activity. The instant the new attempt streams anything, the
 * flag stops applying on its own — no clearing call to forget, and no way for a stale "retrying" to
 * squat on a later genuine think (which would be the same class of lie in the opposite direction).
 */
export interface AgentActivitySnapshot {
  activity: AgentStatusActivity;

  /** 1-based attempt now being made. */
  attempt: number;

  maxAttempts: number;

  /** `Date.now()` when this retry was decided. */
  since: number;
}

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

  /** What the turn IS (creation/repair/plan/edit) — a fact the proxy already holds, never a guess. */
  kind: AgentStatusKind;

  /** Wall time since the generation's stream began, per the SERVER's clock — never a client guess. */
  elapsedMs: number;

  /** How long the stream had been silent when this heartbeat fired. */
  silentMs: number;

  /**
   * Present ONLY while it is true. Absent is the normal case and means "nothing to add beyond
   * phase/kind" — an older or unaware client that ignores this field still renders exactly the panel
   * it rendered before, which is why this was added as a new optional field rather than by widening
   * `phase` (the client REJECTS an unknown `phase` outright, so widening it would blank the panel
   * during precisely the stall it exists to cover).
   */
  activity?: AgentStatusActivity;

  attempt?: number;
  maxAttempts?: number;

  [key: string]: string | number | undefined;
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

  /** What the turn is. Defaults to `edit` — the copy that claims the least. */
  kind?: AgentStatusKind;

  /**
   * Pull the current provider-level activity at tick time. Pull, not push, so the heartbeat stays a
   * passive observer of facts the proxy already holds (this module's standing rule) and so there is no
   * "clear it" call anyone can forget.
   */
  activity?: () => AgentActivitySnapshot | null | undefined;
}

export function createHeartbeat(
  generationId: string,
  write: (status: AgentStatusPart) => void,
  options: HeartbeatOptions = {},
): HeartbeatController {
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const quietMs = options.quietMs ?? HEARTBEAT_QUIET_MS;
  const kind = options.kind ?? 'edit';

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
      /*
       * Only report a retry that began at or after the last real content. Once the new attempt streams
       * anything, `lastActivityAt` moves past `since` and this silently stops applying — so a later,
       * genuine long think is never mislabelled as a retry by a flag nobody remembered to clear.
       *
       * Inside the try with the write, not above it: this is a foreign callback, and the module's whole
       * standing rule is that the status channel cannot break the generation it narrates.
       */
      const pending = options.activity?.();
      const retry = pending && pending.since >= lastActivityAt ? pending : null;

      write({
        type: 'agent-status',
        generationId,
        seq: ++seq,
        ...(retry ? { activity: retry.activity, attempt: retry.attempt, maxAttempts: retry.maxAttempts } : {}),

        /*
         * `thinking` until the first real text chunk: before that, the silence IS the think (or the
         * provider connection settling). After text has streamed once, a quiet spell reads as the
         * model pausing mid-answer — different message, same liveness guarantee.
         */
        phase: sawText ? 'generating' : 'thinking',
        kind,
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
