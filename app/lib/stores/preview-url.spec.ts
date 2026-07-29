/**
 * The arithmetic behind a preview that does not silently die (T8, `spec/sandbox-codesandbox.md`).
 *
 * 🔴 Every wrong answer here is INVISIBLE in production. A CodeSandbox preview token is a bearer
 * credential riding in the iframe URL; when it expires the private preview host answers 401, and a
 * cross-origin 401 page still fires the iframe's `onLoad` — so the workbench clears its stale-preview
 * alert and reports a healthy preview over a dead one. Nothing throws.
 *
 * The two failure directions are therefore both silent:
 *
 *   - scheduling NOTHING when there is an expiry → the preview dies under the user after an hour and
 *     only a full page reload brings it back;
 *   - scheduling SOMETHING when there is no expiry (the WebContainer answer, `undefined`) → a timer
 *     fires forever against a provider that has no way to mint a replacement.
 *
 * And `previewUrlWithPath` exists because a preview base carries `?preview_token=…`: string-appending
 * a path glues it onto the QUERY and breaks the route and the credential at once.
 */
import { describe, expect, it } from 'vitest';
import { MIN_REMINT_DELAY_MS, PREVIEW_REMINT_WINDOW_MS, previewUrlWithPath, remintDelayMs } from './preview-url';

const NOW = 1_000_000;

describe('remintDelayMs', () => {
  /*
   * 🔴 "Does not expire" is not "expires now". WebContainer preview URLs carry no expiry, and the
   * absent value must schedule NOTHING — treating it as 0 would arm a timer whose callback can never
   * produce a new URL, on the provider that is still the default build.
   */
  it('answers "never" for a provider that reports no expiry', () => {
    expect(remintDelayMs(undefined, NOW)).toBeUndefined();
  });

  /*
   * NaN is the shape a malformed `expiresAt` actually takes: the mint route returns an ISO string and
   * `Date.parse` yields NaN for anything it cannot read. Every comparison against NaN is false, so an
   * unguarded version would compute NaN and `setTimeout(fn, NaN)` fires IMMEDIATELY — a re-mint loop
   * against a route that is already answering badly.
   */
  it('answers "never" for an unparseable expiry rather than looping on NaN', () => {
    expect(remintDelayMs(Number.NaN, NOW)).toBeUndefined();
    expect(remintDelayMs(Number.POSITIVE_INFINITY, NOW)).toBeUndefined();
  });

  /** The ordinary case: re-mint one window ahead of death, not at it. */
  it('schedules one re-mint window before expiry', () => {
    const expiresAt = NOW + 60 * 60_000;

    expect(remintDelayMs(expiresAt, NOW)).toBe(60 * 60_000 - PREVIEW_REMINT_WINDOW_MS);
  });

  /*
   * The window is a LEAD, so the scheduled moment must land strictly before expiry — that is the
   * whole property T8 buys. Asserted rather than assumed because a sign error here still produces a
   * plausible-looking positive number.
   */
  it('lands strictly before the expiry it is protecting', () => {
    const expiresAt = NOW + 60 * 60_000;

    expect(NOW + remintDelayMs(expiresAt, NOW)!).toBeLessThan(expiresAt);
  });

  /*
   * A token already inside the window (the tab was hidden, the timer was throttled) yields a negative
   * raw delay. Clamping to a small positive value re-mints promptly on the next tick; `setTimeout`
   * with a negative delay fires immediately, which is a hot loop if the mint route is failing.
   */
  it('clamps a token already inside the window to the floor, never to zero or below', () => {
    const expiresAt = NOW + PREVIEW_REMINT_WINDOW_MS - 1;
    const delay = remintDelayMs(expiresAt, NOW)!;

    expect(delay).toBe(MIN_REMINT_DELAY_MS);
    expect(delay).toBeGreaterThan(0);
  });

  /** A laptop that slept through the expiry entirely: still a prompt retry, still not a hot loop. */
  it('clamps an ALREADY-expired token to the floor rather than to a negative delay', () => {
    const delay = remintDelayMs(NOW - 10 * 60 * 60_000, NOW)!;

    expect(delay).toBe(MIN_REMINT_DELAY_MS);
    expect(delay).toBeGreaterThan(0);
  });

  /** The window is a parameter so a test (or an operator) can move it without editing the store. */
  it('honours a caller-supplied window', () => {
    expect(remintDelayMs(NOW + 10_000, NOW, 1_000)).toBe(9_000);
  });
});

describe('previewUrlWithPath', () => {
  const BASE = 'https://sb1-5173.csb.app/?preview_token=abc';

  /*
   * 🔴 THE CREDENTIAL. `base + '/play'` produces `…preview_token=abc/play` — the token is corrupted
   * AND the route never happens, and the visible symptom is a 401 page, which reads as "the preview
   * broke" rather than "we built the URL wrong".
   */
  it('keeps the preview token while swapping the path', () => {
    const joined = new URL(previewUrlWithPath(BASE, '/play'));

    expect(joined.pathname).toBe('/play');
    expect(joined.searchParams.get('preview_token')).toBe('abc');
  });

  /** A path handed in without its leading slash must not become a relative sibling of the current one. */
  it('normalises a path with no leading slash', () => {
    expect(new URL(previewUrlWithPath(BASE, 'play')).pathname).toBe('/play');
  });

  /*
   * The re-mint path re-applies the user's CURRENT path onto the new base. At the root that is a
   * no-op, and it must be byte-identical — a re-mint that rewrote the URL cosmetically would remount
   * the iframe for nothing on every token rotation.
   */
  it('returns the base untouched for "/" and for an empty path', () => {
    expect(previewUrlWithPath(BASE, '/')).toBe(BASE);
    expect(previewUrlWithPath(BASE, '')).toBe(BASE);
  });

  /*
   * Degrades rather than throws. A preview that lost its path is a nuisance; a `TypeError` raised
   * inside a render is a blank workbench.
   */
  it('returns a malformed base unchanged instead of throwing into a render', () => {
    expect(previewUrlWithPath('not a url', '/play')).toBe('not a url');
  });
});
