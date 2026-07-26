/**
 * "New chat, same game" — IN PLACE (SPEC §4.5.6, §4.2.9).
 *
 * ## Why this exists
 *
 * The action started life as a mount-baton hand-off: park the project id, `navigate('/')`, and let the
 * builder's mount path put the files in front of an empty chat. That is the right mechanism when the
 * project is NOT already open (a dashboard Open, a remix) — but when it IS open it re-mounts a project
 * that never went anywhere: `mountProjectFiles` runs again, the workbench tears down and slides back in,
 * and the user watches their whole workspace reload to be told a sentence's worth of nothing. Reported
 * as "it makes the workflow look broken", and it is: clearing a conversation is not a project event.
 *
 * So the already-mounted case resets the conversation where it stands — messages, chat identity, parsed
 * output, context stats — and touches NOTHING that belongs to the project: not the WebContainer, not the
 * file tree, not the preview, not `showWorkbench`, not `chatStore.started`.
 *
 * ## Why a signal store rather than a callback
 *
 * The conversation lives inside `ChatImpl` (`useChat`'s message array is component state), but the
 * action is triggered from outside it — the ⋯ main menu's "New chat" and the `/clear` command must take
 * the SAME path or "new chat" means two different things depending on how you asked for it (the rule
 * `useStartNewChat` already records). A monotonic counter is the smallest thing that crosses that gap
 * without either component importing the other, and it is idempotent-safe: a listener compares against
 * the value it last saw, so a remount can never replay a reset it already performed.
 */
import { atom } from 'nanostores';

/**
 * Bumped once per requested reset. The VALUE is meaningless; only a change is a request.
 *
 * Module-level, so it survives an SPA navigate — hence listeners must seed their "last seen" from the
 * current value at mount rather than from 0.
 */
export const chatResetRequest = atom<number>(0);

/** Ask the open conversation to clear itself. No-op if the builder is not mounted. */
export function requestChatReset(): void {
  chatResetRequest.set(chatResetRequest.get() + 1);
}
