-- 0017 — deleting an account must not delete the financial record (SPEC §4.5.1, §4.6, spec/billing.md).
--
-- §4.5.1 has always said self-serve account deletion purges projects and messages while
-- "ledger rows are RETAINED (financial record, disassociated from PII where legally required)".
-- The schema said the opposite. Both `credit_ledger.user_id` and `generations.user_id` were declared
-- `references auth.users(id) ON DELETE CASCADE` (0001), so the very first `auth.admin.deleteUser()`
-- call would have taken with it:
--
--   * every ledger row that user ever had — including `purchase` rows backing real Stripe payments,
--     i.e. the record of money we actually took;
--   * every `generations` row — the cost/diagnostics record the §4.10 Admin usage and margin reports
--     are computed FROM, so historical spend and margin would shift retroactively every time somebody
--     closed their account.
--
-- Nothing would have thrown. The rows would simply stop existing, and the reports would keep rendering
-- a smaller, wronger number with total confidence. This is the same rule migration 0014 already applied
-- to `sandbox_lifecycle_marks.user_id` (`on delete set null`, with a test named "the hour still
-- happened") — the two just never got compared.
--
-- The fix drops the FK on these two tables rather than nulling the column, and that is deliberate:
--
--   * `set null` cannot be used — `user_id` is `not null` on both, and it is the column every balance
--     read (`order by seq desc limit 1`) and every per-user report groups by. A ledger whose owner
--     column empties on deletion is not a retained record, it is an anonymous pile of numbers.
--   * The uuid that remains no longer resolves to a person: `auth.users` is gone, and with it the
--     email and every other identifier. That IS "disassociated from PII" — the row stays attributable
--     for accounting and irreversible for identification, which is the shape a financial record is
--     supposed to have.
--   * Referential integrity for LIVE users is unaffected in practice: both tables are written only by
--     server code holding an already-authenticated user id (the credit gate, settlement, the webhook),
--     never by a client-supplied one.
--
-- Everything else still cascades on purpose. `profiles`, `projects`, `entitlements`,
-- `asset_entitlements`, `unity_license_entitlements` and `git_tokens` all describe the PERSON or their
-- property, and when the person goes they should go with them — the credential table most of all.

-- --------------------------------------------------------------------------------------------
-- credit_ledger — the append-only money record. Survives its user.
-- --------------------------------------------------------------------------------------------
alter table public.credit_ledger
  drop constraint if exists credit_ledger_user_id_fkey;

comment on column public.credit_ledger.user_id is
  'The account this entry belongs to. Deliberately NOT a foreign key: the append-only financial record '
  'outlives account deletion (§4.5.1). After a delete the uuid no longer resolves to a person — the PII '
  'lived in auth.users — so the row stays attributable for accounting and useless for identification.';

-- --------------------------------------------------------------------------------------------
-- generations — the usage + cost record every Admin margin report is computed from.
-- --------------------------------------------------------------------------------------------
alter table public.generations
  drop constraint if exists generations_user_id_fkey;

comment on column public.generations.user_id is
  'The account that ran this generation. Deliberately NOT a foreign key, for the same reason as '
  'credit_ledger.user_id: a generation that happened must keep having happened after the account is '
  'deleted, or historical cost and margin (§4.10) change retroactively.';
