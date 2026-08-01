/**
 * Booting the Nodepod runtime (`spec/sandbox-nodepod.md`).
 *
 * 🔴 One of only two modules allowed to import the Nodepod SDK — `sandbox-seam.spec.ts` enforces that
 * as a default-deny source scan with a control. Feature code imports `~/lib/sandbox`.
 *
 * The split from `nodepod-provider.ts` follows the CodeSandbox precedent: this file owns the vendor
 * import, the service worker, and the server-ready fan-out; the provider owns the seam translation and
 * is unit-testable against a fake client with no runtime at all.
 */
import { WORK_DIR } from '~/utils/constants';
import { SandboxUnavailableError } from './errors';
import type { NodepodClient } from './nodepod-provider';

/**
 * Where a project lives inside the pod.
 *
 * 🔴 **RE-EXPORTED FROM `WORK_DIR`, never written out again.** Nodepod has no host filesystem to
 * collide with, so the value is a free choice — which is exactly what makes a second literal so easy
 * to justify and so damaging. Every caller rebases against `WORK_DIR` (`path.relative(workdir, …)` in
 * `files.ts`, seven call sites), so a boot that mounted somewhere else would produce a file tree whose
 * every path failed to rebase: the workbench renders `rootFolder={WORK_DIR}`, matches nothing, and
 * shows an EMPTY project with no error. That is the failure `constants.ts`'s own comment records from
 * the CodeSandbox swap; one import is the whole fix.
 */
export const NODEPOD_WORKDIR = WORK_DIR;

/**
 * The service worker Nodepod uses to serve previews, at the root of OUR origin.
 *
 * Copied out of the installed package by `scripts/sync-nodepod-assets.mjs` and pinned byte-identical
 * by `nodepod-assets.spec.ts`. A worker's scope cannot rise above its own path, so this must be `/…`
 * and not `/assets/…`, or previews 404 with nothing explaining why.
 */
const SW_URL = '/__sw__.js';
const WORKER_URL = '/__worker__.js';

export interface BootedNodepod {
  client: NodepodClient;

  /** Register a dev-server listener. Returns an unsubscribe function. */
  onServerReady(listener: (port: number, url: string) => void): () => void;
}

/**
 * Listeners are held HERE rather than passed into `Nodepod.boot()` directly.
 *
 * `boot()` takes a single `onServerReady` callback, but the seam contract is subscribe/unsubscribe and
 * more than one caller wants the event. Fanning out from one registration also means a listener added
 * AFTER the dev server came up still learns about it — `seen` replays. Without the replay a preview
 * that boots faster than the UI mounts is simply never shown, intermittently, which reads as "the
 * preview sometimes doesn't appear".
 */
function createServerReadyHub() {
  const listeners = new Set<(port: number, url: string) => void>();
  const seen = new Map<number, string>();

  return {
    emit(port: number, url: string) {
      seen.set(port, url);

      for (const listener of listeners) {
        try {
          listener(port, url);
        } catch {
          // One bad listener must not stop the others, nor kill the runtime's callback.
        }
      }
    },

    subscribe(listener: (port: number, url: string) => void) {
      listeners.add(listener);

      for (const [port, url] of seen) {
        try {
          listener(port, url);
        } catch {
          /* as above */
        }
      }

      return () => void listeners.delete(listener);
    },
  };
}

let booted: Promise<BootedNodepod> | undefined;

/**
 * Boot the runtime for this tab, once.
 *
 * Nodepod is per-TAB and needs no project id — the whole point of the browser-side provider is that
 * there is no VM to mint, own, or bill. It also needs no API key: the runtime talks only to public
 * infrastructure (npm, jsdelivr, esm.sh), which is why adopting it removes a credential rather than
 * adding one.
 */
export function bootNodepod(): Promise<BootedNodepod> {
  booted ??= connect();

  return booted;
}

async function connect(): Promise<BootedNodepod> {
  /*
   * Nothing here may run during SSR: `~/lib/sandbox` is imported by the server render, and the SDK
   * touches `navigator`/`SharedArrayBuffer` at boot. A never-resolving promise is the same shape the
   * WebContainer branch uses, and it keeps the server from importing a browser runtime at all.
   */
  if (import.meta.env.SSR) {
    return new Promise<BootedNodepod>(() => {});
  }

  if (!crossOriginIsolated) {
    /*
     * Fail with the CAUSE, not the symptom. Nodepod's sync VFS bridge is `Atomics.wait` over a
     * SharedArrayBuffer, so without COOP/COEP `boot()` throws something generic — and the actual
     * problem is a response header on the document, which no stack trace will ever mention.
     */
    throw new SandboxUnavailableError(
      'This browser tab is not cross-origin isolated, so the sandbox cannot start. ' +
        'The page must be served with Cross-Origin-Opener-Policy: same-origin and ' +
        'Cross-Origin-Embedder-Policy: require-corp.',
    );
  }

  const hub = createServerReadyHub();

  try {
    // Not destructured: the naming-convention rule reserves PascalCase for types, and `Nodepod` is a class.
    const sdk = await import('@scelar/nodepod');

    const pod = await sdk.Nodepod.boot({
      workdir: NODEPOD_WORKDIR,
      swUrl: SW_URL,
      workerUrl: WORKER_URL,

      // Their mark, not ours (§2.5 — every brand surface comes from `app/config/brand.ts`).
      watermark: false,

      onServerReady: (port: number, url: string) => hub.emit(port, url),
    });

    return { client: pod as unknown as NodepodClient, onServerReady: hub.subscribe };
  } catch (error) {
    /*
     * Do not cache a rejection: a transient failure (a service worker that lost a registration race,
     * a reload mid-boot) would otherwise make every later attempt in this tab fail instantly with a
     * stale error, and "Try again" would be a lie.
     */
    booted = undefined;

    throw error instanceof SandboxUnavailableError
      ? error
      : new SandboxUnavailableError(
          `The sandbox runtime could not start: ${String((error as Error)?.message ?? error)}`,
        );
  }
}
