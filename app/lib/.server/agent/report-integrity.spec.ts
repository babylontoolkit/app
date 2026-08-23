/**
 * THE GUARD REPORTS IN PRODUCTION AND THROWS UNDER TEST — AND NOTHING WAS ASSERTING EITHER HALF.
 *
 * `reportIntegrity` is the one function in this feature that decides what a violation COSTS. Both of
 * its halves fail silently and in opposite directions, which is why they are pinned off one fixture:
 *
 *  - **If it throws in production**, a bookkeeping guard kills a paid turn the user has already been
 *    gated for — strictly worse than the defect it watches for (`spec/fail-loud.md`: *"observability
 *    itself"* is one of the two sanctioned silent swallows).
 *  - **If it never throws at all**, the feature degrades to a chart. `spec/fail-loud.md` rule 6 — *a
 *    guard is only real if a test fails when it is removed* — has nothing to bite on, and a guard that
 *    only ever reports is a guard nobody notices going quiet.
 *
 * The rate window is the third silent failure and it is a MEASURED one. Inheriting
 * `DEFAULT_FAILURE_RATE_CONFIG` (minSamples 10, threshold 0.5) means a single duplicate path or a
 * single lost handoff among twenty otherwise-healthy turns alerts ZERO times — i.e. the shared default
 * swallows precisely the low-frequency, high-cost incidents this signal was built for. That is
 * asserted here as a SCENARIO, not as a number: pinning the literal `0.1` goes green for a config that
 * is wrong in some other way, whereas driving one violation through twenty turns cannot.
 *
 * ⚠️ **`LONE_VIOLATION_ALERT_IS_ORDER_SENSITIVE` — FOUND WHILE WRITING THIS, REPORTED NOT FIXED.**
 * `FailureRateWindow.record` zeroes its cooldown on the sample that TRIPS the threshold, whoever that
 * sample is; `reportIntegrity` then suppresses the alert when the current turn is clean
 * (`found.length > 0 && outcome.shouldAlert`). So a violation followed immediately by healthy turns
 * trips the window on a HEALTHY sample, the alert is discarded, and the cooldown is spent anyway —
 * measured on the real config: violation-then-19-clean pages ZERO times, while two-clean-then-violation
 * pages once. The scenario below therefore uses the ordering that reflects the incident (a healthy
 * platform, then one bad request) rather than pinning the swallowed one as correct. The fix belongs in
 * production code, not here.
 *
 * And the wiring: `runAgentGeneration` cannot be constructed in a unit test (it boots the prompt store,
 * the ledger and a provider), so the call site is a source scan — the `budgets-wiring.spec.ts`
 * instrument, with the same CONTROLS, because a scanner whose pattern silently stops matching reports a
 * clean bill of health forever.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FAILURE_RATE_CONFIG, FailureRateWindow } from '~/lib/.server/monitoring/failure-rate';
import type { IntegrityReport, InvariantViolation } from './request-invariants';
import { REQUEST_INTEGRITY_RATE_CONFIG, defaultIntegrityMode, reportIntegrity } from './request-invariants';

/* ONE fixture for both directions. "Reports here, throws there" is only a claim about the same input. */
const VIOLATION: InvariantViolation = {
  invariant: 'INV-1',
  detail: "src/pages/Home.tsx also arrived as '/home/project/src/pages/Home.tsx'",
};

/** A window that always says "worth alerting", so the reporter half is reachable without arithmetic. */
const alwaysAlert = () => ({ record: vi.fn(() => ({ shouldAlert: true, rate: 1 })) });

describe('reportIntegrity — production reports, test throws', () => {
  it('does NOT throw in report mode, and hands the violation to the reporter', () => {
    const reporter = { alert: vi.fn() };
    const window = alwaysAlert();

    let report: IntegrityReport | undefined;

    /*
     * Asserted as an explicit non-throw rather than by simply calling it: a bare call that happens not
     * to throw proves nothing about a mutation that makes it throw — the test would fail with an
     * unhandled error rather than with a statement about the behaviour under test.
     */
    expect(() => {
      report = reportIntegrity([VIOLATION], { mode: 'report', reporter, window });
    }).not.toThrow();

    expect(report?.violations).toEqual([VIOLATION]);
    expect(report?.shouldAlert).toBe(true);

    /* The alert has to NAME the invariant, or the pager says "something was wrong" and nothing else. */
    expect(reporter.alert).toHaveBeenCalledTimes(1);
    expect(reporter.alert.mock.calls[0][0]).toContain('INV-1');
    expect(reporter.alert.mock.calls[0][0]).toContain('Home.tsx');
    expect(reporter.alert.mock.calls[0][1]).toMatchObject({ invariants: 'INV-1' });
  });

  it('DOES throw in throw mode, on the same input, naming the invariant and its detail', () => {
    expect(() => reportIntegrity([VIOLATION], { mode: 'throw', window: alwaysAlert() })).toThrow(/INV-1/);
    expect(() => reportIntegrity([VIOLATION], { mode: 'throw', window: alwaysAlert() })).toThrow(/Home\.tsx/);
  });

  it('still reports before it throws — a failing suite must also leave the monitor trail', () => {
    const reporter = { alert: vi.fn() };

    expect(() => reportIntegrity([VIOLATION], { mode: 'throw', reporter, window: alwaysAlert() })).toThrow();
    expect(reporter.alert).toHaveBeenCalledTimes(1);
  });

  it('throws under VITEST and reports when nothing marks the process as a test', () => {
    expect(defaultIntegrityMode()).toBe('throw');

    /*
     * ⚠️ `vi.stubEnv(..., undefined)` rather than reading the ambient environment. This repo has a
     * recorded trap (`oauth.spec.ts`): a spec asserting an UNCONFIGURED state resolved the developer's
     * real environment instead, so it passed in CI and failed only for the person who had configured
     * the thing — teaching the one developer who can see it that a red suite is normal.
     */
    vi.stubEnv('VITEST', undefined);
    vi.stubEnv('NODE_ENV', undefined);
    expect(defaultIntegrityMode()).toBe('report');

    vi.unstubAllEnvs();
  });
});

describe('a healthy turn is still a sample', () => {
  it('records a clean generation in the window', () => {
    const reporter = { alert: vi.fn() };
    const window = { record: vi.fn(() => ({ shouldAlert: false, rate: 0 })) };

    const report = reportIntegrity([], { mode: 'report', reporter, window });

    /*
     * 🔴 THE DENOMINATOR. A window fed only failures has no denominator, so its rate is always 1.0 and
     * the threshold means nothing — every sample would trip it forever. The healthy turn is what makes
     * "10% of the last twenty" a sentence about anything.
     */
    expect(window.record).toHaveBeenCalledWith(false);
    expect(reporter.alert).not.toHaveBeenCalled();
    expect(report.violations).toEqual([]);
    expect(report.shouldAlert).toBe(false);
  });

  /*
   * 🔴 THE ORDERING HALF, and the reason there is no `found.length > 0 &&` gate on the alert.
   *
   * `FailureRateWindow` zeroes its cooldown on whichever sample TRIPS the threshold, and that sample
   * is frequently a HEALTHY one: a violation enters the window and the rate crosses on the next clean
   * turn. Gating the alert on this turn's violations discards it and burns the twenty-sample cooldown
   * anyway, so a lone violation followed by healthy traffic pages ZERO times — measured on the real
   * config as `[violation, x19 clean]` firing at sample 3 and being swallowed.
   *
   * So a clean turn on a window that says "alert" MUST alert, and must say why it looks clean.
   */
  it('alerts on a clean turn when the WINDOW crossed on it, and says so', () => {
    const reporter = { alert: vi.fn() };
    const window = { record: vi.fn(() => ({ shouldAlert: true, rate: 0.33 })) };

    const report = reportIntegrity([], { mode: 'report', reporter, window });

    expect(reporter.alert).toHaveBeenCalledTimes(1);
    expect(reporter.alert.mock.calls[0][0]).toContain('33%');
    expect(reporter.alert.mock.calls[0][0]).toContain('this turn was clean');
    expect(report.shouldAlert).toBe(true);
  });

  it('does not throw on a clean turn even in throw mode', () => {
    expect(() => reportIntegrity([], { mode: 'throw', window: alwaysAlert() })).not.toThrow();
  });
});

describe('rate limiting, against a real window', () => {
  /*
   * Constructed directly rather than via `sharedRateWindow`: the shared map is process-global and the
   * proxy owns the `'request-integrity'` name. A spec that reaches into it is one `resetRateWindows()`
   * away from being order-dependent, and worse, could fix the live window's config from a test.
   */
  let window: FailureRateWindow;

  beforeEach(() => {
    window = new FailureRateWindow(REQUEST_INTEGRITY_RATE_CONFIG);
  });

  const feed = (outcomes: readonly boolean[], reporter: { alert: ReturnType<typeof vi.fn> }) => {
    for (const violating of outcomes) {
      reportIntegrity(violating ? [VIOLATION] : [], { mode: 'report', reporter, window });
    }
  };

  it('alerts ONCE for a run of consecutive violations', () => {
    const reporter = { alert: vi.fn() };

    feed(
      Array.from({ length: 10 }, () => true),
      reporter,
    );

    expect(reporter.alert).toHaveBeenCalledTimes(1);
  });

  /*
   * CONTROL for the one above. "Exactly one alert" also passes for a window that alerts once and then
   * never again — which is the muted pager wearing the cooldown's clothes. A sustained incident must
   * come back once the cooldown has been paid for in samples.
   */
  it('alerts AGAIN once the cooldown has been spent, and not before', () => {
    const reporter = { alert: vi.fn() };
    const { cooldownSamples } = REQUEST_INTEGRITY_RATE_CONFIG;

    /* The first alert lands as soon as `minSamples` is met; the next cannot until `cooldownSamples`. */
    feed(
      Array.from({ length: cooldownSamples }, () => true),
      reporter,
    );
    expect(reporter.alert).toHaveBeenCalledTimes(1);

    feed(
      Array.from({ length: 3 }, () => true),
      reporter,
    );
    expect(reporter.alert).toHaveBeenCalledTimes(2);
  });

  /*
   * 🔴 THE CONFIG TEST THAT MATTERS, written as a scenario because the number is not the point.
   *
   * One duplicated path in twenty otherwise-healthy turns IS the incident class this was built for —
   * one project's file map double-keyed for weeks at ~22.5k tokens a turn. If it does not page, the
   * signal is decorative. Pinning `threshold === 0.1` instead would go green for a config that is
   * wrong in some other way; this cannot.
   *
   * ⚠️ The healthy turns come FIRST, and that is not cosmetic — it is the shape of the incident (a
   * platform serving fine, then one turn assembles a bad request). It is also the only shape that
   * works today: see the header note of the same
   * name.
   */
  const HEALTHY_TURNS = 19;

  it('a LONE violation among twenty otherwise-healthy turns still alerts', () => {
    const reporter = { alert: vi.fn() };

    feed([false, false, true, ...Array.from({ length: HEALTHY_TURNS - 2 }, () => false)], reporter);

    expect(reporter.alert.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  /*
   * CONTROL — and the measurement that made the config its own constant. The same scenario, through the
   * INHERITED default, alerts zero times: `minSamples: 10, threshold: 0.5` is tuned for "is a subsystem
   * broken", where half of everything failing is the interesting state. Without this the test above
   * passes for a config that has silently reverted to the shared default.
   */
  it('the same lone violation is silenced entirely by the shared default config', () => {
    const reporter = { alert: vi.fn() };
    window = new FailureRateWindow(DEFAULT_FAILURE_RATE_CONFIG);

    feed([false, false, true, ...Array.from({ length: HEALTHY_TURNS - 2 }, () => false)], reporter);

    expect(reporter.alert).not.toHaveBeenCalled();
  });
});

describe('the guard cannot be killed by its own bookkeeping', () => {
  /*
   * The `execution-queue` lesson: a guard whose survival depends on a monitoring library has moved the
   * silent failure one level down. `onError` is required, not politeness — and here the requirement is
   * stronger, because the proxy calls this BARE so that the deliberate test-mode throw is the only
   * thing able to escape.
   */
  it('survives a reporter whose alert throws', () => {
    const reporter = {
      alert: () => {
        throw new Error('monitoring transport is down');
      },
    };

    expect(() => reportIntegrity([VIOLATION], { mode: 'report', reporter })).not.toThrow();
  });

  it('survives a rate window whose record throws', () => {
    const window = {
      record: () => {
        throw new Error('window exploded');
      },
    };

    expect(() => reportIntegrity([VIOLATION], { mode: 'report', window })).not.toThrow();
    expect(() => reportIntegrity([], { mode: 'report', window })).not.toThrow();
  });
});

/* ------------------------------------------------------------------ wiring */

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

/** Comments quote these identifiers constantly; a scan that counts prose proves nothing. */
const codeOnly = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    .join('\n');

const proxy = () => codeOnly(read('app/lib/.server/agent/proxy.ts'));

describe('the proxy calls the guard once, bare, with its own window', () => {
  it('reports exactly once per generation', () => {
    expect(proxy().match(/reportIntegrity\(/g)).toHaveLength(1);
  });

  /*
   * 🔴 NOT WRAPPED. Everything that could throw for an uninteresting reason (the reporter, the window)
   * is already wrapped INSIDE `reportIntegrity`, so a `try/catch` here would catch exactly one thing:
   * the deliberate test-mode throw. That turns "it throws under test" into a sentence in a comment.
   */
  it('calls it bare — no try/catch at the call site', () => {
    const source = proxy();
    const index = source.indexOf('reportIntegrity(');

    expect(index, 'reportIntegrity call not found').toBeGreaterThan(-1);
    expect(source.slice(Math.max(0, index - 200), index)).not.toContain('try {');
  });

  /*
   * `sharedRateWindow` fixes a window's config on FIRST use, so a bare `sharedRateWindow('request-
   * integrity')` here would silently inherit the shared default — the config whose control above shows
   * it alerts zero times on the incident class this exists for.
   */
  it('creates the request-integrity window with the request-integrity config', () => {
    expect(proxy()).toMatch(/sharedRateWindow\(\s*'request-integrity',\s*REQUEST_INTEGRITY_RATE_CONFIG,?\s*\)/);
  });

  it('routes the alert through the declared signal', () => {
    expect(proxy()).toMatch(/ALERT_SIGNALS\.REQUEST_INTEGRITY/);
  });

  /*
   * 🔴 INV-4 INTERROGATES THE PAYLOAD. `checkHandoffRecorded(observedHandoffs, recordedHandoffs)` is
   * `f(x, x)` — the second argument derived from the first one line above — and cannot fire for any
   * input. The check has to read the object that is ABOUT TO BE PERSISTED, so that dropping the field
   * from the record is what the guard notices.
   */
  it('reads the handoffs back off the row it is about to persist', () => {
    const source = proxy();

    expect(source).toContain('checkHandoffRecorded(observedHandoffs, generationRow.fallbackHandoffs)');
    expect(source).not.toContain('checkHandoffRecorded(observedHandoffs, recordedHandoffs)');
  });
});

describe('CONTROLS — the scanner still reads the file it thinks it does', () => {
  it('finds the proxy, and it is a real module', () => {
    const source = proxy();

    expect(source.length).toBeGreaterThan(10_000);
    expect(source).toContain('runAgentGeneration');
  });

  it('strips comments rather than matching prose', () => {
    const stripped = codeOnly(['/* reportIntegrity(x) */', 'const real = 1;', '// reportIntegrity(y)'].join('\n'));

    expect(stripped).toContain('const real = 1;');
    expect(stripped).not.toContain('reportIntegrity(x)');
    expect(stripped).not.toContain('reportIntegrity(y)');
  });

  /* The locators must find something, or the emptiness/absence guards above assert nothing at all. */
  it('locates every construct it asserts on', () => {
    const source = proxy();

    expect(source).toContain('reportIntegrity(');
    expect(source).toContain('sharedRateWindow(');
    expect(source).toContain('checkHandoffRecorded(');
  });

  /* The absence assertion is only meaningful if the string it looks for is one the scanner could see. */
  it('would see a wrapped call if there were one', () => {
    const wrapped = codeOnly(['      try {', '        reportIntegrity(issues, {});', '      } catch {}'].join('\n'));
    const index = wrapped.indexOf('reportIntegrity(');

    expect(wrapped.slice(Math.max(0, index - 200), index)).toContain('try {');
  });
});
