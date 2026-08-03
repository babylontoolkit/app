/**
 * Wiring for `local-owner.ts` — session in, stamped records and a scoped viewer out.
 *
 * Everything that decides anything lives next door and is pure; this file only does the three things
 * that need a browser: publish the viewer, apply an adoption plan to IndexedDB, and drop the
 * `localStorage` caches that would otherwise print the PREVIOUS account's identity to the next one.
 *
 * It runs as one module-level subscription rather than a hook. The session can change without any
 * particular component being mounted (`refreshSession` is called from the enhancer, from settlement,
 * from the account menu), and a hook would tie ownership — a privacy property — to whichever screen
 * happened to be on. Started once from `useSession`, which is already the single place the session
 * boots.
 */
import {
  LOCAL_OWNER_KEY,
  localOwnerRevision,
  planAdoption,
  setLocalViewer,
  viewerFromSession,
  type LocalViewer,
} from './local-owner';
import { sessionStore } from '~/lib/stores/session';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('LocalOwner');

/**
 * Which account this browser last rendered for. Distinct from `LOCAL_OWNER_KEY`, which records the
 * one-time legacy adoption and is written once ever; this one moves on every account switch.
 */
const LAST_SESSION_USER_KEY = 'bt_local_last_user';

/**
 * Per-browser caches of a THIRD-PARTY identity, cleared when the account changes.
 *
 * These hold a GitHub/Netlify/Vercel username and avatar — not credentials (the tokens are
 * server-held, `git_tokens`, and `github_connection.token` is written as `''`), so this is a display
 * leak rather than a credential one: user B opens Settings and sees user A's GitHub account sitting
 * there, connected. They re-populate on their own from `/api/*-user` for whoever is actually signed
 * in, which is what makes clearing them safe — nothing here is a last copy of anything.
 *
 * ⚠️ `bolt_profile` is deliberately NOT in this list. It is upstream's local personalization and in
 * local mode it is the only identity there is (`~/lib/identity`); with accounts configured the
 * session already outranks it, so it cannot mislabel a session anyway.
 */
const IDENTITY_CACHE_KEYS = ['github_connection', 'netlify_connection', 'vercel_connection'];

let started = false;

export function startLocalOwnerSync(): void {
  if (started || typeof window === 'undefined') {
    return;
  }

  started = true;

  sessionStore.subscribe((session) => {
    const viewer = viewerFromSession(session);

    /*
     * Published FIRST and synchronously. Every read path gates on it, so any delay here is a window in
     * which the previous account's records are still being handed out.
     */
    setLocalViewer(viewer);

    if (session.loading) {
      return;
    }

    void reconcile(viewer);
  });
}

/** Serialised so a burst of `refreshSession` calls cannot run two adoptions over the same records. */
let inFlight: Promise<void> = Promise.resolve();

function reconcile(viewer: LocalViewer): Promise<void> {
  inFlight = inFlight.then(() => applyOwnership(viewer)).catch(() => undefined);

  return inFlight;
}

async function applyOwnership(viewer: LocalViewer): Promise<void> {
  const userId = viewer.status === 'user' ? viewer.id : null;

  forgetPreviousAccountIdentity(userId);

  if (!userId) {
    return;
  }

  const unsyncedAdopted = readLocalStorage(LOCAL_OWNER_KEY) !== null;

  /*
   * The one-shot marker is already burnt AND every legacy record has been dealt with, so there is
   * nothing an adoption pass could do but re-read the whole database on every session refresh.
   */
  if (unsyncedAdopted && adoptedThisLoad.has(userId)) {
    return;
  }

  /*
   * Imported lazily so this module can be started from `useSession` — which every page uses —
   * without dragging the persistence layer (and its top-level `openDatabase()` await) into pages that
   * never touch a chat. `db` lives in `useChatHistory`, not `db.ts`, which is where it has always been.
   */
  const [{ getAll, stampChatOwners }, { db }, { listAllChats }] = await Promise.all([
    import('./db'),
    import('./useChatHistory'),
    import('./projects'),
  ]);

  if (!db) {
    return;
  }

  let ownedServerChatIds = new Set<string>();
  let serverAnswered = false;

  try {
    ownedServerChatIds = new Set((await listAllChats()).map((chat) => chat.serverChatId));
    serverAnswered = true;
  } catch (error) {
    /*
     * Not an error worth surfacing: a signed-in user with a flaky connection just keeps whatever
     * attribution they already have. `planAdoption` refuses to act — and refuses to burn the marker —
     * on an unanswered server, because an empty list is shaped exactly like "you own no chats".
     */
    logger.debug(`Could not confirm chat ownership with the server: ${(error as Error).message}`);
  }

  const plan = planAdoption({
    chats: await getAll(db),
    ownedServerChatIds,
    viewer,
    unsyncedAdopted,
    serverAnswered,
  });

  if (!plan.ownerId) {
    return;
  }

  const stamped = await stampChatOwners(db, plan.chatIds, plan.ownerId);

  if (plan.markUnsyncedAdopted) {
    writeLocalStorage(LOCAL_OWNER_KEY, plan.ownerId);
  }

  adoptedThisLoad.add(userId);

  if (stamped > 0) {
    logger.info(`Attributed ${stamped} existing chat(s) to the signed-in account.`);

    // Wake anything already rendering a list, or the user sees an empty sidebar and reads it as loss.
    localOwnerRevision.set(localOwnerRevision.get() + 1);
  }
}

/** Accounts whose adoption pass has already run in this page load. */
const adoptedThisLoad = new Set<string>();

/**
 * Drop the previous account's cached third-party identities once the account actually changes.
 *
 * Only on a CHANGE, and never on the first observation: the initial load has no prior value to
 * compare against, and clearing there would wipe the connections of the person who just signed in.
 * A sign-OUT (`userId === null`) is also not a change of account — the same person may be signing
 * straight back in, and their own caches surviving a reload is the behaviour that already existed.
 */
function forgetPreviousAccountIdentity(userId: string | null): void {
  if (!userId) {
    return;
  }

  const previous = readLocalStorage(LAST_SESSION_USER_KEY);

  writeLocalStorage(LAST_SESSION_USER_KEY, userId);

  if (previous === null || previous === userId) {
    return;
  }

  for (const key of IDENTITY_CACHE_KEYS) {
    removeLocalStorage(key);
  }

  logger.info('Signed-in account changed — cleared this browser’s cached connection identities.');
}

/*
 * `localStorage` throws in a partitioned or storage-blocked context (Safari private browsing, an
 * embedded frame with third-party storage denied). Ownership must degrade to "we cannot remember the
 * marker" — which `planAdoption` reads as an un-run adoption, i.e. cautious — and never take the app
 * down on the session's own subscribe path.
 */
function readLocalStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Nothing to do — see above.
  }
}

function removeLocalStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to do — see above.
  }
}
