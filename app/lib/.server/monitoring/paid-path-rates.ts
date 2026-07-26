/**
 * Rates on the paid path — the watching half of the markers (`spec/fail-loud.md` Stage C, SPEC §5A).
 *
 * `+unproductive-rescue`, `+forced-continuation`, `+provider-retry` and the per-reason refunds are
 * all RECORDED today: they land in `generations.finish_reason` and in the ledger, and the §4.10 panels
 * can chart them. Nothing WATCHES them. That gap is rule 9 with a fuse on it — *"when you fix a
 * pathology, re-derive whether its metric still measures it"* — because five metrics in this codebase
 * have now died reporting zero, and a marker nobody reads is the same failure with an extra step.
 *
 * The premise these alerts exist to make actionable is already written in `proxy.ts`'s comments and is
 * worth stating here too: **a rescue firing OFTEN means the cause is upstream of the rescue, and the
 * rescue is only paying for it.** One `+unproductive-rescue` is the machinery working — the user got
 * their spec instead of their money back. A quarter of generations needing one is a prompt, a model or
 * a provider regression, and the rescue is quietly absorbing it at 5x output rate forever.
 *
 * Same shape and same scope as `failure-rate.ts`: bounded in-process ring buffers, no database read
 * (the alert must fire when the database is what is down), thresholds chosen so a single occurrence is
 * never an incident. The functions here are thin — the judgement is in `FailureRateWindow`, which is
 * pure and separately tested.
 */
import type { Monitor } from './index';
import { ALERT_SIGNALS } from './events';
import { sharedRateWindow, type FailureRateConfig } from './failure-rate';

/**
 * The automatic transitions worth watching. Each is a marker `proxy.ts` already writes into
 * `finish_reason`; the string here IS that marker, so a rename cannot leave the alert watching a
 * signal that no longer exists under a name nobody greps for.
 */
export const RESCUE_MARKERS = {
  FORCED_CONTINUATION: 'forced-continuation',
  UNPRODUCTIVE_RESCUE: 'unproductive-rescue',
  PROVIDER_RETRY: 'provider-retry',
} as const;

export type RescueMarker = (typeof RESCUE_MARKERS)[keyof typeof RESCUE_MARKERS];

/**
 * A rescue is EXPECTED to fire sometimes, so the threshold is well above zero — but a quarter of
 * generations is not "sometimes", it is a regression being absorbed. The window is deliberately wider
 * than the failure window (40 vs 20): rescues are rarer than failures, so a narrow window would swing
 * over the threshold on two unlucky turns.
 */
const RESCUE_RATE_CONFIG: FailureRateConfig = {
  minSamples: 12,
  threshold: 0.25,
  windowSize: 40,
  cooldownSamples: 40,
};

/**
 * Refunds should be rare in absolute terms — every one is a failed piece of paid work. A fifth of a
 * subsystem's units of work ending in a refund means that subsystem is broken, not unlucky.
 */
const REFUND_RATE_CONFIG: FailureRateConfig = {
  minSamples: 10,
  threshold: 0.2,
  windowSize: 50,
  cooldownSamples: 50,
};

export interface RescueMarkerOutcome {
  forcedContinuation: boolean;
  unproductiveRescue: boolean;
  providerRetry: boolean;
}

/**
 * Record one generation's rescue markers, alerting on any that has crossed its rate.
 *
 * ⚠️ EVERY generation is recorded, not only the rescued ones — a rate needs its denominator. Recording
 * only the firings would make every window 100% and alert on the first one, which is how a rate signal
 * turns into a per-event alarm nobody can leave switched on.
 */
export function recordRescueMarkers(monitor: Monitor, outcome: RescueMarkerOutcome): void {
  const fired: Array<[RescueMarker, boolean]> = [
    [RESCUE_MARKERS.FORCED_CONTINUATION, outcome.forcedContinuation],
    [RESCUE_MARKERS.UNPRODUCTIVE_RESCUE, outcome.unproductiveRescue],
    [RESCUE_MARKERS.PROVIDER_RETRY, outcome.providerRetry],
  ];

  for (const [marker, happened] of fired) {
    const result = sharedRateWindow(`rescue:${marker}`, RESCUE_RATE_CONFIG).record(happened);

    if (result.shouldAlert) {
      monitor.alert(
        ALERT_SIGNALS.RESCUE_MARKER_RATE,
        `+${marker} fired on ${(result.rate * 100).toFixed(0)}% of recent generations ` +
          `(${result.failures}/${result.window}). The rescue is working; something upstream of it is not.`,
        { severity: 'warning', scope: 'paid-path-rates', tags: { marker } },
      );
    }
  }
}

/** The ledger reasons whose work can end in a refund (`spec/fail-loud.md` §Scope). */
export type RefundableReason = 'generation' | 'media' | 'license';

/**
 * Record whether one unit of paid work ended in a refund, alerting when a reason's rate crosses.
 *
 * "Unit of work" is per reason and is the thing the user asked for: one generation, one media task
 * reaching a terminal state, one license issue. Called once per unit with `false` when it delivered —
 * the denominator again.
 */
export function recordRefundOutcome(monitor: Monitor, reason: RefundableReason, refunded: boolean): void {
  const result = sharedRateWindow(`refund:${reason}`, REFUND_RATE_CONFIG).record(refunded);

  if (result.shouldAlert) {
    monitor.alert(
      ALERT_SIGNALS.REFUND_RATE,
      `${(result.rate * 100).toFixed(0)}% of recent '${reason}' work was refunded ` +
        `(${result.failures}/${result.window}) — the operator is absorbing a cost the provider already billed.`,
      { severity: 'critical', scope: 'paid-path-rates', tags: { reason } },
    );
  }
}
