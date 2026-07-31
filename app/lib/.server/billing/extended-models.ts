/**
 * `ENABLE_EXTENDED_MODELS` — the master switch for the PAID rungs of the model ladder (SPEC §4.6.1a).
 *
 * ## Why a flag and not "just unset the selectors"
 *
 * The rungs already refuse individually when their selector cannot be priced, so an operator CAN turn
 * Premium off by breaking its config. That is turning a capability off by leaving it misconfigured —
 * indistinguishable, from the outside and from a log, from the mistake it imitates, and the ladder
 * reports it as a fault (`serveable: false, reason: …`) rather than as a decision.
 *
 * The real reason it exists: **the provider does not always serve more than one model reliably.** KIE
 * has repeatedly been dependable on exactly one model at a time (`spec/anthropic-models.md` §3.4a, and
 * the ~30s silent-step kill that made Opus 5 creations fail intermittently). When that happens the
 * honest configuration is one model for everyone — and the operator needs to say so in one place,
 * without editing three selectors, without a redeploy, and without the UI continuing to advertise
 * classes the platform is not going to serve.
 *
 * ## What "off" means, exactly
 *
 * `getModelTiers` returns the STANDARD rung alone. Everything downstream follows from that one fact,
 * which is the point — no second code path to keep in step:
 *
 * - `decideModelTier` finds no such rung and resolves DOWN to standard (`reason: 'unavailable'`), which
 *   is already how it treats a rung absent from the ladder. A hand-edited request body asking for
 *   `supermax` therefore runs standard, exactly as an unrecognised tier id does.
 * - `/api/me` reports one rung, so the composer pill has nothing to offer and does not open a picker.
 * - `getTierModel` refuses outright (below), so even a caller that somehow authorized a paid rung
 *   cannot resolve a model for it. Two walls, the §4.5.3 pattern, because this decides what gets
 *   billed.
 *
 * ## Default ON
 *
 * Unset means the ladder behaves exactly as it did before this flag existed — an operator who has
 * never heard of it sees no change. That is the additive direction; defaulting to off would silently
 * withdraw a paid capability from every existing deploy on upgrade, which is a worse surprise than the
 * one it would prevent.
 *
 * ⚠️ It is read through `envFlag`, so it is on ONLY for the exact string `"true"`. `"1"`, `"yes"` and
 * `"TRUE"` are all OFF — the safe direction for a switch that decides whether the expensive models can
 * run at all.
 */
import { envFlag } from '~/lib/.server/env';

export const EXTENDED_MODELS_ENV_KEY = 'ENABLE_EXTENDED_MODELS';

/** Are the paid rungs (Premium, SuperMax) offered at all on this deploy? */
export function extendedModelsEnabled(context?: unknown): boolean {
  return envFlag(context, EXTENDED_MODELS_ENV_KEY, true);
}
