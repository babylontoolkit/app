/**
 * `public.user_id_for_email` against a REAL Postgres (migration 0022, SPEC §4.18a).
 *
 * The function itself is three lines; the GRANTS are the reason this file exists. Postgres grants
 * EXECUTE on a new function to PUBLIC by default, so a `security definer` lookup over `auth.users` is
 * one forgotten `revoke` away from letting any signed-in user turn any email address into an internal
 * user id through the ordinary browser PostgREST client — an account-enumeration oracle handed to the
 * whole internet, added in support of one Editor tool.
 *
 * No TypeScript test can see that. `has_function_privilege` can, and only against a database that
 * actually applied the migration — which is why this follows `ledger-sql.spec.ts` in running the real
 * migration files verbatim against embedded Postgres rather than asserting on the SQL text.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

let db: PGlite;

const USER = '33333333-3333-4333-8333-333333333333';

/** Only the Supabase platform surface the migrations lean on — never a fake of our own logic. */
const SUPABASE_PRELUDE = `
  create schema if not exists auth;
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

async function lookup(email: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string | null }>(`select public.user_id_for_email($1) as id`, [email]);
  return rows[0]?.id ?? null;
}

const SIGNATURE = 'public.user_id_for_email(text)';

async function canExecute(role: string): Promise<boolean> {
  const { rows } = await db.query<{ allowed: boolean }>(`select has_function_privilege($1, $2, 'execute') as allowed`, [
    role,
    SIGNATURE,
  ]);
  return rows[0]?.allowed === true;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_PRELUDE);

  const dir = path.resolve(process.cwd(), 'supabase/migrations');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    await db.exec(await fs.readFile(path.join(dir, file), 'utf8'));
  }
}, 60_000);

beforeEach(async () => {
  await db.exec('delete from auth.users cascade;');
  await db.query(`insert into auth.users (id, email) values ($1, 'Dev@Studio.com')`, [USER]);
});

describe('user_id_for_email', () => {
  it('resolves an address to its user id', async () => {
    await expect(lookup('Dev@Studio.com')).resolves.toBe(USER);
  });

  /*
   * Supabase normalizes on signup, but a developer typing their address into a Unity Editor field will
   * not match our casing — and a lookup that silently misses reads to them as "my subscription is not
   * recognised", which is the least debuggable possible symptom.
   */
  it('is case-insensitive', async () => {
    await expect(lookup('dev@studio.com')).resolves.toBe(USER);
    await expect(lookup('DEV@STUDIO.COM')).resolves.toBe(USER);
  });

  it('tolerates surrounding whitespace', async () => {
    await expect(lookup('  dev@studio.com  ')).resolves.toBe(USER);
  });

  /* NULL, not an exception: "no such user" is the normal answer and the route must not 500 on it. */
  it('returns null for an address we have never seen', async () => {
    await expect(lookup('stranger@example.com')).resolves.toBeNull();
  });

  it('returns null rather than erroring on nonsense input', async () => {
    await expect(lookup("' or 1=1 --")).resolves.toBeNull();
  });
});

describe('the grants — the actual security property', () => {
  /*
   * 🔴 If either of these two flips to `true`, any signed-in user can enumerate accounts by email
   * through the browser's own Supabase client. Nothing else in the codebase would notice.
   */
  it('is NOT executable by anon', async () => {
    await expect(canExecute('anon')).resolves.toBe(false);
  });

  it('is NOT executable by authenticated', async () => {
    await expect(canExecute('authenticated')).resolves.toBe(false);
  });

  /*
   * The CONTROL. Without it, "anon cannot execute it" passes just as happily for a function that
   * nobody can execute — including the server — which is a broken endpoint rather than a secure one,
   * and would only be discovered by a Unity developer whose licence stopped being recognised.
   */
  it('IS executable by service_role', async () => {
    await expect(canExecute('service_role')).resolves.toBe(true);
  });

  /*
   * `revoke ... from public` is the line that does the work — a grant to PUBLIC would make the two
   * role assertions above pass while every role on the database could still call it.
   */
  it('is NOT executable by PUBLIC', async () => {
    await expect(canExecute('public')).resolves.toBe(false);
  });
});
