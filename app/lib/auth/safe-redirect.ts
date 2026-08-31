/**
 * Where auth is allowed to send you, and what counts as a password (SPEC §4.5.1).
 *
 * ONE rule in ONE place, client-importable, because three layers need the same answer and a second
 * copy is how they drift: the sign-in dialog (before `window.location.href`), `/api/auth` (when it
 * builds the `?next=` Supabase will bounce through), and `/auth/callback` (the wall, on the way back
 * in). Every one of those handles a value that started life in a URL or a request body — i.e. it is
 * attacker-supplied — and the failure mode is an OPEN REDIRECT: a link that genuinely signs the user
 * in and then lands them on a look-alike page, with our domain in the referrer chain to make it
 * convincing. The wall is the callback; the other two exist so a bad value is refused at the point it
 * is introduced rather than surviving three hops to be caught at the end.
 *
 * This file must stay free of server imports — the dialog is a client component.
 */

/** Where we land when the requested destination is missing or refused. */
export const DEFAULT_REDIRECT = '/';

/**
 * A same-site path, or `DEFAULT_REDIRECT`.
 *
 * Accepts ONLY a root-relative path. An absolute URL is refused even when its host is ours today —
 * "is this my origin?" is a question whose answer changes with every new environment, and getting it
 * wrong is silent. A protocol-relative `//evil.com` and a backslash-prefixed `/\evil.com` both parse
 * as an off-site host in at least one browser, so both are refused explicitly rather than left to
 * whichever parser happens to see the string last.
 */
export function safeRedirect(next: string | null | undefined): string {
  if (!next) {
    return DEFAULT_REDIRECT;
  }

  /*
   * Control characters and spaces are stripped BEFORE the shape is judged, never after: URL parsers
   * ignore a leading newline or tab, so `"\n//evil.com"` passes a `startsWith('//')` check performed
   * on the raw string and is then followed off-site anyway.
   */
  const trimmed = next.replace(/[\u0000-\u0020]/g, '');

  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('/\\')) {
    return DEFAULT_REDIRECT;
  }

  return trimmed;
}

/**
 * The minimum we accept, enforced on the SERVER for every path that sets a password.
 *
 * Supabase's own floor is lower and lives in their dashboard, so relying on it puts the rule
 * somewhere this repo cannot see and turns the dialog's `minLength={8}` into a suggestion the API
 * quietly disagrees with.
 */
export const MIN_PASSWORD_LENGTH = 8;

/** A sentence naming what is wrong with a password, or `null` when it is acceptable. */
export function passwordProblem(password: string | undefined | null): string | null {
  if (!password) {
    return 'A password is required.';
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Your password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }

  return null;
}
