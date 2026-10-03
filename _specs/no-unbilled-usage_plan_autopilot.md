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
