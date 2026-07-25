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

export interface AgentStatusSnapshot {
  generationId: string;
  seq: number;
  phase: AgentStatusPhase;

  /** Elapsed since the generation started, per the SERVER's clock at the moment it wrote the part. */
  elapsedMs: number;

  /** Client wall time when the part was first ingested — the anchor for live elapsed display. */
  receivedAt: number;
}

/**
 * A status older than this is not "the current state of the stream" any more. Heartbeats arrive
 * every `HEARTBEAT_INTERVAL_MS` (3s) while silent; 8s of no heartbeat means content is flowing (or
 * the generation ended) and the panel must yield to the real output.
 */
export const STATUS_STALE_MS = 8000;

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
    elapsedMs?: unknown;
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
    elapsedMs: status.elapsedMs,
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
 * The user-facing copy. Honest by design: it never pretends to BE the reasoning (when a provider
 * streams real thinking text, the ThinkingPanel shows it and this panel never appears), and it
 * answers the exact question dead dots cannot — "is it doing something, or is it frozen?".
 */
export function describeAgentStatus(status: AgentStatusSnapshot, now = Date.now()): { label: string; detail: string } {
  const elapsed = formatElapsed(currentElapsedMs(status, now));

  if (status.phase === 'thinking') {
    return {
      label: `Thinking — ${elapsed}`,
      detail: 'The model is reasoning through your request.',
    };
  }

  return {
    label: `Still working — ${elapsed}`,
    detail: 'The model is reasoning through your request.',
  };
}
