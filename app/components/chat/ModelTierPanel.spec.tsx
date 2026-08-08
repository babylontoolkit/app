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
 * credits the user holds, and whether the operator's Premium selector can be priced.
 *
 * `minimumCredits` is fixed at the shipped default (premium 1,200) because the assertions name 1,200
 * explicitly — a fixture that derived the number from the assertion would pass against any threshold
 * at all.
 */
function ladder(options: { balance: number; premiumServeable?: boolean }): SessionState {
  const { balance, premiumServeable = true } = options;

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
   * 🔴 THE ACCEPTANCE, END TO END: 2,000 credits on an edit turn → every row selectable, and choosing
   * Premium makes the PILL say "Opus 5".
   *
   * The pill is rendered alongside the panel rather than the store write being asserted alone, because
   * the store write is the easy half. The claim that matters to a user is that the control they can see
   * now names the model their next build will run — and a picker that writes `'premium'` into a store
   * nothing reads would satisfy every assertion short of this one.
   */
  it('offers every row at 2,000 credits on an edit turn, and selecting Premium renames the pill', () => {
    openPanel();
    render(
      <div>
        <ModelTierPanel />
        <div data-testid="pill-slot">
          <ModelTierPill />
        </div>
      </div>,
    );

    expect(rows()).toHaveLength(2);

    for (const label of ['Standard', 'Premium']) {
      expect(isLocked(row(label)), `${label} must be selectable at 2,000 credits on an edit turn`).toBe(false);
    }

    // The unlocked rows say what the rung BUYS, never why it cannot be had.
    expect(copyOf(row('Premium'))).toContain(MODEL_TIER_DESCRIPTIONS.premium);

    const pill = () => within(screen.getByTestId('pill-slot')).getByRole('button');

    expect(pill().textContent).toContain('Sonnet 5');

    press(row('Premium'));

    expect(modelTierStore.get()).toBe('premium');
    expect(modelTierPanelOpen.get(), 'a successful choice closes the picker').toBe(false);
    expect(pill().textContent, 'the pill must name the rung the user just chose').toContain('Opus 5');
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

describe('ModelTierPanel — the first build turn is not a lock', () => {
  /**
   * 🔴 EVERY PAID RUNG IS PICKABLE ON THE FIRST BUILD (owner, 2026-08-03: "we can choose our model as
   * long as we have enough credits and the additional models are enabled").
   *
   * This block used to assert the exact opposite — every paid row locked, with copy reading "your first
   * build always runs …". Inverted rather than deleted, because the panel is where a user goes to find
   * out WHY a rung is unavailable, and a stale lock here would refuse a purchase on the biggest turn in
   * the product while quoting a reason that no longer exists.
   */
  it('leaves every row selectable on a first build turn', () => {
    creationTurnStore.set(true);
    openPanel();
    render(<ModelTierPanel />);

    for (const label of ['Standard', 'Premium']) {
      expect(isLocked(row(label)), `${label} must be selectable on a first build`).toBe(false);
    }
  });

  it('selects a paid rung on a first build turn', () => {
    creationTurnStore.set(true);
    openPanel();
    render(<ModelTierPanel />);

    press(row('Premium'));

    expect(modelTierStore.get()).toBe('premium');
  });

  /** No row may still be telling the user to wait for a lock the server stopped applying. */
  it('never mentions the retired first-build lock', () => {
    creationTurnStore.set(true);
    openPanel();
    render(<ModelTierPanel />);

    for (const label of ['Standard', 'Premium']) {
      expect(copyOf(row(label)), `${label}`).not.toMatch(/first build/i);
    }
  });

  /**
   * THE CONTROL. Without it the assertions above are satisfied by a panel that renders no lock in any
   * state at all — which would hide the threshold lock that is still very much real.
   */
  it('CONTROL — an unaffordable rung is still locked on that same turn', () => {
    creationTurnStore.set(true);
    sessionStore.set(ladder({ balance: 500 }));
    openPanel();
    render(<ModelTierPanel />);

    expect(isLocked(row('Premium'))).toBe(true);
    expect(copyOf(row('Premium'))).toMatch(/Unlocks at 1,200 credits/);
  });
});

describe('ModelTierPanel — the credits threshold', () => {
  /** At 500 credits the paid rows name their number — the one lock a user can actually act on. */
  it('names 1,200 credits on the Premium row at a 500-credit balance', () => {
    sessionStore.set(ladder({ balance: 500 }));
    openPanel();
    render(<ModelTierPanel />);

    const premium = row('Premium');

    expect(isLocked(premium)).toBe(true);
    expect(copyOf(premium)).toMatch(/Unlocks at 1,200 credits/);
    expect(copyOf(premium), 'this is not a creation lock').not.toMatch(/first build/i);
    expect(copyOf(premium)).not.toMatch(/unavailable/i);
  });

  /** The boundary is `>=`: exactly the threshold unlocks the rung. */
  it('unlocks Premium at exactly 1,200 credits', () => {
    sessionStore.set(ladder({ balance: 1_200 }));
    openPanel();
    render(<ModelTierPanel />);

    expect(isLocked(row('Premium'))).toBe(false);
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
  /*
   * 🔴 ON A TWO-RUNG LADDER, AN UNSERVEABLE PAID RUNG MEANS THERE IS NO PICKER AT ALL (2026-08-08).
   *
   * This case used to render the panel and assert the unserveable row's COPY — "unavailable", never a
   * threshold, because no amount of credits opens an operator's misconfiguration. With one paid rung
   * that is unreachable through the panel by construction: `hasModelChoice` counts SERVEABLE rows, so
   * a broken Premium leaves exactly one option and the picker correctly refuses to open on a choice
   * that does not exist. Asserting that instead is the honest test of the current shape — and it is a
   * real property, not a consolation: a one-row picker is a control that cannot do anything.
   *
   * ⚠️ The lock VOCABULARY it used to pin (unserveable beats below_minimum; the unserveable sentence
   * never quotes a threshold) is not lost — `lockReasonFor` is pure and is exercised directly below,
   * which is where it belonged anyway. What is genuinely gone is the rendered-copy assertion, and it
   * comes back the moment a second paid rung does.
   */
  it('offers no picker at all when the only paid rung is unserveable, however rich the user', () => {
    sessionStore.set(ladder({ balance: 10_000_000, premiumServeable: false }));
    openPanel();
    render(<ModelTierPanel />);

    expect(rows(), 'one serveable rung is not a choice').toHaveLength(0);

    // CONTROL: the same balance with the rung healthy really does open a two-row picker.
    cleanup();
    sessionStore.set(ladder({ balance: 10_000_000 }));
    openPanel();
    render(<ModelTierPanel />);

    expect(rows()).toHaveLength(2);
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
    // A balance below BOTH thresholds — the first-build lock that used to drive this test is retired.
    sessionStore.set(ladder({ balance: 10 }));
    openPanel();
    render(<ModelTierPanel />);

    for (const label of ['Premium']) {
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

    expect(row('Premium').disabled).toBe(false);
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
    expect(rows()).toHaveLength(2);
  });

  /** Escape closes it — a popup with only an X reads as stuck. */
  it('closes on Escape', () => {
    openPanel();
    render(<ModelTierPanel />);

    expect(rows()).toHaveLength(2);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(modelTierPanelOpen.get()).toBe(false);
    expect(rows()).toHaveLength(0);
  });
});

describe('lockReasonFor', () => {
  const tier = (over: Partial<ModelTierState> = {}): ModelTierState => ({
    id: 'premium',
    label: 'Premium',
    model: 'claude-opus-5',
    minimumCredits: 1_200,
    available: true,
    serveable: true,
    ...over,
  });

  const session = (balance: number, serveable = true) => ladder({ balance, premiumServeable: serveable });

  /** Standard has no threshold and no selector to misconfigure — it can never be locked. */
  it('never locks standard, whatever else is true', () => {
    const standard = tier({ id: 'standard', minimumCredits: 0 });

    expect(lockReasonFor(standard, session(0))).toBeNull();
    expect(lockReasonFor({ ...standard, serveable: false }, session(0))).toBeNull();
  });

  it('is null for a paid rung that is serveable and funded', () => {
    expect(lockReasonFor(tier(), session(2_000))).toBeNull();
    expect(lockReasonFor(tier(), session(1_500)), 'the threshold is >=').toBeNull();
  });

  it('reports below_minimum only when credits are the actual problem', () => {
    expect(lockReasonFor(tier(), session(1_199))).toBe('below_minimum');
    expect(lockReasonFor(tier(), session(0))).toBe('below_minimum');
  });

  it('reports unserveable regardless of balance', () => {
    expect(lockReasonFor(tier({ serveable: false }), session(10_000_000, false))).toBe('unserveable');
    expect(lockReasonFor(tier({ serveable: false }), session(0, false))).toBe('unserveable');
  });

  /**
   * 🔴 THE ORDER IS THE POINT, because the order decides which SENTENCE the user reads. Checking the
   * balance first would tell a user to buy credits for a lock money cannot open.
   */
  it('reports unserveable ahead of below_minimum', () => {
    expect(lockReasonFor(tier({ serveable: false }), session(0, false))).toBe('unserveable');
  });

  /**
   * 🔴 THE FIRST BUILD IS NOT A LOCK ANY MORE (owner, 2026-08-03).
   *
   * There used to be a `creation_turn` reason outranking both of these, mirroring a server rule that no
   * longer exists. A funded, serveable rung is pickable on EVERY turn — asserted rather than merely
   * deleted, because "the picker silently refuses on the biggest turn in the product" is precisely the
   * kind of regression that reads as a UI quirk instead of as a broken purchase.
   */
  it('locks nothing merely because it is the first build turn', () => {
    expect(lockReasonFor(tier(), session(10_000_000))).toBeNull();
  });

  /** The full grid, so a future edit cannot quietly change one cell. */
  it('covers the whole {serveable} × {balance} grid', () => {
    const cases: Array<[boolean, number, ReturnType<typeof lockReasonFor>]> = [
      [true, 10_000_000, null],
      [true, 1_200, null],
      [true, 1_199, 'below_minimum'],
      [false, 10_000_000, 'unserveable'],
      [false, 0, 'unserveable'],
    ];

    for (const [serveable, balance, expected] of cases) {
      expect(
        lockReasonFor(tier({ serveable }), session(balance, serveable)),
        `serveable=${serveable} balance=${balance}`,
      ).toBe(expected);
    }
  });
});

/**
 * 🔴 EVERY ROW NAMES ITS OWN RUNG'S MODEL, ACROSS ALL THREE FAMILIES (§4.6.1a FR8, T11c).
 *
 * The rows are the only place a user can compare what the rungs actually ARE before spending on one, so
 * a row that names the wrong model — or that renders an id verbatim because the parser only knew Claude
 * — is a purchase made on wrong information. The parser's own derivation is pinned unit-side in
 * `app/lib/stores/model-tier.spec.ts` (including the rule that it is derived from the id's shape and not
 * from a client-side table); what is pinned HERE is that the resolved name reaches the screen, on the
 * same row as its label, for a ladder whose rungs come from three different families.
 *
 * The ids are supplied by the FIXTURE, i.e. they arrive the way the server sends them
 * (`modelTiersSessionHint`'s per-tier `model`) — the component is never given a family to look up.
 */
describe('ModelTierPanel — rung model names', () => {
  /** A tri-family ladder: the shape T11 exists to serve. */
  const triFamily = (): SessionState => {
    const base = ladder({ balance: 50_000 });
    const tiers = base.credits.modelTiers.tiers.map((tier) =>
      tier.id === 'premium' ? { ...tier, model: 'gpt-5-6-sol' } : { ...tier, model: 'gemini-3-5-flash' },
    );

    return { ...base, credits: { ...base.credits, modelTiers: { ...base.credits.modelTiers, tiers } } };
  };

  it('shows each rung’s resolved display name beside its label — "Premium — GPT 5.6 Sol"', () => {
    sessionStore.set(triFamily());
    openPanel();
    render(<ModelTierPanel />);

    expect(copyOf(row('Standard'))).toContain('Gemini 3.5 Flash');
    expect(copyOf(row('Premium'))).toContain('GPT 5.6 Sol');

    // Never the raw id, and never the un-dotted version the id literally carries.
    expect(copyOf(row('Premium')), 'a raw id on a row is the parser having failed silently').not.toContain(
      'gpt-5-6-sol',
    );
    expect(copyOf(row('Premium'))).not.toContain('5 6');
  });

  /*
   * The pill is the readout half of the same fact, and it is pinned in `ModelTierPill.spec.tsx` — the
   * always-visible control is what a user reads on every turn, not the panel.
   */

  /**
   * CONTROL — the same assertions against the CLAUDE ladder, unchanged by the tri-family parser.
   *
   * Without it, generalising `parseModel` could rename every Claude rung and every assertion above would
   * still pass: they only ever look at the rungs the fixture moved.
   */
  it('CONTROL — an all-Claude ladder still reads exactly as it did', () => {
    openPanel();
    render(<ModelTierPanel />);

    expect(copyOf(row('Standard'))).toContain('Sonnet 5');
    expect(copyOf(row('Premium'))).toContain('Opus 5');
  });
});

/**
 * `parseModel`'s own derivation — the families, the dash-to-dot rule, the verbatim fallthrough and the
 * no-hardcoded-table source scan — lives with the unit in `app/lib/stores/model-tier.spec.ts`. Kept here
 * only as the seam this file depends on: the panel renders whatever that function returns.
 */
describe('parseModel', () => {
  it('is the single source of the names rendered above', () => {
    expect(parseModel('claude-sonnet-5').full).toBe('Sonnet 5');
    expect(parseModel('gpt-5-6-sol').full).toBe('GPT 5.6 Sol');
    expect(parseModel('gemini-3-5-flash').full).toBe('Gemini 3.5 Flash');
  });
});
