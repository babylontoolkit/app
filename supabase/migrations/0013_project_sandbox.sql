-- Per-project sandboxes (`spec/sandbox-codesandbox.md`, CodeSandbox production plan T1).
--
-- `sandbox_id` records WHICH provider VM holds this project's workspace. It replaces the per-user
-- registry (`sandboxes/{userId}.json`), whose one-VM-per-user shape let project B silently adopt
-- project A's filesystem: the warm-boot gate had no project identity to check against. The project
-- row IS the registry now — ownership and cascade come for free, and `createSandboxForProject`'s
-- `project:${id}` tags stop lying.
--
-- A plain pointer, the same shape as `game_backend_ref` (0004) and `linked_unity_project_id` (0011)
-- — NEVER a credential. The provider session it addresses is minted server-side from the platform
-- API key; the client supplies a PROJECT id it must own, never a sandbox id. Null = no VM has been
-- created for this project yet, which is the state of every existing row.
alter table public.projects add column if not exists sandbox_id text;

comment on column public.projects.sandbox_id is
  'Per-project sandbox VM (spec/sandbox-codesandbox.md): the provider sandbox id holding this project workspace. A plain pointer, never a credential. The client never SUPPLIES one — it names a project it owns and the server resolves the VM. Whether it is ever SENT to a browser is a separate question the project routes decide (they serialize the whole row today); do not read this comment as a guarantee that it is withheld.';
