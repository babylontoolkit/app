/**
 * CodeSandbox configuration — the server half of the sandbox seam (SPEC §5, §8,
 * `spec/sandbox-codesandbox.md`).
 *
 * 🔴 **`CODESANDBOX_API_KEY` is a platform secret and never leaves the server.** It is not
 * `VITE_`-prefixed (Vite inlines those into the client bundle), it is never returned in a response
 * body, and it is never logged. The browser gets a scoped per-sandbox `SandboxSession` instead —
 * see `service.ts`. A key in a bundle works off-platform forever, which is the `export-api-keys`
 * lesson (SPEC §5).
 *
 * Everything here is config, never hardcoded (SPEC §1.3): the template pin, the VM tier, and the
 * idle timeout are all operator-tunable, because each of them is a number that costs money and the
 * alternative is a code change and a deploy to adjust it.
 *
 * Absent credentials are a describable state, never a crash (§1.3 principle 0): {@link isSandboxConfigured}
 * answers the question so the UI can render "not configured" and the platform keeps running on
 * WebContainer.
 */
import { env, envNumber, NotConfiguredError } from '~/lib/.server/env';
import { DEFAULT_SANDBOX_CREATES_PER_HOUR } from './create-limit';
import { activeSandboxTemplatePin, decideSandboxTemplate, type SandboxTemplateDecision } from './template-pin';

/**
 * The template to fork per project — an alias built by `csb build … --alias`, NOT a raw sandbox id.
 *
 * An alias is a stable pointer to an immutable template snapshot, which is exactly §4.4's
 * pin-and-promote shape: an admin re-points it, and until they do, a push to the starter repo
 * reaches nobody. Defaulting to the alias rather than to `undefined` means a fresh deploy forks the
 * blessed starter instead of CodeSandbox's generic universal template — which would boot, install
 * nothing, and produce a project that is not a Babylon Toolkit project at all.
 */
export const DEFAULT_SANDBOX_TEMPLATE = 'btk@starter';

/**
 * The default VM tier for a project sandbox.
 *
 * Raised Pico → **Nano** (2 CPU / 4GiB) by owner decision 2026-07-28, on the measurement the previous
 * comment here asked for. Both halves are now measured:
 *
 *   - **Developing** is cheap: a Vite dev server on the Babylon starter uses ~490MB. Pico is plenty.
 *   - **Publishing is not.** `vite build` (rollup over the whole Babylon graph, §4.8) peaked at
 *     **1,958MB of Pico's 2,053MB — 95MB of headroom, and it survived on swap.** It completed, so this
 *     is not a fix for a broken build; it is refusing to ship a 4.6% margin on a step whose cost grows
 *     with the user's own asset count. Nano doubles the ceiling for the same workload.
 *
 * 💰 This tier is a COST, and raising it raises what the platform pays per wall-clock hour — which is
 * why `vmUsdPerHourForTier` derives the billing rate FROM this constant rather than making an operator
 * remember to move a second number (that drift is exactly what happened the first time this was
 * changed). At Nano every pack and plan still clears `MIN_PACK_MARGIN`, worst case 2.41× — Micro would
 * NOT (break-even for the weakest pack is ≈$0.240/hr), so this is the last free step up.
 *
 * The tier can also be raised per-sandbox at runtime (`updateTier` scales without a reboot, but is
 * UPGRADE-ONLY), which remains the escape hatch if a publish build ever needs more than Nano.
 */
export const DEFAULT_SANDBOX_VM_TIER = 'Nano';

/**
 * Idle seconds before CodeSandbox hibernates the VM.
 *
 * This is the main cost lever: a hibernated sandbox bills nothing and resumes in 1–3s with its
 * filesystem AND its running dev server intact (MEASURED). Five minutes matches their free-plan
 * default; the maximum is 86,400.
 */
export const DEFAULT_SANDBOX_HIBERNATION_SECONDS = 300;

/**
 * How long a minted preview host token stays valid.
 *
 * Short by design: the token is what makes a PRIVATE sandbox's preview readable, it travels in an
 * iframe URL, and it is cheap to mint again. This is the same posture as today's WebContainer
 * previews — "unguessable and dies with the session" — expressed as an expiry.
 */
export const DEFAULT_SANDBOX_HOST_TOKEN_MINUTES = 60;

export function sandboxApiKey(context?: unknown): string | undefined {
  return env(context, 'CODESANDBOX_API_KEY');
}

/**
 * Is the server able to talk to CodeSandbox at all?
 *
 * A predicate rather than a throw, so `/api/me` and the settings UI can report the state without
 * taking a page down — the `premiumSessionHint` lesson: a degraded capability reports "off", never
 * "on", and never by crashing the endpoint that was only asking.
 */
export function isSandboxConfigured(context?: unknown): boolean {
  return Boolean(sandboxApiKey(context));
}

/** The key, or a 503 that names the variable. Call this only on paths that genuinely need to spend. */
export function requireSandboxApiKey(context?: unknown): string {
  const key = sandboxApiKey(context);

  if (!key) {
    throw new NotConfiguredError(
      'CodeSandbox',
      'Set CODESANDBOX_API_KEY (server-only, never VITE_-prefixed) from https://codesandbox.io/t/api.',
    );
  }

  return key;
}

/**
 * Which template a new project forks (plan T14).
 *
 * The decision itself is pure and lives in `template-pin.ts`; this only supplies the two fallbacks.
 * A PROMOTED pin outranks `CODESANDBOX_TEMPLATE` — that is the whole point of promoting one — and the
 * pin is read from an in-process cache because this is called synchronously while building a fork
 * request. `ensureSandboxTemplatePin` refreshes that cache at the async doorways; with nothing loaded
 * the answer is exactly what it was before pinning existed.
 */
export function sandboxTemplateDecision(context?: unknown): SandboxTemplateDecision {
  return decideSandboxTemplate({
    pin: activeSandboxTemplatePin(),
    envTemplate: env(context, 'CODESANDBOX_TEMPLATE'),
    baked: DEFAULT_SANDBOX_TEMPLATE,
  });
}

export function sandboxTemplate(context?: unknown): string {
  return sandboxTemplateDecision(context).template;
}

/**
 * The provider's tier names, in their canonical spelling.
 *
 * Exported so the BILLING side keys its price tables off the same list — one spelling, one place.
 */
export const SANDBOX_VM_TIERS = ['Pico', 'Nano', 'Micro', 'Small', 'Medium', 'Large', 'XLarge'] as const;

/**
 * The configured tier, NORMALISED to its canonical spelling.
 *
 * 🔴 **The normalisation is a money fix, not tidiness.** Two readers of this value disagreed about what
 * counts as a match: the provider resolves it case-INSENSITIVELY (`service.ts` lowercases both sides
 * before comparing), while billing looks the name up EXACTLY in its price tables. So a lowercase value
 * ran one tier and priced another:
 *
 *   - `pico`   → ran Pico ($0.074), billed $0.149  — over-states, merely noisy
 *   - `micro`  → ran Micro ($0.298), billed $0.149 — **under-states by 2×**
 *   - `xlarge` → ran XLarge (~$4.77), billed $0.149 — **under-states by 32×**
 *
 * The unknown-tier fallback lands on the dearest MEASURED tier, which is conservative only while the
 * real tier is cheaper than that. Above it the error inverts into the silent direction — a VM that
 * costs 32× what the margin floor is told it costs, with nothing throwing. Two readers of one variable
 * must never disagree about what its VALUE IS, which is the same rule `kieEnvModel` had to learn about
 * `LLM_MODEL` (there it was which variable WINS; here it is which spellings match).
 *
 * An unrecognised name is returned UNCHANGED rather than coerced, deliberately: each side already has a
 * considered fallback for a name it does not know (the provider runs Pico so a typo cannot silently
 * boot an XLarge; billing prices at the dearest measured tier so a typo cannot silently under-charge).
 * Those two are conservative in opposite directions ON PURPOSE, and collapsing them here would trade a
 * loud, safe divergence for a quiet, uniform guess.
 */
export function sandboxVmTier(context?: unknown): string {
  const configured = env(context, 'CODESANDBOX_VM_TIER')?.trim();

  if (!configured) {
    return DEFAULT_SANDBOX_VM_TIER;
  }

  const canonical = SANDBOX_VM_TIERS.find((tier) => tier.toLowerCase() === configured.toLowerCase());

  return canonical ?? configured;
}

export function sandboxHibernationSeconds(context?: unknown): number {
  const seconds = envNumber(context, 'CODESANDBOX_HIBERNATION_SECONDS', DEFAULT_SANDBOX_HIBERNATION_SECONDS);

  /*
   * A nonsensical override must not disable hibernation — that is the difference between a sandbox
   * that costs nothing while idle and one that bills all night. Same "ignore a bad override rather
   * than obey it" rule as the working-copy cap and the Unity price ladder.
   */
  return Number.isFinite(seconds) && seconds > 0 && seconds <= 86400 ? seconds : DEFAULT_SANDBOX_HIBERNATION_SECONDS;
}

/**
 * How many sandboxes one account may fork per hour (`create-limit.ts`).
 *
 * Config rather than a constant for the usual reason: it is a number that costs money and bounds a
 * platform-wide provider budget, so an operator must be able to move it without a deploy.
 */
export function sandboxCreatesPerHour(context?: unknown): number {
  const limit = envNumber(context, 'CODESANDBOX_MAX_CREATES_PER_HOUR', DEFAULT_SANDBOX_CREATES_PER_HOUR);

  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_SANDBOX_CREATES_PER_HOUR;
}

/**
 * Concurrently RUNNING sandboxes allowed per account (`vm-cap.ts`).
 *
 * The constant lives HERE rather than in `vm-cap.ts` so nothing has to import a module that imports
 * `service.ts`, which imports this file — `create-limit.ts` can own its own default because it is
 * pure, and `vm-cap.ts` cannot.
 */
export const DEFAULT_SANDBOX_MAX_RUNNING_VMS = 2;

/**
 * How many of one account's sandboxes may be RUNNING at the same time (`vm-cap.ts`).
 *
 * Two is enough for the real workflow (the project you are building plus one you flipped back to)
 * and it bounds the per-user share of a provider concurrency limit that is measured for the whole
 * API key. Config rather than a constant for the usual reason: it is a number that costs money.
 */
export function sandboxMaxRunningVms(context?: unknown): number {
  const cap = envNumber(context, 'CODESANDBOX_MAX_RUNNING_VMS', DEFAULT_SANDBOX_MAX_RUNNING_VMS);

  /*
   * A nonsensical override falls back rather than being obeyed — the same rule as
   * `sandboxHibernationSeconds`. Obeying `0` would hibernate a sandbox the instant it was minted.
   */
  return Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_SANDBOX_MAX_RUNNING_VMS;
}

/**
 * Ceiling on a minted preview token's life: 24 hours.
 *
 * 🔴 The token is a BEARER credential that rides in an iframe URL — in the address bar of a popped-out
 * preview, in browser history, in any proxy log the URL passes through — and its expiry is the ONLY
 * thing that limits the damage of one leaking. An operator typo (`60000` for "sixty") currently mints
 * ~41-day tokens with nothing to say so. Same ignore-a-bad-override posture as
 * {@link sandboxHibernationSeconds}: a nonsensical value falls back rather than being obeyed.
 */
export const MAX_SANDBOX_HOST_TOKEN_MINUTES = 24 * 60;

export function sandboxHostTokenMinutes(context?: unknown): number {
  const minutes = envNumber(context, 'CODESANDBOX_HOST_TOKEN_MINUTES', DEFAULT_SANDBOX_HOST_TOKEN_MINUTES);

  return Number.isFinite(minutes) && minutes > 0 && minutes <= MAX_SANDBOX_HOST_TOKEN_MINUTES
    ? minutes
    : DEFAULT_SANDBOX_HOST_TOKEN_MINUTES;
}
