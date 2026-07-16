-- Premium store-asset entitlements (SPEC §4.9).
--
-- A store asset marked `premium` in app/config/assets.json may enter a project only if the user owns it.
-- Ownership is one row here, granted by the Stripe webhook on a one-time purchase (mode: payment). This
-- is deliberately SEPARATE from the credit ledger (credits are consumable; an asset purchase is a
-- durable grant) and from Pro `entitlements` (a subscription from the license service, not a purchase).
--
-- Idempotency is enforced by the DATABASE, not app code: a unique index on payment_ref catches a Stripe
-- retry, and a partial unique index on (user_id, asset_id) means a user owns a given asset exactly once,
-- however many times a webhook is replayed or a second tab races.

create table if not exists public.asset_entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- The catalog id from app/config/assets.json (e.g. 'prefab_standard_car'). Not an FK — the catalog is
  -- versioned config in the repo, not a table.
  asset_id text not null,

  -- The Stripe checkout session id, for idempotency. Null only for a manual/admin grant.
  payment_ref text,

  created_at timestamptz not null default now()
);

-- A user owns a given asset once.
create unique index if not exists asset_entitlements_user_asset_idx
  on public.asset_entitlements(user_id, asset_id);

-- A Stripe delivery grants once.
create unique index if not exists asset_entitlements_payment_ref_idx
  on public.asset_entitlements(payment_ref)
  where payment_ref is not null;

create index if not exists asset_entitlements_user_idx
  on public.asset_entitlements(user_id, created_at desc);

alter table public.asset_entitlements enable row level security;

-- Owner may read their own entitlements. Writes go through the service-role webhook path only (like the
-- credit ledger): there is deliberately no user insert/update/delete policy.
create policy "asset_entitlements: owner read" on public.asset_entitlements
  for select using (auth.uid() = user_id);
