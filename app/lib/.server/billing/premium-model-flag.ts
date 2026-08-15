/**
 * `ENABLE_EXTENDED_MODELS` — the master switch for the PAID rung of the model ladder (SPEC §4.6.1a).
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
 * ## 🔴 The retired names are REFUSED, and this flag has now been renamed TWICE
 *
 * Renaming a flag whose default is ON is a **silent money bug**: the old key stops being read, falls
 * through to the default, and the deploy starts serving the expensive rungs to everyone — the costly
 * direction, with nothing thrown and nothing logged. So every rename here ships as a PAIR: read the
 * new name, and refuse the old one by NAME, exactly as `CREATION_FLAT_CREDITS` and the retired
 * `*_DOLLARS` price vars are.
 *
 * The history, because the direction has reversed and a reader who assumes one rename will get it
 * backwards:
 *
 *  - shipped as `ENABLE_EXTENDED_MODELS` (two paid rungs: Premium · SuperMax)
 *  - **2026-08-08** → `ENABLE_PREMIUM_MODEL`, when SuperMax was retired and the plural stopped being
 *    true; `ENABLE_EXTENDED_MODELS` became refused
 *  - **2026-08-10** → back to `ENABLE_EXTENDED_MODELS`, when PLATINUM restored the second paid rung
 *    and the plural became true again; `ENABLE_PREMIUM_MODEL` is now the refused one
 *
 *  - **2026-08-14** → PLATINUM retired again (owner), so the ladder is back to ONE paid rung — and
 *    the name was deliberately **NOT** flipped a third time.
 *
 * 🔴 **Why the third rename was refused, since precedent points the other way.** The two earlier flips
 * were argued from grammar: one paid rung, so drop the plural. That reasoning is worth less than it
 * costs. Each rename of a default-ON money flag has a documented failure mode — the old key stops
 * being read, falls through to ON, and the deploy serves the expensive rung to everyone — and the
 * knowledge base ended up asserting the INVERSE polarity for a day, on the flag deciding who gets
 * served a paid model. Meanwhile `EXTENDED_MODELS` reads perfectly well as "the models beyond
 * Standard", a set that is allowed to have one member. **Renaming this again needs a reason about
 * BEHAVIOUR, not about number agreement.**
 *
 * ⚠️ It governs EVERY paid rung — currently exactly one. Per-rung narrowing is `enabledEnvKey`, which
 * can only ever narrow what this allows; with one rung it is the same key, which is why
 * `ENABLE_PLATINUM_MODEL` is now REFUSED rather than ignored.
 *
 * `SUPERMAX_MODEL` / `SUPERMAX_MINIMUM_CREDITS` stay refused throughout, and PLATINUM taking that
 * rung's position did NOT change that: those values were chosen against SuperMax's threshold and
 * SuperMax's price list, so adopting them silently would serve a paid class nobody reviewed. The
 * failure is quieter than the flag's (a missing rung is the *cheap* direction) but it is the same
 * shape, and treating one case by hand and the other by judgement is how the two halves of a pair
 * drift.
 */
import { env, envFlag, NotConfiguredError } from '~/lib/.server/env';
import type { ModelTierDefinition } from './model-tiers';

export const ENABLE_EXTENDED_MODELS_ENV_KEY = 'ENABLE_EXTENDED_MODELS';

/**
 * Are PAID rungs offered at all on this deploy? The MASTER switch, covering every rung in
 * `PAID_MODEL_TIERS` — not just the one it is named after.
 *
 * The plural in `EXTENDED_MODELS` is load-bearing: this governs Premium AND Platinum together. A
 * deploy that sets it false serves the Standard model to everyone, whatever the per-rung flags say.
 * Per-rung control is `enabledEnvKey`, which only ever NARROWS this.
 *
 * ⚠️ It is read through `envFlag`, so it is on ONLY for the exact string `"true"` — `"1"`, `"yes"` and
 * `"TRUE"` are all OFF, the safe direction for a switch deciding whether the expensive models run.
 */
export function extendedModelsEnabled(context?: unknown): boolean {
  return envFlag(context, ENABLE_EXTENDED_MODELS_ENV_KEY, true);
}

/**
 * Is this SPECIFIC paid rung offered? Master switch AND the rung's own flag, both default ON.
 *
 * The conjunction is the safety property and it is one-directional: a rung can be withdrawn without
 * touching its sibling, but no per-rung flag can serve a rung the master switch has turned off. That
 * asymmetry is what makes adding Platinum a no-op for every deploy that had already disabled paid
 * models — the upgrade cannot widen what is served, only keep or narrow it.
 */
export function modelTierEnabled(definition: ModelTierDefinition, context?: unknown): boolean {
  return extendedModelsEnabled(context) && envFlag(context, definition.enabledEnvKey, true);
}

/**
 * Env keys that used to configure the ladder and are now read by nothing.
 *
 * Each entry carries the sentence an operator needs: what to do instead. A refusal that only says
 * "remove this" leaves them guessing whether the capability moved or vanished.
 */
const RETIRED_MODEL_TIER_ENV: ReadonlyArray<{ key: string; fix: string }> = [
  /*
   * 🔴 THE REFUSAL SWAPPED DIRECTION ON 2026-08-10, and swapping it was not optional.
   *
   * `ENABLE_EXTENDED_MODELS` was retired in favour of `ENABLE_PREMIUM_MODEL` on 2026-08-08, when the
   * ladder was cut to ONE paid rung and the "extended models" plural stopped being true. PLATINUM
   * restored the second paid rung, so the plural is accurate again and the name went back.
   *
   * The entry that used to sit here refused `ENABLE_EXTENDED_MODELS` — the key the platform now READS.
   * Leaving it would refuse the live flag on every deploy that sets it, i.e. the rename would have
   * broken the thing it renamed. And deleting it without adding its mirror would reproduce the exact
   * bug the 08-08 rename was documented against, pointing the other way: a deploy carrying
   * `ENABLE_PREMIUM_MODEL=false` would stop being read, fall through to the default ON, and start
   * serving the expensive rungs to everyone — costly, silent, unlogged.
   *
   * **A rename of a default-ON flag is always a PAIR of edits: start reading the new name, and start
   * REFUSING the old one.** Doing only the first is the silent money bug; doing only the second is an
   * outage. That is true in whichever direction the rename runs, including back the way it came.
   */
  {
    key: 'ENABLE_PREMIUM_MODEL',
    fix: `the paid rung is governed by ${ENABLE_EXTENDED_MODELS_ENV_KEY} — copy its value across and remove the old key`,
  },

  /*
   * 🔴 The SuperMax keys stay REFUSED even though PLATINUM now occupies that rung's position
   * (2026-08-10). Adopting a stale `SUPERMAX_MODEL` value into Platinum is the tempting move and the
   * wrong one: that value was chosen against SuperMax's threshold and SuperMax's price list, and
   * silently promoting it means an operator serves a rung they never reviewed, at a threshold they
   * never set. Refusing costs them one deliberate edit; adopting costs them a mis-served paid tier
   * with nothing thrown. Same rule as `ENABLE_EXTENDED_MODELS` directly above.
   */
  /*
   * 🔴 PLATINUM RETIRED (owner, 2026-08-14) — and its keys are refused for the SuperMax reason, not
   * silently folded into Premium. Premium's model DID move up to `claude-fable-5` as part of the same
   * change, so `PLATINUM_MODEL=claude-fable-5` would happen to be right on the owner's deploy — which
   * is exactly why adopting it is the wrong habit: it would be right by coincidence here and wrong on
   * the next deploy, at a threshold nobody re-checked, with nothing thrown.
   *
   * ⚠️ `ENABLE_PLATINUM_MODEL` is refused too, and that one is the costly direction. It is a per-rung
   * NARROWING switch: an operator who set it `false` to withdraw Platinum, and whose model has now
   * moved into Premium, would have their withdrawal silently stop applying to the rung that inherited
   * it. Refusing costs one deliberate edit; ignoring costs a paid rung served to people the operator
   * had turned it off for.
   */
  {
    key: 'PLATINUM_MODEL',
    fix: 'the Platinum rung is retired — its model moved into PREMIUM_MODEL (review it against the active price list and PREMIUM_MINIMUM_CREDITS first) or remove this key',
  },
  {
    key: 'PLATINUM_MINIMUM_CREDITS',
    fix: 'the Platinum rung is retired — set the threshold in PREMIUM_MINIMUM_CREDITS or remove this key',
  },
  {
    key: 'ENABLE_PLATINUM_MODEL',
    fix: `the Platinum rung is retired — the remaining paid rung is governed by ${ENABLE_EXTENDED_MODELS_ENV_KEY}, so set that instead or remove this key`,
  },

  {
    key: 'SUPERMAX_MODEL',
    fix: 'the SuperMax rung is retired and replaced by PLATINUM — move the model to PLATINUM_MODEL (reviewing it against the active price list first) or remove this key',
  },
  {
    key: 'SUPERMAX_MINIMUM_CREDITS',
    fix: 'the SuperMax rung is retired and replaced by PLATINUM — set the threshold in PLATINUM_MINIMUM_CREDITS or remove this key',
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
