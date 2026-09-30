-- 0025 — the Unity Bridge (SPEC §4.17).
--
-- The Unity Bridge lets the agent drive the user's LOCAL Unity Editor (and Blender) through the Babylon
-- Toolkit Desktop Agent (`bt-agent bridge`), which long-polls this server over HTTPS. This migration adds:
--
--   * bridge_devices  — a paired Desktop Agent. Only the SHA-256 hash of its device token is stored.
--   * bridge_pairings — single-use install codes (10 minutes). A signed-in user mints one in the Unity Bridge
--                       dialog; the helper claims it with `--pair <code>` (D55). Only the code's SHA-256
--                       hash is stored — the plaintext code never is.
--   * bridge_jobs     — the durable record of each bridge operation (queues and parked polls live in
--                       memory on the one server instance; only durable facts land here).
--
-- There is NO project link (D54, owner 2026-09-29): a builder project is never tied to a device or a Unity
-- project. The model opens or creates the Unity project it works on through the helper. There is no
-- per-device "Allow scripts" column either (D55): scripts are allowed unless the helper runs with
-- `--no-scripts`, which only the user's own computer decides.
--
-- All three tables have RLS ENABLED with NO POLICY, deliberately: service-role only, the git_tokens rule
-- (migration 0006). A user has no legitimate reason to read a token hash through the anon key.
--
-- Money: NONE. Bridge operations are not billed separately; the model turn that drives Unity/Blender is
-- billed like any generation (owner, 2026-09-29, D53). This migration deliberately does NOT touch
-- credit_ledger — there is no 'bridge' ledger reason and no credits column on a job.
create table if not exists public.bridge_devices (
  id            text primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  os            text not null,
  token_hash    text not null unique,
  capabilities  jsonb,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);
create index if not exists bridge_devices_user_idx on public.bridge_devices (user_id);
alter table public.bridge_devices enable row level security;
-- NO POLICY, deliberately (service-role only, the git_tokens rule, migration 0006).

create table if not exists public.bridge_pairings (
  id           text primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  secret_hash  text not null unique,
  status       text not null check (status in ('pending', 'consumed')),
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);
alter table public.bridge_pairings enable row level security;
-- NO POLICY, deliberately.

create table if not exists public.bridge_jobs (
  id           text primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  project_id   uuid not null references public.projects(id) on delete cascade,
  device_id    text not null,
  operation    text not null,
  tier         text not null check (tier in ('allowed', 'scripts', 'consent')),
  status       text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'refused', 'cancelled')),
  started      boolean not null default false,
  result_text  text,
  error        text,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz,
  reported_at  timestamptz
);
create index if not exists bridge_jobs_project_idx on public.bridge_jobs (project_id, created_at desc);
alter table public.bridge_jobs enable row level security;
-- NO POLICY, deliberately.
