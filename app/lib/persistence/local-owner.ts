/**
 * Who a browser-local record belongs to (SPEC §4.5.3, §4.5.6).
 *
 * 🔴 **This exists because the browser's stores were never scoped to an account, and two people
 * sharing a computer could read each other's conversations.** The server side was always right —
 * `/api/projects` and `/api/chats` both go through `requireUser` and `listByUser(user.id)`, so the
 * Projects dashboard and the sidebar's *server* half have never leaked. But IndexedDB (`boltHistory`)
 * and `localStorage` are per-BROWSER-PROFILE, they carry no owner, and sign-out clears neither: it
 * drops the session cookie and reloads. Three paths followed from that, each silent:
 *
 *   1. **`mergeChatList` keeps every local chat that has no `serverChatId`.** That is correct as
 *      written — an unsaved chat is real and must not be dropped because the server has not heard of
 *      it — but a chat only gets a `serverChatId` at the END of a generation (`ensureServerChatId`,
 *      called from `checkpointProject`), while `storeMessageHistory` writes IndexedDB on every
 *      message. So a stopped, failed, or closed-tab generation leaves a local-only chat FOREVER, and
 *      it rendered in the next user's sidebar with its title.
 *   2. **Opening one had no ownership check at all.** A non-UUID local id skips `openFromServer`
 *      entirely and reads `getMessages(db, id)` + `getSnapshot(db, id)` straight out of IndexedDB —
 *      the whole conversation, plus the snapshot's files.
 *   3. **The offline fallback showed everything.** `localChatList(local)` filters nothing by design
 *      (blanking the sidebar on a network blip is its own bug), and a 401 from an expired session
 *      reaches it as an ordinary thrown error — so a signed-out browser listed every chat anyone had
 *      ever made on that machine.
 *
 * ## The two decisions in here
 *
 * **Scope reads; do not delete.** A local chat is the write-ahead buffer for work the server has not
 * seen yet (`storeMessageHistory` writes on every message; the server is written at the end of a
 * generation). Wiping IndexedDB on a sign-out would destroy an in-flight conversation for anyone who
 * signs out and back in — a data-loss bug traded for a privacy one. Filtering hides the records and
 * leaves the bytes; the rightful owner signs in and sees them again. Same reasoning that keeps
 * `localChatList` separate from `mergeChatList([], local)` one file over.
 *
 * **Unknown fails CLOSED.** Everywhere else in this codebase "could not ask" degrades toward showing
 * more (`mount-source.ts`'s `undefined` vs `null`, `localChatList` itself) because the cost is a
 * user losing sight of their own work. Here the cost of guessing wrong is showing someone else's
 * conversation, so a viewer we cannot identify — session still loading, `/api/me` unreachable — owns
 * NOTHING. That is safe precisely because it deletes nothing: the records reappear the moment the
 * session resolves.
 *
 * ## Attribution is by EVIDENCE, not by "whoever got here first"
 *
 * Records written before this shipped carry no owner, and guessing is what we are trying to stop. So
 * `planAdoption` asks the server: a legacy chat whose `serverChatId` is in the viewer's own
 * `/api/chats` list is PROVABLY theirs and gets stamped; one whose id is absent belongs to someone
 * else (or was deleted elsewhere) and is left alone, forever invisible to this viewer. Only chats
 * with no `serverChatId` at all have no evidence available, and those are adopted once per browser —
 * bounded by a marker so the second account to sign in inherits nothing.
 *
 * Pure and DOM-free so every rule above is testable without a database; `local-owner-sync.ts` is the
 * wiring, `db.ts` does the stamping.
 */
import { atom } from 'nanostores';
import type { SessionState } from '~/lib/stores/session';

/**
 * The `localStorage` marker recording that this browser has already run the one-time adoption of
 * legacy chats that carry no `serverChatId`. Holds the id of the account that ran it, for diagnosis.
 */
export const LOCAL_OWNER_KEY = 'bt_local_owner';

/**
 * The owner id used when Supabase is unconfigured (§4.5 local mode).
 *
 * Local mode is a real mode with a real single user, so everything stamps to one constant id and the
 * filtering below is a no-op. Never reachable in production — `assertNotLocalInProduction`.
 */
export const LOCAL_SINGLE_USER_ID = 'local';

/**
 * Who is looking.
 *
 * Three states, not two, because "nobody is signed in" and "we do not know yet" have to be
 * distinguishable at the call site even though they currently reach the same answer. Collapsing them
 * into `undefined` is how a later reader talks themselves into treating a boot race as a guest
 * session and showing it something.
 */
export type LocalViewer = { status: 'unknown' } | { status: 'nobody' } | { status: 'user'; id: string };

export const UNKNOWN_VIEWER: LocalViewer = { status: 'unknown' };
export const NO_VIEWER: LocalViewer = { status: 'nobody' };

/** Any browser-local record that can carry an owner. */
export interface OwnedRecord {
  /** The account that wrote it. Absent on records written before this shipped — see `planAdoption`. */
  ownerId?: string;
}

/**
 * The viewer implied by the session (`~/lib/stores/session`).
 *
 * ⚠️ `loading` is checked FIRST and on its own. `EMPTY_SESSION` has `authenticated: false` and
 * `accountsEnabled: false`, which is byte-identical to a resolved local-mode session — so a rule that
 * looked at `accountsEnabled` before `loading` would hand every booting page the local single-user id
 * and show it every record on the machine, for as long as `/api/me` took to answer.
 */
export function viewerFromSession(session: Pick<SessionState, 'loading' | 'accountsEnabled' | 'user'>): LocalViewer {
  if (session.loading) {
    return UNKNOWN_VIEWER;
  }

  if (session.user?.id) {
    return { status: 'user', id: session.user.id };
  }

  /*
   * Accounts are not configured, so there is exactly one user and no way to tell them apart from
   * themselves. Anything else here would make local development show an empty sidebar.
   */
  if (!session.accountsEnabled) {
    return { status: 'user', id: LOCAL_SINGLE_USER_ID };
  }

  // Accounts exist and nobody is signed in. Browsing is fine; reading the last user's chats is not.
  return NO_VIEWER;
}

/**
 * May this viewer see this record?
 *
 * 🔴 An UNSTAMPED record (`ownerId === undefined`) belongs to NOBODY, never to everybody. That is the
 * whole fix in one line: the permissive reading is exactly the behaviour being removed, and it is the
 * one a future reader will be tempted by when a legacy chat goes missing from their sidebar. Legacy
 * records are rescued by `planAdoption` stamping them, not by this predicate being generous.
 */
export function ownsLocalRecord(record: OwnedRecord, viewer: LocalViewer): boolean {
  if (viewer.status !== 'user') {
    return false;
  }

  return record.ownerId === viewer.id;
}

/** The subset of `records` this viewer may see. Order preserved — callers sort for themselves. */
export function filterOwnedRecords<T extends OwnedRecord>(records: readonly T[], viewer: LocalViewer): T[] {
  return records.filter((record) => ownsLocalRecord(record, viewer));
}

/** A local chat as adoption needs to see it. */
export interface AdoptableChat extends OwnedRecord {
  id: string;
  metadata?: { serverChatId?: string };
}

export interface AdoptionInput {
  /** Every chat in this browser's IndexedDB. */
  chats: readonly AdoptableChat[];

  /** The `serverChatId`s the SERVER just said belong to this viewer — the proof. */
  ownedServerChatIds: ReadonlySet<string>;

  viewer: LocalViewer;

  /** Has this browser already run the one-time adoption of chats with no `serverChatId`? */
  unsyncedAdopted: boolean;

  /**
   * Did the server actually answer? A failed `/api/chats` yields an EMPTY owned set, which is
   * indistinguishable from "you own no chats" — and adopting on that basis would stamp nothing while
   * burning the one-shot marker, orphaning every legacy chat on the machine permanently.
   */
  serverAnswered: boolean;
}

export interface AdoptionPlan {
  /** The account to stamp onto `chatIds`. Absent when there is nothing to do. */
  ownerId?: string;

  /** Local chat ids to stamp, in input order. */
  chatIds: string[];

  /** Write `LOCAL_OWNER_KEY` after applying, closing the one-time window for this browser. */
  markUnsyncedAdopted: boolean;
}

const NOTHING_TO_DO: AdoptionPlan = { chatIds: [], markUnsyncedAdopted: false };

/**
 * Which legacy records this viewer may claim.
 *
 * 🔴 **A stamped record is never re-stamped.** Ownership is decided once and is final; re-attributing
 * on a later sign-in is the original leak with an audit trail. So only `ownerId === undefined` is ever
 * a candidate, and everything below narrows from there:
 *
 *   - **has a `serverChatId` the server confirmed** → adopt. Proof, not inference.
 *   - **has a `serverChatId` the server did NOT confirm** → leave it. It is another account's chat, or
 *     one deleted from another device. Either way this viewer has no claim, and it stays invisible.
 *   - **has no `serverChatId`** → no evidence exists. Adopt once per browser, gated on
 *     `unsyncedAdopted`, so the FIRST account to sign in after the upgrade keeps its unsynced work and
 *     the second inherits nothing.
 *
 * The marker is written whenever a resolved user has seen a server answer — including when nothing was
 * adopted. Leaving the window open "until there is something to claim" means it is still open for the
 * next account, which is the case it exists to close.
 */
export function planAdoption(input: AdoptionInput): AdoptionPlan {
  const { chats, ownedServerChatIds, viewer, unsyncedAdopted, serverAnswered } = input;

  if (viewer.status !== 'user' || !serverAnswered) {
    return NOTHING_TO_DO;
  }

  const chatIds: string[] = [];

  for (const chat of chats) {
    if (chat.ownerId !== undefined) {
      continue;
    }

    const serverChatId = chat.metadata?.serverChatId;

    if (serverChatId) {
      if (ownedServerChatIds.has(serverChatId)) {
        chatIds.push(chat.id);
      }

      continue;
    }

    if (!unsyncedAdopted) {
      chatIds.push(chat.id);
    }
  }

  return { ownerId: viewer.id, chatIds, markUnsyncedAdopted: !unsyncedAdopted };
}

/**
 * The viewer, for code that cannot take it as an argument.
 *
 * `setMessages` is called from a dozen places that have no session in scope, and threading one
 * through all of them is how a call site quietly gets missed — an unstamped write is invisible to its
 * own author, which is the worst failure this module can have. Reading it here makes stamping
 * automatic and impossible to forget. Set by `local-owner-sync.ts`; `UNKNOWN_VIEWER` until then.
 */
export const localViewerStore = atom<LocalViewer>(UNKNOWN_VIEWER);

/**
 * Bumped after legacy chats are stamped, so a surface already on screen re-reads.
 *
 * Adoption happens asynchronously after the session resolves (it waits on `/api/chats`), and the
 * sidebar's own load is triggered by opening it. Without a signal, a user who upgraded and opened the
 * sidebar in that window sees an empty list and concludes their chats are gone — which is the exact
 * impression this whole change exists to avoid creating.
 */
export const localOwnerRevision = atom(0);

export function setLocalViewer(viewer: LocalViewer): void {
  const current = localViewerStore.get();

  // Atoms compare by reference; re-setting an equal viewer would wake every subscriber on every poll.
  if (current.status === viewer.status && (current as { id?: string }).id === (viewer as { id?: string }).id) {
    return;
  }

  localViewerStore.set(viewer);
}

export function localViewer(): LocalViewer {
  return localViewerStore.get();
}

/**
 * Claim an INCOMING record for the importing account.
 *
 * 🔴 Whatever `ownerId` the payload carried is DISCARDED, never honoured. An import file is
 * user-supplied — a `.json` from Settings → Data, possibly exported by somebody else — and trusting
 * the id inside it would let one account plant records into a shared browser that another account
 * then owns and sees. The importer owns what they imported; that is the only defensible answer, and
 * it is also the only one that makes the imported chats visible to the person who imported them.
 */
export function claimForImport<T extends OwnedRecord>(record: T): T {
  return { ...record, ownerId: currentOwnerId() };
}

/**
 * The account to stamp on a write, or `undefined` when we do not know one.
 *
 * ⚠️ Callers must treat `undefined` as "leave whatever is already there", NOT as "clear the owner".
 * `setMessages` does a blind `put` of a whole record, so writing `ownerId: undefined` during a boot
 * race would un-own a record the user is actively typing into and hide their own chat from them. See
 * the read-then-put in `db.ts`.
 */
export function currentOwnerId(): string | undefined {
  const viewer = localViewerStore.get();

  return viewer.status === 'user' ? viewer.id : undefined;
}
