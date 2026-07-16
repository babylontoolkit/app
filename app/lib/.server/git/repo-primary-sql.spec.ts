/**
 * Repo-primary persistence, against a REAL Postgres (SPEC §4.5.4b, migration 0006).
 *
 * Same reasoning as `ledger-sql.spec.ts`, applied to a different money-shaped path. `FsGitTokenStore`
 * is a TypeScript mirror: it has no foreign keys, no check constraints, no primary key, and no RLS. It
 * can prove we wrote the rules twice; it cannot prove the DATABASE enforces them — and the database is
 * what runs in production.
 *
 * The stakes here are not credits, they are the user's only copy of their game:
 *   - a `git_tokens` PK that does not match `onConflict: 'user_id,provider'` means re-connecting
 *     ACCUMULATES rows instead of replacing, and `get` picks one at random — saves that work on
 *     Tuesday and fail on Wednesday with nothing having changed;
 *   - an RLS policy on `git_tokens` hands the browser back the credential §4.5.4b just took out of it;
 *   - a `provider`/`linked_repo` pair that can go half-null is a project that believes it is saved.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

let db: PGlite;

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/** The Supabase surface migration 0001 leans on. Mirrors `ledger-sql.spec.ts`. */
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

/** Insert a project, returning the error message if Postgres refused it. */
async function insertProject(columns: Record<string, unknown>): Promise<string | null> {
  const full = { user_id: USER, name: 'A game', template_id: 'racing', ...columns };
  const keys = Object.keys(full);
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');

  try {
    await db.query(`insert into public.projects (${keys.join(', ')}) values (${placeholders})`, Object.values(full));
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

async function putToken(over: Record<string, unknown> = {}): Promise<string | null> {
  const row = {
    user_id: USER,
    provider: 'github',
    access_token_encrypted: 'iv.tag.ciphertext',
    provider_login: 'octocat',
    updated_at: new Date().toISOString(),
    ...over,
  };
  const keys = Object.keys(row);

  try {
    await db.query(
      `insert into public.git_tokens (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})
       on conflict (user_id, provider) do update set
         access_token_encrypted = excluded.access_token_encrypted,
         provider_login = excluded.provider_login,
         updated_at = excluded.updated_at`,
      Object.values(row),
    );

    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_PRELUDE);

  const dir = path.resolve(process.cwd(), 'supabase/migrations');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  // The real migrations, unmodified — including 0006. A migration that cannot run is a finding.
  for (const file of files) {
    await db.exec(await fs.readFile(path.join(dir, file), 'utf8'));
  }
}, 60_000);

beforeEach(async () => {
  await db.exec(`delete from auth.users cascade;`);
  await db.query(`insert into auth.users (id, email) values ($1, 'a@example.com'), ($2, 'b@example.com')`, [
    USER,
    OTHER,
  ]);
});

describe('git_tokens — the credential table', () => {
  it('exists after the migrations run', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' and table_name = 'git_tokens'`,
    );

    expect(rows).toHaveLength(1);
  });

  it('has RLS ENABLED', async () => {
    const { rows } = await db.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = 'git_tokens'`,
    );

    expect(rows[0]?.relrowsecurity).toBe(true);
  });

  /**
   * 🔴 The point of the whole table. RLS on + zero policies = service role only.
   *
   * If someone adds "owner can read their own row" in good faith while building a connections UI, this
   * fails — which is the entire reason it is asserted rather than only commented. §4.5.4b took this
   * credential out of the browser; a select policy is how it silently gets back in.
   */
  it('has NO policy at all — not an omission, the design (§4.5.4b, §5)', async () => {
    const { rows } = await db.query<{ policyname: string }>(
      `select policyname from pg_policies where schemaname = 'public' and tablename = 'git_tokens'`,
    );

    expect(rows.map((r) => r.policyname)).toEqual([]);
  });

  /** Contrast, so the assertion above cannot pass by RLS being broken platform-wide. */
  it('sits alongside tables that DO have owner policies', async () => {
    const { rows } = await db.query<{ policyname: string }>(
      `select policyname from pg_policies where schemaname = 'public' and tablename = 'projects'`,
    );

    expect(rows.length).toBeGreaterThan(0);
  });

  /**
   * The PK must be exactly what `SupabaseGitTokenStore.put` names in `onConflict: 'user_id,provider'`.
   * A mismatch does not throw at boot — it throws on the user's first re-connect, mid-save.
   */
  it('keys on (user_id, provider), matching the store’s onConflict', async () => {
    const { rows } = await db.query<{ attname: string }>(
      `select a.attname
         from pg_index i
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = 'public.git_tokens'::regclass and i.indisprimary
        order by a.attname`,
    );

    expect(rows.map((r) => r.attname)).toEqual(['provider', 'user_id']);
  });

  it('REPLACES on re-connect rather than accumulating a second row', async () => {
    expect(await putToken({ access_token_encrypted: 'first', provider_login: 'octocat' })).toBeNull();
    expect(await putToken({ access_token_encrypted: 'second', provider_login: 'octocat-renamed' })).toBeNull();

    const { rows } = await db.query<{ access_token_encrypted: string; provider_login: string }>(
      `select access_token_encrypted, provider_login from public.git_tokens where user_id = $1`,
      [USER],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ access_token_encrypted: 'second', provider_login: 'octocat-renamed' });
  });

  it('lets one user hold a github AND a gitlab token', async () => {
    expect(await putToken({ provider: 'github' })).toBeNull();
    expect(await putToken({ provider: 'gitlab' })).toBeNull();

    const { rows } = await db.query(`select 1 from public.git_tokens where user_id = $1`, [USER]);
    expect(rows).toHaveLength(2);
  });

  it('rejects a provider it has no adapter for', async () => {
    expect(await putToken({ provider: 'bitbucket' })).toMatch(/git_tokens_provider_check|violates check constraint/i);
  });

  /** A deleted account must not leave a live write credential behind in our database. */
  it('CASCADES on user deletion — a closed account leaves no usable token', async () => {
    await putToken();
    await db.query(`delete from auth.users where id = $1`, [USER]);

    const { rows } = await db.query(`select 1 from public.git_tokens`);
    expect(rows).toEqual([]);
  });

  it('refuses a token for a user that does not exist', async () => {
    const result = await putToken({ user_id: '33333333-3333-4333-8333-333333333333' });
    expect(result).toMatch(/foreign key|violates/i);
  });
});

describe('projects — the link is all-or-nothing', () => {
  it('defaults a new project to UNLINKED: no provider, auto_push on', async () => {
    expect(await insertProject({})).toBeNull();

    const { rows } = await db.query<{ provider: string | null; auto_push: boolean; linked_repo: string | null }>(
      `select provider, auto_push, linked_repo from public.projects where user_id = $1`,
      [USER],
    );

    expect(rows[0]).toMatchObject({ provider: null, linked_repo: null, auto_push: true });
  });

  it('accepts a fully linked project', async () => {
    expect(
      await insertProject({ provider: 'github', linked_repo: 'octocat/my-game', linked_branch: 'main' }),
    ).toBeNull();
  });

  /**
   * A half-written link is the failure §4.5.4b cannot tolerate: the UI reads "linked" and shows a
   * saved badge, and the save path has no provider to resolve — so the user is told their only copy is
   * safe while nothing is being written anywhere.
   */
  it.each([
    ['a provider with no repo', { provider: 'github' }],
    ['a repo with no provider', { linked_repo: 'octocat/my-game', linked_branch: 'main' }],
    ['a repo with no branch', { provider: 'github', linked_repo: 'octocat/my-game' }],
    ['a branch with no repo', { provider: 'github', linked_branch: 'main' }],
  ])('REFUSES %s', async (_label, columns) => {
    expect(await insertProject(columns)).toMatch(/projects_link_complete_check|violates check constraint/i);
  });

  it('rejects a provider it has no adapter for', async () => {
    const result = await insertProject({ provider: 'svn', linked_repo: 'x/y', linked_branch: 'main' });
    expect(result).toMatch(/projects_provider_check|violates check constraint/i);
  });

  it('keeps auto_push non-null — an unset save preference is not a thing', async () => {
    expect(await insertProject({ auto_push: null })).toMatch(/null value|not-null/i);
  });
});
