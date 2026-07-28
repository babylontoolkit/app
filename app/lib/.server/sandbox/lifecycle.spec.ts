/**
 * "Create or resume?" is a decision that can destroy a user's game silently (SPEC §8).
 *
 * Exhaustive, in the shape of `auto-repair.spec.ts` and `restore-target.spec.ts`, because the wrong
 * answer here does not throw: creating when we should have resumed boots a perfect, working sandbox
 * containing a FRESH TEMPLATE instead of the project the user spent credits on, and abandons the old
 * VM to bill until its idle timeout.
 */
import { describe, expect, it } from 'vitest';
import { decideCreatePersist, decideSandboxStart, isDestructive, isSandboxGoneError } from './lifecycle';

describe('decideSandboxStart', () => {
  it('creates when the project has never had a sandbox', () => {
    expect(decideSandboxStart({})).toEqual({ action: 'create', reason: 'no-sandbox-yet' });
  });

  it('resumes when the sandbox is confirmed present', () => {
    expect(decideSandboxStart({ recordedSandboxId: 'abc123', existsAtProvider: true })).toEqual({
      action: 'resume',
      reason: 'has-sandbox',
    });
  });

  it('creates when the sandbox is confirmed GONE', () => {
    expect(decideSandboxStart({ recordedSandboxId: 'abc123', existsAtProvider: false })).toEqual({
      action: 'create',
      reason: 'sandbox-gone',
    });
  });

  it('🔴 REFUSES when it could not find out whether the sandbox exists', () => {
    /*
     * The case the whole module exists for. `undefined` is "the network failed", NOT "it is gone".
     * Collapsing the two lets a blip replace someone's project with a template — the same
     * `null`-vs-`undefined` distinction `mount-source.ts` draws to stop a flaky connection deciding
     * the browser is authoritative.
     */
    expect(decideSandboxStart({ recordedSandboxId: 'abc123' })).toEqual({
      action: 'refuse',
      reason: 'existence-unknown',
    });
    expect(decideSandboxStart({ recordedSandboxId: 'abc123', existsAtProvider: undefined })).toEqual({
      action: 'refuse',
      reason: 'existence-unknown',
    });
  });

  it('honours an explicit reset even when the sandbox is alive and reachable', () => {
    expect(decideSandboxStart({ recordedSandboxId: 'abc123', existsAtProvider: true, resetRequested: true })).toEqual({
      action: 'create',
      reason: 'reset-requested',
    });
  });

  it('honours an explicit reset even when existence is unknown', () => {
    // Intent outranks facts: a user asking for a clean environment gets one regardless.
    expect(decideSandboxStart({ recordedSandboxId: 'abc123', resetRequested: true })).toEqual({
      action: 'create',
      reason: 'reset-requested',
    });
  });

  it('never resumes without a recorded id, whatever else is true', () => {
    /*
     * Property rather than an example: there is nothing to resume without an id, and a `resume`
     * here would call the provider with `undefined` and fail in a way that reads as an outage.
     */
    for (const existsAtProvider of [true, false, undefined]) {
      for (const resetRequested of [true, false, undefined]) {
        expect(decideSandboxStart({ existsAtProvider, resetRequested }).action).not.toBe('resume');
      }
    }
  });

  it('never creates while a sandbox is confirmed alive unless a reset was asked for', () => {
    // The expensive mistake, stated as a property: a live sandbox is never discarded by accident.
    expect(decideSandboxStart({ recordedSandboxId: 'x', existsAtProvider: true }).action).toBe('resume');
  });
});

describe('isDestructive', () => {
  it('flags only the create that replaces an existing project', () => {
    expect(isDestructive({ action: 'create', reason: 'sandbox-gone' })).toBe(true);
  });

  it('does not flag a first-ever create, which overwrites nothing', () => {
    expect(isDestructive({ action: 'create', reason: 'no-sandbox-yet' })).toBe(false);
  });

  it('does not flag a reset the user explicitly asked for', () => {
    expect(isDestructive({ action: 'create', reason: 'reset-requested' })).toBe(false);
  });

  it('does not flag resume or refuse', () => {
    expect(isDestructive({ action: 'resume', reason: 'has-sandbox' })).toBe(false);
    expect(isDestructive({ action: 'refuse', reason: 'existence-unknown' })).toBe(false);
  });
});

/**
 * The compare-and-set that decides which VM a project actually has.
 *
 * Both wrong answers are silent and both cost money forever: keeping the loser of a race leaves a
 * running VM that nothing can name again (a bill with no owner and a live write session pointed at
 * it), and misreading a reset as a lost race throws away the fresh VM and reconnects the user to the
 * sandbox they just asked to destroy.
 */
describe('decideCreatePersist', () => {
  it('persists the first-ever sandbox and disposes nothing', () => {
    expect(decideCreatePersist({ created: 'sb-new', current: undefined })).toEqual({
      canonicalSandboxId: 'sb-new',
      persist: true,
      dispose: [],
    });
  });

  it('persists when the row still holds exactly what we read before forking', () => {
    /* Nobody wrote underneath us — the `sandbox-gone` re-create shape. */
    expect(decideCreatePersist({ before: 'sb-dead', created: 'sb-new', current: 'sb-dead' })).toEqual({
      canonicalSandboxId: 'sb-new',
      persist: true,

      /*
       * Deliberately empty: `sb-dead` is already 404 at the provider, so asking to delete it would
       * only generate noise. Only a RESET disposes the predecessor.
       */
      dispose: [],
    });
  });

  it('persists when the row already names what we just created — an idempotent re-read', () => {
    expect(decideCreatePersist({ created: 'sb-new', current: 'sb-new' })).toEqual({
      canonicalSandboxId: 'sb-new',
      persist: true,
      dispose: [],
    });
  });

  it('🔴 loses the race to a concurrent writer and DISPOSES its own fork', () => {
    /*
     * Two tabs opened the project, both read no sandbox, both forked. Theirs is on the row and other
     * tabs are already connecting to it, so ours has to go — an orphan bills by the second and is
     * invisible in every panel we have.
     */
    expect(decideCreatePersist({ before: undefined, created: 'sb-mine', current: 'sb-theirs' })).toEqual({
      canonicalSandboxId: 'sb-theirs',
      persist: false,
      dispose: ['sb-mine'],
    });
  });

  it('loses the race even when the project already had a sandbox before', () => {
    expect(decideCreatePersist({ before: 'sb-old', created: 'sb-mine', current: 'sb-theirs' })).toEqual({
      canonicalSandboxId: 'sb-theirs',
      persist: false,
      dispose: ['sb-mine'],
    });
  });

  it('🔴 a RESET whose row is unchanged persists the NEW id and disposes the OLD one', () => {
    /*
     * The trap this function's doc comment names. A reset leaves the old id on the row until we
     * overwrite it, so a naive "current !== created → we lost" reading would discard the fresh VM on
     * every reset and hand the user back the sandbox they asked to throw away.
     */
    expect(
      decideCreatePersist({ before: 'sb-old', created: 'sb-new', current: 'sb-old', resetRequested: true }),
    ).toEqual({
      canonicalSandboxId: 'sb-new',
      persist: true,
      dispose: ['sb-old'],
    });
  });

  it('a reset on a project with no previous sandbox disposes nothing', () => {
    expect(decideCreatePersist({ created: 'sb-new', current: undefined, resetRequested: true })).toEqual({
      canonicalSandboxId: 'sb-new',
      persist: true,
      dispose: [],
    });
  });

  it('a reset that LOSES a race disposes its own fork, never the winner', () => {
    const decision = decideCreatePersist({
      before: 'sb-old',
      created: 'sb-mine',
      current: 'sb-theirs',
      resetRequested: true,
    });

    expect(decision).toEqual({ canonicalSandboxId: 'sb-theirs', persist: false, dispose: ['sb-mine'] });
  });

  it('never disposes the sandbox it just told the caller to use', () => {
    /* Property, not an example: disposing the canonical id hands the caller a VM being deleted. */
    const inputs = [undefined, 'sb-old', 'sb-new'];

    for (const before of inputs) {
      for (const current of inputs) {
        for (const resetRequested of [true, false]) {
          const decision = decideCreatePersist({ before, created: 'sb-new', current, resetRequested });
          expect(decision.dispose).not.toContain(decision.canonicalSandboxId);
        }
      }
    }
  });
});

/**
 * "Is it CONFIRMED gone?" — a false positive here re-creates a project from the template while the
 * real VM sits there holding the user's game, so typed evidence outranks message text and a 5xx is
 * never an answer.
 */
describe('isSandboxGoneError', () => {
  it('reads a 404 status off the error', () => {
    expect(isSandboxGoneError({ status: 404 })).toBe(true);
    expect(isSandboxGoneError({ statusCode: 404 })).toBe(true);
    expect(isSandboxGoneError({ response: { status: 404 } })).toBe(true);
    expect(isSandboxGoneError({ status: '404' })).toBe(true);
  });

  it('reads a not-found code', () => {
    expect(isSandboxGoneError({ code: 'not_found' })).toBe(true);
    expect(isSandboxGoneError({ code: 'NotFound' })).toBe(true);
    expect(isSandboxGoneError({ code: 'ENOENT' })).toBe(true);
  });

  it('🔴 a 5xx is NOT gone — it is "could not ask"', () => {
    /*
     * The whole tri-state depends on this: a provider outage answering "gone" would let a blip
     * replace a live project with a fresh template, and nothing would throw.
     */
    expect(isSandboxGoneError({ status: 500 })).toBe(false);
    expect(isSandboxGoneError({ status: 503, message: 'sandbox not found' })).toBe(false);
    expect(isSandboxGoneError({ response: { status: 502 }, message: '404 upstream' })).toBe(false);
  });

  it('does not treat other client errors as gone', () => {
    expect(isSandboxGoneError({ status: 401 })).toBe(false);
    expect(isSandboxGoneError({ status: 403 })).toBe(false);
    expect(isSandboxGoneError({ status: 429 })).toBe(false);
  });

  it('lets a typed non-404 status VETO a message that reads like a 404', () => {
    /*
     * 🔴 The shape a real SDK error actually has: a status AND a message. The original test above
     * passed only because it omitted the message, so the regex was never reached — and the regex was
     * winning. A 403 saying "not found or you lack access" is the provider being deliberately vague
     * about someone else's resource; reading it as CONFIRMED GONE makes `sandboxExists` answer
     * `false`, `decideSandboxStart` answer `create`, and the user's project get replaced by a fresh
     * template while their real VM keeps running. "Last resort" means no typed evidence AT ALL.
     */
    expect(isSandboxGoneError({ status: 403, message: 'Sandbox not found or you lack access' })).toBe(false);
    expect(isSandboxGoneError({ status: 401, message: 'not found' })).toBe(false);
    expect(isSandboxGoneError({ status: 429, message: 'rate limited (last 404 seen)' })).toBe(false);
    expect(isSandboxGoneError({ statusCode: 500, message: 'sandbox does not exist' })).toBe(false);
    expect(isSandboxGoneError({ response: { status: 502 }, message: 'not found' })).toBe(false);

    // The 404 itself still wins over any message, from any of the three status shapes.
    expect(isSandboxGoneError({ status: 404, message: 'connect ETIMEDOUT' })).toBe(true);
  });

  it('falls back to the message only when there is no typed evidence', () => {
    expect(isSandboxGoneError(new Error('Sandbox not found'))).toBe(true);
    expect(isSandboxGoneError(new Error('Request failed with status 404'))).toBe(true);
    expect(isSandboxGoneError(new Error('that sandbox does not exist'))).toBe(true);
    expect(isSandboxGoneError(new Error('connect ETIMEDOUT'))).toBe(false);
    expect(isSandboxGoneError(new Error('An unexpected error occurred'))).toBe(false);
  });

  it('says "not gone" for anything that is not an object', () => {
    /* An undefined/string rejection must never be read as a definitive 404. */
    expect(isSandboxGoneError(undefined)).toBe(false);
    expect(isSandboxGoneError(null)).toBe(false);
    expect(isSandboxGoneError('not found')).toBe(false);
    expect(isSandboxGoneError(404)).toBe(false);
    expect(isSandboxGoneError({})).toBe(false);
  });
});
