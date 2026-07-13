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
import { getPlatformConfig, NotConfiguredError, PLATFORM_MODEL, PLATFORM_PROVIDER, requirePlatformKey } from './config';
import { createSkillTools, MAX_TOOL_ROUNDS, type SkillToolContext } from './tools';
import { checkCreditGate, getGenerationLog } from './usage';

const logger = createScopedLogger('agent-proxy');

/** Self-healing cap per generation (§4.2.7). Beyond this the agent is thrashing, not fixing. */
export const MAX_REPAIR_TURNS = 2;

/** Anthropic permits a small number of cache breakpoints; we spend at most three. */
const CACHE_CONTROL = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };

export interface AgentRequest {
  messages: Message[];
  files?: FileMap;
  chatId?: string;

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
}

export interface GenerationUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;

  /** Anthropic reports cached input SEPARATELY from `input_tokens` — see the note in `drain()`. */
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

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

  // 1. Credit gate — once, up front. In-flight generations are never killed for balance (§4.2.1).
  const gate = await checkCreditGate();

  if (!gate.allowed) {
    const error = new Error(gate.message) as Error & { statusCode: number; isRetryable: boolean };
    error.statusCode = 402;
    error.isRetryable = false;

    throw error;
  }

  /*
   * 2. Model + key. Credits mode is the default and uses the platform key with a FIXED model.
   * BYOK is honored only with Pro features enabled — otherwise a client-supplied key or model is
   * ignored outright rather than trusted (§4.6.1).
   */
  const useByok = config.proFeaturesEnabled && Boolean(request.apiKeys?.[PLATFORM_PROVIDER]);
  const model = config.proFeaturesEnabled && request.model ? request.model : PLATFORM_MODEL;

  if (!useByok) {
    requirePlatformKey(config);
  }

  const provider = PROVIDER_LIST.find((p) => p.name === PLATFORM_PROVIDER);

  if (!provider) {
    throw new NotConfiguredError(`The ${PLATFORM_PROVIDER} provider`, 'It is missing from the provider registry.');
  }

  // 3. The active prompt version — from OUR store. Zero GitHub dependency at generation time (§4.3.2).
  const activePrompt = await getActivePrompt();

  if (!activePrompt) {
    throw new NotConfiguredError(
      'The system prompt',
      'No prompt version is active. Run a doc-sync: POST /api/admin/prompt/refresh.',
    );
  }

  // Bound to a const so the null-check narrowing survives into the async generator below.
  const promptVersion = activePrompt;

  // 4. Explicit slash invocation force-loads its skill.
  const slash = await resolveSlashInvocation(request.messages);
  let messages = slash ? slash.messages : request.messages;

  // 5. Repair turn: append the compiler output as the task.
  const isRepair = Boolean(request.errors?.length);

  if (isRepair && (request.repairAttempt ?? 1) <= MAX_REPAIR_TURNS) {
    messages = [
      ...messages,
      { id: `repair-${Date.now()}`, role: 'user', content: buildRepairMessage(request.errors!) } as Message,
    ];
  }

  /*
   * 6. Route the on-demand doc blocks. Keyed off the user's request AND any invoked skill body, so
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
   * 7. Assemble system blocks, most-stable first.
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
    // Binaries arrive here as `<boltFile binary size>` markers with empty content — never bytes.
    system.push({
      role: 'system',
      content: `# Current Project Files\n\n${createFilesContext(request.files, true)}`,
    });
  }

  // 8. The tool loop runs entirely server-side; the client stream stays pure text + actions.
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

  const totals: GenerationUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  let toolRounds = 0;
  let finishReason = 'unknown';

  const startStream = (history: CoreMessage[], allowTools: boolean) =>
    _streamText({
      model: modelInstance,
      messages: history,
      maxTokens: 64_000,
      tools,

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

    const usage = await result.usage;
    totals.promptTokens += usage?.promptTokens ?? 0;
    totals.completionTokens += usage?.completionTokens ?? 0;
    totals.totalTokens += usage?.totalTokens ?? 0;

    const anthropicMeta = (await result.providerMetadata)?.anthropic as
      | { cacheReadInputTokens?: number; cacheCreationInputTokens?: number }
      | undefined;

    totals.cacheReadTokens += anthropicMeta?.cacheReadInputTokens ?? 0;
    totals.cacheCreationTokens += anthropicMeta?.cacheCreationInputTokens ?? 0;

    finishReason = await result.finishReason;
    toolRounds += Math.max(0, ((await result.steps)?.length ?? 1) - 1);
  }

  let resolveUsage: (usage: GenerationUsage) => void;
  const usagePromise = new Promise<GenerationUsage>((resolve) => {
    resolveUsage = resolve;
  });

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
    } finally {
      resolveUsage(totals);

      await getGenerationLog().record({
        chatId: request.chatId,
        model,
        provider: PLATFORM_PROVIDER,
        promptVersionId: promptVersion.id,
        skillsLoaded: [...toolContext.loaded],
        blocksLoaded: blocks.map((b) => b.id),
        promptTokens: totals.promptTokens,
        completionTokens: totals.completionTokens,
        totalTokens: totals.totalTokens,
        cacheReadTokens: totals.cacheReadTokens,
        cacheCreationTokens: totals.cacheCreationTokens,
        toolRounds,
        repairOf: request.repairOf,
        finishReason,
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
  };
}
