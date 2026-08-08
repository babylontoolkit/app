# Creation cost — Phase 2: on-demand documentation

> Phase 1 **BUILT** 2026-08-07. Phase 2 **BUILT** 2026-08-08 — see "What Phase 2 shipped" below.
> Phases 3–4 remain plans. Supersedes `~/.claude/plans/that-is-not-the-sparkling-teapot.md`.

---

## What Phase 2 shipped (2026-08-08, gates green: 284 files / 5,383 tests)

**The keyword doc router is deleted.** `selectOnDemandBlocks` and `selectStickyBlocks` are gone, the
`keywords: string[]` field is gone from every document, and `allUserTexts` — the haystack a router
would need — is gone from `proxy.ts`. The model chooses from `description` fields via a new
`load_reference(id)` tool (`agent/reference-tools.ts`), reading the same pinned, admin-promoted
snapshot the baked docs came from. This is the fourth keyword table removed from this codebase and
the last one that decided what the model is told.

**Measured, on the live prompt version `pv_20260807122138_f1638e7c`:**

| | chars | ≈ tokens |
|---|---|---|
| base prompt today | 137,969 | 34k |
| — Agent Reference docs leaving it (6 docs) | −88,218 | −22k |
| + the new Reference Library index (30 docs) | +7,457 | +2k |
| **base prompt after** | **57,208** | **14k (−59%)** |
| routed doc blocks pasted into every creation | −246,435 | **−61.6k** |
| **total off the creation prefix** | **−327,196** | **≈ −82k** |

The largest single doc unbaked is `react-framework.md` at 32,076 chars — which contains the Next.js
full-stack guide and the Lovable TanStack adapter, ~13.7 KB of guidance for platforms this is not,
previously in every prompt. (Reported upstream; the doc is authored in `babylontoolkit/agent`.)

**The pieces, and why each is shaped the way it is:**

- `prompt/sources.ts` — `BASE_DOCS` shrinks from 8 docs to **2**: `reference` (the router index the
  Agent Reference maintains for exactly this purpose) and `platform-host` (which prevents a wrong
  action on every turn, so it cannot be loaded on demand). `keywords` → `description`.
- `prompt/reference-index.ts` — the twin of `buildSkillsIndex`: sorted by id, whitespace-collapsed, no
  counts or dates, empty when there are no docs. All four properties exist so the base prompt (the
  platform's most valuable cache entry) cannot be rewritten by a cosmetic edit.
- `agent/reference-tools.ts` — `MAX_REFERENCE_LOADS = 3`, enforced in `execute`, checked BEFORE the
  store read. Never a zod constraint; never enforced by withdrawing the tool. Plus `carriedReferenceIds`,
  which carries what the model loaded into the next turn's cached prefix (append-only, first-seen,
  truncating) over the `blocksLoaded` annotation that already travelled.
- `agent/tool-policy.ts` — the creation turn's `maxSteps` is now **derived** (`CREATION_TOOL_ROUNDS + 1`)
  rather than hand-maintained, so the `+ 1` answer-step rule stays true when a budget moves. The
  historic tool-less one-shot is **gone**: with the docs unbaked, a creation with no tools would write a
  whole game having never seen the API documentation, and nothing would throw.
- The toolset `media-only` is renamed **`creation`** — it holds media + references now, and a name that
  misdescribes a tool set is how a document gets "restored" to a prefix it was never missing from.

**Guards, all mutation-verified (13 mutations, every one caught):** budget removed, budget checked
after the store read, budget charged for carried refs, carried set rotating instead of truncating,
index unsorted, whitespace uncollapsed, empty index still advertising the tool, the load-before-writing
sentence removed, the creation cap hardcoded, the `+1` removed, creation reverted to tool-less, a
keyword table regrown in `sources.ts`, descriptions emptied.

`no-prompt-classifier.spec.ts` now covers the documentation path as well as the creation path, with
its own CONTROL, so the ban this repo states three times finally holds where it failed the fourth.

### ⚠️ Owed before this is real

1. **A doc-sync + promote.** The change is INERT until an admin resyncs: the active prompt version
   still has the old baked content and the old 24 on-demand ids. `load_reference('react-framework')`
   returns "no reference named…" until then — which the tool reports honestly, listing what the version
   does hold.
2. **The live measurement.** Everything above is computed from stored bytes, not observed on a
   generation. Run a creation and read `.data/generations/gen_*.json`.
3. **Output QUALITY, not credits.** The risk token math cannot settle: the model may decline a document
   it needed and write worse Toolkit code. If quality regresses, the fallback is a small fixed set —
   **never a return to keyword routing.**

## Context

A "mario kart racer clone" creation billed **1,489 credits ($3.72)** and wrote **zero files**
(`gen_msixapaq_i871b6`). The owner's question was whether the platform has become too expensive to
sell. The measured answer is that the *architecture* is fine and the *documentation strategy* is not:
the platform bakes ~84k tokens of Babylon Toolkit documentation into every creation, chosen by a
keyword table that matches the platform's own hidden text rather than the user's request.

The owner's own workflow — a five-line `~/.claude/CLAUDE.md` persona, `~/.claude/skills/`, and an
Agent Reference fetched on demand — has run for months across Claude Code, Copilot and Lovable with no
cold-prompt problem. Phase 2 restores that architecture inside the platform.

---

## What Phase 1 shipped (done, gates green)

**1. The customer is never billed for the state of our cache** — `billedUsage` in
`billing/gate.ts`. `decideCredits` prices `cacheCreationTokens` at the READ rate, so a generation
bills the same whether the prefix was hot or cold. `rawCostUsd` and the recorded token columns keep
the TRUE numbers, so the §4.10 margin report still shows exactly what the platform absorbed.

*Measured on the cold creation vector (111,659 prefix / 12,862 output, Sonnet 5 on Anthropic):*
**346 credits → 91 credits**, raw cost unchanged at $0.8629. Pinned by
`billing/cache-neutral-billing.spec.ts` (9 tests), mutation-verified in both directions — reverting
`decideCredits` fails the cache-neutrality test, and routing `rawCostUsd` through `billedUsage` fails
the honesty test.

**2. A build turn that writes no files is a FAILURE, not a success** — `isFailedBuildTurn` +
`NO_FILES_WRITTEN_ERROR` in `agent/unproductive.ts`, thrown in `proxy.ts` after the forced
continuation and the rescue have both had their chance. That 1,489-credit generation settled
`completed`; it now sets `failed`, which routes it to the §4.6 auto-refund.

Supporting fix: `emittedAction` is now a **sticky flag over the raw stream** rather than a substring
test on the length-capped `assistantText` recovery buffer. Harmless while the only reader was the
rescue (worst case, one extra pass); not harmless when the same miss refunds a build that worked.

Both consumers read one `owesFiles` expression, pinned by `first-build-turn.spec.ts` — including that
the verdict runs *after* the rescue, and that `NO_FILES_WRITTEN_ERROR` deliberately does **not** match
the retry ladder's `/returned an empty response/i`.

---

## The measurement Phase 2 rests on

Run against the live prompt store (`pv_20260807122138_f1638e7c`) and the real router
(`selectOnDemandBlocks`), with only ~6 KB of the creation brief as input:

| routed on… | blocks | bytes | tokens |
|---|---|---|---|
| the HIDDEN creation brief alone | 10 | 246,435 | **61.6k** |
| brief + `"mario kart racer clone"` | 10 | 246,435 | 61.6k |
| brief + `"a chess puzzle game"` | 10 | 246,435 | **61.6k — identical** |
| the user's words alone: `"mario kart racer clone"` | 1 | 50,414 | 12.6k |
| the user's words alone: `"a chess puzzle game"` | 0 | 0 | 0 |

**Every creation on this platform gets the same ten documents, including `racing-system` (12.6k
tokens), whether it is a kart racer or a chess game.** The brief swamps the user's request entirely —
the user's own words contribute *nothing* to which documentation the model receives. `"touch"` matches
inside `"untouched defaults"`; `"video"` comes from the word `generate_video`; the phrase `"make me a
kart racing game"` added to the brief on 2026-08-06 (`3e89d81`) pulls in the racing corpus by itself.

This is the fourth instance of a class CLAUDE.md bans three times (skills router, landing-pass rule,
genre inference). It is the only one still live.

### The base prompt, section by section

`137,979` chars. Only **27%** of it is the platform's own rules:

| section | bytes | keep? |
|---|---|---|
| Hard Constraints | 13,844 | ✅ platform |
| Action Protocol | 5,595 | ✅ platform |
| Platform Identity & Knowledge Protocol | 5,811 | ✅ platform |
| Available Skills + Skills | 7,769 | ✅ platform |
| Project's Own Documents / Self-Healing | 4,360 | ✅ platform |
| ALREADY INSTALLED (platform host) | 3,039 | ✅ platform |
| **Agent Reference — ROUTER INDEX** | 7,432 | ✅ **this IS the index** |
| User Interface Instructions | 18,779 | → on demand |
| React Framework | 18,425 | → on demand |
| Interactive Scene Content | 17,350 | → on demand |
| Full Stack Server React Framework (**NEXT.JS**) | 10,366 | → on demand ⚠️ |
| Agent Reference Overview | 8,189 | → on demand |
| Code Generation Instructions | 8,323 | → on demand |
| Agent Training Reference | 5,236 | → on demand |
| **Lovable TanStack Adapter** | 3,365 | → on demand ⚠️ |

⚠️ **13,731 bytes of every generation is documentation for platforms this is not** — a Next.js
full-stack guide and a *Lovable* adapter, in a Vite + React project. Worse than waste: it teaches
patterns that do not apply here. Both live inside `references/react-framework.md`, which is authored
in `babylontoolkit/agent` and is **not ours to edit** — moving that doc on demand resolves it, and the
split is worth reporting upstream.

### The finding that decides the design

The **ROUTER INDEX is already baked into the base prompt**, and it says, in capitals:

> **ALWAYS READ THIS ENTIRE DOCUMENT TO THE END, THEN FETCH THE MATCHING SUB-DOCUMENTS.**
> You **MUST** fetch and read the matching sub-document(s) below BEFORE answering… **If any fetch
> fails, STOP immediately and tell the user.**

**The model has no fetch tool.** It is handed a mandatory routing table it physically cannot act on,
while the platform keyword-matches some of the same documents behind its back and pastes them in.

So Phase 2 is not a new architecture and there is no index to invent. The owner's design is already
90% present in the prompt. **The missing piece is one tool.**

---

## Phase 2 — the work

This is the same fix the codebase already applied to skills on 2026-07-26, when the keyword router was
torn out (`'ui'` matched inside `'build'`) and the model was allowed to choose from descriptions:
measured **6 rounds / 29,173 output tokens → 1 round / 122 tokens**. The doc blocks never received it.

### 2.1 `load_reference(id)` — mirror `load_skill` exactly

New tool beside `load_skill` in `agent/tools.ts`, reading from the same synced prompt version the
baked docs come from (`prompt/store.ts`) — no network, no GitHub, versioned and admin-pinned. Strictly
better than the owner's `WebFetch`, which can fail mid-generation.

Copy the `load_skill` shape, because every part of it is load-bearing:

- **`MAX_REFERENCE_LOADS = 3`, enforced inside `execute`, checked before the store read.** Never a zod
  constraint — a schema violation throws `InvalidToolArgumentsError` and kills the generation *after*
  the tokens are spent. Past the budget the tool returns a refusal naming what is already loaded.
- **Never withdraw the tool to control cost — cap the bodies.** The dangling-instruction failure
  (`spec/skills.md`) is exactly what the ROUTER INDEX is doing today.
- **Sticky per conversation** (`stickyLoadedSkills` pattern): a reference loaded on turn 1 rides the
  cached prefix on turn 2, **append-only in first-seen order**, and the budget counts NEW loads only.
- **`MAX_REFERENCE_LOADS` is arithmetic, not taste** — it must be re-derived together with `maxSteps`
  if either moves, the same pairing `MAX_MEDIA_ROUNDS` and `CREATION_MEDIA_STEPS + 1` have.

### 2.2 Move the docs out of the prefix

`BASE_DOCS` (except the ROUTER INDEX and the platform-host note) and all 24 `ON_DEMAND_BLOCKS` become
loadable ids. The base prompt keeps the platform's rules plus the two indexes.

**Start with ZERO baked docs.** The owner's months of evidence say the model fetches what it needs
when it is told to, and a fixed set is a guess that costs everyone. Add a fixed set back only if the
quality measurement (below) says so — and if it does, `react-training` + `script-component` are the
candidates.

The index must carry the `load_skill` index's load-bearing sentence: **decide and load BEFORE writing.**
A `load_reference` call is ~50 tokens; the 29,173-token measurement was the model *drafting between
rounds and discarding*, at 5× input rate. Loading is cheap; interleaving is not.

### 2.3 Never route on hidden text

Whatever routing survives (ideally none), exclude the `CREATION_BRIEF_MARKER` message from
`allUserTexts` in `proxy.ts`, and pin it with a test asserting the brief cannot select a block. Revert
the `"make me a kart racing game"` phrase in `registry/create-project.ts`.

### 2.4 Delete the keyword table

`selectOnDemandBlocks` / `selectStickyBlocks` and the 25 `keywords:` arrays go with it — along with
the append-only, first-seen-ordered byte-level rules that exist *only* to stop a large prefix
rewriting itself. Extend `no-prompt-classifier.spec.ts` to cover doc selection, so the ban finally
holds everywhere it is stated.

### Expected effect

Removing 22.5k tok of baked docs + 61.6k tok of routed docs takes **~84k tokens off every creation
prefix** — a measured ~212k prefix down to ~128k, **−40%**.

| Sonnet 5 / Anthropic | today | after |
|---|---|---|
| cold prefix write (2× = $6/M) | $1.27 | **$0.77** |
| warm prefix read (0.1× = $0.30/M) | $0.064 | $0.038 |
| **platform absorbs per cold start** (Phase 1) | $1.21 | **$0.73** |

Plus up to 3 tool rounds, each re-reading the warm prefix at ~$0.038 — and each loading only
documentation the model actually asked for.

⚠️ **The risk token math cannot settle:** on demand means the model may decline a doc it needed and
write worse Toolkit code. The measurement below must judge **output quality**, not credits. If quality
regresses, the fallback is a slightly larger fixed set — **never a return to keyword routing.**

---

## Phase 3 — the cache warmer — ⚠️ SUPERSEDED 2026-08-08 by `_specs/cold-start-cost_plan.md` §4

> 🔴 **The verdict below — "almost certainly delete" — stands on arithmetic that is wrong by ~80×, and
> it inverts once the arithmetic is fixed.** Kept, struck through, because a documented conclusion
> nobody can see the reasoning behind is how a retracted number gets acted on a year later.
>
> Two independent errors, in the same direction:
>
> 1. It prices **every** warm cycle as a full cache WRITE. Anthropic refreshes a cache entry's TTL on
>    every READ, so only the first cycle writes and the rest are 0.1×, not 2× — a **20× error**. (That
>    property is Anthropic's documented behaviour and has still never been measured here, which is why
>    item 1 below survives unchanged and is the only part of this section still binding.)
> 2. It prices the **whole ~128k prefix**. A warmer can only warm the blocks that are byte-identical
>    across users — the base prompt and the starter framework files, ~31k tokens. The game-code and
>    per-conversation entries are unique per project and unwarmable by construction — a further **4×
>    error**.
>
> Corrected: **~$0.30/day**, against a hard budget of $2/day. The premise "the platform will not pay
> tens of dollars a day" is still right; it simply never described what this would cost.
>
> ~~**Constraint: the platform will not pay tens of dollars a day to keep a cache warm.** The
> arithmetic agrees and says the warmer should go.~~
>
> ~~| | one warm | continuous 24/7 at 1h TTL |~~
> ~~| today, ~212k prefix | $1.27 | **$30/day** |~~
> ~~| after Phase 2, ~128k prefix | $0.77 | $18/day |~~
>
> ~~Both are refused. And after Phase 2 the warmer costs more than what it prevents: absorbing one cold
> start is $0.73, and running the warmer is 24 of those a day. It only pays for itself above ~24 cold
> starts/day, which live traffic with TTL-refresh-on-hit makes ≈ 0.~~

`cache-warmer.ts:213` returns `none('platform provider is not KIE')` — it has been **dead since the
move to Anthropic**, so nothing in production currently depends on it, and nothing has been warm.

1. **Run `scripts/cache-probe.mjs` against Anthropic FIRST.** Confirm TTL-refresh-on-hit and the
   cold→warm curve on the new prefix shape. No warmer-shaped code is written before that number
   exists. **← still binding, and now the item the whole decision turns on.**
2. If the probe justifies one: route via `getModelInstance` (not KIE's wire), drop the fanout to 1 on
   Anthropic (6 is KIE's per-backend balancer), skip a cycle when the cache was read recently, and
   warm the shared blocks with a byte-identity test — a warmer one space off warms a prefix nobody
   sends. **Hard budget: ≤ $2/day, or it is not built.**
3. Delete `prompt/cache-warmer.ts` only if the probe says a read does NOT refresh the TTL, which puts
   the cost at ~$5.95/day and outside the budget.

Full reasoning, measurements and the warmable-share breakdown: `_specs/cold-start-cost_plan.md` §3–§4.

## Phase 4 — what Phase 2 lets us delete

A ~46k prefix does not need the apparatus a ~212k prefix needed:

- `selectOnDemandBlocks` / `selectStickyBlocks` + the keyword table (Phase 2.4);
- ~~`prompt/cache-warmer.ts` (Phase 3.3)~~ — **withdrawn**, see the Phase 3 correction above: the
  warmer is REVIVED on Anthropic if the probe confirms TTL-refresh-on-hit, not deleted;
- the 4-breakpoint budget — `MAX_CACHE_BREAKPOINTS`, `cache-breakpoints.spec.ts`, the shared-breakpoint
  and stable-zone rules — collapses to 1–2 obvious ones;
- then consolidate the six turn-outcome mechanisms (step budget ↔ media rounds ↔ forced continuation ↔
  unproductive rescue ↔ zero-file verdict ↔ retry tool-mode) into one `decideTurnOutcome` pure function.
  `first-build-turn.spec.ts` exists because a verifier once broke five of them with the suite green.

**Net effect: this removes more code than it adds.** The sandbox seam, artifact pipeline, ledger,
repo-primary persistence, publish/share/remix and the doc **sync** all stay — they are not the cost.
Syncing the docs was correct; baking them into the prefix was not. Those are separable, which is why
none of the doc-sync work is wasted.

---

## Verification

**Unit** — cold and warm bill identical credits while `raw_cost_usd` differs (✅ shipped); a zero-file
build turn refunds (✅ shipped); the creation prefix is **byte-identical across two different user
prompts**; the hidden brief cannot select a block; `MAX_REFERENCE_LOADS` refuses before the store read;
the reference index is sorted and deterministic.

**Live — the only proof that counts.** Run the same prompt twice back to back, then a *different*
genre, and read `.data/generations/gen_*.json`:

- run 2: `cacheCreationTokens ≈ 0`, `cacheReadTokens ≈` full prefix, `finishReason: 'stop'` (no
  `+forced-continuation`);
- the chess prompt loads *chess-relevant* references and **no `racing-system`**;
- a working copy exists containing `src/scripts/*` and a rewritten `Home.tsx`;
- all three runs bill within a few credits of each other.

**Quality gate (do not skip).** Five real creations across different genres, judged on the *game*, not
the credits: does it run, is the GameMode registered, does the play contract hold, is the landing page
coherent? A cheaper prefix that produces worse Toolkit code is a regression, and it is the one failure
this plan can actually cause.

**Gates:** `pnpm typecheck && pnpm lint:fix && pnpm lint && pnpm test`.

## Economics after Phase 1 + 2

| | here | bolt / lovable |
|---|---|---|
| creation (hot **or cold** — one number) | ~90–145 | ~150 |
| follow-up edit / variation | **~11–18** | ~50–150 |

The second row is the one to sell on: a warm edit is 11–18 credits because the prefix is cached and
the history carries no file bodies. A customer iterating on a kart racer is *cheaper* here.
