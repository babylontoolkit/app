# spec/context-budget.md

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
> byte-faithful. The signup grant went from ~5 creations to ~21.
>
> **The trap to not re-introduce:** a tool round is not "one extra API call". It re-prefills the whole
> prompt AND invites the model to throw away everything it has written so far. Before adding a tool to
> the loop, ask whether the thing it fetches could simply be in the cached prefix instead.
 — what the model is allowed to see

> Sub-spec of SPEC §4.2.8. Sibling of `spec/binary-files.md`, and the generalization of it.
>
> **Status: implemented and measured (2026-07).**

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

## Where it lives

| Concern | File |
|---|---|
| The classifier (net-new, zero merge surface) | `app/lib/context/opaque-files.ts` |
| Its tests (both directions) | `app/lib/context/opaque-files.spec.ts` |
| Marker emission | `app/lib/.server/llm/utils.ts` → `createFilesContext` |
| Cache breakpoint + 1h TTL | `app/lib/.server/agent/proxy.ts` |
| Out-of-band mount | `app/lib/registry/mount.ts` → `writeTextFiles` / `writeBinaryFiles` |
| Artifact with no file bodies | `app/lib/registry/create-project.ts` |
| Watcher (keeps the lockfile IN the project) | `app/lib/stores/files.ts` → `watchPaths` |
| Body-strip before POST (keeps it OUT of the wire) | `app/components/chat/Chat.client.tsx` → `agentFiles` |

## How to re-measure (do this on any change to the above)

1. Run one creation in the browser, DevTools open.
2. Grab the `POST /api/agent` response stream; the `8:` annotation lines carry `usage` and `agentMeta`.
3. Compare `promptTokens` (this is the **uncached** count — Anthropic reports cached input separately) + `cacheCreationTokens` + `cacheReadTokens`.
4. A creation that costs more than ~150k **total input tokens** is a regression. Find what got inlined.
