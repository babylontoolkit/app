# Managed billing visibility (plan)

Owner, 2026-10-02: *"I just created a game, I see a bunch of media render, but no AI TIME for actually
creating the game… if this was live I would basically have eaten that cost."*

Investigated (session `sesn_01WvYYW1…`, a first build at `xhigh`, 36 min in): **nothing was eaten** — the
managed engine settles the AI charge ONCE, at turn end (`engine.ts` generator `finally` →
`settleManagedTurn`), while media debits before spend. The session's own usage at that moment was
$9.76 list cost; our rates price the same tokens at $9.71; the turn would bill ~3,306 credits by the
warm-price rule (cache writes at the read rate, floor = never below cost). Three real defects remain:

1. **Spend is invisible while a managed turn runs.** For half an hour a build looks free.
2. **The detach tail can go unbilled.** A detached turn settles what had accrued at the detach; whatever
   the session runs AFTER it (until it idles on the next custom tool call no browser answers) is billed
   only at the next settlement — a resume or the chat's next turn. A chat nobody reopens never bills it.
3. **Every managed ledger row says "— flat creation price"** (`gate.ts:405`, keyed on `flatCredits > 0`,
   which only the managed settlement passes now). Wrong on every edit; reads like a billing bug.

## Decisions

- **D1 — Running estimate from the session's own usage.** During a managed turn the heartbeat carries
  `creditsSoFar`: what `decideManagedCharge` WOULD charge right now against the chat's current cursor
  (pure, nothing written). Source = the cumulative usage the event stream already carries
  (`session.usage` events), else a throttled `sessions.retrieve` (≥ 15 s apart). A failure drops the field,
  never the heartbeat. Legacy sends none. It is an ESTIMATE and is labelled `~N credits so far`; the
  settled number is what the ledger shows.
- **D2 — Detach settles its tail in the background.** When a turn ends `detached`, fire-and-forget a tail
  settlement: poll the session (like `control.ts`'s Stop path) until it is no longer `running`/
  `rescheduling` or a deadline (`MANAGED_DETACH_SETTLE_WAIT_MS`, default 30 min) passes, then
  `settleManagedTurn({ anchorWhenEmpty: false })`. Safe against a resume settling first: settlement is
  by cursor and serialised per chat, so the second one charges only what is new (often nothing). Never
  throws; logs. Residual (accepted, documented): a server restart inside the wait leaves the tail for the
  next settlement of that chat.
- **D3 — The ledger note names what priced it.** `SettleInput` gains `chargeLabel?: string`, used instead
  of the `flatCredits` suffix; the managed settlement passes `managed session`. The old suffix stays for a
  caller that passes `flatCredits` without a label (none ship today).

## Tasks

- [x] **T1 — Ledger label.** `gate.ts` `chargeLabel`; `settle.ts` passes `chargeLabel: 'managed session'`.
  Test: a managed settlement's ledger note contains `managed session` and NOT `flat creation price`;
  CONTROL: `flatCredits` without a label keeps the old suffix.
- [x] **T2 — Detach tail settlement.** As D2. Tests (fake client + injected clock/poll): a detached turn
  whose session keeps running and then idles bills the post-detach usage once; a resume that settled
  first → the tail settles nothing extra (no double charge); a session that never stops → settles at the
  deadline; a throwing retrieve never throws out. Mutation: removing the background call fails the first
  test.
- [x] **T3 — Live credits-so-far.** As D1: server computes it (pure helper + throttled source), heartbeat
  carries `creditsSoFar`, `agent-status.ts` keeps it, the status panel shows `~N credits so far` beside the
  step. Tests: helper matches `decideManagedCharge` for the same usage/cursor; heartbeat omits the field on
  a throwing source; client renders it only when present (legacy unchanged). Live: drive one cheap managed
  turn and see the number on screen.
- [x] **T4 — Docs + gates.** SPEC §4.2 managed bullets / §4.6 settlement + CLAUDE.md managed bullet:
  one sentence each for D1–D3. `pnpm typecheck && pnpm lint:fix && pnpm lint && pnpm test` green.

## Outcome (2026-10-02)

All four tasks verified by independent subagents. A verifier finding (a tail still waiting when a NEW turn
starts could bill part of that turn under the old `_tail` id, so its refund would miss it) was fixed with
`flushDetachedTail` at turn start, and re-verified with a mutation run. Accepted residual: usage still in
flight at the flush lands in the new turn's settlement (≤ one request, under-bill direction only).
