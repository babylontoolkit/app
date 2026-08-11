# spec/fail-loud.md — A paid request never fails silently (governs SPEC §4.2, §4.6, §4.16; owner directive 2026-07-25)

> **Status: POLICY ADOPTED, STAGES A + B + C + D DONE (D drove live 2026-07-26).** Owner directive
> (2026-07-25, verbatim intent): *"we should never have silent fails on a paid service that burns
> credits."* Much of this document describes guards that already exist — they are listed so nobody
> rebuilds them. **Nothing in the four-stage plan is owed any more** — A, B and C landed 2026-07-25 and
> D drove live 2026-07-26 — so §"The four stages" is now a record of what was built and why, not a
> to-do list. Three things are deliberately NOT covered and are named where they are decided rather
> than left to be rediscovered: the KIE **create-time** media failure branch is still unit-proven only
> (§"Stage D"); `web_search`'s after-the-fact debit stays sanctioned (§Scope); and the
> `transport-envelope` tripwire stays a per-occurrence alert rather than a rate (§"Stage C").
> **Stage A's inventory is §"The money-path inventory" below**; the
> three defects it found are fixed and pinned (`media.spec.ts` orphan refund,
> `enhancer-settlement.spec.ts`, `money-swallow-alert.spec.ts`), all mutation-verified. **Stage B is
> `billing/money-paths.spec.ts`** — default-deny over every ledger-debiting call site, enumerated from
> disk, with three scanner controls; four mutations verified. **Stage C is
> `monitoring/paid-path-rates.ts`** — the rescue markers and per-reason refunds watched as RATES, with
> the marker counts on the §4.10 Admin panel; five mutations verified.

## Why this spec exists — the day that produced it

On 2026-07-25 an investor demo failed on `/bt-spec add user authentication…`. The generation billed
**316 credits**, recorded `status: 'completed'`, `finishReason: 'stop'`, and delivered 83 characters
of *"I'll load the bt-spec skill workflow…"* — then nothing. The user watched a screen that "just
sits there". Three defects were found behind it that day, and **every one was silent**:

1. **Every `/slash` invocation ever served was dropped** — the parse miss returned `null` one branch
   *above* its own unknown-skill warning. No error, no log, nothing in `skillsLoaded`.
2. **The promise-and-stop billed as a success** — `!producedText` could not see it, because a promise
   is text.
3. **File bodies in user messages re-shipped uncached forever** — the token count only ever went up
   slowly, which no one watches.

They join a family this repo keeps rediscovering: the `credit_ledger.generation_id` FK that would
have made **every production generation bill zero** (settlement swallows errors by design, so the
reject vanished); the enhancer that settled correctly while the **UI balance drifted** for the rest
of the session; the doubled `drain` that recorded a **twice-billed generation as `finish=stop · 0
tool rounds`**; the `/bt-landing` run that settled **427 credits and evaporated with the tab**
(§4.5.4c); and KIE's adapter regressing thinking text to empty **while still billing the tokens**
(§3.4a). Different subsystems, one shape: **money moved, nothing anyone could see said what it
bought.**

The structural reason is worth stating once: on this platform a failure's natural presentation is a
*cheaper-looking turn* — fewer tokens, a clean `stop`, a green suite. Every incentive in the
telemetry points the wrong way. Loudness therefore cannot be an instinct applied where someone
remembers; it has to be a rule with a guard behind it, which is what this spec is.

## Scope

Primary: **every request that reaches KIE** — LLM generations (`/api/agent`, incl. repairs, forced
continuations, the unproductive rescue, paid model tiers), the enhancer (`/api/enhancer`), and media
renders (§4.16, both stages of a cut-out). Binding equally: every other ledger debit — the full
`LedgerReason` set is `grant | purchase | generation | media | search | license | project_create |
refund | promo | adjustment` (`billing/ledger.ts`), and the debiting members (`generation`, `media`,
`search`, `license`, `project_create`) all carry this contract. `search` debits AFTER the vendor
returned and may go negative by design — that is a documented posture, not a silent failure.
`project_create` (migration 0015) is the opposite posture: it debits BEFORE anything is provisioned,
so it refuses rather than overdraws, and its refund path is the deletion of a project that never
completed a generation.

## The core rule: four terminal states, and no fifth

Every credit-spending request ends in **exactly one** of:

| State | Meaning | The pattern that implements it |
|---|---|---|
| **DELIVERED** | The thing asked for exists and is *observable*: file actions applied, text streamed, bytes at the dest path, `license.json` returned | Judged from what WE observed (`textChars`, actions, sniffed bytes) — never from the provider's `finishReason` (see rule 7) |
| **REFUSED BEFORE SPEND** | 4xx with a describable reason; **zero debit** | The media pattern: quote → refuse (`lookupMediaPrice` → null → 402/400); unpriced model refused; caps checked before the gate |
| **REFUNDED** | The debit stands (it happened) + a compensating `refund` row + an error the user can see and Retry | Zero-text hard failure; media render failure (refund-exactly-once latch); license `grant()` race loser |
| **CHARGED AS CONSUMED** | A **Stop** — the user's own abort, billed to the abort point | §4.12. A Stop is never a failure and never refunds |

**"Completed with nothing to show" is not a state.** A generation that ends outside these four is a
defect by definition — the 316-credit promise was exactly that, and the fix (the unproductive
rescue) works by forcing the turn back into DELIVERED or, failing that, letting the zero-text check
route it to REFUNDED.

**The reporting corollary:** any *automatic* transition on a paid path — a rescue, a forced
continuation, a retry, a degradation, a clamp — must leave a machine-visible trace (a `finish_reason`
marker, a monitoring event, a ledger reason) even when it succeeds, and a user-visible one whenever
the user's outcome differs from what they asked for. A rescue that leaves no trace is how the next
regression hides *inside* the machinery built to catch the last one.

## The standing rules

1. **Four terminal states** (above). New debit path → say which states it can reach and how, in its
   doc comment, before it ships.
2. **A degraded capability reports OFF, never ON** (`modelTiersSessionHint` precedent, née `premiumSessionHint`, §4.2a/§4.6.1a — it reports per-rung `available` AND `serveable`, so "you cannot afford it" and "the operator has not configured it" stay distinguishable). Honest
   downgrade beats an advertised feature that hard-fails on use.
3. **A best-effort step that cannot fail the request must still REPORT** (`remixBlockedReason`
   precedent, §4.5.4b). Keeping the request successful is right; keeping it *quiet* is the defect.
4. **`catch` + log is not handling on a money path.** A swallowed error must refund, retry, or
   surface a reason the caller can render. Exactly two sanctioned swallows: observability itself
   (the monitor never throws — a narration channel must not break what it narrates) and the
   documented `'search'` after-the-fact debit. Anything else needs a written sentence beside it.
5. **A settled charge the UI cannot see is a defect even when the ledger is right** (the enhancer
   lesson). Every debit path must move the on-screen balance — annotation or `refreshSession()`.
6. **A guard is only real if a test fails when it is removed.** Mutation-verify. All three of
   2026-07-25's failures shipped behind a green suite; two of the guards that would have caught them
   (`slash-invocation.spec.ts` building its input the way the CLIENT builds it, the
   `transport-envelope` source scan with a control) exist precisely because a test that asserts what
   the code's own regex describes proves nothing.
7. **The provider's word is not evidence.** `finishReason` is a claim (`shouldForceContinuation`),
   returned bytes are typed by sniffing (`lib/media/sniff.ts`), thinking text can be silently empty
   while billed (§3.4a). Deliverables are judged from what we measured.
8. **Silence is narrated, never endured** — the heartbeat (§3.4a): during a legitimately long think
   the user sees a ticking status, so "working" and "dead" are never the same pixels. It is a
   liveness signal only; it never fabricates content.
9. **When you fix a pathology, re-derive whether its metric still measures it.** Five metrics have
   now died reporting zero (`wastedOutput`, `tool_rounds`, `charsPerOutputToken`, the thinking
   estimate, the overwritten `finishReason`). A metric encoding the shape of the old failure reports
   success on the new one.

## Already enforced — do not rebuild

| Guard | Where | Catches |
|---|---|---|
| Zero-text → hard failure → auto-refund | `proxy.ts` (`producedText`) | The clean-`stop`-that-said-nothing (10,054 tokens, 405 credits) |
| Unproductive-turn rescue, ONE bounded pass, `+unproductive-rescue` marker | `agent/unproductive.ts` + `proxy.ts` | The 316-credit promise; preamble-only turns |
| Forced continuation, gated on a REAL last-step tool call | `shouldForceContinuation` | Tool-cap truncation, without the 2× spurious re-run |
| Transport-envelope strip + loose drift tripwire → monitoring | `chat/message-envelope.ts`, `transport-envelope.spec.ts` | The `/slash` drop, and its silent return under a changed format |
| Media: quote=debit, refuse-not-guess, refund-exactly-once latch, never-negative `'media'` | `media/service.ts`, migration 0009 | Charging for renders that cannot be priced or never delivered |
| Byte sniffing on the media file proxy | `lib/media/sniff.ts` | JPEGs shipped as `.png` on the provider's say-so |
| Refund/settle ordered by `seq`, never `created_at` | migration 0003 | The refund that read the wrong row and skipped the debit |
| `generations` row anchored inside `settleGeneration` | `billing/generations.ts` | The FK reject that would have billed zero forever |
| Enhancer `refreshSession()` on stream end | `usePromptEnhancer` | The correctly-settled charge the screen couldn't see |
| Failure-RATE alerting | `monitoring/failure-rate.ts` | A spike of hard failures, as a rate rather than anecdotes |
| Heartbeat during stream silence | `agent/heartbeat.ts` | Long thinks reading as hangs while credits burn |
| `finish_reason` markers `+forced-continuation` / `+unproductive-rescue` / `+provider-retry` | `proxy.ts` | Doubled/rescued generations recording as ordinary turns |
| `LEDGER_INTEGRITY` alerts on the un-throwable money writes | `gate.ts`, `media/service.ts`, `unity-license-service.ts` | Anchor/charge/refund failures that were log-only, i.e. invisible in production |
| Media task-record write refunds if it cannot be stored | `media/service.ts` | A paid, running render that nothing can poll and nothing can refund |
| Enhancer zero-text / stream-error → refund + `failed` | `api.enhancer.ts` | A truncated or empty enhancement charged as a success |
| Default-deny over every ledger-debiting call site | `billing/money-paths.spec.ts` | A debit path shipping with no refund, no alert and no written excuse — the moment it lands |
| `RESCUE_MARKER_RATE` / `REFUND_RATE` rolling windows | `monitoring/paid-path-rates.ts` | A rescue quietly absorbing an upstream regression; a subsystem refunding most of its work |
| Rescue-marker counts on the usage panel | `admin/usage-report.ts` → Admin tab | Rescued turns, which look completely ordinary in every other number on the page |
| Truncated-action rescue (opens > closes) | `agent/action-tags.ts` + `unproductive.ts` | A turn cut off mid-`<boltAction>`: artifact card with no rows, no file written, billed in full |

## 🔴 THE GUARD THAT WAS DISARMED BY THE THING IT GUARDS AGAINST (2026-08-10)

Reported by the owner, for the third or fourth time, as the thing that would stop them shipping:
*"I was supposed to be fixing the pac man player, but just sitting there. THAT IS SO BAD FOR PAID
CREDITS — the user paid for that work and nothing."*

**Measured, `gen_msn0zl5h_44wpni`:** 44,582 prompt + 13,436 completion tokens, **240 credits
($0.696)**, `status: completed`, no refund, no rescue. The saved transcript's last assistant message:

```
<boltArtifact  ×1     </boltArtifact>  ×0
<boltAction    ×1     </boltAction>    ×0
```

…ending mid-diff on the literal text `>>>>>>> REPLACE`. **The action runner only executes a CLOSED
action**, so no file was written. On screen: an artifact card with a title and nothing under it —
visually identical to "still working", except the turn was over.

**Why nothing caught it.** `shouldRescueUnproductiveTurn` opened with
`if (aborted || alreadyContinued || emittedAction) return false`, and `emittedAction` is
`text.includes('<boltAction')` — the **opening** tag. So the guard against *"announced work and did
nothing"* was switched off **by the announcement itself**. Every other signal agreed with it: 7,695
chars is long, the turn called a tool, and the prose was confident. The one mechanical fact that
disagreed — that the action never closed — was the one nothing measured.

**Fixed** with an explicit `truncatedAction` (opens > closes), checked **before** the `emittedAction`
bail. A truncated action is the strongest possible rescue signal, because no interpretation is
involved: the model did not choose to stop.

### Never regress, each silent

- **Order is load-bearing.** `truncatedAction` must be tested BEFORE `emittedAction`. Moving it after
  restores the bug exactly, and every other test in `unproductive.spec.ts` still passes
  (mutation-verified: the ordering swap fails 3, and rescuing on any emitted action fails 4).
- **Count closes, never opens.** `emittedAction` is deliberately left alone and NOT redefined —
  `creation-completion.ts` reads it meaning "it emitted ONE action", and silently changing that would
  move a second decision nobody re-checked.
- **`>` and not `!==`.** A stray close with no open is a harmless parser oddity; treating it as
  truncation rescues turns whose files all landed, doubling the cost of healthy builds.
- **The counter lives in `action-tags.ts`, not inline in `proxy.ts`.** It shipped inline, where no test
  could reach it — the `execution-queue.ts` lesson ("a behaviour no test can reach is how a one-line
  bug survives"). It carries `needle.length - 1` chars of lookback because a provider may split a tag
  across deltas; get that wrong and the count is silently low, which reads as truncation on **every**
  healthy build and buys a second billed pass on all of them.

### The second-order finding

This is also where the stray `=======` / `>>>>>>> REPLACE` conflict markers in shipped source come
from (`RaceHud.tsx`, 2026-08-09, which broke `/play` entirely and took two turns to repair). A
truncated `type="edit"` leaves SEARCH/REPLACE syntax where code should be. **The same defect that
silently bills for nothing also silently corrupts files** — so this guard is not only a money fix.

⚠️ **NOT yet driven live.** The predicate and the counter are unit-tested and mutation-verified against
the real transcript's chunking, but the end-to-end path — truncation → rescue → files landed — has not
been observed on a live generation.

## The money-path inventory (Stage A output, 2026-07-25)

Enumerated from the **ledger API's callers**, not from a keyword — `getLedger(...).append` has
exactly 11 call sites, and every one is below. The KIE-reaching set is enumerated separately
(reaching the provider is what makes a path expensive even when it never touches the ledger).

### Every ledger write

| # | Call site | Reason | States it can reach | What reports each transition |
|---|---|---|---|---|
| 1 | `billing/gate.ts` `settleGeneration` | `generation` | DELIVERED · CHARGED AS CONSUMED | `credits` annotation → client balance; `generations` row; `agent-usage` log |
| 2 | `billing/gate.ts` `refundGeneration` | `refund` | REFUNDED | compensating row; `finish_reason: error`; `status: failed`; §4.10 refund audit |
| 3 | `media/service.ts` `startMediaTask` | `media` | REFUSED BEFORE SPEND (unpriced / 402 / 4K cut-out / empty prompt) · DELIVERED | quote = debit (same code path); `media-task` data part; panel + tool result name the exact price |
| 4 | `media/service.ts` `refundMediaTask` | `refund` | REFUNDED | `refunded` latch (exactly once); task record `status: failed` + `error`; toast |
| 5 | `agent/web-search-tool.ts` `debitSearch` | `search` | DELIVERED only | **SANCTIONED after-the-fact debit** (§Scope). May go negative; a failed debit is logged and the research answer proceeds |
| 6 | `licensing/unity-license-service.ts` | `license` | REFUSED BEFORE SPEND (invalid tier / 402) · DELIVERED | flat price shown on the button; unlock row makes re-issue free |
| 7 | `licensing/unity-license-service.ts` `refundLicense` | `refund` | REFUNDED | grant-throws and grant-race-loser paths; `LicenseRefusedError` to the caller |
| 8 | `billing/ledger.ts` `ensureSignupGrant` | `grant` | credit — not a debit | partial unique index; `DuplicateGrantError` → null |
| 9 | `billing/stripe.ts` pack purchase | `purchase` | credit — not a debit | idempotent on `session.id`; `DuplicatePaymentError` → 2xx |
| 10 | `billing/stripe.ts` subscription invoice | `purchase` | credit — not a debit | idempotent on `invoice.id`; unattributable invoice logged loudly, never 500 |
| 11 | `routes/api.admin.credits.ts` | `adjustment` | operator action | admin-only; append-only row; §4.10 audit |

### Every KIE-reaching call site

| Path | Gate | Settles | Failure handling |
|---|---|---|---|
| `agent/proxy.ts` (generation, repair, forced continuation, unproductive rescue, paid model tiers) | `checkCreditGate` once | `settleGeneration` in `finally` | zero-text → hard failure → auto-refund; abort → CHARGED AS CONSUMED |
| `routes/api.enhancer.ts` | `checkCreditGate` | `settleGeneration` on stream end | **FIXED in Stage A** — see defect 2 |
| `media/kie-client.ts` `create` | debit precedes it | n/a (fixed price) | create throws → refund + anchor `failed` + 502 |
| `media/kie-client.ts` `query` | n/a | n/a | flaky poll ≠ failure (stays pending); a reported failure refunds once |

### The `catch` audit — `app/lib/.server/{agent,billing,media}`

52 `catch`es, every one classified. **Report** = logs *and* alerts monitoring; **log-only** was the
category Stage A removed from the money paths.

| Classification | Count | Examples |
|---|---|---|
| Rethrow (with a typed refusal) | 6 | `MediaRefusedError`, `LicenseRefusedError`, `DuplicatePaymentError` re-raise, KIE non-JSON |
| Refund | 5 | media create-failure, media poll-failure, cut-out-cannot-start, license grant-throw, license race-loser |
| Report (alert + log) | 4 | **new in Stage A** — anchor failure, charge failure, generation refund failure, media/license refund failure |
| Retry | 1 | `retry-policy.ts` — one provider retry, only with zero output produced |
| Sanctioned swallow (with its sentence) | 36 | observability itself (`monitoring`, `heartbeat`); the documented `'search'` debit; parse/probe misses that return `null` (`store.ts`, `attachments.ts`, `kie-client.ts` result shapes); best-effort enrichment that runs AFTER settlement (`usage.ts`, `generations.ts` upsert, `recoverTranscript`); `providerRates`' premium injection (documented: settlement may never refuse) |
| **Unclassifiable — FIXED** | 3 | the three defects below |

### The three defects Stage A found

1. **A media render could be paid for, started, and then untrackable** (`media/service.ts`). The
   `putMediaTask` write happens AFTER the debit and AFTER KIE starts rendering, and it was
   unguarded. An object-store hiccup there produced a **fifth terminal state**: credits gone, render
   running, no record for the poll route to deliver from, no record for the failure path to refund
   from — and the tool result said only that the task "could not start", which reads as a refusal
   that cost nothing. Now: refund, anchor `failed`, and a 500 that says what happened. Pinned in
   `media.spec.ts` (mutation-verified: the test fails when the guard rethrows instead).
2. **The enhancer could only ever reach two states** (`routes/api.enhancer.ts`). It settled every
   outcome as DELIVERED. A `part.type === 'error'` mid-stream was `break` + a log line, and a
   zero-text finish was not checked at all — so a truncated or empty enhancement was charged, with
   the browser holding a broken response and nothing anywhere reporting a problem. This is the
   proxy's `producedText` rule (a clean `stop` with nothing to show is a FAILURE) missing from the
   subsystem that has the least machinery to notice. Now: stream error **or** zero text → refund +
   `status: failed`. Its four-state mapping is in the route's doc comment (the §"When you add a paid
   path" checklist item). Pinned in `billing/enhancer-settlement.spec.ts` — ⚠️ deliberately NOT in
   `app/routes/`, where Remix would compile it as a route and 500 every request.
3. **Four money-path swallows were log-only, i.e. invisible in production** (`gate.ts`,
   `media/service.ts`, `unity-license-service.ts`). Rule 4 forbids `catch` + log on a money path, and
   these three writes genuinely cannot refund or retry their way out — settlement runs inside the
   proxy's `finally`, and a refund is itself the compensating step for an already-failed request — so
   **reporting is the only loudness available to them**. The FK-anchor failure is the exact defect
   that would have billed ZERO on every production generation forever, and it announced itself only
   in a log line nobody reads. All four now fire `ALERT_SIGNALS.LEDGER_INTEGRITY` at `critical`.
   Pinned in `billing/money-swallow-alert.spec.ts`, **with a control** proving the collector sees
   traffic at all (the `no-server-storage.spec.ts` lesson: a matcher that silently matches nothing
   reports a clean bill of health forever).

**Two things Stage A deliberately did NOT change**, both flagged for the owner rather than fixed:
`web_search`'s after-the-fact debit stays sanctioned exactly as the Scope section describes; and
`providerRates`' per-rung injection swallow stays, because its alternative is taking settlement down. Since 2026-07-31 it swallows PER RUNG (§4.6.1a), so one broken selector cannot drop another rung's row.

## The four stages — ALL COMPLETE (A+B+C 2026-07-25, D 2026-07-26)

Kept in full, because each stage's brief records *why* its guard exists and what it cost to find —
which is the part that stops the guard being "simplified" away later. The kickoff prompts remain
usable for a re-drive. Definition of done for every stage was: gates green (`pnpm typecheck && pnpm
lint:fix && pnpm lint && pnpm test`), new guards mutation-verified, and this spec's status banner
updated in the same change.

### Stage A — ENUMERATE the money paths and audit every swallow ✅ DONE 2026-07-25

The lesson of `spec/spend-holes.md`, applied to debits: both of its sweeps failed not at the guard
but at the *enumeration*, so the enumeration must be structural. Walk every call site that debits
the ledger or reaches KIE; for each, write down which terminal states it can reach and what reports
each transition. Then grep every `catch` in `app/lib/.server/{agent,billing,media}` and classify it:
refund / retry / report / rethrow / sanctioned-swallow (with its sentence). Output: an inventory
table appended to this spec, and fixes for any catch that is none of the five.

> **Kickoff prompt:** *"Read spec/fail-loud.md, then run Stage A: enumerate every ledger-debit and
> KIE-reaching call site, classify each against the four terminal states, audit every catch in the
> money paths, fix the unclassifiable ones, and append the inventory to the spec."*

### Stage B — the structural guard (`money-paths.spec.ts`) ✅ DONE 2026-07-25

**Built as `app/lib/.server/billing/money-paths.spec.ts`.** Enumerated from the ledger API's callers
exactly as the warning below demands: a file counts as a money path when it *imports the ledger* AND
*calls `.append({`* — which is a complete definition (the ledger is the only way credits move), not a
guess about which call sites matter. Comment-stripped, so machinery named in a doc comment never
counts. Default-deny: any file writing a DEBITING reason (`generation`, `media`, `search`, `license`)
must name a compensating row or a `LEDGER_INTEGRITY` alert, or sit in `NO_LOUDNESS_BY_DESIGN` with a
justification over 40 characters. One entry qualifies today: `web-search-tool.ts`, the sanctioned
after-the-fact debit. A reason in neither the debit nor the credit set fails outright, so a *new*
`LedgerReason` is caught on the day it lands. A second describe pins the §"When you add a paid path"
doc-comment contract: a module that spends credits must cite the spec that governs it.

**Three controls** (the `no-server-storage.spec.ts` lesson): the scan still finds writers/debiters/
reasons at all; a comment-only mention does not count; and `props.append(` / `headers.append(` are
correctly excluded. **Four mutations verified** — a new unguarded debiting file, an unclassified
reason, a debiter stripped of all loudness, and a blinded scanner all fail it.

⚠️ **One finding worth keeping, because it is the difference between a guard and a decoration:** the
first draft accepted `MediaRefusedError` / `LicenseRefusedError` as loudness. Stripping *every* refund
and alert out of `media/service.ts` still went green — those typed refusals belong to the
REFUSE-BEFORE-SPEND path, which every debiting module has anyway, so they discriminate nothing. They
are out. **"Can this module refuse a request?" is not the same question as "can it give money back?"**

#### The original brief, kept for the reasoning

Default-deny, the `outbound-enumerate.spec.ts` shape: every call site that debits (`appendLedger` /
`settleGeneration` / media debit / license debit) must reference refund-or-report machinery or
appear in a justified allow-list with a written reason. A debit path added next month is covered the
moment it lands. ⚠️ Heed the spend-holes warning: a detector that decides which call sites matter
reproduces the original bug with a regex — enumerate from the ledger API's callers, not from a
keyword. Include a CONTROL proving the scanner still matches (`no-server-storage.spec.ts` lesson),
and mutation-verify.

> **Kickoff prompt:** *"Read spec/fail-loud.md, then run Stage B: build money-paths.spec.ts as a
> default-deny structural guard over every ledger-debiting call site, with a scanner control,
> mutation-verified."*

### Stage C — ALERTS on the rescue markers ✅ DONE 2026-07-25

**Built as `app/lib/.server/monitoring/paid-path-rates.ts`**, on the `failure-rate.ts` pattern —
generalised there into named `sharedRateWindow(name, config)` windows (bounded, in-process, no
database read, because the alert has to fire when the database is what is down). Two signals:
`RESCUE_MARKER_RATE` at 25% over a 40-generation window (a rescue is *expected* to fire sometimes, so
the threshold sits well above zero) and `REFUND_RATE` at 20% over 50, per ledger reason. Recorded
from `proxy.ts` (all three markers plus the `generation` refund outcome), from `media/service.ts` at
each of the four terminal points, and from `unity-license-service.ts`. The §4.10 panel gained a
**Rescued turns** stat with the per-marker breakdown beneath it, counted from `finish_reason` by a
pure `countMarkers`.

**Why a rescued turn needs its own number:** when a rescue fires it WORKS — the user gets their
artifact, the tokens and credits and the `stop` all look ordinary, and no other figure on the page
moves. That is the most dangerous shape a metric has taken here yet, and the premise the alert makes
actionable is already written in `proxy.ts`'s comments: **if a rescue fires often, the cause is
upstream of the rescue and the rescue is only paying for it** — at 5× output rate, since every one of
them is a second stream.

⚠️ **Two findings from the mutation run, both about the tests rather than the code, and both worth
generalising.** (1) The obvious denominator test — 40 healthy generations, then one rescue — **cannot
fail**: dropping the denominator leaves a single sample, which is under `minSamples`, so it passes
either way. Both denominator tests now spread the firings thinly enough (12 in 120, 10 in 100) that
the un-denominated version crosses the threshold and the real one does not. (2) The refund-rate
denominator had the identical hole. **A rate signal's denominator is invisible to any test whose
numerator alone is below `minSamples`** — and a broken version still prints a confident "100%".

**One item from the brief deliberately NOT converted: the `transport-envelope` tripwire.** It already
ships a `warning`-level `captureMessage` to the errors collector on every occurrence, and that is the
right loudness for it — unlike a rescue, it does not fire occasionally under normal operation. If it
fires at all the client's transport format has drifted, which affects *every* message from that
build, so a rolling window would delay the alert and cap it at one per cooldown. Left as-is on
purpose; it is not an oversight.

#### The original brief, kept for the reasoning


`+unproductive-rescue`, `+forced-continuation`, `+provider-retry`, refund rate per ledger reason,
and the `transport-envelope` tripwire all *record* today; nothing *watches* them. Wire rates into
the `failure-rate.ts` rolling-window pattern with alert thresholds, and surface per-marker counts on
the §4.10 Admin usage panel. The explicit premise (already in `proxy.ts`'s comments): **if a rescue
fires often, the cause is upstream of the rescue and the rescue is only paying for it** — the alert
is what makes that sentence actionable.

> **Kickoff prompt:** *"Read spec/fail-loud.md, then run Stage C: alert on the finish_reason marker
> rates and per-reason refund rates via the failure-rate pattern, and add them to the Admin usage
> report."*

### Stage D — LIVE drives of the never-exercised failure paths ✅ DONE 2026-07-26

All three driven against real KIE with the ledger open. **No defects found** — but see the caveat on
(2) and (3) at the end, which is about who drove them, not about the result.

**(1) A real `/bt-spec` in the browser.** `gen_ms1dfnia_1l63pn`: `finish=stop`, `toolRounds: 0`,
`skillsLoaded: ['bt-spec', …]` — so the transport-envelope strip and slash resolution both worked on a
message carrying the client's `[Model: …][Provider: …]` prefix (defect 1 of the demo day: *every*
`/slash` was being dropped). 378 credits debited, balance 47,064 → 46,686, and the header balance
matched the ledger exactly (rule 5 — a settled charge the UI cannot see is a defect). The **unproductive
rescue did not fire and should not have**: the turn produced 15,221 chars and a real `_specs/` file,
verified by the model refusing to clobber it on a later turn. DELIVERED, judged from what we observed.

**(2) A real media render FAILURE → refund.** `med_ms1b7770_o21mh0` (nano-banana-2), a prompt the
provider's moderation refused:

```
04:39:53  media   -24  bal=48332
04:40:06  refund  +24  bal=48356   "media refund: The provider reported the generation failed."
```

Every property of the REFUNDED state held: the task record carries `status: 'failed'`, `error`, and the
`refunded: true` latch; the `generations` row is `status: failed`; **exactly ONE refund row exists
across nine media debits** (the exactly-once latch, which is the property no unit test can prove about
the real poll loop); the balance is whole; and the Media panel renders it with the reason attached
(*"refunded — The provider reported…"*), so the user is told rather than left to notice. This path was
spec-pinned and had never been seen live.

**(3) The agent-tool media path inside a chat turn.** Established by correlating every media task
against the LLM generation in flight at the time — the distinguishing evidence being that the tool
passes `file_name` (the panel does not, so a panel render is slugged from the prompt):

| media task | created | inside an LLM turn | tool rounds |
|---|---|---|---|
| `hero-racing`, `arcade-racing-logo`, `car-showcase` | 20:40:49/52/55 | gen spanning **20:40:34–20:47:09** | 1 |
| `adventure-hero`, `adventure-emblem`, `adventure-texture` | 20:56:04/10/10 | gen spanning 20:55:49–20:59:00 | 1 |
| `synty-hero`, `synty-emblem` | 21:06:13/16 | gen spanning 21:05:42–21:08:41 | 1 |

Eight renders, all fired **15–21 seconds into a live generation**, **one tool round each** — which is
the creation brief's "all generate calls first, in ONE round" behaving exactly as designed, and the
async-enqueue contract holding (the loop never parked on a render). Three of them chained the
transparency cut-out (`stage`/`cutout`/`renderUrl` on the record) and were billed once for both stages.

⚠️ **The honest caveat: (2) and (3) were driven by the OWNER's own use of the product, and verified
afterwards from the ledger, the task records and the panel — not staged by the person writing this
entry.** That is stronger evidence than a staged drive for the question "does this work in real use",
and weaker for "can I make it fail on demand": a second failure mode (KIE erroring at CREATE time
rather than during the render — the `create throws → refund + anchor failed + 502` branch) is still
only unit-proven. The refund-exactly-once latch is now live-confirmed on the poll branch, which was the
one that mattered most.

> **Kickoff prompt (for a future re-drive):** *"Read spec/fail-loud.md, then run Stage D item (N):
> drive it live with the ledger open and record the result in the spec."*

## When you add a paid path (the checklist that makes this spec cheap)

Before the first review: name its four-state mapping in the doc comment · refuse before spend where
the price/feasibility is unknowable · refund exactly once on failure, with a latch · report every
automatic transition to `finish_reason`/monitoring · move the visible balance · mutation-verify the
guard · and ask what the *silent* version of this feature failing would look like — then make that
version impossible to ship quietly.
