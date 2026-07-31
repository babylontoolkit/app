// @vitest-environment jsdom
/**
 * THE MODEL TIER PICKER, RENDERED (§4.6.1a T11).
 *
 * The pill's spec (`ModelTierPill.spec.tsx`) covers the READOUT — which model is about to run, and
 * whether the user's stored choice is being honoured. This file covers the other half: the panel where
 * the choice is actually made, and — more importantly — what a row SAYS when it cannot be chosen.
 *
 * ## Why the copy is the thing under test, not just the store write
 *
 * There are three reasons a rung is locked and they need three different actions from the user:
 *
 * - **creation_turn** — nothing to do; it clears by itself when the first build finishes (§4.4a).
 * - **unserveable** — the OPERATOR's selector for that rung cannot be priced. No amount of credits helps.
 * - **below_minimum** — buy credits; the row names the number.
 *
 * Quoting a threshold for either of the first two sends a funded user to the billing page to spend money
 * on a lock that money cannot open. That is a silent defect in the §4.2.8 sense — nothing throws, the
 * store is correct, and the only casualty is a user's wallet — so the sentences are pinned, not just the
 * side effects.
 *
 * ## `.click()` does not open a menu; and module state survives `cleanup()`
 *
 * Two harness rules inherited from this repo's existing render specs. Selections here are driven with a
 * real `pointerDown` before the click (CLAUDE.md §4.1a: a scripted `.click()` does not open a Radix-style
 * menu, so a "nothing happened" result is a test artefact rather than a bug). And `modelTierPanelOpen` is
 * a module-level nanostore — `cleanup()` unmounts the tree but does not touch it — so every store this
 * file drives is reset in BOTH hooks. Without that, a test that opened the panel leaves the next one
 * starting from "already open", which reads exactly like a click that did nothing.
 *
 * ⚠️ `@testing-library/user-event` is NOT a dependency of this repo (only `@testing-library/react` and
 * `@testing-library/jest-dom`), so pointer events are dispatched with `fireEvent` directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

const toasts = vi.hoisted(() => ({ info: vi.fn(), warning: vi.fn() }));
vi.mock('react-toastify', () => ({ toast: toasts }));

import { ModelTierPanel, lockReasonFor } from './ModelTierPanel';
import { ModelTierPill } from './ModelTierPill';
import { MODEL_TIER_DESCRIPTIONS, modelTierPanelOpen, parseModel } from '~/lib/stores/model-tier';
import { creationTurnStore } from '~/lib/stores/chat';
import { modelTierStore } from '~/lib/stores/settings';
import { EMPTY_SESSION, sessionStore, type ModelTierState, type SessionState } from '~/lib/stores/session';

/**
 * The ladder as the server would describe it, with the two knobs every test below turns: how many
 * credits the user holds, and whether the operator's SuperMax selector can be priced.
 *
 * `minimumCredits` is fixed at the shipped defaults (premium 1,200 / supermax 1,500) because the
 * acceptance names 1,500 explicitly — a fixture that derived the number from the assertion would pass
 * against any threshold at all.
 */
function ladder(options: { balance: number; supermaxServeable?: boolean; premiumServeable?: boolean }): SessionState {
  const { balance, supermaxServeable = true, premiumServeable = true } = options;

  return {
    ...EMPTY_SESSION,
    loading: false,
    authenticated: true,
    credits: {
      ...EMPTY_SESSION.credits,
      balance,
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
            serveable: premiumServeable,
          },
          {
            id: 'supermax',
            label: 'SuperMax',
            model: 'claude-fable-5',
            minimumCredits: 1_500,
            available: true,
            serveable: supermaxServeable,
          },
        ],
      },
    },
  };
}

/** Every tier row is a real `<button aria-pressed>`; the panel's X is the only button without one. */
const rows = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'));

const row = (label: string) => {
  const found = rows().find((button) => (button.textContent ?? '').includes(label));

  if (!found) {
    throw new Error(
      `no picker row labelled ${label} (rows: ${rows()
        .map((r) => r.textContent)
        .join(' | ')})`,
    );
  }

  return found;
};

/** The lock glyph a row renders for every non-null `lockReasonFor`. */
const isLocked = (button: HTMLButtonElement) => button.querySelector('.i-ph\\:lock-simple') !== null;

const copyOf = (button: HTMLButtonElement) => button.textContent ?? '';

/**
 * A REAL pointer press, not `element.click()`.
 *
 * CLAUDE.md §4.1a: a scripted click does not open a Radix-style menu because those open on
 * `pointerdown`, so a scripted "nothing happened" is a test artefact. This panel's rows are plain
 * buttons today, but driving them the way a browser does is what keeps that true if a row ever becomes
 * a menu item.
 */
function press(button: HTMLElement) {
  fireEvent.pointerDown(button, { pointerId: 1, button: 0, isPrimary: true });
  fireEvent.pointerUp(button, { pointerId: 1, button: 0, isPrimary: true });
  fireEvent.click(button);
}

/**
 * Open the picker by setting the store DIRECTLY — the pill is not rendered in this file.
 *
 * (The previous version of this comment said "the way the user does — by pressing the pill", which is
 * not what the line below does. That the pill's click actually reaches this store is the pill's own
 * property and is pinned there, by a real press, in `ModelTierPill.spec.tsx`. Claiming it here would
 * have this file silently taking credit for coverage that lives in another one.)
 */
const openPanel = () => modelTierPanelOpen.set(true);

beforeEach(() => {
  sessionStore.set(ladder({ balance: 2_000 }));
  modelTierStore.set('standard');
  creationTurnStore.set(false);
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

describe('ModelTierPanel — choosing a rung', () => {
  /**
   * 🔴 THE ACCEPTANCE, END TO END: 2,000 credits on an edit turn → all three rows selectable, and
   * choosing SuperMax makes the PILL say "Fable 5".
   *
   * The pill is rendered alongside the panel rather than the store write being asserted alone, because
   * the store write is the easy half. The claim that matters to a user is that the control they can see
   * now names the model their next build will run — and a picker that writes `'supermax'` into a store
   * nothing reads would satisfy every assertion short of this one.
   */
  it('offers all three rows at 2,000 credits on an edit turn, and selecting SuperMax renames the pill', () => {
    openPanel();
    render(
      <div>
        <ModelTierPanel />
        <div data-testid="pill-slot">
          <ModelTierPill />
        </div>
      </div>,
    );

    expect(rows()).toHaveLength(3);

    for (const label of ['Standard', 'Premium', 'SuperMax']) {
      expect(isLocked(row(label)), `${label} must be selectable at 2,000 credits on an edit turn`).toBe(false);
    }

    // The unlocked rows say what the rung BUYS, never why it cannot be had.
    expect(copyOf(row('SuperMax'))).toContain(MODEL_TIER_DESCRIPTIONS.supermax);

    const pill = () => within(screen.getByTestId('pill-slot')).getByRole('button');

    expect(pill().textContent).toContain('Sonnet 5');

    press(row('SuperMax'));

    expect(modelTierStore.get()).toBe('supermax');
    expect(modelTierPanelOpen.get(), 'a successful choice closes the picker').toBe(false);
    expect(pill().textContent, 'the pill must name the rung the user just chose').toContain('Fable 5');
    expect(pill().textContent).not.toContain('Sonnet');
  });

  /** Premium is a rung like any other — the ladder has three, not "standard plus premium". */
  it('selects the PREMIUM rung by its own row', () => {
    openPanel();
    render(<ModelTierPanel />);

    press(row('Premium'));

    expect(modelTierStore.get()).toBe('premium');
    expect(modelTierPanelOpen.get()).toBe(false);
  });
});

describe('ModelTierPanel — the first-build lock', () => {
  /**
   * 🔴 EVERY PAID RUNG IS LOCKED ON THE FIRST BUILD (§4.4a), AND THE ROW MUST NOT MENTION CREDITS.
   *
   * The user in this test holds 2,000 credits — they clear both thresholds. Telling them "unlocks at
   * 1,500 credits" would be a lie that costs them money, and it is the exact wrong-sentence failure the
   * lock-reason ORDER exists to prevent (creation_turn is reported before anything about the account).
   */
  it('locks every non-standard row and explains the creation lock without naming a threshold', () => {
    creationTurnStore.set(true);
    openPanel();
    render(<ModelTierPanel />);

    expect(isLocked(row('Standard')), 'Standard is always available — it is a real choice').toBe(false);

    for (const label of ['Premium', 'SuperMax']) {
      const locked = row(label);

      expect(isLocked(locked), `${label} must be locked on a first build`).toBe(true);
      expect(copyOf(locked)).toMatch(/first build/i);
      expect(copyOf(locked), 'a funded user must not be sent to the billing page').not.toMatch(/credits/i);
      expect(copyOf(locked)).not.toMatch(/1,200|1,500/);
      expect(copyOf(locked), 'the creation lock is not an availability problem').not.toMatch(/unavailable/i);
    }
  });

  /** Clicking a locked row changes NOTHING — and leaves the panel open, because the copy is the answer. */
  it('a click on a locked row selects nothing and keeps the panel open', () => {
    creationTurnStore.set(true);
    openPanel();
    render(<ModelTierPanel />);

    press(row('SuperMax'));

    expect(modelTierStore.get(), 'a locked row must never select').toBe('standard');
    expect(modelTierPanelOpen.get(), 'the explanation it just revealed is the point of the click').toBe(true);
  });

  /**
   * THE CONTROL. Without it every assertion above is satisfied by a panel whose rows are permanently
   * locked, or which renders no rows at all.
   */
  it('CONTROL — the same rows are selectable once the turn is not a first build', () => {
    creationTurnStore.set(false);
    openPanel();
    render(<ModelTierPanel />);

    expect(isLocked(row('Premium'))).toBe(false);
    expect(isLocked(row('SuperMax'))).toBe(false);

    press(row('SuperMax'));

    expect(modelTierStore.get()).toBe('supermax');
  });
});

describe('ModelTierPanel — the credits threshold', () => {
  /** At 500 credits the paid rows name their number — the one lock a user can actually act on. */
  it('names 1,500 credits on the SuperMax row at a 500-credit balance', () => {
    sessionStore.set(ladder({ balance: 500 }));
    openPanel();
    render(<ModelTierPanel />);

    const supermax = row('SuperMax');

    expect(isLocked(supermax)).toBe(true);
    expect(copyOf(supermax)).toMatch(/Unlocks at 1,500 credits/);
    expect(copyOf(supermax), 'this is not a creation lock').not.toMatch(/first build/i);
    expect(copyOf(supermax)).not.toMatch(/unavailable/i);

    const premium = row('Premium');

    expect(isLocked(premium)).toBe(true);
    expect(copyOf(premium)).toMatch(/Unlocks at 1,200 credits/);
  });

  /** The boundary is `>=`: exactly the threshold unlocks the rung. */
  it('unlocks SuperMax at exactly 1,500 credits', () => {
    sessionStore.set(ladder({ balance: 1_500 }));
    openPanel();
    render(<ModelTierPanel />);

    expect(isLocked(row('SuperMax'))).toBe(false);
  });
});

describe('ModelTierPanel — an unserveable rung', () => {
  /**
   * 🔴 CREDITS CANNOT OPEN THIS LOCK, SO THE ROW MUST NOT QUOTE A PRICE.
   *
   * `serveable: false` means the OPERATOR's selector for that rung has no row in the active price list —
   * the platform will refuse it however rich the user is. Ten million credits is the assertion: a
   * threshold sentence here would have the user buy credits forever against a lock that is not theirs.
   */
  it('locks an unserveable rung at any balance and says unavailable rather than quoting a threshold', () => {
    sessionStore.set(ladder({ balance: 10_000_000, supermaxServeable: false }));
    openPanel();
    render(<ModelTierPanel />);

    const supermax = row('SuperMax');

    expect(isLocked(supermax)).toBe(true);
    expect(copyOf(supermax)).toMatch(/unavailable/i);
    expect(copyOf(supermax), 'no amount of credits opens this lock').not.toMatch(/Unlocks at/);
    expect(copyOf(supermax)).not.toMatch(/1,500/);
    expect(copyOf(supermax)).not.toMatch(/first build/i);

    // The rung the operator DID configure is unaffected — this is a per-rung fact, not a panel mode.
    expect(isLocked(row('Premium'))).toBe(false);
  });
});

describe('ModelTierPanel — a locked row is not a dead end', () => {
  /**
   * 🔴 §4.1a: A LOCKED ROW IS EXPLAINING, NOT DISABLED.
   *
   * An HTML-`disabled` button cannot be clicked, cannot be focused, and cannot be read by a pointer —
   * so it can never answer the question it just raised. The whole three-reason lock vocabulary above is
   * unreachable the moment somebody "tidies" these rows by adding `disabled`.
   */
  it('renders locked rows as real, enabled buttons', () => {
    creationTurnStore.set(true);
    openPanel();
    render(<ModelTierPanel />);

    for (const label of ['Premium', 'SuperMax']) {
      const locked = row(label);

      expect(isLocked(locked)).toBe(true);
      expect(locked.disabled, `${label} must stay clickable so it can explain itself`).toBe(false);
      expect(locked.hasAttribute('disabled')).toBe(false);
    }
  });

  it('renders locked rows as enabled buttons for the threshold lock too', () => {
    sessionStore.set(ladder({ balance: 500 }));
    openPanel();
    render(<ModelTierPanel />);

    expect(row('SuperMax').disabled).toBe(false);
  });
});

describe('ModelTierPanel — layout stability', () => {
  /**
   * 🔴 THE ANCHOR IS ALWAYS RENDERED (§4.1a — "a right-aligned toolbar must not RESIZE").
   *
   * The panel is a `position: absolute` popup inside a zero-width `relative` anchor, and that anchor is
   * a FLEX CHILD of the chat box's control row. Returning `null` when closed removes the child, so
   * opening the picker inserts the row's `gap` and shifts every control beside it — the acceptance's
   * "does not move any sibling by a pixel". A zero-width anchor held from first paint costs nothing.
   */
  it('renders its anchor when CLOSED, so opening the picker cannot shift a sibling', () => {
    const { container } = render(
      <div>
        <ModelTierPanel />
        <span data-testid="sibling" />
      </div>,
    );

    const wrapper = container.firstElementChild!;

    expect(modelTierPanelOpen.get()).toBe(false);
    expect(wrapper.children, 'the anchor must not disappear when the panel is closed').toHaveLength(2);

    const anchorWhenClosed = wrapper.children[0];

    expect(anchorWhenClosed).not.toBeNull();
    expect(anchorWhenClosed.className).toContain('relative');
    expect(screen.getByTestId('sibling').previousElementSibling).toBe(anchorWhenClosed);

    /*
     * ...and opening it adds only the popup INSIDE that same anchor. The store write is wrapped in
     * `act` because it happens outside React's own event handling here — without it the re-render is
     * still pending when the assertions run, and the panel would look permanently closed.
     */
    act(() => modelTierPanelOpen.set(true));

    expect(wrapper.children, 'opening must not add a flex child to the row').toHaveLength(2);
    expect(wrapper.children[0]).toBe(anchorWhenClosed);
    expect(screen.getByTestId('sibling').previousElementSibling).toBe(anchorWhenClosed);
    expect(rows()).toHaveLength(3);
  });

  /** Escape closes it — a popup with only an X reads as stuck. */
  it('closes on Escape', () => {
    openPanel();
    render(<ModelTierPanel />);

    expect(rows()).toHaveLength(3);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(modelTierPanelOpen.get()).toBe(false);
    expect(rows()).toHaveLength(0);
  });
});

describe('lockReasonFor', () => {
  const tier = (over: Partial<ModelTierState> = {}): ModelTierState => ({
    id: 'supermax',
    label: 'SuperMax',
    model: 'claude-fable-5',
    minimumCredits: 1_500,
    available: true,
    serveable: true,
    ...over,
  });

  const session = (balance: number, serveable = true) => ladder({ balance, supermaxServeable: serveable });

  /** Standard has no threshold and no selector to misconfigure — it can never be locked. */
  it('never locks standard, whatever else is true', () => {
    const standard = tier({ id: 'standard', minimumCredits: 0 });

    expect(lockReasonFor(standard, session(0), true)).toBeNull();
    expect(lockReasonFor(standard, session(0), false)).toBeNull();
    expect(lockReasonFor({ ...standard, serveable: false }, session(0), true)).toBeNull();
  });

  it('is null for a paid rung that is serveable, funded, and off the creation turn', () => {
    expect(lockReasonFor(tier(), session(2_000), false)).toBeNull();
    expect(lockReasonFor(tier(), session(1_500), false), 'the threshold is >=').toBeNull();
  });

  it('reports below_minimum only when credits are the actual problem', () => {
    expect(lockReasonFor(tier(), session(1_499), false)).toBe('below_minimum');
    expect(lockReasonFor(tier(), session(0), false)).toBe('below_minimum');
  });

  it('reports unserveable regardless of balance', () => {
    expect(lockReasonFor(tier({ serveable: false }), session(10_000_000, false), false)).toBe('unserveable');
    expect(lockReasonFor(tier({ serveable: false }), session(0, false), false)).toBe('unserveable');
  });

  /**
   * 🔴 THE ORDER IS THE POINT, because the order decides which SENTENCE the user reads.
   *
   * creation_turn outranks unserveable outranks below_minimum. Checking `serveable` first would tell a
   * funded user on a first build that the rung is permanently unavailable, when it unlocks by itself in
   * a minute; checking the balance first would tell them to buy credits for a lock money cannot open.
   */
  it('reports creation_turn ahead of BOTH other reasons', () => {
    // Every reason true at once: unserveable, broke, and on a first build.
    expect(lockReasonFor(tier({ serveable: false }), session(0, false), true)).toBe('creation_turn');

    // Funded and serveable, but a first build.
    expect(lockReasonFor(tier(), session(10_000_000), true)).toBe('creation_turn');
  });

  it('reports unserveable ahead of below_minimum', () => {
    expect(lockReasonFor(tier({ serveable: false }), session(0, false), false)).toBe('unserveable');
  });

  /** The full grid, so a future edit cannot quietly change one cell. */
  it('covers the whole {creationTurn} × {serveable} × {balance} grid', () => {
    const cases: Array<[boolean, boolean, number, ReturnType<typeof lockReasonFor>]> = [
      [true, true, 10_000_000, 'creation_turn'],
      [true, true, 0, 'creation_turn'],
      [true, false, 10_000_000, 'creation_turn'],
      [true, false, 0, 'creation_turn'],
      [false, true, 10_000_000, null],
      [false, true, 1_500, null],
      [false, true, 1_499, 'below_minimum'],
      [false, false, 10_000_000, 'unserveable'],
      [false, false, 0, 'unserveable'],
    ];

    for (const [creationTurn, serveable, balance, expected] of cases) {
      expect(
        lockReasonFor(tier({ serveable }), session(balance, serveable), creationTurn),
        `creationTurn=${creationTurn} serveable=${serveable} balance=${balance}`,
      ).toBe(expected);
    }
  });
});

describe('parseModel', () => {
  it('renders the shipped ladder ids', () => {
    expect(parseModel('claude-fable-5')).toEqual({ short: 'Fable', full: 'Fable 5' });
    expect(parseModel('claude-opus-4-8')).toEqual({ short: 'Opus', full: 'Opus 4.8' });
    expect(parseModel('claude-opus-5').full).toBe('Opus 5');
    expect(parseModel('claude-sonnet-5').full).toBe('Sonnet 5');
  });

  /**
   * 🔴 AN UNRECOGNISED ID RETURNS ITSELF — it must never blank the pill or throw.
   *
   * `LLM_MODEL` and the rung selectors are operator config that can name a model this build has never
   * heard of (§4.2a — swapping the platform model is a config operation, no redeploy). A parser that
   * returned `''` for an unfamiliar id would leave the one control whose whole job is naming the model
   * in use showing nothing at all.
   */
  it('returns an unrecognised id verbatim rather than throwing or blanking', () => {
    expect(parseModel('gpt-5')).toEqual({ short: 'gpt-5', full: 'gpt-5' });
    expect(parseModel('')).toEqual({ short: '', full: '' });
    expect(parseModel('claude')).toEqual({ short: 'claude', full: 'claude' });
    expect(parseModel('some-vendor/model:1')).toEqual({ short: 'some-vendor/model:1', full: 'some-vendor/model:1' });
  });
});
