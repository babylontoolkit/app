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
| §0.4 | **Where v1 actually is now** — the prefix was fixed; reliability did not move |
| §1 | Diagnosis — five root causes |
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
thing doing the "all" routinely runs *eleven* minutes without emitting a byte.

Fix that one property and most of the 40+ invariants in `CLAUDE.md` stop being necessary.

> **That paragraph was a prediction when it was written. It has since been tested, and it held.**
> The prompt *was* fixed — 4× smaller, §0.4 — and reliability did not move at all. The two creations
> that ran afterward took 12–14 minutes and charged 753 and 1,162 credits; one of them ran into the
> provider's output ceiling, dropped ten closing tags, welded nine files into one 94KB file and
> shipped no game. **It was never the prompt.** It is the shape of the turn (§1.1), the channel the
> files ride in (§1.2), and the fact that the response physically does not fit (§1.5).

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

- The **file dump** is bolt.diy's, inherited unexamined. Upstream puts the project's files in
  the prompt; that is `createFilesContext` and it is how the fork works. What made it catastrophic
  here is *our* starter: bolt.diy's templates are ~15 files of Vite + React, and the Babylon Toolkit
  starter is **88**, including a read-only demo class library and a framework system directory. Same
  mechanism, six times the payload. Measured on a real project: **36,453 tokens, 47% of the prefix.**
  > ⚠️ An earlier draft of this section called it "the 155k file dump," and §1.3 called the creation
  > prefix "170,371 prompt tokens." **Both were wrong.** 170,371 was the *sum of `promptTokens`
  > across four steps*, not a prefix; the real cached prefix was **77,699**. Corrected here because
  > this document's whole argument is that unexamined numbers drive bad decisions, and an inflated
  > one pointed at the right fix for the wrong reason — see §0.4, where the right fix landed and the
  > complaint did not go away.
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

### 0.4 Where v1 actually is now — the prefix got fixed, and reliability did not move

**Between the first draft of this document and this revision, §3.3 and Inversion 3 were both built
into v1 and driven live.** That is not a footnote; it is the experiment that tells you which half of
this document was right.

| shipped | commit | measured |
|---|---|---|
| On-demand docs — `load_reference`, keyword doc router deleted | Phase 2, `creation-cost_plan.md` | base prompt **137,969 → 57,208 bytes**; **−82k tokens** off the creation prefix |
| File manifest replaces the dump | `81db063` | **131,231 → 2,536 chars** — 52× |
| `read_file` — the other half of Inversion 3 | `554cc1a` | the dump showed 70 files; the model reads ~8 |
| Manifest wired, starter/game-code split retired | `992e0e5` | cached prefix **77,699 → 37,713** |
| Media: one at a time, spaced, retried; round budget deleted | `c0fa312` | §3.5 as written, shipped |
| Loud "this build did not finish" verdict | `7433c30` | three states, persisted annotation |
| Cache writes billed to the customer at the READ rate | Phase 1 | cold vector **346 → 91 credits** |

**The prefix work worked exactly as predicted.** The cached prefix is now **38,591 tokens** — inside
§8's "under 40k" bar, down 4× from where this document started complaining.

**And here are the two creations that ran after all of it landed** (2026-08-08, Anthropic direct):

```
gen_mskbklu7  fable-5   prefix 38,595   out 64,703   753 credits   12.3 min
              step 2:  685,491ms · 61,221 out · 71,322 chars text     ← ONE step, 11.4 minutes
              tags 10 open / 10 close — this one landed its files
gen_mskc4r0y  opus-5    prefix 38,591   out 76,664  1,162 credits   14.0 min
              step 3:  688,305ms · 64,000 out · 90,288 chars text  ← stop reason: max_tokens
              tags 14 open /  4 close — nine files welded into one, no game shipped (§1.2)
```

Both were rescued by an automatic pass and settled `stop+creation-completeness`. Both cost 5–8× the
target and took 12–14 minutes. **The difference between the one that worked and the one that
destroyed its own output is whether the model happened to keep emitting closing tags across an
eleven-minute response** — which is not a property anything in the system controls, measures, or
checks. That is the owner's complaint, in the log, on the version with the fixed prompt.

**Where the customer's 1,162 credits actually went:**

| | credits | share |
|---|---|---|
| **output** | **767** | **66.0%** |
| uncached input (conversation + tool results re-sent each step) | 364 | 31.3% |
| cache write | 15 | 1.3% |
| cache read | 15 | 1.3% |

**The entire cached prefix is 2.6% of the bill.** Output, plus the conversation growth that output
causes, is **97%**. Every mechanism in §0.3 — and every remaining prefix idea — is competing for that
last 2.6%.

**So the three conclusions that should shape v2:**

1. **The prefix was a real problem and it is now a solved one. Do not re-fight it, and do not expect
   the fix to buy reliability.** It bought cost headroom, which is worth having, and it is the reason
   §3.3 stays in this document. It is not why creations stop.
2. **Cost is now an OUTPUT problem, and output is also the entire wall clock.** 64,703 and 76,664
   output tokens, decoded serially. No cache, no breakpoint, no manifest and no warmer touches either
   number. The only lever on output-per-response is *emitting less per response* — which is
   Inversion 1, and nothing else.
3. **§0.3's lesson survived being learned.** "Benchmark against the outside before optimising the
   inside" was applied to the prefix and the prefix got 4× better. The same discipline was never
   applied to the shape of the turn, so the turn is still one 11-minute step that overruns the
   provider's output ceiling. **An improving metric still is not evidence you are on the right
   branch** — it just tells you which branch you are on.

---

## 1. Diagnosis — five root causes, not forty bugs

`CLAUDE.md` records roughly forty never-regress rules. That density *is* the finding: they are not
forty independent mistakes, they are **five structural choices, each generating bugs faster than
they could be fixed.**

§1.5 is the one that is still actively breaking creations today, and it is the one that proves the
other four are structural rather than incidental. Read it even if you skim the rest.

### 1.1 The monolithic turn

One generation must: gather its context, decide the design, generate art, write the landing page,
write the chrome, write the game code, write the spec, and answer — in a single streamed response.

From the last creation before this revision (`gen_mskc4r0y`, opus-5, 2026-08-08):

```
prefix 38,591 · completion 76,664 · 1,162 credits · 837,075ms total
step 3: 688,305ms · 64,000 out · 90,288 chars text · 22,847 chars reasoning · stop: max_tokens
```

**One step. Eleven and a half minutes. Sixty-four thousand output tokens. Cut off by the provider.**
The prefix is a twentieth of that step's cost and none of its duration.

| Symptom | Mechanism |
|---|---|
| "Hangs in the middle doing nothing" | Output decodes serially at ~60–110 tok/s. 64k output **cannot** be fast — 688s is the arithmetic, not a stall. |
| **Stops mid-build** | **The response hits the 64,000-token output ceiling mid-file (§1.5).** |
| Provider kills the step | KIE terminates any step emitting no bytes for ~30s. A long think emits nothing. |
| Stuck artifact row, forever | Execution-queue poisoning — one throw killed every later action in the tab. |
| Corrupted source file | A stray `</parameter>` in the text channel lands verbatim in `Home.tsx`. |
| Forced-continuation double-bill | A step claiming `tool-calls` with no tool call re-ran the whole prefix. |
| Half-written project | The model wrote 1 file of 15, said "Writing the full project now.", stopped. |
| Step starvation | Tool rounds and file-writing rounds share one `maxSteps`; reads ate the budget. |
| No partial credit | There is no record of what succeeded. One turn. It lands or it doesn't. |

**None of these are fixable in place.** They are properties of "one turn does everything." v1 has
now proved that the hard way: after the prefix was cut 4×, every symptom above except the first two
rows' magnitude is unchanged.

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

#### 🔴 The proof — a 1,162-credit creation that shipped 4 files, none of them the game

`gen_mskc4r0y`, 2026-08-08, opus-5 on Anthropic direct. Reported by the owner as *"charged me over
1,100 credits and only created 4 files then just stopped."* That is exactly what happened, and the
saved transcript says why. Tag census on the assistant message:

```
<boltAction> opened : 14
</boltAction> closed:  4        ← the model stopped emitting closing tags after the first file
```

Traced in order, the model opened `DESIGN.md` and closed it — then opened **ten consecutive file
actions and closed none of them.** The parser writes a file on **close**, so it went looking for the
next `</boltAction>`, found one 94,000 characters later, and **concatenated nine files into one.**
On disk:

```
src/scripts/KartTrack.ts       93,856 bytes   ← nine files welded together, unparseable
src/scripts/Kart.ts            does not exist
src/scripts/KartFactory.ts     does not exist
src/pages/Home.tsx              1,055 bytes   ← untouched starter
src/chrome/splash.tsx           3,634 bytes   ← untouched starter
```

**Four files reached disk: `DESIGN.md`, `SPEC.md`, one stylesheet, and the 94KB weld.** Not one line
of the game — kart physics, the factory, the game mode, the landing page, the chrome — survived; the
starter files sat untouched underneath. The generation settled `completed`, the user was charged
1,162 credits, and the UI said the game was ready to play.

**Three separate things had to be true, and the text channel is what let them combine:**

1. **The model dropped its closing tags** — throughout, not at the cut: the ten unclosed opens are
   spread from char 2,230 to 88,657, all of them well before the truncation point. Formatting
   discipline simply decays across a 64k-token response. `CLAUDE.md` records this as a recurring
   slip and blames KIE; **this ran on Anthropic direct, so it is a long-response property, not a
   provider defect** — and the sibling creation an hour earlier was 10-for-10 clean, so it is
   **nondeterministic**. You cannot test your way to confidence in it; you can only stop depending
   on it.
2. **The parser's fallback was built for the wrong shape.** It handles *the last action* missing its
   close (search forward for `</boltArtifact>`). It has no answer for *many* actions missing theirs,
   so instead of failing it **silently merged them** — the worst possible outcome, because a merge
   looks like a successful write.
3. **The output ceiling (§1.5) cut the response** at 64,000 tokens mid-file, guaranteeing at least
   one unclosed tag even if the model had been perfect.

**A tool call cannot forget its closing tag.** `write_file({path, content})` either arrives as a
well-formed call with both fields or it does not arrive; there is no state in which nine files
become one. Every layer of this failure — the dropped tags, the merge, the silent success — is
downstream of the decision to ship file contents through a prose channel.

> **If v2 changes one thing from v1, make it this one.** §1.5 explains why builds stop; this
> explains why the ones that stop leave wreckage instead of a partial project, and why nobody
> noticed until a human opened the file.

> **A v1 stopgap, if v1 must keep running:** treat a `<boltAction` opening while already inside an
> action as an **implicit close** of the previous one. Roughly five lines in `message-parser.ts`,
> and it would have saved nine of these ten files. It does not fix the truncation and it does not
> make the channel safe — it just stops one dropped tag from eating the rest of the project.

### 1.3 The model was shown everything, always — ✅ FIXED IN V1, KEEP THE FIX

A 77,699-token cached prefix, of which **36,453 (47%) was the starter tree dumped in** so the model
could "see" the project. That dump is why v1 needed four ordered cache breakpoints, a stable-zone
splitter, an opaque-file classifier, a `CLAUDE.md` promotion path, and a duplicate-key bug that
silently cost 22.5k tokens per turn.

The model reads about eight files. It was shown eighty-eight.

**Fixed in v1** (`81db063`, `554cc1a`, `992e0e5`): a manifest of path + size + kind, plus a
`read_file` tool. 131,231 chars → 2,536. The starter/game-code breakpoint split went with it — at
700 tokens the sharding apparatus cost more in breakpoints than it could save in bytes. **One
entry, sorted, one breakpoint.** Carry this forward as built; §2's Inversion 3 records the design.

**What it did not fix:** anything in §1.1, §1.2, §1.4 or §1.5. Worth stating plainly, because the
saving was large and real and it is tempting to read a large saving as progress on the complaint.

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
the art, or lose the build. Both bad — and both forced by making media compete for the *same step
budget* that has to write the game.

> ⚠️ **Correction, recorded because it is exactly the class of error this document is about.** An
> earlier draft blamed "a 20-second-to-4-minute async render inside a synchronous loop." **That was
> wrong.** `startMediaTask` has always been async-enqueue and returns the destination path
> immediately — the 268 seconds above were the model *reasoning*, not waiting on a render. A budget
> was applied to a cost that did not exist, and then this document justified the budget with the
> same imaginary cost. The real scarcity was **steps**, and the real fix was to stop making media
> and file-writing share a ceiling. Diagnose from the step log, not from the shape of the API.

**Your instinct — one at a time, spaced out — was right, and it shipped** (`c0fa312`):
`MAX_MEDIA_ROUNDS`, the round tracker and the refusal branch are deleted; renders go out singly,
spaced 1500ms, 3 attempts per *image*; and the step ceiling moved with the budget, because deleting
a cap without raising the ceiling trades a refusal for a starved turn, which is worse. Carry the
whole of §3.5 forward as built.

### 1.5 🔴 The response does not fit — and this is what "it stops in the middle" is

**The root cause the other four were hiding, and the one still breaking creations today.**

Anthropic's completion ceiling is **64,000 tokens** (`PROVIDER_COMPLETION_LIMITS.Anthropic` — the
smallest cap across the current lineup, deliberately a floor because undershooting truncates while
overshooting is a hard 400). A creation artifact — landing page, chrome, game code, spec, prose — is
**90,000 to 111,000 characters**. At the ~1.8 chars/output-token that dense TypeScript and CSS
actually tokenize at, **that is 50,000 to 62,000 tokens of artifact, plus 20,000+ of reasoning, in
one response.**

**It does not fit. Not marginally — structurally.** Three consecutive measured creations:

```
33644f7  step 5: 655,957ms · 64,000 out · finish=length+forced-continuation   ← ceiling
mskc4r0y step 3: 688,305ms · 64,000 out · stop=max_tokens · 90,288 chars      ← ceiling
mskbklu7 step 2: 685,491ms · 61,221 out · 71,322 chars                        ← 96% of ceiling
```

**Why it presents as "it stopped for no reason":**

- The cut lands **mid-file**. The artifact protocol (§1.2) has no way to say "that file was
  truncated" — the parser's artifact-close fallback closes the action, the execution queue writes
  the half-file to disk, and it looks like a finished write of a broken file.
- Nothing downstream can tell a truncated project from a finished one by inspection. v1 needed a
  dedicated `truncatedByLength` signal *because* `length` is the only proof; every other signal it
  reads is circumstantial.
- The user was shown **"🎮 Your game is ready — open Preview to play it."** on a build cut off at the
  ceiling, for 1,175 credits. Fixed in `7433c30`; the fix is a better *report*, not a fix for the
  truncation.

**v1 now carries three separate rescue guards, each added after a live failure, all detecting the
same disease from a different angle:**

| guard | fires when | added because |
|---|---|---|
| `shouldForceContinuation` | tool-round cap hit mid-loop | silent truncation after loading a skill |
| `shouldRescueUnproductiveTurn` | announced the work, did none | 524 output tokens bought 83 chars, billed 316 credits |
| `shouldVerifyCreationCompleteness` | a first build turn that may be half-done | wrote 1 file of 15, said "Writing the full project now.", settled `stop` |

They are **mutually exclusive and capped at one extra pass** — so a turn gets at most two streams,
i.e. a hard ceiling of ~128k output tokens for a whole creation, with no third chance. A project
needing more than that **cannot complete, by construction.**

**And the rescue is not cheap.** On `gen_mskc4r0y` the completeness pass alone cost **105,827
uncached input tokens** (the entire truncated artifact re-sent), a **second full 37,689-token cache
write**, and 10,889 output — **≈ 32% of the whole creation's bill, spent recovering from the
ceiling.** More than ten times what the cached prefix costs.

**Nothing about the prompt fixes this.** Not the manifest, not on-demand docs, not a warmer, not a
better breakpoint order. The response is too big for the response. **The only fix is to stop asking
for the whole project in one response** — which is Inversion 1, and is why Inversion 1 is first.

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

**The arithmetic that makes this non-optional (§1.5):** the provider's completion ceiling is 64,000
tokens and a creation artifact is 50–62k tokens of code plus 20k+ of reasoning. One turn *cannot*
carry a creation — v1 hit `max_tokens` on three consecutive measured builds. Split into six steps,
**no step needs more than ~12k output**, which is a fifth of the ceiling and about two minutes of
decode instead of eleven and a half. The step plan is not a nicer way to do the same thing; it is
the only shape that fits in the response window at all.

> **Cap output per step explicitly, at roughly a third of the provider ceiling**, and treat a step
> approaching it as a planning bug — the step was scoped too large. Never let a step discover the
> ceiling; v1's `truncatedByLength` exists because by then the only remaining move is an expensive
> guess about what got lost.

What this buys, none of which v1 can have:

- **Resumable.** Tab dies at step 3? Steps 1–2 are on disk. Resume runs 3–6.
- **Per-step retry.** Step 4 fails → retry step 4, not the build.
- **Honest progress.** "Step 3 of 6 — landing page" is a fact, not a spinner.
- **Bounded output.** No step approaches the ceiling, so no step runs eleven silent minutes and no
  step can be truncated mid-file.
- **Partial credit.** A job completing 4 of 6 bills 4 and says so.
- **Diagnosable.** The journal *is* the diagnostic. v1 needed `steps jsonb`, `tool_rounds`,
  `silentStepOutputTokens` and a whole admin report to reconstruct one turn.
- **All three rescue guards delete.** `shouldForceContinuation`, `shouldRescueUnproductiveTurn` and
  `shouldVerifyCreationCompleteness` (§1.5) are three detectors for "the one big turn didn't
  finish." A step either completed or it didn't, and the journal says which.

**Cost is lower, not merely equal.** Same work, split — but v1's rescue pass re-sent the entire
truncated artifact as **uncached** input and paid a **second full prefix cache write**, ≈32% of the
creation bill. A step plan re-reads a *cached* prefix at 0.1× and re-sends nothing it already
wrote.

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

### Inversion 3 — The model reads files; it is not shown them ✅ BUILT IN V1

Send a **manifest** (path + size + one-word kind, ~700 tokens), a `read_file` tool, and the 3–5 files
that are genuinely always needed (`globals.ts`, the play contract, `vite.config.ts`).

**Built and driven live in v1** (`81db063`, `554cc1a`, `992e0e5`). Measured: dump 131,231 chars /
36,453 tokens → manifest **2,536 chars / ~700 tokens**, and the cached prefix **77,699 → 37,713**.
Everything in `CLAUDE.md` about breakpoint ordering, stable zones and opaque-file classification
became unnecessary and was retired. **One entry, sorted, one breakpoint.**

Port the implementation, and with it the four properties each of which cost a real generation:

- **Cost is proportional to file COUNT, not file SIZE** — assert it as a *ratio* in the spec, not a
  literal, so a dump creeping back under a new name fails the test.
- **Sorted and de-duplicated on the project-relative path.** `Object.keys` is watcher-arrival order,
  so an unsorted listing rewrites the cache entry at 2× for content that did not change; the map is
  client-supplied and can still carry both path spellings.
- **`read_file` never throws** — a wrong path returns a sentence naming near-matches and the same
  generation continues. Every argument is `.optional()` and validated *inside* `execute`: a zod
  violation is enforced before `execute` runs, aborting the stream and killing the generation
  **after** the tokens are spent.
- **`read_file` is in every toolset, including the read-only discuss one.** The files are no longer
  in the prompt, so a turn that can see the manifest but cannot read a body is a dangling
  instruction in its purest form — shown a list and refused every item.

> ⚠️ **The trap this sprang, and it will spring again.** Adding `read_file` to the creation toolset
> without re-deriving `CREATION_TOOL_ROUNDS` **starved the turn**: reads are steps, creation had
> four, it spent them gathering context, hit the cap, and the forced continuation paid a second full
> prefix write (`33644f7`). The file header for `read_file` said "arithmetic against `maxSteps`, not
> a preference" — and the arithmetic was not done, one commit later, by the person who wrote the
> warning. **Any budget sharing a ceiling must be DERIVED from it, never hand-maintained.**

**This inversion and §3.3 are the same idea applied to the two halves of the prefix** — the file dump
and the baked doc corpus. **Both are now done**; together they took the prefix from ~78k to ~38.6k.
Read §0.4 before concluding that finished the job.

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

| | cached prefix | cold start |
|---|---|---|
| bolt.diy / Claude Code, persona snippet | ~a few hundred tokens | none — **~133 credits** |
| v1 as this document was first written | **77,699 tokens** | ~$0.50 of cache write, run to run |
| **v1 today, after §3.3 + Inversion 3 shipped** | **38,591 tokens** | **~$0.72 true, ~30 credits billed** |

**Both halves of this shipped in v1 and both worked.** The keyword doc router is deleted, docs load
through `load_reference(id)` chosen from `description` fields, and the base prompt went
**137,969 → 57,208 bytes (−59%)**, taking **~82k tokens** off the creation prefix. Phase 1 also made
the customer cache-neutral — `decideCredits` prices cache-creation tokens at the READ rate, so a
generation bills the same hot or cold (cold vector: **346 → 91 credits**) while `rawCostUsd` keeps
the true number for the margin report.

**The lesson held exactly: "cold vs warm" is not a fact about caching, it is a symptom of prefix
size.** At 38.6k the cold start costs the *platform* $0.72 and the *customer* nothing, and the whole
apparatus in v1's `spec/context-budget.md` — sharedness-ordered breakpoints, stable zones, the
warmer — is machinery for a number that no longer exists. Do not port any of it.

**What is left in the 38.6k, in order:**

| | ≈ tokens | share |
|---|---|---|
| **two skills inlined on the first build turn** (`bt-design` + `bt-landing`) | **~17,600** | **46%** |
| base prompt (platform rules + reference index) | ~14,300 | 37% |
| asset-library index, media/project notes | ~4,000 | 10% |
| reference index rows | ~2,000 | 5% |
| **file manifest** | **~700** | 2% |

**The single biggest thing in the prefix is now the two-skill preload** — bigger than the platform's
own rules, 25× the file manifest. It is there for a good reason (§3.4: the first build brief is
machine-written against exactly those two, so there is nothing to route, and it took 468s → 114s).
Take the win, but **size it honestly and revisit it before adding a third**; it is the only prefix
lever left worth anything, and it is worth ~17k.

⚠️ And read §0.4 first: **the entire prefix is 2.6% of a creation's bill.** Halving it again saves
about 15 credits of 1,162. This section is finished work; §1.5 is where the money and the reliability
both are.

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

### 3.5 Media generation — the redesign ✅ BUILT IN V1

**The part v1 got most wrong — and then fixed** (`c0fa312`, 2026-08-08). This section shipped as
written: the round budget, the round tracker and the refusal branch are deleted; renders go out one
at a time, spaced 1500ms, with 3 attempts per *image*. Port it as built. Two lessons from shipping
it that are not obvious from the design:

- **Deleting a budget without raising its ceiling trades a refusal for a starved turn**, which is
  worse. One image per round means six images cost six steps; the step ceiling has to move with the
  budget (`MEDIA_IMAGE_ROUNDS`, added to `maxSteps` only on turns that actually have media tools).
  Same arithmetic trap as `read_file` in Inversion 3 — **derive shared ceilings, never hand-maintain
  them.**
- **The retry wraps only `provider.create`**, so the debit still precedes it and a retry never
  re-debits. A deterministic refusal (4xx, "invalid", "unsupported") fails fast instead of burning
  backoff on an answer that will not change.

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
silently.** The chrome has moved twice — out of the framework directory, then renamed again to its
current home at `src/chrome/**`. The model writes `src/chrome/splash.tsx` into a starter whose file
still sits under the previous name — and the project builds,
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

**A shared ceiling is DERIVED, never hand-maintained.** v1 added `read_file` to the creation toolset
without re-deriving `CREATION_TOOL_ROUNDS`, and the turn starved: reads are steps, creation had four,
it spent them gathering context and hit the cap. The same trap fired on the media budget. **If two
budgets consume one `maxSteps`, the total must be computed from the parts** — and asserted as a
*relationship* in a test, never as a literal, or the next person to add a tool reproduces it. The
file that starved had a header saying "arithmetic against `maxSteps`, not a preference." Prose does
not do arithmetic.

**An automatic transition on a paid path must be visible to the USER, not only to the machine.**
v1 cut a build off at the output ceiling for 1,175 credits and showed *"🎮 Your game is ready — open
Preview to play it."* Every marker existed server-side — `finish_reason`, the monitoring alert, the
admin count — and none of it reached the person looking at the broken project. Port the fix's shape
(`7433c30`): **one pure function, shared by server and client** so the two can never disagree about
what "finished" means, returning three states —

| `finished` | nothing intervened | celebrate |
| --- | --- | --- |
| `rescued` | an automatic pass saved it | a quiet note, no action |
| `incomplete` | we cut it off | a persistent alert with a "Finish the build" action |

**`incomplete` outranks `rescued`** — a truncated turn that was also rescued is still truncated, and
reporting the rescue describes the treatment while hiding the injury. The verdict rides on a
**persisted annotation, not a toast**: the build this exists for is one the user walks away from
believing it worked. And **`finished` must stay the common case** — a warning that fires on healthy
builds is one users learn to ignore, so it needs a control test in both directions.

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
| A metric defined as the shape of a known failure | See §5, and §8 item 8 — this document did it too. |
| Auto-push, auto-merge, or anything that writes to a user's account unasked | §4.3. |
| **Rescue passes that detect "the big turn didn't finish"** | v1 has three, mutually exclusive, capped at one extra pass — and one of them costs ~32% of a creation's bill. Under Inversion 1 a step either completed or it did not. §1.5. |
| **A parser that repairs malformed file syntax** | v1's fallback for a missing `</boltAction>` silently welded nine files into one and reported success. You cannot make a prose channel safe; you can only stop using it (§1.2). |
| **A budget or ceiling maintained by hand next to the one it shares** | Starved the creation turn twice — `read_file`, then media. Derive it, assert the relationship. §5. |

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
`load_reference` + `web_fetch`. **Port the manifest, `read_file`, `load_reference` and the reference
index from v1 — they are built, measured and working (§0.4).**
*Demo: a real creation, ~30k prompt tokens, six visible steps, a playable game — and §8 item 6:
every file the job claims is on disk, parses, and contains only itself.*

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
6. 🔴 **Every file the model said it wrote exists on disk, and no file contains another.** Run a
   creation; diff the set of files the job claims against the sandbox; assert each one parses.
   **v1 passes every other test on this list and fails this one** — `gen_mskc4r0y` claimed 14 files,
   wrote 4, welded 9 into a 94KB `KartTrack.ts`, and reported success (§1.2). This is the test that
   would have caught it, and it is the only one on this list that requires looking at bytes rather
   than at metrics.
7. 🔴 **No step is ever truncated by the provider.** Assert `finish_reason !== 'length'` /
   `stop_reason !== 'max_tokens'` across a run of real creations, and alert on the *rate* in
   production. Cap output per step at ~⅓ of the provider ceiling (§2, Inversion 1). v1 hit the
   64,000-token ceiling on three consecutive measured creations and only discovered it by reading a
   server console log.
8. **Cost — measured on the OUTPUT side, not the prompt side.** A creation bills **≤ 500 credits**,
   and **no single step emits more than ~12k output tokens.** The prompt bar (under 40k prefix, under
   5k system prompt) is retained but is **no longer the interesting number**: v1 met it — 38,591 —
   while creations cost 753–1,162 credits and ran 12–14 minutes, because **the prefix is 2.6% of the
   bill and output is 66%** (§0.4). Cold and warm runs must bill within 10% of each other; the
   reference point is bolt.diy answering *"make me a mario kart clone"* in ~133 credits.
   > ⚠️ **Item 8 is written this way on purpose.** The old version of it measured prompt size alone —
   > which meant it went green on the release that produced the two worst creations in the product's
   > history. That is §5's "a metric defined as the shape of a known failure" happening inside this
   > document's own definition of done. Re-derive these bars whenever a pathology is fixed.
9. **Byte identity.** A 2MB binary survives mount → sandbox → GitHub → clone → mount, sha256-equal.
10. **A stranger can play it.** Publish, open the link in a clean browser profile, play the game.
11. **Auth.** Every `api.*` route names a wall or fails the default-deny scan.
12. **Docs match runtime.** CI diffs every API name in the reference against `babylon.toolkit.d.ts`.

> **Items 6 and 7 are the reliability bar.** Everything else on this list was green in v1 on the day
> it shipped a 94KB welded file and charged 1,162 credits for it.

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
| **`file-manifest.ts` + `read_file`** | Inversion 3, built and measured — 52× less prefix (§1.3) |
| **`reference-index.ts` + `load_reference`** | §3.3, built — base prompt −59%, docs on demand |
| **`billedUsage` / `decideCredits`** | The customer is never billed for the state of our cache |
| **`media/dispatch.ts`** | §3.5 as shipped — one at a time, spaced, retried per image |
| **The three-state build verdict** (`7433c30`) | One pure function, server + client, `incomplete` outranks `rescued` |

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
