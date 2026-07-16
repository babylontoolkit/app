# spec/context-budget.md — what the model is allowed to see

> ## OUTPUT tokens are a budget too — and on creation they were the bigger one
>
> This document is about what the model READS. The other half of the bill is what it WRITES, and a
> creation turn was spending most of its output on work nobody ever saw.
>
> **Progressive disclosure (`load_skill` on demand) was catastrophic here.** Per-step timings from a
> real "make me a kart racer":
>
> ```
> step 1:  28s |  2,570 out | load_skill          step 5:  51s |  4,221 out | read_skill_resource
> step 2:  27s |  2,015 out | read_skill_resource step 6:  53s |  4,250 out | load_skill
> step 3:  52s |  4,074 out | load_skill          step 7:  86s |  7,768 out | load_skill
> step 4:  51s |  4,275 out | load_skill          step 8: 118s | 13,813 out | ANSWER
> ```
>
> A tool CALL is a JSON argument worth ~50 tokens. Those 29,173 tokens across the tool steps are the
> model **drafting the game, abandoning the draft to fetch a skill, and redrafting** — six times, to
> load exactly ONE distinct skill. That was **75% of the wall clock and 68% of the bill, spent writing
> code the user never saw.**
>
> Two fixes, both measured:
> 1. **Pre-load the skills a request obviously needs** into the CACHED prefix (`preload-skills.ts`).
>    Cache reads bill at 0.1x, so the context is nearly free — and there are no round trips to redraft
>    around.
> 2. **A creation turn runs with NO tools at all** (`CREATION_BRIEF_MARKER` → `allowTools: false`). The
>    brief IS the workflow; there is nothing to look up. The system prompt already said "never load a
>    skill on a project-creation turn" **and the model ignored it four times** — so the capability is
>    removed rather than discouraged. Instructions are not a control.
>
> | "make me a kart racer" | Before | After |
> |---|---|---|
> | Wall clock | 468s | **114s** |
> | Output tokens | 42,986 | **12,862** |
> | Tool rounds | 6 (hit the cap) | **0** |
> | Raw cost | $1.41 | **$0.32** |
> | Credits | 470 | **106** |
>
> Quality was verified unchanged: landing page rewritten from scratch, play contract intact, binaries
> byte-faithful. Cost per creation dropped **470 → 106 credits** (this table's Sonnet-5 measurement; the
> Opus default is ~140 credits warm / ~480 cold — see `rates.ts`), so a fixed signup grant buys ~4.4x
> more creations than before the optimization.
>
> **The trap to not re-introduce:** a tool round is not "one extra API call". It re-prefills the whole
> prompt AND invites the model to throw away everything it has written so far. Before adding a tool to
> the loop, ask whether the thing it fetches could simply be in the cached prefix instead.
>
> ## The same disease, on EDIT turns — and the rule that finally kills it
>
> Fixing creation did not fix editing, and editing was worse. Measured on "change the CTA button's
> colour", against the same project:
>
> ```
> step 1: 30s | 2,641 out | read_skill_resource({skill: 'bt-design', paths: []})
> step 2: 19s | 1,867 out | load_skill({name: 'bt-design'})     <- already loaded
> step 3: 18s | 1,449 out | load_skill({name: 'bt-design'})     <- already loaded
> step 4: 24s | 1,945 out | load_skill({name: 'bt-design'})     <- already loaded
> step 5: 22s | 2,075 out | load_skill({name: 'bt-design'})     <- already loaded
> step 6:  7s |   580 out | load_skill({name: 'bt-design'})     <- already loaded
> step 7: 11s |   888 out | read_skill_resource({..., paths: ['placeholder']})
> step 8: 19s | 1,723 out | ANSWER: ""
> ```
>
> `bt-design` was ALREADY PRE-LOADED into the cached prefix, under a heading reading
> **"ALREADY LOADED — do NOT call load_skill"**. The model called `load_skill` for it five times in a
> row. Each call returned "already loaded, proceed with the task". Each time it called again. Then it
> invented a resource path called `"placeholder"`. It burned all six tool rounds, ~11,000 output
> tokens and two minutes — and returned an **empty string**. The user's file was never touched and
> they were charged 405 credits.
>
> **The rule: a skill is reached EITHER by pre-loading it into the prefix OR by the model fetching it —
> never both at once.** Offering a tool while instructing the model not to use it is not redundancy, it
> is a trap. So `allowTools` is now `!isCreationTurn && preloaded.length === 0 && !slash`: the tools
> exist only on the turn the keyword router could not anticipate, which is the only turn they can help.
>
> We tried the obvious middle ground first — keep `read_skill_resource` (so a pre-loaded skill's
> bundled files stay reachable) and drop only `load_skill`. The model thrashed on the remaining tool
> instead: six rounds, 160s, empty response, pulling in 101KB of hero-scroll templates to change a
> button's colour. **The trap is the tool, not which tool.** See spec/skills.md for the limitation this
> leaves behind and the right way to close it (a resource-level router, not the tool).
>
> Two defects this uncovered, both of which had been silently eating real generations:
>
> 1. **A zod constraint on a tool argument is a loaded gun.** The AI SDK validates arguments BEFORE
>    `execute` runs, and a violation throws `InvalidToolArgumentsError`, which **kills the generation**.
>    `paths: z.array(z.string()).min(1)` died on `paths: []`; `name: z.string()` died on `load_skill({})`.
>    Both burned the user's tokens and returned a zod dump. **A tool argument the model can plausibly
>    get wrong is validated in `execute`, never in the schema** — `execute` can return a sentence the
>    model reads and corrects on its next step. Constrain the schema only where a violation is
>    impossible. (`tools.spec.ts` pins this.)
> 2. **`finishReason: 'stop'` does not mean the model said anything.** That empty answer above was a
>    clean `stop` with 10,054 billed output tokens, `result.text === ''` and `response.messages === []`.
>    Nothing threw. The proxy now treats a generation that produced zero text as a hard failure, which
>    routes it to the §4.6 auto-refund instead of charging for silence.
>
> ## Diff-based edits (`type="edit"`)
>
> With the tool loop out of the way, the remaining cost of an edit turn is the file rewrite itself.
> `type="file"` re-emits the WHOLE file, so cost scales with the size of the FILE rather than the size
> of the CHANGE. `type="edit"` (`app/lib/runtime/edit-blocks.ts`) sends search/replace blocks instead.
>
> Measured end to end — "change the CTA button's colour to a vivid green and make its corners fully
> rounded", against a real 10,532-character `Home.css`:
>
> | | Tool loop + full rewrite | Tools off, full rewrite | **Tools off + `edit`** |
> |---|---|---|---|
> | Wall clock | 121–185s | 47s | **39s** |
> | Output tokens | 10,054–15,881 | 6,522 | **3,958** |
> | Tool rounds | 6 (cap) | 0 | **0** |
> | Result | **empty response** | whole file re-emitted | one block, matched exactly once |
>
> A second probe ("change the headline and add a subtitle") produced 2 blocks across `Home.tsx` and
> `Home.css` — both matched exactly once — in 26s and 1,991 output tokens.
>
> The format is search/replace, NOT a unified diff: `@@ -41,7 +41,9 @@` makes the model count lines and
> carry an offset, and it gets that wrong often enough that the repair turns cost more than the diff
> saved. A search block carries its own anchor, so there is nothing to miscount.
>
> The safety property is that a mis-applied edit is worse than an expensive one — it corrupts a file the
> user never asked to change. So a SEARCH that matches nothing is an error, a SEARCH that matches twice
> is an error (never "take the first one"), and blocks apply **all-or-nothing** to an in-memory copy:
> a half-patched file never reaches disk, even for an instant. There is no fuzzy matching, ever.

> Sub-spec of SPEC §4.2.8. Sibling of `spec/binary-files.md`, and the generalization of it.
>
> **Status: implemented and measured (2026-07).** The headline levers below are built. §"The complete
> lever inventory" and §"Levers that are NOT built" (both added 2026-07-13, after an audit found code
> and spec had drifted apart in both directions) are the parts most likely to be out of date first —
> check them against the code before trusting them.

## The rule

**The artifact is a channel to the MODEL that happens to write files. The WebContainer filesystem is how files reach the project. Never confuse the two.**

Every byte routed through a `boltArtifact` is a byte the model pays to read — on this turn, and on *every* subsequent turn, because the artifact lives in an assistant message and rides the conversation history forever.

This is a **money path**, in the same sense the credit ledger is. A regression here throws no error, fails no build, and breaks no test you would think to write. It silently multiplies the input bill of every generation, forever. Treat it accordingly.

## The measurement that produced this spec

One "make me a kart racer", the acceptance case, on the real starter:

| | Before | After |
|---|---|---|
| Request body | 553,660 B | 181,569 B |
| Uncached prompt tokens | **997,775** | **695** |
| Cache creation | 101,702 | 110,964 |
| Cache read | 102,413 | 0 (single-step run) |
| **Total input tokens** | **1,100,188** | **111,659** |
| Est. cost (Sonnet, in+out) | ≈ **$4.25** | ≈ **$1.35** |

(Costs measured on Sonnet 5, the default at the time. The platform default is now Opus 4.8 — a uniform ~1.67x across every token class — so the "After" creation is ≈ **$2.25** of model spend on Opus. The savings *ratio* the table demonstrates is model-independent.)

Output is now the dominant cost (~69%), which is the correct shape: we pay for what the model *writes*, not for what it *re-reads*.

## The two causes (both structural, neither obvious)

**1. Double representation.** The creation artifact inlined all 51 starter files (258KB, ~70k tokens). The agent proxy *also* sent the same files as a `# Current Project Files` block built from the file map. The model received every file **twice**, and the artifact copy then sat in the history permanently.

**2. Multiplied by the tool loop.** `maxSteps` re-sends the whole prefix on every step (up to `MAX_TOOL_ROUNDS + 1` = 7). An *uncached* file context is therefore paid up to seven times per generation, at full price. This is why "the context is only 140k, that's fine" is the wrong intuition: 140k × 7 = ~1M.

## The three rules

### 1. The creation artifact carries no file bodies

The whole starter — binary *and* text — is written straight to the WebContainer. The artifact carries only `npm install` and `npm run dev`.

The file map, which the watcher populates from exactly those writes, is the **single representation** the model ever sees.

Safe because **restore is snapshot-driven**, not artifact-replay: `useChatHistory` → `restoreSnapshot` → `workbenchStore.restoreFiles(snapshot.files)`. Verify this still holds before changing it.

### 2. Opaque files are declared, never shown

A file can be in the project but not in the conversation for three reasons. All three now get identical treatment — a `<boltFile>` marker carrying path + size, and no body:

| Class | Why | Example |
|---|---|---|
| **binary** | bytes cannot survive UTF-8 encoding | `hero.png`, `havok.wasm` |
| **generated** | correct text; no correct edit exists | `package-lock.json` (218KB) |
| **opaque** | authored, but never by the agent | `public/scripts/twgsl.js` (73KB), `pep.js` (41KB), `glslang.js` (16KB), `*.svg` |

Those three vendor shims alone were **half the starter's entire text payload** — minified WebGPU and pointer-event glue, sent twice per turn, seven times per generation.

**The inverse rule matters just as much.** Everything the agent must READ to do its job stays fully visible: `src/babylon/globals.ts`, `system/platform.tsx`, the `classes/` demo library, `vite.config.ts`, `index.html`. Hiding those would leave the model guessing at the play contract — the exact failure §4.4c exists to prevent. `opaque-files.spec.ts` tests **both** directions, deliberately.

#### Opaque means "not in the conversation", NOT "not in the project"

This distinction is the whole ballgame, and upstream got it wrong in a way that is easy to repeat.

Upstream's watcher excluded `**/package-lock.json` (`app/lib/stores/files.ts`), on the tacit assumption that the file map is a *view for the model*. **It is not — it is the SOURCE every egress path builds from:** ZIP export, GitHub sync, snapshot, and share build all iterate `workbenchStore.files`. A lockfile absent from the map is a lockfile absent from the user's exported project, so a restored snapshot re-resolves its dependencies and can install a *different tree than the one that was tested* — which is exactly the class of failure the exact-pinning work exists to prevent, reintroduced through the back door.

So the two concerns are separated, each handled where it belongs:

| Concern | Where it is handled |
|---|---|
| The project must CONTAIN the file | the watcher — no exclusion beyond `node_modules` / `.git` |
| The model must not READ the file | the context boundary — `createFilesContext` emits a marker |
| The server must not be SHIPPED the file | the client — `stripOpaqueContent` trims bodies out of the POST |

`stripOpaqueContent` returns a **copy**. It trims the map posted to the agent route (a 218KB lockfile on every turn is pure freight, since the model only ever gets a marker for it) and must never mutate `workbenchStore.files`, or the egress paths lose the file again. There is a test for exactly that.

**Verified end to end:** after a project is created, `package-lock.json` appears in the workbench tree, survives a snapshot→restore round-trip, and lands in the exported ZIP as valid JSON (218,135 bytes, 359 packages, `@babylonjs/core@9.16.0`) — while never reaching the model.

### 3. The file context is cached

The `# Current Project Files` block carries a cache breakpoint.

This does **not** contradict §4.3.5's "volatile context last, uncached" ordering. A breakpoint caches the prefix *up to itself*, so the base prompt and the routed doc blocks keep their own cache entries regardless; a file edit invalidates only the file entry. What the breakpoint buys is the **multiplier**: steps 2..n of the tool loop read the project at a tenth of the price instead of full freight.

Budget: Anthropic allows 4 breakpoints. We spend all 4 — base prompt, routed blocks, invoked skill, file context. There are none spare; adding one means taking one away.

### 4. The cache TTL is 1 hour, not 5 minutes

The default `ephemeral` tier expires after **5 minutes**, and an app builder is precisely the workload that defeats it: the user generates a game, then spends several minutes **playing it** before asking for a change. By then the prefix is cold, and the next turn re-writes all ~111k tokens at full price.

That is not paying for a cache. It is paying to *keep creating* one, on every turn, forever — and it is invisible in a single-creation measurement, which is why it survived the first round of this work.

The 1h tier writes at **2×** (vs 1.25×) and reads at **0.1×**. It breaks even on the *second* cached turn and wins on every turn after:

| Ten-turn session | Cache-write cost |
|---|---|
| 5-minute TTL (default) | 10 × 111k × $3.75/M ≈ **$4.16** |
| 1-hour TTL | one write at $6/M + nine reads at $0.30/M ≈ **$0.97** |

**Verified against the live API (2026-07), not assumed:**
- `ttl: '1h'` needs **no beta header** — the extended TTL is GA. (`extended-cache-ttl-2025-04-11` is no longer required.)
- `@ai-sdk/anthropic@1.2.12` passes `cacheControl` through **verbatim** (`getCacheControl` returns the object as given), so `ttl` reaches the wire even though the SDK has no named support for it.
- An entry written with `ttl: '1h'` is still a **cache read seven minutes later** — i.e. it genuinely gets the 1h tier and does not silently fall back to 5m. This is the check to re-run if the SDK is ever upgraded.

**Consequence for billing (Stage 3):** cache creation is billed at **2×**, not 1.25×. Ledger math that assumes the default premium will systematically under-charge every generation.

## Standing rule for every future ingest path

Folder import, git import, remix, asset add, snapshot restore, GitHub sync: **new files must be classified before they can reach the model.** If a code path adds files to a project, it is responsible for deciding whether they are opaque.

The default for anything **generated, vendored, or minified is opaque.**

---

## The complete lever inventory

The sections above tell the story of the big wins. They are not the whole system. An audit (2026-07-13)
found roughly a dozen further levers that exist **only in code** — each one load-bearing, none of them
written down, every one of them removable by a well-meaning refactor that would throw nothing and break
no test. They are listed here so that "why is this here?" has an answer.

**Ordered by what it would cost to lose them.**

### 1. The declaration file is NEVER baked into the prompt

`app/lib/.server/prompt/sources.ts` — `babylon.toolkit.d.ts` is **~490KB (~130k tokens)**. It is synced
for the *editor's* IntelliSense and deliberately kept out of `BASE_DOCS`.

Putting it in the cached prefix would **dwarf every other cost in this document** — it is larger than
the entire post-fix creation context. The instinct that would reintroduce it is a reasonable-sounding
one ("the agent should know the API surface"), which is exactly why it needs to be written down. The
agent learns the API from the Agent Reference prose and the `classes/` demo library, not from a type
dump.

### 2. Attachment limits — an unbounded upload is an unbounded bill

`app/lib/.server/agent/attachments.ts`, enforced in `api.agent.ts` **before the credit gate and before
the model**.

| Limit | Value |
|---|---|
| `MAX_ATTACHMENT_BYTES` | 5,000,000 (5MB) per file |
| `MAX_ATTACHMENT_BYTES_TOTAL` | 20,000,000 (20MB) per message |
| `MAX_ATTACHMENTS` | 8 per message |

**Vision tokens bill through the normal formula, so an unbounded attachment is an unbounded bill on OUR
platform key.** The client's picker (`accept="image/*"`) is a UX affordance, not a control — this is a
plain HTTP endpoint and `curl` does not run our React code.

Two details that look like over-engineering and are not: size is computed by **base64 arithmetic without
decoding** (materialising a claimed gigabyte just to measure it *is* the denial-of-service), and the
declared MIME type must match the actual bytes (**magic-number sniff**, 12 bytes decoded) — because a
caller can label a 40MB video `image/png`.

### 3. The tool set is designed, not assembled

Every one of these came out of a measured failure, and each is a whole wasted generation if removed
(`app/lib/.server/agent/tools.ts`, `proxy.ts`):

- **`MAX_TOOL_ROUNDS = 6`, consumed as `maxSteps: MAX_TOOL_ROUNDS + 1`.** The `+1` is the ANSWER step.
  Handing the model the raw tool cap leaves it no step in which to actually reply.
- **Forced-answer continuation.** If a generation ends on `finishReason: 'tool-calls'` (it hit the cap),
  the proxy re-streams **once** with tools disabled and a "you have used all available tool rounds"
  message. Without it the user gets a preamble and no artifact — a fully wasted generation.
- **`toolChoice: 'none'` on non-tool turns.** Tool *definitions* must still be sent (Anthropic requires
  them whenever history contains `tool_use` blocks); `none` is what forbids new calls.
- **`read_skill_resource` takes an ARRAY of paths.** One-path-per-call made N resources cost N sequential
  round trips — and a round trip re-prefills the entire ~133k-token prompt. Measured: a generation spent
  **all six rounds** paging in one skill's resources, with none left to answer.
- **An already-loaded `load_skill` returns one line**, not the skill body again. Observed: `/bt-spec`
  calling `load_skill('bt-spec')` twice — **17KB each**.
- **Tool descriptions say what the tool is NOT.** Models used `read_skill_resource` as a general file
  reader (observed: burning every round trying to read `SPEC.md`, then hitting the cap with no answer).
- **A miss is reported alongside the hits, with "do not retry with a different path."** A bad path costs
  one cheap correction instead of a whole extra round of guessing.

### 4. Preload bounds — the keyword router must not drag in the library

`app/lib/.server/agent/preload-skills.ts`

- **`MAX_PRELOADED = 2`** — so a keyword-soup prompt cannot pull the entire skill library into the prefix.
- **A creation turn preloads exactly ONE skill (`bt-design`).** The routing text on a creation turn is the
  *brief*, which is full of incidental game vocabulary that keyword-matches skills the model has no use
  for (observed: dragging in `bt-prototype` for an already-scaffolded project).
- **The asymmetry that sets keyword breadth:** a false positive costs cached tokens (0.1×); a false
  negative costs a round trip (~50s plus thousands of redrafted output tokens). Lean toward loading.
- **The preloaded block deliberately OMITS bundled resource paths.** Naming a file the model has no tool
  to open is a dangling instruction, and it caused the 6-round/160s thrash described above.

### 5. Cache-stability guards (a busted cache is a silent 10× on the prefix)

- **The skills index is sorted by name** (`skills/sync.ts`, `store.ts` → `listActive()`). An unstable
  index changes the prefix bytes and **busts the prompt cache on every generation** — a direct hit to
  margin, with nothing in the UI to show for it.
- **Unchanged prompt builds are skipped by content hash** (`prompt/build.ts`), so a no-op doc sync does
  not change the prefix bytes and does not invalidate the cache.
- **Per-STEP usage accounting** (`agent/step-usage.ts`). Billing sums `result.steps`, not `result.usage`
  + `result.providerMetadata` — the latter is last-step-scoped. The bug this caught: a creation logging
  **133,565 cache-read tokens ≈ exactly ONE read** of a 133k prefix, when the tool loop had read it many
  times. Without correct accounting, caching cannot even be measured, let alone billed.

### 6. What never enters the file map at all

- **Template hygiene** (`app/lib/registry/hygiene.ts`): `.gitmodules`, `*.tsbuildinfo`, `.git/`,
  `node_modules/`, `.bolt/`, and `Screenshot.png` — **2.9MB** — are never mounted, so they never reach
  the map, the model, a snapshot, or an export.
- **`IGNORE_PATTERNS`** (`llm/constants.ts`, applied in `createFilesContext`): `node_modules/**`,
  `.git/**`, `dist/**`, `build/**`, `coverage/**`, `**/*.log`, lockfiles, etc.
- **Binaries carry `content: ''` in the FilesStore itself** (`stores/files.ts`); bytes live in the
  WebContainer and are read back via `readBinaryFile()`. See `spec/binary-files.md`.
- **`type="edit"` refuses binaries** (`action-runner.ts`) — there are no bytes to write a SEARCH block
  against.

### 7. Output-side caps

- **`maxTokens: 64_000` on every agent generation** (`proxy.ts`).
- **Repair error output is truncated to 8,000 characters** (`proxy.ts`) before it enters the prompt. A
  Vite error cascade is unbounded, and it arrives on the turn we can least afford to inflate.
- **`PROVIDER_COMPLETION_LIMITS.Anthropic = 64000` is a FLOOR, not a ceiling** (`llm/constants.ts`) —
  consulted only when a model's real cap is unknown, i.e. exactly when pessimism is correct. Undershooting
  truncates; overshooting is a 400. Do not "helpfully" raise it. (§4.2a, `spec/anthropic-models.md`.)
- **The prompt enhancer caps input at 10,000 characters** (`routes/api.enhancer.ts`). The prompt is echoed
  into the model, so its length *is* the bill.

### 8. Rules that live in the system prompt, not in code

These are enforced by prose, so they are invisible to grep — and they are the first thing a prompt edit
can silently delete:

- `prompt/sections/40-skill-usage.md`: **"The default is ZERO skills"**; **"At most ONE skill per
  generation"**; "Loading is not free: it costs a tool round and a large amount of context"; "Never load
  a skill on a project-creation turn"; and the anti-chain-loading rule ("a skill that names other skills
  as later steps is describing the USER's workflow, not yours").
- `prompt/sections/10-action-protocol.md`: the **default-to-`edit` decision table** — "This is the single
  biggest lever you have on how fast the user gets their result." Full rewrite only when the file does not
  exist or more than ~half of it is changing.

Note the standing lesson from §"The same disease, on EDIT turns": **instructions are not a control.** The
prompt said "never load a skill on a project-creation turn" and the model ignored it four times. Where a
rule can be enforced by removing the capability, enforce it there and keep the prose as explanation.

---

## Wasted tokens and dead time — the taxonomy, and how to see it

Everything above is about not *sending* tokens. This section is about the other failure: tokens we
**did** buy that bought us nothing. Every entry below is a real, measured generation from this project.

### The physics you cannot cache your way out of

Input tokens arrive in parallel and can be cached. **Output tokens leave the model SERIALLY, at roughly
60–110 tok/s.** They are also the most expensive tokens we buy (**5× input**). So output is simultaneously
*most of the bill* and *most of the wall clock*, and the two cannot be traded against each other:

> A generation that emits 44,000 output tokens **cannot** finish in under several minutes. There is no
> cache, no prefix, and no prompt trick that fixes it. The only fix is to emit fewer output tokens.

This is why "make it faster" and "make it cheaper" are the same instruction here, and why a latency
complaint must never be answered with more caching until the step log has been read.

### The taxonomy

| # | Pathology | Measured | Fix, and where it is enforced |
|---|---|---|---|
| 1 | **Redrafting around tool rounds.** Each tool call makes the model abandon its draft, re-read the prefix, and start over. | 29,173 output tokens across 6 tool steps to load **one** distinct skill = **68% of the bill, 75% of the wall clock**, writing code the user never saw. A tool CALL itself is ~50 tokens; the rest is redrafting. | Pre-load into the cached prefix; `allowTools = false` on creation/preloaded/slash turns (`preload-skills.ts`, `proxy.ts`). |
| 2 | **Tokens the user never sees.** Aggregate usage hides this completely. | *(historical — this generation's six-tool-round shape no longer exists; for today's product see §"MEASURED")* One generation billed **44,308 output tokens** whose final visible answer was ~9k → **~35k output tokens** spent on abandoned attempts, re-generated answers after a round cap, and verbose tool preambles. **Today: 1.4–2.1 ch/tok, ~40–60% of output is thinking, ~10.5k tokens on the worst run.** | `steps[].textChars` + the **density** ratio (below). ⚠️ The metric that measured this was **blind to it after the pathology-1 fix** — see §"The metric that went blind". |
| 3 | **Dead air — paying full output rate for reasoning returned as EMPTY text.** `thinking.display` defaults to `"omitted"`. | **90.5s of total silence** before the first byte — not even HTTP headers — on a 152s generation. Billed in full. | `display: 'summarized'` costs nothing extra and turns those tokens into a stream the user watches (`thinkingFetch`, `spec/anthropic-models.md` §3.4). |
| 4 | **A clean `stop` that said nothing.** `finishReason: 'stop'` does not mean the model produced text. | `result.text === ''`, `response.messages === []`, nothing thrown — and **10,054 output tokens billed, 405 credits taken**. | Zero-text is a hard failure → §4.6 auto-refund (`proxy.ts`). |
| 5 | **A tool-argument schema violation killing the generation after the tokens are spent.** The AI SDK validates args BEFORE `execute`; a violation throws `InvalidToolArgumentsError`. | `load_skill({})` killed a real edit turn: **45s and ~3,500 output tokens**, file untouched, user shown a zod dump. | All tool params optional; validate inside `execute`, which can return a correcting sentence the model reads on its next step (`tools.ts`, pinned by `tools.spec.ts`). |
| 6 | **Hitting the tool cap with no step left to answer.** The user gets a preamble and no artifact — a 100% wasted generation. | 6 rounds consumed, empty response. | `maxSteps: MAX_TOOL_ROUNDS + 1` (the `+1` IS the answer step) plus a forced-answer continuation with tools disabled (`proxy.ts`). |
| 7 | **Re-emitting a whole file to change one line.** Cost scales with FILE size, not CHANGE size. | 10,532-character `Home.css`: full rewrite = 6,522 output tokens / 47s. Same edit as one search/replace block = **3,958 tokens / 39s**; a two-file edit landed in **1,991 tokens / 26s**. | `type="edit"` search/replace blocks (`edit-blocks.ts`) + the default-to-`edit` rule in `10-action-protocol.md`. |
| 8 | **Under-thinking — the most expensive saving there is.** A cheaper effort does not return a smaller correct answer; it returns a **confident wrong one**, and the repair turns cost more than the saving. | `effort: low` was 22% cheaper on a creation and, on an edit, **wrote into a read-only project zone** (`src/routing/router.tsx`, §4.4c) and abandoned diff-edits for whole-file rewrites. | `low` is DELETED from `EffortLevel`; `parseEffort()` clamps it back to `medium`. **There is no cheap tier** (`spec/anthropic-models.md` §3.5a). |
| 9 | **Cache churn — paying to keep *creating* a cache rather than read one.** | The 5-minute default TTL expires while the user is playing the game we just built; the next turn re-writes ~111k tokens at full price. Ten turns: **~$4.16 vs ~$0.97**. | `ttl: '1h'` (§"The cache TTL is 1 hour"). |
| 10 | **Re-sending the whole conversation, uncached, forever.** | Turn 5 of a real build: **9,476 → 512 tokens re-sent per turn (−94.6%)** from compaction; a long prose session shaves a further ~49% on top once the turn cap bites. | **Fixed** — compaction + a char cap + a turn cap (`llm/history.ts`, §5 below). |
| 11 | **Dead time that costs ZERO tokens — text we already had, withheld by our own filter.** The bill is not the only thing a generation spends. | Measured on a live creation: the server-side shell-strip buffered EVERY `<boltAction>` until its close tag, including `type="file"`. A 13,776-char game script reached the browser **51 seconds** after the model began sending it, as one lump — 18 text chunks for the whole generation, biggest silences 51.5s / 31.1s / 12.6s. Nothing threw; the artifact was byte-perfect; the product just looked frozen, and the freeze scaled with file size. | **Fixed 2026-07-16** — a file action forwards its opening tag and streams its body on arrival; only `shell`/`start` (which genuinely cannot be judged half-read) still buffer (`agent/shell-strip.ts`). After: **157 chunks, max 222 chars, zero silences ≥2s.** |

**Two things that look like waste and are not.** A **Stop** is not waste: the tokens were really consumed
and are billed for what was spent to the abort point (§4.12). A **hard failure** is waste, but it is *our*
waste — the provider still bills us, and the user is auto-refunded (§4.6). Never "fix" either by charging
the user more.

**⚠️ And one that costs nothing and is still real (pathology 11).** Every other row here is measured in
tokens, which trains the eye to price a defect by its bill — so a defect with a bill of **$0** reads as
"not a problem" and survives. The 51-second freeze cost nothing, changed no bytes, broke no test, and was
the single worst thing about using the product. **A latency complaint must be traced to where the time
actually went** (§"The instrumentation that finds it") — the step log said `92s · 89 tok/s`, entirely
normal, because the time was lost AFTER the model and the server-side log stops at the model. It took a
client-side chunk trace to see it. When someone says "it feels slow", the answer is a measurement, never
an explanation of why it must be fast.

### The instrumentation that finds it

Aggregate numbers hide every pathology above. A generation's total says `44,308 out` and looks like a big
answer; only the step breakdown shows that 35k of it went nowhere. So each generation records
(`GenerationRecord`, `app/lib/.server/billing/generations.ts`):

- **`steps[]`** — per tool round: `ms`, `outTokens`, `inTokens`, `cacheRead`, `cacheWrite`, `tools[]`.
- **`toolRounds`**, **`durationMs`**, **`finishReason`**.
- **`steps[].textChars`** and **`reasoningChars`** — how much TEXT the step actually streamed. Anthropic
  bills thinking + tool-call JSON + text as one `outTokens` number, and only text can reach the user, so
  this is the only exact way to attribute a step's output.
- A log line carrying the **decode rate** (`out tok/s`) and the **density** (`chars text / out token`)
  next to the wall clock — because those two ratios separate the causes of slowness, and they have
  **opposite fixes**:

| Symptom in the step log | Cause | Fix |
|---|---|---|
| Many steps, each with meaningful `outTokens`, few visible in the answer | sequential tool rounds + redrafting | remove/batch the tools (pathology 1) |
| One step, huge `outTokens`, decode rate ~normal, **density ~3.5–4** | the answer itself is too big | emit fewer output tokens — **caching cannot help** (pathology 7) |
| One step, huge `outTokens`, **density well below ~3.5** | we are billed for thinking/redrafting, not artifact | effort policy (pathology 8) — and measure before touching it |
| Long gap before the first byte, low visible output | thinking with `display: omitted` | pathology 3 |

**Billing reads `result.steps`, NOT `result.usage` + `result.providerMetadata`** (`agent/step-usage.ts`) —
the latter is scoped to the LAST step only. The bug this caught: a creation logging **133,565 cache-read
tokens ≈ exactly ONE read** of a 133k prefix, when the tool loop had read it repeatedly. Under-counting
there means both the bill and the diagnostics are wrong, in the same direction, invisibly.
(`step-usage.spec.ts`, `spec/billing.md`.)

### The metric that went blind (2026-07-16)

**A fix can silently disable the metric that measures the thing it fixed.** This one did, and it took
five months to notice because the dashboard read a confident, wrong **zero**.

`wastedOutput()` was defined as *"sum of all-but-last step outputs"* — i.e. **waste means extra steps**.
That was correct when it was written, against the generation in pathology 1: six tool rounds, 29,173
output tokens, one skill loaded.

Then we fixed pathology 1. Pre-loading skills sets `allowTools: false` → `maxSteps: 1`. So a creation now
runs as **exactly one step** — and the metric's `if (steps.length <= 1) return 0` guard fired. The admin
dashboard reported **zero wasted output on every creation**: the most expensive generation in the product
(~44k output tokens ≈ $1.11, ~70% of its own bill). All the money moved inside a single step, where the
metric could not see, and the number that would have told us went quiet instead of loud.

**Why a total can never answer this.** A step's billed `outTokens` bundles three things and Anthropic
reports them as one number:

    outTokens  =  thinking  +  tool-call JSON  +  text
                  (invisible)  (~50 tok)         (the only part that can reach the user)

`display: 'summarized'` does not help: we are billed for the FULL thinking and handed a summary, so the
reasoning we can see is not the reasoning we paid for. There is no provider field that separates them.

**What is exact, free, and sufficient: `textChars`.** We are streaming the text — we can just count it.
Real text runs **~3.5–4 characters per output token**. So:

| Step | Density | Reading |
|---|---|---|
| 44,308 out, ~168,000 chars text | **3.8 ch/tok** | healthy — the bill bought the artifact |
| 44,308 out, ~34,200 chars text (the historical case: ~9k *tokens* of visible answer) | **0.77 ch/tok** | ~35k of that output was thinking/redrafting |
| 8,037 out, 15,049 chars text (a real warm creation, 2026-07-16) | **1.9 ch/tok** | ~half that output was thinking — **this is today's normal**, see §"MEASURED" |
| 5,000 out, **0 chars text** | **0** | produced literally nothing for the user (`silentStepOutputTokens`) |

⚠️ **Read the units.** The pathology-2 figure "visible answer was ~9k" is ~9k **tokens**, not characters
— ≈34,200 chars. Confusing the two makes healthy generations look catastrophic (and is exactly the class
of error that made a chars/4 token estimate come out 38% low elsewhere in this doc). **Density compares
chars to tokens on purpose: `textChars` is exact and free, and tokenizing server-side is neither.**

Two metrics, because they catch different failures: **`silentStepOutputTokens`** (exact — output on steps
that emitted no text at all) catches redrafting across steps; **`charsPerOutputToken`** catches a single
fat step that thought far more than it wrote. The old metric caught only the first, and only when the
first still existed.

**The rule, generalised: when you fix a pathology, re-derive whether its metric still measures it.** A
metric whose definition encodes the SHAPE of the old failure ("waste = extra steps") dies the moment the
shape changes — and it dies reporting zero, which reads as success. Prefer a definition tied to the thing
itself ("output that produced no text") over one tied to the mechanism you happened to see it through.

### MEASURED, 2026-07-16: seven live creations

Nine real creations against `claude-opus-4-8` at `medium` effort, read off the step log and a
client-side chunk trace:

| Run | Genre | out | chars text | Density | Thinking window | Thinking | Cached / written | Cost |
|---|---|---|---|---|---|---|---|---|
| 1 | racing (cold) | 6,050 | 12,615 | 2.1 | — | — | 0 / 146,097 | $1.61 |
| 2 | racing (warm) | 8,037 | 15,049 | 1.9 | — | — | 113,762 / 8,745 | $0.35 |
| 3 | adventure (new blocks) | 7,378 | 15,316 | 2.1 | — | — | 43,269 / 67,267 | $0.88 |
| 4 | adventure (warm) | 6,180 | 12,822 | 2.1 | — | — | 110,536 / **0** | **$0.21** |
| 5 | third-person (new block) | 14,906 | 28,034 | 1.9 | — | — | 43,269 / 70,958 | $1.11 |
| 6 | third-person (warm) | 16,983 | 24,375 | 1.4 | 82s of 189s | **43%** | 114,227 / **0** | $0.49 |
| 7 | racing (warm) | 8,267 | 16,264 | 2.0 | 10s of 93s | **11%** | 113,762 / 175 | $0.27 |
| 8 | third-person (warm) | 24,438 | 31,033 | 1.3 | 157s of 290s | **54%** | 114,227 / **0** | $0.67 |
| 9 | physics (new blocks) | 5,477 | 11,110 | 2.0 | **3.1s of 61s** | **5%** | 43,269 / 56,874 | $0.73 |

**Thinking is 5–54%, scaling with the difficulty of the ask** — not a flat rate. A physics playground
barely thinks (3.1s); a third-person platformer with a character controller thinks for 157s. That is
effort proportional to difficulty, i.e. correct behaviour, not waste. The `~35k` figure is retired: the
heaviest real run spent ~13.2k output tokens thinking.

### ⚠️ `charsPerOutputToken` is calibrated for PROSE and will libel every code generation

**The "~3.5–4 chars/output token" baseline is English text. Our output is TypeScript and CSS, which
tokenize far denser** — punctuation, identifiers and indentation each cost tokens. Measured here, a
near-pure code artifact with almost no thinking (**run 9: 3.1s of thinking**) comes in at **2.0 ch/tok**.
So **~2.0–2.2 IS the healthy baseline for this product**, and a 3.5–4 threshold flags every good
generation as "billed for thinking, not artifact" — a false positive on literally every creation,
reported confidently, forever.

Subtracting the measured thinking window from `outTokens` gives the real code density across runs 6–9:
**2.14 / 2.21 / 2.54 / 2.77** — consistent, and nowhere near 3.8.

**Use the reasoning WINDOW, not density, to price thinking.** It is a direct measurement (`g:` channel
first-to-last timestamp × the decode rate) and needs no per-language constant. Density is an indirect
proxy whose constant depends on what the model is writing — and this product writes code, not prose.
Density is still useful for one thing: a step far below the ~2.0 code baseline (run 8's 1.3) is thinking
heavy. Reading it against 3.8 is what produces the false alarm.

**This is the third time a metric here has confidently encoded a wrong assumption** (`wastedOutput`'s
step-shape, the units error below, and now a prose constant on code). The pattern: **a metric that
requires a magic constant will be wrong the moment the thing it measures changes character.** Prefer the
measurement that needs no constant.

**Caching needs nothing ON A CREATION.** A warm creation hits its whole prefix (`0 written`, runs 4 and
6). Cold starts and new-block genres cost $0.9–1.6 once, then volume erases them. Note runs 3 and 5: a
routed block the prefix has not seen before invalidates everything downstream of it — including the
byte-identical starter file context — because the blocks sit ahead of the file context in the system array.

> 🔴 **The paragraph that used to live here said that ordering "optimises EDIT turns, where files change
> every turn and blocks never do, and must not be fixed." That was WRONG IN BOTH HALVES, and it was
> written from creation data before a single edit turn had ever been measured.** Blocks change PER
> MESSAGE (`selectOnDemandBlocks` is keyed off the user's wording); files often do NOT change (an
> answer-only edit touches nothing). Measured 2026-07-16: **only 1 of 4 edit turns cache-hit**, the rest
> paid ~110–160k writes that nothing read — at 2×, i.e. **worse than not caching at all** — and edits ran
> **6–12× the 65-credit floor** that a warm edit demonstrates. See CLAUDE.md §"THE BIGGEST OPEN NUMBER".
> **Do not act on the old claim OR its inverse without measuring**: reordering may still be right for
> creations and wrong for edits, and sticky/append-only/sorted block routing may beat reordering outright.
> The general lesson is the one this session kept re-learning: **a conclusion drawn from one turn type is
> not a conclusion about the system.**

**⚠️ Thinking spend has ~8× run-to-run variance and CANNOT be tuned from a handful of runs.** Run 6 thought
for 87 seconds; run 7 for 10 — same model, same effort, same prompt shape. Any effort change measured on a
few generations is indistinguishable from that noise. This does not license touching the effort policy: it
prices the eval work. Thinking is worth ~⅓ of COGS, so an output-quality eval suite now has a quantified
payoff rather than being hygiene — and until it exists, "think less" trades unmeasured quality for
unmeasured savings. (Pathology 8 stands: `low` is deleted because the cheaper tier returned confident wrong
answers, so there is no cheap tier waiting to be switched on.)

**Output being most of the bill is the SUCCESS condition, not a pathology.** Input was driven from
1,100,188 → ~110k and most of that now cache-reads at 0.1×; when input is optimised away, output becomes
the majority by arithmetic. Roughly half of it is the artifact itself — the files the user asked for — which
is not waste at any price. Only the thinking half is even a candidate.

**The credit math is confirmed end-to-end:** run 6 billed **163 credits** against an independently derived
raw cost of $0.485 (× 334 = 162). The ledger charges what the generation costs.

---

### ⚠️ Gap: none of these diagnostics survive into production

`public.generations` has columns for tokens, model, credits, and cost — and **no columns for `steps`,
`tool_rounds`, `duration_ms`, or `finish_reason`** (`supabase/migrations/0001_*.sql`). Those fields are
written to the local-FS generation record and **dropped on the floor in Supabase mode**
(`SupabaseGenerationStore.upsert` maps only the columns that exist).

**FIXED (migration `0002_generation_diagnostics.sql`, 2026-07-14).** `public.generations` now carries
`tool_rounds`, `duration_ms`, `finish_reason`, `repair_of` and `steps jsonb`, and
`SupabaseGenerationStore` writes them. Until it did, production could see **that** a generation cost a
lot and never that 68% of it went on redrafting around tool calls — and every number in this document
had to be read by hand out of a browser DevTools stream, which does not scale to noticing a regression
across real users. **Keep writing them:** they are what lets the §4.10 dashboards answer "*why* is this
expensive" rather than only "*how* expensive is it".

---

## 5. The conversation history carries no file bodies (`llm/history.ts`)

**The history is UNCACHED, and that is structural.** All four cache breakpoints sit on the **system**
blocks; the messages come after them, so the conversation is outside the cached prefix. Every byte of
every previous turn is re-sent at **full input rate on every turn, forever**, and the total grows
monotonically with the length of the session.

**Measured on the real conversations in this project: 83–87% of that history is file BODIES** inside
`<boltAction type="file">` blocks in assistant turns. Across six real conversations: **112,121 → 17,174
characters (−85%)**, or roughly **28,030 → 4,294 tokens re-sent on every single turn** — and those were
only *three-message* conversations. The saving compounds with every additional turn.

And every one of those bytes was **redundant**. The current, complete, and *more accurate* contents of
those same files are sent fresh each turn in `# Current Project Files`. The copy in the history is a
snapshot of what the model wrote several turns ago, which may since have been edited, restored, or
deleted. We were paying, repeatedly, for a **stale second copy of something we also send correctly** —
the same **double representation** this document diagnosed for the creation artifact (§"The two causes"),
displaced into the conversation.

So the bodies are stripped from file/edit actions in assistant turns; **the tags survive**, so the model
still knows exactly which files it created and edited, and reads their real contents from the file
context. User messages are never touched: what the user said exists nowhere else.

A windowing backstop bounds the growth that scales with *conversation* length rather than file size,
dropping the oldest turns — but **never the first user message**, which is the original brief and the
thing the whole project exists to satisfy. It has two bounds, applied in order: a **char cap**
(`MAX_HISTORY_CHARS`, ~15k tokens) that trims by SIZE, and a **turn cap** (`HISTORY_WINDOW_TURNS`,
env-tunable, default 30 messages; `0` disables it) that trims by COUNT — the char cap alone never fires
on a long session of many *small* messages, so the turn cap keeps the first brief plus the N most-recent
messages and drops the whole turns in between (a message is kept or dropped as a unit, so an assistant
turn is never severed from the request it answered). Measured: turn 5 of a real build is **9,476 → 512
tokens** re-sent per turn from compaction alone; a 61-message prose session is trimmed a further **−49%**
by the turn cap over the char cap alone.

**No summary model call.** Once compaction has stripped the 83–87% that is file bodies, the surviving
prose is small, and a `createSummary`-style round trip would bill its own output tokens on every long
turn — routinely more than the handful of retained messages cost. A straight window is the cheapest
correct option (this is the trade §"Dead levers" below refers to when it points at `createSummary` as a
*starting point*, not working code).

### Why not cache the history instead?

**Because it would cost more, not less.** A breakpoint caches the prefix *up to itself*, so caching the
history requires everything before it to be byte-stable — and it is not: the routed doc blocks, the
invoked skill, and the file context all vary per turn and all sit in `system`, *before* the messages. A
breakpoint on the history would be invalidated on essentially every turn, so we would pay a **2× cache
WRITE** each time in place of a 1× uncached read. Caching it properly means moving the volatile blocks
*after* the history — a real restructure, to be measured against the live API rather than guessed at, and
one that would need a fifth breakpoint or the sacrifice of an existing one. Compaction is orthogonal and
composes with that change if it ever lands.

---

## Splitting a doc on its real seam — the `ui-design-system.md` case (2026-07-16)

**15,595 → 7,739 baked tokens (−50%), nothing rewritten, nothing lost.**

`ui-design-system.md` was the largest doc we baked: 31% of the whole cached prefix. The tempting lever
was "write it more concisely", and that lever does not exist — the doc is **66% code fences**, so
compacting the prose could have reclaimed a few hundred tokens at best. (Same for `react-framework.md`
at 78% and `project-installer.md` at 64%. **Verbiage is never the lever in a reference doc.**)

The real shape of it was that **two documents were living in one file**:

- the UI **architecture** — the Scene Viewer's three layers, the z-index stack, `CustomOverlay`, HUDs,
  popups, modals — which nearly every UI turn needs; and
- the complete `@babylonjs/gui` **API reference** — which most turns never touch. A landing page, a
  React HUD, a gameplay tweak: none of them need `AdvancedDynamicTexture`.

Splitting on that seam moved 7,856 tokens out of the prefix and into an on-demand block
(`references/babylon-gui.md`, agent repo). **The generalisable rule: look for a doc that is really two
documents — one about how the system is put together, one that is an API surface for a specific
technology. The API surface routes; the architecture bakes.**

**Two rules made the split safe, and both must survive:**

1. **The decision matrix stayed BAKED.** It is the routing brain — "health bar above a 3D character →
   GPU GUI, `linkWithMesh`". Route it out and the model no longer knows GPU GUI is even the right
   answer, which is a far worse failure than not having the API.
2. **The baked doc ends with an explicit refusal instruction:** if you need the GPU GUI API and the
   reference is not in front of you, SAY SO — never reconstruct the API from general BabylonJS
   knowledge. A false-negative route is otherwise **silent**: the model invents a control that does not
   exist and the user finds out at runtime.

Keywords come from the decision matrix's own rows (the situations the doc itself says require GPU GUI),
not from imagination, and the phrasings a user actually reaches for — "floating damage numbers", "name
tags over the other players", "make the menu work in VR" — are pinned in `doc-sync.spec.ts`. That test
earned its keep immediately: it caught "make the menu work in VR" matching **nothing**, because the
keyword list had `vr ui` but not `in vr`, and `includes()` makes a bare `vr` unusable (it fires on
"vroom", "servers", "swerve").

---

## Levers that are NOT built

**None outstanding.** The two that were listed here — the unwindowed history and the never-firing
self-healing loop — are both built (§5 above; `auto-repair.ts` / SPEC §4.2 item 7, 2026-07-14). History
windowing was completed with an env-tunable turn cap (`HISTORY_WINDOW_TURNS`) alongside the char cap on
2026-07-15; the deliberate non-choice there is **no summary model call** — see §5.

The remaining known lever, deliberately not taken: **model routing** (Haiku for trivial turns, ~3×
cheaper). It is not a free win — see §3.5a: an under-thinking model does not return a smaller correct
answer, it returns a confident wrong one, and the repair turns cost more than the routing saved. If it is
ever attempted, it must be routed on turn KIND (as the effort policy is), never on a prose classifier.

---

## Dead levers — present in the tree, NOT on the live path

The client posts to `/api/agent` (the platform proxy). Upstream bolt.diy's `/api/chat` and `/api/llmcall`
now **fail closed** (404 unless `UPSTREAM_LLM_ROUTES_ENABLED` — see `app/lib/.server/llm/upstream-routes.ts`
and SPEC §4.5.4), because they had no session check, no credit gate and no settlement.

Everything reachable only from those routes is therefore **dead code**, and must not be mistaken for a live
cost control:

| Looks like a lever | Where | Reality |
|---|---|---|
| `selectContext` — LLM-based file selection ("only 5 files in the context buffer") | `llm/select-context.ts` | only called from `/api/chat` |
| `createSummary` — chat history summarisation | `llm/create-summary.ts` | only called from `/api/chat` |
| last-3-message history slice | `routes/api.chat.ts` | only on the dead path — the proxy does its OWN windowing (`llm/history.ts`, §5), so this is redundant, not a missing lever |
| `simplifyBoltActions` — strips file bodies from assistant history | `llm/utils.ts` | used only by the two above |
| `MAX_RESPONSE_SEGMENTS = 2` + continuation on `finishReason: 'length'` | `llm/constants.ts` | only on the dead path |
| `MAX_TOKENS = 128000` | `llm/constants.ts` | the proxy hardcodes 64k |
| `maxLLMSteps` (MCP setting) | `Chat.client.tsx` → `api.chat.ts` | **still posted by the client on every turn, silently ignored by the proxy** |

If upstream's agent rework is ever pulled in, `select-context` and `create-summary` are the natural
starting points for the history window above — but they are starting points, not working code.

## Where it lives

| Concern | File |
|---|---|
| The classifier (net-new, zero merge surface) | `app/lib/context/opaque-files.ts` |
| Its tests (both directions) | `app/lib/context/opaque-files.spec.ts` |
| Marker emission + `IGNORE_PATTERNS` | `app/lib/.server/llm/utils.ts` → `createFilesContext` |
| Cache breakpoints (all 4) + 1h TTL + `maxTokens` + repair-error truncation | `app/lib/.server/agent/proxy.ts` |
| Per-step usage accounting (how caching is measured at all) | `app/lib/.server/agent/step-usage.ts` |
| Out-of-band mount | `app/lib/registry/mount.ts` → `writeTextFiles` / `writeBinaryFiles` |
| Artifact with no file bodies + short creation brief | `app/lib/registry/create-project.ts` |
| Template junk never mounted (2.9MB `Screenshot.png`) | `app/lib/registry/hygiene.ts` |
| Watcher (keeps the lockfile IN the project) | `app/lib/stores/files.ts` → `watchPaths` |
| Body-strip before POST (keeps it OUT of the wire) | `app/components/chat/Chat.client.tsx` → `agentFiles` |
| Tool-set design (rounds, batching, forced answer, `toolChoice`) | `app/lib/.server/agent/tools.ts` |
| Preload bounds (`MAX_PRELOADED`, creation = 1 skill) | `app/lib/.server/agent/preload-skills.ts` |
| Effort policy (escalate-only) | `app/lib/.server/agent/effort-policy.ts` |
| Declaration file kept OUT of the prompt (~490KB) | `app/lib/.server/prompt/sources.ts` |
| Attachment limits (vision tokens = unbounded bill) | `app/lib/.server/agent/attachments.ts` |
| Diff edits | `app/lib/runtime/edit-blocks.ts` |
| Skill budget + default-to-`edit` rules (prose) | `app/lib/.server/prompt/sections/40-skill-usage.md`, `10-action-protocol.md` |

## How to re-measure (do this on any change to the above)

1. Run one creation in the browser, DevTools open.
2. Grab the `POST /api/agent` response stream; the `8:` annotation lines carry `usage` and `agentMeta`.
3. Compare `promptTokens` (this is the **uncached** count — Anthropic reports cached input separately) + `cacheCreationTokens` + `cacheReadTokens`.
4. A creation that costs more than ~150k **total input tokens** is a regression. Find what got inlined.
