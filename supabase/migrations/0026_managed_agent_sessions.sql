-- 0026 — Managed Agents sessions, one per chat (`_specs/managed-agents-engine_plan.md` D5, T4, T7).
--
-- On the managed agent engine (`AGENT_ENGINE=managed`) a chat's conversation lives in a Managed Agents
-- SESSION on Anthropic's side: Anthropic keeps the history and compacts it, and we stop re-sending it.
-- The session id therefore has to be findable from the chat on ANY device — a second browser opening
-- the chat must continue the same session, not start a new one — so it lives on the chat's index row:
--
--   * managed_session_id — set once, on the chat's first managed turn (compare-and-set: the first writer
--                          wins, `chat-index.ts` `claimManagedSession`), reused by every later turn.
--   * managed_settled_at — T7's settlement cursor: the `processed_at` of the last usage event already
--                          billed, so a disconnected turn settles what it consumed and a resumed turn
--                          settles only the rest. Text, because it is Anthropic's timestamp verbatim.
--
-- Neither column is written by the transcript save (`putChat` → upsert): that upsert never names them,
-- so a save preserves them. Adding them to the upsert payload would erase the session on every save.
--
-- 🔴 A SESSION NEVER FOLLOWS A CHAT ID TO ANOTHER PROJECT. The chat id is the only thing a caller names;
-- ownership is proven on the PROJECT (§4.5.3). `chats.id` is global, and the transcript upsert is keyed
-- on it alone, so a save naming someone else's chat id under the caller's own project re-homes the row.
-- Without the trigger below, that re-homed row would still carry the victim's session id — and the
-- caller would then pass every ownership check on their own project and continue someone else's
-- conversation. The trigger clears both columns whenever project_id changes, in the database, where no
-- code path can forget it. `FsChatIndex.upsert` mirrors it for local mode.
--
-- Money: NONE here. Settlement still goes through the append-only ledger (`settleGeneration`).
alter table public.chats
  add column if not exists managed_session_id text,
  add column if not exists managed_settled_at text;

create or replace function public.chats_forget_session_on_rehome() returns trigger
language plpgsql as $$
begin
  if new.project_id is distinct from old.project_id then
    new.managed_session_id := null;
    new.managed_settled_at := null;
  end if;

  return new;
end;
$$;

drop trigger if exists chats_forget_session_on_rehome on public.chats;
create trigger chats_forget_session_on_rehome
  before update on public.chats
  for each row execute function public.chats_forget_session_on_rehome();
