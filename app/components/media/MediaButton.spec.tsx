// @vitest-environment jsdom
/**
 * 🔴 THE MEDIA BUTTON IS GATED ON THE GATEWAY — BUT ONLY ONCE THE SESSION HAS ANSWERED (2026-08-11).
 *
 * A deployment can serve no media at all: `LLM_PROVIDER=Anthropic` with no `MEDIA_PROVIDER` makes
 * `getMediaProvider` return null, and `/api/me` reports `media.provider: null`. The button rendered
 * anyway, opening a panel that drew KIE's catalogue and refused at quote time — an advertised
 * capability that could not be delivered, discovered only after the user had composed a request.
 *
 * ## Why `session.loading` is half the rule, and the half worth testing hardest
 *
 * ⚠️ THE TWO NULLS ARE NOT THE SAME NULL. `media.provider` is null BEFORE `/api/me` answers as well as
 * when there is genuinely no gateway. Gating on the provider alone would therefore hide this button on
 * EVERY page load and pop it back in a moment later — the toolbar resize §4.1a forbids outright ("a
 * right-aligned toolbar must not RESIZE when the preview boots"; measured there at 486px of drift).
 * `loading` is what separates "we do not know yet" from "we asked and the answer is none".
 *
 * That is the same distinction `mount-source.ts` records as `undefined` (could not ask) vs `null`
 * (asked, the answer is empty), and collapsing it is how the fix for one defect ships another.
 *
 * ## Hidden, not disabled — deliberately the opposite of Share/Deploy
 *
 * Those two render disabled-not-absent because they become available a moment later, so the space has
 * to be held. This one never will on this deployment, and §4.1a's other half is that a permanently
 * disabled control "is a dead end, not a roadmap". So the assertions below check for ABSENCE, not for
 * `disabled` — a disabled Media button would satisfy a naive "the user cannot click it" test while
 * breaking the rule the component was written to follow.
 *
 * ## Route taken: this RENDERS the component
 *
 * The alternative was extracting the predicate to a pure `shouldOfferMedia(...)` and testing that.
 * Rejected: `@testing-library/react` and `jsdom` are both devDependencies here and sibling specs render
 * components (`ModelTierPill.spec.tsx`, `project-title.spec.tsx`), so extracting a two-line predicate
 * would add an indirection whose only purpose is to dodge a harness that already exists — and it would
 * leave the WIRING untested, which is where every defect in this repo has lived. `ModelTierPill.spec`
 * records this exact correction: a source scan justified by "this repo has no component-render harness"
 * that was simply untrue, and the weak assertion outlived the reason for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/*
 * `~/lib/persistence` boots the sandbox as an import side effect (the `sandbox-seam` rule), so it is
 * stubbed. The atom is created INSIDE the factory: `vi.mock` is hoisted above every import, so a
 * factory closing over a top-level `const` throws at collect time.
 */
vi.mock('~/lib/persistence', async () => {
  const { atom } = await import('nanostores');
  return { projectId: atom<string | undefined>('prj_media') };
});

/*
 * The real panel imports `~/lib/media/tasks`, which reaches `~/lib/stores/workbench` and boots a
 * sandbox on import. Stubbed to a marker: this file is about WHETHER the entry point is offered, and
 * the panel's own contents are covered by `media-panel-fields.spec.tsx`. The marker still lets the
 * click test prove the button is a live control rather than a shape that renders.
 */
vi.mock('./MediaPanel', () => ({
  MediaPanel: ({ projectId }: { projectId: string }) => <div data-testid="media-panel">{projectId}</div>,
}));

const { projectId: projectIdStore } = await import('~/lib/persistence');
const { MediaButton } = await import('./MediaButton');
const { EMPTY_SESSION, sessionStore } = await import('~/lib/stores/session');

/** The three facts this component reads, and nothing else. */
const session = (loading: boolean, provider: 'KIE' | 'Comet' | null, loadFailed = false) => ({
  ...EMPTY_SESSION,
  loading,
  loadFailed,
  media: { provider },
});

const mediaButton = () => screen.queryByRole('button', { name: 'Media' });

beforeEach(() => {
  projectIdStore.set('prj_media');
  sessionStore.set(session(false, 'KIE'));
});

afterEach(() => {
  cleanup();
  projectIdStore.set(undefined);
  sessionStore.set(EMPTY_SESSION);
  vi.clearAllMocks();
});

describe('MediaButton — offered only where media can actually be generated', () => {
  /**
   * 🔴 THE CONTROL, and every "is hidden" assertion below is worthless without it: a configured gateway
   * must OFFER the button.
   *
   * A component that returned `null` unconditionally — i.e. media generation removed from the product —
   * passes every absence assertion in this file. Both gateways are driven so the rule cannot narrow to
   * whichever one someone tested.
   */
  it('CONTROL — offers the button on a configured gateway', () => {
    for (const provider of ['KIE', 'Comet'] as const) {
      sessionStore.set(session(false, provider));

      const view = render(<MediaButton />);

      expect(mediaButton(), `${provider} must offer media generation`).not.toBeNull();
      view.unmount();
    }
  });

  /**
   * 🔴 THE REGRESSION TEST. A settled null means this deployment serves no renders, and the entry point
   * must not exist.
   *
   * Mutation that kills it: removing the `if (!sessionLoading && !media.provider) return null` guard,
   * which is the state the button shipped in — opening a panel offering nano-banana-2 and kling-3.0 on
   * a box that could serve neither.
   */
  it('hides the button once the session has settled with no gateway', () => {
    sessionStore.set(session(false, null));

    const { container } = render(<MediaButton />);

    expect(mediaButton()).toBeNull();

    /*
     * HIDDEN, NOT DISABLED (§4.1a — a permanently disabled control is a dead end). Asserting on the
     * container rather than only on the query is what distinguishes the two: a disabled button still
     * satisfies "the user cannot use it", and would pass a weaker test while breaking the rule.
     */
    expect(container.firstChild, 'a disabled Media button is the wrong fix — it renders NOTHING').toBeNull();
  });

  /**
   * 🔴 THE OTHER HALF, and the one a naive fix breaks. While `/api/me` is still in flight the provider
   * is null for a reason that has nothing to do with the deployment, and the button must hold its space.
   *
   * Mutation that kills it: gating on `!media.provider` alone (dropping the `!sessionLoading` term).
   * That reads as a tighter, more obviously correct guard, and it hides the button on EVERY page load
   * and pops it back in when the session lands — the §4.1a toolbar resize, reintroduced by the fix for
   * the test directly above.
   */
  it('offers the button while the session is still loading, so the toolbar cannot resize', () => {
    sessionStore.set(session(true, null));

    render(<MediaButton />);

    expect(mediaButton(), 'a null provider before /api/me has answered is "unknown", not "none"').not.toBeNull();
  });

  /**
   * 🔴 THE THIRD NULL, and the one the first fix got wrong (caught by the T9 verifier, not by any test
   * that existed at the time).
   *
   * `refreshSession` reports a FAILED `/api/me` — non-OK response or a network throw — as a fully empty
   * session with `loading: false`. So "we could not ask" arrives wearing the exact shape of "we asked
   * and this deployment has no gateway", and a guard reading only those two hides Media on a box where
   * media is configured. Worse than a page-load flicker: `usePromptEnhancer` refreshes the session
   * MID-SESSION, so the button vanishes out from under someone mid-edit and the toolbar resizes.
   *
   * Mutation that kills it: dropping the `!loadFailed` term from the guard — i.e. the state this file
   * shipped in before the verifier's report.
   */
  it('keeps offering the button when /api/me FAILED — "could not ask" is not "there is none"', () => {
    sessionStore.set(session(false, null, true));

    render(<MediaButton />);

    expect(
      mediaButton(),
      'a transient /api/me failure must not hide a capability the deployment actually has',
    ).not.toBeNull();
  });

  /**
   * CONTROL for the test above. Without it, `loadFailed` could be wired as "always show the button" and
   * the settled-null regression test would be the only thing objecting — this pins that the failure
   * flag is read as a THIRD state rather than as a blanket override.
   */
  it('still hides on a settled null even though loadFailed exists', () => {
    sessionStore.set(session(false, null, false));

    const { container } = render(<MediaButton />);

    expect(mediaButton()).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  /**
   * And it disappears when that same load settles on "no gateway" — the transition the two tests above
   * describe as endpoints, asserted as one sequence on one mounted component.
   *
   * This is what makes the pair non-vacuous: a component wired to the provider ALONE passes the settled
   * test, and one wired to nothing passes the loading test. Only a component reading both flips here.
   */
  it('goes from offered to absent as a load settles on no gateway', () => {
    sessionStore.set(session(true, null));

    const view = render(<MediaButton />);

    expect(mediaButton()).not.toBeNull();

    sessionStore.set(session(false, null));
    view.rerender(<MediaButton />);

    expect(mediaButton()).toBeNull();
  });

  /** CONTROL for the sequence above — a load settling on a REAL gateway keeps the button. */
  it('CONTROL — stays offered when the same load settles on a real gateway', () => {
    sessionStore.set(session(true, null));

    const view = render(<MediaButton />);
    sessionStore.set(session(false, 'Comet'));
    view.rerender(<MediaButton />);

    expect(mediaButton()).not.toBeNull();
  });

  /**
   * No project, no button — the bytes land IN a project, so there is nothing to generate into.
   *
   * Driven across all four gateway states because the project check is the FIRST return and would
   * otherwise be pinned only in whichever session state the test happened to use. Mutation that kills
   * it: removing the `if (!activeProjectId) return null` guard, which hands `MediaPanel` an undefined
   * project id and posts quotes to `/api/projects/undefined/media`.
   */
  it('hides the button with no active project, whatever the gateway says', () => {
    projectIdStore.set(undefined);

    for (const loading of [true, false]) {
      for (const provider of ['KIE', 'Comet', null] as const) {
        sessionStore.set(session(loading, provider));

        const view = render(<MediaButton />);

        expect(mediaButton(), `loading=${loading} provider=${provider} must offer nothing`).toBeNull();
        view.unmount();
      }
    }
  });

  /**
   * The button is a live control, not a shape that renders — it opens the panel for the ACTIVE project.
   *
   * Without this, every assertion in the file is satisfied by a `<button>` wired to nothing. It also
   * pins the project id reaching the panel, which is the value the quote and the debit are keyed on.
   */
  it('opens the panel for the active project when clicked', () => {
    render(<MediaButton />);

    expect(screen.queryByTestId('media-panel'), 'the panel must not mount until asked for').toBeNull();

    fireEvent.click(mediaButton()!);

    expect(screen.getByTestId('media-panel').textContent).toBe('prj_media');
  });
});
