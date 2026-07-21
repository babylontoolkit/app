/**
 * Project persistence (SPEC §4.5.5, §4.5.4b).
 *
 * Two backends behind one interface, chosen by whether Supabase is configured — the same seam the
 * prompt and skill stores use. The filesystem implementation is not a mock: it enforces the same
 * ownership semantics, so share, remix and the two-wall rule are fully exercisable in local
 * development.
 *
 * 🔴 **A project row is metadata. The platform stores no project FILES** (§4.5.4b) — the code lives in
 * the user's own repo, and their in-progress work lives in their browser. There was a `SnapshotStore`
 * here, with both backends and a version-history route; it is gone. See the note above `ProjectStore`
 * in `types.ts` for why, and `share/seed-store.ts` for the one deliberate exception (a published game's
 * remix seed), which is one object at a derived key and not a store.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { platformDataDir } from '~/lib/.server/prompt/store';
import { isSupabaseConfigured, createAdminClient } from '~/lib/.server/supabase/client';
import type { NewProject, Project, ProjectStore } from './types';

function newId(prefix: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14);
  return `${prefix}_${stamp}_${Math.random().toString(36).slice(2, 10)}`;
}

/*
 * ---------------------------------------------------------------------------------------------
 * Filesystem
 * ---------------------------------------------------------------------------------------------
 */

/**
 * Exported so the git token store (§4.5.4b) reuses this exact table rather than writing a second,
 * subtly-different one — the temp-file-then-rename in `put` is what makes a local write atomic, and a
 * copy that forgot it would corrupt a row on a crash.
 */
export class FsJsonTable<T extends { id: string }> {
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

/**
 * Apply the column defaults migration 0006 gives the real table (§4.5.4b).
 *
 * The FS store round-trips the domain object, so it has no DEFAULT to fall back on: a project written
 * without `autoPush` reads back `undefined`, where Postgres would say `true`. That divergence is the
 * whole failure mode `FsLedger` taught us about — the mirror is happy while production behaves
 * differently — and here it would mean auto-push silently off in local mode and on in production.
 */
function withProjectDefaults<T extends Project | null>(project: T): T {
  return project ? { ...project, autoPush: project.autoPush ?? true } : project;
}

export class FsProjectStore implements ProjectStore {
  private readonly _table: FsJsonTable<Project>;

  constructor(root?: string) {
    this._table = new FsJsonTable<Project>(root ?? path.join(platformDataDir(), 'projects'));
  }

  async create(project: NewProject): Promise<Project> {
    const now = new Date().toISOString();
    const row: Project = withProjectDefaults({ ...project, id: newId('prj'), createdAt: now, updatedAt: now });
    await this._table.put(row);

    return row;
  }

  async get(id: string): Promise<Project | null> {
    return withProjectDefaults(await this._table.get(id));
  }

  async listByUser(userId: string): Promise<Project[]> {
    const rows = await this._table.all();

    return rows
      .filter((p) => p.userId === userId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(withProjectDefaults);
  }

  async update(id: string, patch: Partial<Omit<Project, 'id' | 'userId' | 'createdAt'>>): Promise<Project> {
    const existing = await this._table.get(id);

    if (!existing) {
      throw new Error(`Project not found: ${id}`);
    }

    const row: Project = withProjectDefaults({
      ...existing,
      ...patch,
      id: existing.id,
      updatedAt: new Date().toISOString(),
    });
    await this._table.put(row);

    return row;
  }

  async delete(id: string): Promise<void> {
    await this._table.remove(id);
  }

  async getByShareId(shareId: string): Promise<Project | null> {
    const rows = await this._table.all();

    return withProjectDefaults(rows.find((p) => p.shareId === shareId) ?? null);
  }

  async listGallery(limit: number): Promise<Project[]> {
    const rows = await this._table.all();

    return rows
      .filter((p) => p.galleryStatus === 'approved' && p.sharedAt)
      .sort((a, b) => (b.sharedAt ?? '').localeCompare(a.sharedAt ?? ''))
      .slice(0, limit);
  }

  async listGallerySubmissions(limit: number): Promise<Project[]> {
    const rows = await this._table.all();

    return rows
      .filter((p) => p.galleryStatus === 'pending' && p.sharedAt)
      .sort((a, b) => (b.sharedAt ?? '').localeCompare(a.sharedAt ?? ''))
      .slice(0, limit);
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
    shareTitle: row.share_title ?? undefined,
    shareDescription: row.share_description ?? undefined,
    sharedAt: row.shared_at ?? undefined,
    soloLaunch: row.solo_launch ?? undefined,
    galleryStatus: row.gallery_status ?? undefined,
    remixedFrom: row.remixed_from ?? undefined,
    remixSeedAt: row.remix_seed_at ?? undefined,
    provider: row.provider ?? undefined,
    linkedRepo: row.linked_repo ?? undefined,
    linkedBranch: row.linked_branch ?? undefined,
    lastSyncedCommitSha: row.last_synced_commit_sha ?? undefined,
    githubInstallationRef: row.github_installation_ref ?? undefined,

    // `?? true` mirrors the column default, so a row written before 0006 reads as auto-push ON.
    autoPush: row.auto_push ?? true,
    gameBackendRef: row.game_backend_ref ?? undefined,
    linkedUnityProjectId: row.linked_unity_project_id ?? undefined,
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
    shareTitle: 'share_title',
    shareDescription: 'share_description',
    sharedAt: 'shared_at',
    soloLaunch: 'solo_launch',
    galleryStatus: 'gallery_status',
    remixedFrom: 'remixed_from',
    remixSeedAt: 'remix_seed_at',
    provider: 'provider',
    linkedRepo: 'linked_repo',
    linkedBranch: 'linked_branch',
    lastSyncedCommitSha: 'last_synced_commit_sha',
    githubInstallationRef: 'github_installation_ref',
    gameBackendRef: 'game_backend_ref',
    linkedUnityProjectId: 'linked_unity_project_id',
    autoPush: 'auto_push',
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

  async listGallery(limit: number): Promise<Project[]> {
    return this._listGalleryByStatus('approved', limit);
  }

  async listGallerySubmissions(limit: number): Promise<Project[]> {
    return this._listGalleryByStatus('pending', limit);
  }

  private async _listGalleryByStatus(status: 'approved' | 'pending', limit: number): Promise<Project[]> {
    const db = await this._db();
    const { data } = await db
      .from('projects')
      .select()
      .eq('gallery_status', status)
      .not('shared_at', 'is', null)
      .order('shared_at', { ascending: false })
      .limit(limit);

    return (data ?? []).map(rowToProject);
  }
}

/*
 * ---------------------------------------------------------------------------------------------
 * Selection
 * ---------------------------------------------------------------------------------------------
 */

let _projects: ProjectStore | undefined;

export function getProjectStore(context?: unknown): ProjectStore {
  if (!_projects) {
    _projects = isSupabaseConfigured(context) ? new SupabaseProjectStore(context) : new FsProjectStore();
  }

  return _projects;
}

/** Test seam. */
export function setProjectStore(store: ProjectStore | undefined) {
  _projects = store;
}
