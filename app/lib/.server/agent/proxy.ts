/**
 * The server agent proxy (SPEC §3, §4.2).
 *
 * Every platform-credit generation goes through here. LLM calls NEVER leave the browser directly:
 * the platform key must not reach the client, and the server is where the credit gate, the synced
 * prompt version, prompt-cache breakpoints, the skill tool loop, and usage recording all happen.
 *
 * Agent architecture stance (deliberate — do not re-architect, §4.2): ONE agent, a server-side tool
 * loop, and self-healing repair turns. No orchestrator, no subagents in the core loop.
 */
import {
  convertToCoreMessages,
  streamText as _streamText,
  type CoreMessage,
  type Message,
  type StreamTextResult,
} from 'ai';
import { createScopedLogger } from '~/utils/logger';
import { getActivePrompt } from '~/lib/.server/prompt/active';
import { getPromptStore } from '~/lib/.server/prompt/store';
import { selectOnDemandBlocks } from '~/lib/.server/prompt/sources';
import { getSkillStore } from '~/lib/.server/skills/store';
import { parseSlashInvocation } from '~/lib/skills/slash';
import { createFilesContext } from '~/lib/.server/llm/utils';
import type { FileMap } from '~/lib/.server/llm/constants';
import { PROVIDER_LIST } from '~/utils/constants';
import type { IProviderSetting } from '~/types/model';
import type { AuthUser } from '~/lib/.server/supabase/auth';
import { resolveByok } from '~/lib/.server/licensing/entitlements';
import { checkCreditGate, refundGeneration, settleGeneration } from '~/lib/.server/billing/gate';
import { getPlatformConfig, NotConfiguredError, PLATFORM_MODEL, PLATFORM_PROVIDER, requirePlatformKey } from './config';
import { createSkillTools, MAX_TOOL_ROUNDS, type SkillToolContext } from './tools';
import { getGenerationLog, type GenerationRecord } from './usage';
import { accumulateStepUsage, emptyUsage, type GenerationUsage, type UsageStep } from './step-usage';

const logger = createScopedLogger('agent-proxy');

/** Self-healing cap per generation (§4.2.7). Beyond this the agent is thrashing, not fixing. */
export const MAX_REPAIR_TURNS = 2;

/**
 * Prompt-cache breakpoints (SPEC §4.2.8). Anthropic permits four; we spend all four — the base
 * prompt, the routed doc blocks, an invoked skill, and the project files. There are none spare.
 *
 * **The TTL is the whole point.** The default `ephemeral` tier expires after 5 MINUTES, and an app
 * builder is exactly the workload that defeats it: the user generates a game, then spends several
 * minutes actually PLAYING it before asking for a change. By then the prefix is cold, and the next
 * turn re-writes all ~111k tokens at full price. That is not paying for a cache — it is paying to
 * keep creating one, on every turn, forever.
 *
 * The 1h tier costs 2x to write instead of 1.25x, and reads stay at 0.1x. It therefore breaks even
 * on the SECOND cached turn and wins on every turn after — which, for a session where a human stops
 * to look at what we built, is every session. Measured over ten turns: ~$4.16 of cache writes at 5m
 * vs ~$0.97 at 1h.
 *
 * Verified against the live API (2026-07): `ttl` needs no beta header (the extended TTL is GA), the
 * SDK passes `cacheControl` through verbatim, and an entry written this way is still a cache READ
 * seven minutes later — i.e. it is genuinely 1h and not a silent fall back to the 5m tier.
 */
const CACHE_CONTROL = { anthropic: { cacheControl: { type: 'ephemeral' as const, ttl: '1h' as const } } };

export interface AgentRequest {
  messages: Message[];
  files?: FileMap;
  chatId?: string;

  /**
   * The authenticated user. Resolved by the ROUTE, never by the client (§4.5.3) — the ledger is keyed
   * on this id, so a client-supplied one would let anyone spend anyone else's credits.
   */
  user: AuthUser;

  /** The project this generation belongs to. Ownership is proven by the route before we get here. */
  projectId?: string;

  /**
   * Stop (§4.12). Aborting stops the stream but NOT the settlement: the tokens consumed up to the
   * abort point were really spent, and the ledger records what happened, never the estimate.
   */
  abortSignal?: AbortSignal;

  /** Remix loader/action context — the only source of server env in a Cloudflare-shaped runtime. */
  context?: unknown;

  /** Vite compile errors observed after the last apply. Their presence makes this a repair turn. */
  errors?: string[];

  /** The generation being repaired, and which attempt this is (1-based). */
  repairOf?: string;
  repairAttempt?: number;

  /** BYOK — honored ONLY with Pro features enabled (§4.6.1). Ignored entirely otherwise. */
  apiKeys?: Record<string, string>;
  providerSettings?: Record<string, IProviderSetting>;
  model?: string;
}

/** The skill tool set, as `streamText` sees it — keeps the result's tool types concrete. */
type SkillTools = ReturnType<typeof createSkillTools>;

export interface AgentGeneration {
  /**
   * The visible output: text only. The server-side tool loop — including a forced continuation when
   * the tool-round cap is hit — is resolved inside this generator, so the client sees pure text.
   */
  textStream: AsyncGenerator<string>;
  promptVersionId: string;
  model: string;
  blocksLoaded: string[];

  /** Skills loaded during this generation — mutated by the tool loop as it runs. */
  toolContext: SkillToolContext;

  /** Resolves once the stream is fully drained. */
  usage: Promise<GenerationUsage>;

  /** Resolves with what we charged, once settled. Drives the client's credit badge (§4.6). */
  settlement: Promise<{ creditsCharged: number; balanceAfter: number } | null>;

  /** e.g. "your Pro subscription lapsed, so this build used credits" (§4.6.1). Never an error. */
  notice?: string;
}

/** Re-exported so callers keep importing it from the proxy; the math lives in `step-usage`. */
export type { GenerationUsage } from './step-usage';

function lastUserText(messages: Message[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user');

  return typeof last?.content === 'string' ? last.content : '';
}

/**
 * Resolve an explicit `/skill-name <task>` invocation.
 *
 * The user asked for this skill by name, so it is FORCE-LOADED — no description matching, no
 * `load_skill` round trip. The skill body is injected as its own cached system block and the user's
 * message becomes the task, exactly as it behaves in Claude Code.
 */
async function resolveSlashInvocation(
  messages: Message[],
): Promise<{ skillBlock: string; skillName: string; messages: Message[] } | null> {
  const index = messages.map((m) => m.role).lastIndexOf('user');

  if (index === -1) {
    return null;
  }

  const message = messages[index];
  const text = typeof message.content === 'string' ? message.content : '';
  const invocation = parseSlashInvocation(text);

  if (!invocation) {
    return null;
  }

  const skill = await getSkillStore().getActive(invocation.name);

  if (!skill) {
    // Not a known skill — treat it as ordinary prose rather than swallowing the user's message.
    logger.warn(`Slash invocation for unknown skill "${invocation.name}" — passing through as text`);
    return null;
  }

  const resources = skill.resourcePaths.length
    ? `\n\nBundled resources (read with read_skill_resource):\n${skill.resourcePaths.map((p) => `- ${p}`).join('\n')}`
    : '';

  const skillBlock = [
    `# Invoked Skill: ${skill.name}`,
    '',
    'The user invoked this skill explicitly. Follow its instructions for this request.',
    'It is already loaded — do not call `load_skill` for it.',
    '',
    skill.body,
    resources,
  ].join('\n');

  // The args become the task. An empty invocation still runs the skill, with no specific task.
  const task = invocation.args
    ? invocation.args
    : `Run the ${skill.name} skill. The user provided no additional input.`;

  const rewritten = [...messages];
  rewritten[index] = { ...message, content: task };

  return { skillBlock, skillName: skill.name, messages: rewritten };
}

/** Format compile errors into the repair turn the model sees (§4.2.7). */
export function buildRepairMessage(errors: string[]): string {
  return [
    'The changes you just made produced build errors. Fix these errors and nothing else —',
    'do not add features or refactor unrelated code.',
    '',
    '```',
    errors.join('\n').slice(0, 8000),
    '```',
  ].join('\n');
}

export async function runAgentGeneration(request: AgentRequest): Promise<AgentGeneration> {
  const config = getPlatformConfig(request.context);
  const user = request.user;

  /*
   * 1. BYOK — decided by the SERVER, from a verified Pro entitlement (§4.6.1).
   *
   * A client can send an API key and claim anything it likes. `resolveByok` is what decides, and it
   * reads our own entitlement store: PRO_FEATURES_ENABLED must be on AND the license service must
   * have confirmed an active subscription (or this is local dev). A lapsed subscriber silently falls
   * back to credits with a friendly notice — never an error, never a blocked build.
   */
  const byok = await resolveByok({
    userId: user.id,
    email: user.email,
    isLocal: user.isLocal,
    hasKey: Boolean(request.apiKeys?.[PLATFORM_PROVIDER]),
    context: request.context,
  });

  /*
   * 2. Credit gate — once, up front, and only for platform-paid generations. In-flight generations
   * are never killed for balance (§4.2.1), so this is the ONE moment we may refuse.
   */
  const gate = await checkCreditGate({ userId: user.id, byok: byok.allowed, context: request.context });

  if (!gate.allowed) {
    const error = new Error(gate.message) as Error & { statusCode: number; isRetryable: boolean };
    error.statusCode = 402;
    error.isRetryable = false;

    throw error;
  }

  /*
   * 3. Model + key. Credits mode is the default: the platform key, a FIXED model, no choices to make.
   * A client-supplied model is honored ONLY under a verified BYOK — otherwise it is ignored outright
   * rather than trusted, because model choice is a config property, never a user input (§4.2a).
   */
  const useByok = byok.allowed;
  const model = useByok && request.model ? request.model : PLATFORM_MODEL;

  if (!useByok) {
    requirePlatformKey(config);
  }

  const provider = PROVIDER_LIST.find((p) => p.name === PLATFORM_PROVIDER);

  if (!provider) {
    throw new NotConfiguredError(`The ${PLATFORM_PROVIDER} provider`, 'It is missing from the provider registry.');
  }

  // 4. The active prompt version — from OUR store. Zero GitHub dependency at generation time (§4.3.2).
  const activePrompt = await getActivePrompt();

  if (!activePrompt) {
    throw new NotConfiguredError(
      'The system prompt',
      'No prompt version is active. Run a doc-sync: POST /api/admin/prompt/refresh.',
    );
  }

  // Bound to a const so the null-check narrowing survives into the async generator below.
  const promptVersion = activePrompt;

  // 5. Explicit slash invocation force-loads its skill.
  const slash = await resolveSlashInvocation(request.messages);
  let messages = slash ? slash.messages : request.messages;

  // 6. Repair turn: append the compiler output as the task.
  const isRepair = Boolean(request.errors?.length);

  if (isRepair && (request.repairAttempt ?? 1) <= MAX_REPAIR_TURNS) {
    messages = [
      ...messages,
      { id: `repair-${Date.now()}`, role: 'user', content: buildRepairMessage(request.errors!) } as Message,
    ];
  }

  /*
   * 7. Route the on-demand doc blocks. Keyed off the user's request AND any invoked skill body, so
   * that `/bt-spec build a racing game` pulls in the RacingSystem docs even though the word "racing"
   * only appears in the task.
   */
  const routingText = `${lastUserText(messages)}\n${slash?.skillBlock ?? ''}`;
  const store = getPromptStore();
  const blocks: Array<{ id: string; title: string; body: string }> = [];

  for (const block of selectOnDemandBlocks(routingText)) {
    const body = await store.readOnDemand(promptVersion.id, block.id);

    if (body) {
      blocks.push({ id: block.id, title: block.title, body });
    }
  }

  /*
   * 8. Assemble system blocks, most-stable first.
   *
   * Anthropic caches the prefix UP TO each breakpoint, so ordering is what makes caching pay: the
   * base prompt (the big, byte-identical chunk) leads and gets its own breakpoint; the routed blocks
   * and any invoked skill follow with theirs; volatile project context comes LAST with no breakpoint,
   * so a file edit never invalidates the expensive prefix. This is a primary margin lever (§4.3.5).
   */
  const system: CoreMessage[] = [{ role: 'system', content: promptVersion.content, providerOptions: CACHE_CONTROL }];

  blocks.forEach((block, i) => {
    system.push({
      role: 'system',
      content: `# Component Reference: ${block.title}\n\n${block.body}`,

      // One breakpoint for the whole routed set — spend cache breakpoints sparingly.
      ...(i === blocks.length - 1 ? { providerOptions: CACHE_CONTROL } : {}),
    });
  });

  if (slash) {
    system.push({ role: 'system', content: slash.skillBlock, providerOptions: CACHE_CONTROL });
  }

  if (request.files && Object.keys(request.files).length > 0) {
    /*
     * Binaries and opaque files arrive here as `<boltFile>` markers — never bodies (§4.2.8).
     *
     * This block IS cached, and that is not a contradiction of the ordering above. A breakpoint
     * caches the prefix UP TO itself, so the base prompt and the routed blocks keep their own cache
     * entries regardless: if a file changes next turn, only THIS entry misses and the expensive
     * prefix still hits. What the breakpoint buys is the multiplier — `maxSteps` re-sends the entire
     * prefix on every step of the tool loop, so an uncached file context is paid up to seven times
     * per generation at full price. Cached, steps 2..n read it at a tenth. It was the single largest
     * line item in the 997k-token creation we measured (§4.2.8).
     */
    system.push({
      role: 'system',
      content: `# Current Project Files\n\n${createFilesContext(request.files, true)}`,
      providerOptions: CACHE_CONTROL,
    });
  }

  // 9. The tool loop runs entirely server-side; the client stream stays pure text + actions.
  const toolContext: SkillToolContext = { loaded: new Set(slash ? [slash.skillName] : []) };
  const tools = createSkillTools(toolContext);

  const modelInstance = provider.getModelInstance({
    model,
    serverEnv: (request.context as { cloudflare?: { env?: Env } })?.cloudflare?.env as Env,
    apiKeys: useByok ? request.apiKeys : undefined,
    providerSettings: useByok ? request.providerSettings : undefined,
  });

  logger.info(
    `Generation: model=${model} prompt=${promptVersion.id} blocks=[${blocks.map((b) => b.id).join(',')}] ` +
      `${slash ? `slash=/${slash.skillName} ` : ''}${isRepair ? `repair(${request.repairAttempt ?? 1}) ` : ''}` +
      `mode=${useByok ? 'byok' : 'platform'}`,
  );

  const coreMessages = convertToCoreMessages(messages as any);

  const totals: GenerationUsage = emptyUsage();
  let toolRounds = 0;
  let finishReason = 'unknown';

  /*
   * Where the wall-clock actually goes (§4.2).
   *
   * A generation feels slow for one of two very different reasons, and they have opposite fixes:
   * SEQUENTIAL TOOL ROUNDS (each one re-prefills the whole prompt before the model can ask for the
   * next thing) or DECODE (output tokens come out one at a time, ~60-90/s, and no amount of caching
   * touches that). Guessing which is which is how you optimise the wrong one, so every step reports
   * its own duration, tool calls, and output tokens.
   */
  const startedAt = Date.now();
  let stepClock = startedAt;
  let stepIndex = 0;
  const stepLog: NonNullable<GenerationRecord['steps']> = [];

  const startStream = (history: CoreMessage[], allowTools: boolean) =>
    _streamText({
      model: modelInstance,
      messages: history,
      maxTokens: 64_000,
      tools,

      onStepFinish: (step) => {
        const now = Date.now();
        const ms = now - stepClock;
        stepClock = now;

        const tools = step.toolCalls?.map((c) => c.toolName) ?? [];
        const out = step.usage?.completionTokens ?? 0;
        const meta = step.providerMetadata?.anthropic as
          | { cacheReadInputTokens?: number; cacheCreationInputTokens?: number }
          | undefined;

        stepLog.push({
          ms,
          outTokens: out,
          inTokens: step.usage?.promptTokens ?? 0,
          cacheRead: meta?.cacheReadInputTokens ?? 0,
          cacheWrite: meta?.cacheCreationInputTokens ?? 0,
          tools,
        });

        logger.info(
          `  step ${++stepIndex}: ${ms}ms · ${out} out · ` +
            `${step.usage?.promptTokens ?? 0} in (+${meta?.cacheReadInputTokens ?? 0} cached, ` +
            `${meta?.cacheCreationInputTokens ?? 0} written)` +
            `${tools.length ? ` · tools: ${tools.join(', ')}` : ' · ANSWER'}`,
        );
      },

      /*
       * Stop (§4.12). The signal aborts the provider request, so we stop paying for tokens the moment
       * the user says stop — but the tokens already generated are still billed, in the `finally` below.
       */
      abortSignal: request.abortSignal,

      /*
       * `toolChoice: 'none'` still passes the tool DEFINITIONS (Anthropic requires them whenever the
       * history contains tool_use blocks) while forbidding new calls — that is what forces an answer.
       */
      toolChoice: allowTools ? 'auto' : 'none',

      /*
       * +1 for the ANSWER step. `maxSteps` counts every LLM round trip, tool calls included, so
       * handing it the raw tool cap leaves no step in which to actually reply.
       */
      maxSteps: allowTools ? MAX_TOOL_ROUNDS + 1 : 1,
    });

  /**
   * Drain one streamText result, forwarding text and accumulating usage.
   *
   * Anthropic reports cached input separately from `input_tokens`, and `@ai-sdk/anthropic` maps only
   * the UNCACHED count into `promptTokens`. So a well-cached generation looks nearly free here (we
   * measured 65,199 prompt tokens cold vs 3,996 warm for the same 143KB prefix). Billing has to see
   * the cache columns too, or it will systematically under-count input.
   */
  async function* drain(result: StreamTextResult<SkillTools, never>): AsyncGenerator<string> {
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        yield part.textDelta;
      } else if (part.type === 'error') {
        throw part.error;
      }
    }

    /*
     * Bill from `steps`, NOT from `result.usage` + `result.providerMetadata`.
     *
     * Those two have different scopes: `usage` is combined across every step, while
     * `providerMetadata` is — per its own JSDoc — "from the LAST step". Anthropic reports cache
     * reads/writes ONLY in provider metadata, so the obvious pairing bills six rounds of input
     * against one round of cache. `steps` is the only surface where both are per-step (§4.6).
     */
    const steps = await result.steps;
    accumulateStepUsage(totals, steps as unknown as UsageStep[]);

    finishReason = await result.finishReason;
    toolRounds += Math.max(0, (steps?.length ?? 1) - 1);
  }

  let resolveUsage: (usage: GenerationUsage) => void;
  const usagePromise = new Promise<GenerationUsage>((resolve) => {
    resolveUsage = resolve;
  });

  let resolveSettlement: (settlement: { creditsCharged: number; balanceAfter: number } | null) => void;
  const settlementPromise = new Promise<{ creditsCharged: number; balanceAfter: number } | null>((resolve) => {
    resolveSettlement = resolve;
  });

  /**
   * Did this generation HARD-FAIL?
   *
   * Not the same as "was stopped". A stop is a user decision and the tokens it burned are genuinely
   * owed (§4.12). A hard failure is the provider erroring out or the stream breaking — the user asked
   * for a game and got nothing — and §4.6 is explicit that those auto-refund.
   */
  let failed = false;

  async function* run(): AsyncGenerator<string> {
    try {
      const first = startStream([...system, ...coreMessages], true);
      yield* drain(first);

      /*
       * "On cap, proceed with what's loaded" (spec/skills.md) — the half that is easy to forget.
       *
       * `finishReason === 'tool-calls'` means the loop stopped because it ran out of STEPS, not
       * because the model was done: its last act was a tool call, so it never wrote an answer. Left
       * alone this is a silent truncation — the user gets a few sentences of preamble and no
       * artifact, which is exactly what we observed. So we continue the conversation once more with
       * tools disabled, forcing it to finish with whatever it managed to load.
       */
      if (finishReason === 'tool-calls') {
        logger.warn(`Tool-round cap (${MAX_TOOL_ROUNDS}) reached — forcing a final answer with tools disabled`);

        const priorMessages = (await first.response).messages;

        const continuation = startStream(
          [
            ...system,
            ...coreMessages,
            ...priorMessages,
            {
              role: 'user',
              content:
                'You have used all available tool rounds. Do not call any more tools. ' +
                'Complete the task now using what you have already loaded.',
            },
          ],
          false,
        );

        yield* drain(continuation);
      }
    } catch (error) {
      /*
       * A HARD FAILURE — the provider errored, or the stream broke. Distinct from a Stop, which is a
       * user decision. Flag it, then rethrow: the client still needs to see the error.
       *
       * A user abort arrives here too (the abort signal rejects the stream), so exclude it — the
       * tokens a stopped generation burned are genuinely owed (§4.12).
       */
      failed = !request.abortSignal?.aborted;
      throw error;
    } finally {
      resolveUsage(totals);

      /*
       * Settle, then record — and do BOTH even when the generation threw or was stopped (§4.12).
       *
       * A user who hits Stop after thirty seconds consumed thirty seconds of real tokens. Anthropic
       * has already billed us for them, so `totals` is what was actually spent, and the ledger records
       * exactly that — never the full estimate the generation would have cost had it finished.
       */
      const generationId = `gen_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

      const settlement = await settleGeneration({
        userId: user.id,
        generationId,
        model,
        usage: totals,
        byok: useByok,
        context: request.context,
      });

      /*
       * AUTO-REFUND on a hard failure (§4.6).
       *
       * The provider still bills US for the tokens a failed generation burned — we do not get that
       * back. But the USER asked for a game and got an error, and charging them for our failure is
       * indefensible. So we eat the cost: the debit stays in the ledger (it happened) and a
       * compensating `refund` row sits beside it. Append-only means the history stays honest AND the
       * balance comes out right.
       */
      if (failed && settlement && settlement.creditsCharged > 0) {
        await refundGeneration(
          user.id,
          generationId,
          settlement.creditsCharged,
          'Automatic refund — the generation failed',
          request.context,
        );
      }

      resolveSettlement(
        settlement
          ? {
              creditsCharged: failed ? 0 : settlement.creditsCharged,
              balanceAfter: failed ? settlement.balanceAfter + settlement.creditsCharged : settlement.balanceAfter,
            }
          : null,
      );

      await getGenerationLog().record({
        id: generationId,
        chatId: request.chatId,
        userId: user.id,
        projectId: request.projectId,
        model,
        provider: PLATFORM_PROVIDER,
        creditsCharged: failed ? 0 : (settlement?.creditsCharged ?? 0),
        rawCostUsd: settlement?.rawCostUsd ?? 0,
        promptVersionId: promptVersion.id,
        skillsLoaded: [...toolContext.loaded],
        blocksLoaded: blocks.map((b) => b.id),
        promptTokens: totals.promptTokens,
        completionTokens: totals.completionTokens,
        totalTokens: totals.totalTokens,
        cacheReadTokens: totals.cacheReadTokens,
        cacheCreationTokens: totals.cacheCreationTokens,
        toolRounds,
        durationMs: Date.now() - startedAt,
        steps: stepLog,
        repairOf: request.repairOf,
        finishReason: failed ? 'error' : finishReason,
      });
    }
  }

  return {
    textStream: run(),
    promptVersionId: promptVersion.id,
    model,
    blocksLoaded: blocks.map((b) => b.id),
    toolContext,
    usage: usagePromise,
    settlement: settlementPromise,
    notice: byok.notice,
  };
}
