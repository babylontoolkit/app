/**
 * One in-flight BUILD generation per project (SPEC §4.12).
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
 * ## 🔴 A PLAN TURN IS NEITHER A HOLDER NOR A VICTIM (owner, 2026-08-09)
 *
 * *"I am getting stuck here too often… I am not in build mode and don't ever hold me because it
 * thinks I am."* The lock was taken for EVERY generation that named a project, so Plan mode — which
 * exists precisely to think about a project without touching it — both claimed the lock and was
 * refused by it, and the refusal said *"this project is already building"* to a user who had
 * deliberately switched building off.
 *
 * The scope was wrong, not the mechanism. Read the paragraph this file opens with: the thing being
 * prevented is **interleaved file actions in the game tree**, and a Plan turn cannot produce one.
 * It is read-only by three independent guarantees (§4.2.9), not by instruction — `toolset:
 * 'skills-only'` (no media, no MCP writes), the server-written `NO_REPLAY` mark that routes the whole
 * message through the render-only parser so a disobedient `<boltAction>` displays but never runs, and
 * `_specs/**` as the single write door. So `shouldClaimProject` scopes the lock to build turns, which
 * fixes both directions at once: a Plan turn takes no claim, so it cannot block the build that
 * follows it, and it makes no claim request, so a build in flight cannot refuse it.
 *
 * The honest residual: two Plan turns racing can both write the same `_specs/<x>_plan.md`, last write
 * wins. That is a document, it is visible in the editor, and re-running the plan fixes it — not the
 * silent, unrecoverable tree corruption this lock is here for. Trading it for a user who cannot get
 * stuck is the right side of that bargain.
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

  /**
   * The claiming REQUEST's abort signal. A claim whose own request has been aborted (Stop, a closed
   * tab) must never refuse a new send: the model can produce no further file actions once the signal
   * fires, and the release in the stream's `finally` can lag the abort by however long settlement and
   * the provider tail take — during which "press Stop, then send again" (exactly what the error copy
   * tells the user to do) was bouncing off the corpse of the generation they had already stopped.
   */
  signal?: AbortSignal;
}

const claims = new Map<string, Claim>();

/** What the claim decision needs to know about a request. */
export interface ClaimDecisionInput {
  /** The project this generation names, if any. A generation with no project locks nothing. */
  projectId?: string;

  /** The turn's mode. `'discuss'` is Plan mode (§4.2.9) — read-only, so it stays out of the lock. */
  chatMode?: 'discuss' | 'build';
}

/**
 * Does this generation participate in the one-build-at-a-time lock?
 *
 * Pure and exported so the rule is testable and lives in ONE place: the answer decides both whether
 * this turn can be REFUSED and whether it can refuse the next one, and getting it wrong in either
 * direction is invisible — too narrow silently re-opens the interleaved-writes corruption, too broad
 * silently strands the user behind a wall the error message cannot explain.
 *
 * Anything that is not explicitly Plan mode claims. That default is the safe direction: an older
 * client, a missing field, or a value nobody recognised is treated as a build, so a turn that might
 * write files is never quietly let past the lock.
 */
export function shouldClaimProject(input: ClaimDecisionInput): boolean {
  if (!input.projectId) {
    return false;
  }

  return input.chatMode !== 'discuss';
}

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
export function claimProject(projectId: string, userId: string, signal?: AbortSignal): () => void {
  const existing = claims.get(projectId);

  if (existing) {
    const age = Date.now() - existing.claimedAt;

    if (existing.signal?.aborted) {
      /*
       * The holder was STOPPED (or its tab closed) — its provider call is aborted and no further file
       * actions can come out of it; only its settlement tail is still unwinding. Refusing here made
       * the error's own advice ("press Stop, before starting another change") false.
       */
      logger.info(`In-flight claim on project ${projectId} was aborted — taking it over`);
    } else if (age < CLAIM_TTL_MS) {
      throw new GenerationInFlightError();
    } else {
      /*
       * Stale. Something failed to release — that is a bug worth seeing in the logs, but the user's
       * project must not stay locked because of it.
       */
      logger.warn(`Stale in-flight claim on project ${projectId} (${Math.round(age / 1000)}s old) — taking it over`);
    }
  }

  const claim: Claim = { userId, claimedAt: Date.now(), signal };
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
