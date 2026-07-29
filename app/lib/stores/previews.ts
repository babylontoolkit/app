import { atom } from 'nanostores';
import type { SandboxProvider } from '~/lib/sandbox';
import { remintDelayMs, REMINT_RETRY_DELAY_MS } from './preview-url';

// Extend Window interface to include our custom property
declare global {
  interface Window {
    _tabId?: string;
  }
}

export interface PreviewInfo {
  port: number;
  ready: boolean;
  baseUrl: string;

  /**
   * When `baseUrl`'s credential dies (epoch ms), on providers whose preview URLs expire.
   *
   * Absent means "does not expire" (WebContainer), NOT "unknown" — nothing is scheduled for it.
   */
  expiresAt?: number;
}

// Create a broadcast channel for preview updates
const PREVIEW_CHANNEL = 'preview-updates';

export class PreviewsStore {
  #availablePreviews = new Map<number, PreviewInfo>();
  #sandbox: Promise<SandboxProvider>;
  #broadcastChannel?: BroadcastChannel;
  #lastUpdate = new Map<string, number>();
  #watchedFiles = new Set<string>();
  #refreshTimeouts = new Map<string, NodeJS.Timeout>();
  #REFRESH_DELAY = 300;
  #storageChannel?: BroadcastChannel;

  /** Per-port re-mint timers (T8). Only providers whose preview URLs expire ever populate this. */
  #remintTimers = new Map<number, ReturnType<typeof setTimeout>>();

  previews = atom<PreviewInfo[]>([]);

  constructor(sandboxPromise: Promise<SandboxProvider>) {
    this.#sandbox = sandboxPromise;
    this.#broadcastChannel = this.#maybeCreateChannel(PREVIEW_CHANNEL);
    this.#storageChannel = this.#maybeCreateChannel('storage-sync-channel');

    if (this.#broadcastChannel) {
      // Listen for preview updates from other tabs
      this.#broadcastChannel.onmessage = (event) => {
        const { type, previewId } = event.data;

        if (type === 'file-change') {
          const timestamp = event.data.timestamp;
          const lastUpdate = this.#lastUpdate.get(previewId) || 0;

          if (timestamp > lastUpdate) {
            this.#lastUpdate.set(previewId, timestamp);
            this.refreshPreview(previewId);
          }
        }
      };
    }

    if (this.#storageChannel) {
      // Listen for storage sync messages
      this.#storageChannel.onmessage = (event) => {
        const { storage, source } = event.data;

        if (storage && source !== this._getTabId()) {
          this._syncStorage(storage);
        }
      };
    }

    // Override localStorage setItem to catch all changes
    if (typeof window !== 'undefined') {
      const originalSetItem = localStorage.setItem;

      localStorage.setItem = (...args) => {
        originalSetItem.apply(localStorage, args);
        this._broadcastStorageSync();
      };
    }

    this.#init();
  }

  #maybeCreateChannel(name: string): BroadcastChannel | undefined {
    if (typeof globalThis === 'undefined') {
      return undefined;
    }

    const globalBroadcastChannel = (
      globalThis as typeof globalThis & {
        BroadcastChannel?: typeof BroadcastChannel;
      }
    ).BroadcastChannel;

    if (typeof globalBroadcastChannel !== 'function') {
      return undefined;
    }

    try {
      return new globalBroadcastChannel(name);
    } catch (error) {
      console.warn('[Preview] BroadcastChannel unavailable:', error);
      return undefined;
    }
  }

  // Generate a unique ID for this tab
  private _getTabId(): string {
    if (typeof window !== 'undefined') {
      if (!window._tabId) {
        window._tabId = Math.random().toString(36).substring(2, 15);
      }

      return window._tabId;
    }

    return '';
  }

  // Sync storage data between tabs
  private _syncStorage(storage: Record<string, string>) {
    if (typeof window !== 'undefined') {
      Object.entries(storage).forEach(([key, value]) => {
        try {
          const originalSetItem = Object.getPrototypeOf(localStorage).setItem;
          originalSetItem.call(localStorage, key, value);
        } catch (error) {
          console.error('[Preview] Error syncing storage:', error);
        }
      });

      // Force a refresh after syncing storage
      const previews = this.previews.get();
      previews.forEach((preview) => {
        const previewId = this.getPreviewId(preview.baseUrl);

        if (previewId) {
          this.refreshPreview(previewId);
        }
      });

      // Reload the page content
      if (typeof window !== 'undefined' && window.location) {
        const iframe = document.querySelector('iframe');

        if (iframe) {
          iframe.src = iframe.src;
        }
      }
    }
  }

  // Broadcast storage state to other tabs
  private _broadcastStorageSync() {
    if (typeof window !== 'undefined') {
      const storage: Record<string, string> = {};

      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);

        if (key) {
          storage[key] = localStorage.getItem(key) || '';
        }
      }

      this.#storageChannel?.postMessage({
        type: 'storage-sync',
        storage,
        source: this._getTabId(),
        timestamp: Date.now(),
      });
    }
  }

  async #init() {
    const sandbox = await this.#sandbox;

    // Listen for server ready events
    sandbox.onServerReady((port, url) => {
      console.log('[Preview] Server ready on port:', port, url);
      this.broadcastUpdate(url);

      // Initial storage sync when preview is ready
      this._broadcastStorageSync();
    });

    // Listen for port events
    sandbox.onPort((port, type, url) => {
      let previewInfo = this.#availablePreviews.get(port);

      if (type === 'close' && previewInfo) {
        this.#cancelRemint(port);
        this.#availablePreviews.delete(port);
        this.previews.set(this.previews.get().filter((preview) => preview.port !== port));

        return;
      }

      const previews = this.previews.get();

      if (!previewInfo) {
        previewInfo = { port, ready: type === 'open', baseUrl: url };
        this.#availablePreviews.set(port, previewInfo);
        previews.push(previewInfo);
      }

      previewInfo.ready = type === 'open';
      previewInfo.baseUrl = url;

      this.previews.set([...previews]);

      if (type === 'open') {
        this.broadcastUpdate(url);

        /*
         * Learn (and then keep ahead of) this URL's expiry. The port event carries only a URL, so the
         * expiry has to be asked for — on a provider without expiring URLs there is no such method and
         * this is a no-op. Fire-and-forget: a preview must appear whether or not the mint route answers.
         */
        void this.#scheduleRemint(port);
      }
    });
  }

  /**
   * Ask the provider for this port's current URL and schedule the next re-mint before it dies.
   *
   * 🔴 The whole point is that an EXPIRED preview looks fine: the provider's 401 page is cross-origin,
   * so it still fires the iframe's `onLoad` and the stale-preview alert clears. Without this the
   * workbench reports a healthy preview over a dead one after an hour and only a page reload fixes it.
   */
  async #scheduleRemint(port: number): Promise<void> {
    const sandbox = await this.#sandbox;

    // Absent on providers whose preview URLs never expire (WebContainer) — nothing to schedule.
    if (!sandbox.refreshPreviewUrl) {
      return;
    }

    let minted: { url: string; expiresAt?: number } | undefined;

    try {
      minted = await sandbox.refreshPreviewUrl(port);
    } catch (error) {
      console.warn('[Preview] Could not refresh the preview URL for port', port, error);
    }

    /*
     * 🔴 The port may have CLOSED while that awaited — a dev-server restart is exactly the moment a
     * re-mint is in flight. Installing a timer now would tick forever for a preview nothing renders,
     * one immortal timer per restart, spending provider requests against a rate limit.
     */
    if (!this.#availablePreviews.has(port)) {
      return;
    }

    /*
     * 🔴 A mint that produced nothing is a FAILURE, not a new state of the world: keep the URL the
     * iframe is happily using and try again shortly. Applying a degraded/undated URL here would
     * replace a still-valid preview with a dead one five minutes EARLY — the very failure this
     * scheduler exists to prevent — and, with no expiry to schedule from, it would then stop rotating
     * for the rest of the session.
     */
    if (!minted?.expiresAt) {
      this.#armRemint(port, REMINT_RETRY_DELAY_MS);
      return;
    }

    this.#applyPreviewUrl(port, minted);

    const delay = remintDelayMs(minted.expiresAt, Date.now());

    if (delay === undefined) {
      return;
    }

    this.#armRemint(port, delay);
  }

  #armRemint(port: number, delay: number) {
    this.#cancelRemint(port);
    this.#remintTimers.set(
      port,
      setTimeout(() => {
        this.#remintTimers.delete(port);
        void this.#scheduleRemint(port);
      }, delay),
    );
  }

  /**
   * Swap in a re-minted URL, leaving everything else about the preview alone.
   *
   * `port` and `ready` must stay stable: the preview did not close and did not become unready — only
   * its credential rotated. Changing either would flicker the port dropdown and remount the iframe
   * through the ready→false path for no reason.
   */
  #applyPreviewUrl(port: number, minted: { url: string; expiresAt?: number }) {
    const previewInfo = this.#availablePreviews.get(port);

    if (!previewInfo) {
      return;
    }

    if (previewInfo.baseUrl === minted.url && previewInfo.expiresAt === minted.expiresAt) {
      return;
    }

    /*
     * A NEW object, not a mutation.
     *
     * Today's consumer happens to survive either way (`Preview.tsx`'s effect depends on the baseUrl
     * STRING, and the new array already re-renders it) — but a mutated entry means the atom's old and
     * new values are the same objects, so any consumer that memoises on identity, diffs, or holds a
     * captured entry silently keeps the dead token. Rotation is invisible when it fails; publishing a
     * replacement is what makes the change observable to everyone rather than to one component.
     */
    const updated: PreviewInfo = { ...previewInfo, baseUrl: minted.url, expiresAt: minted.expiresAt };
    this.#availablePreviews.set(port, updated);
    this.previews.set(this.previews.get().map((preview) => (preview.port === port ? updated : preview)));
  }

  #cancelRemint(port: number) {
    const timer = this.#remintTimers.get(port);

    if (timer) {
      clearTimeout(timer);
      this.#remintTimers.delete(port);
    }
  }

  /**
   * The current, non-expiring-imminently URL for a port — what the reload button must use.
   *
   * `iframe.src = iframe.src` re-requests the SAME token, so a manual reload of an expired preview
   * reloads the 401 page. Callers await this first and assign what it returns.
   */
  async currentPreviewUrl(port: number): Promise<string | undefined> {
    const sandbox = await this.#sandbox;

    if (sandbox.refreshPreviewUrl) {
      try {
        const minted = await sandbox.refreshPreviewUrl(port);

        if (minted) {
          this.#applyPreviewUrl(port, minted);

          return minted.url;
        }
      } catch (error) {
        console.warn('[Preview] Could not re-mint before reload for port', port, error);
      }
    }

    return this.#availablePreviews.get(port)?.baseUrl;
  }

  /*
   * Helper to extract preview ID from URL.
   *
   * ⚠️ Still WebContainer-shaped: it matches StackBlitz's `*.local-credentialless.webcontainer-api.io`
   * preview hostname. It degrades safely rather than throwing — a provider with different preview
   * URLs returns null here and every caller guards on that, costing only the cross-tab preview
   * broadcast. Promoting preview-id extraction onto `SandboxProvider` is follow-up work; it is left
   * here so this pass stays behaviour-preserving (`spec/sandbox-seam.md`).
   */
  getPreviewId(url: string): string | null {
    const match = url.match(/^https?:\/\/([^.]+)\.local-credentialless\.webcontainer-api\.io/);
    return match ? match[1] : null;
  }

  // Broadcast state change to all tabs
  broadcastStateChange(previewId: string) {
    const timestamp = Date.now();
    this.#lastUpdate.set(previewId, timestamp);

    this.#broadcastChannel?.postMessage({
      type: 'state-change',
      previewId,
      timestamp,
    });
  }

  // Broadcast file change to all tabs
  broadcastFileChange(previewId: string) {
    const timestamp = Date.now();
    this.#lastUpdate.set(previewId, timestamp);

    this.#broadcastChannel?.postMessage({
      type: 'file-change',
      previewId,
      timestamp,
    });
  }

  // Broadcast update to all tabs
  broadcastUpdate(url: string) {
    const previewId = this.getPreviewId(url);

    if (previewId) {
      const timestamp = Date.now();
      this.#lastUpdate.set(previewId, timestamp);

      this.#broadcastChannel?.postMessage({
        type: 'file-change',
        previewId,
        timestamp,
      });
    }
  }

  // Method to refresh a specific preview
  refreshPreview(previewId: string) {
    // Clear any pending refresh for this preview
    const existingTimeout = this.#refreshTimeouts.get(previewId);

    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Set a new timeout for this refresh
    const timeout = setTimeout(() => {
      const previews = this.previews.get();
      const preview = previews.find((p) => this.getPreviewId(p.baseUrl) === previewId);

      if (preview) {
        preview.ready = false;
        this.previews.set([...previews]);

        requestAnimationFrame(() => {
          preview.ready = true;
          this.previews.set([...previews]);
        });
      }

      this.#refreshTimeouts.delete(previewId);
    }, this.#REFRESH_DELAY);

    this.#refreshTimeouts.set(previewId, timeout);
  }

  refreshAllPreviews() {
    const previews = this.previews.get();

    for (const preview of previews) {
      const previewId = this.getPreviewId(preview.baseUrl);

      if (previewId) {
        this.broadcastFileChange(previewId);
      }
    }
  }
}

// Create a singleton instance
let previewsStore: PreviewsStore | null = null;

export function usePreviewStore() {
  if (!previewsStore) {
    /*
     * Initialize with a Promise that resolves to the session sandbox.
     * This should match how the sandbox is initialized elsewhere (`~/lib/sandbox`).
     */
    previewsStore = new PreviewsStore(Promise.resolve({} as SandboxProvider));
  }

  return previewsStore;
}
