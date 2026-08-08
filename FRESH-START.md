# FRESH-START.md

**A rebuild brief for the Babylon Toolkit App Builder, v2.**

This is not a spec. It is the list of things the current system got structurally wrong, the
architectural inversions that fix them, and the five capabilities you asked to carry forward. Every
claim here is backed by something that actually happened in v1 — measured, logged, or shipped.

Read §1 and §2 first. They are the whole point. §3 onward is implementation detail.

---

## 0. The verdict in one paragraph

v1 works. It builds real games. What it cannot do is **tell you whether it is going to finish** —
and that single property is why it feels unreliable and why it feels expensive, because a run you
can't trust is a run you pay for twice. The root cause is not the prompt, not the model, and not
the sandbox. It is that **one generation is one monolithic streamed turn that must do everything at
once, with no persisted intermediate state, over a transport where any hiccup loses all of it.**
Nothing in v1 can resume. Nothing in v1 can report "step 3 of 7". Everything is all-or-nothing, and
the thing doing the "all" routinely runs four minutes without emitting a byte.

Fix that one property and most of the 40+ hard-won invariants in `CLAUDE.md` stop being necessary.

---

## 1. Diagnosis — four root causes, not forty bugs

`CLAUDE.md` records roughly forty distinct never-regress rules. That density is itself the finding:
they are not forty independent mistakes, they are **four structural choices, each generating bugs
faster than they could be fixed.**

### 1.1 The monolithic turn

One generation must: read ~170k tokens of context, decide the design, generate art, write the
landing page, write the chrome, write the game code, write the spec, and answer — in a single
streamed response producing 30k+ output tokens.

Evidence from your last run:

```
prompt 170,371 · completion 31,692 · total 202,063
step 2: 268,169ms · 25,598 out · 0 chars text · 17,613 chars reasoning
```

Consequences that all trace to this one choice:

| Symptom | Mechanism |
|---|---|
| "Hangs in the middle doing nothing" | Output decodes serially at ~60–110 tok/s. 30k output **cannot** be fast. |
| Provider kills the step | KIE terminates any step emitting no bytes for ~30s. A long think emits nothing. |
| Stuck artifact row, forever | `execution-queue` poisoning — one throw killed every later action in the tab. |
| Corrupted source file | A stray `</parameter>` in the text channel lands verbatim in `Home.tsx`. |
| Forced continuation double-bill | A step claiming `tool-calls` with no tool call re-ran the whole 200k prefix. |
| No partial credit on failure | There is no record of what succeeded. It's one turn. It either lands or it doesn't. |

**None of these are fixable in place.** They are properties of "one turn does everything."

### 1.2 Files travel through a text channel

v1 writes files by streaming `<boltAction type="file">` in the model's prose channel, parsed
client-side. This is inherited from bolt.diy and it is the source of an entire bug family:

- `shell-strip.ts` — server filter, because the same channel carries shell commands
- `protocol-strip.ts` — server filter, because tool-call syntax leaks into prose
- `message-parser.ts` artifact-close fallback — because the model sometimes emits zero `</boltAction>`
- The execution queue — because parsed actions need serializing
- The `NO_REPLAY` marking system — because replaying history rewrites files
- History compaction stripping file bodies — because bodies re-send forever otherwise

Six subsystems exist **solely because file contents ride in prose.** A file write is a structured
operation. It should be a structured call.

### 1.3 The model is shown everything, always

170,371 prompt tokens on a fresh creation. The bulk is the starter tree dumped into context so the
model can "see" the project. That dump is why:

- Cold starts cost $0.50 (later $0.24 after two optimization phases)
- Four cache breakpoints had to be budgeted, ordered by sharedness, and defended by tests
- Duplicate file-map keys silently cost 22.5k tokens/turn
- A `CLAUDE.md` promotion path, an opaque-file classifier, and a stable-zone splitter were needed

The model reads maybe eight files. It is shown eighty-eight.

### 1.4 Media on the build's critical path

This is the one you flagged, and it is the cleanest example of the whole pattern.

The brief tells the model to make all image calls "FIRST, in ONE parallel round." The model doesn't
work that way — it discovers art needs *while designing*. So it made a round, then another, then
wanted a third. `MAX_MEDIA_ROUNDS = 2` refused the third:

```
WARN media-tools  media tool: round budget spent (2/2), call refused   ×3
```

That cap exists because without it, a run burned all its steps on images and **shipped no game at
all** (`gen_msixapaq_i871b6`, 1,489 credits, zero files). So the choice was: refuse the art, or
lose the build. Both are bad. Both are forced by putting a 20-second-to-4-minute async render
inside a synchronous LLM tool loop that also has to write your game.

**Your instinct — one at a time, spaced out — was correct.** Serializing gives per-image retry,
partial success, visible progress, and no interaction with the build's step budget. I argued for
batching to save tool rounds. That saved a few thousand tokens and cost you the reliability of the
entire creation path.

---

## 2. The five inversions

These are the architectural changes. Everything in §3 assumes them.

### Inversion 1 — Generation is a persisted, resumable **step plan**, not a turn

The single most important change in this document.

A build is a **job** with a row per step. The server owns the job; the client renders it.

```
job: { id, projectId, userId, status, steps[] }
step: { n, kind, status, input, output, attempts, tokens, startedAt, endedAt }
```

Step kinds for a creation:

| # | kind | model call? | writes |
|---|---|---|---|
| 1 | `plan` | yes, small | the step list + design brief (structured output) |
| 2 | `game-code` | yes | `src/scripts/**` |
| 3 | `landing` | yes | `src/pages/**` |
| 4 | `chrome` | yes | `src/chrome/**` |
| 5 | `verify` | no | runs `tsc`, feeds errors back |
| 6 | `repair` | yes, conditional | fixes what `verify` found |

Properties this buys you, none of which v1 can have:

- **Resumable.** Tab dies at step 3? Steps 1–2 are on disk. Resume runs 3–6.
- **Per-step retry.** Step 4 fails? Retry step 4. Not the build.
- **Honest progress.** "Step 3 of 6 — landing page" is a fact, not a spinner.
- **Bounded output.** No step emits 30k tokens, so no step runs 4 minutes silently.
- **Partial credit.** A job that completes 4 of 6 steps bills 4 steps and says so.
- **Diagnosable.** The journal *is* the diagnostic. v1 needed `steps jsonb`, `tool_rounds`,
  `silentStepOutputTokens`, `charsPerOutputToken` and a Marketplace report to reconstruct what a
  single turn did.

Cost is not higher. It is the same total work, split — and each step re-reads a *cached* prefix at
0.1×, where v1's forced continuations rewrote the prefix at 2×.

> **Non-negotiable:** the step journal is written to durable storage **as each step completes**,
> never held in memory. If it lives only in the streaming response, you have rebuilt v1.

### Inversion 2 — Files are written by tool calls, never by prose

Replace the artifact protocol with two tools:

```ts
write_file({ path: string, content: string })       // full body
edit_file({ path: string, find: string, replace: string })  // surgical
```

Deletes: `shell-strip.ts`, `protocol-strip.ts`, the message parser's action half, the execution
queue, `NO_REPLAY` marking, and the history body-stripping compaction. Six subsystems, gone.

Gains: paths validated before write; binaries never touched by the text path; a partial stream
writes *fewer files*, not *corrupted files*; and the tool result carries the write's success back
to the model, so it knows what landed.

**Honest cost:** JSON-encoding code costs ~10–15% more output tokens than raw prose, and streaming
prose *looks* nicer. Pay it. Every one of the six deleted subsystems was born from a real shipped
defect.

### Inversion 3 — The model reads files; it is not shown them

Do not dump the starter tree. Send:

- A **file manifest** — paths + sizes, ~1–2k tokens for the whole project
- A `read_file(path)` tool
- The 3–5 files that are genuinely always needed (`globals.ts`, the play contract, `vite.config.ts`)

Expected prompt on a creation: **~25–35k, not 170k.** Every doc in `CLAUDE.md` about cache
breakpoints, stable zones, sharedness ordering, and opaque-file classification becomes unnecessary
— they are all workarounds for a dump that shouldn't exist.

Keep one cache breakpoint on the base prompt. That's it.

### Inversion 4 — Long-running work is a queue, never a tool

Any operation taking >5 seconds is enqueued and polled, never awaited inside a generation.

That means media generation, and it means anything else you add later (builds, deploys, asset
processing). The model's tool call **returns immediately** with a handle; a worker does the work;
the client renders progress from the job row.

### Inversion 5 — Fail loud, fail *specific*, and always leave a next action

Every failure surface must answer three things: **what failed, why, and what to do now.** v1
shipped refusals that named no cause (`"The project failed to build. Fix the errors in the editor"`
— while holding the exact file and line), and users correctly concluded the button was broken.

Rule: if the system knows a filename, a line, a limit, or a variable name, the message says it.

---

## 3. The five pillars

### 3.1 Nodepod as the sandbox — behind a seam, from commit one

**Decision:** Nodepod is the provider. It's chosen, live-tested with the real AppTemplate (Babylon
+ Toolkit + Havok, 66ms HMR), and the fork is yours at `MackeyK24/Nodepod`
(`~/Documents/Repos/Nodepod`) so defects are fixable in-house.

**Do this before any feature code exists:**

1. Define `SandboxProvider` in `app/lib/sandbox/types.ts`. It **declares its own types** — it must
   never import a vendor package, or the default-deny scan below is impossible to write.
2. Write `sandbox-seam.spec.ts` as a **default-deny source scan with controls**: only
   `nodepod-provider.ts` may import the vendor package. Add the controls (a test proving the
   scanner still detects a violation) or it silently passes forever.
3. Only then write features, importing from `~/lib/sandbox`.

v1 kept "no new WebContainer coupling" as a *rule* for its entire build. When the seam was finally
extracted, **13 modules imported the package directly and 7 more reached the boot singleton.** A
rule that cannot fail is a rule nobody is keeping. Make it a test on day one.

**Interface (minimum):**

```ts
interface SandboxProvider {
  boot(projectId: string): Promise<Sandbox>;
  capabilities: { search: boolean; watch: boolean; symlinks: boolean };
}
interface Sandbox {
  fs: {
    readFile(path: string): Promise<Uint8Array>;   // bytes, always
    writeFile(path: string, data: Uint8Array | string): Promise<void>;
    readdir(path: string): Promise<Dirent[]>;
    rm(path: string): Promise<void>;
  };
  exec(cmd: string, args: string[]): Promise<{ exitCode: number; output: string }>;
  preview(): Promise<{ url: string }>;
  dispose(): Promise<void>;
}
```

**A capability a provider may lack is a `capabilities` flag, never a `typeof x.internal?.foo`
probe.** v1's search did the probe and reported "no results" where the truth was "not supported."

**Carry over:** `WORK_DIR` is never a literal. One `toProjectRelativePath()` / `toSandboxStoreKey()`
pair, used by every writer. v1 had nine hardcoded `/home/project` literals and a duplicate-key bug
that cost 22.5k tokens per turn because two writers keyed the map differently.

**Known Nodepod issue:** publishing breaks on a missing `util.formatWithOptions`. Fork is paused on
a 1.9.12-vs-1.9.18 base decision. Resolve before building on it.

### 3.2 Multi-user with credits

**Auth: two walls, both load-bearing.**

- Wall 1 — session (is this a verified user?)
- Wall 2 — ownership (`requireOwnedProject`, the *only* way a client-supplied project id becomes a
  project)
- RLS as a backstop, not the mechanism — service-role paths bypass it by design

**Someone else's project returns 404, never 403.** A 403 confirms the id exists and is an
enumeration oracle.

**Ledger: append-only, balance derived.**

```sql
credit_ledger(
  seq          bigserial primary key,   -- order by THIS, never created_at
  user_id      uuid not null,
  delta        integer not null,
  balance_after integer not null,       -- computed by the WRITER under a lock
  reason       text not null,
  ref_id       text,
  created_at   timestamptz default now()
)
```

Three rules, each of which cost v1 real money to learn:

1. **`balance_after` is computed by a Postgres `security definer` function holding a per-user
   advisory lock.** Deriving it in TypeScript reintroduces the lost-update race (two generations
   read 100, both write 60).
2. **Order by `seq`, never `created_at`.** `now()` is the *transaction* timestamp, so back-to-back
   rows tie and the tiebreak falls to a random uuid. This bit the exact debit→refund sequence that
   runs on every failed generation.
3. **Grant uniqueness and payment idempotency are partial unique indexes**, not app-level checks.
   A read-then-write check is a race a Stripe retry sails straight through.

**Test the SQL, not just a TypeScript mirror.** Run real migrations against PGlite. v1's
TypeScript ledger mirror was fully green while a missing FK meant **every production generation
would have billed zero.**

**Pricing:** `credits = ceil(raw_usd / CREDIT_UNIT_COST_USD * CREDIT_MARGIN)`. The margin is only
real if a credit *retails* at `CREDIT_UNIT_COST_USD` — assert `packMargin() >= MIN_PACK_MARGIN` in
a test, or a repriced pack silently inverts your margin. v1 shipped packs at 0.84× against a 3.34×
setting: a ~19% loss per generation, worst on the biggest customers.

**Gate once before the model; settle after. Settlement can never refuse** — so a generation debit
may go negative and nothing else may.

With Inversion 1, add: **bill per completed step.** A job that dies at step 3 bills 3 steps. This
is the honest version of v1's refund-on-failure, and it needs no "was this productive?" heuristic.

### 3.3 Dynamic Agent Reference (the Lovable model)

**Shape:** an index in the prompt, bodies fetched on demand.

```
Baked (always):   reference.md index — ~30 rows, id + one-line description   (~3k tokens)
On demand:        load_reference(id) → full doc body
```

Two rules that v1 learned the hard way:

**1. The model chooses from descriptions. There is no keyword router.**

v1 shipped a `Record<string, string[]>` of substrings. Failures, all silent:
- `'ui'` matched as a bare substring, so `"why is my build failing"` (b-**ui**-ld) loaded a 24KB
  design doc on a debugging question
- 3 of 10 synced skills had no entry and could **never load**
- The router's input included the invoked skill's own body, so `/bt-spec` loaded `bt-landing`
  because bt-spec's text contains the word "landing"
- The keyword table lived in the *consuming* repo, so adding a doc required a TypeScript edit

The same class of bug hit game-genre inference twice more: `"top down twin stick shooter"` matched
the single word `shooter` and mounted an FPS starter. **Genre inference is now deleted entirely and
`no-prompt-classifier.spec.ts` holds it deleted.** Do not rebuild any of these.

**2. Bound loads with a budget, never by withdrawing the tool.**

`MAX_REFERENCE_LOADS = 3`, enforced **in `execute`, never in the zod schema** — a schema violation
kills the generation *after* the tokens are spent. Past the budget, the tool refuses and names what
is already loaded.

**3. Loaded references stick for the conversation.** v1 measured a turn that loaded a skill at 2
steps / 303k prefix / 528 credits, and the follow-ups that *carried* it at 1 step / 169k / 276
credits. Carry them forward, **append-only in first-seen order** — inserting at the front rewrites
the whole cached prefix at 2×.

**Sync:** fetch by commit SHA from `babylontoolkit/agent`, store content-addressed, promote
explicitly. Generations must never depend on GitHub at runtime.

⚠️ **A doc that teaches an API the runtime doesn't have ships a game that runs in dev and can never
be built.** v1 hit this twice: `hideSplashScreenDelayMs` (renamed to `scenePrewarmDurationMs`) and
`GetKeyDown`/`GetKeyUp`/`GetKeyPress` (Unity names that never existed in the Toolkit — three
consecutive generations shipped games crashing in `update()`). Add a **CI check that diffs every
API name in the docs against `babylon.toolkit.d.ts`.** This is the single highest-value piece of
tooling not in v1.

> There is a live instance of this right now: a skill prescribes `babylonjsLoadingDiv` /
> `babylonjsLoadingText` while the shipped template uses `xbabylonjsLoadingDiv` /
> `xbabylonjsLoadingTextDiv`. Same class. The proposed CI check catches it.

### 3.4 Slash skills

**agentskills.io-compliant, authored externally in `babylontoolkit/skills`, consumed here.**

Two invocation paths, and they are genuinely different:

| Path | Mechanic |
|---|---|
| `/bt-landing <brief>` | User names it. Loaded directly, no model choice. |
| Model-chosen | Index in prompt; model calls `load_skill(name)` from descriptions. |

Everything from §3.3 applies: descriptions do the routing, `MAX_SKILL_LOADS = 2` enforced in
`execute`, sticky across the conversation, append-only.

**The one exception worth keeping:** on the first build turn, preload the known-needed pair
(`bt-landing` + `bt-design`) inline with skill tools *off*. That brief is machine-written against
those two skills, so there is nothing to route. It measured 468s → 114s. **One mechanism per turn,
never two** — v1's six-round thrash came from a skill being inlined *while the tool was still
offered*, so the model kept trying to load what it already had.

**Slash commands are exact-match only.** `/clear the obstacles` is a message for the agent, not a
command. A prefix match silently swallows real messages.

**Platform-capability exclusions belong at the store's read seam**, not in a router — some skills
(`bt-gauntlet` needs subagent fan-out and screenshot evidence) can't work on a server tool loop, and
excluding them at read time covers already-synced copies too.

### 3.5 Media generation — the redesign

**This is the part v1 got most wrong. Build it this way instead.**

#### Core rule: media is a queue, never a tool round

```
model                 server                          worker
  |                     |                                |
  |-- request_art ----->|                                |
  |                     |-- enqueue N jobs, return ----->|
  |<-- paths, instant --|                                |
  |                     |                          [one at a time,
  |  (keeps building)   |                           spaced, retried]
  |                     |<---- job N complete -----------|
  |                     |----> client polls, writes file
```

The model's call **returns the destination paths immediately** and never blocks. The build proceeds.
The art lands behind it. There is no round budget, because media consumes no rounds.

#### Serialized, spaced, independently retried

Your original instinct, implemented:

```ts
const MEDIA_CONCURRENCY = 1;      // one at a time
const MEDIA_SPACING_MS = 1500;    // spaced out
const MEDIA_MAX_ATTEMPTS = 3;     // per image, not per batch
```

What this buys over v1's parallel round:

- **Partial success is normal.** 5 of 7 images landing is a good outcome, not a failed one.
- **Per-image retry.** A flaky render retries itself. v1's flaky poll was `≠ failure` by special case.
- **Real progress.** "Generating art — 3 of 7" instead of four minutes of nothing.
- **No refusals, ever.** The build never competes with the art for a budget.
- **Failure is contained.** One bad prompt fails one image.

#### Billing

- Quote and debit **before** any spend, using the exact same lookup the panel's price display uses
- `reason: 'media'` **may never go negative** — it debits before anything is provisioned
- Refund exactly once: per-task serialization + a `refunded` latch
- No price fallback. Unknown model / unmatched options / per-second-without-duration → **refuse**,
  never guess. (LLM models fall back to the *most expensive* row; media must not.)

#### Two surfaces, one service

1. **Media Dialog** — user picks model + options, sees the exact credit price on the button
2. **In-prompt** — the model requests art during a build

Both call one `startMediaTask()`. Never two implementations, or the quote and the debit drift.

#### Format and transparency — carry these forward, they were expensive

- **Photographic art defaults to jpg.** A 2K photographic PNG is ~10MB vs <1MB jpg. v1 froze the
  browser tab at 8,011 MB by base64-ing several of them on the main thread.
- **Transparency is a `transparent: true` flag, not a file format.** Google's image models emit no
  alpha channel at all. Asking for "transparent background" in the prompt makes the model paint a
  **picture of a checkerboard**, baked into the art forever. Real transparency = a second
  `recraft/remove-background` stage (~2 credits), quoted and debited with stage 1 as one task.
  Verified live: 2752×1536 RGBA at 79.2% fully transparent.
- **Type the file-proxy response from the bytes**, not the URL. KIE returns JPEG bytes behind `.png`
  URLs; v1 wrote mislabeled files into projects for months.
- **Never encode media on the main thread.** Web Worker, transfer ArrayBuffers zero-copy.

---

## 4. Carry forward — the expensive lessons

Short list. Each of these cost real money or real data in v1.

**Binary files are bytes, end to end.** Every path — template mount, import, sandbox write,
snapshot, restore, GitHub sync, deploy — carries binaries as `Uint8Array`. base64 is a *wire*
format, never live state. **Never route a binary through the text protocol.** Test: a round-trip
must be sha256-identical. v1 verified this on a 2MB `havok.wasm` against real github.com.

**Never `VITE_`-prefix a platform secret.** Vite inlines `VITE_*` into the client bundle. A
service-role key in a browser hands every visitor every row.

**A server route may act on a secret, never emit one.** Upstream shipped an unauthenticated
`GET /api/export-api-keys` returning `{"Anthropic":"sk-ant-..."}`. "Is a key configured?" is a
boolean.

**Every outbound route needs auth in the handler.** Not in a wrapper's boolean option — v1 had a
`requireAuth` flag nothing read, making ~14 routes *look* protected while anonymous. Enforce with a
**default-deny source scan** that fails any `api.*` handler referencing no wall.

**A user's code lives in their repo.** Nothing pushes without a button press. *Linked* ≠ *synced*.
v1 auto-pushed on every checkpoint — writing to someone's account on its own initiative.

**Never merge.** Divergence is a two-button choice for the user.

**One `isSecretPath` rule in one place.** The narrower `/\.env\.[^/]*local$/` version pushed
`.env.production` — the most dangerous file in the family.

**A restore is not an overlay.** It must delete what's absent, or undo leaves the file it's undoing.
But an empty incoming map deletes *nothing*, and `protect` is a required per-call-site answer to
"what is this map authoritative about?"

**Test discipline that actually caught things:**

- **Mutation-verify every money or safety test.** Break the code deliberately; the test must fail.
  v1 had multiple vacuous tests — one asserted `expect(fraction).toBe(PROGRESS_CAP)`, which moves
  both sides together and passed with the cap set to the exact value it existed to prevent.
- **Default-deny source scans need a control** proving the scanner still detects a violation. A scan
  that silently matches nothing reports a clean bill of health forever.
- **`env()` falls back to `process.env`, and vitest loads `.env.local`.** Any test asserting an
  *unconfigured* state must `vi.stubEnv(..., undefined)` — including every variable in the
  precedence chain, not just the one under test. This trap fired **four separate times** in v1.
- **Drive the real UI before claiming a user-facing feature works.** v1 shipped two data-loss bugs
  with 1,109 tests green; every defect was in the wiring between correctly-tested pieces.

---

## 5. Do not build these

| Don't | Why |
|---|---|
| Keyword routers of any kind | Failed 3× (skills, docs, genre). Descriptions + model choice. |
| Server-side snapshot history | v1 deleted it; it grew back as `current_snapshot_id`. One working copy, derived key, no retention. |
| Server-side MCP | Upstream's is unauthenticated RCE. MCP runs in the user's sandbox. |
| Server-side execution of user code | Ever. |
| BYOK / provider pickers in v1 | Credits-only. One model ladder, operator-configured. Add later behind a flag. |
| Five cache breakpoints | The API max is four. With Inversion 3 you need one. |
| A "waste" metric defined as the shape of a known failure | v1 had five metrics that reported success once their failure was fixed. |

---

## 6. Build order

Each stage ends with something demonstrable.

**Stage 0 — the seams (before features).**
`SandboxProvider` + its default-deny scan. `toProjectRelativePath`. Binary round-trip test. The
brand module + its CI grep gate. *Demo: a file with binary bytes survives mount → read → write.*

**Stage 1 — the job engine.**
Job/step tables, the runner, the journal, resume, the client renderer. **Model calls are stubbed.**
*Demo: kill the tab mid-job; reopen; it resumes at the right step.*

This is the stage that decides whether v2 is better than v1. Do not shortcut it.

**Stage 2 — the agent.**
`write_file` / `edit_file` / `read_file` tools. Base prompt + manifest. `load_reference`.
*Demo: a real creation, ~30k prompt tokens, six visible steps.*

**Stage 3 — users and money.**
Auth, two walls, ledger (PGlite-tested), Stripe, per-step billing.
*Demo: two accounts, correct isolation, a 404 on someone else's project.*

**Stage 4 — media.**
Queue, worker, serialized + spaced, Media Dialog, in-prompt requests.
*Demo: seven images requested, rendered one at a time with visible progress, build never blocked.*

**Stage 5 — skills, sync, persistence.**
`/slash`, skill sync, GitHub sync, share/remix.

**Stage 6 — the doc/runtime API check.** (§3.3)

---

## 7. Definition of done

The reliability bar, stated as tests:

1. **Resume.** Kill the browser at any step of a creation. Reopen. It resumes and completes.
2. **No silent step.** No step exceeds 60s without emitting output or a heartbeat with a cause.
3. **Partial credit.** A job dying at step 3 of 6 bills 3 steps and says exactly that.
4. **Media independence.** Request 10 images on a build. The build completes on time. The images
   land afterward, one at a time, with progress. **Zero refusals.**
5. **Cost.** A creation's prompt is under 40k tokens. Cold and warm runs bill within 10%.
6. **Byte identity.** A 2MB binary survives mount → sandbox → GitHub → clone → mount, sha256-equal.
7. **Auth.** Every `api.*` route fails the default-deny scan or names a wall.
8. **Docs match runtime.** CI diffs every API name in the reference against `babylon.toolkit.d.ts`.

---

## 8. What v1 got right — port it, don't re-derive it

Not everything needs rebuilding. Take these as-is:

- The **credit ledger SQL** — the advisory-lock function, `seq` ordering, partial unique indexes
- **`isSecretPath`**, `restore-plan.ts`, `sandbox-paths.ts` — small, pure, exhaustively tested
- The **binary round-trip** test suite
- The **brand module + CI gate**
- `cache-probe.mjs`, `stream-probe.mjs`, `compare-generations.mjs` — these diagnostics answered
  questions no server aggregate could, and each was written *after* a wrong diagnosis
- The **Marketplace price list** — one versioned document, promote/rollback, no prices in env vars
- **`babylon.toolkit.d.ts` is never baked into the prompt.** ~490KB / ~130k tokens — bigger than
  your entire target creation context.

And the largest asset of all: `CLAUDE.md`. Forty invariants, each one a bug someone paid for. Most
become unnecessary under §2's inversions — but read every one before deciding it doesn't apply.
