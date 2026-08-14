// @vitest-environment jsdom
/**
 * The build shows EVERY step (§4.4e, owner 2026-08-14).
 *
 * *"If you are going to show these Steps… YOU MUST SHOW ALL STEPS, so the user knows what is going on.
 * Including the first and last steps... all of them."*
 *
 * The failure this closes: the only trace of a phased build on screen was the short user message each
 * phase carries. The FRONT-END phase rides the user's own message and therefore has none — so the
 * first thing anyone ever saw was `Step 2 of 4`, with no list to belong to and no step 1 anywhere.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { advanceCreationPlan, newCreationPlan, type CreationPlan } from '~/lib/agent/creation-plan';
import { newProjectModeStore } from '~/lib/stores/new-project-mode';

/*
 * `useChatHistory` reaches the workbench, which boots a sandbox at module scope. Only `projectId` is
 * needed here, so it is stubbed with a real atom — the component genuinely subscribes to it, which is
 * what the "renders nothing for a DIFFERENT project" case exercises.
 */
const history: { projectId: ReturnType<typeof import('nanostores').atom<string | undefined>> } = {} as never;

vi.mock('~/lib/persistence/useChatHistory', async () => {
  const { atom: makeAtom } = await import('nanostores');
  history.projectId = makeAtom<string | undefined>(undefined);

  return { projectId: history.projectId };
});

const { CreationPlanCard } = await import('./CreationPlanCard');

const PROJECT = 'prj_1';

function planAt(n: number): CreationPlan {
  let plan = newCreationPlan();

  for (let i = 0; i < n; i++) {
    plan = advanceCreationPlan(plan, {
      id: plan.phases[plan.next],
      generationId: `gen_${i}`,
      at: '2026-08-14T00:00:00.000Z',
      state: 'finished',
    });
  }

  return plan;
}

function mount(plan: CreationPlan | undefined, pid: string | undefined = PROJECT) {
  history.projectId.set(pid);
  newProjectModeStore.set({ projectId: PROJECT, userPrompt: 'a kart racer', ...(plan ? { plan } : {}) });

  return render(<CreationPlanCard />);
}

afterEach(() => {
  cleanup();
  newProjectModeStore.set(null);
  history.projectId.set(undefined);
});

describe('CreationPlanCard', () => {
  /**
   * 🔴 THE REPORTED BUG. On the very first phase every step must already be on screen — including the
   * one running, which is the one that never announces itself in the chat.
   */
  it('shows EVERY step from the first phase, numbered from one', () => {
    mount(planAt(0));

    const steps = newCreationPlan().phases.length;

    for (let n = 1; n <= steps; n++) {
      expect(screen.getByText(new RegExp(`^${n}\\.`))).toBeTruthy();
    }

    expect(screen.getByText(/Step 1\b/)).toBeTruthy();
  });

  /**
   * 🔴 NO "of N" ANYWHERE (owner, 2026-08-14): *"no need `of 3` part"* — the card and the phase message
   * say it the same way, and the card's LIST is what tells the user how long the build is.
   *
   * Asserted over the whole card rather than the counter alone: the total was on screen twice, and
   * fixing the string a test names while leaving the other is how half a rename ships.
   */
  it('shows the ordinal without a total', () => {
    const { container } = mount(planAt(1));

    expect(screen.getByText(/Step 2\b/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/Step \d+ of/);
  });

  it('names the step actually running, in the present tense', () => {
    mount(planAt(0));
    expect(screen.getByText('Designing your front end')).toBeTruthy();

    cleanup();
    mount(planAt(1));
    expect(screen.getByText('Generating your artwork')).toBeTruthy();
  });

  /** The list keeps its shape as the build advances — done stays visible, pending stays visible. */
  it('still shows the finished steps and the ones still to come', () => {
    mount(planAt(1));

    const steps = newCreationPlan().phases.length;

    for (let n = 1; n <= steps; n++) {
      expect(screen.getByText(new RegExp(`^${n}\\.`))).toBeTruthy();
    }

    expect(screen.getByText(/Step 2\b/)).toBeTruthy();
  });

  describe('when it must render nothing', () => {
    /* A project with no plan is the handoff card's job — the two are exact complements. */
    it('renders nothing without a plan', () => {
      const { container } = mount(undefined);
      expect(container.firstChild).toBeNull();
    });

    it('renders nothing once the plan is complete', () => {
      const { container } = mount(planAt(newCreationPlan().phases.length));
      expect(container.firstChild).toBeNull();
    });

    /**
     * 🔴 A module-level store survives an SPA navigate, so without the project check a plan would
     * follow the user into a different project and narrate a build that is not happening there.
     */
    it('renders nothing for a DIFFERENT project', () => {
      const { container } = mount(planAt(0), 'prj_other');
      expect(container.firstChild).toBeNull();
    });
  });
});

/**
 * 🔴 THE TWO CARDS ARE EXACT COMPLEMENTS (2026-08-14).
 *
 * `BaseChat` renders both in the same slot with a comment saying they never appear together. That has
 * to be a PROPERTY, not a claim: the mode used to be cleared by the send, so "a mode exists" and
 * "nothing has been built" were one fact — under phases the mode outlives the send carrying the plan,
 * and the handoff card would have sat above the progress card for the whole build, offering to build
 * a game that was three steps into being built.
 *
 * Asserted over the plan/no-plan pair rather than by rendering `BaseChat`, which would need the whole
 * chat harness to say something this simple.
 */
describe('CreationHandoffCard and CreationPlanCard never stack', () => {
  it('a mode with NO plan shows the handoff card and not the plan card', async () => {
    const { CreationHandoffCard } = await import('./CreationHandoffCard');

    history.projectId.set(PROJECT);
    newProjectModeStore.set({ projectId: PROJECT, userPrompt: 'a kart racer' });

    const handoff = render(<CreationHandoffCard />);
    expect(handoff.container.firstChild).not.toBeNull();
    cleanup();

    const plan = render(<CreationPlanCard />);
    expect(plan.container.firstChild).toBeNull();
  });

  it('a mode WITH a plan shows the plan card and not the handoff card', async () => {
    const { CreationHandoffCard } = await import('./CreationHandoffCard');

    history.projectId.set(PROJECT);
    newProjectModeStore.set({ projectId: PROJECT, userPrompt: 'a kart racer', plan: planAt(0) });

    const handoff = render(<CreationHandoffCard />);
    expect(handoff.container.firstChild).toBeNull();
    cleanup();

    const plan = render(<CreationPlanCard />);
    expect(plan.container.firstChild).not.toBeNull();
  });
});
