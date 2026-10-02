/**
 * Server-side transcript recovery — a completed, PAID generation must leave a record (§4.5.6, §4.6).
 *
 * ## The hole this closes
 *
 * Settlement is server-side and happens the moment the stream ends. Persistence is CLIENT-side and
 * happens afterwards: the browser writes the message list to `/api/projects/:id/messages/:chatId`.
 * Between those two points the platform has taken the user's credits and stored nothing.
 *
 * Measured live: `/bt-landing` ran to completion (`finish=stop`, 20,364 output tokens, 8 files),
 * settled at **427 credits**, and then the tab died. Re-opening the project showed the conversation as
 * it had been BEFORE the run — no redesign, no mention of it, no way to tell it had ever happened. The
 * server log knew; the user's account was debited; nothing else survived. Worse, the generation row
 * recorded `chatId: null`, because the client never sent one — so even the audit trail could not say
 * which conversation the money had been spent on.
 *
 * ## What this can and cannot restore
 *
 * It restores the RECORD, never the FILES. The platform stores no project files by design
 * (§4.5.4b — no snapshot table, no snapshot route, pinned by `no-server-storage.spec.ts`), so a
 * recovered transcript lets the user see what was built and ask for it again; it does not put the
 * bytes back. Do NOT "improve" this by having it stash the artifact's files somewhere — that is
 * server-side project storage under a new name, which is exactly what migration 0007 removed.
 *
 * ## Why it is a PURE function
 *
 * Same reason as `auto-repair.ts` and `restore-target.ts`: it decides whether to OVERWRITE a stored
 * conversation, and getting that wrong destroys history silently. The two failure directions are not
 * symmetric — writing when we should not have can shrink a rich client-saved transcript down to this
 * module's plainer reconstruction, while failing to write merely leaves the status quo. So the guard
 * is deliberately biased: when in doubt, do nothing.
 */

import { MANAGED_ASSISTANT_ID_PREFIX } from '~/lib/chat/managed-turn';

/** A stored conversation, as `message-store.ts` holds it. Structural to avoid a server-only import. */
export interface RecoverableChat {
  serverChatId: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messages: unknown[];
}

export interface RecoveryPlanInput {
  /**
   * The SERVER chat id (a UUID), never the browser's local counter (§4.5.6).
   *
   * Absent on the first turn of a brand-new chat, because the client mints it at first SAVE. That turn
   * is therefore not covered — see the module note in `proxy.ts`.
   */
  serverChatId?: string;

  /** What is already stored for this chat, or `null` if nothing is. */
  existing: RecoverableChat | null;

  /**
   * The conversation as the server received it this turn, oldest first.
   *
   * `id` is carried through when the client supplied one. The stored shape must stay renderable by the
   * client (`Message` requires an id), so a recovered chat that re-opens is a conversation rather than
   * a crash — a transcript that cannot render is no more use than the missing one it replaced.
   */
  requestMessages: { id?: string; role: string; content: string }[];

  /** The assistant text this generation actually streamed. */
  assistantText: string;

  /** Title to use when creating the object fresh. */
  title?: string;

  /** Injected — `Date` is not available to callers that need determinism in tests. */
  now: string;
}

export function planTranscriptRecovery(input: RecoveryPlanInput): RecoverableChat | null {
  /* No id, no key. Minting one here would create a SECOND chat the client never adopts (§4.5.6). */
  if (!input.serverChatId) {
    return null;
  }

  /* Nothing was produced — a failed generation refunds, and an empty transcript is not a record. */
  if (!input.assistantText.trim()) {
    return null;
  }

  /*
   * Every stored message carries an `id` — the client's own where it had one, a stable synthetic one
   * otherwise. Synthetic ids are derived from the position, never from a clock or a random source, so
   * re-running recovery on the same turn produces byte-identical output instead of a second set of
   * messages that merely look different.
   */
  const messages = [
    ...input.requestMessages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m, index) => ({ id: m.id ?? `recovered-${index}`, role: m.role, content: m.content })),
    { id: `recovered-${input.requestMessages.length}`, role: 'assistant', content: input.assistantText },
  ];

  /*
   * 🔴 NEVER SHRINK A STORED CONVERSATION.
   *
   * The client's copy is strictly richer than this one — it carries annotations, the `NO_REPLAY` mark
   * (§4.5.4b), tool invocations and artifact structure, none of which the server reconstructs. If the
   * client already saved this turn, its object has at LEAST as many messages as we are holding, and
   * overwriting it would silently downgrade a good transcript to a plain one.
   *
   * This is also the race guard: the client save and this write are concurrent, and a `>=` here means
   * the loser of that race does nothing rather than clobbering the winner.
   */
  if (input.existing && input.existing.messages.length >= messages.length) {
    return null;
  }

  return {
    serverChatId: input.serverChatId,
    title: input.existing?.title ?? input.title,
    createdAt: input.existing?.createdAt ?? input.now,
    updatedAt: input.now,
    messages,
  };
}

/*
 * ================================================================================================
 * THE MANAGED ENGINE'S TRANSCRIPT (`_specs/managed-agents-engine_plan.md` T10).
 *
 * On the managed engine the server writes the turn's record at the END OF EVERY REQUEST — a finished
 * turn, a detached one (closed tab), a resumed one, a failed one — because a managed turn can finish
 * with no browser listening, and the browser was the only writer. Same rules as `planTranscriptRecovery`
 * above, extended for a turn that can span two requests:
 *
 *   - **Never shrink.** The client's copy is richer; a write only ever APPENDS this turn, or replaces
 *     this turn's own earlier (shorter) server-written reply.
 *   - **One reply per TURN, not per request.** The assistant message id is derived from the session's
 *     `user.message` event id (`managedAssistantId`), which a detached request and the resume that
 *     finishes it share — so a resume REPLACES the partial reply instead of adding a second one.
 *   - **A turn the client already saved is left alone** (its user message is stored with something
 *     after it).
 *   - **No file bodies.** The reply is the agent's narration only (tool inputs never reach it), and
 *     a history rebuilt from the request has `<boltAction type="file">` bodies emptied.
 * ================================================================================================
 */

export { MANAGED_ASSISTANT_ID_PREFIX };

/** The stored id of a managed turn's reply. Pure. */
export function managedAssistantId(turnId: string): string {
  return `${MANAGED_ASSISTANT_ID_PREFIX}${turnId}`;
}

const FILE_ACTION_BODY = /(<boltAction\b[^>]*\btype="(?:file|edit)"[^>]*>)[\s\S]*?(<\/boltAction>)/g;

/** Empty every file-action body, keeping the tags (the record of WHICH files a turn touched). Pure. */
export function stripFileBodies(content: string): string {
  return content.replace(FILE_ACTION_BODY, '$1$2');
}

export interface StoredMessage {
  id: string;
  role: string;
  content: string;
  annotations?: unknown[];
}

export interface ManagedTranscriptInput {
  serverChatId?: string;
  existing: RecoverableChat | null;

  /** The conversation as the client sent it this request (normalised), oldest first. */
  requestMessages: { id?: string; role: string; content: string }[];

  /** This turn's user message — what the user typed. `null` when the request carries none. */
  userMessage: { id?: string; content: string } | null;

  /** This turn's reply: the agent's narration plus the annotations the route writes. */
  assistant: StoredMessage;

  /** The turn did something worth recording even if it said nothing (wrote files, ran tools). */
  didWork: boolean;

  title?: string;
  now: string;
}

function asStored(message: unknown): StoredMessage | null {
  const m = message as Partial<StoredMessage> | null;

  return m && typeof m === 'object' && typeof m.id === 'string' ? (m as StoredMessage) : null;
}

export function planManagedTranscript(input: ManagedTranscriptInput): RecoverableChat | null {
  if (!input.serverChatId) {
    return null;
  }

  const { assistant } = input;

  /*
   * An EMPTY reply (a Stop after only reads, a detach before the first narration) is never stored as a
   * message — it renders as a blank bubble. The user's words still are, so the turn is on record.
   */
  const hasReply = assistant.content.trim().length > 0;

  const lastUserIndex = input.requestMessages.map((m) => m.role).lastIndexOf('user');
  const history = input.requestMessages
    .filter((m, i) => (m.role === 'user' || m.role === 'assistant') && i !== lastUserIndex)
    .map((m, i) => ({ id: m.id ?? `recovered-${i}`, role: m.role, content: stripFileBodies(m.content) }));

  const base: unknown[] = input.existing ? [...input.existing.messages] : history;
  const at = base.findIndex((m) => asStored(m)?.id === assistant.id);

  const done = (messages: unknown[]): RecoverableChat => ({
    serverChatId: input.serverChatId!,
    title: input.existing?.title ?? input.title,
    createdAt: input.existing?.createdAt ?? input.now,
    updatedAt: input.now,
    messages,
  });

  /* This turn's reply is already stored (the detached request wrote it): replace it — never with less. */
  if (at >= 0) {
    if (!hasReply) {
      return null;
    }

    const stored = asStored(base[at])!;

    if (String(stored.content ?? '').length > assistant.content.length) {
      return null;
    }

    if (
      stored.content === assistant.content &&
      JSON.stringify(stored.annotations ?? []) === JSON.stringify(assistant.annotations ?? [])
    ) {
      return null;
    }

    const messages = [...base];
    messages[at] = assistant;

    return done(messages);
  }

  const userId = input.userMessage?.id;
  const userAt = userId ? base.findIndex((m) => asStored(m)?.id === userId) : -1;

  /* The client already saved this turn (its user message is stored with something after it). */
  if (userAt >= 0 && userAt < base.length - 1) {
    return null;
  }

  const messages = [...base];

  if (input.userMessage && userAt < 0 && (hasReply || input.didWork || input.userMessage.content.trim())) {
    messages.push({ id: userId ?? `${assistant.id}-user`, role: 'user', content: input.userMessage.content });
  }

  if (hasReply) {
    messages.push(assistant);
  }

  return messages.length > base.length ? done(messages) : null;
}
