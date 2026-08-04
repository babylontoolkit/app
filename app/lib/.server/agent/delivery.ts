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

/**
 * How the configured provider puts the model's answer on the wire.
 *
 * - `streamed` — text arrives progressively, as the model decodes it.
 * - `batched` — the provider withholds the answer and flushes it when the turn ends. Nothing the user
 *   is waiting for can appear before then, however healthy the generation is.
 */
export type DeliveryMode = 'streamed' | 'batched';

/**
 * 🔴 Keyed by PROVIDER, never by model.
 *
 * The probe ran `claude-opus-5` and the buffering was invariant across all three request shapes, so
 * the boundary that predicts it is the adapter in front of the model. Keying this by model would
 * silently report `streamed` the day someone sets `LLM_MODEL` to anything else on the same buffering
 * provider — a wrong sentence during exactly the wait it exists to explain.
 */
const DELIVERY: Record<PlatformProviderName, DeliveryMode> = {
  /* Measured streaming live during the window (`KIE_BUG_REPORT.md`, 2026-07-24 control). */
  Anthropic: 'streamed',

  /* Measured 3/3 buffered, 2026-08-03. See the table above. */
  KIE: 'batched',
};

export function providerDeliveryMode(provider: PlatformProviderName): DeliveryMode {
  /*
   * An unknown provider is assumed to STREAM. The batched sentence tells the user to expect nothing
   * for minutes; saying that about a provider we have not measured would manufacture the very despair
   * this module exists to prevent, and it is unfalsifiable from the user's side. Claim the quieter
   * thing when we do not know.
   */
  return DELIVERY[provider] ?? 'streamed';
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
