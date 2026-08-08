-- 0020 — the creation handoff now carries a PHASE PLAN, and its end state moved.
--
-- NO SCHEMA CHANGE. This migration exists because migration 0016's column comment became FALSE, and
-- a comment that lies is how five of this codebase's recorded defects survived review. The plan is a
-- new key inside the existing jsonb, so nothing about the column's type or constraints changes.
--
-- ## Why creation became a plan
--
-- One model turn was asked to write the game, a complete landing-page and chrome redesign, and two
-- design docs. Measured on `gen_mskc4r0y` (2026-08-08, opus-5, Anthropic direct): 14 files / 90,288
-- chars in ONE response, which hit the provider's 64,000-token output ceiling with
-- `stop_reason: max_tokens`. The model also emitted 14 `<boltAction>` opens and only 4 closes, so the
-- parser welded nine files into a single 93,856-byte `KartTrack.ts` and the game never reached disk.
-- Settled `completed`, billed 1,162 credits, user shown "Your game is ready".
--
-- The response does not fit — structurally, not marginally. Split into Game -> Frontend -> Art ->
-- Verify, no phase needs more than a third of the ceiling.
--
-- ## What changed about NULL
--
-- 0016: "NULL once the first build turn has been SENT."
-- 0020: "NULL once the LAST PHASE has completed."
--
-- The BRIEF is still consumed on send, and for 0016's original reason: it is a fact about the FIRST
-- message, and re-appending it would double-append into an UNCACHED history that re-sends forever.
-- What outlives the send is the PLAN, because it is the only record of which phases are still owed.
-- Without it a tab that dies mid-build strands a half-written project with nothing able to resume,
-- and the user has already paid for the phases that did run.
--
-- NULL is therefore still the end state and still means "this project has nothing outstanding". The
-- end simply moved from the first send to the last phase.
--
-- 🔴 The plan stores NO FILE BYTES — phase ids, a counter, and one record per completed phase
-- (its generation id, a timestamp, its verdict). The platform's "we store no project files" property
-- (0007) is untouched, and this is not a snapshot history under a new name: exactly one plan per
-- project, deleted with the row, never "keep the last few".
--
-- 🔴 The column is CLIENT-WRITTEN, so the route caps and clamps it (`api.projects.$projectId.ts`)
-- and folds it MONOTONICALLY — `next` only ever moves forward. A full replace would let a second tab
-- or an out-of-order retry rewind the counter and re-run a phase that already ran, paying twice and
-- overwriting files that were correct. Same lesson as the ledger's `seq`: a read-then-write is a
-- race, so the merge is the write.

comment on column projects.creation_handoff is
  'Unbuilt-project handoff (§4.4a) + phase plan (§4.4e): {brief, userPrompt, plan}. The brief is '
  'consumed when the first build turn is sent; the whole column is NULL once the last phase of the '
  'plan has completed. Stores no file bytes.';
