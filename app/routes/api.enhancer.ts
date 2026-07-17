/**
 * Prompt enhancement (upstream bolt.diy's route, brought onto the platform money path).
 *
 * This is a REAL LLM call on the PLATFORM key, and until it was gated it had no session check, no
 * credit gate, and no settlement — an unauthenticated `curl` loop against our own Anthropic key,
 * billed to us. Worse, the model and provider were read straight out of the request body (upstream
 * puts them in a `[Model: ...]` prefix that `streamText` parses), so a caller could simply ask for the
 * most expensive model on the market and we would pay for it.
 *
 * So it now goes through the same three steps as a generation (§4.2, §4.5.4, §4.6):
 *
 *   1. a VERIFIED session — enhancement costs money, so it is not for anonymous callers (§4.5.1);
 *   2. the credit gate, once, before the model is called;
 *   3. settlement afterwards, against the tokens actually spent.
 *
 * And the model is the platform's choice, not the caller's, unless a server-verified Pro entitlement
 * says the user is paying with their own key (§4.6.1).
 */
import { type ActionFunctionArgs } from '@remix-run/cloudflare';
import { streamText } from '~/lib/.server/llm/stream-text';
import { stripIndents } from '~/utils/stripIndent';
import { getApiKeysFromCookie, getProviderSettingsFromCookie } from '~/lib/api/cookies';
import { createScopedLogger } from '~/utils/logger';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { resolveByok } from '~/lib/.server/licensing/entitlements';
import { checkCreditGate, settleGeneration } from '~/lib/.server/billing/gate';
import { getPlatformModel, getPlatformProvider } from '~/lib/.server/agent/config';

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

    const cookieHeader = request.headers.get('Cookie');
    const apiKeys = getApiKeysFromCookie(cookieHeader);
    const providerSettings = getProviderSettingsFromCookie(cookieHeader);

    // The platform's provider — an operator config, never the request's choice (see the model note below).
    const platformProvider = getPlatformProvider(context);

    /*
     * 2. BYOK is decided by the SERVER, never by the request. Without a verified active Pro
     * entitlement the caller's key is ignored and the platform pays — which is exactly why the model
     * below must not be the caller's choice either.
     */
    const byok = await resolveByok({
      userId: user.id,
      email: user.email,
      isLocal: user.isLocal,
      hasKey: Boolean(apiKeys?.[platformProvider]),
      context,
    });

    // 3. The credit gate — the one moment we may refuse.
    const gate = await checkCreditGate({ userId: user.id, byok: byok.allowed, context });

    if (!gate.allowed) {
      return new Response(JSON.stringify({ error: true, message: gate.message, statusCode: 402 }), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    /*
     * The model is OURS to choose, for everyone. `streamText` parses the `[Model:]`/`[Provider:]`
     * prefix below to pick a provider, so writing the platform's model into it is what takes the
     * choice away from the request body. Enhancement is a small fixed utility, not a place where
     * model selection buys anyone anything — so even a Pro user gets the platform model here; their
     * key simply pays for it.
     */
    const model = getPlatformModel(context);
    const provider = platformProvider;

    const generationId = `gen_enh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const result = await streamText({
      messages: [
        {
          role: 'user',
          content:
            `[Model: ${model}]\n\n[Provider: ${provider}]\n\n` +
            stripIndents`
            You are a professional prompt engineer specializing in crafting precise, effective prompts.
            Your task is to enhance prompts by making them more specific, actionable, and effective.

            I want you to improve the user prompt that is wrapped in \`<original_prompt>\` tags.

            For valid prompts:
            - Make instructions explicit and unambiguous
            - Add relevant context and constraints
            - Remove redundant information
            - Maintain the core intent
            - Ensure the prompt is self-contained
            - Use professional language

            For invalid or unclear prompts:
            - Respond with clear, professional guidance
            - Keep responses concise and actionable
            - Maintain a helpful, constructive tone
            - Focus on what the user should provide
            - Use a standard template for consistency

            IMPORTANT: Your response must ONLY contain the enhanced prompt text.
            Do not include any explanations, metadata, or wrapper tags.

            <original_prompt>
              ${message}
            </original_prompt>
          `,
        },
      ],
      env: context.cloudflare?.env as any,

      // Only a BYOK user's keys are honored; otherwise the platform key comes from the server env.
      apiKeys: byok.allowed ? apiKeys : {},
      providerSettings: byok.allowed ? providerSettings : {},
      options: {
        system:
          'You are a senior software principal architect, you should help the user analyse the user query and enrich it with the necessary context and constraints to make it more specific, actionable, and effective. You should also ensure that the prompt is self-contained and uses professional language. Your response should ONLY contain the enhanced prompt text. Do not include any explanations, metadata, or wrapper tags.',
      },
    });

    /*
     * SETTLEMENT (§4.6). `usage` resolves once the stream is drained, which is why this is not awaited
     * here — the response has to start flowing to the browser now. Settlement can never refuse and
     * never throws, so nothing downstream depends on it finishing first.
     *
     * The enhancer sends no cache-control, so there are no cache tokens to account for.
     */
    result.usage
      .then((usage) =>
        settleGeneration({
          userId: user.id,
          generationId,
          model,
          provider,
          usage: {
            promptTokens: usage.promptTokens ?? 0,
            completionTokens: usage.completionTokens ?? 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
          byok: byok.allowed,
          context,
        }),
      )
      .catch((error) => logger.error(`Failed to settle enhancement ${generationId}: ${error?.message}`));

    // Handle streaming errors in a non-blocking way
    (async () => {
      try {
        for await (const part of result.fullStream) {
          if (part.type === 'error') {
            const error: any = part.error;
            logger.error('Streaming error:', error);

            break;
          }
        }
      } catch (error) {
        logger.error('Error processing stream:', error);
      }
    })();

    // Return the text stream directly since it's already text data
    return new Response(result.textStream, {
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
