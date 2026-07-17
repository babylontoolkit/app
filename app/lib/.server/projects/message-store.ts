/**
 * Where a project's conversation lives (SPEC §4.5, §4.5.5, §4.5.4b).
 *
 * The chat is an OBJECT, not a relation: it is written whole on every turn, read whole on resume,
 * never queried by row, and can be megabytes. It is also the one part of a project the platform still
 * holds under repo-primary persistence — the user's CODE goes to their repo, the conversation about it
 * stays with us so a project can be resumed on another device (§4.5.4b).
 *
 * ## Why this is a module rather than two lines in the route
 *
 * It exists because the key was private to `api.projects.$projectId.messages.ts`, which meant nothing
 * else could address a conversation — including the code that deletes a project. So **deleting a
 * project left its chat behind forever**: the row went, the transcript stayed, and the id needed to
 * find it again went with the row. Unreachable, un-deletable, and a privacy failure the user has every
 * reason to think they had just prevented by pressing Delete.
 *
 * That is the same shape as the orphaned snapshot payloads this era of the codebase keeps producing —
 * bytes outliving the record that named them — and the fix is the same: one key, in one place, that
 * both the writer and the reaper import.
 */
import { getObjectStore } from '~/lib/.server/storage';

/** One conversation per project, at a key derived from the project id. */
export function messagesKey(projectId: string): string {
  return `messages/${projectId}.json`;
}

/**
 * Forget a project's conversation.
 *
 * Unconditional and idempotent: deleting an object that is not there is a no-op, so the caller never
 * has to ask "was there a chat?" first — a question whose wrong answer leaves the bytes behind.
 */
export async function deleteMessages(projectId: string, context?: unknown): Promise<void> {
  await getObjectStore(context).delete(messagesKey(projectId));
}
