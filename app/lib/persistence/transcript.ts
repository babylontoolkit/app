/**
 * Restoring a conversation without re-running it (SPEC §4.5.4b).
 *
 * ## The gap this closes
 *
 * `saveMessages` uploaded the chat on every checkpoint and **nothing ever read it back** —
 * `loadMessages` had zero call sites. So the platform paid to store every conversation and never used
 * one: open a project on a second device and the game came back from the repo while the conversation
 * was simply gone. §4.5.4b promises the opposite ("server = project record + chat"), and the chat is
 * not a nicety — it is the record of what the user asked for and why the game is the way it is.
 *
 * ## Why this is not just `setInitialMessages(serverMessages)`
 *
 * 🔴 **Parsing a message writes files.** `useMessageParser`'s `onActionClose` calls
 * `workbenchStore.runAction`, and that is deliberate: replaying `<boltAction type="file">` is how
 * upstream rebuilds a project that has no snapshot. Hand it a restored history for a project whose
 * files just came from the user's REPO and it writes months-old bodies over them, racing the mount,
 * silently.
 *
 * So the messages are marked (`NO_REPLAY`), and marked messages go to a parser that renders them and
 * runs nothing. This module decides what gets marked, as a pure function, because the failure is
 * invisible: mark too much and a live generation stops applying its own files; mark too little and a
 * restore quietly corrupts the project it just mounted.
 */
import type { Message } from 'ai';
import { NO_REPLAY } from '~/lib/hooks/useMessageParser';

/**
 * Mark a restored conversation as history: show it, never re-run it.
 *
 * Applied to messages arriving from the SERVER for a project whose files came from somewhere else (the
 * repo, a local checkpoint, a remix seed). Never applied to a live generation — that one's actions are
 * how the files get written in the first place.
 *
 * Idempotent, and preserves any annotations the message already carried (`chatSummary`, `no-store`),
 * because those drive other behaviour and silently dropping them would be a second bug wearing this
 * one's clothes.
 */
export function markAsTranscript(messages: Message[]): Message[] {
  return messages.map((message) => {
    const annotations = Array.isArray(message.annotations) ? message.annotations : [];

    if (annotations.includes(NO_REPLAY)) {
      return message;
    }

    return { ...message, annotations: [...annotations, NO_REPLAY] };
  });
}

/**
 * Is this history worth restoring at all?
 *
 * An empty or absent history is the normal case for a brand-new project, not an error — and restoring
 * `[]` over a conversation that is already on screen would be a regression dressed as a feature.
 */
export function hasRestorableHistory(messages: unknown): messages is Message[] {
  return Array.isArray(messages) && messages.length > 0;
}
