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
import { getBillingConfig, getPremiumTier } from '~/lib/.server/billing/rates';
import { DEFAULT_MODEL } from '~/utils/constants';
import { ensureSignupGrant, getLedger } from '~/lib/.server/billing/ledger';
import { getEntitlement } from '~/lib/.server/licensing/entitlements';
import { isStripeConfigured, CREDIT_PACKS, SUBSCRIPTION_PLANS } from '~/lib/.server/billing/stripe';
import { errorResponse } from '~/lib/.server/http';
import { getMonitor, FUNNEL_EVENTS } from '~/lib/.server/monitoring';

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    const user = await getUser(request, context);
    const platform = getPlatformConfig(context);
    const billing = getBillingConfig(context);

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
    if (user.emailVerified && billing.grantsEnabled) {
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
      platform.proFeaturesEnabled ? getEntitlement(user.id, user.email, context) : Promise.resolve(null),
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
        enforced: billing.enforced,
        purchasable: isStripeConfigured(context),
        packs: CREDIT_PACKS.filter((p) => p.isActive),

        /*
         * The plan LIST is static config, so it rides the session for free. Whether THIS user has a
         * subscription deliberately does not: that needs a Stripe API call, and `/api/me` runs on every
         * page load. It is resolved lazily by `/api/credits` when someone actually opens billing.
         */
        plans: SUBSCRIPTION_PLANS.filter((p) => p.isActive),

        /*
         * The PREMIUM model tier (§4.6.1). A hint for rendering the model toggle — the server re-derives
         * eligibility on every generation (`decidePremium`), so this can never grant premium by itself.
         * `available` is whether THIS user may currently pick it: they hold the minimum, or enforcement
         * is off (beta/local, where nobody is charged). Below the minimum the toggle renders locked with
         * the threshold shown, which is the whole point — it protects a fresh grant from a 2x model.
         */
        premium: (() => {
          const tier = getPremiumTier(context);

          /*
           * The STANDARD model, so the composer pill can name the model actually in use when premium is
           * off (§4.6.1). Guarded: a misconfigured provider must not take `/api/me` down — it is a
           * rendering hint, and the baked default is the honest fallback for what the model would be.
           */
          let standardModel: string;

          try {
            standardModel = getPlatformModel(context);
          } catch {
            standardModel = DEFAULT_MODEL;
          }

          return {
            model: tier.model,
            standardModel,
            minimumCredits: tier.minimumCredits,
            available: !billing.enforced || balance >= tier.minimumCredits,
          };
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
