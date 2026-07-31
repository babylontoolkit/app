/**
 * Session, balance, and capabilities (SPEC §4.5, §4.6, §4.6.1).
 *
 * The one endpoint the client asks: *who am I, what may I do, and what do I have left?* Everything
 * the UI needs to decide what to render — and, critically, **nothing the UI could use to grant itself
 * something.** `proFeaturesEnabled` and `byokUnlocked` are reported here, but the server re-derives
 * both on every generation (`resolveByok`). This response is a hint for rendering, never an authority.
 *
 * It is also where the **signup grant** is issued (§4.5.4): the first time we see a VERIFIED session.
 * Not at signup — an unconfirmed address must never be able to mint credits — and not in the auth
 * route, because OAuth users never pass through it. Every authenticated path lands here, and the
 * grant is idempotent, so "call it every time" is both correct and safe.
 */
import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { getUser } from '~/lib/.server/supabase/auth';
import { isSupabaseConfigured } from '~/lib/.server/supabase/client';
import { getPlatformConfig, getPlatformModel } from '~/lib/.server/agent/config';
import { getBillingConfigSafe, getModelTiers, type ModelTierStatus } from '~/lib/.server/billing/rates';
import { modelTiersSessionHint } from '~/lib/.server/billing/premium';
import { DEFAULT_MODEL } from '~/utils/constants';
import { ensureSignupGrant, getLedger } from '~/lib/.server/billing/ledger';
import { getEntitlement } from '~/lib/.server/licensing/entitlements';
import { isStripeConfigured, CREDIT_PACKS, SUBSCRIPTION_PLANS } from '~/lib/.server/billing/stripe';
import { errorResponse } from '~/lib/.server/http';
import { getMonitor, FUNNEL_EVENTS } from '~/lib/.server/monitoring';
import { ensureMarketPrices } from '~/lib/.server/billing/market-price-store';

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    // The premium tier below prices from the marketplace list — refresh it at this async doorway.
    await ensureMarketPrices(context);

    const user = await getUser(request, context);
    const platform = getPlatformConfig(context);

    /*
     * 🔴 A MISCONFIGURED PRICE VARIABLE MUST NOT TAKE `/api/me` DOWN — it is the session endpoint on
     * EVERY page load, so a throw here is the whole app, for every user, over a line in an env file.
     * This is exactly the `premiumSessionHint` defect (2026-07-25) in a second place: `getBillingConfig`
     * gained a refusal when `CREATION_FLAT_CREDITS` was retired (§4.4a) and this call inherited it
     * unguarded, five lines from a `getPlatformConfig` call that IS guarded for the same reason.
     *
     * Degraded honestly rather than invented: with no readable configuration we do not know the grant
     * size, so no grant is issued (it is idempotent — the real one lands on the next request once the
     * operator fixes their env, and issuing a guessed number of credits is the unrecoverable
     * direction), and `enforced` reports TRUE, the conservative reading — telling the client credits
     * do not bind when we cannot tell is the same class of invention as advertising premium we cannot
     * serve. Nothing here can SPEND: the gate and settlement still call `getBillingConfig` and still
     * throw.
     */
    const billing = getBillingConfigSafe(context);

    if (!user) {
      return json({
        authenticated: false,
        accountsEnabled: isSupabaseConfigured(context),

        /*
         * Even signed out, the client needs to know whether Pro machinery exists at all — because in
         * the shipping default (`false`) the provider picker, model selector and key fields must not
         * render for ANYONE, signed in or not (§4.6.1).
         */
        proFeaturesEnabled: platform.proFeaturesEnabled,
      });
    }

    // The grant. Idempotent — a partial unique index means exactly one lands, however many race.
    if (user.emailVerified && billing?.grantsEnabled) {
      const granted = await ensureSignupGrant(user.id, billing.signupGrantCredits, context);

      /*
       * The funnel's "verified" stage (§5A). `ensureSignupGrant` returns the entry only on the FIRST
       * verified session (null on every later idempotent call), so this fires exactly once per user —
       * the natural place to record it, since OAuth users never touch the sign-up route.
       */
      if (granted) {
        getMonitor(context).track(FUNNEL_EVENTS.VERIFIED, { userId: user.id });
      }
    }

    const [balance, entitlement] = await Promise.all([
      getLedger(context).balance(user.id),
      platform.proFeaturesEnabled ? getEntitlement(user.id, context) : Promise.resolve(null),
    ]);

    /*
     * BYOK is unlocked by an ACTIVE entitlement — or by local dev, which has no license service to
     * ask (§4.6.1). Note this is only ever `true` when `proFeaturesEnabled` is on, so the credits-only
     * default can never accidentally reveal a key field.
     */
    const byokUnlocked = platform.proFeaturesEnabled && (user.isLocal || entitlement?.status === 'active');

    return json({
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        emailVerified: user.emailVerified,
        isAdmin: user.isAdmin,
        isLocal: user.isLocal,
      },

      credits: {
        balance,

        /*
         * Off = beta mode: usage is recorded in full, but a zero balance blocks nobody (§4.6). The UI
         * uses this to decide whether to show an "out of credits" wall or just a usage read-out.
         */
        enforced: billing?.enforced ?? true,
        purchasable: isStripeConfigured(context),
        packs: CREDIT_PACKS.filter((p) => p.isActive),

        /*
         * The plan LIST is static config, so it rides the session for free. Whether THIS user has a
         * subscription deliberately does not: that needs a Stripe API call, and `/api/me` runs on every
         * page load. It is resolved lazily by `/api/credits` when someone actually opens billing.
         */
        plans: SUBSCRIPTION_PLANS.filter((p) => p.isActive),

        /*
         * The MODEL TIER LADDER (§4.6.1a). A hint for rendering the composer's tier picker — the server
         * re-derives eligibility on every generation (`decideModelTier`), so this can never grant a rung
         * by itself. Per rung, `available` is whether THIS user may currently pick it: it is serveable
         * AND they hold its minimum. The thresholds bind regardless of `BILLING_ENFORCED` — settlement
         * debits the balance either way, so the balance is always the eligibility fact (see
         * `premium.ts`). Below a rung's minimum its row renders locked with the threshold shown — that
         * is what protects a fresh grant from the expensive models.
         */
        modelTiers: (() => {
          /*
           * ⚠️ EVERY LOOKUP IS INDIVIDUALLY GUARDED, and the reason is a real outage.
           *
           * `/api/me` is the SESSION endpoint on every page load. Before the premium half was guarded,
           * an unpriced `PREMIUM_MODEL` threw straight past this object literal into the loader's catch
           * and took the whole app down for every user — because a toggle's RENDERING HINT was
           * misconfigured (2026-07-25). Generalizing to three rungs multiplies the ways an operator can
           * reach that state, so nothing here may throw: `getModelTiers` catches per rung internally,
           * `getPlatformModel` is caught here, and `modelTiersSessionHint` is total by construction.
           *
           * 🔴 A rung that cannot be priced reports `available: false`, NOT the baked default's
           * availability. It genuinely cannot be served — `getTierModel` applies the same validation and
           * refuses at generation time — so advertising it renders an enabled picker row that hard-fails
           * the moment it is used. Degrading a capability to "off" is honest; degrading it to "on"
           * invents one.
           */
          let standardModel: string | null = null;

          try {
            standardModel = getPlatformModel(context);
          } catch {
            standardModel = null;
          }

          let tiers: ModelTierStatus[] | null = null;

          try {
            tiers = getModelTiers(standardModel ?? DEFAULT_MODEL, context);
          } catch {
            tiers = null;
          }

          return modelTiersSessionHint({
            tiers,
            standardModel,
            fallbackStandardModel: DEFAULT_MODEL,
            balance,
          });
        })(),
      },

      pro: {
        proFeaturesEnabled: platform.proFeaturesEnabled,
        byokUnlocked,
        tier: entitlement?.tier ?? null,
        status: entitlement?.status ?? null,
        subscriberEmail: entitlement?.subscriberEmail ?? null,
      },

      accountsEnabled: isSupabaseConfigured(context),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
