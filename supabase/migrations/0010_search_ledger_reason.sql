-- 0010 — the 'search' ledger reason (SPEC §4.2, spec/billing.md).
--
-- The agent's `web_search` research tool calls a paid search vendor (SerpApi/Brave) on the platform's
-- key. Each billable search is a flat, known credit charge (the Marketplace price list's `search` rate)
-- debited when the search returns. It is a NEW reason rather than a reuse of 'generation' or 'media':
--
--   * Unlike 'media' (debited BEFORE spend, so it may refuse/never overdraw), a search runs INSIDE an
--     LLM generation the user already passed the gate for, and the vendor cost is already incurred by
--     the time we debit. Refusing it mid-generation would only lose the audit trail — so 'search'
--     debits MAY go negative, exactly like 'generation' (the ledger writers pass allow_negative=true).
--   * Admin reporting separates search spend from LLM/media spend directly off the reason column.
--
-- Search debits are NOT anchored to a generations row (generation_id stays null, like 'grant'), so no
-- foreign-key row is required — the charge stands on the reason + note alone.
alter table public.credit_ledger
  drop constraint if exists credit_ledger_reason_check;

alter table public.credit_ledger
  add constraint credit_ledger_reason_check
  check (reason in ('grant', 'purchase', 'generation', 'media', 'search', 'refund', 'promo', 'adjustment'));
