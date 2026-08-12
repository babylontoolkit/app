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
 *
 * FOUR TERMINAL STATES (`spec/fail-loud.md`): REFUSED BEFORE SPEND — no session, an over-long or
 * missing prompt, or the credit gate (402), all before the model is called. DELIVERED — text streamed
 * and settled. REFUNDED — a stream error or a zero-text finish, refunded and recorded `failed`. There
 * is no CHARGED AS CONSUMED here: the enhancer has no Stop affordance. `usePromptEnhancer` calls
 * `refreshSession()` when the stream ends, which is what puts the settled charge (or its refund) on
 * screen — this route streams bare text and can carry no `credits` annotation of its own.
 */
import { type ActionFunctionArgs } from '@remix-run/cloudflare';
import { streamText } from '~/lib/.server/llm/stream-text';
import { stripIndents } from '~/utils/stripIndent';
import { getApiKeysFromCookie, getProviderSettingsFromCookie } from '~/lib/api/cookies';
import { createScopedLogger } from '~/utils/logger';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { resolveByok } from '~/lib/.server/licensing/entitlements';
import { checkCreditGate, refundGeneration, settleGeneration } from '~/lib/.server/billing/gate';
import { getGenerationStore } from '~/lib/.server/billing/generations';
import { getEnhancerModel, resolvePlatformProvider } from '~/lib/.server/agent/config';
import { accumulateStepUsage, emptyUsage, type UsageStep } from '~/lib/.server/agent/step-usage';
import { familyOf } from '~/lib/modules/llm/model-families';

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

    /*
     * The platform's provider — an operator config, never the request's choice (see the model note
     * below), and since 2026-08-11 the LADDER-RESOLVED one rather than `LLM_PROVIDER`.
     *
     * 🔴 Resolved ONCE and threaded to the model lookup, the wire and `settleGeneration` alike, for
     * the same reason a generation is (SPEC §4.2a): the gateway that spends the tokens must be the one
     * whose rates bill them. Reading it twice is how the enhancer ends up billing gateway A's rates
     * for gateway B's tokens.
     */
    const platformProvider = resolvePlatformProvider(context);

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
     * model selection buys anyone anything — so even a Pro user gets the platform's choice here;
     * their key simply pays for it.
     *
     * And that choice is `ENHANCE_PROMPT_MODEL` when the operator has set one (`getEnhancerModel`).
     * Rewriting ≤10k characters of English is not what the expensive model is for — it reads no
     * project files, calls no tools, and shares no cached prefix with anything — so this is the one
     * paid path in the product where a cheaper model costs the user nothing they can perceive. It
     * still settles through the same gate and the same ledger, at that model's own rates.
     */
    const model = getEnhancerModel(context, platformProvider);
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
     * SETTLE, THEN REFUND IF IT FAILED (§4.6, `spec/fail-loud.md`).
     *
     * The enhancer is a paid KIE-reaching path and must land in the same four terminal states a
     * generation does. It used to reach only two: the gate could refuse before spend, and everything
     * else settled as DELIVERED — a stream that errored halfway, or one that produced no text at all,
     * was logged and charged, with the browser left holding a truncated response and no error. The
     * proxy's `producedText` rule (a clean `stop` with nothing to show is a FAILURE) applies here for
     * exactly the same reason; there is just far less machinery around it.
     *
     * Not awaited — the response has to start flowing to the browser now. Settlement can never refuse
     * and never throws, so nothing downstream depends on it finishing first. The enhancer sends no
     * cache-control, so there are no cache tokens to account for.
     */
    void (async () => {
      let failed = false;
      let producedText = false;

      try {
        for await (const part of result.fullStream) {
          if (part.type === 'error') {
            logger.error(`Enhancement ${generationId} stream error:`, part.error as any);
            failed = true;
            break;
          }

          if (part.type === 'text-delta' && part.textDelta) {
            producedText = true;
          }
        }
      } catch (error) {
        logger.error(`Enhancement ${generationId} stream broke: ${(error as Error)?.message}`);
        failed = true;
      }

      // No text is a failure however cheerfully the provider finished — the user got nothing.
      if (!producedText) {
        failed = true;
      }

      /*
       * 🔴 BILL FROM THE STEPS, exactly as the proxy does — `result.usage` was reporting ZERO INPUT.
       *
       * Observed live 2026-08-11: a real enhancement settled `promptTokens: 0` against 335 output
       * tokens, i.e. the ~600-token system prompt and the user's text were never billed at all. An
       * under-charge, which is `rates.ts`' safe direction and precisely why it could sit here
       * indefinitely without anything failing.
       *
       * `accumulateStepUsage` is the function settlement already trusts for every generation, and
       * using it here buys three things a hand-rolled read cannot: the input tokens, the family-aware
       * cache accounting (`promptTokensIncludeCacheRead`), and one place to fix the next surprise.
       * The old code hardcoded `cacheReadTokens: 0` — true today because the enhancer sends no
       * `cache_control`, and a claim rather than a measurement the moment that changes.
       *
       * ⚠️ Falls back to `result.usage` when there are no steps: settlement can never refuse (§4.6),
       * so a shape this does not recognise must still bill SOMETHING rather than throw away the turn.
       */
      const usage = emptyUsage();

      try {
        const steps = await result.steps;

        if (steps?.length) {
          accumulateStepUsage(usage, steps as unknown as UsageStep[], familyOf(model) ?? undefined);
        } else {
          const combined = await result.usage;
          usage.promptTokens = combined.promptTokens ?? 0;
          usage.completionTokens = combined.completionTokens ?? 0;
          usage.totalTokens = usage.promptTokens + usage.completionTokens;
        }
      } catch (error) {
        logger.error(`Failed to read enhancement usage for ${generationId}: ${(error as Error)?.message}`);
        return;
      }

      const settlement = await settleGeneration({
        userId: user.id,
        generationId,
        model,
        provider,
        usage,

        /*
         * So the credits ledger names this turn instead of the generic "Generation" (§4.6). The
         * display string is `ledger-display.ts`'s to choose — this only says what the turn WAS.
         */
        statusKind: 'enhance',
        byok: byok.allowed,
        context,
      });

      if (!failed) {
        return;
      }

      /*
       * The provider still billed US for whatever a broken enhancement burned; the user gets their
       * credits back and the row says `failed`, so the §4.10 refund audit can see it.
       */
      if (settlement && settlement.creditsCharged > 0) {
        await refundGeneration(
          user.id,
          generationId,
          settlement.creditsCharged,
          'Automatic refund — the prompt enhancement failed',
          context,
        );
      }

      await getGenerationStore(context)
        .upsert({ id: generationId, userId: user.id, model, status: 'failed' })
        .catch(() => undefined);
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
