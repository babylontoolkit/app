-- 0029 — A generation is debited AT MOST ONCE (`_specs/no-unbilled-usage_plan.md`, verifier defect B).
--
-- The billing sweep (0028) settles `running` rows a dead process left behind, and a delete settles them
-- too. Each settler CLAIMS the row first (a guarded `running` -> `interrupted` update), so only one of them
-- debits. This index is the defense in depth under that claim: whatever races, the database refuses a
-- second `generation` debit naming the same generation id.
--
-- Safe because no legitimate flow debits one generation id twice — every settlement names its own id:
-- a legacy turn settles once in its `finally`; a managed turn settles under its id, and its later tails
-- under distinct suffixed ids (`_tail`, `_stop` (random per Stop), `<session>_prior`, `<chat>_sweep_<ts>`,
-- `<chat>_delete_<ts>`, `<chat>_orphan_<ts>`); a resumed turn is a new request with a new id; refunds and
-- media/search debits use other reasons. A debit with no generation id is not constrained.
--
-- ⚠️ If a deployed database already holds a duplicate, this statement FAILS the migration — loudly, on
-- purpose: such a row is a double charge to reconcile by hand (a compensating `adjustment`), never one to
-- hide by skipping the index.
create unique index if not exists credit_ledger_one_debit_per_generation
  on public.credit_ledger (generation_id)
  where reason = 'generation' and generation_id is not null;
