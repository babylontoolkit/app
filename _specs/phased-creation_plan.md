# Phased, resumable project creation

## Context

Project creation is one model turn that must write the game, a complete landing-page and chrome
redesign, and two design docs. It does not fit in a response.

Measured on `gen_mskc4r0y` (2026-08-08, opus-5, Anthropic direct) — the run the owner reported as
*"charged me over 1,100 credits and only created 4 files then just stopped"*:

| | |
|---|---|
| artifact | 14 files / 90,288 chars in one response |
| output ceiling | hit it — `maxTokens: 64_000` (`proxy.ts:1607`), `stop_reason: max_tokens` |
| closing tags | **14 `<boltAction>` opens, 4 closes** |
| result on disk | nine files welded into one 93,856-byte `KartTrack.ts`; `Kart.ts` and `KartFactory.ts` never existed; `Home.tsx`/`splash.tsx` left as untouched starter |
| longest step | 688,305 ms |
| billed | 1,162 credits, settled `completed`, user shown *"🎮 Your game is ready"* |

Character split: **game code 50,487 (45%) · landing+chrome 37,382 (33%) · docs ~8,000 (7%).**

Two further facts:

- The sibling creation an hour earlier (`gen_mskbklu7`, fable-5) was **10 opens / 10 closes and
  landed fine**. The difference between a working creation and a destroyed one is whether the model
  happened to keep emitting closing tags across an eleven-minute response. Nothing measures that.
- `CREATION_ALLOWS_MEDIA = false` (`tool-policy.ts:116`) — images cannot be generated on the creation
  turn at all, so the model designs a page needing six images and writes a shopping list instead.

This is not a prompt problem. The prefix was already cut 4× (77,699 → 38,591 tokens) and **the entire
cached prefix is 2.6% of that bill; output is 66%.** The fix is to stop asking for the whole project
in one response.

### Decisions taken (owner, this session)

| | |
|---|---|
| Phases | **Game → Frontend → Art → Verify** |
| Phase list | **Fixed in code** — no model-authored plan, no menu selection |
| Storage | **Extend `projects.creation_handoff` jsonb** — no new tables |
| Resume | **Show remaining phases, one click to continue** — never auto-spend on page load |

---

## Stage 0 — Parser implicit-close (ship first, on its own)

**Independent of everything below, and it protects every turn including today's.**

`app/lib/runtime/message-parser.ts:152-172` handles a missing `</boltAction>` only for the *last*
action in an artifact (it searches forward for `</boltArtifact>`). With ten missing closes it found
the next close 94,000 chars later and **silently merged nine files into one**.

Change: while `insideAction`, a `<boltAction` open encountered before any close is an **implicit
close** of the current action. Take `min(closeIndex, artifactCloseIndex, nextActionOpenIndex)`.

- ~5 lines in the existing `actionEndIndex` computation.
- Would have saved **nine of those ten files**.
- Test in `message-parser.spec.ts`: ten opens / zero closes → ten distinct files, each containing
  only its own body. **Control:** a normal balanced artifact is byte-identical. Mutation-verify by
  reverting the `min` and watching the ten-file test fail.

> ⚠️ FRESH-START §6 bans *"a parser that repairs malformed file syntax"* while §1.2 offers this
> exact stopgap. §1.2 wins on cost, and the tension is the reason this ships **separately**: bundling
> it lets a green phased creation hide a still-broken parser. Phases make a dropped tag less likely,
> never impossible, and the blast radius of one is still nine files welded into one.

---

## Stage 1 — The phase plan (data model + server plumbing)

### The record

New pure module `app/lib/agent/creation-plan.ts` — client **and** server, same siting as
`turn-outcome.ts` (which is the precedent for a verdict both sides must agree on).

```ts
export type CreationPhaseId = 'game' | 'frontend' | 'art' | 'verify';

export interface CreationPlan {
  v: 1;                       // unknown version ⇒ treated as NO plan ⇒ today's one-shot, unchanged
  phases: CreationPhaseId[];  // ordered, from CREATION_PHASES — never model-authored
  next: number;               // index of the next phase to run; === phases.length ⇒ complete
  done: Array<{ id: CreationPhaseId; generationId: string; at: string; state: TurnOutcomeState }>;
}
```

`CREATION_PHASES` is a constant table: `{ id, label, task, allowsMedia, kind }`.

### Storage — one source, one cache

| where | role |
|---|---|
| `projects.creation_handoff.plan` | **the source** — survives tab death and device switch |
| `bt_new_project_mode:<projectId>` localStorage | **the cache** (already the documented relationship, `Chat.client.tsx:386`) |
| `newProjectModeStore` atom | the live value for the open project |

No migration for the column. **Ship `0020_creation_plan_comment.sql`, comment-only** — migration
0016's comment asserts *"NULL once the first build turn has been sent"* and that sentence becomes
false. A comment that lies is how five recorded defects in this repo survived review.

**The invariant change, precisely:**

- The **brief** is still consumed on SEND (unchanged — the reason, a double-append into an uncached
  history that re-sends forever, is unchanged). Attached to the phase-0 message only.
- The **plan** ends when the last phase settles, or when the user types a message of their own.
- `creation_handoff` is NULLed at **plan completion**. NULL is still the end state; the end moved.

### Two rules that are not optional

1. **Monotonic merge, server-side.** `PATCH /api/projects/:id` is a full replace today. Two tabs or
   an out-of-order retry can move `next` backwards and re-run a finished phase.
   `next = Math.max(existing?.plan?.next ?? 0, incoming.next)`, in the route (which can read the
   existing row), not in `parseCreationHandoff` (which cannot). This is the ledger's `seq` lesson
   applied to a counter that decides what gets rebuilt.
2. **Split the malformed rule.** `parseCreationHandoff` returns `undefined` on anything malformed and
   its comment defends it: *"a corrupt handoff is exactly a project that should stop offering to
   build itself."* Right for a **brief**, catastrophic for a **plan** — clearing on a corrupt plan
   strands a half-built project with no resume. Malformed brief ⇒ clear everything. Malformed or
   unknown-version plan ⇒ **drop the plan, keep the brief** ⇒ falls back to today's single turn.

Cap the plan on the way in like the brief: `phases.length <= 8`, ids from the enum, `next` clamped to
`[0, phases.length]`, `done.length <= phases.length`.

### Turn kind — keep `isFirstBuildTurn`, add one orthogonal fact

**`isFirstBuildTurn` stays exactly as it is and stays TRUE for every phase.** Every phase message
carries `CREATION_BRIEF_MARKER`, so `carriesCreationBrief` (`proxy.ts:461`) is untouched,
`first-build-turn.spec.ts`'s twelve paired assertions stay green, and — decisively —
`describeTurnOutcome` keeps working on phases 2–4 (it returns `finished` for any non-first-build turn,
so a naive phase-2 turn could never report `incomplete`).

Add one fact that only new consumers read:

```ts
// api.agent.ts — forwarded RAW (the toolkitSystems precedent: the proxy owns the parse)
creationPhase?: string;

// proxy.ts, immediately after line 718
const creationPhase = isFirstBuildTurn ? parseCreationPhaseId(request.creationPhase) : null;
```

Gating the parse on `isFirstBuildTurn` means a forged `creationPhase` on an ordinary edit buys
nothing — the same containment as the forged-marker analysis already in that doc comment.

**The twelve behaviours split cleanly:**

| stays on `isFirstBuildTurn` (10) | moves to `creationPhase` (2) |
|---|---|
| skill preload, sticky-skill suppression, `offerLoadSkill:false`, `owesFiles`, the completeness pass, `isFailedBuildTurn`, `decideModelTier`, `discussModeNote`, `statusKindFor`, client `creationTurnStore` | `toolPolicyForTurn` (art needs media), `mediaProtocolNote` |

Ten are *protections that apply to every creation turn*; two are *what this turn is for*.

> **Bonus saving:** `preloadSkills` inlines `bt-landing` + `bt-design` at ~17.6k tokens — **46% of
> the current prefix**. Today the game phase pays for `bt-landing` it never uses. Inline per phase
> need: game gets neither, frontend gets both. See the ⚠️ cache note in "Traps" before assuming this
> is free.

### The brief splits into FACTS and TASKS

`buildCreationBrief` (`create-project.ts:407`) ends with a **"Your task now"** section — that section
*is* the monolith. It moves into `CREATION_PHASES[].task`. What stays in the brief is what is true
about the moment of creation: title, starter shell, scaffolded class + play contract, images on disk,
content policy, read-only zones.

A phase message:

```
[Model: …]\n\n[Provider: …]\n\n
{CREATION_BRIEF_MARKER} Do not re-create it.

**Step 2 of 4 — the front end.**
{CREATION_PHASES[1].task}
The project facts are in the brief earlier in this conversation.
Do NOT rewrite files that are already correct — emit only what this step owes.
```

That last line is lifted in spirit from `CREATION_COMPLETION_PROMPT`, whose comment already records
it as *"load-bearing, not politeness"*.

**Existing rows keep the old brief text and, having no `plan`, behave exactly as today.**

---

## Stage 2 — The split (game → frontend), client auto-advance

*Demo: a real creation runs two visible phases, no step exceeds ~20k output, no `max_tokens`.*

Reuse the auto-repair shape exactly — a **pure decider** plus an effect that fires `append` when
`!isLoading`. That is the one existing mechanism that starts a generation with no user action
(`auto-repair.ts` + the effect at `Chat.client.tsx:903-936`).

```ts
// app/lib/chat/creation-plan-runner.ts
export function decideNextCreationTurn(input: {
  plan: CreationPlan | null;
  projectId: string | undefined;
  isLoading: boolean;
  hasError: boolean;          // sendMessage truncates the messages array on error
  armedIndex: number | null;  // set by onFinish once actions settled — the latch
  lastOutcome: TurnOutcomeState | null;
  paused: PauseReason | null;
}): { kind: 'run'; index: number } | { kind: 'pause'; reason: PauseReason } | { kind: 'done' } | { kind: 'wait' };
```

Every non-`run` branch is a way to spend money the user did not authorise or to collide with an
in-flight generation — same category as `decideAutoRepair`, same exhaustive mutation-verified spec.

**Per-phase sequence:**

1. `onFinish` fires; read the outcome from `agentMeta`.
2. `outcome.state === 'incomplete'` ⇒ **pause, do not advance.** The existing persistent alert
   already carries a "Finish the build" action.
3. Otherwise `waitForActionsSettled({...})` — the exact call already at `Chat.client.tsx:641`.
4. Settled ⇒ PATCH `{plan: {...plan, next: n+1, done: [...done, record]}}`, update the local store,
   set `armedIndex = n+1`.
5. The effect sees `!isLoading && armedIndex !== null` ⇒ **disarm first** (`armedIndex = null`
   *before* the `append`, the documented rule from the repair effect), then
   `append(phaseMessage, { body: { creationPhase } })`.
6. `next === phases.length` ⇒ `saveCreationHandoff(projectId, null)`, clear the local mode, arm the
   repair watch, arm `creationCompleteRef`, celebrate.

**Read the plan from `newProjectModeStore.get()` inside callbacks, never from a captured render
value** — `useStore` *is* a render capture, which is the documented `projectId: undefined`
post-mortem.

**The 409 is avoided by construction:** `releaseProject?.()` runs in the dataStream `execute`'s
`finally` (`api.agent.ts:220`), after `streamGeneration` has awaited settlement — i.e. the claim is
free before the response body closes, therefore before `onFinish` runs. Step 3 adds a settle wait on
top. A 409 that still happens is not a crash: the plan is persisted, `next` is unadvanced, and the
card offers Continue.

### Files

| path | change |
|---|---|
| `app/lib/agent/creation-plan.ts` | **new** — `CREATION_PHASES`, `parseCreationPlan`, `parseCreationPhaseId` (resolves DOWN), `mergeCreationPlan`, `advanceCreationPlan`, `creationPhaseMessage`, `describeCreationPlan`, `describeCreationPlanOutcome` |
| `app/lib/chat/creation-plan-runner.ts` | **new** — `decideNextCreationTurn` |
| `app/lib/registry/create-project.ts` | `buildCreationBrief` sheds "Your task now" into the phase tasks |
| `app/lib/stores/new-project-mode.ts` | `plan?` field, validated through `parseCreationPlan` (rebuilt field-by-field, never spread); `updateCreationPlan`. ⚠️ **Rewrite, do not delete, the "CLEARED ON SEND" header** — the brief still clears on send; the plan is what outlives it |
| `app/routes/api.projects.$projectId.ts` | accept + cap `plan`; the split malformed rule; monotonic merge |
| `app/lib/.server/projects/types.ts` | `CreationHandoff.plan?` |
| `app/lib/persistence/projects.ts` | `saveCreationHandoff` carries the plan |
| `app/lib/chat/new-project-send.ts` | sibling `composeCreationPhaseTurn` (`parts: undefined`, `annotations: ['hidden']` — mirroring the brief, because `convertToCoreMessages` prefers `parts`) |
| `app/routes/api.agent.ts` | `creationPhase?: string` in the body, forwarded raw |
| `app/lib/.server/agent/proxy.ts` | parse `creationPhase`; pass to tool policy + media note; add it to `agentMeta` |
| `app/lib/.server/agent/tool-policy.ts` | `creationPhase` input; `CREATION_ALLOWS_MEDIA` → `phaseAllowsMedia(phase)` |
| `app/lib/runtime/auto-repair.ts` | `creationPlanActive` ⇒ `{ repair: false, disarm: false }` (see Traps) |
| `app/components/chat/Chat.client.tsx` | mount effect reads `plan`; `onFinish` phase-aware; brief attached to phase 0 only; `body.creationPhase`; one new effect drives the runner |

---

## Stage 3 — The art phase

*Demo: a creation generates its own images, one at a time, with progress, zero refusals.*

Phase 3 turns media **on** for the first time on a creation. Everything needed already shipped in
`c0fa312`: no round budget, one image per call, serialized + spaced 1500ms + 3 attempts per image.

- `phaseAllowsMedia('art') === true` → toolset gains `mediaTools`.
- `maxSteps` for the art phase = `CREATION_TOOL_ROUNDS + MEDIA_IMAGE_ROUNDS + 1`, **derived, never a
  literal** (see Traps).
- `mediaProtocolNote` is emitted on this phase only. It sits past the last cache breakpoint, so it
  costs no prefix invalidation.
- The phase task tells the model to read the art it named in the frontend phase's `DESIGN.md` and
  render it, then wire the returned `/assets/generated/…` paths into the files phase 2 wrote.

Delete or repoint `CREATION_MEDIA_STEPS` (`tool-policy.ts:26`) while here — it has no reader and its
comment describes a policy the file elsewhere reverses.

---

## Stage 4 — The verify phase

*Demo: creation ends by proving the project compiles, and fixes it if not.*

This phase is **not a model turn unless it needs to be** — it is a client action plus a conditional
repair turn, which is why it is cheap.

1. Run `npm run build` in the sandbox (allow-listed: `npm run <script>`). The script is
   `tsc -b && vite build`.
2. Parse the output with the **existing** `app/lib/share/build-failure.ts` — it already extracts a
   headline naming file and line, cuts the log from the tail, and strips ANSI. Do not write a second
   parser.
3. Clean build ⇒ mark the phase `finished`, complete the plan.
4. Errors ⇒ post a repair turn using the existing plumbing: `body: { errors, repairOf, repairAttempt }`
   → `buildRepairMessage` (`proxy.ts:858-865`), effort escalates to `high` via `effort-policy.ts`,
   capped by `MAX_REPAIR_TURNS = 2`. Re-run the build after. Still failing after the cap ⇒ pause with
   the compiler output **rendered in the card, not a toast** (the `build-failure.ts` lesson).

This is the same shape as the existing auto-repair loop, pointed at build errors instead of preview
errors — and it is the only phase that can honestly say *"it compiles"*, which is Definition-of-Done
item 6 in FRESH-START.

---

## Stage 5 — Resume and the progress UI

**Mount** (`Chat.client.tsx:382-411`) already hydrates the local mode and falls back to the row.
Extend it to read `plan`. `plan && plan.next < plan.phases.length` ⇒ mid-creation ⇒ card renders in
`continue` state. **Nothing fires automatically** (owner's choice, and it is also the
`spec/fail-loud.md` position — an automatic paid generation on page load, days later, on a device
opened only to look).

`decideCreationHandoff` grows from two kinds to four: `build`, `describe`, `running`, `continue` —
**in the same commit as the mode change**, or the default card copy actively offers to build a
project that is already building.

```
Your build paused at step 2 of 4
  1  Game code    ✓ done
  2  Front end    ⟳ paused — out of credits
  3  Art            · pending
  4  Verify         · pending

  [ Continue the build ]     …or just tell me what to do next.
```

**A normal message while a plan is paused abandons the plan** (`saveCreationHandoff(id, null)`) — the
user has taken the wheel, and a plan that can fire days after they moved on is worse than no plan.

**Crash mid-phase-0, before the PATCH.** Resume re-runs phase 0 and must not re-append the brief into
an uncached history. Guard with the same exact-string check `carriesCreationBrief` performs — not a
classifier:

```ts
const briefAlreadyPosted = messages.some(m => m.role === 'user' && String(m.content).includes(CREATION_BRIEF_MARKER));
```

**During a phase**, the existing liveness panel becomes phase-aware: `phaseIndex` / `phaseTotal` /
`phaseLabel` on the heartbeat status, and a **per-phase `typicalMs`** in `delivery.ts` (a
whole-creation baseline against a 2-minute phase makes the expectation bar dishonest). The bar still
never fills — `PROGRESS_CAP < 1`, asserted against the literal, because that test was vacuous on its
first pass and only mutation testing caught it.

> Writing your game code · step 1 of 4 · 47s

`statusKindFor` stays `'creation'`. Between phases the card is a persistent progress strip, **never a
toast** — a build the user walks away from is exactly the case that must still be saying so when they
come back.

---

## Billing

Per-turn settlement is unchanged, and that is an improvement: N phases = N `generations` rows, each
with its own `steps` jsonb, `tool_rounds`, `duration_ms`, `finish_reason`. That is FRESH-START's
"partial credit" and "diagnosable" for free, and it is why no `job_steps` table is needed.

`billedUsage` (`gate.ts:181`) already bills cache-creation at the **read** rate, so re-sending the
prefix per phase is cheap for the customer.

Three decisions:

1. **Phase 0 carries `minimumCredits`** — the one permitted stopper, at the moment nothing is
   half-made, matching the `project_create` rule exactly. The lever exists and is tested but uncalled
   (`gate.ts:44-57`). ⚠️ **Its refusal copy is stale** (written for the retired flat charge — *"Creating
   a new project costs N credits"*); the copy must move with the lever. **Ship
   `CREATION_MIN_CREDITS` defaulting to `0` (disabled)** and set the number from ten measured
   creations — inventing it now refuses paying users on a guess, the same reason the cache warmer
   ships default-off.
2. **Phases 1–3 run the ordinary gate.** A 402 there strands nothing: the plan is persisted, the card
   is honest, exposure stays bounded at one generation. **Do not invent a negative-allowed path for
   later phases** — that trades a bounded visible pause for unbounded silent debt.
3. **Neither `flatCredits` nor `maxCredits`.** `CREATION_FLAT_CREDITS` is already refused with a
   `NotConfiguredError`; re-attaching a price to `isFirstBuildTurn` undoes the 2026-07-29 decoupling
   and restores the forged-marker pricing exploit. A per-phase cap is worse than useless — it *hides*
   a planning bug that should be fixed by re-scoping the phase.

**Expected cost.** Phasing does not shrink total output; it makes it fit. The saving comes from
elsewhere: `gen_mskc4r0y` spent **≈32% of its entire bill** on the completeness pass (105,827
uncached input re-sending the truncated artifact, plus a second full 37,689-token cache write). Under
phases that pass should almost never fire. **Budget the measurement, not the promise.**

---

## Traps — every one of these has already fired in this repo

1. **🔴 The verdict will go quiet, and silence will read as health.** `describeTurnOutcome` is defined
   against the shape of the monolithic failure — `truncatedByLength`, `completionPassWroteFiles`,
   `forcedContinuation`. Under phases all three approach zero. That is *exactly* the `wastedOutput`
   mistake, which reported zero waste on the most expensive generation in the product, in good faith,
   forever. Two required consequences:
   - **A plan-level verdict.** `describeTurnOutcome` answers for one turn; a creation with two
     `finished` turns and a pause on phase 3 is a broken project made of healthy turns. Add
     `describeCreationPlanOutcome(plan)` — same pure, shared, three-state shape, computed from
     `plan.done` + `plan.next`. `incomplete` still outranks `rescued`.
   - **Watch the rates.** Alert on `finish_reason === 'length'` and on the completeness pass firing,
     scoped to creation phases. A detector that stops firing must be *observed* stopping.
2. **🔴 Auto-repair must be disarmed while phases remain.** Mid-creation compile errors are *normal* —
   phase 2 can import an image phase 3 has not rendered. `decideAutoRepair` fires on any
   `source: 'preview'` alert in the window, so today it would fire between every pair of phases,
   bill the user to "fix" what the next phase fixes, and collide for the in-flight claim. Fix it in
   the **pure function**, not the effect. `disarm: false`, not `true` — the watch must survive to
   cover the last phase.
3. **A shared ceiling is DERIVED, never hand-maintained.** This has fired twice already (`read_file`
   joining the creation toolset without re-deriving `CREATION_TOOL_ROUNDS` — 74,524 cache tokens,
   `finish=length`, 1,175 credits; then the media budget). Assert as relationships:
   - `ACTIONS_SETTLE_TIMEOUT_MS + PHASE_START_GRACE_MS < STALL_FAIL_MS` (the watchdog calls `stop()`
     at 300s — dead time between phases must not look like a silent stream; set `fakeLoading` for the
     gap so the composer stays locked)
   - art-phase `maxSteps` derived from its budgets
   - `PHASE_MAX_OUTPUT_TOKENS ≈ PROVIDER_COMPLETION_LIMITS.Anthropic / 3`, and `maxTokens` at
     `proxy.ts:1607` derived from it rather than a bare `64_000`
   - a full plan's message count and char total sit inside `HISTORY_WINDOW_TURNS` — if a fifth phase
     is ever added, this is what notices the brief can be windowed out
4. **⚠️ Measure whether a per-phase toolset invalidates the cached prefix.** Anthropic caches
   `tools → system → messages`. If tool *definitions* differ between phases, the art phase may pay a
   full ~38.6k-token cache **write**. Nothing here has measured it, because no two turns of the same
   kind have ever differed in toolset. **Half-day pre-flight:** extend `scripts/cache-probe.mjs` to
   send the platform-exact body twice differing only in the presence of `mediaTools`. Outcome decides
   whether per-phase skill inlining and per-phase media are free or cost one write per creation
   (≈$0.72 platform-absorbed, invisible to the customer). **Do not decide this from the shape of the
   API** — that is precisely the `MAX_MEDIA_ROUNDS` mistake, where a budget was invented for a cost
   that did not exist.
5. **Two writers of "is creation over".** The row wins, the local copy is a cache, the merge is
   monotonic and server-side. State it in the doc comment on **both** sides.
6. **`parsedMessages` is keyed by array index** (`useMessageParser.ts:219`) and `sendMessage` mutates
   the messages array (`:2251`, `:2297`). Verify phase boundaries do not shift indices under
   already-parsed content.

### Incidental findings (fix separately, small)

- **`windowHistory`'s "the first user message is never dropped" is factually false.** `history.ts:260`
  and its comment both assert `messages[0]` is the original brief. Since §4.4a it is the machine-written
  assistant setup artifact (`npm install` + `npm run dev`) — the least valuable message — while the
  user's words and the hidden brief sit at indices 1–2 and are droppable. Nothing breaks at four
  phases, but the guarantee the comment states is not the one the code provides, and the brief becomes
  load-bearing across four turns instead of one. One-line fix: keep the first **user** message.

---

## Verification

**Unit — mutation-verified, every one** (break the code, watch it fail; this repo has caught four
vacuous tests this way):

- `creation-plan.spec.ts` — unknown phase id resolves DOWN; unknown `v` ⇒ no plan; oversized plan
  refused; `next` clamped; **monotonic merge** (drop the `Math.max` ⇒ a test fails); malformed plan
  keeps the brief (drop the split ⇒ a test fails).
- `creation-plan-runner.spec.ts` — never while `isLoading`; never while `error != null`; never twice
  for one index; pauses on `incomplete`; pauses on 402; `done` at the end.
- `auto-repair.spec.ts` — repair suppressed while phases remain, resumes after the last. **Control:**
  with no plan every existing assertion is byte-identical.
- `tool-policy.spec.ts` — art gets media, code phases do not; `maxSteps` asserted as a *relationship*.
- `first-build-turn.spec.ts` — **extend, never weaken.** Behavioural:
  `carriesCreationBrief(phaseMessage('verify'))` is `true`, so all ten protections and the verdict are
  live on phase 4. Structural: the source scan gains `toolPolicyForTurn` / `mediaProtocolNote`
  receiving `creationPhase` as a shorthand binding (`/[{,]\s*creationPhase\s*[,}]/`, never a bare
  `toContain` — that mutation survived once already).
- `message-parser.spec.ts` — Stage 0's ten-open/zero-close test plus its balanced-artifact control.

**Default-deny source scans, each with a control** proving the scanner still sees a violation:

1. Extend `no-prompt-classifier.spec.ts` over `creation-plan.ts`: the phase list and phase task are
   functions of an **index**, never of user text. This would be the fourth classifier.
2. Exactly **one** call site of `composeNewProjectTurn`, guarded by the brief-not-in-transcript check.
3. Nothing outside `creation-plan.ts` constructs a `CreationPlan` object literal.

**Live drive — non-negotiable.** Two data-loss bugs shipped here with 1,109 tests green, and every
defect lived in the wiring *between* correctly-tested pieces.

1. One real creation. Read the per-phase step log: **no phase over ~12–20k output**, **no
   `stop_reason: max_tokens`**, and the `<boltAction>` open/close census **balanced per phase**.
2. **Definition-of-done item 6, the one v1 fails:** diff the files each phase *claims* against the
   sandbox; assert each parses and contains only itself.
3. Kill the tab mid-phase-2. Reopen **in a clean profile on a different device**. Continue. Assert
   the finished project.
4. Run one creation with a balance too low for phase 2 → the pause card, not wreckage.
5. Confirm the art phase actually renders images and wires the paths in.

**Gates:** `pnpm typecheck && pnpm lint:fix && pnpm lint && pnpm test` before each stage lands.

---

## Not building

| | why |
|---|---|
| `creation_jobs` / `creation_steps` tables | The plan is four ints and four strings. Per-step attempts/tokens/duration/finish-reason are **already** recorded — one `generations` row per phase. |
| A model-authored plan turn | An extra turn and an extra failure mode to produce a constant. |
| Server-side phase advancement | The server cannot see disk; `emittedAction` is a sniff of its own outgoing stream. The 2026-07-31 execution-queue poisoning is exactly the case where the server was satisfied and every later action was silently dropped. |
| A skip-detector for narrow requests | The fourth keyword classifier — and one over the *model's own output*, which is worse. Phases 2–4 will correctly write nothing and cost a few hundred output tokens against a warm prefix. Measure it; if material, reword the task, never route. |
| `maxCredits` / `flatCredits` per phase | A cap hides a planning bug. A phase needing one must be re-scoped. |
| Auto-resume on page load | Owner's decision; also the `spec/fail-loud.md` position. |
| Per-phase effort or model escalation | `effort-policy.ts` escalates by turn kind and only upward. A phase ladder is a new spend policy with no measured need. |

---

## Build order

| stage | ends with |
|---|---|
| **0** Parser implicit-close | Ten unclosed opens produce ten correct files. Ships alone. |
| **1** Plan data model + `creationPhase` plumbing | Plan round-trips through the row; a one-phase plan behaves exactly like today. |
| **2** Game → Frontend split + auto-advance | A real creation runs two phases, no `max_tokens`. |
| **3** Art phase | The creation generates and wires its own images. |
| **4** Verify phase | Creation ends having proved the project compiles. |
| **5** Resume card + phase-aware progress | Kill the tab mid-build, reopen anywhere, one click finishes it. |

Stages 0–2 are the reliability fix and are worth shipping before 3–5 exist.
