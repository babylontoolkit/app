/**
 * `PreviewsStore` keeping an expiring preview alive (T8, `spec/sandbox-codesandbox.md`).
 *
 * 🔴 The defect this exists to prevent is silent by construction: when a CodeSandbox preview token
 * expires the private host answers 401, and a cross-origin 401 page STILL fires the iframe's
 * `onLoad`. The stale-preview alert clears, the workbench reports a healthy preview, and the user's
 * only recovery is a full page reload. So the store has to stay ahead of the expiry on its own.
 *
 * Three properties are pinned here, each of which fails quietly if it regresses:
 *
 *   - the scheduled re-mint fires BEFORE `expiresAt`, and swaps only the URL — `port` and `ready`
 *     stay put, because the preview did not close and did not become unready;
 *   - the swapped preview is a NEW OBJECT. React reads the active preview by identity, so an
 *     in-place `baseUrl` mutation re-renders nothing: the iframe keeps the dead token and every
 *     store assertion still passes. This is the mutation the identity assertions below exist for;
 *   - a provider with no `refreshPreviewUrl` (the WebContainer shape — its URLs never expire)
 *     schedules NOTHING. A timer there would fire forever against something that cannot mint.
 *
 * Driven against a provider double: the claim is about what the STORE does with a provider's
 * answers, and `SandboxProvider` declares its own types precisely so a spec can supply them.
 */
/*
 * The provider double's unused listeners are inert ON PURPOSE — the claim under test is what the
 * store does, so its collaborators do nothing deliberately rather than by omission (same convention
 * as `codesandbox-provider.spec.ts`).
 */
/* eslint-disable @typescript-eslint/no-empty-function */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxPreviewUrl, SandboxProvider } from '~/lib/sandbox';
import { PreviewsStore } from './previews';
import { PREVIEW_REMINT_WINDOW_MS, REMINT_RETRY_DELAY_MS } from './preview-url';

type PortListener = (port: number, type: 'open' | 'close', url: string) => void;

interface ProviderDouble {
  provider: SandboxProvider;

  /** Fire a port event as the provider would. */
  firePort: PortListener;

  /** Every `refreshPreviewUrl` call, with the clock reading at the moment it was made. */
  refreshedAt: number[];
}

/**
 * A provider that reports port events and (optionally) mints preview URLs.
 *
 * `mint === undefined` is the WebContainer shape: no `refreshPreviewUrl` METHOD at all, which is how
 * the seam says "these URLs do not expire" (a boolean would have to be read, and a method that
 * always resolves `undefined` would still be polled).
 */
function providerDouble(
  mint?: (port: number, call: number) => SandboxPreviewUrl | undefined | Promise<SandboxPreviewUrl | undefined>,
): ProviderDouble {
  let portListener: PortListener = () => {};
  const refreshedAt: number[] = [];
  let calls = 0;

  const provider = {
    onServerReady: () => {},
    onPort: (listener: PortListener) => {
      portListener = listener;
    },
    ...(mint
      ? {
          refreshPreviewUrl: async (port: number) => {
            refreshedAt.push(Date.now());
            return mint(port, calls++);
          },
        }
      : {}),
  } as unknown as SandboxProvider;

  return {
    provider,
    firePort: (port, type, url) => portListener(port, type, url),
    refreshedAt,
  };
}

/** Build the store and let its async `#init` register the provider's listeners. */
async function storeOver(double: ProviderDouble) {
  const store = new PreviewsStore(Promise.resolve(double.provider));

  // `#init` awaits the sandbox promise, so the listeners exist only after the microtask queue drains.
  await vi.advanceTimersByTimeAsync(0);

  return store;
}

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60_000;

beforeEach(() => {
  /*
   * ⚠️ The store opens `BroadcastChannel`s for cross-tab sync. Node has one, and a live channel keeps
   * handles around for no benefit here — the constructor already degrades when it is absent, which is
   * the shape this spec wants.
   */
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('an expiring preview URL', () => {
  /*
   * 🔴 THE WHOLE POINT. The re-mint must land while the old token is still ALIVE — one second late
   * and the iframe has already loaded a 401 that looks like a working page.
   */
  it('re-mints before the token expires, swapping only the URL', async () => {
    const double = providerDouble((_port, call) => ({
      url: `https://sb1-5173.csb.app/?preview_token=t${call}`,
      expiresAt: Date.now() + HOUR,
    }));
    const store = await storeOver(double);

    double.firePort(5173, 'open', 'https://sb1-5173.csb.app');
    await vi.advanceTimersByTimeAsync(0);

    const first = store.previews.get()[0];
    expect(first).toMatchObject({ port: 5173, ready: true, baseUrl: 'https://sb1-5173.csb.app/?preview_token=t0' });

    const firstExpiry = first.expiresAt!;
    expect(firstExpiry).toBe(T0 + HOUR);

    // Nothing has fired yet: the schedule is a lead time, not an immediate second call.
    expect(double.refreshedAt).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(HOUR - PREVIEW_REMINT_WINDOW_MS);

    const second = store.previews.get()[0];

    // Fired, and fired EARLY — with a full re-mint window to spare.
    expect(double.refreshedAt).toHaveLength(2);
    expect(double.refreshedAt[1]).toBeLessThan(firstExpiry);
    expect(second.baseUrl).toBe('https://sb1-5173.csb.app/?preview_token=t1');

    /*
     * `port` and `ready` are STABLE across the rotation: the preview did not close and did not become
     * unready, only its credential changed. Flipping `ready` would remount the iframe through the
     * not-ready path and flicker the port dropdown for no reason.
     */
    expect(second.port).toBe(5173);
    expect(second.ready).toBe(true);
  });

  /*
   * 🔴 THE MUTATION THIS SPEC EXISTS FOR. React reads the active preview by identity. An in-place
   * `baseUrl = …` leaves every field assertion above passing while the rendered iframe keeps the dead
   * token — the re-mint accomplishes literally nothing, invisibly.
   */
  it('publishes a NEW preview object, never a mutated one', async () => {
    const double = providerDouble((_port, call) => ({
      url: `https://sb1-5173.csb.app/?preview_token=t${call}`,
      expiresAt: Date.now() + HOUR,
    }));
    const store = await storeOver(double);

    double.firePort(5173, 'open', 'https://sb1-5173.csb.app');
    await vi.advanceTimersByTimeAsync(0);

    const before = store.previews.get()[0];
    const beforeSnapshot = { ...before };

    await vi.advanceTimersByTimeAsync(HOUR - PREVIEW_REMINT_WINDOW_MS);

    const after = store.previews.get()[0];

    expect(after).not.toBe(before);

    // And the old object was left alone — a consumer still holding it sees no surprise edit.
    expect(before).toEqual(beforeSnapshot);
  });

  /** The schedule renews itself: an hour-long token re-mints every hour, not once. */
  it('keeps re-scheduling after each rotation', async () => {
    const double = providerDouble((_port, call) => ({
      url: `https://sb1-5173.csb.app/?preview_token=t${call}`,
      expiresAt: Date.now() + HOUR,
    }));
    const store = await storeOver(double);

    double.firePort(5173, 'open', 'https://sb1-5173.csb.app');
    await vi.advanceTimersByTimeAsync(0);

    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(HOUR - PREVIEW_REMINT_WINDOW_MS);
    }

    expect(double.refreshedAt).toHaveLength(4);
    expect(store.previews.get()[0].baseUrl).toBe('https://sb1-5173.csb.app/?preview_token=t3');
  });

  /*
   * A closed port must take its timer with it. Otherwise a project whose dev server is restarted a
   * few times accumulates timers minting tokens for ports nothing is rendering — requests against a
   * rate-limited provider on behalf of a preview that no longer exists.
   */
  it('cancels the timer when the port closes', async () => {
    const double = providerDouble(() => ({ url: 'https://sb1-5173.csb.app/?t=1', expiresAt: Date.now() + HOUR }));
    const store = await storeOver(double);

    double.firePort(5173, 'open', 'https://sb1-5173.csb.app');
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    double.firePort(5173, 'close', 'https://sb1-5173.csb.app');

    expect(vi.getTimerCount()).toBe(0);
    expect(store.previews.get()).toEqual([]);

    await vi.advanceTimersByTimeAsync(4 * HOUR);
    expect(double.refreshedAt).toHaveLength(1);
  });

  /*
   * 🔴 A MINT THAT PRODUCED NO EXPIRY IS A FAILURE, NOT A NEW STATE OF THE WORLD. Installing an
   * undated URL is wrong twice over: it can only be the degraded bare host, which is GUARANTEED to
   * 401 on a private sandbox (so a single transient blip replaces a still-valid preview with a dead
   * one, five minutes EARLY — precisely the failure this scheduler exists to prevent); and with no
   * expiry to schedule from, rotation then stops for the rest of the session, silently.
   */
  it('keeps the working URL when a mint comes back without an expiry, and retries', async () => {
    let broken = true;
    const double = providerDouble(() =>
      broken
        ? { url: 'https://sb1-5173.csb.app' }
        : { url: 'https://sb1-5173.csb.app/?preview_token=good', expiresAt: Date.now() + HOUR },
    );
    const store = await storeOver(double);

    double.firePort(5173, 'open', 'https://sb1-5173.csb.app/?preview_token=live');
    await vi.advanceTimersByTimeAsync(0);

    // The URL the iframe is happily rendering is left exactly as it was.
    expect(store.previews.get()[0].baseUrl).toBe('https://sb1-5173.csb.app/?preview_token=live');
    expect(store.previews.get()[0].expiresAt).toBeUndefined();

    // But a retry IS armed — without one, this preview is never rotated again.
    expect(vi.getTimerCount()).toBe(1);

    broken = false;
    await vi.advanceTimersByTimeAsync(REMINT_RETRY_DELAY_MS);

    expect(double.refreshedAt).toHaveLength(2);
    expect(store.previews.get()[0].baseUrl).toBe('https://sb1-5173.csb.app/?preview_token=good');

    // And recovery resumes the ORDINARY schedule, not the retry cadence.
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(HOUR - PREVIEW_REMINT_WINDOW_MS);
    expect(double.refreshedAt).toHaveLength(3);
  });

  /*
   * A mint that THROWS is the same failure through a different door: keep the working preview, retry
   * shortly. A transient 500 at the rotation moment must not cost the session its rotation.
   */
  it('keeps the original preview when the mint route fails, and retries until it comes back', async () => {
    let broken = true;
    const double = providerDouble(() => {
      if (broken) {
        return Promise.reject(new Error('HTTP 500')) as Promise<never>;
      }

      return { url: 'https://sb1-5173.csb.app/?preview_token=good', expiresAt: Date.now() + HOUR };
    });
    const store = await storeOver(double);

    double.firePort(5173, 'open', 'https://sb1-5173.csb.app/?preview_token=live');
    await vi.advanceTimersByTimeAsync(0);

    expect(store.previews.get()).toMatchObject([
      { port: 5173, ready: true, baseUrl: 'https://sb1-5173.csb.app/?preview_token=live' },
    ]);
    expect(vi.getTimerCount()).toBe(1);

    // Still failing an hour in: still retrying, still holding the URL that works.
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(double.refreshedAt.length).toBeGreaterThan(2);
    expect(store.previews.get()[0].baseUrl).toBe('https://sb1-5173.csb.app/?preview_token=live');

    broken = false;
    await vi.advanceTimersByTimeAsync(REMINT_RETRY_DELAY_MS);

    expect(store.previews.get()[0].baseUrl).toBe('https://sb1-5173.csb.app/?preview_token=good');
  });

  /*
   * 🔴 THE IMMORTAL TIMER. A dev-server restart closes and reopens the port — which is EXACTLY the
   * moment a re-mint is in flight, because a restart is also when tokens get asked for. Arming a
   * timer after the await for a port that has since closed leaves one undying timer per restart,
   * each minting tokens forever for a preview nothing renders, against a rate-limited provider.
   */
  it('arms nothing when the port closes while a mint is still in flight', async () => {
    let releaseMint: (value: SandboxPreviewUrl) => void = () => {};
    const double = providerDouble(() => new Promise<SandboxPreviewUrl>((resolve) => (releaseMint = resolve)));
    const store = await storeOver(double);

    double.firePort(5173, 'open', 'https://sb1-5173.csb.app');
    await vi.advanceTimersByTimeAsync(0);

    // The mint is parked; the port goes away underneath it.
    double.firePort(5173, 'close', 'https://sb1-5173.csb.app');
    expect(store.previews.get()).toEqual([]);

    releaseMint({ url: 'https://sb1-5173.csb.app/?preview_token=late', expiresAt: Date.now() + HOUR });
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(0);

    // Hours later: still no timer, still no second mint, and no preview resurrected by a late answer.
    await vi.advanceTimersByTimeAsync(4 * HOUR);
    expect(double.refreshedAt).toHaveLength(1);
    expect(store.previews.get()).toEqual([]);
  });
});

describe('a provider whose preview URLs do not expire (WebContainer)', () => {
  /*
   * 🔴 The seam reads the ABSENCE of `refreshPreviewUrl` as "these URLs do not expire". The store must
   * take that literally: no timer, no call, byte-identical behaviour to before T8 on the provider
   * that is still the default build.
   */
  it('schedules nothing and never asks for a re-mint', async () => {
    const double = providerDouble();
    const store = await storeOver(double);

    double.firePort(5173, 'open', 'https://abc.local-credentialless.webcontainer-api.io');
    await vi.advanceTimersByTimeAsync(0);

    expect(store.previews.get()).toMatchObject([
      { port: 5173, ready: true, baseUrl: 'https://abc.local-credentialless.webcontainer-api.io' },
    ]);

    // Nothing pending, and nothing pending an hour later either.
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(4 * HOUR);
    expect(double.refreshedAt).toEqual([]);
    expect(store.previews.get()[0].expiresAt).toBeUndefined();
  });
});

describe('currentPreviewUrl — what the reload button must use', () => {
  /*
   * 🔴 `iframe.src = iframe.src` re-requests the SAME token, so a manual reload of an expired preview
   * faithfully reloads the 401 page — the user presses the button, watches it "reload", and nothing
   * improves. The reload path has to ASK for a URL rather than reuse the rendered one.
   */
  it('returns a freshly minted URL, and publishes it to the store', async () => {
    const double = providerDouble((_port, call) => ({
      url: `https://sb1-5173.csb.app/?preview_token=t${call}`,
      expiresAt: Date.now() + HOUR,
    }));
    const store = await storeOver(double);

    double.firePort(5173, 'open', 'https://sb1-5173.csb.app');
    await vi.advanceTimersByTimeAsync(0);

    const before = store.previews.get()[0];

    await expect(store.currentPreviewUrl(5173)).resolves.toBe('https://sb1-5173.csb.app/?preview_token=t1');

    // The reload's fresh URL becomes the store's URL too — one truth, and again by replacement.
    const after = store.previews.get()[0];
    expect(after.baseUrl).toBe('https://sb1-5173.csb.app/?preview_token=t1');
    expect(after).not.toBe(before);
  });

  /*
   * A mint failure at reload time falls back to the URL we already have. Returning `undefined` would
   * make the caller blank the iframe: strictly worse than reloading a preview that might still work.
   */
  it('falls back to the stored URL when the provider cannot mint', async () => {
    let fail = false;
    const double = providerDouble(() => {
      if (fail) {
        return Promise.reject(new Error('HTTP 500')) as Promise<never>;
      }

      return { url: 'https://sb1-5173.csb.app/?preview_token=t0', expiresAt: Date.now() + HOUR };
    });
    const store = await storeOver(double);

    double.firePort(5173, 'open', 'https://sb1-5173.csb.app');
    await vi.advanceTimersByTimeAsync(0);

    fail = true;

    await expect(store.currentPreviewUrl(5173)).resolves.toBe('https://sb1-5173.csb.app/?preview_token=t0');
  });

  /** On a provider with no minting there is exactly one answer: the URL the port event carried. */
  it('returns the stored URL on a provider that cannot re-mint at all', async () => {
    const double = providerDouble();
    const store = await storeOver(double);

    double.firePort(5173, 'open', 'https://abc.local-credentialless.webcontainer-api.io');
    await vi.advanceTimersByTimeAsync(0);

    await expect(store.currentPreviewUrl(5173)).resolves.toBe('https://abc.local-credentialless.webcontainer-api.io');
  });

  /** A port nobody ever opened has no URL to invent — `undefined`, never a guessed host. */
  it('answers undefined for a port that was never open', async () => {
    const store = await storeOver(providerDouble());

    await expect(store.currentPreviewUrl(9999)).resolves.toBeUndefined();
  });
});
