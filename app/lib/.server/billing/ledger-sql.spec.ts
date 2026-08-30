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
import { LEDGER_REASONS } from './ledger';

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
  note?: string | null;
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
      entry.note ?? null,
      entry.allowNegative ??
        (entry.reason === 'generation' || entry.reason === 'adjustment' || entry.reason === 'search'),
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

  /*
   * Migration 0013: the per-project sandbox pointer (`spec/sandbox-codesandbox.md`). A plain column,
   * never a credential — it replaces the per-user registry file whose one-VM-per-user shape let one
   * project silently adopt another's filesystem.
   */
  it('adds sandbox_id to projects — the row is the sandbox registry', async () => {
    const { rows } = await db.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `select column_name, data_type, is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'projects'`,
    );
    const column = rows.find((r) => r.column_name === 'sandbox_id');

    expect(column, 'sandbox_id must exist on projects').toBeTruthy();

    // Nullable with no default: every existing row, and every new project, starts with no VM.
    expect(column?.is_nullable).toBe('YES');
  });

  /*
   * Migration 0016: the creation handoff (§4.4a). The brief that rides hidden on the first build turn
   * is a fact about the PROJECT, not about the browser that created it — it lived in `localStorage`,
   * so an unbuilt project opened on a second machine sent its first build turn with no brief at all
   * and simply built worse, with nothing throwing (§4.2.8's silent failure mode).
   *
   * jsonb rather than two text columns: the handoff is one object that is written and cleared whole,
   * and `{brief, userPrompt}` is the shape both the route and `rowToProject` already speak.
   */
  it('adds creation_handoff to projects as a nullable jsonb column (§4.4a)', async () => {
    const { rows } = await db.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `select column_name, data_type, is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'projects'`,
    );
    const column = rows.find((r) => r.column_name === 'creation_handoff');

    expect(column, 'creation_handoff must exist on projects').toBeTruthy();
    expect(column?.data_type).toBe('jsonb');

    /*
     * 🔴 NULL is the END STATE, not merely the initial one: the handoff is cleared when the first
     * build turn is SENT. A NOT NULL column could not express "this project has been built".
     */
    expect(column?.is_nullable).toBe('YES');
  });

  /*
   * Migration 0014: sandbox lifecycle marks (plan T12). Append-only, RLS-enabled with no policy
   * (service-role only, like `git_tokens` — a forged mark is a forged cost report), and the CHECK on
   * `event` is what keeps the pairing honest: `admin/vm-report.ts` treats create/resume as OPENING an
   * interval and everything else as CLOSING one, so a fifth event value silently invented by a future
   * writer would close intervals nobody meant to close.
   */
  describe('sandbox lifecycle marks', () => {
    it('creates the table with RLS enabled and no policy', async () => {
      const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
        `select relname, relrowsecurity from pg_class
         where relnamespace = 'public'::regnamespace and relkind = 'r'`,
      );
      const table = rows.find((r) => r.relname === 'sandbox_lifecycle_marks');

      expect(table, 'the table must exist').toBeTruthy();
      expect(table?.relrowsecurity, 'RLS must be enabled').toBe(true);

      const { rows: policies } = await db.query(
        `select policyname from pg_policies where schemaname = 'public' and tablename = 'sandbox_lifecycle_marks'`,
      );

      expect(policies, 'service-role only — a user must never read or forge these').toHaveLength(0);
    });

    it('accepts the four lifecycle events and REJECTS anything else at the CHECK constraint', async () => {
      for (const event of ['create', 'resume', 'hibernate', 'delete']) {
        await db.query(`insert into public.sandbox_lifecycle_marks (sandbox_id, event) values ($1, $2)`, [
          'sb-1',
          event,
        ]);
      }

      await expect(
        db.query(`insert into public.sandbox_lifecycle_marks (sandbox_id, event) values ('sb-1', 'paused')`),
      ).rejects.toThrow(/check|constraint/i);

      await db.exec(`delete from public.sandbox_lifecycle_marks`);
    });

    it('keeps a mark when its user is deleted — the hour still happened', async () => {
      /*
       * `on delete set null`, deliberately NOT a cascade. A user who deletes their account still ran a
       * VM yesterday, and cascading the evidence away would make historical hours vanish from the
       * report retroactively — the one thing an append-only cost record must never do.
       */
      await db.query(
        `insert into public.sandbox_lifecycle_marks (user_id, sandbox_id, event) values ($1, 'sb-9', 'create')`,
        [USER],
      );
      await db.query(`delete from auth.users where id = $1`, [USER]);

      const { rows } = await db.query<{ user_id: string | null }>(
        `select user_id from public.sandbox_lifecycle_marks where sandbox_id = 'sb-9'`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBeNull();

      await db.exec(`delete from public.sandbox_lifecycle_marks`);
    });
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

  /*
   * Migration 0023: three fields the TYPE declared and Postgres never had. The TS mirror could not
   * catch this — `FsGenerationStore` writes the whole record, so all three were present in local dev
   * and absent in the only deploy that bills money. This is the SQL half, which is the half that was
   * missing (`ledger-sql.spec.ts`'s own reason for existing: the mirror proves we wrote the rules
   * twice, not that the DATABASE enforces them).
   */
  describe('migration 0023 — the generation record is complete on Postgres', () => {
    it('adds the three columns the record type has always declared', async () => {
      const { rows } = await db.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
        `select column_name, is_nullable, column_default from information_schema.columns
         where table_schema = 'public' and table_name = 'generations'`,
      );
      const columns = rows.filter((r) => ['raw_stops', 'fallback_handoffs', 'blocks_loaded'].includes(r.column_name));

      expect(columns.map((c) => c.column_name).sort()).toEqual(['blocks_loaded', 'fallback_handoffs', 'raw_stops']);

      /*
       * 🔴 NULLABLE AND UNDEFAULTED, asserted rather than assumed. For an array column `NULL` (never
       * recorded) and `'{}'` (recorded, none) are different facts, and a default would collapse the
       * two so that no reader could ever tell a pre-migration row from a turn that genuinely had none.
       */
      for (const column of columns) {
        expect(column.is_nullable, `${column.column_name} must stay nullable`).toBe('YES');
        expect(column.column_default, `${column.column_name} must have no default`).toBeNull();
      }
    });

    /*
     * 🔴 THE DIRECT REGRESSION TEST FOR THE LIVE DEFECT. A handoff means a DIFFERENT MODEL SERVED THE
     * TURN while the turn billed at the requested model's rates (§4.2a). Before 0023 this string had
     * nowhere to land on the backend that bills real money.
     */
    it('round-trips a refusal-fallback handoff', async () => {
      await db.query(
        `insert into public.generations (id, user_id, model, fallback_handoffs, raw_stops, blocks_loaded)
         values ($1, $2, 'claude-fable-5', $3, $4, $5)`,
        [
          'gen_fallback',
          USER,
          ['claude-fable-5\u2192claude-opus-5'],
          ['refusal', 'end_turn'],
          ['racing-system', 'react-training'],
        ],
      );

      const { rows } = await db.query<{
        fallback_handoffs: string[];
        raw_stops: string[];
        blocks_loaded: string[];
      }>(`select fallback_handoffs, raw_stops, blocks_loaded from public.generations where id = 'gen_fallback'`);

      expect(rows[0].fallback_handoffs).toEqual(['claude-fable-5\u2192claude-opus-5']);
      expect(rows[0].raw_stops).toEqual(['refusal', 'end_turn']);
      expect(rows[0].blocks_loaded).toEqual(['racing-system', 'react-training']);

      await db.exec(`delete from public.generations where id = 'gen_fallback'`);
    });

    /*
     * CONTROL. A `not null` column with no default would break the three-column insert every foreign
     * key test in this file leans on — and it would break it from a migration, i.e. far from the test
     * that fails. It must still be legal to write a generation row knowing only its identity.
     */
    it('CONTROL — a row can still be created from identity alone, and reads back NULL not empty', async () => {
      await createGeneration('gen_bare');

      const { rows } = await db.query<{
        fallback_handoffs: string[] | null;
        raw_stops: string[] | null;
        blocks_loaded: string[] | null;
      }>(`select fallback_handoffs, raw_stops, blocks_loaded from public.generations where id = 'gen_bare'`);

      expect(rows).toHaveLength(1);
      expect(rows[0].fallback_handoffs, 'never recorded is NULL, not an empty array').toBeNull();
      expect(rows[0].raw_stops).toBeNull();
      expect(rows[0].blocks_loaded).toBeNull();

      await db.exec(`delete from public.generations where id = 'gen_bare'`);
    });
  });

  /*
   * Migration 0024: the record of WHAT WE SENT. `jsonb` for migration 0002's stated reason for
   * `steps` — written once, read whole, never joined or filtered on.
   */
  describe('migration 0024 — the request is on the record', () => {
    it('adds the fingerprint columns, nullable and undefaulted', async () => {
      const { rows } = await db.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `select column_name, data_type, is_nullable, column_default from information_schema.columns
         where table_schema = 'public' and table_name = 'generations'
           and column_name in ('request_fingerprints', 'integrity_issues')`,
      );

      expect(rows.map((r) => r.column_name).sort()).toEqual(['integrity_issues', 'request_fingerprints']);

      /*
       * The TYPES, not just presence and nullability. `jsonb` is migration 0002's stated case for
       * `steps` — written once, read whole, never joined or filtered on — and `text[]` is what keeps
       * the NULL-vs-empty distinction the whole column family rests on. A scalar `text` column would
       * accept every write here and quietly stop being either.
       */
      expect(rows.find((r) => r.column_name === 'request_fingerprints')?.data_type).toBe('jsonb');
      expect(rows.find((r) => r.column_name === 'integrity_issues')?.data_type).toBe('ARRAY');

      for (const row of rows) {
        expect(row.is_nullable, `${row.column_name} must stay nullable`).toBe('YES');
        expect(row.column_default, `${row.column_name} must have no default`).toBeNull();
      }
    });

    it('round-trips an ordered FOUR-request turn intact, and the row stays bounded', async () => {
      /*
       * Four, because that is a real worst case: a provider retry, its tool-free variant, a forced
       * continuation and a completeness pass can all fire in one turn. Two would round-trip fine and
       * prove nothing about the shape Open Question 2 actually worried about.
       */
      const fingerprints = [
        { kind: 'first', breakpointCount: 3, messages: { count: 4, chars: 812, sha256: 'aa'.repeat(32) } },
        { kind: 'provider-retry', breakpointCount: 3, messages: { count: 4, chars: 812, sha256: 'aa'.repeat(32) } },
        {
          kind: 'provider-retry-tool-free',
          breakpointCount: 3,
          messages: { count: 5, chars: 940, sha256: 'cc'.repeat(32) },
        },
        {
          kind: 'forced-continuation',
          breakpointCount: 3,
          messages: { count: 6, chars: 1204, sha256: 'bb'.repeat(32) },
        },
      ];

      /*
       * 🔴 BOUNDED BY CONSTRUCTION, asserted rather than assumed (Open Question 2). The entire
       * justification for putting this on the row rather than in its own table is that it is small and
       * read whole. A fingerprint that started carrying bodies would round-trip perfectly and silently
       * make `generations` the widest table in the database — and since §4.5.4b says the platform
       * stores no project files, "the row got big" is the symptom of a rule being broken.
       */
      expect(JSON.stringify(fingerprints).length).toBeLessThan(4_000);

      await db.query(
        `insert into public.generations (id, user_id, model, request_fingerprints, integrity_issues)
         values ($1, $2, 'claude-sonnet-5', $3, $4)`,
        ['gen_fp', USER, JSON.stringify(fingerprints), ['INV-1: two spellings of src/pages/Home.tsx']],
      );

      const { rows } = await db.query<{ request_fingerprints: unknown[]; integrity_issues: string[] }>(
        `select request_fingerprints, integrity_issues from public.generations where id = 'gen_fp'`,
      );

      /* ORDER is the point — a re-issue is a different request, and merging them loses the fact. */
      expect(rows[0].request_fingerprints).toEqual(fingerprints);
      expect((rows[0].request_fingerprints as Array<{ kind: string }>).map((f) => f.kind)).toEqual([
        'first',
        'provider-retry',
        'provider-retry-tool-free',
        'forced-continuation',
      ]);
      expect(rows[0].integrity_issues).toEqual(['INV-1: two spellings of src/pages/Home.tsx']);

      await db.exec(`delete from public.generations where id = 'gen_fp'`);
    });

    /*
     * 🔴 "NO FINGERPRINT" AND "AN EMPTY FINGERPRINT" ARE DIFFERENT FACTS (edge case 3). A turn that
     * failed before `startStream` — a gate refusal, a claim conflict — never assembled a request; a
     * turn that assembled one and had nothing wrong with it did. Collapsing the two is the
     * `remoteHead` `undefined`-vs-`null` mistake one subsystem over.
     */
    it('CONTROL — a turn that never reached startStream reads back NULL, not an empty array', async () => {
      await createGeneration('gen_nostream');

      const { rows } = await db.query<{ request_fingerprints: unknown; integrity_issues: unknown }>(
        `select request_fingerprints, integrity_issues from public.generations where id = 'gen_nostream'`,
      );

      expect(rows[0].request_fingerprints).toBeNull();
      expect(rows[0].integrity_issues).toBeNull();

      /* …and a turn that DID assemble one, cleanly, is distinguishable from it. */
      await db.query(
        `insert into public.generations (id, user_id, model, request_fingerprints, integrity_issues)
         values ('gen_clean', $1, 'claude-sonnet-5', $2, $3)`,
        [USER, JSON.stringify([{ kind: 'first' }]), []],
      );

      const { rows: clean } = await db.query<{ integrity_issues: string[] }>(
        `select integrity_issues from public.generations where id = 'gen_clean'`,
      );

      expect(clean[0].integrity_issues, 'checked and clean is an EMPTY array, never NULL').toEqual([]);

      await db.exec(`delete from public.generations where id in ('gen_nostream', 'gen_clean')`);
    });
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

  /*
   * The 'search' reason (migration 0010): accepted by the CHECK constraint, needs NO generations anchor
   * (generation_id null, like 'grant'), and MAY overdraw — it is charged mid-generation after the vendor
   * already ran. All three are real-Postgres facts the TS mirror cannot prove.
   */
  it('accepts a search debit with no generation anchor, and lets it overdraw', async () => {
    await append({ delta: 4, reason: 'grant' });

    // No createGeneration() call: a search debit carries no generation_id, so the FK cannot bite.
    const row = await append({ delta: -10, reason: 'search' });

    expect(row.balance_after).toBe(-6);
  });

  it('rejects an unknown ledger reason at the CHECK constraint', async () => {
    await expect(append({ delta: -1, reason: 'bogus', allowNegative: true })).rejects.toThrow(/check|constraint/i);
  });

  /*
   * The 'project_create' reason (migration 0015): the flat New Project charge. It is the 'media' shape,
   * not the 'search' shape — debited BEFORE anything is provisioned, so it must REFUSE rather than
   * overdraw. Both halves are asserted, because getting this backwards gives away project creation for
   * free and throws nothing.
   */
  it('accepts a project_create debit with no generation anchor', async () => {
    await append({ delta: 1000, reason: 'grant' });

    const row = await append({ delta: -150, reason: 'project_create' });

    expect(row.balance_after).toBe(850);
  });

  it('REFUSES a project_create debit that would overdraw — it debits before anything is provisioned', async () => {
    await append({ delta: 100, reason: 'grant' });

    await expect(append({ delta: -150, reason: 'project_create' })).rejects.toThrow(/insufficient|balance|negative/i);
  });
});

/**
 * The three lockstep places (`ledger.ts`'s union, `mayGoNegative`, and the SQL `CHECK`) drifting apart is
 * a mis-bill that throws nothing: a reason the TypeScript accepts and Postgres rejects fails only in
 * production, and only on the path that uses it. Assert the SQL constraint's member list against the
 * runtime inventory the union is derived from, in BOTH directions.
 */
describe('the SQL reason CHECK and the TypeScript inventory agree', () => {
  it('names exactly the reasons LEDGER_REASONS declares', async () => {
    const { rows } = await db.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'credit_ledger_reason_check'`,
    );

    expect(rows).toHaveLength(1);

    const inSql = [...rows[0].def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();

    expect(inSql).toEqual([...LEDGER_REASONS].sort());
  });

  /* CONTROL — a constraint definition that stopped parsing would make the assertion above vacuous. */
  it('CONTROL — the constraint definition really was read from Postgres', async () => {
    const { rows } = await db.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'credit_ledger_reason_check'`,
    );

    expect(rows[0].def).toMatch(/reason/);
    expect(rows[0].def).toContain("'project_create'");
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
 * The 'project_create' reason and its AT-MOST-ONCE refund (migration 0015).
 *
 * The refund is the interesting half, and it is the half `FsLedger` cannot prove: two concurrent
 * DELETEs of one project both read "not refunded yet" and both insert, MINTING the creation price —
 * delete-and-recreate in a loop and get paid. TypeScript's read-then-write check is a race by
 * construction, so the guarantee is a PARTIAL UNIQUE INDEX, and this is the only place it is real.
 *
 * The predicate is the other half of the design, and getting it wrong is WORSE than the bug it
 * prevents: every other refund carries a free-text note that legitimately repeats ("Generation failed"
 * arrives many times for one user), so a blanket unique index on (user_id, note) would reject every
 * second generation refund and leave users unrefunded — silently, and only for people already having a
 * bad day. Hence the CONTROLS below: they are not padding, they are the reason the predicate exists.
 */
describe("the 'project_create' reason and its at-most-once refund (migration 0015)", () => {
  const NOTE = 'project_create:prj_a';

  it('accepts a project_create debit with no generation anchor', async () => {
    await append({ delta: 1000, reason: 'grant' });

    // No createGeneration(): the flat creation price is not cost-recovery, so it names no generation.
    const row = await append({ delta: -150, reason: 'project_create', note: NOTE });

    expect(row.balance_after).toBe(850);
  });

  /*
   * It debits BEFORE anything is provisioned, so an insufficient balance must REFUSE rather than
   * overdraw — a refusal leaves nothing half-made. ('search' is the opposite case: a vendor was already
   * paid, so refusing there would only lose the audit trail.)
   */
  it('REFUSES a project_create debit that would overdraw — the project must not be created', async () => {
    await append({ delta: 100, reason: 'grant' });

    await expect(append({ delta: -150, reason: 'project_create', note: NOTE })).rejects.toThrow(
      /insufficient credits/i,
    );

    expect(await balance()).toBe(100);
  });

  /* 🔴 The faucet, closed in the database. The second insert is REJECTED, not merely detected. */
  it('refuses a SECOND refund carrying the same project_create note', async () => {
    await append({ delta: 1000, reason: 'grant' });
    await append({ delta: -150, reason: 'project_create', note: NOTE });
    await append({ delta: 150, reason: 'refund', note: NOTE });

    await expect(append({ delta: 150, reason: 'refund', note: NOTE })).rejects.toThrow(/duplicate key|unique/i);

    expect(await balance()).toBe(1000);
  });

  /* Per-user, like the grant and payment indexes — two accounts each get their own project refunded. */
  it('is per-user: another account may still be refunded for its own project', async () => {
    await append({ delta: 1000, reason: 'grant' });
    await append({ userId: OTHER, delta: 1000, reason: 'grant' });

    await append({ delta: 150, reason: 'refund', note: NOTE });
    await append({ userId: OTHER, delta: 150, reason: 'refund', note: NOTE });

    expect(await balance()).toBe(1150);
    expect(await balance(OTHER)).toBe(1150);
  });

  /* Per-project: one user deleting two undelivered projects is refunded for both. */
  it('is per-project: a second, different project is still refunded', async () => {
    await append({ delta: 1000, reason: 'grant' });
    await append({ delta: 150, reason: 'refund', note: NOTE });
    await append({ delta: 150, reason: 'refund', note: 'project_create:prj_b' });

    expect(await balance()).toBe(1300);
  });

  /*
   * 🔴 CONTROL — the collision the predicate exists to avoid. If the index were widened to all refunds,
   * this is what would break: every second generation refund rejected, users left paying for our
   * failures. It must stay possible to write the same free-text refund note twice.
   */
  it('CONTROL — two generation refunds noted identically both land', async () => {
    await append({ delta: 1000, reason: 'grant' });
    await createGeneration('gen_a');
    await createGeneration('gen_b');
    await append({ delta: -30, reason: 'generation', generationId: 'gen_a' });
    await append({ delta: -30, reason: 'generation', generationId: 'gen_b' });

    await append({ delta: 30, reason: 'refund', generationId: 'gen_a', note: 'Generation failed' });
    await append({ delta: 30, reason: 'refund', generationId: 'gen_b', note: 'Generation failed' });

    expect(await balance()).toBe(1000);
  });

  /* CONTROL — a NULL note is not a value, so unnoted refunds never collide with each other either. */
  it('CONTROL — refunds with no note at all repeat freely', async () => {
    await append({ delta: 1000, reason: 'grant' });
    await append({ delta: 10, reason: 'refund' });
    await append({ delta: 10, reason: 'refund' });

    expect(await balance()).toBe(1020);
  });

  /*
   * 🔴 THE ESCAPE. The predicate is `note like 'project\_create:%'` — the underscore is ESCAPED, so it
   * matches a literal `_`. Drop the backslash and `_` becomes LIKE's single-character wildcard, which
   * silently widens the index to notes that merely resemble the prefix. This pair proves the index is
   * matching a literal underscore rather than any character, which also proves the tests above are
   * exercising the index and not a coincidence.
   */
  it('CONTROL — the underscore is literal: a project?create-shaped note is NOT constrained', async () => {
    await append({ delta: 1000, reason: 'grant' });
    await append({ delta: 10, reason: 'refund', note: 'projectXcreate:prj_a' });
    await append({ delta: 10, reason: 'refund', note: 'projectXcreate:prj_a' });

    expect(await balance()).toBe(1020);
  });

  /* And the index really is named + partial in the catalog, not a full unique constraint in disguise. */
  it('is a PARTIAL unique index — the predicate is on the index, not enforced in the application', async () => {
    const { rows } = await db.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
       where schemaname = 'public' and indexname = 'credit_ledger_project_create_refund_idx'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/unique/i);
    expect(rows[0].indexdef).toMatch(/where/i);
    expect(rows[0].indexdef).toMatch(/user_id/);
    expect(rows[0].indexdef).toMatch(/note/);
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

/**
 * Account deletion keeps the books (SPEC §4.5.1, migration 0017).
 *
 * 🔴 It did not. `credit_ledger.user_id` and `generations.user_id` were both declared
 * `references auth.users(id) ON DELETE CASCADE` in 0001, so the first `auth.admin.deleteUser()` would
 * have taken the user's entire financial record with it — including `purchase` rows backing real
 * Stripe payments — and shrunk every historical §4.10 margin report by however much that user spent.
 * Nothing throws; the numbers simply get smaller and stay confident.
 *
 * This is the CASCADE half of the money path, and `FsLedger` cannot see it: the local mirror has no
 * foreign keys at all, so both the bug and the fix are invisible to every TypeScript test.
 */
describe('deleting an account (§4.5.1, migration 0017)', () => {
  it('KEEPS the ledger — a purchase we took money for cannot vanish from the books', async () => {
    await append({ delta: 5000, reason: 'purchase', paymentRef: 'pi_live_1' });
    await append({ delta: -250, reason: 'generation', generationId: null });

    await db.query(`delete from auth.users where id = $1`, [USER]);

    const { rows } = await db.query<{ reason: string; delta: number }>(
      `select reason, delta from public.credit_ledger where user_id = $1 order by seq`,
      [USER],
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ reason: 'purchase', delta: 5000 });
  });

  it('KEEPS the generations record — historical cost and margin must not move retroactively', async () => {
    await createGeneration('gen_kept');

    await db.query(`delete from auth.users where id = $1`, [USER]);

    const { rows } = await db.query(`select id from public.generations where user_id = $1`, [USER]);
    expect(rows).toHaveLength(1);
  });

  /*
   * The retained row still names the account — that is what makes it an accounting record rather than
   * an anonymous number — while the PII it pointed at is gone with `auth.users`. "Disassociated",
   * not "detached": a ledger whose owner column empties on deletion cannot be reconciled with
   * anything.
   */
  it('leaves the user id in place, now resolving to nobody', async () => {
    await append({ delta: 5000, reason: 'purchase', paymentRef: 'pi_live_2' });
    await db.query(`delete from auth.users where id = $1`, [USER]);

    const { rows } = await db.query<{ user_id: string | null }>(
      `select user_id from public.credit_ledger where reason = 'purchase'`,
    );

    expect(rows[0].user_id).toBe(USER);
    expect((await db.query(`select id from auth.users where id = $1`, [USER])).rows).toHaveLength(0);
  });

  /*
   * CONTROL, in the other direction — 0017 must not have turned every cascade off. What describes the
   * PERSON or their property still goes when they do, and `git_tokens` (their OAuth credential) most
   * of all. Without this, dropping every FK in the schema would pass the three tests above.
   */
  it('CONTROL — still cascades the person away: profile, projects, credential', async () => {
    // The profile already exists — 0001's `on_auth_user_created` trigger made it (§4.5.2).
    expect((await db.query(`select 1 from public.profiles where id = $1`, [USER])).rows).toHaveLength(1);

    await db.query(`insert into public.projects (user_id, name, template_id) values ($1, 'Game', 'racing')`, [USER]);
    await db.query(
      `insert into public.git_tokens (user_id, provider, access_token_encrypted, provider_login)
       values ($1, 'github', 'enc', 'octocat')`,
      [USER],
    );

    await db.query(`delete from auth.users where id = $1`, [USER]);

    for (const table of ['profiles', 'projects', 'git_tokens']) {
      const { rows } = await db.query(
        `select 1 from public.${table} where ${table === 'profiles' ? 'id' : 'user_id'} = $1`,
        [USER],
      );
      expect(rows, `${table} must not outlive its user`).toHaveLength(0);
    }
  });
});
