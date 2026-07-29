/**
 * The sandbox path is WATCHED, not merely logged (plan T13, SPEC §5A, `spec/sandbox-codesandbox.md`).
 *
 * Before `sandbox-rates.ts` every failure in `app/lib/.server/sandbox/*` was a `logger.warn` — invisible
 * in production — on the path that decides whether a user can open their project at all. That is rule 9
 * with a fuse on it: five metrics in this codebase have now died reporting zero, and a subsystem with no
 * metric at all is the same failure without the extra step.
 *
 * Three properties are pinned here, and each one fails SILENTLY if it regresses:
 *
 *   1. **The denominator exists.** A window fed only its failures reads 100% and alerts on the first
 *      one, which is how a rate signal turns into a per-event alarm somebody switches off. This is the
 *      property that cannot be seen by reading the alert's own output — a broken version still says
 *      "100% of recent sandbox creates failed", which looks exactly like a real outage.
 *   2. **The three windows are independent.** Creates failing must not implicate resumes, and neither
 *      may implicate the clean-boot window, which is not a failure window at all.
 *   3. **A CLEAN resume is its own signal at its own severity.** It is the closest thing this subsystem
 *      has to a data-loss indicator (the snapshot expired, the files are template state) and it is
 *      invisible to every failure metric because the request SUCCEEDED. Folding it into the failure
 *      rate would bury it; giving it `critical` would make operators mute a thing that is sometimes
 *      unavoidable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMonitor, type Monitor } from './index';
import { ALERT_SIGNALS } from './events';
import { resetRateWindows } from './failure-rate';
import { recordSandboxCleanBoot, recordSandboxOutcome } from './sandbox-rates';

interface Fired {
  signal: string;
  detail: string;
  severity?: string;
  tags?: Record<string, unknown>;
}

let fired: Fired[];
let monitor: Monitor;

beforeEach(() => {
  resetRateWindows();
  fired = [];
  monitor = {
    alert: (signal: string, detail: string, ctx?: { severity?: string; tags?: Record<string, unknown> }) =>
      void fired.push({ signal, detail, severity: ctx?.severity, tags: ctx?.tags }),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    track: vi.fn(),
  } as unknown as Monitor;
});

afterEach(() => {
  resetRateWindows();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('sandbox failure rate alerts as a RATE, never per event', () => {
  it('a healthy stream of successes is silent — and IS recorded', () => {
    /*
     * The successes are the denominator. They are recorded here purely so that the next test's
     * arithmetic is possible at all; on their own the only observable is silence.
     */
    for (let i = 0; i < 40; i++) {
      recordSandboxOutcome(monitor, 'create', false);
      recordSandboxOutcome(monitor, 'resume', false);
    }

    expect(fired).toHaveLength(0);
  });

  it('one failure in a healthy window is silent', () => {
    // A provider hiccup is ordinary. An alert on the first one is an alert nobody can leave switched on.
    recordSandboxOutcome(monitor, 'create', true);

    for (let i = 0; i < 30; i++) {
      recordSandboxOutcome(monitor, 'create', false);
    }

    expect(fired).toHaveLength(0);
  });

  it('a sustained failure rate alerts as critical, naming the fraction and what users cannot do', () => {
    /*
     * Half of opens failing is a product outage even while generation, billing and auth are all green —
     * the sandbox is where the user's game lives. `critical` (not `warning`) because there is no upside
     * to a failure here: the user is looking at a broken workbench.
     */
    for (let i = 0; i < 20; i++) {
      recordSandboxOutcome(monitor, 'resume', i % 2 === 0);
    }

    expect(fired.length).toBeGreaterThan(0);
    expect(fired[0].signal).toBe(ALERT_SIGNALS.SANDBOX_FAILURE_RATE);
    expect(fired[0].severity).toBe('critical');
    expect(fired[0].tags?.kind).toBe('resume');
    expect(fired[0].detail).toMatch(/50% of recent sandbox resumes failed/);
    expect(fired[0].detail).toMatch(/open their projects/);
  });

  it('names the CREATE case for what it is — nobody can start a new project', () => {
    /*
     * The two kinds are different outages and the alert has to say which: "cannot open the project you
     * have" and "cannot start a new one" get triaged differently, and a shared message would leave the
     * operator to guess from a tag.
     */
    for (let i = 0; i < 20; i++) {
      recordSandboxOutcome(monitor, 'create', true);
    }

    expect(fired[0].tags?.kind).toBe('create');
    expect(fired[0].detail).toMatch(/start new projects/);
  });

  /*
   * 🔴 THE DENOMINATOR. Recording only the failures puts the window at 100% and alerts on the eighth
   * one regardless of how healthy the platform is.
   *
   * ⚠️ The obvious version of this test (40 successes, then one failure) CANNOT fail: dropping the
   * successes leaves a single sample, below `minSamples`, so it stays silent either way — the trap
   * `paid-path-rates.spec.ts` documents. The failures have to be spread thinly enough that the two
   * versions disagree: 12 failures is above `minSamples` on its own, so the mutated code alerts, while
   * 12-in-120 is a 10% rate that the honest code correctly ignores.
   */
  it('successes are recorded too, so an occasional failure is not an incident', () => {
    for (let i = 0; i < 120; i++) {
      recordSandboxOutcome(monitor, 'create', i % 10 === 0);
    }

    expect(fired, '12 failures across 120 attempts is a 10% rate, not an outage').toHaveLength(0);
  });

  it('cools down instead of re-alerting on every subsequent attempt', () => {
    /*
     * A total outage produces a lot of samples fast. Without the cooldown this is one alert per failed
     * open — a pager storm that says nothing the first alert did not.
     */
    for (let i = 0; i < 60; i++) {
      recordSandboxOutcome(monitor, 'create', true);
    }

    expect(fired.length, 'a self-cooling window, not one alert per request').toBeLessThan(3);
  });
});

describe('the three windows are independent', () => {
  it('a broken create path never implicates resume or clean-boot', () => {
    /*
     * These are genuinely different failures — forking a VM and waking one go through different provider
     * endpoints — and mixing them would let a broken fork path make "your existing projects are fine"
     * unsayable. The clean-boot window matters most here: it is not a failure window, so a failure
     * leaking into it would read as data loss that never happened.
     */
    for (let i = 0; i < 40; i++) {
      recordSandboxOutcome(monitor, 'create', true);
      recordSandboxOutcome(monitor, 'resume', false);
      recordSandboxCleanBoot(monitor, false);
    }

    expect(new Set(fired.map((f) => f.signal))).toEqual(new Set([ALERT_SIGNALS.SANDBOX_FAILURE_RATE]));
    expect(new Set(fired.map((f) => f.tags?.kind))).toEqual(new Set(['create']));
  });

  it('a hot clean-boot window never implicates the failure windows', () => {
    for (let i = 0; i < 40; i++) {
      recordSandboxCleanBoot(monitor, true);
      recordSandboxOutcome(monitor, 'resume', false);
    }

    expect(new Set(fired.map((f) => f.signal))).toEqual(new Set([ALERT_SIGNALS.SANDBOX_CLEAN_BOOT_RATE]));
  });
});

describe('a CLEAN resume is a success with a cost, and gets its own signal', () => {
  it('alerts on its own signal at WARNING severity, explaining where the files came from', () => {
    /*
     * Warning, not critical: some CLEAN resumes are unavoidable — a project untouched for long enough
     * loses its snapshot and that is the provider working as documented. A quarter of them is the
     * actionable shape (snapshots expiring far faster than the hibernation config implies), and every
     * one of those users silently relied on the §4.5.4c working copy to refill a project that came up
     * looking like a fresh template.
     */
    for (let i = 0; i < 20; i++) {
      recordSandboxCleanBoot(monitor, true);
    }

    expect(fired[0].signal).toBe(ALERT_SIGNALS.SANDBOX_CLEAN_BOOT_RATE);
    expect(fired[0].severity).toBe('warning');
    expect(fired[0].detail).toMatch(/came back CLEAN/);
    expect(fired[0].detail).toMatch(/working copy/);
  });

  it('an ordinary RESUME stream is silent — the window has a denominator too', () => {
    /*
     * Same mutation guard as the failure windows, one window over: 12 CLEAN resumes is above
     * `minSamples` on its own, so a version that recorded only the clean ones would alert here.
     */
    for (let i = 0; i < 120; i++) {
      recordSandboxCleanBoot(monitor, i % 10 === 0);
    }

    expect(fired, '10% of resumes coming back CLEAN is ordinary snapshot expiry').toHaveLength(0);
  });
});

/*
 * Monitoring may never throw into a request path — `index.ts` rule 1, and the reason callers do NOT
 * wrap these in try/catch. The guarantee lives in `DefaultMonitor`, so it is tested THERE rather than
 * re-implemented as a second try/catch here: what has to hold is that the guarantee covers the way
 * THESE call sites use it (a real `getMonitor`, at the moment it actually alerts, with a hostile
 * transport underneath). A duplicated guard in `sandbox-rates.ts` would pass this test while hiding a
 * regression in the guarantee everything else depends on.
 */
describe('🔴 recording can never throw into the sandbox route', () => {
  const alertingBurst = (fn: () => void) => {
    for (let i = 0; i < 20; i++) {
      fn();
    }
  };

  it('survives a collector that throws synchronously, on the alerting path', () => {
    vi.stubEnv('MONITORING_WEBHOOK_URL', 'https://collector.example.com/hook');
    vi.stubGlobal('fetch', () => {
      throw new Error('the collector is on fire');
    });

    const real = getMonitor(undefined);

    expect(() => alertingBurst(() => recordSandboxOutcome(real, 'create', true))).not.toThrow();
    expect(() => alertingBurst(() => recordSandboxCleanBoot(real, true))).not.toThrow();
  });

  it('survives the quiet path too, where no alert is ever produced', () => {
    // A success records into the window and returns. Nothing here is allowed to fail an open either.
    const real = getMonitor(undefined);

    expect(() => alertingBurst(() => recordSandboxOutcome(real, 'resume', false))).not.toThrow();
    expect(() => alertingBurst(() => recordSandboxCleanBoot(real, false))).not.toThrow();
  });
});
