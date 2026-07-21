-- Unity Project Licenser (SPEC §4.18) — link a project to a local Unity project.
--
-- `linked_unity_project_id` holds the Unity project's `productGUID` (32 hex chars). It is a plain
-- pointer, the same shape as `game_backend_ref` (0004) — NEVER a credential. It is the value the
-- generated `license.json` is locked to: the license `key` is a hash over `plan-<guid>`, so a license
-- only validates in the Unity project it was linked for.
--
-- A single nullable pointer, unlike the repo link (0006) — no tuple, no constraint. Null = no Unity
-- project linked, which is the state of every existing and most future projects.
alter table public.projects add column if not exists linked_unity_project_id text;

comment on column public.projects.linked_unity_project_id is
  'Unity Project Licenser (§4.18): the linked Unity project productGUID the generated license.json is locked to. A plain pointer, never a credential.';
