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
 * ## 🔴 A SEND FROM THE SAME TAB REPLACES THAT TAB'S OWN TURN (2026-09-30)
 *
 * *"the app builder project gets stuck in the BUILD state and whatever i enter give this error"* —
 * the 409 below, on every send, with no Stop button on screen to press. The lock refuses while the
 * holder's REQUEST is still connected, and a browser tab can leave one connected after it stopped
 * showing it: `useChat` keeps ONE abort controller, so a second request started from the same tab
 * (an automatic phase, retry or repair racing a send) overwrites the handle to the first, and from
 * then on nothing in the page can abort it. The screen reads idle, Stop does nothing, and the server
 * turn keeps the project until it finishes or the claim TTL passes. The error's own advice ("press
 * Stop") was unreachable.
 *
 * A tab can only show one turn at a time, so when the SAME tab sends again, it is not racing itself:
 * whatever it had in flight has been given up on. Each request carries the tab's id (`clientId`), and a
 * live claim from the same user and the same tab is SUPERSEDED — its generation is aborted exactly
 * as a Stop would abort it (billed for what it consumed, never refunded) and the new turn takes the
 * claim. The abort is what keeps the corruption guarantee: an aborted generation produces no further
 * file actions, which is the same reasoning the aborted-holder takeover already relies on.
 *
 * Everything else is still REFUSED: another tab, another user, or a request with no `clientId` (an
 * older bundle). Two tabs racing one project is the case this lock was written for, and the refusal
 * now says which case it is, so its advice points at the tab that can act on it.
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
 *
 * 🔴 This is NOT a limit on how long a build may run — nothing stops the turn when it passes. It is
 * how long the lock trusts a live, connected turn before another tab may start a second build beside
 * it, so it must be LONGER than the longest real turn or it re-opens the interleaved-writes corruption
 * this file exists to prevent. It was 15 minutes, written when a turn was one model call; a tool-loop
 * build turn is bounded only by credits and segments and can run for hours (owner, 2026-09-30: "we
 * will need at least a 2-3 hour max time"). The cost of a long value is small now: a disconnected
 * holder yields instantly (its signal aborts) and the same tab supersedes its own turn, so the TTL only
 * matters for a turn that hangs while its tab stays open AND a second tab wants the project.
 *
 * Config, `AGENT_CLAIM_TTL_MINUTES` — see `resolveClaimTtlMs`.
 */
export const DEFAULT_CLAIM_TTL_MINUTES = 180;

/** Below this a real build turn could outlive its own lock. */
export const MIN_CLAIM_TTL_MINUTES = 15;

/**
 * `AGENT_CLAIM_TTL_MINUTES` → milliseconds. Unset or unparseable → the default; below the floor → the
 * floor (a typo'd `1` must not hand a running build's project to a second tab after a minute).
 */
export function resolveClaimTtlMs(raw: string | undefined): number {
  const minutes = Number(raw);
  const chosen =
    raw === undefined || raw.trim() === '' || !Number.isFinite(minutes)
      ? DEFAULT_CLAIM_TTL_MINUTES
      : Math.max(minutes, MIN_CLAIM_TTL_MINUTES);

  return chosen * 60 * 1000;
}

const DEFAULT_CLAIM_TTL_MS = resolveClaimTtlMs(undefined);

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

  /** The browser tab that sent the claiming request (see "same tab" above). Absent from older bundles. */
  clientId?: string;

  /** Aborts the claiming generation. Called when a later send from the same tab supersedes it. */
  supersede?: () => void;

  /** How long this claim is trusted while live. Stored on the claim so the reader needs no config. */
  ttlMs: number;
}

const claims = new Map<string, Claim>();

/**
 * Is this claim still holding the project?
 *
 * ONE rule, read by both the writer (`claimProject`, which throws on a live claim) and the reader
 * (`isProjectClaimed`, which refuses an operation on one) — the `isSecretPath` discipline. Two private
 * copies of "is it live" is the shape this codebase keeps rediscovering: they agree on the day they
 * are written and drift the first time the TTL or the abort rule moves, and the two failure directions
 * are opposite and both silent (a reader that thinks a live claim is dead lets a branch switch replace
 * files under a running generation; one that thinks a dead claim is live strands the user behind a
 * wall nothing can clear).
 *
 * `now` is a parameter, not a `Date.now()` call, so a test can age a claim without a fake timer.
 */
function isClaimLive(claim: Claim, now: number): boolean {
  return !claim.signal?.aborted && now - claim.claimedAt < claim.ttlMs;
}

/**
 * Does a generation currently hold this project? A READ — it never claims and never evicts.
 *
 * Added for the tree-replacing git operations (§4.13a): a branch switch and a discard both overwrite
 * the whole working tree, which is exactly the interleaving this lock exists to prevent, but they are
 * not generations and must not take the lock to find out. They ask, and refuse themselves.
 *
 * 🔴 **IT MUST NOT MUTATE, and the tempting version does.** The obvious implementation deletes an
 * expired entry while it is there ("tidy up as you go"), and that silently changes `claimProject`'s
 * semantics: a takeover of a stale claim is a WARN-logged event that says something failed to release
 * its `finally`, and a reader that swept the corpse first turns that signal off — the takeover looks
 * like an ordinary claim and the leak it was reporting becomes invisible. Worse, this runs on a
 * REFUSAL path, and a refusal with a side effect is a refusal that behaves differently depending on
 * how many times the user pressed the button.
 */
export function isProjectClaimed(projectId: string): boolean {
  const claim = claims.get(projectId);

  return claim !== undefined && isClaimLive(claim, Date.now());
}

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
    super(
      'This project is already building in another tab or window. Wait for it to finish, or press Stop there, before starting another change.',
    );
    this.name = 'GenerationInFlightError';
  }
}

/** Who is asking, beyond the user: which tab, and how to stop this generation if that tab replaces it. */
export interface ClaimOptions {
  /** The sending tab's id. Only a claim from the same user AND the same tab can be superseded. */
  clientId?: string;

  /** Aborts THIS generation. Stored on the claim and called if a later send from the same tab supersedes it. */
  supersede?: () => void;

  /** From `resolveClaimTtlMs(AGENT_CLAIM_TTL_MINUTES)`. Absent → the default. */
  ttlMs?: number;
}

/**
 * Is `existing` a claim the incoming request may supersede rather than be refused by?
 *
 * Both ids must be present and equal: a request with no `clientId` is an older bundle that cannot say
 * which tab it came from, and guessing "same tab" there would let a second tab kill a live build.
 */
function isSameTab(existing: Claim, userId: string, clientId: string | undefined): boolean {
  return Boolean(clientId) && existing.clientId === clientId && existing.userId === userId;
}

/**
 * Claim the project for this generation, or throw if someone already holds it.
 *
 * Returns a release function. Call it in a `finally` — never on the success path only, or a failed
 * generation locks the project until the TTL expires.
 */
export function claimProject(
  projectId: string,
  userId: string,
  signal?: AbortSignal,
  options: ClaimOptions = {},
): () => void {
  const existing = claims.get(projectId);

  if (existing) {
    const now = Date.now();
    const age = now - existing.claimedAt;

    if (existing.signal?.aborted) {
      /*
       * The holder was STOPPED (or its tab closed) — its provider call is aborted and no further file
       * actions can come out of it; only its settlement tail is still unwinding. Refusing here made
       * the error's own advice ("press Stop, before starting another change") false.
       */
      logger.info(`In-flight claim on project ${projectId} was aborted — taking it over`);
    } else if (isClaimLive(existing, now)) {
      if (!isSameTab(existing, userId, options.clientId)) {
        /* Not aborted (the branch above), inside the TTL, another tab — a live generation owns the tree. */
        throw new GenerationInFlightError();
      }

      /*
       * The same tab is sending again, so it has given up on the turn it had in flight (see "same tab"
       * in the header). Abort that generation the way a Stop would and take the project over.
       */
      logger.info(`In-flight claim on project ${projectId} superseded by a new send from the same tab`);
      existing.supersede?.();
    } else {
      /*
       * Stale. Something failed to release — that is a bug worth seeing in the logs, but the user's
       * project must not stay locked because of it.
       */
      logger.warn(`Stale in-flight claim on project ${projectId} (${Math.round(age / 1000)}s old) — taking it over`);
    }
  }

  const claim: Claim = {
    userId,
    claimedAt: Date.now(),
    signal,
    clientId: options.clientId,
    supersede: options.supersede,
    ttlMs: options.ttlMs ?? DEFAULT_CLAIM_TTL_MS,
  };
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
