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
import type { CodeSandbox, SandboxSession, VMTier } from '@codesandbox/sdk';
import {
  requireSandboxApiKey,
  sandboxHibernationSeconds,
  sandboxHostTokenMinutes,
  sandboxTemplate,
  sandboxVmTier,
} from './config';
import { isSandboxGoneError } from './lifecycle';
import { recordSandboxMark, type SandboxLifecycleEvent } from './usage-store';
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

/**
 * 🔴 **THE SDK IS LOADED LAZILY, AND THAT IS A DEPLOYMENT REQUIREMENT, NOT A PREFERENCE.**
 *
 * The production image serves the Remix build under **workerd** (`pnpm run dockerstart` →
 * `wrangler pages dev`, see DEPLOY.md). `@codesandbox/sdk`'s ESM entry calls
 * `createRequire(import.meta.url)` at module scope, and `import.meta.url` is `undefined` there — so a
 * STATIC import throws while the server bundle is still evaluating, before any route exists:
 *
 *     TypeError: The argument 'path' must be a file URL object … Received 'undefined'
 *
 * MEASURED: with the static import, **every request to the production build returned 500**, including
 * `/healthz` — which is the path Lightsail's health check polls, so the deployment could never have
 * reached ACTIVE. It took down auth, billing and generation alike, none of which have anything to do
 * with sandboxes; the import was simply in the same bundle.
 *
 * Deferring it to first USE means the module only loads on a request that genuinely needs a VM, which
 * is also the only kind of request that can afford it. The type-only import above is erased at compile
 * time and reaches no runtime.
 */
let sdkModule: Promise<typeof import('@codesandbox/sdk')> | undefined;

function loadSdk(): Promise<typeof import('@codesandbox/sdk')> {
  if (!sdkModule) {
    sdkModule = import('@codesandbox/sdk');
  }

  return sdkModule;
}

async function sdk(context?: unknown): Promise<CodeSandbox> {
  const key = requireSandboxApiKey(context);
  let client = clients.get(key);

  if (!client) {
    const sdkExports = await loadSdk();
    client = new sdkExports.CodeSandbox(key);
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
async function tier(context?: unknown): Promise<VMTier> {
  const name = sandboxVmTier(context);
  const sdkExports = await loadSdk();

  const resolved = sdkExports.VMTier.All.find((candidate) => candidate.name?.toLowerCase() === name.toLowerCase());

  if (!resolved) {
    logger.warn(`Unknown CODESANDBOX_VM_TIER "${name}" — falling back to Pico.`);
    return sdkExports.VMTier.Pico;
  }

  return resolved;
}

/**
 * Who a VM's time belongs to, for the lifecycle marks (`usage-store.ts`, plan T12).
 *
 * Threaded in rather than looked up here, for two reasons: this module holds the API key and has no
 * business reading project rows, and the callers already know the answer — the session route has both
 * ids in hand, and the cap sweep derives the project from the row it selected the sandbox from.
 *
 * Optional because attribution is a REPORTING nicety and starting a VM is not. A mark with no user
 * still counts its hours (they land under `unattributed`, visibly); a caller that could not supply one
 * must never be blocked from doing the actual work.
 */
export interface SandboxAttribution {
  userId?: string;
  projectId?: string;
}

/**
 * Record one lifecycle mark, best-effort.
 *
 * `recordSandboxMark` cannot throw, so this is a naming convenience rather than a second guard — but
 * it is the one place the `at` stamp is taken, so a mark can never be dated by the reader.
 */
function mark(
  event: SandboxLifecycleEvent,
  sandboxId: string,
  attribution: SandboxAttribution | undefined,
  context: unknown,
): Promise<void> {
  return recordSandboxMark(
    { event, sandboxId, userId: attribution?.userId, projectId: attribution?.projectId, at: Date.now() },
    context,
  );
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
export async function createSandboxForProject(
  projectId: string,
  context?: unknown,
  attribution?: SandboxAttribution,
): Promise<StartedSandbox> {
  const sandbox = await (
    await sdk(context)
  ).sandboxes.create({
    id: sandboxTemplate(context),
    title: `project-${projectId}`,
    privacy: 'private',
    tags: ['btk', `project:${projectId}`],
    vmTier: await tier(context),
    hibernationTimeoutSeconds: sandboxHibernationSeconds(context),
  });

  // The project id is known here whatever the caller passed, so a create is never unattributed by project.
  await mark('create', sandbox.id, { ...attribution, projectId: attribution?.projectId ?? projectId }, context);

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
export async function resumeSandbox(
  sandboxId: string,
  context?: unknown,
  attribution?: SandboxAttribution,
): Promise<StartedSandbox> {
  const sandbox = await (await sdk(context)).sandboxes.resume(sandboxId);

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
    await sandbox.updateTier(await tier(context));
  } catch (error) {
    logger.warn(`Could not apply the configured VM tier to ${sandboxId}: ${(error as Error)?.message}`);
  }

  await mark('resume', sandbox.id, attribution, context);

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
    await (await sdk(context)).sandboxes.get(sandboxId);
    return true;
  } catch (error) {
    /*
     * The classification lives in `lifecycle.ts` (pure, no SDK import) because the resume path needs
     * the SAME answer: a resume that fails because the VM is gone must fall through to create, and a
     * resume that fails for any other reason must not. Two copies of this predicate would eventually
     * disagree, and the direction they would disagree in is "replace the user's project".
     */
    if (isSandboxGoneError(error)) {
      return false;
    }

    logger.warn(`Could not determine whether sandbox ${sandboxId} exists: ${(error as Error)?.message}`);

    return undefined;
  }
}

/** One running VM as the provider reports it — the input to `decideVmCap`. */
export interface RunningSandbox {
  sandboxId: string;

  /** When this VM's current session began, as epoch ms. Absent when the provider does not say. */
  startedAt?: number;

  /** Last observed activity, epoch ms. The fallback age signal when `startedAt` is absent. */
  lastActiveAt?: number;
}

/**
 * Every VM currently running on the API key's workspace.
 *
 * Workspace-wide by nature — the provider has no per-user view, because the account is ours and the
 * users are ours. Callers intersect this with the sandbox ids on ONE user's project rows, which is
 * what makes the per-user cap a per-user cap rather than a platform-wide one.
 *
 * ⚠️ The provider documents this data as refreshed roughly every 30 seconds, so it is a recent
 * picture and not a live one. That is fine for the only thing it is used for: hibernation is free and
 * reversible, so acting on a slightly stale list costs a resume, never any state.
 */
export async function listRunningSandboxes(context?: unknown): Promise<RunningSandbox[]> {
  const { vms } = await (await sdk(context)).sandboxes.listRunning();

  return vms
    .filter((vm): vm is typeof vm & { id: string } => typeof vm.id === 'string' && vm.id.length > 0)
    .map((vm) => ({
      sandboxId: vm.id,
      startedAt: vm.sessionStartedAt ? vm.sessionStartedAt.getTime() : undefined,
      lastActiveAt: vm.lastActiveAt ? vm.lastActiveAt.getTime() : undefined,
    }));
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
  const sandbox = await (await sdk(context)).sandboxes.resume(sandboxId);

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
  const client = await sdk(context);
  const token = await client.hosts.createToken(sandboxId, { expiresAt });

  return {
    url: client.hosts.getUrl(token, port),
    headers: client.hosts.getHeaders(token),
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * The files a forked template must contain before it may be promoted (plan T14).
 *
 * SENTINELS, never a count — the same rule `waitForMountVisible` records. A count is a guess that
 * moves the moment the starter gains a file, and it would start refusing valid promotions with a
 * message about the wrong thing. These four say "this is a Babylon Toolkit project, and its shape is
 * the one `src/scripts/` and the play contract assume".
 *
 * ⚠️ Stored PROJECT-RELATIVE and resolved against `client.workspacePath` at the call site. MEASURED
 * (`spec/sandbox-codesandbox.md`): `batchWrite` takes relative paths and **everything else is
 * absolute** — the SDK forwards the string to the VM agent verbatim, so a bare `package.json` would
 * be looked for at the filesystem root. Every sentinel would then be "missing", every promotion would
 * 422, and the message would blame the template for a path bug.
 */
export const TEMPLATE_SENTINEL_FILES = ['package.json', 'vite.config.ts', 'src/babylon/globals.ts', 'src/pages'];

export interface TemplateValidation {
  ok: boolean;

  /** Why it was refused, in the operator's words. Absent when `ok`. */
  reason?: string;

  /** The throwaway VM this check forked, so the caller can reap it whatever the verdict. */
  probeSandboxId?: string;
}

/**
 * Fork a candidate template ONCE and check it is actually mountable (plan T14).
 *
 * 🔴 This runs BEFORE the pin moves. Promoting an unmountable template would break every new project
 * at once — the exact failure pinning exists to prevent, delivered by the mechanism meant to prevent
 * it (`api.admin.template.ts` makes the same argument for the file-tree pin, and it is the reason that
 * route validates rather than trusting a SHA).
 *
 * It costs one VM for a few seconds, on an ADMIN action, once per promotion. That is the cheapest
 * honest answer available: the alternative is asking CodeSandbox whether an id exists, which says
 * nothing about whether the thing behind it boots or contains a Babylon project.
 *
 * The probe id is returned rather than reaped here so the caller reaps it on BOTH paths — a validation
 * that leaks a VM when it refuses would make refusing more expensive than accepting.
 *
 * ⚠️ It deliberately bypasses the per-user create rate limit and the running-VM cap. Both bound what
 * USERS can spend; this is an admin action, at most one VM per promotion, monitored, and with a
 * 60-second hibernation timeout. Counting it would let a few promotions lock the admin out of the
 * control they use to fix a bad template — the cap refusing the repair, at the moment of the repair.
 */
export async function validateSandboxTemplate(target: string, context?: unknown): Promise<TemplateValidation> {
  let probeSandboxId: string | undefined;

  try {
    const sandbox = await (
      await sdk(context)
    ).sandboxes.create({
      id: target,
      title: 'template-validation-probe',
      privacy: 'private',
      tags: ['btk', 'template-probe'],
      vmTier: await tier(context),

      // Short: this VM exists for one filesystem read and must never outlive a forgotten reap.
      hibernationTimeoutSeconds: 60,
    });

    probeSandboxId = sandbox.id;

    const client = await sandbox.connect();

    try {
      const missing: string[] = [];

      /*
       * The SDK's own answer for where the project lives, rather than our `WORK_DIR` constant: this is
       * a VM we just forked from an ARBITRARY candidate template, and asserting our root onto someone
       * else's image is how a valid template gets refused for the wrong reason.
       */
      const root = client.workspacePath.replace(/\/+$/, '');

      for (const path of TEMPLATE_SENTINEL_FILES) {
        try {
          await client.fs.stat(`${root}/${path}`);
        } catch {
          missing.push(path);
        }
      }

      if (missing.length > 0) {
        return {
          ok: false,
          reason: `it booted, but it is not a Babylon Toolkit starter — missing ${missing.join(', ')}`,
          probeSandboxId,
        };
      }

      return { ok: true, probeSandboxId };
    } finally {
      await client.disconnect().catch(() => undefined);
      client.dispose();
    }
  } catch (error) {
    /*
     * A fork or connect that throws IS the answer: whatever the operator typed does not produce a
     * usable sandbox. Reported verbatim, because "invalid template" without the provider's own words
     * leaves them guessing between a typo, a deleted alias and an outage.
     */
    return { ok: false, reason: (error as Error)?.message || 'the template could not be forked', probeSandboxId };
  }
}

/**
 * Put a sandbox to sleep. Cheap, reversible, and the correct default when a builder tab closes.
 *
 * Best-effort by design: failing to hibernate costs idle VM time until the provider's own timeout
 * fires, which is a bill, not a broken product — so it must never fail the request that triggered it.
 * It is LOGGED rather than swallowed, because a hibernate that silently never works is a bill nobody
 * would otherwise notice.
 */
export async function hibernateSandbox(
  sandboxId: string,
  context?: unknown,
  attribution?: SandboxAttribution,
): Promise<void> {
  try {
    await (await sdk(context)).sandboxes.hibernate(sandboxId);
  } catch (error) {
    logger.warn(`Could not hibernate sandbox ${sandboxId}: ${(error as Error)?.message}`);

    /*
     * No mark. A hibernate that did not happen leaves the VM RUNNING and billing — recording the
     * close anyway would end the interval in the report while the meter kept turning, i.e. the report
     * would under-state cost exactly when the cost is real. An interval left open is the honest
     * reading, and the provider's own idle timeout closes it eventually.
     */
    return;
  }

  await mark('hibernate', sandboxId, attribution, context);
}

/**
 * Destroy a sandbox permanently. Called when the PROJECT is deleted.
 *
 * Shutdown first, then delete: MEASURED, `delete` on a running VM can fail with
 * `An unexpected error occurred`, and a delete that fails silently leaves a VM the operator is
 * paying for and has no obvious way to find. Bytes must never outlive the record that named them —
 * the same orphan rule that makes a project delete sweep storage prefixes.
 */
export async function deleteSandbox(
  sandboxId: string,
  context?: unknown,
  attribution?: SandboxAttribution,
): Promise<void> {
  const client = await sdk(context);

  try {
    await client.sandboxes.shutdown(sandboxId);
  } catch (error) {
    logger.warn(`Could not shut down sandbox ${sandboxId} before deleting: ${(error as Error)?.message}`);
  }

  await client.sandboxes.delete(sandboxId);

  /*
   * After the delete SUCCEEDS. A failed delete throws (deliberately — an orphan VM must be loud), and
   * marking the interval closed on the way past would tell the report the meter stopped on a VM the
   * operator is still paying for.
   */
  await mark('delete', sandboxId, attribution, context);
}
