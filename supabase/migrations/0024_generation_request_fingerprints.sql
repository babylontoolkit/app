-- What we actually SENT, beside what it cost (SPEC §4.2 step 2a, §4.2.8).
--
-- Every generation records what it cost, how long it took, which skills fired and which model was
-- billed. Nothing anywhere records the REQUEST. So when the model behaves as if it could not see
-- something, there is no way to check — and three times now that is exactly what happened: the model
-- was shown 7 files of a 78-file tree, every agent-written file was listed twice for weeks at the 2x
-- cache-write rate, and the re-sent history carried stale file bodies at 83-87% of its size. None of
-- them threw. In all three the record was correct about everything it recorded, and nothing compared
-- the record to the request.
--
-- 🔴 `request_fingerprints` IS HASHES, COUNTS AND SHORT STRINGS — NEVER BODIES. The assembled arrays
-- contain the whole system prompt, the compacted conversation and, on an attachment turn, up to 20MB
-- of image payload. Storing the request itself would make this feature a way to put project files on
-- our servers, which is precisely what §4.5.4b, migration 0007 and `no-server-storage.spec.ts` exist
-- to prevent. The discipline is the one `steps[].textChars` already follows: record the LENGTH of a
-- step's text, never the text. Attachments are recorded by count and by a token UPPER BOUND, so not
-- even their byte pattern is reachable.
--
-- One entry per stream start. A turn issues one request and can then re-issue for five distinct
-- reasons — the provider retry, its tool-free variant, the forced continuation, the unproductive
-- rescue and the creation-completeness pass — FOUR of which splice in synthetic system and user
-- messages (the same-as-first retry re-sends byte-identical arrays, differing only in the
-- `thinkingMode` the final retry carries -- see `retryThinkingMode`).
--
-- ⚠️ That is five REASONS to re-issue — six `RequestKind` values counting `first` — and not a bound: the provider retry alone can fire up to
-- MAX_PROVIDER_RETRY_ATTEMPTS times, so a turn's array is bounded by the retry and tool policies
-- rather than by the number of reasons. `jsonb` because it is read whole and never filtered on.
--
-- What no persisted record has ever carried is what any of them SENT. `finish_reason` has named
-- WHICH re-issue ran since migration 0002 (`stop+forced-continuation`, `+provider-retry`, …); the
-- request itself — a dropped tool set, a spliced block, an appended message — had nowhere to land.
-- Ordered, never collapsed: merging them loses the fact this column exists to expose.
--
-- `jsonb` for migration 0002's stated reason for `steps`: written once, read whole, never joined or
-- filtered on. Bounded by construction — one small object per stream start, and the number of stream
-- starts is bounded by the retry and tool policies.
--
-- NULLABLE, NO DEFAULT, NO BACKFILL. A turn that failed before `startStream` — a gate refusal, a
-- `NotConfiguredError`, a claim conflict — has NO fingerprint, and that must stay distinguishable
-- from "the fingerprint was empty". It is the `remoteHead` `undefined`-vs-`null` distinction one
-- subsystem over, where collapsing the two lets a flaky connection authorise a push. Every row before
-- 2026-08-21 genuinely has no record of its request; a default would manufacture one.
--
-- NO INDEX, for 0021's reason: read as part of a row on a per-user page already indexed by user and
-- time. Nothing filters or joins on either column.
alter table public.generations
  add column if not exists request_fingerprints jsonb;

alter table public.generations
  add column if not exists integrity_issues text[];

comment on column public.generations.request_fingerprints is
  'Ordered fingerprint per model request this turn (`agent/request-fingerprint.ts`) — hashes, counts and short strings, NEVER message, file or system-block bodies. NULL means the turn never reached `startStream`, which is NOT the same as an empty fingerprint.';

comment on column public.generations.integrity_issues is
  'Request invariants violated while assembling this turn (`agent/request-invariants.ts`), as `INV-n: detail`. A violation NEVER fails a generation (§4.2 step 2a). NULL for rows written before 2026-08-21 — never checked, not checked-and-clean.';
