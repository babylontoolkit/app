/**
 * The credit ledger (SPEC §4.6, §4.5.4, spec/billing.md).
 *
 * **APPEND-ONLY. Balance is DERIVED, never a mutable counter.**
 *
 * This is not stylistic. A mutable `credits` column is a lost update waiting to happen: two
 * concurrent generations read 100, each subtract 40, and both write 60 — the user paid once for two
 * generations. It is also unauditable: when a customer says "where did my credits go", a counter can
 * only answer "they're gone". Every row here records what happened, why, and what the balance was
 * afterwards, so the balance is always reconstructible and every debit is attributable.
 *
 * The invariants, in order of how expensive they are to get wrong:
 *
 * 1. **Rows are never updated or deleted.** A correction is a new compensating row (`refund`).
 * 2. **`balance_after` is computed by the WRITER, under a lock**, from the previous row — never
 *    supplied by a caller.
 * 3. **Balance never goes negative** — except for a `generation` debit, which MAY, because we settle
 *    AFTER the tokens are spent and we refuse to kill an in-flight generation for balance (§4.2.1).
 *    Reality is allowed to overshoot; the gate on the NEXT generation catches it.
 * 4. **One grant per user, forever** — enforced by a partial unique index in Postgres, not by a
 *    read-then-write check that a race would sail straight through (§4.5.4).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '~/utils/logger';
import { platformDataDir } from '~/lib/.server/prompt/store';
import { createAdminClient, isSupabaseConfigured } from '~/lib/.server/supabase/client';

const logger = createScopedLogger('ledger');

export type LedgerReason = 'grant' | 'purchase' | 'generation' | 'refund' | 'promo' | 'adjustment';

export interface LedgerEntry {
  id: string;
  userId: string;

  /** Signed: positive credits the user, negative debits. A `generation` is always negative. */
  delta: number;

  reason: LedgerReason;

  /** The generation this debit (or its refund) belongs to — makes every charge attributable. */
  generationId?: string;

  /** Stripe. `paymentRef` is the IDEMPOTENCY key for purchases (§4.6). */
  paymentProvider?: string;
  paymentRef?: string;

  /** The derived balance at this row. The writer computes it; nobody else may supply it. */
  balanceAfter: number;

  /** Free-text audit note — a refund reason, an admin adjustment justification. */
  note?: string;

  createdAt: string;
}

export type NewLedgerEntry = Omit<LedgerEntry, 'id' | 'balanceAfter' | 'createdAt'>;

export class DuplicateGrantError extends Error {
  constructor() {
    super('This account has already received its starter credits.');
    this.name = 'DuplicateGrantError';
  }
}

export class DuplicatePaymentError extends Error {
  constructor(paymentRef: string) {
    super(`Payment ${paymentRef} has already been credited.`);
    this.name = 'DuplicatePaymentError';
  }
}

export interface Ledger {
  /** Append a row, deriving `balanceAfter`. Throws on a duplicate grant or a replayed payment. */
  append(entry: NewLedgerEntry): Promise<LedgerEntry>;

  /** Derived balance: the `balanceAfter` of the latest row. Zero when the user has no rows. */
  balance(userId: string): Promise<number>;

  list(userId: string, limit?: number): Promise<LedgerEntry[]>;

  /** Has this user ever been granted? Cheap check for the UI; the index is the real guard. */
  hasGrant(userId: string): Promise<boolean>;
}

function newId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14);
  return `led_${stamp}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Should this entry be refused for driving the balance below zero?
 *
 * A `generation` debit is exempt. We charge AFTER the model has run, and §4.2.1 forbids killing an
 * in-flight generation over balance — so the true cost can legitimately exceed what was there when
 * the gate ran. Refusing to record it would mean we ate the cost AND lost the audit trail. Record the
 * truth, let the balance go negative, and let the gate refuse the NEXT one.
 */
function mayGoNegative(reason: LedgerReason): boolean {
  return reason === 'generation' || reason === 'adjustment';
}

/*
 * ---------------------------------------------------------------------------------------------
 * Filesystem ledger (local mode)
 * ---------------------------------------------------------------------------------------------
 */

/**
 * The local-development ledger.
 *
 * Real append-only semantics against a JSONL file, with an in-process mutex so concurrent
 * generations cannot interleave a read-compute-write and produce two rows with the same
 * `balanceAfter`. Single-process only — which is exactly what local development is. Production runs
 * on Postgres, where the guarantee comes from a real transaction (below).
 */
export class FsLedger implements Ledger {
  private readonly _dir: string;
  private _chain: Promise<unknown> = Promise.resolve();

  constructor(dir?: string) {
    this._dir = dir ?? path.join(platformDataDir(), 'ledger');
  }

  private _file(userId: string): string {
    // The user id becomes a filename — never let one traverse.
    const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this._dir, `${safe}.jsonl`);
  }

  /** Serialize every mutation. Without this, two concurrent appends both read the same last row. */
  private _serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._chain.then(fn, fn);
    this._chain = run.catch(() => undefined);

    return run;
  }

  private async _read(userId: string): Promise<LedgerEntry[]> {
    try {
      const raw = await fs.readFile(this._file(userId), 'utf8');

      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LedgerEntry);
    } catch {
      return [];
    }
  }

  async append(entry: NewLedgerEntry): Promise<LedgerEntry> {
    return this._serialize(async () => {
      const rows = await this._read(entry.userId);

      if (entry.reason === 'grant' && rows.some((r) => r.reason === 'grant')) {
        throw new DuplicateGrantError();
      }

      if (entry.paymentRef && rows.some((r) => r.paymentRef === entry.paymentRef)) {
        throw new DuplicatePaymentError(entry.paymentRef);
      }

      const previous = rows.length ? rows[rows.length - 1].balanceAfter : 0;
      const balanceAfter = previous + entry.delta;

      if (balanceAfter < 0 && !mayGoNegative(entry.reason)) {
        throw new Error(`Refusing to append ${entry.reason}: it would drive the balance negative.`);
      }

      const row: LedgerEntry = { ...entry, id: newId(), balanceAfter, createdAt: new Date().toISOString() };

      await fs.mkdir(this._dir, { recursive: true });
      await fs.appendFile(this._file(entry.userId), `${JSON.stringify(row)}\n`, 'utf8');

      return row;
    });
  }

  async balance(userId: string): Promise<number> {
    const rows = await this._read(userId);

    return rows.length ? rows[rows.length - 1].balanceAfter : 0;
  }

  async list(userId: string, limit = 100): Promise<LedgerEntry[]> {
    const rows = await this._read(userId);

    return rows.slice(-limit).reverse();
  }

  async hasGrant(userId: string): Promise<boolean> {
    return (await this._read(userId)).some((r) => r.reason === 'grant');
  }
}

/*
 * ---------------------------------------------------------------------------------------------
 * Supabase ledger (production)
 * ---------------------------------------------------------------------------------------------
 */

function rowToEntry(row: Record<string, any>): LedgerEntry {
  return {
    id: row.id,
    userId: row.user_id,
    delta: row.delta,
    reason: row.reason,
    generationId: row.generation_id ?? undefined,
    paymentProvider: row.payment_provider ?? undefined,
    paymentRef: row.payment_ref ?? undefined,
    balanceAfter: row.balance_after,
    note: row.note ?? undefined,
    createdAt: row.created_at,
  };
}

/**
 * The production ledger.
 *
 * Every append goes through the `append_ledger_entry` Postgres function, NOT through an
 * insert built here. That is deliberate: deriving `balance_after` correctly requires
 * read-latest-then-insert to be ATOMIC, and only the database can promise that. Doing it in
 * TypeScript would reintroduce precisely the lost-update race the append-only design exists to
 * prevent — under `SELECT ... FOR UPDATE` in the function, concurrent generations serialize.
 *
 * The unique-violation codes below are the real enforcement of "one grant per user" and "one credit
 * per payment": both are partial unique indexes, so a race loses at the database rather than
 * double-granting.
 */
export class SupabaseLedger implements Ledger {
  constructor(private readonly _context?: unknown) {}

  private async _db() {
    return createAdminClient(this._context);
  }

  async append(entry: NewLedgerEntry): Promise<LedgerEntry> {
    const db = await this._db();

    const { data, error } = await db.rpc('append_ledger_entry', {
      p_user_id: entry.userId,
      p_delta: entry.delta,
      p_reason: entry.reason,
      p_generation_id: entry.generationId ?? null,
      p_payment_provider: entry.paymentProvider ?? null,
      p_payment_ref: entry.paymentRef ?? null,
      p_note: entry.note ?? null,
      p_allow_negative: mayGoNegative(entry.reason),
    });

    if (error) {
      // 23505 = unique_violation. Which index fired tells us which idempotency guard caught a replay.
      if (error.code === '23505') {
        if (entry.reason === 'grant') {
          throw new DuplicateGrantError();
        }

        if (entry.paymentRef) {
          throw new DuplicatePaymentError(entry.paymentRef);
        }
      }

      throw new Error(`Ledger append failed: ${error.message}`);
    }

    return rowToEntry(Array.isArray(data) ? data[0] : data);
  }

  /**
   * The latest row, by `seq` — NEVER by `created_at`.
   *
   * `created_at` is `now()`, the TRANSACTION timestamp, and two ledger rows written back-to-back
   * routinely share one. When they tie, ordering falls through to a random uuid and "the latest row"
   * becomes "a random one of the rows from this millisecond" — so the balance read is wrong, silently.
   * The sequence in migration 0003 exists precisely to make this ordering total. See its header for the
   * reproduction (a generation debit followed by its auto-refund derived the wrong balance).
   */
  async balance(userId: string): Promise<number> {
    const db = await this._db();

    const { data } = await db
      .from('credit_ledger')
      .select('balance_after')
      .eq('user_id', userId)
      .order('seq', { ascending: false })
      .limit(1)
      .maybeSingle();

    return data?.balance_after ?? 0;
  }

  async list(userId: string, limit = 100): Promise<LedgerEntry[]> {
    const db = await this._db();

    const { data } = await db
      .from('credit_ledger')
      .select()
      .eq('user_id', userId)
      .order('seq', { ascending: false })
      .limit(limit);

    return (data ?? []).map(rowToEntry);
  }

  async hasGrant(userId: string): Promise<boolean> {
    const db = await this._db();

    const { data } = await db
      .from('credit_ledger')
      .select('id')
      .eq('user_id', userId)
      .eq('reason', 'grant')
      .maybeSingle();

    return Boolean(data);
  }
}

let _ledger: Ledger | undefined;

export function getLedger(context?: unknown): Ledger {
  if (!_ledger) {
    _ledger = isSupabaseConfigured(context) ? new SupabaseLedger(context) : new FsLedger();
  }

  return _ledger;
}

/** Test seam. */
export function setLedger(ledger: Ledger | undefined) {
  _ledger = ledger;
}

/**
 * Issue the signup grant. Idempotent by construction (§4.5.4).
 *
 * Called on every sign-in, not just the first — re-verification, an OAuth re-link, or two tabs racing
 * would each try to grant. The unique index means exactly one wins and the rest land here as a
 * `DuplicateGrantError`, which is the SUCCESS path: the user has their grant. Swallow it.
 */
export async function ensureSignupGrant(
  userId: string,
  credits: number,
  context?: unknown,
): Promise<LedgerEntry | null> {
  if (credits <= 0) {
    return null;
  }

  try {
    const entry = await getLedger(context).append({
      userId,
      delta: credits,
      reason: 'grant',
      note: 'Welcome — starter credits',
    });

    logger.info(`Granted ${credits} starter credits to ${userId}`);

    return entry;
  } catch (error) {
    if (error instanceof DuplicateGrantError) {
      return null;
    }

    throw error;
  }
}
