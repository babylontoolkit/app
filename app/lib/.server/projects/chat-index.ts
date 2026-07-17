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

  async upsert(row: ChatIndexRow): Promise<void> {
    await this._table.put(row);
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
    await this._table.remove(id);
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
}

function toRow(row: ChatIndexRow): ChatRow {
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
