// @vitest-environment jsdom
/**
 * THE PREMIUM LOCK, RENDERED (§4.6.1, §4.4a T13).
 *
 * Premium is EDIT-ONLY: on a first build turn the platform forces the standard model, because
 * KIE-buffered Fable 5 cannot flush a creation-sized artifact before the gateway timeout (`decidePremium`
 * `reason: 'creation_turn'`, and the measured 307.8s-of-reasoning / 0-text / `finish=error` run behind
 * it). The server is the authority and re-derives that on every generation — so a wrong answer HERE can
 * never buy premium. It can only lie to the user about the model their next build will run, in whichever
 * direction it is wrong: offer a toggle the server declines, or hide one they are entitled to.
 *
 * ## Why this file exists at all
 *
 * `first-build-turn.spec.ts` used to justify covering this component with a SOURCE SCAN, on the stated
 * grounds that "this repo has no component-render harness (no jsdom/testing-library in the vitest
 * setup)". That was simply untrue — `@testing-library/react` and `jsdom` are both dependencies and
 * sibling specs in this very directory render components. An independent verifier found it.
 *
 * The generalisable half is worth more than the fix: this repo has been here before. `shell-strip.ts`
 * shipped buffering every file until its close tag while its own doc comment claimed "the artifact still
 * streams to the user in real time" — and that false sentence is recorded as HOW the defect survived
 * review. A comment cannot fail, so a comment explaining why a weak assertion is the strongest available
 * one is load-bearing prose that nothing checks. When the justification is wrong, the weak assertion
 * outlives every reason to keep it.
 *
 * So: the lock is asserted by RENDERING. The scan in `first-build-turn.spec.ts` stays as the wiring
 * check it always was (that `Chat.client` writes the store), and the rule lives here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/*
 * The toast is the locked pill's ONLY output on a click — it is what tells the user why nothing
 * happened — so it is recorded rather than stubbed to a no-op.
 */
const toasts = vi.hoisted(() => ({ info: vi.fn(), warning: vi.fn() }));
vi.mock('react-toastify', () => ({ toast: toasts }));

import { PremiumToggle } from './PremiumToggle';
import { creationTurnStore } from '~/lib/stores/chat';
import { premiumModelStore } from '~/lib/stores/settings';
import { EMPTY_SESSION, sessionStore, type SessionState } from '~/lib/stores/session';

/** A credits user holding well above the premium threshold — the only state where the pill can unlock. */
const funded: SessionState = {
  ...EMPTY_SESSION,
  loading: false,
  authenticated: true,
  credits: {
    ...EMPTY_SESSION.credits,
    balance: 50_000,
    premium: { model: 'claude-fable-5', standardModel: 'claude-opus-5', minimumCredits: 1_200, available: true },
  },
};

const pill = () => screen.getByRole('button');

/** The pill NAMES the model actually in use, so the label is the honest read of "am I locked?". */
const label = () => pill().textContent ?? '';

/** The lock glyph the component renders for every ineligible state (`!eligible`). */
const locked = () => pill().querySelector('.i-ph\\:lock-simple') !== null;

beforeEach(() => {
  sessionStore.set(funded);
  premiumModelStore.set(false);
  creationTurnStore.set(false);
});

afterEach(() => {
  cleanup();
  sessionStore.set(EMPTY_SESSION);
  premiumModelStore.set(false);
  creationTurnStore.set(false);
  vi.clearAllMocks();
});

describe('PremiumToggle — the first-build lock', () => {
  /*
   * THE CONTROL, and the whole file depends on it: a funded, ordinary turn must be UNLOCKED. Without it
   * every assertion below is satisfied by a component that is permanently locked, or renders nothing.
   */
  it('CONTROL — a funded user on an ordinary turn gets an unlocked pill', () => {
    render(<PremiumToggle />);

    expect(locked()).toBe(false);
    expect(label()).toContain('Opus 5');
  });

  /**
   * 🔴 LOCKED IN NEW PROJECT MODE. This is the window T13 closed: the creation brief is appended at
   * SEND, so while the user edits the carried prompt nothing carries `CREATION_BRIEF_MARKER` yet —
   * `creationTurnStore` is true from the MODE (`isCreationTurn`'s `newProjectMode` key), and the pill
   * must be locked for exactly as long as the user is looking at it.
   */
  it('locks while the next turn is a first build', () => {
    creationTurnStore.set(true);
    render(<PremiumToggle />);

    expect(locked()).toBe(true);
    expect(label()).toContain('Opus 5');
    expect(label()).not.toContain('Fable');
  });

  /** And UNLOCKS after — the mode is cleared on send and the user's next turn is an ordinary edit. */
  it('unlocks once the first build turn is over', () => {
    creationTurnStore.set(true);

    const view = render(<PremiumToggle />);

    expect(locked()).toBe(true);

    creationTurnStore.set(false);
    view.rerender(<PremiumToggle />);

    expect(locked()).toBe(false);
  });

  /**
   * A locked pill must not TOGGLE. `premiumModelStore` is what the send path reads, so a click that
   * flipped it would put `premium: true` on the wire for a first build — declined server-side, but the
   * user would then see the model silently disagree with the pill for the rest of the session.
   */
  it('a click while locked explains the lock instead of switching model', () => {
    creationTurnStore.set(true);
    render(<PremiumToggle />);

    fireEvent.click(pill());

    expect(premiumModelStore.get()).toBe(false);
    expect(toasts.warning).not.toHaveBeenCalled();
    expect(toasts.info).toHaveBeenCalledTimes(1);

    /* The copy has to name the reason. "Not enough credits" here would be flatly wrong and unfixable. */
    expect(String(toasts.info.mock.calls[0][0])).toMatch(/creation/i);
    expect(String(toasts.info.mock.calls[0][0])).not.toMatch(/credits\./i);
  });

  it('CONTROL — the same click on an ordinary turn really does switch to premium', () => {
    render(<PremiumToggle />);

    fireEvent.click(pill());

    expect(premiumModelStore.get()).toBe(true);
    expect(toasts.warning).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 THE LOCK OUTRANKS AN ALREADY-ON TOGGLE. A user who enabled premium, then created a new project,
   * arrives at the first build with `premiumModelStore === true`. `active` is `enabled && eligible`, so
   * the pill must fall back to the standard model rather than showing an accented "Fable 5" it cannot
   * honour — the one state where a stale preference and a hard rule disagree.
   */
  it('shows the STANDARD model on a first build even when premium was already enabled', () => {
    premiumModelStore.set(true);
    creationTurnStore.set(true);
    render(<PremiumToggle />);

    expect(locked()).toBe(true);
    expect(label()).toContain('Opus 5');
    expect(label()).not.toContain('Fable');
  });

  /**
   * The OTHER lock reason must still work and must still read differently. Both states render the same
   * glyph, and the tooltip/toast is the only thing that tells a user whether to add credits or wait —
   * a first-build lock that said "unlocks at 1,200 credits" would send a funded user to the billing page.
   */
  it('distinguishes the threshold lock from the first-build lock in its tooltip', () => {
    creationTurnStore.set(true);
    render(<PremiumToggle />);

    expect(pill().getAttribute('title')).toMatch(/creation/i);

    cleanup();

    creationTurnStore.set(false);
    sessionStore.set({ ...funded, credits: { ...funded.credits, balance: 10 } });
    render(<PremiumToggle />);

    expect(locked()).toBe(true);
    expect(pill().getAttribute('title')).toMatch(/1,200 credits/);
    expect(pill().getAttribute('title')).not.toMatch(/creation/i);
  });
});
