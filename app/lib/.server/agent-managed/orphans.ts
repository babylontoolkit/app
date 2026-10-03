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
import { createScopedLogger } from '~/utils/logger';
import { parseCostCursor, serializeCostCursor, type CostCursor } from './session-cost';

const logger = createScopedLogger('managed-orphans');

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
  /**
   * Record the orphan — ONE open owner per session (no-unbilled-usage R2, migration 0030). A second record of a
   * session already open MERGES into it (`mergeOrphanCursors`: the more advanced cursor, pending intents
   * unioned) instead of overwriting it with whatever cursor arrived last, and a RESOLVED orphan is never
   * reopened (the sweep resolves only a fully billed, archived session — reopening it with an older cursor
   * re-bills what was billed). Throws when it could not be written.
   */
  record(orphan: NewManagedOrphan): Promise<ManagedOrphan>;

  /** Open orphans, oldest first. */
  listOpen(limit?: number): Promise<ManagedOrphan[]>;

  /** Advance an open orphan's cursor (its settlement wrote the cursor here, not on a chat row). */
  setCursor(id: string, cursor: string): Promise<void>;

  /**
   * Billed in full and archived — the sweep's word, and FINAL: `record` never reopens it. Never use it to take
   * back a keep that did not stick (that is `withdraw`): a resolved orphan looks "billed and done" to every
   * later keep of its session, which would leave the session with NO billing owner (verifier R2 defect).
   */
  resolve(id: string): Promise<void>;

  /** The open orphan of a session, whatever its id — one at most (migration 0030). */
  openForSession(sessionId: string): Promise<ManagedOrphan | null>;

  /**
   * DELETE an open orphan that should never have been kept (a release that failed after the keep, R2a). Gone,
   * not resolved, so a later keep of the same session records it afresh. A resolved row is left alone.
   */
  withdraw(id: string): Promise<void>;
}

const orphanId = (chatId: string, sessionId: string) => `${chatId}:${sessionId}`;

function cursorWeight(cursor: CostCursor): number {
  const t = cursor.tokens;

  return t.input + t.output + t.cacheRead + t.cache5m + t.cache1h;
}

/**
 * Two cursors for one session → the one that has billed MORE (credits, then tokens), carrying the union of
 * both pending lists (an intent debited twice is refused by migration 0029, so a union never double-charges).
 * Billing from the less advanced one would re-bill everything between them. Unparseable → the other one;
 * both unparseable → the newer text. Pure, exported for tests.
 */
export function mergeOrphanCursors(existing: string | null, incoming: string | null): string | null {
  const a = parseCostCursor(existing);
  const b = parseCostCursor(incoming);

  if (!a || !b) {
    return b ? incoming : a ? existing : (incoming ?? existing);
  }

  const ahead = a.credits !== b.credits ? (a.credits > b.credits ? a : b) : cursorWeight(a) >= cursorWeight(b) ? a : b;
  const pending = [...(a.pending ?? [])];

  for (const intent of b.pending ?? []) {
    if (!pending.some((p) => p.generationId === intent.generationId)) {
      pending.push(intent);
    }
  }

  return serializeCostCursor({ ...ahead, pending });
}

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
    const existing = (await this._get(id)) ?? (await this._openBySession(orphan.sessionId));

    /* Never reopen: a resolved orphan's session was billed in full and archived. */
    if (existing?.resolvedAt) {
      return existing;
    }

    const row: ManagedOrphan = existing
      ? {
          ...existing,
          cursor: mergeOrphanCursors(existing.cursor, orphan.cursor),
          reason: orphan.reason ?? existing.reason,
        }
      : { ...orphan, id, createdAt: new Date().toISOString() };

    await this._put(row);

    return row;
  }

  /** The open orphan of a session, whatever its id (0030's rule, mirrored). */
  private async _openBySession(sessionId: string): Promise<ManagedOrphan | null> {
    return (await this._scanOpen()).find((row) => row.sessionId === sessionId) ?? null;
  }

  async openForSession(sessionId: string): Promise<ManagedOrphan | null> {
    return this._openBySession(sessionId);
  }

  async withdraw(id: string): Promise<void> {
    const existing = await this._get(id);

    if (existing && !existing.resolvedAt) {
      await fs.rm(this._file(id), { force: true });
    }
  }

  async listOpen(limit = 200): Promise<ManagedOrphan[]> {
    return (await this._scanOpen()).slice(0, limit);
  }

  /** Every open record, oldest first — read from disk each time (never a caller's earlier listing). */
  private async _scanOpen(): Promise<ManagedOrphan[]> {
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

    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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

  async record(orphan: NewManagedOrphan, retried = false): Promise<ManagedOrphan> {
    const db = await createAdminClient(this._context);
    const id = orphanId(orphan.chatId, orphan.sessionId);
    const existing = (await this._byId(id)) ?? (await this._openBySession(orphan.sessionId));

    /* Never reopen: a resolved orphan's session was billed in full and archived (R2). */
    if (existing?.resolvedAt) {
      return existing;
    }

    if (existing) {
      const { data, error } = await db
        .from('managed_billing_orphans')
        .update({
          cursor: mergeOrphanCursors(existing.cursor, orphan.cursor),
          reason: orphan.reason ?? existing.reason ?? null,
        })
        .eq('id', existing.id)
        .is('resolved_at', null)
        .select()
        .maybeSingle();

      if (error) {
        throw new Error(`Could not refresh the managed billing orphan ${existing.id}: ${error.message}`);
      }

      /* Resolved between the read and the write: it stays resolved. */
      return data ? fromRow(data) : { ...existing, resolvedAt: existing.resolvedAt ?? new Date().toISOString() };
    }

    const { data, error } = await db
      .from('managed_billing_orphans')
      .insert({
        id,
        user_id: orphan.userId,
        project_id: orphan.projectId,
        chat_id: orphan.chatId,
        session_id: orphan.sessionId,
        cursor: orphan.cursor,
        model: orphan.model,
        reason: orphan.reason ?? null,
      })
      .select()
      .single();

    if (error) {
      /* A concurrent record won the insert (the id, or 0030's one-open-per-session index): merge into it. */
      if ((error as { code?: string }).code === '23505' && !retried) {
        return this.record(orphan, true);
      }

      throw new Error(`Could not record the managed billing orphan ${id}: ${error.message}`);
    }

    return fromRow(data);
  }

  async openForSession(sessionId: string): Promise<ManagedOrphan | null> {
    return this._openBySession(sessionId);
  }

  async withdraw(id: string): Promise<void> {
    const db = await createAdminClient(this._context);
    const { error } = await db.from('managed_billing_orphans').delete().eq('id', id).is('resolved_at', null);

    if (error) {
      throw new Error(`Could not withdraw the managed billing orphan ${id}: ${error.message}`);
    }
  }

  private async _byId(id: string): Promise<ManagedOrphan | null> {
    const db = await createAdminClient(this._context);
    const { data, error } = await db.from('managed_billing_orphans').select().eq('id', id).maybeSingle();

    if (error) {
      throw new Error(`Could not read the managed billing orphan ${id}: ${error.message}`);
    }

    return data ? fromRow(data) : null;
  }

  private async _openBySession(sessionId: string): Promise<ManagedOrphan | null> {
    const db = await createAdminClient(this._context);
    const { data, error } = await db
      .from('managed_billing_orphans')
      .select()
      .eq('session_id', sessionId)
      .is('resolved_at', null)
      .limit(1);

    if (error) {
      throw new Error(`Could not read the open orphan of session ${sessionId}: ${error.message}`);
    }

    return data?.[0] ? fromRow(data[0]) : null;
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

/**
 * A chat that holds a session is settled from its OWN cursor; an open orphan of that session sits idle beside
 * it (the sweep defers it while the chat is bound). Before the chat lets go of the session WITHOUT keeping it
 * (a complete settlement at a rebind, a delete, a re-home), the orphan's cursor is advanced to the chat's —
 * or the sweep would later bill, from the orphan's stale cursor, usage the chat already billed. Merge rules
 * (`mergeOrphanCursors`), never a rewind.
 *
 * Returns whether the orphan is known to be in step: `true` when there is none or it was advanced (or there
 * was no cursor to advance it to), `false` when the read or the write failed — the caller must then NOT let
 * go of the session (R2-b: a stale orphan is a later double charge). Never throws. One retry.
 */
export async function advanceOpenOrphan(
  context: unknown,
  sessionId: string,
  cursor: string | null | undefined,
): Promise<boolean> {
  if (!cursor) {
    return true;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const store = getManagedOrphanStore(context);
      const open = await store.openForSession(sessionId);

      if (open) {
        await store.setCursor(open.id, mergeOrphanCursors(open.cursor, cursor) ?? cursor);
      }

      return true;
    } catch (error) {
      logger.error(
        `Could not advance the open orphan of session ${sessionId} (attempt ${attempt}): ${(error as Error)?.message}`,
      );
    }
  }

  return false;
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
