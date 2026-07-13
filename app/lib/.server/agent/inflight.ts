/**
 * One in-flight generation per project (SPEC §4.12).
 *
 * Two generations against the same project interleave their file actions, and the working tree ends
 * up a mix of two different ideas — a corruption the user cannot see, cannot undo, and will report as
 * "it broke my game". So the second one is REFUSED, with a friendly message, rather than queued:
 * queueing hides the fact that the user is about to spend credits twice on a race they did not intend
 * (two tabs, or a double-clicked send).
 *
 * The claim is released in the proxy's `finally`, so a crash, a Stop, or a closed tab all free it —
 * the same place settlement happens, for the same reason.
 *
 * ## Scope, honestly
 *
 * This is a per-PROCESS lock (a `Map` in memory). It is correct for a single server, and it is what we
 * run. Across several instances behind a load balancer, two requests could land on different processes
 * and both pass. That is a real limit, and the fix when we get there is an advisory lock in Postgres —
 * the same mechanism `append_ledger_entry` already uses — keyed on the project id. It is NOT worth
 * building before there is a second instance, but it must not be forgotten when there is: the failure
 * is silent tree corruption, not an error.
 */
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('agent-inflight');

/**
 * A generation that never released its claim (a hung provider call, a lost `finally`) must not lock a
 * project forever — that would brick the project with no way for the user to recover. A claim older
 * than this is treated as dead.
 */
const CLAIM_TTL_MS = 15 * 60 * 1000;

interface Claim {
  userId: string;
  claimedAt: number;
}

const claims = new Map<string, Claim>();

export class GenerationInFlightError extends Error {
  readonly statusCode = 409;
  readonly isRetryable = true;

  constructor() {
    super('This project is already building. Wait for it to finish, or press Stop, before starting another change.');
    this.name = 'GenerationInFlightError';
  }
}

/**
 * Claim the project for this generation, or throw if someone already holds it.
 *
 * Returns a release function. Call it in a `finally` — never on the success path only, or a failed
 * generation locks the project until the TTL expires.
 */
export function claimProject(projectId: string, userId: string): () => void {
  const existing = claims.get(projectId);

  if (existing) {
    const age = Date.now() - existing.claimedAt;

    if (age < CLAIM_TTL_MS) {
      throw new GenerationInFlightError();
    }

    /*
     * Stale. Something failed to release — that is a bug worth seeing in the logs, but the user's
     * project must not stay locked because of it.
     */
    logger.warn(`Stale in-flight claim on project ${projectId} (${Math.round(age / 1000)}s old) — taking it over`);
  }

  const claim: Claim = { userId, claimedAt: Date.now() };
  claims.set(projectId, claim);

  let released = false;

  return () => {
    if (released) {
      return;
    }

    released = true;

    /*
     * Only clear OUR claim. If a stale takeover happened, the map now holds someone else's claim and
     * deleting it blindly would hand the project to a third generation while the second still runs.
     */
    if (claims.get(projectId) === claim) {
      claims.delete(projectId);
    }
  };
}

/** Test seam. */
export function _resetClaims(): void {
  claims.clear();
}
