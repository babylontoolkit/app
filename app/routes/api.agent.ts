/**
 * The agent proxy entry point (SPEC §3, §4.2).
 *
 * This is the platform's generation route: the client's chat posts here, and the platform key never
 * leaves the server. The visible stream is deliberately PURE TEXT + ACTIONS — the server-side skill
 * tool loop runs inside a single generation and the client sees only latency, never the tool calls
 * (§4.2 step 3).
 */
import { type ActionFunctionArgs } from '@remix-run/cloudflare';
import { describeTurnOutcome } from '~/lib/agent/turn-outcome';
import { createDataStream, formatDataStreamPart, type DataStreamWriter, type Message } from 'ai';
import { createScopedLogger } from '~/utils/logger';
import { runAgentGeneration } from '~/lib/.server/agent/proxy';
import { NotConfiguredError } from '~/lib/.server/agent/config';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { validateAttachments } from '~/lib/.server/agent/attachments';
import { claimProject, shouldClaimProject } from '~/lib/.server/agent/inflight';
import { sanitizeGameBackend } from '~/lib/.server/game-backend/separation';
import { ShellActionStreamFilter } from '~/lib/.server/agent/shell-strip';
import { ProtocolTagStreamFilter } from '~/lib/.server/agent/protocol-strip';
import { typicalDurationMs } from '~/lib/.server/agent/delivery';
import { withGenerationHeartbeat } from '~/lib/.server/agent/heartbeat';
import { NO_REPLAY, PLAN_MODE } from '~/types/message-marks';
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
     * The rung of the MODEL TIER LADDER the user picked (§4.6.1a): `'standard' | 'premium'`.
     *
     * An enum tier ID, never a model string — the server maps it to THAT rung's operator-configured,
     * operator-priced model, which is what keeps §4.2a's "model choice is config, never a user choice"
     * true while still letting a user pick a class. Typed as a plain `string` on purpose: it is an
     * untrusted browser value, and `decideModelTier` narrows it (resolving anything unrecognised DOWN
     * to `standard`) rather than a cast that would let a typo through. Sent by every client, honored
     * only if the user actually holds that rung's threshold — a request, never authorization.
     */
    tier?: string;

    /**
     * @deprecated The pre-ladder boolean (§4.6.1), still accepted as an alias for `tier: 'premium'`.
     *
     * Kept because a browser holding the previous bundle keeps sending it across a deploy, and the
     * failure of dropping it is SILENT: the user's premium preference simply stops being honored and
     * nothing anywhere says so. `tier` wins when both are present.
     */
    premium?: boolean;

    /**
     * The user's chosen base thinking effort for this session (§4.2.9): `'medium'` (the default) or
     * `'high'`. Typed as a plain string here on purpose — it is an untrusted browser value, and the
     * proxy validates it with `parseUserEffort` rather than a cast that would let `max` through.
     */
    effort?: string;

    /**
     * The chat's Discuss toggle (§4.2.9): `'discuss'` asks for a prose-only planning turn — no
     * artifacts, no file writes. Honored via a volatile-tail note, ignored on the creation turn.
     */
    chatMode?: 'discuss' | 'build';

    /**
     * The user's "Use Asset Library" preference (§4.4d, Control Panel → Features, default ON).
     * Only an explicit `false` opts this generation out of the pinned Synty library block —
     * absent means ON, so an older client silently keeps the shipped default.
     */
    useAssetLibrary?: boolean;

    /**
     * The user's "Toolkit systems" preference (§4.4e, Control Panel → Features, default `'auto'`).
     * An unrecognised value — including absent, from an older client — resolves DOWN to `'auto'`,
     * which pushes no block at all. Forwarded RAW: `toolkitSystemsNoteForRequest` owns the parse, so
     * the browser and the server can never disagree about what a value means.
     */
    toolkitSystems?: string;

    /**
     * Which phase of the creation plan this turn is (§4.4e, `~/lib/agent/creation-plan`).
     *
     * Forwarded RAW for the `toolkitSystems` reason: the proxy owns the parse, and
     * `parseCreationPhaseId` resolves an unrecognised value DOWN to "no phase" rather than to a
     * default. That direction matters here because one phase (`art`) carries the media tools, which
     * spend credits — inventing a more capable phase than the caller named is the expensive
     * direction, and it throws nothing.
     *
     * Meaningless on any turn that is not a first build turn; the proxy ignores it there, so a forged
     * value on an ordinary edit buys nothing at all.
     */
    creationPhase?: string;

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
     * One in-flight BUILD generation per project (§4.12). Two build generations against one project
     * interleave their file actions and leave a working tree that is a mix of two different ideas — a
     * corruption the user cannot see and cannot undo. Claimed here, released in `finally` so a Stop, a
     * crash, or a closed tab all free it — and the claim carries THIS request's signal, so a holder
     * that was STOPPED yields to the next send immediately rather than only when its settlement tail
     * finishes.
     *
     * A Plan-mode turn (§4.2.9) takes NO claim and therefore cannot be refused by one: it is read-only
     * by guarantee, so it can neither corrupt the tree nor be corrupted by a build. `shouldClaimProject`
     * owns that rule — see the header of `inflight.ts` for why the scope is the fix.
     */
    releaseProject =
      body.projectId && shouldClaimProject({ projectId: body.projectId, chatMode: body.chatMode })
        ? claimProject(body.projectId, user.id, request.signal)
        : undefined;

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
      tier: body.tier,
      premium: body.premium,
      effort: body.effort,
      chatMode: body.chatMode,
      useAssetLibrary: body.useAssetLibrary,
      toolkitSystems: body.toolkitSystems,
      creationPhase: body.creationPhase,

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
   * WHICH SKILLS THIS TURN IS RUNNING — emitted BEFORE the model writes a token (§4.11).
   *
   * The server already knows: `/slash` invocations are resolved and skills pre-loaded while building
   * the prompt, well before the stream opens. The same list also rides on the `agentMeta` annotation
   * at the end (which is what survives a reload), but that arrives with the token counts — i.e. only
   * once the turn is over, which is the least useful moment to learn what it was doing.
   *
   * A DATA part, exactly like the heartbeat: server→client only, never `text`, so it reaches the
   * model as zero tokens and can never leak into the artifact parser.
   */
  if (generation.toolContext.loaded.size > 0) {
    stream.writeData({
      type: 'skills-loaded',
      generationId: generation.generationId,
      skills: [...generation.toolContext.loaded],
    });
  }

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
    /*
     * Tag it as a plan-mode message (§4.2.9) — distinct from the restore path that ALSO writes
     * NO_REPLAY — so the client can offer "Build & Apply" on a plan turn that proposed a write (and
     * route the turn to the plan parser, whose `_specs/` door is what lets bt-spec/bt-plan write
     * their artifacts). See `PLAN_MODE` in `~/types/message-marks`.
     *
     * 🔴 PLAN_MODE is written BEFORE NO_REPLAY, deliberately. They are separate stream parts, and a
     * client render can commit between them — a frame carrying NO_REPLAY without PLAN_MODE is
     * indistinguishable from a restored build message, and the client's sticky parser routing froze
     * a live plan turn onto the transcript parser off exactly that frame (observed 2026-07-24: the
     * artifact said "Spec written" while the file 404'd). In this order the ambiguous state cannot
     * exist on the wire; the client additionally refuses to freeze a route until text arrives.
     */
    stream.writeMessageAnnotation(PLAN_MODE);
    stream.writeMessageAnnotation(NO_REPLAY);
  }

  const shellFilter = new ShellActionStreamFilter();

  /*
   * Chained AFTER the shell filter, on its pass-through output (§4.2, §5): the shell filter forwards
   * file-action bodies verbatim, and a stray tool-call tag (`</parameter>`) leaks INTO those bodies, so
   * it must be scrubbed from what the shell filter emits — including the file text — before it reaches
   * the client's artifact parser and lands in a source file as a syntax error.
   */
  const protocolFilter = new ProtocolTagStreamFilter();

  const forwardText = (text: string) => {
    const safe = protocolFilter.push(text);

    if (safe.length > 0) {
      stream.write(formatDataStreamPart('text', safe));
    }
  };

  /*
   * Liveness heartbeat (§4.2a). A thinking model's stream is legitimately silent for MINUTES —
   * KIE buffers the whole reasoning window and (measured 2026-07-24) currently returns EVERY
   * model's thinking text empty, so during a long think there is no event to render at all. While
   * the drain is quiet, `withGenerationHeartbeat` writes `agent-status` data parts on a timer:
   * elapsed time + phase, proving the pipe alive end to end. Data channel only — never `text`
   * (artifact parser), never `reasoning` (`g:`), never the model's context. The moment real
   * content streams (including real thinking text, when KIE fixes their adapter), the quiet clock
   * resets and the heartbeat goes silent on its own.
   */
  const heartbeatSource = withGenerationHeartbeat(
    generation.textStream,
    generation.generationId,

    /*
     * The optional retry fields widen the part's index signature to include `undefined`, which
     * `JSONValue` refuses. They are written by conditional spread, so an absent one is a MISSING KEY
     * rather than a present-but-undefined one — the shape on the wire really is JSON-safe.
     */
    (status) => stream.writeData(status as Record<string, string | number>),

    {
      /* What the turn IS, so the panel can say "Building your project" instead of an anonymous "Thinking". */
      kind: generation.statusKind,

      /*
       * And what the user should EXPECT (`agent/delivery.ts`): whether this provider streams at all,
       * and roughly how long a turn of this kind runs. Measured 2026-08-03 — KIE holds the entire
       * answer and flushes it at the end — so on that provider a silent stretch is not a symptom, and
       * the panel is only able to say so because these two facts reach it.
       */
      deliveryMode: generation.deliveryMode,
      typicalMs: typicalDurationMs(generation.statusKind),

      /*
       * And what is happening to the REQUEST — a provider retry reads as a four-minute "Thinking" from
       * out here, because the retry loop lives inside `textStream`. Pulled per tick so the panel can say
       * "the provider stalled, retrying 2 of 3" instead of implying the user is paying to think.
       */
      activity: () => generation.currentActivity(),
    },
  );

  for await (const chunk of heartbeatSource) {
    if (chunk.type === 'text') {
      forwardText(shellFilter.push(chunk.value));
    } else {
      stream.write(formatDataStreamPart(chunk.type, chunk.value));
    }
  }

  // Flush in order: the shell filter's tail is text that still has to pass the protocol scrub.
  forwardText(shellFilter.flush());

  const protocolTail = protocolFilter.flush();

  if (protocolTail.length > 0) {
    stream.write(formatDataStreamPart('text', protocolTail));
  }

  // Surface leaked tool-call tags — invisible otherwise, and a signal the model/provider is misbehaving.
  if (protocolFilter.strippedCount > 0) {
    getMonitor(context).captureMessage(
      `Stripped ${protocolFilter.strippedCount} stray tool-call tag(s) from the output stream`,
      { scope: 'protocol-strip', level: 'warning' },
    );
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

      /*
       * The rung that actually RAN, and why — never the one that was requested (§4.6.1a). A declined
       * Premium turn and a plain Standard turn can run the same model and are very different facts, so a
       * client reading only `model` cannot tell them apart; and once two rungs may name one model, the
       * model string stops identifying a rung at all. This is what makes a Premium turn identifiable
       * in the generation log and lets the composer pill name what was really billed.
       */
      tier: generation.tier,
      tierReason: generation.tierReason,

      skillsLoaded: [...generation.toolContext.loaded],
      blocksLoaded: generation.blocksLoaded,

      /*
       * The re-sent history as it went on the wire (post-compaction) — the client's `/context`
       * report and health dot read this, never a client-side estimate (§4.5.6).
       */
      history: generation.historyStats,

      /*
       * 🔴 HOW THIS TURN ENDED, FOR THE USER (`~/lib/agent/turn-outcome.ts`).
       *
       * Every marker for a truncated build already existed server-side — `finish_reason` carried
       * `length+forced-continuation`, monitoring alerted on the rate, the Admin panel counted it — and
       * the user was still shown `🎮 Your game is ready` on a project cut off mid-file. This is the
       * user-visible half `spec/fail-loud.md`'s reporting corollary always required.
       *
       * It rides on `agentMeta` deliberately: annotations are persisted with the message, so the
       * warning survives a reload. A toast would not, and a build the user walks away from broken is
       * exactly the case that has to still be saying so when they come back.
       */
      outcome: { ...describeTurnOutcome(await generation.outcome) },
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
