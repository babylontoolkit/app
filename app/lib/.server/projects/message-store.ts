/**
 * Where a project's conversations live (SPEC §4.5, §4.5.5, §4.5.6, §4.5.4b).
 *
 * A chat is an OBJECT, not a relation: it is written whole on every turn, read whole on resume, never
 * queried by row, and can be megabytes. It is also the one part of a project the platform still holds
 * under repo-primary persistence — the user's CODE goes to their repo, the conversation about it stays
 * with us so a project can be resumed on another device (§4.5.4b).
 *
 * ## A project has MANY chats (§4.5.6)
 *
 * It used to have exactly one, at `messages/{projectId}.json`. That was upstream's model showing
 * through — in bolt.diy the chat WAS the project, so 1:1 was a tautology rather than a decision. Game
 * projects run long and phase-shaped (spec → plan → execute), and the conversation is uncached and
 * re-sent every turn (`spec/context-budget.md`), so "new chat, same game" is the difference between
 * paying for a spec discussion during every execute turn and not.
 *
 * ## Two things here are load-bearing, and both fail silently
 *
 * **The chat id must not be the browser's chat id.** See `IChatMetadata.serverChatId` — the local id is
 * a per-browser counter, so `messages/{projectId}/1.json` means two devices collide on one object.
 * This module never mints an id and never accepts one it did not get from the caller's metadata; the
 * validation below is what stops a counter (or a `../`) from becoming a key.
 *
 * **Deleting a project deletes a PREFIX, not a key.** `deleteMessages` used to delete one object
 * because there only was one. With many chats, deleting the key that no longer exists would leave every
 * real transcript behind — the exact orphan shape §4.5.4b keeps turning up, where bytes outlive the
 * record that named them. It sweeps the prefix, and it sweeps the legacy key too.
 */
import { getObjectStore } from '~/lib/.server/storage';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('message-store');

/**
 * A stored conversation.
 *
 * The title rides WITH the messages rather than in a separate index: an index is a second copy of the
 * truth, and the moment it can disagree with the objects it names, it will. Listing costs one `get`
 * per chat, which is fine for a bounded list and honest about where the data is.
 */
export interface StoredChat {
  serverChatId: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messages: unknown[];
}

/** What a chat looks like WITHOUT its body — enough to render a picker, cheap enough to list. */
export type ChatSummary = Omit<StoredChat, 'messages'> & { messageCount: number };

/**
 * A guard rail on count, not a policy on behaviour.
 *
 * Chats are cheap but not free, and this is an authenticated HTTP endpoint rather than our React code.
 * A client looping "new chat" cannot grow a project's storage without bound.
 */
export const MAX_CHATS_PER_PROJECT = 100;

/**
 * The pre-§4.5.6 key: one transcript per project.
 *
 * Still read (see `adoptLegacyChat`) because real users have real conversations here. Never written.
 */
export function legacyMessagesKey(projectId: string): string {
  return `messages/${projectId}.json`;
}

/** Everything belonging to one project's conversations. The unit the reaper works in. */
export function messagesPrefix(projectId: string): string {
  return `messages/${projectId}/`;
}

/**
 * One conversation.
 *
 * 🔴 `serverChatId` reaches this from a request body, so it is a value the caller CHOOSES. Unvalidated,
 * `../../seeds/{someone}` is a path traversal out of the project's own prefix — the same wall
 * `share/serve.ts` needed for build paths (§5). A UUID is the only thing we ever mint, so a UUID is the
 * only thing we accept: anything else is a caller inventing a key.
 */
export function messagesKey(projectId: string, serverChatId: string): string {
  if (!isValidChatId(serverChatId)) {
    throw new Error(`Invalid chat id: ${serverChatId}`);
  }

  return `${messagesPrefix(projectId)}${serverChatId}.json`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this an id we could have minted?
 *
 * Deliberately strict. It rejects `..`, slashes, and the empty string by rejecting everything that is
 * not a UUID — a whitelist, so a new way to write a nasty string is refused by default rather than
 * needing a new rule. It also rejects `"1"`, which is the interesting case: that is what a browser's
 * local chat id looks like, and accepting it is how the cross-device collision gets in.
 */
export function isValidChatId(serverChatId: string): boolean {
  return UUID_RE.test(serverChatId);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Save a conversation.
 *
 * Continuing the legacy chat MIGRATES it: the transcript is written to its own object and the old
 * single-transcript key is dropped. That has to happen here rather than being left to a read-side
 * adoption, because otherwise the same conversation exists at two keys and `listChats` shows the user
 * their history twice. The write comes first — a failed delete leaves a duplicate (which `listChats`
 * resolves in favour of the real object), while a failed write after a delete would lose the chat.
 */
export async function putChat(projectId: string, chat: StoredChat, context?: unknown): Promise<void> {
  const store = getObjectStore(context);
  const bytes = encoder.encode(JSON.stringify(chat));

  await store.put(messagesKey(projectId, chat.serverChatId), bytes, 'application/json');

  if (chat.serverChatId === legacyChatId(projectId)) {
    await store.delete(legacyMessagesKey(projectId));
  }
}

export async function getChat(projectId: string, serverChatId: string, context?: unknown): Promise<StoredChat | null> {
  const bytes = await getObjectStore(context).get(messagesKey(projectId, serverChatId));

  if (!bytes) {
    return null;
  }

  return parseChat(bytes, serverChatId);
}

/**
 * A corrupt object is a miss, not a throw.
 *
 * The caller is asking "what was said"; the honest answer for unreadable bytes is "nothing I can show
 * you", not a 500 that also costs them the project mount. Loud in the log, cosmetic to the user.
 */
function parseChat(bytes: Uint8Array, serverChatId: string): StoredChat | null {
  try {
    const parsed = JSON.parse(decoder.decode(bytes)) as Partial<StoredChat>;

    if (!Array.isArray(parsed.messages)) {
      return null;
    }

    return {
      serverChatId,
      title: parsed.title,
      createdAt: parsed.createdAt ?? new Date(0).toISOString(),
      updatedAt: parsed.updatedAt ?? parsed.createdAt ?? new Date(0).toISOString(),
      messages: parsed.messages,
    };
  } catch (error) {
    logger.error(`Unreadable chat ${serverChatId}: ${(error as Error).message}`);
    return null;
  }
}

/**
 * The project's chats, newest activity first.
 *
 * Includes the legacy single-transcript object as a chat if one is there (§4.5.6) — a user who has been
 * building since before this existed must not open their project to an empty history. It is adopted on
 * READ rather than rewritten on a migration: a migration over every project's objects is a batch job
 * that can half-finish, and there is no deadline forcing one.
 */
export async function listChats(projectId: string, context?: unknown): Promise<ChatSummary[]> {
  const store = getObjectStore(context);
  const objects = await store.list(messagesPrefix(projectId));

  const chats = await Promise.all(
    objects
      .filter((object) => object.key.endsWith('.json'))
      .map(async (object) => {
        const serverChatId = object.key.slice(messagesPrefix(projectId).length, -'.json'.length);

        if (!isValidChatId(serverChatId)) {
          logger.warn(`Ignoring object with a non-chat key: ${object.key}`);
          return null;
        }

        const bytes = await store.get(object.key);

        return bytes ? parseChat(bytes, serverChatId) : null;
      }),
  );

  const found = chats.filter((chat): chat is StoredChat => chat !== null);

  /*
   * The real object wins.
   *
   * `putChat` migrates a continued legacy chat and then deletes the old key; if that delete failed, the
   * same conversation is readable at BOTH keys and the user would see their history listed twice. This
   * makes the duplicate unobservable rather than trusting the delete to have worked.
   */
  const alreadyMigrated = found.some((chat) => chat.serverChatId === legacyChatId(projectId));
  const legacy = alreadyMigrated ? null : await adoptLegacyChat(projectId, context);

  if (legacy) {
    found.push(legacy);
  }

  return found
    .map(({ messages, ...summary }) => ({ ...summary, messageCount: messages.length }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/**
 * A stable, synthetic id for the pre-§4.5.6 transcript, so the client can address it like any other
 * chat instead of needing a special case for "the old one".
 *
 * Derived from the project id (stable across reads) and shaped so it can never collide with a chat we
 * mint: `crypto.randomUUID` is v4, which always has `4` at position 13 and one of `89ab` at 17; this
 * has `0` in both. It IS accepted by `messagesKey` — deliberately. Continuing the legacy chat writes it
 * to its own object under this id and drops the old key (see `putChat`), so the migration is a
 * consequence of using it rather than a batch job someone has to remember to run.
 */
export function legacyChatId(projectId: string): string {
  const hash = [...projectId].reduce((acc, ch) => (acc * 33 + ch.charCodeAt(0)) >>> 0, 5381);
  return `${hash.toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`;
}

async function adoptLegacyChat(projectId: string, context?: unknown): Promise<StoredChat | null> {
  const bytes = await getObjectStore(context).get(legacyMessagesKey(projectId));

  if (!bytes) {
    return null;
  }

  const chat = parseChat(bytes, legacyChatId(projectId));

  return chat ? { ...chat, title: chat.title ?? 'Earlier conversation' } : null;
}

/**
 * Read a chat by id, wherever it actually lives.
 *
 * The real object always wins over the legacy key — a legacy chat that has been continued exists at
 * both until the migrating delete lands, and the object is the newer of the two.
 */
export async function getChatOrLegacy(
  projectId: string,
  serverChatId: string,
  context?: unknown,
): Promise<StoredChat | null> {
  const chat = await getChat(projectId, serverChatId, context);

  if (chat) {
    return chat;
  }

  return serverChatId === legacyChatId(projectId) ? adoptLegacyChat(projectId, context) : null;
}

/**
 * How many conversations a project has (§4.5.6) — WITHOUT reading any of them.
 *
 * `listChats` costs one `get` per chat because it needs titles. The dashboard only needs a number, and
 * doing it the expensive way would mean fetching every conversation on the platform to render a card.
 * This is one prefix listing per project.
 *
 * It exists because a project with no chats looked like an orphan: the owner deleted a project's only
 * conversation, the project correctly stayed (deleting a chat must never destroy an UNLINKED game —
 * the browser is its only copy, §4.5.4b), and the dashboard gave no way to see that "no chats" was a
 * real, deliberate state rather than something broken.
 */
export async function countChats(projectId: string, context?: unknown): Promise<number> {
  const store = getObjectStore(context);
  const objects = await store.list(messagesPrefix(projectId));

  const own = objects.filter((object) => {
    const id = object.key.slice(messagesPrefix(projectId).length, -'.json'.length);
    return object.key.endsWith('.json') && isValidChatId(id);
  });

  /*
   * The legacy transcript counts as one, and only if it has not already been migrated to its own
   * object — otherwise a continued legacy chat is counted twice (`listChats` resolves the same
   * duplicate, for the same reason).
   */
  const migrated = own.some((object) => object.key.endsWith(`${legacyChatId(projectId)}.json`));
  const legacy = migrated ? null : await store.get(legacyMessagesKey(projectId));

  return own.length + (legacy ? 1 : 0);
}

/**
 * Forget ONE conversation. The project and its other chats are untouched.
 *
 * Unconditional and idempotent: deleting an object that is not there is a no-op, so the caller never
 * has to ask "is there a chat?" first — a question whose wrong answer leaves the bytes behind.
 */
export async function deleteChat(projectId: string, serverChatId: string, context?: unknown): Promise<void> {
  const store = getObjectStore(context);

  await store.delete(messagesKey(projectId, serverChatId));

  /*
   * Both homes, unconditionally. A legacy chat that was continued exists at two keys until the
   * migrating delete lands; deleting only one of them means the conversation the user just deleted
   * comes back on the next list.
   */
  if (serverChatId === legacyChatId(projectId)) {
    await store.delete(legacyMessagesKey(projectId));
  }
}

/**
 * Forget EVERY conversation in a project — the project-delete reaper (§4.5.4b).
 *
 * 🔴 A prefix sweep, not a key delete. This function used to delete `messages/{projectId}.json` because
 * that was the only object there could be; left alone through §4.5.6 it would have deleted a key that
 * no longer exists and reported success, stranding every real transcript with nothing left that could
 * name them — unreachable, un-deletable, and still ours after the user pressed Delete. The legacy key
 * is swept too, for the projects that predate the change.
 */
export async function deleteMessages(projectId: string, context?: unknown): Promise<void> {
  const store = getObjectStore(context);
  const objects = await store.list(messagesPrefix(projectId));

  await Promise.all(objects.map((object) => store.delete(object.key)));
  await store.delete(legacyMessagesKey(projectId));
}
