/**
 * Unity Project Licenser — tier mapping + license assembly (SPEC §4.18).
 *
 * Pure, server-only functions that turn a Stripe subscription plan id + the linked Unity project
 * into a `license.json` object byte-compatible with the unchanged `licenser.cs` validator shipped in
 * the Unity Exporter plugin. Nothing here touches the network, the ledger, or a client bundle — the
 * only side channel is the crypto core (`unity-license-crypto.ts`, also `.server/`).
 *
 * Tier authority is the CURRENT Stripe plan (resolved live by the route, never cached), mapped by
 * `licenseTierForPlan`. There is no paid-tier fallback: anything we don't recognise — including a
 * missing/unreachable subscription — degrades to Indie, so an outage can never fabricate a paid tier.
 *
 * The seat fields `s1`/`s2` live OUTSIDE the encrypted `secret` and the `key` hash (see `licenser.cs`),
 * so a user hand-editing seat emails into the file inside their Unity project never invalidates the
 * license — that is why SmallBusiness ships blank seats and Studio ships "unlimited".
 */
import { computeProjectLicenseKeyHash, encryptLicenseSecret } from './unity-license-crypto';

/** The three plan names the Unity plugin's `IsPro()`/seat logic understands (of the ones we issue). */
export type UnityLicensePlan = 'Indie' | 'SmallBusiness' | 'PremiumContent';

/** The plans, cheapest-first — the order the tier ladder is offered in the UI. */
export const UNITY_LICENSE_PLANS: readonly UnityLicensePlan[] = ['Indie', 'SmallBusiness', 'PremiumContent'];

/**
 * User-facing labels. The plan STRING (`PremiumContent`) is a byte-compat constraint with `licenser.cs`
 * and must never change; "Enterprise Studio" is only what the dialog shows for it (owner naming).
 */
export const UNITY_LICENSE_PLAN_LABELS: Record<UnityLicensePlan, string> = {
  Indie: 'Indie',
  SmallBusiness: 'Small Business',
  PremiumContent: 'Enterprise Studio',
};

/** Narrow an arbitrary string to a known plan — the picker input is validated through this. */
export function isValidLicenseTier(tier: unknown): tier is UnityLicensePlan {
  return tier === 'Indie' || tier === 'SmallBusiness' || tier === 'PremiumContent';
}

/** The tier a plan resolves to: the Unity plan name plus its two seat values. */
export interface UnityLicenseTier {
  plan: UnityLicensePlan;
  s1: string;
  s2: string;
}

/**
 * The `license.json` object — field-for-field the shape `licenser.cs`'s `License` class deserializes
 * (`{ licensee, product, project, secret, trial, plan, org, key, s1, s2 }`). `expires` is carried for
 * documentation; the validator reads the expiry from inside the `secret` payload, not this field, and
 * an extra JSON field is ignored by Unity's `JsonUtility`.
 */
export interface UnityLicense {
  licensee: string;
  product: string;
  project: string;
  secret: string;
  trial: boolean;
  plan: UnityLicensePlan;
  org: string;
  key: string;
  s1: string;
  s2: string;
  expires: string;
}

/** Inputs to `buildUnityLicense` — all server-derived; nothing here is client-supplied verbatim. */
export interface BuildUnityLicenseInput {
  /** The chosen license tier (the paid §4.18 selection), validated via `isValidLicenseTier`. */
  plan: UnityLicensePlan;

  /** The authenticated platform user's email (Supabase-verified). */
  licensee: string;

  /** The linked Unity project id — `PlayerSettings.productGUID`, 32 hex chars. */
  unityProjectId: string;

  /** The App Builder project name (display/free text). */
  projectName: string;
}

/** Every license we issue is perpetual for its project (owner decision). */
const EXPIRES = 'never';

/** Organizations are never checked — `*` matches any org in `licenser.cs`'s `IsOrganization()`. */
const ORG = '*';

/**
 * The seat values for a chosen plan. Never throws — an unrecognised value degrades to Indie.
 *
 * Tier is now a paid SELECTION (the §4.18 credit price ladder), no longer derived from a Stripe
 * subscription. Seats live OUTSIDE the encrypted secret and the key hash, so shipping them here is safe
 * and user-editable after the fact:
 * - `SmallBusiness` → two blank, editable seats.
 * - `PremiumContent` → unlimited (unchecked) seats.
 * - `Indie` / anything unrecognised → locked seats.
 */
export function tierForPlanName(plan: UnityLicensePlan): UnityLicenseTier {
  switch (plan) {
    case 'SmallBusiness':
      return { plan: 'SmallBusiness', s1: '', s2: '' };
    case 'PremiumContent':
      return { plan: 'PremiumContent', s1: 'unlimited', s2: 'unlimited' };
    default:
      return { plan: 'Indie', s1: 'locked', s2: 'locked' };
  }
}

/**
 * True iff `id` is a plausible Unity project GUID: exactly 32 hexadecimal characters (case-insensitive;
 * surrounding whitespace tolerated). This is the shape of `PlayerSettings.productGUID`.
 */
export function isValidUnityProjectId(id: string): boolean {
  return typeof id === 'string' && /^[0-9a-f]{32}$/i.test(id.trim());
}

/**
 * Assemble a full `license.json` object from the plan + linked project. Pure and non-throwing —
 * the caller (route) is responsible for having validated `unityProjectId` via `isValidUnityProjectId`.
 *
 * The Unity project id is normalised to lowercase so `product` and the `key` seed match the plugin's
 * lowercased `productGUID`. The `secret` payload is `plan|licensee|org|product|project|expires`; the
 * `key` is `hash(plan + "-" + productGUID)`, which locks the license to that one Unity project.
 */
export function buildUnityLicense({
  plan,
  licensee,
  unityProjectId,
  projectName,
}: BuildUnityLicenseInput): UnityLicense {
  const tier = tierForPlanName(plan);
  const product = unityProjectId.trim().toLowerCase();
  const secret = encryptLicenseSecret(`${tier.plan}|${licensee}|${ORG}|${product}|${projectName}|${EXPIRES}`);
  const key = computeProjectLicenseKeyHash(`${tier.plan}-${product}`);

  return {
    licensee,
    product,
    project: projectName,
    secret,
    trial: false,
    plan: tier.plan,
    org: ORG,
    key,
    s1: tier.s1,
    s2: tier.s2,
    expires: EXPIRES,
  };
}
