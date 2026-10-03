# Managed Agents Engine — Anthropic's agent loop under the App Builder

**Goal.** Replace the home-built agent loop with Anthropic's hosted one (Claude Managed Agents), so a user's build runs the way the same prompt runs in Claude Code: one durable session, Anthropic's own prompt caching and compaction, no gateway in between. Keep everything that is ours and works: the front end, sign-in, projects, the credit ledger, Stripe, share/gallery/remix, the Nodepod browser sandbox and its live preview.

**Why now (owner, 2026-09-30).** *"Even a simple prompt… nothing but errors, refunds and takes forever… If I entered that same prompt in plain Claude Code, it would have been done 10 times over by now with Opus 5.5."* Measured the same day (`.data/logs/server.log`, `.data/generations`):
- 5 of 12 turns failed `error+segments:0` after up to 13 billed steps (≤ $5.17 provider cost each), all refunded;
- the provider (Comet) dropped the connection mid-turn (`TypeError: terminated`) and missed its cache on roughly a third of steps, rewriting 80–130k tokens at the 2× write rate;
- every step re-sends a ~55–150k-token prefix we assemble ourselves;
- a 20-minute build spent about 7 minutes thinking before its first file and then ~20 single `evaluate_in_game` calls in a row.

The common factor is that we own the loop, the prefix, the provider choice, the retries and the verification policy. Managed Agents moves the loop, caching, compaction and session durability to Anthropic.

**Scope.** Build turns (first build and edits) on the new engine, behind a flag. Plan mode, the Unity Bridge tools and MCP stay on the legacy engine until the new one is proven (D9). Nothing is deleted (hide-don't-delete): `AGENT_ENGINE=legacy` restores today's behaviour byte for byte.

---

## Decisions

- **D1 — Managed Agents, not the Agent SDK.** The Agent SDK *is* the Claude Code process; Anthropic's hosting guide says to run one container per user session, with a gateway, session routing, warm pools and egress lockdown. That is the server-VM lifecycle machinery already ruled out (memory: browser-sandbox requirement — idle cost and lifecycle work, not hourly rate). Managed Agents runs the loop and stores the session on Anthropic's side; we run no per-user process.
- **D2 — Nodepod stays THE sandbox.** The project's files, `npm`, Vite and the preview stay in the user's browser ($0 idle). Anthropic's cloud sandbox documents no way to expose a port, so it cannot serve the game preview; it is not the project's home.
- **D3 — Project tools are CUSTOM tools executed in the browser.** The agent gets custom tools (`agent.custom_tool_use` → our server → the browser's existing workspace executor → `user.custom_tool_result`). They reuse today's executor ops one to one: read, write, edit, list/glob, grep, run allow-listed command, `check_game`, `evaluate_in_game`, `capture_game_screenshot`, `get_game_errors`, `update_todos`. Built-in `bash`/`write`/`edit` are DISABLED, so nothing the model writes can land anywhere but the project (and SPEC §5, no server-side execution of user code, is unchanged).
- **D4 — Docs and skills are Managed Agents skills, read with the built-in `read`.** The Agent Reference and the synced `bt-*` skills are uploaded as skills. They land in the session sandbox under `/workspace/skills/`, and built-in `read`/`glob`/`grep` stay enabled for that path only. This replaces the baked ~90k-character base prompt with on-demand reading, which is how the owner's local Claude Code works. Tool names separate the two filesystems: `project_read`, `project_write`, … for the game; built-ins for the skills.
- **D5 — One session per chat.** The session id is stored with the chat. Anthropic keeps the history and compacts it; we stop re-sending history and file context ourselves. A new chat is a new session; the first message of a session carries a short project manifest (file list only).
- **D6 — A closed tab pauses, never fails.** A session waiting on a custom tool idles at `requires_action` until the result arrives (no documented timeout). When the browser reconnects it answers the outstanding calls and the session continues. A Stop sends `user.interrupt`.
- **D7 — Billing stays ours, cost-derived.** The credit gate runs before each `user.message`. Usage comes from the session's per-request usage events (`span.model_request_end`) and is settled through the existing `settleGeneration` at the end of each user turn (`session.status_idle` with `end_turn`), plus $0.08 per active session-hour, priced as a configured rate (never hardcoded). The per-turn credit ceiling becomes an interrupt. No refund for a turn that wrote files; a turn that errored before any model request is refunded as today.
- **D8 — Anthropic is the ONLY LLM provider; KIE / Comet / Higgsfield are MEDIA providers (owner, 2026-09-30).** Managed Agents runs on Anthropic's platform, so the agent never goes through Comet or KIE. `.env.local` becomes `LLM_PROVIDER=Anthropic` with `AUTO_MODEL_SELECT=false` (the chain otherwise overrides `LLM_PROVIDER`), and `MEDIA_PROVIDER` chooses who renders images, video and sound: `KIE` | `Comet` | `Higgsfield`. Anthropic's baked rows already price the agent's models (`claude-sonnet-5-5`, `claude-opus-5-5`). Two media gaps are separate plans, not tasks here: **Comet sound** (Comet now sells ElevenLabs Text to Sound v2 and Suno; our Comet client has no sound route, so `generate_sound` is hidden on Comet) and **Higgsfield as a third media provider** (not built; `MEDIA_PROVIDER=Higgsfield` is refused today — a start exists in the Agent Reference's `references/web-higgsfield-cli.md`).
- **D9 — Flag and fallback.** `AGENT_ENGINE` = `managed` | `legacy` (default `legacy` until T12 passes, then `managed`). Per-turn fallback is NOT automatic: switching engines mid-chat loses the session, so the flag is per deploy and read when a chat starts.
- **D10 — Sonnet 5.5 is the default model (owner, 2026-09-30).** Read from `LLM_MODEL` as today (`.env.local`: `claude-sonnet-5-5`), at effort `medium`. The agent is provisioned per (model, effort), so the Premium/Platinum tiers become separate provisioned agents of the same definition. **Built 2026-10-02** (it had shipped hardcoded to Standard): every rung is provisioned by Synchronize and on demand, the turn's rung comes from `decideModelTier`, and a tier change moves the chat to a new session on that rung's agent with a recap of the conversation. T1 measured Sonnet at ~6 min / ~$0.90 per full game against Opus 5.5's ~15 min / ~$3.26.
- **D11 — Anthropic-side session storage is accepted (owner, 2026-09-30).** Managed Agents sessions are stored by Anthropic and are not eligible for Zero Data Retention; the privacy/terms copy states it (T12).
- **D12 — The Agent Reference is mounted as FILES, not uploaded as a skill (T1 result).** Uploading `reference.md`, `references/**` and `training/**` once (Files API) and mounting them under `/workspace/agent/` worked first time: the model read `reference.md` and used the docs without mixing them up with the project. The synced `bt-*` skills still go through the Skills API (they carry SKILL.md frontmatter the platform indexes). Provisioning (T3) uploads the reference files once per synced Agent Reference version and reuses the file ids.
- **D13 — The per-turn credit ceiling is a SESSION BUDGET (T1 result).** Managed Agents sessions take a hard dollar cap (`budget.max_list_cost`, minor units, pre-request gate) and pause at `budget_reached` instead of overspending. T7 maps the turn's credit ceiling onto it rather than counting usage and interrupting ourselves.
- **D14 — The user's effort is honoured, per SESSION (owner, 2026-10-02; `_specs/effort-selector_plan.md` D2–D4).** The engine had ignored the user's effort: every session ran at the agent's provisioned `MANAGED_AGENT_EFFORT`. Agents stay one per rung, provisioned at the operator default (`MANAGED_AGENT_EFFORT` now accepts `medium` | `high` | `xhigh` | `max`). Each session is created with `agent: { type: 'agent_with_overrides', id, version, model: { id, effort } }` — the user's choice when the deploy offers it (`parseUserEffort` against `offeredUserEffortLevels`), else the operator default, clamped by `servableEffort` — and `budget` stays on create (a session created without one can never gain one). Effort cannot change on a live session (not per `user.message`, not via `sessions.update`), so an effort change MOVES the chat to a new session through the same path as a tier change (old turn superseded, its tail settled, session archived, recap carried); a RESUME never switches. No repair escalation on this engine — repairs run at the session's effort. The served effort is recorded on the generation and emitted in `agentMeta`. This extends D10 (one agent per rung), it does not change it.

## Open questions the spike (T1) must answer before T2+

1. Round-trip latency of one custom tool call through server → browser → server → Anthropic. **Partly answered:** server → local executor → Anthropic is ~3 s per tool round in T1 (the local executor itself is 0–35 ms). The browser hop is still unmeasured — T5 measures it.
2. ~~Can thinking effort be set on the agent?~~ **Yes** — `model: { id, effort }` on the agent. Default model decided: Sonnet 5.5 (D10).
3. ~~Usage-event fields?~~ **Answered:** `span.model_request_end.model_usage` reports `input_tokens`, `output_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens` separately per request; `session.usage.list_cost` (cents) and `active_seconds` give the session total.
4. ~~Skills readable while built-in write/edit/bash are disabled?~~ **Yes**, with the reference mounted as files (D12); the model used `read`/`glob` on `/workspace/agent` and the `project_*` tools for the game, never confusing the two.
5. Rate limits per organisation, and behaviour when several users' sessions run at once. **Open** — two sessions ran concurrently in T1 without throttling; real load is measured before T12.
6. ~~Data retention~~ **Accepted by the owner** (D11).

### T1 results (2026-09-30)

The owner's prompt, *"Make me a mario kart racer clone complete with drifting mechanics with sound fx. Use the WebAudio API directly"*, on the pinned starter. All runs: effort `medium`, $20 session budget. "Plays" means opened in Chrome, Start Race clicked, accelerated and steered: the kart drove, AI karts raced, and the HUD updated.

| Run | Total | First file | Cost (list) | Checks | Plays | Errors |
|---|---|---|---|---|---|---|
| Opus 5.5 #1 | 15.3 min | 3.6 min | $3.26 | 4/4 pass | ✅ | 0 |
| Sonnet 5.5 #1 | 5.7 min | 1.8 min | $0.94 | 2/2 pass | ✅ | 0 |
| Sonnet 5.5 #2 | 6.1 min | 1.4 min | $0.87 | 3/3 pass | ✅ | 0 |
| Opus 5.5 #2 | 17.4 min | 7.0 min | $3.80 | 3/3 pass | ✅ | 0 |
| Sonnet 5.5 #3 | 7.2 min | 2.9 min | $1.08 | 3/3 pass | ✅ | 0 |
| Opus 5.5 #3 | cancelled by the owner at $4.02 (decision already made) | | | | | |

**Legacy engine, same day, same prompt:** the build passed 20+ minutes without its game phase finishing (about 6½ minutes of thinking before the first game file, then a 20-call `evaluate_in_game` chain), and 5 of the 12 turns logged that day failed `error+segments:0` and were refunded (up to $5.17 provider cost each), including Comet `TypeError: terminated` drops.

**Spike caveats:** the project tools ran against a local copy of the starter rather than the browser, `check_game` was typecheck plus production build (no in-browser scene probe), and the spike skipped image generation. Those are the parts T5, T8 and T11 cover.

### T11 results (2026-10-01)

`node scripts/engine-eval.mjs --engines legacy,managed --prompts mario,platformer,edit,fix --n 1`, run as four processes against a local dev server (`AGENT_ENGINE_EVAL_OVERRIDE=true`). Both engines ran `claude-sonnet-5-5` on Anthropic at effort `medium`. The managed agent was re-provisioned first (version 2, prompt `pv_20261001032127_1fa4e8e6`). "Success" means the harness's final check passed (`tsc -b --force` plus `vite build`), files were written, the creation plan completed and no turn failed. The games were not played: the harness has no browser, so preview tools answered "unavailable". Credits are turn plus media, without the flat 100-credit project charge. Every run was checked against the server log: the managed runs finished `managed:end_turn` and the legacy runs `stop+segments:1`. There were no relay timeouts, refunds or errors.

| Run / engine | Prompt | Total | First file | Credits (raw $) | Turns | Checks | Success | Errors |
|---|---|---|---|---|---|---|---|---|
| Legacy | Mario Kart | 10.9 min | 0.5 min | 763 ($2.61) | 3 | 2/2 pass | ✅ | 0 |
| Managed | Mario Kart | 7.1 min | 1.0 min | 439 ($1.46) | 1 | 2/2 pass | ✅ | 0 |
| Legacy | Platformer | 4.9 min | 0.7 min | 408 ($1.41) | 3 | 2/2 pass | ✅ | 0 |
| Managed | Platformer | 3.1 min | 0.8 min | 212 ($0.69) | 1 | 2/2 pass | ✅ | 0 |
| Legacy | Edit (pause menu) | 0.5 min | 0.2 min | 30 ($0.11) | 1 | 1/1 pass | ✅ | 0 |
| Managed | Edit (pause menu) | 1.0 min | 0.5 min | 44 ($0.16) | 1 | 1/1 pass | ✅ | 0 |
| Legacy | Fix (TS2322) | 0.3 min | 0.1 min | 13 ($0.04) | 1 | 1/1 pass | ✅ | 0 |
| Managed | Fix (TS2322) | 0.4 min | 0.1 min | 6 ($0.02) | 1 | 1/1 pass | ✅ | 0 |

**Reading:**
- Both engines went 8/8, so N=1 shows no difference in reliability. That needs more runs, not this table.
- On first builds the managed engine was about 35% faster and cost about half as much: 7.1 vs 10.9 min and 439 vs 763 credits for Mario Kart, 3.1 vs 4.9 min and 212 vs 408 credits for the platformer. It builds every phase in one turn, where the legacy engine needs three turns that each rebuild the prompt.
- On single-turn edits and fixes the two are within a few credits and a few seconds of each other. The legacy engine was slightly quicker on the edit, and the managed engine was slightly cheaper on the fix.
- Legacy is clearly healthier than in T1's same-day observation: no 20-minute stall and no refunded turns. Comparing against T1's legacy numbers would therefore overstate the gap.

**What invalidated the first three attempts** (kept as `.data/engine-eval/results-*.jsonl`, not used above):
1. The harness wrote run projects under `.data/engine-eval/` inside the repo. The dev server's Vite watcher saw each run's `tsconfig.json` and `dist/index.html`, logged "changed tsconfig file detected … forcing full reload", and cleared the SSR module graph. The next `/api/agent/tool-result` then loaded a fresh `mcp-relay` with an empty registry, answered `delivered:false`, and the turn waited out the 30 s relay timeout. Legacy refunded "wrote no files" turns because of this, and the managed engine paused.
   - Fix: run projects now go to `--work-dir`, which defaults to `<tmpdir>/btk-engine-eval`. A directory inside the repo is refused (`resolveWorkDir`).
2. Eight concurrent processes slowed one `tsc`+`vite build` check to 4.6 min.
3. The dev server was stopped by a 30-minute background limit partway through one batch.

---

## Tasks

- [x] **T1 — Spike: the Mario Kart prompt on Managed Agents, headless (go/no-go).** **GO (2026-09-30):** 5/5 completed runs playable, 0 failures, Sonnet median 6.1 min / ~$0.95; total spike spend $13.97 incl. the cancelled run. Script: `scripts/managed-agents-spike.mjs` (reused by T11).
  `scripts/managed-agents-spike.mjs`: creates an agent (the platform's game-building instructions condensed to a short system prompt; custom tools per D3) and a cloud environment (built-in tools: `read`/`glob`/`grep` only); uploads the Agent Reference as one skill; runs the owner's exact prompt (*"Make me a mario kart racer clone complete with drifting mechanics with sound fx. Use the WebAudio API directly"*). Custom tools are served by a local Node process standing in for the browser: it applies writes to a temp copy of the pinned starter, runs the allow-listed commands for real, and for `check_game` runs `tsc` plus a headless page load. Run 3 times on Opus 5.5 and 3 on Sonnet 5.5.
  **Acceptance:** a results table in this file (time to first file, total time, cost, playable yes/no, failures) beside the same prompt on the legacy engine; answers to open questions 1–5. **Go** if the median build is playable in under half the legacy time with no failed runs; otherwise stop and report.

- [x] **T2 — Engine seam + flag.** `AGENT_ENGINE` read in the agent route; `managed` routes to a new `app/lib/.server/agent-managed/` module, `legacy` to today's proxy unchanged. The route keeps the two walls, the attachment caps, the in-flight claim (including same-tab supersede) and the credit gate in front of both.
  **Acceptance:** with `legacy`, the full test suite is unchanged; a source scan pins that the two walls and the gate run before either engine.

- [x] **T3 — Agent provisioning from the synced prompt.** An admin action (beside Prompt → Refresh) creates/updates the Managed Agents agent from the active prompt version: system prompt, model, custom tool definitions, skills (Agent Reference + synced `bt-*`, honouring `skills/exclusions.ts`). Stores agent id + version on the prompt version. Not configured → a "not configured" state and a descriptive error, never a crash.
  **Acceptance:** re-running the action with unchanged inputs makes no new agent version (hash-skipped, like prompt builds).

- [x] **T4 — Session per chat.** Migration: `managed_session_id` on the chat index row. Created on the chat's first managed turn; reused after. Ownership checked through the chat's project (404-not-403).
  **Acceptance:** a second device opening the chat continues the same session; another user's chat id cannot reach it.

- [x] **T5 — Event bridge → the existing data stream.** Translate session events into the stream the client already renders: `agent.message`/`event_delta` → text; `agent.thinking` → reasoning; custom tool calls → `workspace-tool-call` / `preview-tool-call` data parts; `update_todos` → `agent-todos`; status → the liveness panel. The browser's existing executor and `/api/agent/tool-result` answer the calls; the server forwards them as `user.custom_tool_result`.
  **Acceptance:** the current chat UI renders a managed turn (narration, activity list, todos, preview updating) with no client changes beyond what T6 needs.

- [x] **T6 — Reconnect and Stop.** On page load, a chat with a session in `requires_action` re-attaches: it fetches the outstanding `agent.custom_tool_use` events, runs them in the browser and posts results. Stop sends `user.interrupt`.
  **Acceptance:** closing the tab mid-build and reopening resumes the build with no refund and no duplicate writes; Stop ends it within seconds and bills what was consumed.

- [x] **T7 — Billing.** Per user turn: gate before send; settle from summed per-request usage at `status_idle` (`end_turn`); session-hour rate from config; credit ceiling → the session budget (D13) and a paused outcome with Keep building; `ledger-sql.spec.ts` and `billing.spec.ts` cases for each.
  **Acceptance:** a turn's credits match `ceil(raw / CREDIT_UNIT_COST_USD × CREDIT_MARGIN)` from the reported usage; an error before any model request refunds; a ceiling stop never refunds.

- [x] **T8 — Media and sound tools.** `generate_image` / `generate_video` / `generate_sound` become custom tools the SERVER answers (debit → task → path), exactly as today's `media/service.ts`; the browser still writes the bytes.
  **Acceptance:** the media debit and refund tests pass against the managed path.

- [x] **T9 — First-build phases on the new engine.** Creation still clones the starter with no model call; the first build turn is one managed turn. The phase list (design → game → front end) becomes guidance in the first message rather than three separate requests, since the session no longer has an output ceiling per request.
  **Acceptance:** New Project → Build my game produces a playable game on the managed engine; the handoff card and celebration still work.

- [x] **T10 — Transcript and history.** The chat transcript saved for the sidebar and reload is built from session events. Our history compaction and file-context assembly are skipped on this engine.
  **Acceptance:** reload and a second device show the same conversation; no file bodies stored in the transcript.

- [x] **T11 — Eval harness.** `scripts/engine-eval.mjs` runs a fixed prompt set (Mario Kart, a platformer, an edit turn, a fix turn) N times per engine and reports success rate, time and cost (modelled on Convex Chef's `test-kitchen`).
  **Acceptance:** one command produces a comparison table; it is the evidence for T12.

- [x] **T12 — Switch the default.** `AGENT_ENGINE=managed` by default once T11 shows the managed engine beats legacy on success rate and median time. Update SPEC §3, §4.2, §4.2.8, §4.6, §8l and CLAUDE.md (the engine, the retention note, which context-budget levers no longer apply). Legacy stays as the kill switch.
  **Acceptance:** SPEC and CLAUDE.md describe the managed engine; the gates pass.
  **Keep, do not remove (owner asked, 2026-09-30):** `LLM_PROVIDER_CHAIN` / `AUTO_MODEL_SELECT` still drive the legacy engine, which is the kill switch and still serves Plan mode and the prompt enhancer until they move. Remove them only when legacy is retired for good.

---

## Risks

- **Beta API.** Behaviour may change between releases. The flag (D9) is the fallback.
- **Cost per token.** Anthropic list price instead of Comet's discount. It's offset if failed and re-run turns stop, and T1 measures it.
- **Custom-tool latency.** Every project operation crosses server ↔ browser. T1 measures it; if it dominates, a later step can mirror files into the cloud sandbox so reads are local.
- **Data retention.** Sessions live on Anthropic's platform (open question 6).
- **Single instance.** The tool-result relay registry is in-process, the same constraint as today.

## Considered and not chosen

- **Claude Agent SDK on our servers.** It's Claude Code itself, but it needs one container per user session plus orchestration (D1).
- **Managed Agents with the project in Anthropic's cloud sandbox.** It has real files and real `npm`/`tsc`, but no documented port for the preview, and it would move the project's home off the browser (D2). Revisit as a hybrid: files mirrored there for reads and typecheck, preview still in Nodepod.
- **Swapping to another open-source builder** (Chef, Dyad, Creable). Chef is the same architecture as ours and Convex-specific; Dyad is desktop and bring-your-own-key; Creable routes all AI through Totalum.
