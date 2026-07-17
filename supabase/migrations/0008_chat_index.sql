-- --------------------------------------------------------------------------------------------
-- 0008 — the chat index (SPEC §4.5.6, §4.5.4b)
--
-- The sidebar was a view of the BROWSER, not of the account. It rendered `getAll(indexedDb)`, so a chat
-- started on a laptop did not exist on a desktop, and clearing site data destroyed the list. Meanwhile
-- the transcripts themselves were already on the server (`messages/{projectId}/{chatId}.json`) — the
-- data was there and nothing listed it. This table is what makes the sidebar follow the user: the
-- browser becomes a local staging area, the platform holds the project record and the conversation, and
-- the user's CODE stays in their own repo (§4.5.4b).
--
-- ## Why an index at all, when the transcript already knows its own title
--
-- `message-store.ts` deliberately keeps the title INSIDE the transcript object — one home for the truth,
-- no index that can disagree with the thing it names. That reasoning holds for one project (`listChats`
-- costs one `get` per chat, bounded by MAX_CHATS_PER_PROJECT).
--
-- It does not survive a GLOBAL list. Rendering a sidebar of every chat the user has would mean reading
-- every transcript body on the platform — megabytes of messages fetched and thrown away to display a
-- row of titles — on every page load. So metadata moves into a table that can be queried, and the body
-- stays an object.
--
-- ## The objects remain the truth about EXISTENCE
--
-- This is a cache of metadata, not the register of what exists. If a row is missing, the chat is still
-- there and still readable: `listChats` reconciles against the object prefix and backfills. That
-- ordering is deliberate — an index that is authoritative about existence turns a failed write into a
-- conversation that is silently gone, which is the exact orphan shape §4.5.4b keeps producing (bytes
-- outliving the record that named them). Here the bytes outlive nothing; they ARE the record.
--
-- ## There is no `url_id`, deliberately
--
-- A chat's URL is `/chat/<id>` — this uuid. Upstream routed `/chat/<slug-of-the-title>`, de-duplicated
-- against ONE browser's IndexedDB (`getUrlId` appends `-2`). That cannot be a key here: two users who
-- both type "start dev server" produce the same slug, and the de-duplication cannot see across
-- accounts. It also puts the conversation's title in the URL bar and every proxy log on the way. A
-- column for it would be written and never read — and this schema has already learned what an unread
-- field does (`current_snapshot_id`, migration 0007: a field named for a system nobody uses is how the
-- system comes back).
--
-- ## Ownership is inherited, never denormalised
--
-- No `user_id` column, deliberately — it would be a second home for ownership and it would be the one
-- the sidebar trusted. `snapshots` established the pattern in 0001 and it is the right one: a chat is
-- never addressable on its own, so ownership is derived from its project every time it is asked for.
-- --------------------------------------------------------------------------------------------

create table if not exists public.chats (
  -- The server-minted chat id (§4.5.6). NEVER the browser's local id: `getNextId` is a per-browser
  -- counter, so every browser's first chat is "1" and two devices would collide on one row.
  id           uuid primary key,

  project_id   uuid not null references public.projects(id) on delete cascade,

  -- Nullable: a chat is indexed from its first save, and it may not have been named yet.
  title        text,

  message_count integer not null default 0,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- The sidebar query: a user's chats, newest activity first. `project_id` leads because ownership is
-- resolved by joining projects — there is no user_id here to index on.
create index if not exists chats_project_updated_idx on public.chats(project_id, updated_at desc);

alter table public.chats enable row level security;

-- Ownership is inherited from the project — the `snapshots` pattern from 0001. A chat is never
-- addressable on its own, so there is no path to one that does not go through a project the caller owns.
create policy "chats: via owned project" on public.chats
  for all using (
    exists (select 1 from public.projects p where p.id = chats.project_id and p.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.projects p where p.id = chats.project_id and p.user_id = auth.uid())
  );
