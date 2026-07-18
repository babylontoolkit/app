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

/** A monthly plan (§4.6). Same credits, arriving every month instead of when you remember to buy. */
export interface SubscriptionPlan {
  id: string;
  name: string;
  creditsPerMonth: number;
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

    /**
     * The plans on offer. Static config, so it costs nothing to carry here — unlike whether THIS user
     * is subscribed, which needs a Stripe call and is fetched by the billing UI on demand.
     */
    plans: SubscriptionPlan[];

    /**
     * The PREMIUM model tier (§4.6.1) — a rendering hint for the model toggle, never an authority. The
     * server re-derives eligibility on every generation (`decidePremium`), so `available` here only
     * decides whether the toggle renders unlocked or locked-with-a-threshold.
     */
    premium: {
      /** The premium model id, e.g. `claude-fable-5`. */
      model: string;

      /** The standard (default) model id, e.g. `claude-opus-4-8` — named on the pill when premium is off. */
      standardModel: string;

      /** Credits the user must hold to unlock premium — shown in the locked-state copy. */
      minimumCredits: number;

      /** Does this user currently qualify (holds the minimum, or enforcement is off)? */
      available: boolean;
    };
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
  credits: {
    balance: 0,
    enforced: false,
    purchasable: false,
    packs: [],
    plans: [],
    premium: { model: 'claude-fable-5', standardModel: 'claude-opus-4-8', minimumCredits: 1000, available: false },
  },
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

      // Merge over defaults so a field the server omits (e.g. `premium` on an older deploy) is present.
      credits: data.credits ? { ...EMPTY_SESSION.credits, ...data.credits } : EMPTY_SESSION.credits,
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

/**
 * May this user pick the PREMIUM model right now (§4.6.1)? Mirrors `decidePremium` on the server — but
 * never replaces it. Computed LIVE from the balance (not the server's cached `available` flag) so it
 * stays honest after a settlement drops the balance below the threshold mid-session. When enforcement
 * is off, nobody is charged, so premium is freely available.
 */
export function canUsePremium(session: SessionState): boolean {
  if (!session.credits.enforced) {
    return true;
  }

  return session.credits.balance >= session.credits.premium.minimumCredits;
}
