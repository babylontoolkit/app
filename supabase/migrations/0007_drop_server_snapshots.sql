-- --------------------------------------------------------------------------------------------
-- 0007 — the platform stores no project files (SPEC §4.5.4b)
--
-- Migration 0006 implemented repo-primary persistence: the user's game lives in THEIR GitHub/GitLab
-- repo, their in-progress work lives in their browser, and the server keeps the project record and the
-- chat. It removed the BEHAVIOUR and left the SCHEMA entirely intact — the `snapshots` table, its
-- index, its RLS policy, and `projects.current_snapshot_id` all survived, unused.
--
-- That is not a cosmetic leftover. A table called `snapshots` with a live RLS policy is a standing
-- invitation to write to it, and `current_snapshot_id` is worse: it kept a real meaning on a small
-- number of rows (it pointed at a remix seed) while its NAME described the per-generation version
-- history the platform had stopped taking. A field whose name promises a deleted system is how the
-- deleted system comes back.
--
-- The seed is now stored as what it is — one object per project at a key derived from the project id
-- (`app/lib/.server/share/seed-store.ts`) — so there is nothing left to point at.
--
-- ## What happens to existing data
--
-- Dropping `snapshots` discards the metadata rows. The PAYLOAD BYTES were never in Postgres (they are
-- objects under `snapshots/{projectId}/{snapshotId}.json` in S3), so this drop does not delete anyone's
-- files, and it also does not clean those objects up: the rows that named them are going away. See the
-- backfill note below — on a platform with real users, the objects are swept BEFORE this runs.
-- --------------------------------------------------------------------------------------------

-- --------------------------------------------------------------------------------------------
-- Carry the one thing worth keeping: which projects have a remix seed.
--
-- Runs BEFORE the drop, deliberately. On a live database `current_snapshot_id` is the only record of
-- which published games have a seed, and losing it would silently break remix for every game published
-- before this migration — the exact failure §4.8's seed exists to fix, reintroduced by the cleanup
-- that was supposed to make it honest.
--
-- `updated_at` is the honest approximation of "when": the seed was deposited at publish, and the row's
-- last write was that publish. This column is read as a boolean anyway.
-- --------------------------------------------------------------------------------------------
alter table public.projects add column if not exists remix_seed_at timestamptz;

update public.projects
   set remix_seed_at = coalesce(updated_at, now())
 where current_snapshot_id is not null
   and remix_seed_at is null;

comment on column public.projects.remix_seed_at is
  'When a remix seed was deposited (§4.8). A hint, not an address — the seed key is derived from the '
  'project id. Absent on almost every project: the platform stores no project files (§4.5.4b).';

-- --------------------------------------------------------------------------------------------
-- Drop the server-side snapshot history.
--
-- Order matters: the policy and index belong to the table, so they go with it, but naming them
-- explicitly documents what existed. `current_snapshot_id` has no FK to `snapshots` (it never did), so
-- dropping the table first cannot fail on it.
-- --------------------------------------------------------------------------------------------
drop policy if exists "snapshots: via owned project" on public.snapshots;
drop index if exists public.snapshots_project_id_idx;
drop table if exists public.snapshots;

alter table public.projects drop column if exists current_snapshot_id;
