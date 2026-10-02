# Auto-pilot run log — managed-agents-engine_plan.md

## Run 1 — started 2026-10-01 16:50 HST (`/bt-execute --auto-pilot … ALL`, TIME MATTERS)
Queue: T2–T12 (T1 already done).

- DECISION setup: `@anthropic-ai/sdk@0.131.0` added (the version T1's spike ran on); lockfile diff is the SDK subtree only.
- DECISION setup: pre-existing uncommitted work from the 2026-09-30 session (same-tab supersede in api.agent.ts/inflight.ts, server-log, agent-request) is left in place; files this run must also change are committed whole, the rest stay unstaged.
- DECISION setup: the managed engine returns the same `AgentGeneration` interface as the legacy proxy, so the route's `streamGeneration` and the client render a managed turn unchanged (T5 acceptance) — plan D3/T5.
- DECISION setup: the credit gate stays inside each engine (moving it into the route would change the legacy engine); T2's source scan pins walls-in-route-before-dispatch and gate-first in both engines.
- DECISION setup: Plan mode and turns carrying MCP tools route to legacy per turn; Unity Bridge tools are not offered on the managed engine (plan Scope).
- DECISION setup: tool-loop.spec.ts expected the old turnMaxCredits default (2500) while the pre-existing uncommitted tool-loop.ts edit set 25000 (matching the owner's .env.local); spec + .env.example comment aligned to 25000 so the pre-commit gate can pass.
- T2 ✅ verified (independent subagent), attempts 1 — engine-select.spec (22), engine-seam.spec (11, source scan + 5 controls + behaviour). Files: agent-managed/{config,engine-select,engine}.ts, app/routes/api.agent.ts, .env.example, spec/agent-seams.md, package.json (+SDK).
- T3 ✅ verified (independent subagent), attempts 1 — provision.spec (14), tools.spec (6), admin-route.spec (5). Files: agent-managed/{tools,system-prompt,provision,record}.ts, prompt/store.ts, api.admin.managed-agent.ts, ManagedAgentRow.tsx, AdminTab.tsx.
- T4 ✅ verified (independent subagent), attempts 1 — sessions.spec (16), managed-sessions-sql.spec (7, PGlite). Files: migration 0026, projects/chat-index.ts, agent-managed/sessions.ts.
- DECISION T4: migration 0026 also carries `managed_settled_at` (T7's settlement cursor) so the feature has one migration; a trigger clears both managed columns when a chat row changes project (stops a session following a chat id to another project).
- DECISION T3: skills via the Skills API (skills.create / versions.create, pinned on the agent); reference files via Files API at the prompt version's sourceCommitSha; record stored on the prompt version under managedAgents["model:effort"].
- DECISION Phase A commit deferred until Phase B lands: the pre-commit hook runs the whole working tree, and Phase B was already editing engine.ts in parallel.
- T11 (build pass) done by implementer, not yet verified/run: scripts/engine-eval.mjs + scripts/engine-eval/lib.mjs (+22 tests), resolveEngineForRequest eval-only override (engine-override.spec 6). DECISION T11: eval drives the real /api/agent over HTTP and plays the browser's executor locally; engine chosen per request only via a dev-only override (NODE_ENV!=production AND AGENT_ENGINE_EVAL_OVERRIDE=true).
- T5 ✅ verified (independent subagent, LIVE in Chrome on the real managed engine), attempts 1 (+1 fix pass: dead-session rebind, supersede of a turn waiting on tool results) — events.spec 10, dispatch.spec 10, engine-turn.spec 18, control.spec 6, managed-turn.spec 7. Live: gen_muqfhzmw_qdtd2a end_turn −21 (formula matches).
- T6 ✅ verified LIVE — reload mid-turn: detached −6 then resumed −10, one tool result per call (no duplicate writes), no refund; Stop → user.interrupt 0.36 s later, session idle at +0.49 s, billed −19, no refund.
- T7 ✅ verified — billing.spec +4 (extraRawCostUsd), cursor settlement idempotent, refund only before any model request / empty response, budget stop never refunds. Orchestrator re-checked ledger rows independently (debits only, no refunds).
- DECISION T6: resume appends a new assistant message (status returns the turn's text) instead of `reload()`, which deleted the previous answer (found live by the implementer).
- DECISION T7: cursor advanced before the debit — a failed debit under-bills (alerted) rather than double-charging; session hours billed even with zero tokens.
- DECISION records: T7 block's "credit ceiling → user.interrupt" reworded to the session budget per D13.
- Open (non-blocking, from verifier): on Stop, a model request still running when the request detaches is only billed by the chat's NEXT settlement — handled in Phase C (interrupt route settles after idle).
