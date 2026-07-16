-- Repo-primary persistence (SPEC §4.5.4b) — the user's repo becomes the only permanent store.
--
-- Two changes, one theme: the platform stops being the home of the user's game code and becomes a
-- pointer to where it really lives.
--
--   1. `projects` learns WHICH provider it is linked to, and whether saves happen on their own.
--   2. `git_tokens` holds the credential that makes reaching that repo possible.
--
-- `linked_repo`, `linked_branch` and `last_synced_commit_sha` already exist (migration 0001, added for
-- §4.13 when sync was an optional feature). They are unchanged here — what changes is their status:
-- under §4.5.4b they are no longer a nice-to-have pointer, they are the address of the only copy.

-- --------------------------------------------------------------------------------------------
-- projects: which provider, and does it save by itself
-- --------------------------------------------------------------------------------------------

-- Null = UNLINKED (browser-only, §4.5.4b). Not defaulted to 'github': a default would make every
-- pre-existing project claim a link it does not have, and "linked" is derived from `linked_repo`, so a
-- provider without a repo must be impossible to read as a save target.
alter table public.projects
  add column if not exists provider text;

-- Constrained rather than free text — a typo'd provider is a save that resolves no adapter at all, and
-- the failure would surface at 3am on a push, not here.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'projects_provider_check') then
    alter table public.projects
      add constraint projects_provider_check check (provider is null or provider in ('github', 'gitlab'));
  end if;
end $$;

-- A provider is meaningless without a repo, and a repo is unreachable without a provider. Either both
-- or neither: this is what stops a half-written link from becoming a project that believes it is saved.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'projects_link_complete_check') then
    alter table public.projects
      add constraint projects_link_complete_check check (
        (provider is null and linked_repo is null and linked_branch is null)
        or (provider is not null and linked_repo is not null and linked_branch is not null)
      );
  end if;
end $$;

-- Auto-push on checkpoint, ON by default once linked (§4.5.4b). The default is `true` and not
-- nullable: a user who linked a repo asked for their work to live there, and a save path that silently
-- defaults to off is a user who believes they are saved and is not.
--
-- It is inert while UNLINKED (nothing to push to), so no constraint ties it to `provider`.
alter table public.projects
  add column if not exists auto_push boolean not null default true;

-- Reload has to answer "is this project linked?" for every project on the dashboard.
create index if not exists projects_linked_idx
  on public.projects(user_id)
  where linked_repo is not null;

-- --------------------------------------------------------------------------------------------
-- git_tokens: the credential, encrypted, service-role only
-- --------------------------------------------------------------------------------------------
--
-- Ciphertext only — AES-256-GCM, keyed by GIT_TOKEN_ENCRYPTION_KEY, done in the app
-- (`git/token-store.ts`). Postgres never sees a plaintext token, so a dump, a stray backup, or a
-- support engineer with read access does not become live write access to every user's source code.
create table if not exists public.git_tokens (
  user_id                 uuid not null references auth.users(id) on delete cascade,
  provider                text not null check (provider in ('github', 'gitlab')),

  -- Never plaintext. The column name says so on purpose: an insert of a raw token here is a review
  -- failure that the name makes visible at the call site.
  access_token_encrypted  text not null,

  -- Null for GitHub OAuth App tokens, which do not expire and issue no refresh token.
  refresh_token_encrypted text,

  -- Null = does not expire. GitLab's are ~2h and must be refreshed before a save that takes hundreds
  -- of blob uploads (`REFRESH_SKEW_MS` in git/resolve.ts).
  expires_at              timestamptz,

  -- The provider account this belongs to, shown in the UI so the user knows what is linked.
  provider_login          text not null,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  -- One token per user per provider. This is the PK, and it is what `SupabaseGitTokenStore.put`
  -- names in `onConflict: 'user_id,provider'` — reconnecting REPLACES rather than accumulating.
  -- Without it, a re-connect leaves the old (possibly revoked) token behind and `get` picks a row at
  -- random: saves that work on Tuesday and fail on Wednesday with no change to anything.
  primary key (user_id, provider)
);

alter table public.git_tokens enable row level security;

-- 🔴 NO POLICY, DELIBERATELY. Not an omission — read this before adding one.
--
-- Every other user-facing table grants the owner read access (§4.5.5). This one must not. RLS is
-- enabled and no policy exists, so `anon` and `authenticated` can reach exactly nothing and only the
-- service role can touch the table.
--
-- The reasoning: §4.5.4b took this credential OUT of the browser (it used to be a raw PAT in
-- localStorage, re-sent in every request body). A "the owner can read their own row" policy hands it
-- back the moment any client does `select * from git_tokens` — and that is a one-line change made in
-- good faith by someone building a connections UI, against a table whose name does not warn them.
-- The connection UI reads `/api/git/connections`, which returns a summary with no token field (§5: a
-- route may ACT on a secret, never EMIT one).
--
-- If you need user-scoped reads here, the answer is a view that omits the token columns, never a
-- policy on this table.
--
-- `updated_at` is written by the app on every put (`SupabaseGitTokenStore.put`), matching how
-- `projects` does it — no trigger, because this repo has no `set_updated_at` to reuse.
