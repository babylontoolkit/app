/**
 * Project + snapshot persistence (SPEC §4.5.5).
 *
 * Two backends behind one interface, chosen by whether Supabase is configured — the same seam the
 * prompt and skill stores use. The filesystem implementation is not a mock: it enforces the same
 * ownership semantics and the same byte-faithful payload format, so restore, retry and share are
 * fully exercisable in local development.
 *
 * The snapshot PAYLOAD always goes through `ObjectStore` regardless of backend. Bytes never live in
 * a database row: a project with a few GLB models would blow past Postgres row limits, and Supabase
 * is not a CDN.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '~/utils/logger';
import { platformDataDir } from '~/lib/.server/prompt/store';
import { getObjectStore, type ObjectStore } from '~/lib/.server/storage';
import { isSupabaseConfigured, createAdminClient } from '~/lib/.server/supabase/client';
import type {
  ManifestEntry,
  NewProject,
  Project,
  ProjectStore,
  Snapshot,
  SnapshotPayload,
  SnapshotStore,
} from './types';

const logger = createScopedLogger('projects');

function newId(prefix: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14);
  return `${prefix}_${stamp}_${Math.random().toString(36).slice(2, 10)}`;
}

/** The manifest is derived, never supplied — a client-declared size could lie about what it stored. */
export function buildManifest(files: SnapshotPayload): ManifestEntry[] {
  const manifest: ManifestEntry[] = [];

  for (const [filePath, dirent] of Object.entries(files)) {
    if (dirent?.type !== 'file') {
      continue;
    }

    manifest.push({
      path: filePath,
      isBinary: dirent.isBinary,

      /*
       * For binaries `content` is base64, so its length is ~4/3 of the real byte count; `size` carries
       * the true value. Reporting the base64 length as the file size would make every restore
       * integrity check disagree with the bytes on disk.
       */
      size: dirent.size ?? dirent.content.length,
    });
  }

  return manifest.sort((a, b) => a.path.localeCompare(b.path));
}

function snapshotKey(projectId: string, snapshotId: string): string {
  return `snapshots/${projectId}/${snapshotId}.json`;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/*
 * ---------------------------------------------------------------------------------------------
 * Filesystem
 * ---------------------------------------------------------------------------------------------
 */

class FsJsonTable<T extends { id: string }> {
  constructor(private readonly _dir: string) {}

  private _file(id: string) {
    // Ids are server-minted, but a table is a filesystem path — never let one contain a separator.
    if (id.includes('/') || id.includes('\\') || id.includes('..')) {
      throw new Error(`Invalid id: ${id}`);
    }

    return path.join(this._dir, `${id}.json`);
  }

  async put(row: T): Promise<void> {
    await fs.mkdir(this._dir, { recursive: true });

    const file = this._file(row.id);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(row, null, 2), 'utf8');
    await fs.rename(tmp, file);
  }

  async get(id: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(this._file(id), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  async all(): Promise<T[]> {
    let names: string[];

    try {
      names = await fs.readdir(this._dir);
    } catch {
      return [];
    }

    const rows: T[] = [];

    for (const name of names.filter((n) => n.endsWith('.json'))) {
      const row = await this.get(name.replace(/\.json$/, ''));

      if (row) {
        rows.push(row);
      }
    }

    return rows;
  }

  async remove(id: string): Promise<void> {
    try {
      await fs.unlink(this._file(id));
    } catch {
      // Already gone is fine.
    }
  }
}

export class FsProjectStore implements ProjectStore {
  private readonly _table: FsJsonTable<Project>;

  constructor(root?: string) {
    this._table = new FsJsonTable<Project>(root ?? path.join(platformDataDir(), 'projects'));
  }

  async create(project: NewProject): Promise<Project> {
    const now = new Date().toISOString();
    const row: Project = { ...project, id: newId('prj'), createdAt: now, updatedAt: now };
    await this._table.put(row);

    return row;
  }

  async get(id: string): Promise<Project | null> {
    return this._table.get(id);
  }

  async listByUser(userId: string): Promise<Project[]> {
    const rows = await this._table.all();

    return rows.filter((p) => p.userId === userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async update(id: string, patch: Partial<Omit<Project, 'id' | 'userId' | 'createdAt'>>): Promise<Project> {
    const existing = await this._table.get(id);

    if (!existing) {
      throw new Error(`Project not found: ${id}`);
    }

    const row: Project = { ...existing, ...patch, id: existing.id, updatedAt: new Date().toISOString() };
    await this._table.put(row);

    return row;
  }

  async delete(id: string): Promise<void> {
    await this._table.remove(id);
  }

  async getByShareId(shareId: string): Promise<Project | null> {
    const rows = await this._table.all();

    return rows.find((p) => p.shareId === shareId) ?? null;
  }
}

export class FsSnapshotStore implements SnapshotStore {
  private readonly _table: FsJsonTable<Snapshot>;
  private readonly _objects: ObjectStore;

  constructor(objects?: ObjectStore, root?: string) {
    this._table = new FsJsonTable<Snapshot>(root ?? path.join(platformDataDir(), 'snapshots'));
    this._objects = objects ?? getObjectStore();
  }

  async create(input: { projectId: string; files: SnapshotPayload; messageId?: string; label?: string }) {
    const id = newId('snp');
    const storagePath = snapshotKey(input.projectId, id);

    await this._objects.put(storagePath, encoder.encode(JSON.stringify(input.files)), 'application/json');

    const row: Snapshot = {
      id,
      projectId: input.projectId,
      storagePath,
      fileManifest: buildManifest(input.files),
      messageId: input.messageId,
      label: input.label,
      createdAt: new Date().toISOString(),
    };
    await this._table.put(row);

    return row;
  }

  async get(id: string): Promise<Snapshot | null> {
    return this._table.get(id);
  }

  async read(id: string): Promise<SnapshotPayload | null> {
    const row = await this._table.get(id);

    if (!row) {
      return null;
    }

    const bytes = await this._objects.get(row.storagePath);

    if (!bytes) {
      logger.error(`Snapshot ${id} has a row but no payload at ${row.storagePath}`);
      return null;
    }

    return JSON.parse(decoder.decode(bytes)) as SnapshotPayload;
  }

  async listByProject(projectId: string): Promise<Snapshot[]> {
    const rows = await this._table.all();

    return rows.filter((s) => s.projectId === projectId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async deleteByProject(projectId: string): Promise<void> {
    for (const row of await this.listByProject(projectId)) {
      await this._objects.delete(row.storagePath);
      await this._table.remove(row.id);
    }
  }
}

/*
 * ---------------------------------------------------------------------------------------------
 * Supabase
 * ---------------------------------------------------------------------------------------------
 */

/**
 * Column mapping. Postgres is snake_case, the domain type is camelCase, and doing this by hand in
 * one place beats an ORM that would have to understand RLS.
 */
function rowToProject(row: Record<string, any>): Project {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    templateId: row.template_id,
    shareId: row.share_id ?? undefined,
    currentSnapshotId: row.current_snapshot_id ?? undefined,
    linkedRepo: row.linked_repo ?? undefined,
    linkedBranch: row.linked_branch ?? undefined,
    lastSyncedCommitSha: row.last_synced_commit_sha ?? undefined,
    githubInstallationRef: row.github_installation_ref ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectToRow(project: Partial<Project>): Record<string, any> {
  const row: Record<string, any> = {};
  const map: Record<string, string> = {
    userId: 'user_id',
    name: 'name',
    templateId: 'template_id',
    shareId: 'share_id',
    currentSnapshotId: 'current_snapshot_id',
    linkedRepo: 'linked_repo',
    linkedBranch: 'linked_branch',
    lastSyncedCommitSha: 'last_synced_commit_sha',
    githubInstallationRef: 'github_installation_ref',
  };

  for (const [key, column] of Object.entries(map)) {
    if (key in project) {
      row[column] = (project as Record<string, any>)[key] ?? null;
    }
  }

  return row;
}

export class SupabaseProjectStore implements ProjectStore {
  constructor(private readonly _context?: unknown) {}

  private async _db() {
    return createAdminClient(this._context);
  }

  async create(project: NewProject): Promise<Project> {
    const db = await this._db();
    const { data, error } = await db.from('projects').insert(projectToRow(project)).select().single();

    if (error) {
      throw new Error(`Failed to create project: ${error.message}`);
    }

    return rowToProject(data);
  }

  async get(id: string): Promise<Project | null> {
    const db = await this._db();
    const { data } = await db.from('projects').select().eq('id', id).maybeSingle();

    return data ? rowToProject(data) : null;
  }

  async listByUser(userId: string): Promise<Project[]> {
    const db = await this._db();
    const { data } = await db.from('projects').select().eq('user_id', userId).order('updated_at', { ascending: false });

    return (data ?? []).map(rowToProject);
  }

  async update(id: string, patch: Partial<Omit<Project, 'id' | 'userId' | 'createdAt'>>): Promise<Project> {
    const db = await this._db();
    const { data, error } = await db
      .from('projects')
      .update({ ...projectToRow(patch), updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update project: ${error.message}`);
    }

    return rowToProject(data);
  }

  async delete(id: string): Promise<void> {
    const db = await this._db();
    await db.from('projects').delete().eq('id', id);
  }

  async getByShareId(shareId: string): Promise<Project | null> {
    const db = await this._db();
    const { data } = await db.from('projects').select().eq('share_id', shareId).maybeSingle();

    return data ? rowToProject(data) : null;
  }
}

function rowToSnapshot(row: Record<string, any>): Snapshot {
  return {
    id: row.id,
    projectId: row.project_id,
    storagePath: row.storage_path,
    fileManifest: (row.file_manifest ?? []) as ManifestEntry[],
    messageId: row.message_id ?? undefined,
    label: row.label ?? undefined,
    createdAt: row.created_at,
  };
}

export class SupabaseSnapshotStore implements SnapshotStore {
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

  async create(input: { projectId: string; files: SnapshotPayload; messageId?: string; label?: string }) {
    const db = await this._db();
    const id = newId('snp');
    const storagePath = snapshotKey(input.projectId, id);

    /*
     * Object first, row second. If the object write fails we have written nothing and the caller sees
     * the error. The reverse order would leave a row pointing at bytes that do not exist — a snapshot
     * the version history offers to restore and then cannot.
     */
    await this._objects.put(storagePath, encoder.encode(JSON.stringify(input.files)), 'application/json');

    const { data, error } = await db
      .from('snapshots')
      .insert({
        id,
        project_id: input.projectId,
        storage_path: storagePath,
        file_manifest: buildManifest(input.files),
        message_id: input.messageId ?? null,
        label: input.label ?? null,
      })
      .select()
      .single();

    if (error) {
      // Do not leak the orphan: the row failed, so the bytes are unreferenced.
      await this._objects.delete(storagePath);
      throw new Error(`Failed to record snapshot: ${error.message}`);
    }

    return rowToSnapshot(data);
  }

  async get(id: string): Promise<Snapshot | null> {
    const db = await this._db();
    const { data } = await db.from('snapshots').select().eq('id', id).maybeSingle();

    return data ? rowToSnapshot(data) : null;
  }

  async read(id: string): Promise<SnapshotPayload | null> {
    const row = await this.get(id);

    if (!row) {
      return null;
    }

    const bytes = await this._objects.get(row.storagePath);

    if (!bytes) {
      logger.error(`Snapshot ${id} has a row but no payload at ${row.storagePath}`);
      return null;
    }

    return JSON.parse(decoder.decode(bytes)) as SnapshotPayload;
  }

  async listByProject(projectId: string): Promise<Snapshot[]> {
    const db = await this._db();
    const { data } = await db
      .from('snapshots')
      .select()
      .eq('project_id', projectId)
      .order('created_at', { ascending: true });

    return (data ?? []).map(rowToSnapshot);
  }

  async deleteByProject(projectId: string): Promise<void> {
    const db = await this._db();

    for (const row of await this.listByProject(projectId)) {
      await this._objects.delete(row.storagePath);
    }

    await db.from('snapshots').delete().eq('project_id', projectId);
  }
}

/*
 * ---------------------------------------------------------------------------------------------
 * Selection
 * ---------------------------------------------------------------------------------------------
 */

let _projects: ProjectStore | undefined;
let _snapshots: SnapshotStore | undefined;

export function getProjectStore(context?: unknown): ProjectStore {
  if (!_projects) {
    _projects = isSupabaseConfigured(context) ? new SupabaseProjectStore(context) : new FsProjectStore();
  }

  return _projects;
}

export function getSnapshotStore(context?: unknown): SnapshotStore {
  if (!_snapshots) {
    _snapshots = isSupabaseConfigured(context) ? new SupabaseSnapshotStore(context) : new FsSnapshotStore();
  }

  return _snapshots;
}

/** Test seams. */
export function setProjectStore(store: ProjectStore | undefined) {
  _projects = store;
}

export function setSnapshotStore(store: SnapshotStore | undefined) {
  _snapshots = store;
}
