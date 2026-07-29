/**
 * Waiting for a resumed sandbox's already-open ports to be reported (the wake path, plan T6).
 *
 * `shouldStartDevServer` asks one question — "is a dev server already serving?" — and answers it from
 * `previews.length`. On a tab-local runtime that is instantaneous and always right: the WebContainer
 * dies with the tab, so a fresh page has no ports by definition. On a PERSISTENT sandbox it is a race.
 * A resumed VM's ports are not transitions, so nothing fires for them; the provider REPLAYS them
 * (`replayOpenPorts`) with one sweep at registration and a second after the SDK's port state syncs —
 * and the mount path reads `previews.length` well before either has landed.
 *
 * Both wrong answers are silent and neither is cosmetic:
 *
 *   - Ports arrive LATE and we act on the empty list → a second `npm run dev` into a VM that already
 *     has one bound to 5173. The measured shape of that collision is "Port 5173 is already in use",
 *     with the new project served by the previous process (the T6-inverse defect, from the other side).
 *   - We never wait and the server really IS dead (hibernation killed the process, or the user killed
 *     it in a terminal) → the reload lands on a dead preview with nothing restarting it and no signal.
 *
 * So the wake path waits, briefly and boundedly, for the replay to settle before deciding. The wait is
 * a decision function of its own because the failure it prevents cannot be seen: a wrong bound produces
 * a project that looks fine and does not run, on somebody else's machine.
 */

/**
 * How long the wake path waits for the port replay before concluding nothing is listening.
 *
 * Sized from the provider's own replay schedule — a sweep at registration and a re-check at
 * `PORT_REPLAY_RECHECK_MS` (3s) — plus room for the round trip each sweep makes. A shorter window
 * expires between the two sweeps, which is the worst possible place to stop: exactly the case the
 * re-check exists to catch. Longer buys nothing; the second sweep is the last one there will be.
 */
export const PORT_SETTLE_TIMEOUT_MS = 5_000;

/** How often the window is re-checked. Short enough that a healthy resume costs ~one poll, not the window. */
export const PORT_SETTLE_POLL_MS = 250;

export interface PortSettleOptions {
  /** How many previews the store currently holds. Read fresh on every poll — that is the whole point. */
  runningPreviews: () => number;

  /** Injected so the decision is testable without real time passing. */
  wait: (ms: number) => Promise<void>;

  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Wait until a preview is registered, or the window expires.
 *
 * Returns whether a dev server is serving. `true` means "leave it alone"; `false` means "nothing is
 * listening — start one". Deliberately returns as soon as the answer is known, so the common case (a
 * resumed VM whose server is healthy) costs one poll rather than the full window.
 *
 * The elapsed clock is the SUM OF THE POLLS, never `Date.now()`: this runs on the mount path, where a
 * wall clock makes the bound untestable and — as migration 0003 records for the ledger — a clock that
 * ties or goes backwards decides something it has no business deciding.
 */
export async function awaitRunningPreview(options: PortSettleOptions): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? PORT_SETTLE_TIMEOUT_MS;
  const pollMs = Math.max(1, options.pollMs ?? PORT_SETTLE_POLL_MS);

  if (options.runningPreviews() > 0) {
    return true;
  }

  for (let elapsed = 0; elapsed < timeoutMs; elapsed += pollMs) {
    await options.wait(Math.min(pollMs, timeoutMs - elapsed));

    if (options.runningPreviews() > 0) {
      return true;
    }
  }

  return false;
}
