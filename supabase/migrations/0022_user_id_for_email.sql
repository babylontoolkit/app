-- 0022 — resolve a platform user id from an email address (SPEC §4.18, §4.6).
--
-- The Unity Editor asks "does this developer have an active subscription?" and knows only their email.
-- Every entitlement fact we hold — the credit ledger, the Stripe subscription's `metadata.userId` — is
-- keyed on our user id, and `findActiveSubscription` documents exactly why it must stay that way:
-- looking a subscription up by `customer_email` breaks the moment somebody changes their platform
-- email, and silently matches the WRONG customer if two accounts ever shared one. So the email has to
-- become a user id first, and this is the only step that can do it.
--
-- `auth.users` is not reachable through PostgREST (Supabase does not expose the auth schema), so a
-- `security definer` function is the mechanism — the same shape as `append_ledger_entry`, and for the
-- same reason: a privileged operation that must not become a general-purpose door.
--
-- 🔴 THE GRANTS ARE THE POINT, NOT THE LOOKUP.
--
-- Postgres grants EXECUTE on a new function to PUBLIC by default. Left alone, this function would let
-- ANY signed-in user — through the ordinary anon/authenticated PostgREST client the browser already
-- holds — turn any email address into an internal user id, and confirm whether that address has an
-- account at all. That is an account-enumeration oracle handed to the whole internet, from a function
-- added to support one Editor tool. It is revoked from PUBLIC/anon/authenticated and granted only to
-- `service_role`, which exists solely on the server (§5: never `VITE_`-prefix the service-role key).
--
-- Returns NULL for an unknown address rather than raising. "No such user" is the normal answer here,
-- not an error, and the route must not be able to tell an unknown email apart from a known one with no
-- entitlement — see `subscription-access.ts`, where both resolve to the same `reason: 'none'` body.
--
-- Case-insensitive: Supabase normalizes emails on signup, but a developer typing their address into a
-- Unity Editor field will not match our casing, and a lookup that silently misses reads to them as
-- "my subscription is not recognised". `lower()` on the column means the unique index on `email` is
-- not used — deliberate, and irrelevant at this table's size behind a rate-limited endpoint.

create or replace function public.user_id_for_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id
  from auth.users u
  where lower(u.email) = lower(btrim(p_email))
  limit 1;
$$;

revoke all on function public.user_id_for_email(text) from public;
revoke all on function public.user_id_for_email(text) from anon;
revoke all on function public.user_id_for_email(text) from authenticated;

grant execute on function public.user_id_for_email(text) to service_role;

comment on function public.user_id_for_email(text) is
  'Service-role only. Resolves an email to a platform user id for the Unity subscription check (SPEC 4.18). Never grant to anon/authenticated: that is an account-enumeration oracle.';
