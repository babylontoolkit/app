-- ================================================================================================
-- 0019 — Record WHAT KIND of turn a generation was.
--
-- `generations` records how long a turn took (`duration_ms`, migration 0002) and nothing about what
-- sort of turn it WAS. So the question "how long does a typical edit take?" has never been
-- answerable from this table: the durations are all there, in one undifferentiated pile, and a
-- creation that legitimately runs five minutes sits beside a one-line edit that runs seven seconds.
--
-- That gap surfaced on 2026-08-03. The liveness panel gained an expectation baseline — the number
-- that answers "is 3m30s normal, or is this stuck?" — and the baseline had to be a HAND-PICKED
-- CONSTANT, because nothing in the platform could compute one. Asked where it came from, the honest
-- answer was "three samples and a round number". The measured local spread was 15s / 81s / 328s,
-- which is a 20x range with no way to bucket it.
--
-- `status_kind` is the missing dimension, and it costs nothing to record: `statusKindFor()` already
-- decides it on every single turn, before a token is spent, to drive the panel's copy. It was simply
-- never persisted.
--
-- With this column, `typicalDurationMs` can eventually stop being a guess and become a percentile
-- over real traffic (per kind, and per model — a model swap moves these numbers, §4.2a). Until
-- enough rows accumulate, the constants in `agent/delivery.ts` stand, now env-overridable so a wrong
-- baseline is a config change rather than a deploy.
--
-- ⚠️ NULLABLE, with no default and no backfill. Every row written before today genuinely does not
-- know its kind, and inventing one — 'edit', being the most common — would poison the very
-- percentile this column exists to make possible, silently and permanently. An honest NULL is
-- excluded from the statistics; a fabricated 'edit' is not.
--
-- See SPEC §4.2a and `agent/delivery.ts`.
-- ================================================================================================

-- 'creation' | 'repair' | 'plan' | 'edit' — mirrors `AgentStatusKind` (`agent/heartbeat.ts`).
--
-- Deliberately TEXT rather than an enum: this vocabulary is owned by application code that adds a
-- kind whenever a new sort of turn appears, and an enum turns each of those into a migration. The
-- reader (`typicalDurationMs`) already falls back for a kind it does not recognise.
alter table public.generations add column if not exists status_kind text;

-- The index that makes the eventual percentile query cheap, and it is the whole point of the column:
-- "median duration for kind X on model Y". Partial, because a NULL kind can never satisfy that query
-- and the historical rows would otherwise be dead weight in the index forever.
create index if not exists generations_status_kind_duration_idx
  on public.generations (status_kind, model, duration_ms)
  where status_kind is not null and duration_ms is not null;
