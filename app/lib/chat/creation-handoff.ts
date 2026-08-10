/**
 * THE HANDOFF — what the card offers between "your project exists" and "build my game" (§4.4a).
 *
 * ## Why there is a card at all
 *
 * Creation is a clone now, so the moment it finishes is a genuine seam: a running starter, an empty
 * game, and a prompt the user typed a minute ago that nothing has done anything with yet. The first
 * shipped version handed that moment over implicitly — it put the words back in the chat box and left
 * a banner describing the situation. Owner, on seeing it: *"it kind of feels disconnected to the
 * initial project creation process."* Correct. The words reappearing in the box read as leftover
 * state rather than as the next step, and a panel that only DESCRIBES gives the flow no forward edge.
 *
 * The card is that forward edge, and it encodes the asymmetry the owner named: **creation is the heavy
 * step that must not fail; the brief is cheap and re-runnable.** *"If it craps during project
 * creation, the whole thing is fucked. If something goes wrong with the brief we can easily fix it
 * with a prompt."* So the two are separated by a deliberate action, and the cheap half is the one that
 * is easy to redo.
 *
 * ## Why the branch is a pure function
 *
 * Because there are two genuinely different situations and the difference is easy to get subtly wrong
 * in JSX. With typed words there is something to CONTINUE; on the card path with an empty box there is
 * nothing to send, and offering a "Build my game" button there would either post an empty turn or
 * quietly invent a brief on the user's behalf. Neither is acceptable, and neither would throw.
 */

/** The fields of the mode this decision reads. Structural so the tests can pass literals. */
export interface HandoffInput {
  /** The user's own words, if there were any (`NewProjectMode.userPrompt`). */
  userPrompt?: string;
}

export interface HandoffDecision {
  /**
   * `build` — there are words to send: offer the primary action that sends them.
   * `describe` — the card path with an empty box: there is nothing to continue, so the primary action
   * points the user at the chat box instead of pretending it can build from nothing.
   */
  kind: 'build' | 'describe';

  /**
   * The exact text the card displays and its actions operate on — never trimmed or reformatted, since
   * this is what gets sent and the user is entitled to see the bytes.
   */
  prompt: string;
}

/**
 * What the handoff card should offer.
 *
 * Whitespace-only counts as empty: a box holding a stray newline is not a brief, and "Build my game"
 * on it would spend a real generation on nothing.
 */
export function decideCreationHandoff({ userPrompt }: HandoffInput): HandoffDecision {
  const prompt = userPrompt ?? '';

  return prompt.trim().length > 0 ? { kind: 'build', prompt } : { kind: 'describe', prompt: '' };
}

/**
 * The slash command the card's **Plan my brief** action writes in front of the user's words (§4.4a).
 *
 * 🔴 **PLAN IS THE THIRD DOOR OUT OF THE CARD, AND IT REPLACED THE BASELINE SAVE (owner, 2026-08-09).**
 * *"I think I have enough save to GitHub buttons."* The card's third button was a duplicate of the
 * header chip's action — correct as REUSE, redundant as a place to put it — and the thing genuinely
 * missing from this moment was a way to NOT one-shot the whole game. A first build turn asked to write
 * the game, the landing page, the chrome and the docs is the run that hit the provider's output ceiling
 * (§4.4e); `bt-plan` turns the same brief into an ordered task list the user can then execute a step at
 * a time. So the choice on the card is now *build it* / *edit it* / *plan it*, which are three answers to
 * the one question the card asks, rather than two answers and a safeguard.
 *
 * ⚠️ **It fills the box; it does not send.** The user is expected to read the composed command, edit it
 * further if they want, and press enter themselves — same contract as *Edit my brief*, which is the
 * whole reason this is a prefix rather than a second send path.
 */
export const PLAN_SKILL_COMMAND = '/bt-plan';

/**
 * The user's brief, addressed to the planning skill.
 *
 * The brief is TRIMMED here and nowhere else. `decideCreationHandoff` deliberately preserves the exact
 * bytes — that text is what Build sends and what the card quotes — but this is a COMMAND LINE, and
 * `parseSlashInvocation` anchors on a leading `/` after trimming and then trims the args itself. So a
 * carried prompt that starts with a newline (the landing-page box hands those back routinely) would put
 * `/bt-plan` alone on the first line: identical on the wire, and it reads in the chat box as if the
 * command had lost its argument.
 *
 * An empty brief still yields the command plus its space, so the caret lands where the user types. It is
 * unreachable from the card today — the Plan button only exists on the `build` branch, which is defined
 * by having words — and it is here so this function can never be the thing that turns an empty box into
 * a bare `/bt-plan` invocation.
 */
export function planCommandFor(prompt: string): string {
  const brief = prompt.trim();

  return brief ? `${PLAN_SKILL_COMMAND} ${brief}` : `${PLAN_SKILL_COMMAND} `;
}

/** The fields of a registry row this reads. Structural so the tests need no fixture. */
export interface BriefSourceEntry {
  title?: string;
  description?: string;
  is_fallback?: boolean;
}

/**
 * The brief a GAME TYPE card carries, for a user who picked one and typed nothing.
 *
 * 🔴 **Picking a card IS a brief** (owner, 2026-07-29). The card path used to reach the handoff with no
 * words at all, so it offered *Describe your game* — asking the user to type out the thing they had
 * just chosen from a menu, which is the entire point of the quick-pick row inverted. *"The GAME TYPES
 * at the main menu should carry over and not have to describe the game."*
 *
 * This does NOT contradict the "never put the machine's phrasing in the user's mouth" rule that shaped
 * `decideCreationHandoff`. That rule is about INVENTING intent where none was expressed. Here the words
 * are the ones the user read on the card and clicked — the title and the description are the offer they
 * accepted, so echoing them back is a quotation, not a fabrication. It is also why the text is the
 * card's own copy verbatim rather than a nicer sentence written for the model: the brief the card shows
 * must be the thing the user believes they chose.
 *
 * ⚠️ **The FALLBACK row is excluded, deliberately.** "Blank Canvas — an empty scene, total creative
 * freedom" is the choice that means *I do not have a brief yet*, so turning it into one would build a
 * random game out of a request for a blank page. That path keeps *Describe your game*, which is the
 * correct answer there and the case the owner explicitly asked to preserve: *"a VERY KOOL FALLBACK for
 * when you DON'T HAVE A GAME BRIEF."*
 *
 * Returns `undefined` — never an empty string — so the caller passes nothing rather than passing blank
 * words, and `draftTextForSeed`'s existing emptiness rules keep working unchanged.
 */
export function briefFromRegistryEntry(entry: BriefSourceEntry): string | undefined {
  if (entry.is_fallback) {
    return undefined;
  }

  /*
   * ⚠️ BOTH FIELDS ARE READ DEFENSIVELY, and that is not paranoia about the TYPE — the registry is DATA
   * (`game-registry.json`, and an admin-editable row behind it), so a missing `description` is a content
   * mistake, not a compile error. The first draft called `.trim()` straight on it and a row without one
   * threw a `TypeError` inside `handleSelectEntry` — i.e. **clicking a card failed to create a project
   * at all**, turning a cosmetic gap in a card's copy into a total failure of the heavy step. Creation
   * is the one thing in this flow that must not fail (§4.4a); a brief is the cheap half.
   */
  const title = (entry.title ?? '').trim();
  const description = (entry.description ?? '').trim();

  if (!title) {
    return description || undefined;
  }

  return description ? `${title} — ${description}` : title;
}
