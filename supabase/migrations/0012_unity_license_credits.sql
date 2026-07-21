-- 0012 — the 'license' ledger reason + Unity license unlock records (SPEC §4.18, §4.6.1).
--
-- Generating a Unity Project License is now a FLAT credit charge (the price ladder: Indie / SmallBusiness
-- / PremiumContent), replacing the retired PayPal annual Pro Tools subscription. The credit balance IS
-- the entitlement — no credits, no Pro Tools. Two pieces:
--
-- 1. The 'license' ledger reason. Like 'media' (migration 0009) and UNLIKE 'generation', a license debit
--    runs BEFORE the license is issued and may NEVER overdraw — the ledger writers pass
--    allow_negative=false for it (it is absent from `mayGoNegative`), so an insufficient balance REFUSES
--    the generation. It is a flat PRICE, not cost-recovery, so it is not anchored to a generations row
--    (generation_id stays null, like 'grant'/'search'); the charge stands on the reason + note alone.
--    Admin reporting separates license revenue from LLM/media spend directly off the reason column.
--
-- 2. `unity_license_entitlements` — one row per (user, unity_project_id, tier) the user has PAID to
--    unlock. "Once per project+tier, re-download free" (owner decision 2026-07-20): the first generation
--    of a (unity project, tier) pair debits and inserts a row; every later (re)generation of that same
--    pair sees the row and is issued free. The unlock is keyed to the UNITY project id (the productGUID
--    the license is cryptographically locked to), NOT the App Builder project — otherwise a user could
--    re-link many Unity GUIDs to one App Builder project and mint many perpetual licenses for one payment.
alter table public.credit_ledger
  drop constraint if exists credit_ledger_reason_check;

alter table public.credit_ledger
  add constraint credit_ledger_reason_check
  check (reason in ('grant', 'purchase', 'generation', 'media', 'search', 'license', 'refund', 'promo', 'adjustment'));

create table if not exists public.unity_license_entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- The Unity project GUID (PlayerSettings.productGUID), 32 lowercase hex chars. The value the license
  -- is locked to. Not an FK — Unity projects are not platform rows.
  unity_project_id text not null,

  -- The license tier the user paid to unlock: 'Indie' | 'SmallBusiness' | 'PremiumContent'.
  tier text not null check (tier in ('Indie', 'SmallBusiness', 'PremiumContent')),

  -- The credit_ledger row id of the debit that paid for this unlock (audit trail; null for a
  -- pre-existing/admin grant or an unmetered-mode issue).
  ledger_entry_id text,

  created_at timestamptz not null default now()
);

-- A user unlocks a given (unity project, tier) exactly once, however many times generation is retried.
create unique index if not exists unity_license_entitlements_user_project_tier_idx
  on public.unity_license_entitlements(user_id, unity_project_id, tier);

create index if not exists unity_license_entitlements_user_idx
  on public.unity_license_entitlements(user_id, created_at desc);

alter table public.unity_license_entitlements enable row level security;

-- Owner may read their own unlocks. Writes go through the service-role license path only (like the
-- credit ledger and asset_entitlements): there is deliberately no user insert/update/delete policy.
create policy "unity_license_entitlements: owner read" on public.unity_license_entitlements
  for select using (auth.uid() = user_id);
