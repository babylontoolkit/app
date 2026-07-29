/**
 * The pure decisions a project-scoped sandbox boot makes (SPEC §8, `spec/sandbox-codesandbox.md`).
 *
 * Same reasoning as `codesandbox-translate.ts`, one layer up: these are the parts of the boot that
 * fail SILENTLY. A session request missing its project id is a 400 the user reads as "the workspace
 * is broken"; a preview minted without one hands project A's token to project B's iframe; a reconnect
 * that accepts a different sandbox swaps a filesystem underneath a live page. None of them throws on
 * its own, so each is a pure function with a test rather than a line inside an async boot.
 *
 * No SDK import here on purpose — this module must stay importable from a spec (and from the seam
 * entry) without pulling `@codesandbox/sdk/browser` into a build that does not use it.
 */
import { SandboxAdoptionError } from './errors';

/**
 * Where a sandbox records WHICH project it belongs to.
 *
 * Defense in depth for the warm-boot gate (`liveSandboxIsTruth`). With per-project VMs a mismatch
 * should be impossible — which is exactly why it is cheap insurance: the one thing standing between a
 * mis-pointed `sandbox_id` (an operator edit, a restored old row, a bug in the compare-and-set) and
 * silently adopting another project's files as this project's truth is a byte on disk that disagrees.
 *
 * Inside `.codesandbox/` deliberately, because that directory is excluded at the MAP layer
 * (`MAP_EXCLUDED_DIRS`, shipped with T9): the sentinel therefore never appears in the file tree, the
 * model's context, a ZIP export, a working copy or a git push, and a repo restore can no longer plan
 * it for deletion. It is read through the provider's `fs` for exactly that reason — the map is not
 * where it lives.
 */
export const SANDBOX_IDENTITY_PATH = '.codesandbox/btk-project.json';

/** The directory half of {@link SANDBOX_IDENTITY_PATH} — created before the write. */
export const SANDBOX_IDENTITY_DIR = '.codesandbox';

/** The bytes written to {@link SANDBOX_IDENTITY_PATH}. */
export function identitySentinel(projectId: string): string {
  return `${JSON.stringify({ projectId }, null, 2)}\n`;
}

/**
 * What the sentinel on disk says about whose sandbox this is.
 *
 * Three answers, not two. `unknown` is its own case because a sandbox created before the sentinel
 * existed — or one whose `.codesandbox/` was cleaned — carries no claim at all, and treating "no
 * claim" as "wrong project" would send every warm VM in existence down the restore-from-a-client-copy
 * path the gate was built to avoid. Only a sentinel that is PRESENT and NAMES SOMEONE ELSE is a
 * mismatch.
 */
export function readIdentityVerdict(
  raw: string | undefined,
  expectedProjectId: string,
): 'match' | 'mismatch' | 'unknown' {
  if (!raw) {
    return 'unknown';
  }

  let recorded: unknown;

  try {
    recorded = (JSON.parse(raw) as { projectId?: unknown }).projectId;
  } catch {
    // Corrupt or truncated: it makes no claim we can act on, so it makes no claim at all.
    return 'unknown';
  }

  if (typeof recorded !== 'string' || recorded === '') {
    return 'unknown';
  }

  return recorded === expectedProjectId ? 'match' : 'mismatch';
}

/**
 * The body of a `POST /api/sandbox/session`.
 *
 * The project id is REQUIRED by the route (`requireOwnedProject` is the second wall) and omitting it
 * is a 400 — which is precisely what the pre-per-project client did, so this exists to make the shape
 * a tested fact rather than an inline object literal.
 */
export function sessionRequestBody(projectId: string, options: { reset?: boolean } = {}): Record<string, unknown> {
  const body: Record<string, unknown> = { projectId };

  if (options.reset) {
    body.reset = true;
  }

  return body;
}

/** The query form of a preview mint. Both parameters are required by the route. */
export function previewRequestPath(projectId: string, port: number): string {
  return `/api/sandbox/preview?port=${encodeURIComponent(String(port))}&projectId=${encodeURIComponent(projectId)}`;
}

/**
 * Refuse a reconnect that would move this page onto a different sandbox.
 *
 * `created` and a changed id are checked SEPARATELY because they are different accidents with the
 * same consequence: `created: true` is the server having forked a fresh template (the previous VM was
 * gone), while a changed id with `created: false` is this tab having been handed someone else's
 * running sandbox. Either way the live client would start reading and WRITING a filesystem that is
 * not the one the workbench is rendering.
 */
export function assertReconnectSameSandbox(
  bootedSandboxId: string,
  next: { sandboxId: string; created?: boolean },
): void {
  if (next.created || next.sandboxId !== bootedSandboxId) {
    throw new SandboxAdoptionError(bootedSandboxId, next.sandboxId);
  }
}

/**
 * Is a cached preview URL still worth handing to an iframe?
 *
 * Split out so the cache rule is testable without a clock in the boot module. T8 threads `expiresAt`
 * all the way to `PreviewInfo`; this is the half that keeps a token from being served with seconds
 * left on it.
 */
export function previewCacheIsFresh(expiresAt: number, now: number, remintWindowMs: number): boolean {
  return expiresAt - now > remintWindowMs;
}

/**
 * Re-mint this long before a preview token expires.
 *
 * 🔴 **ONE writer for a number two layers depend on agreeing about.** The store schedules its rotation
 * at `expiresAt - window`; the boot's mint cache decides "still fresh?" with the same window. Two
 * independently-chosen values would silently disagree in the direction that breaks it — the store asks
 * for a new token and the cache hands back the old one, so the timer fires, changes nothing, and the
 * preview 401s anyway. Derived, not copied (`spec/billing.md`'s drift lesson, applied to a clock).
 *
 * Lives HERE rather than in the store because this module is pure and importable from either side.
 */
export const PREVIEW_REMINT_WINDOW_MS = 5 * 60_000;
