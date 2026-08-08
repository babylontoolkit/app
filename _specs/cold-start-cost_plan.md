# Cold-start cost — the remaining $0.50

> Supersedes Phase 3 of `_specs/creation-cost_plan.md`, whose arithmetic is wrong — see §5.

## Context

Phases 1 and 2 of `_specs/creation-cost_plan.md` shipped. The customer no longer pays for a cold
cache (Phase 1 bills cache-creation tokens at the read rate), and the base prompt dropped from
138,660 to 57,208 bytes (Phase 2, on-demand docs). The owner's remaining objection is about the
**platform's** side of that trade:

> "it still cost me 50 cents for cold starts, and a cold start is the first AI call after a TTL cache
> reset, so could be up to every hour it cost me 50 cents for the first user call"

**That is correct, with one qualification.** Anthropic refreshes a cache entry's TTL every time it is
read, so the write is paid once per **idle gap ≥ 1 hour**, not once per clock hour. Continuous traffic
never pays it. At current traffic almost every hour has a gap, so in practice the owner's version is
what is happening — but the cost scales with idleness and disappears with volume. ⚠️ *Refresh-on-hit
is Anthropic's documented behaviour and has never been measured here — step 3 measures it, and step 4
does not get built until it does.*

Live config: `LLM_PROVIDER=Anthropic`, `LLM_MODEL=claude-sonnet-5` → $3/M in, **1h cache write 2× =
$6/M**, cache read 0.1× = $0.30/M. $0.50 ÷ $6/M ≈ **83k tokens** written per cold start.

Two of those 83k tokens' worth of causes are already-solved-but-not-deployed or outright bugs. Fix
those first; they need no new machinery and no new spend.

| | cold-start prefix | cost |
|---|---|---|
| today | ~83k tok | **$0.50** |
| after step 1 (deploy Phase 2) | ~63k | $0.38 |
| after step 2 (fix duplicate map keys) | **~40k** | **$0.24** |
| after step 4 (warm the shared 31k), if step 3 confirms | ~9k unwarmable | **$0.05** + ~$0.30/day |

---

## Step 1 — Deploy Phase 2 (no code; ~20k tokens off every prefix)

Phase 2 is **inert in production**. The active prompt version is `pv_20260807122138_f1638e7c`:
`baseBytes` 138,660 (~34.7k tok) with 24 on-demand ids — the pre-Phase-2 shape. The new base is 57,208
bytes (~14.3k tok) with 30 on-demand ids.

**Action:** Settings → Admin → doc-sync, then promote. Verify the new version's `baseBytes` ≈ 57,208
and `onDemandIds.length === 30` before promoting.

This also activates the two AgentReference fixes committed today (`web-app-builder.md`'s
`load_reference` section, the rewritten `shader-materials.md`). Until it runs, the model is still told
*"do not act on those fetch instructions"* and `load_reference` is dead on arrival.

## Step 2 — 🔴 Every agent-written file is in the context TWICE

**A real bug, found while measuring.** The one project on disk
(`.data/storage/working/prj_20260807222919_g53b9ggy.json`) holds 101 keys, of which **14 are the same
file under two keys** — `src/pages/Home.tsx` *and* `/home/project/src/pages/Home.tsx` — totalling
**90,092 duplicated chars ≈ 22.5k tokens**. The 14 are exactly the files the model wrote:
`Home.tsx`, `Home.css`, the four `src/scripts/kart/*.ts`, `MarioKartRacerCloneMode.ts`, the five
`src/chrome/*`, `SPEC.md`, `DESIGN.md`.

**Root cause, one line, and the variable name already states the contract:**

- `app/lib/runtime/message-parser.ts:495` sets `action.filePath` to the raw attribute the model
  emitted — **project-relative**, always ("that is the artifact format", per the comment at
  `action-runner.ts:21`).
- `app/lib/runtime/action-runner.ts:542` and `:609` call
  `this.#onFileWritten?.(action.filePath, …)` — into a parameter declared as **`absoluteFilePath`**
  (`action-runner.ts:119`).
- `FilesStore.recordAgentWrite` (`app/lib/stores/files.ts:654`) does `this.files.setKey(filePath, …)`,
  and the map is keyed **absolute** (that is what the watcher writes). So the write lands under a
  relative key, the watcher later adds the absolute one, and both survive.
- `createFilesContext` iterates `Object.keys(files).sort()` and de-duplicates nothing — it normalises
  only for the ignore check and the emitted label. **Both keys emit a full `<boltAction type="file">`.**

Cost: ~22.5k tok × $6/M = **$0.135 per cold write**, and it *doubles the per-turn rewrite of the
mutable game-code entry* (BP4) — the one entry that rewrites at 2× on every single turn, forever, and
grows with the game. It is also a correctness defect: the model is shown two copies of `Home.tsx` and
can edit one while leaving the other stale, and `#modifiedFiles` / lock state / `getFile()` all key on
absolute, so the relative twin is a ghost nothing else can see.

**Fix** — normalise inside `recordAgentWrite` (the single choke point), not at the two call sites, and
apply the same rule to its sibling `#recordRestoredFiles` (`files.ts:1102`, which the spec header at
`files-restore-writethrough.spec.ts:632` already notes inherits this contract). Reuse the existing
`toProjectRelativePath` / `isSandboxAbsolutePath` in `app/lib/common/sandbox-paths.ts` plus the
sandbox `workdir` to rebase to the map's convention.

Two things that must be true and are easy to get wrong:

- The rebased key must be **byte-identical to the key the watcher produces**, or the fix creates a
  third spelling instead of removing the second. Pin it with a test that drives a `recordAgentWrite`
  and a watcher event for the same file and asserts `Object.keys(files).length === 1`.
- **Existing working copies already contain both keys**, so a restore repopulates the duplicate. The
  normalisation has to sit at the map-write seam (both writers above), which the restore path passes
  through — verify with the existing `files-restore-writethrough.spec.ts` harness.

Mutation check: reverting the normalisation must fail the dedupe test.

## Step 3 — Measure before building anything warmer-shaped

`scripts/cache-probe.mjs` already speaks the Claude wire with the platform's exact `cache_control`
shape. It has **never been run against Anthropic** (it was written for KIE), and one number decides
step 4:

**Does a cache READ refresh the 1h TTL?**

⚠️ **The probe was KIE-only and could not be pointed at the provider actually being billed** — it
required `KIE_API_KEY` and posted to `api.kie.ai`, while the platform has run on Anthropic direct
since before Opus 5. Fixed 2026-08-08: `PROBE_PROVIDER=Anthropic|KIE` (defaulting to `LLM_PROVIDER`)
switches base URL and auth header (`x-api-key` vs bearer); everything else — the `cache_control`
breakpoint, the tiered write counter, the hit logic — is unchanged, which is the point.

**Measured immediately (2026-08-08, `claude-sonnet-5`, 3 requests, 4s apart):**

```
  #   ms      write     read    fresh   verdict
   1   4067       5420        0        6   miss (wrote)
   2   2565          0     5420        6   HIT
   3   2405          0     5420        6   HIT
```

**Anthropic direct warms on the FIRST request** — no 4–5 request warmup curve, which is a KIE
load-balancer artifact (`spec/context-budget.md`). One write, then hits. That already removes the
"~8× one prefix in warmup" caveat from every Anthropic-side cache estimate in this repo.

The TTL question needs a run that straddles the window: **write at t=0, read at t=45min, read at
t=90min** (`node scripts/cache-probe.mjs 3 2700000`). Without refresh-on-hit the entry dies 60 min
after the WRITE and the t=90 read misses; with it, the t=45 read resets the clock and t=90 hits.
Decisive either way, ~4 requests of spend.

CLAUDE.md's standing rule applies verbatim — *"No warmer-shaped code gets written before this number
exists"*, and *"never diagnose the cache from production turns whose prefix changed between them."*

## Step 4 — Revive the warmer on Anthropic (only if step 3 confirms)

`app/lib/.server/prompt/cache-warmer.ts:213` returns `none('platform provider is not KIE')`. It has
been dead since the move to Anthropic, which is why nothing has been warm. Three changes:

1. **Route via `getModelInstance`**, not KIE's wire (`buildWarmupRequest` currently posts to KIE's
   `/claude/v1/messages` with `KIE_API_KEY`).
2. **`CACHE_WARMER_FANOUT` → 1 on Anthropic.** The default of 6 exists for KIE's per-backend load
   balancer; the repo's own control measured Anthropic at **0/29 cold**, so one touch warms it. Six
   touches is six times the bill for nothing.
3. **Skip when the cache was read recently.** Record the last successful `cacheReadTokens > 0` in the
   proxy and have the cycle no-op if it is within the interval, so the warmer costs nothing during
   busy hours and only covers idle gaps.

Then extend the warmed prefix from BP1 to **BP1 + BP2** — the starter framework block
(`~/lib/context/stable-zones.ts`) is byte-identical for every project on the same template pin, and it
is the largest warmable chunk after the base prompt. This is the extension CLAUDE.md already scoped
and deferred: build it **only with a byte-identity test**, because *"a warmer one space off warms a
prefix nobody sends, silently."*

**Warmable share, measured on the real project:** base 14.3k tok + stable-zone files ~17k tok (the raw
stable set is ~50k, but `public/scripts/*.js` — twgsl 74.5KB, pep 41.9KB, glslang 16KB — are opaque
markers, not bytes) ≈ **31k of the ~40k prefix, 78%**. Residual unwarmable ≈ 9k tok = **$0.05**.

| | daily cost |
|---|---|
| warmer, if reads refresh TTL: 32 pings × 31k × $0.30/M | **$0.30/day** |
| warmer, if every cycle must re-write: 32 × 31k × $6/M | **$5.95/day** → refuse, delete it |
| absorbing cold starts instead, at N idle gaps/day | N × $0.24 |

**Hard budget stands: ≤ $2/day, or it is not built.** The optimistic case is 15× inside it; the
pessimistic case is 3× outside it. Step 3 says which.

## Step 5 — Correct the superseded Phase 3

`_specs/creation-cost_plan.md` §"Phase 3" concludes *"delete `cache-warmer.ts`"* off a table reading
**$18–30/day**. Both inputs are wrong and the conclusion inverts once they are fixed:

- It priced **every** cycle as a full cache WRITE. If reads refresh the TTL, only the first cycle
  writes and the rest are 0.1× — a **20× error**.
- It priced the **whole ~128k prefix**. A warmer can only warm the shared blocks (~31k), because the
  game-code and per-conversation entries are unique per project — a further **4× error**.

Update that section in place rather than leaving a documented "delete it" verdict standing on
retracted arithmetic. Keep the Phase 4 deletions (`selectOnDemandBlocks`, the keyword table) — those
are unaffected.

---

## Verification

**Unit**

- `recordAgentWrite` + a watcher event for one file → exactly one map key (mutation-verified).
- A restore of a working copy that contains **both** spellings collapses to one key.
- `createFilesContext` over a map with both spellings emits one `<boltAction>` (a control asserting a
  genuinely distinct second file still emits two).
- Warmer: byte-identity between the warmed prefix and the prefix `buildSystemPrompt` produces —
  the test that makes step 4 safe to ship.
- Gates: `pnpm typecheck && pnpm lint:fix && pnpm lint && pnpm test`.

**Live — the only proof that counts**

1. After step 1, confirm the promoted version's `baseBytes` ≈ 57,208 / 30 on-demand ids.
2. Create a project, run one build turn, read `.data/generations/gen_*.json`: `cacheCreationTokens`
   should fall from ~83k to ~40k, and the working copy must contain **zero** relative keys
   (`Object.keys(files).filter(k => !k.startsWith('/'))` is empty).
3. Run the same prompt again within the hour: expect `cacheCreationTokens ≈ 0`,
   `cacheReadTokens ≈` the full prefix, and — the Phase 1 property — **both runs billing identical
   credits** while `raw_cost_usd` differs.
4. After step 4, leave the platform idle > 1 h and send one request: expect a cache READ, not a write.

## Not doing

- **No credit ceiling.** Standing owner decision: a genuinely complex build *should* bill 1,500. The
  rule is that the bill reflects the work asked for, never our infrastructure state — Phase 1 already
  achieves exactly that.
- **No provider change.** This is a caching problem on the current provider, not a reason to re-open
  KIE vs Anthropic.
- **No shrinking of the platform's own rules** (`20-hard-constraints.md` etc.). They are ~8k tokens
  and they are the honest tax on being hosted rather than an editor.
