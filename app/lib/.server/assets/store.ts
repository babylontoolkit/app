/**
 * User asset persistence (SPEC §4.9).
 *
 * Uploaded models/textures/audio: the BYTES live in object storage (per-user prefix, so the quota is a
 * prefix sum), and this row is the metadata plus the introspection summary the agent reads. Same
 * two-backend seam as the project store — Supabase in production, a local JSON table in dev — so the
 * assets tab is exercisable before any S3 account exists.
 *
 * Store-catalog assets (hosted scenes, prefabs, packs) are NOT here — they are static config
 * (`app/config/assets.json`). This table is only user uploads.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { platformDataDir } from '~/lib/.server/prompt/store';
import { getObjectStore, type ObjectStore } from '~/lib/.server/storage';
import { isSupabaseConfigured, createAdminClient } from '~/lib/.server/supabase/client';
import type { AssetKind } from './validate';

export interface UserAsset {
  id: string;
  userId: string;
  projectId?: string;
  filename: string;
  contentType: string;
  byteSize: number;
  storagePath: string;
  kind: AssetKind;

  /** The glTF component reference (§4.9), when the asset is a scene/prefab. Injected into agent context. */
  introspection?: string;
  createdAt: string;
}

export type NewUserAsset = Omit<UserAsset, 'id' | 'createdAt'>;

export interface UserAssetStore {
  create(asset: NewUserAsset, bytes: Uint8Array): Promise<UserAsset>;
  listByUser(userId: string): Promise<UserAsset[]>;
  listByProject(projectId: string): Promise<UserAsset[]>;
  get(id: string): Promise<UserAsset | null>;
  delete(id: string): Promise<void>;

  /** Total bytes this user stores — the quota check reads this before an upload (§4.9). */
  bytesUsedBy(userId: string): Promise<number>;
}

function newId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14);
  return `ast_${stamp}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Per-user object-store prefix — makes the quota a prefix sum and keeps one user's assets together. */
export function assetKey(userId: string, assetId: string, extension: string): string {
  return `assets/${userId}/${assetId}.${extension}`;
}

/*
 * ---------------------------------------------------------------------------------------------
 * Filesystem
 * -------------------------------------------------------------------------------------------
 */

class FsUserAssetStore implements UserAssetStore {
  private readonly _dir: string;
  private readonly _objects: ObjectStore;

  constructor(objects?: ObjectStore, root?: string) {
    this._dir = root ?? path.join(platformDataDir(), 'user_assets');
    this._objects = objects ?? getObjectStore();
  }

  private _file(id: string): string {
    if (id.includes('/') || id.includes('\\') || id.includes('..')) {
      throw new Error(`Invalid asset id: ${id}`);
    }

    return path.join(this._dir, `${id}.json`);
  }

  async create(asset: NewUserAsset, bytes: Uint8Array): Promise<UserAsset> {
    await fs.mkdir(this._dir, { recursive: true });
    await this._objects.put(asset.storagePath, bytes, asset.contentType);

    const row: UserAsset = { ...asset, id: newId(), createdAt: new Date().toISOString() };
    await fs.writeFile(this._file(row.id), JSON.stringify(row, null, 2), 'utf8');

    return row;
  }

  private async _all(): Promise<UserAsset[]> {
    let names: string[];

    try {
      names = await fs.readdir(this._dir);
    } catch {
      return [];
    }

    const rows: UserAsset[] = [];

    for (const name of names.filter((n) => n.endsWith('.json'))) {
      try {
        rows.push(JSON.parse(await fs.readFile(path.join(this._dir, name), 'utf8')) as UserAsset);
      } catch {
        // skip
      }
    }

    return rows;
  }

  async listByUser(userId: string): Promise<UserAsset[]> {
    return (await this._all())
      .filter((a) => a.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listByProject(projectId: string): Promise<UserAsset[]> {
    return (await this._all()).filter((a) => a.projectId === projectId);
  }

  async get(id: string): Promise<UserAsset | null> {
    try {
      return JSON.parse(await fs.readFile(this._file(id), 'utf8')) as UserAsset;
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<void> {
    const row = await this.get(id);

    if (row) {
      await this._objects.delete(row.storagePath);
    }

    try {
      await fs.unlink(this._file(id));
    } catch {
      // already gone
    }
  }

  async bytesUsedBy(userId: string): Promise<number> {
    return (await this.listByUser(userId)).reduce((sum, a) => sum + a.byteSize, 0);
  }
}

/*
 * ---------------------------------------------------------------------------------------------
 * Supabase
 * -------------------------------------------------------------------------------------------
 */

function rowToAsset(row: Record<string, any>): UserAsset {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id ?? undefined,
    filename: row.filename,
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    storagePath: row.storage_path,
    kind: row.kind,
    introspection: row.introspection ?? undefined,
    createdAt: row.created_at,
  };
}

class SupabaseUserAssetStore implements UserAssetStore {
  private readonly _objects: ObjectStore;

  constructor(
    private readonly _context?: unknown,
    objects?: ObjectStore,
  ) {
    this._objects = objects ?? getObjectStore(_context);
  }

  private async _db() {
    return createAdminClient(this._context);
  }

  async create(asset: NewUserAsset, bytes: Uint8Array): Promise<UserAsset> {
    await this._objects.put(asset.storagePath, bytes, asset.contentType);

    const db = await this._db();
    const { data, error } = await db
      .from('user_assets')
      .insert({
        user_id: asset.userId,
        project_id: asset.projectId ?? null,
        filename: asset.filename,
        content_type: asset.contentType,
        byte_size: asset.byteSize,
        storage_path: asset.storagePath,
        kind: asset.kind,
        introspection: asset.introspection ?? null,
      })
      .select()
      .single();

    if (error) {
      await this._objects.delete(asset.storagePath);
      throw new Error(`Failed to record asset: ${error.message}`);
    }

    return rowToAsset(data);
  }

  async listByUser(userId: string): Promise<UserAsset[]> {
    const db = await this._db();
    const { data } = await db
      .from('user_assets')
      .select()
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    return (data ?? []).map(rowToAsset);
  }

  async listByProject(projectId: string): Promise<UserAsset[]> {
    const db = await this._db();
    const { data } = await db.from('user_assets').select().eq('project_id', projectId);

    return (data ?? []).map(rowToAsset);
  }

  async get(id: string): Promise<UserAsset | null> {
    const db = await this._db();
    const { data } = await db.from('user_assets').select().eq('id', id).maybeSingle();

    return data ? rowToAsset(data) : null;
  }

  async delete(id: string): Promise<void> {
    const row = await this.get(id);

    if (row) {
      await this._objects.delete(row.storagePath);
    }

    const db = await this._db();
    await db.from('user_assets').delete().eq('id', id);
  }

  async bytesUsedBy(userId: string): Promise<number> {
    const db = await this._db();
    const { data } = await db.from('user_assets').select('byte_size').eq('user_id', userId);

    return (data ?? []).reduce((sum, r: { byte_size: number }) => sum + Number(r.byte_size), 0);
  }
}

let _store: UserAssetStore | undefined;

export function getUserAssetStore(context?: unknown): UserAssetStore {
  if (!_store) {
    _store = isSupabaseConfigured(context) ? new SupabaseUserAssetStore(context) : new FsUserAssetStore();
  }

  return _store;
}

export function setUserAssetStore(store: UserAssetStore | undefined) {
  _store = store;
}
