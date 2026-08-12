-- Which GATEWAY served a generation (SPEC §4.2a, §4.6).
--
-- `settleGeneration` has always been handed a `provider` and has always PRICED with it — `ratesFor`
-- selects the rate table from it, so it decides what the user is charged. It was never persisted:
-- `toGenerationRecord` hardcoded `provider: 'Anthropic'` on read, with a comment saying there is no
-- such column, so a Postgres deploy could not say which gateway served any historical turn.
--
-- That was survivable while one gateway existed. `AUTO_MODEL_SELECT` (2026-08-10) makes the gateway a
-- PER-REQUEST choice, so:
--   * a row that cannot name its gateway cannot be reconciled against that gateway's invoice — which
--     is the only thing that can answer OQ4 (is Comet's advertised discount actually billed?);
--   * the §4.10 per-provider cost view reports every row as Anthropic, i.e. confidently wrong rather
--     than absent, on the dashboard an operator would use to check a cutover;
--   * `provider` is an INPUT to the cost we already stored in `raw_cost_usd`, so omitting it stores an
--     answer without its question.
--
-- Found 2026-08-11 by a live drive of the prompt enhancer: its rows carried no provider at all,
-- because it has no enrichment step to add one after settlement.
--
-- NULLABLE with NO BACKFILL, deliberately. Every existing row was served before this column existed
-- and its gateway is genuinely unknown; writing a default would manufacture a fact — the same reason
-- migration 0019 (`status_kind`) left history NULL. Readers must treat NULL as "unknown", never as
-- "Anthropic". No index: this is read on a per-user page of rows that is already indexed by user and
-- time, and the Admin report aggregates over that same window.
alter table public.generations
  add column if not exists provider text;

comment on column public.generations.provider is
  'The gateway that served and billed this generation (KIE | Comet | Anthropic). NULL for rows written before 2026-08-11 — unknown, never assume a default.';
