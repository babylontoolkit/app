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
import { DEFAULT_MODEL } from '~/utils/constants';

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

  /**
   * The account's avatar (`profiles.avatar_url`, usually from OAuth). Absent for most email/password
   * accounts, which fall back to an icon.
   *
   * It rides on the SESSION rather than being read from the browser's `bolt_profile` because identity
   * shown next to an account must come from the account — see `~/lib/identity`.
   */
  avatarUrl?: string;

  emailVerified: boolean;
  isAdmin: boolean;
  isLocal: boolean;
}

/**
 * One rung of the model tier ladder, as the SERVER described it on the last `/api/me` (§4.6.1a).
 *
 * Mirrors `ModelTierHint` server-side. Declared here rather than imported because this module is in
 * the client bundle and `~/lib/.server/**` may never be: the two are held in agreement by the wire, and
 * by `session-payload.spec.ts` asserting the exact field set a row carries.
 */
export interface ModelTierState {
  id: string;
  label: string;

  /** The model this rung runs, e.g. `claude-fable-5`. Rendered on the pill and the picker row. */
  model: string;

  /** Credits the user must hold to unlock it. `0` for standard. Shown in the locked-row copy. */
  minimumCredits: number;

  /**
   * Server SNAPSHOT of "may this user pick it", as of the page load. See `canUseTier` for why the
   * client recomputes affordability rather than reading this.
   */
  available: boolean;

  /** Can the platform serve it at all — is the operator's selector priceable? Not client-derivable. */
  serveable: boolean;
}

export interface ModelTiersState {
  /** The model a `standard` turn runs — what the pill names when no paid rung is selected. */
  standardModel: string;
  tiers: ModelTierState[];
}

/**
 * The ladder before (or without) a server answer: the platform default, every paid rung LOCKED.
 *
 * Locked is the safe direction — an optimistic default would render a selectable Premium row to a
 * signed-out visitor. The paid row is still LISTED rather than omitted, so the picker has a stable
 * shape and a user can see what exists and what it would take to unlock it.
 */
export const LOCKED_MODEL_TIERS: ModelTiersState = {
  standardModel: DEFAULT_MODEL,
  tiers: [
    { id: 'standard', label: 'Standard', model: DEFAULT_MODEL, minimumCredits: 0, available: true, serveable: true },
    {
      id: 'premium',
      label: 'Premium',
      model: 'claude-opus-5',
      minimumCredits: 1200,
      available: false,
      serveable: false,
    },
  ],
};

/**
 * Validate the ladder ON ARRIVAL — the `credits` merge is SHALLOW, so this object is trusted whole.
 *
 * `{ ...EMPTY_SESSION.credits, ...data.credits }` replaces `modelTiers` outright the moment the server
 * sends one, defaults included. So a server that omits it is handled by the spread, but a server that
 * sends a HALF-formed one — an older deploy, a mid-rollout box, a proxy that mangled the body — hands
 * the picker `tiers: undefined`, and `.find()` on undefined is a blank screen rather than a locked
 * ladder. The defensive read costs nothing and turns every malformed shape into the locked default,
 * which is the same answer as "we could not ask".
 */
export function normalizeModelTiers(value: unknown): ModelTiersState {
  if (!value || typeof value !== 'object') {
    return LOCKED_MODEL_TIERS;
  }

  const candidate = value as Partial<ModelTiersState>;

  if (!Array.isArray(candidate.tiers) || candidate.tiers.length === 0) {
    return LOCKED_MODEL_TIERS;
  }

  const tiers = candidate.tiers
    .filter((row): row is ModelTierState => Boolean(row) && typeof row === 'object' && typeof row.id === 'string')
    .map((row) => ({
      id: row.id,
      label: typeof row.label === 'string' ? row.label : row.id,
      model: typeof row.model === 'string' ? row.model : DEFAULT_MODEL,
      minimumCredits: Number.isFinite(row.minimumCredits) ? row.minimumCredits : Number.POSITIVE_INFINITY,

      /*
       * `=== true`, never truthiness: a row missing the field must read as LOCKED, and `undefined`
       * placed on a boolean is neither locked nor unlocked — a consumer reading `!available` renders it
       * correctly while one reading `available === false` renders an enabled control that hard-fails.
       * An absent threshold is treated as unaffordable for the same reason: refuse, never guess cheap.
       */
      available: row.available === true,
      serveable: row.serveable === true,
    }));

  if (tiers.length === 0) {
    return LOCKED_MODEL_TIERS;
  }

  return {
    standardModel:
      typeof candidate.standardModel === 'string' && candidate.standardModel.trim()
        ? candidate.standardModel
        : DEFAULT_MODEL,
    tiers,
  };
}

export interface SessionState {
  loading: boolean;

  /**
   * 🔴 "WE COULD NOT ASK" — DISTINCT FROM "WE ASKED AND THE ANSWER IS NONE" (2026-08-11).
   *
   * `refreshSession` reports a failed `/api/me` as a fully EMPTY session with `loading: false`, which
   * is right for auth and credits (signed-out is the safe reading) and WRONG for any control that
   * hides itself when a capability is absent: an absent capability and an unanswered question become
   * the same value, so a transient blip looks exactly like a deployment that has never had the
   * feature. `mount-source.ts` already draws this line — `undefined` (could not ask) is not `null`
   * (asked, empty) — and collapsing them there lets a flaky connection push over a repo it never read.
   *
   * The concrete symptom this exists to stop: `usePromptEnhancer` calls `refreshSession()` MID-SESSION,
   * so one failed request made the Media button vanish from the header on a deployment where media is
   * configured — resizing the toolbar, which §4.1a forbids outright.
   *
   * ⚠️ It is NOT a licence to render a capability as available. A control may use this to keep HOLDING
   * ITS PLACE, never to claim a gateway exists; the server re-derives everything on use regardless.
   */
  loadFailed: boolean;
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
     * The MODEL TIER LADDER (§4.6.1a) — a rendering hint for the composer's tier picker, never an
     * authority. The server re-derives eligibility on every generation (`decideModelTier`), so
     * `available` here only decides whether a row renders selectable or locked-with-a-threshold.
     */
    modelTiers: ModelTiersState;
  };

  /**
   * WHICH GATEWAY SERVES RENDERS (§4.16) — a rendering hint for the Media panel, never an authority.
   * The routes re-derive it and refuse on their own, so this only decides which model list and which
   * controls are drawn. `provider: null` means the platform serves no media here at all.
   */
  media: {
    provider: 'KIE' | 'Comet' | null;
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
  loadFailed: false,
  authenticated: false,
  accountsEnabled: false,
  credits: {
    balance: 0,
    enforced: false,
    purchasable: false,
    packs: [],
    plans: [],
    modelTiers: LOCKED_MODEL_TIERS,
  },

  /*
   * Defaults to NO media, deliberately. Until `/api/me` answers, drawing a model list would offer
   * controls whose gateway is unknown — and offering transparency we cannot deliver is the one
   * failure §4.16 exists to prevent. Absent means off; the server turns it on.
   */
  media: { provider: null },
  pro: { proFeaturesEnabled: false, byokUnlocked: false, tier: null, status: null, subscriberEmail: null },
};

export const sessionStore = atom<SessionState>(EMPTY_SESSION);

/** Refresh from `/api/me`. Safe to call often; it is one cheap read. */
export async function refreshSession(): Promise<SessionState> {
  try {
    const response = await fetch('/api/me');

    if (!response.ok) {
      const next = { ...EMPTY_SESSION, loading: false, loadFailed: true };
      sessionStore.set(next);

      return next;
    }

    const data = (await response.json()) as Partial<SessionState>;

    const next: SessionState = {
      loading: false,
      loadFailed: false,
      authenticated: Boolean(data.authenticated),
      accountsEnabled: Boolean(data.accountsEnabled),
      user: data.user,

      /*
       * Merge over defaults so a field the server omits (e.g. `modelTiers` on an older deploy) is
       * present. ⚠️ The merge is SHALLOW, so a nested object arrives whole or not at all — a server
       * sending a HALF-formed `modelTiers` would replace the default outright and leave
       * `tiers` undefined, which is a crash in the picker rather than a locked ladder. Hence
       * `normalizeModelTiers`: the ladder is validated on arrival, not trusted for its shape.
       */
      credits: data.credits
        ? { ...EMPTY_SESSION.credits, ...data.credits, modelTiers: normalizeModelTiers(data.credits.modelTiers) }
        : EMPTY_SESSION.credits,
      media: data.media ?? EMPTY_SESSION.media,
      pro: data.pro ?? EMPTY_SESSION.pro,
    };

    sessionStore.set(next);

    return next;
  } catch {
    // Offline or mid-deploy. Report signed-out rather than hanging the UI on a spinner forever.
    const next = { ...EMPTY_SESSION, loading: false, loadFailed: true };
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
 * May this user pick this RUNG right now (§4.6.1a)? Mirrors `decideModelTier` on the server — but never
 * replaces it.
 *
 * Computed LIVE from the balance (not the server's cached `available` flag) so it stays honest after a
 * settlement drops the balance below a threshold mid-session: `/api/me` was fetched on page load and
 * its `available` is a snapshot of that moment, while the balance moves on every generation. The
 * threshold binds regardless of `enforced` — settlement debits the balance either way (see server
 * `premium.ts`).
 *
 * ⚠️ `serveable` is the ONE thing taken from the server's snapshot rather than recomputed, because the
 * client cannot know it: it means "the operator's selector for this rung can be priced". A rung the
 * platform will refuse must not be offered as pickable no matter how many credits the user holds
 * (degrading a capability to "off" is honest, to "on" invents one).
 *
 * Standard is ALWAYS usable — it has no threshold and no selector to misconfigure.
 */
export function canUseTier(session: SessionState, tierId: string): boolean {
  if (tierId === 'standard') {
    return true;
  }

  const row = session.credits.modelTiers.tiers.find((tier) => tier.id === tierId);

  return Boolean(row) && row!.serveable && session.credits.balance >= row!.minimumCredits;
}

/** @deprecated Use `canUseTier(session, 'premium')`. Kept while the toggle's callers migrate (T11). */
export function canUsePremium(session: SessionState): boolean {
  return canUseTier(session, 'premium');
}
