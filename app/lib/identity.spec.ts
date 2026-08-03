/**
 * The chrome names the right person (SPEC §4.5.1, §4.5.2).
 *
 * 🔴 Written because it did not. Two surfaces printed `profile?.username || 'Guest User'` from
 * upstream's per-browser `bolt_profile`, so with accounts configured a signed-in user is labelled
 * "Guest User" beside their own projects — and on a shared machine, labelled with whatever name the
 * PREVIOUS person typed into Settings. Neither failure throws; both are simply the wrong name on the
 * screen, forever.
 *
 * The tests below assert the two directions that matter — an account is never overridden by local
 * state, and local mode still gets its personalization — plus the loading frame, which is where a
 * naive fix reintroduces the bug at a shorter duration.
 */
import { describe, expect, it } from 'vitest';
import { resolveDisplayIdentity, type LocalProfile } from './identity';
import { EMPTY_SESSION, type SessionState, type SessionUser } from './stores/session';

const STALE: LocalProfile = { username: 'Somebody Else', bio: '', avatar: 'data:image/png;base64,STALE' };

type SessionPatch = Omit<Partial<SessionState>, 'user'> & { user?: Partial<SessionUser> };

function session(patch: SessionPatch): SessionState {
  const { user, ...rest } = patch;

  return {
    ...EMPTY_SESSION,
    loading: false,
    ...rest,
    ...(user
      ? {
          user: {
            id: 'u1',
            email: 'builder@example.com',
            displayName: 'Builder',
            emailVerified: true,
            isAdmin: false,
            isLocal: false,
            ...user,
          },
        }
      : {}),
  };
}

describe('a signed-in account', () => {
  const signedIn = session({ authenticated: true, accountsEnabled: true, user: {} });

  it('is named by the ACCOUNT, never by the browser profile', () => {
    const identity = resolveDisplayIdentity(signedIn, STALE);

    expect(identity.kind).toBe('account');
    expect(identity.name).toBe('Builder');
    expect(identity.name).not.toBe(STALE.username);
  });

  it('shows the account email as the second line', () => {
    expect(resolveDisplayIdentity(signedIn, STALE).secondary).toBe('builder@example.com');
  });

  /*
   * The avatar follows the same rule as the name, and for the same reason: a face left in
   * `localStorage` by the last person to use this browser must not be shown next to this account.
   */
  it('does not wear the previous browser user’s avatar', () => {
    expect(resolveDisplayIdentity(signedIn, STALE).avatar).toBeUndefined();
  });

  it('wears the account’s own avatar when it has one', () => {
    const withAvatar = session({
      authenticated: true,
      accountsEnabled: true,
      user: { avatarUrl: 'https://example.com/me.png' },
    });

    expect(resolveDisplayIdentity(withAvatar, STALE).avatar).toBe('https://example.com/me.png');
  });

  it('falls back to the email, never to "Guest", when the account has no display name', () => {
    const nameless = session({ authenticated: true, accountsEnabled: true, user: { displayName: '' } });

    expect(resolveDisplayIdentity(nameless, STALE).name).toBe('builder@example.com');
  });

  it('offers no sign-in affordance', () => {
    expect(resolveDisplayIdentity(signedIn, STALE).canSignIn).toBe(false);
  });
});

describe('local mode — the single developer (§4.5)', () => {
  const local = session({
    authenticated: true,
    accountsEnabled: false,
    user: { isLocal: true, displayName: 'Local Developer', email: 'local@localhost' },
  });

  /*
   * The inverse of the rule above, and it is not an inconsistency: with no account to contradict it,
   * the local profile is the only personalization that exists and nobody else's name can be in it.
   */
  it('DOES take the local profile’s name', () => {
    expect(resolveDisplayIdentity(local, { username: 'Mackey', bio: '', avatar: '' }).name).toBe('Mackey');
  });

  it('takes the local profile’s avatar too', () => {
    expect(resolveDisplayIdentity(local, STALE).avatar).toBe(STALE.avatar);
  });

  it('falls back to "Local Developer" with no local profile set', () => {
    const identity = resolveDisplayIdentity(local, { username: '   ', bio: '', avatar: '' });

    expect(identity.kind).toBe('local');
    expect(identity.name).toBe('Local Developer');
  });

  it('never offers a sign-in that cannot work', () => {
    expect(resolveDisplayIdentity(local, {}).canSignIn).toBe(false);

    // …including when `/api/me` failed outright and left us with no user at all.
    const degraded = session({ authenticated: false, accountsEnabled: false });
    expect(resolveDisplayIdentity(degraded, {}).canSignIn).toBe(false);
    expect(resolveDisplayIdentity(degraded, {}).kind).toBe('local');
  });
});

describe('a signed-out visitor, with accounts configured', () => {
  const guest = session({ authenticated: false, accountsEnabled: true });

  it('is a guest, and may sign in', () => {
    const identity = resolveDisplayIdentity(guest, {});

    expect(identity.kind).toBe('guest');
    expect(identity.name).toBe('Guest');
    expect(identity.canSignIn).toBe(true);
  });

  /*
   * Browsing signed out is the funnel (§4.5.1), not an error — but a name left behind by whoever last
   * signed in on this browser must not make an anonymous visitor look like them.
   */
  it('is not named by a leftover local profile', () => {
    expect(resolveDisplayIdentity(guest, STALE).name).toBe('Guest');
    expect(resolveDisplayIdentity(guest, STALE).avatar).toBeUndefined();
  });
});

describe('while the session is still loading', () => {
  const loading: SessionState = { ...EMPTY_SESSION, loading: true };

  /*
   * The whole defect is "the screen states an identity that is not yours". Printing 'Guest User' — or
   * the local username — for the ~100ms before `/api/me` answers is the same statement, briefly. It
   * must assert nothing at all.
   */
  it('asserts no name', () => {
    const identity = resolveDisplayIdentity(loading, STALE);

    expect(identity.loading).toBe(true);
    expect(identity.name).toBe('');
    expect(identity.avatar).toBeUndefined();
  });

  it('offers no sign-in button before we know whether anyone is signed in', () => {
    expect(resolveDisplayIdentity(loading, STALE).canSignIn).toBe(false);
  });
});

/**
 * CONTROL — the string this module was written to delete is not reachable from any input.
 *
 * Without this, every assertion above could pass while some branch still emits it: the tests name the
 * cases somebody thought of, and the defect was a case nobody had.
 */
it('CONTROL — no combination of inputs produces "Guest User"', () => {
  const users: Array<Partial<SessionUser> | undefined> = [
    undefined,
    {},
    { isLocal: true },
    { displayName: '' },
    { displayName: '', email: '' },
  ];
  const profiles: Array<Partial<LocalProfile> | undefined> = [undefined, {}, STALE, { username: 'Guest User' }];

  for (const loading of [true, false]) {
    for (const accountsEnabled of [true, false]) {
      for (const user of users) {
        for (const profile of profiles) {
          const state: SessionState = {
            ...session({ authenticated: Boolean(user), accountsEnabled, ...(user ? { user } : {}) }),
            loading,
          };

          /*
           * The local branch legitimately echoes whatever the user typed as their OWN name — and it
           * is reached via `user.isLocal`, not via `accountsEnabled`, which is what the first draft of
           * this exemption assumed. The control found that on its first run.
           */
          const isLocalBranch = user?.isLocal === true || (!accountsEnabled && !user);

          if (profile?.username === 'Guest User' && isLocalBranch) {
            continue;
          }

          expect(resolveDisplayIdentity(state, profile).name).not.toBe('Guest User');
        }
      }
    }
  }
});
