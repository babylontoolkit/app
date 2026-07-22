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
