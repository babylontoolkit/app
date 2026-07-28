/**
 * Mint preview access for a port on a PROJECT's sandbox (SPEC §4.5.3, §5, §8,
 * `spec/sandbox-codesandbox.md` §6).
 *
 * A CodeSandbox project sandbox is created `privacy: 'private'`, so its preview host answers 401 to
 * anyone without a token (MEASURED — and that privacy is the point). The `<iframe src>` cannot set a
 * header, so the query-param token form is the one that makes the preview renderable at all: this
 * route turns "the dev server opened port N" into a URL the workbench can actually show.
 *
 * Same non-negotiables as `api.sandbox.session.ts`:
 *
 * 1. **No sandbox id from the caller** — the caller names a PROJECT, `requireOwnedProject` proves they
 *    own it (404, never 403), and the sandbox id is read off the row. A caller-supplied sandbox id
 *    would mint read access to someone else's running game.
 * 2. **Nothing derived from `CODESANDBOX_API_KEY` in the response** — the token is a scoped, expiring
 *    credential for one sandbox's preview, minted server-side.
 * 3. `requireVerifiedUser`, because minting resumes the sandbox's billing clock server-side.
 */
import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { errorResponse } from '~/lib/.server/http';
import { isSandboxConfigured } from '~/lib/.server/sandbox/config';
import { createPreviewAccess } from '~/lib/.server/sandbox/service';

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    const user = await requireVerifiedUser(request, context);

    if (!isSandboxConfigured(context)) {
      return json({ error: 'Sandbox provider is not configured.', configured: false }, { status: 503 });
    }

    const url = new URL(request.url);
    const port = Number(url.searchParams.get('port'));

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return json({ error: 'Invalid port.' }, { status: 400 });
    }

    const projectId = (url.searchParams.get('projectId') ?? '').trim();

    if (!projectId) {
      return json({ error: 'A projectId is required to mint a preview.' }, { status: 400 });
    }

    const project = await requireOwnedProject(user, projectId, context);

    if (!project.sandboxId) {
      /*
       * 404, not 403 — the same enumeration posture as `requireOwnedProject`, though here there is
       * nothing to enumerate: the project simply has no VM yet, so there is no preview to grant.
       */
      return json({ error: 'No sandbox for this project yet.' }, { status: 404 });
    }

    const access = await createPreviewAccess(project.sandboxId, port, context);

    return json({ url: access.url, expiresAt: access.expiresAt });
  } catch (error) {
    return errorResponse(error);
  }
}
