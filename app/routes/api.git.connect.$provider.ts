/**
 * Start the OAuth dance for a git provider (SPEC §4.5.4b).
 *
 * `GET /api/git/connect/:provider?returnTo=/chat/abc` → 302 to the provider's consent screen.
 *
 * The user id is baked into a SIGNED `state` here, so the callback never has to trust anything the
 * browser hands it about who is connecting. Without that, an attacker could complete their own OAuth
 * dance and have the resulting token filed against someone else's account — which under §4.5.4b means
 * their repo becomes the "permanent home" of a stranger's project.
 */
import type { LoaderFunctionArgs } from '@remix-run/cloudflare';
import { redirect } from '@remix-run/cloudflare';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { env } from '~/lib/.server/env';
import { buildAuthorizeUrl, getOAuthConfig, safeReturnTo } from '~/lib/.server/git/oauth';
import type { GitProviderId } from '~/lib/.server/git/provider';
import { randomBytes } from 'node:crypto';

function parseProvider(raw: string | undefined): GitProviderId | null {
  return raw === 'github' || raw === 'gitlab' ? raw : null;
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const provider = parseProvider(params.provider);

  if (!provider) {
    throw new Response('Not found', { status: 404 });
  }

  // Saving writes to the user's own account — a verified user, exactly like every other write path.
  const user = await requireVerifiedUser(request, context);
  const config = getOAuthConfig(context, provider);

  if (!config) {
    /*
     * The operator has not set up this provider's OAuth app. A descriptive 503, never a crash and
     * never a redirect to a broken consent screen (§1.3 principle 0).
     */
    throw new Response(`Saving to ${provider === 'github' ? 'GitHub' : 'GitLab'} is not configured on this server.`, {
      status: 503,
    });
  }

  const appUrl = env(context, 'APP_URL') ?? new URL(request.url).origin;
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get('returnTo') ?? undefined);

  const authorizeUrl = buildAuthorizeUrl({
    context,
    provider,
    config,
    appUrl,
    state: {
      userId: user.id,
      provider,
      returnTo,
      issuedAt: Date.now(),
      nonce: randomBytes(8).toString('hex'),
    },
  });

  return redirect(authorizeUrl);
}
