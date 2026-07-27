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
