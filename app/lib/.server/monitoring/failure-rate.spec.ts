import { describe, expect, it } from 'vitest';
import { FailureRateWindow } from './failure-rate';

describe('FailureRateWindow', () => {
  const config = { minSamples: 4, threshold: 0.5, windowSize: 6, cooldownSamples: 6 };

  it('does not alert before minSamples, however bad the early run', () => {
    const w = new FailureRateWindow(config);

    // Three straight failures — 100% rate, but below the sample floor.
    expect(w.record(true).shouldAlert).toBe(false);
    expect(w.record(true).shouldAlert).toBe(false);
    expect(w.record(true).shouldAlert).toBe(false);
  });

  it('alerts once the failing fraction crosses the threshold with enough samples', () => {
    const w = new FailureRateWindow(config);
    w.record(true);
    w.record(true);
    w.record(false);

    const r = w.record(true); // 3/4 = 0.75 >= 0.5, window 4 >= minSamples 4

    expect(r.shouldAlert).toBe(true);
    expect(r.rate).toBeCloseTo(0.75);
    expect(r.failures).toBe(3);
  });

  it('does not alert when the rate is healthy', () => {
    const w = new FailureRateWindow(config);
    w.record(false);
    w.record(false);
    w.record(true);

    const r = w.record(false); // 1/4 = 0.25 < 0.5

    expect(r.shouldAlert).toBe(false);
  });

  it('respects the cooldown — one alert, then silence until it cools down', () => {
    const w = new FailureRateWindow({ ...config, cooldownSamples: 3 });
    w.record(true);
    w.record(true);
    w.record(true);
    expect(w.record(true).shouldAlert).toBe(true); // first trip

    // Still failing, but within cooldown — must stay quiet.
    expect(w.record(true).shouldAlert).toBe(false);
    expect(w.record(true).shouldAlert).toBe(false);

    // Cooldown elapsed (3 samples since the alert) and still over threshold → fires again.
    expect(w.record(true).shouldAlert).toBe(true);
  });

  it('slides the window — old failures age out and stop counting', () => {
    const w = new FailureRateWindow({ ...config, windowSize: 4, minSamples: 4, cooldownSamples: 1 });
    w.record(true);
    w.record(true);

    // Fill the rest of the window with successes and push the failures out.
    w.record(false);
    w.record(false);
    w.record(false);

    const r = w.record(false); // window now [F,F,F,F] → 0 failures

    expect(r.window).toBe(4);
    expect(r.failures).toBe(0);
    expect(r.shouldAlert).toBe(false);
  });
});
