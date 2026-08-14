/**
 * THE HANDOFF CARD — the seam between "your project exists" and "build my game" (§4.4a).
 *
 * ## Why this replaced a banner
 *
 * The first version of this moment was implicit: the splash came down, the user's words silently
 * reappeared in the chat box, and a banner described the situation in three bullet points. Owner:
 * *"instead of simply filling the chat box, which kind of feels disconnected to the initial project
 * creation process… maybe we can bring up a card."* The banner explained the state; it gave the flow no
 * forward edge, and the reappearing text read as leftover state rather than as the next step.
 *
 * The card encodes the asymmetry the owner named: **creation is the heavy step that must not fail; the
 * brief is cheap and re-runnable.** *"If it craps during project creation the whole thing is fucked. If
 * something goes wrong with the brief we can easily fix it with a prompt and not have to go through the
 * heavy project creation process."* So the two halves are separated by a deliberate press, and the half
 * that is easy to redo is the one behind the button.
 *
 * It REPLACES the banner rather than joining it — two panels explaining one moment is the stacking
 * problem `NewChatIntro` already had to be gated against.
 *
 * ## The rules it is holding
 *
 * 🔴 **The brief is SHOWN.** Build sends these words and only these words (the hidden machine-written
 * brief that used to ride with them was retired 2026-08-08, §4.4a) — they are the user's, and they are
 * entitled to read them before pressing a button that spends credits.
 *
 * 🔴 **No Build without words.** On the card path (a picked genre, an empty box) there is nothing to
 * continue. A Build button there would either post an empty turn or quietly invent a brief on the user's
 * behalf — so the primary becomes *Describe your game*, which just puts the caret in the box.
 * `decideCreationHandoff` owns that branch so it is testable without React.
 *
 * 🔴 **X hides the CARD, never the MODE.** `dismissCreationHandoff` is not `exitNewProjectMode`. The
 * mode is what says "created, never built", and three things read it after the card is gone: the carried
 * prompt (this card holds the only copy of it), the premium lock (every paid rung is edit-only, and a
 * first build on a buffered model dies at the gateway timeout), and the game-ready celebration, armed on
 * the send. Collapsing the two would put all of that behind the most casual gesture on the screen. Only
 * a SEND clears the mode.
 *
 * §4.1a house style, applied to a card rather than the toolbar: ONE accent-filled primary, everything
 * else the same shared secondary (a style only looks wrong next to its neighbours, which is why both
 * live in constants here rather than being re-typed per button), one X, and one caption line under the
 * row rather than beside it. The toolbar's "fill is reserved for the git chip and the ⋯ menu" rule is
 * about that ROW; this is the chat column, where the card is the only thing asking for a decision.
 *
 * ⚠️ `text-accent` (no shade) generates NO CSS — `uno.config.ts` defines `accent` as a shade map with no
 * `DEFAULT`, so the utility silently matches nothing. Use `text-accent-500`.
 */
import { useStore } from '@nanostores/react';
import { decideCreationHandoff, planCommandFor } from '~/lib/chat/creation-handoff';
import { projectId } from '~/lib/persistence/useChatHistory';
import { dismissCreationHandoff, newProjectModeStore } from '~/lib/stores/new-project-mode';

/**
 * The row's buttons SHARE THE WIDTH of the brief box above them (`flex-1`), rather than each being as
 * wide as its own label — owner's call, and it is what makes the card read as one block instead of a
 * panel with a ragged row bolted underneath. `min-w-0` + `whitespace-nowrap` keep a long provider label
 * ("Reconnect GitLab") from either overflowing or wrapping mid-row.
 */
const CARD_ROW_BUTTON = 'inline-flex flex-1 min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md ';

/**
 * The primary action — the ACCENT fill, not the pale house primary.
 *
 * `bg-bolt-elements-button-primary-background` is a tinted lavender that reads softer than the bordered
 * secondary beside it, which inverts the hierarchy: the one button worth pressing looked like the one
 * you could ignore. Same accent the ⋯ toolbar button wears (§4.1a) — that row's "fill is reserved for
 * two controls" rule is about the TOOLBAR; this is the chat column, where the card is the only thing
 * asking for a decision.
 */
const CARD_PRIMARY_BUTTON =
  CARD_ROW_BUTTON +
  'bg-accent-500 px-3 py-1.5 text-sm font-medium text-white ' +
  'hover:bg-bolt-elements-button-primary-backgroundHover transition-colors';

/**
 * Everything that is not the primary. One shared constant, imported rather than re-typed, for the reason
 * §4.1a records about the toolbar: the row grew a control at a time, each one individually reasonable,
 * and a style only looks wrong NEXT TO the others — which nothing in a code review shows you.
 */
const CARD_SECONDARY_BUTTON =
  CARD_ROW_BUTTON +
  'border border-bolt-elements-borderColor px-3 py-1.5 text-sm ' +
  'text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-3 ' +
  'hover:text-bolt-elements-textPrimary transition-colors';

interface CreationHandoffCardProps {
  /** Send the brief as the first build turn. Goes through the ordinary `sendMessage` — never a second send path. */
  onBuild?: (prompt: string) => void;

  /** Move the text into the chat box, focused, caret at the end. */
  onEdit?: (prompt: string) => void;

  /**
   * **Plan my brief** — the same fill-the-box-and-focus as `onEdit`, PLUS switching the chat into Plan
   * mode. Separate from `onEdit` because that second half is the point (§4.2.9): the `/bt-plan` command
   * asks the skill to plan, and Plan mode is what makes the turn actually read-only. The card does not
   * know what "Plan mode" is — it reports the choice, and `Chat.client` owns the mechanics.
   */
  onPlan?: (prompt: string) => void;

  /** The `X`: put the text in the box, but leave focus where it is. */
  onDismiss?: (prompt: string) => void;
}

export function CreationHandoffCard({ onBuild, onEdit, onPlan, onDismiss }: CreationHandoffCardProps) {
  const mode = useStore(newProjectModeStore);
  const pid = useStore(projectId);

  /*
   * The mode is keyed per project and hydrated on every mount, so the store already answers for the OPEN
   * project. The `pid` check is the second wall against the one failure that matters: a module-level
   * store survives an SPA navigate, and a card that followed the user into a project they had already
   * built would offer to build it again from a brief describing a different game.
   */
  /*
   * 🔴 `mode.plan` is the "the build has STARTED" half (§4.4e, 2026-08-14).
   *
   * The mode used to be cleared by the send, so "a mode exists" and "nothing has been built" were the
   * same fact. Under phases the mode OUTLIVES the send — it carries the plan, which is the only record
   * of which steps are still owed — so without this the card would sit above `CreationPlanCard` for
   * the whole build, offering to build a game that is three steps into being built.
   *
   * This is what makes BaseChat's "the two never render together" a property rather than a claim: the
   * handoff card is a mode with NO plan, the plan card is a mode WITH one, and the conditions are
   * exact complements.
   */
  if (!mode || !pid || mode.projectId !== pid || mode.handoffDismissed || mode.plan) {
    return null;
  }

  const handoff = decideCreationHandoff({ userPrompt: mode.userPrompt });

  const dismiss = () => {
    dismissCreationHandoff(pid);
  };

  /*
   * No top padding on the outer wrapper: the column already supplies `--panel-top-gap`, and a second one
   * here is the misalignment against the workspace panel that this card is meant to sit level with.
   */
  return (
    <div className="max-w-chat mx-auto w-full px-1">
      <div className="relative rounded-lg border border-accent-500/40 bg-bolt-elements-background-depth-2 p-4">
        <button
          type="button"
          onClick={() => {
            dismiss();
            onDismiss?.(handoff.prompt);
          }}
          aria-label="Close"
          title="Close — your brief stays with the project"
          className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md text-bolt-elements-textTertiary hover:bg-bolt-elements-background-depth-3 hover:text-bolt-elements-textPrimary transition-colors"
        >
          <div className="i-ph:x text-sm" />
        </button>

        <div className="flex items-center gap-2 mb-2">
          <div className="i-ph:sparkle-duotone text-lg text-accent-500" />
          <h2 className="text-sm font-semibold text-bolt-elements-textPrimary">Your project is ready</h2>
        </div>

        <p className="text-sm text-bolt-elements-textSecondary mb-3">
          The starter is installed and running in the preview — that is the stock template, not your game. Nothing has
          been built in it yet.
        </p>

        {handoff.kind === 'build' ? (
          <>
            <div className="mb-3">
              <div className="text-xs uppercase tracking-wide text-bolt-elements-textTertiary mb-1">Your brief</div>
              <blockquote className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-3 py-2 text-sm text-bolt-elements-textPrimary">
                {handoff.prompt}
              </blockquote>
            </div>

            <div className="flex items-stretch gap-2">
              <button type="button" onClick={() => onBuild?.(handoff.prompt)} className={CARD_PRIMARY_BUTTON}>
                <div className="i-ph:paper-plane-tilt-duotone text-base" />
                Build my game
              </button>

              <button
                type="button"
                onClick={() => {
                  dismiss();
                  onEdit?.(handoff.prompt);
                }}
                className={CARD_SECONDARY_BUTTON}
              >
                <div className="i-ph:pencil-simple-duotone text-base" />
                Edit my brief
              </button>

              {/*
               * 🔴 PLAN, NOT SAVE (owner, 2026-08-09). *"I think I have enough save to GitHub buttons."*
               * The third slot used to hold the header chip's save action; what this moment was actually
               * missing is a way to NOT one-shot the whole game.
               *
               * 🔴 **It switches the chat into Plan mode, and that is half the point** (owner, same day —
               * *"WE NEED To ALSO SWITCH TO PLAN MODE. That is the whole point as well"*). The `/bt-plan`
               * prefix asks the skill to plan; §4.2.9's Plan mode is what makes the turn READ-ONLY, so
               * without it a first build turn holding a planning command is still a turn that may rewrite
               * the project. Prefix without mode is a request the pipeline is free to ignore.
               *
               * Still sends NOTHING — the box is filled and focused exactly as Edit does, so the user
               * reads the composed command, edits it if they want, and presses enter themselves.
               */}
              <button
                type="button"
                onClick={() => {
                  dismiss();
                  onPlan?.(planCommandFor(handoff.prompt));
                }}
                className={CARD_SECONDARY_BUTTON}
              >
                <div className="i-ph:list-checks-duotone text-base" />
                Plan my brief
              </button>
            </div>
          </>
        ) : (
          <div className="flex items-stretch gap-2">
            {/*
             * The card path: a genre was picked and nothing was typed. There is no brief to show and
             * nothing to continue, so the only action is to go and write one.
             */}
            <button
              type="button"
              onClick={() => {
                dismiss();
                onEdit?.('');
              }}
              className={CARD_PRIMARY_BUTTON}
            >
              <div className="i-ph:pencil-simple-duotone text-base" />
              Describe your game
            </button>
          </div>
        )}

        {/*
         * The captions for the row above — one line, under the buttons rather than beside them, with a
         * rule between (owner's call, on both counts).
         *
         * Side-by-side, a sentence long enough to be useful wraps and pushes the buttons out of
         * alignment, so the row's shape depended on how long the label happened to be. The separator is
         * what stops the captions reading as a third, unaligned column of the button row.
         *
         * The Plan caption is not decoration: a button that puts a slash command in the box and then
         * waits is the one action here whose effect is not obvious from its label, and the sentence has
         * to say both what it produces and that it does not build.
         */}
        <div className="mt-3 flex flex-col gap-0.5 border-t border-bolt-elements-borderColor pt-2 text-xs text-bolt-elements-textTertiary">
          {handoff.kind === 'describe' && <span>Tell it what to build — that message is the brief.</span>}
          {handoff.kind === 'build' && (
            <span>
              Plan turns your brief into an ordered list of tasks first, instead of building it all in one go.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
