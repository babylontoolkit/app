/**
 * The sign-up gate (SPEC §4.5.1).
 *
 * ## What it is
 *
 * Anonymous visitors may browse the gallery and play a shared game with no account — that is the
 * zero-cost funnel. The gate falls at CREATION intent: New Project and Remix. Until this existed,
 * those doors reached their server route, took a `401`, and surfaced it as a generic toast reading
 * "You must be signed in to do that." — true, unactionable, and it threw away what the visitor was
 * trying to do. A funnel that tells someone to sign in without offering them the form, and then
 * forgets their intent, is a leak.
 *
 * ## Why a store rather than props
 *
 * The doors are far apart — `Chat.client.tsx`'s `startProject`, the `/remix/:shareId` route — and the
 * dialog is one mounted component in the header. Threading a callback from the header down to a
 * creation path is not the relationship: any door may raise the gate, and there is exactly one gate.
 * This is the `requestChatReset` shape, with a payload.
 *
 * ## What it is NOT
 *
 * 🔴 **A wall.** `requireUser` / `requireVerifiedUser` on the server are the wall and are untouched.
 * This store decides what the UI RENDERS and nothing else; a client that never opens it still cannot
 * create a project. Treating it as authorization is the `/api/me` mistake one layer down.
 *
 * 🔴 **The place to answer a 403.** A `403` from `requireVerifiedUser` means the user IS signed in
 * and has not confirmed their email — showing them a sign-in form is a false statement about what is
 * wrong, and they would sign in successfully and hit the same refusal. `describeAuthFailure` splits
 * the two so a caller cannot collapse them by accident.
 */
import { atom } from 'nanostores';
import { sessionStore, type SessionState } from '~/lib/stores/session';
import { safeRedirect } from '~/lib/auth/safe-redirect';

export interface AuthGateRequest {
  /**
   * One sentence naming the thing the visitor was trying to do, shown above the form.
   *
   * "Sign in to remix this game" is an invitation; a bare "Sign in" is a toll booth, and the user has
   * to reconstruct why they are looking at it.
   */
  reason: string;

  /**
   * Where to land afterwards — the preserved intent (§4.5.1).
   *
   * Passed through `safeRedirect` on the way IN as well as at every later hop, so a value assembled
   * from `window.location` (or, on the remix route, from a URL parameter) cannot become an open
   * redirect just because one call site forgot.
   */
  redirectTo: string;
}

/** The open gate, or `null`. */
export const authGate = atom<AuthGateRequest | null>(null);

/**
 * Can the gate meaningfully open for this session?
 *
 * `false` in local mode (no accounts exist, so there is nobody to sign in as — `AccountMenu` renders
 * nothing for the same reason) and `false` when the user is already signed in, where the refusal they
 * just hit is about something other than identity. Pure so the decision is testable without a DOM;
 * the caller uses the answer to fall back to its own error path rather than failing silently.
 */
export function canOpenAuthGate(session: SessionState): boolean {
  return Boolean(session.accountsEnabled) && !session.authenticated;
}

/**
 * Raise the gate. Returns `false` when it cannot open, and the caller MUST then report the failure
 * itself — a gate that quietly declines leaves the user staring at a button that did nothing.
 */
export function requestSignIn(request: AuthGateRequest): boolean {
  if (!canOpenAuthGate(sessionStore.get())) {
    return false;
  }

  authGate.set({ reason: request.reason, redirectTo: safeRedirect(request.redirectTo) });

  return true;
}

/** Close the gate. Idempotent. */
export function dismissSignIn(): void {
  authGate.set(null);
}

/** What a route refusal actually means, from the caller's point of view. */
export type AuthFailure = { kind: 'signin'; message: string } | { kind: 'verify'; message: string } | { kind: 'other' };

/**
 * Classify a failed request so a caller cannot answer "you are not verified" with a sign-in form.
 *
 * `401` is "we do not know who you are" → the gate. `403` here is `requireVerifiedUser` → the user is
 * known and their email is not confirmed, so the honest answer is the server's own sentence plus the
 * resend affordance already in the account menu. Anything else is not an identity problem at all and
 * is left to the caller's existing handling, which is why `other` carries no message: inventing one
 * would paper over a 402, a 500, or a network failure with an auth story.
 */
export function describeAuthFailure(status: number, serverMessage?: string): AuthFailure {
  if (status === 401) {
    return { kind: 'signin', message: serverMessage || 'Sign in to continue.' };
  }

  if (status === 403) {
    return {
      kind: 'verify',
      message: serverMessage || 'Please verify your email address to start building. Check your inbox for the link.',
    };
  }

  return { kind: 'other' };
}
