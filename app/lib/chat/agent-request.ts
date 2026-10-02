/**
 * One agent turn in flight per browser tab, and the tab's id that tells the server so.
 *
 * `useChat` keeps a single abort controller. When a second request starts from the same tab before
 * the first has ended (an automatic phase, retry or repair racing a send), the second overwrites the
 * handle to the first, and from then on nothing in the page can abort it: the screen reads idle, Stop
 * does nothing, and the server keeps the project locked to a turn nobody is watching — every later
 * send refused with "This project is already building" (2026-09-30).
 *
 * Two halves close that, and they need each other:
 *
 *   - `fetch` here aborts the tab's previous agent request before starting the next, so an abandoned
 *     turn's connection actually closes and its stream can never reach an orphaned reader. (An
 *     orphaned reader that saw the old turn's error would call `stop()`, and `stop()` now points at
 *     the NEW turn — killing the very send that replaced it.)
 *   - `AGENT_TAB_ID` rides in every request body, so the server can let this tab's new turn take the
 *     project from its old one even if the old connection's close has not reached it yet
 *     (`agent/inflight.ts`, "same tab"). Another tab is still refused.
 *
 * `abort` exists because aborting the old request clears `useChat`'s own controller handle, so its
 * `stop()` can no longer reach the turn that replaced it. Stop calls both.
 */

export interface AgentRequestTracker {
  /** A `fetch` for `useChat` that aborts this tab's previous agent request before sending the next. */
  fetch: typeof fetch;

  /** Abort the tab's current agent request, if any. Safe to call when nothing is in flight. */
  abort: () => void;
}

export function createAgentRequestTracker(
  baseFetch: typeof fetch = (input, init) => globalThis.fetch(input, init),
): AgentRequestTracker {
  let current: AbortController | null = null;

  return {
    fetch: (input, init) => {
      /*
       * Aborted with NO reason, deliberately: `fetch` rejects with the reason itself when one is given,
       * and `useChat` treats a turn as cancelled (silently, no error alert, no retry) only when the
       * rejection is named `AbortError` — which is what a reasonless abort produces.
       */
      current?.abort();

      const controller = new AbortController();
      current = controller;

      const outer = init?.signal;

      if (outer) {
        if (outer.aborted) {
          controller.abort();
        } else {
          outer.addEventListener('abort', () => controller.abort(), { once: true });
        }
      }

      return baseFetch(input, { ...init, signal: controller.signal });
    },

    abort: () => {
      current?.abort();
      current = null;
    },
  };
}

/** This page load's id. A reload is a new tab as far as the server is concerned — its old request closed. */
export const AGENT_TAB_ID: string =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** The tracker the builder's chat uses. One per page, like the chat itself. */
export const agentRequests = createAgentRequestTracker();
