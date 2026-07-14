/**
 * Self-healing: should the build error we are looking at trigger an automatic repair turn? (§4.2.7)
 *
 * This is a pure function on purpose. It decides whether to **spend the user's credits without them
 * asking for anything** — which is the most consequential decision the client makes — and that belongs
 * somewhere it can be tested exhaustively, not buried in a `useEffect` where every branch is reachable
 * only by driving a browser.
 *
 * The server has always been able to run a repair turn (it folds the compiler output into the prompt,
 * caps attempts at `MAX_REPAIR_TURNS`, and escalates the thinking effort: repair → `high`, second
 * repair → `xhigh`). Nothing ever triggered it, because the client never sent `errors` / `repairOf` /
 * `repairAttempt`. A generation that produced code which did not compile simply left the user staring
 * at a red box. This is the missing half.
 */
import type { ActionAlert } from '~/types/actions';

/** Mirrors the server's `MAX_REPAIR_TURNS`. The server enforces it regardless of what we send. */
export const MAX_CLIENT_REPAIRS = 2;

/**
 * How long after a generation finishes we still consider a build error to be *ours*.
 *
 * Vite recompiles a moment AFTER the last file action lands, so the error arrives shortly after the
 * stream ends rather than during it. Too short and we miss the error we caused; too long and we start
 * "repairing" breakage the user introduced themselves — and billing them for the privilege.
 */
export const REPAIR_WINDOW_MS = 8000;

export interface RepairWatch {
  /** The generation whose output we are watching. A repair must NAME what it repairs. */
  generationId: string;

  /** Which repair attempt produced the generation being watched. 0 = an ordinary turn. */
  attempt: number;

  /** Epoch ms after which this error is no longer attributable to that generation. */
  until: number;
}

export type RepairDecision =
  | { repair: false; disarm: boolean }
  | { repair: true; repairOf: string; repairAttempt: number; errors: string[] };

/**
 * Every `repair: false` branch here is a way the agent could otherwise have spent money the user never
 * authorised. They are the point of the function, not edge cases around it.
 */
export function decideAutoRepair(input: {
  alert: ActionAlert | null | undefined;
  watch: RepairWatch | null;
  isLoading: boolean;
  now: number;
}): RepairDecision {
  const { alert, watch, isLoading, now } = input;

  // Nothing to react to, nothing armed, or a generation is already running.
  if (!alert || !watch || isLoading) {
    return { repair: false, disarm: false };
  }

  /*
   * ONLY a preview (Vite compile) error. A terminal error is usually the user's own command — repairing
   * it uninvited is both presumptuous and billable.
   */
  if (alert.source !== 'preview') {
    return { repair: false, disarm: false };
  }

  // Outside the window: this break is not attributable to the generation we were watching.
  if (now > watch.until) {
    return { repair: false, disarm: true };
  }

  /*
   * Out of attempts. Two failed repairs means the agent is thrashing, not fixing, and a third turn
   * spends the user's credits to watch it thrash again. Disarm and leave the alert up — the user still
   * has the manual "Fix this error" button, which is *their* decision to spend.
   */
  if (watch.attempt >= MAX_CLIENT_REPAIRS) {
    return { repair: false, disarm: true };
  }

  const errors = [alert.description, alert.content].filter((part): part is string => Boolean(part));

  if (errors.length === 0) {
    // An error with no text tells the model nothing; a repair turn on it is a guaranteed waste.
    return { repair: false, disarm: true };
  }

  return {
    repair: true,
    repairOf: watch.generationId,
    repairAttempt: watch.attempt + 1,
    errors,
  };
}

/** The visible message. The compiler output rides in the request body, never pasted into the chat. */
export function repairMessage(attempt: number): string {
  return attempt === 1
    ? 'The build failed. Fix the errors below and nothing else.'
    : 'That did not fix it. The build is still failing — fix the errors below and nothing else.';
}
