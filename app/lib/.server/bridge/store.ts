/**
 * Unity Bridge persistence (SPEC §4.17, migration 0025) — paired devices, pairing handshakes, and the
 * durable record of bridge jobs.
 *
 * Only DURABLE facts live here. Presence, queues, parked polls and job handles are in-memory on the one
 * server instance (`relay.ts`, D5) — never persist a queue.
 *
 * Secrets: a device row holds only the SHA-256 hex of its token, a pairing only the hash of its secret.
 * Nothing in this module may log either. The tables have RLS enabled with NO policy (service-role only,
 * the `git_tokens` rule), so the Supabase twin uses the ADMIN client.
 *
 * Local mode: `FsBridgeStore` keeps three `FsJsonTable`s under `<platformDataDir>/bridge/`; a lookup by
 * anything other than id scans `all()` (the volumes are one developer's devices and jobs).
 */
import path from 'node:path';
import type { BridgeHello, BridgeJobStatus } from '~/lib/bridge/protocol';
import type { BridgeTier } from '~/lib/bridge/tiers';
import { platformDataDir } from '~/lib/.server/prompt/store';
import { FsJsonTable } from '~/lib/.server/projects/store';
import { createAdminClient, isSupabaseConfigured } from '~/lib/.server/supabase/client';

export interface BridgeDeviceRow {
  id: string;
  userId: string;
  name: string;
  os: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
  capabilities?: BridgeHello;
}

export interface BridgePairingRow {
  id: string;
  code: string;
  secretHash: string;
  deviceName: string;
  os: string;
  userId?: string;
  status: 'pending' | 'approved' | 'consumed';
  expiresAt: string;
  createdAt: string;
}

export interface BridgeJobRow {
  id: string;
  userId: string;
  projectId: string;
  deviceId: string;
  operation: string; // human label, e.g. "unity_command bt_export_level"
  tier: BridgeTier;
  status: BridgeJobStatus;
  credits: number;
  started: boolean;
  resultText?: string;
  error?: string;
  createdAt: string;
  finishedAt?: string;
  reportedAt?: string;
}

export interface BridgeStore {
  putDevice(row: BridgeDeviceRow): Promise<void>;
  getDevice(id: string): Promise<BridgeDeviceRow | null>;
  getDeviceByTokenHash(hash: string): Promise<BridgeDeviceRow | null>;
  listDevices(userId: string): Promise<BridgeDeviceRow[]>;
  putPairing(row: BridgePairingRow): Promise<void>;
  getPairing(id: string): Promise<BridgePairingRow | null>;
  findPendingPairingByCode(code: string, nowIso: string): Promise<BridgePairingRow | null>;
  putJob(row: BridgeJobRow): Promise<void>;
  getJob(id: string): Promise<BridgeJobRow | null>;
  listJobs(projectId: string, limit: number): Promise<BridgeJobRow[]>; // newest first
}

function isPendingAndLive(row: BridgePairingRow, code: string, nowIso: string): boolean {
  return row.code === code && row.status === 'pending' && Date.parse(row.expiresAt) > Date.parse(nowIso);
}

function newestFirst(a: BridgeJobRow, b: BridgeJobRow): number {
  const byTime = Date.parse(b.createdAt) - Date.parse(a.createdAt);

  // Same-millisecond jobs tie on the clock; the id's time prefix then random suffix keeps it deterministic.
  return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
}

/*
 * ---------------------------------------------------------------------------------------------
 * Filesystem store (local mode)
 * ---------------------------------------------------------------------------------------------
 */

export class FsBridgeStore implements BridgeStore {
  private readonly _devices: FsJsonTable<BridgeDeviceRow>;
  private readonly _pairings: FsJsonTable<BridgePairingRow>;
  private readonly _jobs: FsJsonTable<BridgeJobRow>;

  constructor(root: string = path.join(platformDataDir(), 'bridge')) {
    this._devices = new FsJsonTable<BridgeDeviceRow>(path.join(root, 'devices'));
    this._pairings = new FsJsonTable<BridgePairingRow>(path.join(root, 'pairings'));
    this._jobs = new FsJsonTable<BridgeJobRow>(path.join(root, 'jobs'));
  }

  async putDevice(row: BridgeDeviceRow): Promise<void> {
    await this._devices.put(row);
  }

  async getDevice(id: string): Promise<BridgeDeviceRow | null> {
    return this._devices.get(id);
  }

  async getDeviceByTokenHash(hash: string): Promise<BridgeDeviceRow | null> {
    return (await this._devices.all()).find((row) => row.tokenHash === hash) ?? null;
  }

  async listDevices(userId: string): Promise<BridgeDeviceRow[]> {
    return (await this._devices.all())
      .filter((row) => row.userId === userId)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  async putPairing(row: BridgePairingRow): Promise<void> {
    await this._pairings.put(row);
  }

  async getPairing(id: string): Promise<BridgePairingRow | null> {
    return this._pairings.get(id);
  }

  async findPendingPairingByCode(code: string, nowIso: string): Promise<BridgePairingRow | null> {
    return (await this._pairings.all()).find((row) => isPendingAndLive(row, code, nowIso)) ?? null;
  }

  async putJob(row: BridgeJobRow): Promise<void> {
    await this._jobs.put(row);
  }

  async getJob(id: string): Promise<BridgeJobRow | null> {
    return this._jobs.get(id);
  }

  async listJobs(projectId: string, limit: number): Promise<BridgeJobRow[]> {
    return (await this._jobs.all())
      .filter((row) => row.projectId === projectId)
      .sort(newestFirst)
      .slice(0, Math.max(0, limit));
  }
}

/*
 * ---------------------------------------------------------------------------------------------
 * Supabase store (service role — the tables have no RLS policy by design)
 * ---------------------------------------------------------------------------------------------
 */

type Row = Record<string, unknown>;

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

function deviceFromRow(row: Row): BridgeDeviceRow {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    os: row.os as string,
    tokenHash: row.token_hash as string,
    capabilities: (row.capabilities as BridgeHello | null) ?? undefined,
    createdAt: row.created_at as string,
    lastSeenAt: optionalString(row.last_seen_at),
    revokedAt: optionalString(row.revoked_at),
  };
}

function deviceToRow(row: BridgeDeviceRow): Row {
  return {
    id: row.id,
    user_id: row.userId,
    name: row.name,
    os: row.os,
    token_hash: row.tokenHash,
    capabilities: row.capabilities ?? null,
    created_at: row.createdAt,
    last_seen_at: row.lastSeenAt ?? null,
    revoked_at: row.revokedAt ?? null,
  };
}

function pairingFromRow(row: Row): BridgePairingRow {
  return {
    id: row.id as string,
    code: row.code as string,
    secretHash: row.secret_hash as string,
    deviceName: row.device_name as string,
    os: row.os as string,
    userId: optionalString(row.user_id),
    status: row.status as BridgePairingRow['status'],
    expiresAt: row.expires_at as string,
    createdAt: row.created_at as string,
  };
}

function pairingToRow(row: BridgePairingRow): Row {
  return {
    id: row.id,
    code: row.code,
    secret_hash: row.secretHash,
    device_name: row.deviceName,
    os: row.os,
    user_id: row.userId ?? null,
    status: row.status,
    expires_at: row.expiresAt,
    created_at: row.createdAt,
  };
}

function jobFromRow(row: Row): BridgeJobRow {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    projectId: row.project_id as string,
    deviceId: row.device_id as string,
    operation: row.operation as string,
    tier: row.tier as BridgeTier,
    status: row.status as BridgeJobStatus,
    credits: Number(row.credits ?? 0),
    started: Boolean(row.started),
    resultText: optionalString(row.result_text),
    error: optionalString(row.error),
    createdAt: row.created_at as string,
    finishedAt: optionalString(row.finished_at),
    reportedAt: optionalString(row.reported_at),
  };
}

function jobToRow(row: BridgeJobRow): Row {
  return {
    id: row.id,
    user_id: row.userId,
    project_id: row.projectId,
    device_id: row.deviceId,
    operation: row.operation,
    tier: row.tier,
    status: row.status,
    credits: row.credits,
    started: row.started,
    result_text: row.resultText ?? null,
    error: row.error ?? null,
    created_at: row.createdAt,
    finished_at: row.finishedAt ?? null,
    reported_at: row.reportedAt ?? null,
  };
}

export class SupabaseBridgeStore implements BridgeStore {
  constructor(private readonly _context: unknown) {}

  private async _upsert(table: string, row: Row): Promise<void> {
    const client = await createAdminClient(this._context);
    const { error } = await client.from(table).upsert(row, { onConflict: 'id' });

    if (error) {
      throw new Error(`Failed to write ${table}: ${error.message}`);
    }
  }

  private async _one(table: string, column: string, value: string): Promise<Row | null> {
    const client = await createAdminClient(this._context);
    const { data, error } = await client.from(table).select('*').eq(column, value).maybeSingle();

    if (error) {
      throw new Error(`Failed to read ${table}: ${error.message}`);
    }

    return (data as Row | null) ?? null;
  }

  async putDevice(row: BridgeDeviceRow): Promise<void> {
    await this._upsert('bridge_devices', deviceToRow(row));
  }

  async getDevice(id: string): Promise<BridgeDeviceRow | null> {
    const row = await this._one('bridge_devices', 'id', id);
    return row ? deviceFromRow(row) : null;
  }

  async getDeviceByTokenHash(hash: string): Promise<BridgeDeviceRow | null> {
    const row = await this._one('bridge_devices', 'token_hash', hash);
    return row ? deviceFromRow(row) : null;
  }

  async listDevices(userId: string): Promise<BridgeDeviceRow[]> {
    const client = await createAdminClient(this._context);
    const { data, error } = await client
      .from('bridge_devices')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to read bridge_devices: ${error.message}`);
    }

    return ((data as Row[] | null) ?? []).map(deviceFromRow);
  }

  async putPairing(row: BridgePairingRow): Promise<void> {
    await this._upsert('bridge_pairings', pairingToRow(row));
  }

  async getPairing(id: string): Promise<BridgePairingRow | null> {
    const row = await this._one('bridge_pairings', 'id', id);
    return row ? pairingFromRow(row) : null;
  }

  async findPendingPairingByCode(code: string, nowIso: string): Promise<BridgePairingRow | null> {
    const client = await createAdminClient(this._context);
    const { data, error } = await client
      .from('bridge_pairings')
      .select('*')
      .eq('code', code)
      .eq('status', 'pending')
      .gt('expires_at', nowIso)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) {
      throw new Error(`Failed to read bridge_pairings: ${error.message}`);
    }

    const row = ((data as Row[] | null) ?? [])[0];

    return row ? pairingFromRow(row) : null;
  }

  async putJob(row: BridgeJobRow): Promise<void> {
    await this._upsert('bridge_jobs', jobToRow(row));
  }

  async getJob(id: string): Promise<BridgeJobRow | null> {
    const row = await this._one('bridge_jobs', 'id', id);
    return row ? jobFromRow(row) : null;
  }

  async listJobs(projectId: string, limit: number): Promise<BridgeJobRow[]> {
    const client = await createAdminClient(this._context);
    const { data, error } = await client
      .from('bridge_jobs')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(Math.max(0, limit));

    if (error) {
      throw new Error(`Failed to read bridge_jobs: ${error.message}`);
    }

    return ((data as Row[] | null) ?? []).map(jobFromRow);
  }
}

let override: BridgeStore | null = null;

export function getBridgeStore(context: unknown): BridgeStore {
  return override ?? (isSupabaseConfigured(context) ? new SupabaseBridgeStore(context) : new FsBridgeStore());
}

/** Test seam, matching `setGitTokenStore`/`setProjectStore`. */
export function setBridgeStore(store: BridgeStore | null): void {
  override = store;
}
