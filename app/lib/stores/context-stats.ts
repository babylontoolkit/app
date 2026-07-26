/**
 * Context stats for the current conversation (SPEC §4.5.6) — the data behind the `/context` command
 * and the chat panel's health dot.
 *
 * Populated from the per-generation annotations the server already streams back (`api.agent.ts`):
 * `usage` (real token counts) and `agentMeta.history` (the re-sent conversation as it actually went on
 * the wire, POST-compaction). The client never estimates history size from its own messages — it holds
 * the un-compacted copy, which is exactly the number that does not matter.
 *
 * Why the health rule reads the way it does: the conversation history is the one UNCACHED input
 * component, re-sent at full rate on every turn forever (`spec/context-budget.md`), and the server
 * window (`HISTORY_WINDOW_TURNS`) bounds it by silently FORGETTING the oldest turns. So "red" is not
 * "about to break" — nothing breaks — it is "you are now paying to re-send a conversation that is
 * being truncated anyway", which is precisely when `/clear` costs nothing you still had.
 */
import { atom } from 'nanostores';

export interface ContextStats {
  /** Messages re-sent this turn, post-compaction (user + assistant). */
  historyMessages: number;

  /** Chars of that re-sent history — ~4 chars/token for prose. */
  historyChars: number;

  /** The server's history window (`HISTORY_WINDOW_TURNS`); at this count the oldest turns drop. */
  maxTurns: number;

  /** Attachments still riding in the re-sent history. Zero on the overwhelming majority of chats. */
  attachments: number;

  /**
   * Estimated tokens those attachments cost EVERY TURN (`llm/history.ts` — an upper bound per image).
   * They carry no characters, so before this existed the dot reported them as free while the user
   * paid for them on every subsequent turn.
   */
  attachmentTokens: number;

  /** Uncached input tokens last turn (history + the volatile tail). Billed at full rate. */
  promptTokens: number;

  /** Cached prefix read last turn (system blocks + files). Billed at 0.1x — big is fine. */
  cacheReadTokens: number;

  /** Cache writes last turn (billed 2x). A large number on an ordinary edit means prefix churn. */
  cacheCreationTokens: number;

  /** Output tokens last turn. */
  completionTokens: number;

  /** What the last turn actually cost, settled (§4.6). */
  creditsCharged: number;

  model: string;
}

export type ContextHealth = 'green' | 'amber' | 'red';

/**
 * Amber when the conversation has grown enough that clearing at the next natural boundary is worth
 * it; red when the server window is (or is about to start) silently dropping the oldest turns.
 * Fractions of `maxTurns` rather than absolute counts so an operator tuning `HISTORY_WINDOW_TURNS`
 * moves the dot with it.
 */
export const AMBER_TURNS_FRACTION = 0.5;
export const RED_TURNS_FRACTION = 0.9;

/** Char-based backstop, mirroring `MAX_HISTORY_CHARS`' role server-side: big turns redden early. */
export const AMBER_HISTORY_CHARS = 24_000;
export const RED_HISTORY_CHARS = 48_000;

/** The §4.2.8 prose rule of thumb, used to weigh attachment tokens against the char thresholds. */
export const CHARS_PER_TOKEN = 4;

/**
 * The history's real weight: text characters PLUS the attachments riding along with them.
 *
 * An image contributes no characters and is re-sent, uncached, on every turn after the one it was
 * attached to — so a chars-only measure called it free and the dot stayed green while the bill grew.
 * Attachment tokens are converted to char-equivalents rather than the thresholds being restated in
 * tokens, so `AMBER_/RED_HISTORY_CHARS` keep their one meaning and their one calibration.
 */
export function historyWeight(stats: Pick<ContextStats, 'historyChars' | 'attachmentTokens'>): number {
  return stats.historyChars + (stats.attachmentTokens ?? 0) * CHARS_PER_TOKEN;
}

export function contextHealth(
  stats: Pick<ContextStats, 'historyMessages' | 'historyChars' | 'maxTurns'> & { attachmentTokens?: number },
): ContextHealth {
  const turnsFraction = stats.maxTurns > 0 ? stats.historyMessages / stats.maxTurns : 0;
  const weight = historyWeight({ historyChars: stats.historyChars, attachmentTokens: stats.attachmentTokens ?? 0 });

  if (turnsFraction >= RED_TURNS_FRACTION || weight >= RED_HISTORY_CHARS) {
    return 'red';
  }

  if (turnsFraction >= AMBER_TURNS_FRACTION || weight >= AMBER_HISTORY_CHARS) {
    return 'amber';
  }

  return 'green';
}

/** No stats until the first generation of the session reports back. The dot renders nothing. */
export const contextStatsStore = atom<ContextStats | null>(null);

/** `/context` opens the report panel; the dot toggles it too. */
export const contextPanelOpen = atom<boolean>(false);

/**
 * Read the two annotations off a finished assistant message and update the store. Tolerant of
 * missing pieces (an older saved message, a failed generation): whatever is absent keeps its
 * previous value where that is sane, or zeroes.
 */
export function updateContextStats(annotations: unknown[] | undefined): void {
  if (!annotations) {
    return;
  }

  const find = (type: string) =>
    annotations.find(
      (a): a is { type: string; value: Record<string, unknown> } =>
        typeof a === 'object' && a !== null && (a as { type?: string }).type === type,
    )?.value;

  const usage = find('usage');
  const meta = find('agentMeta');
  const credits = find('credits');
  const history = meta?.history as
    | { messages?: number; chars?: number; maxTurns?: number; attachments?: number; attachmentTokens?: number }
    | undefined;

  if (!usage && !history) {
    return;
  }

  const prev = contextStatsStore.get();

  contextStatsStore.set({
    historyMessages: history?.messages ?? prev?.historyMessages ?? 0,
    historyChars: history?.chars ?? prev?.historyChars ?? 0,
    maxTurns: history?.maxTurns ?? prev?.maxTurns ?? 0,
    attachments: history?.attachments ?? prev?.attachments ?? 0,
    attachmentTokens: history?.attachmentTokens ?? prev?.attachmentTokens ?? 0,
    promptTokens: (usage?.promptTokens as number) ?? 0,
    cacheReadTokens: (usage?.cacheReadTokens as number) ?? 0,
    cacheCreationTokens: (usage?.cacheCreationTokens as number) ?? 0,
    completionTokens: (usage?.completionTokens as number) ?? 0,
    creditsCharged: (credits?.creditsCharged as number) ?? 0,
    model: (meta?.model as string) ?? prev?.model ?? '',
  });
}

/** A new conversation starts with no context — reset on chat switch or `/clear`. */
export function resetContextStats(): void {
  contextStatsStore.set(null);
  contextPanelOpen.set(false);
}
