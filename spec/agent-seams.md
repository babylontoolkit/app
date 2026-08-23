# Agent seams — the three phases a model request passes through

> **Status:** naming and a scan, deliberately **not** a rewrite. SPEC §4.2's standing stance is
> *"single agent + server-side tool loop + self-healing repair turns… **do not re-architect**"*, and
> nothing in this document changes a call order. What changes is that the phases have names, every
> participant is filed under one, and `seam-classification.spec.ts` fails when a new participant
> appears in `proxy.ts` or `api.agent.ts` without being filed here. **A document that rots is worse
> than no document, because it is read as current.**

## Why this exists

The proxy is one long function that assembles a request, streams a response, and runs tools in
between. That shape is readable — you can follow a generation top to bottom in one file — and it has
one weakness: nothing states which of those three things a given module participates in, so the
answer lives in whoever last read the file. Every entry in the "straddlers" section below is a module
someone would reasonably file in the wrong place.

The immediate consumer is `request-fingerprint.ts`. It records the assembled request at `startStream`,
and the reason it must record **every** assembly and not just the first is a straddler:
`stripReplayedReasoning` runs on STREAM output *in order to assemble a second request inside the same
turn*. Miss that and the fingerprint records the one request nobody was ever confused about.

## The three phases

| Phase | Definition | Boundary in the code |
|---|---|---|
| **ASSEMBLE** | Runs while `system[]`, `coreMessages[]`, `tools` and `model` are being built. | Everything above the `startStream` closure in `proxy.ts`, plus the route work in `api.agent.ts` before `runAgentGeneration` — **and the body of `startStream` itself**, which is where the arrays are finally handed over. |
| **STREAM** | Wraps, filters, measures or reacts to the model's output. | The `drain` loop, the `onStepFinish` handler, the filter chain in `api.agent.ts`, and settlement. |
| **TOOL** | Enforced inside a tool's `execute`, or handed to the SDK as a per-call hook or a step cap. | The tool objects built during ASSEMBLE but whose rules bite during the loop. |

⚠️ **A module can be built in one phase and bite in another, and that is not a classification failure —
it is the thing the classification is for.** Those rows carry two phases and a reason.

⚠️ **`startStream`'s own body is ASSEMBLE, not a fourth phase**, and the boundary above says so
explicitly because the first draft did not: it read *"everything ABOVE the `startStream` closure"*
while filing `request-fingerprint.ts` and `request-invariants.ts` — which run INSIDE it — under
ASSEMBLE. The definition excluded the very point its own immediate consumer runs at. The closure is
the last thing that touches the arrays before they go to the model, so it is the end of ASSEMBLE, not
outside it.

## What is deliberately REJECTED

Recorded here so it is not proposed as the obvious next step, because it is the obvious next step and
it is wrong for this codebase:

- **A plugin registry.** SPEC §4.2 forbids re-architecting the loop; a registry replaces a readable
  call order with an indirection you have to run to understand.
- **An event emitter.** The same objection, plus it makes ordering implicit — and ordering is
  load-bearing here (the `PLAN_MODE`-before-`NO_REPLAY` annotation order is a race fix; the file
  context sits behind the last cache breakpoint on purpose).
- **Reversible effects / a transaction model.** The money path is already append-only and settled
  once; a second notion of "undo" over it is a way to disagree with the ledger.
- **Config-composed pipelines, or any port of Cordis.** The brief that asked for this work says it
  itself: *"Not worth a rewrite now, but that's the shape to move toward if the proxy is ever
  restructured."* That sentence is the decision. This document is the part of it that is worth having
  today.

⚠️ **`MAX_MEDIA_ROUNDS` does not exist** — deleted 2026-08-08 by owner decision (`media-tools.ts`:
*"THERE IS NO MEDIA ROUND BUDGET"*), with live evidence of three refused images. It must not appear in
any classification here; text asserting the constant will not compile against the code it describes.

## The straddlers

These are the rows a reader would file wrong, with the reason each one genuinely sits on a boundary.

### `llm/history.ts` — `stripReplayedReasoning` — **STREAM → ASSEMBLE**
Invoked three times, each on `(await first.response).messages` — STREAM
output — and each time in order to build the message array for a **new** request inside the same turn.
🔴 **This is why the request invariant evaluates at every assembly point and not only the first.** A
verifier bolted to the first request would never see the continuation, the rescue or the completeness
pass, which are exactly the requests no persisted record has ever mentioned.

### `agent/tool-policy.ts` — **ASSEMBLE + TOOL**
`toolPolicyForTurn` is decided during assembly, but its `maxSteps` is handed to the
SDK as a per-generation **cap** (`proxy.ts`, inside `startStream`) where it governs the tool loop. The
decision is ASSEMBLE; the enforcement is TOOL.

### `agent/budgets.ts` — **ASSEMBLE + TOOL**
`resolveAgentBudgets` is resolved once during assembly and enforced inside every
file/reference tool's `execute`. `budgets-wiring.spec.ts` exists *because* of this split: every seam
takes the budgets optionally, so a proxy that forgets to pass one produces a perfectly healthy
generation silently running on the default.

### `agent/delivery.ts` — **ASSEMBLE + STREAM, via two different exports**
⚠️ Not one value crossing a boundary — two exports on two paths. `deliveryModeFor` is called on the
returned handle in `proxy.ts` (assembly-side facts: provider and model), while `typicalDurationMs` is
called by the stream wrapper in `api.agent.ts`. Describing this as "computed during assembly and
consumed by the stream wrapper" would be false on day one, and a false sentence in a spec is how the
spec stops being read.

### `agent/preload-skills.ts` — **ASSEMBLE, reading the previous turn's STREAM output**
`carriedSkillNames` reads `agentMeta.skillsLoaded` annotations off the conversation — output the model
produced on an earlier turn — to decide what rides in *this* turn's cached prefix. It is ASSEMBLE, but
its input is another turn's STREAM, which is why `stickyLoadedSkills` must be append-only in
first-seen order: re-ordering it rewrites the prefix at the 2× cache-write rate.

### `prompt/cache-warmer.ts` — **ASSEMBLE + STREAM**
`ensureCacheWarmer` runs at the proxy doorway; `recordCacheRead` is stamped after a
generation reports a cache read, so the warmer can skip a cycle when organic traffic
has already warmed the prefix. Two phases, one module, and the feedback loop between them is the
reason the warmer's steady-state cost is proportional to how quiet the platform is.

### `billing/gate.ts` — **ASSEMBLE + STREAM**
`checkCreditGate` runs once before the model; `settleGeneration` and `refundGeneration` run after it. The asymmetry is load-bearing and belongs in the
classification: the gate MAY refuse, settlement NEVER may (§4.6).

### `agent/retry-policy.ts`, `agent/unproductive.ts`, `agent/creation-completion.ts` — **STREAM → ASSEMBLE**
The same shape as `stripReplayedReasoning`: each decides, from a drained stream, that another request
must be assembled. Together they account for **four** of the six `startStream` call sites — the two
retry shapes, the unproductive rescue and the creation-completeness pass. The other two are the FIRST
request and the forced continuation, whose decision (`shouldForceContinuation`) is exported from
`proxy.ts` itself rather than from a module of its own, which is why it has no row in the tables
below.

## The participants

Every module `proxy.ts` or `api.agent.ts` imports a VALUE from. Filed by phase, with the line the
proxy (or route) actually invokes it on, so the table can be checked against the code rather than
believed.

### ASSEMBLE

| Module | Entry point | Invoked at |
|---|---|---|
| `app/lib/.server/agent/attachments.ts` | `validateAttachments` | `api.agent.ts:192` (`validateAttachments`) |
| `app/lib/.server/agent/config.ts` | `getPlatformConfig`, `getPlatformModel`, `getTierModel`, `providersToPrice`, `requirePlatformKey` | `proxy.ts:761` (`providersToPrice`) |
| `app/lib/.server/agent/discuss-note.ts` | `discussModeNote` | `proxy.ts:1149` (`discussModeNote`) |
| `app/lib/.server/agent/effort-policy.ts` | `effortForTurn` | `proxy.ts:1846` (`effortForTurn`) |
| `app/lib/.server/agent/inflight.ts` | `shouldClaimProject`, `claimProject` | `api.agent.ts:207` (`shouldClaimProject`) |
| `app/lib/.server/agent/media-note.ts` | `mediaProtocolNote` | `proxy.ts:1632` (`mediaProtocolNote`) |
| `app/lib/.server/agent/project-instructions.ts` | `buildProjectInstructions` | `proxy.ts:1104` (`buildProjectInstructions`) |
| `app/lib/.server/agent/project-notes.ts` | `buildProjectNotes` | `proxy.ts:1570` (`buildProjectNotes`) |
| `app/lib/.server/agent/request-fingerprint.ts` | `computeRequestFingerprint` | `proxy.ts:2068` (`computeRequestFingerprint`) |
| `app/lib/.server/agent/request-invariants.ts` | `checkNoDuplicatePaths`, `checkFirstBuildManifest`, `checkManifestShrink` (with the manifest); `checkNoFileBodies` (per assembly, inside `startStream`); `checkHandoffRecorded` + `reportIntegrity` (once, at settlement) | `proxy.ts:1260` (`checkNoDuplicatePaths`) |
| `app/lib/.server/assets/library-manifest.ts` | `assetLibraryIndexForRequest` | `proxy.ts:1302` (`assetLibraryIndexForRequest`) |
| `app/lib/.server/assets/library-store.ts` | `activeAssetLibrary`, `ensureAssetLibraryForContext` | `proxy.ts:771` (`ensureAssetLibraryForContext`) |
| `app/lib/.server/billing/market-price-store.ts` | `ensureMarketPrices`, `marketPriceProvidersFor` | `proxy.ts:761` (`marketPriceProvidersFor`) |
| `app/lib/.server/billing/premium.ts` | `decideModelTier`, `tierDeclinedNotice` | `proxy.ts:986` (`decideModelTier`) |
| `app/lib/.server/billing/rates.ts` | `getModelTiers` | `proxy.ts:962` (`getModelTiers`) |
| `app/lib/.server/game-backend/separation.ts` | `sanitizeGameBackend` | `api.agent.ts:256` (`sanitizeGameBackend`) |
| `app/lib/.server/licensing/entitlements.ts` | `resolveByok` | `proxy.ts:799` (`resolveByok`) |
| `app/lib/.server/media/provider.ts` | `resolveMediaProvider` | `proxy.ts:1483` (`resolveMediaProvider`) |
| `app/lib/.server/projects/ownership.ts` | `requireOwnedProject` | `api.agent.ts:183` (`requireOwnedProject`) |
| `app/lib/.server/prompt/active.ts` | `getActivePrompt` | `proxy.ts:1030` (`getActivePrompt`) |
| `app/lib/.server/prompt/store.ts` | `getPromptStore` | `proxy.ts:1075` (`getPromptStore`) |
| `app/lib/.server/skills/store.ts` | `getSkillStore` | `proxy.ts:680` (`getSkillStore`) |
| `app/lib/.server/storage/index.ts` | `getObjectStore` | `proxy.ts:1491` (`getObjectStore`) |
| `app/lib/.server/supabase/auth.ts` | `requireVerifiedUser` | `api.agent.ts:169` (`requireVerifiedUser`) |
| `app/lib/agent/starter-note.ts` | `starterGameTypeFrom`, `starterGameTypeNote` | `proxy.ts:1614` (`starterGameTypeFrom`) |
| `app/lib/agent/toolkit-systems.ts` | `toolkitSystemsNoteForRequest` | `proxy.ts:1318` (`toolkitSystemsNoteForRequest`) |
| `app/lib/chat/message-envelope.ts` | `stripTransportPrefix`, `splitCarriedArtifact`, `stripTransportEnvelopes`, `countUnstrippedEnvelopes` | `proxy.ts:673` (`stripTransportPrefix`) |
| `app/lib/context/file-manifest.ts` | `buildFileManifest`, `renderFileManifest` | `proxy.ts:1281` (`renderFileManifest`) |
| `app/lib/modules/llm/model-families.ts` | `familyOf` | `proxy.ts:1006` (`familyOf`) |
| `app/lib/registry/entries.ts` | `findRegistryEntry` | `proxy.ts:1614` (`findRegistryEntry`) |
| `app/lib/skills/slash.ts` | `parseSlashInvocation` | `proxy.ts:674` (`parseSlashInvocation`) |

`app/lib/agent/creation-plan.ts` is ASSEMBLE for `creationPhaseNote` / `parseCreationPhaseId` /
`projectOwesBuild` and STREAM for `phaseOwesFiles`, which asks of a finished turn whether it owed
files.
`app/lib/modules/llm/capabilities.ts` is ASSEMBLE for `parseUserEffort` and
STREAM→ASSEMBLE for `canDisableThinking`, which decides the last-resort re-issue.
`app/lib/.server/llm/history.ts` is ASSEMBLE for `compactHistory` / `historySize` / `historySavings`
and a straddler for `stripReplayedReasoning` — see above.

### STREAM

| Module | Entry point | Invoked at |
|---|---|---|
| `app/lib/.server/agent/action-tags.ts` | `createTagCounter`, `isTruncatedAction` | `proxy.ts:2389` (`createTagCounter`) |
| `app/lib/.server/agent/heartbeat.ts` | `withGenerationHeartbeat` | `api.agent.ts:454` (`withGenerationHeartbeat`) |
| `app/lib/.server/agent/protocol-strip.ts` | `ProtocolTagStreamFilter` | `api.agent.ts:434` (`ProtocolTagStreamFilter`) |
| `app/lib/.server/agent/provider-select.ts` | `recordProviderFailure`, `recordProviderSuccess` | `proxy.ts:2506` (`recordProviderFailure`) |
| `app/lib/.server/agent/shell-strip.ts` | `ShellActionStreamFilter` | `api.agent.ts:426` (`ShellActionStreamFilter`) |
| `app/lib/.server/agent/step-usage.ts` | `accumulateStepUsage`, `emptyUsage` | `proxy.ts:1916` (`emptyUsage`) |
| `app/lib/.server/agent/usage-metadata.ts` | `extractStepCacheTokens`, `shouldWarnMissingUsageNamespace`, `usageNamespaceFor` | `proxy.ts:2130` (`extractStepCacheTokens`) |
| `app/lib/.server/agent/usage.ts` | `getGenerationLog` | `proxy.ts:3149` (`getGenerationLog`) |
| `app/lib/.server/billing/savings.ts` | `describeSavings` | `proxy.ts:2965` (`describeSavings`) |
| `app/lib/.server/monitoring/failure-rate.ts` | `sharedFailureRate` | `proxy.ts:3174` (`sharedFailureRate`) |
| `app/lib/.server/monitoring/paid-path-rates.ts` | `recordRefundOutcome`, `recordRescueMarkers` | `proxy.ts:3194` (`recordRescueMarkers`) |
| `app/lib/modules/llm/refusal-fallback.ts` | `describeRefusal`, `drainFallbackHandoffs` | `proxy.ts:2806` (`describeRefusal`) |
| `app/lib/modules/llm/stop-reason-tap.ts` | `peekStopReasons`, `drainStopReasons` | `proxy.ts:2804` (`peekStopReasons`) |
| `app/lib/agent/turn-outcome.ts` | `describeTurnOutcome` | `api.agent.ts:587` (`describeTurnOutcome`) |
| `app/lib/.server/monitoring/index.ts` | `getMonitor`, `FUNNEL_EVENTS`, `ALERT_SIGNALS` — ⚠️ **ASSEMBLE + STREAM**: the monitor is obtained at the assembly doorway and fires funnel events and alerts throughout the turn. Filed here because the alerts that matter are stream-side, but it belongs to no single phase | `proxy.ts:781` (`getMonitor`) |

`app/lib/.server/agent/proxy.ts` itself is the whole pipeline; `api.agent.ts` invokes it as `runAgentGeneration`.

### TOOL

| Module | Entry point | Invoked at |
|---|---|---|
| `app/lib/.server/agent/mcp-relay.ts` | `cancelGenerationToolCalls` | `proxy.ts:3213` (`cancelGenerationToolCalls`) |

### ASSEMBLE + TOOL — built during assembly, enforced inside `execute`

| Module | Entry point | Built at |
|---|---|---|
| `app/lib/.server/agent/file-tools.ts` | `createFileTools` | `proxy.ts:1785` (`createFileTools`) |
| `app/lib/.server/agent/mcp-tools.ts` | `createMcpRelayTools` | `proxy.ts:1396` (`createMcpRelayTools`) |
| `app/lib/.server/agent/media-tools.ts` | `createMediaTools` | `proxy.ts:1487` (`createMediaTools`) |
| `app/lib/.server/agent/preview-tools.ts` | `createPreviewTools` | `proxy.ts:1443` (`createPreviewTools`) |
| `app/lib/.server/agent/reference-tools.ts` | `createReferenceTools` (TOOL), `carriedReferenceIds` (ASSEMBLE) | `proxy.ts:1078` (`carriedReferenceIds`) |
| `app/lib/.server/agent/tool-repair.ts` | `createRepairTool`; `repairUnavailableToolCall` is handed to the SDK as a per-call hook | `proxy.ts:1815` (`createRepairTool`) |
| `app/lib/.server/agent/tools.ts` | `createSkillTools` | `proxy.ts:1822` (`createSkillTools`) |
| `app/lib/.server/agent/web-fetch-tool.ts` | `createWebFetchTool` | `proxy.ts:1754` (`createWebFetchTool`) |
| `app/lib/.server/agent/web-search-tool.ts` | `createWebSearchTool` | `proxy.ts:1753` (`createWebSearchTool`) |
| `app/lib/.server/agent/budgets.ts` | `resolveAgentBudgets` — straddler, see above | `proxy.ts:1526` (`resolveAgentBudgets`) |
| `app/lib/.server/agent/tool-policy.ts` | `toolPolicyForTurn` — straddler, see above | `proxy.ts:1528` (`toolPolicyForTurn`) |

### Straddlers filed above, listed here so every module appears exactly once

⚠️ **"Straddler" means a module with a ROW here**, and that is a definition rather than an observation:
`monitoring/index.ts` also carries two phases (its own row says so — the monitor is obtained at the
assembly doorway and fires throughout the turn) and is deliberately NOT listed, because it belongs to
the pipeline the way a logger does rather than to a boundary between two phases. A count of
"straddlers" means the rows below plus the two flagged in the ASSEMBLE+TOOL table.

⚠️ The reference is the FIRST invocation only, and that is a real limitation rather than an oversight:
every module here is invoked from more than one place — that is what makes it a straddler — so one
reference cannot be the whole story. The other invocation points are named in the prose above.
`seam-classification.spec.ts` checks every `file:line (symbol)` in this document against the real
file, so a reference that drifted fails a test instead of quietly becoming fiction.

| Module | Phases | First invoked at |
|---|---|---|
| `app/lib/.server/agent/creation-completion.ts` | STREAM → ASSEMBLE | `proxy.ts:2751` (`shouldVerifyCreationCompleteness`) |
| `app/lib/.server/agent/delivery.ts` | ASSEMBLE + STREAM, via two exports | `proxy.ts:3264` (`deliveryModeFor`) |
| `app/lib/.server/agent/preload-skills.ts` | ASSEMBLE, reading the previous turn's STREAM | `proxy.ts:1151` (`preloadSkills`) |
| `app/lib/.server/agent/retry-policy.ts` | STREAM → ASSEMBLE | `proxy.ts:2480` (`shouldRetryGeneration`) |
| `app/lib/.server/agent/unproductive.ts` | STREAM → ASSEMBLE | `proxy.ts:2695` (`shouldRescueUnproductiveTurn`) |
| `app/lib/.server/billing/gate.ts` | ASSEMBLE + STREAM | `proxy.ts:913` (`checkCreditGate`) |
| `app/lib/.server/llm/history.ts` | ASSEMBLE + (STREAM → ASSEMBLE) | `proxy.ts:1904` (`compactHistory`) |
| `app/lib/.server/prompt/cache-warmer.ts` | ASSEMBLE + STREAM | `proxy.ts:777` (`ensureCacheWarmer`) |
| `app/lib/agent/creation-plan.ts` | ASSEMBLE + STREAM | `proxy.ts:904` (`parseCreationPhaseId`) |
| `app/lib/modules/llm/capabilities.ts` | ASSEMBLE + (STREAM → ASSEMBLE) | `proxy.ts:1855` (`parseUserEffort`) |

## Adding a participant

`seam-classification.spec.ts` enumerates the modules `proxy.ts` and `api.agent.ts` actually import a
value from and fails on any that is not named in this file. It is **default-deny**: a new module is a
failing test until it is classified.

### Keeping the invocation references true

Every `` `file:NNN` (`symbol`) `` reference in this document is checked against the real file by
`seam-classification.spec.ts`. That test exists because these numbers rotted once already, **in the
branch that first wrote them** — this feature's own tasks added ~220 lines to `proxy.ts` and 64 of 75
references became fiction the same day.

⚠️ **They are the ONLY permitted form.** A reference in prose, or a bare `` `:NNN` `` continuation,
cannot name a symbol and therefore cannot be verified — so the scan asserts that the number of
CHECKED references equals the number that EXIST, and that no bare continuation is present. That
control is not theoretical: the first version of this scan anchored on a markdown table cell, and a
verifier smuggled a reference to line 99999 past it by adding two words to the sentence.

**When the scan fails, REGENERATE — never delete the reference and never widen the regex.** For each
claim, find the first line of `proxy.ts` / `api.agent.ts` that invokes the named symbol on real code
(not a comment, not an import) and write that number. The failure message names every offender.

⚠️ **Do not silence that failure by adding an allow-list entry.** The allow-list exists for modules
that are genuinely not part of the request pipeline — a logger, a constants file, a marker string —
and every entry carries a prose reason. A participant put there is a lie with a test protecting it,
which is worse than the undocumented state this file replaced. The list is enumerated **from the
imports**, never from a hand-written roster, because a hand-written roster is exactly how the
`spend-holes` sweep missed five routes: it enumerated the ones somebody had thought of.
