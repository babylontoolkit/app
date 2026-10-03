/**
 * Prompt enhancement (the ✨ button) — upstream bolt.diy's route, on the platform money path.
 *
 * 🔴 ANTHROPIC MANAGED AGENTS ONLY (owner, 2026-10-03, `_specs/anthropic-only_plan.md`). The enhancement
 * runs as a one-shot Managed Agents session (`agent-managed/enhance.ts`); the provider path this route
 * used to drive (`streamText` + the KIE/Comet gateway chain, BYOK cookies) is gone.
 *
 * The walls, in order, before a single token is spent:
 *
 *   1. a VERIFIED session — enhancement costs money, so it is not for anonymous callers (§4.5.1);
 *   2. the input caps — the prompt is echoed into the model, so its length IS the bill;
 *   3. inside `runManagedEnhancement`: the credit gate BEFORE the session exists, a `running` row naming
 *      the session before the first message, the whole session settled once, a failure refunded.
 *
 * The model is the platform's choice (`getEnhancerModel(context, 'Anthropic')`), never the request's.
 *
 * FOUR TERMINAL STATES (`spec/fail-loud.md`): REFUSED BEFORE SPEND (no session, a bad prompt, the gate's
 * 402, "not configured" 503); DELIVERED (text streamed and settled); REFUNDED (an error or a zero-text
 * finish — the stream errors so the browser restores the original prompt). `usePromptEnhancer` calls
 * `refreshSession()` when the stream ends, which puts the settled charge (or its refund) on screen.
 */
import { type ActionFunctionArgs } from '@remix-run/cloudflare';
import { createScopedLogger } from '~/utils/logger';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { runManagedEnhancement } from '~/lib/.server/agent-managed/enhance';

export async function action(args: ActionFunctionArgs) {
  return enhancerAction(args);
}

const logger = createScopedLogger('api.enhancer');

/**
 * The prompt is echoed into the model, so its length IS the bill. The browser sends whatever is in the
 * textarea, but this is a plain HTTP endpoint and `curl` does not run our React code.
 */
const MAX_INPUT_CHARS = 10_000;

async function enhancerAction({ context, request }: ActionFunctionArgs) {
  try {
    // 1. A verified session. Enhancement spends real money on our key.
    const user = await requireVerifiedUser(request, context);

    const { message } = await request.json<{ message: string }>();

    if (typeof message !== 'string' || !message.trim()) {
      throw new Response('Invalid or missing message', { status: 400, statusText: 'Bad Request' });
    }

    if (message.length > MAX_INPUT_CHARS) {
      throw new Response(`Prompt is too long to enhance (max ${MAX_INPUT_CHARS} characters).`, {
        status: 413,
        statusText: 'Payload Too Large',
      });
    }

    /*
     * A one-shot Managed Agents session. Its gate refusal (402) and "not configured" (503) arrive as errors
     * carrying `statusCode`, answered as JSON by the catch below.
     */
    const enhanced = await runManagedEnhancement({ user, message, context });

    return new Response(enhanced.pipeThrough(new TextEncoderStream()), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error: any) {
    // A validation rejection above is already a Response — let it through untouched.
    if (error instanceof Response) {
      throw error;
    }

    /*
     * `requireVerifiedUser` throws UnauthorizedError (401) / ForbiddenError (403), which carry their
     * own status. Reporting those as a 500 would tell a signed-out user the server is broken when in
     * fact it is working exactly as designed.
     */
    if (typeof error?.statusCode === 'number') {
      return new Response(JSON.stringify({ error: true, message: error.message, statusCode: error.statusCode }), {
        status: error.statusCode,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    logger.error(error);

    if (error instanceof Error && error.message?.includes('API key')) {
      throw new Response('Invalid or missing API key', { status: 401, statusText: 'Unauthorized' });
    }

    throw new Response(null, { status: 500, statusText: 'Internal Server Error' });
  }
}
