/**
 * Client error sink (SPEC §5A "error tracking on client and server").
 *
 * The browser posts caught errors here (from the React error boundaries) so they land in the SAME
 * vendor-neutral monitor as server errors — one place to watch, one adapter to configure at the
 * credential pass. The client never talks to a monitoring vendor directly: that would mean a public
 * DSN in the bundle and a vendor commitment baked into client code. The transport choice stays
 * server-side (§5A), exactly like every other platform integration.
 *
 * This is unauthenticated on purpose — a crash can happen before sign-in, and an error report that
 * needs a session is an error report you never get. To keep it from becoming a spam amplifier into our
 * collector, the payload is strictly length-capped here and the whole thing is best-effort: a bad body
 * is dropped, never a 500.
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { getMonitor } from '~/lib/.server/monitoring';

/** Hard caps — a client error report is a few lines, never a payload channel. */
const MAX_MESSAGE = 2000;
const MAX_STACK = 8000;
const MAX_SCOPE = 200;

export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return json({ error: true, message: 'Method not allowed.' }, { status: 405 });
  }

  try {
    const body = await request.json<{
      message?: string;
      stack?: string;
      name?: string;
      scope?: string;
      url?: string;
    }>();

    const message = String(body.message ?? '').slice(0, MAX_MESSAGE);

    // Nothing to report — accept quietly rather than argue with a browser.
    if (!message) {
      return json({ received: true });
    }

    const error = new Error(message);
    error.name = String(body.name ?? 'ClientError').slice(0, 100);
    error.stack = body.stack ? String(body.stack).slice(0, MAX_STACK) : undefined;

    getMonitor(context).captureException(error, {
      scope: `client:${String(body.scope ?? 'unknown').slice(0, MAX_SCOPE)}`,
      tags: { url: String(body.url ?? '').slice(0, 500), origin: 'client' },
    });

    return json({ received: true });
  } catch {
    // A malformed report must not itself become an error. Swallow.
    return json({ received: false });
  }
}
