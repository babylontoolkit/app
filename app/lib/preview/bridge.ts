/**
 * The builder-side half of the dev-tools channel — see `protocol.ts` for the design.
 *
 * One bridge per page. It owns the `message` listener, matches replies to requests, keeps the running
 * error/console history, and exposes the four things the panel and (via the relay) the agent need:
 * `evaluate`, `console`, `errors`, `screenshot`.
 *
 * ## The things that are easy to get wrong here
 *
 * 🔴 **The peer check is on `source`, never on `origin`.** Only messages whose `source` is the preview
 * iframe's own `contentWindow` are honoured. Filtering on origin instead looks equivalent and is not:
 * Nodepod previews are same-origin with the builder, so an origin check would accept messages from the
 * builder's OWN other frames and from any same-origin document — including anything a game embedded in
 * an iframe of its own. `source` identifies the window; origin only identifies its host.
 *
 * 🔴 **A pending request must survive the document going away.** A preview reloads constantly (HMR, a
 * file write, the user pressing reload). A request in flight when that happens gets no reply, ever, so
 * every one carries a timeout and `detach()` settles the whole pending map. Without that, the agent's
 * tool call hangs for its full relay window and the turn pays for the silence.
 *
 * 🔴 **`ready` is a fact with a lifetime.** The agent script announces itself on load; on reload it
 * announces itself again. Treating the first `ready` as permanent means a request sent after a reload
 * goes to a document that has been replaced. Readiness is therefore reset on `attach` and re-armed by
 * each `ready` event, and a request that arrives before readiness WAITS rather than failing — a game
 * that is still booting is the normal case for the first question anyone asks.
 */
import { atom } from 'nanostores';
import { createScopedLogger } from '~/utils/logger';
import {
  isPreviewMessage,
  PREVIEW_WIRE_TAG,
  PREVIEW_WIRE_VERSION,
  type PreviewConsoleEntry,
  type PreviewErrorEntry,
  type PreviewMethod,
} from './protocol';

const logger = createScopedLogger('preview-bridge');

/**
 * How long one request may take.
 *
 * Comfortably above an `evaluate` against a live scene (sub-millisecond) and a canvas read-back (tens
 * of ms), and well under the relay's own 60s window so a stuck preview surfaces as a named failure
 * here rather than as an anonymous relay timeout.
 */
export const PREVIEW_REQUEST_TIMEOUT_MS = 10_000;

/** How long to wait for a booting document to announce itself before giving up on a request. */
export const PREVIEW_READY_TIMEOUT_MS = 15_000;

/** Ring size for what the BUILDER keeps. The document keeps its own; this is what survives a reload. */
const HISTORY_LIMIT = 200;

export interface PreviewScreenshot {
  dataUrl: string;
  width: number;
  height: number;
  blank: boolean;
  note?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Errors from the running game, newest last. Survives a preview reload; cleared on `attach`. */
export const previewErrorsStore = atom<PreviewErrorEntry[]>([]);

/** Console output from the running game, newest last. */
export const previewConsoleStore = atom<PreviewConsoleEntry[]>([]);

/** Is a preview document currently connected? Drives the panel's empty state. */
export const previewConnectedStore = atom<boolean>(false);

let iframe: HTMLIFrameElement | undefined;
let listening = false;
let sequence = 0;
let ready = false;
let readyWaiters: Array<() => void> = [];
const pending = new Map<string, Pending>();

function pushCapped<T>(store: { get(): T[]; set(value: T[]): void }, entry: T) {
  const next = [...store.get(), entry];
  store.set(next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next);
}

function handleMessage(event: MessageEvent) {
  /*
   * 🔴 The peer check. `event.source` is the only thing that identifies WHICH window spoke; see the
   * file header for why an origin comparison is not a substitute on a same-origin provider.
   */
  if (!iframe || event.source !== iframe.contentWindow) {
    return;
  }

  if (!isPreviewMessage(event.data)) {
    return;
  }

  const message = event.data;

  if (message.kind === 'event') {
    if (message.event === 'ready') {
      ready = true;
      previewConnectedStore.set(true);

      const waiters = readyWaiters;
      readyWaiters = [];
      waiters.forEach((resume) => resume());
    } else if (message.event === 'error') {
      pushCapped(previewErrorsStore, message.data as PreviewErrorEntry);
    } else if (message.event === 'console') {
      pushCapped(previewConsoleStore, message.data as PreviewConsoleEntry);
    }

    return;
  }

  if (message.kind === 'response') {
    const entry = pending.get(message.id);

    if (!entry) {
      /* A reply to a request we already timed out. Ordinary after a slow reload; not an error. */
      return;
    }

    pending.delete(message.id);
    clearTimeout(entry.timer);

    if (message.ok) {
      entry.resolve(message.data);
    } else {
      entry.reject(new Error(message.error || 'The preview reported an unknown failure.'));
    }
  }
}

/**
 * Point the bridge at a preview iframe. Idempotent per element; re-attaching to a NEW element resets
 * readiness and the history, because a different document is a different game.
 */
export function attachPreviewBridge(element: HTMLIFrameElement) {
  if (iframe === element) {
    return;
  }

  iframe = element;
  ready = false;
  previewConnectedStore.set(false);
  previewErrorsStore.set([]);
  previewConsoleStore.set([]);

  if (!listening && typeof window !== 'undefined') {
    window.addEventListener('message', handleMessage);
    listening = true;
  }
}

/** Stop listening and fail every in-flight request. Called when the preview goes away. */
export function detachPreviewBridge() {
  if (typeof window !== 'undefined' && listening) {
    window.removeEventListener('message', handleMessage);
  }

  listening = false;
  iframe = undefined;
  ready = false;
  previewConnectedStore.set(false);

  /*
   * 🔴 Settle everything. A pending request whose document has gone will never be answered, and a
   * promise nobody rejects is a tool call that burns its whole relay window in silence.
   */
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error('The preview was closed before it answered.'));
  }

  pending.clear();

  const waiters = readyWaiters;
  readyWaiters = [];
  waiters.forEach((resume) => resume());
}

/** Mark the document gone without tearing the bridge down — a reload is coming. */
export function notifyPreviewReloading() {
  ready = false;
  previewConnectedStore.set(false);
}

async function waitForReady(): Promise<void> {
  if (ready) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      readyWaiters = readyWaiters.filter((waiter) => waiter !== resume);
      resolve();
    }, PREVIEW_READY_TIMEOUT_MS);

    const resume = () => {
      clearTimeout(timer);
      resolve();
    };

    readyWaiters.push(resume);
  });
}

async function request<T>(method: PreviewMethod, params?: Record<string, unknown>): Promise<T> {
  if (!iframe) {
    throw new Error('No preview is running. Start the dev server first.');
  }

  await waitForReady();

  const target = iframe.contentWindow;

  if (!target) {
    throw new Error('The preview window is not available.');
  }

  if (!ready) {
    throw new Error('The preview did not respond. It may still be starting, or the page may have failed to load.');
  }

  const id = `pv_${++sequence}`;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`The preview did not answer within ${Math.round(PREVIEW_REQUEST_TIMEOUT_MS / 1000)}s.`));
    }, PREVIEW_REQUEST_TIMEOUT_MS);

    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });

    target.postMessage({ [PREVIEW_WIRE_TAG]: 1, v: PREVIEW_WIRE_VERSION, kind: 'request', id, method, params }, '*');
  });
}

/**
 * Run an expression inside the running game and return its (capped) value.
 *
 * This is the capability the whole channel exists for: the agent asks the game a question in the
 * game's own terms — `GameManager.GetScene().meshes.length`, `scene.getMeshByName('kart').position` —
 * instead of inferring it from a screenshot.
 */
export async function evaluateInPreview(expression: string): Promise<unknown> {
  const result = await request<{ value: unknown }>('evaluate', { expression });
  return result?.value;
}

export async function readPreviewConsole(since = 0): Promise<PreviewConsoleEntry[]> {
  const result = await request<{ entries: PreviewConsoleEntry[] }>('console', { since });
  return result?.entries ?? [];
}

export async function readPreviewErrors(since = 0): Promise<PreviewErrorEntry[]> {
  const result = await request<{ entries: PreviewErrorEntry[] }>('errors', { since });
  return result?.entries ?? [];
}

export async function capturePreviewScreenshot(): Promise<PreviewScreenshot> {
  return request<PreviewScreenshot>('screenshot');
}

/** Is a document connected right now? Synchronous, for render paths. */
export function isPreviewBridgeReady(): boolean {
  return ready;
}

/**
 * Install the agent script into the sandbox. Safe to call repeatedly; a provider without the
 * capability is a no-op that reports why rather than throwing.
 */
export async function installPreviewAgent(
  provider: { capabilities: { previewScript: boolean }; setPreviewScript?: (script: string) => Promise<void> },
  script: string,
): Promise<boolean> {
  if (!provider.capabilities.previewScript || !provider.setPreviewScript) {
    logger.info('Preview dev-tools are not supported by this sandbox provider');
    return false;
  }

  try {
    await provider.setPreviewScript(script);
    return true;
  } catch (error) {
    /*
     * Never fatal. This is instrumentation: a failure here must cost the user a debugging aid, never
     * their preview. `spec/fail-loud.md` still applies to the REPORT — hence a warning, not a swallow.
     */
    logger.warn(`Could not install the preview dev-tools script: ${(error as Error)?.message}`);
    return false;
  }
}

/**
 * Run one dev-tools request on behalf of the agent (the client half of the §4.14-style relay).
 *
 * One entry point rather than four exported calls at the call site, so the client handler stays a
 * dispatch and the METHOD NAMES live next to the protocol that defines them — a switch in
 * `Chat.client.tsx` would be a second place that has to know what `screenshot` means.
 *
 * Errors are thrown, not swallowed: the caller turns them into the relay's `error` field, which the
 * model reads as a tool_result and can act on ("start the dev server", "the expression threw").
 */
export async function runPreviewToolCall(method: PreviewMethod, params?: Record<string, unknown>): Promise<unknown> {
  if (method === 'evaluate') {
    const expression = typeof params?.expression === 'string' ? params.expression : '';

    if (!expression.trim()) {
      throw new Error('evaluate needs an expression.');
    }

    return evaluateInPreview(expression);
  }

  if (method === 'console') {
    const entries = await readPreviewConsole();
    const level = typeof params?.level === 'string' ? params.level : undefined;

    return level ? entries.filter((entry) => entry.level === level) : entries;
  }

  if (method === 'errors') {
    return readPreviewErrors();
  }

  if (method === 'screenshot') {
    return capturePreviewScreenshot();
  }

  throw new Error(`Unknown preview method: ${method}`);
}
