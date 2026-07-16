/**
 * Which git providers this user has connected, and which the server can offer (SPEC §4.5.4b, §5).
 *
 *   GET /api/git/connections → { configured: ['github'], connections: [{ provider, providerLogin, connectedAt }] }
 *
 * **Never returns a token.** §5: a route may act on a secret, never emit one — and "is it connected?"
 * is answerable as a boolean plus a display name, exactly as `/api/check-env-key` answers "is a key
 * configured?" without the value. `listConnections` maps to a summary type that has no token field, so
 * this cannot regress by someone widening a `select('*')`.
 *
 * `configured` is what the OPERATOR set up; `connections` is what the USER linked. The UI needs both:
 * with neither provider configured, Save cannot work at all and says so ("not configured"), which is a
 * different message from "you have not connected yet".
 */
import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireUser } from '~/lib/.server/supabase/auth';
import { configuredProviders } from '~/lib/.server/git/oauth';
import { listConnections } from '~/lib/.server/git/resolve';
import { errorResponse } from '~/lib/.server/http';

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    const user = await requireUser(request, context);

    return json({
      configured: configuredProviders(context),
      connections: await listConnections(context, user.id),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
