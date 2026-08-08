/**
 * `ENABLE_PREMIUM_MODEL` — the master switch for the PAID rung of the model ladder (SPEC §4.6.1a).
 *
 * ## Why a flag and not "just unset the selector"
 *
 * The rung already refuses when its selector cannot be priced, so an operator CAN turn Premium off by
 * breaking its config. That is turning a capability off by leaving it misconfigured — indistinguishable,
 * from the outside and from a log, from the mistake it imitates, and the ladder reports it as a fault
 * (`serveable: false, reason: …`) rather than as a decision.
 *
 * The real reason it exists: **the provider does not always serve more than one model reliably.** KIE
 * has repeatedly been dependable on exactly one model at a time (`spec/anthropic-models.md` §3.4a, and
 * the ~30s silent-step kill that made Opus 5 creations fail intermittently). When that happens the
 * honest configuration is one model for everyone — and the operator needs to say so in one place,
 * without editing a selector, without a redeploy, and without the UI continuing to advertise a class
 * the platform is not going to serve.
 *
 * ## What "off" means, exactly
 *
 * `getModelTiers` returns the STANDARD rung alone. Everything downstream follows from that one fact,
 * which is the point — no second code path to keep in step:
 *
 * - `decideModelTier` finds no such rung and resolves DOWN to standard (`reason: 'unavailable'`), which
 *   is already how it treats a rung absent from the ladder. A hand-edited request body asking for
 *   `premium` therefore runs standard, exactly as an unrecognised tier id does.
 * - `/api/me` reports one rung, so the composer pill has nothing to offer and does not open a picker.
 * - `getTierModel` refuses outright, so even a caller that somehow authorized the paid rung cannot
 *   resolve a model for it. Two walls, the §4.5.3 pattern, because this decides what gets billed.
 *
 * ## Default ON
 *
 * Unset means the ladder behaves exactly as it did before this flag existed — an operator who has
 * never heard of it sees no change. That is the additive direction; defaulting to off would silently
 * withdraw a paid capability from every existing deploy on upgrade, which is a worse surprise than the
 * one it would prevent.
 *
 * ⚠️ It is read through `envFlag`, so it is on ONLY for the exact string `"true"`. `"1"`, `"yes"` and
 * `"TRUE"` are all OFF — the safe direction for a switch that decides whether the expensive model can
 * run at all.
 *
 * ## 🔴 The retired names are REFUSED, and the flag is why (2026-08-08)
 *
 * This variable shipped as `ENABLE_EXTENDED_MODELS` while the ladder had two paid rungs. Renaming a
 * flag whose default is ON is a **silent money bug**: a deploy carrying `ENABLE_EXTENDED_MODELS=false`
 * in SSM would, on upgrade, stop being read, fall through to the default, and start serving the
 * expensive rung to everyone — the costly direction, with nothing thrown and nothing logged. So the old
 * name is refused by NAME, pointing at its replacement, exactly as `CREATION_FLAT_CREDITS` and the
 * retired `*_DOLLARS` price vars are.
 *
 * `SUPERMAX_MODEL` / `SUPERMAX_MINIMUM_CREDITS` join it for the sibling reason: the SuperMax rung was
 * retired in the same change, so those are selectors nothing reads — an operator believing they are
 * serving a class that no longer exists. The failure is quieter than the flag's (a missing rung is the
 * *cheap* direction) but it is the same shape, and treating one case by hand and the other by
 * judgement is how the two halves of a pair drift.
 */
import { env, envFlag, NotConfiguredError } from '~/lib/.server/env';

export const ENABLE_PREMIUM_MODEL_ENV_KEY = 'ENABLE_PREMIUM_MODEL';

/** Is the paid rung (Premium) offered at all on this deploy? */
export function premiumModelEnabled(context?: unknown): boolean {
  return envFlag(context, ENABLE_PREMIUM_MODEL_ENV_KEY, true);
}

/**
 * Env keys that used to configure the ladder and are now read by nothing.
 *
 * Each entry carries the sentence an operator needs: what to do instead. A refusal that only says
 * "remove this" leaves them guessing whether the capability moved or vanished.
 */
const RETIRED_MODEL_TIER_ENV: ReadonlyArray<{ key: string; fix: string }> = [
  {
    key: 'ENABLE_EXTENDED_MODELS',
    fix: `renamed to ${ENABLE_PREMIUM_MODEL_ENV_KEY} — copy its value across and remove the old key`,
  },
  {
    key: 'SUPERMAX_MODEL',
    fix: 'the SuperMax rung is retired; there is one paid rung now, so name that model in PREMIUM_MODEL or remove this key',
  },
  {
    key: 'SUPERMAX_MINIMUM_CREDITS',
    fix: 'the SuperMax rung is retired; set the threshold in PREMIUM_MINIMUM_CREDITS or remove this key',
  },
];

/**
 * Throw if a retired ladder variable is set.
 *
 * ⚠️ **Where this is called decides whether it is safe.** It sits inside `getModelTier`, which is
 * wrapped per-rung by `getModelTiers`' try/catch — so a read path (`/api/me`, the session hint) sees
 * a LOCKED Premium row carrying this message as its operator-facing `reason`, and the money path
 * (`getTierModel`, before a generation) sees the throw. Never call it from `kieRates` or anywhere else
 * on the settlement path: a refusal there takes billing down over a stale variable name, and the
 * 2026-07-25 `/api/me` outage is the standing lesson about throwing on a rendering hint.
 */
export function refuseRetiredModelTierEnv(context?: unknown): void {
  const set = RETIRED_MODEL_TIER_ENV.filter((entry) => env(context, entry.key)?.trim());

  if (!set.length) {
    return;
  }

  throw new NotConfiguredError(
    `${set.map((entry) => entry.key).join(', ')} (set, but retired)`,
    `The model tier ladder no longer reads ${set.length > 1 ? 'these' : 'this'}: ` +
      `${set.map((entry) => `${entry.key} — ${entry.fix}`).join('; ')}. ` +
      'A variable nothing reads is a configuration you believe you have and do not.',
  );
}
