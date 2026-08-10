// @vitest-environment jsdom
/**
 * THE HANDOFF CARD, RENDERED (§4.4a).
 *
 * The card is the seam between "your project exists and runs" and "build my game". Everything worth
 * testing about it is a rule that fails SILENTLY — nothing here throws when it breaks, the card simply
 * offers the wrong thing to the wrong project, or ends the "created, never built" state early on the
 * most expensive turn in the product.
 *
 * The five rules pinned here:
 *
 *   1. **It belongs to ONE project.** `newProjectModeStore` is module-level, and module-level state
 *      survives an SPA navigate — that is the inherited-identity class of bug §4.5.6 records twice. A
 *      card that followed the user into a finished project would offer to rebuild it from a brief
 *      describing a different game.
 *   2. **The brief is SHOWN, byte-exact.** Build sends these words and only these words (the hidden
 *      machine-written brief was retired 2026-08-08), and the user is entitled to read them before
 *      pressing a button that spends credits.
 *   3. **Dismissing the CARD is not leaving the MODE.** `dismissCreationHandoff` hides one panel;
 *      `newProjectModeStore` keeps the mode, which is what still carries the user's only copy of their
 *      prompt, holds the premium pill locked (paid rungs are edit-only) and arms the game-ready toast.
 *      Collapse the two and the most casual gesture on screen quietly takes all three.
 *   4. **No Build without words.** On the describe path a Build button would post an empty turn or invite
 *      the model to invent a brief.
 *   5. **Plan is Edit with a prefix, and it sends nothing.** It hands the box `/bt-plan <brief>` for the
 *      user to read, edit and post themselves.
 *
 * ⚠️ `useChatHistory` is the builder's whole persistence module; importing it for real would drag the
 * WebContainer boot and IndexedDB into a unit test. Only the `projectId` atom is needed — same mock the
 * sibling store specs use.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const history = vi.hoisted(() => ({ projectId: null as any }));

vi.mock('~/lib/persistence/useChatHistory', async () => {
  const { atom: makeAtom } = await import('nanostores');
  history.projectId = makeAtom<string | undefined>(undefined);

  return { projectId: history.projectId };
});

/*
 * 🔴 THE CARD NO LONGER TOUCHES THE PERSISTENCE LAYER (owner, 2026-08-09). The third button used to be
 * the header chip's save action, so this file doubled `~/lib/persistence` in order to prove that merely
 * rendering the card pushed nothing to anybody's repository. That button is now **Plan my brief**, which
 * writes text into the chat box and nothing else. The mocks are deleted rather than left standing: a
 * double for a seam the component no longer has is a test that passes for a reason that stopped being
 * true, which is how this file's sibling specs have gone quietly vacuous before.
 */
import { projectId } from '~/lib/persistence/useChatHistory';
import {
  enterNewProjectMode,
  newProjectModeStore,
  readNewProjectMode,
  type NewProjectMode,
} from '~/lib/stores/new-project-mode';
import { CreationHandoffCard } from './CreationHandoffCard';

const PID = 'proj_kart_racer';

/** Multi-line and padded on purpose: what the card shows and what Build sends must be these exact bytes. */
const TYPED = '\n  a kart racer\n\n  with boost pads on the second lap  \n';

function mode(overrides: Partial<NewProjectMode> = {}): NewProjectMode {
  return { projectId: PID, userPrompt: TYPED, ...overrides };
}

const buildButton = () => screen.queryByRole('button', { name: /build my game/i });
const editButton = () => screen.queryByRole('button', { name: /edit my brief/i });
const planButton = () => screen.queryByRole('button', { name: /plan my brief/i });
const describeButton = () => screen.queryByRole('button', { name: /describe your game/i });
const closeButton = () => screen.queryByRole('button', { name: /close/i });

/** The card's only identifying landmark that is not a class name. */
const card = () => screen.queryByRole('heading', { name: /your project is ready/i });

let onBuild: ReturnType<typeof vi.fn>;
let onEdit: ReturnType<typeof vi.fn>;
let onPlan: ReturnType<typeof vi.fn>;
let onDismiss: ReturnType<typeof vi.fn>;

function renderCard() {
  return render(<CreationHandoffCard onBuild={onBuild} onEdit={onEdit} onPlan={onPlan} onDismiss={onDismiss} />);
}

beforeEach(() => {
  localStorage.clear();
  newProjectModeStore.set(null);
  projectId.set(PID);
  onBuild = vi.fn();
  onEdit = vi.fn();
  onPlan = vi.fn();
  onDismiss = vi.fn();
});

afterEach(() => {
  cleanup();
  newProjectModeStore.set(null);
  projectId.set(undefined);
  localStorage.clear();
  vi.clearAllMocks();
});

describe('CreationHandoffCard — whose card is this', () => {
  it('renders for the project that is open', () => {
    enterNewProjectMode(mode());
    renderCard();

    expect(card()).toBeInTheDocument();
  });

  /*
   * 🔴 The second wall. The store is hydrated per mount, but it is module-level and an SPA navigate
   * unloads nothing — so a mode left over from another project must never draw a card here. The failure
   * is not a stray panel: pressing Build on it would send ANOTHER game's brief into this project.
   */
  it('renders nothing when the mode belongs to a different project', () => {
    enterNewProjectMode(mode({ projectId: 'proj_someone_elses_game' }));
    projectId.set(PID);
    renderCard();

    expect(card()).not.toBeInTheDocument();
    expect(buildButton()).not.toBeInTheDocument();
  });

  /* CONTROL: without this, every assertion above passes for a component that renders nothing, ever. */
  it('renders nothing for an ordinary project that was never in New Project mode', () => {
    renderCard();

    expect(card()).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('CreationHandoffCard — the build path', () => {
  beforeEach(() => {
    enterNewProjectMode(mode());
  });

  /*
   * The user is about to press a button that spends credits. They must be able to read what it sends —
   * and read it unedited, since `whitespace-pre-wrap` means the card is showing the literal bytes.
   */
  it('shows the brief on the card, byte-exact', () => {
    const { container } = renderCard();

    // The blockquote is the semantic element holding the quoted brief, not a styling hook.
    expect(container.querySelector('blockquote')?.textContent).toBe(TYPED);
  });

  it('sends the exact typed prompt when Build my game is pressed', () => {
    renderCard();
    fireEvent.click(buildButton()!);

    expect(onBuild).toHaveBeenCalledTimes(1);
    expect(onBuild).toHaveBeenCalledWith(TYPED);
  });

  /*
   * Build does NOT dismiss. The mode is cleared by the SEND, not by the card — a build that fails is one
   * the user retries, and a card that had already torn itself down would leave them looking at an
   * ordinary chat box with no sign that the brief is still pending.
   */
  it('leaves the card standing after Build — the send clears the mode, not the card', () => {
    renderCard();
    fireEvent.click(buildButton()!);

    expect(card()).toBeInTheDocument();
    expect(newProjectModeStore.get()?.handoffDismissed).not.toBe(true);
  });

  it('hands the prompt to the chat box and closes the card when Edit brief is pressed', () => {
    renderCard();
    fireEvent.click(editButton()!);

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith(TYPED);
    expect(card()).not.toBeInTheDocument();
  });

  /*
   * 🔴 PLAN IS EDIT WITH A PREFIX (owner, 2026-08-09).
   *
   * It hands the box a `/bt-plan` command instead of sending anything, so the user can read it, edit it
   * further, and press enter themselves. The two things that fail silently here: sending it (a card
   * button that spends credits without the user pressing send is the thing Build exists to be), and
   * losing the brief off the end of the command — the whole point is that the plan is planned FROM the
   * user's own words.
   */
  it('hands the chat box a /bt-plan command carrying the brief, and sends nothing', () => {
    renderCard();
    fireEvent.click(planButton()!);

    expect(onPlan).toHaveBeenCalledTimes(1);
    expect(onPlan).toHaveBeenCalledWith(`/bt-plan ${TYPED.trim()}`);
    expect(onBuild).not.toHaveBeenCalled();
    expect(card()).not.toBeInTheDocument();
  });

  /*
   * 🔴 PLAN IS ITS OWN ACTION, NOT `onEdit` WITH DIFFERENT TEXT (owner, 2026-08-09): *"WE NEED To ALSO
   * SWITCH TO PLAN MODE. That is the whole point as well."* The prefix asks the skill to plan; §4.2.9's
   * Plan mode is what makes the turn read-only. Routing this through `onEdit` would compose the right
   * command and leave the chat in Build — a turn free to rewrite the project while the user believes
   * they asked for a plan, and nothing on screen or in the reply would say otherwise.
   */
  it('does NOT route Plan through the Edit handler — the mode switch rides on its own callback', () => {
    renderCard();
    fireEvent.click(planButton()!);

    expect(onEdit).not.toHaveBeenCalled();
  });

  /*
   * The command line is TRIMMED where the quoted brief is not. `TYPED` starts with a newline — the
   * landing-page box hands those back routinely — and an untrimmed prefix leaves `/bt-plan` alone on the
   * first line, reading in the chat box as if the command had lost its argument.
   */
  it('does not leave the command dangling on its own line', () => {
    renderCard();
    fireEvent.click(planButton()!);

    expect(onPlan.mock.calls[0][0]).toMatch(/^\/bt-plan a kart racer/);
  });

  it('closes the card and reports the prompt when X is pressed', () => {
    renderCard();
    fireEvent.click(closeButton()!);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith(TYPED);
    expect(card()).not.toBeInTheDocument();
  });

  /*
   * 🔴 Dismissing the CARD is not leaving the MODE. The project is still unbuilt and the carried prompt
   * must survive — `dismissCreationHandoff` is deliberately not `exitNewProjectMode`.
   */
  it.each([
    ['Edit brief', () => fireEvent.click(editButton()!)],
    ['Plan brief', () => fireEvent.click(planButton()!)],
    ['X', () => fireEvent.click(closeButton()!)],
  ])('keeps the mode (and its carried prompt) alive after %s', (_label, press) => {
    renderCard();
    press();

    expect(newProjectModeStore.get()).toMatchObject({ projectId: PID });
    expect(readNewProjectMode(PID, localStorage)?.userPrompt).toBe(TYPED);
  });

  /*
   * 🔴 THE DISMISSAL IS A SESSION FACT, AND THE CARD COMES BACK (owner, 2026-07-29).
   *
   * It used to persist, which was the wrong shape: until the first build, this card IS the state of the
   * project — one action outstanding, and nothing else on screen says so. Persisting the dismissal is
   * right for a NAG; this is not one, because it ends by itself the moment the user builds. So `X` means
   * "hide it for now", and a reload (or another device) gets the card back with its brief.
   */
  it('does NOT persist the dismissal — a fresh mount shows the card again', () => {
    renderCard();
    fireEvent.click(closeButton()!);
    cleanup();

    expect(readNewProjectMode(PID, localStorage)?.handoffDismissed).not.toBe(true);

    // Re-mount exactly as a reload would: hydrate the store from storage, then render.
    newProjectModeStore.set(readNewProjectMode(PID, localStorage));
    renderCard();

    expect(card()).toBeInTheDocument();

    /* CONTROL — it really was closed before the remount, so this is about persistence, not the click. */
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('CreationHandoffCard — the describe path (a card was picked, nothing was typed)', () => {
  beforeEach(() => {
    enterNewProjectMode(mode({ userPrompt: undefined }));
  });

  /*
   * 🔴 The load-bearing one. There are no words, so there is nothing to send: a Build button here would
   * post an empty turn or quietly invent a brief on the user's behalf, on the most expensive generation
   * in the product. Neither throws.
   */
  it('offers no Build button anywhere — and nothing to plan either', () => {
    renderCard();

    expect(card()).toBeInTheDocument();
    expect(buildButton()).not.toBeInTheDocument();
    expect(editButton()).not.toBeInTheDocument();
    expect(planButton()).not.toBeInTheDocument();
    expect(onBuild).not.toHaveBeenCalled();
  });

  it('makes Describe your game the primary action and calls back with an empty prompt', () => {
    renderCard();

    expect(describeButton()).toBeInTheDocument();
    fireEvent.click(describeButton()!);

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith('');
    expect(onBuild).not.toHaveBeenCalled();
  });

  /* The user may still just close it — the describe path is an invitation, never a trap. */
  it('still offers X, and closing it keeps the mode', () => {
    renderCard();

    expect(closeButton()).toBeInTheDocument();
    fireEvent.click(closeButton()!);

    expect(onDismiss).toHaveBeenCalledWith('');
    expect(card()).not.toBeInTheDocument();
    expect(newProjectModeStore.get()).toMatchObject({ projectId: PID });
  });
});

/**
 * THE SHAPE OF THE ROW (owner, 2026-08-09 — replacing the baseline-save block this file used to hold).
 *
 * The third slot was the header chip's save action; it is **Plan my brief** now — *"I think I have enough
 * save to GitHub buttons"*. The property worth pinning is not the absence of that one button, which is a
 * negative that stays true by itself: it is the row's SIZE. §4.1a's whole record of the toolbar is that a
 * row grows one individually-reasonable control at a time, and a style — or a count — only looks wrong
 * next to its neighbours, which nothing in a code review shows you. So the count is asserted, and the
 * next addition has to be a deliberate edit to this number rather than an unremarked fourth button.
 */
describe('the action row', () => {
  beforeEach(() => {
    enterNewProjectMode(mode());
  });

  it('offers exactly three actions and the close button', () => {
    renderCard();

    const labels = screen
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent);

    expect(labels).toEqual(['Close', 'Build my game', 'Edit my brief', 'Plan my brief']);
  });
});
