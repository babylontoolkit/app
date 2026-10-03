-- 0028 — No unbilled usage: a durable record BEFORE spend, and the sweep that bills what a dead process
-- left behind (`_specs/no-unbilled-usage_plan.md` D2, D3, D4).
--
-- Owner, 2026-10-02: "we never eat the cost". Until now a `generations` row was written only at the END of
-- a turn (`settleGeneration`), so a process that died mid-stream left NOTHING: no row, no usage, no debit.
-- Every model turn now writes its row `status = 'running'` before the first provider call, the legacy
-- engine checkpoints its cumulative usage onto that row after every finished step, and a periodic sweep
-- settles any row still `running` past a stale threshold — from its last checkpoint, as `interrupted`,
-- never refunded.
--
-- Money: NONE moves here. Every debit still goes through `append_ledger_entry`.

-- Which engine wrote the row: 'legacy' | 'managed' | 'enhancer'. NULL for media rows and for every row
-- written before this migration — the sweep settles only the engines it knows, so a media task's
-- `running` row (debited up front, `media/service.ts`) is never mistaken for an unbilled turn.
-- NULL means UNKNOWN, never a default (the 0021 rule).
alter table public.generations add column if not exists engine text;

-- The Managed Agents session a managed turn ran on, when known at the time the row was written.
alter table public.generations add column if not exists managed_session_id text;

-- The last sign of life of a `running` row: set when the row opens and on every usage checkpoint. The
-- sweep's staleness test reads coalesce(checkpoint_at, created_at), so a long legacy turn that is still
-- checkpointing is never swept from under itself.
alter table public.generations add column if not exists checkpoint_at timestamptz;

-- The sweep's hot query: rows still running, oldest sign of life first. Partial — a finished row (all but
-- a handful) never enters the index.
create index if not exists generations_running_idx
  on public.generations (coalesce(checkpoint_at, created_at))
  where status = 'running';

-- D3 (b): every chat bound to a managed session. Partial — most chats have none.
create index if not exists chats_managed_session_idx
  on public.chats (managed_session_id)
  where managed_session_id is not null;

-- D4: a managed session whose settlement FAILED while its chat (or project, or account) was being
-- deleted. The chat row holds the session id and the cost cursor, and it is about to go — so the pair is
-- copied here first, and the sweep settles it later from this row instead.
--
-- NO foreign keys, on purpose: this row must SURVIVE the delete that created it (the chat cascades with
-- its project, the project with its user). `user_id` names the account the usage is billed to, like
-- `credit_ledger.user_id` after migration 0017. Service-role only: RLS on, no policy.
create table if not exists public.managed_billing_orphans (
  id           text primary key,
  user_id      uuid not null,
  project_id   text not null,
  chat_id      text not null,
  session_id   text not null,
  cursor       text,
  model        text not null,
  reason       text,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz
);

create index if not exists managed_billing_orphans_open_idx
  on public.managed_billing_orphans (created_at)
  where resolved_at is null;

alter table public.managed_billing_orphans enable row level security;
