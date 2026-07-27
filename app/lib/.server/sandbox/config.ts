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
 * MEASURED: a Vite dev server on the Babylon starter used **490MB of 2309MB** on Pico (1 CPU / 2GiB),
 * so Pico is genuinely enough for a builder session. The expensive step is `vite build` (rollup over
 * the whole Babylon graph) on the §4.8 publish path, which is not yet measured — raise this if that
 * turns out to need more, and note the tier can also be raised per-sandbox at runtime
 * (`updateTier` scales without a reboot, but is UPGRADE-ONLY).
 */
export const DEFAULT_SANDBOX_VM_TIER = 'Pico';

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

export function sandboxTemplate(context?: unknown): string {
  return env(context, 'CODESANDBOX_TEMPLATE') || DEFAULT_SANDBOX_TEMPLATE;
}

export function sandboxVmTier(context?: unknown): string {
  return env(context, 'CODESANDBOX_VM_TIER') || DEFAULT_SANDBOX_VM_TIER;
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

export function sandboxHostTokenMinutes(context?: unknown): number {
  const minutes = envNumber(context, 'CODESANDBOX_HOST_TOKEN_MINUTES', DEFAULT_SANDBOX_HOST_TOKEN_MINUTES);

  return Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_SANDBOX_HOST_TOKEN_MINUTES;
}
