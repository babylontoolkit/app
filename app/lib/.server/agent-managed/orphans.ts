/**
 * Managed sessions whose settlement FAILED while their chat was being deleted
 * (`_specs/no-unbilled-usage_plan.md` D4, migration 0028).
 *
 * A chat's index row is the only record of its managed session and of its cost cursor — and a chat,
 * project or account delete removes it. Delete settles first (`delete-settle.ts`); when that settlement
 * cannot complete (Anthropic down, a read that fails), the delete still proceeds — the user pressed Delete,
 * and holding their delete hostage to our vendor's availability is the wrong trade — but only AFTER the
 * session id and the cursor are copied HERE. The billing sweep (`sweep.ts`) settles each open orphan from
 * this record and resolves it.
 *
 * DECISION (T4): a dedicated table, not a `running` generations row: a settlement needs the session id,
 * the cursor and the account, and a generations row has no column for a cursor — a second meaning
 * squeezed into an existing column is how a reader is later misled. No foreign keys: the record must
 * outlive the delete that wrote it. Service-role only.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { platformDataDir } from '~/lib/.server/prompt/store';
import { createAdminClient, isSupabaseConfigured } from '~/lib/.server/supabase/client';

export interface ManagedOrphan {
  /** `${chatId}:${sessionId}` — one record per session, so a retried delete never duplicates it. */
  id: string;
  userId: string;
  projectId: string;
  chatId: string;
  sessionId: string;

  /** The chat's cost cursor at the delete — `null` when nothing had been settled yet. */
  cursor: string | null;
  model: string;
  reason?: string;
  createdAt: string;
  resolvedAt?: string;
}

export type NewManagedOrphan = Omit<ManagedOrphan, 'id' | 'createdAt' | 'resolvedAt'>;

export interface ManagedOrphanStore {
  /** Record (or refresh, for a retried delete) the orphan. Throws when it could not be written. */
  record(orphan: NewManagedOrphan): Promise<ManagedOrphan>;

  /** Open orphans, oldest first. */
  listOpen(limit?: number): Promise<ManagedOrphan[]>;

  /** Advance an open orphan's cursor (its settlement wrote the cursor here, not on a chat row). */
  setCursor(id: string, cursor: string): Promise<void>;

  resolve(id: string): Promise<void>;
}

const orphanId = (chatId: string, sessionId: string) => `${chatId}:${sessionId}`;

export class FsManagedOrphanStore implements ManagedOrphanStore {
  private readonly _dir: string;

  constructor(dir?: string) {
    this._dir = dir ?? path.join(platformDataDir(), 'managed-orphans');
  }

  private _file(id: string) {
    return path.join(this._dir, `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  }

  private async _get(id: string): Promise<ManagedOrphan | null> {
    try {
      return JSON.parse(await fs.readFile(this._file(id), 'utf8')) as ManagedOrphan;
    } catch {
      return null;
    }
  }

  private async _put(orphan: ManagedOrphan): Promise<void> {
    await fs.mkdir(this._dir, { recursive: true });
    await fs.writeFile(this._file(orphan.id), JSON.stringify(orphan, null, 2), 'utf8');
  }

  async record(orphan: NewManagedOrphan): Promise<ManagedOrphan> {
    const id = orphanId(orphan.chatId, orphan.sessionId);
    const existing = await this._get(id);
    const row: ManagedOrphan = {
      ...orphan,
      id,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };

    await this._put(row);

    return row;
  }

  async listOpen(limit = 200): Promise<ManagedOrphan[]> {
    let names: string[];

    try {
      names = await fs.readdir(this._dir);
    } catch {
      return [];
    }

    const rows: ManagedOrphan[] = [];

    for (const name of names.filter((n) => n.endsWith('.json'))) {
      try {
        const row = JSON.parse(await fs.readFile(path.join(this._dir, name), 'utf8')) as ManagedOrphan;

        if (!row.resolvedAt) {
          rows.push(row);
        }
      } catch {
        /* A corrupt record is skipped, never fatal to the sweep. */
      }
    }

    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit);
  }

  async setCursor(id: string, cursor: string): Promise<void> {
    const existing = await this._get(id);

    if (!existing) {
      throw new Error(`No orphan ${id}`);
    }

    await this._put({ ...existing, cursor });
  }

  async resolve(id: string): Promise<void> {
    const existing = await this._get(id);

    if (existing) {
      await this._put({ ...existing, resolvedAt: new Date().toISOString() });
    }
  }
}

export class SupabaseManagedOrphanStore implements ManagedOrphanStore {
  constructor(private readonly _context?: unknown) {}

  async record(orphan: NewManagedOrphan): Promise<ManagedOrphan> {
    const db = await createAdminClient(this._context);
    const id = orphanId(orphan.chatId, orphan.sessionId);
    const { data, error } = await db
      .from('managed_billing_orphans')
      .upsert(
        {
          id,
          user_id: orphan.userId,
          project_id: orphan.projectId,
          chat_id: orphan.chatId,
          session_id: orphan.sessionId,
          cursor: orphan.cursor,
          model: orphan.model,
          reason: orphan.reason ?? null,
          resolved_at: null,
        },
        { onConflict: 'id' },
      )
      .select()
      .single();

    if (error) {
      throw new Error(`Could not record the managed billing orphan ${id}: ${error.message}`);
    }

    return fromRow(data);
  }

  async listOpen(limit = 200): Promise<ManagedOrphan[]> {
    const db = await createAdminClient(this._context);
    const { data, error } = await db
      .from('managed_billing_orphans')
      .select()
      .is('resolved_at', null)
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) {
      throw new Error(`Could not list managed billing orphans: ${error.message}`);
    }

    return (data ?? []).map(fromRow);
  }

  async setCursor(id: string, cursor: string): Promise<void> {
    const db = await createAdminClient(this._context);
    const { error } = await db.from('managed_billing_orphans').update({ cursor }).eq('id', id);

    if (error) {
      throw new Error(`Could not advance the cursor of orphan ${id}: ${error.message}`);
    }
  }

  async resolve(id: string): Promise<void> {
    const db = await createAdminClient(this._context);
    const { error } = await db
      .from('managed_billing_orphans')
      .update({ resolved_at: new Date().toISOString() })
      .eq('id', id);

    if (error) {
      throw new Error(`Could not resolve orphan ${id}: ${error.message}`);
    }
  }
}

function fromRow(r: any): ManagedOrphan {
  return {
    id: r.id,
    userId: r.user_id,
    projectId: r.project_id,
    chatId: r.chat_id,
    sessionId: r.session_id,
    cursor: r.cursor ?? null,
    model: r.model,
    reason: r.reason ?? undefined,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at ?? undefined,
  };
}

let _store: ManagedOrphanStore | undefined;

export function getManagedOrphanStore(context?: unknown): ManagedOrphanStore {
  if (!_store) {
    _store = isSupabaseConfigured(context) ? new SupabaseManagedOrphanStore(context) : new FsManagedOrphanStore();
  }

  return _store;
}

/** Test seam. */
export function setManagedOrphanStore(store: ManagedOrphanStore | undefined) {
  _store = store;
}
