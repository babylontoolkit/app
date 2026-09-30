-- 0025 — the Unity Bridge (SPEC §4.17, spec/billing.md).
--
-- The Unity Bridge lets the agent drive the user's LOCAL Unity Editor (and Blender) through the Babylon
-- Toolkit Desktop Agent (`bt-agent bridge`), which long-polls this server over HTTPS. This migration adds:
--
--   * bridge_devices  — a paired Desktop Agent. Only the SHA-256 hash of its device token is stored.
--   * bridge_pairings — the short-lived device-code pairing handshake (10 minutes). Only the secret's hash.
--   * bridge_jobs     — the durable record of each bridge operation (queues and parked polls live in
--                       memory on the one server instance; only durable facts land here).
--   * projects.bridge_link — which device + Unity project a builder project is linked to.
--
-- All three tables have RLS ENABLED with NO POLICY, deliberately: service-role only, the git_tokens rule
-- (migration 0006). A user has no legitimate reason to read a token hash through the anon key.
--
-- Money (spec/billing.md): 'bridge' is a new ledger reason, the 'media' shape — debited BEFORE dispatch, so
-- an insufficient balance REFUSES rather than overdrawing (absent from `mayGoNegative`). A job the helper
-- never reported `started` is refunded exactly once; that "once" is enforced HERE by a partial unique index
-- on the refund's note `bridge:<jobId>` (the project_create precedent, migration 0015), never by a
-- read-then-write check in TypeScript.
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
  code         text not null,
  secret_hash  text not null,
  device_name  text not null,
  os           text not null,
  user_id      uuid references auth.users(id) on delete cascade,
  status       text not null check (status in ('pending', 'approved', 'consumed')),
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);
create index if not exists bridge_pairings_code_idx on public.bridge_pairings (code) where status = 'pending';
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
  credits      integer not null default 0,
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

alter table public.projects add column if not exists bridge_link jsonb;

alter table public.credit_ledger drop constraint if exists credit_ledger_reason_check;
alter table public.credit_ledger add constraint credit_ledger_reason_check
  check (reason in ('grant', 'purchase', 'generation', 'media', 'search', 'project_create', 'bridge', 'refund', 'promo', 'adjustment'));

-- Exactly one refund per bridge job, enforced by the database (D13; the project_create precedent, 0015).
create unique index if not exists credit_ledger_bridge_refund_idx
  on public.credit_ledger (user_id, note)
  where reason = 'refund' and note like 'bridge:%';
