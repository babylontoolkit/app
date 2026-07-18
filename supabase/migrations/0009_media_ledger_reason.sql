-- 0009 — the 'media' ledger reason (SPEC §4.16, spec/billing.md).
--
-- Built-in image/video generation debits credits UP-FRONT at a known price (the Marketplace price
-- list), unlike LLM generations which settle after spend. That difference is why it is a NEW reason
-- rather than a reuse of 'generation':
--
--   * 'generation' debits MAY go negative (settlement can never refuse, §4.2.1). A media debit runs
--     BEFORE any money is spent at KIE, so there is never a reason to overdraw — the ledger writers
--     pass allow_negative=false for 'media', and an insufficient balance REFUSES the render before
--     the task is created.
--   * Admin reporting separates media spend from LLM spend directly off the reason column.
--
-- Refunds for failed renders reuse the existing 'refund' reason, anchored to the same
-- generation_id (media tasks anchor a generations row exactly like LLM generations do, so the
-- credit_ledger.generation_id foreign key holds).
alter table public.credit_ledger
  drop constraint if exists credit_ledger_reason_check;

alter table public.credit_ledger
  add constraint credit_ledger_reason_check
  check (reason in ('grant', 'purchase', 'generation', 'media', 'refund', 'promo', 'adjustment'));
