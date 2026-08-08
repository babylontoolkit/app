# FRESH-START.md

**A rebuild brief for the Babylon Toolkit App Builder, v2.**

This is not a spec. It is (a) what the current system got structurally wrong, (b) the architectural
inversions that fix it, and (c) everything you need to carry across so the rebuild doesn't re-learn
it. Every claim is backed by something that actually happened in v1 — measured, logged, or shipped.

**Read §1 and §2 first.** They are the whole point. Everything after is detail you'll want open
while building.

| | |
|---|---|
| §0.3 | **How v1 got here** — read before optimising anything |
| §1 | Diagnosis — four root causes |
| §2 | The five inversions |
| §3 | The five pillars you asked for |
| §4 | The rest of the product (project contract, templates, persistence, share) |
| §5 | Carry-forward invariants |
| §6 | Do not build these |
| §7 | Build order |
| §8 | Definition of done |
| §9 | Port list — take these files as they are |
| A–C | Data model · env vars · deploy |

---

## 0. The verdict, and the starting point

### 0.1 One paragraph

v1 works. It builds real games. What it cannot do is **tell you whether it is going to finish** —
and that single property is why it feels unreliable *and* why it feels expensive, because a run you
can't trust is a run you pay for twice. The root cause is not the prompt, not the model, and not the
sandbox. It is that **one generation is one monolithic streamed turn that must do everything at
once, with no persisted intermediate state, over a transport where any hiccup loses all of it.**
Nothing in v1 can resume. Nothing can report "step 3 of 7". Everything is all-or-nothing, and the
thing doing the "all" routinely runs four minutes without emitting a byte.

Fix that one property and most of the 40+ invariants in `CLAUDE.md` stop being necessary.

### 0.2 Fork bolt.diy again, or start clean?

**Recommendation: start clean, and port deliberately.**

v1 forked bolt.diy and paid for it continuously. The fork gave you a working chat UI, a file tree,
a terminal and a preview — genuinely valuable, and worth roughly the first three weeks. What it also
gave you, permanently:

- The **artifact text protocol** for file writes (§1.2) — six subsystems exist to contain it
- A **single-user, browser-local** persistence model that had to be unpicked for multi-user
- **~14 unauthenticated outbound routes** that cost money and leaked tokens until audited
- An **unauthenticated RCE** via server-side MCP
- A file layer that **destroys binary bytes** at ingest
- A standing obligation to stay mergeable with an upstream you diverge from every week

None of those are bolt.diy being bad software. They are what happens when a single-user local dev
tool becomes a hosted multi-tenant product.

**What to actually do:** greenfield the app (Remix or Next, your call — Remix if you want the v1
routes to port with minimal edits), and lift the pieces named in §9 file-by-file. They are mostly
pure functions with exhaustive tests and they carry the expensive knowledge. Rebuild the chat UI;
it's a week and you get to design it around the step journal (§2.1) instead of around a stream.

---

### 0.3 How v1 got here — read this before you optimise anything

The single most useful thing in this document, because it is the failure that produced all the
others.

**The prefix was never designed. It accreted, and then it got optimised.**

- The **155k file dump** is bolt.diy's, inherited unexamined. Upstream puts the project's files in
  the prompt; that is `createFilesContext` and it is how the fork works. What made it catastrophic
  here is *our* starter: bolt.diy's templates are ~15 files of Vite + React, and the Babylon Toolkit
  starter is **88**, including a read-only demo class library and a framework system directory. Same
  mechanism, six times the payload.
- The **15k baked doc corpus** was a deliberate decision, and the wrong one. It followed from the
  rule "generations never depend on GitHub at runtime," and it reached **138,660 bytes** before
  anyone measured it.

Then — and this is the part to internalise — **a year went into making that prefix cheaper instead of
asking why it was large.** Cache breakpoints ordered by sharedness. A stable-zone splitter. An
opaque-file classifier. Sticky block routing. History compaction. A duplicate-key fix worth 22.5k
tokens per turn. A cache warmer, and a probe to measure the warmup curve it needed. `MAX_MEDIA_ROUNDS`
and `CREATION_MEDIA_STEPS` to stop the resulting turn eating itself.

Every one of those is real engineering that produced a real, measurable saving. Together they took a
creation from **1,100,188 to 111,659 input tokens** — a 90% cut, and it reads as a triumph.

**It was a 90% cut on a number that should never have existed.** The measurements all pointed the
right way, which is precisely why nobody stopped: an improving metric feels like evidence you are on
the right branch, and it is not. It only tells you that you are moving.

The comparison that would have ended the whole line of work was one line long — *what does every
other agent host do with this exact prompt?* — and it was available from day one, in the next window,
where the owner was using a 150-token persona snippet against the same reference with no cold starts
at all. It was never run. A year of internal measurement, and no external baseline.

**So, three rules for v2:**

1. **Benchmark against the outside before optimising the inside.** Take the flagship prompt, run it
   through a host you do not control, and write the number down. That number is your ceiling. If you
   are 4× off it, you have a design problem and no amount of tuning will close it.
2. **Question inherited mechanisms, especially the ones that work.** The file dump never failed. It
   just cost, silently, on every turn, forever — and it was invisible precisely because it was
   upstream's and therefore assumed correct.
3. **A hard budget beats a clever optimisation.** A CI ceiling on prompt bytes would have caught this
   in week two and forced the design conversation. Every mechanism listed above exists because there
   was no ceiling — so the only available move was to make the overrun cheaper.

---

## 1. Diagnosis — four root causes, not forty bugs

`CLAUDE.md` records roughly forty never-regress rules. That density *is* the finding: they are not
forty independent mistakes, they are **four structural choices, each generating bugs faster than
they could be fixed.**

### 1.1 The monolithic turn

One generation must: read ~170k tokens of context, decide the design, generate art, write the
landing page, write the chrome, write the game code, write the spec, and answer — in a single
streamed response producing 30k+ output tokens.

From your last run:

```
prompt 170,371 · completion 31,692 · total 202,063
step 2: 268,169ms · 25,598 out · 0 chars text · 17,613 chars reasoning
```

| Symptom | Mechanism |
|---|---|
| "Hangs in the middle doing nothing" | Output decodes serially at ~60–110 tok/s. 30k output **cannot** be fast. |
| Provider kills the step | KIE terminates any step emitting no bytes for ~30s. A long think emits nothing. |
| Stuck artifact row, forever | Execution-queue poisoning — one throw killed every later action in the tab. |
| Corrupted source file | A stray `</parameter>` in the text channel lands verbatim in `Home.tsx`. |
| Forced-continuation double-bill | A step claiming `tool-calls` with no tool call re-ran the whole 200k prefix. |
| Half-written project | The model wrote 1 file of 15, said "Writing the full project now.", stopped. |
| No partial credit | There is no record of what succeeded. One turn. It lands or it doesn't. |

**None of these are fixable in place.** They are properties of "one turn does everything."

### 1.2 Files travel through a text channel

v1 writes files by streaming `<boltAction type="file">` in the model's prose channel, parsed
client-side. Inherited from bolt.diy, and the source of an entire bug family:

- `shell-strip.ts` — because the same channel carries shell commands
- `protocol-strip.ts` — because tool-call syntax leaks into prose and lands in source files
- The parser's artifact-close fallback — because the model sometimes emits zero `</boltAction>`
- The execution queue — because parsed actions need serializing
- `NO_REPLAY` marking — because replaying history rewrites files over the user's repo
- History compaction stripping file bodies — because bodies re-send forever otherwise

**Six subsystems exist solely because file contents ride in prose.** A file write is a structured
operation.

### 1.3 The model is shown everything, always

170,371 prompt tokens on a fresh creation, mostly the starter tree dumped in so the model can "see"
the project. That dump is why v1 needed four ordered cache breakpoints, a stable-zone splitter, an
opaque-file classifier, a `CLAUDE.md` promotion path, and a duplicate-key bug that silently cost
22.5k tokens per turn.

The model reads maybe eight files. It is shown eighty-eight.

### 1.4 Long-running work inside the loop

The cleanest example, and the one that broke your last build.

The brief told the model to make all image calls "FIRST, in ONE parallel round." Models don't work
that way — they discover art needs *while designing*. So it made a round, then another, then wanted
a third:

```
step 2: 268,169ms · 25,598 out · 0 chars text · generate_image
WARN  media tool: round budget spent (2/2), call refused   x3
step 4:  23,597ms ·  3,211 out ·  7,165 chars text · ANSWER
```

`MAX_MEDIA_ROUNDS = 2` refused the third. That cap exists because without it a run burned all its
steps on images and **shipped no game at all** (1,489 credits, zero files). So the choice was: refuse
the art, or lose the build. Both bad. Both forced by putting a 20-second-to-4-minute async render
inside a synchronous loop that also has to write your game.

**Your instinct — one at a time, spaced out — was right.** Serializing gives per-image retry, partial
success, visible progress, and zero interaction with the build's budget. Batching saved a few
thousand tokens and cost the reliability of the entire creation path.

---

## 2. The five inversions

### Inversion 1 — Generation is a persisted, resumable **step plan**

The single most important change in this document.

A build is a **job** with a row per step. The server owns it; the client renders it.

```ts
job  { id, projectId, userId, status, createdAt, steps[] }
step { n, kind, status, input, output, attempts, tokens, startedAt, endedAt, error? }
```

A creation:

| # | kind | model? | writes |
|---|---|---|---|
| 1 | `plan` | small | the step list + design brief (structured output) |
| 2 | `game-code` | yes | `src/scripts/**` |
| 3 | `landing` | yes | `src/pages/**` |
| 4 | `chrome` | yes | `src/chrome/**` |
| 5 | `verify` | no | runs `tsc`, collects errors |
| 6 | `repair` | conditional | fixes what `verify` found |

What this buys, none of which v1 can have:

- **Resumable.** Tab dies at step 3? Steps 1–2 are on disk. Resume runs 3–6.
- **Per-step retry.** Step 4 fails → retry step 4, not the build.
- **Honest progress.** "Step 3 of 6 — landing page" is a fact, not a spinner.
- **Bounded output.** No step emits 30k tokens, so no step runs four silent minutes.
- **Partial credit.** A job completing 4 of 6 bills 4 and says so.
- **Diagnosable.** The journal *is* the diagnostic. v1 needed `steps jsonb`, `tool_rounds`,
  `silentStepOutputTokens` and a whole admin report to reconstruct one turn.

Cost is not higher — same work, split — and each step re-reads a **cached** prefix at 0.1× where
v1's forced continuations rewrote it at 2×.

> **Non-negotiable:** the journal is written to durable storage **as each step completes**. If it
> lives only in the streaming response, you have rebuilt v1 with extra tables.

**A step that fails does not kill the job.** Mark it `failed`, record the error, continue to the next
step, and surface it at the end. The only steps that may halt a job are ones later steps genuinely
cannot proceed without — and there are almost none.

### Inversion 2 — Files are written by tool calls, never by prose

```ts
write_file({ path, content })
edit_file({ path, find, replace })
read_file({ path })
```

Deletes `shell-strip`, `protocol-strip`, the parser's action half, the execution queue, `NO_REPLAY`,
and history body-stripping. Six subsystems.

Gains: paths validated before write; binaries never touched by the text path; a partial stream writes
*fewer files*, not *corrupted files*; the tool result tells the model what actually landed.

**Honest cost:** JSON-encoding code costs ~10–15% more output tokens, and prose streams prettier. Pay
it. Each deleted subsystem was born from a real shipped defect.

### Inversion 3 — The model reads files; it is not shown them

Send a **manifest** (paths + sizes, ~1–2k tokens), a `read_file` tool, and the 3–5 files that are
genuinely always needed (`globals.ts`, the play contract, `vite.config.ts`).

Expected creation prompt: **~25–35k, not 170k.** Everything in `CLAUDE.md` about breakpoint ordering,
stable zones and opaque-file classification becomes unnecessary. Keep **one** breakpoint on the base
prompt.

**This inversion and §3.3 are the same idea applied to the two halves of the prefix** — the file dump
(~155k) and the baked doc corpus (~15k). Do both or neither: shrinking one while the other stays huge
leaves the cold start, and the cold start is the whole complaint.

### Inversion 4 — Long-running work is a queue, never a tool

Anything over ~5 seconds is enqueued and polled: media, builds, deploys, asset processing. The tool
call **returns immediately** with a handle. A worker does the work. The client renders progress from
the job row.

### Inversion 5 — Fail loud, fail *specific*, always leave a next action

Every failure names **what failed, why, and what to do now.** v1 shipped `"The project failed to
build. Fix the errors in the editor"` while holding the exact file and line — and users correctly
concluded the button was broken.

If the system knows a filename, a line, a limit or a variable name, **the message says it.**

---

## 3. The five pillars

### 3.1 Nodepod as the sandbox — behind a seam, from commit one

**Decision:** Nodepod. Chosen, live-tested with the real AppTemplate (Babylon + Toolkit + Havok,
66ms HMR), and the fork is yours at `MackeyK24/Nodepod` (`~/Documents/Repos/Nodepod`) so defects are
fixable in-house. The point is **$0 idle and no hibernate machinery**, not the hourly rate.

**Before any feature code exists:**

1. Define `SandboxProvider` in `app/lib/sandbox/types.ts`. It **declares its own types** — it must
   never import a vendor package, or the scan below is impossible to write.
2. Write `sandbox-seam.spec.ts` as a **default-deny source scan with controls**: only
   `nodepod-provider.ts` may import the vendor package. Include a control proving the scanner still
   detects a violation.
3. *Then* write features, importing from `~/lib/sandbox`.

v1 kept "no new WebContainer coupling" as a *rule* for its whole build. When the seam was finally
extracted, **13 modules imported the package and 7 more reached the boot singleton.** A rule that
cannot fail is a rule nobody is keeping.

```ts
interface SandboxProvider {
  boot(projectId: string): Promise<Sandbox>;
  capabilities: { search: boolean; watch: boolean; symlinks: boolean };
}
interface Sandbox {
  fs: {
    readFile(path: string): Promise<Uint8Array>;      // bytes, always
    writeFile(path: string, data: Uint8Array | string): Promise<void>;
    readdir(path: string): Promise<Dirent[]>;
    rm(path: string): Promise<void>;
  };
  exec(cmd: string, args: string[]): Promise<{ exitCode: number; output: string }>;
  preview(): Promise<{ url: string }>;
  dispose(): Promise<void>;
}
```

**A capability a provider may lack is a `capabilities` flag, never a `typeof x.internal?.foo` probe.**
v1's search did the probe and reported "no results" where the truth was "not supported."

**Paths:** `WORK_DIR` is never a literal. One `toProjectRelativePath()` / `toSandboxStoreKey()` pair
used by **every** writer. v1 had nine hardcoded `/home/project` literals and a duplicate-key bug
that put every agent-written file in the map twice — 22.5k tokens per turn, and the model shown two
copies of `Home.tsx` it could edit independently.

**Mount is not "visible" is not "settled".** Three distinct states, and v1 needed all three:

- bytes written to the sandbox
- the file map (watcher-filled, **async**) actually shows them — v1 fired a generation at 5,405ms
  with **7 files** while the store filled at 5,531ms with **78**
- the map has stopped changing (quiescence, with a floor and a ceiling — never a blind `setTimeout`)

Gate the build on the third. Under Inversion 3 this gets much cheaper: you need the manifest to be
complete, not eighty-eight file bodies.

**Known Nodepod issue:** publishing breaks on a missing `util.formatWithOptions`. The fork is paused
on a 1.9.12-vs-1.9.18 base decision. Resolve before building on it.

### 3.2 Multi-user with credits

**Auth — two walls, both load-bearing.**

| Wall | Question |
|---|---|
| 1 | Is this a verified user? (session) |
| 2 | Do they own this project? (`requireOwnedProject`) |
| backstop | RLS — not the mechanism; service-role paths bypass it by design |

**Someone else's project is 404, never 403.** A 403 confirms the id exists — an enumeration oracle.

**Ledger — append-only, balance derived.**

```sql
credit_ledger(
  seq            bigserial primary key,   -- order by THIS, never created_at
  user_id        uuid not null,
  delta          integer not null,
  balance_after  integer not null,        -- computed by the WRITER under a lock
  reason         text not null,           -- generation | media | project_create | grant | purchase | adjustment
  ref_id         text,
  created_at     timestamptz default now()
)
```

Three rules, each of which cost real money in v1:

1. **`balance_after` is computed by a Postgres `security definer` function holding a per-user
   advisory lock.** Deriving it in TypeScript reintroduces the lost-update race — two generations
   read 100, both write 60.
2. **Order by `seq`, never `created_at`.** `now()` is the *transaction* timestamp, so back-to-back
   rows tie and the tiebreak falls to a random uuid. This bit the exact debit→refund pair that runs
   on every failed generation, producing a balance that skipped the debit.
3. **Grant uniqueness and payment idempotency are partial unique indexes.** A read-then-write check
   is a race a Stripe retry sails straight through.

**Test the SQL, not a TypeScript mirror.** Run real migrations against PGlite. v1's mirror was fully
green while a missing FK meant **every production generation would have billed zero**.

**Pricing.** `credits = ceil(raw_usd / CREDIT_UNIT_COST_USD * CREDIT_MARGIN)`. The margin is only
real if a credit *retails* at `CREDIT_UNIT_COST_USD` — assert `packMargin() >= MIN_PACK_MARGIN` in a
test or a repriced pack silently inverts it. v1 shipped packs at 0.84× against a 3.34× setting: ~19%
loss per generation, worst on the biggest customers. Credits are cost-proportional, so **the model
changes volume, not margin percentage** — "downgrade to save money" is always a false economy.

**Gate once before the model; settle after. Settlement can never refuse** — so a generation debit may
go negative and nothing else may. Media and project-create debit *before* provisioning, so they
refuse at 402 instead.

**Under Inversion 1, bill per completed step.** A job dying at step 3 bills 3. This replaces v1's
refund-on-failure plus its "was this productive?" heuristics — and it's honest in both directions.

**Subscriptions:** `invoice.paid` is the **only** grant path (it fires for month one too; also
granting on `checkout.session.completed` double-credits under a second idempotency key). The user id
rides on `subscription_data.metadata` — renewals have no session. **Credits never expire or reset.**

### 3.3 Dynamic Agent Reference (the Lovable model)

**Shape:** an index in the prompt, bodies on demand.

#### Start from the persona snippet, not from a corpus

This is the version that demonstrably works. It is what the owner uses in Claude Code, Cursor and
every other agent host, and **none of them have cold starts, TTL penalties or per-run cost variance**
on the identical request:

```markdown
# Babylon Toolkit Agent Persona

You are an expert web game developer using BabylonJS and the Babylon Toolkit. Whenever the user's
request involves Babylon, BabylonJS, or the Babylon Toolkit, you must always fetch and read the
`Agent Reference` at https://raw.githubusercontent.com/babylontoolkit/agent/main/reference.md before
doing anything else. Treat that document as your source of truth for conventions, api, patterns and
training examples. If the fetch fails, stop immediately and tell the user. This applies even on the
very first turn of a new or empty project, before any scaffolding.
```

**Roughly 150 tokens.** The reference it names is an *index*; sub-documents come down only when the
model decides it needs them. Nothing in that arrangement is large enough to have a cold start.

Now the measured comparison, on the same prompt — *"make me a mario kart clone"*:

| | prefix | cold start |
|---|---|---|
| bolt.diy / Claude Code, persona snippet | ~a few hundred tokens | none — **~133 credits** |
| v1, this platform | **170,371 tokens** | ~600 credits, and it varies run to run |

v1's prefix breaks down as ~15k of baked platform rules + index (59,325 bytes) and **~155k of dumped
starter files.** A cold cache writes all of it at **2×** — about a dollar of input before one token
of the game exists.

**The lesson is exact: "cold vs warm" is not a fact about caching, it is a symptom of prefix size.**
At 5k tokens the distinction is meaningless and no warmer, no breakpoint budget and no
sharedness-ordered block layout is needed — the entire apparatus in v1's `spec/context-budget.md`
exists to manage a number that should never have been large. Every other host avoided the problem by
never creating it.

#### The shape to build

```
System prompt:  persona + platform rules, kept SMALL and audited for size   (target <5k tokens)
Index:          fetched or pinned — ~30 rows, id + one-line description     (~2-3k tokens)
Bodies:         load_reference(id) — on demand, never baked
Project files:  a manifest + read_file (Inversion 3), never a dump
Arbitrary URLs: web_fetch(url) — pages the USER names
```

**Fetch the reference at runtime, but cache it server-side by SHA.** This is the one refinement worth
making over the raw snippet, and it costs nothing in prefix size:

```
first request ──▶ GitHub raw @ SHA ──▶ content-addressed blob ──▶ served from cache thereafter
```

You keep the snippet's economics (tiny prefix, no baked corpus, docs current) and you drop its single
real weakness — a GitHub outage failing paid generations, or a docs push silently changing every
user's behaviour mid-session. Pin the SHA per prompt version so a run is reproducible and an admin can
roll back; refresh on promote. **If the cache is cold and GitHub is down, say so and stop** — which is
exactly what the snippet already instructs.

> ⚠️ An earlier draft of this section said *"generations never depend on GitHub at runtime"* and made
> `web_fetch` the escape hatch rather than the mechanism. That rule was written for a system whose
> docs were baked into a 170k prefix — and **the baking is what caused the cost the rule was meant to
> avoid.** It protected reproducibility at the price of the thing that actually hurt. Keep the SHA
> cache for reproducibility; do not reintroduce the corpus to get it.

**Budget the system prompt like money, because it is.** v1's base prompt reached 138,660 bytes before
anyone measured it, and got to 59,325 only after a dedicated optimisation phase. Put a byte ceiling in
CI, fail the build above it, and make every addition argue for its place. **A prompt section costs
every generation, forever.**

**Two rules learned the hard way:**

**1. The model chooses from descriptions. There is no keyword router.**

v1 shipped a `Record<string, string[]>` of substrings. Every failure silent:

- `'ui'` matched as a bare substring, so `"why is my build failing"` (b-**ui**-ld) loaded a 24KB
  design doc on a debugging question
- 3 of 10 synced skills had no entry and could **never load**
- The router's input included the invoked skill's own body, so `/bt-spec` loaded `bt-landing`
  because bt-spec's text contains the word "landing" — sticky for the whole conversation
- The table lived in the consuming repo, so adding a doc needed a TypeScript edit

The same class hit genre inference twice more: `"top down twin stick shooter"` matched the single
word `shooter` and mounted an FPS starter. That is now deleted, and `no-prompt-classifier.spec.ts`
keeps it deleted. **Do not rebuild any of these.**

**2. Bound loads with a budget, never by withdrawing the tool.** `MAX_REFERENCE_LOADS = 3`, enforced
**in `execute`, never in the zod schema** — a schema violation kills the generation *after* the
tokens are spent. Past the budget the tool refuses and names what is already loaded.

**3. Loaded references stick for the conversation.** v1 measured a turn that loaded a skill at 2 steps
/ 303k prefix / 528 credits, and the follow-ups that *carried* it at 1 step / 169k / 276 credits.
Carry them **append-only in first-seen order** — inserting at the front rewrites the whole cached
prefix at 2×.

**⚠️ Build the doc/runtime API check.** A doc teaching an API the runtime doesn't have ships a game
that runs in dev and can never be built (Vite never typechecks). v1 hit this twice:
`hideSplashScreenDelayMs` (renamed to `scenePrewarmDurationMs`) and
`GetKeyDown`/`GetKeyUp`/`GetKeyPress` (Unity names that never existed in the Toolkit — three
consecutive generations shipped games crashing in `update()`). **CI must diff every API name in the
docs against `babylon.toolkit.d.ts`.** This is the highest-value tooling not in v1.

> There is a live instance right now: a skill prescribes `babylonjsLoadingDiv` /
> `babylonjsLoadingText` while the shipped template uses `xbabylonjsLoadingDiv` /
> `xbabylonjsLoadingTextDiv`. The x-prefixed ones are correct. Same class; this check catches it.

### 3.4 Slash skills

**agentskills.io-compliant, authored externally in `babylontoolkit/skills`, consumed here.**

| Path | Mechanic |
|---|---|
| `/bt-landing <brief>` | User names it. Loaded directly, no model choice. |
| Model-chosen | Index in prompt; model calls `load_skill(name)` from descriptions. |

Everything in §3.3 applies: descriptions route, `MAX_SKILL_LOADS = 2` enforced in `execute`, sticky,
append-only.

**The one exception worth keeping:** on the first build turn, preload the known-needed pair
(`bt-landing` + `bt-design`) inline with skill tools **off**. That brief is machine-written against
those two, so there's nothing to route — 468s → 114s. **One mechanism per turn, never two:** v1's
six-round thrash came from a skill inlined *while the tool was still offered*, so the model kept
trying to load what it already had.

**Slash commands are exact-match only.** `/clear the obstacles` is a message for the agent. A prefix
match silently swallows real messages — the dangerous direction. Unknown `/word`s falling through to
the model are harmless.

**Client-side commands that never reach the server:** `/clear` (new chat, same project), `/context`
(the usage report). Zero credits, zero round trip.

**Platform-capability exclusions live at the store's read seam**, not in a router — some skills
(`bt-gauntlet` needs subagent fan-out and screenshot evidence) can't work on a server tool loop, and
excluding them at read time also covers already-synced copies.

### 3.5 Media generation — the redesign

**The part v1 got most wrong. Build it this way.**

#### Media is a queue, never a tool round

```
model                 server                          worker
  |-- request_art ---->|                                |
  |<-- paths, instant --|-- enqueue N jobs ------------>|
  |  (keeps building)   |                        [ONE at a time,
  |                     |                         spaced, retried]
  |                     |<---- job N complete -----------|
  |                     |----> client polls, writes bytes
```

The call **returns destination paths immediately** and never blocks. The build proceeds. Art lands
behind it. **No round budget, because media consumes no rounds.**

#### Serialized, spaced, independently retried

```ts
const MEDIA_CONCURRENCY  = 1;      // one at a time
const MEDIA_SPACING_MS   = 1500;   // spaced out
const MEDIA_MAX_ATTEMPTS = 3;      // per image, not per batch
```

Over v1's parallel round this buys: **partial success is normal** (5 of 7 is a good outcome);
**per-image retry**; **real progress** ("Generating art — 3 of 7"); **no refusals ever**; **contained
failure** (one bad prompt fails one image).

#### Billing

- Quote and debit **before** any spend, through the same lookup the panel's price display uses
- `reason: 'media'` **may never go negative** — it debits before anything is provisioned
- Refund exactly once: per-task serialization + a `refunded` latch. A flaky poll is **not** a failure.
- **No price fallback.** Unknown model / unmatched options / per-second-without-duration → **refuse**.
  (LLM models fall back to the *most expensive* row so "configured" and "priced" stay the same
  question. Media debits before spend, so it must refuse instead.)

#### Two surfaces, one service

The **Media Dialog** (user picks model + options, exact credit price on the button) and the
**in-prompt** path both call one `startMediaTask()`. Never two implementations, or the quote and the
debit drift.

#### Format and transparency — carry these, they were expensive

- **Photographic art defaults to jpg.** A 2K photographic PNG is ~10MB vs <1MB jpg. v1 froze a
  browser tab at 8,011 MB base64-ing several of them on the main thread.
- **Transparency is a `transparent: true` flag, not a file format.** Google's image models emit **no
  alpha channel at all**. Asking for "transparent background" in the prompt makes the model paint a
  **picture of a checkerboard**, baked into the art forever. Real transparency = a second
  `recraft/remove-background` stage (~2 credits), quoted and debited with stage 1 as one task.
  Verified live: 2752×1536 RGBA, 79.2% fully transparent, soft shadow edge preserved.
- **Type the file-proxy response from the bytes**, not the URL. KIE returns JPEG bytes behind `.png`
  URLs; v1 wrote mislabeled files into projects for months.
- **Never encode media on the main thread.** Web Worker, transfer ArrayBuffers zero-copy.
- One pure `resolveDelivery()` read by the quote, the payload **and** the destination path — disagree
  and the file is billed as one thing, written as another, referenced as a third.

---

## 4. The rest of the product

The parts that aren't optional if the output is meant to be a playable Babylon game.

### 4.1 The generated-project contract

**This is domain law. Get it wrong and every generated project is subtly broken.**

**Play contract.** Gameplay is entered **only** through:

```ts
navigate('/play', { gameMode: 'MyGameMode', sceneUrl?, ...selections })
```

with a **registered** GameMode class. Extra config (track choice, car choice, difficulty) rides in
that same NavigationState object — sessionStorage-backed, **never the URL**.

- React UI uses `useUnifiedNavigation` and must **never** import `GameManager` or any Babylon module
  (it drags the Babylon runtime into the main bundle)
- Game code in `src/scripts/` uses `GameManager.NavigateTo`
- Babylon imports stay inside the lazy `/play` chunk

The frontend is fully redesignable — a landing page may have no play button at all — but this call
must never be broken, stubbed or bypassed.

**File zones.**

| Zone | Rule |
|---|---|
| `src/scripts/**` | **The write zone.** All game code — GameModes and Script Components. |
| `src/pages/**`, `src/components/**` | Frontend. Fully redesignable. |
| `src/chrome/**` | Splash, preloader, overlay. Redesignable; keep the wiring. |
| `src/babylon/classes/**` | **READ-ONLY** demo library. Copy FROM it, never edit. |
| `src/babylon/system/**` | **READ-ONLY** framework internals. |
| `app.tsx`, `src/routing/**` | **READ-ONLY** routing shell. |

**Copying a demo class into `src/scripts/` requires rebasing its relative imports** (`'../globals'` →
`'../babylon/globals'`) or Vite fails with `Failed to resolve import`. The scaffolder does this
deterministically; the prompt instructs the model for copies it makes later.

**⚠️ The chrome path is a contract between the templates and the prompt, and a mismatch fails
silently.** It was `src/babylon/**`, then `src/custom/**`, now `src/chrome/**`. The model writes
`src/chrome/splash.tsx` into a starter whose file is `src/custom/splash.tsx` — the project builds,
runs, and **ignores the redesign**. Repointing the prompt is half the change; the pinned starter
snapshot still holds the old tree until an admin promotes the new template. Pin this with a test
asserting the absence of the old path in every shipped file.

**Landing page rewrites.** `src/pages/Home.tsx` + `Home.css` are **overwritten per project**. Nothing
from the starter page survives — no hero, no demo buttons, no framework links, no footer, **no
Toolkit/BabylonJS attribution or branding at all**. Carry forward only the navigation *pattern*.
Use whichever starter images the design calls for; **never delete image files from disk**. Zero
unresolved imports after any rewrite.

**Batteries-included, stated as a preference and not a mandate.** Prefer the Toolkit's built-in
systems (physics, animation, audio, navigation, cameras, input) over hand-rolling — but **do not name
a single concrete class per genre.** v1's prompt said *"Driving / racing → the RacingSystem (e.g.
`StandardCarController`)"* under a heading calling deviation *"a generation-quality bug"*, in the
cached prefix of every generation of every genre. Name the **subsystem**, describe the capability,
and let the model choose the implementation. Engine plumbing (Havok, audio, nav) is genuinely
"don't hand-roll this"; a car controller is a **design decision**, and a 4-wheel physics car is the
wrong shape for a top-down arcade racer, a hover kart or a boat.

### 4.2 Templates and the starter registry

Projects start from an official Toolkit starter, **pinned by commit SHA** and served from object
storage. Creation makes **zero GitHub calls** once pinned; a push to the starter repo reaches nobody
until an admin promotes it.

Rules, each of which fails silently:

- A client-reported broken mount (`?fallback=1`) **outranks a healthy pin**, or a user is trapped on
  bad bytes forever
- A pin whose snapshot object is **missing** serves live but **never re-pins** — auto-re-pinning to
  today's `main` is the unreviewed jump pinning exists to prevent
- Auto-pin only on a clean bootstrap, marked `pinnedBy: 'auto'`
- **Validate before** re-pointing; rollback only onto bytes that still validate

**Genre inference is deleted.** A typed prompt seeds the Blank Canvas fallback and the model decides
what to build. Cards and the wizard remain as **explicit** choices. Do not rebuild ranking.

**Scaffolding (§4.4b).** New Project copies the entry's `source_class` from `src/babylon/classes/`
into `src/scripts/<ProjectClassName>.ts`, renames the class **and** its `RegisterClass` string,
rebases relative imports, and adds the registration import to `globals.ts`. Without that last step
the class never registers and `/play` dead-ends.

**Creation contacts no model.** Fetch the pinned starter, mount, scaffold the class, `npm install`,
`npm run dev`, stop — with the stock page live. The user's first message is the first build turn.
Nothing a model does can decide whether a project exists.

### 4.3 Persistence

**The user's code lives in their repo. The platform holds the project record, the conversation, and
one crash-recovery working copy.**

- **Nothing pushes without a button press.** v1 auto-pushed on every checkpoint — writing to
  someone's account on its own initiative. **Linked ≠ synced.** *Linked* is a permanent fact about
  the project; *synced* is a fact about right now that only the user's action makes true.
- **Save CREATES, never adopts** (`adoptExisting: false`). Save derives the repo name from the
  project title — a user with an unrelated `my-game` would have had its HEAD overwritten. Collisions
  walk to `my-game-2`. *Linking* a repo the user named still adopts; that's the right behaviour for
  that verb.
- **One working copy per project**, key **derived** from the project id, no retention. It is a
  crash-recovery buffer, **never a history** — "keep the last few" is how a snapshots table grows
  back.
- **Local checkpoints** (IndexedDB, ~20/project) power undo. **Order by monotonic `seq`, never
  `createdAt`** — same tie-breaking bug as the ledger, and here it decides which checkpoint undo
  restores.
- **A restore is not an overlay.** It must delete what's absent or undo leaves the file it's undoing.
  Two ways to get that catastrophically wrong, both one-liners: normalize both sides through one path
  function (compare raw and *nothing* matches, so the restore **wipes the project**), and make
  `protect` a **required** per-call-site answer to "what is this map authoritative about?" (a repo
  tree has no `.env`, so treating it as whole truth **deletes the user's API keys**). An empty
  incoming map deletes **nothing**.
- **`isSecretPath` is one rule in one place.** The narrower `/\.env\.[^/]*local$/` version pushed
  `.env.production` — the most dangerous file in the family.
- **Never merge.** Divergence is a two-button choice for the user. Pull always checkpoints first.
- **A project holds many chats.** The server chat id is a **minted UUID**, never the browser's — v1's
  `max(local keys)+1` meant every browser's first chat was `"1"`, so a laptop and a desktop
  **overwrote each other's conversation**. The sidebar lists the **account's** chats, not the
  browser's; the objects decide what exists and the index only decorates.

### 4.4 Share, play, gallery, remix

- **Publishing runs a checklist**: a secret scan is a **blocking refusal**; debug overlays are a
  warning.
- **A build failure must name the file and line, in the dialog, not a toast.** Cut the log from the
  **tail** (npm echoes first, `tsc`/Vite print errors last — capping from the front reliably shows
  the banner and drops the only actionable line). v1's *"The project failed to build. Fix the errors
  in the editor"* got Share reported as broken when Share was working correctly.
- **`/play/:shareId` is origin-isolated** (iframe → a separate `PLAY_URL`), and fails **closed** in
  production if that origin is unset — a shared build must never be served same-origin against app
  cookies.
- **Build with a relative base** (`--base=./`) plus a root-absolute-asset backstop, and resolve the
  router basename at runtime. v1 shipped with `base: "/"` and a comment claiming the opposite:
  **every published game was broken and always had been**, because no test ever went as far as "a
  stranger can play it."
- **A remix is born unlinked**, and gets its **own** seed under its own id, so unpublishing or
  deleting the source never empties someone else's remix. Test the **property**, not the fields that
  happened to exist when it was written.
- Publish deposits a `.env`-stripped **remix seed** — the one piece of user source the platform keeps,
  for a game deliberately made public. **Unpublish deletes it.**

### 4.5 Admin, brand, monitoring

**Admin panel** — the operator surface. Prefer a button here over a CLI every time:
doc/skill sync + promote, starter template pin/promote/rollback, the price list, usage and margin
reports, gallery curation, the reports queue, credit adjustments (through the append-only ledger).

**Brand module.** All product name, logos, colours, taglines, support links and absolute URLs come
from one config module + `APP_URL`/`PLAY_URL`. Never hardcoded in components, emails, meta tags,
manifests or error pages. The PWA manifest is a **route**, not a static file, so its name comes from
the module. **A CI grep gate enforces this** and caught two real regressions in v1's own code.

**Monitoring** — transport-agnostic, never throws, fire-and-forget. Alert on: generation failure
*rate*, payment webhook failure, sync build failure. Funnel events at signup, verified,
project_created, generation started/completed/failed, first_playable, share_published, remix_created,
purchase_completed. Health check reports per-dependency **config state** (never a secret) plus a
`ready` flag.

**Keep the per-generation diagnostics** (`tool_rounds`, `duration_ms`, `finish_reason`, `steps`
jsonb). Aggregate usage hides every pathology in §1; without these you can chart spend but never
diagnose it. Under Inversion 1 the step journal replaces most of this for free.

---

## 5. Carry-forward invariants

Short list. Each cost real money or real data.

**Binary files are bytes, end to end.** Every path — template mount, import, sandbox write, snapshot,
restore, GitHub sync, deploy — carries binaries as `Uint8Array`. base64 is a **wire** format, never
live state. Round-trip must be sha256-identical. v1 verified this on a 2MB `havok.wasm` against real
github.com.

**Never `VITE_`-prefix a platform secret.** Vite inlines `VITE_*` into the client bundle. A
service-role key in a browser hands every visitor every row. (Upstream's `VITE_SUPABASE_*` is the
*user's* game backend and is public by design — ours is the platform DB.)

**A server route may act on a secret, never emit one.** Upstream shipped an unauthenticated
`GET /api/export-api-keys` returning `{"Anthropic":"sk-ant-..."}`. Worse than unmetered spend: a
leaked key works off-platform forever. **"Is a key configured?" is a boolean.**

**Every outbound route needs auth in the handler** — not in a wrapper's boolean option. v1 had a
`requireAuth` flag nothing read, making ~14 routes *look* protected while anonymous. Enforce with a
**default-deny source scan** failing any `api.*` handler that references no wall.

**SSRF guard on every caller-supplied URL**, re-run on **every redirect hop**.

**Cap every client-supplied upload** — attachments, builds, remix seeds. "Verified" is not
"unmetered". **And derive related limits from each other**: v1 held a project for crash recovery at
256MB and refused its remix seed at 75MB, so a project between them published successfully and was
**permanently un-remixable**, silently. A limit only correct *relative* to another limit must be
derived from it or asserted against it.

**A best-effort step that cannot fail the request must still report.** Return the reason and render
it.

**Shell commands are allow-listed** (`npm install <pkg>`, `npm run <script>`), client-side **and**
server-side. Under Inversion 2 this shrinks to validating the `exec` tool's arguments.

**No server-side execution of user code or skill scripts. Ever.**

**Test discipline that actually caught things:**

- **Mutation-verify every money or safety test.** Break the code; the test must fail. v1 had multiple
  vacuous tests — one asserted `expect(fraction).toBe(PROGRESS_CAP)`, which moves both sides together
  and **passed with the cap set to the exact value it existed to prevent**.
- **Default-deny source scans need a control** proving the scanner still detects a violation. A scan
  that silently matches nothing reports a clean bill of health forever.
- **`env()` falls back to `process.env`, and vitest loads `.env.local`.** Any test asserting an
  *unconfigured* state must `vi.stubEnv(..., undefined)` — **including every variable in the
  precedence chain**, not just the one under test. This trap fired **four separate times**.
- **Drive the real UI before claiming a user-facing feature works.** v1 shipped two data-loss bugs
  with 1,109 tests green; every defect lived in the wiring *between* correctly-tested pieces.
- **When you fix a pathology, re-derive whether its metric still measures it.** v1's `wastedOutput`
  was defined as "sum of all-but-last step outputs". The fix made a creation exactly one step, so it
  reported **zero waste on the most expensive generation in the product**, in good faith, forever.
  **Five** metrics were found encoding the shape of a failure they no longer detected.

---

## 6. Do not build these

| Don't | Why |
|---|---|
| Keyword routers of any kind | Failed 3× — skills, docs, genre. Descriptions + model choice. |
| Server-side snapshot history | v1 deleted it and it grew back as a field name. One working copy, derived key, no retention. |
| Server-side MCP | Upstream's is unauthenticated RCE. MCP runs in the user's sandbox. |
| Server-side execution of user code | Ever. |
| BYOK / provider pickers at launch | Credits-only. One operator-configured model ladder. Flag it for later. |
| Five cache breakpoints | The API max is four. Under Inversion 3 you need one. |
| A cache warmer | It exists only to hide a huge prefix. Fix the prefix (§3.3) and there is nothing to warm. v1's ran inert for months and nobody noticed. |
| A baked documentation corpus | The persona snippet + a fetched index is what works everywhere else. §3.3. |
| A metric defined as the shape of a known failure | See §5. |
| Auto-push, auto-merge, or anything that writes to a user's account unasked | §4.3. |

---

## 7. Build order

Each stage ends with something demonstrable.

**Stage 0 — the seams.** `SandboxProvider` + its default-deny scan. `toProjectRelativePath`. Binary
round-trip test. Brand module + CI gate.
*Demo: a file with binary bytes survives mount → read → write, sha256-equal.*

**Stage 1 — the job engine.** Job/step tables, runner, journal, resume, client renderer. **Model
calls stubbed.**
*Demo: kill the tab mid-job; reopen; it resumes at the right step.*

> This stage decides whether v2 is better than v1. Do not shortcut it.

**Stage 2 — the agent.** `write_file` / `edit_file` / `read_file`. Base prompt + manifest.
`load_reference` + `web_fetch`.
*Demo: a real creation, ~30k prompt tokens, six visible steps, a playable game.*

**Stage 3 — the project contract.** Templates + pin/promote, scaffolding, play contract, file zones,
landing + chrome rewrite.
*Demo: three different genres, all playable, all with bespoke landing pages.*

**Stage 4 — users and money.** Auth, two walls, ledger (PGlite-tested), Stripe, per-step billing.
*Demo: two accounts, correct isolation, 404 on someone else's project.*

**Stage 5 — media.** Queue, worker, serialized + spaced, Media Dialog, in-prompt requests.
*Demo: 10 images requested on a build. Build completes on time. Images land one at a time with
progress. **Zero refusals.***

**Stage 6 — skills, persistence, share.** `/slash`, skill sync, GitHub sync, share/play/remix.

**Stage 7 — the doc/runtime API check**, admin panel, monitoring.

---

## 8. Definition of done

The reliability bar, as tests:

1. **Resume.** Kill the browser at any step of a creation. Reopen. It resumes and completes.
2. **No silent step.** No step exceeds 60s without output or a heartbeat that names a cause.
3. **Never half-done.** A job that cannot complete a step marks it, logs it, **continues**, and
   reports what was left at the end. It never stops in the middle.
4. **Partial credit.** A job dying at step 3 of 6 bills 3 steps and says exactly that.
5. **Media independence.** 10 images on a build → build completes on time, images land afterward with
   progress, **zero refusals**.
6. **Cost.** A creation's prompt is under 40k tokens, of which the system prompt is under 5k. **Cold
   and warm runs bill within 10%** — if they don't, the prefix is still too big (§3.3). The reference
   point is bolt.diy answering *"make me a mario kart clone"* in ~133 credits with no cold-start
   concept at all.
7. **Byte identity.** A 2MB binary survives mount → sandbox → GitHub → clone → mount, sha256-equal.
8. **A stranger can play it.** Publish, open the link in a clean browser profile, play the game.
9. **Auth.** Every `api.*` route names a wall or fails the default-deny scan.
10. **Docs match runtime.** CI diffs every API name in the reference against `babylon.toolkit.d.ts`.

---

## 9. Port list — take these as they are

Mostly pure, exhaustively tested, and carrying the expensive knowledge:

| From v1 | Why |
|---|---|
| The credit ledger **SQL** | Advisory-lock function, `seq` ordering, partial unique indexes |
| `isSecretPath` | One rule, one place — the `.env.production` lesson |
| `restore-plan.ts` | Delete-what's-absent + `protect`, both catastrophic to get wrong |
| `sandbox-paths.ts` | `toProjectRelativePath` / `toSandboxStoreKey` |
| The binary round-trip suite | Proves the property v1's whole file layer exists to hold |
| Brand module + `check-brand.mjs` | Already caught two real regressions |
| `cache-probe.mjs`, `stream-probe.mjs`, `compare-generations.mjs` | Each written *after* a wrong diagnosis; each answered what no server aggregate could |
| The Marketplace price list | One versioned document, promote/rollback, **no prices in env vars** |
| `game-registry.json` | Data, not code — the starter entries |
| The prompt's hard-constraints text | Minus the concrete-class-per-genre line (§4.1) |

**Never bake `babylon.toolkit.d.ts` into the prompt.** ~490KB / ~130k tokens — larger than the entire
target creation context. Editor IntelliSense only.

And the biggest asset: **`CLAUDE.md`**. Forty invariants, each one a bug someone paid for. Most become
unnecessary under §2 — but read every one before deciding it doesn't apply to you.

---

## Appendix A — data model

```
users            (from the auth provider)
projects         id, user_id, title, created_at,
                 provider, linked_repo, linked_branch,   -- all-or-nothing tuple
                 sandbox_id, remix_seed_at, share_id, gallery_state,
                 game_backend_ref, creation_handoff jsonb
jobs             id, project_id, user_id, status, created_at        -- Inversion 1
job_steps        job_id, n, kind, status, input, output, attempts,
                 tokens, started_at, ended_at, error
chats            id (uuid), project_id, title, updated_at
credit_ledger    seq, user_id, delta, balance_after, reason, ref_id, created_at
generations      id, user_id, project_id, model, tokens…, raw_cost_usd,
                 finish_reason, duration_ms, steps jsonb
payments         stripe ids + partial unique index (idempotency)
grants           partial unique index (once per user)
media_tasks      id, user_id, project_id, model, status, attempts, refunded
user_assets      catalog + entitlements
play_reports     anonymous → admin queue
```

**RLS on every table, policies living with the table they protect.** The link tuple
(`provider` + `linked_repo` + `linked_branch`) needs a DB constraint — it caught two live half-link
writers in v1.

## Appendix B — configuration

Everything below is **config, never hardcoded**. Secrets are server-only.

```
# model
LLM_PROVIDER            Anthropic | KIE          (provider and model switch TOGETHER)
LLM_MODEL               claude-sonnet-5 …
PREMIUM_MODEL / SUPERMAX_MODEL + their credit minimums

# money
CREDIT_UNIT_COST_USD, CREDIT_MARGIN, MIN_PACK_MARGIN
SIGNUP_GRANT_CREDITS    ← define ONCE; v1's example file set it twice with different values
PROJECT_CREATE_CREDITS
BILLING_ENFORCED

# limits (all env-tunable — a hardcoded ceiling is a deploy for the operator)
BUILD_MAX_MB, BUILD_MAX_FILES, REMIX_SEED_MAX_MB, ATTACHMENT_MAX_MB
HISTORY_WINDOW_TURNS, MAX_REFERENCE_LOADS, MAX_SKILL_LOADS

# surfaces
APP_URL, PLAY_URL       ← PLAY_URL unset in production fails the play path CLOSED

# secrets — server only, never VITE_-prefixed, never in a response body
ANTHROPIC_API_KEY / KIE_API_KEY, STRIPE_SECRET, SUPABASE_SERVICE_ROLE_KEY,
AWS creds, GIT_TOKEN_ENCRYPTION_KEY, GIT_OAUTH_STATE_SECRET
```

**Prices are not env vars.** They live in the versioned Marketplace price list, promoted from the
admin panel. A price var nothing reads is a mis-bill waiting to be believed — v1 makes the retired
ones throw loudly if set.

**Every refusal names the limit *and* the variable that sets it.**

## Appendix C — deployment

- Container on Lightsail (v1's shape); values from SSM → container env. Not Cloudflare Pages.
- **`assertNotLocalInProduction`** — local mode treats every caller as a verified admin, so refuse to
  boot into it when `NODE_ENV=production`. Check at **boot**, not per-request: v1 checked per-request
  and a misconfigured deploy booted healthy and served anonymous admin.
- **Local mode must be real, not a mock** — with no vendor accounts at all the platform should run as
  one verified local developer with filesystem persistence, a working ledger and real ownership
  checks. That is what makes the money stages buildable before Stripe exists.
- **Never skip or stub a feature because a key is missing.** Read credentials from config and degrade
  gracefully: a "not configured" UI state and a descriptive server error.
