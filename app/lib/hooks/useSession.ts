/**
 * The session hook (SPEC §4.5, §4.6.1).
 *
 * Every component that needs to know "is BYOK unlocked" or "what is my balance" reads it from here,
 * so there is exactly ONE place the answer comes from — the server. A component that decided for
 * itself (say, by reading an env var in the client bundle) would be deciding from a value the user
 * can change.
 */
import { useStore } from '@nanostores/react';
import { useEffect } from 'react';
import { refreshSession, sessionStore, canGenerate, type SessionState } from '~/lib/stores/session';

let started = false;

export function useSession(): SessionState & { refresh: () => Promise<SessionState> } {
  const session = useStore(sessionStore);

  useEffect(() => {
    // One fetch per page load, however many components ask.
    if (!started) {
      started = true;
      void refreshSession();
    }
  }, []);

  return { ...session, refresh: refreshSession };
}

/**
 * Is the Pro/BYOK surface allowed to render at all?
 *
 * The single predicate every provider-picker, model-selector and key-field render path must consult.
 * In the shipping default this is `false` for everyone, and that machinery is ABSENT from the DOM —
 * not disabled, not hidden behind a collapsed panel (§4.1, §2.3, §4.6.1).
 */
export function useByokUnlocked(): boolean {
  const session = useStore(sessionStore);

  return session.pro.proFeaturesEnabled && session.pro.byokUnlocked;
}

export function useCanGenerate(): { allowed: boolean; reason?: string } {
  const session = useStore(sessionStore);

  return canGenerate(session);
}
