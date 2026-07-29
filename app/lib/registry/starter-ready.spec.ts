/**
 * The last two steps of creation — `npm install` and the dev server binding a port (plan T6).
 *
 * The owner's success condition for New Project is *"npm install + npm run dev and showing the starter
 * app template basic home page"*, so this wait is what the splash sits on top of. Both of its wrong
 * answers are silent, and they are silent in opposite directions:
 *
 *   - too SHORT dismisses the splash on a project whose preview is blank, which reads as "the product
 *     made me a broken thing" at the exact moment a user's first project appears;
 *   - too LONG — or unbounded — hangs the New Project button behind somebody else's slow install, with
 *     no error anywhere and no way out (§1.3 principle 0, degrade never block).
 *
 * So the properties pinned here are the BOUNDS and the NARRATION, not the shape of either loop: it must
 * cost ~one poll when the answer is already known, it must survive an install or a port arriving late,
 * it must announce each stage exactly once and in order, and above all it must TERMINATE — an unbounded
 * version hangs the mount forever and looks exactly like a broken product.
 *
 * Driven with an INJECTED clock, like `settle.spec.ts` and `port-settle.spec.ts`: every rule here is
 * about ordering and duration, neither of which needs a real timer, and a spec that actually slept
 * would take four minutes to assert the install ceiling once.
 */
import { describe, expect, it } from 'vitest';
import {
  CREATION_INSTALL_TIMEOUT_MS,
  CREATION_READY_POLL_MS,
  CREATION_SERVE_TIMEOUT_MS,
  awaitStarterRunning,
  type StarterReadyStage,
} from './starter-ready';

/**
 * A fake clock whose `wait` only ADVANCES time and records what it was asked for.
 *
 * Elapsed time in the implementation is the SUM OF THE POLLS rather than `Date.now()` — the same rule
 * `port-settle` and the ledger's `seq` ordering record — which is precisely what makes the ceilings
 * assertable instead of flaky. `elapsed` here is therefore the production clock, read the same way the
 * production code counts it.
 *
 * Both predicates are functions of that clock, so a test says "the install finishes at 4s" rather than
 * counting reads: this module reads `installComplete` once before its loop and once per poll, and a
 * read-indexed fixture silently encodes that call pattern into every assertion.
 */
function harness(options: { installAt?: number; portAt?: number } = {}) {
  const waits: number[] = [];
  const stages: StarterReadyStage[] = [];
  let installReads = 0;
  let previewReads = 0;

  const elapsed = () => waits.reduce((sum, ms) => sum + ms, 0);

  return {
    waits,
    stages,
    elapsed,
    get installReads() {
      return installReads;
    },
    get previewReads() {
      return previewReads;
    },
    options: {
      installComplete: () => {
        installReads++;
        return options.installAt !== undefined && elapsed() >= options.installAt;
      },
      runningPreviews: () => {
        previewReads++;
        return options.portAt !== undefined && elapsed() >= options.portAt ? 1 : 0;
      },
      wait: async (ms: number) => {
        waits.push(ms);
      },
      onStage: (stage: StarterReadyStage) => {
        stages.push(stage);
      },
    },
  };
}

describe('awaitStarterRunning — the install stage', () => {
  /**
   * The warm path, and the common one on a forked CodeSandbox template where `node_modules` is baked in
   * and `npm install` is a ~2s "up to date". Every poll spent here is a poll the user watches a
   * full-screen overlay for after the work it describes has finished.
   */
  it('costs zero waits when the install is already complete on entry', async () => {
    const h = harness({ installAt: 0, portAt: 0 });

    const result = await awaitStarterRunning(h.options);

    expect(result.installed).toBe(true);
    expect(h.waits).toEqual([]);
    expect(result.elapsedMs).toBe(0);
  });

  /** The ordinary case: the install finishes partway through its window and the wait ends there. */
  it('returns as soon as the install finishes, not at the ceiling', async () => {
    const h = harness({ installAt: 2_000, portAt: 2_000 });

    const result = await awaitStarterRunning(h.options);

    expect(result.installed).toBe(true);
    expect(h.elapsed()).toBe(2_000);
    expect(h.elapsed()).toBeLessThan(CREATION_INSTALL_TIMEOUT_MS);
  });

  /**
   * 🔴 THE INSTALL CEILING. A cold WebContainer install of the full starter tree is the slow case this
   * narration exists for — and an install that is slower still, or wedged, must not hold the overlay
   * open forever. Reaching the ceiling is NORMAL and SILENT: the project exists, the install keeps
   * running in the terminal behind the splash.
   *
   * The poll count is pinned to the exact ceiling so an unbounded mutation cannot pass by merely
   * running "a bit longer"; and because the harness never really sleeps, an unbounded version HANGS
   * this test rather than failing it — which is itself the signal (`settleAfterCreation`'s ceiling test
   * records the same shape).
   */
  it('gives up at the install ceiling when the install never completes', async () => {
    const h = harness({ portAt: 0 });

    const result = await awaitStarterRunning(h.options);

    expect(result.installed).toBe(false);

    const installWaits = h.waits.slice(0, Math.ceil(CREATION_INSTALL_TIMEOUT_MS / CREATION_READY_POLL_MS));
    expect(installWaits.reduce((sum, ms) => sum + ms, 0)).toBe(CREATION_INSTALL_TIMEOUT_MS);
  });

  /**
   * 🔴 An install that never finished must NOT short-circuit the serve stage. On a forked template the
   * dev server is baked in and may already be up, so concluding "not installed, therefore not serving"
   * would dismiss the splash a fraction of a second before the home page it was waiting for appears —
   * and would hide the one stage that has something to show.
   */
  it('still runs the serve stage after the install times out', async () => {
    const h = harness({ portAt: CREATION_INSTALL_TIMEOUT_MS });

    const result = await awaitStarterRunning(h.options);

    expect(result.installed).toBe(false);
    expect(result.serving).toBe(true);
    expect(h.stages).toEqual(['install', 'serve']);
  });

  /**
   * The predicate is re-read on every poll rather than captured once — that IS the mechanism. Pinned as
   * a property so a "read it once" simplification, which makes every late completion unreachable, fails
   * here as well as above.
   */
  it('re-reads installComplete on every poll', async () => {
    const h = harness({ installAt: 1_500, portAt: 0 });

    await awaitStarterRunning(h.options);

    /* One read before the loop plus one per poll — three polls to cross 1,500ms at 500ms each. */
    expect(h.installReads).toBe(4);
  });
});

describe('awaitStarterRunning — the serve stage', () => {
  /** A preview already registered is the whole answer: no dead time behind an overlay for nothing. */
  it('costs zero extra waits when a preview is already present', async () => {
    const h = harness({ installAt: 0, portAt: 0 });

    const result = await awaitStarterRunning(h.options);

    expect(result.serving).toBe(true);
    expect(h.waits).toEqual([]);
  });

  /**
   * The port appearing LATE is narrated rather than missed. Vite binds a beat after the install ends,
   * and answering from the first read would take the splash down over a preview that was about to
   * exist — the "ready project with a blank page" failure in its most likely form.
   */
  it('reports serving when the port opens partway through the window', async () => {
    const h = harness({ installAt: 0, portAt: 1_500 });

    const result = await awaitStarterRunning(h.options);

    expect(result.serving).toBe(true);
    expect(result.elapsedMs).toBe(1_500);
    expect(result.elapsedMs).toBeLessThan(CREATION_SERVE_TIMEOUT_MS);
  });

  /**
   * 🔴 THE SERVE CEILING. A dev server that never binds must still let creation finish: the splash
   * comes down, the project is there, and a broken preview is better looked at in the workbench than
   * behind a full-screen overlay. Bounded polls for the same reason as the install ceiling — an
   * unbounded version hangs this test instead of failing it.
   */
  it('resolves with serving:false when the port never opens', async () => {
    const h = harness({ installAt: 0 });

    const result = await awaitStarterRunning(h.options);

    expect(result.serving).toBe(false);
    expect(result.elapsedMs).toBe(CREATION_SERVE_TIMEOUT_MS);
    expect(h.waits.length).toBe(Math.ceil(CREATION_SERVE_TIMEOUT_MS / CREATION_READY_POLL_MS));
  });

  /** The port half is `awaitRunningPreview`, so its count is re-read per poll there too. */
  it('re-reads the preview count on every poll', async () => {
    const h = harness({ installAt: 0, portAt: 1_000 });

    await awaitStarterRunning(h.options);

    expect(h.previewReads).toBe(3);
  });
});

describe('awaitStarterRunning — narration', () => {
  /**
   * 🔴 STAGE ORDER. The splash's two sentences are written by these callbacks, and both wrong orders
   * are silent: "Starting your project…" over a running `npm install` is a lie the user cannot check,
   * and a stage announced twice re-writes the phase after the next one has already been set (the
   * "creating-serve then creating-install" flicker). Exactly once, install first, in every path.
   */
  it('announces install then serve, each exactly once, on the fast path', async () => {
    const h = harness({ installAt: 0, portAt: 0 });

    await awaitStarterRunning(h.options);

    expect(h.stages).toEqual(['install', 'serve']);
  });

  it('announces install then serve, each exactly once, when BOTH stages time out', async () => {
    const h = harness();

    await awaitStarterRunning(h.options);

    expect(h.stages).toEqual(['install', 'serve']);
  });

  /**
   * The stage is announced BEFORE its wait, not after it. Announcing afterwards means the splash
   * describes the step that just ended for the whole duration of the one that is running — which is the
   * same defect as no narration at all, wearing a plausible disguise.
   */
  it('announces a stage before waiting on it', async () => {
    const seen: string[] = [];
    const h = harness();

    await awaitStarterRunning({
      ...h.options,
      onStage: (stage) => seen.push(`stage:${stage}`),
      wait: async (ms) => {
        h.waits.push(ms);

        if (seen[seen.length - 1]?.startsWith('stage:')) {
          seen.push('wait');
        }
      },
    });

    expect(seen[0]).toBe('stage:install');
    expect(seen[1]).toBe('wait');
    expect(seen.filter((entry) => entry === 'stage:serve').length).toBe(1);
    expect(seen.indexOf('stage:serve')).toBeGreaterThan(seen.indexOf('wait'));
  });
});

describe('awaitStarterRunning — the bound as a whole', () => {
  /**
   * 🔴 THE WHOLE-WAIT BOUND. Creation blocks on this, so the worst case a user can experience is the
   * number asserted here. Two ceilings that individually terminate can still compose into a wait nobody
   * intended, and "how long can New Project take?" must have an answer that is readable from one line.
   */
  it('never exceeds the sum of both ceilings, even when nothing ever happens', async () => {
    const h = harness();

    const result = await awaitStarterRunning(h.options);

    expect(result.installed).toBe(false);
    expect(result.serving).toBe(false);
    expect(result.elapsedMs).toBe(CREATION_INSTALL_TIMEOUT_MS + CREATION_SERVE_TIMEOUT_MS);
    expect(result.elapsedMs).toBe(h.elapsed());
  });

  /**
   * `elapsedMs` is the SUM OF THE POLLS, never a wall clock. Asserted against a clock that is deliberately
   * wrong — real time passes here while the injected clock says nothing did — so a `Date.now()`
   * regression cannot pass by being approximately right.
   */
  it('reports polled time, not wall-clock time', async () => {
    const h = harness({ installAt: 1_000, portAt: 1_000 });

    const started = Date.now();
    const result = await awaitStarterRunning(h.options);

    expect(result.elapsedMs).toBe(1_000);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  /**
   * A ceiling is a ceiling, not a target: `wait` is asked for `min(pollMs, remaining)` so a poll
   * interval that does not divide the window cannot spill past it. A bound the code overshoots is a
   * bound nobody can reason about.
   */
  it('never overshoots either window when pollMs does not divide it', async () => {
    const h = harness();

    const result = await awaitStarterRunning({
      ...h.options,
      installTimeoutMs: 1_000,
      serveTimeoutMs: 700,
      pollMs: 300,
    });

    expect(result.elapsedMs).toBe(1_700);
    expect(h.waits).toEqual([300, 300, 300, 100, 300, 300, 100]);
  });

  /**
   * A zero or negative poll interval is an infinite loop reached through a config typo rather than a
   * code change — `elapsed` never advances, so the window never expires. Clamped to >= 1: the wait just
   * costs more iterations. Termination matters far more than the exact count.
   */
  it.each([0, -1, -500])('does not hang when pollMs is %i', async (pollMs) => {
    const h = harness();

    const result = await awaitStarterRunning({ ...h.options, installTimeoutMs: 5, serveTimeoutMs: 5, pollMs });

    expect(result.elapsedMs).toBe(10);
    expect(h.stages).toEqual(['install', 'serve']);
  });

  /** Degenerate windows are an immediate ANSWER, not an immediate wait — and still both stages. */
  it('answers immediately with no waits when both windows are zero', async () => {
    const h = harness();

    const result = await awaitStarterRunning({ ...h.options, installTimeoutMs: 0, serveTimeoutMs: 0 });

    expect(result).toEqual({ installed: false, serving: false, elapsedMs: 0 });
    expect(h.waits).toEqual([]);
    expect(h.stages).toEqual(['install', 'serve']);
  });

  /**
   * The sizes are decisions with reasons attached (a cold WebContainer install vs. Vite with the deps
   * already on disk), not arbitrary numbers. Pinned so a drift is visible in a diff — and `vi.stubEnv`
   * is unnecessary here only because they are constants rather than config; if they ever become
   * env-tunable this test must scrub first (the `oauth.spec.ts` trap).
   */
  it('exposes the sizes creation was tuned to', () => {
    expect(CREATION_INSTALL_TIMEOUT_MS).toBe(180_000);
    expect(CREATION_SERVE_TIMEOUT_MS).toBe(60_000);
    expect(CREATION_READY_POLL_MS).toBe(500);

    /* The install window must dominate: it is the only stage that can legitimately take minutes. */
    expect(CREATION_INSTALL_TIMEOUT_MS).toBeGreaterThan(CREATION_SERVE_TIMEOUT_MS);
  });

  /** Explicit bounds win over the defaults, so a future provider is not stuck with WebContainer's. */
  it('honours explicit bounds', async () => {
    const h = harness({ installAt: 400, portAt: 800 });

    const result = await awaitStarterRunning({
      ...h.options,
      installTimeoutMs: 1_000,
      serveTimeoutMs: 1_000,
      pollMs: 100,
    });

    expect(result).toEqual({ installed: true, serving: true, elapsedMs: 800 });
  });

  /**
   * CONTROL — the harness can tell the two outcomes apart.
   *
   * Every assertion above reads a boolean off this fixture, so a fixture that reported the same answer
   * either way would leave the whole file green and meaningless. Both branches, same call, one test.
   */
  it('CONTROL — the harness distinguishes an install that completes from one that never does', async () => {
    const never = await awaitStarterRunning({ ...harness().options, installTimeoutMs: 0, serveTimeoutMs: 0 });
    const done = await awaitStarterRunning({
      ...harness({ installAt: 0, portAt: 0 }).options,
      installTimeoutMs: 0,
      serveTimeoutMs: 0,
    });

    expect(never.installed).toBe(false);
    expect(never.serving).toBe(false);
    expect(done.installed).toBe(true);
    expect(done.serving).toBe(true);
  });
});
