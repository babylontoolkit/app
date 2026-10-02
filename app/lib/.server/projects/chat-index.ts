/**
 * The chat index — what makes the sidebar follow the user (SPEC §4.5.6, §4.5.4b).
 *
 * The transcripts were always on the server; nothing listed them. The sidebar rendered
 * `getAll(indexedDb)`, so it was a view of the BROWSER rather than of the account: a chat started on a
 * laptop did not exist on a desktop, and clearing site data destroyed the list. This table is the
 * missing half — the browser becomes a local staging area, the platform holds the project record and
 * the conversation, and the user's CODE lives in their own repo.
 *
 * ## This is a metadata CACHE, not the register of what exists
 *
 * 🔴 The objects in `messages/{projectId}/` are the truth about which chats exist. A row here can be
 * missing and the chat is still there, still readable, still listed — `listChats` reconciles against
 * the object prefix and backfills what it finds.
 *
 * That ordering is the whole safety argument. An index that is authoritative about existence turns a
 * failed row-write into a conversation that is silently gone: the bytes sit in storage forever with
 * nothing left that names them. It is the same orphan shape §4.5.4b keeps producing, and it is why
 * `deleteMessages` sweeps a prefix rather than a key. Here the bytes outlive nothing, because the bytes
 * ARE the record.
 *
 * So: never make a read path depend on a row being present, and never delete an object because its row
 * is missing.
 *
 * ## Why an index exists at all
 *
 * `message-store.ts` deliberately keeps each title INSIDE its transcript, so there is one home for the
 * truth. That holds for ONE project — listing costs one `get` per chat, bounded by
 * `MAX_CHATS_PER_PROJECT`. It does not survive a global list: rendering every chat a user has would
 * mean fetching every transcript body on the platform, megabytes at a time, to display a row of titles.
 */
import path from 'node:path';
import { platformDataDir } from '~/lib/.server/prompt/store';
import { isSupabaseConfigured, createAdminClient } from '~/lib/.server/supabase/client';
import { FsJsonTable } from './store';

/** One row: everything the sidebar needs, and nothing that would need the transcript to be read. */
export interface ChatIndexRow {
  /** The server-minted chat id (§4.5.6) — never the browser's local counter. */
  id: string;

  projectId: string;
  title?: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;

  /**
   * The Managed Agents session this chat runs on (`_specs/managed-agents-engine_plan.md` D5, T4).
   *
   * Set ONCE, on the chat's first managed turn, by `claimManagedSession` — never by `upsert`, which is
   * what every transcript save calls. A save must never be the thing that erases (or forges) the
   * pointer to a conversation's history: the session holds the whole conversation on Anthropic's side,
   * and losing the id loses the thread for every device at once.
   *
   * 🔴 Cleared when the row moves to another project (migration 0026's trigger; mirrored by
   * `FsChatIndex.upsert`). A session never follows a chat id across projects — the chat id is the only
   * thing a caller names, and ownership is proven on the PROJECT.
   */
  managedSessionId?: string;

  /** T7's settlement cursor: the `processed_at` of the last usage event already billed. */
  managedSettledAt?: string;
}

/** What a caller passes to `claimManagedSession`. */
export interface ManagedSessionClaim {
  /** The server chat id (a UUID — validated by the caller). */
  id: string;

  /** The project the caller has proven they own. */
  projectId: string;

  /** The session the caller just created and wants to record. */
  sessionId: string;

  /** ISO timestamp for a row this call has to create. */
  now: string;
}

export interface ChatIndex {
  /** Insert or update. Called on every save, so it must be idempotent on `id`. */
  upsert(row: ChatIndexRow): Promise<void>;

  /** Every indexed chat in one project. */
  listByProject(projectId: string): Promise<ChatIndexRow[]>;

  /**
   * Every indexed chat across MANY projects — the sidebar query.
   *
   * Takes project ids rather than a user id because ownership is not stored here (see the migration:
   * no `user_id` column, deliberately — it would be a second home for ownership, and it would be the
   * one the sidebar trusted). The caller resolves the user's projects first, which keeps ownership
   * derived in exactly one place.
   */
  listByProjects(projectIds: string[]): Promise<ChatIndexRow[]>;

  remove(id: string): Promise<void>;

  /** The project-delete reaper. Idempotent — a project with no indexed chats is not an error. */
  removeByProject(projectId: string): Promise<void>;

  /** One row by chat id, or `null`. The caller checks `projectId` — ownership is not stored here. */
  get(id: string): Promise<ChatIndexRow | null>;

  /**
   * COMPARE-AND-SET the chat's managed session (T4). Returns the row as it stands AFTER the attempt.
   *
   *   - No row yet (a brand-new chat — the transcript is saved at the END of a turn, the session is
   *     needed at the START): a row is CREATED for `projectId` carrying `sessionId`. Insert-if-absent,
   *     never an overwrite, so it cannot steal a row that appeared in the meantime.
   *   - A row of THIS project with no session: `sessionId` is recorded.
   *   - A row that already has a session, or that belongs to another project: NOTHING changes.
   *
   * So the FIRST writer wins and every later claimant reads the winner back. The caller compares the
   * returned `managedSessionId` with its own to learn whether it won, and the returned `projectId` with
   * its own to learn whether the chat is even theirs.
   */
  claimManagedSession(claim: ManagedSessionClaim): Promise<ChatIndexRow | null>;

  /**
   * Record T7's settlement cursor. Only on a row of `projectId` — returns `false` (writes nothing) when
   * the row is missing or belongs to another project.
   */
  setManagedSettledAt(input: { id: string; projectId: string; settledAt: string }): Promise<boolean>;

  /**
   * COMPARE-AND-CLEAR the chat's managed session (managed-agents-engine T5 rebind): clears
   * `managedSessionId` AND the settlement cursor, but only while the row of `projectId` still holds
   * `sessionId`. Two racing requests that both found the same dead session cannot wipe a session the
   * other one has already claimed in its place. Returns whether this call cleared it.
   */
  releaseManagedSession(input: { id: string; projectId: string; sessionId: string }): Promise<boolean>;
}

/*
 * ---------------------------------------------------------------------------------------------
 * Filesystem — a real implementation, not a mock (see `store.ts`)
 * ---------------------------------------------------------------------------------------------
 */

export class FsChatIndex implements ChatIndex {
  private readonly _table: FsJsonTable<ChatIndexRow>;

  constructor(root?: string) {
    this._table = new FsJsonTable<ChatIndexRow>(root ?? path.join(platformDataDir(), 'chats'));
  }

  /**
   * Every read-modify-write of one row goes through this, so the compare-and-set in
   * `claimManagedSession` is atomic within the process (the FS index is local mode: one process).
   */
  private readonly _locks = new Map<string, Promise<unknown>>();

  private _withRow<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this._locks.get(id) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.catch(() => undefined);

    this._locks.set(id, settled);
    void settled.then(() => {
      if (this._locks.get(id) === settled) {
        this._locks.delete(id);
      }
    });

    return next;
  }

  /**
   * Mirrors the Supabase upsert exactly: the summary columns are replaced, the managed-session columns
   * are NOT (the Postgres upsert never names them, so they survive), and a row that moves to another
   * project loses them (migration 0026's trigger). Without the merge a plain `put` would erase the
   * session pointer on every transcript save — local mode only, and silently.
   */
  async upsert(row: ChatIndexRow): Promise<void> {
    await this._withRow(row.id, async () => {
      const existing = await this._table.get(row.id);
      const { managedSessionId: _ignoredSession, managedSettledAt: _ignoredCursor, ...summary } = row;
      const keep = existing && existing.projectId === row.projectId ? existing : undefined;

      await this._table.put({
        ...summary,
        ...(keep?.managedSessionId ? { managedSessionId: keep.managedSessionId } : {}),
        ...(keep?.managedSettledAt ? { managedSettledAt: keep.managedSettledAt } : {}),
      });
    });
  }

  async get(id: string): Promise<ChatIndexRow | null> {
    return this._table.get(id);
  }

  async claimManagedSession(claim: ManagedSessionClaim): Promise<ChatIndexRow | null> {
    return this._withRow(claim.id, async () => {
      const existing = await this._table.get(claim.id);

      if (!existing) {
        const created: ChatIndexRow = {
          id: claim.id,
          projectId: claim.projectId,
          messageCount: 0,
          createdAt: claim.now,
          updatedAt: claim.now,
          managedSessionId: claim.sessionId,
        };

        await this._table.put(created);

        return created;
      }

      if (existing.projectId !== claim.projectId || existing.managedSessionId) {
        return existing;
      }

      const updated = { ...existing, managedSessionId: claim.sessionId };
      await this._table.put(updated);

      return updated;
    });
  }

  async setManagedSettledAt(input: { id: string; projectId: string; settledAt: string }): Promise<boolean> {
    return this._withRow(input.id, async () => {
      const existing = await this._table.get(input.id);

      if (!existing || existing.projectId !== input.projectId) {
        return false;
      }

      await this._table.put({ ...existing, managedSettledAt: input.settledAt });

      return true;
    });
  }

  async releaseManagedSession(input: { id: string; projectId: string; sessionId: string }): Promise<boolean> {
    return this._withRow(input.id, async () => {
      const existing = await this._table.get(input.id);

      if (!existing || existing.projectId !== input.projectId || existing.managedSessionId !== input.sessionId) {
        return false;
      }

      const { managedSessionId: _session, managedSettledAt: _cursor, ...rest } = existing;
      await this._table.put(rest);

      return true;
    });
  }

  async listByProject(projectId: string): Promise<ChatIndexRow[]> {
    const rows = await this._table.all();
    return rows.filter((row) => row.projectId === projectId).sort(byNewestActivity);
  }

  async listByProjects(projectIds: string[]): Promise<ChatIndexRow[]> {
    const wanted = new Set(projectIds);
    const rows = await this._table.all();

    return rows.filter((row) => wanted.has(row.projectId)).sort(byNewestActivity);
  }

  async remove(id: string): Promise<void> {
    await this._withRow(id, () => this._table.remove(id));
  }

  async removeByProject(projectId: string): Promise<void> {
    const rows = await this.listByProject(projectId);
    await Promise.all(rows.map((row) => this._table.remove(row.id)));
  }
}

/**
 * Newest activity first, with the id as a tiebreak.
 *
 * The tiebreak is not decoration. Two chats saved in the same millisecond tie on `updatedAt`, and an
 * unstable comparator then reorders the sidebar between renders for no reason the user can see — the
 * same class of bug as ordering the ledger by `created_at` (migration 0003) and local checkpoints by
 * `createdAt`, where a tie let a random row win. Cosmetic here rather than destructive, but the fix is
 * one line and the lesson is already paid for.
 */
function byNewestActivity(a: ChatIndexRow, b: ChatIndexRow): number {
  return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

/*
 * ---------------------------------------------------------------------------------------------
 * Supabase
 * ---------------------------------------------------------------------------------------------
 */

interface ChatRow {
  id: string;
  project_id: string;
  title: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
  managed_session_id?: string | null;
  managed_settled_at?: string | null;
}

/**
 * 🔴 The managed-session columns are deliberately ABSENT here. `upsert` sends exactly these keys, and
 * PostgREST's upsert updates exactly the keys it is sent — so leaving them out is what makes every
 * transcript save preserve the session pointer. Adding them (even as `null`) would erase it on every
 * save. They are written only by `claimManagedSession` / `setManagedSettledAt`.
 */
function toRow(row: ChatIndexRow): Omit<ChatRow, 'managed_session_id' | 'managed_settled_at'> {
  return {
    id: row.id,
    project_id: row.projectId,
    title: row.title ?? null,
    message_count: row.messageCount,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function fromRow(row: ChatRow): ChatIndexRow {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title ?? undefined,
    messageCount: row.message_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.managed_session_id ? { managedSessionId: row.managed_session_id } : {}),
    ...(row.managed_settled_at ? { managedSettledAt: row.managed_settled_at } : {}),
  };
}

export class SupabaseChatIndex implements ChatIndex {
  constructor(private readonly _context?: unknown) {}

  private async _db() {
    return createAdminClient(this._context);
  }

  async upsert(row: ChatIndexRow): Promise<void> {
    const db = await this._db();
    const { error } = await db.from('chats').upsert(toRow(row), { onConflict: 'id' });

    if (error) {
      throw new Error(`Failed to index chat ${row.id}: ${error.message}`);
    }
  }

  async listByProject(projectId: string): Promise<ChatIndexRow[]> {
    return this.listByProjects([projectId]);
  }

  async listByProjects(projectIds: string[]): Promise<ChatIndexRow[]> {
    /*
     * `.in()` with an empty list is a query for nothing, but it is still a round trip — and a user with
     * no projects is the FIRST thing a new account is. Answer it here.
     */
    if (projectIds.length === 0) {
      return [];
    }

    const db = await this._db();
    const { data, error } = await db
      .from('chats')
      .select()
      .in('project_id', projectIds)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: true });

    if (error) {
      throw new Error(`Failed to list chats: ${error.message}`);
    }

    return (data ?? []).map(fromRow);
  }

  async remove(id: string): Promise<void> {
    const db = await this._db();
    const { error } = await db.from('chats').delete().eq('id', id);

    if (error) {
      throw new Error(`Failed to remove chat ${id} from the index: ${error.message}`);
    }
  }

  async removeByProject(projectId: string): Promise<void> {
    const db = await this._db();
    const { error } = await db.from('chats').delete().eq('project_id', projectId);

    if (error) {
      throw new Error(`Failed to clear the chat index for ${projectId}: ${error.message}`);
    }
  }

  async get(id: string): Promise<ChatIndexRow | null> {
    const db = await this._db();
    const { data, error } = await db.from('chats').select().eq('id', id).maybeSingle();

    if (error) {
      throw new Error(`Failed to read chat ${id}: ${error.message}`);
    }

    return data ? fromRow(data as ChatRow) : null;
  }

  /**
   * Two statements, each atomic on its own, and the row read back decides who won:
   *
   *   1. INSERT … ON CONFLICT (id) DO NOTHING — creates the row for a brand-new chat, carrying the
   *      session; does nothing at all if any row with this id exists (it can never re-home a row).
   *   2. UPDATE … WHERE id AND project_id AND managed_session_id IS NULL — records the session on an
   *      existing row of this project that has none yet. A concurrent claimant that got there first
   *      makes this match nothing.
   */
  async claimManagedSession(claim: ManagedSessionClaim): Promise<ChatIndexRow | null> {
    const db = await this._db();

    const inserted = await db.from('chats').upsert(
      {
        ...toRow({
          id: claim.id,
          projectId: claim.projectId,
          messageCount: 0,
          createdAt: claim.now,
          updatedAt: claim.now,
        }),
        managed_session_id: claim.sessionId,
      },
      { onConflict: 'id', ignoreDuplicates: true },
    );

    if (inserted.error) {
      throw new Error(`Failed to record the managed session for chat ${claim.id}: ${inserted.error.message}`);
    }

    const updated = await db
      .from('chats')
      .update({ managed_session_id: claim.sessionId })
      .eq('id', claim.id)
      .eq('project_id', claim.projectId)
      .is('managed_session_id', null);

    if (updated.error) {
      throw new Error(`Failed to record the managed session for chat ${claim.id}: ${updated.error.message}`);
    }

    return this.get(claim.id);
  }

  async setManagedSettledAt(input: { id: string; projectId: string; settledAt: string }): Promise<boolean> {
    const db = await this._db();
    const { data, error } = await db
      .from('chats')
      .update({ managed_settled_at: input.settledAt })
      .eq('id', input.id)
      .eq('project_id', input.projectId)
      .select('id');

    if (error) {
      throw new Error(`Failed to record the settlement cursor for chat ${input.id}: ${error.message}`);
    }

    return (data ?? []).length > 0;
  }

  async releaseManagedSession(input: { id: string; projectId: string; sessionId: string }): Promise<boolean> {
    const db = await this._db();
    const { data, error } = await db
      .from('chats')
      .update({ managed_session_id: null, managed_settled_at: null })
      .eq('id', input.id)
      .eq('project_id', input.projectId)
      .eq('managed_session_id', input.sessionId)
      .select('id');

    if (error) {
      throw new Error(`Failed to release the managed session of chat ${input.id}: ${error.message}`);
    }

    return (data ?? []).length > 0;
  }
}

let _index: ChatIndex | undefined;

export function getChatIndex(context?: unknown): ChatIndex {
  if (!_index) {
    _index = isSupabaseConfigured(context) ? new SupabaseChatIndex(context) : new FsChatIndex();
  }

  return _index;
}

/** Test seam. */
export function setChatIndex(index: ChatIndex | undefined) {
  _index = index;
}
