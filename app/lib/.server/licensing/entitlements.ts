/**
 * Pro Tools entitlements (SPEC §4.6.1, §4.5.4 point 6).
 *
 * **Pro gates EXACTLY ONE thing: BYOK + model selection. Nothing else, ever.** Export, GitHub Sync,
 * share, gallery, MCP, game backends — every other feature is available to every user. A user's
 * project is never held hostage.
 *
 * Two rules do the load-bearing work here:
 *
 * 1. **BYOK is honored only with a server-verified active entitlement.** A client can send an API key
 *    and a `byok: true` flag all it likes; `resolveByok()` is what decides, and it reads the
 *    entitlement from our own store. A lapsed subscriber silently falls back to credits with a
 *    friendly notice — never an error, never a blocked build.
 *
 * 2. **Our outage must never punish a subscriber.** If the license service is unreachable we do NOT
 *    lapse anyone for 72 hours. The failure mode of a validation call is "no change", not "revoke".
 */
import { createScopedLogger } from '~/utils/logger';
import fs from 'node:fs/promises';
import path from 'node:path';
import { platformDataDir } from '~/lib/.server/prompt/store';
import { getPlatformConfig } from '~/lib/.server/agent/config';
import { createAdminClient, isSupabaseConfigured } from '~/lib/.server/supabase/client';
import { validateSubscription, type EntitlementTier } from './licenser';

const logger = createScopedLogger('entitlements');

/** Revalidate an active entitlement at most this often (§4.6.1: the service never sees per-generation traffic). */
const REVALIDATE_AFTER_MS = 24 * 60 * 60 * 1000;

/** How long a validation-service outage may last before it can lapse anyone. Our outage, our problem. */
const UNREACHABLE_GRACE_MS = 72 * 60 * 60 * 1000;

export interface Entitlement {
  userId: string;
  source: 'protools_subscription';
  tier?: EntitlementTier;
  status: 'active' | 'lapsed';

  /** The email the license service knows them by — often NOT their platform email (§4.6.1). */
  subscriberEmail: string;

  lastValidatedAt: string;
  expiresAt?: string;
}

export interface EntitlementStore {
  get(userId: string): Promise<Entitlement | null>;
  put(entitlement: Entitlement): Promise<void>;
}

class FsEntitlementStore implements EntitlementStore {
  private readonly _dir = path.join(platformDataDir(), 'entitlements');

  private _file(userId: string) {
    return path.join(this._dir, `${userId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  }

  async get(userId: string): Promise<Entitlement | null> {
    try {
      return JSON.parse(await fs.readFile(this._file(userId), 'utf8')) as Entitlement;
    } catch {
      return null;
    }
  }

  async put(entitlement: Entitlement): Promise<void> {
    await fs.mkdir(this._dir, { recursive: true });
    await fs.writeFile(this._file(entitlement.userId), JSON.stringify(entitlement, null, 2), 'utf8');
  }
}

class SupabaseEntitlementStore implements EntitlementStore {
  constructor(private readonly _context?: unknown) {}

  async get(userId: string): Promise<Entitlement | null> {
    const db = await createAdminClient(this._context);
    const { data } = await db.from('entitlements').select().eq('user_id', userId).maybeSingle();

    if (!data) {
      return null;
    }

    return {
      userId: data.user_id,
      source: data.source,
      tier: data.tier ?? undefined,
      status: data.status,
      subscriberEmail: data.subscriber_email,
      lastValidatedAt: data.last_validated_at,
      expiresAt: data.expires_at ?? undefined,
    };
  }

  async put(entitlement: Entitlement): Promise<void> {
    const db = await createAdminClient(this._context);

    await db.from('entitlements').upsert(
      {
        user_id: entitlement.userId,
        source: entitlement.source,
        tier: entitlement.tier ?? null,
        status: entitlement.status,
        subscriber_email: entitlement.subscriberEmail,
        last_validated_at: entitlement.lastValidatedAt,
        expires_at: entitlement.expiresAt ?? null,
      },
      { onConflict: 'user_id' },
    );
  }
}

let _store: EntitlementStore | undefined;

export function getEntitlementStore(context?: unknown): EntitlementStore {
  if (!_store) {
    _store = isSupabaseConfigured(context) ? new SupabaseEntitlementStore(context) : new FsEntitlementStore();
  }

  return _store;
}

/** Test seam. */
export function setEntitlementStore(store: EntitlementStore | undefined) {
  _store = store;
}

/**
 * Validate against the license service and upsert the entitlement.
 *
 * Called on sign-in and at most every 24h thereafter — never per generation.
 */
export async function refreshEntitlement(
  userId: string,
  email: string,
  context?: unknown,
): Promise<Entitlement | null> {
  const store = getEntitlementStore(context);
  const existing = await store.get(userId);
  const subscriberEmail = existing?.subscriberEmail || email;

  const result = await validateSubscription(subscriberEmail, context);

  /*
   * THE GRACE WINDOW. The service is down — we learned nothing, so we change nothing. Lapsing a
   * subscriber here would mean a blip in OUR infrastructure revokes a benefit they paid for. Only
   * after 72 hours of continuous unreachability do we accept that the silence might be real.
   */
  if (result.unreachable) {
    if (!existing) {
      return null;
    }

    const age = Date.now() - new Date(existing.lastValidatedAt).getTime();

    if (age < UNREACHABLE_GRACE_MS) {
      logger.warn(`License service unreachable; holding ${userId}'s entitlement (${Math.round(age / 3600_000)}h old)`);
      return existing;
    }

    logger.warn(`License service unreachable beyond the ${UNREACHABLE_GRACE_MS / 3600_000}h grace — lapsing ${userId}`);

    const lapsed: Entitlement = { ...existing, status: 'lapsed' };
    await store.put(lapsed);

    return lapsed;
  }

  const entitlement: Entitlement = {
    userId,
    source: 'protools_subscription',
    tier: result.tier,
    status: result.active ? 'active' : 'lapsed',
    subscriberEmail,
    lastValidatedAt: new Date().toISOString(),
    expiresAt: result.expiresAt,
  };

  await store.put(entitlement);

  return entitlement;
}

/** The cached entitlement, revalidated if stale. */
export async function getEntitlement(userId: string, email: string, context?: unknown): Promise<Entitlement | null> {
  const existing = await getEntitlementStore(context).get(userId);

  if (!existing) {
    return refreshEntitlement(userId, email, context);
  }

  const age = Date.now() - new Date(existing.lastValidatedAt).getTime();

  if (age > REVALIDATE_AFTER_MS) {
    return refreshEntitlement(userId, email, context);
  }

  return existing;
}

/**
 * Link a subscription whose email differs from the platform email (§4.6.1).
 *
 * This WILL be a support path — the email someone subscribed with is very often not the one they
 * signed up here with. It is self-serve on purpose: the proof is that the license service itself
 * confirms the supplied address is an active subscriber. We are not deciding who is a subscriber; we
 * are asking the authority and recording its answer.
 */
export async function linkSubscriberEmail(
  userId: string,
  subscriberEmail: string,
  context?: unknown,
): Promise<{ linked: boolean; message: string; entitlement?: Entitlement }> {
  const result = await validateSubscription(subscriberEmail, context);

  if (result.unreachable) {
    return { linked: false, message: 'The license service is temporarily unavailable. Please try again shortly.' };
  }

  if (!result.active) {
    return { linked: false, message: 'No active Pro Tools subscription was found for that email address.' };
  }

  const entitlement: Entitlement = {
    userId,
    source: 'protools_subscription',
    tier: result.tier,
    status: 'active',
    subscriberEmail,
    lastValidatedAt: new Date().toISOString(),
    expiresAt: result.expiresAt,
  };

  await getEntitlementStore(context).put(entitlement);
  logger.info(`Linked Pro entitlement for ${userId} via ${subscriberEmail} (${result.tier})`);

  return { linked: true, message: 'Pro Tools subscription linked. BYOK is now unlocked.', entitlement };
}

export interface ByokDecision {
  /** The ONLY thing that may switch the proxy onto a user-supplied key. */
  allowed: boolean;

  /** Rendered as a friendly notice when a Pro user's subscription has lapsed mid-session. */
  notice?: string;
  tier?: EntitlementTier;
}

/**
 * May this user's own API key be used for this generation? (§4.6.1)
 *
 * The single decision point. Three gates, ALL of which must pass, and none of which the client
 * controls:
 *
 * 1. `PRO_FEATURES_ENABLED` — the master switch. Off (the shipping default) means no BYOK for anyone,
 *    and the UI contains no provider machinery at all.
 * 2. An active, server-verified entitlement — or local dev, where there is no license service to ask.
 * 3. The user actually supplied a key.
 */
export async function resolveByok(input: {
  userId: string;
  email: string;
  isLocal?: boolean;
  hasKey: boolean;
  context?: unknown;
}): Promise<ByokDecision> {
  const config = getPlatformConfig(input.context);

  if (!config.proFeaturesEnabled || !input.hasKey) {
    return { allowed: false };
  }

  // Local development bypasses the license call (§4.6.1) — there is no subscriber to validate.
  if (input.isLocal) {
    return { allowed: true, tier: 'enterprise' };
  }

  const entitlement = await getEntitlement(input.userId, input.email, input.context);

  if (entitlement?.status === 'active') {
    return { allowed: true, tier: entitlement.tier };
  }

  if (entitlement?.status === 'lapsed') {
    return {
      allowed: false,
      notice: 'Your Pro Tools subscription has lapsed, so this build used platform credits. Renew to re-enable BYOK.',
    };
  }

  return { allowed: false };
}
