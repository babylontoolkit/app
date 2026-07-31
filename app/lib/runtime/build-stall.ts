/**
 * When has a build stopped being a build and become a hang? (Found live 2026-07-31.)
 *
 * `#runBuildAction` awaits `process.exit` with no bound at all. On the CodeSandbox provider a
 * background command can be created and then never run — MEASURED: `spawn('echo', ['hi'])` on a
 * freshly-resumed VM produced no output and had not exited after 20s, while the same call on a warm
 * VM exits in ~230ms. With no timeout that await never settles, and the damage is NOT limited to the
 * one press:
 *
 *   1. Share sits on "Building & publishing…" forever — no error, no log, nothing to retry.
 *   2. The build action is left `running`, so `decidePublishReadiness` refuses EVERY later Share and
 *      Deploy for the rest of the session with "your latest changes are still being written" — a
 *      message about the user's files, describing a dead command they cannot see. One hang therefore
 *      reads as "publishing is broken", which is exactly how it was reported.
 *
 * So the timeout is not politeness: it is what converts an invisible permanent failure into one
 * failed action the user can retry. A throw marks the action `failed`, which is what unblocks (2).
 *
 * The rule is SILENCE, not duration — a build that is printing is working, however long it takes, and
 * a fixed wall-clock cap would kill a large honest build (this project's own vite build emits chunk
 * lines throughout and takes ~8.5s, but a cold install-and-build is minutes). Pure so it can be
 * tested without waiting two minutes for a real one.
 */

/** How long a build may emit NOTHING before it is treated as hung. */
export const BUILD_STALL_TIMEOUT_MS = 120_000;

/** How often the waiter re-checks. Small enough to be responsive, large enough to be free. */
export const BUILD_STALL_POLL_MS = 5_000;

/**
 * User-facing, and deliberately not "the project failed to build" — nothing about the project is
 * wrong, and sending the user to the editor to hunt for a compile error they do not have is worse
 * than saying nothing.
 */
export const BUILD_STALL_MESSAGE =
  'The build stopped responding — your sandbox went quiet for two minutes. Nothing is wrong with your project; wait a moment and try again.';

export function isBuildStalled(nowMs: number, lastOutputAtMs: number, timeoutMs = BUILD_STALL_TIMEOUT_MS): boolean {
  return nowMs - lastOutputAtMs >= timeoutMs;
}
