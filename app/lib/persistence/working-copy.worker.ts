/**
 * Web Worker that encodes + uploads the server working copy off the main thread (SPEC §4.5.4c, §4.16).
 *
 * The main thread reads a project's raw bytes (async, non-blocking) and TRANSFERS the ArrayBuffers
 * here (zero-copy). This worker does the two synchronous, un-yieldable, memory-doubling steps —
 * base64-encoding every binary and `JSON.stringify`-ing the whole envelope — and PUTs the result. None
 * of it touches the UI thread, so even a large save can never freeze the tab (the §4.16 media crash was
 * exactly that freeze, on the main thread).
 *
 * The PUT is same-origin, so the session cookie rides along automatically (`credentials: 'same-origin'`)
 * — the working-copy route's two-wall auth is satisfied the same as a main-thread fetch.
 */
import { buildWorkingCopyBody, type WorkingCopyEntry } from './working-copy-envelope';

interface WorkerRequest {
  requestId: number;
  url: string;
  seq: number;
  entries: WorkingCopyEntry[];
}

interface WorkerResponse {
  requestId: number;
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * The worker global, typed locally so this file needs neither the `webworker` tsc lib (which conflicts
 * with the DOM lib the rest of the app uses) nor an `any`.
 */
interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse) => void;
}

const ctx = self as unknown as WorkerScope;

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { requestId, url, seq, entries } = event.data;

  try {
    const body = buildWorkingCopyBody(seq, entries);
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
      credentials: 'same-origin',
    });

    const reply: WorkerResponse = { requestId, ok: response.ok, status: response.status };

    if (!response.ok) {
      reply.error = `HTTP ${response.status}`;
    }

    ctx.postMessage(reply);
  } catch (error) {
    ctx.postMessage({
      requestId,
      ok: false,
      error: (error as Error)?.message ?? 'worker error',
    } satisfies WorkerResponse);
  }
};
