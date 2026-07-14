-- ================================================================================================
-- 0002 — Generation diagnostics: WHY a generation was expensive, not just THAT it was.
--
-- `public.generations` recorded tokens, model, credits and cost. That answers "how expensive", and
-- nothing else. It cannot answer "why", and "why" is the only question that leads to a fix — because
-- the two causes of an expensive, slow generation have OPPOSITE remedies:
--
--   * many sequential tool rounds, each redrafting the answer  → remove/batch the tools
--   * one enormous answer decoding serially at ~60-110 tok/s   → emit fewer output tokens
--                                                                (caching CANNOT help here)
--
-- Aggregate usage hides the difference completely. A real generation billed 44,308 output tokens
-- whose visible answer was ~9k — roughly 35,000 output tokens went to steps the user never saw. In
-- the totals that is indistinguishable from "the model wrote a big answer".
--
-- Every number in spec/context-budget.md was obtained by hand, locally, from a browser DevTools
-- stream. That does not scale to noticing a regression across real users, and until these columns
-- exist the §4.10 admin cost dashboards can only CHART spend, never DIAGNOSE it.
--
-- See spec/context-budget.md §"Wasted tokens and dead time" and SPEC §4.2.8.
-- ================================================================================================

-- Tool rounds the server ran inside this generation. A generation that hit the cap (MAX_TOOL_ROUNDS)
-- is the signature of the model thrashing — and of an answer step that may never have happened.
alter table public.generations add column if not exists tool_rounds integer not null default 0;

-- Wall clock. Paired with output_tokens this yields the decode rate (out tok/s), which is what
-- separates "slow because of tool rounds" from "slow because the answer is huge".
alter table public.generations add column if not exists duration_ms integer;

-- 'stop' | 'length' | 'tool-calls' | 'error'. A clean 'stop' that produced no text is a hard failure
-- that we auto-refund (§4.6) — and it billed 10,054 output tokens the one time we measured it.
alter table public.generations add column if not exists finish_reason text;

-- Self-healing (§4.2.7): the generation this one repairs. Makes repair cost measurable, which is the
-- prerequisite for ever pricing repairs at reduced weight (REPAIR_WEIGHT, §4.6).
alter table public.generations add column if not exists repair_of text;

-- The per-step breakdown: [{ms, outTokens, inTokens, cacheRead, cacheWrite, tools[]}, ...].
--
-- jsonb, not a child table: it is written once, read whole, never joined or filtered on, and its
-- shape follows the AI SDK's step object rather than anything we control. A child table would buy
-- query power we have no use for and cost a second round trip on the hot settlement path.
alter table public.generations add column if not exists steps jsonb;

-- The dashboards' hot query: "the expensive generations, worst first, over a window."
create index if not exists generations_cost_idx
  on public.generations(created_at desc, credits_charged desc);

-- Finding the thrashers: generations that burned every tool round they were given.
create index if not exists generations_tool_rounds_idx
  on public.generations(tool_rounds) where tool_rounds > 0;
