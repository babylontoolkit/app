-- 0015 — the 'project_create' ledger reason (SPEC §4.4a, §4.6, spec/billing.md).
--
-- Creating a New Project is now a flat credit charge (`PROJECT_CREATE_CREDITS`, default 150), debited at
-- project registration. It replaces the flat 500-credit price the CREATION GENERATION used to carry: under
-- the project-first flow (2026-07-29) creation runs no generation at all — it clones the starter template,
-- installs and serves it — and the build turn that follows bills cost-derived like any other turn. The two
-- are different charges for different work, which is exactly why this is a new reason and not a reuse.
--
-- It is the 'media' shape, NOT the 'search' shape, and the distinction is the whole point:
--
--   * 'search' (0010) debits AFTER a vendor was already paid, mid-generation, so refusing it would only
--     lose the audit trail — it MAY overdraw.
--   * 'project_create' debits BEFORE anything is provisioned (no project row, no VM, no template fetch),
--     so an insufficient balance must REFUSE, not overdraw. It is absent from `mayGoNegative`, and the
--     ledger writers pass allow_negative=false for it. A refusal leaves nothing half-made — categorically
--     different from a mid-creation failure, and the only thing permitted to stop a creation.
--
-- It is a flat PRICE, not cost-recovery, so it is not anchored to a generations row (generation_id stays
-- null, like 'grant'/'search') — the charge stands on the reason + note alone. Admin reporting
-- separates project-creation revenue from LLM/media spend directly off the reason column, and the refund
-- of a project deleted before it ever completed a generation reuses 'refund'.
alter table public.credit_ledger
  drop constraint if exists credit_ledger_reason_check;

alter table public.credit_ledger
  add constraint credit_ledger_reason_check
  check (reason in ('grant', 'purchase', 'generation', 'media', 'search', 'project_create', 'refund', 'promo', 'adjustment'));

-- The project-create refund happens AT MOST ONCE per project, and that is enforced HERE — not by a
-- read-then-write check in TypeScript.
--
-- A check is a race, and this one is reachable by ordinary use: two tabs, or a double-clicked Delete,
-- both read "not refunded yet" and both insert, MINTING the creation price. It is the same lesson as the
-- signup grant and Stripe payment idempotency (migration 0001) — both of those are partial unique
-- indexes for exactly this reason, and both were once app-level checks.
--
-- Scoped to the `project_create:%` note prefix on purpose: other refunds (`generation`, `media`)
-- carry free-text notes that legitimately REPEAT — "Generation failed" arrives many times for
-- one user — so a blanket unique index on (user_id, note) would reject every second generation refund and
-- leave users unrefunded. The predicate is what keeps this guard narrow enough to be safe.
create unique index if not exists credit_ledger_project_create_refund_idx
  on public.credit_ledger (user_id, note)
  where reason = 'refund' and note like 'project\_create:%';
