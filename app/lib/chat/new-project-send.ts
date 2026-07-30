/**
 * THE FIRST BUILD TURN — the user's words, plus the brief they never see (§4.4a, T10).
 *
 * Creation is a clone now, so the machine-written creation brief (the play contract, the class that was
 * actually scaffolded, the images actually on disk, the landing/chrome instruction) has no generation to
 * ride on at creation time. It rides on the FIRST message the user sends instead — appended hidden,
 * exactly as it was before, so the transcript still shows only what the user actually wrote.
 *
 * ## Why this is a pure function rather than four lines inside `sendMessage`
 *
 * It decides what reaches the model on the most expensive turn in the product. That is the same category
 * as `decideCredits` and `auto-repair`: logic that spends real money, whose failures are silent. Two of
 * them in particular:
 *
 *   - **A dropped marker.** `CREATION_BRIEF_MARKER` is how the server recognises a first build turn, and
 *     TEN behavioural protections hang off that one string — the premium/Fable-5 lock (whose absence is
 *     a MEASURED gateway timeout on a creation-sized artifact), the `bt-landing`+`bt-design` preload
 *     (whose absence restores the 29,173-token draft-reload-redraft pathology), the bounded media-only
 *     tool loop, `requiresAction`, the liveness copy. Lose it and everything still "works", worse and
 *     more expensively, with nothing throwing.
 *   - **A double-append.** Two sends, or one send composed twice, put the brief in the conversation
 *     twice — and the conversation is UNCACHED and re-sent at full rate on every later turn, forever.
 *     The caller guards this by clearing the mode before posting; this function additionally cannot
 *     invent a brief it was not given.
 *
 * ## Shape
 *
 * Two messages, not one concatenated blob: the visible message must be byte-exactly what the user typed
 * (it is what the sidebar title, the transcript and every later turn's history show), and the hidden one
 * carries `annotations: ['hidden']` — the same shape creation used to commit directly, understood by
 * `Messages.client.tsx` — while still being an ordinary user message on the wire, which is what the
 * server's marker sniff reads.
 */

/** One composed message. Deliberately not the AI SDK's `Message` — this module decides text, not ids. */
export interface ComposedMessage {
  content: string;

  /** `['hidden']` on the brief; absent on the user's own words. */
  annotations?: string[];
}

export interface ComposeNewProjectTurnInput {
  /** Exactly what will be shown as the user's message — already carrying any model/provider preamble. */
  userText: string;

  /** The creation brief, built at creation time and carried in New Project mode. */
  brief: string;
}

/**
 * Compose the first build turn.
 *
 * Never alters `userText` — not trimmed, not prefixed, not summarised. Skips either message when its
 * text is empty: an empty visible message would put a blank bubble in the transcript and make the
 * project's own title derive from nothing, and an empty hidden message would spend a wire slot on
 * nothing at all.
 */
export function composeNewProjectTurn({ userText, brief }: ComposeNewProjectTurnInput): ComposedMessage[] {
  const messages: ComposedMessage[] = [];

  if (userText.length > 0) {
    messages.push({ content: userText });
  }

  if (brief.trim().length > 0) {
    messages.push({ content: brief, annotations: ['hidden'] });
  }

  return messages;
}
