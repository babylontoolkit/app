-- Three fields the type has always declared and Postgres has never had (SPEC §4.2a, §4.5.5).
--
-- `GenerationRecord` declares `rawStops`, `fallbackHandoffs` and `blocksLoaded`. The FS store writes
-- the whole record, so all three are present in local mode. `SupabaseGenerationStore.upsert` maps
-- named columns and simply does not mention them, and no migration ever created one — so in
-- production they were written by nothing, read by nothing, and nothing threw. The type said the
-- record carried them; the deploy that bills real money did not.
--
-- 🔴 `fallback_handoffs` is the one that matters, and it is this feature's own subject matter.
-- §4.2a's server-side refusal fallback retries a DECLINED request on another model **on the same
-- stream** — so a different model serves the turn while the turn still bills at the requested model's
-- rates. `fallbackHandoffs` exists precisely so that stays visible (`refusal-fallback.ts`, 2026-08-06).
-- On Postgres it had nowhere to land, which means the platform's record of "which model actually
-- answered" was correct in local dev and blank everywhere it counts.
--
-- ⚠️ `blocks_loaded` was worse than missing: `toGenerationRecord` returned a hardcoded `[]`, so every
-- Postgres deploy answered "no on-demand doc blocks were loaded" for every generation — confidently
-- wrong rather than absent, on a number §4.2.8's context-budget work is measured by. That is the exact
-- pattern migration 0021 was written to kill for `provider`.
--
-- NULLABLE, NO DEFAULT, NO BACKFILL. For an array column this is not a detail: `NULL` means "never
-- recorded" and `'{}'` means "recorded, and there were none". A default would collapse a fact we do
-- not have into a fact we do, and a reader could never tell a pre-migration row from a turn that
-- genuinely loaded no doc blocks and had no stop-reason oddities. It is the same distinction as
-- `remoteHead` `undefined`-vs-`null` one subsystem over (`mount-source.ts`), where collapsing the two
-- lets a flaky connection authorise a push. Migrations 0019 and 0021 left history NULL for this
-- reason and so does this one.
--
-- NO INDEX, for 0021's reason: these are read as part of a row on a per-user page already indexed by
-- user and time, and the §4.10 admin report aggregates over that same window. Nothing filters or joins
-- on them, and an index on a rarely-populated array column is upkeep bought with nothing.
alter table public.generations
  add column if not exists raw_stops text[];

alter table public.generations
  add column if not exists fallback_handoffs text[];

alter table public.generations
  add column if not exists blocks_loaded text[];

comment on column public.generations.raw_stops is
  'RAW wire stop_reason strings observed during the turn, in order (stop-reason-tap) — @ai-sdk/anthropic collapses unrecognised reasons into finishReason:''unknown''. NULL for rows written before 2026-08-21: never recorded, which is NOT the same as recorded-and-empty.';

comment on column public.generations.fallback_handoffs is
  'Refusal-fallback handoffs as from->to strings (§4.2a): the requested model declined and the named model served the turn on the same stream, while the turn billed at the REQUESTED model''s rates. NULL for rows written before 2026-08-21: never recorded, not recorded-as-none.';

comment on column public.generations.blocks_loaded is
  'On-demand doc blocks routed into this generation (§4.2.8). NULL for rows written before 2026-08-21 — previously read back as a hardcoded empty array, i.e. reported as "none loaded" for every row.';
