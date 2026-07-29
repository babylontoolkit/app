/**
 * Mint a browser session for a PROJECT's sandbox (SPEC §4.5.3, §5, §8, `spec/sandbox-codesandbox.md`).
 *
 * This is the doorway that makes a server-backed sandbox usable from client code without the API key
 * ever leaving the server. The browser POSTs a project id it owns, gets a scoped `SandboxSession`, and
 * hands it to `connectToSandbox`. The key stays in `app/lib/.server/**`.
 *
 * ## The four things this route must never do
 *
 * 1. **Accept a sandbox id from the caller.** A session is a bearer credential for one sandbox — a
 *    caller-supplied id would be a live shell in someone else's project. The client supplies a PROJECT
 *    id, which `requireOwnedProject` turns into a project or a 404; the sandbox id is read off the row.
 *    There is no sandbox id on the wire to tamper with. (This replaces the per-user registry, which
 *    derived the key from the user id and therefore gave a user's SECOND project the FIRST one's VM.)
 * 2. **Create a sandbox when it cannot confirm the old one is gone.** `decideSandboxStart` returns
 *    `refuse` for "could not find out", and this route honours it with a retryable 503 rather than
 *    forking a fresh template over the user's work.
 * 3. **Leave a forked VM that nothing can name.** Every create is compare-and-set against the row
 *    (`decideCreatePersist`), and the loser of a race — like the VM a reset replaces — is destroyed.
 *    An orphan bills by the second and is invisible in every panel we have.
 * 4. **Return anything derived from `CODESANDBOX_API_KEY`.** The session and the preview URL are
 *    scoped, expiring credentials for one sandbox; the key is not in either.
 *
 * ⚠️ `requireVerifiedUser`, not `requireUser`: creating a sandbox spends money, and an unverified
 * address is the shape every free-tier abuse takes (§4.5.4 draws the same line for the signup grant).
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { getProjectStore } from '~/lib/.server/projects/store';
import { errorResponse } from '~/lib/.server/http';
import { isSandboxConfigured, sandboxCreatesPerHour, sandboxMaxRunningVms } from '~/lib/.server/sandbox/config';
import { enforceRunningVmCap } from '~/lib/.server/sandbox/vm-cap';
import { ensureSandboxTemplatePin } from '~/lib/.server/sandbox/template-pin';
import { getObjectStore } from '~/lib/.server/storage';
import { decideCreatePersist, decideSandboxStart, isSandboxGoneError } from '~/lib/.server/sandbox/lifecycle';
import { decideCreateAllowed, recentSandboxCreates, recordSandboxCreate } from '~/lib/.server/sandbox/create-limit';
import {
  createBrowserSession,
  createSandboxForProject,
  deleteSandbox,
  resumeSandbox,
  sandboxExists,
} from '~/lib/.server/sandbox/service';
import { getMonitor } from '~/lib/.server/monitoring';
import { recordSandboxCleanBoot, recordSandboxOutcome } from '~/lib/.server/monitoring/sandbox-rates';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.sandbox.session');

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, { status: 405 });
    }

    const user = await requireVerifiedUser(request, context);

    /*
     * A "not configured" answer is a describable state, not a crash (§1.3 principle 0). The client
     * reads this and falls back rather than showing a broken workbench.
     */
    if (!isSandboxConfigured(context)) {
      return json({ error: 'Sandbox provider is not configured.', configured: false }, { status: 503 });
    }

    const body = (await request.json().catch(() => ({}))) as { projectId?: unknown; reset?: unknown };
    const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';

    if (!projectId) {
      return json({ error: 'A projectId is required to start a sandbox.' }, { status: 400 });
    }

    // The second wall. Someone else's project is a 404, never a 403 — a 403 confirms the id exists.
    const project = await requireOwnedProject(user, projectId, context);

    /*
     * The async doorway for the template pin (T14). `sandboxTemplate()` is called synchronously deep
     * in the fork request, so the promoted pin has to already be in the in-process cache by then —
     * same seam, and same reason, as `ensureMarketPrices()` before a generation. TTL'd, so this is a
     * storage read at most once a minute; a failed load keeps the previous answer and never blocks.
     */
    await ensureSandboxTemplatePin(getObjectStore(context));

    const store = getProjectStore(context);

    const resetRequested = body.reset === true;

    /*
     * The id as of THIS request's decision. `decideCreatePersist` compares against it later, so it
     * must be captured before anything can change the row underneath us.
     */
    const before = project.sandboxId;

    /*
     * The existence check is skipped when there is nothing to check — it is a network round trip
     * whose only possible answer would be about an id we do not have.
     */
    const existsAtProvider = before ? await sandboxExists(before, context) : undefined;

    const decision = decideSandboxStart({
      recordedSandboxId: before,
      existsAtProvider,
      resetRequested,
    });

    if (decision.action === 'refuse') {
      /*
       * We hold an id and could not confirm anything about it. Creating would abandon a sandbox that
       * is probably fine and replace the user's files with a fresh template; 503 is retryable and
       * touches nothing.
       */
      logger.warn(`Refusing to start a sandbox for project ${project.id}: ${decision.reason}`);

      /*
       * A refusal IS a failed resume from the user's side — they asked to open their project and it
       * did not open. It reaches here only when `sandboxExists` could not find out, i.e. the provider
       * is unreachable, which is precisely the platform-wide condition the rate window exists to
       * surface. Leaving it unrecorded would make a total provider outage look like an idle window.
       */
      recordSandboxOutcome(getMonitor(context), 'resume', true);

      return json(
        { error: 'Could not reach the sandbox provider. Please try again.', retryable: true },
        { status: 503 },
      );
    }

    /** Best-effort destruction with a monitored failure — an orphan VM is a bill nobody sees. */
    const dispose = async (ids: string[]) => {
      for (const id of ids) {
        try {
          await deleteSandbox(id, context, { userId: user.id, projectId: project.id });
          logger.info(`Disposed sandbox ${id} for project ${project.id}.`);
        } catch (error) {
          getMonitor(context).captureException(error, {
            scope: 'sandbox.dispose',
            userId: user.id,
            tags: { projectId: project.id, sandboxId: id },
          });
        }
      }
    };

    /**
     * Fork a VM, then settle who actually owns the row.
     *
     * Shared by the ordinary create path and the resume→create fallback, so the compare-and-set and
     * the rate limit cannot end up applying to one and not the other.
     */
    const createAndRecord = async () => {
      const limit = decideCreateAllowed(recentSandboxCreates(user.id), Date.now(), sandboxCreatesPerHour(context));

      if (!limit.allowed) {
        return { limited: limit } as const;
      }

      /*
       * The window covers the PROVIDER call only, and it is inside `createAndRecord` so that both
       * callers — the ordinary create and the resume→create fallback — feed it. A rate-limited request
       * returns above without recording: that is US refusing, not the provider failing, and counting it
       * would let one user's runaway loop trip a platform-wide outage alert.
       */
      let created: Awaited<ReturnType<typeof createSandboxForProject>>;

      try {
        created = await createSandboxForProject(project.id, context, { userId: user.id, projectId: project.id });
        recordSandboxOutcome(getMonitor(context), 'create', false);
      } catch (error) {
        recordSandboxOutcome(getMonitor(context), 'create', true);
        throw error;
      }

      recordSandboxCreate(user.id);

      // Re-read to see whether a concurrent request recorded a different sandbox while we were forking.
      const fresh = await store.get(project.id);

      const persist = decideCreatePersist({
        before,
        created: created.sandboxId,
        current: fresh?.sandboxId,
        resetRequested,
      });

      if (persist.persist) {
        await store.update(project.id, { sandboxId: persist.canonicalSandboxId });
      } else {
        logger.warn(
          `Concurrent create for project ${project.id}: keeping ${persist.canonicalSandboxId}, disposing ${created.sandboxId}.`,
        );
      }

      await dispose(persist.dispose);

      return {
        limited: undefined,
        sandboxId: persist.canonicalSandboxId,

        /*
         * A sandbox we did NOT create was not booted by us — reporting our own `bootupType` for it
         * would tell the client "freshly forked, template state" about a VM that may hold real files.
         * `RESUME` is the honest answer: we are joining something that already existed.
         */
        bootupType: persist.persist ? created.bootupType : 'RESUME',
        created: persist.persist,
      } as const;
    };

    let sandboxId: string;
    let bootupType: string;
    let didCreate: boolean;

    if (decision.action === 'create') {
      const result = await createAndRecord();

      if (result.limited) {
        return json(
          {
            error: `Too many sandboxes started on this account. Try again in about ${Math.ceil(
              result.limited.retryAfterSeconds / 60,
            )} minute(s).`,
            retryable: true,
          },
          { status: 429, headers: { 'Retry-After': String(result.limited.retryAfterSeconds) } },
        );
      }

      sandboxId = result.sandboxId!;
      bootupType = result.bootupType!;
      didCreate = result.created!;
      logger.info(`Sandbox ${sandboxId} ready for project ${project.id} (${decision.reason}).`);
    } else {
      try {
        const resumed = await resumeSandbox(before!, context, { userId: user.id, projectId: project.id });
        sandboxId = resumed.sandboxId;
        bootupType = resumed.bootupType;
        didCreate = false;
        recordSandboxOutcome(getMonitor(context), 'resume', false);

        /*
         * A separate window, on the RESUME path only. This request succeeded — but `CLEAN` means the
         * snapshot expired and the files are template state, so the project the user sees came from the
         * working copy, not from the VM. No failure metric can ever show that.
         */
        recordSandboxCleanBoot(getMonitor(context), bootupType === 'CLEAN');

        logger.info(`Resumed sandbox ${sandboxId} for project ${project.id} (${bootupType}).`);
      } catch (error) {
        recordSandboxOutcome(getMonitor(context), 'resume', true);

        /*
         * `sandboxExists` said the VM was there and the resume disagrees — a VM deleted provider-side
         * between the two calls, or one whose existence check answered from a stale cache. Without
         * this fallback the project is bricked into a permanent 503: every later request repeats the
         * same check, gets the same answer, and fails the same way, with no path back for the user.
         *
         * ONCE, and only on a CONFIRMED-gone error. Retrying a create on a transient failure is the
         * "replace the user's project with a template" direction `decideSandboxStart` exists to avoid.
         */
        if (!isSandboxGoneError(error)) {
          throw error;
        }

        logger.warn(`Sandbox ${before} for project ${project.id} is gone at the provider — creating a new one.`);

        const result = await createAndRecord();

        if (result.limited) {
          return json(
            {
              error: `Too many sandboxes started on this account. Try again in about ${Math.ceil(
                result.limited.retryAfterSeconds / 60,
              )} minute(s).`,
              retryable: true,
            },
            { status: 429, headers: { 'Retry-After': String(result.limited.retryAfterSeconds) } },
          );
        }

        sandboxId = result.sandboxId!;
        bootupType = result.bootupType!;
        didCreate = result.created!;
      }
    }

    const session = await createBrowserSession(sandboxId, { permission: 'write' }, context);

    /*
     * Make room, never refuse (`vm-cap.ts`). Per-project sandboxes mean a user with six open projects
     * has six VMs billing until each one's own idle timeout; hibernating the least-recently-touched
     * one costs a 1–3s resume and nothing else.
     *
     * AFTER the session is minted, deliberately: this is a cost sweep, and the credential the user is
     * waiting for must not queue behind it. It is best-effort and deadline-bounded, so it can neither
     * fail nor stall the response.
     */
    await enforceRunningVmCap({
      userId: user.id,
      keepSandboxId: sandboxId,
      cap: sandboxMaxRunningVms(context),
      context,
    });

    /*
     * `bootupType` is REPORTED, not swallowed. `CLEAN` means the hibernation snapshot had expired and
     * setup re-ran — the files are template state, and the client must refill them from the working
     * copy rather than assume a resume restored anything. Treating every resume as restorative is how
     * a user gets an empty project with no error.
     */
    return json({ session, sandboxId, bootupType, created: didCreate });
  } catch (error) {
    return errorResponse(error);
  }
}
