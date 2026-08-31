/**
 * The sign-up gate (SPEC §4.5.1).
 *
 * Two failures this pins, both silent:
 *
 * - **The gate opens for someone already signed in, or in local mode.** Nothing throws; the user just
 *   gets a sign-in form for a problem that is not about identity, signs in successfully, and hits the
 *   same refusal. `requestSignIn` must report that it declined so the caller falls back to its own
 *   error path — a gate that quietly does nothing leaves a button that appears broken.
 * - **`403` is answered with a sign-in form.** `requireVerifiedUser` returns 403 to a user who IS
 *   signed in and has not confirmed their email. Collapsing it into 401 is the whole reason
 *   `describeAuthFailure` exists rather than a `status === 401 || status === 403` at each call site.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { sessionStore, EMPTY_SESSION, type SessionState } from '~/lib/stores/session';
import { authGate, canOpenAuthGate, describeAuthFailure, dismissSignIn, requestSignIn } from './auth-gate';

/** A session in the state the named door is reached from. */
function session(over: Partial<SessionState>): SessionState {
  return { ...EMPTY_SESSION, loading: false, ...over };
}

const ANONYMOUS = session({ accountsEnabled: true, authenticated: false });
const SIGNED_IN = session({ accountsEnabled: true, authenticated: true });
const LOCAL_MODE = session({ accountsEnabled: false, authenticated: true });

beforeEach(() => {
  authGate.set(null);
  sessionStore.set(EMPTY_SESSION);
});

describe('canOpenAuthGate', () => {
  it('opens for an anonymous visitor on a deployment with accounts', () => {
    expect(canOpenAuthGate(ANONYMOUS)).toBe(true);
  });

  it('declines in local mode — there is nobody to sign in as', () => {
    /*
     * `AccountMenu` renders nothing for the same reason. A 401 cannot occur here anyway (every caller
     * resolves to LOCAL_USER), so the honest answer to a request is "I cannot", not an empty form.
     */
    expect(canOpenAuthGate(LOCAL_MODE)).toBe(false);
  });

  it('declines for a signed-in user — whatever they hit was not about identity', () => {
    expect(canOpenAuthGate(SIGNED_IN)).toBe(false);
  });
});

describe('requestSignIn', () => {
  it('opens the gate and reports that it did', () => {
    sessionStore.set(ANONYMOUS);

    expect(requestSignIn({ reason: 'Sign in to remix.', redirectTo: '/remix/abc' })).toBe(true);
    expect(authGate.get()).toEqual({ reason: 'Sign in to remix.', redirectTo: '/remix/abc' });
  });

  it('sanitizes the destination on the way IN, not only at the navigation', () => {
    sessionStore.set(ANONYMOUS);
    requestSignIn({ reason: 'x', redirectTo: 'https://evil.example/steal' });

    expect(authGate.get()?.redirectTo).toBe('/');
  });

  it('returns false AND leaves the gate shut when it cannot open', () => {
    /*
     * Both halves matter. The boolean is what makes the caller report the failure itself; leaving the
     * gate shut is what stops a dialog appearing over a user who is already signed in.
     */
    for (const state of [LOCAL_MODE, SIGNED_IN]) {
      sessionStore.set(state);
      expect(requestSignIn({ reason: 'x', redirectTo: '/remix/abc' })).toBe(false);
      expect(authGate.get()).toBeNull();
    }
  });

  it('dismisses idempotently', () => {
    sessionStore.set(ANONYMOUS);
    requestSignIn({ reason: 'x', redirectTo: '/' });
    dismissSignIn();
    dismissSignIn();

    expect(authGate.get()).toBeNull();
  });
});

describe('describeAuthFailure', () => {
  it('sends 401 to the gate', () => {
    expect(describeAuthFailure(401, 'You must be signed in to do that.')).toEqual({
      kind: 'signin',
      message: 'You must be signed in to do that.',
    });
  });

  it('sends 403 somewhere else entirely — it is a verification problem, not a sign-in one', () => {
    const failure = describeAuthFailure(403, 'Please verify your email address to start building.');

    expect(failure.kind).toBe('verify');
    expect(failure.kind === 'verify' && failure.message).toContain('verify');
  });

  it('carries the SERVER’s sentence through rather than restating it', () => {
    // The server knows what it refused and why; a client-side paraphrase drifts from it silently.
    expect(describeAuthFailure(401, 'Sign in to remix this game.')).toMatchObject({
      message: 'Sign in to remix this game.',
    });
  });

  it('still says something when the server sent no message', () => {
    expect(describeAuthFailure(401).kind).toBe('signin');
    expect(describeAuthFailure(403).kind).toBe('verify');
  });

  it('leaves every other status alone, with NO message to paper over it', () => {
    /*
     * A 402 (out of credits), a 500 and a network failure are not identity problems. Returning a
     * message here would let a caller render an auth story over a billing refusal.
     */
    for (const status of [200, 400, 402, 404, 409, 500, 503]) {
      expect(describeAuthFailure(status, 'ignored')).toEqual({ kind: 'other' });
    }
  });
});
