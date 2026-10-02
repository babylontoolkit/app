/**
 * Migration 0026 against a REAL Postgres (PGlite) — managed-agents-engine plan T4.
 *
 * `FsChatIndex` mirrors these rules in TypeScript; this proves the DATABASE enforces them, with the
 * same statements `SupabaseChatIndex` issues:
 *
 *   - the transcript save (`upsert … on conflict (id) do update`, never naming the managed columns)
 *     PRESERVES the session pointer;
 *   - a save that re-homes a chat id into another project CLEARS it (the trigger) — a session never
 *     follows a chat id across projects;
 *   - the claim is a compare-and-set: insert-if-absent, then update-where-null; the first writer wins.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

let db: PGlite;

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/** The Supabase surface the migrations lean on. Mirrors `repo-primary-sql.spec.ts`. */
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

let projectA: string;
let projectB: string;

async function newProject(userId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.projects (user_id, name, template_id) values ($1, 'Game', 'racing') returning id`,
    [userId],
  );

  return rows[0].id;
}

/** Exactly what `SupabaseChatIndex.upsert` sends: the summary columns, never the managed ones. */
async function saveTranscript(id: string, projectId: string, messageCount: number): Promise<void> {
  const now = new Date().toISOString();
  await db.query(
    `insert into public.chats (id, project_id, title, message_count, created_at, updated_at)
       values ($1, $2, 'Kart', $3, $4, $4)
     on conflict (id) do update set
       project_id = excluded.project_id,
       title = excluded.title,
       message_count = excluded.message_count,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    [id, projectId, messageCount, now],
  );
}

/** Exactly what `SupabaseChatIndex.claimManagedSession` sends. */
async function claim(id: string, projectId: string, sessionId: string) {
  const now = new Date().toISOString();
  await db.query(
    `insert into public.chats (id, project_id, title, message_count, created_at, updated_at, managed_session_id)
       values ($1, $2, null, 0, $3, $3, $4)
     on conflict (id) do nothing`,
    [id, projectId, now, sessionId],
  );
  await db.query(
    `update public.chats set managed_session_id = $3
      where id = $1 and project_id = $2 and managed_session_id is null`,
    [id, projectId, sessionId],
  );

  return row(id);
}

async function row(id: string) {
  const { rows } = await db.query<{
    project_id: string;
    managed_session_id: string | null;
    managed_settled_at: string | null;
  }>(`select project_id, managed_session_id, managed_settled_at from public.chats where id = $1`, [id]);

  return rows[0];
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_PRELUDE);

  const dir = path.resolve(process.cwd(), 'supabase/migrations');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  // The real migrations, unmodified — a migration that cannot run is a finding.
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
  projectA = await newProject(USER);
  projectB = await newProject(OTHER);
});

describe('migration 0026 — managed sessions on the chat row', () => {
  it('adds managed_session_id and managed_settled_at to public.chats', async () => {
    const { rows } = await db.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'chats'
          and column_name in ('managed_session_id', 'managed_settled_at')
        order by column_name`,
    );

    expect(rows).toEqual([
      { column_name: 'managed_session_id', data_type: 'text' },
      { column_name: 'managed_settled_at', data_type: 'text' },
    ]);
  });

  it('a claim on a brand-new chat creates the row carrying the session', async () => {
    const id = randomUUID();

    expect(await claim(id, projectA, 'sesn_1')).toMatchObject({ project_id: projectA, managed_session_id: 'sesn_1' });
  });

  it('the transcript save preserves the session and the cursor', async () => {
    const id = randomUUID();
    await claim(id, projectA, 'sesn_1');
    await db.query(`update public.chats set managed_settled_at = '2026-10-01T12:00:00Z' where id = $1`, [id]);

    await saveTranscript(id, projectA, 4);

    expect(await row(id)).toEqual({
      project_id: projectA,
      managed_session_id: 'sesn_1',
      managed_settled_at: '2026-10-01T12:00:00Z',
    });
  });

  it('the first claim wins; a second claim changes nothing', async () => {
    const id = randomUUID();
    await claim(id, projectA, 'sesn_1');

    expect((await claim(id, projectA, 'sesn_2')).managed_session_id).toBe('sesn_1');
  });

  it("a claim naming another project's chat id neither re-homes the row nor overwrites its session", async () => {
    const id = randomUUID();
    await claim(id, projectA, 'sesn_1');

    expect(await claim(id, projectB, 'sesn_attacker')).toMatchObject({
      project_id: projectA,
      managed_session_id: 'sesn_1',
    });
  });

  it('🔴 a save that re-homes the chat id into another project CLEARS the session (the trigger)', async () => {
    const id = randomUUID();
    await claim(id, projectA, 'sesn_victim');
    await db.query(`update public.chats set managed_settled_at = '2026-10-01T12:00:00Z' where id = $1`, [id]);

    await saveTranscript(id, projectB, 1);

    expect(await row(id)).toEqual({ project_id: projectB, managed_session_id: null, managed_settled_at: null });
  });

  it('CONTROL: an ordinary update of the same project leaves the session alone (the trigger is scoped)', async () => {
    const id = randomUUID();
    await claim(id, projectA, 'sesn_1');

    await db.query(`update public.chats set title = 'Renamed' where id = $1`, [id]);

    expect((await row(id)).managed_session_id).toBe('sesn_1');
  });
});
