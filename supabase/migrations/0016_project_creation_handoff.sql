-- 0016 — the creation handoff lives on the PROJECT, not in one browser (§4.4a).
--
-- A project created and not yet built carries two facts: the machine-written creation brief (play
-- contract, scaffolded class name, the images actually on disk) and the user's own words. Both lived
-- ONLY in that browser's localStorage, which made them a property of a device rather than of the
-- project — so opening an unbuilt project on a second machine showed no handoff card AND sent the first
-- build turn with no brief at all. The build still ran; it just quietly lost the facts that make it
-- good, which is §4.2.8's stated failure mode (nothing throws, the token count goes DOWN).
--
-- One nullable jsonb column, `{ "brief": "...", "userPrompt": "..." }`, following `game_backend_ref`
-- and `linked_unity_project_id`: a plain fact about the project, not a table.
--
-- 🔴 NULL IS THE END STATE. The handoff is cleared when the first build turn is SENT (not when it
-- succeeds — a failed build is retried and the retry must still carry the brief). A row that never
-- clears is a project that offers to build itself forever, so the clear is part of the send path, and
-- deleting the project takes it with the row.
alter table projects
  add column if not exists creation_handoff jsonb;

comment on column projects.creation_handoff is
  'Unbuilt-project handoff (§4.4a): {brief, userPrompt}. NULL once the first build turn has been sent.';
