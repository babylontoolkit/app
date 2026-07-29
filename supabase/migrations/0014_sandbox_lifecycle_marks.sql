-- Sandbox VM lifecycle marks (plan T12, SPEC §4.6, `spec/sandbox-codesandbox.md`).
--
-- Per-project sandboxes (T1–T3) made VM time a real cost line, and the launch decision (2026-07-27)
-- was to BAKE that cost into `CREDIT_MARGIN` rather than meter it per user. That decision is only
-- defensible while somebody can check it — `SANDBOX_EST_VM_HOURS_PER_KCREDIT` (T11) is an ESTIMATE,
-- and an estimate nothing measures is a belief. This table is the measurement.
--
-- **Append-only, exactly like `credit_ledger`.** A mark is a fact about a moment; VM-hours are
-- DERIVED by pairing them (`admin/vm-report.ts`), never stored as a mutable counter. A counter loses
-- updates under concurrency and cannot answer "where did the hours go" — and the whole point of this
-- table is to answer that question. There is deliberately no update or delete path.
--
-- `sandbox_id` is a POINTER, not a credential (the same status it has on `projects.sandbox_id`,
-- 0013): reaching a sandbox still requires a server-minted, scoped, expiring session.
create table if not exists public.sandbox_lifecycle_marks (
  id uuid primary key default gen_random_uuid(),

  -- Nullable and NOT cascading: the whole value of a mark is that it outlives the VM and the project
  -- it describes. A user who deletes a project on Tuesday still ran a VM on Monday, and deleting the
  -- evidence with the project would make every historical hour vanish from the report — the same
  -- "bytes outliving the record" rule read in the opposite direction.
  user_id uuid references auth.users(id) on delete set null,
  project_id text,

  sandbox_id text not null,

  -- 'create' and 'resume' OPEN a running interval; 'hibernate' and 'delete' CLOSE one.
  event text not null check (event in ('create', 'resume', 'hibernate', 'delete')),

  at timestamptz not null default now()
);

-- The report reads a recent window, newest first.
create index if not exists sandbox_lifecycle_marks_at_idx
  on public.sandbox_lifecycle_marks(at desc);

-- Pairing walks one sandbox's marks in time order.
create index if not exists sandbox_lifecycle_marks_sandbox_idx
  on public.sandbox_lifecycle_marks(sandbox_id, at);

alter table public.sandbox_lifecycle_marks enable row level security;

-- RLS enabled with NO POLICY: service-role only, like `git_tokens`. These marks are operator
-- bookkeeping surfaced on the admin dashboard; a user has no reason to read them and every reason
-- not to be able to write them (a forged mark is a forged cost report).
