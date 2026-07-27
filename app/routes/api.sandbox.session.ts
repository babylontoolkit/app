/**
 * Mint a browser session for the caller's sandbox (SPEC §5, §8, `spec/sandbox-codesandbox.md`).
 *
 * This is the doorway that makes a server-backed sandbox usable from client code without the API key
 * ever leaving the server. The browser POSTs here, gets a scoped `SandboxSession`, and hands it to
 * `connectToSandbox`. The key stays in `app/lib/.server/**`.
 *
 * ## The three things this route must never do
 *
 * 1. **Accept a sandbox id from the caller.** A session is a bearer credential for one sandbox — a
 *    caller-supplied id would be a live shell in someone else's project. The id comes from
 *    `registry.ts`, keyed by the VERIFIED user. There is no id on the wire to tamper with.
 * 2. **Create a sandbox when it cannot confirm the old one is gone.** `decideSandboxStart` returns
 *    `refuse` for "could not find out", and this route honours it with a retryable 503 rather than
 *    forking a fresh template over the user's work.
 * 3. **Return anything derived from `CODESANDBOX_API_KEY`.** The session and the preview URL are
 *    scoped, expiring credentials for one sandbox; the key is not in either.
 *
 * ⚠️ `requireVerifiedUser`, not `requireUser`: creating a sandbox spends money, and an unverified
 * address is the shape every free-tier abuse takes (§4.5.4 draws the same line for the signup grant).
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { errorResponse } from '~/lib/.server/http';
import { isSandboxConfigured } from '~/lib/.server/sandbox/config';
import { decideSandboxStart } from '~/lib/.server/sandbox/lifecycle';
import { getSandboxRecord, putSandboxRecord } from '~/lib/.server/sandbox/registry';
import {
  createBrowserSession,
  createSandboxForProject,
  resumeSandbox,
  sandboxExists,
} from '~/lib/.server/sandbox/service';
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

    const body = (await request.json().catch(() => ({}))) as { reset?: boolean };

    const record = await getSandboxRecord(user.id, context);

    /*
     * The existence check is skipped when there is nothing to check — it is a network round trip
     * whose only possible answer would be about an id we do not have.
     */
    const existsAtProvider = record ? await sandboxExists(record.sandboxId, context) : undefined;

    const decision = decideSandboxStart({
      recordedSandboxId: record?.sandboxId,
      existsAtProvider,
      resetRequested: body.reset === true,
    });

    if (decision.action === 'refuse') {
      /*
       * We hold an id and could not confirm anything about it. Creating would abandon a sandbox that
       * is probably fine and replace the user's files with a fresh template; 503 is retryable and
       * touches nothing.
       */
      logger.warn(`Refusing to start a sandbox for ${user.id}: ${decision.reason}`);

      return json(
        { error: 'Could not reach the sandbox provider. Please try again.', retryable: true },
        { status: 503 },
      );
    }

    let sandboxId: string;
    let bootupType: string;

    if (decision.action === 'create') {
      const created = await createSandboxForProject(user.id, context);
      sandboxId = created.sandboxId;
      bootupType = created.bootupType;

      await putSandboxRecord(user.id, { sandboxId, createdAt: new Date().toISOString() }, context);
      logger.info(`Created sandbox ${sandboxId} for ${user.id} (${decision.reason})`);
    } else {
      const resumed = await resumeSandbox(record!.sandboxId, context);
      sandboxId = resumed.sandboxId;
      bootupType = resumed.bootupType;
      logger.info(`Resumed sandbox ${sandboxId} for ${user.id} (${bootupType})`);
    }

    const session = await createBrowserSession(sandboxId, { permission: 'write' }, context);

    /*
     * `bootupType` is REPORTED, not swallowed. `CLEAN` means the hibernation snapshot had expired and
     * setup re-ran — the files are template state, and the client must refill them from the working
     * copy rather than assume a resume restored anything. Treating every resume as restorative is how
     * a user gets an empty project with no error.
     */
    return json({ session, sandboxId, bootupType, created: decision.action === 'create' });
  } catch (error) {
    return errorResponse(error);
  }
}
