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
 * ⚠️ `getSession` is not optional plumbing. The SDK calls it to RECONNECT — when a laptop wakes, a
 * network drops, or a hibernated VM needs resuming mid-session. Pointing it at anything other than a
 * live re-mint means the workbench works perfectly until the first interruption and then silently
 * stops receiving file events, which reads as "the app froze" rather than as a connection problem.
 */
import { connectToSandbox, type SandboxClient } from '@codesandbox/sdk/browser';
import { bootupPreservedFilesystem } from './codesandbox-translate';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('codesandbox-boot');

/**
 * The bootupType of THIS page's first session — the fact `bootRestoredFilesystem` is derived from.
 *
 * Module state rather than a return value because the seam entry (`index.ts`) needs it AFTER
 * `bootCodeSandbox` resolves, and later reconnects (`getSession`) must NOT overwrite it: the mount
 * decision was made against the first boot, and a mid-session hibernate/resume does not retroactively
 * change what the mount should have done.
 */
let firstBootupType: string | undefined;

/** Whether this page's boot came back with the previous session's files intact. False until booted. */
export function bootRestoredFilesystem(): boolean {
  return firstBootupType !== undefined && bootupPreservedFilesystem(firstBootupType);
}

interface SessionResponse {
  session: Parameters<typeof connectToSandbox>[0]['session'];
  sandboxId: string;
  bootupType: string;
  created: boolean;
}

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxUnavailableError';
  }
}

async function requestSession(options: { reset?: boolean } = {}): Promise<SessionResponse> {
  const response = await fetch('/api/sandbox/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };

    /*
     * LOUD. A sandbox that cannot start is the whole product not working, and the two states worth
     * distinguishing — "not configured" and "could not reach the provider" — both have an operator
     * action behind them. Failing quietly here would present as an empty workbench.
     */
    throw new SandboxUnavailableError(detail.error ?? `Could not start a sandbox (HTTP ${response.status}).`);
  }

  return (await response.json()) as SessionResponse;
}

interface PreviewResponse {
  url: string;
  expiresAt: string;
}

/** Minted preview URLs by port. Tokens live ~an hour; re-minting per port event would be waste. */
const previewUrls = new Map<number, { url: string; expiresAt: number }>();

/** Re-mint when this close to expiry, so an iframe never receives a URL about to die under it. */
const PREVIEW_REMINT_WINDOW_MS = 5 * 60_000;

/**
 * Turn "port N opened" into a URL an `<iframe>` can actually render.
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
 */
export async function mintPreviewUrl(port: number, host: string): Promise<string> {
  const cached = previewUrls.get(port);

  if (cached && cached.expiresAt - Date.now() > PREVIEW_REMINT_WINDOW_MS) {
    return cached.url;
  }

  try {
    const response = await fetch(`/api/sandbox/preview?port=${port}`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = (await response.json()) as PreviewResponse;
    previewUrls.set(port, { url: data.url, expiresAt: Date.parse(data.expiresAt) });

    return data.url;
  } catch (error) {
    logger.warn(`Could not mint a preview token for port ${port}: ${(error as Error)?.message}`);

    return `https://${host}`;
  }
}

/**
 * Connect to this user's sandbox, creating or resuming it server-side as needed.
 *
 * The `bootupType` is logged rather than ignored: `CLEAN` means the hibernation snapshot expired and
 * the VM came back as bare template state. Nothing here can fix that — refilling from the §4.5.4c
 * working copy is the mount path's job — but it must be visible, because the symptom otherwise is a
 * project that silently lost its files.
 */
export async function bootCodeSandbox(): Promise<SandboxClient> {
  const first = await requestSession();

  firstBootupType = first.bootupType;

  logger.info(`Sandbox ${first.sandboxId} ready (${first.bootupType}${first.created ? ', newly created' : ''}).`);

  if (first.bootupType === 'CLEAN') {
    logger.warn(
      `Sandbox ${first.sandboxId} came back CLEAN — its snapshot had expired, so the filesystem is template state.`,
    );
  }

  return connectToSandbox({
    session: first.session,

    /*
     * Re-mint on every reconnect rather than replaying the first session: sessions expire, and a
     * resumed-from-hibernation sandbox needs the server to wake it before a connection can succeed.
     */
    getSession: async () => (await requestSession()).session,

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
}
