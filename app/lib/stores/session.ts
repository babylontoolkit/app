/**
 * Session, credits, and capabilities — the client's view of who it is (SPEC §4.5, §4.6, §4.6.1).
 *
 * **This store decides what the UI is allowed to RENDER. It decides nothing about what the user is
 * allowed to DO.** The server re-derives every one of these flags on every request (`resolveByok`,
 * `checkCreditGate`, `requireOwnedProject`), so tampering with the store in DevTools reveals a
 * provider picker that the server will then ignore. That asymmetry is deliberate and load-bearing:
 * client state is a rendering hint, never an authority.
 *
 * The flag that matters most is `byokUnlocked`. It is the ONLY thing that may reveal the provider
 * picker, the model selector, or an API-key field. In the shipping default
 * (`PRO_FEATURES_ENABLED=false`) it is `false` for everyone, and credits-mode UI therefore contains
 * zero provider machinery — not disabled, not collapsed: absent (§4.1, §2.3).
 */
import { atom } from 'nanostores';

export interface CreditPack {
  id: string;
  name: string;
  credits: number;
  priceCents: number;
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  isAdmin: boolean;
  isLocal: boolean;
}

export interface SessionState {
  loading: boolean;
  authenticated: boolean;

  /** False when Supabase is unconfigured — the app runs as a single local user (§4.5). */
  accountsEnabled: boolean;

  user?: SessionUser;

  credits: {
    balance: number;

    /** Off = beta mode: usage recorded, nobody blocked (§4.6). Drives "out of credits" vs. a read-out. */
    enforced: boolean;
    purchasable: boolean;
    packs: CreditPack[];
  };

  pro: {
    /** The master switch. Off (the default) means Pro/BYOK UI does not exist for ANYONE. */
    proFeaturesEnabled: boolean;

    /** THE flag. The only thing that may reveal provider/model/key controls. */
    byokUnlocked: boolean;

    tier: string | null;
    status: string | null;
    subscriberEmail: string | null;
  };
}

export const EMPTY_SESSION: SessionState = {
  loading: true,
  authenticated: false,
  accountsEnabled: false,
  credits: { balance: 0, enforced: false, purchasable: false, packs: [] },
  pro: { proFeaturesEnabled: false, byokUnlocked: false, tier: null, status: null, subscriberEmail: null },
};

export const sessionStore = atom<SessionState>(EMPTY_SESSION);

/** Refresh from `/api/me`. Safe to call often; it is one cheap read. */
export async function refreshSession(): Promise<SessionState> {
  try {
    const response = await fetch('/api/me');

    if (!response.ok) {
      const next = { ...EMPTY_SESSION, loading: false };
      sessionStore.set(next);

      return next;
    }

    const data = (await response.json()) as Partial<SessionState>;

    const next: SessionState = {
      loading: false,
      authenticated: Boolean(data.authenticated),
      accountsEnabled: Boolean(data.accountsEnabled),
      user: data.user,
      credits: data.credits ?? EMPTY_SESSION.credits,
      pro: data.pro ?? EMPTY_SESSION.pro,
    };

    sessionStore.set(next);

    return next;
  } catch {
    // Offline or mid-deploy. Report signed-out rather than hanging the UI on a spinner forever.
    const next = { ...EMPTY_SESSION, loading: false };
    sessionStore.set(next);

    return next;
  }
}

/**
 * Apply the settled cost of a generation (§4.6).
 *
 * The agent stream ends with a `credits` annotation carrying the ACTUAL charge and the resulting
 * balance. We set the balance from the server's number rather than subtracting locally — the server
 * settled against real token usage, and a client-side subtraction would drift from the ledger the
 * first time a generation was stopped or repaired.
 */
export function applySettlement(balanceAfter: number | null) {
  if (balanceAfter === null) {
    return;
  }

  const current = sessionStore.get();
  sessionStore.set({ ...current, credits: { ...current.credits, balance: balanceAfter } });
}

/** Can this user start a generation right now? Mirrors the server gate — but never replaces it. */
export function canGenerate(session: SessionState): { allowed: boolean; reason?: string } {
  if (session.accountsEnabled && !session.authenticated) {
    return { allowed: false, reason: 'Sign in to start building.' };
  }

  if (session.authenticated && !session.user?.emailVerified) {
    return { allowed: false, reason: 'Verify your email to start building. Check your inbox.' };
  }

  // BYOK users pay with their own key, so a zero platform balance is irrelevant to them.
  if (session.pro.byokUnlocked) {
    return { allowed: true };
  }

  if (session.credits.enforced && session.credits.balance <= 0) {
    return { allowed: false, reason: 'You are out of credits. Add more to keep building.' };
  }

  return { allowed: true };
}
