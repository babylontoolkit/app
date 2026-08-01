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
  PREVIEW_BUSY_LINGER_MARGIN_MS,
  PREVIEW_BUSY_NEVER_END_ON,
  previewBusyCopy,
  previewBusyElapsedSeconds,
  previewBusyLingerMs,
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
   * 🔴 **The count NEVER skips a value** — it goes 11, 12, 13, 14 and not 11, 12, 14.
   *
   * A regression guard with a story: a "never DISPLAY 13" rule was built, live-driven and reverted,
   * because a number that is never displayed forces a visible 12 → 14 jump on every cold load. The
   * jump reads as a dropped frame — the clock looks broken rather than tidy — which is strictly more
   * noticeable than the thing it was avoiding. The requirement is that the count never ENDS on 13
   * (see `previewBusyLingerMs`), not that it never shows it. Anyone reintroducing a skip list, for 13
   * or for any other number, fails here.
   */
  it('never skips a value as it counts', () => {
    let previous = previewBusyElapsedSeconds('loading', PREVIEW_BUSY_DELAY_MS)!;

    for (let ms = PREVIEW_BUSY_DELAY_MS; ms < PREVIEW_BUSY_CEILING_MS; ms += 50) {
      const state = previewBusyState({ loading: true, elapsedMs: ms, everLoaded: false });
      const seconds = previewBusyElapsedSeconds(state, ms);

      if (seconds === undefined) {
        continue;
      }

      expect(seconds - previous).toBeLessThanOrEqual(1);
      previous = seconds;
    }
  });

  /* …and it does pass through every one of them, which is the half the skip version got wrong. */
  it('displays the values it will not end on, while counting', () => {
    const shown = new Set<number>();

    for (let ms = PREVIEW_BUSY_DELAY_MS; ms < 30_000; ms += 50) {
      const state = previewBusyState({ loading: true, elapsedMs: ms, everLoaded: false });
      const seconds = previewBusyElapsedSeconds(state, ms);

      if (seconds !== undefined) {
        shown.add(seconds);
      }
    }

    for (const value of PREVIEW_BUSY_NEVER_END_ON) {
      expect(shown).toContain(value);
    }
  });
});

describe('previewBusyLingerMs', () => {
  /*
   * 🔴 **Not decoration — without this every other test in this block is VACUOUS.** They all iterate
   * `PREVIEW_BUSY_NEVER_END_ON`, so emptying the list makes each one loop over nothing and report
   * success: the rule would be silently gone with a green suite. Verified by mutation, which is how
   * the hole was found in the first place.
   */
  it('actually has a value it refuses to end on', () => {
    expect(PREVIEW_BUSY_NEVER_END_ON.length).toBeGreaterThan(0);
    expect(PREVIEW_BUSY_NEVER_END_ON).toContain(13);
  });

  /* The overwhelmingly common case: the load ends on an ordinary number and the overlay goes at once. */
  it('does not delay an ordinary finish', () => {
    for (let ms = PREVIEW_BUSY_DELAY_MS; ms < 30_000; ms += 50) {
      const shown = previewBusyElapsedSeconds('loading', ms)!;

      if (!PREVIEW_BUSY_NEVER_END_ON.includes(shown)) {
        expect(previewBusyLingerMs(ms)).toBe(0);
      }
    }
  });

  /*
   * 🔴 The point of the whole mechanism: whenever the load finishes on a number we will not end on,
   * holding for the returned time must actually land the display on a DIFFERENT, larger number.
   *
   * Asserted as that end-to-end property rather than as a duration, because a linger that is merely
   * "about a second" can still finish a hair before the boundary and leave the count sitting on the
   * value it was supposed to move off — intermittently, which is the worst way for this to fail.
   */
  it('holds just long enough to move the count off a value it will not end on', () => {
    for (let ms = 0; ms < 30_000; ms += 17) {
      const shown = previewBusyElapsedSeconds('loading', ms)!;

      if (!PREVIEW_BUSY_NEVER_END_ON.includes(shown)) {
        continue;
      }

      const linger = previewBusyLingerMs(ms);
      const after = previewBusyElapsedSeconds('loading', ms + linger)!;

      expect(after).toBeGreaterThan(shown);
      expect(PREVIEW_BUSY_NEVER_END_ON).not.toContain(after);
    }
  });

  /*
   * ⚠️ Bounded by construction. An overlay that outlives its own load is normally a defect, and the
   * only thing making it acceptable here is that it cannot be long: derived from the next tick, never
   * a chosen constant. A linger that could reach seconds would be a cover over a READY preview.
   */
  it('never holds the overlay for longer than the range it is stepping over', () => {
    const ceiling = (PREVIEW_BUSY_NEVER_END_ON.length + 1) * 1_000 + PREVIEW_BUSY_LINGER_MARGIN_MS;

    for (let ms = 0; ms < 30_000; ms += 17) {
      expect(previewBusyLingerMs(ms)).toBeLessThan(ceiling);
    }
  });

  /*
   * 🔴 A load that genuinely runs long reports the TRUTH — the rule constrains the ending, not the
   * clock. Past the range there is nothing to step over, so every finish is immediate and the seconds
   * shown are real. Without this, "round the number up" could grow into rounding a 40 s wait.
   */
  it('never delays a finish beyond the range', () => {
    const past = Math.max(...PREVIEW_BUSY_NEVER_END_ON);

    for (let ms = (past + 1) * 1_000; ms < 60_000; ms += 17) {
      expect(previewBusyLingerMs(ms)).toBe(0);
    }
  });

  /*
   * 🔴 The linger CLEARS the tick boundary rather than landing exactly on it.
   *
   * This cannot be caught by asserting on the resulting number: arithmetically, stopping dead on the
   * boundary already rounds to the next second, so the pure function looks correct without any margin
   * at all (verified by mutation — removing it passed every other test here). The margin exists for
   * the RENDER: the clock repaints on a 250 ms interval, so finishing at the boundary races the paint
   * and the new value may never reach the screen, leaving the count resting on the very number this
   * exists to avoid — intermittently, and only in a real browser. So the slack itself is the property.
   */
  it('clears the tick boundary instead of landing on it', () => {
    for (let ms = 0; ms < 30_000; ms += 17) {
      const linger = previewBusyLingerMs(ms);

      if (linger === 0) {
        continue;
      }

      const boundary = (Math.round(ms / 1000) + 0.5) * 1000 - ms;
      expect(linger - boundary).toBeGreaterThanOrEqual(PREVIEW_BUSY_LINGER_MARGIN_MS);
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
