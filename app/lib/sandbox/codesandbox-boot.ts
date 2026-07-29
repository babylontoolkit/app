/**
 * Booting a CodeSandbox-backed sandbox in the browser (SPEC §8, `spec/sandbox-codesandbox.md`).
 *
 * The client counterpart to `~/lib/webcontainer`: it produces a connected client for the seam entry
 * point to wrap. Where the WebContainer boot starts a WASM runtime in the tab, this one asks the
 * server for a scoped session and connects over a WebSocket.
 *
 * 🔴 **No API key is involved and none can be.** `/api/sandbox/session` proves the caller's identity,
 * decides create-vs-resume server-side, and returns a `SandboxSession` scoped to one sandbox. This
 * module never sees `CODESANDBOX_API_KEY`, and `sandbox-seam.spec.ts` scans to keep it that way.
 *
 * 🔴 **A boot belongs to ONE PROJECT, and every fact it produces is per-boot.** The sandbox is the
 * project's VM (its id lives on the project row), so the project id is an ARGUMENT here and is
 * CAPTURED by every closure this function hands back — never re-read from a store. A hibernated tab
 * that wakes an hour later must reconnect to the project it booted for, not to whichever project the
 * `projectId` atom happens to hold; and the preview cache lives inside the boot rather than at module
 * scope, so port 5173 on project B can never be answered with project A's token. Both of those were
 * module state before per-project sandboxes existed, and both fail silently.
 *
 * ⚠️ `getSession` is not optional plumbing. The SDK calls it to RECONNECT — when a laptop wakes, a
 * network drops, or a hibernated VM needs resuming mid-session. Pointing it at anything other than a
 * live re-mint means the workbench works perfectly until the first interruption and then silently
 * stops receiving file events, which reads as "the app froze" rather than as a connection problem.
 */
import { connectToSandbox, type SandboxClient } from '@codesandbox/sdk/browser';
import { bootupPreservedFilesystem } from './codesandbox-translate';
import {
  assertReconnectSameSandbox,
  previewCacheIsFresh,
  previewRequestPath,
  PREVIEW_REMINT_WINDOW_MS,
  sessionRequestBody,
} from './boot-decisions';
import { SandboxUnavailableError } from './errors';
import type { SandboxPreviewUrl } from './types';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('codesandbox-boot');

export { SandboxUnavailableError };

interface SessionResponse {
  session: Parameters<typeof connectToSandbox>[0]['session'];
  sandboxId: string;
  bootupType: string;
  created: boolean;
}

/** Everything a boot produces, all of it scoped to the project that was booted. */
export interface CodeSandboxBoot {
  client: SandboxClient;

  sandboxId: string;

  /**
   * Whether THIS boot came back with the previous session's files intact.
   *
   * A per-boot value, not module state: a mid-page reconnect must not retroactively change what the
   * mount decided, and — more dangerously — a CLEAN reconnect must never read as "the disk was
   * restored", which would let the next checkpoint capture template state as the project.
   */
  bootRestoredFilesystem: boolean;

  mintPreviewUrl: (port: number, host: string) => Promise<string>;

  /**
   * The current URL for a port already seen open, re-minted if its token is close to expiry.
   *
   * The host is not a parameter because the caller (`PreviewsStore`, through the provider's
   * `refreshPreviewUrl`) does not have one — it has a port and a stale URL. The minter recorded the
   * host when the port first opened, which is the only place it is ever known.
   */
  previewUrlForPort: (port: number) => Promise<SandboxPreviewUrl | undefined>;
}

async function requestSession(projectId: string, options: { reset?: boolean } = {}): Promise<SessionResponse> {
  const response = await fetch('/api/sandbox/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sessionRequestBody(projectId, options)),
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string; retryable?: boolean };

    /*
     * LOUD. A sandbox that cannot start is the whole product not working, and the two states worth
     * distinguishing — "not configured" and "could not reach the provider" — both have an operator
     * action behind them. Failing quietly here would present as an empty workbench.
     *
     * `retryable` is carried through rather than assumed: the server marks a provider blip 503
     * retryable and a 429 rate limit likewise, while a 404 (not your project) and a 400 (no project
     * id) are states a retry cannot change, and offering a retry button for those is a lie.
     */
    throw new SandboxUnavailableError(detail.error ?? `Could not start a sandbox (HTTP ${response.status}).`, {
      retryable: detail.retryable ?? response.status >= 500,
    });
  }

  return (await response.json()) as SessionResponse;
}

/**
 * Turn "port N opened" into a URL an `<iframe>` can actually render, for ONE project.
 *
 * 🔴 A project sandbox is `privacy: 'private'`, so its preview host answers **401** to anyone
 * without a token (MEASURED — that privacy is deliberate, it is the user's unreleased game). The
 * bare `https://<id>-<port>.csb.app` the port event carries is therefore NOT a preview URL; it is a
 * closed door. This asks `/api/sandbox/preview` — a two-wall route — for the `?preview_token=` form,
 * which is the only form an iframe can present (it cannot set a header).
 *
 * Falls back to the bare host URL rather than throwing: a minting failure should degrade to the 401
 * page (which at least names the problem in the network tab) instead of tearing down the port event
 * and leaving no preview registered at all.
 *
 * 🔴 The cache is a local, per-boot `Map`. As module state keyed by PORT alone it would hand project
 * B's iframe the token minted for project A's port 5173 — a live, readable preview of the wrong game,
 * with nothing to indicate it.
 */
function createPreviewMinter(projectId: string): {
  mintPreviewUrl: (port: number, host: string) => Promise<string>;
  previewUrlForPort: (port: number) => Promise<SandboxPreviewUrl | undefined>;
} {
  const previewUrls = new Map<number, { url: string; expiresAt: number }>();

  /**
   * The public host each port was announced on, recorded whether or not minting SUCCEEDED.
   *
   * Kept apart from the URL cache on purpose: a re-mint needs a host, and if the host were only
   * recorded alongside a successful mint then a port whose FIRST mint failed would have no host for
   * the rest of the boot — so `previewUrlForPort` could only ever answer `undefined`, and the store's
   * retry would tick forever without issuing a single request. The host is knowledge from the port
   * event, not a product of the mint; storing it where the mint's success is stored conflated the two.
   */
  const previewHosts = new Map<number, string>();

  /**
   * A tokened URL for this port, or `undefined` if one could not be produced.
   *
   * 🔴 `undefined` means FAILED, and it is deliberately not a URL. The tempting degrade — hand back
   * `https://<host>` — is a URL that is *guaranteed* to 401 on a private sandbox, so returning it from
   * a RE-MINT would replace a still-valid preview with a dead one, five minutes early, on a single
   * transient blip. Only the first-open path may degrade that way (there is nothing to lose there and
   * the 401 at least names the problem in the network tab); a re-mint's caller must be free to keep
   * what it already has.
   */
  async function mint(port: number, host: string): Promise<SandboxPreviewUrl | undefined> {
    previewHosts.set(port, host);

    const cached = previewUrls.get(port);

    if (cached && previewCacheIsFresh(cached.expiresAt, Date.now(), PREVIEW_REMINT_WINDOW_MS)) {
      return { url: cached.url, expiresAt: cached.expiresAt };
    }

    try {
      const response = await fetch(previewRequestPath(projectId, port));

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as { url: string; expiresAt: string };
      const expiresAt = Date.parse(data.expiresAt);

      if (!Number.isFinite(expiresAt)) {
        /*
         * A URL we cannot date is a URL we cannot keep alive: nothing would ever schedule its
         * replacement, so it dies quietly an hour later. Treated as a failed mint rather than cached.
         */
        throw new Error(`unparseable expiry "${data.expiresAt}"`);
      }

      previewUrls.set(port, { url: data.url, expiresAt });

      return { url: data.url, expiresAt };
    } catch (error) {
      logger.warn(`Could not mint a preview token for port ${port}: ${(error as Error)?.message}`);

      return undefined;
    }
  }

  return {
    // The first-open path: a bare host is better than no preview entry at all. See `mint`.
    mintPreviewUrl: async (port, host) => (await mint(port, host))?.url ?? `https://${host}`,

    previewUrlForPort: async (port) => {
      const host = previewHosts.get(port);

      /*
       * A port never SEEN through this boot has no host, so there is nothing to re-mint and no URL to
       * guess. `undefined` says exactly that; a fabricated bare-host URL here would replace a working
       * preview with a 401. A port that was seen but whose mint failed DOES have a host — which is
       * what lets a retry heal it.
       */
      return host ? mint(port, host) : undefined;
    },
  };
}

/**
 * Connect to a PROJECT's sandbox, creating or resuming it server-side as needed.
 *
 * The `bootupType` is logged rather than ignored: `CLEAN` means the hibernation snapshot expired and
 * the VM came back as bare template state. Nothing here can fix that — refilling from the §4.5.4c
 * working copy is the mount path's job — but it must be visible, because the symptom otherwise is a
 * project that silently lost its files.
 */
export async function bootCodeSandbox(
  projectId: string,
  options: { onAdoptionRefused?: (error: Error) => void } = {},
): Promise<CodeSandboxBoot> {
  const first = await requestSession(projectId);

  logger.info(
    `Sandbox ${first.sandboxId} ready for project ${projectId} ` +
      `(${first.bootupType}${first.created ? ', newly created' : ''}).`,
  );

  if (first.bootupType === 'CLEAN') {
    logger.warn(
      `Sandbox ${first.sandboxId} came back CLEAN — its snapshot had expired, so the filesystem is template state.`,
    );
  }

  const client = await connectToSandbox({
    session: first.session,

    /*
     * Re-mint on every reconnect rather than replaying the first session: sessions expire, and a
     * resumed-from-hibernation sandbox needs the server to wake it before a connection can succeed.
     *
     * 🔴 For the PROJECT THIS BOOT WAS FOR — `projectId` is the captured argument, never a store read.
     * A tab hibernated on project A that wakes while the user has since opened project B would
     * otherwise reconnect A's live client to B's VM.
     *
     * 🔴 And never onto a DIFFERENT sandbox: `assertReconnectSameSandbox` throws rather than let the
     * SDK point this page's client at a filesystem the workbench is not rendering. The refusal is
     * surfaced through `onAdoptionRefused` because the SDK swallows it into a failed reconnect, and a
     * dead-quiet connection is exactly the symptom that reads as "the app froze".
     */
    getSession: async () => {
      const next = await requestSession(projectId);

      try {
        assertReconnectSameSandbox(first.sandboxId, next);
      } catch (error) {
        logger.error(
          `Refusing to reconnect project ${projectId}: booted ${first.sandboxId}, ` +
            `offered ${next.sandboxId}${next.created ? ' (newly created)' : ''}.`,
        );
        options.onAdoptionRefused?.(error as Error);

        throw error;
      }

      return next.session;
    },

    /*
     * Tell the SDK when the tab is focused so it reconnects on wake instead of sitting on a socket
     * that died while the laptop was closed.
     *
     * 🔴 `visibilitychange` alone is NOT enough (MEASURED live): a tab that stays visible but loses
     * WINDOW focus for ~20 minutes never fires it, the Pitcher socket goes stale, and every
     * fs/terminal call times out ("Pitcher message fs/writeFile timed out", typing into a terminal
     * silently dropped) — until the user happens to refocus the window, which is exactly the
     * "it works now that I moved the window" symptom. `window` focus events cover that case.
     */
    onFocusChange: (notify) => {
      const notifyNow = () => notify(document.visibilityState === 'visible' && document.hasFocus());
      document.addEventListener('visibilitychange', notifyNow);
      window.addEventListener('focus', notifyNow);
      window.addEventListener('blur', notifyNow);

      return () => {
        document.removeEventListener('visibilitychange', notifyNow);
        window.removeEventListener('focus', notifyNow);
        window.removeEventListener('blur', notifyNow);
      };
    },
  });

  const minter = createPreviewMinter(projectId);

  return {
    client,
    sandboxId: first.sandboxId,
    bootRestoredFilesystem: bootupPreservedFilesystem(first.bootupType),
    mintPreviewUrl: minter.mintPreviewUrl,
    previewUrlForPort: minter.previewUrlForPort,
  };
}
