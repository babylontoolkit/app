/**
 * Premium store-asset ownership (SPEC §4.9).
 *
 * One row per (user, premium asset), granted by the Stripe webhook on a one-time purchase. The gate at
 * add-time (`decidePremiumAssetAdd`) reads `has()`; the webhook calls `grant()`. Same two-backend seam
 * as every other store — Supabase in production, a local JSONL table in dev — so the premium flow is
 * exercisable before any Stripe/Supabase account exists.
 *
 * Idempotency in production is enforced by the DATABASE (the unique indexes in migration 0005): `grant`
 * treats a unique-violation as "already owned", never an error, so a replayed webhook is a no-op. The FS
 * mirror re-implements the same check so dev behaves the same, but the DB is the real guard.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { platformDataDir } from '~/lib/.server/prompt/store';
import { isSupabaseConfigured, createAdminClient } from '~/lib/.server/supabase/client';

export interface AssetEntitlementStore {
  /** Does this user own this premium asset? */
  has(userId: string, assetId: string): Promise<boolean>;

  /** Grant ownership. Idempotent — returns false if the user already owned it (or a replay). */
  grant(userId: string, assetId: string, paymentRef?: string): Promise<{ granted: boolean }>;

  /** Every premium asset id this user owns — the catalog UI marks these as owned. */
  listByUser(userId: string): Promise<string[]>;
}

interface Row {
  userId: string;
  assetId: string;
  paymentRef?: string;
  createdAt: string;
}

/*
 * ---------------------------------------------------------------------------------------------
 * Filesystem (dev / no-Supabase)
 * ---------------------------------------------------------------------------------------------
 */
class FsAssetEntitlementStore implements AssetEntitlementStore {
  private readonly _file: string;

  constructor(root?: string) {
    this._file = path.join(root ?? platformDataDir(), 'asset_entitlements.jsonl');
  }

  private async _read(): Promise<Row[]> {
    try {
      const raw = await fs.readFile(this._file, 'utf8');

      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Row);
    } catch {
      return [];
    }
  }

  async has(userId: string, assetId: string): Promise<boolean> {
    return (await this._read()).some((r) => r.userId === userId && r.assetId === assetId);
  }

  async grant(userId: string, assetId: string, paymentRef?: string): Promise<{ granted: boolean }> {
    const rows = await this._read();

    // Idempotent on both keys the DB indexes: (user, asset) and payment_ref.
    if (
      rows.some((r) => (r.userId === userId && r.assetId === assetId) || (paymentRef && r.paymentRef === paymentRef))
    ) {
      return { granted: false };
    }

    const row: Row = { userId, assetId, paymentRef, createdAt: new Date().toISOString() };
    await fs.mkdir(path.dirname(this._file), { recursive: true });
    await fs.appendFile(this._file, `${JSON.stringify(row)}\n`);

    return { granted: true };
  }

  async listByUser(userId: string): Promise<string[]> {
    return (await this._read()).filter((r) => r.userId === userId).map((r) => r.assetId);
  }
}

/*
 * ---------------------------------------------------------------------------------------------
 * Supabase (production)
 * ---------------------------------------------------------------------------------------------
 */
class SupabaseAssetEntitlementStore implements AssetEntitlementStore {
  constructor(private readonly _context?: unknown) {}

  private async _db() {
    return createAdminClient(this._context);
  }

  async has(userId: string, assetId: string): Promise<boolean> {
    const db = await this._db();
    const { data } = await db
      .from('asset_entitlements')
      .select('id')
      .eq('user_id', userId)
      .eq('asset_id', assetId)
      .maybeSingle();

    return Boolean(data);
  }

  async grant(userId: string, assetId: string, paymentRef?: string): Promise<{ granted: boolean }> {
    const db = await this._db();
    const { error } = await db
      .from('asset_entitlements')
      .insert({ user_id: userId, asset_id: assetId, payment_ref: paymentRef ?? null });

    if (error) {
      // 23505 = unique violation → already owned / replayed delivery. That is success, not failure.
      if (error.code === '23505') {
        return { granted: false };
      }

      throw new Error(`Failed to grant asset entitlement: ${error.message}`);
    }

    return { granted: true };
  }

  async listByUser(userId: string): Promise<string[]> {
    const db = await this._db();
    const { data } = await db.from('asset_entitlements').select('asset_id').eq('user_id', userId);

    return (data ?? []).map((r: { asset_id: string }) => r.asset_id);
  }
}

let _store: AssetEntitlementStore | undefined;

export function getAssetEntitlementStore(context?: unknown): AssetEntitlementStore {
  if (!_store) {
    _store = isSupabaseConfigured(context) ? new SupabaseAssetEntitlementStore(context) : new FsAssetEntitlementStore();
  }

  return _store;
}

/** Test seam — reset the memoized store so a test can point at a temp dir / fresh backend. */
export function resetAssetEntitlementStoreForTests(): void {
  _store = undefined;
}
