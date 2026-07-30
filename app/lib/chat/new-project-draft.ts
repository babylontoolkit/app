/**
 * THE CARRIED PROMPT — how the user's own words get into the chat box (§4.4a, T8).
 *
 * ## What changed, and why the shape did with it
 *
 * The first version of this ran at the END OF CREATION: the splash came down and the words the user had
 * typed a minute earlier silently reappeared in the textbox. Owner, on seeing it: *"it kind of feels
 * disconnected to the initial project creation process."* Correct — text that arrives in a box nobody
 * typed into reads as leftover state, not as the next step. The words are carried by the HANDOFF CARD
 * now (`creation-handoff.ts`), and they only reach the box when the user asks for them: **Edit brief**
 * (fill and focus), the card's **X** (fill, but leave focus alone), or **Describe your game** on the
 * card path (focus an empty box).
 *
 * Those three are the same two statements in different combinations, which is exactly the kind of thing
 * that drifts apart when it is written out three times in a 2,000-line component. So the caller says
 * WHAT it wants — text, focus — and the ordering hazard below is handled here, once.
 *
 * 🔴 **THE ORDER IS THE FEATURE.** `clearDraftPrompt()` forgets the draft everywhere it lives — the
 * pending debounced cookie write (which fires up to a second LATER and would otherwise resurrect the
 * old text), the cookie itself, and the controlled input. A prefill written before it is silently
 * wiped, and worse, wiped by a timer rather than by the next statement, so it survives a casual read of
 * the code. `applyCreationDraft` therefore owns both halves and always clears first.
 *
 * What is carried is the user's OWN words, never the machine's: `visiblePrompt` when the two diverge
 * (the wizard compiles a long brief and shows a short line in its place, `project.ts`), otherwise
 * `prompt`. The creation BRIEF — play contract, scaffolded class, images on disk — is not part of this
 * at all; it rides hidden on the send (`new-project-mode.ts`).
 */

/** The fields of `ProjectSeed` this decision reads. Structural on purpose — the tests pass literals. */
export interface DraftSeed {
  /** What was seeded. On the wizard path this is the compiled brief, which is NOT what a textbox holds. */
  prompt?: string;

  /** What the user actually typed, when that differs from `prompt`. Preferred whenever present. */
  visiblePrompt?: string;
}

/**
 * The user's own words for this seed, or `''` for the card path — a picked card involves no typed words,
 * and inventing some ("build a racing game") would put the machine's phrasing in the user's mouth.
 *
 * Read once at creation to fill `NewProjectMode.userPrompt`, which is what the card and every action
 * below then operate on. The seed itself is in-memory and does not survive a reload; the mode does.
 */
export function draftTextForSeed(seed: DraftSeed | null | undefined): string {
  const text = seed?.visiblePrompt ?? seed?.prompt ?? '';
  return text.trim().length === 0 ? '' : text;
}

export interface CreationDraftDeps {
  /** Forget the draft everywhere (`clearDraftPrompt`). ALWAYS called, and always first. */
  clearDraft: () => void;

  /** Put the text in the box and persist it, so it survives a reload before the user sends. */
  applyDraft: (text: string) => void;

  /** Focus the textarea and put the caret at `caret`. */
  focusDraft: (caret: number) => void;
}

export interface CreationDraftOptions {
  /**
   * Should the caret end up in the box?
   *
   * `true` for **Edit brief** and **Describe your game** — the user asked to type, so taking focus is
   * the point (and on the empty card path focus is the ONLY thing that happens). `false` for the card's
   * **X**: dismissing a panel is not a request to start typing, and stealing focus there would scroll a
   * fresh project's chat box into view for a user who has just said "not now".
   */
  focus?: boolean;
}

/**
 * Put `text` in the chat box. Returns the text that was applied (`''` when there was none).
 *
 * Callers do not get to choose the order: clear, then apply, then focus. An empty `text` applies
 * nothing — there is no reason to write `''` over an input the clear has already emptied — but it can
 * still take focus, which is what the card path's **Describe your game** is.
 */
export function applyCreationDraft(
  text: string | null | undefined,
  deps: CreationDraftDeps,
  options: CreationDraftOptions = {},
): string {
  deps.clearDraft();

  const draft = text ?? '';

  if (draft) {
    deps.applyDraft(draft);
  }

  if (options.focus !== false) {
    deps.focusDraft(draft.length);
  }

  return draft;
}
