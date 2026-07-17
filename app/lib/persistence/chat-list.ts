/**
 * What the sidebar shows (SPEC §4.5.6, §4.5.4b) — the server's chats, merged with this browser's.
 *
 * ## Why a merge at all
 *
 * The sidebar used to be `getAll(indexedDb)`: a view of the BROWSER, not of the account. A chat started
 * on a laptop did not exist on a desktop, and clearing site data destroyed the list — while the
 * transcripts sat on the server the whole time with nothing listing them. The server is now the truth
 * about which conversations exist, and the browser is a local staging area.
 *
 * But the browser is not *only* a cache, which is why this is a merge and not a replacement:
 *
 *   - **A local record supplies the local id.** Export and Duplicate look a chat up in IndexedDB by id;
 *     the server does not know that id and must not, since it is a per-browser counter (§4.5.6).
 *   - **A chat with no server id is still real.** It is a conversation in this browser that has not been
 *     saved yet — no project, or nothing said. Dropping it because the server has not heard of it would
 *     delete the user's current chat out from under them.
 *
 * ## The invisible-chat trap, which is why nothing here filters
 *
 * The sidebar's old filter was `item.urlId && item.description`, and both came only from the model's
 * first artifact — so a conversation the model never wrote a file in (a question answered in prose, a
 * failed generation, a Stop) was INVISIBLE. It rendered nothing and reported nothing; the chat was in
 * the database and simply never listed. That was reported as "no chats at all show in the left sidebar".
 *
 * So this function never drops an entry for missing metadata. Every chat gets a `urlId` and a title, by
 * falling back until it has one. A chat that exists is a chat that lists.
 */
import type { ChatHistoryItem } from './useChatHistory';

/** A chat as `GET /api/chats` returns it. */
export interface ServerChat {
  serverChatId: string;
  projectId: string;
  projectName?: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/** A sidebar row: an ordinary history item, plus which game it belongs to. */
export interface SidebarChat extends ChatHistoryItem {
  projectName?: string;

  /** False when this browser has no record of the chat — Export and Duplicate need one. */
  local: boolean;
}

/**
 * The list to render.
 *
 * Server chats first-class, local-only chats kept, ordered by most recent activity.
 *
 * 🔴 A local chat whose `serverChatId` is NOT in the server list is dropped — it was deleted from
 * another device, and "the server is the truth" is exactly what makes a delete stick everywhere. That
 * is safe ONLY because the caller falls back to the local list wholesale when the fetch fails: a
 * network error must never look like "everything was deleted".
 */
export function mergeChatList(server: ServerChat[], local: ChatHistoryItem[]): SidebarChat[] {
  const localByServerId = new Map(
    local.filter((chat) => chat.metadata?.serverChatId).map((chat) => [chat.metadata!.serverChatId!, chat]),
  );

  const fromServer: SidebarChat[] = server.map((chat) => {
    const mirror = localByServerId.get(chat.serverChatId);

    return {
      /*
       * The LOCAL id when this browser has one, so Export/Duplicate keep working. Otherwise the server
       * id, which is at least stable and addressable — the chat opens through the project mount, which
       * fetches the transcript and creates the local record.
       */
      id: mirror?.id ?? chat.serverChatId,

      /*
       * 🔴 The SERVER id, never the title slug — the sidebar links here, and this link has to work on a
       * device that has never seen the chat.
       *
       * `/chat/start-dev-server` is upstream's design: a slug of the chat's title, de-duplicated by
       * walking THIS browser's IndexedDB and appending `-2`. That is coherent for one user on one
       * machine and incoherent the moment the list is the account's rather than the browser's — the
       * slug is not unique across users, the de-duplication cannot see the other ones, and the title
       * ends up in the URL bar and every proxy log on the way. See `mintUrlId`.
       */
      urlId: chat.serverChatId,
      description: chat.title ?? mirror?.description ?? 'Untitled chat',

      /*
       * The list never renders message bodies; loading every transcript to draw a sidebar is the whole
       * thing the server-side index exists to avoid.
       */
      messages: [],

      timestamp: chat.updatedAt,
      metadata: { ...mirror?.metadata, projectId: chat.projectId, serverChatId: chat.serverChatId },
      projectName: chat.projectName,
      local: Boolean(mirror),
    };
  });

  /*
   * Chats this browser has that the server does not: only the ones that were never saved. A local chat
   * that HAS a server id but is missing from the list was deleted elsewhere, and must stay gone.
   */
  const serverIds = new Set(server.map((chat) => chat.serverChatId));
  const localOnly: SidebarChat[] = local
    .filter((chat) => !chat.metadata?.serverChatId)
    .map((chat) => ({
      ...chat,
      urlId: chat.urlId ?? chat.id,
      description: chat.description ?? 'Untitled chat',
      messages: [],
      local: true,
    }));

  const stale = local.filter(
    (chat) => chat.metadata?.serverChatId && !serverIds.has(chat.metadata.serverChatId),
  ).length;

  if (stale > 0) {
    // Not an error — this is a delete from another device arriving. Worth seeing when one goes missing.
    console.debug(`[chat-list] ${stale} local chat(s) no longer on the server — deleted elsewhere.`);
  }

  return [...fromServer, ...localOnly].sort(byNewestFirst);
}

/**
 * The list to render when the server could not be reached.
 *
 * 🔴 This exists because `mergeChatList(server, local)` is NOT the right fallback with an empty
 * `server`. That call drops every local chat that HAS a `serverChatId` — which is correct when the
 * server has genuinely spoken and not mentioned them (a delete from another device), and catastrophic
 * when it simply did not answer: the sidebar would empty itself on a flaky connection and look exactly
 * like every conversation having been deleted.
 *
 * "The server said none" and "the server said nothing" are different answers. Keeping them in separate
 * functions is what stops a future reader from collapsing them — the same distinction `mount-source.ts`
 * draws between `remoteHead: null` (branch empty) and `undefined` (could not ask).
 */
export function localChatList(local: ChatHistoryItem[]): SidebarChat[] {
  return local
    .map((chat) => ({
      ...chat,
      urlId: chat.urlId ?? chat.id,
      description: chat.description ?? 'Untitled chat',
      messages: [],
      local: true,
    }))
    .sort(byNewestFirst);
}

/**
 * Newest first, with the id as a tiebreak.
 *
 * The tiebreak is not decoration: two chats saved in the same millisecond tie on `timestamp`, and an
 * unstable comparator reorders the sidebar between renders for no reason the user can see. The same
 * class of bug as ordering the ledger by `created_at` (migration 0003) and local checkpoints by
 * `createdAt` — cosmetic here rather than destructive, but the lesson is already paid for.
 */
function byNewestFirst(a: SidebarChat, b: SidebarChat): number {
  return b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id);
}
