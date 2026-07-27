/**
 * The CodeSandbox lifecycle, server-side (SPEC §5, §8, `spec/sandbox-codesandbox.md`).
 *
 * This module holds the API key. Nothing it returns ever contains it.
 *
 * ## What crosses to the browser, and why it is safe
 *
 * A **`SandboxSession`** — a scoped, per-sandbox, expiring credential minted by
 * `sandbox.createSession()`. The browser passes it to `connectToSandbox` from
 * `@codesandbox/sdk/browser` and gets a `SandboxClient` that can only touch that one sandbox. This
 * is the SDK's own design for exactly this split, and it is what lets the provider run client-side
 * (where `FilesStore` and the workbench live) without §5 bending an inch.
 *
 * ⚠️ A session is still a bearer credential. It is minted per user per project behind
 * `requireOwnedProject`, it carries `permission`, and it must never be logged.
 *
 * ## Everything here spends money
 *
 * A running VM bills per second, so every function that can start one is a cost path. The bias
 * throughout is to reap rather than to leak: `hibernate` is cheap and reversible (MEASURED: resume
 * in 1.3–2.4s with the filesystem AND the running dev server intact), so it is the default way to
 * put a sandbox down.
 */
import { CodeSandbox, VMTier } from '@codesandbox/sdk';
import type { SandboxSession } from '@codesandbox/sdk';
import {
  requireSandboxApiKey,
  sandboxHibernationSeconds,
  sandboxHostTokenMinutes,
  sandboxTemplate,
  sandboxVmTier,
} from './config';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('sandbox-service');

/**
 * One SDK client per API key.
 *
 * Cached because constructing it per request would rebuild the HTTP plumbing on a hot path, and
 * keyed by the key itself so a rotated credential takes effect without a restart — the same shape
 * as the market-price in-process cache.
 */
const clients = new Map<string, CodeSandbox>();

function sdk(context?: unknown): CodeSandbox {
  const key = requireSandboxApiKey(context);
  let client = clients.get(key);

  if (!client) {
    client = new CodeSandbox(key);
    clients.set(key, client);
  }

  return client;
}

/**
 * Resolve the configured tier name to a `VMTier`, falling back rather than throwing.
 *
 * A typo in `CODESANDBOX_VM_TIER` must not make every project fail to open. It degrades to Pico —
 * the cheapest — because the failure direction that matters is "silently ran everyone on XLarge".
 */
function tier(context?: unknown): VMTier {
  const name = sandboxVmTier(context);

  const resolved = VMTier.All.find((candidate) => candidate.name?.toLowerCase() === name.toLowerCase());

  if (!resolved) {
    logger.warn(`Unknown CODESANDBOX_VM_TIER "${name}" — falling back to Pico.`);
    return VMTier.Pico;
  }

  return resolved;
}

export interface StartedSandbox {
  sandboxId: string;

  /** How it came up. `CLEAN` means the snapshot was gone and setup re-ran — the files are template state. */
  bootupType: 'RUNNING' | 'CLEAN' | 'RESUME' | 'FORK';
}

/**
 * Fork a brand-new sandbox for a project from the pinned template.
 *
 * 🔴 **`privacy: 'private'` is not optional.** The SDK's default is `"public"`, so a sandbox created
 * without this is a user's game readable by anyone who guesses a short id. It is passed at every
 * creation site and pinned by a test, in the same spirit as `adoptExisting: false` on the git save.
 *
 * The template is an ALIAS (`btk@starter`), so what a project forks is whatever an admin last
 * promoted — §4.4's pin, applied to the runtime instead of the file tree.
 */
export async function createSandboxForProject(projectId: string, context?: unknown): Promise<StartedSandbox> {
  const sandbox = await sdk(context).sandboxes.create({
    id: sandboxTemplate(context),
    title: `project-${projectId}`,
    privacy: 'private',
    tags: ['btk', `project:${projectId}`],
    vmTier: tier(context),
    hibernationTimeoutSeconds: sandboxHibernationSeconds(context),
  });

  return { sandboxId: sandbox.id, bootupType: sandbox.bootupType };
}

/**
 * Bring an existing sandbox back up.
 *
 * Resume covers three provider states and only the third loses anything: a warm memory snapshot
 * (1–3s), an archived one (10–60s, state retained), or an expired one (CLEAN — setup re-runs and the
 * files are template state). Callers must READ `bootupType`: a `CLEAN` answer means the project's
 * files are gone and the §4.5.4c working copy has to refill them. Treating resume as always-restoring
 * is how a user gets an empty project with no error.
 */
export async function resumeSandbox(sandboxId: string, context?: unknown): Promise<StartedSandbox> {
  const sandbox = await sdk(context).sandboxes.resume(sandboxId);

  /*
   * Apply the configured tier to an EXISTING sandbox, so raising `CODESANDBOX_VM_TIER` actually
   * reaches the projects that already exist. Without this the variable only affects sandboxes
   * created after the change, and an operator raising it in response to a crash would watch the
   * crash continue — the config would look ignored.
   *
   * MEASURED why this matters: the real Babylon Toolkit starter (32 dependencies, 759MB of
   * `node_modules`) dies with a **bus error** — the kernel killing it for memory — when Vite starts
   * on Pico's 1 CPU / 2GiB. An earlier "490MB, Pico is enough" reading came from a five-dependency
   * toy and did not survive contact with the real thing.
   *
   * ⚠️ `updateTier` is UPGRADE-ONLY and scales without a reboot. A request to shrink throws, which
   * is why this is best-effort: refusing to resume a working sandbox because an operator lowered a
   * number would turn a cost tweak into an outage. Logged, never fatal.
   */
  try {
    await sandbox.updateTier(tier(context));
  } catch (error) {
    logger.warn(`Could not apply the configured VM tier to ${sandboxId}: ${(error as Error)?.message}`);
  }

  return { sandboxId: sandbox.id, bootupType: sandbox.bootupType };
}

/**
 * Does this sandbox still exist at the provider?
 *
 * 🔴 **Tri-state on purpose, and the third state is the point.** `true`/`false` are confirmed
 * answers; `undefined` means "could not find out". `decideSandboxStart` refuses to act on
 * `undefined` precisely so a network blip cannot be read as "the sandbox is gone" and replace a
 * user's project with a fresh template. Returning `false` on any error would collapse exactly the
 * distinction this exists to preserve.
 */
export async function sandboxExists(sandboxId: string, context?: unknown): Promise<boolean | undefined> {
  try {
    await sdk(context).sandboxes.get(sandboxId);
    return true;
  } catch (error) {
    const message = (error as Error)?.message ?? '';

    if (/not found|404|does not exist/i.test(message)) {
      return false;
    }

    logger.warn(`Could not determine whether sandbox ${sandboxId} exists: ${message}`);

    return undefined;
  }
}

/**
 * Mint a browser session for a sandbox.
 *
 * `permission` is enforced by the provider, not by hiding UI: a read-only session is the honest
 * implementation of a shared or gallery view, and it holds even if the client is tampered with.
 */
export async function createBrowserSession(
  sandboxId: string,
  options: { permission?: 'read' | 'write'; env?: Record<string, string> } = {},
  context?: unknown,
): Promise<SandboxSession> {
  const sandbox = await sdk(context).sandboxes.resume(sandboxId);

  return sandbox.createSession({
    permission: options.permission ?? 'write',
    env: options.env,
  });
}

export interface PreviewAccess {
  /** The full preview URL, token included as a query param so an `<iframe src>` can use it directly. */
  url: string;

  /** Header form, for server-side fetches of the same origin. */
  headers: Record<string, string>;

  expiresAt: string;
}

/**
 * Mint preview access for a port on a PRIVATE sandbox.
 *
 * MEASURED: all three forms work (header, cookie, `?preview_token=`), and an anonymous request is
 * refused with **401** — a private sandbox really is private. The query-param form is the one that
 * matters, because an `<iframe src>` cannot set a header, so this is what makes the preview
 * embeddable with no proxy in front of it.
 */
export async function createPreviewAccess(sandboxId: string, port: number, context?: unknown): Promise<PreviewAccess> {
  const expiresAt = new Date(Date.now() + sandboxHostTokenMinutes(context) * 60_000);
  const client = sdk(context);
  const token = await client.hosts.createToken(sandboxId, { expiresAt });

  return {
    url: client.hosts.getUrl(token, port),
    headers: client.hosts.getHeaders(token),
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Put a sandbox to sleep. Cheap, reversible, and the correct default when a builder tab closes.
 *
 * Best-effort by design: failing to hibernate costs idle VM time until the provider's own timeout
 * fires, which is a bill, not a broken product — so it must never fail the request that triggered it.
 * It is LOGGED rather than swallowed, because a hibernate that silently never works is a bill nobody
 * would otherwise notice.
 */
export async function hibernateSandbox(sandboxId: string, context?: unknown): Promise<void> {
  try {
    await sdk(context).sandboxes.hibernate(sandboxId);
  } catch (error) {
    logger.warn(`Could not hibernate sandbox ${sandboxId}: ${(error as Error)?.message}`);
  }
}

/**
 * Destroy a sandbox permanently. Called when the PROJECT is deleted.
 *
 * Shutdown first, then delete: MEASURED, `delete` on a running VM can fail with
 * `An unexpected error occurred`, and a delete that fails silently leaves a VM the operator is
 * paying for and has no obvious way to find. Bytes must never outlive the record that named them —
 * the same orphan rule that makes a project delete sweep storage prefixes.
 */
export async function deleteSandbox(sandboxId: string, context?: unknown): Promise<void> {
  const client = sdk(context);

  try {
    await client.sandboxes.shutdown(sandboxId);
  } catch (error) {
    logger.warn(`Could not shut down sandbox ${sandboxId} before deleting: ${(error as Error)?.message}`);
  }

  await client.sandboxes.delete(sandboxId);
}
