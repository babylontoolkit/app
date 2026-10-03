# effort-selector — auto-pilot run log

## Run 1 — started 2026-10-02 14:44 (branch `btk-sandbox`)

Queue: T1–T10 (ALL), 0/10 done at start.

### Decisions

- DECISION run: stay on `btk-sandbox` (not the default branch `main`) — skill rule only branches off the default.
- DECISION run: phases = [T1–T3] [T4–T6] [T7–T8 (live)] [T9 (SPEC)] [T10] — no `### Phase` headers; groups of ≤3, live/SPEC/last close a group.

### Tasks
- DECISION T1: no message sent per probe session — create + matching read-back = accepted (9 free creates); inference-time acceptance is checked live in T8.
- DECISION T1: D5 seed — every rung (sonnet-5-5, opus-5-5, fable-5-1) accepted xhigh and max → `MODELS_WITHOUT_XHIGH` ships empty.
- DECISION T2: `parseUserEffort`'s default offered list is the SAFE one (no max); `proxy.ts` passes `offeredUserEffortLevels(context)` now (one line) so `ENABLE_MAX_EFFORT` works on legacy.
- DECISION T3: `parseEffort` takes an optional var name so `MANAGED_AGENT_EFFORT` warnings name the right variable.
- T1 ✅ verified (independent) — 1 attempt — probe run live, Findings table written.
- T2 ✅ verified (independent) — 1 attempt — anthropic.spec 53, effort-offer.spec 6.
- T3 ✅ verified (independent) — 1 attempt — config.spec 15, provision.spec 17.
