/**
 * The agent proxy entry point (SPEC §3, §4.2).
 *
 * This is the platform's generation route: the client's chat posts here, and the platform key never
 * leaves the server. The visible stream is deliberately PURE TEXT + ACTIONS — the server-side skill
 * tool loop runs inside a single generation and the client sees only latency, never the tool calls
 * (§4.2 step 3).
 */
import { type ActionFunctionArgs } from '@remix-run/cloudflare';
import { createDataStream, formatDataStreamPart, type DataStreamWriter, type Message } from 'ai';
import { createScopedLogger } from '~/utils/logger';
import { runAgentGeneration } from '~/lib/.server/agent/proxy';
import { NotConfiguredError } from '~/lib/.server/agent/config';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { validateAttachments } from '~/lib/.server/agent/attachments';
import { claimProject } from '~/lib/.server/agent/inflight';
import { sanitizeGameBackend } from '~/lib/.server/game-backend/separation';
import { ShellActionStreamFilter } from '~/lib/.server/agent/shell-strip';
import { NO_REPLAY } from '~/types/message-marks';
import { getMonitor } from '~/lib/.server/monitoring';
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
    projectId?: string;
    errors?: string[];
    repairOf?: string;
    repairAttempt?: number;
    model?: string;

    /**
     * The user opted into the PREMIUM model tier (§4.6.1). A boolean, not a model string: the server
     * maps it to the single configured premium model and honors it only if the credits threshold is met.
     * Sent by every client, ignored unless the user actually holds enough credits — it is a request,
     * never authorization.
     */
    premium?: boolean;

    /**
     * The chat's Discuss toggle (§4.2.9): `'discuss'` asks for a prose-only planning turn — no
     * artifacts, no file writes. Honored via a volatile-tail note, ignored on the creation turn.
     */
    chatMode?: 'discuss' | 'build';

    /**
     * A connected Game Backend (§4.15). The client sends only the PUBLIC facts — connected? which
     * project ref? RLS confirmed? — never the management PAT (that stays in the browser). The proxy
     * turns this into an RLS-first system note; it is never used to reach the user's Supabase from here.
     */
    gameBackend?: { connected: boolean; projectRef?: string; rlsConfirmed?: boolean };

    /** Asset introspection summaries the client attached for referenced assets (§4.9). */
    assetNotes?: string[];

    /**
     * MCP tools actually running in the project's WebContainer (§4.14). The proxy uses them to tell the
     * model what it can call — `inputSchema` is what tells it the arguments; execution stays client-side
     * in the sandbox. All third-party and untrusted: the proxy caps how much of a schema reaches the
     * prompt, and the sandbox's own server is the real validator of any call.
     */
    mcpTools?: Array<{ name: string; description?: string; server: string; inputSchema?: unknown }>;
  }>();

  const cookies = parseCookies(request.headers.get('Cookie'));

  /*
   * BYOK keys ride in a cookie (they are the user's own, client-stored). The proxy ignores them
   * unless PRO_FEATURES_ENABLED and a verified entitlement — never trusted from the client alone.
   */
  const apiKeys: Record<string, string> = JSON.parse(cookies.apiKeys || '{}');
  const providerSettings: Record<string, IProviderSetting> = JSON.parse(cookies.providers || '{}');

  /*
   * Held across the whole STREAM, not just this function — the response returns while generation is
   * still running, so releasing on return would free the project while its files are still being
   * written. Released in the stream's `finally`, or in the catch below if we never got that far.
   */
  let releaseProject: (() => void) | undefined;

  try {
    /*
     * THE TWO WALLS (§4.5.3), in order, before a single token is spent.
     *
     * 1. Session — and VERIFIED, because generation is what costs us money. An unverified account may
     *    open the builder and look around; it may not burn credits (§4.5.1).
     * 2. Ownership — if this generation names a project, the caller must own it. `projectId` arrives
     *    from the client, so without this check it is just a number someone can change in DevTools to
     *    write files into a stranger's game.
     */
    const user = await requireVerifiedUser(request, context);

    if (body.projectId) {
      await requireOwnedProject(user, body.projectId, context);
    }

    /*
     * Attachments (§4.12), BEFORE the credit gate — a rejected upload must never cost the user
     * credits and must never reach the model. The client already limits size and type, but that limit
     * lives in a browser the user controls; this is a plain HTTP endpoint and `curl` does not run our
     * React code. Vision tokens bill through the normal formula, so an unbounded attachment is an
     * unbounded bill on OUR platform key.
     */
    validateAttachments(body.messages, context);

    /*
     * One in-flight generation per project (§4.12). Two generations against one project interleave
     * their file actions and leave a working tree that is a mix of two different ideas — a corruption
     * the user cannot see and cannot undo. Claimed here, released in `finally` so a Stop, a crash, or
     * a closed tab all free it.
     */
    releaseProject = body.projectId ? claimProject(body.projectId, user.id) : undefined;

    const generation = await runAgentGeneration({
      messages: body.messages,
      files: body.files,
      chatId: body.chatId,
      user,
      projectId: body.projectId,

      /*
       * Stop (§4.12). Remix hands us the client's disconnect signal, so closing the stream (the Stop
       * button, or a closed tab) aborts the provider call instead of leaving it running and billing
       * us for output nobody will ever read.
       */
      abortSignal: request.signal,

      errors: body.errors,
      repairOf: body.repairOf,
      repairAttempt: body.repairAttempt,
      model: body.model,
      premium: body.premium,
      chatMode: body.chatMode,

      /*
       * §4.15 hard separation: a client could post OUR platform project ref as its "game backend".
       * Sanitise at the boundary so a claim pointing at the platform Supabase becomes "no backend"
       * rather than an RLS-first note scaffolding game code against our own database.
       */
      gameBackend: sanitizeGameBackend(body.gameBackend, context),
      assetNotes: body.assetNotes,
      mcpLiveTools: body.mcpTools,
      apiKeys,
      providerSettings,
      context,
    });

    const dataStream = createDataStream({
      async execute(stream) {
        try {
          await streamGeneration(stream, generation, context);
        } finally {
          releaseProject?.();
        }
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
    // Never hold a project because the request failed before the stream started.
    releaseProject?.();

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

/** The visible stream: prose + actions, then the annotations the client's badges are built from. */
async function streamGeneration(
  stream: DataStreamWriter,
  generation: Awaited<ReturnType<typeof runAgentGeneration>>,
  context: unknown,
) {
  /*
   * Two channels, and they must NOT be merged.
   *
   * `text` is prose + boltArtifact markup, and the client feeds it straight into the artifact parser —
   * so a sentence of the model's reasoning leaking into `text` mid-`<boltAction>` would be written
   * into the user's file. `reasoning` rides the AI SDK's own reasoning part (`g:`), which `useChat`
   * collects onto `message.reasoning` and never shows the parser.
   *
   * The proxy has already resolved the whole server-side tool loop, so what arrives here is exactly
   * what the user should see.
   *
   * The TEXT channel is passed through the shell-action strip (§4.2.5, §5): a disallowed
   * `<boltAction type="shell">` in the model's output is dropped server-side before it reaches the
   * client — defense-in-depth behind the client executor's allow-list. Reasoning is never filtered.
   */
  /*
   * MCP tool-call relay (§4.14). Subscribe BEFORE draining, so no tool-call the model makes early can be
   * missed. Each call is written to the client as a data part; the client runs it in its WebContainer
   * and POSTs the result to `/api/agent/tool-result`, which unblocks the server-side `execute` that is
   * awaiting it. Execution NEVER happens on platform infrastructure (§5).
   */
  generation.onMcpToolCall((event) => {
    stream.writeData({
      type: 'mcp-tool-call',
      generationId: generation.generationId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,

      // Pins the call to the server that owns the tool — two servers may expose the same tool name.
      server: event.server,
      args: event.args as any,
    });
  });

  /*
   * Media renders the model started (§4.16). Fire-and-forget, unlike the MCP relay: the debit is
   * taken and the KIE task is running — the client's only job is to poll the task route and write
   * the bytes into the WebContainer at `destPath` when the render lands.
   */
  generation.onMediaTask((event) => {
    stream.writeData({
      type: 'media-task',
      taskId: event.taskId,
      projectId: event.projectId,
      destPath: event.destPath,
      kind: event.kind,
      model: event.model,
      credits: event.credits,
    });
  });

  /*
   * Discussion mode's HARD WALL (§4.2.9): mark the message render-only BEFORE any text streams. The
   * client routes NO_REPLAY messages to the transcript parser (renders artifacts, never executes
   * them), so even a disobedient `<boltAction type="file">` displays as a proposal and cannot touch
   * the project. Ordering is the wall — annotate after the text and the parser has already run the
   * actions. The mark rides into IndexedDB with the message, so a reload cannot replay it either.
   */
  if (generation.discussMode) {
    stream.writeMessageAnnotation(NO_REPLAY);
  }

  const shellFilter = new ShellActionStreamFilter();

  for await (const chunk of generation.textStream) {
    if (chunk.type === 'text') {
      const safe = shellFilter.push(chunk.value);

      if (safe.length > 0) {
        stream.write(formatDataStreamPart('text', safe));
      }
    } else {
      stream.write(formatDataStreamPart(chunk.type, chunk.value));
    }
  }

  const tail = shellFilter.flush();

  if (tail.length > 0) {
    stream.write(formatDataStreamPart('text', tail));
  }

  // Surface any disallowed command the model tried — the client already refuses it; this makes it visible.
  if (shellFilter.stripped.length > 0) {
    getMonitor(context).captureMessage(
      `Stripped ${shellFilter.stripped.length} disallowed shell action(s): ` +
        shellFilter.stripped.map((s) => s.command).join(' | '),
      { scope: 'shell-strip', level: 'warning' },
    );
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

  /*
   * Traceability for the client (cost badge, and which doc snapshot produced this answer).
   *
   * `generationId` is here because the SELF-HEALING loop needs it (§4.2.7): if the code we just wrote
   * fails to compile, the client re-POSTs with `repairOf: generationId`, which is what tells the server
   * this is a repair rather than a fresh request — and that in turn is what escalates the effort level
   * and caps the attempts.
   */
  stream.writeMessageAnnotation({
    type: 'agentMeta',
    value: {
      generationId: generation.generationId,
      promptVersionId: generation.promptVersionId,
      model: generation.model,
      skillsLoaded: [...generation.toolContext.loaded],
      blocksLoaded: generation.blocksLoaded,

      /*
       * The re-sent history as it went on the wire (post-compaction) — the client's `/context`
       * report and health dot read this, never a client-side estimate (§4.5.6).
       */
      history: generation.historyStats,
    },
  });

  /*
   * What this generation actually cost the user, and their new balance (§4.6). Sent AFTER the text so
   * the credit badge updates from a settled number, never an estimate.
   */
  const settlement = await generation.settlement;

  stream.writeMessageAnnotation({
    type: 'credits',
    value: {
      creditsCharged: settlement?.creditsCharged ?? 0,
      balanceAfter: settlement?.balanceAfter ?? null,
      notice: generation.notice ?? null,
    },
  });
}
