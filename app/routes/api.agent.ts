/**
 * The agent proxy entry point (SPEC §3, §4.2).
 *
 * This is the platform's generation route: the client's chat posts here, and the platform key never
 * leaves the server. The visible stream is deliberately PURE TEXT + ACTIONS — the server-side skill
 * tool loop runs inside a single generation and the client sees only latency, never the tool calls
 * (§4.2 step 3).
 */
import { type ActionFunctionArgs } from '@remix-run/cloudflare';
import { createDataStream, formatDataStreamPart, type Message } from 'ai';
import { createScopedLogger } from '~/utils/logger';
import { runAgentGeneration } from '~/lib/.server/agent/proxy';
import { NotConfiguredError } from '~/lib/.server/agent/config';
import type { FileMap } from '~/lib/.server/llm/constants';
import type { IProviderSetting } from '~/types/model';

const logger = createScopedLogger('api.agent');

export async function action(args: ActionFunctionArgs) {
  return agentAction(args);
}

function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};

  for (const item of (header || '').split(';')) {
    const [name, ...rest] = item.trim().split('=');

    if (name && rest.length) {
      cookies[decodeURIComponent(name.trim())] = decodeURIComponent(rest.join('=').trim());
    }
  }

  return cookies;
}

async function agentAction({ context, request }: ActionFunctionArgs) {
  const body = await request.json<{
    messages: Message[];
    files?: FileMap;
    chatId?: string;
    errors?: string[];
    repairOf?: string;
    repairAttempt?: number;
    model?: string;
  }>();

  const cookies = parseCookies(request.headers.get('Cookie'));

  /*
   * BYOK keys ride in a cookie (they are the user's own, client-stored). The proxy ignores them
   * unless PRO_FEATURES_ENABLED and a verified entitlement — never trusted from the client alone.
   */
  const apiKeys: Record<string, string> = JSON.parse(cookies.apiKeys || '{}');
  const providerSettings: Record<string, IProviderSetting> = JSON.parse(cookies.providers || '{}');

  try {
    const generation = await runAgentGeneration({
      messages: body.messages,
      files: body.files,
      chatId: body.chatId,
      errors: body.errors,
      repairOf: body.repairOf,
      repairAttempt: body.repairAttempt,
      model: body.model,
      apiKeys,
      providerSettings,
      context,
    });

    const dataStream = createDataStream({
      async execute(stream) {
        /*
         * TEXT ONLY. The proxy's generator has already resolved the whole server-side tool loop —
         * including the forced continuation when the tool-round cap is hit — so what arrives here is
         * exactly what the user should see: prose + boltArtifact markup, and nothing else.
         */
        for await (const delta of generation.textStream) {
          stream.write(formatDataStreamPart('text', delta));
        }

        const usage = await generation.usage;

        stream.writeMessageAnnotation({
          type: 'usage',
          value: {
            completionTokens: usage.completionTokens,
            promptTokens: usage.promptTokens,
            totalTokens: usage.totalTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheCreationTokens: usage.cacheCreationTokens,
          },
        });

        // Traceability for the client (cost badge, and which doc snapshot produced this answer).
        stream.writeMessageAnnotation({
          type: 'agentMeta',
          value: {
            promptVersionId: generation.promptVersionId,
            model: generation.model,
            skillsLoaded: [...generation.toolContext.loaded],
            blocksLoaded: generation.blocksLoaded,
          },
        });
      },
      onError: (error: any) => `Custom error: ${error?.message || 'Unknown error'}`,
    });

    return new Response(dataStream.pipeThrough(new TextEncoderStream()), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache',
        'Text-Encoding': 'chunked',
      },
    });
  } catch (error: any) {
    logger.error(error);

    // "Not configured" is a first-class, describable state — never a crash, never a silent fallback.
    if (error instanceof NotConfiguredError) {
      return new Response(
        JSON.stringify({ error: true, message: error.message, statusCode: 503, isRetryable: false }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({
        error: true,
        message: error?.message || 'An unexpected error occurred',
        statusCode: error?.statusCode || 500,
        isRetryable: error?.isRetryable !== false,
      }),
      { status: error?.statusCode || 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
