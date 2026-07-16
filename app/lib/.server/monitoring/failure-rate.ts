/**
 * Generation failure-rate signal (SPEC §5A "alerting on generation failure rate").
 *
 * A single failed generation is not an incident — generations fail for ordinary reasons (a provider
 * hiccup, a model that returned no text; both auto-refund, §4.6). What ops needs to hear about is a
 * RATE: "one in three generations is failing right now" means something is broken platform-wide.
 *
 * This is a bounded in-process ring buffer of recent outcomes. In-process is the right scope: we run
 * one container per environment (spec/hosting.md), and a rate over the last N generations that THIS
 * instance served is exactly the local health signal. It is deliberately NOT a database read — the
 * alert must fire even when the database is the thing that is down.
 *
 * Pure and reset-able so the threshold logic is unit-tested, never discovered in production.
 */

export interface FailureRateConfig {
  /** Don't judge a rate until we have at least this many samples — 1/1 is noise, not a trend. */
  minSamples: number;

  /** Alert when the failing fraction over the window meets or exceeds this (0..1). */
  threshold: number;

  /** How many recent outcomes to keep. The rate is computed over exactly this window. */
  windowSize: number;

  /** Don't re-alert on every failure once tripped; wait this many samples before it can fire again. */
  cooldownSamples: number;
}

export const DEFAULT_FAILURE_RATE_CONFIG: FailureRateConfig = {
  minSamples: 10,
  threshold: 0.5,
  windowSize: 20,
  cooldownSamples: 20,
};

export interface FailureRateResult {
  shouldAlert: boolean;
  rate: number;
  window: number;
  failures: number;
}

/**
 * A window of recent generation outcomes. One instance per server process (see `sharedFailureRate`).
 */
export class FailureRateWindow {
  private readonly _outcomes: boolean[] = [];
  private _sinceLastAlert = Infinity;

  constructor(private readonly _config: FailureRateConfig = DEFAULT_FAILURE_RATE_CONFIG) {}

  /** Record one outcome. Returns whether this pushes the window over the alert threshold. */
  record(failed: boolean): FailureRateResult {
    this._outcomes.push(failed);

    if (this._outcomes.length > this._config.windowSize) {
      this._outcomes.shift();
    }

    this._sinceLastAlert = Math.min(this._sinceLastAlert + 1, Number.MAX_SAFE_INTEGER);

    const window = this._outcomes.length;
    const failures = this._outcomes.filter(Boolean).length;
    const rate = window > 0 ? failures / window : 0;

    const overThreshold = window >= this._config.minSamples && rate >= this._config.threshold;
    const cooledDown = this._sinceLastAlert >= this._config.cooldownSamples;
    const shouldAlert = overThreshold && cooledDown;

    if (shouldAlert) {
      this._sinceLastAlert = 0;
    }

    return { shouldAlert, rate, window, failures };
  }

  /** Test seam — start clean. */
  reset(): void {
    this._outcomes.length = 0;
    this._sinceLastAlert = Infinity;
  }
}

let shared: FailureRateWindow | undefined;

/** The process-wide window the proxy records into. */
export function sharedFailureRate(): FailureRateWindow {
  if (!shared) {
    shared = new FailureRateWindow();
  }

  return shared;
}
