/**
 * Pro Tools entitlements (SPEC §4.6.1, §4.5.4 point 6).
 *
 * **Pro gates EXACTLY ONE thing: BYOK + model selection. Nothing else, ever.** Export, GitHub Sync,
 * share, gallery, MCP, game backends — every other feature is available to every user. A user's
 * project is never held hostage.
 *
 * **This module performs NO network validation.** The external license service (`licenser.asmx`) was
 * retired (§4.18); the business is credits-based and Pro/BYOK is disabled by default and
 * manual/testing-only from here. `getEntitlement` simply reads the stored row — an entitlement is
 * seeded out-of-band (admin/testing) and never revalidated against a remote authority, so there is no
 * outage that could lapse anyone and no grace window to hold.
 *
 * The one load-bearing rule that remains: **BYOK is honored only with an active, server-verified
 * entitlement.** A client can send an API key and a `byok: true` flag all it likes; `resolveByok()` is
 * what decides, and it reads the entitlement from our own store. Without one (the shipping default),
 * the build quietly uses platform credits — never an error, never a blocked build.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { platformDataDir } from '~/lib/.server/prompt/store';
import { getPlatformConfig } from '~/lib/.server/agent/config';
import { createAdminClient, isSupabaseConfigured } from '~/lib/.server/supabase/client';

/**
 * The Pro tier an entitlement grants. Formerly sourced from the license-service client; now a plain
 * local type since that client is retired (§4.18).
 */
export type EntitlementTier = 'indie' | 'small_business' | 'enterprise';

export interface Entitlement {
  userId: string;
  source: 'protools_subscription';
  tier?: EntitlementTier;
  status: 'active' | 'lapsed';

  /** The email the entitlement was recorded against — often NOT their platform email (§4.6.1). */
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
 * The stored entitlement, or null. **No revalidation** — the license service is retired (§4.18), so
 * this is a plain store read. Whatever was recorded (manually / by an admin / in testing) is what the
 * user has.
 */
export async function getEntitlement(userId: string, context?: unknown): Promise<Entitlement | null> {
  return getEntitlementStore(context).get(userId);
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
 * 2. An active, server-verified entitlement — or local dev, where every caller is treated as the
 *    verified local developer.
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

  // Local development has no entitlement to read (§4.6.1) — the local developer is treated as Pro.
  if (input.isLocal) {
    return { allowed: true, tier: 'enterprise' };
  }

  const entitlement = await getEntitlement(input.userId, input.context);

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
