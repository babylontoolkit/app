-- ============================================================================================
-- 0004 — Share / Gallery / Remix (§4.8), Assets (§4.9), Game Backend link (§4.15)
--
-- Stage 4 surface. Additive only: new nullable columns on `projects`, and two new tables. Nothing
-- here changes an existing money rule, so the guarantees pinned by `ledger-sql.spec.ts` are untouched
-- — but this file runs in that same PGlite harness, so a syntax error here fails that test too.
-- ============================================================================================

-- --------------------------------------------------------------------------------------------
-- projects: publishing + gallery + remix provenance
--
-- `share_id` and the GitHub-link columns already exist from 0001. These are the rest of the publish
-- metadata: the public title/blurb, when it was last published, the solo-launch flag, the gallery
-- moderation state, and where a remix came from.
-- --------------------------------------------------------------------------------------------
alter table public.projects add column if not exists share_title       text;
alter table public.projects add column if not exists share_description text;
alter table public.projects add column if not exists shared_at         timestamptz;
alter table public.projects add column if not exists solo_launch       boolean not null default false;
alter table public.projects add column if not exists remixed_from      uuid references public.projects(id) on delete set null;

-- Gallery moderation. The user may only ever move a project to 'pending'; 'approved'/'rejected' are an
-- admin action (§5: nothing public without approval). Enforced in the route layer, constrained here.
alter table public.projects add column if not exists gallery_status text not null default 'none'
  check (gallery_status in ('none', 'pending', 'approved', 'rejected'));

-- The gallery grid queries "approved games, newest first". Partial so the index only carries the
-- handful of approved rows, not every private project on the platform.
create index if not exists projects_gallery_idx
  on public.projects(shared_at desc)
  where gallery_status = 'approved';

-- Report link → admin queue (§5). A published game anyone can flag; the admin unpublishes or dismisses.
create table if not exists public.play_reports (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects(id) on delete cascade,
  share_id     text not null,
  reason       text,
  -- Nullable: a report can come from an anonymous player on a public /play page.
  reporter_id  uuid references auth.users(id) on delete set null,
  status       text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  created_at   timestamptz not null default now()
);

create index if not exists play_reports_open_idx on public.play_reports(created_at desc) where status = 'open';

alter table public.play_reports enable row level security;

-- Anyone (even anonymous) may FILE a report on a public game — that is the whole point of the link.
-- Reading and resolving the queue is admin-only, and admin runs through the service-role client which
-- bypasses RLS, so there is deliberately no select policy for ordinary users here.
create policy "play_reports: anyone may file" on public.play_reports
  for insert with check (true);

-- --------------------------------------------------------------------------------------------
-- assets (§4.9) — per-user uploaded models/textures/audio
--
-- Store assets (hosted scenes, prefabs, packs) are static catalog config in the repo, NOT rows here.
-- This table is only USER UPLOADS: the bytes live in object storage (per-user prefix, quota-counted),
-- and this row is the metadata + the introspection summary the agent reads (§4.9 "the agent knows
-- what it just got").
-- --------------------------------------------------------------------------------------------
create table if not exists public.user_assets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  -- Optional: an asset may be scoped to one project or live in the account library (§4.9).
  project_id    uuid references public.projects(id) on delete cascade,
  filename      text not null,
  content_type  text not null,
  byte_size     bigint not null,
  storage_path  text not null,
  kind          text not null check (kind in ('model', 'texture', 'audio', 'scene', 'other')),
  -- The glTF component/extras breakdown injected into agent context (§4.9). Null for non-glTF assets.
  introspection jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists user_assets_user_idx on public.user_assets(user_id, created_at desc);
create index if not exists user_assets_project_idx on public.user_assets(project_id) where project_id is not null;

alter table public.user_assets enable row level security;

create policy "user_assets: owner full access" on public.user_assets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- --------------------------------------------------------------------------------------------
-- projects: Game Backend link (§4.15)
--
-- The user's OWN Supabase project ("Game Backend"). We store ONLY the public-by-design values (the
-- project ref and, for the agent's RLS-first scaffolding, whether a backend is connected). The anon
-- key and URL are the user's and are public; the management PAT is NEVER stored server-side — it stays
-- in the user's browser (the upstream connector owns it). This is a pointer, not a credential store.
-- --------------------------------------------------------------------------------------------
alter table public.projects add column if not exists game_backend_ref text;
