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
  PREVIEW_SETTLE_CEILING_MS,
  PREVIEW_SETTLE_QUIET_MS,
  previewBusyCopy,
  previewBusyElapsedSeconds,
  previewBusyState,
  shouldRevealPreview,
} from './preview-busy';

const at = (elapsedMs: number) => previewBusyState({ loading: true, elapsedMs });

describe('previewBusyState', () => {
  it('says nothing when no load is in flight', () => {
    expect(previewBusyState({ loading: false, elapsedMs: 10_000 })).toBe('hidden');
  });

  /*
   * 🔴 A WARM first paint is ~0.5 s (MEASURED, `spec/sandbox-nodepod.md`). With no delay the overlay
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
   * 🔴 **One visible state, for the whole wait.** There used to be a second, `first-run`, selected by
   * an `everLoaded` flag — and once the cover started outliving the iframe `load` event, that flag
   * flipped mid-wait and the panel went *Loading… → Preparing… → Loading…* in front of the user.
   * Swept across the whole visible window: any elapsed value that is covered must report the SAME
   * state, so no second branch can be reintroduced without failing here.
   */
  it('never changes what it is called part-way through a wait', () => {
    const seen = new Set<string>();

    for (let ms = PREVIEW_BUSY_DELAY_MS; ms < PREVIEW_BUSY_CEILING_MS; ms += 250) {
      seen.add(previewBusyState({ loading: true, elapsedMs: ms }));
    }

    expect([...seen]).toEqual(['loading']);
  });

  /*
   * 🔴 The exit must not depend solely on a `load` event that may never fire. A preview that has not
   * loaded in two minutes has a problem the user needs to SEE — the error overlay, the blank page —
   * not a spinner sitting on top of it. Same reason `coversWorkspace` refuses to cover `failed`.
   */
  it('gives up at the ceiling rather than covering a dead preview forever', () => {
    expect(at(PREVIEW_BUSY_CEILING_MS - 1)).toBe('loading');
    expect(at(PREVIEW_BUSY_CEILING_MS)).toBe('hidden');
    expect(at(10 * PREVIEW_BUSY_CEILING_MS)).toBe('hidden');
  });

  it('orders its own thresholds', () => {
    expect(PREVIEW_BUSY_DELAY_MS).toBeLessThan(PREVIEW_BUSY_CEILING_MS);
  });
});

describe('previewBusyElapsedSeconds', () => {
  it('shows nothing when there is no panel to show it on', () => {
    for (const ms of [0, PREVIEW_BUSY_DELAY_MS, 30_000]) {
      expect(previewBusyElapsedSeconds('hidden', ms)).toBeUndefined();
    }
  });

  /*
   * 🔴 **The REAL elapsed time — never padded or nudged.** Its stated purpose is to let someone
   * watching a cold start tell that about fifteen seconds have gone by, and a clock that flatters the
   * wait cannot do that. A padded version and a version that refused to finish on 13 were both built
   * and reverted; this asserts the number against the truth so neither can return quietly.
   */
  it('reports the true elapsed time', () => {
    expect(previewBusyElapsedSeconds('loading', 1_000)).toBe(1);
    expect(previewBusyElapsedSeconds('loading', 15_000)).toBe(15);

    for (let ms = PREVIEW_BUSY_DELAY_MS; ms < 30_000; ms += 137) {
      expect(previewBusyElapsedSeconds('loading', ms)).toBe(Math.round(ms / 1000));
    }
  });

  /* A count that goes backwards, or skips, reads as a glitch rather than as a clock. */
  it('counts up one second at a time, never backwards and never skipping', () => {
    let previous = 0;

    for (let ms = PREVIEW_BUSY_DELAY_MS; ms <= 40_000; ms += 50) {
      const seconds = previewBusyElapsedSeconds('loading', ms)!;
      expect(seconds - previous).toBeGreaterThanOrEqual(0);
      expect(seconds - previous).toBeLessThanOrEqual(1);
      previous = seconds;
    }
  });
});

describe('shouldRevealPreview', () => {
  const settled = {
    sinceLoadMs: 1_000,
    imagesPending: 0,
    quietForMs: PREVIEW_SETTLE_QUIET_MS,
    observable: true,
  };

  it('reveals once nothing is outstanding and it has stayed that way', () => {
    expect(shouldRevealPreview(settled)).toBe(true);
  });

  /*
   * 🔴 The measured defect this exists for: the iframe `load` event fires before React has rendered,
   * so the page paints its text ~1.8 s before the logo lands while a restored pod snapshot is still
   * streaming files in. Uncovering there lets the user watch the page assemble.
   */
  it('keeps covering while images are still outstanding', () => {
    expect(shouldRevealPreview({ ...settled, imagesPending: 1, quietForMs: 0 })).toBe(false);
    expect(shouldRevealPreview({ ...settled, imagesPending: 3, quietForMs: 5_000 })).toBe(false);
  });

  /*
   * 🔴 At the `load` event there are legitimately ZERO images pending — not because the page is
   * finished but because React has not rendered yet. Without the quiet period this reveals instantly
   * on every load and the whole rule does nothing, while still LOOKING implemented.
   */
  it('does not mistake "not started yet" for "finished"', () => {
    expect(shouldRevealPreview({ ...settled, sinceLoadMs: 0, quietForMs: 0 })).toBe(false);
    expect(shouldRevealPreview({ ...settled, quietForMs: PREVIEW_SETTLE_QUIET_MS - 1 })).toBe(false);
  });

  /*
   * 🔴 A broken image, an image the pod cannot serve, or a loader that never settles must NEVER hide a
   * broken preview behind a spinner. Every hold needs an exit that does not depend on the thing being
   * waited for — the same principle as `PREVIEW_BUSY_CEILING_MS`, one layer down.
   */
  it('gives up at the ceiling however much is still pending', () => {
    expect(
      shouldRevealPreview({
        sinceLoadMs: PREVIEW_SETTLE_CEILING_MS,
        imagesPending: 9,
        quietForMs: 0,
        observable: true,
      }),
    ).toBe(true);
    expect(shouldRevealPreview({ sinceLoadMs: 60_000, imagesPending: 9, quietForMs: 0, observable: true })).toBe(true);
  });

  /*
   * ⚠️ A cross-origin preview (CodeSandbox serves from its own origin) cannot be inspected at all.
   * Holding it on a blind delay would penalise every load on that provider for a wait that may not
   * exist, so an unobservable document degrades to the old behaviour: reveal at `load`.
   */
  it('reveals immediately when the document cannot be inspected', () => {
    expect(shouldRevealPreview({ sinceLoadMs: 0, imagesPending: 0, quietForMs: 0, observable: false })).toBe(true);
    expect(shouldRevealPreview({ sinceLoadMs: 0, imagesPending: 5, quietForMs: 0, observable: false })).toBe(true);
  });

  it('keeps the quiet period well under the ceiling', () => {
    expect(PREVIEW_SETTLE_QUIET_MS).toBeLessThan(PREVIEW_SETTLE_CEILING_MS);
  });
});

describe('previewBusyCopy', () => {
  it('renders nothing at all when hidden', () => {
    expect(previewBusyCopy('hidden')).toBeUndefined();
  });

  it('names what is being waited on rather than just spinning', () => {
    const copy = previewBusyCopy('loading')!;

    expect(copy.title).toMatch(/loading your project/i);
    expect(copy.detail).toMatch(/workspace/i);
  });

  /*
   * 🔴 The clock is appended to the END of the detail (`· 11s`), so a trailing full stop renders as
   * "workspace. · 11s". Adding one back is a one-character "punctuation fix" that reads as an
   * improvement and that nothing else would catch.
   */
  it('leaves room for the elapsed clock at the end of the detail', () => {
    expect(previewBusyCopy('loading')!.detail).not.toMatch(/[.!?]$/);
  });

  /*
   * 🔴 A REGRESSION GUARD, not a style rule. This copy used to read "First run: the dev server is
   * optimizing dependencies. Later loads are much faster." The first sentence was measured FALSE
   * (`spec/sandbox-nodepod.md` §8 — dep optimization is ~2.6 s of a ~15 s one-time pod init), and the
   * second was a speed promise the product does not need: later loads arrive in ~300 ms with no
   * overlay at all, so the user gets the evidence unprompted. Both are easy to reintroduce in good
   * faith by someone trying to be reassuring.
   */
  it('promises nothing unmeasured about speed', () => {
    const { title, detail } = previewBusyCopy('loading')!;
    const text = `${title} ${detail}`;

    expect(text).not.toMatch(/faster|quicker|instant|only takes|won't take/i);
    expect(text).not.toMatch(/optimizing dependencies|dependency optimization/i);
  });
});
