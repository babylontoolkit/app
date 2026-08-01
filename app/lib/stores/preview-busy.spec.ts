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
  PREVIEW_BUSY_DELAY_MS,
  PREVIEW_BUSY_EXPLAIN_MS,
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
  /*
   * 🔴 The clock is scoped to `first-run` and nothing else. That state is the long one (~13–15 s), and
   * a spinner with static text over that span reads as STUCK — the count is the difference between
   * "this is broken" and "this takes about fifteen seconds". On the brief `loading` state a ticking
   * number is noise, and it is the only moving thing on the panel, so it draws the eye hardest exactly
   * where it matters least.
   */
  it('never counts on any state but first-run', () => {
    for (const ms of [0, PREVIEW_BUSY_DELAY_MS, 5_000, 30_000]) {
      expect(previewBusyElapsedSeconds('hidden', ms)).toBeUndefined();
      expect(previewBusyElapsedSeconds('loading', ms)).toBeUndefined();
    }
  });

  /*
   * 🔴 …and it counts for the WHOLE of first-run, from its very first frame. A second threshold of its
   * own would open the longest state silent for a beat — exactly when the user starts wondering
   * whether it has hung — and two numbers that must stay ordered are two numbers that can drift.
   */
  it('counts from the first frame of first-run, with no threshold of its own', () => {
    expect(previewBusyElapsedSeconds('first-run', PREVIEW_BUSY_EXPLAIN_MS)).toBe(4);
  });

  it('counts up in whole seconds', () => {
    expect(previewBusyElapsedSeconds('first-run', 11_000)).toBe(11);
    expect(previewBusyElapsedSeconds('first-run', 15_400)).toBe(15);
    expect(previewBusyElapsedSeconds('first-run', 15_600)).toBe(16);
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

  /* Every frame the state machine calls first-run must produce a number — no silent gap anywhere. */
  it('produces a count for every elapsed value that yields first-run', () => {
    for (let ms = PREVIEW_BUSY_EXPLAIN_MS; ms < PREVIEW_BUSY_CEILING_MS; ms += 250) {
      const state = previewBusyState({ loading: true, elapsedMs: ms, everLoaded: false });

      if (state === 'first-run') {
        expect(previewBusyElapsedSeconds(state, ms)).toBeTypeOf('number');
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
   * 🔴 The clock is appended to the END of first-run's detail (`· 11s`), so a trailing full stop there
   * renders as "sandbox. · 11s". Adding one back is a one-character "punctuation fix" that reads as an
   * improvement and that nothing else would catch.
   *
   * `loading` KEEPS its full stop, and the asymmetry is the point: the punctuation differs because the
   * rendering differs. Asserting both ways round stops someone "harmonising" them in either direction.
   */
  it('leaves room for the elapsed clock at the end of the first-run detail', () => {
    expect(previewBusyCopy('first-run')!.detail).not.toMatch(/[.!?]$/);
    expect(previewBusyCopy('loading')!.detail).toMatch(/\.$/);
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
