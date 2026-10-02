/**
 * The browser's half of reconnect and Stop for the managed agent engine
 * (`_specs/managed-agents-engine_plan.md` D6, T6).
 *
 * On the managed engine a closed tab does NOT end a build: the turn keeps its Managed Agents session,
 * which waits on tool results only a browser can produce. So:
 *
 *   - **Stop** must say so explicitly (`requestManagedInterrupt`) — aborting the request only detaches.
 *     Fire-and-forget with `keepalive`, error swallowed: the Stop button must never wait on, or fail
 *     because of, this call.
 *   - **A reopened chat** asks whether its turn is still pending (`isManagedTurnPending`) and, if so,
 *     re-attaches with a resume turn (`managedResume: true`), which replays the turn and answers the
 *     outstanding tool calls.
 *   - **A turn must name its chat.** The session is keyed by the server chat id, and a brand-new chat
 *     can send its first turn before that id is minted (it is minted at first save). On the managed
 *     engine the id is minted at send time instead (`withManagedChatId`).
 *
 * Every function here is a no-op on the legacy engine.
 */
import type { TurnIdentity } from './turn-identity';

export type AgentEngineHint = 'managed' | 'legacy';

/** The Stop button's interrupt. Never throws, never awaited by the caller. */
export function requestManagedInterrupt(
  engine: AgentEngineHint,
  identity: TurnIdentity,
  fetchImpl: typeof fetch = fetch,
): boolean {
  if (engine !== 'managed' || !identity.projectId || !identity.chatId) {
    return false;
  }

  try {
    void fetchImpl('/api/agent/managed/interrupt', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: identity.projectId, chatId: identity.chatId }),
    }).catch(() => undefined);
  } catch {
    // Stop must always work; the interrupt is best effort.
  }

  return true;
}

/** Is this chat's managed turn still under way on the server — and what did the user ask in it? */
export async function managedTurnStatus(
  engine: AgentEngineHint,
  identity: TurnIdentity,
  fetchImpl: typeof fetch = fetch,
): Promise<{ pending: boolean; userText?: string }> {
  if (engine !== 'managed' || !identity.projectId || !identity.chatId) {
    return { pending: false };
  }

  try {
    const query = new URLSearchParams({ projectId: identity.projectId, chatId: identity.chatId });
    const response = await fetchImpl(`/api/agent/managed/status?${query}`);

    if (!response.ok) {
      return { pending: false };
    }

    const status = (await response.json()) as { engine?: string; pending?: boolean; userText?: unknown };

    if (status.engine !== 'managed' || status.pending !== true) {
      return { pending: false };
    }

    return typeof status.userText === 'string' ? { pending: true, userText: status.userText } : { pending: true };
  } catch {
    return { pending: false };
  }
}

/** The text a resume shows as its user message when the saved transcript does not already end with one. */
export const RESUME_PLACEHOLDER = 'Continue the build that was in progress.';

/**
 * How a reopened tab re-attaches. `reload` re-posts the LAST message — right when the saved transcript
 * already ends with the turn's user message. When it ends with an ASSISTANT message (the previous turn's
 * answer — the client saves at the end of a turn, so a turn interrupted mid-way left no record), reload
 * would DROP that answer to make room; append the resumed turn's user message instead.
 */
export function resumeAction(
  lastRole: string | undefined,
  userText: string | undefined,
): { kind: 'reload' } | { kind: 'append'; content: string } {
  return lastRole === 'user' ? { kind: 'reload' } : { kind: 'append', content: userText || RESUME_PLACEHOLDER };
}

/**
 * The turn's identity, with a server chat id minted when the managed engine needs one and the chat has
 * none yet. `mint` must also RECORD the id where the chat's later save will find it (`chatMetadata`), or
 * the transcript and the session would be filed under two different chats.
 */
export function withManagedChatId(engine: AgentEngineHint, identity: TurnIdentity, mint: () => string): TurnIdentity {
  if (engine !== 'managed' || !identity.projectId || identity.chatId) {
    return identity;
  }

  return { ...identity, chatId: mint() };
}

/** How long a reopened tab waits for its preview before re-attaching anyway. */
export const RESUME_PREVIEW_WAIT_MS = 90_000;

/**
 * Resolve once `ready()` holds (re-checked on every `listen` notification), or after `timeoutMs` —
 * never rejects. A reopened tab re-attaches only once its sandbox's preview is up: the resumed turn's
 * outstanding call is often `check_game`, and run against a preview still booting it fails for a reason
 * that has nothing to do with the game (seen live: "the preview was restarting").
 */
export function whenReady(
  ready: () => boolean,
  listen: (onChange: () => void) => () => void,
  timeoutMs: number = RESUME_PREVIEW_WAIT_MS,
): Promise<boolean> {
  if (ready()) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    let unlisten: () => void = () => undefined;
    const timer = setTimeout(() => {
      unlisten();
      resolve(false);
    }, timeoutMs);

    unlisten = listen(() => {
      if (ready()) {
        clearTimeout(timer);
        unlisten();
        resolve(true);
      }
    });
  });
}
