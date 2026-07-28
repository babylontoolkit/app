/**
 * "Create a new sandbox, or resume the one this project already has?" (SPEC §8,
 * `spec/sandbox-codesandbox.md`).
 *
 * Pure and exhaustively tested, for the same reason `auto-repair.ts` and `restore-target.ts` are:
 * **both wrong answers are silent, and one of them destroys the user's game.**
 *
 *   - Creating when we should have resumed hands the user a FRESH TEMPLATE in place of their
 *     project. Nothing throws — the sandbox boots perfectly, the dev server starts, and the game
 *     they spent credits building is simply not in it. The old VM also leaks, billing until its
 *     idle timeout.
 *   - Resuming when we should have created fails loudly and recoverably: the id 404s, and we can
 *     fall back to creating.
 *
 * The asymmetry decides the bias: **never create while a sandbox id exists**, unless the caller has
 * positively established that the id is unusable. "I could not reach CodeSandbox to ask" is not
 * that establishment — it is `undefined`, and it means do nothing, which is the same
 * `null`-vs-`undefined` distinction `mount-source.ts` draws between "the branch is empty" and "I
 * could not ask". Collapsing the two is how a flaky connection gets to overwrite a project.
 */

export interface SandboxStartFacts {
  /** The sandbox id recorded on the project, if it has ever had one. */
  recordedSandboxId?: string;

  /**
   * Does that sandbox still exist at the provider?
   *
   * `true` = confirmed present. `false` = confirmed GONE (a definitive 404). `undefined` = **we
   * could not find out** — a network error, a timeout, a 500. The third case is the whole reason
   * this is a tri-state and not a boolean.
   */
  existsAtProvider?: boolean;

  /**
   * The user explicitly asked for a clean environment (a "reset sandbox" affordance).
   *
   * Only ever set from a deliberate user action. It is the one input allowed to discard a working
   * sandbox, which is why it is named for the intent rather than being folded into the flags above.
   */
  resetRequested?: boolean;
}

export type SandboxStartDecision =
  | { action: 'create'; reason: 'no-sandbox-yet' | 'sandbox-gone' | 'reset-requested' }
  | { action: 'resume'; reason: 'has-sandbox' }
  | { action: 'refuse'; reason: 'existence-unknown' };

/**
 * Decide how to bring a project's sandbox up.
 *
 * Note the order: `resetRequested` is checked FIRST, because it is the only input that expresses an
 * intent rather than a fact, and a user asking for a clean environment should get one whether or not
 * the old sandbox is reachable.
 */
export function decideSandboxStart(facts: SandboxStartFacts): SandboxStartDecision {
  if (facts.resetRequested) {
    return { action: 'create', reason: 'reset-requested' };
  }

  if (!facts.recordedSandboxId) {
    return { action: 'create', reason: 'no-sandbox-yet' };
  }

  if (facts.existsAtProvider === false) {
    /*
     * Confirmed gone. Creating is correct AND unavoidable — but note what has already been lost: the
     * files were in that VM. §4.5.4c's working copy is what refills the new one, which is why that
     * copy stops being a nicety the moment this provider ships.
     */
    return { action: 'create', reason: 'sandbox-gone' };
  }

  if (facts.existsAtProvider === undefined) {
    /*
     * 🔴 The case this whole module exists for. We hold an id and cannot confirm anything about it.
     * Creating would abandon a sandbox that is probably fine and replace the user's project with a
     * template; resuming would likely fail anyway. Refusing surfaces a retryable error and touches
     * nothing — the "when in doubt, do nothing" bias the restore path takes.
     */
    return { action: 'refuse', reason: 'existence-unknown' };
  }

  return { action: 'resume', reason: 'has-sandbox' };
}

/**
 * Is this decision safe to act on without the user having asked?
 *
 * A `create` that follows `sandbox-gone` replaces what the user was looking at. Callers use this to
 * decide whether to just do it or to say so first — the §4.13 posture: when the platform cannot be
 * sure, it tells the user rather than silently picking.
 */
export function isDestructive(decision: SandboxStartDecision): boolean {
  return decision.action === 'create' && decision.reason === 'sandbox-gone';
}

export interface CreatePersistFacts {
  /** The sandbox id on the project row when THIS request decided to create. `undefined` = none yet. */
  before?: string;

  /** The sandbox this request just forked. Always present — we only ask after creating. */
  created: string;

  /** The sandbox id on the row NOW, re-read after the fork. The other half of the compare-and-set. */
  current?: string;

  /** The create came from a deliberate reset, so `before` is meant to stop existing. */
  resetRequested?: boolean;
}

export interface CreatePersistDecision {
  /** The sandbox this request should actually connect the caller to. */
  canonicalSandboxId: string;

  /** Whether to write `created` onto the project row. False means someone else's write stands. */
  persist: boolean;

  /** Sandboxes to destroy, best-effort. Never contains `canonicalSandboxId`. */
  dispose: string[];
}

/**
 * Compare-and-set for "which VM does this project actually have?" — the race the per-user registry
 * used to hide (`spec/sandbox-codesandbox.md` §11 M1).
 *
 * Two tabs opening one project both read `sandboxId` unset, both fork a template, and both write.
 * Last write wins, and the LOSER is a running VM billing by the second that nothing can name again —
 * with a live write session pointed at it, so the user can be typing into a filesystem that no longer
 * belongs to their project. Nothing throws; the symptom is a bill and, later, work that vanished.
 *
 * Pure because both wrong answers are silent and one of them costs money forever, which is the same
 * reason `decideSandboxStart` above is pure.
 *
 * 🔴 The comparison is against `before`, NEVER simply "is there an id on the row now". A reset leaves
 * the OLD id on the row until we overwrite it, so a naive `current !== created → we lost` reading
 * would discard the fresh VM on every reset and reconnect the user to the sandbox they just asked to
 * throw away.
 */
export function decideCreatePersist(facts: CreatePersistFacts): CreatePersistDecision {
  const lostRace = Boolean(facts.current && facts.current !== facts.before && facts.current !== facts.created);

  if (lostRace) {
    /*
     * Another request recorded a different sandbox while we were forking. Theirs is canonical — it is
     * the one the row names, and other tabs are already connecting to it. Ours has to go, or it bills
     * until its idle timeout and then sits there as an orphan.
     */
    return { canonicalSandboxId: facts.current!, persist: false, dispose: [facts.created] };
  }

  return {
    canonicalSandboxId: facts.created,
    persist: true,

    /*
     * A reset is the ONE case where the previous VM is deliberately abandoned, so it is the one case
     * that must destroy it. A `sandbox-gone` create must not: that id is already 404 at the provider,
     * and asking to delete it would only generate noise.
     */
    dispose: facts.resetRequested && facts.before && facts.before !== facts.created ? [facts.before] : [],
  };
}

/**
 * Does this error mean the sandbox is CONFIRMED gone, rather than "we could not ask"?
 *
 * The distinction is the whole point of `decideSandboxStart`'s tri-state, so the classifier deserves
 * the same care: a false positive here re-creates a project from the template while the real VM sits
 * there holding the user's game.
 *
 * Typed/status evidence FIRST, message text last. A 404 from the SDK is a fact; a message matching
 * `/not found/i` is a guess that a reworded provider error, a localized message, or an unrelated
 * "template not found" can all satisfy. The regex stays only as a last-resort fallback because the
 * SDK does not document a stable error type, and losing the classification entirely would brick a
 * project whose VM was deleted into a permanent 503.
 */
export function isSandboxGoneError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    response?: { status?: unknown };
    message?: unknown;
  };

  const statuses = [candidate.status, candidate.statusCode, candidate.response?.status];

  if (statuses.some((status) => status === 404 || status === '404')) {
    return true;
  }

  if (typeof candidate.code === 'string' && /^(not_found|notfound|enoent)$/i.test(candidate.code)) {
    return true;
  }

  /*
   * 🔴 Any OTHER status is a veto, not an invitation to guess. The error carried typed evidence and
   * that evidence was not 404 — a 403 ("Sandbox not found or you lack access"), a 401, a 429 whose
   * text mentions a 404, a 500. Every one of those means "could not ask", which upstream must keep as
   * `undefined`.
   *
   * Reading the message anyway is the failure this whole module exists to prevent: `sandboxExists`
   * would answer `false` = CONFIRMED GONE, `decideSandboxStart` would say `create`, and the user's
   * project would be replaced by a fresh template while their real VM keeps running and billing.
   * "Last resort" has to mean *no typed evidence at all*, not *no typed evidence I recognised*.
   */
  if (statuses.some((status) => status !== undefined && status !== null)) {
    return false;
  }

  return typeof candidate.message === 'string' && /not found|404|does not exist/i.test(candidate.message);
}
