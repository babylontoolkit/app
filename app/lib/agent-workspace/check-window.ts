/**
 * "The agent's game check is driving the preview right now" (tool-loop plan T9 fix loop).
 *
 * `check_game` navigates the preview `/` → `/play` → back to where it was. Tearing a running game
 * down mid-frame can throw from the runtime (found live: `Cannot read properties of null (reading
 * 'focus')` while "Checking your game…" was on screen — the project's own code has no `.focus(` call
 * at all). Those errors belong in the CHECK RESULT, which already collects them from the preview
 * error store. Raised as a `source:'preview'` alert they are worse than noise: the alert offers a paid
 * "Ask" button and `decideAutoRepair` fires on it, so the platform's own navigation could spend the
 * user's credits on a repair turn nobody asked for.
 *
 * A depth counter (checks may overlap) plus a short grace after the last one ends, because an error
 * thrown while the page unloads can be REPORTED a moment after the navigation promise resolves.
 * Errors outside the window are untouched.
 */
export const CHECK_WINDOW_GRACE_MS = 1_500;

let depth = 0;
let lastEndedAt = 0;

export function beginWorkspaceCheck(): void {
  depth += 1;
}

export function endWorkspaceCheck(now: number = Date.now()): void {
  depth = Math.max(0, depth - 1);

  if (depth === 0) {
    lastEndedAt = now;
  }
}

export function isWorkspaceCheckInProgress(): boolean {
  return depth > 0;
}

/** Should a preview error that happened at `at` stay out of the user-facing alert? */
export function suppressesPreviewAlert(at: number): boolean {
  return (
    depth > 0 ||
    (lastEndedAt > 0 && at >= lastEndedAt - CHECK_WINDOW_GRACE_MS && at <= lastEndedAt + CHECK_WINDOW_GRACE_MS)
  );
}

/** Test seam — module state survives between specs. */
export function resetWorkspaceCheckWindow(): void {
  depth = 0;
  lastEndedAt = 0;
}
