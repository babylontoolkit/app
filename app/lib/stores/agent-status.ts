/**
 * The client half of the generation liveness heartbeat (SPEC §4.2a; server: `agent/heartbeat.ts`).
 *
 * While a generation's stream is silent (a long think, a provider buffering its reasoning window),
 * the server emits `agent-status` data parts on a timer. This store holds the latest one and the
 * pure logic that turns it into what the user sees: a live "Thinking — 1m 12s" panel instead of an
 * anonymous dots spinner that is indistinguishable from a hang.
 *
 * Two rules, both load-bearing:
 *
 * - **`(generationId, seq)` gating.** `useChat`'s data array is re-scanned from the top on every
 *   stream chunk, so the same heartbeat parts are re-presented over and over. Ingesting them again
 *   would refresh `receivedAt` each pass and a stale status would look forever fresh — the panel
 *   would sit on "Thinking — 5s" while the answer streamed underneath it. Only a part newer than
 *   what the store holds is accepted.
 *
 * - **Freshness decides visibility.** Heartbeats are only SENT during silence, so "the last one is
 *   recent" means "we are in a silent stretch right now" — show the panel. Once content flows the
 *   heartbeats stop, the snapshot goes stale, and the caller falls back to the ordinary streaming
 *   indicator. The client never fabricates a status the server did not send.
 */
import { atom } from 'nanostores';

export type AgentStatusPhase = 'thinking' | 'generating';

/** What the turn IS — mirrors `agent/heartbeat.ts`. The server sends a fact; this file owns the words. */
export type AgentStatusKind = 'creation' | 'repair' | 'plan' | 'edit';

/**
 * What is happening to the REQUEST — mirrors `agent/heartbeat.ts`. Orthogonal to kind and phase.
 *
 * Only `retrying` today, and it exists because this panel was the reason a user concluded they were
 * being overcharged: a stalled provider being retried rendered as "Thinking — 4m", so four minutes of
 * unbilled recovery looked like four minutes of billed reasoning.
 */
export type AgentStatusActivity = 'retrying';

export interface AgentStatusSnapshot {
  generationId: string;
  seq: number;
  phase: AgentStatusPhase;
  kind: AgentStatusKind;

  /** Elapsed since the generation started, per the SERVER's clock at the moment it wrote the part. */
  elapsedMs: number;

  /** Absent unless the server is reporting one. Absent is the ordinary case. */
  activity?: AgentStatusActivity;
  attempt?: number;
  maxAttempts?: number;

  /** Client wall time when the part was first ingested — the anchor for live elapsed display. */
  receivedAt: number;
}

/**
 * A status older than this is not "the current state of the stream" any more. Heartbeats arrive
 * every `HEARTBEAT_INTERVAL_MS` (3s) while silent; 8s of no heartbeat means content is flowing (or
 * the generation ended) and the panel must yield to the real output.
 */
export const STATUS_STALE_MS = 8000;

const KINDS: AgentStatusKind[] = ['creation', 'repair', 'plan', 'edit'];

export const agentStatusStore = atom<AgentStatusSnapshot | null>(null);

/**
 * Ingest one data part if it is an `agent-status` newer than what the store holds. Safe to call
 * with every part on every re-scan — anything else is ignored.
 */
export function updateAgentStatus(part: unknown, now = Date.now()): void {
  if (!part || typeof part !== 'object') {
    return;
  }

  const status = part as {
    type?: unknown;
    generationId?: unknown;
    seq?: unknown;
    phase?: unknown;
    kind?: unknown;
    elapsedMs?: unknown;
    activity?: unknown;
    attempt?: unknown;
    maxAttempts?: unknown;
  };

  if (
    status.type !== 'agent-status' ||
    typeof status.generationId !== 'string' ||
    typeof status.seq !== 'number' ||
    typeof status.elapsedMs !== 'number' ||
    (status.phase !== 'thinking' && status.phase !== 'generating')
  ) {
    return;
  }

  const current = agentStatusStore.get();

  // Same generation → only ever move forward. A new generation always wins.
  if (current && current.generationId === status.generationId && status.seq <= current.seq) {
    return;
  }

  agentStatusStore.set({
    generationId: status.generationId,
    seq: status.seq,
    phase: status.phase,

    /*
     * An unknown or missing kind falls back to `edit` — the copy that claims the least. A status part
     * from an older server (or a future kind this client has not learned) must degrade to a vaguer
     * sentence, never to a wrong one: "Working on your changes" is true of every turn.
     */
    kind: KINDS.includes(status.kind as AgentStatusKind) ? (status.kind as AgentStatusKind) : 'edit',
    elapsedMs: status.elapsedMs,

    /*
     * An unrecognised activity is DROPPED, not passed through — the panel then falls back to the
     * phase/kind sentence, which is still true. This is the one axis where being vague is safe and
     * being specific-but-wrong is not: an activity is a claim about why the user is waiting.
     */
    ...(status.activity === 'retrying'
      ? {
          activity: 'retrying' as const,
          ...(typeof status.attempt === 'number' ? { attempt: status.attempt } : {}),
          ...(typeof status.maxAttempts === 'number' ? { maxAttempts: status.maxAttempts } : {}),
        }
      : {}),
    receivedAt: now,
  });
}

export function resetAgentStatus(): void {
  agentStatusStore.set(null);
}

/** Live elapsed time: the server's measurement plus the time since we received it. */
export function currentElapsedMs(status: AgentStatusSnapshot, now = Date.now()): number {
  return status.elapsedMs + Math.max(0, now - status.receivedAt);
}

/** Fresh = a heartbeat arrived recently = the stream is in a silent stretch RIGHT NOW. */
export function isStatusFresh(status: AgentStatusSnapshot, now = Date.now()): boolean {
  return now - status.receivedAt < STATUS_STALE_MS;
}

/** "47s" under a minute, "1m 12s" above — coarse on purpose; this is reassurance, not telemetry. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * The user-facing copy, per turn kind.
 *
 * 🔴 **It describes THE TURN, never the model's inner activity.** Reported live: *"2-3 min of empty is
 * a killer… thinking about what???"* — a fair complaint, because "Thinking" answered only "the pipe is
 * alive" and left the longest wait in the product (a creation, minutes on a hard brief) with no idea
 * what it was waiting FOR. The fix is not to guess harder: the server sends what the turn IS, decided
 * before a token was spent, and these sentences say that. "Building your project" is true for the whole
 * turn; "writing Home.tsx" would be a story we cannot see, and the moment a provider streams real
 * reasoning the ThinkingPanel shows it and this panel never appears at all.
 *
 * `thinking` = nothing has streamed yet (planning). `generating` = text has streamed and then paused
 * mid-answer. Same liveness guarantee, different truth about where the turn is.
 */
const COPY: Record<AgentStatusKind, { label: string; thinking: string; generating: string }> = {
  creation: {
    label: 'Building your project',
    thinking: 'Designing your landing page and planning the game code. The first build takes a few minutes.',
    generating: 'Writing your project files — landing page, chrome and game code.',
  },
  repair: {
    label: 'Fixing a build error',
    thinking: 'Reading the compiler output to work out what broke.',
    generating: 'Patching the code that failed to build.',
  },
  plan: {
    label: 'Planning',
    thinking: 'Working through the approach. Nothing is written to your project on a plan turn.',
    generating: 'Writing up the plan.',
  },
  edit: {
    label: 'Working on your changes',
    thinking: 'Reading your project and working out the change.',
    generating: 'Applying the change to your project.',
  },
};

/**
 * Honest by design: it never pretends to BE the reasoning (when a provider streams real thinking text,
 * the ThinkingPanel shows it and this panel never appears), and it answers the two questions dead dots
 * cannot — "is it doing something, or is it frozen?" and "doing WHAT?".
 */
export function describeAgentStatus(status: AgentStatusSnapshot, now = Date.now()): { label: string; detail: string } {
  const elapsed = formatElapsed(currentElapsedMs(status, now));
  const copy = COPY[status.kind];

  /*
   * A retry OUTRANKS the phase sentence, because it is the more truthful answer to "why am I waiting?".
   * It also says the thing the user cannot otherwise know and wrongly assumes the opposite of: a retried
   * attempt is not charged. Measured 2026-07-28 — a 387s creation with two stalled attempts billed 54
   * credits — and the user's read of that same screen was *"burning credits for nothing"*. The retry is
   * unbilled BY CONSTRUCTION (`shouldRetryGeneration` only retries while `outTokens === 0`), so saying so
   * is a fact, not reassurance.
   */
  if (status.activity === 'retrying') {
    const of = status.attempt && status.maxAttempts ? ` ${status.attempt} of ${status.maxAttempts}` : '';

    return {
      label: `Reconnecting to the model — ${elapsed}`,
      detail: `The provider stopped responding, so we're retrying${of}. You are not charged for a retried attempt — your work is still queued.`,
    };
  }

  return {
    label: `${copy.label} — ${elapsed}`,
    detail: status.phase === 'thinking' ? copy.thinking : copy.generating,
  };
}
