# spec/fail-loud.md — A paid request never fails silently (governs SPEC §4.2, §4.6, §4.16; owner directive 2026-07-25)

> **Status: POLICY ADOPTED, WORK PARTLY OWED.** Owner directive (2026-07-25, verbatim intent): *"we
> should never have silent fails on a paid service that burns credits."* Much of this document
> describes guards that already exist — they are listed so nobody rebuilds them. The part that does
> NOT yet exist is enumerated in §"The kickoff plan", each stage with a paste-able prompt. Until a
> stage is run, its items are OWED, not done — do not cite this spec as evidence they are built.

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
continuations, the unproductive rescue, premium tier), the enhancer (`/api/enhancer`), and media
renders (§4.16, both stages of a cut-out). Binding equally: every other ledger debit — the full
`LedgerReason` set is `grant | purchase | generation | media | search | license | refund | promo |
adjustment` (`billing/ledger.ts`), and the debiting members (`generation`, `media`, `search`,
`license`) all carry this contract. `search` debits AFTER the vendor returned and may go negative by
design — that is a documented posture, not a silent failure.

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
2. **A degraded capability reports OFF, never ON** (`premiumSessionHint` precedent, §4.2a). Honest
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

## The kickoff plan (the owed work)

Four stages, independent, in value order. Each is kicked off by pasting its prompt into a fresh
session. Definition of done for every stage: gates green (`pnpm typecheck && pnpm lint:fix && pnpm
lint && pnpm test`), new guards mutation-verified, and this spec's status banner updated in the same
change.

### Stage A — ENUMERATE the money paths and audit every swallow

The lesson of `spec/spend-holes.md`, applied to debits: both of its sweeps failed not at the guard
but at the *enumeration*, so the enumeration must be structural. Walk every call site that debits
the ledger or reaches KIE; for each, write down which terminal states it can reach and what reports
each transition. Then grep every `catch` in `app/lib/.server/{agent,billing,media}` and classify it:
refund / retry / report / rethrow / sanctioned-swallow (with its sentence). Output: an inventory
table appended to this spec, and fixes for any catch that is none of the five.

> **Kickoff prompt:** *"Read spec/fail-loud.md, then run Stage A: enumerate every ledger-debit and
> KIE-reaching call site, classify each against the four terminal states, audit every catch in the
> money paths, fix the unclassifiable ones, and append the inventory to the spec."*

### Stage B — the structural guard (`money-paths.spec.ts`)

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

### Stage C — ALERTS on the rescue markers (a recorded marker nobody watches is rule 9 waiting to fire)

`+unproductive-rescue`, `+forced-continuation`, `+provider-retry`, refund rate per ledger reason,
and the `transport-envelope` tripwire all *record* today; nothing *watches* them. Wire rates into
the `failure-rate.ts` rolling-window pattern with alert thresholds, and surface per-marker counts on
the §4.10 Admin usage panel. The explicit premise (already in `proxy.ts`'s comments): **if a rescue
fires often, the cause is upstream of the rescue and the rescue is only paying for it** — the alert
is what makes that sentence actionable.

> **Kickoff prompt:** *"Read spec/fail-loud.md, then run Stage C: alert on the finish_reason marker
> rates and per-reason refund rates via the failure-rate pattern, and add them to the Admin usage
> report."*

### Stage D — LIVE drives of the never-exercised failure paths

The MCP-relay lesson: "correct by construction" until driven live. Owed drives, cheapest first:
**(1)** one real `/bt-spec` in the browser (exercises the envelope strip, slash resolution, and —
if the model stalls — the rescue, in one turn); **(2)** a real media render FAILURE → refund
observed in ledger + panel (spec-pinned, never seen live); **(3)** the agent-tool media path inside
a chat turn. Each is a manual verification with the ledger open, not a CI test.

> **Kickoff prompt:** *"Read spec/fail-loud.md, then run Stage D item (N): drive it live with the
> ledger open and record the result in the spec."*

## When you add a paid path (the checklist that makes this spec cheap)

Before the first review: name its four-state mapping in the doc comment · refuse before spend where
the price/feasibility is unknowable · refund exactly once on failure, with a latch · report every
automatic transition to `finish_reason`/monitoring · move the visible balance · mutation-verify the
guard · and ask what the *silent* version of this feature failing would look like — then make that
version impossible to ship quietly.
