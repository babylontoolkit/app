# No unbilled usage (plan)

Owner, 2026-10-02: *"We always figure a way to get billing in, we never eat the cost. Otherwise this is all
for nothing."* Rule from here on: **every byte of provider spend reaches the ledger — even when the request
dies, the process restarts, the tab closes, or the user never comes back.** The only spend the platform
absorbs is what the owner has DECIDED to absorb (the refund policy R1–R8 and the cache-warmer ops spend),
never an accident of timing.

## Audit (2026-10-02, read-only; file:line refs in the audit transcript)

Real gaps — usage that can be lost even though it should bill:

- **G1** Legacy engine + enhancer: nothing is written until the end (`settleGeneration` in a `finally`,
  `proxy.ts` ~3408/3449; enhancer fire-and-forget `api.enhancer.ts` ~186-284). Process death mid-stream
  loses ALL usage. Per-step usage exists (`onStepFinish` → `turnMeter.onStep`) but is never persisted.
- **G2** Chat / project / account delete during or after a managed turn: the index row goes, the session is
  never interrupted, settled or archived; a pending tail then finds the session unbound and charges nothing.
- **G3** A failed managed turn refunds everything its settlement charged — which can include usage carried
  over from an EARLIER turn (an unsettled tail, a killed Stop tail, a failed read).
- **G4** Rebind/tier/effort switch releases the old session (cursor cleared) even when its `_prior`
  settlement failed; usage after `_prior` from a session still running past the supersede wait is lost when
  it is archived.
- **G5** No sweep: a managed chat never touched again never settles its tail (in-memory timers die with the
  process). No list-all query exists to build one.
- **G6** Crash between the managed cursor write and the debit loses that charge with no alert.
- **G7** Legacy: the step in flight at a Stop / error / provider retry is never billed (incl. its input and
  cache tokens); with `AGENT_TOOL_LOOP=false` an aborted stream bills nothing.
- **G8** Enhancer: a provider error before streaming starts hangs `await result.steps` forever (ai@4.3.16)
  — no row, no alert.
- **G9** Media: an ambiguous create (timeout / network) is refunded and retried, so a render the provider
  accepted can run refunded, and a retry can start an un-debited duplicate.
- **G10 (unverified, possibly largest)** Production runs under workerd (`wrangler pages dev`, one
  container). The code never calls `waitUntil` and `enable_request_signal` is not set. If a client
  disconnect cancels the request's work, `finally`-block settlements and every fire-and-forget tail may never
  run.

Also: web search debits AFTER the vendor is paid and only logs a failed debit (`web-search-tool.ts` ~35-66).

## Decisions

- **D1 — Measure G10 first, then make settlement survive it.** Run the production server shape locally and
  observe whether, after a client disconnect, (a) `request.signal` fires, (b) a `finally` after the stream
  runs, (c) a fire-and-forget promise and a `setTimeout` run. Whatever the answer, every settlement and tail
  is registered with the runtime's `waitUntil` when one exists (`context.cloudflare.ctx.waitUntil`), behind
  one helper `keepAlive(context, promise)`, so the same code is safe on Node and workerd. Record the
  measured facts in Findings.
- **D2 — A durable record BEFORE spend.** Every model turn (legacy, managed, enhancer) writes its
  `generations` row with `status:'running'` (plus engine, chat, and managed session id) before the first
  provider call. Legacy checkpoints cumulative usage onto that row after every step. A row left `running`
  past a stale threshold is a turn whose process died.
- **D3 — The sweep.** One server sweep, started lazily at the first request and every
  `BILLING_SWEEP_INTERVAL_MS` (default 10 min), run through `keepAlive`, never two at once, never throws:
  (a) a stale `running` legacy/enhancer row → settle from its last checkpoint, status `interrupted`, never
  refunded; (b) every chat with a managed session whose session cost exceeds its cursor and that has no
  turn in flight in this process → settle (`requireBoundSession`, `anchorWhenEmpty:false`, id `<chat>_sweep`);
  (c) a managed pending-debit intent with no ledger row (D6) → debit it. Needs a new
  `ChatIndex.listWithManagedSession()` (FS + Postgres; a partial index on `managed_session_id`).
- **D4 — Delete settles first.** Deleting a chat, project or account interrupts each live managed session,
  waits (bounded) for it to stop, settles it, archives it, and settles any stale legacy row — THEN deletes.
  A settle failure is logged and the sweep's intent is kept (the record survives the delete).
- **D5 — A turn bills carried-over usage separately, before it starts.** At managed turn start (after the
  gate, before any session message) settle anything above the cursor as `<gen>_carry` (generalising
  `flushDetachedTail`). A failed turn's refund then covers only its own usage. Rebind releases the old
  session ONLY after its `_prior` settlement succeeded (or the session is gone — 404); a session still
  running past the supersede wait is interrupted, waited for, settled, then archived.
- **D6 — No cursor-without-debit window.** The managed cursor records a pending debit
  `{generationId, credits}` in the same write; it is cleared after the debit lands. The sweep debits any
  pending intent whose generation has no ledger row (idempotent by generation id).
- **D7 — Bill the step in flight.** Capture `message_start` usage (input + cache tokens) from the raw
  Anthropic-shaped SSE via the existing stop-reason fetch tee; a step or retry attempt that breaks after it
  is billed at that usage plus any output already counted. Same rule for the tool-loop-off path.
- **D8 — Enhancer cannot hang.** Settle from a race of `result.steps` against the stream's error / end;
  write the `running` row first (D2) so even a hang is swept.
- **D9 — Media: ambiguous creates keep their debit.** A timeout / network failure on create is AMBIGUOUS:
  never refunded, never retried blind; the task is marked `unknown` and polled/reconciled by idempotency
  key where the gateway supports one, else surfaced to the Admin report. Only an explicit provider refusal
  (4xx) refunds. Web search debits BEFORE the vendor call (refund on vendor failure) and alerts on a
  failed debit.
- **D10 — The policy stays the owner's.** Refunds R1–R8 (failed generations, refused media, etc.) and the
  cache-warmer ops spend are unchanged; they are listed in `spec/billing.md` as the ONLY sanctioned
  platform-absorbed spend.

## Tasks

- [x] **T1 — Measure G10 + `keepAlive`.** Run the production server shape (`pnpm build` then the
  package's `wrangler pages dev` start script) on a spare port; a tiny probe route (dev-only, removed after)
  or a real `/api/agent` legacy turn; disconnect mid-stream; observe (a)–(c) of D1 from logs. Add
  `app/lib/.server/runtime/keep-alive.ts` (`keepAlive(context, promise)` → `waitUntil` when present, else
  returns the promise) and route every settlement / tail / Stop tail / enhancer settlement through it; set
  `enable_request_signal` in `wrangler.toml` if the probe shows the signal does not fire. Findings record
  what was measured. **Acceptance:** after a mid-stream disconnect under the production shape, a legacy
  turn's ledger row lands.
- [x] **T2 — Durable `running` row + legacy step checkpoints.** D2 for legacy, managed and enhancer.
  Tests: a row exists before the first provider call; each finished step updates its cumulative usage; a
  completed turn ends `completed` exactly once (no double debit). Migration only if a column is missing.
- [x] **T3 — Sweep.** D3 (a)–(c) + `listWithManagedSession` (FS + Postgres, migration with the partial
  index, asserted in `ledger-sql.spec.ts`). Tests: stale legacy row → billed from checkpoint, `interrupted`,
  no refund; managed chat with cost above cursor and no in-flight turn → billed once; CONTROL a chat with a
  turn in flight is skipped; a second sweep charges nothing; a throwing session read never throws.
- [x] **T4 — Delete settles first.** D4 for chat, project and account delete. Tests: delete during a live
  managed turn → session interrupted + settled + archived, ledger row lands, then the rows go; a settle
  failure leaves a sweepable record.
- [x] **T5 — Carry-over + safe rebind.** D5. Tests: carried-over usage bills as `_carry` before the turn and
  a failed turn refunds only its own usage; rebind with a failing `_prior` read keeps the session bound;
  a still-running old session is interrupted, settled, then archived.
- [x] **T6 — Pending-debit intent.** D6. Tests: cursor written + debit "crashes" → sweep debits it once;
  normal path leaves no intent.
- [x] **T7 — Bill the step in flight.** D7. Tests: a stream that breaks after `message_start` bills its
  input/cache tokens; a retry attempt that broke after `message_start` is billed; tool-loop-off abort bills
  what was consumed.
- [x] **T8 — Enhancer.** D8. Test: a provider error before streaming settles (zero or partial) instead of
  hanging.
- [x] **T9 — Media + web search.** D9. Tests: create timeout → no refund, task `unknown`, no blind retry;
  explicit 4xx → refund; web search debits before the vendor call.
- [x] **T10 — Docs + gates.** SPEC §4.6 + `spec/billing.md` (the no-unbilled-usage rule, the sweep, the
  sanctioned-absorption list D10) + CLAUDE.md one entry; `pnpm typecheck && pnpm lint:fix && pnpm lint &&
  pnpm test` green.

## Findings

**T1 — G10 measured, 2026-10-02.** Production shape run locally: `pnpm build`, then `wrangler pages dev
./build/client --port 8799` (wrangler 4.44.0, workerd, `compatibility_date = "2025-03-28"`) with the
`.env.local` bindings. A temporary probe route streamed one chunk every 500 ms for 10 s; `curl -N` was killed
after ~1.6 s. workerd noticed the disconnect ~1–1.5 s later (on the next enqueue).

| Observed after a mid-stream client disconnect | `nodejs_compat` only (as shipped) | + `enable_request_signal` |
|---|---|---|
| (a) `request.signal` fires | **No** — never | **Yes** — ~1 s after the disconnect |
| (b) a loop's `finally` after the stream (the shape of the proxy's settlement `finally`) | **No** — never runs | **No** — never runs |
| (c) fire-and-forget promise (3 s) / `setTimeout` (5 s), with nothing registered via `waitUntil` | **No** — both stop with the request; logging stops entirely | **No** — same |
| (d) work registered via `context.cloudflare.ctx.waitUntil` (3 s, 5 s, 12 s; one run 75 s) | **Yes** — all ran | **Yes** — all ran |
| (b)/(c) while a `waitUntil` promise is still outstanding | **Yes** — the whole request context stays alive, so the loop `finally` and the fire-and-forget work run too | **Yes** — and the loop saw the abort at once |

- `context.cloudflare.ctx.waitUntil` is present in the production load context (Remix's
  `createPagesFunctionHandler` builds it) — no change to `functions/[[path]].ts` / `getLoadContext` needed.
- Even with NO disconnect, a probe's async work finishing at the same moment as the response body was cut off
  (its `finally` never logged): work that outlives the response is not safe without `waitUntil` either.
- Settlement-shaped probe (the route's exact driver: `ai@4` `createDataStream` + async generator whose
  `finally` does an outbound HTTP write, like a Supabase/PostgREST ledger insert), killed at 1.2 s:
  without `keepAlive` → signal fired, `finally` **never ran, no row**; with `keepAlive` → `finally` ran and
  the row **landed** (`{"keep":true,"aborted":true}`); `keepAlive` without the flag → the generator ran to its
  natural end (10 s, i.e. a closed tab would run the whole turn) and then wrote the row (`aborted:false`).
- Local mode cannot run under workerd: `node:fs` is the unenv stub (`[unenv] fs.mkdir is not implemented
  yet!` on `/api/me`; the FS stores resolve to `/.data`). So no real `/api/agent` turn can be driven under the
  production shape without Supabase; production uses Supabase + S3, which are HTTP and behave like the probe.
- Real legacy Plan-mode turn on the Node dev server (Sonnet), disconnected mid-stream: the settlement ran and
  the ledger row landed (`gen_mus4epkz_uvjzlo`, 4 credits, step 1 only). A disconnect during the FIRST step
  settled `0` tokens (`gen_mus4ds59_j53vjt`, 61 text chunks already streamed) — the in-flight step is
  unbilled, which is G7 / T7, not G10.
- Not measured: whether self-hosted workerd caps `waitUntil` for the 30-min detached-tail wait (75 s
  measured fine; hosted Cloudflare would cap at ~30 s after the response).

