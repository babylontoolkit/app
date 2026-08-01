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
   * A spinner says "wait"; it does not say "this is one-time". The cold wait is Vite's dependency
   * optimization, which happens once per dependency set — and a user who is not told that reasonably
   * concludes their project is always this slow.
   */
  it('explains the first run once it is clearly the cold one', () => {
    expect(at(PREVIEW_BUSY_EXPLAIN_MS - 1)).toBe('loading');
    expect(at(PREVIEW_BUSY_EXPLAIN_MS)).toBe('first-run');
    expect(at(17_000)).toBe('first-run');
  });

  /*
   * 🔴 A later navigation that happens to be slow is NOT paying for dependency optimization. Claiming
   * it is would be a confident wrong answer at the one moment the user is reading the screen.
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

  /* The whole point of the slow branch: say that it is one-time, or the spinner says nothing new. */
  it('tells the user the first run is one-time', () => {
    expect(previewBusyCopy('first-run')!.detail).toMatch(/faster|once|first/i);
  });
});
