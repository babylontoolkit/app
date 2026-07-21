/**
 * Unity Project License unlock records (SPEC §4.18) — one row per (user, unity project, tier) the user
 * has PAID to unlock, so "once per project+tier, re-download free" (owner decision 2026-07-20) holds.
 *
 * The first generation of a (unity project, tier) pair debits the flat credit price and calls `grant()`;
 * every later (re)generation of that same pair sees `has() === true` and is issued free. The unlock is
 * keyed to the UNITY project id (the productGUID the license is cryptographically locked to), NOT the App
 * Builder project — otherwise a user could re-link many Unity GUIDs to one App Builder project and mint
 * many perpetual licenses for a single payment.
 *
 * Same two-backend seam as `assets/entitlements.ts`, which this deliberately mirrors: Supabase in
 * production (idempotency enforced by the unique index in migration 0012), a local JSONL table in dev.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { platformDataDir } from '~/lib/.server/prompt/store';
import { isSupabaseConfigured, createAdminClient } from '~/lib/.server/supabase/client';
import type { UnityLicensePlan } from './unity-license';

export interface LicenseEntitlementStore {
  /** Has this user already paid to unlock this (unity project, tier)? */
  has(userId: string, unityProjectId: string, tier: UnityLicensePlan): Promise<boolean>;

  /** Record a paid unlock. Idempotent — returns false if it already existed (or a replay). */
  grant(
    userId: string,
    unityProjectId: string,
    tier: UnityLicensePlan,
    ledgerEntryId?: string,
  ): Promise<{ granted: boolean }>;

  /** Every tier this user has unlocked for a given unity project — drives the "unlocked" UI state. */
  listTiers(userId: string, unityProjectId: string): Promise<UnityLicensePlan[]>;
}

interface Row {
  userId: string;
  unityProjectId: string;
  tier: UnityLicensePlan;
  ledgerEntryId?: string;
  createdAt: string;
}

/*
 * ---------------------------------------------------------------------------------------------
 * Filesystem (dev / no-Supabase)
 * ---------------------------------------------------------------------------------------------
 */
class FsLicenseEntitlementStore implements LicenseEntitlementStore {
  private readonly _file: string;

  constructor(root?: string) {
    this._file = path.join(root ?? platformDataDir(), 'license_entitlements.jsonl');
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

  async has(userId: string, unityProjectId: string, tier: UnityLicensePlan): Promise<boolean> {
    return (await this._read()).some(
      (r) => r.userId === userId && r.unityProjectId === unityProjectId && r.tier === tier,
    );
  }

  async grant(
    userId: string,
    unityProjectId: string,
    tier: UnityLicensePlan,
    ledgerEntryId?: string,
  ): Promise<{ granted: boolean }> {
    const rows = await this._read();

    if (rows.some((r) => r.userId === userId && r.unityProjectId === unityProjectId && r.tier === tier)) {
      return { granted: false };
    }

    const row: Row = { userId, unityProjectId, tier, ledgerEntryId, createdAt: new Date().toISOString() };
    await fs.mkdir(path.dirname(this._file), { recursive: true });
    await fs.appendFile(this._file, `${JSON.stringify(row)}\n`);

    return { granted: true };
  }

  async listTiers(userId: string, unityProjectId: string): Promise<UnityLicensePlan[]> {
    return (await this._read())
      .filter((r) => r.userId === userId && r.unityProjectId === unityProjectId)
      .map((r) => r.tier);
  }
}

/*
 * ---------------------------------------------------------------------------------------------
 * Supabase (production)
 * ---------------------------------------------------------------------------------------------
 */
class SupabaseLicenseEntitlementStore implements LicenseEntitlementStore {
  constructor(private readonly _context?: unknown) {}

  private async _db() {
    return createAdminClient(this._context);
  }

  async has(userId: string, unityProjectId: string, tier: UnityLicensePlan): Promise<boolean> {
    const db = await this._db();
    const { data } = await db
      .from('unity_license_entitlements')
      .select('id')
      .eq('user_id', userId)
      .eq('unity_project_id', unityProjectId)
      .eq('tier', tier)
      .maybeSingle();

    return Boolean(data);
  }

  async grant(
    userId: string,
    unityProjectId: string,
    tier: UnityLicensePlan,
    ledgerEntryId?: string,
  ): Promise<{ granted: boolean }> {
    const db = await this._db();
    const { error } = await db.from('unity_license_entitlements').insert({
      user_id: userId,
      unity_project_id: unityProjectId,
      tier,
      ledger_entry_id: ledgerEntryId ?? null,
    });

    if (error) {
      // 23505 = unique violation → already unlocked / replayed. That is success, not failure.
      if (error.code === '23505') {
        return { granted: false };
      }

      throw new Error(`Failed to grant license entitlement: ${error.message}`);
    }

    return { granted: true };
  }

  async listTiers(userId: string, unityProjectId: string): Promise<UnityLicensePlan[]> {
    const db = await this._db();
    const { data } = await db
      .from('unity_license_entitlements')
      .select('tier')
      .eq('user_id', userId)
      .eq('unity_project_id', unityProjectId);

    return (data ?? []).map((r: { tier: UnityLicensePlan }) => r.tier);
  }
}

let _store: LicenseEntitlementStore | undefined;

export function getLicenseEntitlementStore(context?: unknown): LicenseEntitlementStore {
  if (!_store) {
    _store = isSupabaseConfigured(context)
      ? new SupabaseLicenseEntitlementStore(context)
      : new FsLicenseEntitlementStore();
  }

  return _store;
}

/** Test seam — reset the memoized store so a test can point at a temp dir / fresh backend. */
export function resetLicenseEntitlementStoreForTests(): void {
  _store = undefined;
}
