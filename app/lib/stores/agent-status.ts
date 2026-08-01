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

  /**
   * How long the model stream had been SILENT when the server wrote this part.
   *
   * 🔴 The direct answer to "is this stuck?", and it was already on the wire and thrown away. Measured
   * 2026-08-01 with a client-side chunk trace: our own heartbeat arrived on the dot every 3000ms while
   * real model text landed in three bursts (14.2s, 22.0s, 27.5s) — so the pipeline was demonstrably
   * healthy and the gaps were the PROVIDER buffering. The panel could not say so, because this number
   * stopped at the store boundary. Absent from an older server, in which case no stall line is shown —
   * never a fabricated one.
   */
  silentMs?: number;

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
    silentMs?: unknown;
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

    // Only carried when the server actually sent a number; absent means "we do not know", not "zero".
    ...(typeof status.silentMs === 'number' ? { silentMs: status.silentMs } : {}),

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

/**
 * Live silence: the server's measurement plus the time since we received it.
 *
 * Extrapolated exactly like {@link currentElapsedMs}, and for the same reason — heartbeats arrive
 * every ~3s and the panel ticks every 1s, so a frozen number would read as a stalled UI during the
 * very stall it is reporting. `undefined` when the server did not send one: a missing measurement
 * must stay missing rather than become a confident `0`.
 */
export function currentSilentMs(status: AgentStatusSnapshot, now = Date.now()): number | undefined {
  return status.silentMs === undefined ? undefined : status.silentMs + Math.max(0, now - status.receivedAt);
}

/**
 * Below this, silence is not worth mentioning.
 *
 * A heartbeat only fires after {@link STATUS_STALE_MS}-scale quiet already, so *some* silence is the
 * normal state whenever this panel is visible — reporting it at 3s would put an alarming sentence on
 * every ordinary turn and teach the user to ignore the one that matters. This is the point where a
 * person starts wondering whether it has died.
 */
export const SILENCE_WORTH_MENTIONING_MS = 15_000;

/**
 * How far the silence must fall SHORT of the whole turn before it is worth reporting separately.
 *
 * When nothing has arrived at all, silence and elapsed are the same number, and printing both puts
 * the identical figure on two lines — which reads as a rendering bug and wastes the line. The gap
 * only has to be big enough to mean "something did arrive, and then it stopped".
 */
export const SILENCE_RESTATES_ELAPSED_MS = 2_000;

/**
 * What the CLIENT can see of the artifact, which the server cannot.
 *
 * The server knows the turn's KIND before a token is spent; only the browser knows how many file
 * actions have actually opened and completed, because it is the thing parsing them out of the
 * stream. Splitting it this way keeps both halves reporting only what they observe.
 */
export interface ArtifactProgress {
  /** File/edit actions seen to COMPLETE this turn. */
  written: number;

  /** File/edit actions currently running. */
  writing: number;
}

/**
 * Count file progress from an artifact runner's actions.
 *
 * Pure and here rather than in the component, so it is testable without importing `workbenchStore` —
 * which boots a sandbox, an editor store and a watcher as an import side effect (`execution-queue.ts`
 * records the same constraint). The caller subscribes; this counts.
 *
 * 🔴 `start` and `shell` actions are excluded deliberately. A dev server is `running` FOREVER, so
 * counting it parks a permanent "1 in progress" under every panel — the same trap `settleableStatuses`
 * records for the game-ready celebration, where a long-lived `start` meant the celebration could never
 * fire.
 */
export function countArtifactProgress(actions: Array<{ type?: string; status?: string }>): ArtifactProgress {
  let written = 0;
  let writing = 0;

  for (const action of actions) {
    if (action.type !== 'file' && action.type !== 'edit') {
      continue;
    }

    if (action.status === 'complete') {
      written += 1;
    } else if (action.status === 'running') {
      writing += 1;
    }
  }

  return { written, writing };
}

/**
 * "3 files written · 1 in progress".
 *
 * 🔴 Deliberately reports NO TOTAL. Rows only exist once their opening tag has arrived, so the
 * denominator is unknowable mid-stream — "3 of 5" would invent a target and then be wrong the moment
 * a sixth file appeared, which is worse than saying less. Counts up, never claims a finish line.
 */
export function formatArtifactProgress(progress: ArtifactProgress): string | undefined {
  const parts: string[] = [];

  if (progress.written > 0) {
    parts.push(`${progress.written} file${progress.written === 1 ? '' : 's'} written`);
  }

  if (progress.writing > 0) {
    parts.push(`${progress.writing} in progress`);
  }

  return parts.length > 0 ? parts.join(' · ') : undefined;
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
export function describeAgentStatus(
  status: AgentStatusSnapshot,
  now = Date.now(),
  progress?: ArtifactProgress,
): { label: string; detail: string; progress?: string } {
  const elapsed = formatElapsed(currentElapsedMs(status, now));
  const copy = COPY[status.kind];

  /*
   * The concrete line: what has actually landed, and whether anything is arriving.
   *
   * 🔴 Both clauses are OBSERVATIONS, never inferences. The counts are rows the client parsed; the
   * silence is the server's own measurement of its model connection. Neither says what the model is
   * "doing" — that is the standing rule of this file, and the reason the panel is trustworthy enough
   * to be worth reading during a five-minute wait.
   */
  const silent = currentSilentMs(status, now);
  const elapsedMs = currentElapsedMs(status, now);

  /*
   * ⚠️ Suppressed when the silence covers essentially the WHOLE turn, because then it is not news —
   * it is the label again. Observed live on the first drive: *"Working on your changes — 15s"* above
   * *"nothing from the model for 15s"*, the same number twice, which reads as a UI bug and spends the
   * one line that is supposed to carry new information. A stall is only worth naming once something
   * HAS arrived and then stopped.
   */
  const stalled =
    silent !== undefined && silent >= SILENCE_WORTH_MENTIONING_MS && silent < elapsedMs - SILENCE_RESTATES_ELAPSED_MS;

  /*
   * 🔴 No file count during `thinking`. That phase means NO TEXT has streamed this turn, so this turn
   * has provably written nothing — while the artifact the caller counted is still the PREVIOUS turn's,
   * all of whose actions are `complete`. Counting it would report "8 files written" about a turn that
   * has not written one, which is worse than the silence it replaces.
   *
   * ⚠️ Narrow residual: a turn that streams prose before opening its artifact is briefly `generating`
   * with the old artifact still current. Bounded by the few hundred ms before the `<boltArtifact>` tag,
   * and self-correcting the instant it opens.
   */
  const counted = status.phase === 'generating' && progress ? formatArtifactProgress(progress) : undefined;

  const clauses = [counted, stalled ? `nothing from the model for ${formatElapsed(silent)}` : undefined].filter(
    Boolean,
  );

  const progressLine = clauses.length > 0 ? clauses.join(' · ') : undefined;

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

      /*
       * A retry deliberately keeps the FILE COUNT and drops the silence clause: "nothing from the
       * model for 30s" is the very thing being reported one line above, and saying it twice reads as
       * two problems. What survives is what the user still wants to know — whether the work already
       * done is still there.
       */
      ...(counted ? { progress: counted } : {}),
    };
  }

  return {
    label: `${copy.label} — ${elapsed}`,
    detail: status.phase === 'thinking' ? copy.thinking : copy.generating,
    ...(progressLine ? { progress: progressLine } : {}),
  };
}
