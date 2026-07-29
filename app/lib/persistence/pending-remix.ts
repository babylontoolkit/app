/**
 * The remix / open handoff (SPEC §4.8, §4.1).
 *
 * `/remix/:shareId` clones a game server-side, then navigates to the builder. But the builder is the
 * only place the WebContainer and workbench exist, so the newly-cloned project's files must be mounted
 * THERE, not on the remix page. This tiny module is the baton: the remix page writes the new project
 * id, the builder reads it once on load and mounts the project through the same server-checkpoint path
 * a normal resume uses.
 *
 * The Dashboard ("All Projects", §4.1) needs the exact same baton for a different reason: a project the
 * platform owns may have NO local chat in *this* browser (created on another device, or a remix the
 * user navigated away from before the first message persisted). When there is no `/chat/:urlId` to open,
 * the dashboard drops the project id here and lets the builder mount its files fresh — same mechanism,
 * different key so the two intents never get confused.
 *
 * sessionStorage (not a query param) because it survives the `navigate('/')` without putting a project
 * id in the URL, and it is same-tab only — a second tab does not accidentally inherit the mount.
 */
export const PENDING_REMIX_KEY = 'pendingRemixProjectId';
export const PENDING_OPEN_KEY = 'pendingOpenProjectId';

/**
 * Which of the project's chats to open (§4.5.6) — optional, and only meaningful alongside a pending
 * open. Absent means "the one I was last in", which is what someone clicking a project means.
 */
export const PENDING_CHAT_KEY = 'pendingOpenChatId';

/**
 * "Mount this project, restore NO conversation" — New chat, same game (§4.5.6).
 *
 * A separate key rather than a sentinel in the chat slot. A sentinel would have to be a string that no
 * real chat id can equal, which is a collision waiting to be introduced by someone who changes how ids
 * are minted and has no reason to look here.
 */
export const PENDING_FRESH_CHAT_KEY = 'pendingOpenFreshChat';

/**
 * Park a project id for the builder to mount on its next load.
 *
 * `chat` picks which conversation comes back: a specific id, `'latest'` (the one you were last in — the
 * default, and what clicking a project means), or `'fresh'` for a new chat on the same game.
 */
export function setPendingOpenProject(projectId: string, chat: string | 'latest' | 'fresh' = 'latest'): void {
  if (typeof sessionStorage === 'undefined') {
    return;
  }

  sessionStorage.setItem(PENDING_OPEN_KEY, projectId);

  /*
   * Always write BOTH slots, clearing what does not apply. A stale id or flag left from a previous open
   * would silently reopen the wrong conversation — or none — which looks exactly like data loss to the
   * user ("where did my chat go?") while everything is in fact still there.
   */
  sessionStorage.removeItem(PENDING_CHAT_KEY);
  sessionStorage.removeItem(PENDING_FRESH_CHAT_KEY);

  if (chat === 'fresh') {
    sessionStorage.setItem(PENDING_FRESH_CHAT_KEY, '1');
  } else if (chat !== 'latest') {
    sessionStorage.setItem(PENDING_CHAT_KEY, chat);
  }
}

function takeKey(key: string): string | null {
  if (typeof sessionStorage === 'undefined') {
    return null;
  }

  const id = sessionStorage.getItem(key);

  if (id) {
    // Read-once: clear immediately so a refresh does not re-mount over later work.
    sessionStorage.removeItem(key);
  }

  return id;
}

/**
 * Park a just-cloned remix for the builder to mount on its next load.
 *
 * The one writer of `PENDING_REMIX_KEY`, so the raw sessionStorage write is not copied at each call
 * site — self-remix from the ⋯ menu and a shared-game remix both land here.
 */
export function setPendingRemix(projectId: string): void {
  if (typeof sessionStorage === 'undefined') {
    return;
  }

  sessionStorage.setItem(PENDING_REMIX_KEY, projectId);
}

export function takePendingRemix(): string | null {
  return takeKey(PENDING_REMIX_KEY);
}

export interface PendingMount {
  projectId: string;

  /** A specific conversation to restore. Absent means the most recently touched one. */
  serverChatId?: string;

  /** New chat, same game (§4.5.6): mount the files, restore nothing. */
  freshChat: boolean;
}

/**
 * Non-consuming peek: is a project mount parked for this load?
 *
 * Exists so the builder can decide, on its FIRST render, whether to show the boot splash — the
 * consuming read (`takePendingProjectMount`) runs in an effect, i.e. after the render that already
 * chose what to draw. Without the peek, `ready` on `/` was `!mixedId` = instantly true, so a remix or
 * dashboard open mounted the project BEHIND a fully-rendered empty chat: no "Waking your workspace…",
 * no file counts — the same silent-boot gap `BootScreen` was built to close for resume (owner report
 * 2026-07-29: "Remix this project should have the same splash progress creations and resumes get").
 *
 * MUST stay read-only: this runs per hook instance and multiple components call `useChatHistory`;
 * a consuming peek would eat the baton before the mount effect could act on it.
 */
export function hasPendingProjectMount(): boolean {
  if (typeof sessionStorage === 'undefined') {
    return false;
  }

  return sessionStorage.getItem(PENDING_OPEN_KEY) !== null || sessionStorage.getItem(PENDING_REMIX_KEY) !== null;
}

/**
 * The single reader the builder calls on a fresh mount: either a just-cloned remix or a dashboard
 * "open" resolves to the same thing — a project id whose files should be mounted. Open takes precedence
 * (it is the more explicit user action), then remix.
 *
 * Both chat slots are consumed unconditionally, even on the remix path. A remix is a NEW project born
 * with no chats at all, so a leftover id from a previous open would otherwise ask the clone for a
 * conversation belonging to the project it was cloned FROM.
 */
export function takePendingProjectMount(): PendingMount | null {
  const open = takeKey(PENDING_OPEN_KEY);
  const serverChatId = takeKey(PENDING_CHAT_KEY) ?? undefined;
  const freshChat = takeKey(PENDING_FRESH_CHAT_KEY) !== null;

  if (open) {
    return { projectId: open, serverChatId, freshChat };
  }

  const remix = takeKey(PENDING_REMIX_KEY);

  return remix ? { projectId: remix, freshChat: false } : null;
}
