/**
 * One Managed Agents session per chat (`_specs/managed-agents-engine_plan.md` D5, T4).
 *
 * A session holds the whole conversation on Anthropic's side, so it must be findable from the CHAT on
 * any device: the id lives on the chat's index row (`chats.managed_session_id`, migration 0026), is
 * created on the chat's first managed turn, and is reused by every turn after — including a turn sent
 * from a second browser that has never seen it.
 *
 * ## Ownership
 *
 * The route proves the caller owns the PROJECT (`requireOwnedProject`, 404-not-403). The chat id is the
 * one thing the caller names on top of that, so every function here checks the chat's row belongs to
 * that project and answers a chat of another project exactly like a chat that does not exist: 404,
 * "Chat not found." — never a different sentence, which would confirm the id is real. Migration 0026's
 * trigger closes the remaining door (a row re-homed into the caller's project loses its session).
 *
 * ## Races
 *
 * Two first turns of one chat can race (two tabs, a double send). Each creates a session; the index's
 * compare-and-set records the FIRST and every later claimant reads it back. The loser's freshly created
 * session is DISCARDED: it has received no events and is never used again, and the optional `discard`
 * hook lets the caller archive it. Both requests then continue the same — the stored — session.
 */
import { isServerChatId } from '~/lib/persistence/chat-id';
import { NotFoundError } from '~/lib/.server/projects/ownership';
import { getChatIndex } from '~/lib/.server/projects/chat-index';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('managed-sessions');

/** A request this module cannot serve — a 400 at the route, with the sentence. */
export class ManagedSessionError extends Error {
  readonly statusCode = 400;
  readonly isRetryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'ManagedSessionError';
  }
}

const CHAT_NOT_FOUND = 'Chat not found.';

function requireChatId(chatId: string | undefined): string {
  if (!chatId) {
    throw new ManagedSessionError(
      'This turn names no chat, and the managed agent engine keeps each conversation in a session per chat. ' +
        'Reload the page and send the message again.',
    );
  }

  /*
   * A chat id we could never have minted is answered like a chat that does not exist: the caller is
   * inventing a key, and a distinct message would only teach them the format.
   */
  if (!isServerChatId(chatId)) {
    throw new NotFoundError(CHAT_NOT_FOUND);
  }

  return chatId;
}

export interface GetOrCreateManagedSessionInput {
  /** The verified user (for the log line only — ownership is proven on the project by the route). */
  userId: string;

  /** A project the caller has ALREADY proven they own (`requireOwnedProject`). */
  projectId: string;

  /** The server chat id from the request body. */
  chatId: string | undefined;

  context?: unknown;

  /** Creates a new Managed Agents session and returns its id. Injected — this module never calls Anthropic. */
  create: () => Promise<string>;

  /** Called with a session created here that lost the race and will never be used. Best-effort. */
  discard?: (sessionId: string) => Promise<void>;
}

export interface ManagedSessionRef {
  sessionId: string;

  /** `true` only for the request whose session was recorded. */
  created: boolean;
}

/**
 * The chat's session, creating it on the chat's first managed turn.
 *
 * Throws `ManagedSessionError` (400) for a turn with no chat id and `NotFoundError` (404) for a chat of
 * another project. Never returns another project's session.
 */
export async function getOrCreateManagedSession(input: GetOrCreateManagedSessionInput): Promise<ManagedSessionRef> {
  const chatId = requireChatId(input.chatId);
  const index = getChatIndex(input.context);

  const existing = await index.get(chatId);

  if (existing && existing.projectId !== input.projectId) {
    throw new NotFoundError(CHAT_NOT_FOUND);
  }

  if (existing?.managedSessionId) {
    return { sessionId: existing.managedSessionId, created: false };
  }

  const sessionId = await input.create();
  const row = await index.claimManagedSession({
    id: chatId,
    projectId: input.projectId,
    sessionId,
    now: new Date().toISOString(),
  });

  /*
   * The chat moved to another project between the read and the claim (or the row vanished). The
   * session we created is not this caller's to keep, and nothing of the other project is revealed.
   */
  if (!row || row.projectId !== input.projectId || !row.managedSessionId) {
    await discardQuietly(input, sessionId);
    throw new NotFoundError(CHAT_NOT_FOUND);
  }

  if (row.managedSessionId !== sessionId) {
    logger.info(
      `Chat ${chatId} (user ${input.userId}): a concurrent first turn recorded session ${row.managedSessionId} first; ` +
        `discarding ${sessionId}.`,
    );
    await discardQuietly(input, sessionId);

    return { sessionId: row.managedSessionId, created: false };
  }

  return { sessionId, created: true };
}

async function discardQuietly(input: GetOrCreateManagedSessionInput, sessionId: string): Promise<void> {
  if (!input.discard) {
    return;
  }

  try {
    await input.discard(sessionId);
  } catch (error) {
    // An unused session idles at no cost; failing the turn over its cleanup would be the wrong trade.
    logger.warn(`Could not discard unused managed session ${sessionId}: ${(error as Error)?.message}`);
  }
}

/** The chat's session id, or `null` when it has none (or is not this project's chat). Never creates. */
export async function getManagedSessionId(
  projectId: string,
  chatId: string | undefined,
  context?: unknown,
): Promise<string | null> {
  if (!chatId || !isServerChatId(chatId)) {
    return null;
  }

  const row = await getChatIndex(context).get(chatId);

  return row && row.projectId === projectId ? (row.managedSessionId ?? null) : null;
}

/** T7's settlement cursor for the chat, or `null` when nothing has been settled yet. */
export async function getManagedSettledAt(
  projectId: string,
  chatId: string | undefined,
  context?: unknown,
): Promise<string | null> {
  if (!chatId || !isServerChatId(chatId)) {
    return null;
  }

  const row = await getChatIndex(context).get(chatId);

  return row && row.projectId === projectId ? (row.managedSettledAt ?? null) : null;
}

/**
 * Advance T7's settlement cursor. Throws `NotFoundError` when the chat is not this project's — a cursor
 * written to the wrong row would make another chat skip usage it never billed.
 */
export async function setManagedSettledAt(
  projectId: string,
  chatId: string | undefined,
  settledAt: string,
  context?: unknown,
): Promise<void> {
  const id = requireChatId(chatId);
  const written = await getChatIndex(context).setManagedSettledAt({ id, projectId, settledAt });

  if (!written) {
    throw new NotFoundError(CHAT_NOT_FOUND);
  }
}

/**
 * Release the chat's DEAD session so the next claim creates a fresh one (rebind). Compare-and-clear on
 * `sessionId`: a racing request that already rebound the chat keeps its new session. Clears the
 * settlement cursor with it — the cursor belongs to the old session's events. Returns whether this call
 * released it.
 */
export async function releaseManagedSession(
  projectId: string,
  chatId: string | undefined,
  sessionId: string,
  context?: unknown,
): Promise<boolean> {
  const id = requireChatId(chatId);

  return getChatIndex(context).releaseManagedSession({ id, projectId, sessionId });
}
