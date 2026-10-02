/**
 * Reconnect and Stop for a managed turn (`_specs/managed-agents-engine_plan.md` D6, T6).
 *
 * A closed tab DETACHES a managed turn — it keeps its session, which idles at `requires_action` waiting
 * on tool results only the browser can produce. Two calls let a browser deal with that:
 *
 *   - `getManagedTurnStatus` — is the chat's session still mid-turn (running, or waiting on a tool
 *     result nobody has answered)? A reopened chat that is told `pending: true` re-attaches by posting
 *     a resume turn (`managedResume`), which replays the turn and answers the outstanding calls.
 *   - `interruptManagedTurn` — the explicit Stop. A request abort cannot carry it (a closed tab and a
 *     Stop look identical from the server, `api.agent.ts`), so the Stop button calls this separately.
 *
 * Both take a project the caller ALREADY proved they own (the route's two walls) and a chat id, and a
 * chat of another project answers exactly like a chat that does not exist: 404, "Chat not found."
 */
import type Anthropic from '@anthropic-ai/sdk';
import { isServerChatId } from '~/lib/persistence/chat-id';
import { getChatIndex } from '~/lib/.server/projects/chat-index';
import { NotFoundError } from '~/lib/.server/projects/ownership';
import { type AgentEngine, getManagedClient, resolveAgentEngine } from './config';
import type { SessionEventLike } from './events';
import { awaitingToolResults, listCurrentTurnEvents } from './turn';

const CHAT_NOT_FOUND = 'Chat not found.';

/** The chat's session id, `null` for a chat with none; throws 404 for another project's chat. */
async function sessionFor(projectId: string, chatId: unknown, context: unknown): Promise<string | null> {
  if (typeof chatId !== 'string' || !isServerChatId(chatId)) {
    throw new NotFoundError(CHAT_NOT_FOUND);
  }

  const row = await getChatIndex(context).get(chatId);

  if (row && row.projectId !== projectId) {
    throw new NotFoundError(CHAT_NOT_FOUND);
  }

  return row?.managedSessionId ?? null;
}

export interface ManagedTurnStatus {
  engine: AgentEngine;

  /** The chat's turn is still under way on Anthropic's side and a browser should re-attach. */
  pending: boolean;

  /**
   * What the user asked for in that turn — so a reopened tab whose saved transcript ends BEFORE the
   * turn (the client saves at the end of a turn) can show the message it is resuming, instead of
   * dropping its previous answer to make room. Absent when nothing is pending.
   */
  userText?: string;
}

/** The project manifest a new session's first message carries (`message.ts`) — not the user's words. */
const MANIFEST = /^\[Project files[\s\S]*?\[End of project files\]\n*/;

export const RESUME_USER_TEXT_MAX = 4000;

/** The user's words in the current turn's `user.message`, manifest removed. Pure. */
export function currentTurnUserText(events: SessionEventLike[]): string | undefined {
  const message = events.find((e) => e.type === 'user.message');
  const content = Array.isArray(message?.content) ? (message!.content as Array<{ type?: string; text?: string }>) : [];
  const text = content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .replace(MANIFEST, '')
    .trim();

  return text ? text.slice(0, RESUME_USER_TEXT_MAX) : undefined;
}

/** Pure: is a session in this state still owed a browser? */
export function isPendingTurn(status: string | undefined, currentTurnEvents: SessionEventLike[]): boolean {
  if (status === 'running' || status === 'rescheduling') {
    return true;
  }

  return status === 'idle' && awaitingToolResults(currentTurnEvents);
}

export async function getManagedTurnStatus(input: {
  projectId: string;
  chatId: unknown;
  context?: unknown;
  client?: Anthropic;
}): Promise<ManagedTurnStatus> {
  const engine = resolveAgentEngine(input.context);
  const sessionId = await sessionFor(input.projectId, input.chatId, input.context);

  if (engine !== 'managed' || !sessionId) {
    return { engine, pending: false };
  }

  const client = input.client ?? getManagedClient(input.context);
  const session = await client.beta.sessions.retrieve(sessionId);

  if (session.status !== 'idle' && !isPendingTurn(session.status, [])) {
    return { engine, pending: false };
  }

  const events = await listCurrentTurnEvents(client, sessionId);
  const pending = isPendingTurn(session.status, events);

  return pending ? { engine, pending, userText: currentTurnUserText(events) } : { engine, pending };
}

/** Send `user.interrupt` to the chat's session. `false` when the chat has no session to interrupt. */
export async function interruptManagedTurn(input: {
  projectId: string;
  chatId: unknown;
  context?: unknown;
  client?: Anthropic;
}): Promise<{ interrupted: boolean }> {
  const sessionId = await sessionFor(input.projectId, input.chatId, input.context);

  if (!sessionId) {
    return { interrupted: false };
  }

  const client = input.client ?? getManagedClient(input.context);
  await client.beta.sessions.events.send(sessionId, { events: [{ type: 'user.interrupt' }] });

  return { interrupted: true };
}
