/**
 * A boot belongs to ONE project, and every fact it produces is captured per boot
 * (SPEC §8, `spec/sandbox-codesandbox.md`).
 *
 * Both of the things pinned here used to be MODULE state, and both fail silently in the same shape —
 * the tab keeps working, pointed at the wrong project:
 *
 *   - `getSession` is what the SDK calls to RECONNECT (a laptop wakes, a socket drops, a hibernated
 *     VM needs resuming). Re-reading the project id from a store there means a tab hibernated on
 *     project A that wakes after the user opened project B reconnects A's live client to B's VM.
 *     Nothing throws: the workbench simply starts reading and WRITING another game's files.
 *   - the preview cache keyed by PORT alone hands project B's iframe the token minted for project A's
 *     port 5173 — a live, readable preview of an unreleased game, with nothing to indicate it.
 *
 * Driven against a doubled `@codesandbox/sdk/browser`: the claim is about what THIS module asks for
 * and refuses, and a real WebSocket cannot exist in a spec anyway.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SandboxAdoptionError } from './errors';

type GetSession = () => Promise<unknown>;

/** The `getSession` the module handed the SDK — the reconnect path, captured for direct calling. */
let capturedGetSession: GetSession | undefined;

const connectToSandbox = vi.hoisted(() => vi.fn());

vi.mock('@codesandbox/sdk/browser', () => ({ connectToSandbox }));

import { bootCodeSandbox } from './codesandbox-boot';

interface SessionReply {
  sandboxId?: string;
  bootupType?: string;
  created?: boolean;
}

/** Bodies posted to `/api/sandbox/session`, in order. */
let sessionBodies: Array<Record<string, unknown>>;

/** URLs fetched from the preview minter, in order. */
let previewRequests: string[];

/** What the next session request answers with. Pushed per test to script a reconnect. */
let sessionQueue: SessionReply[];

/** What the preview route answers with, per call. */
let previewReplies: Array<{ ok: boolean; url?: string; expiresAt?: string }>;

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  sessionBodies = [];
  previewRequests = [];
  sessionQueue = [];
  previewReplies = [];
  capturedGetSession = undefined;
  connectToSandbox.mockReset();

  connectToSandbox.mockImplementation(async (options: { getSession: GetSession }) => {
    capturedGetSession = options.getSession;

    return { id: 'client' };
  });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: { body?: string }) => {
      if (input === '/api/sandbox/session') {
        sessionBodies.push(JSON.parse(init?.body ?? '{}'));

        const reply = sessionQueue.shift() ?? {};

        if (reply.sandboxId === 'HTTP_503') {
          return jsonResponse(
            { error: 'Could not reach the sandbox provider.', retryable: true },
            {
              ok: false,
              status: 503,
            },
          );
        }

        return jsonResponse({
          session: { token: `tok_${sessionBodies.length}` },
          sandboxId: reply.sandboxId ?? 'sb_1',
          bootupType: reply.bootupType ?? 'RESUME',
          created: reply.created ?? false,
        });
      }

      previewRequests.push(input);

      const reply = previewReplies.shift();

      if (!reply || !reply.ok) {
        return jsonResponse({}, { ok: false, status: 500 });
      }

      return jsonResponse({ url: reply.url, expiresAt: reply.expiresAt });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the session request', () => {
  /*
   * 🔴 The route's second wall is `requireOwnedProject`; a body with no project id is a 400 whose
   * only symptom is an empty workbench. The pre-per-project client posted exactly that.
   */
  it('names the project being booted', async () => {
    await bootCodeSandbox('prj_a');

    expect(sessionBodies).toEqual([{ projectId: 'prj_a' }]);
  });

  /*
   * A per-BOOT fact, never module state: a CLEAN reconnect must never retroactively read as "the disk
   * was restored", which would let the next checkpoint capture bare template state as the project.
   */
  it('reports whether THIS boot came back with the previous session’s files', async () => {
    sessionQueue = [{ bootupType: 'RESUME' }];
    expect((await bootCodeSandbox('prj_a')).bootRestoredFilesystem).toBe(true);

    sessionQueue = [{ bootupType: 'CLEAN' }];
    expect((await bootCodeSandbox('prj_a')).bootRestoredFilesystem).toBe(false);
  });

  /*
   * LOUD, and with the server's own retryability rather than a guess: a 503 blip is worth a retry
   * button and "not your project" is not, and offering one for the latter is a lie the user presses
   * repeatedly.
   */
  it('throws a described, retryable failure when the server refuses', async () => {
    sessionQueue = [{ sandboxId: 'HTTP_503' }];

    await expect(bootCodeSandbox('prj_a')).rejects.toMatchObject({
      name: 'SandboxUnavailableError',
      message: 'Could not reach the sandbox provider.',
      retryable: true,
    });

    // Nothing connected: a failed session must not produce a half-live client.
    expect(connectToSandbox).not.toHaveBeenCalled();
  });
});

describe('reconnect (the SDK’s getSession)', () => {
  /*
   * 🔴 THE HIBERNATE CASE. The boot captured `prj_a`; by the time the tab wakes the user may have
   * opened `prj_b` elsewhere and every ambient store says so. Re-reading a store here reconnects A's
   * live client — the one the workbench is rendering — to B's VM. The projectId argument is captured
   * by the closure precisely so that "whatever the atom says now" can never enter this path.
   */
  it('re-requests for the ORIGINAL project, not whatever is current', async () => {
    await bootCodeSandbox('prj_a');

    // The world moves on: another project is opened, atoms change, hours pass.
    sessionQueue = [{ sandboxId: 'sb_1' }];
    await capturedGetSession!();

    expect(sessionBodies).toEqual([{ projectId: 'prj_a' }, { projectId: 'prj_a' }]);
  });

  /*
   * A re-MINT, not a replay of the first session: sessions expire, and a resumed-from-hibernation
   * sandbox needs the server to wake it before a connection can succeed. Replaying would work
   * perfectly until the first interruption and then read as "the app froze".
   */
  it('hands back the freshly minted session', async () => {
    await bootCodeSandbox('prj_a');
    sessionQueue = [{ sandboxId: 'sb_1' }];

    expect(await capturedGetSession!()).toEqual({ token: 'tok_2' });
  });

  /*
   * 🔴 The dangerous direction. `created: true` means the server had to fork a fresh VM — the disk is
   * bare template state. Adopting it silently swaps the user's filesystem mid-session: every file
   * gone, no event, no error, the workbench still rendering the old tree from memory. Failing the
   * reconnect leaves a dead connection and SAYS SO, which is recoverable; adopting is not.
   */
  it('refuses a session the server had to create, and reports it', async () => {
    const onAdoptionRefused = vi.fn();
    await bootCodeSandbox('prj_a', { onAdoptionRefused });

    sessionQueue = [{ sandboxId: 'sb_1', created: true }];
    await expect(capturedGetSession!()).rejects.toBeInstanceOf(SandboxAdoptionError);

    /*
     * The notification is not decoration: the SDK swallows this rejection into a failed reconnect, so
     * without it the user watches a dead-quiet workbench and calls it a freeze.
     */
    expect(onAdoptionRefused).toHaveBeenCalledTimes(1);
    expect(onAdoptionRefused.mock.calls[0][0]).toBeInstanceOf(SandboxAdoptionError);
  });

  it('refuses a session pointing at a DIFFERENT sandbox', async () => {
    const onAdoptionRefused = vi.fn();
    await bootCodeSandbox('prj_a', { onAdoptionRefused });

    sessionQueue = [{ sandboxId: 'sb_99', created: false }];
    await expect(capturedGetSession!()).rejects.toBeInstanceOf(SandboxAdoptionError);
    expect(onAdoptionRefused).toHaveBeenCalledTimes(1);
  });

  /** The control: an ordinary reconnect to the same live VM must sail through untouched. */
  it('accepts the same sandbox and notifies nobody', async () => {
    const onAdoptionRefused = vi.fn();
    await bootCodeSandbox('prj_a', { onAdoptionRefused });

    sessionQueue = [{ sandboxId: 'sb_1', created: false }];
    await expect(capturedGetSession!()).resolves.toBeDefined();
    expect(onAdoptionRefused).not.toHaveBeenCalled();
  });
});

describe('the preview minter', () => {
  const FAR_FUTURE = new Date(Date.now() + 60 * 60_000).toISOString();

  /*
   * 🔴 A project sandbox is `privacy: 'private'` — the bare `https://<id>-<port>.csb.app` the port
   * event carries answers 401 (MEASURED). Only the `?preview_token=` form a two-wall route mints can
   * be rendered in an iframe, which cannot set a header.
   */
  it('mints through the route for the project this boot was for', async () => {
    const boot = await bootCodeSandbox('prj_a');
    previewReplies = [{ ok: true, url: 'https://sb_1-5173.csb.app?preview_token=A', expiresAt: FAR_FUTURE }];

    expect(await boot.mintPreviewUrl(5173, 'sb_1-5173.csb.app')).toBe('https://sb_1-5173.csb.app?preview_token=A');
    expect(previewRequests).toEqual(['/api/sandbox/preview?port=5173&projectId=prj_a']);
  });

  /*
   * 🔴 THE CROSS-PROJECT CACHE. Two boots, the same port, in one page's lifetime (the dashboard does a
   * full page load between projects, but a re-boot inside one tab is exactly what a retry produces).
   * Module state keyed by port alone would answer project B's iframe with project A's token — a live,
   * readable preview of the wrong game and nothing to indicate it.
   */
  it('never answers project B’s port with project A’s token', async () => {
    const bootA = await bootCodeSandbox('prj_a');
    previewReplies = [{ ok: true, url: 'https://sb_1-5173.csb.app?preview_token=A', expiresAt: FAR_FUTURE }];
    await bootA.mintPreviewUrl(5173, 'sb_1-5173.csb.app');

    const bootB = await bootCodeSandbox('prj_b');
    previewReplies = [{ ok: true, url: 'https://sb_2-5173.csb.app?preview_token=B', expiresAt: FAR_FUTURE }];

    expect(await bootB.mintPreviewUrl(5173, 'sb_2-5173.csb.app')).toBe('https://sb_2-5173.csb.app?preview_token=B');
    expect(previewRequests[1]).toBe('/api/sandbox/preview?port=5173&projectId=prj_b');
  });

  /** Within one boot the cache is a cache: a second ask for a live token costs no request. */
  it('reuses a token that is still comfortably fresh', async () => {
    const boot = await bootCodeSandbox('prj_a');
    previewReplies = [{ ok: true, url: 'https://sb_1-5173.csb.app?preview_token=A', expiresAt: FAR_FUTURE }];

    await boot.mintPreviewUrl(5173, 'sb_1-5173.csb.app');
    await boot.mintPreviewUrl(5173, 'sb_1-5173.csb.app');

    expect(previewRequests).toHaveLength(1);
  });

  /** A token near expiry is re-minted rather than handed over to die under a rendered iframe. */
  it('re-mints a token inside the expiry window', async () => {
    const boot = await bootCodeSandbox('prj_a');
    previewReplies = [
      { ok: true, url: 'https://old', expiresAt: new Date(Date.now() + 30_000).toISOString() },
      { ok: true, url: 'https://new', expiresAt: FAR_FUTURE },
    ];

    await boot.mintPreviewUrl(5173, 'sb_1-5173.csb.app');

    expect(await boot.mintPreviewUrl(5173, 'sb_1-5173.csb.app')).toBe('https://new');
    expect(previewRequests).toHaveLength(2);
  });

  /*
   * Degrades rather than throws. A minting failure that tore down the port event would leave NO
   * preview registered at all; the bare host at least 401s visibly in the network tab, which names
   * the problem instead of hiding it.
   */
  it('falls back to the bare host when minting fails', async () => {
    const boot = await bootCodeSandbox('prj_a');
    previewReplies = [{ ok: false }];

    expect(await boot.mintPreviewUrl(5173, 'sb_1-5173.csb.app')).toBe('https://sb_1-5173.csb.app');
  });

  /*
   * `previewUrlForPort` (T8) is the re-mint door: `PreviewsStore` has a PORT and a stale URL, never a
   * host, so the host has to come from what the minter recorded the first time the port opened.
   */
  describe('previewUrlForPort — the re-mint door', () => {
    /*
     * 🔴 A port this boot never minted has no recorded host, so there is nothing to re-mint and
     * nothing to guess. `undefined` says exactly that; fabricating `https://<something>` here would
     * replace a working preview with a 401 page — the very failure T8 exists to remove.
     */
    it('answers undefined for a port that was never minted through this boot', async () => {
      const boot = await bootCodeSandbox('prj_a');

      expect(await boot.previewUrlForPort(5173)).toBeUndefined();
      expect(previewRequests).toEqual([]);
    });

    /*
     * 🔴 A port whose FIRST mint failed must still be re-mintable, or the store's retry ticks forever
     * without issuing a single request and the preview stays dead until a page reload. The host comes
     * from the PORT EVENT, not from a successful mint — recording it only alongside a minted URL made
     * a first-open failure permanent for the rest of the boot.
     */
    it('can still re-mint a port whose first mint failed, and heals when the route recovers', async () => {
      const boot = await bootCodeSandbox('prj_a');
      previewReplies = [{ ok: false }, { ok: true, url: 'https://healed', expiresAt: FAR_FUTURE }];

      // The first-open degrade: a bare host, and nothing cached.
      expect(await boot.mintPreviewUrl(5173, 'sb_1-5173.csb.app')).toBe('https://sb_1-5173.csb.app');

      expect(await boot.previewUrlForPort(5173)).toEqual({ url: 'https://healed', expiresAt: Date.parse(FAR_FUTURE) });
      expect(previewRequests).toHaveLength(2);
    });

    /** A live token costs no request: the re-mint schedule asks often, and the cache is what makes that free. */
    it('returns the cached URL, with its expiry, while it is still fresh', async () => {
      const boot = await bootCodeSandbox('prj_a');
      previewReplies = [{ ok: true, url: 'https://sb_1-5173.csb.app?preview_token=A', expiresAt: FAR_FUTURE }];

      await boot.mintPreviewUrl(5173, 'sb_1-5173.csb.app');

      expect(await boot.previewUrlForPort(5173)).toEqual({
        url: 'https://sb_1-5173.csb.app?preview_token=A',
        expiresAt: Date.parse(FAR_FUTURE),
      });

      // The expiry is a NUMBER (epoch ms) — the store does arithmetic on it, not string comparison.
      expect(typeof (await boot.previewUrlForPort(5173))!.expiresAt).toBe('number');
      expect(previewRequests).toHaveLength(1);
    });

    /*
     * The case the timer fires for: the recorded token is inside the window, so the same call that
     * "returns the current URL" quietly buys a new one — using the host recorded at first mint, for
     * THIS boot's project.
     */
    it('re-mints a token inside the window, reusing the host it recorded', async () => {
      const boot = await bootCodeSandbox('prj_a');
      previewReplies = [
        { ok: true, url: 'https://old', expiresAt: new Date(Date.now() + 30_000).toISOString() },
        { ok: true, url: 'https://new', expiresAt: FAR_FUTURE },
      ];

      await boot.mintPreviewUrl(5173, 'sb_1-5173.csb.app');

      expect(await boot.previewUrlForPort(5173)).toEqual({ url: 'https://new', expiresAt: Date.parse(FAR_FUTURE) });
      expect(previewRequests).toEqual([
        '/api/sandbox/preview?port=5173&projectId=prj_a',
        '/api/sandbox/preview?port=5173&projectId=prj_a',
      ]);
    });

    /*
     * 🔴 A FAILED RE-MINT REPORTS NOTHING — never the bare host. On a private sandbox that URL is
     * guaranteed to 401, so handing it back from a re-mint would swap a still-valid preview for a
     * dead one five minutes early, on one transient blip. `undefined` lets the store keep what it
     * has and retry, which is the only non-destructive answer. (The first-open path may still
     * degrade — see the bare-host test above: there is no working preview to lose.)
     */
    it('answers undefined when the re-mint fails, rather than the guaranteed-401 bare host', async () => {
      const boot = await bootCodeSandbox('prj_a');
      previewReplies = [
        { ok: true, url: 'https://old', expiresAt: new Date(Date.now() + 30_000).toISOString() },
        { ok: false },
      ];

      await boot.mintPreviewUrl(5173, 'sb_1-5173.csb.app');

      expect(await boot.previewUrlForPort(5173)).toBeUndefined();
    });

    /*
     * 🔴 A URL WE CANNOT DATE IS A URL WE CANNOT KEEP ALIVE: nothing would ever schedule its
     * replacement, so it would die quietly an hour later — the exact silent 401 T8 exists to remove.
     * Treated as a failed mint: not returned, and NOT cached, so the next ask re-fetches rather than
     * being answered forever from a poisoned cache entry.
     */
    it('treats an unparseable expiry as a failed mint, and caches nothing', async () => {
      const boot = await bootCodeSandbox('prj_a');
      previewReplies = [
        { ok: true, url: 'https://old', expiresAt: new Date(Date.now() + 30_000).toISOString() },
        { ok: true, url: 'https://undated', expiresAt: 'whenever' },
        { ok: true, url: 'https://new', expiresAt: FAR_FUTURE },
      ];

      await boot.mintPreviewUrl(5173, 'sb_1-5173.csb.app');

      expect(await boot.previewUrlForPort(5173)).toBeUndefined();

      // Nothing was poisoned: the next attempt goes back to the route and succeeds.
      expect(await boot.previewUrlForPort(5173)).toEqual({ url: 'https://new', expiresAt: Date.parse(FAR_FUTURE) });
      expect(previewRequests).toHaveLength(3);
    });
  });
});
