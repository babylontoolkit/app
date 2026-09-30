# App Builder v2 — Agent Harness Research

*2026-09-30. Research into why v1 builds rarely finish, what the builders that do finish have in common, and which agent harness to build v2 on.*

---

## 1. Verdict

**The model is not the cause, Nodepod is not the cause, and bolt.diy's UI is not the cause.** The cause is the design v1 inherited from bolt.diy and then tightened to cut cost: **the model writes the whole game as streamed text in one response, with no way to compile, run, or check it, under hard caps.** The prompt then tells the model to expect to run short. This is verified in the code.

Every builder that finishes builds reliably (Lovable, Bolt v2, Replit Agent 3/4, v0, Same, Chef) has **abandoned the one-response artifact** in favour of a **tool-calling loop**:
- files are written and edited one tool call at a time;
- the step budget is long and the agent works from a todo list;
- typecheck, build and runtime checks run *inside* the turn, and a passing result is what defines "done".

**Bolt itself, the company that invented the artifact protocol, moved v2 onto the Claude Agent SDK.** Anthropic's Bolt case study confirms this.

**Consequence:** "worst case, start from a fresh bolt.diy" rebuilds the root cause, unless the agent half (message parser, action runner, `<boltArtifact>` protocol) is ripped out on day one. A fresh bolt.diy is fine as a **UI shell** (chat, editor, file tree, preview). It is not a harness.

---

## 2. Why v1 does not finish (verified in this repo)

| # | Mechanism | Where | Effect |
|---|---|---|---|
| 1 | Files are written only as `<boltArtifact>`/`<boltAction>` text in the reply ("One artifact per response") | `prompt/sections/10-action-protocol.md:36`, client action runner | The entire deliverable must fit in one response |
| 2 | Output is capped at **64k tokens**, shared with thinking, on models that allow 128k | `agent/proxy.ts:2131` | `creation-plan.ts:9-18` measures a monolithic game at 50–62k artifact tokens + 20k reasoning, so it cannot fit |
| 3 | 10 steps on a build turn (18–26 with media/bridge); reads measured to exhaust them before any write | `budgets.ts:184-197`, `tool-policy.ts:359,403-411` | Turn ends mid-plan |
| 4 | The rescue is ONE tools-off stream: "You have used all available tool rounds… Complete the task now" | `proxy.ts:2734-2757` | Cannot read or check anything; if it truncates, the turn ends "incomplete" |
| 5 | **No tool runs `tsc`, `vite build`, or returns compile errors**; the verify phase was removed | no such tool; `creation-plan.ts:290-311` | Type and import errors are never seen before the turn ends |
| 6 | Build turns deliberately exclude the preview tools | `proxy.ts:1866-1887` | The build cannot see its own runtime errors |
| 7 | Auto-repair fires only on uncaught preview exceptions within 8s, max 2, off during the plan | `runtime/auto-repair.ts`, `Chat.client.tsx:1257` | Game code lazy-loads under `/play`, so its errors arrive after the window and repair almost never fires |
| 8 | Read budget 24 files / 120k chars; reference docs 3 per turn; no `.d.ts`; refusals say "write the code now" | `budgets.ts`, `file-tools.ts:199-223` | Toolkit calls are written from memory, producing invented APIs (the `GetKeyDown` class of bug) |
| 9 | `read_file` serves the pre-turn snapshot | `proxy.ts:1784-1790` | Cannot re-read what it just wrote |
| 10 | Failed `edit` actions are never fed back; edits must match file bodies the model was never shown | `action-runner.ts:319-336` | Silent failed edits |
| 11 | Ordinary-turn truncation is reported as `finished`; the phase plan pauses on `incomplete` and waits for the user | `turn-outcome.ts:122`, `creation-plan-runner.ts:240` | This is the "keep typing continue" experience |
| 12 | **The prompt tells the model to expect to fall short:** *"run short on the game, and the user is one prompt from done"*; "say plainly what you could not do"; "two or three concrete next steps" | `20-hard-constraints.md:234-244`, `creation-completion.ts:127-141` | This is the "another pass" behaviour |
| 13 | Stale pointers: history says bodies are in "Current Project Files" (that section no longer exists); a tool says "there is no tool to read more" | `history.ts:83`, `tools.ts:195` | On continue turns the model cannot find its own earlier work |

SPEC §4.2 states the intent plainly: *"single agent + server-side tool loop + self-healing repair turns. No orchestrator/subagents"*, chosen for **cost, latency and streaming UX**. §4.2.8 treats every step, read and continuation as money to minimise. Each decision was reasonable taken alone. Together they built a harness optimised to be cheap per turn rather than to finish. `proxy.ts` is 3,385 lines, roughly half of them comments explaining past defects, which is a sign of a design fighting its own shape.

---

## 3. What the builders that finish have in common

| Pattern | Who | v1 today |
|---|---|---|
| File writes/edits are **tool calls** (write, str_replace, view) | Lovable `lov-write`/`lov-line-replace`, v0 Edit, Replit `str_replace_editor`, Chef `edit`, Same `string_replace` | Text artifact |
| **Long step budget + todo list** | Chef 64 steps, Replit up to 200 min, v0 TodoManager, Same `.same/todos.md`, Anthropic "feature list all marked failing" | 10 steps, no todo |
| **Verify tool inside the turn; passing = done** | Chef `deploy` = `tsc --noEmit` + build + dev server; "DO NOT end your turn until the error is fixed". Same runs the linter after every edit | None |
| **Runtime checks** (console, network, browser) | Lovable, Replit App Testing, Anthropic Evaluator (Playwright) | Exists (`evaluate_in_game`, screenshot), but excluded from build turns |
| **Circuit breakers** on fix loops | Same 3 per file, v0 2 failures, Chef `MAX_CONSECUTIVE_DEPLOY_ERRORS` | Caps on steps, not on fix attempts |
| **Plan, then build incrementally** | Bolt v2 / v0 / Lovable plan mode; Anthropic planner → one feature at a time | Phases exist but are cut short |
| **Separate evaluator** (never saw the generation) | Replit verifier, Anthropic Evaluator | None (the model grades itself) |
| **Subagents with fresh context** | Replit, Lovable, Bolt (via Agent SDK), Same `task_agent` | Explicitly "no subagents" |
| **Compaction / context reset** | Dyad, Chef, Anthropic handoff files, Agent SDK built-in | History windowing only |
| **Usage-based credits scaled to effort**, a spend ceiling rather than a step cap | Lovable, Replit | Step caps to protect cost |

Anthropic's own harness posts name v1's exact failure modes: **"one-shotting"** and **"declaring done early"**
([effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents),
[harness design for long-running apps](https://www.anthropic.com/engineering/harness-design-long-running-apps)).

**Games need one adjustment:** generic browser testers fail on `<canvas>` (Lovable documents this). Verification for a Babylon game is:
1. `tsc -b`;
2. `vite build`;
3. load `/play`;
4. `get_game_errors` + `evaluate_in_game` (scene loaded? `update()` running?);
5. an in-render screenshot.

v1 already built steps 4–5.

---

## 4. Harness options

**Hard constraint:** tools must execute in **Nodepod in the user's tab** ($0 idle). There are three ways to do that:
- **(a)** the loop runs on the server and each tool call is **relayed** to the browser (v1's §4.14 MCP relay pattern: `execute` emits, awaits the browser's POST, one generation, one settlement);
- **(b)** the loop runs **in the browser** and LLM calls go through the metered proxy;
- **(c)** Anthropic hosts the loop and our server relays its custom tool calls to the browser.

| Harness | Fit | Why |
|---|---|---|
| **Claude Agent SDK** (TS) | ⭐ **Top pick** | Closest to Claude Code's own harness: compaction, TodoWrite, subagents (Task), **SKILL.md skills natively**, hooks (a Stop hook can block "done" until verify passes), sessions/resume. Built-in Read/Write/Edit/Bash can be disabled (`tools`/`disallowedTools`) and replaced with in-process tools (`createSdkMcpServer`), whose handlers run in **our** Node process and can await the browser relay. `ANTHROPIC_BASE_URL` → our metering proxy sees every request exactly. Bolt v2 runs on it. Costs: one CLI subprocess per *active* session (~1 GiB, ~$0.05/h; Anthropic notes tokens dominate by ~10×); Claude-only; proprietary terms (no "Claude Code" branding). |
| **Vercel AI SDK v6/v7** `ToolLoopAgent` + relayed `execute` | ⭐ Strong second | Smallest migration from v1 (already ai@4 + the relay). Exact per-step usage, one settlement, Apache-2.0, multi-provider, `stopWhen`/`prepareStep`, v7 durable `WorkflowAgent` and a `SandboxSession` interface Nodepod could implement. **We build** todo, compaction, subagents and the verify gate ourselves (a few hundred lines each). Avoid its pure client-tool mode: every tool result becomes a new HTTP request and fragments billing. |
| **pi-agent-core + pi-ai** (loop in the browser) | Interesting | MIT, runs in the browser, tools call Nodepod directly (no relay), `streamProxy` to our metered server. But: minimal by design (no todos or subagents), a turn dies with the tab, ownership changed in April 2026 (Earendil) with npm scope churn, and `pi-web-ui` is gone from main. |
| **Claude Managed Agents** (client-executed custom tools) | Spike-worthy | Anthropic hosts the loop (no subprocess on our side); `agent.custom_tool_use` → our server relays to the browser → `user.custom_tool_result`. Beta (`managed-agents-2026-04-01`); billing comes from Anthropic's usage, not our gateway (no KIE/Comet); less control over the prompt and cache. |
| LangChain **deepagents** (JS) | Viable | Implement `BaseSandbox` (`execute`/`uploadFiles`/`downloadFiles`) and get file tools, `write_todos`, subagents and summarisation for free. Heavy abstraction; harder to control cache-breakpoint ordering. |
| Mastra | Viable | Similar to deepagents, TS-native; watch the `ee/` licence boundary. |
| opencode, Codex app-server, OpenHands, Goose, Cline SDK | Poor | Each assumes it owns a local disk and process. |
| Amp / Cursor / Factory SDKs | No | Vendor-billed models; cannot resell as credits. |
| Roo Code | Dead | Archived 2026-05-15. |

### Open-source bases worth reading (not necessarily forking)

- **Chef (get-convex/chef, Apache-2.0).** A **bolt.diy fork that already made the jump**: tools declared server-side, executed in the browser WebContainer, `maxSteps: 64`, and a `deploy` tool (`tsc --noEmit` + build) as the done gate with a consecutive-error breaker. The best proof that the jump works on a browser sandbox. Its per-step HTTP round trip is the one thing v1's relay does better.
- **vercel-labs/open-agents (MIT).** "The agent is not the sandbox": a durable workflow drives the sandbox through tools, and turns survive across persisted steps.
- **Dyad (Apache-2.0, local Electron).** A small AI SDK tool loop with compaction; a useful minimal reference.
- **bolt.diy** is stalled (last release v1.0.0, 2025-05) and still uses the text protocol.

---

## 5. Recommendation

1. **Harness: Claude Agent SDK, with Nodepod-relayed tools.**
   - Keep the SDK's TodoWrite, Task (subagents), Skill, compaction and hooks.
   - Disable its Read/Write/Edit/Glob/Grep/Bash and register replacements **with the same names and argument shapes** (`file_path`, `old_string`, `new_string`, …). Claude is heavily trained on those exact schemas, which is a large part of why Claude Code's edits land.
   - Replacements run in Nodepod through the relay. `Bash` is restricted to an allow-list: `npm`, `tsc`, `vite build`, `ls`/`cat`-class commands.
   - Add a `check_game` tool: `tsc -b` → `vite build` → load `/play` → `get_game_errors` + `evaluate_in_game` + screenshot.
   - A **Stop hook refuses to end the turn while `check_game` is failing**, with a breaker of about 3 consecutive identical failures, after which the turn ends loudly.
   - The user's `bt-*` skills load as-is. This is also what makes `bt-gauntlet` possible on the platform (it was excluded for lacking subagents).
2. **Put the Toolkit's `.d.ts` in the project and let the agent Grep it** rather than baking it into the prompt. This is how Claude Code avoids invented APIs.
3. **Replace step caps with a spend ceiling.** Budget each turn in credits (say the user-visible max) and let the agent run until done or out of budget. Credits are already cost-proportional, so this is honest pricing. Expect a full game to cost several dollars in tokens, not cents. Anthropic measured a retro game maker at $9 solo and $200 with a full planner/evaluator harness; price the product accordingly.
4. **UI shell:** either a fresh bolt.diy with the agent half deleted, or v1's own workbench, which already runs on Nodepod. The shell is the cheap part.
5. **Carry forward from v1:**
   - Nodepod sandbox seam;
   - Unity Bridge + Desktop Agent;
   - preview tools (in-render screenshot, `evaluate_in_game`);
   - the relay registry pattern;
   - media generation;
   - local-disk mirror;
   - the ledger/Stripe/credits money path;
   - auth's two walls.
   
   **Leave behind:** the artifact protocol, phase plan, step/read/reference caps, forced-continuation rescues, and most of the §4.2.8 context-shaping.

### De-risk before committing: a 2–3 day bake-off

The tool layer (relayed Read/Write/Edit/Glob/Grep/Bash/`check_game`) is **harness-agnostic**. Build it once and run it under both **Claude Agent SDK** and **AI SDK v6 `ToolLoopAgent`**. Then run the same 5 real game briefs through each and measure:
- completion rate (does `check_game` pass with no "continue"?);
- $ per build;
- wall time;
- number of user interventions.

Pick the winner on data. The same experiment also answers whether v1 could be rescued by swapping its brain, since the tool layer drops into v1's proxy too.

---

## Sources

- Anthropic: [Bolt case study](https://claude.com/customers/bolt), [Lovable case study](https://claude.com/customers/lovable), [Agent SDK hosting](https://code.claude.com/docs/en/agent-sdk/hosting), [Agent SDK MCP / custom tools](https://code.claude.com/docs/en/agent-sdk/mcp), [Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview), [self-hosted sandboxes](https://platform.claude.com/docs/managed-agents/self-hosted-sandboxes), [effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), [harness design for long-running apps](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- Builders: [Lovable agent mode](https://lovable.dev/en/blog/agent-mode-beta), [Lovable browser testing](https://docs.lovable.dev/features/browser-testing), [Modal × Lovable](https://modal.com/blog/lovable-case-study), [Bolt v2](https://bolt.new/blog/introducing-bolt-v2), [Replit changelog](https://docs.replit.com/updates/2025/09/12/changelog), [Replit App Testing](https://docs.replit.com/features/agent/app-testing.md), [v0 agent post](https://vercel.com/blog/how-we-made-v0-an-effective-coding-agent), [leaked prompts (unofficial)](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools)
- Harnesses: [AI SDK 7](https://vercel.com/blog/ai-sdk-7), [AI SDK agents](https://ai-sdk.dev/docs/agents/overview), [pi-mono](https://github.com/badlogic/pi-mono), [deepagents backends](https://docs.langchain.com/oss/javascript/deepagents/backends), [Mastra workspaces](https://mastra.ai/docs/workspace/overview), [open-agents](https://github.com/vercel-labs/open-agents), [Chef](https://github.com/get-convex/chef), [Dyad tool calling](https://dyad.sh/blog/ai-agent-tool-calling-electron), [Roo shutdown](https://blog.kilo.ai/thank-you-roo)

**Unverified:** where Bolt v2's agent executes its tools (server container or WebContainer); Macaly/Anything/Rork internals; `[L]` leaked prompts may be outdated. The claim that Agent SDK in-process tool handlers run in the host process (so they can await the relay) matches the SDK design but should be the first thing the bake-off proves.
