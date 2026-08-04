// @vitest-environment jsdom
/**
 * THE FIRST-BUILD LOCK, RENDERED (§4.6.1a, §4.4a).
 *
 * EVERY paid rung is EDIT-ONLY: on a first build turn the platform forces the standard model
 * (`decideModelTier` `reason: 'creation_turn'`). The evidence is Fable 5 — a KIE-buffered creation-sized
 * artifact could not flush before the gateway timeout, measured as 307.8s of reasoning / 0 text /
 * `finish=error` — and the lock was GENERALIZED to the whole ladder rather than kept on the rung that
 * produced it, because the first build is the largest artifact in the product and the safe direction is
 * to assume the next expensive model has the same problem until a live drive says otherwise.
 *
 * The server is the authority and re-derives that on every generation — so a wrong answer HERE can never
 * buy a paid rung. It can only lie to the user about the model their next build will run, in whichever
 * direction it is wrong: name a rung the server declines, or hide one they are entitled to.
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
 * ⚠️ The pill no longer toasts AT ALL — a click opens the picker, and every explanation lives on the
 * panel's rows (§4.1a: the surface that can act on a reason is the surface that should state it).
 *
 * The mock is KEPT, and asserted-on below, precisely because that is a property worth pinning rather
 * than an accident: the toggle this replaced fired a toast on every click, and reintroducing one here
 * would put a transient message on screen at the same moment a panel opens saying the same thing.
 * (The previous version of this comment claimed the toast was "the locked pill's ONLY output on a
 * click" — false the moment the component was rewritten, and left standing. A comment cannot fail, so
 * a false one is how a dead assertion survives review: `shell-strip.ts`, again.)
 */
const toasts = vi.hoisted(() => ({ info: vi.fn(), warning: vi.fn() }));
vi.mock('react-toastify', () => ({ toast: toasts }));

import { ModelTierPill } from './ModelTierPill';
import { modelTierPanelOpen } from '~/lib/stores/model-tier';
import { creationTurnStore } from '~/lib/stores/chat';
import { modelTierStore } from '~/lib/stores/settings';
import { EMPTY_SESSION, sessionStore, type SessionState } from '~/lib/stores/session';

/** A credits user holding well above the premium threshold — the only state where the pill can unlock. */
const funded: SessionState = {
  ...EMPTY_SESSION,
  loading: false,
  authenticated: true,
  credits: {
    ...EMPTY_SESSION.credits,
    balance: 50_000,
    modelTiers: {
      standardModel: 'claude-sonnet-5',
      tiers: [
        {
          id: 'standard',
          label: 'Standard',
          model: 'claude-sonnet-5',
          minimumCredits: 0,
          available: true,
          serveable: true,
        },
        {
          id: 'premium',
          label: 'Premium',
          model: 'claude-opus-5',
          minimumCredits: 1_200,
          available: true,
          serveable: true,
        },
        {
          id: 'supermax',
          label: 'SuperMax',
          model: 'claude-fable-5',
          minimumCredits: 1_500,
          available: true,
          serveable: true,
        },
      ],
    },
  },
};

const pill = () => screen.getByRole('button');

/** The pill NAMES the model actually in use, so the label is the honest read of "am I locked?". */
const label = () => pill().textContent ?? '';

/** The lock glyph the component renders for every ineligible state (`!eligible`). */
const locked = () => pill().querySelector('.i-ph\\:lock-simple') !== null;

beforeEach(() => {
  sessionStore.set(funded);
  modelTierStore.set('standard');
  creationTurnStore.set(false);

  /*
   * The picker's open state is MODULE state and survives `cleanup()`, so without this reset a test that
   * opened the panel leaves the next one starting from "already open" — which reads as a click that did
   * nothing. Every store this file drives is reset in both hooks for the same reason.
   */
  modelTierPanelOpen.set(false);
});

afterEach(() => {
  cleanup();
  sessionStore.set(EMPTY_SESSION);
  modelTierStore.set('standard');
  creationTurnStore.set(false);
  modelTierPanelOpen.set(false);
  vi.clearAllMocks();
});

describe('ModelTierPill — the first-build lock', () => {
  /*
   * THE CONTROL, and the whole file depends on it: a funded, ordinary turn must be UNLOCKED. Without it
   * every assertion below is satisfied by a component that is permanently locked, or renders nothing.
   */
  it('CONTROL — a funded user on an ordinary turn gets an unlocked pill', () => {
    render(<ModelTierPill />);

    expect(locked()).toBe(false);
    expect(label()).toContain('Sonnet 5');
  });

  /*
   * 🔴 THE LOCK GLYPH IS ABOUT A MISMATCH, NOT ABOUT THE PILL'S OWN STATE — the one semantic the pill
   * gained over the boolean toggle it replaced.
   *
   * The old toggle rendered a lock whenever premium was ineligible, so a user who had deliberately
   * chosen the standard model was shown a padlock on a first build — telling them something was being
   * withheld when nothing they had asked for was. With three rungs that reading is untenable: Standard
   * is a real choice, not the absence of one. The lock now means "the rung you SELECTED is not what is
   * about to run", which is only ever true when the user asked for something they cannot currently have.
   */
  it('shows NO lock to a user who chose Standard, even on a first build', () => {
    creationTurnStore.set(true);
    render(<ModelTierPill />);

    expect(locked()).toBe(false);
    expect(label()).toContain('Sonnet 5');
  });

  /**
   * 🔴 THE FIRST BUILD IS NOT A LOCK (owner, 2026-08-03: "we can choose our model as long as we have
   * enough credits and the additional models are enabled").
   *
   * The pill used to show Standard, with a padlock, on the first build turn no matter how funded the
   * user was. It must now name the rung the user PAID for — the pill's entire job is naming what will
   * actually run, so a stale lock here is the component lying about a purchase on the most expensive
   * turn in the product.
   */
  it('runs the selected rung on a first build turn, unlocked', () => {
    modelTierStore.set('premium');
    creationTurnStore.set(true);
    render(<ModelTierPill />);

    expect(locked()).toBe(false);
    expect(label()).toContain('Opus 5');
    expect(label(), 'a first build on Premium must not be showing the standard model').not.toContain('Sonnet');
  });

  /** Unchanged by the turn: the same funded user reads the same pill either side of the first build. */
  it('reads identically once the first build turn is over', () => {
    modelTierStore.set('premium');
    creationTurnStore.set(true);

    const view = render(<ModelTierPill />);
    const during = label();

    creationTurnStore.set(false);
    view.rerender(<ModelTierPill />);

    expect(locked()).toBe(false);
    expect(label()).toBe(during);
  });

  /*
   * 🔴 THE POSITIVE ASSERTION: an ACTIVE pill names the PREMIUM rung's model.
   *
   * Every other label assertion in this file is either "contains Sonnet 5" or the negative "does not
   * contain Opus" — and both are satisfied by a pill that names the standard model in every state.
   * Measured: changing the component to `parseModel(standardModel)` for its premium half — precisely
   * the "names the wrong model on the wrong rung" defect the ladder migration risks — left all 4,063
   * tests green. A pill whose whole job is to name the model actually in use needs at least one test
   * that fails when it names the wrong one.
   */
  it('names the PREMIUM rung’s model when premium is on and eligible', () => {
    modelTierStore.set('premium');
    creationTurnStore.set(false);

    render(<ModelTierPill />);

    expect(locked()).toBe(false);
    expect(label()).toContain('Opus 5');
    expect(label(), 'an active premium pill must not still be naming the standard model').not.toContain('Sonnet');
  });

  /*
   * 🔴 A CLICK OPENS THE PICKER; IT NEVER CHANGES THE SELECTION ITSELF — the T11 change.
   *
   * A two-state control cannot express a three-state choice. The tempting alternative, cycling rungs on
   * each click, makes the MOST EXPENSIVE rung reachable by an accidental double-click on the one control
   * that is always on screen. So the pill's only action is to open the panel, and every selection is a
   * deliberate press on a named row.
   */
  it('a click opens the picker and changes nothing by itself', () => {
    render(<ModelTierPill />);

    fireEvent.click(pill());

    expect(modelTierPanelOpen.get()).toBe(true);
    expect(modelTierStore.get(), 'the pill must never select a rung on its own').toBe('standard');
  });

  /*
   * 🔴 THE AFFORDABILITY HALF OF "NAME THE MODEL ACTUALLY IN USE" — the pill's single most important
   * property, and the half that was NOT pinned.
   *
   * Measured: keeping the creation-turn branch and dropping only the `canUseTier` check left all 4,143
   * tests green, while a user who had selected SuperMax and then spent down below its threshold saw
   * "Fable 5" on the pill and got Sonnet 5 on their next build. That is the live mid-session case —
   * `applySettlement` re-locks a rung as the balance falls after every generation — so it is the more
   * likely of the two directions, and it is exactly what the component's own doc comment forbids.
   */
  it('names the STANDARD model once the balance no longer clears the selected rung', () => {
    modelTierStore.set('supermax');
    sessionStore.set({ ...funded, credits: { ...funded.credits, balance: 500 } });

    render(<ModelTierPill />);

    expect(label()).toContain('Sonnet 5');
    expect(label(), 'the pill must never name a model the next build will not run').not.toContain('Fable');
    expect(locked(), 'and it must say so — the selected rung is not what runs').toBe(true);
  });

  /* CONTROL — the same selection at a balance that DOES clear it really does name Fable 5. */
  it('CONTROL — names the SuperMax model when the balance clears its threshold', () => {
    modelTierStore.set('supermax');

    render(<ModelTierPill />);

    expect(label()).toContain('Fable 5');
    expect(locked()).toBe(false);
  });

  /* The pill opens a panel and says nothing transient — no toast competing with the surface it opened. */
  it('never toasts: the explanation belongs to the picker, not to a disappearing message', () => {
    modelTierStore.set('premium');
    creationTurnStore.set(true);
    render(<ModelTierPill />);

    fireEvent.click(pill());

    expect(toasts.info).not.toHaveBeenCalled();
    expect(toasts.warning).not.toHaveBeenCalled();
  });

  /* And it closes again — the pill is the toggle for its own panel. */
  it('a second click closes the picker', () => {
    render(<ModelTierPill />);

    fireEvent.click(pill());
    fireEvent.click(pill());

    expect(modelTierPanelOpen.get()).toBe(false);
  });

  /* A locked pill still opens the picker: that is where the explanation lives (§4.1a — no dead ends). */
  it('still opens the picker while locked, rather than doing nothing', () => {
    modelTierStore.set('premium');
    sessionStore.set({ ...funded, credits: { ...funded.credits, balance: 10 } });
    render(<ModelTierPill />);

    fireEvent.click(pill());

    expect(modelTierPanelOpen.get()).toBe(true);
    expect(modelTierStore.get(), 'a locked pill must not silently downgrade the stored choice').toBe('premium');
  });

  /**
   * 🔴 THE THRESHOLD OUTRANKS AN ALREADY-CHOSEN RUNG. A user who selected Premium and then spent down
   * below its minimum must see the STANDARD model, not an accented "Opus 5" the server will not honour
   * — the one state where a stale preference and a live rule disagree.
   *
   * ⚠️ This test used to assert the same thing about the FIRST BUILD TURN, which is no longer a lock
   * (owner, 2026-08-03). The property it protects — the pill never names a rung that will not run — is
   * unchanged; only the reason a rung can fail to run is.
   */
  it('shows the STANDARD model when the chosen rung is unaffordable', () => {
    modelTierStore.set('premium');
    sessionStore.set({ ...funded, credits: { ...funded.credits, balance: 10 } });
    render(<ModelTierPill />);

    expect(locked()).toBe(true);
    expect(label()).toContain('Sonnet 5');

    /*
     * The negative names the PREMIUM rung's model, which the ladder moved from Fable 5 to Opus 5
     * (§4.6.1a). Left as `Fable` it would still pass and assert nothing — the pill cannot render a
     * model that is no longer on this rung.
     */
    expect(label()).not.toContain('Opus');
  });

  /**
   * The threshold lock is the ONLY lock left, and the tooltip must never mention the retired one.
   *
   * The negative is the load-bearing half: the first-build sentence used to be one of two branches
   * here, so a copy string left behind would tell a funded user to wait for a lock that no longer
   * exists — and, on a first build, would be the only thing on screen contradicting the pill itself.
   */
  /**
   * 🔴 THE PILL NAMES A NON-CLAUDE RUNG PROPERLY (§4.6.1a FR8, T11c).
   *
   * The ladder can now put a GPT or Gemini model on a paid rung, and the pill's whole job is naming the
   * model actually in use. Before the parser was generalised it read `claude-*` only, so any other id
   * fell through to itself and the toolbar's most-read control showed a raw API id — which is not a
   * model name to a user, and reads as a bug in the product rather than as the model they picked.
   *
   * The id comes from the FIXTURE, i.e. the way the server sends it (`modelTiersSessionHint`'s per-tier
   * `model`). Nothing here tells the component which family it is looking at.
   */
  it('names a GPT rung as "GPT 5.6 Sol", in the label and in the tooltip', () => {
    sessionStore.set({
      ...funded,
      credits: {
        ...funded.credits,
        modelTiers: {
          ...funded.credits.modelTiers,
          tiers: funded.credits.modelTiers.tiers.map((tier) =>
            tier.id === 'premium' ? { ...tier, model: 'gpt-5-6-sol' } : tier,
          ),
        },
      },
    });
    modelTierStore.set('premium');
    render(<ModelTierPill />);

    expect(locked()).toBe(false);
    expect(label()).toContain('GPT 5.6 Sol');
    expect(label(), 'a raw API id on the pill is the parser having failed silently').not.toContain('gpt-5-6-sol');
    expect(pill().getAttribute('title')).toContain('GPT 5.6 Sol');
  });

  /** The same for Gemini — a second family, so one family's shape cannot be special-cased into passing. */
  it('names a Gemini rung as "Gemini 3.5 Flash"', () => {
    sessionStore.set({
      ...funded,
      credits: {
        ...funded.credits,
        modelTiers: {
          ...funded.credits.modelTiers,
          tiers: funded.credits.modelTiers.tiers.map((tier) =>
            tier.id === 'supermax' ? { ...tier, model: 'gemini-3-5-flash' } : tier,
          ),
        },
      },
    });
    modelTierStore.set('supermax');
    render(<ModelTierPill />);

    expect(label()).toContain('Gemini 3.5 Flash');
    expect(label()).not.toContain('3 5');
  });

  it('explains the threshold lock and never claims a first-build one', () => {
    modelTierStore.set('premium');
    creationTurnStore.set(true);
    sessionStore.set({ ...funded, credits: { ...funded.credits, balance: 10 } });
    render(<ModelTierPill />);

    expect(locked()).toBe(true);
    expect(pill().getAttribute('title')).toMatch(/Premium/);
    expect(pill().getAttribute('title')).not.toMatch(/first build/i);
  });
});
