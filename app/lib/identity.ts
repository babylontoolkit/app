/**
 * Who the chrome says you are (SPEC §4.5.1, §4.5.2).
 *
 * 🔴 **This exists because two surfaces answered the question from the wrong source.** The sidebar
 * header and the settings avatar dropdown both read `profileStore` — upstream bolt.diy's
 * `localStorage` blob (`bolt_profile`) — and printed `'Guest User'` when it was empty. That was
 * coherent in bolt.diy, which has no accounts at all. Here it is a second, unrelated identity sitting
 * where the real one belongs: with accounts configured, a signed-in user would still be labelled
 * "Guest User" beside their own projects, and there is nothing on screen that would ever say
 * otherwise.
 *
 * The rules below are each a decision, not a preference:
 *
 * - **An ACCOUNT's identity comes from the account, and the local profile may never override it.**
 *   `bolt_profile` is per-BROWSER, so on a shared machine it holds whatever the last person typed.
 *   Letting it win means labelling this session with someone else's name and face — the exact failure
 *   this module was written to remove, returning through the fallback.
 * - **In LOCAL mode the local profile DOES win.** There is no account to contradict it, and it is the
 *   only personalization that exists (§4.5: local mode is a real mode, not a stub).
 * - **While the session is loading we assert nothing.** The wrong-name flash is the defect; a brief
 *   nameless avatar is not. Callers get `loading` and can render a placeholder.
 *
 * Pure and framework-free so it can be tested without a DOM — `useDisplayIdentity` is the two-line
 * hook over it.
 */
import type { SessionState } from '~/lib/stores/session';

/** Upstream's per-browser profile (`~/lib/stores/profile`), declared here to keep this module pure. */
export interface LocalProfile {
  username: string;
  bio: string;
  avatar: string;
}

/**
 * - `account` — a real platform account (§4.5.1).
 * - `local` — the single local developer, Supabase unconfigured (§4.5).
 * - `guest` — accounts exist and nobody is signed in. Browsing is allowed; that is the funnel, not an
 *   error, which is why this is a first-class state rather than an absence.
 */
export type IdentityKind = 'account' | 'local' | 'guest';

export interface DisplayIdentity {
  kind: IdentityKind;

  /** The name to print. Empty ONLY while the session is still loading. */
  name: string;

  /** Email, or the reason there is no name — rendered as the second line where there is room. */
  secondary?: string;

  /** An image URL or data URI, or undefined for the icon fallback. */
  avatar?: string;

  /** True until `/api/me` has answered. Nothing above should be treated as settled while set. */
  loading: boolean;

  /** Should a "Sign in" affordance be offered? Only ever true for `guest`. */
  canSignIn: boolean;
}

const EMPTY_PROFILE: LocalProfile = { username: '', bio: '', avatar: '' };

export function resolveDisplayIdentity(session: SessionState, profile?: Partial<LocalProfile>): DisplayIdentity {
  const local = { ...EMPTY_PROFILE, ...(profile ?? {}) };

  if (session.loading) {
    /*
     * Deliberately nameless. The alternative — printing the local username, or 'Guest User' — states
     * an identity we have not yet been told, and then swaps it a moment later. A signed-in user
     * seeing "Guest User" flash is the original bug at a shorter duration.
     */
    return { kind: 'guest', name: '', avatar: undefined, loading: true, canSignIn: false };
  }

  const user = session.authenticated ? session.user : undefined;

  if (user?.isLocal) {
    return {
      kind: 'local',
      name: local.username.trim() || user.displayName || 'Local Developer',
      secondary: 'This device',
      avatar: local.avatar || undefined,
      loading: false,
      canSignIn: false,
    };
  }

  if (user) {
    /*
     * Account-only, on purpose — see the header. `local.username`/`local.avatar` are NOT consulted,
     * even as a fallback, because a fallback is exactly how the previous browser user's name would
     * reappear on a machine where this account has no display name set.
     */
    return {
      kind: 'account',
      name: user.displayName || user.email || 'Builder',
      secondary: user.email,
      avatar: user.avatarUrl || undefined,
      loading: false,
      canSignIn: false,
    };
  }

  if (!session.accountsEnabled) {
    /*
     * Local mode normally arrives authenticated (`getUser` returns `LOCAL_USER`). Reaching here means
     * `/api/me` failed — degrade to the local profile rather than inviting a sign-in that cannot work.
     */
    return {
      kind: 'local',
      name: local.username.trim() || 'Local Developer',
      secondary: 'This device',
      avatar: local.avatar || undefined,
      loading: false,
      canSignIn: false,
    };
  }

  return {
    kind: 'guest',
    name: 'Guest',
    secondary: 'Not signed in',
    avatar: undefined,
    loading: false,
    canSignIn: true,
  };
}
