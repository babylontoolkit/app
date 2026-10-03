# no-unbilled-usage — auto-pilot run log

## Run 1 — started 2026-10-02 22:04 HST (branch `btk-sandbox`)

Queue: T1–T10 (ALL), 0/10 done at start.

### Decisions

- DECISION run: phases = [T1 (live measurement)] [T2–T4] [T5–T7] [T8–T9] [T10].
- DECISION run: phase checkpoint commits use `--no-verify`; T10 runs the full chain and its commit goes through the hook (hook = typecheck/lint/brand; tests run separately).
- DECISION run: refund policy R1–R8 unchanged (D10) — owner's documented rule; surfaced in the exit report.

### Tasks
- DECISION T1: the load-bearing fix is registering the `/api/agent` stream driver with `waitUntil` (a generator `finally` is unreachable after a disconnect unless the drain is kept alive); every settle/refund/tail/media call is ALSO wrapped so non-route callers are covered.
- DECISION T1: `enable_request_signal` added to wrangler.toml — without it `keepAlive` runs a closed tab's whole turn to completion (abort never fires).
- DECISION T1: acceptance proven with a probe reproducing the route's driver shape under workerd (local mode cannot run under workerd — unenv fs) + a real legacy disconnect on Node (ledger row gen_mus4epkz_uvjzlo).
- RISK T1: 30-min detached-tail wait under self-hosted workerd proven only to 75 s — the T3 sweep is the backstop.
- T1 ✅ verified (independent) — 1 attempt — keep-alive.spec 6; agent/managed/billing/media 2,776 tests green; G10 CONFIRMED and fixed.
- DECISION T2: BYOK turns write no running row and are never swept (the user's key paid). A failed running-row open/checkpoint alerts and the turn proceeds.
- DECISION T3: sweep starts from request doorways (proxy, managed engine, /api/me) + an unref'd timer (under workerd a timer does not outlive its request); managed sweep window = chats active in the last 7 days.
- DECISION T4: a delete never blocks on settlement; a session still running after the bounded wait is recorded in `managed_billing_orphans` (no FKs — survives the delete) carrying the POST-settlement cursor.
- DECISION T3/T4 (verifier fix): claim-before-debit (`running`→`interrupted` guarded update) + migration 0029 one-debit-per-generation partial unique index (FS mirror too); a refused duplicate = "already billed" (0 credits, alert, no refund). Settlement ids made unique (`_prior` carries the session id).
- RISK: Postgres-only query paths (listRunning filter, projects!inner join, orphan store, 23505 mapping) checked against migrations by reading + PGlite schema/index — not against live PostgREST.
- NOTE (pre-existing, not fixed): enhancer failure upsert zeroes token columns on Postgres (records only); a managed turn finishing after its chat was deleted rewrites the transcript (billing-safe).
- T2 ✅ verified (independent) — 1 attempt.
- T3 ✅ verified (independent) — 2 attempts (defect B fixed).
- T4 ✅ verified (independent) — 2 attempts (defect A fixed). Suites: 131 files / 2,800 tests green.
- DECISION T5: `_carry` also runs on a resume; a rebind whose `_prior` is incomplete records an orphan (post-settlement cursor) and releases; orphan write failure → ManagedRebindError 503, chat stays bound.
- DECISION T6: `pending` is a LIST of intents; every settlement recovers stored intents first; anchored recovery writes only the ledger debit (`gate.ts debitAnchoredGeneration`); a refundable turn's intent is DROPPED (never debited) — refunds aren't idempotent so debit+refund pairs could refund twice.
- DECISION T6 (verifier fix): intents debited before EVERY release (rebind gone/missing, orphan 404); orphan/chat released only when nothing is owed.
- DECISION T7: wire tap on Anthropic-shaped SSE only (Anthropic + KIE/Comet Claude routes); gpt/gemini/chat wires NOT tapped (gap); broken step output floored at chars/4 (can under-bill, never over-bill).
- RISK (carried to T8–T9 brief): migration 0026 re-home trigger nulls a chat's session+cursor on project move → pending intents lost (platform loses); T5 race keepForSweep-then-release-throws / concurrent switched rebinds → same cursor billed twice (user overcharged, rare).
- T5 ✅ verified (independent) — 1 attempt.
- T6 ✅ verified (independent) — 2 attempts (2 money defects fixed).
- T7 ✅ verified (independent) — 1 attempt. Suites: 147 files / 3,187 tests green.
- DECISION T8: enhancer settles from a bounded race (2 s after stream end); failure status rides the settlement write (no zeroing upsert); wire recorder passed (additive prop in upstream stream-text.ts, logged in FORK_BASE.md).
- DECISION T9: media create failures classified refused / not-sent / ambiguous, DEFAULT ambiguous → debit held, task `unknown`, Admin "unconfirmed" list, alert. Under workerd every transport failure is ambiguous (measured: refused connection and after-send drop are indistinguishable). Cut-out start failure refunds only the cut-out share. All media status writes carry the money columns. Web search debits before the vendor call; no vendor call on a failed enforced debit.
- DECISION R1: a chat moved to another project settles its session first (billed to the OLD owner); a move/delete whose session handling cannot be confirmed is refused retryably (503) — nothing erased.
- DECISION R2: one billing owner per session — orphan withdraw = delete; sweep defers an orphan while its chat is still bound; orphan advanced BEFORE release; failed advance → no release, retryable refusal; migration 0030 one open orphan per session.
- NOTE: account-delete refusal message says "Nothing was deleted" even if earlier projects in the loop were purged — wording only, retry completes correctly.
- T8 ✅ verified (independent) — 1 attempt.
- T9 ✅ verified (independent) — 1 attempt (+ workerd classification measured).
- R1/R2 (carried residuals) ✅ verified (independent) — 3 attempts. Suites: 172 files / 3,765 tests green.
- DECISION T10: R1–R8 numbered from the refund call sites (spec/billing.md). fail-loud's four terminal states kept; `interrupted` / media `unknown` documented as CHARGED AS CONSUMED variants.
- DECISION T10 (scope expansion, verifier-found): production env delivery was broken for ~55 names — `bindings.sh` dropped every name with a digit/lowercase (all `S3_*` → S3 silently OFF in production; `HuggingFace_API_KEY`), and ~50 names the app reads were never declared in `worker-configuration.d.ts` (incl. `MANAGED_SESSION_HOUR_USD`, `AGENT_TURN_MAX_CREDITS`, `PROJECT_CREATE_CREDITS`, `FAL_API_KEY`, `ENABLE_MAX_EFFORT`, `GITHUB/GITLAB_OAUTH_*`). Fixed bindings.sh regex + declared all + default-deny guard `env-delivery.spec.ts` (literal, wrapper, *_ENV_KEY, baseUrlKey and template-literal reads; checks the exact bindings.sh extraction). Exclusions by design: UPSTREAM_LLM_ROUTES_ENABLED, VITE_GITHUB_ACCESS_TOKEN.
- DECISION T10: stale `NO_LOUDNESS_BY_DESIGN` web-search exemption removed (web search now debits first + alerts).
- T10 ✅ verified (independent) — 3 attempts; full gates: typecheck 0, lint 0 errors, 452 files / ~9,490 tests green, brand gate green.

## Run 1 — ended 2026-10-03 00:39 HST — 10/10 complete, 0 deferred. Plan finished.
