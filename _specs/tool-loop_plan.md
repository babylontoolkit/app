# Tool Loop — Lovable-style agent for the App Builder

**Goal.** The agent builds a game the way Lovable (and Claude Code) does:
- it writes files one tool call at a time, in a long loop;
- it checks its own work (`tsc` plus actually launching the game in the preview);
- it keeps going until that check passes.

The user watches it happen: short narration, a live activity list, a todo checklist, and the preview updating. The user never types "continue". The one reason a turn stops to ask is money: the per-turn credit ceiling.

**Scope:** every build turn uses the tool loop. That covers the three first-build phases, ordinary edits and fixes. Plan mode gets a restricted version that can only write `_specs/`.

**Source research:** `_specs/v2-harness_research.md`.

**Owner decisions (2026-09-30):**
- "make App Builder use tool loop like Lovable";
- "change the spec as you need";
- "not reliable to create the whole game — front end, artwork and game code — in one turn";
- "we need that Lovable AI feel".

---

## Codebase Analysis

**Mode:** Quick Plan (no spec file) in Heavy mode. I skipped the interview because the owner's messages and the research report answer the scope questions. Assumptions are listed at the end of this section. The plan was checked by one cold-context audit, and every gap it found is resolved below.

### What exists and is reused

**Relay** — `app/lib/.server/agent/mcp-relay.ts`
- `awaitClientToolResult(input: AwaitToolResultInput): Promise<ClientToolResult>` never rejects:
  - timeout → `{error:'The tool did not respond in time.'}`
  - abort → `{error:'The generation was stopped.'}`
- `deliverClientToolResult` is owner-checked.
- `cancelGenerationToolCalls(generationId)` runs in the proxy `finally` (~:3320).
- The registry is in-process, so this is single-instance only (already true for MCP and preview).

**Relay pattern to mirror** — `app/lib/.server/agent/preview-tools.ts`
- `createPreviewTools(ctx: PreviewToolContext)` (:175) defines `relay(...)` and tools whose `execute` relays.
- Args are `.optional()` and validated in `execute`, never with zod enums or required fields. This is the fail-loud rule: a zod violation kills a paid generation.
- Server-side result caps: `MAX_PREVIEW_RESULT_CHARS` 20,000 and `MAX_SCREENSHOT_BASE64` 400,000.
- `capture_game_screenshot` maps `{base64, mimeType, width, height, blank, note}` to image+text content with `experimental_toToolResultContent` (:254-275).

**Stream emit** — `app/routes/api.agent.ts:355-363`
```ts
generation.onPreviewToolCall((event) => {
  stream.writeData({ type: 'preview-tool-call', generationId: generation.generationId,
    toolCallId: event.toolCallId, method: event.method, params: (event.params ?? null) as any });
});
```
- The `agentMeta` annotation is written at :549. The handle's listeners are declared on the `GenerationHandle` interface (~proxy.ts:559) and exposed at :3380-3381.

**Delivery route** — `app/routes/api.agent.tool-result.ts`
- POST `{ generationId, toolCallId, result?, error? }` → `requireVerifiedUser` → `deliverClientToolResult`.
- There is no size cap at the route. Caps live in each tool, so the new tools cap on the server too.

**Client relay branch** — `app/components/chat/Chat.client.tsx:1159-1197`
- Deduped by the `handledToolCalls` ref (:1082).
- Runs `runPreviewToolCall` (`app/lib/preview/bridge.ts:313`), then POSTs the result.

**Preview bridge** — `app/lib/preview/bridge.ts`
- `evaluateInPreview(expr)` (:253), `readPreviewErrors(since = 0)` (:263), `capturePreviewScreenshot()` (:268), `isPreviewBridgeReady()` (:273), `notifyPreviewReloading()` (:190).
- `since` is a **millisecond timestamp** compared with `entry.at`. The error text is `PreviewErrorEntry.message` (`protocol.ts:72`).
- The `ready` flag is set false **only** by `notifyPreviewReloading()` or detach. An in-document `location.assign` therefore needs `notifyPreviewReloading()` first, or the ready poll returns immediately.
- An `evaluate` that navigates the document may never answer, because the document unloads. So a navigation must be scheduled with `setTimeout` inside the evaluated code and return immediately.
- The preview agent script is re-injected into every document.

**Play contract** — starter `src/babylon/system/platform.tsx:61`
- `NAV_STATE_STORE_KEY = "__bt_nav_state"` in sessionStorage holds `{ gameMode, sceneUrl?, … }`, and `/play` reads it.
- The scene probe `(await import('/src/babylon/globals')).default.GetScene()` is already in `evaluate_in_game`'s description (preview-tools.ts:189-192).
- The starter `build` script is `"tsc -b && vite build"`.

**Sandbox** — `app/lib/sandbox`
- Feature code gets the provider as `await sandbox` from `~/lib/sandbox`, a `Promise<SandboxProvider>`. See `workbench.ts:5` and `:805`.
- `fs.mkdir/writeFile/readFile` and `spawn(command, args?, {cwd?,env?}) → SandboxProcess{exit: Promise<number>, output: ReadableStream<string>, kill()}` (`types.ts:84`, `:347`).
- ⚠️ **Never** use `BoltShell.executeCommand` (`utils/shell.ts:497`). It sends Ctrl-C to the terminal that runs `npm run dev`.
- `awaitBuildExit` (`action-runner.ts:1074`) throws after 120 s of silent output. This plan does **not** use it: `runCommand` races its own timeout.

**Agent file write, legacy path** — `workbench.ts:803-836`
- Order: `#editorStore.updateFile`, `setSelectedFile`, `currentView`, `runner.runAction`, then `recordAgentWrite`.
- `#filesStore.recordAgentWrite(filePath, content)` (`files.ts:696`) is text-only and keys through `toSandboxStoreKey`.
- `toProjectRelativePath` lives in `~/lib/common/sandbox-paths`.
- `createFile`/`saveFile` schedule a persistence top-up. An agent write **must not** use them (CLAUDE.md, refresh-saved-copies rule).
- The local-disk mirror sees every sandbox write through `watchPaths`, so it needs no call.

**Checkpoint/settle** — `app/lib/persistence/workbench-settle.ts:20-30`
- It reads only artifact runner actions.
- Relayed writes are safe **only because the client finishes the FS write and `recordAgentWrite` BEFORE posting the tool result.** The server loop blocks on that result.

**Server file snapshot** — proxy.ts:1123-1139
- `projectFiles = contextFiles ?? {}` is the client FileMap, with full text bodies. The type is `FileMap` from `~/lib/.server/llm/constants`, the same one `file-tools.ts` uses.
- `read_file` (`createFileTools(context: FileToolContext)`) reads it, and it is stale after an in-turn write.

**Loop** — proxy.ts
- `startStream(kind: RequestKind, history, allowTools, toolsOverride?, modelOverride?)` (:2104-2318).
  - :2123 `const maxSteps = allowTools ? toolPolicy.maxSteps : 1;`
  - :2131 `const maxTokens = 64_000;`
  - `onStepFinish` (:2200-2285) reads `step.usage` and `extractStepCacheTokens` into `stepLog` entries `{ms, outTokens, inTokens, cacheRead, cacheWrite, tools, textChars, reasoningChars, prefix}`.
- `drain` (:2328-2393):
  - forwards `text-delta` and `reasoning`;
  - sniffs `ACTION_OPEN_TAG`;
  - **accumulates usage only after the `for await` loop** (:2386), so a stream that throws on abort contributes nothing;
  - sets the closure `let`s `finishReason` and `lastStepToolCalls`.
- The first call is at :2562. Provider retries run to ~:2715.
- Tools-OFF rescues: forced continuation (:2734-2757), unproductive rescue (:2799-2840), completeness pass (:2857-2887).
- In the `finally`:
  - `resolveOutcome({... wroteFiles: emittedAction, ...})` (:3001-3008);
  - the `finishReason` suffix composition (:3172-3174);
  - `settleGeneration` (:3017).
- `RequestKind` (`request-fingerprint.ts:70`) is a closed union.
- `fingerprint-wiring.spec.ts:82` and `:103` pin `const maxTokens = 64_000;` and a single `64_000` literal in proxy.ts.

**ai@4.3.16** — verified in `node_modules/ai/dist/index.d.ts`
- `streamText` has `maxSteps`, `onStepFinish` (awaited), `experimental_repairToolCall` and `toolCallStreaming`.
- It has **no `prepareStep`** and cannot change messages between steps.
- So caching the growing tool-loop tail needs a **fetch-level** `cache_control`. The fetch chains are built at:
  - `providers/anthropic.ts:226` — `thinkingFetch(mode, effort, model, refusalFallbackFetch(model, tapStopReasons(rateLimitFetch(...))))`
  - `kie.ts:248` — `thinkingFetch(mode, effort, model, kieFetch(rateLimitFetch(...)))`
  - `cometapi.ts:236` — `thinkingFetch(mode, effort, model, tapStopReasons(rateLimitFetch(...)))`
- The `getModelInstance` options type is declared inline in four places: `base-provider.ts:166`, `anthropic.ts:163`, `kie.ts:136`, `cometapi.ts:122`.

**Cache breakpoints**
- The system array's fullest turn uses **3** breakpoints: base :1242, manifest :1300, and carried references OR skills (:1360/:1366).
- `cache-breakpoints.spec.ts:190` pins "the spare is one", and the rolling tail uses exactly that spare.

**Credit gate** — proxy.ts:931
```ts
const gate = await checkCreditGate({ userId: user.id, byok: byok.allowed, context: request.context });
```
- `CreditGateResult` (`billing/gate.ts:32`) is:
  - `{mode:'byok'}`
  - `{mode:'unmetered', balance}`
  - `{mode:'credits', balance}`
- Pricing helpers: `rawCostUsd(usage, model, provider, context)` (`billing/rates.ts:966`), `creditsForRawCost(cost, config)` (:992), `getBillingConfigSafe(context)` (:921).
- Per-step usage uses `accumulateStepUsage(totals, steps, modelFamily)` and `emptyUsage()` (`agent/step-usage.ts:69`, `:90`). `GenerationUsage` has `promptTokens`, `completionTokens`, `totalTokens`, `cacheReadTokens` and `cacheCreationTokens`, and is family-aware. **Use it, never raw `step.usage`**: inclusive-cache families would double-count.

**Output cap**
- Model rows carry `maxCompletionTokens` (`providers/anthropic.ts:42` gives 128,000 for Sonnet 5 / Opus 5).
- Env-configured models are synthesised by `envModelInfo(name, provider, staticModels, alreadyAdded)` (`providers/env-models.ts:78`), which returns `undefined` when the name is already static.

**Budgets and policy**
- `budgets.ts` `resolveAgentBudgets(context)` folds `AGENT_MAX_*` env into the defaults and derives `creationToolRounds` / `maxToolRounds`.
- `tool-policy.ts` `toolPolicyForTurn(input): ToolPolicy {allowTools, toolset, allowsMedia, maxSteps}`.
- ⚠️ Discuss turns with `preloadedCount > 0 || isSlash` get `allowTools:false, maxSteps:1` (:290-293). That covers `/bt-plan` in Plan mode, which **must** get tools under the tool loop, or it cannot write its `_specs` file.

**Creation phases**
- `app/lib/agent/creation-plan.ts`:
  - `CreationPhaseId` (:57) and the `CreationPhase` shape (:59-112);
  - `CREATION_PHASES` (:163-287), declared order `['frontend','art','game','game-systems','verify']` (pinned in the spec at :34; the two-words / no-shared-word label test is at spec :53);
  - `RETIRED_PHASES` (:403) and `isTurnOutcomeState` (:487), which accepts only finished/rescued/incomplete;
  - `DEFAULT_CREATION_PHASES` (:311);
  - `creationPhaseNote` (:687-713).
- Client runner (`app/lib/chat/creation-plan-runner.ts`):
  - `CreationPauseReason = 'incomplete'|'error'|'unsettled'`;
  - `decideNextCreationTurn` (:203; it pauses on `lastOutcome === 'incomplete'`, which Chat always passes as `null`);
  - `MAX_CREATION_PHASE_RETRIES` (:148).
- `Chat.client.tsx` `onFinish` (:860-957) sets `setPhasePause('incomplete')` on an incomplete outcome, and otherwise settles, advances and arms.
- The run effect (:1306-1359) calls `append({role:'user', content: creationPhaseMessage(plan, i)}, {body:{...liveTurnBody(), creationPhase: phase}})`.

**Outcome** — `app/lib/agent/turn-outcome.ts`
- `TurnOutcomeState` (:52), `describeTurnOutcome(facts)`, `FINISH_BUILD_MESSAGE` (:95).
- `app/components/chat/TurnOutcomeAlert.tsx` hardcodes the "Finish the build" button and styles only `incomplete`.

**Plan-mode follow-ups** — `app/lib/chat/plan-proposal.ts`
- `shouldOfferBuildAndApply(annotations, content)` (:73) and `planArtifactToExecute(content)` (:93), used by `decidePlanFollowUp(annotations, content)` (:146) in `AssistantMessage.tsx:110`.
- Both detect writes from message **text** (`<boltAction>`), so tool writes are invisible to them.

**Prompt**
- Baked sections in `app/lib/.server/prompt/sections/` are assembled by `prompt/build.ts` `assemblePrompt`.
- **A section edit takes effect only after deploy plus a prompt refresh**: `POST /api/admin/prompt {action:'refresh'}` (`api.admin.prompt.ts:148`), then `{action:'activate', versionId}` if refresh did not activate it.
- The volatile-tail notes (phase / discuss / media) are code and take effect on deploy.
- Partial-delivery priming to remove:
  - `20-hard-constraints.md:234-244`;
  - `creation-plan.ts:694-713`;
  - `creation-completion.ts:116-141`;
  - rule 12 of `10-action-protocol.md` (:97).
- Stale pointers to a "Current Project Files" section that no longer exists:
  - `llm/history.ts:83`, duplicated in `request-invariants.spec.ts:52`;
  - `agent/tools.ts:195`;
  - `sections/25-project-spec.md:8`, pinned by `doc-sync.spec.ts:621`.

**Plan mode**
- Read-only, with `_specs/**` as its one write door (`isPlanArtifactPath`, `app/lib/chat/plan-artifacts.ts:39`).
- **A tool write bypasses today's client-side wall, so `write_file` enforces `isPlanArtifactPath` on the server.**

### Answer to the owner's question: is frontend → art → game the best order?

No, not once there is a tool loop.

**Why the old order existed.** It was a truncation hedge: build the bounded front end first "because whatever runs LAST gets cut off", then art, patching paths into files already written. That left Vite red, importing art that did not exist yet.

**What changes with tool writes and a done-gate.** Nothing gets cut off, so the order can follow risk and dependency instead.

**New order:**
1. **Art direction.** Write the game design (`SPEC.md`), the visual design (`DESIGN.md`) and the todo list, and **enqueue every render**. Renders are async (~25-40 s each), so they land while the game is being coded.
2. **Game code.** The game is the product and the riskiest part. It is built while context and budget are freshest, and must pass `check_game`.
3. **Front end.** The landing page and chrome come last. They use art that has already landed and link to real game modes.

**Why this fails better.** If anything stops early, the user has a playable game behind the stock landing page, instead of a pretty page over a broken game.

**Phases stay separate turns** (owner: "not reliable … in one turn"). Each phase is a full tool loop with its own done-gate, and the next one **auto-starts**.

### SPEC conformance

This plan **deliberately changes** SPEC.md, as the owner authorised on 2026-09-30:
- §4.2 steps 2-4, and "Agent architecture stance (do not re-architect)";
- §4.2.1 "in-flight generations are never killed for balance". A tool-loop turn now **pauses at a step boundary** when it reaches its ceiling (never mid-stream), and every file written so far is kept;
- §4.2.8's step-cap philosophy;
- §4.2.9 Plan mode's wall;
- §4.4a L635/L639, the phase order.

T11 writes the text. Unchanged:
- the two walls;
- the ledger (settlement still never refuses);
- the shell allow-list;
- no server-side execution of user code (tools execute in the user's sandbox);
- binary rules;
- the sandbox seam.

- **spec_impact:** yes.
- **size:** large (inferred).
- **proof:** functional.

### Test baseline

Commands: `pnpm test` (`vitest --run`), `pnpm typecheck`, `pnpm lint`.

Current state: **unknown**, because the planning pass ran nothing. T1 step 0 runs the baseline and records any pre-existing failures. The bar throughout is "no new failures versus the baseline".

Client specs that import `workbenchStore` must `vi.mock('~/lib/stores/workbench')`, `vi.mock('~/lib/sandbox')` and `vi.mock('~/lib/preview/bridge')`, because importing the real store boots a sandbox.

### What keeps the app working between tasks

The tool loop sits behind `AGENT_TOOL_LOOP` (D2), **default `false` until T10**. With the flag off, behaviour is today's, **except** four deliberate both-mode changes:
- `maxTokens` = the model's real output cap (D14, T4);
- the removed priming text and the fixed stale pointers (T7);
- the new phase order and phase text (T8);
- one automatic continue of an unfinished phase (T8, D19).

The legacy artifact path is **kept** as a kill switch (D16).

### Quick Plan assumptions

- **(a)** Every build turn uses the tool loop.
- **(b)** The default per-turn ceiling is 2,500 credits. It is config (D9) and the owner may tune it.
- **(c)** `npx tsc -b` is expected to run under Nodepod. **Confirmed live (T1): `npx tsc -b --force --extendedDiagnostics` sees the project (~3.8 s) and catches a sentinel error. Never use `npx tsc -p` under Nodepod — its `npx` takes `-p` as `--package` and tsc then checks zero files. A run that counts zero lines of TypeScript reports `'unavailable'`.** If T1's live check shows it does not, or it takes more than 120 s, `check_game` reports `typecheck: 'unavailable'` and relies on the home + `/play` runtime check (D8). This fallback is decided now.
- **(d)** No new npm dependencies.
- **(e)** Unity-bridge, MCP and media tools are unchanged.

### Task count

11 tasks in 4 phases (large). The work spans the server loop, the client executor, prompts, the phase runner and the UI. Each task is one commit-sized unit.

---

## Decisions

- **D1 — With `AGENT_TOOL_LOOP` on, file changes are tool calls, never `<boltArtifact>` text.**
  - New tools: `write_file`, `edit_file`, `run_command`, `check_game`, `update_todos`, alongside the existing `read_file`.
  - Precedent: Lovable `lov-write`/`lov-line-replace`, Chef `edit`, Claude Code `Write`/`Edit`.
  - Rejected: keeping artifacts and raising the caps. One response would still hold the whole game, and nothing would verify it.
  - Binds: T2, T4, T5, T7.
- **D2 — One flag, `AGENT_TOOL_LOOP`.**
  - Resolved ONCE per request, immediately after the credit gate (proxy.ts, right after the `if (!gate.allowed) {…}` block at ~:937): `const loopCfg = resolveToolLoopConfig(request.context); const toolLoop = loopCfg.enabled;`
  - Everything later reads `toolLoop` / `loopCfg`.
  - `enabled` is `true` only when the env value is `'true'` until T10. After T10 it is `true` unless the value is `'false'`.
  - Rejected: a per-user flag. This is a platform kill switch.
  - Binds: T2–T10.
- **D3 — Claude Code-shaped tools.**
  - `write_file{file_path, content}`.
  - `edit_file{file_path, old_string, new_string, replace_all?}`.
  - `read_file` also accepts `file_path` as an alias of `path`.
  - Every argument is `.optional()` in zod and validated in `execute`; a bad argument returns a sentence.
  - Rejected: SEARCH/REPLACE blocks. It is a different grammar, and the model gets it wrong more often.
  - Binds: T2.
- **D4 — The server owns text contents during a turn.**
  - A `WorkspaceOverlay` sits over `projectFiles`.
  - `read_file` reads the overlay first (read-your-writes).
  - `edit_file` resolves on the server, then relays the resulting **full content** as a write.
  - `run_command` may return new `package.json` text, which updates the overlay.
  - The browser only ever performs full writes, commands and the check.
  - Rejected: relaying reads and edits. More round trips, and two places that can disagree.
  - Binds: T2, T4.
- **D5 — One data-part type, `workspace-tool-call`.**
  - The client executes it, then POSTs the result **only after completion**, and only after `writeAgentFile` resolves for writes.
  - Timeouts: write 30 s, run 300 s, check 180 s.
  - **Server-side result caps:**
    - run output tail 12,000 chars;
    - check errors: 30 entries × 300 chars;
    - check screenshot base64 ≤ `MAX_SCREENSHOT_BASE64`, imported from preview-tools; larger than that is dropped with a note.
  - Binds: T1, T2.
- **D6 — `workbenchStore.writeAgentFile(path, content)`.**
  - `const sb = await sandbox` (from `~/lib/sandbox`).
  - `rel = toProjectRelativePath(path)` (from `~/lib/common/sandbox-paths`).
  - Create the directory with `sb.fs.mkdir(dir, {recursive:true})` when `dir !== '.'`.
  - `sb.fs.writeFile(rel, content)`, then `this.#filesStore.recordAgentWrite(rel, content)`.
  - If the editor has that document open (`this.#editorStore.documents.get()[key]` exists, where `key = toSandboxStoreKey(rel, WORK_DIR)`), call `this.#editorStore.updateFile(key, content)`.
  - **No** `setSelectedFile` and **no** `currentView` switch: the preview stays in front, which is the Lovable feel.
  - Never `createFile`/`saveFile`/`refreshSavedCopiesSoon`.
  - Text only.
  - Binds: T1.
- **D7 — `runCommand` uses `sandbox.spawn`, never the shared terminal.**
  - The command must pass `isAllowedShellCommand` (`~/lib/runtime/shell-allowlist`, no imports, so server-safe too).
  - `npm run dev` and `npm run preview` are refused.
  - `&&` chains run as sequential segments and stop at the first non-zero exit.
  - Each segment:
    - is split on whitespace into argv and run as `sb.spawn(argv[0], argv.slice(1))`;
    - pipes output into a string;
    - resolves as `exitCode = await Promise.race([proc.exit, timeout])`. On timeout it calls `proc.kill()` and gives exit code 124.
  - Output is tail-capped to 12,000 chars.
  - After a segment whose argv[1] is `install|i|uninstall|remove|un`, the result carries the new `package.json` text.
  - Binds: T1, T2.
- **D8 — `check_game` is one relayed operation, `runGameCheck(params)`, with a fixed procedure.**
  1. **Typecheck.** Run `npx tsc -b` via the D7 segment runner with a 120 s timeout.
     - `ok = exitCode === 0`.
     - `errors` = output lines matching `/error TS\d+/`, first 30.
     - If the spawn throws or times out, `'unavailable'`.
  2. **Navigate** is a helper, `navigatePreview(path, navState?)`:
     - `notifyPreviewReloading()`;
     - `await evaluateInPreview(\`(()=>{ ${navState ? \`sessionStorage.setItem('__bt_nav_state', ${JSON.stringify(JSON.stringify(navState))});\` : ''} setTimeout(() => location.assign(${JSON.stringify(path)}), 50); return true; })()\`)`;
     - poll `isPreviewBridgeReady()` every 250 ms for up to 15 s.
     - An evaluate rejection is ignored when the ready poll then succeeds. It is an error only when the poll times out.
  3. **Home.** `startedAt = Date.now()`, `navigatePreview('/')`, wait 3 s, then `home.errors = (await readPreviewErrors(startedAt)).map(e => e.message)`.
  4. **Play** (only with `gameMode`):
     - `startedAt = Date.now()`, `navigatePreview('/play', {gameMode, ...(sceneUrl ? {sceneUrl} : {})})`, wait 8 s, collect errors the same way;
     - probe `(async () => { const s = (await import('/src/babylon/globals')).default.GetScene?.(); return { hasScene: !!s, meshes: s?.meshes?.length ?? 0, ready: s?.isReady?.() ?? false }; })()`;
     - `capturePreviewScreenshot()` gives `{base64, mimeType}`.
  5. **Restore**, in a `finally`: `navigatePreview(previousPath)`, where `previousPath = await evaluateInPreview('location.pathname')` was read at the start. If that read fails, the path is `'/'`.
  - `ok = typecheck === 'unavailable' || typecheck.ok` AND `home.errors.length === 0` AND (no `gameMode`, or (`play.errors.length === 0` and `play.hasScene`)).
  - If no preview is running (the first navigate throws "No preview is running"), call `requestPreviewReload()` and return `ok:false`, `home.errors = ['The preview is not running yet; the platform is restarting it — call check_game again in a moment.']`.
  - Rejected: `vite build` in the check. Too slow in the browser, and publish still runs it.
  - Binds: T1, T2.
- **D9 — Turns are bounded by a CREDIT CEILING, not a step cap.**
  - The ceiling is set by the gate mode:
    - `'credits'` → `Math.min(loopCfg.turnMaxCredits, Math.max(1, gate.balance))`;
    - `'unmetered'` → `loopCfg.turnMaxCredits`;
    - `'byok'` → no ceiling. The user pays their own provider, and no credits are spent.
  - Usage accumulates **per step inside `onStepFinish`** (tool-loop mode only), not after `drain`:
    - `accumulateStepUsage(loopTotals, [step], modelFamily)`;
    - `runningRawUsd = rawCostUsd(loopTotals, model, config.provider, request.context)`.
  - When `billing = getBillingConfigSafe(request.context)` is non-null and `creditsForRawCost(runningRawUsd, billing) >= ceiling`, set `budgetHit = true` and `loopController.abort('budget')`. The abort fires between steps, so the next step's request is aborted before any tokens are spent.
  - In tool-loop mode `drain` does **not** run its post-loop `accumulateStepUsage`, and `totals` is `loopTotals`. This closes the billing hole where an aborted segment settled for nothing.
  - Hitting the ceiling ends the turn **paused** with a **Keep building** action. Spending more is the user's call.
  - Binds: T4, T6.
- **D10 — A turn is SEGMENTS inside ONE generation: one stream, one settlement.**
  - A segment is one `startStream` with tools on, `maxSteps = loopCfg.segmentSteps` (default 40).
  - After each segment, the pure `decideNextSegment(facts, cfg)` chooses `done | continue | gate | stop`.
  - A compact carry is used when the last step's input tokens reach `compactAtTokens` (default 300,000).
  - Maximum segments: `maxSegments` (default 6).
  - This replaces the three tools-off rescues in tool-loop mode.
  - Rejected: one huge `maxSteps`. It has no compaction point and no gate.
  - Binds: T4.
  - **As built (T4):** a Plan (discuss) turn keeps its policy step cap (`maxToolRounds + 1`) instead of `segmentSteps`, and its `_specs/` writes do not count toward the done-gate's `wroteThisTurn` (Plan mode has no `check_game`); they still count as `wroteFiles` for the outcome. A `budget` / `segments` / `breaker` stop is never a failed turn and never refunds (`decideTurnEndVerdict`); a user Stop keeps today's rules.
- **D11 — Done-gate.**
  - A turn that wrote files (`overlay.writes.size > 0`) is done only when its last `check_game` came after its last write and returned `ok`.
  - Otherwise the loop runs a gate segment prompted by `GATE_PROMPT`.
  - Breaker: stop gating after `checkMaxNudges` (default 3) nudges, or after 3 consecutive failures with the same signature. The outcome is then `unverified`.
  - Answer-only turns are never gated.
  - Binds: T4, T6.
- **D12 — Compact carry.**
  - `[...system, ...coreMessages, {role:'user', content: carrySummary(summarizeWorkspace(overlay, wsState)) + '\n\n' + prompt}]`.
  - Binds: T4.
- **D13 — Rolling tail cache breakpoint.**
  - A pure `addTailCacheBreakpoint(body)` puts `cache_control:{type:'ephemeral'}` (5-minute tier) on the last eligible content block of the last message.
  - It applies only when the body has fewer than 4 `cache_control` markers.
  - `withTailCache(base, toolLoop)` returns `toolLoop ? tailCacheFetch(base) : base`, and it wraps the **argument passed to `thinkingFetch`**, i.e. the whole inner chain. It therefore sees `thinkingFetch`'s rewritten body, and runs before `refusalFallbackFetch` / `kieFetch` / `tapStopReasons`.
  - Non-JSON bodies pass through untouched.
  - Rejected: AI SDK 5 `prepareStep`. A major dependency change, and CLAUDE.md pins `@ai-sdk/anthropic ^1.2.12`.
  - Binds: T3.
- **D14 — `maxTokens` = the model's real output cap, in both modes.**
  - `resolveMaxOutputTokens(provider.staticModels, provider.name, model)` returns:
    - the `maxCompletionTokens` of `staticModels.find(m => m.name === model) ?? envModelInfo(model, provider.name, provider.staticModels, [])`, when it is > 0;
    - otherwise 64,000.
  - Binds: T4.
- **D15 — Toolsets and policy with `toolLoop` on.**
  - `creation` = read_file + workspace tools + preview tools + references + repair + (media if the phase `allowsMedia`).
  - `all` = today's + workspace tools.
  - `skills-only` (Plan) = today's + workspace tools built with `planOnly: true`. Only `write_file` (restricted to `_specs/`) and `update_todos` exist there.
  - Discuss turns always get `allowTools: true`, `maxSteps: budgets.maxToolRounds + 1`, **even when a skill is preloaded or it is a slash turn**. Otherwise `/bt-plan` cannot write its plan.
  - Build turns' `maxSteps` = `loopCfg.segmentSteps`, applied in `startStream`.
  - Read budgets use tool-loop defaults: 200 files, 2,000,000 chars, 12 references. These are passed as the base defaults into `resolveAgentBudgets(context, defaults?)`, so env still overrides and the derived invariants recompute.
  - Binds: T5.
- **D16 — Legacy paths are kept, not deleted.**
  - The artifact parser, action runner, rescues and old phase ids stay.
  - They serve the kill switch, old transcripts, folder imports (`folderImport` replays boltActions) and stored plans.
  - Binds: T4, T7, T8.
- **D17 — The protocol text lives in CODE.**
  - `WORKSPACE_PROTOCOL_TOOLS` and `WORKSPACE_PROTOCOL_ARTIFACT` are system messages inserted right after the base block, with no `providerOptions`. They are cached inside the manifest breakpoint's prefix, and they are constant per variant.
  - `10-action-protocol.md` becomes a pointer that keeps its heading (doc-sync rule).
  - The tools block states that it supersedes any other instruction to emit `<boltArtifact>`. That covers the window between deploy and the prompt refresh.
  - Binds: T7.
- **D18 — Creation phases become `['design','game','frontend']`.**
  - `design` is a new id, declared FIRST.
  - `art` stays declared and unscheduled, so stored plans still parse.
  - Labels: "Art direction", "Game code", "Front end".
  - `owesFiles`: `design` true, `game` false, `frontend` true.
  - Binds: T8.
- **D19 — Phase outcomes are decided by a pure `decidePhaseOutcomeAction(state, autoContinuesUsed)`:**
  - `finished` | `rescued` → `advance`;
  - `incomplete` | `unverified`, with `autoContinuesUsed < MAX_AUTO_CONTINUES` (1) → `auto-continue`. The same phase re-runs with `KEEP_BUILDING_MESSAGE`;
  - `incomplete` | `unverified` otherwise → `pause-incomplete`. The existing pause and alert show, and the alert's action posts the outcome's action message;
  - `paused` → `pause-budget`, a new `CreationPauseReason 'budget'`, with the alert.
  - This spends credits without the user asking, so it is a pure, tested function (CLAUDE.md rule).
  - Binds: T8.
- **D20 — The Lovable feel is data.** There are three client streams:
  - **(a) Activity rows.** `workspace-tool-call` parts, plus the client's own completion, become live rows: "Wrote …", "Ran …", "Checking your game…", then passed or problems, with a thumbnail.
  - **(b) Todo checklist.** `agent-todos` parts become a live checklist card.
  - **(c) Persisted summary.** An `agentWorkspace` annotation `{writes, commands, todos, lastCheck}` survives reload and feeds a one-line history summary for the next turn.
  - Keying:
    - the client store records the **current** generation id from the latest part it saw;
    - the streaming last assistant message renders the current generation's live state;
    - a finished message renders the live state when its `agentMeta.generationId` matches a stored entry, and otherwise renders the annotation (after a reload).
  - The prompt asks for one short sentence of narration before each group of tool calls.
  - Binds: T9, T7.
- **D21 — No new dependencies.** Binds: all.
- **D22 — Outcome facts gain `stopReason` and `lastCheckOk`.**
  - `stopReason: 'none'|'budget'|'segments'|'breaker'|'aborted'`.
  - `lastCheckOk: boolean | null`.
  - `wroteFiles = emittedAction || overlay.writes.size > 0`.
  - `TurnOutcomeState` gains `'paused' | 'unverified'`, and `isTurnOutcomeState` accepts them.
  - `TurnOutcome` gains `actionLabel: string | null`: "Finish the build" for legacy `incomplete`, "Keep building" for `paused` / `segments`, "Fix the errors" for `unverified`.
  - Messages, each defined once in `turn-outcome.ts`: `KEEP_BUILDING_MESSAGE` and `FIX_CHECK_MESSAGE`.
  - Binds: T6, T8, T9.

---

## Design Reference

### File map

| Path | Op | Responsibility | Tasks |
|---|---|---|---|
| `app/lib/agent/workspace-protocol-types.ts` | create | shared relay types + constants | T1, T2 |
| `app/lib/agent/string-edit.ts` (+ spec) | create | pure `applyStringEdit` | T2 |
| `app/lib/agent-workspace/executor.ts` (+ spec) | create | client `runWorkspaceToolCall`, `runCommand`, `runGameCheck`, `navigatePreview` | T1 |
| `app/lib/agent-workspace/activity.ts` (+ spec) | create | client activity/todo store + pure reducer | T9 |
| `app/lib/stores/workbench.ts` | modify | `writeAgentFile` | T1 |
| `app/components/chat/Chat.client.tsx` | modify | relay branch; todos; phase outcome actions | T1, T8, T9 |
| `app/lib/.server/agent/tool-loop.ts` (+ spec) | create | config, segment decision, carry, prompts, output cap | T2 (config), T4 |
| `app/lib/.server/agent/workspace-tools.ts` (+ spec, + `workspace-live-relay.spec.ts`) | create | overlay + tools | T2 |
| `app/lib/.server/agent/file-tools.ts` (+ spec) | modify | overlay-aware `read_file` | T2 |
| `app/lib/.server/agent/proxy.ts` | modify | config, tools, loop, ceiling, cap, protocol block, outcome, summary | T2, T3, T4, T5, T6, T7, T9 |
| `app/lib/.server/agent/request-fingerprint.ts` | modify | `RequestKind` += `'tool-loop-continue' \| 'tool-loop-gate'` | T4 |
| `app/lib/.server/agent/fingerprint-wiring.spec.ts` | modify | re-pin the `maxTokens` binding | T4 |
| `app/routes/api.agent.ts` | modify | emit parts; `agentWorkspace` annotation | T2, T9 |
| `app/lib/modules/llm/tail-cache.ts` (+ spec) | create | tail breakpoint + `withTailCache` | T3 |
| `app/lib/modules/llm/base-provider.ts`, `providers/{anthropic,kie,cometapi}.ts` | modify | `toolLoop?` option; compose `withTailCache` | T3 |
| `app/lib/.server/agent/tool-policy.ts`, `budgets.ts`, `discuss-note.ts` (+ specs) | modify | D15 | T5 |
| `app/lib/agent/turn-outcome.ts` (+ spec), `app/components/chat/TurnOutcomeAlert.tsx` | modify | D22 | T6 |
| `app/lib/agent/creation-plan.ts` (+ spec) | modify | phases, `isTurnOutcomeState`, note | T6, T8 |
| `app/lib/.server/agent/workspace-protocol.ts` (+ spec) | create | protocol constants | T7 |
| `app/lib/.server/prompt/sections/{10,20,25,30,40}-*.md` | modify | priming / stale / pointer / build order | T7 |
| `app/lib/.server/agent/creation-completion.ts`, `llm/history.ts`, `agent/tools.ts`, `request-invariants.spec.ts`, `doc-sync.spec.ts` | modify | priming + stale strings | T7 |
| `app/lib/chat/creation-plan-runner.ts` (+ spec) | modify | `decidePhaseOutcomeAction`, `'budget'` pause | T8 |
| `app/components/chat/WorkspaceActivity.tsx`, `AssistantMessage.tsx` | create / modify | activity + checklist UI | T9 |
| `app/lib/chat/plan-proposal.ts` (+ spec) | modify | tool-mode follow-ups | T9 |
| `.env.example` | modify | document the `AGENT_*` vars | T4, T10 |
| `SPEC.md`, `CLAUDE.md` | modify | T11 text | T11 |

### Interfaces & contracts

```ts
// app/lib/agent/workspace-protocol-types.ts  (client-safe: no secrets, no server imports)
export type WorkspaceOp = 'write' | 'run' | 'check';
export interface WorkspaceWriteParams { path: string; content: string }           // project-relative
export interface WorkspaceRunParams { command: string }
export interface WorkspaceCheckParams { gameMode?: string; sceneUrl?: string }
export interface WorkspaceToolCallPart {
  type: 'workspace-tool-call';
  generationId: string;
  toolCallId: string;
  op: WorkspaceOp;
  params: WorkspaceWriteParams | WorkspaceRunParams | WorkspaceCheckParams;
}
export interface WorkspaceWriteResult { ok: true }
export interface WorkspaceRunResult { exitCode: number; output: string; packageJson?: string }
export interface GameCheckResult {
  ok: boolean;
  typecheck: { ok: boolean; errors: string[] } | 'unavailable';
  home: { errors: string[] };
  play: { errors: string[]; hasScene: boolean; meshes: number; ready: boolean } | null;
  screenshot: { base64: string; mimeType: string } | null;
}
export interface TodoItem { content: string; status: 'pending' | 'in_progress' | 'completed' }
export interface AgentTodosPart { type: 'agent-todos'; generationId: string; items: TodoItem[] }
export interface AgentWorkspaceSummary {
  writes: string[];                                     // first-write order, unique
  commands: Array<{ command: string; exitCode: number }>;
  todos: TodoItem[];
  lastCheck: { ok: boolean; errors: string[] } | null;  // ≤10 errors × 300 chars
}
export const WORKSPACE_WRITE_TIMEOUT_MS = 30_000;
export const WORKSPACE_RUN_TIMEOUT_MS = 300_000;
export const WORKSPACE_CHECK_TIMEOUT_MS = 180_000;
export const RUN_OUTPUT_TAIL_CHARS = 12_000;
export const CHECK_MAX_ERRORS = 30;
export const CHECK_ERROR_MAX_CHARS = 300;
export const TYPECHECK_TIMEOUT_MS = 120_000;
export const PLAY_SETTLE_MS = 8_000;
export const HOME_SETTLE_MS = 3_000;
export const PREVIEW_NAV_READY_MS = 15_000;
export const NAV_STATE_STORE_KEY = '__bt_nav_state';   // mirrors starter src/babylon/system/platform.tsx:61
export const DISALLOWED_RUN_SCRIPTS = ['dev', 'preview'] as const;
```

```ts
// app/lib/agent/string-edit.ts
export type StringEditResult = { ok: true; content: string; replacements: number } | { ok: false; error: string };
export function applyStringEdit(source: string, input: { old_string: string; new_string: string; replace_all?: boolean }): StringEditResult;
// old_string === ''           → error 'old_string is empty — use write_file to create or replace a whole file.'
// old_string === new_string   → error 'old_string and new_string are identical — nothing to change.'
// 0 occurrences               → error 'old_string was not found in the file. Re-read it with read_file and copy the text exactly, including whitespace.'
// n>1 && !replace_all         → error `old_string occurs ${n} times — add surrounding lines to make it unique, or pass replace_all: true.`
// else                        → replace first (or all) literally; CRLF not normalised.
```

```ts
// app/lib/.server/agent/workspace-tools.ts
import type { FileMap } from '~/lib/.server/llm/constants';
export class WorkspaceOverlay {
  constructor(base: FileMap);
  read(path: string): string | undefined;      // project-relative; overlay, then a base text file (resolveFile from file-tools); undefined if binary/missing
  write(path: string, content: string): void;  // also adds to writes (insertion-ordered Set) and ++lastWriteSeq
  readonly writes: Set<string>;
  lastWriteSeq: number;
}
export interface WorkspaceTurnState {
  commands: Array<{ command: string; exitCode: number }>;
  todos: TodoItem[];
  lastCheck: { ok: boolean; errors: string[]; afterWriteSeq: number } | null;
  checkFailureSignatures: string[];            // last 3
}
export interface WorkspaceToolContext {
  generationId: string;
  userId: string;
  abortSignal?: AbortSignal;
  emit: (part: { toolCallId: string; op: WorkspaceOp; params: WorkspaceToolCallPart['params'] }) => void;
  emitTodos: (items: TodoItem[]) => void;
  overlay: WorkspaceOverlay;
  state: WorkspaceTurnState;
  planOnly: boolean;
}
export function newWorkspaceTurnState(): WorkspaceTurnState;
export function createWorkspaceTools(ctx: WorkspaceToolContext): Record<string, ReturnType<typeof tool>>;
export function summarizeWorkspace(overlay: WorkspaceOverlay, state: WorkspaceTurnState): AgentWorkspaceSummary;
export function checkBreakerTripped(state: WorkspaceTurnState): boolean;   // 3 stored and all equal
```

```ts
// app/lib/.server/agent/tool-loop.ts
export interface ToolLoopConfig {
  enabled: boolean;          // AGENT_TOOL_LOOP
  segmentSteps: number;      // AGENT_SEGMENT_STEPS      default 40      floor 5
  maxSegments: number;       // AGENT_MAX_SEGMENTS       default 6       floor 1
  turnMaxCredits: number;    // AGENT_TURN_MAX_CREDITS   default 2500    floor 100
  checkMaxNudges: number;    // AGENT_CHECK_MAX_NUDGES   default 3       floor 0
  compactAtTokens: number;   // AGENT_COMPACT_AT_TOKENS  default 300000  floor 50000
}
export function resolveToolLoopConfig(context: unknown): ToolLoopConfig;   // env via `env(context, KEY)` from ~/lib/.server/env; non-numeric → default; below floor → floor
export type StopReason = 'none' | 'budget' | 'segments' | 'breaker' | 'aborted';
export interface SegmentFacts {
  aborted: boolean; budgetHit: boolean; finishReason: string; lastStepToolCalls: number; segmentsRun: number;
  wroteThisTurn: boolean; lastCheck: { ok: boolean; afterWriteSeq: number } | null; lastWriteSeq: number;
  nudgesUsed: number; breakerTripped: boolean; lastStepInputTokens: number;
}
export type SegmentDecision =
  | { kind: 'done' }
  | { kind: 'continue'; compact: boolean }
  | { kind: 'gate'; compact: boolean }
  | { kind: 'stop'; reason: Exclude<StopReason, 'none'> };
export function decideNextSegment(f: SegmentFacts, cfg: ToolLoopConfig): SegmentDecision;
export function carrySummary(s: AgentWorkspaceSummary): string;
export const GATE_PROMPT: string;
export const CONTINUE_PROMPT: string;
export function resolveMaxOutputTokens(staticModels: readonly ModelInfo[], providerName: string, model: string): number;
```

```ts
// app/lib/modules/llm/tail-cache.ts
export function countCacheControls(body: unknown): number;
export function addTailCacheBreakpoint(body: Record<string, unknown>): Record<string, unknown>;   // pure, new object
export function tailCacheFetch(baseFetch: typeof fetch): typeof fetch;
export function withTailCache(baseFetch: typeof fetch, toolLoop: boolean | undefined): typeof fetch; // identity when !toolLoop
```

```ts
// app/lib/agent-workspace/executor.ts (client)
export async function runWorkspaceToolCall(part: WorkspaceToolCallPart): Promise<{ result?: unknown; error?: string }>;
export async function runCommand(command: string, timeoutMs: number): Promise<WorkspaceRunResult>;
export async function navigatePreview(path: string, navState?: Record<string, unknown>): Promise<void>;
export async function runGameCheck(params: WorkspaceCheckParams): Promise<GameCheckResult>;
// dev only: if (import.meta.env.DEV && typeof window !== 'undefined') (window as any).__btWorkspace = { runGameCheck, runCommand };
```

```ts
// app/lib/chat/creation-plan-runner.ts
export type CreationPauseReason = 'incomplete' | 'error' | 'unsettled' | 'budget';
export const MAX_AUTO_CONTINUES = 1;
export type PhaseOutcomeAction = 'advance' | 'auto-continue' | 'pause-incomplete' | 'pause-budget';
export function decidePhaseOutcomeAction(state: TurnOutcomeState | undefined, autoContinuesUsed: number): PhaseOutcomeAction;
```

```ts
// app/lib/agent/turn-outcome.ts additions
export type TurnOutcomeState = 'finished' | 'rescued' | 'incomplete' | 'paused' | 'unverified';
export const KEEP_BUILDING_MESSAGE =
  'Continue building from where you stopped. Re-read the files you already wrote with read_file, finish the remaining work on your todo list, then run check_game until it passes.';
export const FIX_CHECK_MESSAGE =
  'Run check_game, read every error it reports, and fix them. Keep going until check_game passes.';
// TurnOutcome gains: actionLabel: string | null
```

### Control flow — a build turn with `toolLoop` on (proxy.ts)

```
after the credit gate (~:937):
  loopCfg = resolveToolLoopConfig(ctx); toolLoop = loopCfg.enabled
  loopController = new AbortController(); request.abortSignal?.addEventListener('abort', () => loopController.abort('user'))
  turnSignal = toolLoop ? loopController.signal : request.abortSignal     // used by EVERY tool context + startStream below
  ceiling = D9
tool contexts (MCP ~:1405, preview ~:1435, media, bridge ~:1545, workspace): abortSignal: turnSignal
overlay = new WorkspaceOverlay(projectFiles); wsState = newWorkspaceTurnState(); fileToolContext.overlay = overlay
startStream: maxSteps = allowTools ? (toolLoop ? loopCfg.segmentSteps : toolPolicy.maxSteps) : 1
             maxTokens = resolveMaxOutputTokens(provider.staticModels, provider.name, model)
             abortSignal: turnSignal
             onStepFinish (toolLoop): accumulateStepUsage(loopTotals, [step], family); ceiling check → budgetHit / abort('budget')
messages = [...system, ...coreMessages]; kind = 'first'; segmentsRun = 0; nudgesUsed = 0
loop:
  seg = startStream(kind, messages, true)       // provider-retry wrapper only when segmentsRun === 0
  try { yield* drain(seg) } catch (e) { if (!(budgetHit && loopController.signal.aborted)) throw e }
  segmentsRun++
  facts = { aborted: request.abortSignal?.aborted ?? false, budgetHit, finishReason, lastStepToolCalls, segmentsRun,
            wroteThisTurn: overlay.writes.size > 0, lastCheck: wsState.lastCheck, lastWriteSeq: overlay.lastWriteSeq,
            nudgesUsed, breakerTripped: checkBreakerTripped(wsState),
            lastStepInputTokens: last stepLog entry's inTokens + cacheRead + cacheWrite (0 if none) }
  d = decideNextSegment(facts, loopCfg)
  done → break;  stop → stopReason = d.reason; break
  continue|gate:
     prompt = gate ? GATE_PROMPT : CONTINUE_PROMPT; if gate nudgesUsed++
     kind = gate ? 'tool-loop-gate' : 'tool-loop-continue'
     messages = d.compact
        ? [...system, ...coreMessages, { role:'user', content: carrySummary(summarizeWorkspace(overlay, wsState)) + '\n\n' + prompt }]
        : [...messages, ...stripReplayedReasoning((await seg.response).messages), { role:'user', content: prompt }]
  (on a budget abort, `seg.response` is not awaited — the loop stops)
totals = loopTotals (toolLoop) — drain skips its post-loop accumulate when toolLoop
finally: resolveOutcome({... wroteFiles: emittedAction || overlay.writes.size > 0, stopReason, lastCheckOk: wsState.lastCheck?.ok ?? null })
         finishReason suffix (:3172): + (toolLoop ? `+segments:${segmentsRun}` + (stopReason !== 'none' ? `+${stopReason}` : '') + (nudgesUsed ? `+gate:${nudgesUsed}` : '') : '')
toolLoop off → today's code path.
```

### Algorithms & constants

`decideNextSegment(f, cfg)`, evaluated in order:
1. `f.aborted` → `stop 'aborted'`.
2. `f.budgetHit` → `stop 'budget'`.
3. `compact = f.lastStepInputTokens >= cfg.compactAtTokens`.
4. If `f.finishReason === 'tool-calls' && f.lastStepToolCalls > 0`:
   - `f.segmentsRun >= cfg.maxSegments` → `stop 'segments'`;
   - otherwise → `continue {compact}`.
5. `verified = f.lastCheck?.ok === true && f.lastCheck.afterWriteSeq === f.lastWriteSeq`.
6. If `f.wroteThisTurn && !verified`:
   - `f.breakerTripped || f.nudgesUsed >= cfg.checkMaxNudges` → `stop 'breaker'`;
   - `f.segmentsRun >= cfg.maxSegments` → `stop 'segments'`;
   - otherwise → `gate {compact}`.
7. Otherwise → `done`.

**Failure signature:** `errors.join('\n').slice(0, 200)`, pushed on each failed check. Keep the last 3.

**`GATE_PROMPT`** (exact):
> "You changed files in this project but have not verified them. Call `check_game` now (pass the `gameMode` of the GameMode you built). If it reports errors, fix them and call `check_game` again. Do not end your turn until `check_game` returns ok. If you believe an error is outside your control, say so in one sentence and name the file and line."

**`CONTINUE_PROMPT`** (exact):
> "Continue working through your todo list from where you stopped. Re-read any file with `read_file` before editing it. When everything is built, run `check_game` and finish."

**`carrySummary`** (exact format):
```
## Progress so far this turn
Files written: <comma-separated paths, or "none">
Commands run: <"npm install x (exit 0)", …, or "none">
Todo list:
- [x] done item
- [ ] pending item
Last check: <"passed" | "failed:\n<errors, one per line>" | "not run yet">
```

**`addTailCacheBreakpoint(body)`**
- Return `body` unchanged when `!Array.isArray(body.messages)`, or `messages` is empty, or `countCacheControls(body) >= 4`.
- Otherwise:
  1. Clone.
  2. Take the last message. If its `content` is a string, convert it to `[{type:'text', text}]`.
  3. Walk its blocks from the end and pick the first whose `type` is not `thinking` or `redacted_thinking`.
  4. Set `cache_control = {type:'ephemeral'}` on it. If none is eligible, return unchanged.

**`countCacheControls`** counts `cache_control` keys in `system[]`, `tools[]` and each `messages[].content[]` block.

**Typecheck error lines:** lines matching `/error TS\d+/`, first 30, each sliced to 300 chars.

### Error & edge-case policy

**`write_file`**
- Path escaping the project (`..`, or absolute outside WORK_DIR after `toProjectRelativePath`) → refused.
- `isBinaryPath(path)` (from `~/lib/binary/binary-files`) → refused with "binary files come from the media tools".
- `package-lock.json` → refused.
- Read-only zones `src/babylon/classes/**`, `src/babylon/system/**`, `src/routing/**`, `src/app.tsx` → refused, naming the zone.
- `planOnly` and not `isPlanArtifactPath` → `"Plan mode is read-only. Only files under _specs/ can be written."`

**`edit_file`**
- Missing file → `"<path> does not exist — create it with write_file."`
- The same zone, binary and planOnly rules apply.

**Relay `{error}`** (timeout, stopped, browser threw) → `"The workspace could not complete this: <error>"`. The overlay is **not** updated.

**`run_command`**
- Refused → `"That command is not allowed. Allowed: npm install <pkg>, npm uninstall <pkg>, npm run <script> (not dev or preview)."`
- `npm uninstall` is allowed only if `isAllowedShellCommand` allows it. Check in T1. If it does not, drop "uninstall" from this sentence, from D7 and from the protocol text.

**`check_game` with no preview** → per D8, `ok:false` with the restart sentence.

**Ceiling abort mid-tool-call** → the relay resolves `{error:'The generation was stopped.'}`. Settle for what was consumed; the outcome is `paused`.

**`tailCacheFetch`** on a non-string body or a JSON parse failure → passes through untouched.

**Duplicate `toolCallId` on the client** → ignored (shared `handledToolCalls`).

**Two check results for the same generation** → the later one wins in the store.

### Conventions to mirror (verbatim anchors)

The relay function, preview-tools.ts:
```ts
async function relay(ctx, toolCallId, abortSignal, method, params?) {
  ctx.emit({ toolCallId, method, params });
  const outcome = await awaitClientToolResult({
    generationId: ctx.generationId, toolCallId, userId: ctx.userId,
    abortSignal: abortSignal ?? ctx.abortSignal, timeoutMs: PREVIEW_TOOL_TIMEOUT_MS,
  });
  if (outcome.error) return `The preview could not answer: ${outcome.error}`;
  ...
}
```

The client branch, Chat.client.tsx:1159-1197:
```ts
if (handledToolCalls.current.has(previewCall.toolCallId)) { continue; }
handledToolCalls.current.add(previewCall.toolCallId);
void (async () => {
  let result: unknown; let error: string | undefined;
  try { result = await runPreviewToolCall(previewCall.method as never, previewCall.params); }
  catch (e) { error = (e as Error).message; }
  await fetch('/api/agent/tool-result', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ generationId: previewCall.generationId, toolCallId: previewCall.toolCallId, result, error }),
  }).catch(() => undefined);
})();
```

The fetch-wrapper safety, capabilities.ts `thinkingFetch`:
```ts
if (!init?.body || typeof init.body !== 'string' || ...) return baseFetch(input, init);
let body; try { body = JSON.parse(init.body); } catch { return baseFetch(input, init); }
... return baseFetch(input, { ...init, body: JSON.stringify(body) });
```

### Test strategy

- **Pure functions**, exhaustive specs:
  - `applyStringEdit`, `decideNextSegment`, `carrySummary`, `addTailCacheBreakpoint`, `withTailCache`;
  - `resolveMaxOutputTokens`, `resolveToolLoopConfig` (every `AGENT_*` var `vi.stubEnv`'d to undefined first, plus a control with values);
  - `decidePhaseOutcomeAction` and the activity reducer.
- **Server tools** use a fake `emit` + `deliverClientToolResult` (the preview-tools.spec pattern).
- **One live-relay spec** drives the REAL `streamText` with only the model mocked (the `mcp-live-relay.spec.ts` pattern).
- **Client specs** mock the workbench, sandbox and bridge modules.
- **Live checks:** T1 (Nodepod `tsc` + game check), T9 (the UI feel), T10 (two real builds).

---

## Tasks

### Phase 1 — The workspace channel

- [x] **T1** — Client workspace executor: agent writes, allow-listed commands and the game check, in Nodepod
  - Depends on: none
  - Files:
    - create: `app/lib/agent/workspace-protocol-types.ts`, `app/lib/agent-workspace/executor.ts`, `app/lib/agent-workspace/executor.spec.ts`
    - modify: `app/lib/stores/workbench.ts`, `app/components/chat/Chat.client.tsx`
  - Applies: D5, D6, D7, D8. Design Reference → types, executor, Error policy.
  - Steps:
    0. Run `pnpm typecheck && pnpm test`. Record any pre-existing failures in this task's report.
    1. Create `workspace-protocol-types.ts` exactly as specified.
    2. `workbench.ts`: add `async writeAgentFile(projectRelativePath: string, content: string): Promise<void>` per D6.
       - Import `toProjectRelativePath` and `toSandboxStoreKey` from `~/lib/common/sandbox-paths`, if not already imported.
       - Get the provider with `await sandbox` (the existing module import at workbench.ts:5).
       - Add a doc comment citing "agent write must NOT trigger a persistence top-up".
    3. `executor.ts`: implement `runCommand` (D7), `navigatePreview` and `runGameCheck` (D8), and `runWorkspaceToolCall`. The last one switches on `op`:
       - `write` → `writeAgentFile`, then `{result:{ok:true}}`;
       - `run` → `runCommand(command, WORKSPACE_RUN_TIMEOUT_MS)`;
       - `check` → `runGameCheck`;
       - a thrown error → `{error: message}`.
       - Add the DEV-only `window.__btWorkspace` hook.
       - Check whether `isAllowedShellCommand('npm uninstall x').allowed` is true, and apply the Error-policy rule on "uninstall".
    4. `Chat.client.tsx`, right after the `preview-tool-call` branch (after :1197): add a `workspace-tool-call` branch, a copy of the preview branch that calls `runWorkspaceToolCall(part)`.
       - The `fetch` POST happens after the awaited call.
       - Validate `part.toolCallId && part.generationId && part.op` like the preview branch validates `method`.
  - Do not:
    - use `BoltShell` / `awaitBuildExit`;
    - call `createFile`/`saveFile`/`setSelectedFile` for agent writes;
    - POST before the write resolves;
    - send binaries.
  - Tests (`executor.spec.ts`, with `vi.mock('~/lib/stores/workbench')`, `vi.mock('~/lib/sandbox')`, `vi.mock('~/lib/preview/bridge')`):
    - `write op awaits writeAgentFile before resolving` → the mock's resolution order is asserted.
    - `run refuses npm run dev` → returns `{error}` containing "not allowed".
    - `run executes && segments in order and stops at first non-zero` → the second spawn is not called when the first exits 1.
    - `run times out with exit 124 and kills` → `kill` called.
    - `run tail-caps output to 12000`.
    - `run returns packageJson after install`.
    - `check ok matrix` → each D8 condition flips `ok`.
    - `check restores previous path even when the play probe throws`.
    - `check with no preview returns the restart sentence and calls requestPreviewReload`.
  - Acceptance:
    - The unit tests pass.
    - **Live** (dev server, Nodepod, an existing starter project with its scaffolded `<Title>Mode`): in the browser console, run `await window.__btWorkspace.runGameCheck({ gameMode: '<that class>' })`. Within 180 s it returns:
      - `typecheck` with real `tsc` output, or `'unavailable'`. If unavailable, write the reason in the report and in this plan's assumption (c);
      - `home.errors` = `[]`;
      - `play.hasScene: true`;
      - a screenshot of a rendered scene;
      - the preview back on the page it started from.
    - Report the measured `tsc -b` wall time.
  - Verify: `pnpm vitest run app/lib/agent-workspace/executor.spec.ts` → all pass. `pnpm typecheck` → no new errors.
  - Verify level: live

- [x] **T2** — Server workspace tools over an overlay, relayed through the existing registry
  - Depends on: T1
  - Files:
    - create: `app/lib/agent/string-edit.ts` (+ `.spec.ts`), `app/lib/.server/agent/tool-loop.ts` (config only), `app/lib/.server/agent/workspace-tools.ts` (+ `workspace-tools.spec.ts`, `workspace-live-relay.spec.ts`)
    - modify: `app/lib/.server/agent/file-tools.ts` (+ spec), `app/lib/.server/agent/proxy.ts`, `app/routes/api.agent.ts`
  - Applies: D1, D2, D3, D4, D5, D7, D8, D15 (`planOnly`), D20(b).
  - Steps:
    1. `string-edit.ts`: `applyStringEdit` per its contract.
    2. `tool-loop.ts`: create the file with `ToolLoopConfig` and `resolveToolLoopConfig` only (the rest arrives in T4).
       - `enabled`: `env(context,'AGENT_TOOL_LOOP') === 'true'`.
       - Numbers: parse with `Number()`; non-finite → default; below floor → floor.
    3. `workspace-tools.ts`: implement per the interfaces.
       - Private relay: `relay(ctx, toolCallId, abortSignal, op, params, timeoutMs)`, with the same shape as preview-tools' `relay`.
       - `write_file`: validate per the Error policy, relay `write` (30 s), then `overlay.write` on success. Returns `"Wrote <path> (<n> lines)."`
       - `edit_file`: `overlay.read`, `applyStringEdit`, relay a `write` of the full content, `overlay.write`. Returns `"Edited <path> (<k> replacement(s))."`
       - `run_command`: validate, relay `run` (300 s), clip the output to 12,000, apply `packageJson` to `overlay.write('package.json', …)`, push to `state.commands`. Returns `` `exit ${code}\n${output}` ``.
       - `check_game`:
         - relay `check` (180 s);
         - cap errors (30 × 300) and the screenshot (`MAX_SCREENSHOT_BASE64` imported from `./preview-tools`; larger → dropped with a note);
         - `state.lastCheck = {ok, errors: [...typecheck.errors, ...home.errors, ...play.errors].slice(0, 30), afterWriteSeq: overlay.lastWriteSeq}`;
         - on `!ok`, push the failure signature (keep the last 3);
         - `execute` returns `{ verdict: string; screenshot?: {base64, mimeType} }`, where the verdict is `"check_game: PASSED"` or `"check_game: FAILED\n" + errors.join('\n')`, plus `"\nScene: hasScene=<b> meshes=<n> ready=<b>"` when `play` is non-null;
         - `experimental_toToolResultContent: (r) => r.screenshot ? [{type:'text', text: r.verdict}, {type:'image', data: r.screenshot.base64, mimeType: r.screenshot.mimeType}] : [{type:'text', text: r.verdict}]`.
       - `update_todos({items})`: keep items whose `content` is a non-empty string, and coerce an unknown `status` to `'pending'`. Set `state.todos`, call `emitTodos`, return `"Todo list updated (<done>/<total> complete)."`
       - `planOnly` → the returned record has only `write_file` and `update_todos`.
    4. `file-tools.ts`: `FileToolContext` gains `overlay?: WorkspaceOverlay`. `read_file` accepts `file_path`. When `overlay?.read(rel)` is defined, return it (budgets unchanged, re-reads free).
    5. `proxy.ts`:
       - insert the D2 lines right after the credit-gate block (~:937);
       - when `toolLoop`, create `overlay`/`wsState` beside `fileToolContext` (~:1784) and pass `overlay`;
       - add `workspaceListeners` and `todoListeners` + emitters like `previewListeners` (~:1435);
       - build `workspaceTools = toolLoop ? createWorkspaceTools({ generationId, userId: user.id, abortSignal: request.abortSignal, emit, emitTodos, overlay, state: wsState, planOnly: discussNote !== null }) : {}`. `request.abortSignal` becomes `turnSignal` in T4;
       - declare `onWorkspaceToolCall(listener)` and `onAgentTodos(listener)` on the `GenerationHandle` interface (~:559) and implement them next to `onPreviewToolCall` (~:3381).
       - Do not add the tools to any toolset yet (T5).
    6. `api.agent.ts`, after the preview listener (:363):
       - `generation.onWorkspaceToolCall((e) => stream.writeData({ type:'workspace-tool-call', generationId: generation.generationId, toolCallId: e.toolCallId, op: e.op, params: e.params as any }))`
       - `generation.onAgentTodos((items) => stream.writeData({ type:'agent-todos', generationId: generation.generationId, items: items as any }))`
  - Tests:
    - `string-edit.spec.ts`: each rule gives its exact error string; `replace_all` returns the count; a unique replace returns the new content.
    - `workspace-tools.spec.ts`: write relays and then updates the overlay; a failed relay leaves the overlay untouched; edit resolves on the server and relays the full content; edit not-found returns an error with zero emits; `planOnly` refuses `src/a.ts` and allows `_specs/x_plan.md`; zones refused (`src/babylon/system/a.ts`, `src/routing/x.tsx`); `run_command` refuses `npm run dev`; `run_command` applies `package.json` to the overlay; `check_game` sets `lastCheck` with `afterWriteSeq`; the screenshot cap drops an oversized image; `update_todos` emits the items and coerces status; `checkBreakerTripped` requires 3 equal signatures.
    - `file-tools.spec.ts`: `read_file` prefers the overlay; `file_path` alias works.
    - `workspace-live-relay.spec.ts`: the real `streamText`, with a mocked model that calls `write_file` then `read_file` on the same path. The data part is emitted while the step is parked, delivery resumes it, and step 2 reads the new content.
    - `tool-loop.spec.ts` (config part): defaults with all `AGENT_*` vars stubbed undefined; floors; `'true'` enables.
  - Acceptance: the named tests pass, and with `AGENT_TOOL_LOOP` unset the existing proxy specs have no new failures.
  - Verify: `pnpm vitest run app/lib/agent/string-edit.spec.ts app/lib/.server/agent/workspace-tools.spec.ts app/lib/.server/agent/workspace-live-relay.spec.ts app/lib/.server/agent/file-tools.spec.ts app/lib/.server/agent/tool-loop.spec.ts` → all pass.
  - Verify level: standard

- [x] **T3** — Rolling tail cache breakpoint at the fetch layer
  - Depends on: T2 (for `toolLoop` in the proxy)
  - Files:
    - create: `app/lib/modules/llm/tail-cache.ts` (+ `.spec.ts`)
    - modify: `app/lib/modules/llm/base-provider.ts`, `providers/anthropic.ts`, `providers/kie.ts`, `providers/cometapi.ts`, `app/lib/.server/agent/proxy.ts`
  - Applies: D13.
  - Steps:
    1. Implement the four functions per Algorithms.
    2. Add `toolLoop?: boolean` to the inline `getModelInstance` options type in all four files (`base-provider.ts:166`, `anthropic.ts:163`, `kie.ts:136`, `cometapi.ts:122`).
    3. In each provider, wrap the argument passed to `thinkingFetch` with `withTailCache(…, options.toolLoop)`:
       - anthropic.ts:226 → `thinkingFetch(mode, effort, model, withTailCache(refusalFallbackFetch(model, tapStopReasons(rateLimitFetch(...))), options.toolLoop))`;
       - kie.ts:248 and cometapi.ts:236 follow the same shape around their inner chain.
    4. `proxy.ts`: pass `toolLoop` in both `provider.getModelInstance({...})` calls (:1929, :2684).
  - Tests (`tail-cache.spec.ts`):
    - adds `cache_control` to the last text block;
    - string content becomes a block;
    - skipped when 4 markers are present;
    - skips a trailing thinking block and marks the previous block;
    - no messages → unchanged;
    - input not mutated;
    - `tailCacheFetch` passes non-JSON through (`baseFetch` receives the identical `init`);
    - `withTailCache(base, false) === base` and `withTailCache(base, undefined) === base`;
    - CONTROL: 3 system markers + tail → count is exactly 4.
  - Acceptance: the tests pass.
    - Optional live probe with the owner's gateway key, using the `scripts/cache-probe.mjs` style: two sequential requests sharing a growing tail. The second must report `cache_read_input_tokens > 0`.
    - If the probe cannot run here, the report says so.
  - Verify: `pnpm vitest run app/lib/modules/llm/tail-cache.spec.ts` → all pass.
  - Verify level: standard

### Phase 2 — The loop

- [x] **T4** — Segment runner, credit ceiling, done-gate, real output cap
  - Depends on: T2, T3
  - Files: `app/lib/.server/agent/tool-loop.ts` (+ spec), `app/lib/.server/agent/proxy.ts`, `app/lib/.server/agent/request-fingerprint.ts`, `app/lib/.server/agent/fingerprint-wiring.spec.ts`, `app/lib/.server/agent/workspace-live-relay.spec.ts`, `.env.example`
  - Applies: D2, D9, D10, D11, D12, D14. Design Reference → Control flow, Algorithms.
  - Steps:
    1. `tool-loop.ts`: add `decideNextSegment`, `carrySummary`, `GATE_PROMPT` and `CONTINUE_PROMPT` (verbatim), and `resolveMaxOutputTokens` (imports `envModelInfo` from `~/lib/modules/llm/providers/env-models` and `ModelInfo` from the modules types).
    2. `request-fingerprint.ts`: add `'tool-loop-continue' | 'tool-loop-gate'` to `RequestKind`.
    3. `proxy.ts` :2131: `const maxTokens = resolveMaxOutputTokens(provider.staticModels, provider.name, model);`
       - `fingerprint-wiring.spec.ts`: line 82 → `expect(body).toMatch(/const maxTokens = resolveMaxOutputTokens\(/)`;
       - line 103 → assert that `resolveMaxOutputTokens(` appears exactly once in proxy.ts.
    4. `proxy.ts`, per Control flow:
       - `loopController` and `turnSignal` created with the D2 lines;
       - replace `request.abortSignal` with `turnSignal` in the MCP/preview/bridge/workspace tool contexts and in `_streamText`'s `abortSignal`. When `toolLoop` is false, `turnSignal === request.abortSignal`, so nothing changes;
       - compute the ceiling from `gate`;
       - :2123 → `const maxSteps = allowTools ? (toolLoop ? loopCfg.segmentSteps : toolPolicy.maxSteps) : 1;`
       - `onStepFinish` gets the per-step accumulation and the ceiling check (toolLoop only, after the existing bookkeeping);
       - `drain` gets `if (!toolLoop) accumulateStepUsage(totals, …)` around its post-loop accumulation, and when `toolLoop` the settlement reads `loopTotals`;
       - replace the first-stream + rescue chain with the segment loop **inside `if (toolLoop) { … } else { <existing code unchanged> }`**. Keep the provider-retry wrapper for segment 1 only;
       - extend the outcome facts and the `finishReason` suffix (:3172) per Control flow.
    5. `.env.example`: add a commented block listing the six `AGENT_*` vars with their defaults.
  - Do not:
    - let settlement refuse or throw;
    - treat a budget abort as a user Stop;
    - run tools-off rescues in tool-loop mode;
    - hardcode the six numbers outside `resolveToolLoopConfig`.
  - Tests:
    - `tool-loop.spec.ts` covers every `decideNextSegment` branch in order:
      - aborted outranks budget;
      - budget outranks continue;
      - cap mid-loop → continue;
      - cap at `maxSegments` → stop segments;
      - unverified writes → gate;
      - verified, then a later write → gate;
      - breaker → stop breaker;
      - nudges exhausted → stop breaker;
      - no writes and the model ended → done;
      - compact at the threshold.
    - `tool-loop.spec.ts` also covers:
      - `carrySummary` exact output for a fixture;
      - `resolveMaxOutputTokens` → 128000 for a static row, 128000 for an env-synthesised id, 64000 fallback.
    - `workspace-live-relay.spec.ts` gains:
      - a mocked model that ends after a delivered `write_file` without `check_game` → the proxy's second segment's last user message equals `GATE_PROMPT`;
      - a mocked `onStepFinish` cost that crosses the ceiling → `budgetHit`, no further segment, and usage settled from `loopTotals` (> 0).
  - Acceptance: the tests pass, and `pnpm test` shows no new failures versus the baseline with `AGENT_TOOL_LOOP` unset.
  - Verify: `pnpm vitest run app/lib/.server/agent/tool-loop.spec.ts app/lib/.server/agent/workspace-live-relay.spec.ts app/lib/.server/agent/fingerprint-wiring.spec.ts` → all pass. `pnpm test` → no new failures.
  - Verify level: standard

- [x] **T5** — Toolsets, budgets and the Plan-mode wall
  - Depends on: T4
  - Files: `app/lib/.server/agent/tool-policy.ts` (+ spec), `budgets.ts` (+ `budgets.spec.ts`), `proxy.ts`, `discuss-note.ts` (+ spec)
  - Applies: D15.
  - Steps:
    1. `ToolPolicyInput` gains `toolLoop?: boolean`. When true:
       - a discuss turn → `{allowTools:true, toolset:'skills-only', allowsMedia:false, maxSteps: budgets.maxToolRounds + 1}` **regardless of `preloadedCount`/`isSlash`**;
       - first-build → the toolset stays `'creation'`, with `allowTools: true` and today's `maxSteps` formula unchanged (the proxy overrides it with `segmentSteps`);
       - ordinary → `'all'`, `allowTools: true`.
       
       When false, output is identical to today.
    2. `budgets.ts`:
       - add `export const TOOL_LOOP_BUDGET_DEFAULTS = { maxFileReads: 200, maxReadChars: 2_000_000, maxReferenceLoads: 12 }`;
       - `resolveAgentBudgets(context: unknown, defaults?: Partial<Pick<AgentBudgets,'maxFileReads'|'maxReadChars'|'maxReferenceLoads'>>)` uses `defaults` in place of the constants **before** env overrides and before deriving `creationToolRounds`/`maxToolRounds`;
       - the proxy calls it with `toolLoop ? TOOL_LOOP_BUDGET_DEFAULTS : undefined` at :1581.
    3. `proxy.ts` toolset assembly (~:1855-1908), when `toolLoop`:
       - `creation` → `{...fileTools, ...workspaceTools, ...previewTools, ...referenceTools, ...createRepairTool(), ...(toolPolicy.allowsMedia ? mediaTools : {})}`;
       - `all` → today's + `...workspaceTools`;
       - `skills-only` → today's + `...workspaceTools` (already `planOnly`).
       - Pass `toolLoop` into `toolPolicyForTurn`.
    4. `discuss-note.ts`: `discussModeNote({chatMode, toolLoop})`. When `toolLoop`, the `_specs` exception sentence reads: "ONE exception — planning artifacts: write files inside `_specs/` (for example `_specs/<name>_spec.md` or `_plan.md`) with the `write_file` tool. Writes anywhere else are refused." The proxy passes `toolLoop`.
  - Tests:
    - `tool-policy.spec.ts`: `toolLoop` first-build / ordinary / discuss; discuss with `preloadedCount: 2` still `allowTools: true`; all existing cases unchanged.
    - `budgets.spec.ts`: defaults are overridden by the parameter; env still overrides the parameter; derived rounds still satisfy the existing invariant tests.
    - `discuss-note.spec.ts`: the `toolLoop` wording names `write_file` and `_specs/`; the legacy wording is unchanged.
  - Acceptance: the tests pass.
  - Verify: `pnpm vitest run app/lib/.server/agent/tool-policy.spec.ts app/lib/.server/agent/budgets.spec.ts app/lib/.server/agent/discuss-note.spec.ts` → all pass.
  - Verify level: standard

- [x] **T6** — Outcomes, alert and refunds understand tool writes
  - Depends on: T4
  - Files: `app/lib/agent/turn-outcome.ts` (+ spec), `app/components/chat/TurnOutcomeAlert.tsx`, `app/lib/agent/creation-plan.ts` (only `isTurnOutcomeState`), `app/lib/.server/agent/proxy.ts`
  - Applies: D11, D22.
  - Steps:
    1. `turn-outcome.ts`:
       - extend `TurnOutcomeState`;
       - add `stopReason?` and `lastCheckOk?` to the facts;
       - add `actionLabel` to `TurnOutcome` (existing `incomplete` → `'Finish the build'`, `finished`/`rescued` → `null`);
       - export `KEEP_BUILDING_MESSAGE` and `FIX_CHECK_MESSAGE` (verbatim).
    2. `describeTurnOutcome`: after the `aborted` check and BEFORE `!isFirstBuildTurn`, insert:
       - `stopReason === 'budget'` → `{state:'paused', headline:'Paused at your credit limit for this turn', detail:'Everything built so far is saved in your project. Continue to keep building.', action: KEEP_BUILDING_MESSAGE, actionLabel:'Keep building'}`
       - `stopReason === 'breaker' || (wroteFiles && lastCheckOk === false)` → `{state:'unverified', headline:'Built, but the game check is still failing', detail:'The last check reported errors. The agent can keep fixing them.', action: FIX_CHECK_MESSAGE, actionLabel:'Fix the errors'}`
       - `stopReason === 'segments'` → `{state:'incomplete', headline:'This step ran long and stopped before finishing', detail:'Files written so far are saved.', action: KEEP_BUILDING_MESSAGE, actionLabel:'Keep building'}`
    3. `creation-plan.ts` `isTurnOutcomeState` (:487): accept `'paused'` and `'unverified'`.
    4. `TurnOutcomeAlert.tsx`:
       - the button text becomes `outcome.actionLabel ?? 'Finish the build'`;
       - it renders when `outcome.action`;
       - `paused` and `unverified` use the same styling and `role="alert"` as `incomplete`.
    5. `proxy.ts` `resolveOutcome` (:3001-3008): `wroteFiles: emittedAction || (overlay?.writes.size ?? 0) > 0`, `stopReason`, `lastCheckOk`. Also update the same `wroteFiles` expression wherever `owesFiles`/refund facts read `emittedAction` (~:2797-2887 legacy branch; the tool-loop branch passes the new expression).
  - Tests:
    - `turn-outcome.spec.ts`:
      - budget → paused, with `'Keep building'`;
      - breaker → unverified;
      - wrote + failed check → unverified;
      - segments → incomplete, with KEEP_BUILDING;
      - aborted still outranks budget;
      - existing tests unchanged, plus `incomplete` legacy `actionLabel === 'Finish the build'`.
    - `creation-plan.spec.ts`: `isTurnOutcomeState('unverified') === true`.
  - Acceptance: the tests pass.
  - Verify: `pnpm vitest run app/lib/agent/turn-outcome.spec.ts app/lib/agent/creation-plan.spec.ts` → all pass.
  - Verify level: standard

### Phase 3 — What the model is told, and the phase order

- [x] **T7** — Protocol block in code; remove every "run short / another pass" line and stale pointer
  - Depends on: T5
  - Files:
    - create: `app/lib/.server/agent/workspace-protocol.ts` (+ spec)
    - modify: `app/lib/.server/prompt/sections/10-action-protocol.md`, `20-hard-constraints.md`, `25-project-spec.md`, `30-self-healing.md`, `40-skill-usage.md`, `proxy.ts`, `creation-completion.ts`, `llm/history.ts`, `agent/tools.ts`, `request-invariants.spec.ts`, `doc-sync.spec.ts`, `history.spec.ts`
  - Applies: D16, D17, D20 (narration).
  - Steps:
    1. `workspace-protocol.ts`:
       - `WORKSPACE_PROTOCOL_ARTIFACT` = today's `10-action-protocol.md` body verbatim, with rule 12 (:97, "Be concise in prose…") **removed** and the list renumbered.
       - `WORKSPACE_PROTOCOL_TOOLS` = the text under Code below.
    2. `10-action-protocol.md`: the whole body becomes:
       ```
       # How You Change Files

       The Workspace Protocol block that follows this prompt is authoritative for how you create, edit and verify files.
       ```
    3. `proxy.ts` (:1242): immediately after the base system block is created, `system.push({ role: 'system', content: toolLoop ? WORKSPACE_PROTOCOL_TOOLS : WORKSPACE_PROTOCOL_ARTIFACT })`, with **no** `providerOptions`.
    4. `20-hard-constraints.md`: replace the whole `## BUILD ORDER` section (L223 through the line before the next `##` heading) with the replacement below. Do not touch the adjacent sections, which hold the pinned phrases `FIRST BUILT OUT`, `leave the landing page alone`, `narrow request`, `src/chrome/**`, `splash.tsx`, `loading.tsx` and `overlay.tsx`. If `narrow request` was only in BUILD ORDER, the replacement keeps it ("On a NARROW request").
    5. `30-self-healing.md`:
       - replace the sentence that begins "Emit a normal `<boltArtifact>` with the fix" (through the end of that sentence) with "Fix it with the same tools you build with (`edit_file`, or a `<boltArtifact>` if the workspace tools are not offered), then verify with `check_game`.";
       - delete the sentence containing "do not thrash".
    6. `40-skill-usage.md`: delete the two bullets starting "**At most ONE skill per generation.**" and "**Never load a skill on a first-build turn.**" (L23-27).
    7. `creation-completion.ts`: in `CREATION_COMPLETION_PROMPT`, delete the sentence starting "Close the turn as the brief asks" through the end of the string.
    8. Stale pointers:
       - `history.ts:83` → `const OMITTED = '\n[body omitted — read the file with read_file for its current contents]\n';`, and update the duplicated literal in `request-invariants.spec.ts:52` and any `history.spec.ts` assertion of the old text;
       - `tools.ts:195` → replace "there is no tool to read more of them" with "use read_file to read any other file";
       - `25-project-spec.md:8` → replace the phrase naming "Current Project Files" with "the project file list (read any file with `read_file`)", and update the pinned expectation at `doc-sync.spec.ts:621` to the new phrase.
  - Code:
    - `WORKSPACE_PROTOCOL_TOOLS` (verbatim):
      ```
      # Workspace Protocol — how you build

      You work like a senior engineer with a live workspace. You change the project ONLY with your tools — never by writing <boltArtifact> or <boltAction> markup (this supersedes any instruction elsewhere in this prompt to use it):

      - `read_file` — read any project file. Always read a file before you edit it.
      - `write_file` — create a file or replace one completely. Give the COMPLETE contents, never placeholders.
      - `edit_file` — change part of an existing file: `old_string` must match the file exactly (copy it from read_file) and be unique; use `replace_all` to change every occurrence.
      - `run_command` — `npm install <pkg>`, `npm uninstall <pkg>`, `npm run <script>`. The dev server is already running; never start it.
      - `check_game` — typechecks the project, loads the landing page, and launches your game in the live preview (pass `gameMode`, the registered GameMode class name). It returns errors and a screenshot. It is your definition of done.
      - `update_todos` — your visible checklist. Write it at the start of any multi-step task and update it as you finish each item.

      How to work:
      1. Plan: write your todo list first.
      2. Before each group of tool calls, write ONE short sentence telling the user what you are about to do ("Now I'll build the kart controller."). No other narration.
      3. Build in small files: one Script Component per behaviour. Write several files in parallel when they do not depend on each other.
      4. Verify: after your changes, call `check_game`. If it fails, read the errors, fix them, and run it again. Keep going until it passes.
      5. Finish with 2–4 sentences: what you built and how to play it. Never say you "need another pass" — if something is not done, keep working on it.

      Binary files (images, audio, models) are never written by you; use the media tools, which return the path to reference. Never write lockfiles.
      ```
      (Drop "`npm uninstall <pkg>`, " if T1 found that uninstall is not allow-listed.)
    - BUILD ORDER replacement (verbatim):
      ```
      ## BUILD ORDER — design, then the game, then the front end

      A first build runs in three steps, each its own turn: **Art direction** (the game design in `SPEC.md`, the visual design in `DESIGN.md`, and every piece of art rendered), **Game code** (the playable game in `src/scripts/**`, verified with `check_game`), and **Front end** (the landing page and the game chrome, using the art that has already been rendered, verified with `check_game`). The game is built before the front end because the game is the product: the front end then links to modes that really exist and shows art that is really there.

      **This order works because the GameMode class already exists.** Read its real class name off `src/scripts/` — never invent one.

      **On a NARROW request** — one change to one thing — none of this applies: do exactly what was asked, verify it, and stop.
      ```
  - Do not:
    - add `providerOptions` to the protocol block (it would spend the tail breakpoint's spare, D13);
    - delete any section file.
  - Tests:
    - `workspace-protocol.spec.ts`:
      - the tools protocol names all six tools;
      - neither protocol contains `one prompt from done` or `Be concise in prose`;
      - the artifact protocol still documents `<boltArtifact>`;
      - a scan that `20-hard-constraints.md` contains no `one prompt from done` and no `hard length limit`;
      - a proxy-shape spec (or an extension of `cache-breakpoints.spec.ts`) asserting that the protocol block has no `providerOptions`.
    - Existing, no new failures: `doc-sync.spec.ts`, `no-prompt-classifier.spec.ts`, `chrome-zone.spec.ts`, `cache-breakpoints.spec.ts`, `history.spec.ts`, `request-invariants.spec.ts`.
  - Acceptance:
    - The tests pass.
    - `rg -n "one prompt from done|hard length limit" app/` finds nothing.
    - `rg -n "Current Project Files" app/lib/.server` finds nothing outside comments.
  - Verify: `pnpm vitest run app/lib/.server/agent/workspace-protocol.spec.ts app/lib/.server/prompt app/lib/.server/llm/history.spec.ts` → all pass.
  - Verify level: standard

- [x] **T8** — Phases become Art direction → Game code → Front end, and an unfinished phase auto-continues once
  - Depends on: T6, T7
  - Files: `app/lib/agent/creation-plan.ts` (+ spec), `app/lib/chat/creation-plan-runner.ts` (+ spec), `app/components/chat/Chat.client.tsx`
  - Applies: D18, D19, D22.
  - Steps:
    1. `creation-plan.ts`:
       - `CreationPhaseId` adds `'design'`;
       - insert the `design` phase object FIRST in `CREATION_PHASES`;
       - replace `game.task` and `frontend.task` with the texts below;
       - `game.label` = `'Game code'`, `game.activeLabel` = `'Writing your game code'`;
       - `frontend.label` = `'Front end'`, `frontend.activeLabel` = `'Designing your front end'`;
       - `DEFAULT_CREATION_PHASES = ['design', 'game', 'frontend']`;
       - replace the order-rationale comment block (the one headed "ORDERED FRONT END FIRST, GAME LAST", L114-161) with a 6-line comment pointing to `_specs/tool-loop_plan.md` §Codebase Analysis for the new order and why;
       - in `creationPhaseNote`, delete the "READ IN BATCHES, THEN WRITE" paragraph through "Do NOT rewrite files that are already correct — emit only what this step owes."
    2. `creation-plan-runner.ts`: add `'budget'` to `CreationPauseReason`, and add `MAX_AUTO_CONTINUES`, `PhaseOutcomeAction` and `decidePhaseOutcomeAction` per D19.
    3. `Chat.client.tsx`:
       - add `autoContinueRef = useRef<{ index: number; used: number }>({ index: -1, used: 0 })` and `continueMessageRef = useRef<string | null>(null)`;
       - in `onFinish` (:867-876), replace `if (outcome && outcome.state === 'incomplete') { setPhasePause('incomplete'); setTurnOutcomeAlert(outcome); } else {` with:
         - `const used = autoContinueRef.current.index === livePlan.next ? autoContinueRef.current.used : 0;`
         - `const action = decidePhaseOutcomeAction(outcome?.state, used);`
         - `'auto-continue'` → `autoContinueRef.current = { index: livePlan.next, used: used + 1 }; continueMessageRef.current = KEEP_BUILDING_MESSAGE; armedPhaseRef.current = livePlan.next; setArmedPhase(livePlan.next);`
         - `'pause-incomplete'` → `setPhasePause('incomplete'); setTurnOutcomeAlert(outcome);`
         - `'pause-budget'` → `setPhasePause('budget'); setTurnOutcomeAlert(outcome);`
         - `'advance'` → the existing `else` body, unchanged.
       - in the run effect's `append` (:1349), content = `continueMessageRef.current ?? creationPhaseMessage(plan, decision.index)`, then set `continueMessageRef.current = null` right after reading it;
       - `phaseTurnRef.current = true` is already set there, so an auto-continue is a phase turn and `onFinish` re-evaluates it;
       - wherever today's code handles the user resuming from an `'incomplete'` pause (the card's Continue / the alert action), treat `'budget'` identically.
  - Code, phase texts (verbatim):
    - `design`: `{ id:'design', label:'Art direction', activeLabel:'Designing your game and its art', allowsMedia:true, owesFiles:true, task: <below> }`
      ```
      Design the game before anything is built. Write your todo list for this step first.
      1. Write `SPEC.md`: what this game is, how it plays (controls, rules, scoring, win and lose), its modes, and the GameMode that runs it (read its real class name off `src/scripts/`).
      2. Write `DESIGN.md`: the visual direction (palette, type, mood), and the list of art the game and its front end need — landing hero, backgrounds, chrome art, and any in-game textures or sprites — each with subject, aspect ratio, and whether it needs a transparent background.
      3. Generate every piece of art on that list now, one generate call per image. Do not wait for them — they render in the background and will be ready for the later steps. Record each returned path in `DESIGN.md`.
      Do not write game code, the landing page, or the chrome in this step.
      ```
    - `game.task`:
      ```
      Build the GAME described in `SPEC.md` — the playable project in `src/scripts/**`: the GameMode named there plus whatever Script Components, systems and helpers it needs. Write your todo list first. Keep the play contract exactly as described. Use the in-game art listed in `DESIGN.md` where it fits (the files are in `public/assets/generated/`). Do NOT touch the landing page or the game chrome — that is the next step.
      Verify with `check_game` (pass the GameMode's class name) and keep fixing until it passes. If the request was a single narrow change that does not call for game code, do only what was asked and say so in one line.
      ```
    - `frontend.task`:
      ```
      Design the complete front end, following the bt-landing skill (pre-loaded in your Skills), using `DESIGN.md` as your design brief and the art already rendered into `public/assets/generated/` (the paths are recorded in `DESIGN.md`). That is the landing page (`src/pages/Home.tsx` + `Home.css`, rewritten completely, full page width per the Layout law) AND the game chrome in `src/chrome/**` (preloader, splash, overlay) in the same theme. Wire the play contract to the GameMode from `SPEC.md` — read its real class name off `src/scripts/`, never invent one. Write your todo list first.
      Verify with `check_game` (pass the GameMode's class name) and keep fixing until it passes. 🔴 THIS STEP IS NOT OPTIONAL on a first build: redesign both the landing page and the chrome, every time.
      ```
  - Do not:
    - retire the `art` or `frontend` ids;
    - re-add a "limited tool round trips" sentence;
    - auto-continue a `paused` (budget) turn.
  - Tests:
    - `creation-plan.spec.ts`:
      - declared ids equal `['design','frontend','art','game','game-systems','verify']`;
      - `DEFAULT_CREATION_PHASES` equals `['design','game','frontend']`;
      - a stored `{phases:['frontend','art','game'], next:1}` plan parses unchanged;
      - the existing two-words / no-shared-word label test passes for the new defaults;
      - `creationPhaseNote('game')` does not contain `limited number of tool round trips`.
    - `creation-plan-runner.spec.ts`:
      - `decidePhaseOutcomeAction('finished', 0)` → advance;
      - `('incomplete', 0)` → auto-continue;
      - `('incomplete', 1)` → pause-incomplete;
      - `('unverified', 0)` → auto-continue;
      - `('paused', 0)` → pause-budget;
      - `(undefined, 0)` → advance;
      - existing tests unchanged.
  - Acceptance: the tests pass. The phase labels are checked live in T10.
  - Verify: `pnpm vitest run app/lib/agent/creation-plan.spec.ts app/lib/chat/creation-plan-runner.spec.ts` → all pass.
  - Verify level: standard

### Phase 4 — The Lovable feel, and switching it on

- [x] **T9** — Live activity list, todo checklist, persisted workspace summary, Plan follow-ups — owner 2026-09-30: no unchecked items — the platform completes the list when a turn finishes `done`; a turn that stops short keeps its open items.
  - Depends on: T2, T6
  - Files:
    - create: `app/lib/agent-workspace/activity.ts` (+ spec), `app/components/chat/WorkspaceActivity.tsx`
    - modify: `app/components/chat/AssistantMessage.tsx`, `Chat.client.tsx`, `app/routes/api.agent.ts`, `proxy.ts`, `app/lib/.server/llm/history.ts` (+ spec), `app/lib/chat/plan-proposal.ts` (+ spec)
  - Applies: D20, D22.
  - Steps:
    1. `activity.ts`:
       - Types:
         ```ts
         interface ActivityRow { toolCallId: string; kind: 'write'|'run'|'check'; label: string; status: 'running'|'done'|'failed'; screenshotDataUrl?: string }
         interface ActivityState { rows: ActivityRow[]; todos: TodoItem[] }
         interface WorkspaceActivityStore { current: string | null; byGeneration: Record<string, ActivityState> }
         ```
       - Pure reducers:
         - `startRow(store, generationId, part)`: label `Writing \`${path}\``, `Running \`${command}\`` or `Checking your game…`; sets `current = generationId`; ignores a duplicate `toolCallId`.
         - `finishRow(store, generationId, toolCallId, outcome: {ok: boolean; problems?: number; screenshotDataUrl?: string})`: write → `Wrote \`${path}\``; run → `Ran \`${command}\``; check → `Game check passed`, or `Game check found ${n} problem(s)`, where n = typecheck errors + home errors + play errors, and 1 if `ok` is false and n would be 0.
         - `setTodos(store, generationId, items)`: last write wins.
         - `rowsFromSummary(summary: AgentWorkspaceSummary): ActivityState`: rows for writes, commands and lastCheck, with no screenshot.
       - `export const workspaceActivityStore = map<WorkspaceActivityStore>({ current: null, byGeneration: {} })`, from nanostores, as the other stores use.
    2. `Chat.client.tsx`:
       - in the T1 branch, dispatch `startRow` before `runWorkspaceToolCall`;
       - after it returns, dispatch `finishRow`. The screenshot data URL is `` `data:${mimeType};base64,${base64}` `` from a check result;
       - add an `agent-todos` branch that dispatches `setTodos` (idempotent).
    3. `WorkspaceActivity.tsx`, with props `{ state: ActivityState }`:
       - the todo checklist first: `i-ph:check-square` for completed, `i-ph:square` for pending, `i-svg-spinners:90-ring-with-bg` for in_progress;
       - then the rows: the icon per kind is `i-ph:file-code`, `i-ph:terminal-window` or `i-ph:game-controller`, with a spinner while running and `i-ph:x-circle` in red for failed;
       - a check row with a screenshot shows a 160 px-wide `<img>` thumbnail;
       - show the last 6 rows, plus a "Show all N" toggle;
       - use `bolt-elements-*` tokens and match `Artifact.tsx`'s row spacing;
       - no enlarge behaviour.
    4. `AssistantMessage.tsx`:
       - add the props `isLast?: boolean` and `isStreaming?: boolean`, passed from its parent (`Messages.client.tsx`, where `isStreaming` and the index are known);
       - resolve `state`:
         - if `isLast && isStreaming && store.current` → `store.byGeneration[store.current]`;
         - else if `agentMeta.generationId` (read with the existing `readGenerationId(annotations)` helper, or the same parse) is in `byGeneration` → that;
         - else if an `agentWorkspace` annotation exists → `rowsFromSummary(value)`;
         - else nothing;
       - render `<WorkspaceActivity state={…}/>` above the message content when `state` has rows or todos.
    5. `proxy.ts`: the handle gains `workspaceSummary: Promise<AgentWorkspaceSummary | null>`, resolved in the `finally` to `toolLoop ? summarizeWorkspace(overlay, wsState) : null`.
       - `api.agent.ts`: right after the `agentMeta` annotation, `const ws = await generation.workspaceSummary; if (ws) stream.writeMessageAnnotation({ type: 'agentWorkspace', value: ws as any });`
    6. `history.ts`:
       - in compaction, for an assistant message with an `agentWorkspace` annotation, append `\n\n[Workspace: wrote ${n} file(s) (${first 20 paths joined ', '}); todos ${done}/${total}; last check ${passed|failed|not run}]`;
       - apply it to **both** `content` and every text part in `parts` (`convertToCoreMessages` prefers `parts`);
       - skip it if the marker `[Workspace:` is already present.
    7. `plan-proposal.ts`:
       - `planArtifactToExecute(content, annotations?)` also returns the first `agentWorkspace.writes` entry ending in `_plan.md`, when the content has none;
       - `shouldOfferBuildAndApply(annotations, content)` returns `true` when the message is a Plan-mode message with an `agentWorkspace` annotation (tool mode) **and** it wrote no `_plan.md`. The legacy content rule is unchanged;
       - `decidePlanFollowUp` passes `annotations` through. Existing precedence: apply wins.
  - Tests:
    - `activity.spec.ts`:
      - a write start → running row, then done with the "Wrote" label;
      - a failed result → failed;
      - check pass/fail labels and the problem count;
      - screenshot stored;
      - todos last-write-wins;
      - duplicate `toolCallId` ignored;
      - `rowsFromSummary` maps writes, commands and lastCheck.
    - `history.spec.ts`: an `agentWorkspace` annotation is summarised into both `content` and `parts`; idempotent; no annotation → unchanged.
    - `plan-proposal.spec.ts`: a tool-mode plan message that wrote `_specs/x_plan.md` → "Build this plan" with that path; tool-mode without a plan write → Build & Apply; legacy cases unchanged.
  - Acceptance:
    - The tests pass.
    - **Live**, with the flag on (`.env.local` `AGENT_TOOL_LOOP=true` and a dev server restart), on an existing project: send "add a pause menu to my game". In one session observe:
      - a one-sentence narration before the tool rows;
      - the todo checklist ticking;
      - "Wrote …" rows appearing as files land in the file tree;
      - the preview staying in front and updating;
      - a "Checking your game…" row resolving to passed with a thumbnail;
      - no "continue" needed.
    - Reload: that message still shows its checklist and rows (from the annotation).
    - Switch to Plan, send `/bt-plan add a high-score table`: a `_specs/…_plan.md` file is written and "Build this plan" is offered.
  - Verify: `pnpm vitest run app/lib/agent-workspace/activity.spec.ts app/lib/.server/llm/history.spec.ts app/lib/chat/plan-proposal.spec.ts` → all pass.
  - Verify level: live

- [x] **T10** — Turn it on by default and prove a whole game builds end to end — owner approved default-on 2026-09-30; `AGENT_TOOL_LOOP=false` is the kill switch.
  - Depends on: T1–T9
  - Files: `app/lib/.server/agent/tool-loop.ts`, `tool-loop.spec.ts`, `.env.example`
  - Applies: D2, D9, D18, D19.
  - Steps:
    1. `resolveToolLoopConfig`: `enabled = env(context,'AGENT_TOOL_LOOP') !== 'false'`. Update the `.env.example` comment and the spec (enabled by default; `'false'` disables).
    2. Run the gates: `pnpm typecheck && pnpm lint:fix && pnpm lint && pnpm test`.
    3. **Prompt refresh**, because the baked sections changed in T7:
       - with the dev server running and signed in as the local developer (local mode is admin), run `POST /api/admin/prompt` with body `{"action":"refresh"}` (from the browser console: `await (await fetch('/api/admin/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'refresh'})})).json()`);
       - if the response does not show the new version as active, POST `{"action":"activate","versionId":"<returned id>"}`;
       - record the version id.
  - Tests: `tool-loop.spec.ts` → enabled by default; `'false'` disables.
  - Acceptance (**one live session**, local dev server, real provider; a real build spends credits, which is expected):
    - **Build 1.** Create a new project from "a top-down arcade kart racer with boost pads and three laps", press **Build my game**, and type nothing else.
      - The creation card shows **Art direction → Game code → Front end**, each starting by itself.
      - Art direction writes `SPEC.md` and `DESIGN.md` and enqueues renders.
      - Game code's last check row shows "Game check passed" with a thumbnail of a scene.
      - Front end rewrites `Home.tsx`/`Home.css` and `src/chrome/**` using files from `public/assets/generated/`, and its final check passes.
      - The game-ready celebration fires.
      - Pressing Play on the new landing page launches the game with no console errors.
    - Report: total credits, wall time, `finish_reason` suffixes per phase (segments, gates), and any auto-continue.
    - **Build 2.** Repeat once with "a first-person maze with collectible gems and a timer".
    - If a build fails, report the phase, the last check errors and the generation id, and do not check this box.
  - Verify: the gates are green and both live runs are reported.
  - Verify level: live

- [x] **T11** — Update SPEC.md and CLAUDE.md to match what was built
  - Depends on: T10
  - Files: `SPEC.md`, `CLAUDE.md`
  - Applies: all D-numbers.
  - Steps:
    1. **SPEC.md §4.2, step 1** (the credit-gate item): append "A tool-loop turn may PAUSE at a step boundary when it reaches its per-turn ceiling (the lesser of `AGENT_TURN_MAX_CREDITS` and the balance at turn start); it is never cut mid-stream, and everything written so far is kept."
    2. **SPEC.md §4.2, steps 3-4:** replace them with:
       > "3. **Tool loop.** The model changes the project with tools — `read_file`, `write_file`, `edit_file`, `run_command`, `check_game`, `update_todos` — executed in the user's browser sandbox through the relay (the server resolves edits against a per-turn overlay; the browser performs writes, commands and the game check and posts results back only after they complete). A turn is a sequence of segments inside ONE generation (one stream, one settlement), bounded by a per-turn credit ceiling, not a step cap. A turn that wrote files is not done until `check_game` passes after its last write (done-gate; breaker after 3 identical failures or `AGENT_CHECK_MAX_NUDGES`). 4. `AGENT_TOOL_LOOP=false` restores the legacy `<boltArtifact>` path, kept as a kill switch."
    3. **SPEC.md, the "Agent architecture stance" paragraph** → "**Agent architecture stance:** single agent + a Lovable-style tool loop that verifies its own work (`check_game`), with self-healing repair turns as a backstop. Decided 2026-09-30 (owner) — `_specs/tool-loop_plan.md`. The single-response artifact design is retired as the default because it could not finish a build."
    4. **§4.2.8:** prepend a paragraph:
       > "**Tool-loop economics (2026-09-30):** the loop re-sends its growing tail every step; a rolling 5-minute `cache_control` breakpoint on the last message (fetch-level, `tail-cache.ts`) uses the one spare breakpoint and keeps that at cache-read rates. Step caps are replaced by the per-turn credit ceiling; `maxTokens` is the model's own output limit. The `MAX_TOOL_ROUNDS + 1` / forced-continuation rules below apply to the legacy path only."
    5. **§4.2.9:** add "With the tool loop, the `_specs/` write door is enforced server-side inside `write_file` (`isPlanArtifactPath`); edit/run/check tools are not offered, and a Plan turn always has tools (a preloaded skill or slash command no longer withdraws them)."
    6. **§4.4a L635 and L639:** replace the phase sentences with "PHASED CREATION: **Art direction → Game code → Front end**, each its own tool-loop turn that auto-starts; a phase that stops short, or ends with a failing check, auto-continues once; a turn paused at the credit ceiling waits for the user's **Keep building**."
    7. **Decisions log:** after `### §8k Decisions log …` and its entries, add `### §8l Decisions log (tool loop — newest last)` with one entry:
       > "- 2026-09-30 — Tool loop replaces single-response generation (owner). v1 could not finish a build; every builder that finishes (Lovable, Bolt v2, Replit, v0, Chef) writes with tool calls and verifies in-turn. Phases reordered to Art direction → Game code → Front end. Plan: `_specs/tool-loop_plan.md`."
    8. **CLAUDE.md:** under "Standing rules — NEVER violate these in code", add a 🔴 bullet, "THE AGENT BUILDS WITH TOOLS AND VERIFIES WITH `check_game` (2026-09-30, `_specs/tool-loop_plan.md`)", summarising:
       - the six tools;
       - `writeAgentFile` (no persistence top-up) and the POST-after-completion rule;
       - the overlay (server owns text during a turn);
       - the credit ceiling instead of step caps;
       - the done-gate and breaker;
       - the tail breakpoint using the one spare (3 system + 1 tail);
       - Plan mode's server-side `_specs` wall;
       - `AGENT_TOOL_LOOP=false` as the kill switch.
       
       In "Current stage", add a line: "**Tool loop live by default (2026-09-30).**"
  - Tests: no testable surface (documentation).
  - Acceptance:
    - SPEC.md and CLAUDE.md describe the tool loop, the ceiling, the done-gate and the phase order.
    - Neither calls the artifact protocol the default.
    - Nothing contradicts the code.
  - Verify: read through each edited section against the code; `pnpm test` stays green.
  - Verify level: standard

---

## Estimated execution time

| Phase | Tasks | What makes it slow | Estimate |
|---|---|---|---|
| 1 — Workspace channel | T1–T3 | T1's live Nodepod `tsc` + game-check run; the live-relay spec | ~61 min |
| 2 — The loop | T4–T6 | T4 rewires the stream chain in a 3,385-line file | ~61 min |
| 3 — Prompts & phases | T7–T8 | keeping pinned-wording specs green; Chat.client wiring | ~44 min |
| 4 — Feel & switch-on | T9–T11 | one live UI session; two real game builds (~10–20 min wall time each) | ~61 min |

**Total:**
- Base: 11 × 17 + 4 × 10 = 227 min.
- One fix round (20 min) for the genuine unknown (does `tsc -b` run under Nodepod?).
- **About 4.1 h, range 2.9–5.4 h of agent time.**
- With `bt-execute --strict`, about 2–3× that.

**Biggest uncertainty:** T1's in-browser `tsc -b` under Nodepod. The fallback is decided (D8 `'unavailable'`), but it weakens the done-gate to runtime-only checks.

---

## How to execute this plan

Each task above is a checkbox. To implement:
- Run a single task with the bt-execute command (e.g. `bt-execute <this-file> T<n>`), run every remaining task in order with `bt-execute <this-file> ALL` (resumable — it skips tasks already checked), or implement the whole plan from a prompt like "implement the plan at <this-file>".
- bt-execute verifies each phase with an independent verifier; add `--strict` for an adversarial verifier on every task.
- Work the tasks top to bottom unless a task notes a different dependency order.
- When a task is fully implemented and its **Acceptance** criteria are met, mark it complete by editing this file and changing that task's `- [ ]` to `- [x]`.
- Stop and report if a task cannot be completed. Do NOT check a box for partial, skipped, or unverified work.
