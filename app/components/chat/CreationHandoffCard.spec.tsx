// @vitest-environment jsdom
/**
 * THE HANDOFF CARD, RENDERED (§4.4a).
 *
 * The card is the seam between "your project exists and runs" and "build my game". Everything worth
 * testing about it is a rule that fails SILENTLY — nothing here throws when it breaks, the card simply
 * offers the wrong thing to the wrong project, or strips the hidden creation brief out of the most
 * expensive turn in the product.
 *
 * The four rules pinned here:
 *
 *   1. **It belongs to ONE project.** `newProjectModeStore` is module-level, and module-level state
 *      survives an SPA navigate — that is the inherited-identity class of bug §4.5.6 records twice. A
 *      card that followed the user into a finished project would offer to rebuild it from a brief
 *      describing a different game.
 *   2. **The brief is SHOWN.** Build sends the user's words plus a hidden machine-written brief; the
 *      words are theirs and they are entitled to read them before pressing a button that spends credits.
 *   3. **Dismissing the CARD is not leaving the MODE.** `dismissCreationHandoff` hides one panel;
 *      `newProjectModeStore` keeps the mode so the hidden brief still rides on the next message. Collapse
 *      the two and clicking `X` — the most casual gesture on screen — silently strips the play contract,
 *      the scaffolded class name and the on-disk image list out of the build turn, with nothing anywhere
 *      reporting why the output got worse.
 *   4. **No Build without words.** On the describe path a Build button would post an empty turn or invite
 *      the model to invent a brief.
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
 * The card offers the header chip's save action (`useSaveProject`), which reaches the whole persistence
 * layer. Doubled at the seam rather than mocked away: `requestSave` is the ONE writer that pushes to
 * somebody's own repository, so a test that renders this card must be able to prove it was not called.
 */
const persistence = vi.hoisted(() => ({
  requestSave: vi.fn(),
  startGitConnect: vi.fn(),
  repoStatus: null as any,
  unsavedWork: null as any,
  saveState: null as any,
}));

vi.mock('~/lib/persistence', async () => {
  const { atom: makeAtom } = await import('nanostores');
  persistence.repoStatus = makeAtom<any>({ linked: false, configuredProviders: ['github'] });
  persistence.unsavedWork = makeAtom<any>(false);

  return {
    /*
     * The SAME atom the `useChatHistory` mock exposes — production's index re-exports it, and two
     * separate atoms here would make the hook read `undefined` while the card reads a project, which is
     * a disagreement the real code cannot have.
     */
    projectId: history.projectId,
    repoStatus: persistence.repoStatus,
    unsavedWork: persistence.unsavedWork,
    requestSave: persistence.requestSave,
    startGitConnect: persistence.startGitConnect,
  };
});

vi.mock('~/lib/persistence/save-queue', async () => {
  const { atom: makeAtom } = await import('nanostores');
  persistence.saveState = makeAtom<any>({ status: 'idle' });

  return { saveState: persistence.saveState };
});

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
const describeButton = () => screen.queryByRole('button', { name: /describe your game/i });
const closeButton = () => screen.queryByRole('button', { name: /close/i });

/** The card's only identifying landmark that is not a class name. */
const card = () => screen.queryByRole('heading', { name: /your project is ready/i });

let onBuild: ReturnType<typeof vi.fn>;
let onEdit: ReturnType<typeof vi.fn>;
let onDismiss: ReturnType<typeof vi.fn>;

function renderCard() {
  return render(<CreationHandoffCard onBuild={onBuild} onEdit={onEdit} onDismiss={onDismiss} />);
}

beforeEach(() => {
  localStorage.clear();
  newProjectModeStore.set(null);
  projectId.set(PID);
  onBuild = vi.fn();
  onEdit = vi.fn();
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
  it('offers no Build button anywhere', () => {
    renderCard();

    expect(card()).toBeInTheDocument();
    expect(buildButton()).not.toBeInTheDocument();
    expect(editButton()).not.toBeInTheDocument();
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
 * THE BASELINE SAVE (owner, 2026-07-29).
 *
 * *"We should put some sort of Save project button that at least saves the core project to GitHub, so we
 * can easily reset from"* it. This is the only moment where the tree is exactly the pinned starter plus
 * one scaffolded class, so a commit here is a clean baseline — and it is also the moment the project is
 * least safe (unlinked, in a sandbox that can be reclaimed).
 *
 * What must not drift: it is the HEADER CHIP'S action, not a second one. Same hook, same tested
 * `actionLabel`, same single writer. A private save here would be a second thing called saving, which is
 * exactly how the header ended up with two adjacent buttons both labelled "Sync".
 */
describe('the baseline save row', () => {
  const saveButton = () => screen.queryByRole('button', { name: /commit changes|link|reconnect|try again/i });

  beforeEach(() => {
    projectId.set(PID);
    enterNewProjectMode(mode());

    /* Module-level atoms outlive a `cleanup()`, so a state one test sets is the next test's premise. */
    persistence.saveState.set({ status: 'idle' });
    persistence.repoStatus.set({ linked: false, configuredProviders: ['github'] });
  });

  it('offers the save action and routes it through the one writer', () => {
    renderCard();

    expect(saveButton()).toBeInTheDocument();
    fireEvent.click(saveButton()!);

    expect(persistence.requestSave).toHaveBeenCalledTimes(1);
    expect(persistence.requestSave).toHaveBeenCalledWith(PID, 'github');
  });

  /*
   * 🔴 Nothing pushes to somebody's repository without a press (owner, 2026-07-23). Rendering a card that
   * merely OFFERS to save must never be the thing that saves.
   */
  it('CONTROL — rendering the card pushes nothing', () => {
    renderCard();

    expect(persistence.requestSave).not.toHaveBeenCalled();
    expect(persistence.startGitConnect).not.toHaveBeenCalled();
  });

  /*
   * A permanently-dead row is a dead end, not a roadmap (§4.1a). `action: 'none'` is the "already saved,
   * nothing outstanding" state, and a greyed button there says less than no button at all.
   */
  it('disappears when there is nothing to press', () => {
    /* A save already in flight: `action: 'none'`, and a greyed button there says less than no button. */
    persistence.saveState.set({ status: 'saving' });
    renderCard();

    expect(card()).toBeInTheDocument();
    expect(saveButton()).not.toBeInTheDocument();
  });
});
