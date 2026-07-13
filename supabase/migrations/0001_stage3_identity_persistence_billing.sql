-- ============================================================================================
-- Stage 3 — identity, persistence, and money (SPEC §4.5, §4.6, §4.6.1)
--
-- RLS is ON for every user-facing table, and it is the BACKSTOP, not the front door: the server
-- middleware (`requireOwnedProject`) checks ownership before any of this is reached (§4.5.3). Both
-- exist because either alone has failed in the wild — a forgotten `.eq('user_id', …)` becomes a
-- full-table leak without RLS, and RLS cannot protect the service-role paths (grants, webhooks,
-- entitlements) that bypass it BY DESIGN.
-- ============================================================================================

-- --------------------------------------------------------------------------------------------
-- profiles
-- --------------------------------------------------------------------------------------------
create table if not exists public.profiles (
  id                 uuid primary key references auth.users(id) on delete cascade,
  display_name       text,
  avatar_url         text,
  stripe_customer_id text,

  -- Honored ONLY while an active Pro entitlement exists (§4.6.1). This flag alone unlocks nothing.
  byok_enabled       boolean not null default false,

  -- Admin is granted HERE, never from `user_metadata` — which the user can write to themselves.
  is_admin           boolean not null default false,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles: read own" on public.profiles
  for select using (auth.uid() = id);

-- Note the WITH CHECK: without it a user could UPDATE their row and set `id` to someone else's.
create policy "profiles: update own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- `is_admin` and `byok_enabled` are deliberately NOT user-writable: this trigger reverts any attempt.
create or replace function public.protect_privileged_profile_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    new.is_admin := old.is_admin;
    new.byok_enabled := old.byok_enabled;
    new.stripe_customer_id := old.stripe_customer_id;
  end if;

  new.updated_at := now();

  return new;
end;
$$;

drop trigger if exists protect_privileged_profile_columns on public.profiles;
create trigger protect_privileged_profile_columns
  before update on public.profiles
  for each row execute function public.protect_privileged_profile_columns();

-- Auto-create the profile on first sign-in (§4.5.2).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'name',
      split_part(new.email, '@', 1)
    ),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- --------------------------------------------------------------------------------------------
-- projects
-- --------------------------------------------------------------------------------------------
create table if not exists public.projects (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users(id) on delete cascade,
  name                    text not null,
  template_id             text not null,

  -- Public play key (§4.8). Unique across the platform; null until the project is shared.
  share_id                text unique,

  current_snapshot_id     uuid,

  -- GitHub Sync (§4.13) — exactly one linked repo + branch per project.
  linked_repo             text,
  linked_branch           text,
  last_synced_commit_sha  text,
  github_installation_ref text,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists projects_user_id_idx on public.projects(user_id);
create index if not exists projects_share_id_idx on public.projects(share_id) where share_id is not null;

alter table public.projects enable row level security;

create policy "projects: owner full access" on public.projects
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- The ONLY unauthenticated project read: a published game, and only the row that was published.
create policy "projects: public read when shared" on public.projects
  for select using (share_id is not null);

-- --------------------------------------------------------------------------------------------
-- snapshots  (payload bytes live in object storage; only metadata is here)
-- --------------------------------------------------------------------------------------------
create table if not exists public.snapshots (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  storage_path  text not null,
  file_manifest jsonb not null default '[]'::jsonb,
  message_id    text,
  label         text,
  created_at    timestamptz not null default now()
);

create index if not exists snapshots_project_id_idx on public.snapshots(project_id, created_at);

alter table public.snapshots enable row level security;

-- Ownership is inherited from the project. A snapshot is never addressable on its own.
create policy "snapshots: via owned project" on public.snapshots
  for all using (
    exists (select 1 from public.projects p where p.id = snapshots.project_id and p.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.projects p where p.id = snapshots.project_id and p.user_id = auth.uid())
  );

-- --------------------------------------------------------------------------------------------
-- generations  (usage + cost record; the thing every ledger debit points at)
-- --------------------------------------------------------------------------------------------
create table if not exists public.generations (
  id                    text primary key,
  user_id               uuid not null references auth.users(id) on delete cascade,
  project_id            uuid references public.projects(id) on delete set null,
  message_id            text,
  model                 text not null,
  prompt_version_id     text,

  -- UNCACHED input. Anthropic reports cached input separately, and the two cache columns below are
  -- NOT decoration: cache writes bill at 2x (the 1h tier, §4.2.8) and reads at 0.1x.
  input_tokens          integer not null default 0,
  cached_input_tokens   integer not null default 0,
  cache_write_tokens    integer not null default 0,
  output_tokens         integer not null default 0,

  skills_loaded         text[] not null default '{}',
  credits_charged       integer not null default 0,
  raw_cost_usd          numeric(12, 6) not null default 0,
  status                text not null default 'completed',
  error                 text,
  created_at            timestamptz not null default now()
);

create index if not exists generations_user_id_idx on public.generations(user_id, created_at desc);

alter table public.generations enable row level security;

create policy "generations: read own" on public.generations
  for select using (auth.uid() = user_id);

-- --------------------------------------------------------------------------------------------
-- credit_ledger  — APPEND-ONLY. Balance is DERIVED (§4.6).
-- --------------------------------------------------------------------------------------------
create table if not exists public.credit_ledger (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,

  -- Signed: positive credits, negative debits.
  delta            integer not null,

  reason           text not null check (reason in ('grant', 'purchase', 'generation', 'refund', 'promo', 'adjustment')),
  generation_id    text references public.generations(id) on delete set null,
  payment_provider text,
  payment_ref      text,

  -- Derived by `append_ledger_entry` under a lock. NEVER supplied by a caller.
  balance_after    integer not null,

  note             text,
  created_at       timestamptz not null default now()
);

create index if not exists credit_ledger_user_id_idx on public.credit_ledger(user_id, created_at desc);

-- ⚠️ THE GRANT-INTEGRITY GUARD (§4.5.4). One grant per user, forever.
--
-- A read-then-write check in application code would let two concurrent sign-ins both observe "no
-- grant yet" and both grant. This index means the database refuses the second one, whatever the
-- application believes.
create unique index if not exists credit_ledger_one_grant_per_user
  on public.credit_ledger(user_id) where reason = 'grant';

-- ⚠️ THE PAYMENT-IDEMPOTENCY GUARD (§4.6). Stripe RETRIES deliveries; this is what makes that safe.
create unique index if not exists credit_ledger_unique_payment_ref
  on public.credit_ledger(payment_ref) where payment_ref is not null;

alter table public.credit_ledger enable row level security;

-- Read-only to the user. There is no insert/update/delete policy AT ALL, deliberately: every write
-- goes through `append_ledger_entry` (security definer). A user cannot append their own credits.
create policy "credit_ledger: read own" on public.credit_ledger
  for select using (auth.uid() = user_id);

-- Append-only, enforced by the database rather than by convention.
create or replace function public.forbid_ledger_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'credit_ledger is append-only: rows may not be updated or deleted. Append a compensating entry instead.';
end;
$$;

drop trigger if exists forbid_ledger_update on public.credit_ledger;
create trigger forbid_ledger_update
  before update or delete on public.credit_ledger
  for each row execute function public.forbid_ledger_mutation();

-- --------------------------------------------------------------------------------------------
-- append_ledger_entry — the ONLY way a ledger row is written.
--
-- Deriving `balance_after` correctly requires read-latest-then-insert to be ATOMIC. Doing that in
-- TypeScript is a lost update: two concurrent generations both read balance 100, both write 60, and
-- the user paid once for two generations. The row lock below is what makes concurrent settlements
-- serialize.
-- --------------------------------------------------------------------------------------------
create or replace function public.append_ledger_entry(
  p_user_id          uuid,
  p_delta            integer,
  p_reason           text,
  p_generation_id    text default null,
  p_payment_provider text default null,
  p_payment_ref      text default null,
  p_note             text default null,
  p_allow_negative   boolean default false
)
returns public.credit_ledger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_previous integer;
  v_balance  integer;
  v_row      public.credit_ledger;
begin
  -- Serialize concurrent appends for THIS user. Two settlements landing at once now queue rather
  -- than both reading the same stale balance.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select balance_after into v_previous
  from public.credit_ledger
  where user_id = p_user_id
  order by created_at desc, id desc
  limit 1;

  v_balance := coalesce(v_previous, 0) + p_delta;

  -- A `generation` debit MAY go negative: we settle AFTER the tokens are spent, and §4.2.1 forbids
  -- killing an in-flight generation for balance. Reality is allowed to overshoot; the gate on the
  -- NEXT generation is what catches it. Nothing else may.
  if v_balance < 0 and not p_allow_negative then
    raise exception 'Insufficient credits: balance would become %', v_balance
      using errcode = 'check_violation';
  end if;

  insert into public.credit_ledger (
    user_id, delta, reason, generation_id, payment_provider, payment_ref, balance_after, note
  ) values (
    p_user_id, p_delta, p_reason, p_generation_id, p_payment_provider, p_payment_ref, v_balance, p_note
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.append_ledger_entry from public, anon, authenticated;
grant execute on function public.append_ledger_entry to service_role;

-- --------------------------------------------------------------------------------------------
-- entitlements (§4.6.1) — Pro Tools, via the license service. The ONLY Pro-gated thing is BYOK.
-- --------------------------------------------------------------------------------------------
create table if not exists public.entitlements (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null unique references auth.users(id) on delete cascade,
  source            text not null default 'protools_subscription',
  tier              text check (tier in ('indie', 'small_business', 'enterprise')),
  status            text not null default 'lapsed' check (status in ('active', 'lapsed')),

  -- Often NOT the platform email — hence the self-serve link flow (§4.6.1).
  subscriber_email  text not null,

  last_validated_at timestamptz not null default now(),
  expires_at        timestamptz,
  created_at        timestamptz not null default now()
);

alter table public.entitlements enable row level security;

-- Read-only to the user. Only the server (service_role, after asking the license service) may write.
create policy "entitlements: read own" on public.entitlements
  for select using (auth.uid() = user_id);

-- --------------------------------------------------------------------------------------------
-- credit_packs (§4.6) — mirrors the server config; retail pricing tunes without a schema change.
-- --------------------------------------------------------------------------------------------
create table if not exists public.credit_packs (
  id                  text primary key,
  name                text not null,
  credits             integer not null,
  price_cents         integer not null,
  provider_price_ref  text,
  is_active           boolean not null default true
);

alter table public.credit_packs enable row level security;

create policy "credit_packs: public read" on public.credit_packs
  for select using (is_active);
