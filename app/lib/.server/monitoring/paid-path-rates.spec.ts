/**
 * The rescue markers and refunds are WATCHED, not merely recorded (`spec/fail-loud.md` Stage C).
 *
 * Rule 9 is the reason this file exists: a metric nobody reads is the same failure as a metric that
 * reports zero, with an extra step. Five metrics in this codebase have now died reporting success on
 * the failure they were named for — and `+unproductive-rescue` is the most dangerous shape yet,
 * because when it fires the user gets what they asked for. The turn looks ordinary. Only a RATE says
 * that the platform is buying a second stream on a quarter of generations to make that true.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Monitor } from './index';
import { resetRateWindows } from './failure-rate';
import { recordRefundOutcome, recordRescueMarkers, RESCUE_MARKERS } from './paid-path-rates';

interface Fired {
  signal: string;
  detail: string;
  tags?: Record<string, unknown>;
}

let fired: Fired[];
let monitor: Monitor;

const NOTHING = { forcedContinuation: false, unproductiveRescue: false, providerRetry: false };

beforeEach(() => {
  resetRateWindows();
  fired = [];
  monitor = {
    alert: (signal: string, detail: string, ctx?: { tags?: Record<string, unknown> }) =>
      void fired.push({ signal, detail, tags: ctx?.tags }),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    track: vi.fn(),
  } as unknown as Monitor;
});

afterEach(() => resetRateWindows());

describe('rescue markers alert as a RATE, never per event', () => {
  /*
   * The distinction that makes this a signal rather than an alarm. A rescue firing is the machinery
   * WORKING — the user got their spec instead of their money back — so an alert on the first one is
   * an alert nobody can leave switched on, and an alert nobody leaves on is no alert.
   */
  it('one rescue in a healthy window is silent', () => {
    recordRescueMarkers(monitor, { ...NOTHING, unproductiveRescue: true });

    for (let i = 0; i < 30; i++) {
      recordRescueMarkers(monitor, NOTHING);
    }

    expect(fired).toHaveLength(0);
  });

  it('a sustained rescue rate alerts, naming the marker and the fraction', () => {
    // Every other generation needing a rescue is not "sometimes"; it is a regression being absorbed.
    for (let i = 0; i < 20; i++) {
      recordRescueMarkers(monitor, { ...NOTHING, unproductiveRescue: i % 2 === 0 });
    }

    expect(fired.length).toBeGreaterThan(0);
    expect(fired[0].signal).toBe('rescue_marker_rate');
    expect(fired[0].tags?.marker).toBe(RESCUE_MARKERS.UNPRODUCTIVE_RESCUE);
    expect(fired[0].detail).toMatch(/50% of recent generations/);
  });

  it('the markers are independent — a hot one does not implicate the quiet ones', () => {
    for (let i = 0; i < 20; i++) {
      recordRescueMarkers(monitor, { ...NOTHING, providerRetry: true });
    }

    expect(new Set(fired.map((f) => f.tags?.marker))).toEqual(new Set([RESCUE_MARKERS.PROVIDER_RETRY]));
  });

  /*
   * 🔴 THE DENOMINATOR. Recording only the firings would put every window at 100% and alert on the
   * very first rescue — turning the rate back into a per-event alarm. This is the one property that
   * cannot be seen by reading the alert's own output, because a broken version still says "100%".
   */
  it('healthy generations are recorded too, so the rate has a denominator', () => {
    /*
     * Twelve rescues — enough to fill the window's `minSamples` on their own — spread thinly across
     * 120 generations. WITH the denominator the trailing window holds ~4 firings in 40 and stays
     * quiet; WITHOUT it the window is twelve samples that are all `true`, a 100% rate, and it alerts.
     *
     * ⚠️ The obvious version of this test (40 healthy, then one rescue) CANNOT fail: dropping the
     * denominator leaves a single sample, which is below `minSamples`, so it passes either way. A
     * test that cannot distinguish the mutation is decoration — it took the mutation run to find that.
     */
    for (let i = 0; i < 120; i++) {
      recordRescueMarkers(monitor, { ...NOTHING, forcedContinuation: i % 10 === 0 });
    }

    expect(fired, '12 rescues across 120 generations is a 10% rate, not an incident').toHaveLength(0);
  });

  it('cools down instead of re-alerting on every subsequent generation', () => {
    for (let i = 0; i < 60; i++) {
      recordRescueMarkers(monitor, { ...NOTHING, unproductiveRescue: true });
    }

    expect(fired.length, 'a self-cooling window, not one alert per turn').toBeLessThan(3);
  });
});

describe('refund rate is per ledger reason', () => {
  it('alerts when a reason keeps refunding, and says which one', () => {
    for (let i = 0; i < 20; i++) {
      recordRefundOutcome(monitor, 'media', true);
    }

    expect(fired[0].signal).toBe('refund_rate');
    expect(fired[0].tags?.reason).toBe('media');
    expect(fired[0].detail).toMatch(/'media'/);
  });

  it('a healthy reason stays silent while a broken one alerts', () => {
    for (let i = 0; i < 20; i++) {
      recordRefundOutcome(monitor, 'media', true);
      recordRefundOutcome(monitor, 'generation', false);
    }

    expect(new Set(fired.map((f) => f.tags?.reason))).toEqual(new Set(['media']));
  });

  it('delivered work is recorded, so an occasional refund is not an incident', () => {
    /*
     * Same denominator property as the rescue side, and the same trap: ten refunds is `minSamples`, so
     * dropping the denominator makes this window 100% and alert. Spread them thin enough to tell apart.
     */
    for (let i = 0; i < 100; i++) {
      recordRefundOutcome(monitor, 'generation', i % 10 === 0);
    }

    expect(fired, '10 refunds across 100 generations is a 10% rate').toHaveLength(0);
  });
});
