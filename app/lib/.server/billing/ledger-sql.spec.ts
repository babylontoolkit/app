/**
 * The money path, against a REAL Postgres (SPEC §4.6, §4.5.4, spec/billing.md).
 *
 * Every other billing test in this repo runs against `FsLedger` — the local-development mirror. That
 * mirror has no foreign keys, no partial unique indexes, no triggers, and no advisory locks. It is a
 * TypeScript reimplementation of the rules, so it can only prove that we implemented the rules twice;
 * it cannot prove the DATABASE enforces them. And the database is the thing that actually runs in
 * production.
 *
 * That gap is not hypothetical. It is exactly how the foreign key on `credit_ledger.generation_id`
 * shipped unnoticed: nothing inserted into `generations`, so in Postgres EVERY debit would have been
 * rejected (`23503`), `settleGeneration` would have swallowed it, and every generation on the platform
 * would have billed **zero** — silently, forever. `FsLedger` was perfectly happy the entire time.
 *
 * So this file runs the ACTUAL migration files, verbatim, against an embedded Postgres (PGlite), and
 * asserts the guarantees at the level where they are really made. If a migration is edited such that a
 * money rule stops being enforced by the database, this is what fails.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

let db: PGlite;

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/**
 * The bits of Supabase the migration leans on. Not a fake of our own logic — only the platform surface
 * that would exist in a real Supabase project (the `auth` schema, `auth.uid()`, and the three roles).
 */
const SUPABASE_PRELUDE = `
  create schema if not exists auth;

  -- Shaped like the real thing: migration 0001 puts an on-insert trigger on this table that reads
  -- \`raw_user_meta_data\` and \`email\` to seed \`public.profiles\`.
  create table if not exists auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb not null default '{}'::jsonb
  );
  create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
`;

/** Append through the function, exactly as `SupabaseLedger.append` does — never a raw insert. */
async function append(entry: {
  userId?: string;
  delta: number;
  reason: string;
  generationId?: string | null;
  paymentRef?: string | null;
  allowNegative?: boolean;
}) {
  const result = await db.query<{ balance_after: number }>(
    `select * from public.append_ledger_entry($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.userId ?? USER,
      entry.delta,
      entry.reason,
      entry.generationId ?? null,
      null,
      entry.paymentRef ?? null,
      null,
      entry.allowNegative ?? (entry.reason === 'generation' || entry.reason === 'adjustment'),
    ],
  );

  return result.rows[0];
}

/**
 * The latest row by `seq`, exactly as `SupabaseLedger.balance()` reads it — NOT by `created_at`.
 * Ordering a ledger by wall-clock time is the bug migration 0003 exists to fix (see below).
 */
async function balance(userId = USER): Promise<number> {
  const { rows } = await db.query<{ balance_after: number }>(
    `select balance_after from public.credit_ledger where user_id = $1 order by seq desc limit 1`,
    [userId],
  );

  return rows[0]?.balance_after ?? 0;
}

/** A `generations` row must exist before a debit may name it — that IS the foreign key. */
async function createGeneration(id: string, userId = USER) {
  await db.query(`insert into public.generations (id, user_id, model) values ($1, $2, 'claude-sonnet-5')`, [
    id,
    userId,
  ]);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_PRELUDE);

  const dir = path.resolve(process.cwd(), 'supabase/migrations');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  // The real migrations, unmodified. If one of them cannot run, that is a finding, not a test problem.
  for (const file of files) {
    await db.exec(await fs.readFile(path.join(dir, file), 'utf8'));
  }
}, 60_000);

beforeEach(async () => {
  // The ledger is append-only BY TRIGGER, so a plain delete is refused. Disable it for the reset only.
  await db.exec(`
    alter table public.credit_ledger disable trigger user;
    delete from public.credit_ledger;
    alter table public.credit_ledger enable trigger user;
    delete from public.generations;
    delete from auth.users cascade;
  `);
  await db.query(`insert into auth.users (id, email) values ($1, 'a@example.com'), ($2, 'b@example.com')`, [
    USER,
    OTHER,
  ]);
});

describe('the migrations', () => {
  it('apply cleanly to an empty database', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    const tables = rows.map((r) => r.table_name);

    expect(tables).toEqual(
      expect.arrayContaining(['credit_ledger', 'credit_packs', 'entitlements', 'generations', 'profiles', 'projects']),
    );
  });

  /* RLS is the backstop behind the middleware (§4.5.3). A table without it is protected by nothing. */
  it('enables row-level security on every user-scoped table', async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
       where relnamespace = 'public'::regnamespace and relkind = 'r'`,
    );

    for (const table of ['profiles', 'projects', 'generations', 'credit_ledger', 'entitlements', 'chats']) {
      expect(rows.find((r) => r.relname === table)?.relrowsecurity, `${table} must have RLS enabled`).toBe(true);
    }
  });

  /**
   * The chat index (§4.5.6, migration 0008) — what makes the sidebar follow the user.
   *
   * Asserted against the REAL schema because every property here is one the TypeScript store cannot
   * enforce: a foreign key, a cascade, and the ABSENCE of a column.
   */
  describe('the chat index', () => {
    it('cascades chats away with their project — a chat cannot outlive its game', async () => {
      const { rows } = await db.query<{ delete_rule: string; column_name: string }>(
        `select rc.delete_rule, kcu.column_name
           from information_schema.referential_constraints rc
           join information_schema.key_column_usage kcu on kcu.constraint_name = rc.constraint_name
          where kcu.table_name = 'chats' and kcu.column_name = 'project_id'`,
      );

      expect(rows[0]?.delete_rule).toBe('CASCADE');
    });

    it('has NO user_id — ownership is inherited from the project, never denormalised', async () => {
      /*
       * A second home for ownership would be the one the sidebar trusted, and it could disagree with
       * the project's. `snapshots` set this precedent in 0001 and it is the right one.
       */
      const { rows } = await db.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'chats'`,
      );

      expect(rows.map((r) => r.column_name)).not.toContain('user_id');
    });

    it('has NO url_id — a title slug cannot address a chat once there is more than one user', async () => {
      /*
       * `/chat/start-dev-server` was upstream's title slug, de-duplicated against ONE browser's
       * IndexedDB. Two users who both type "start dev server" collide, and the de-duplication cannot
       * see across accounts. The URL is the chat's uuid; a column for the slug would be written and
       * never read, which is exactly what `current_snapshot_id` was (0007).
       */
      const { rows } = await db.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'chats'`,
      );

      expect(rows.map((r) => r.column_name)).not.toContain('url_id');
    });
  });

  /**
   * The platform stores no project files (§4.5.4b, migration 0007).
   *
   * `snapshots` was dropped rather than left empty, and the difference matters: a table with a live RLS
   * policy is a place to write, and 0006 left this one standing for a full release after the behaviour
   * that used it was removed. Asserted against the REAL migrations because the TypeScript mirror cannot
   * see a table nothing references.
   */
  it('has no snapshots table — the platform stores no project files', async () => {
    const { rows } = await db.query<{ relname: string }>(
      `select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'`,
    );

    expect(rows.map((r) => r.relname)).not.toContain('snapshots');
  });

  it('has no current_snapshot_id column left on projects', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'projects'`,
    );
    const columns = rows.map((r) => r.column_name);

    expect(columns).not.toContain('current_snapshot_id');

    // What replaced it: a hint that a published game has a remix seed (§4.8), named for what it means.
    expect(columns).toContain('remix_seed_at');
  });

  /* Migration 0002: without these, production can see THAT a generation cost money, never WHY. */
  it('adds the diagnostics columns the admin dashboards are built from', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'generations'`,
    );
    const columns = rows.map((r) => r.column_name);

    expect(columns).toEqual(expect.arrayContaining(['tool_rounds', 'duration_ms', 'finish_reason', 'steps']));
  });
});

describe('append_ledger_entry (the only way a ledger row is written)', () => {
  it('derives balance_after from the previous row — the caller never supplies it', async () => {
    expect((await append({ delta: 1000, reason: 'grant' })).balance_after).toBe(1000);
    expect((await append({ delta: 5000, reason: 'purchase', paymentRef: 'pi_1' })).balance_after).toBe(6000);

    await createGeneration('gen_1');
    expect((await append({ delta: -250, reason: 'generation', generationId: 'gen_1' })).balance_after).toBe(5750);

    expect(await balance()).toBe(5750);
  });

  it('keeps users isolated', async () => {
    await append({ delta: 1000, reason: 'grant' });
    expect(await balance(OTHER)).toBe(0);
  });

  /* `security definer` + a grant only to `service_role` is what stops a user appending their own credits. */
  it('is security definer and executable only by the service role', async () => {
    const { rows } = await db.query<{ prosecdef: boolean; proacl: string | null }>(
      `select prosecdef, proacl::text from pg_proc where proname = 'append_ledger_entry'`,
    );

    expect(rows[0].prosecdef).toBe(true);
    expect(rows[0].proacl).toContain('service_role');
    expect(rows[0].proacl).not.toContain('anon=');
    expect(rows[0].proacl).not.toContain('authenticated=');
  });
});

/**
 * THE FOREIGN KEY — the bug that would have run the whole platform for free.
 *
 * `settleGeneration` may never throw (§4.6), so it catches, logs, and returns null. A rejected debit
 * therefore looks exactly like a successful one from the outside. Nothing crashes. Nothing fails a
 * build. The user is simply never charged.
 */
describe('credit_ledger.generation_id → generations(id)', () => {
  it('REJECTS a debit whose generation row does not exist', async () => {
    await append({ delta: 10_000, reason: 'grant' });

    await expect(append({ delta: -250, reason: 'generation', generationId: 'gen_missing' })).rejects.toThrow(
      /foreign key|violates/i,
    );

    // The money was never taken: the debit did not land.
    expect(await balance()).toBe(10_000);
  });

  it('accepts the debit once the generation row has been written first', async () => {
    await append({ delta: 10_000, reason: 'grant' });
    await createGeneration('gen_ok');

    expect((await append({ delta: -250, reason: 'generation', generationId: 'gen_ok' })).balance_after).toBe(9750);
  });

  /* A refund names the same generation. If the anchor were the debit's private business, refunds would fail too. */
  it('lets the refund for a failed generation reference the same row', async () => {
    await append({ delta: 10_000, reason: 'grant' });
    await createGeneration('gen_fail');
    await append({ delta: -250, reason: 'generation', generationId: 'gen_fail' });
    await append({ delta: 250, reason: 'refund', generationId: 'gen_fail' });

    expect(await balance()).toBe(10_000);
  });
});

describe('grant integrity and payment idempotency (partial unique indexes, not app checks)', () => {
  /* Re-verification, an OAuth re-link, or two tabs racing all try to grant. Exactly one may ever land. */
  it('refuses a second grant to the same user', async () => {
    await append({ delta: 1000, reason: 'grant' });

    await expect(append({ delta: 1000, reason: 'grant' })).rejects.toThrow(/duplicate key|unique/i);
    expect(await balance()).toBe(1000);
  });

  it('grants each user exactly one — the index is per-user, not global', async () => {
    await append({ delta: 1000, reason: 'grant' });
    await append({ userId: OTHER, delta: 1000, reason: 'grant' });

    expect(await balance()).toBe(1000);
    expect(await balance(OTHER)).toBe(1000);
  });

  /* Stripe RETRIES deliveries — that is a feature. Crediting on every delivery hands out free money. */
  it('refuses to credit the same payment twice', async () => {
    await expect(async () => {
      await append({ delta: 5000, reason: 'purchase', paymentRef: 'cs_test_1' });
      await append({ delta: 5000, reason: 'purchase', paymentRef: 'cs_test_1' });
    }).rejects.toThrow(/duplicate key|unique/i);

    expect(await balance()).toBe(5000);
  });

  it('allows two different payments', async () => {
    await append({ delta: 5000, reason: 'purchase', paymentRef: 'cs_1' });
    await append({ delta: 5000, reason: 'purchase', paymentRef: 'cs_2' });

    expect(await balance()).toBe(10_000);
  });
});

/**
 * ORDERING. Balance is derived from "the latest row", and `created_at` cannot tell you which that is.
 *
 * `now()` is the TRANSACTION timestamp, so rows written back-to-back share one. The original function
 * ordered by `created_at desc, id desc` — and `id` is a random uuid, so on a tie "the latest row" became
 * "a random one of the rows from this millisecond". The next append then derived its balance from the
 * WRONG row: no error, no exception, just a quietly incorrect balance and an append-only history that
 * looks perfectly plausible.
 *
 * `FsLedger` could never have caught this — it appends to a JSONL file, where order is inherent.
 */
describe('ordering is monotonic, not wall-clock (migration 0003)', () => {
  /*
   * THE EXACT SEQUENCE THE PROXY RUNS ON A FAILED GENERATION, back-to-back inside one `finally`:
   * settle the debit, then auto-refund it. Before the fix this produced 9750 — the refund read the GRANT
   * row and computed a balance that skipped the debit.
   *
   * ⚠️ This test does NOT prove the timestamps tie, and it never did. Its comment used to claim "these
   * three rows reliably share a timestamp", which is not something the test establishes OR controls —
   * `now()` ties only if the machine gets through three transactions inside one clock tick, and measured
   * on this hardware it does NOT (three appends, three distinct timestamps). The claim was free to be
   * wrong because the test passes either way: `balance_after` is computed by the WRITER under a lock and
   * ordered by `seq`, so a tie is irrelevant to it. What this test actually pins is that the real
   * proxy sequence chains to the right balance. The tie itself is proven deterministically below, by
   * forcing it — see 'cannot identify the latest row by created_at'.
   */
  it('derives the right balance for a debit and its auto-refund', async () => {
    await append({ delta: 10_000, reason: 'grant' });
    await createGeneration('gen_fail');
    await append({ delta: -250, reason: 'generation', generationId: 'gen_fail' });
    await append({ delta: 250, reason: 'refund', generationId: 'gen_fail' });

    expect(await balance()).toBe(10_000);
  });

  /*
   * A burst of appends must chain correctly, every time — whether or not they land in the same clock
   * tick. (This title used to say "that share a timestamp"; like the test above it neither forces nor
   * checks that, and it passes either way. `seq` is what makes the chain right.)
   */
  it('chains balances correctly across a burst of rapid appends', async () => {
    for (let i = 0; i < 10; i++) {
      await append({ delta: 100, reason: 'promo' });
    }

    expect(await balance()).toBe(1000);

    const { rows } = await db.query<{ balance_after: number }>(
      `select balance_after from public.credit_ledger where user_id = $1 order by seq`,
      [USER],
    );

    expect(rows.map((r) => r.balance_after)).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
  });

  /**
   * `created_at` is NOT a usable ordering key — and this proves the CONSEQUENCE, not the premise.
   *
   * ⚠️ THIS TEST USED TO BE FLAKY, AND THE REASON IS THE POINT. It appended five rows and asserted
   * `count(distinct created_at) < 5` — i.e. it asserted that a RACE OCCURRED. `created_at` defaults to
   * `now()` (the TRANSACTION timestamp), so whether two appends tie depends on whether the machine got
   * through them inside one clock tick. Fast machine: they tie, green. Loaded machine (or a cold first
   * run): the clock ticks between them, five distinct timestamps, RED. It failed roughly one run in
   * three — on a MONEY path, which is the worst place to train someone that a red suite is normal.
   *
   * **A test that hopes for a race is not a test of the race.** So: force the tie instead of waiting for
   * it. The rows below are REAL — written by the real `append_ledger_entry`, with real chained balances —
   * and then their timestamps are collapsed to one value, simulating exactly what a fast machine produces
   * on its own. Deterministic, and it asserts something strictly stronger than the old version did.
   *
   * The sequence is the one the proxy runs in a single `finally` on a failed generation: settle the
   * debit, then auto-refund it. Balance chain: 10000 -> 9750 -> 10000.
   */
  it('cannot identify the latest row by created_at — the tie has two different balances', async () => {
    await append({ delta: 10_000, reason: 'grant' });
    await createGeneration('gen_fail');
    await append({ delta: -250, reason: 'generation', generationId: 'gen_fail' });
    await append({ delta: 250, reason: 'refund', generationId: 'gen_fail' });

    /*
     * Collapse the clock. The ledger is append-only (`forbid_ledger_update`), so the trigger comes off
     * for exactly this write and goes straight back on — the same thing migration 0003 does to backfill.
     * That the trigger has to be lifted at all is itself the append-only rule being real.
     */
    await db.exec(`
      alter table public.credit_ledger disable trigger forbid_ledger_update;
      update public.credit_ledger set created_at = timestamptz '2026-07-17 12:00:00+00';
      alter table public.credit_ledger enable trigger forbid_ledger_update;
    `);

    const { rows: tied } = await db.query<{ n: number; distinct_balances: number }>(
      `select count(*)::int as n, count(distinct balance_after)::int as distinct_balances
         from public.credit_ledger
        where user_id = $1
          and created_at = (select max(created_at) from public.credit_ledger where user_id = $1)`,
      [USER],
    );

    /*
     * 🔴 The kill shot. Three rows share the maximum timestamp, and they carry TWO DIFFERENT balances.
     * So "the latest row by created_at" is not a wrong answer — it is not an answer at all. The tiebreak
     * fell to `id`, a random uuid, which meant the balance read was a COIN FLIP between 10000 and 9750.
     */
    expect(tied[0].n, 'the rows must actually tie for this test to mean anything').toBe(3);
    expect(tied[0].distinct_balances, 'ordering by created_at is ambiguous — multiple balances qualify').toBe(2);

    /*
     * And 9750 — the historical wrong balance, the debit applied and its refund silently skipped — is
     * one of the answers that ordering by created_at can legitimately return.
     */
    const { rows: reachable } = await db.query<{ balance_after: number }>(
      `select distinct balance_after from public.credit_ledger
        where user_id = $1
          and created_at = (select max(created_at) from public.credit_ledger where user_id = $1)
        order by balance_after`,
      [USER],
    );

    expect(reachable.map((r) => r.balance_after)).toEqual([9750, 10_000]);

    /* `seq` has no tie to break. It is the only reason the balance is 10000 every time. */
    expect(await balance()).toBe(10_000);
  });

  it('assigns seq in insert order', async () => {
    await append({ delta: 100, reason: 'grant' });
    await append({ delta: 50, reason: 'promo' });

    const { rows } = await db.query<{ reason: string }>(
      `select reason from public.credit_ledger where user_id = $1 order by seq`,
      [USER],
    );

    expect(rows.map((r) => r.reason)).toEqual(['grant', 'promo']);
  });
});

describe('the negative-balance rule', () => {
  /*
   * A `generation` debit MAY overdraw: we settle AFTER the tokens are spent, and §4.2.1 forbids killing
   * an in-flight generation for balance. Reality is allowed to overshoot; the gate on the NEXT
   * generation is what catches it.
   */
  it('lets a generation debit drive the balance negative', async () => {
    await append({ delta: 100, reason: 'grant' });
    await createGeneration('gen_big');

    const row = await append({ delta: -500, reason: 'generation', generationId: 'gen_big' });

    expect(row.balance_after).toBe(-400);
  });

  /* Nothing else may. A purchase or refund that overdraws is a bug, and the database says so. */
  it('refuses any OTHER entry that would go negative', async () => {
    await expect(append({ delta: -500, reason: 'refund', allowNegative: false })).rejects.toThrow(
      /insufficient credits/i,
    );

    expect(await balance()).toBe(0);
  });
});

/**
 * The 'media' reason (migration 0009, §4.16): an UP-FRONT debit for image/video generation. It runs
 * BEFORE any spend at KIE, so unlike 'generation' it must never overdraw — an insufficient balance
 * refuses the render, it does not record an overshoot.
 */
describe("the 'media' ledger reason (migration 0009)", () => {
  it('accepts a media debit anchored to a generations row, at a positive balance', async () => {
    await append({ delta: 100, reason: 'grant' });
    await createGeneration('med_ok');

    const row = await append({ delta: -21, reason: 'media', generationId: 'med_ok' });

    expect(row.balance_after).toBe(79);
  });

  it('REFUSES a media debit that would overdraw — the render must not start', async () => {
    await append({ delta: 10, reason: 'grant' });
    await createGeneration('med_poor');

    await expect(append({ delta: -21, reason: 'media', generationId: 'med_poor' })).rejects.toThrow(
      /insufficient credits/i,
    );

    expect(await balance()).toBe(10);
  });

  it('lets the refund for a failed render reference the same anchor row', async () => {
    await append({ delta: 100, reason: 'grant' });
    await createGeneration('med_fail');
    await append({ delta: -21, reason: 'media', generationId: 'med_fail' });

    const refunded = await append({ delta: 21, reason: 'refund', generationId: 'med_fail' });

    expect(refunded.balance_after).toBe(100);
  });

  /* The FK holds for media exactly as for LLM generations — an unanchored debit is rejected. */
  it('rejects a media debit whose generations row does not exist', async () => {
    await append({ delta: 100, reason: 'grant' });

    await expect(append({ delta: -21, reason: 'media', generationId: 'med_ghost' })).rejects.toThrow();
  });
});

/**
 * APPEND-ONLY, enforced by the database rather than by convention.
 *
 * A ledger that can be edited cannot answer "where did my credits go", and a corrected row destroys the
 * evidence of what it corrected. Compensating rows only.
 */
describe('append-only', () => {
  it('refuses an UPDATE to a ledger row', async () => {
    await append({ delta: 1000, reason: 'grant' });

    await expect(db.exec(`update public.credit_ledger set delta = 999999`)).rejects.toThrow(/append-only/i);
  });

  it('refuses a DELETE of a ledger row', async () => {
    await append({ delta: 1000, reason: 'grant' });

    await expect(db.exec(`delete from public.credit_ledger where reason = 'grant'`)).rejects.toThrow(/append-only/i);

    expect(await balance()).toBe(1000);
  });
});
