# Project-First Creation — clone the template, run it, then build the game

> Quick Plan (bt-plan, 2026-07-29). No feature spec file; brief = the owner's message below.
>
> **The brief, verbatim in intent:** New Project should set up the project files ONLY — copy the app
> template, `npm install`, `npm run dev`, show the starter home page. No AI prompt, no landing page, no
> game building yet. Then carry the original prompt into the chat textbox so the user can edit it and
> send, building the game on an already-running base template. *"That makes creation just a repo clone,
> npm install and npm run dev… nothing else should be able to stop the project from getting created."*
>
> **Interview decisions locked in with the owner (2026-07-29):**
> **(a) Billing splits in two.** Creation itself carries a **flat charge (100–200 credits, default 150)**
> — *"a flat credit price for the project creation, period"* — and the build turn that follows bills
> **regular per-token**, like any other turn. The existing 500-credit flat creation price on the
> generation is retired.
> **(b) The first prompt is still NEW PROJECT MODE, visibly.** The textbox holds the user's words alone;
> the machine-written brief (play contract, scaffolded class, available images, chrome/landing
> instruction) is appended **hidden on send**. The UI states the mode.
> **(c) The build turn still does game + landing + chrome** — only its TIMING moves — **but the system
> decides from the request's context** whether the landing/chrome pass is wanted.
> **(d) Title and `<Title>Mode.ts` keep deriving from the prompt at creation** (the prompt is known at
> creation; it simply is not sent to a model).

---

## Codebase Analysis

Three read-only exploration passes (creation flow end-to-end; chat input/seed surfaces; billing,
boot-narration and creation-turn coupling) plus direct reads of the ledger and billing config ground
this plan. Every file:line below was inspected.

### Creation today is already two phases — the seam is half-cut

`runStartProject` (`app/components/chat/Chat.client.tsx:1124-1400`) is explicitly phased. **Phase 1**
(AI-free) registers the project row first (`:1152` — a server sandbox cannot boot without a project
id), mints the chat id (`:1175`), then `createProjectFromRegistry` (`:1222`) runs
starter-fetch → hygiene → §4.4b scaffold → `bootForProject` → `clearInheritedDevServer` →
`mountTemplate` (`app/lib/registry/create-project.ts:168-306`). **Phase 2** (best-effort, always
returns `true`) assembles three messages and calls **`reload(reloadOptions)` at `Chat.client.tsx:1374`
— that single line IS the game build.** Everything this plan wants already exists on the correct side
of that line; the work is removing the line, replacing what it did, and re-homing the money.

`npm install` / `npm run dev` are **not** run by the model: `create-project.ts:317-322` emits a synthetic
assistant message containing `<boltArtifact id="project-setup">` with a `shell` and a `start` action,
committed via `setMessages` (`Chat.client.tsx:1301-1311`) and executed by the message parser's action
runner — **independently of `reload()`**. A New Project that never generates therefore already installs
and runs today. That is the single most important finding: the brief's core ask is mostly a deletion.

The three seeded messages are `1-` (visible user prompt), `2-` (the setup artifact), `3-` (the hidden
brief, `annotations: ['hidden']`). Under this plan `1-` and `3-` stop being written at creation; `3-`
is re-created at send time, and `1-`'s content becomes the textbox value.

### `waitForMountVisible` / `settleAfterCreation` exist for a reason that partly evaporates

`waitForMountVisible` (`app/lib/registry/mount.ts:62`) and `settleAfterCreation`
(`app/lib/registry/settle.ts:70`) are ordered where they are (`Chat.client.tsx:1344`, `:1362`) because
the AI SDK reads a **committed** render for `projectId` and the model must not be shown seven files of
a 78-file tree. With no generation firing at creation, that race is gone for the creation path — but
both waits stay valuable for a different reason: the user is about to look at a file tree and a preview.
They are re-purposed, not deleted. (The `extraMetadataRef` hazard documented at `Chat.client.tsx:1316-1345`
resolves itself here: by the time the user hits send, `activeProjectId` committed long ago.)

### "Creation turn" is one string, read in eleven places — and only ONE of them is billing

`app/lib/.server/agent/proxy.ts:555` computes `isCreationTurn` by sniffing the last user message for
`CREATION_BRIEF_MARKER` (`app/types/creation.ts:15`). That one variable drives:

| line | effect |
|---|---|
| `proxy.ts:567,572` | **flat 500-credit price + pre-flight minimum-balance gate** ← the only billing use |
| `proxy.ts:602` | `decidePremium({isCreationTurn})` → premium/Fable 5 forced OFF (`billing/premium.ts:64-76`) |
| `proxy.ts:730` | `preloadSkills(…, isCreationTurn)` → `bt-landing` + `bt-design` inlined (`preload-skills.ts:219-234`) |
| `proxy.ts:747` | sticky carried skills suppressed |
| `proxy.ts:895` | discuss mode disabled on creation (`discuss-note.ts:34`) |
| `proxy.ts:898` | tool policy → `media-only`, `maxSteps: 3` (`tool-policy.ts:94-97`) |
| `proxy.ts:983` | media protocol note suppressed (the brief carries a richer copy) |
| `proxy.ts:1041` | `offerLoadSkill: !isCreationTurn` |
| `proxy.ts:1683` | `requiresAction` — a creation that emits no `<boltAction>` gets one corrective pass |
| `proxy.ts:1941` | liveness-panel copy (`statusKind: 'creation'`) |
| `Chat.client.tsx:848` | client `creationTurnStore` → premium pill locked (`PremiumToggle.tsx:54,78`), error copy (`:991`) |

**This is the plan's central design point.** The owner's answer — *"regular turn, billed regular"* — is a
statement about **money**. The other ten entries are correctness and latency protections, and the
analysis found each fails **silently** if lost. Two are severe: dropping the premium lock re-opens the
MEASURED Fable-5 failure (KIE buffers the whole answer; a creation-sized artifact exceeds their ~5-minute
gateway window → `finish=error` after 7+ minutes, `billing/premium.ts:38-46`), and dropping the skill
preload restores the draft→`load_skill`→redraft pathology the 29,173-token measurement priced.

So this plan **splits the one variable into two orthogonal facts**, which is also what makes the owner's
(a)+(b) answers consistent rather than contradictory:

- **`isFirstBuildTurn`** (New Project mode) — keeps entries 2-11. Still marker-derived; the marker now
  rides in the hidden brief appended at send.
- **billing** — the generation path loses `creationFlatCredits` entirely; the flat charge moves to
  project creation as its own ledger reason.

Decoupling also *removes* a latent exploit the marker sniff carried: today a user who types the marker
sentence verbatim buys 500-credit flat pricing on an arbitrary turn. Once billing no longer reads the
marker, the worst a forged marker buys is 24KB of inlined skills the user pays tokens for anyway.

### Billing: where a flat creation charge can legally live

`credit_ledger` reasons are pinned in **three lockstep places** — the TS union (`ledger.ts:42`),
`mayGoNegative` (`ledger.ts:138-144`) plus its spec mirror, and a SQL `CHECK` re-added per migration.
`0010_search_ledger_reason.sql` is the exact copyable shape (drop constraint → re-add with the new member),
and its header is also the precedent for *reasoning about* whether a reason may overdraw: `'search'` may,
because the vendor was already paid; `'media'` may not, because it debits **before** spend. **A project-create
charge is the `media` shape** — debited before anything is provisioned, so it must **refuse rather than
overdraw** and must be absent from `mayGoNegative`.

`creationFlatCredits` (`rates.ts:410,420-433`, `DEFAULT_CREATION_FLAT_CREDITS = 500`, env
`CREATION_FLAT_CREDITS`) is the config shape to mirror, including its "ignore a bad override rather than
obey it" validation — the comment at `:427` notes obeying a negative would *credit* the user for creating
a project, which applies identically to the new var.

`POST /api/projects` (`app/routes/api.projects.ts:44+`) is where creation is registered and where the
gate + debit belong. Its DELETE-guard at `:51-58` shows the house style. `rollbackRegisteredProject`
(`app/lib/registry/creation-rollback.ts:49`) already deletes the row on a phase-1 failure (T3b) and is
the natural refund site — it is fire-and-forget and never rejects, which is correct for cleanup but means
the refund must be *inside* the same server route rather than bolted to the client's rollback call.

⚠️ **Tension with the brief, stated rather than hidden:** *"nothing else should be able to stop the project
from getting created"* and "a flat creation charge" cannot both be absolute. The gate refuses **before**
anything is provisioned, so a refusal leaves nothing half-made — a clean, described 402, categorically
different from a mid-creation failure. That is the only permitted stopper this plan adds.

### The textbox, the prompt, and the draft machinery

`input`/`handleInputChange`/`setInput` come from `useChat` (`Chat.client.tsx:368-382`), seeded from the
`cachedPrompt` cookie (`:596`). Two established ways to set it programmatically: `setInput` directly
(`:1486,1821`) or a synthetic change event (`:1765-1769`, `BaseChat.tsx:214-218`) — the latter also fires
`debouncedCachePrompt` (`:1468-1474`), so it persists across a reload.

🔴 **The trap:** `clearDraftPrompt()` (`:1483-1487`) cancels the debounce, deletes the cookie and calls
`setInput('')` — and the creation path calls it at **`:1376`, immediately after `reload()`**. A prefill
written before that line is wiped. Ordering here is load-bearing.

`projectSeedStore` (`app/lib/stores/project.ts:12-29`) **already retains the original prompt** — it is
written once at `Chat.client.tsx:1284` and its `prompt` field exists precisely so a re-seed can re-run it
(`project.ts:20-21`). The carry-over needs no new storage, only a new consumer. `StartedFromChip`
(`BaseChat.tsx:398-401`) is the one existing surface that renders above the messages on a *started*
project — the right slot for a New Project mode banner. `NewChatIntro` is gated on `messages.length === 0`
(`BaseChat.tsx:408`) and will not fire, since the setup artifact message is present.

**Nothing focuses the textarea programmatically today** — the only `textareaRef` calls are `blur()` after
send (`:1381,1678,1731`), the auto-resize effect (`:1012-1023`) and `scrollTextArea` (`:895-901`). A
prefill-and-focus needs a new `focus()` + `setSelectionRange`, and must not be followed by the creation
path's existing `blur()` at `:1381`.

**Chat identity survives the change.** `description` derives from `firstArtifact?.title ?? summarizeRequest(firstUserMessage)`
(`useChatHistory.ts:2088-2110`) — the setup artifact carries the project title, so the sidebar entry
(which requires BOTH `urlId` and `description`, `chat-slug.ts:4-7`) is still minted with no user message
present. The user's build prompt then becomes the first user message, which `history.ts:216-263` never
drops — arguably more correct than today, where the never-dropped "original brief" is a message the user
never sent.

### Getting the app running without a generation — the machinery exists

The resume path already does exactly what creation now needs: `prepareMountedProject`
(`useChatHistory.ts:660-695`) → optional `awaitRunningPreview` port-replay wait
(`app/lib/persistence/port-settle.ts`, pure + injected clock) → `installDependencies` (`:687`) →
`startDevServer` (`:690`), with `shouldStartDevServer` (`dependencies.ts:124-136`) refusing to start a
second server. `bootProgress` already models narration phases (`boot-progress.ts:48-67,157-187`) and
`boot-progress.ts:59-67` **already states that the build is deliberately not a splash phase** — this plan
is the change that makes that comment fully true.

`creationCompleteRef` (`Chat.client.tsx:366`, armed `:1372`, consumed `:481-510`) fires the
"🎮 Your game is ready" toast after actions settle. Armed immediately before `reload()`, so removing
`reload()` strands it — it must move to the first build turn or the celebration fires on an empty project.

### "Detect from context whether to build the landing page" — model-decides, never a keyword router

The owner asked the system to *detect by the context of the prompt* whether the landing/chrome pass is
wanted. **This must be the MODEL reading the request, not a keyword table in this repo.** CLAUDE.md
records that lesson twice, expensively: the skills router was a hardcoded substring map where `'ui'`
matched b-**ui**-ld so *"why is my build failing"* inlined a 24KB design skill, and three synced skills
were unroutable entirely — *"what we have now I'd be better off making a prompt library… which defeats
the whole point of skills."* `effort-policy.ts:82-110` states the same rule for spend: decide by turn
KIND, never by reading the prompt, because *"a prose classifier puts the model in charge of the bill."*

The brief therefore **states the choice as an instruction with a stated default** ("this is a fresh
starter; if this reads as a game/experience brief, also do the bt-landing pass — if it is a narrow
request, do only that"), and the model decides. That IS context detection; a regex over the prompt is
what the codebase forbids.

### SPEC.md alignment

**`spec_impact: yes` (inferred).** This changes the §4.4a New Project contract (creation no longer runs a
generation), §4.4/§4.4b two-phase creation, §4.4c (the landing rewrite moves to the first build turn and
becomes conditional), and §4.6/`spec/billing.md` (a new ledger reason, a new flat charge, the retirement
of `CREATION_FLAT_CREDITS` on the generation path). It conforms to: §4.5.3 (two walls — the charge rides
inside `requireUser` on a route that already registers the project), §4.6 (append-only ledger; balance
derived; the new reason may **not** go negative), §5 (no new client-trusted money input), §1.3 principle 0
(every added wait degrades rather than hangs), §4.2.8 (the brief still carries no file bodies, and the
message array shrinks by one visible message per creation).

⚠️ **`NEW_PROJECT.md` documents step 7 (`npm install` → `npm run dev` → preview) as coming AFTER the
landing rewrite (steps 5-6).** The code has always run it before. This plan makes the code order the
documented product behavior and the doc's ordering must be rewritten (T15), not merely appended to.

### Assumptions recorded (not asked, decided here — flag if wrong)

1. **The premium lock stays on the first build turn**, keyed on the new `isFirstBuildTurn`, despite that
   turn billing per-token. Rationale: the measured Fable-5/KIE gateway timeout is a function of ARTIFACT
   SIZE, not of pricing, and the first build turn is still the largest artifact in the product.
2. **The setup artifact message is kept** in the chat (rather than moving install/dev to a direct
   `installDependencies`/`startDevServer` call and leaving the chat empty). Rationale: it is the user's
   visible evidence the project exists, it is what mints the sidebar title with no user message present,
   and it is strictly less change. The alternative is recorded in T5 as considered-and-rejected.
3. **Default `PROJECT_CREATE_CREDITS = 150`** (mid-band of the owner's stated 100-200), env-tunable.

---

## Tasks

### Phase A — creation becomes a clone that always finishes

- [x] **T1** — The `project_create` ledger reason (migration + union + `mayGoNegative` + SQL CHECK)
  - Files: `supabase/migrations/0015_project_create_ledger_reason.sql`, `app/lib/.server/billing/ledger.ts`, `app/lib/.server/billing/ledger-sql.spec.ts`, `app/lib/.server/billing/billing.spec.ts`
  - Details: Copy `0010_search_ledger_reason.sql`'s exact shape — `drop constraint if exists credit_ledger_reason_check` then re-add including `'project_create'`. Add it to the `LedgerReason` union (`ledger.ts:42`). 🔴 **Do NOT add it to `mayGoNegative` (`ledger.ts:138-144`)** — it debits BEFORE anything is provisioned, so it is the `'media'` shape, not the `'search'` shape: it must REFUSE, never overdraw. Write the migration header in the house style, stating that reasoning explicitly (the 0010 header is the model). The debit is not anchored to a `generations` row, so `generation_id` stays null, exactly like `'grant'`.
  - Acceptance: the migration runs clean in the PGlite harness (`ledger-sql.spec.ts`) and a `project_create` row inserts; a `project_create` debit that would drive the balance negative is REJECTED by both the SQL writer and `FsLedger` (mutation-verified: adding it to `mayGoNegative` fails a test); the three lockstep places agree (union, `mayGoNegative`, SQL CHECK) — assert the SQL constraint's member list against the TS union so a future reason cannot be added to one and not the other.

- [x] **T2** — `PROJECT_CREATE_CREDITS` config + the pure charge decision
  - Files: `app/lib/.server/billing/rates.ts`, `app/lib/.server/billing/project-create.ts` (new, PURE), `project-create.spec.ts`, `.env.example`
  - Details: Add `projectCreateCredits` to `BillingConfig`, `DEFAULT_PROJECT_CREATE_CREDITS = 150`, env `PROJECT_CREATE_CREDITS`, validated with the SAME posture as `creationFlatCredits` (`rates.ts:429-433`): `0` is a real value meaning "creation is free", a negative or non-finite override is IGNORED in favour of the default (obeying a negative would CREDIT a user for creating projects — the existing comment at `:427` applies verbatim). Pure `decideProjectCreateCharge({ credits, balance, enforced, byok })` returning `{ charge: number; refuse: boolean; message?: string }`: refuse only when `enforced && !byok && balance < credits`, with a message that NAMES the price and the balance (the `gate.ts:86-95` copy is the model); `credits === 0` never refuses and never writes a ledger row (a zero-value entry is noise, not an audit trail).
  - Acceptance: exhaustive unit tests (free/zero, sufficient, insufficient-enforced, insufficient-unenforced, byok, negative override ignored, non-finite override ignored); `.env.example` documents the var, its default and the 0-disables semantics, in ONE place (the file has a documented history of a var defined twice with different values).

- [x] **T3** — Charge at project registration; refund if creation cannot be completed
  - Files: `app/routes/api.projects.ts`, `app/lib/registry/creation-rollback.ts`, `app/routes/api.projects.$projectId.ts`, route specs
  - Details: In the POST branch (`api.projects.ts:44+`), after `requireUser` and before `store.create`: read the balance, run `decideProjectCreateCharge`, and on `refuse` return **402** with the named price (no row created — a refusal must leave nothing behind). On charge, append the `project_create` debit BEFORE returning, and return the new balance on the response so the client can `applySettlement` without a second round trip (the enhancer's drifted-balance defect, CLAUDE.md §"The enhancer was NOT a hole", is the precedent: a settled charge the UI cannot see reads as a leak). 🔴 **The refund belongs on the SERVER delete path, not the client rollback:** `rollbackRegisteredProject` is fire-and-forget and never rejects (`creation-rollback.ts:49`), so a refund hung off it is a refund that can silently not happen. Refund inside the DELETE handler when the project is deleted **and has never had a completed generation** — that is the observable definition of "creation did not deliver", and it also correctly declines to refund someone who built a game and then deleted the project.
  - Acceptance: route specs pin — insufficient balance under `BILLING_ENFORCED` → 402 naming the price, ZERO project rows written, ZERO ledger rows written; sufficient balance → one `project_create` debit whose `balanceAfter` matches the derived balance, and the project row exists; `PROJECT_CREATE_CREDITS=0` → project created, no ledger row at all; a delete of a project with no completed generation refunds exactly once (mutation: removing the refund fails it; a second delete cannot double-refund); a delete of a project WITH a completed generation refunds nothing.

- [x] **T4** — Retire flat creation pricing from the generation path
  - Files: `app/lib/.server/agent/proxy.ts`, `app/lib/.server/billing/gate.ts`, `app/lib/.server/billing/rates.ts`, `billing.spec.ts`, `spec/billing.md`
  - Details: Remove `creationFlatCredits` from the generation flow — `proxy.ts:567` (the computation), `:572` (`minimumCredits` on the gate) and `:1776-1780` (the flat/`maxCredits` settlement branch) — so the first build turn settles cost-derived like any turn, which is the owner's decision (a). Keep `decideCredits`'s `flat` parameter and its tests: it is a pure, exported money decision and deleting the capability (versus ceasing to pass it) discards a tested lever the operator may want back. 🔴 **`isCreationTurn` must NOT be deleted from `proxy.ts` — only its billing uses.** Rename it `isFirstBuildTurn` in the same commit so the next reader cannot mistake a *pricing* concept for the ten *behavioral* ones it still drives (premium lock, skill preload, tool policy, `requiresAction`, discuss suppression, status copy). Mark `CREATION_FLAT_CREDITS` retired in `rates.ts` and `.env.example` — **refuse it loudly if set**, following the retired-KIE-price-var precedent (a price var nothing reads is a mis-bill waiting to be believed).
  - Acceptance: a generation carrying the brief marker bills cost-derived (mutation: restoring the flat branch fails it); the pre-flight gate no longer refuses a first build turn on a `minimumCredits` threshold; setting `CREATION_FLAT_CREDITS` raises a `NotConfiguredError` naming its replacement; every OTHER `isFirstBuildTurn` consumer keeps its current behavior, asserted (this is the regression surface — one test per consumer, not one test for the rename).

- [x] **T5** — Creation stops firing the build
  - Files: `app/components/chat/Chat.client.tsx` (`runStartProject`), `app/lib/registry/create-project.ts`, specs beside each
  - Details: In phase 2 (`Chat.client.tsx:1282-1382`): **delete the `reload(reloadOptions)` call (`:1374`)**, stop writing the visible `1-` user message and the hidden `3-` brief message (`:1289-1311`) — commit ONLY the `2-` setup artifact — and do not `blur()` the textarea (`:1381`). `buildCreationBrief` (`create-project.ts:372-430`) stays and keeps returning its string, but the string is now handed to New Project mode (T10) instead of a message; it must keep `CREATION_BRIEF_MARKER` **verbatim** (`create-project.ts:397-401` warns why). Move `creationCompleteRef.current = true` (`:1372`) OUT of creation — it belongs to the first build turn (T12). Keep `waitForMountVisible` and `settleAfterCreation`: their AI-race rationale is gone but the user is about to look at this tree, and removing a settle wait is how the mount tail leaks into the next thing that reads the store. **Considered and rejected:** dropping the setup artifact and calling `installDependencies`/`startDevServer` directly — it leaves the chat with zero messages, and since `description` derives from `firstArtifact?.title ?? summarizeRequest(firstUserMessage)` (`useChatHistory.ts:2088-2110`) the chat would be INVISIBLE in the sidebar until the user's first send (`chat-slug.ts:4-7`).
  - Acceptance: a creation drives zero `/api/agent` requests (pinned with a fetch double — mutation: restoring `reload()` fails it) while `npm install` + `npm run dev` still run (the artifact's actions reach the runner); the chat holds exactly one message, an assistant setup artifact; the project appears in the sidebar with the project title (no user message present); `projectSeedStore.prompt` holds the original prompt.

- [x] **T6** — Creation is not "done" until the starter is RUNNING
  - Files: `app/lib/stores/boot-progress.ts`, `app/components/chat/BootScreen.tsx`, `app/components/chat/Chat.client.tsx`, `app/lib/persistence/port-settle.ts` (reuse), specs
  - Details: The brief's success condition is *"showing the starter app template basic home page"*, so the creation splash must cover install and dev-server start rather than coming down while they run in the background. Add `creating-install` ("Installing dependencies…") and `creating-serve` ("Starting your project…") phases to `BootPhase` + `bootPhaseCopy` + `isCreationPhase`'s `creating-` family, written from `runStartProject` after the artifact's actions are queued; wait for the dev-server port with the EXISTING `awaitRunningPreview` (`port-settle.ts`, pure + injected clock). 🔴 **Bounded and degrading, never blocking** (§1.3 principle 0, and the `settleAfterCreation` precedent): a ceiling that is reached is normal and silent — the splash comes down, the project is created, and the preview arrives when it arrives. A creation must never hang on a slow install. On CodeSandbox this is nearly free (`node_modules` is baked into the template — measured `npm install` = 2s "up to date", Vite ready in 402ms); on WebContainer a cold install is the real wait, which is exactly what the narration is for.
  - Acceptance: `boot-progress.spec.ts` covers the two new phases (distinct copy, recognized by `isCreationPhase` — the existing parameterized tests catch a missing case); a spec proves the wait is bounded (a port that never opens still resolves creation, with the splash dismissed) and that a port appearing late is narrated rather than missed; live check: New Project → splash reads Installing → Starting → the preview shows the STOCK starter home page, no generation ran, no credits beyond the flat creation charge.

### Phase B — New Project mode and the carried prompt

- [x] **T7** — New Project mode: the state
  - Files: `app/lib/stores/project.ts` (or a sibling `new-project-mode.ts`), spec beside it
  - Details: A per-project fact — "this project has never been built; the next prompt is its creation brief". It must survive a reload (a user who creates a project, refreshes, then types must still get the brief) and must NOT leak to a different project. Derive it, do not invent a second source of truth: the honest definition is **the project has no completed generation**, and the client already knows an equivalent — `projectSeedStore` is set at creation and the chat has no user messages. Prefer a small explicit store keyed by projectId with a persisted flag, cleared when the first build turn is SENT (not when it finishes — a failed build must not silently drop out of the mode and lose the brief on retry). ⚠️ A slash command must never consume or clear the mode: client commands are intercepted before send (`Chat.client.tsx:1560-1594`) and `/context` on a fresh project is an ordinary thing to type.
  - Acceptance: exhaustive unit tests — set on creation, survives a simulated reload, cleared on the first build send, NOT cleared by a slash command, and scoped per project (opening project B never reports A's mode); mutation-verified.

- [ ] **T8** — Carry the prompt into the textbox
  - Files: `app/components/chat/Chat.client.tsx`, `app/components/chat/ChatBox.tsx` (focus only if needed), spec
  - Details: After creation completes, set the input to the user's original prompt from `projectSeedStore.prompt` (`project.ts:20-21` — it is already stored, no new plumbing), place the caret at the end, and focus the textarea. 🔴 **Ordering is the whole task:** `clearDraftPrompt()` at `Chat.client.tsx:1376` cancels the debounce, deletes the `cachedPrompt` cookie and calls `setInput('')` — the prefill MUST happen after it, or it is silently wiped; and the creation path's `blur()` at `:1381` must not run (T5). Route the prefill through `handleInputChange`'s synthetic-event convention (`:1765-1769`) rather than bare `setInput` so the value also persists to the `cachedPrompt` cookie and survives a reload. Card path (no typed prompt) leaves the box empty — the banner carries the instruction. Nothing focuses this textarea today (`:1012-1023` is resize; `:895-901` is scroll), so add `focus()` + `setSelectionRange(len, len)`.
  - Acceptance: a typed-prompt creation leaves the textbox holding EXACTLY the user's words (no brief text, no boilerplate), caret at end, focused, and the value survives a page reload; a card-path creation leaves it empty; mutation-verified against the ordering trap (moving the prefill before `clearDraftPrompt` fails the test).

- [ ] **T9** — New Project mode: the visible surface
  - Files: `app/components/chat/BaseChat.tsx`, a new `NewProjectBanner.tsx`, `app/components/chat/Chat.client.tsx`
  - Details: The owner asked to *"visibly be in some NEW PROJECT MODE where the prompt is expected to be the game creation brief"*. Render it in the one slot that exists above the messages on a started project — beside/below `StartedFromChip` (`BaseChat.tsx:398-401`); `NewChatIntro` cannot be reused (gated on `messages.length === 0`, `BaseChat.tsx:408`, and the setup artifact makes that false). Copy states the three facts the user needs and nothing else: the starter is running, this next message builds the game, and they can edit it first. Keep it to the §4.1a house style — no new toolbar button, no new fill; this is a transient banner, not a control. It disappears the moment the mode clears (T7).
  - Acceptance: the banner renders only in New Project mode and only on a started project; it disappears after the first build send and does not return on reload; a component spec drives the real gate (present in mode / absent after send), with a control proving an ordinary project never shows it.

- [ ] **T10** — The hidden brief, appended on send
  - Files: `app/components/chat/Chat.client.tsx` (`sendMessage`), `app/lib/registry/create-project.ts` (export `buildCreationBrief`), `app/lib/chat/new-project-send.ts` (new, PURE), spec
  - Details: In `sendMessage`, when New Project mode is active and the message is not a client command, compose the outgoing turn as the user's visible text PLUS the hidden brief — the same shape today's `3-` message has (`Chat.client.tsx:1305-1310`, `annotations: ['hidden']`), so the transcript stays honest about what the user wrote. Make the composition a **pure exported function** (`composeNewProjectTurn({ userText, brief })`): it decides what reaches the model on the most expensive turn in the product, which is the same category as `decideCredits` and `auto-repair` — inline logic here is untestable and silent when wrong. 🔴 The brief MUST carry `CREATION_BRIEF_MARKER` verbatim or ten server behaviors silently regress (see the analysis table; `create-project.ts:397-401`). The brief is built at CREATION time (it needs the scaffolded class name, the on-disk image list, the seeded entry) and stored with the mode (T7) — do not rebuild it at send time from stale state. Clear the mode on send, before the request, so a double-send cannot double-append.
  - Acceptance: pure-unit tests over the composition (marker present, user text preserved byte-exact, hidden annotation set, empty user text handled); an integration spec proves the posted turn carries the marker and the visible message shows only the user's words; a slash command in New Project mode posts NOTHING and leaves the mode intact; a second send does not re-append the brief.

- [ ] **T11** — The brief decides landing + chrome from the request, model-side
  - Files: `app/lib/registry/create-project.ts` (`buildCreationBrief`), spec
  - Details: The owner asked the system to *"detect by the context of the prompt if it should build out the landing page and chrome"*. 🔴 **Implement this as an INSTRUCTION the model resolves, never a keyword table in this repo.** CLAUDE.md records why in detail: the hardcoded skill router matched `'ui'` inside "b**ui**ld" and inlined a 24KB design skill on a debugging question, three synced skills were unroutable, and the fix was to let the model choose from descriptions — *"never re-add a keyword table"*; `effort-policy.ts:82-110` states the same rule for spend ("decide by turn KIND, never by reading the prompt — a prose classifier puts the model in charge of the bill"). Rewrite the brief's task block (`create-project.ts:421-427`) to state the situation (fresh stock starter, nothing designed yet), the DEFAULT (a game/experience brief gets the full bt-landing pass — landing page + `src/custom/**` chrome — plus the game), and the exception (a narrow or non-game request gets only what was asked). Keep the play-contract line, the scaffolded-class facts and the media block unchanged.
  - Acceptance: `create-project.spec.ts` pins that the brief contains the marker, the play contract, the class facts, and BOTH the default and the exception sentences; **a source-scan test (comment-stripped, with a control) fails any keyword/regex classification of the user's prompt introduced in the creation path** — this family of bug has now cost the repo twice and a scan is the only thing that stops the third; live: a game brief produces landing + chrome + game, a narrow request ("just add a rotating cube") does not rewrite the landing page.

- [ ] **T12** — Split the celebration: project ready vs. game ready
  - Files: `app/components/chat/Chat.client.tsx`, spec
  - Details: `creationCompleteRef` (declared `:366`, consumed `:481-510`) fires "🎮 Your game is ready — open Preview to play it." It is armed at `:1372` immediately before the now-deleted `reload()`, so left alone it either never fires or fires on an empty starter. Two distinct moments now exist and each deserves its own honest words: **creation** completes with the starter running ("Your project is ready — describe your game below to build it", aligned with the banner) and **the first build turn** completes with the game ("🎮 Your game is ready…"). Arm the ref at the first build SEND (T10), not at creation. ⚠️ The existing consumer already waits for queued actions to settle before claiming success, and honestly reports "still writing N file(s)" otherwise (`:481-510`) — preserve that; it is the difference between a claim and a fact.
  - Acceptance: a creation shows the project-ready message and never the game-ready one (mutation: arming the ref at creation fails it); the first build turn shows the game-ready message after its actions settle; a build that ends mid-write still reports the honest "still writing" variant.

### Phase C — server treatment of the first build turn

- [ ] **T13** — Keep the ten protections, prove each one
  - Files: `app/lib/.server/agent/proxy.ts`, `app/lib/.server/agent/tool-policy.ts`, `app/lib/.server/agent/preload-skills.ts`, `app/lib/.server/billing/premium.ts`, specs beside each
  - Details: Mostly a VERIFICATION task, and deliberately its own task because "we renamed a variable and everything still works" is exactly the claim that needs evidence. With billing detached (T4), confirm the first build turn still gets: premium/Fable 5 forced off (`premium.ts:64-76` — assumption 1 in the analysis: the KIE gateway timeout is a function of artifact size, not price, and this is still the largest artifact in the product), `bt-landing`+`bt-design` inlined (`preload-skills.ts:219-234`), sticky-skill suppression, discuss-mode suppression, the `media-only` bounded loop (`tool-policy.ts:94-97`), `offerLoadSkill: false`, `requiresAction` (`proxy.ts:1683`), and `statusKind: 'creation'` liveness copy. Client mirror: `creationTurnStore` (`Chat.client.tsx:841-849`) must key on the same marker so `PremiumToggle` stays locked (`PremiumToggle.tsx:54,78`) and the error copy at `:991` still says the project survived a failed build — which is now MORE true than it was, since the project genuinely exists and runs before the build is attempted.
  - Acceptance: one test per protection asserting it still fires on a marker-carrying turn AND does not fire on an ordinary turn (ten paired assertions, not one smoke test); the client premium pill is locked in New Project mode and unlocked after; a forged marker on an ordinary turn is proven to buy no PRICING advantage (the exploit the decoupling closes).

### Phase D — docs

- [ ] **T14** — Rewrite `NEW_PROJECT.md` for the new contract
  - Files: `NEW_PROJECT.md`
  - Details: The documented flow is now wrong in its core claim. Path A (`NEW_PROJECT.md:20-33`) says a typed prompt is *"run IMMEDIATELY as the first generation"* — it is now carried to the textbox instead. The "under the hood" ordering (`:70-107`) puts `npm install`/`npm run dev` at step 7 AFTER the landing rewrite; creation now ends there and the design pass moves to the build turn. Rewrite both, describe New Project mode and the hidden brief, and keep the governing precedence rule (`:9-13`, explicit input > inference > guidance) which this change strengthens rather than alters — the user now literally edits the inference before it runs. Note the new flat creation charge and that a refusal happens before anything is provisioned.
  - Acceptance: no statement in `NEW_PROJECT.md` contradicts the shipped flow; the three paths (typed / card / wizard) each describe where their prompt ends up; the 90-second first-playable target is restated against the new two-step shape.

- [ ] **T15** — Update SPEC.md and the sub-specs to match what was built
  - Files: `SPEC.md`, `spec/billing.md`, `CLAUDE.md`
  - Details: SPEC §4.4/§4.4a (creation is AI-free end-to-end and ends with a running starter; New Project mode; the prompt is carried, not fired), §4.4c (the landing/chrome rewrite happens on the first build turn and is model-decided from the request — record the anti-keyword-router constraint with its rationale so it is not "simplified" later), §4.6 + `spec/billing.md` (the `project_create` reason and its refuse-never-overdraw rule, `PROJECT_CREATE_CREDITS`, the retirement of flat creation pricing on the generation path and why the two are not the same charge). CLAUDE.md's creation/billing blocks get the same treatment. Follow the working agreement: **replace/merge** current-state sections, **append** to the Decisions log with rationale (split creation from build; flat creation charge; per-token build; model-decided landing pass; premium lock retained on a per-token turn), never delete history — supersede it.
  - Acceptance: no spec section contradicts the shipped code; the retired `CREATION_FLAT_CREDITS` behavior is superseded rather than silently deleted; the new ledger reason is documented in `spec/billing.md` beside `media`/`search` with its overdraw posture stated; gates green including the doc-adjacent source-scan specs.

---

## How to execute this plan

Each task above is a checkbox. To implement:
- Run a single task with the bt-execute command (e.g. `bt-execute <this-file> T<n>`), run every remaining task in order with `bt-execute <this-file> ALL` (resumable — it skips tasks already checked), or implement the whole plan from a prompt like "implement the plan at <this-file>".
- Work the tasks top to bottom unless a task notes a different dependency order.
- When a task is fully implemented and its **Acceptance** criteria are met, mark it complete by editing this file and changing that task's `- [ ]` to `- [x]`.
- Stop and report if a task cannot be completed. Do NOT check a box for partial, skipped, or unverified work.
