/**
 * What the user should EXPECT of this turn: how the provider delivers its answer, and how long a
 * turn of this kind usually runs (SPEC §4.2a; consumed by `agent/heartbeat.ts` → `StreamingStatus`).
 *
 * ## Why this exists
 *
 * Reported 2026-08-03, on a first build turn: *"it sat on building for almost 4 min with nothing
 * coming from the model… then we got everything all at once… I almost quit like 3 times wondering if
 * it was just spinning its wheels."*
 *
 * The generation was healthy. Its persisted step log reads `244505ms · 16985 out (69 tok/s)` — a
 * completely ordinary decode rate — and every filter on our side streams (`shell-strip.ts`,
 * `protocol-strip.ts`, the proxy drain, the route). The bytes were held by the PROVIDER.
 *
 * ## The measurement (`scripts/stream-probe.mjs`, 2026-08-03, claude-opus-5)
 *
 * | request shape | chars | delivery |
 * |---|---|---|
 * | production (adaptive+summarized, `thinkingFlag`) | — | died at 22s with no text (the ~30s silent-step kill) |
 * | thinking DISABLED | 26,324 | **100% in the final second, after 130s of silence** |
 * | no thinking fields at all | 26,576 | **100% in the final second, after 168s of silence** |
 *
 * So KIE's adapter buffers the whole answer and flushes it at the end, and **no request shape we can
 * send changes that** — thinking is not the lever, which is why this is a provider FACT here rather
 * than another knob in `retry-policy.ts`. The historical control in `KIE_BUG_REPORT.md` (2026-07-24)
 * has api.anthropic.com streaming live over the same window.
 *
 * ## Why the panel is allowed to say so
 *
 * `heartbeat.ts`'s standing rule is that the status channel reports **facts the proxy already holds,
 * never a guess about what the model is doing**. Which provider is configured is exactly such a fact,
 * and the claim made from it — "this provider sends its answer in one batch" — is about the
 * TRANSPORT, not the model's inner activity.
 *
 * It is also SELF-CORRECTING in the safe direction: if KIE fixes their adapter, real text streams,
 * the heartbeat's quiet clock resets, the panel disappears, and the sentence is never shown. The
 * failure mode of a stale `batched` is a panel that stops being displayed — not a wrong sentence.
 */
import type { AgentStatusKind } from './heartbeat';
import type { PlatformProviderName } from './config';
import { familyOf, type ModelFamily } from '~/lib/modules/llm/model-families';

/**
 * How the configured provider puts the model's answer on the wire.
 *
 * - `streamed` — text arrives progressively, as the model decodes it.
 * - `batched` — the provider withholds the answer and flushes it when the turn ends. Nothing the user
 *   is waiting for can appear before then, however healthy the generation is.
 */
export type DeliveryMode = 'streamed' | 'batched';

/**
 * 🔴 Keyed by (PROVIDER, FAMILY) — still never by a raw model id.
 *
 * **It was keyed by provider alone, and that was right until KIE stopped being one API.** The
 * reasoning has not changed, only the boundary it lands on: the thing that buffers is the ADAPTER in
 * front of the endpoint, and KIE runs three of them. The 2026-08-03 probe was invariant across three
 * request shapes on `claude-opus-5` — which proved the model was not the variable — and the 2026-08-04
 * probe then measured KIE's GPT surface STREAMING on the same account and the same key (first delta at
 * 3.7s, ~1,400 evenly-spread deltas). Same provider, opposite behavior, so provider alone can no
 * longer answer the question.
 *
 * The rule that survives intact is the one that matters: **never keyed by MODEL**. A per-model table
 * would silently report `streamed` the day someone points `LLM_MODEL` at another Claude model on the
 * same buffering adapter — a wrong sentence during exactly the wait it exists to explain. A family is
 * a property of the endpoint; a model id is not.
 */
const DELIVERY: Record<PlatformProviderName, DeliveryMode | Record<ModelFamily, DeliveryMode>> = {
  /* Measured streaming live during the window (`KIE_BUG_REPORT.md`, 2026-07-24 control). ALL families. */
  Anthropic: 'streamed',

  KIE: {
    /* Measured 3/3 buffered, 2026-08-03. See the table above. */
    claude: 'batched',

    /*
     * ✅ Measured streaming, twice. 2026-08-04 big-answer run on `gpt-5-6-sol`: 46,498ms total,
     * **2,382 deltas**, first delta at 3,016ms (6% in), spread over 42,865ms, and **1.0% of chars in
     * the final second**. That last number is the one that matters — it is what separates "streamed
     * for 46s" from "buffered for 46s and arrived at 46s", which no server-side total can tell apart.
     */
    codex: 'streamed',

    /*
     * ✅ CONFIRMED 2026-08-04 by the big-answer probe this entry was provisional pending (T11).
     * `gemini-3-5-flash`, 12,542ms total, 19 deltas, 6,828 chars, first delta at 5,650ms (45% in),
     * **6.8% of chars in the final second** — progressive, not a final-second flush.
     *
     * Fewer, fatter deltas than codex's 2,382, so the panel's expectation bar will move in coarser
     * steps; that is a streaming shape, not a batched one. **This entry is DATA — re-measure with
     * `scripts/stream-probe.mjs gemini-3-5-flash` and flip the one word if KIE's adapter changes.**
     */
    gemini: 'streamed',

    /*
     * UNREACHABLE on KIE and present only so this exhaustive Record compiles: `kie.ts` refuses the
     * `chat` family at model resolution (KIE fronts no Grok/Kimi/Qwen/GLM/DeepSeek/MiniMax ids), so
     * nothing can ever read this value. It is `streamed` because that is the standing default for an
     * unmeasured surface — NOT because anything was measured here.
     */
    chat: 'streamed',
  },

  Comet: {
    /*
     * ✅ MEASURED 2026-08-10, and it is the headline difference from KIE's row above: the same Claude
     * models over the same Anthropic-native Messages API, streaming properly. `stream-probe.mjs`:
     * 5,825 chars over **388 deltas** with **4% of characters in the final second** — that last number
     * is the one that separates "streamed for N seconds" from "buffered for N seconds and flushed",
     * which no server-side total can tell apart. KIE's Claude adapter measures 100% on that number.
     */
    claude: 'streamed',

    /*
     * ⚠️ ASSUMED, NOT MEASURED — the standing default for an unprobed surface. `batched` renders a
     * sentence telling the user to expect nothing for minutes; claiming that about something nobody
     * has watched manufactures the despair the panel exists to prevent, and it is unfalsifiable from
     * their side of the screen. Do not read these three as evidence: if a rung ever names a model in
     * one of these families, MEASURE it with `scripts/stream-probe.mjs` and flip the word.
     */
    codex: 'streamed',
    chat: 'streamed',
    gemini: 'streamed',
  },
};

/**
 * How this turn's answer will be delivered, from the provider and the model's family.
 *
 * Two independent unknowns, both resolving to `streamed`, and for the same reason: the `batched`
 * sentence tells the user to expect nothing for minutes. Saying that about a surface we have not
 * measured would manufacture the very despair this module exists to prevent, and it is unfalsifiable
 * from the user's side. **Claim the quieter thing when we do not know.**
 */
export function deliveryModeFor(provider: PlatformProviderName, model: string | undefined): DeliveryMode {
  const entry = DELIVERY[provider];

  if (entry === undefined) {
    return 'streamed';
  }

  if (typeof entry === 'string') {
    return entry;
  }

  const family = familyOf(model);

  return family ? entry[family] : 'streamed';
}

/**
 * @deprecated Use `deliveryModeFor(provider, model)` — a provider can front more than one adapter.
 *
 * Kept as a delegate rather than deleted: it answers the provider-wide question honestly for a
 * provider whose families agree, and returns the SAFE `streamed` for one whose families differ, so a
 * stray caller can never be told to expect silence on a surface that streams.
 */
export function providerDeliveryMode(provider: PlatformProviderName): DeliveryMode {
  const entry = DELIVERY[provider];

  return typeof entry === 'string' ? entry : 'streamed';
}

/**
 * How long a turn of each kind USUALLY takes, end to end.
 *
 * 🔴 This is a measured baseline, not a promise, and the copy that renders it says "usually" for that
 * reason. Its whole job is to answer the question an elapsed counter cannot — *"is 3m30s normal, or
 * is this thing stuck?"* — which is the question that had the owner reaching for the tab close button
 * three times.
 *
 * Sourced from generations recorded in this repo's own history rather than invented:
 *
 * - creation/first build — 328s (2026-08-03, the reported turn), 384s and 387s (`spec/context-budget.md`
 *   creation measurements), 114s and 161s on lighter briefs. A wide spread, so the copy renders a RANGE.
 * - repair — a repair re-reads compiler output and patches; it runs at `high` effort (`effort-policy.ts`).
 * - plan/edit — 122s, 17s and 7s measured on the sticky-skills follow-ups (2026-07-26).
 *
 * ⚠️ Deliberately GENEROUS. Overshooting costs a pleasant surprise; undershooting means the bar pins
 * at "longer than usual" on ordinary turns, which trains the user to ignore the one signal that is
 * supposed to mean something is wrong.
 */
const TYPICAL_MS: Record<AgentStatusKind, number> = {
  creation: 300_000,
  repair: 120_000,
  plan: 120_000,
  edit: 90_000,
};

export function typicalDurationMs(kind: AgentStatusKind): number {
  return TYPICAL_MS[kind] ?? TYPICAL_MS.edit;
}
