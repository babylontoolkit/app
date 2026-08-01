/**
 * The preview-pane busy overlay (`preview-busy.ts`).
 *
 * Every rule here is a timing rule, and each fails silently in a DIFFERENT direction: too short a
 * delay strobes on every navigation, too long a ceiling parks a spinner over a dead preview forever,
 * and a mis-scoped "first run" branch tells the user something confidently wrong about their project.
 */
import { describe, expect, it } from 'vitest';
import {
  PREVIEW_BUSY_CEILING_MS,
  PREVIEW_BUSY_CLOCK_PADDING_SECONDS,
  PREVIEW_BUSY_DELAY_MS,
  PREVIEW_BUSY_EXPLAIN_MS,
  PREVIEW_BUSY_SKIPPED_SECONDS,
  previewBusyCopy,
  previewBusyElapsedSeconds,
  previewBusyState,
} from './preview-busy';

const at = (elapsedMs: number, overrides: Partial<Parameters<typeof previewBusyState>[0]> = {}) =>
  previewBusyState({ loading: true, elapsedMs, everLoaded: false, ...overrides });

describe('previewBusyState', () => {
  it('says nothing when no load is in flight', () => {
    expect(previewBusyState({ loading: false, elapsedMs: 10_000, everLoaded: false })).toBe('hidden');
  });

  /*
   * 🔴 A WARM first paint is 0.5 s (MEASURED, `spec/sandbox-nodepod.md`). With no delay the overlay
   * would flash on every ordinary load and every in-preview navigation — the same strobing that made
   * the import tail unusable as a boot phase.
   */
  it('stays hidden for a fast load', () => {
    expect(at(0)).toBe('hidden');
    expect(at(500)).toBe('hidden');
    expect(at(PREVIEW_BUSY_DELAY_MS - 1)).toBe('hidden');
  });

  it('appears once the load is slow enough to be worth mentioning', () => {
    expect(at(PREVIEW_BUSY_DELAY_MS)).toBe('loading');
  });

  /* The measured warm number must sit BELOW the delay, or the overlay flashes on every good load. */
  it('keeps the delay above the measured warm first paint', () => {
    expect(PREVIEW_BUSY_DELAY_MS).toBeGreaterThan(500);
  });

  /*
   * A spinner says "wait" and nothing else — fine for a second, unsettling at ten. The cold wait is
   * the pod's one-time initialization (~13–15 s, `spec/sandbox-nodepod.md` §8), and past this the
   * user deserves to know what is being waited on rather than wondering whether it is stuck.
   */
  it('explains the first run once it is clearly the cold one', () => {
    expect(at(PREVIEW_BUSY_EXPLAIN_MS - 1)).toBe('loading');
    expect(at(PREVIEW_BUSY_EXPLAIN_MS)).toBe('first-run');
    expect(at(17_000)).toBe('first-run');
  });

  /*
   * 🔴 A later navigation that happens to be slow is NOT paying the pod's one-time setup — something
   * else is wrong. Telling the user their workspace is being prepared would be a confident wrong
   * answer at the one moment they are reading the screen.
   */
  it('never claims a first run after something has already loaded', () => {
    expect(at(17_000, { everLoaded: true })).toBe('loading');
    expect(at(PREVIEW_BUSY_EXPLAIN_MS, { everLoaded: true })).toBe('loading');
  });

  /*
   * 🔴 The exit must not depend solely on a `load` event that may never fire. A preview that has not
   * loaded in two minutes has a problem the user needs to SEE — the error overlay, the blank page —
   * not a spinner sitting on top of it. Same reason `coversWorkspace` refuses to cover `failed`.
   */
  it('gives up at the ceiling rather than covering a dead preview forever', () => {
    expect(at(PREVIEW_BUSY_CEILING_MS - 1)).toBe('first-run');
    expect(at(PREVIEW_BUSY_CEILING_MS)).toBe('hidden');
    expect(at(10 * PREVIEW_BUSY_CEILING_MS)).toBe('hidden');
  });

  it('orders its own thresholds', () => {
    expect(PREVIEW_BUSY_DELAY_MS).toBeLessThan(PREVIEW_BUSY_EXPLAIN_MS);
    expect(PREVIEW_BUSY_EXPLAIN_MS).toBeLessThan(PREVIEW_BUSY_CEILING_MS);
  });
});

describe('previewBusyElapsedSeconds', () => {
  /* Nothing on screen, nothing to hang a number on. */
  it('never counts while hidden', () => {
    for (const ms of [0, PREVIEW_BUSY_DELAY_MS, 5_000, 30_000]) {
      expect(previewBusyElapsedSeconds('hidden', ms)).toBeUndefined();
    }
  });

  /*
   * 🔴 The clock belongs to the OVERLAY, not to a state, and it has no threshold of its own. It ran on
   * `first-run` alone at first, which did not delay the clock — it delayed the first SIGHT of it: the
   * panel sat silent and then opened at `· 4s`. A counter that starts mid-count reads as a skip, i.e.
   * as evidence something was missed, which is the opposite of what a clock is there to say.
   */
  it('starts counting the moment the overlay appears', () => {
    expect(previewBusyElapsedSeconds('loading', PREVIEW_BUSY_DELAY_MS)).toBe(1 + PREVIEW_BUSY_CLOCK_PADDING_SECONDS);
  });

  /*
   * 🔴 The count is padded so it never reads BEHIND the real wait: `elapsedMs` starts at the iframe
   * load, not at the moment the user started waiting, and rounding shaves the low end further. Erring
   * high costs nothing; erring low makes the finish look like a jump and teaches the user a number
   * that is not the one they lived through.
   *
   * Asserted as a PROPERTY (never under the true elapsed) as well as a value, so the padding cannot be
   * dropped as a stray `+ 1` by someone who reads it as an off-by-one.
   */
  it('never reports less time than has actually elapsed', () => {
    for (let ms = PREVIEW_BUSY_DELAY_MS; ms < 30_000; ms += 173) {
      expect(previewBusyElapsedSeconds('loading', ms)!).toBeGreaterThanOrEqual(ms / 1000);
    }
  });

  /*
   * 🔴 …and it does not restart, reset, or gap at the handover. `loading` → `first-run` is a change of
   * WORDS about one continuous wait, so the number either side of the boundary must be the same
   * number. Anything else is a visible stutter at the exact second the user is reading the panel.
   */
  it('counts unbroken across the loading → first-run handover', () => {
    const boundary = PREVIEW_BUSY_EXPLAIN_MS;

    expect(previewBusyElapsedSeconds('loading', boundary - 1)).toBe(previewBusyElapsedSeconds('first-run', boundary));
  });

  it('counts up in whole seconds', () => {
    const pad = PREVIEW_BUSY_CLOCK_PADDING_SECONDS;

    expect(previewBusyElapsedSeconds('first-run', 11_000)).toBe(11 + pad);
    expect(previewBusyElapsedSeconds('first-run', 15_400)).toBe(15 + pad);
    expect(previewBusyElapsedSeconds('first-run', 15_600)).toBe(16 + pad);
  });

  /*
   * 🔴 Skipped values are never rendered, so the count can never come to REST on one — which is the
   * whole point, since a cold pod finishes in the 13–15 s band and would otherwise sometimes stop
   * there. Swept across the entire visible window rather than spot-checked, because a skip that works
   * at one elapsed value and not another is worse than no skip at all.
   */
  it('never displays a skipped second, anywhere in the visible window', () => {
    for (const everLoaded of [false, true]) {
      for (let ms = 0; ms < PREVIEW_BUSY_CEILING_MS; ms += 50) {
        const state = previewBusyState({ loading: true, elapsedMs: ms, everLoaded });
        const seconds = previewBusyElapsedSeconds(state, ms);

        if (seconds !== undefined) {
          expect(PREVIEW_BUSY_SKIPPED_SECONDS).not.toContain(seconds);
        }
      }
    }
  });

  /* The skip steps UP to the next second — down would under-report, which the padding exists to prevent. */
  it('steps up past a skipped second rather than down', () => {
    for (const skipped of PREVIEW_BUSY_SKIPPED_SECONDS) {
      const ms = (skipped - PREVIEW_BUSY_CLOCK_PADDING_SECONDS) * 1000;
      expect(previewBusyElapsedSeconds('first-run', ms)).toBeGreaterThan(skipped);
    }
  });

  /* Monotonic: a count that ever goes backwards on screen reads as a glitch, not a clock. */
  it('never goes backwards as the wait grows', () => {
    let previous = 0;

    for (let ms = PREVIEW_BUSY_EXPLAIN_MS; ms <= 30_000; ms += 137) {
      const seconds = previewBusyElapsedSeconds('first-run', ms)!;
      expect(seconds).toBeGreaterThanOrEqual(previous);
      previous = seconds;
    }
  });

  /*
   * Every frame the overlay is on screen must produce a number — swept across the whole visible
   * window, both branches, so no silent gap can hide anywhere in it.
   */
  it('produces a count for every frame the overlay is visible', () => {
    for (const everLoaded of [false, true]) {
      for (let ms = 0; ms < PREVIEW_BUSY_CEILING_MS; ms += 250) {
        const state = previewBusyState({ loading: true, elapsedMs: ms, everLoaded });

        if (state !== 'hidden') {
          expect(previewBusyElapsedSeconds(state, ms)).toBeTypeOf('number');
        }
      }
    }
  });
});

describe('previewBusyCopy', () => {
  it('renders nothing at all when hidden', () => {
    expect(previewBusyCopy('hidden')).toBeUndefined();
  });

  it('gives each visible state its own words', () => {
    const loading = previewBusyCopy('loading')!;
    const first = previewBusyCopy('first-run')!;

    expect(loading.title).not.toBe(first.title);
    expect(loading.detail).not.toBe(first.detail);
  });

  /*
   * 🔴 The clock is appended to the END of whichever detail is showing (`· 11s`), so a trailing full
   * stop renders as "sandbox. · 11s". Adding one back is a one-character "punctuation fix" that reads
   * as an improvement and that nothing else would catch.
   *
   * Asserted over BOTH visible states rather than the one that happened to be wrong once: the clock
   * moved from first-run-only to every visible state, and the guard that only knew about `first-run`
   * would have gone on passing while `loading` rendered "project. · 2s".
   */
  it('leaves room for the elapsed clock at the end of every visible detail', () => {
    for (const state of ['loading', 'first-run'] as const) {
      expect(previewBusyCopy(state)!.detail).not.toMatch(/[.!?]$/);
    }
  });

  /* The point of the slow branch: name what is being waited on, or the spinner says nothing new. */
  it('names what is being prepared rather than just spinning', () => {
    const first = previewBusyCopy('first-run')!;

    expect(first.title).toMatch(/preparing/i);
    expect(first.title).toMatch(/workspace/i);
    expect(first.detail.length).toBeGreaterThan(20);
  });

  /*
   * 🔴 A REGRESSION GUARD, not a style rule. This copy used to read "First run: the dev server is
   * optimizing dependencies. Later loads are much faster." The first sentence was measured FALSE
   * (`spec/sandbox-nodepod.md` §8 — dep optimization is ~2.6 s of a ~15 s one-time pod init), and the
   * second was a speed promise the product does not need to make: later loads arrive in ~300 ms with
   * no overlay at all, so the user sees the evidence without being told. Both are easy to reintroduce
   * in good faith by someone trying to be reassuring.
   */
  it('promises nothing about how fast later loads will be', () => {
    for (const state of ['loading', 'first-run'] as const) {
      const { title, detail } = previewBusyCopy(state)!;
      const text = `${title} ${detail}`;

      expect(text).not.toMatch(/faster|quicker|speed|instant|only takes|won't take/i);
      expect(text).not.toMatch(/optimizing dependencies|dependency optimization/i);
    }
  });
});
