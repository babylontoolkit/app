-- 0030 — One OPEN billing orphan per managed session (`_specs/no-unbilled-usage_plan.md`, residual R2).
--
-- An orphan (0028) OWNS a managed session's cost cursor: the billing sweep settles the session from it. Two
-- open owners of one session bill the same usage twice — two concurrent rebinds of a switched session that
-- each kept it for the sweep, say. The store merges a second record into the open one (the more advanced
-- cursor wins, pending intents are unioned) and never reopens a resolved one; this index is the defense in
-- depth under that: the database refuses a second OPEN row for the same session, whatever its id.
--
-- A resolved orphan is history and is not constrained, so a session may be orphaned, settled, and (were it
-- ever needed) orphaned again.
--
-- ⚠️ If a deployed database already holds two open orphans of one session, this statement FAILS the
-- migration — loudly, on purpose: that is a double-billing owner pair to reconcile by hand (resolve one),
-- never one to hide by skipping the index.
create unique index if not exists managed_billing_orphans_one_open_per_session
  on public.managed_billing_orphans (session_id)
  where resolved_at is null;
