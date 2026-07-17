/**
 * What identity does a chat have after a project mount? (SPEC §4.5.6)
 *
 * ## Why this is a pure function and not four `.set()` calls
 *
 * A chat's identity lives in module-level nanostores (`chatId`, `description`, `urlId`,
 * `chatMetadata.serverChatId`), and every path that mounts a project reaches it through
 * `navigate(...)` — an SPA transition. Nothing unloads, so those atoms arrive holding the PREVIOUS
 * chat's values. Identity is therefore inherited by DEFAULT and reset only by remembering to, which is
 * the wrong way round for the one thing whose collision destroys data:
 *
 *   - `ensureServerChatId` reuses `metadata.serverChatId` if the atom has one, so an inherited id makes
 *     the new chat save over the old chat's server transcript — the only copy we hold (§4.5.4b).
 *   - `storeMessageHistory` mints a local id only `if (!chatId.get())`, so an inherited `chatId` makes
 *     the new chat overwrite the old chat's IndexedDB record too.
 *
 * Both are silent, and the sidebar count never moves — the old conversation is simply replaced by the
 * new one. The visible symptom was cosmetic (the header labelled a brand-new chat "start dev server",
 * the title of the chat it was started from), which is how it survived review.
 *
 * So the decision is written down once, exhaustively, next to the reasons — the same treatment
 * `restore-target.ts` and `auto-repair.ts` get, and for the same reason: it overwrites the user's data
 * without being asked, and it fails silently.
 */
import type { IChatMetadata } from './db';

/** The four values that together say "which conversation is this". */
export interface ChatIdentity {
  /** The IndexedDB record key. Falsy means "mint one on first save". */
  chatId: string | undefined;

  /** The chat's title. Half of what makes a chat visible in the sidebar (the other half is `urlId`). */
  description: string | undefined;

  /** The `/chat/:urlId` slug. */
  urlId: string | undefined;

  /** Carries `projectId` and the server-side `serverChatId` (§4.5.6). */
  metadata: IChatMetadata;
}

export interface MountIdentityInputs {
  /** Whatever the atoms currently hold — i.e. the chat the user is navigating AWAY from. */
  current: ChatIdentity;

  /** The project being mounted. */
  projectId: string;

  /**
   * "New chat, same game" (§4.5.6) — the files mount, the conversation does not come along.
   *
   * `false` is a restore (dashboard Open, device switch): the transcript IS coming back, and
   * `restoreTranscript` sets the identity from the record it fetched. This function must not fight it.
   */
  freshChat: boolean;
}

/**
 * The identity a chat should have immediately after `projectId` is mounted.
 *
 * A fresh chat gets NOTHING but the project — no id, no title, no slug, and above all no
 * `serverChatId`. A restore keeps what it has and only pins the project, because the transcript that is
 * about to load owns the rest.
 */
export function identityForMount({ current, projectId, freshChat }: MountIdentityInputs): ChatIdentity {
  if (freshChat) {
    /*
     * Built from scratch, NOT spread from `current`. A spread would silently carry every field added to
     * `IChatMetadata` in future — and the failure mode of carrying one is data loss, not a wrong label.
     * This must break loudly at the type level when the shape grows, rather than inherit by default.
     */
    return {
      chatId: undefined,
      description: undefined,
      urlId: undefined,
      metadata: { projectId },
    };
  }

  return {
    ...current,
    metadata: { ...current.metadata, projectId },
  };
}
