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
import { selectStickyBlocks } from '~/lib/.server/prompt/sources';
import { getSkillStore } from '~/lib/.server/skills/store';
import { parseSlashInvocation } from '~/lib/skills/slash';
import { createFilesContext } from '~/lib/.server/llm/utils';
import type { FileMap } from '~/lib/.server/llm/constants';
import { PROVIDER_LIST } from '~/utils/constants';
import type { IProviderSetting } from '~/types/model';
import type { AuthUser } from '~/lib/.server/supabase/auth';
import { resolveByok } from '~/lib/.server/licensing/entitlements';
import { checkCreditGate, refundGeneration, settleGeneration } from '~/lib/.server/billing/gate';
import { getPlatformConfig, getPlatformModel, NotConfiguredError, requirePlatformKey } from './config';
import { createSkillTools, MAX_TOOL_ROUNDS, type SkillToolContext } from './tools';
import { createMcpRelayTools, type McpToolCallEvent } from './mcp-tools';
import { buildProjectInstructions, MAX_INSTRUCTIONS_CHARS } from './project-instructions';
import { cancelGenerationToolCalls } from './mcp-relay';
import { effortForTurn } from './effort-policy';
import { getGenerationLog, type GenerationRecord } from './usage';
import { compactHistory, historySavings, HISTORY_WINDOW_TURNS } from '~/lib/.server/llm/history';
import { envNumber } from '~/lib/.server/env';
import { buildPreloadedSkillBlock, preloadSkills } from './preload-skills';
import { buildProjectNotes, type GameBackendState } from './project-notes';
import { getMonitor, FUNNEL_EVENTS, ALERT_SIGNALS } from '~/lib/.server/monitoring';
import { sharedFailureRate } from '~/lib/.server/monitoring/failure-rate';
import { CREATION_BRIEF_MARKER } from '~/types/creation';
import { accumulateStepUsage, emptyUsage, type GenerationUsage, type UsageStep } from './step-usage';

const logger = createScopedLogger('agent-proxy');

/** Self-healing cap per generation (§4.2.7). Beyond this the agent is thrashing, not fixing. */
export const MAX_REPAIR_TURNS = 2;

/**
 * Prompt-cache breakpoints (SPEC §4.2.8). Anthropic permits four, and we spend all four:
 *
 *   1. the base prompt
 *   2. the routed doc blocks (one breakpoint for the whole set — `selectStickyBlocks`)
 *   3. skills — the invoked `/slash` skill AND the pre-loaded skills, sharing ONE block
 *   4. the project files
 *
 * ⚠️ **There are none spare, and this list is the reason to believe it.** The previous version of this
 * comment said the same sentence while naming only base/blocks/skill/files — accurate when written,
 * and then the pre-loaded-skills block was added with a fifth breakpoint and nobody re-counted. Every
 * `/slash` turn that also routed a doc block sent five and the API refused it outright (HTTP 400,
 * "A maximum of 4 blocks with cache_control may be provided. Found 5") — 0 tokens, dead generation.
 * `countCacheBreakpoints` + `cache-breakpoints.spec.ts` now enforce what this comment asserts, because
 * a comment cannot fail. **Adding a fifth means MERGING two of the above, not adding a breakpoint.**
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

/**
 * Anthropic's hard limit. A FIFTH breakpoint is not degraded caching — it is HTTP 400 and a dead
 * generation: "A maximum of 4 blocks with cache_control may be provided. Found 5." (verified live).
 */
export const MAX_CACHE_BREAKPOINTS = 4;

/**
 * Should the tool loop be forced to write a final answer? (§4.6, §4.10 — a MONEY gate.)
 *
 * Pure and exported because a `true` here BUYS A SECOND FULL GENERATION on the user's credits without
 * them asking — the same category as the auto-repair loop and restore-target selection, which CLAUDE.md
 * requires be pure functions with exhaustive tests rather than logic inlined where nothing can reach it.
 *
 * 🔴 **BOTH conditions are load-bearing, and `finishReason` alone is a PROVIDER CLAIM, not a fact.** The
 * AI SDK propagates it verbatim and never checks it against whether a tool call was emitted, so a
 * provider reporting `tool-calls` on a step that made none used to send this gate into a whole second
 * generation to "finish" an answer that was already written — measured at +111,827 cache tokens for 682
 * chars, billing one real edit 831 credits against ~415 warranted.
 *
 * ⚠️ Do NOT reduce this to `!producedText`. A genuine cut-off has usually ALREADY emitted text ("Let me
 * load the design skill...") before its tool call, so that gate would skip the rescue precisely when it
 * is needed and restore the silent truncation this exists to prevent. The question is never "did it say
 * anything" — it is "was it interrupted mid-tool-loop". See `forced-continuation.spec.ts`.
 */
export function shouldForceContinuation(result: { finishReason: string; lastStepToolCalls: number }): boolean {
  return result.finishReason === 'tool-calls' && result.lastStepToolCalls > 0;
}

/**
 * Count the cache breakpoints in an assembled system array.
 *
 * Exported so the budget is testable rather than a claim in a comment. The comment on `CACHE_CONTROL`
 * asserted "there are none spare" and was true when written — then a fifth was added and nobody
 * re-counted, so every `/slash` turn that also routed a doc block 400'd. A sentence in a doc comment
 * cannot fail; this can.
 */
export function countCacheBreakpoints(system: CoreMessage[]): number {
  return system.filter((m) => (m as { providerOptions?: unknown }).providerOptions !== undefined).length;
}

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

  /**
   * A connected Game Backend (§4.15) — the user's OWN Supabase, described so the model scaffolds
   * RLS-first. Never a credential: only the public project ref and whether RLS is confirmed.
   */
  gameBackend?: GameBackendState;

  /**
   * Asset introspection notes (§4.9) — component-reference summaries for scenes/prefabs referenced by
   * this project, so the agent writes logic against an asset's actual components instead of guessing.
   */
  assetNotes?: string[];

  /**
   * MCP tools actually running in the project's WebContainer (§4.14) — used to make the "available
   * tools" note reflect what STARTED, not just what `.mcp.json` declared, and to build the relay tools
   * the model calls. `inputSchema` is how the model learns each tool's arguments. Execution is
   * client-side in the sandbox; the server never runs these.
   */
  mcpLiveTools?: Array<{ name: string; description?: string; server: string; inputSchema?: unknown }>;
}

/** The skill tool set, as `streamText` sees it — keeps the result's tool types concrete. */
type SkillTools = ReturnType<typeof createSkillTools>;

/**
 * One chunk of visible output.
 *
 * `reasoning` is kept on its OWN channel, never merged into `text` — the client feeds `text` straight
 * into the artifact parser, so a stray sentence of the model's reasoning inside a `<boltAction>` would
 * be written into the user's file.
 */
export type AgentChunk = { type: 'text'; value: string } | { type: 'reasoning'; value: string };

export interface AgentGeneration {
  /**
   * The visible output. The server-side tool loop — including a forced continuation when the
   * tool-round cap is hit — is resolved inside this generator, so what comes out is exactly what the
   * user should see: the artifact, plus the model's reasoning on a separate channel.
   */
  textStream: AsyncGenerator<AgentChunk>;

  /**
   * Minted BEFORE the stream, not in the settlement `finally`, because the CLIENT needs it: a repair
   * turn names the generation it repairs (`repairOf`, §4.2.7), and the ledger debit references this
   * id. An id that only exists after the generation is over cannot be pointed at.
   */
  generationId: string;

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

  /**
   * Subscribe to MCP tool-calls the model makes during this generation (§4.14). The route forwards each
   * to the client (which runs it in the WebContainer and posts the result back to `/api/agent/tool-result`).
   * No-op when the project has no MCP servers. Subscribe BEFORE draining `textStream`.
   */
  onMcpToolCall(listener: (event: McpToolCallEvent) => void): void;
}

/** Re-exported so callers keep importing it from the proxy; the math lives in `step-usage`. */
export type { GenerationUsage } from './step-usage';

function lastUserText(messages: Message[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user');

  return typeof last?.content === 'string' ? last.content : '';
}

/**
 * Every user message, oldest first — the routing input for the CACHED prefix (`selectStickyBlocks`).
 *
 * ⚠️ Deliberately NOT `lastUserText`. Routing the cached prefix from one message means the user's
 * wording sets the price of their turn: measured live, "make the boost pad glow dimmer" cost 12 credits
 * and "make the boost pad on the racing track glow brighter for the kart lap timing" cost 160 — the
 * same edit, 13x, because the second phrasing routed one extra block and invalidated ~114k behind it.
 *
 * Assistant turns are excluded on purpose. The model echoes topic words constantly ("I've updated the
 * racing line..."), so routing on them would let the MODEL's prose pull blocks into the prefix — an
 * unstable input we do not control, which is the same class of mistake as letting a prose classifier
 * pick the effort level (`effort-policy.ts`).
 */
function allUserTexts(messages: Message[]): string[] {
  return messages.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content as string);
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
  const monitor = getMonitor(request.context);

  /*
   * The generation's identity, minted up front. It is referenced by the ledger debit (which is why
   * `settleGeneration` anchors a `generations` row under it) AND by the client, which needs it to name
   * the generation a repair turn is repairing (§4.2.7). Both of those need it to exist before the
   * generation ends.
   */
  const generationId = `gen_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

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
    hasKey: Boolean(request.apiKeys?.[config.provider]),
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

  // Funnel: the generation cleared the gate and is about to run (§5A). Outcome is tracked at settle.
  monitor.track(FUNNEL_EVENTS.GENERATION_STARTED, {
    userId: user.id,
    projectId: request.projectId,
    repair: Boolean(request.errors?.length),
  });

  /*
   * 3. Model + key. Credits mode is the default: the platform key, a FIXED model, no choices to make.
   * A client-supplied model is honored ONLY under a verified BYOK — otherwise it is ignored outright
   * rather than trusted, because model choice is a config property, never a user input (§4.2a).
   */
  const useByok = byok.allowed;
  const model = useByok && request.model ? request.model : getPlatformModel(request.context);

  if (!useByok) {
    requirePlatformKey(config);
  }

  const provider = PROVIDER_LIST.find((p) => p.name === config.provider);

  if (!provider) {
    throw new NotConfiguredError(`The ${config.provider} provider`, 'It is missing from the provider registry.');
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
   * 7. Route the on-demand doc blocks — from the WHOLE CONVERSATION, not the last message.
   *
   * Keyed off every user request AND any invoked skill body, so that `/bt-spec build a racing game`
   * pulls in the RacingSystem docs even though the word "racing" only appears in the task.
   *
   * ⚠️ These blocks are part of the CACHED PREFIX, so routing them per-message made the user's phrasing
   * set the price of their turn (12 credits vs 160 for the same edit — see `selectStickyBlocks`). The
   * set is sticky and append-only.
   *
   * There is deliberately no single-message `routingText` left in this function. Everything routed from
   * here lands in the cached prefix, so a per-message input is always wrong; if a future feature wants
   * only the current ask, it must be something that sits AFTER the last breakpoint (the volatile tail),
   * and it should say so where it is written rather than reviving a variable that reads as general.
   */
  const userTexts = allUserTexts(messages);
  const skillText = slash?.skillBlock ?? '';

  /*
   * Is this the turn that BUILDS the project? (§4.4b)
   *
   * On a creation turn the brief is the whole workflow — there is nothing to look up — and letting the
   * model try is what made creation slow: it drafted the game, abandoned the draft to call `load_skill`,
   * and redrafted, six times, for 350s and 29,173 wasted output tokens. The system prompt forbids this
   * in words and the model did it anyway. So the tools are taken away rather than argued about.
   */
  const isCreationTurn = lastUserText(messages).includes(CREATION_BRIEF_MARKER);
  const store = getPromptStore();
  const blocks: Array<{ id: string; title: string; body: string }> = [];

  for (const block of selectStickyBlocks([...userTexts, skillText])) {
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

  /*
   * Hand the model the skills it is obviously going to want, instead of making it fetch them.
   *
   * Progressive disclosure loses badly here, and we have the numbers: a real kart-racer build spent
   * 350s and 29,173 output tokens on SIX tool rounds — 75% of the wall clock and 68% of the bill — to
   * load exactly ONE distinct skill. A tool call is ~50 tokens; those tens of thousands are the model
   * drafting the game, deciding it wants a skill, and throwing the draft away to redraft. Pre-loading
   * into the CACHED prefix (reads bill at 0.1x) deletes the round trips AND the redrafts.
   *
   * `load_skill` remains for anything the router does not anticipate.
   */
  /*
   * ⚠️ The creation BRIEF is excluded from skill routing, deliberately, and this is not the same list
   * the doc blocks route from. The brief is machine-written and full of incidental vocabulary
   * ("created", "starter", "scaffold") that keyword-matches skills the model has no use for — the
   * reason `isCreation` short-circuits to `bt-design` at all. Feeding it into the STICKY router would
   * make that mistake permanent for the life of the conversation instead of lasting one turn.
   */
  const skillRoutingTexts = [...userTexts.filter((t) => !t.includes(CREATION_BRIEF_MARKER)), skillText];
  const preloaded = await preloadSkills(skillRoutingTexts, slash?.skillName, isCreationTurn);

  /*
   * 🔴 THE INVOKED SKILL AND THE PRE-LOADED SKILLS SHARE ONE BREAKPOINT — because ANTHROPIC ALLOWS
   * EXACTLY FOUR AND WE HAD FIVE (found + fixed 2026-07-17).
   *
   * The budget is base + routed blocks + skills + project files = 4, and the comment on `CACHE_CONTROL`
   * has always said "there are none spare". It was right when it was written; the pre-loaded-skills
   * block was added later and nobody re-counted. So any `/slash` turn that ALSO routed a doc block sent
   * five, and the API refuses the request outright:
   *
   *   HTTP 400 — "A maximum of 4 blocks with cache_control may be provided. Found 5."
   *
   * That is a HARD failure before a single token: 0 in, 0 out, the whole generation dead. Exactly the
   * shape of the edit-turn `thinking.signature` bug (CLAUDE.md) — a path that every test drove around
   * and no measurement pointed at, because slash invocations are rare and creations never use one.
   *
   * Merging is the STRUCTURAL fix rather than a counter: two skill blocks cannot become three, so five
   * is now unreachable by construction instead of by arithmetic someone has to redo. They also belong
   * together — both answer "which skills does the model already have?" — and one breakpoint for both is
   * what the budget could always afford.
   *
   * ⚠️ Do not "tidy" this back into two `system.push` calls with their own `providerOptions`.
   */
  const skillBlocks = [
    ...(slash ? [slash.skillBlock] : []),
    ...(preloaded.length > 0 ? [buildPreloadedSkillBlock(preloaded)] : []),
  ];

  if (skillBlocks.length > 0) {
    system.push({ role: 'system', content: skillBlocks.join('\n\n'), providerOptions: CACHE_CONTROL });
  }

  /*
   * ---- If the skills are already in the prefix, the model gets NO tools. ----
   *
   * A skill is reached EITHER by pre-loading it into the cached prefix OR by the model fetching it.
   * Never both. Offering a tool while telling the model not to use it is a trap, not a redundancy, and
   * we have now watched it spring three times:
   *
   *   creation turn, tools on   — "never load a skill here" in the prompt; called `load_skill` 4x.
   *                               Removing the tools took the build from 468s to 114s.
   *   edit turn, tools on       — `bt-design` pre-loaded under a heading reading "ALREADY LOADED — do
   *                               NOT call load_skill"; called `load_skill('bt-design')` FIVE TIMES,
   *                               each answered "already loaded, proceed". 6 rounds, ~11,000 output
   *                               tokens, 2 minutes, then an EMPTY response. Charged 405 credits.
   *   edit turn, only
   *   `read_skill_resource` on  — we tried keeping just this one, so bundled files stayed reachable.
   *                               It thrashed on THAT instead: 6 rounds, 160s, empty response again.
   *                               The trap is the tool, not which tool.
   *
   * With tools off the same edit takes 29s and produces a correct patch. So: tools exist only for the
   * turn the keyword router could not anticipate (`preloaded.length === 0`), which is the only turn
   * where they can do any good.
   *
   * KNOWN LIMITATION, recorded rather than hidden: on a pre-loaded turn the model cannot read a
   * skill's BUNDLED RESOURCES (only its instructions are inlined). `bt-design` bundles 101KB of
   * hero-scroll templates and its body says to read one before writing hero-scroll code. Inlining all
   * of it on every design turn (~25k tokens) is the wrong trade for the one turn in fifty that wants
   * it. If that workflow matters, the fix is a resource-level router that inlines the few files a
   * request actually implies — NOT handing the tool back. See spec/skills.md.
   */
  /*
   * MCP relay tools (§4.14). A project's WebContainer MCP servers become tools the model can call; the
   * platform never executes them (§5) — each tool's `execute` EMITS the call to the client and AWAITS
   * the result posted back to `/api/agent/tool-result`, all inside THIS one generation (one settlement,
   * one cached prefix). Empty when the project declared/started no MCP servers, in which case everything
   * below behaves exactly as it did before MCP existed.
   */
  const mcpListeners: Array<(event: McpToolCallEvent) => void> = [];
  const emitMcpCall = (event: McpToolCallEvent) => {
    for (const listener of mcpListeners) {
      listener(event);
    }
  };

  const mcpRelayTools =
    request.mcpLiveTools && request.mcpLiveTools.length > 0
      ? createMcpRelayTools(request.mcpLiveTools, {
          generationId,
          userId: user.id,
          abortSignal: request.abortSignal,
          emit: emitMcpCall,
        })
      : {};
  const hasMcpTools = Object.keys(mcpRelayTools).length > 0;

  /*
   * When the project has MCP tools, the tool loop MUST be on — otherwise the model cannot call them.
   * That re-enables the loop the skill-preload path deliberately disables (see the note above), which is
   * the correct trade: a project with running MCP servers wants those tools reachable, and MCP is a
   * minority of generations. Without MCP tools, `allowTools` is exactly what it always was.
   */
  const allowTools = !isCreationTurn && (hasMcpTools || (preloaded.length === 0 && !slash));

  /*
   * Volatile project-context notes (§4.9 assets, §4.14 MCP tools, §4.15 Game Backend).
   *
   * These sit in the UNCACHED tail on purpose: they change mid-session (a backend is connected, an
   * asset is added, `.mcp.json` is edited), so a cache breakpoint here would invalidate the expensive
   * base prefix every time one of them changed. They are small, and correctness beats caching them.
   * Placed BEFORE the file context so the model reads "what this project has" before "what is in it".
   */
  /*
   * The project's own `CLAUDE.md` (§4.2), promoted from "a file" to "instructions".
   *
   * It goes FIRST in the volatile tail: it is the user telling us how to work on this project, and it
   * outranks every note below it. It is also LIFTED OUT of the file context immediately below — the same
   * bytes must never be sent twice (paid twice per turn, and two copies to disagree after an edit).
   */
  const instructions = buildProjectInstructions(request.files);
  let contextFiles = request.files;

  if (instructions) {
    system.push({ role: 'system', content: instructions.block });

    const { [instructions.key]: _lifted, ...rest } = request.files!;
    contextFiles = rest;

    if (instructions.truncated) {
      logger.warn(`Project CLAUDE.md exceeded ${MAX_INSTRUCTIONS_CHARS} chars and was truncated`);
    }
  }

  for (const note of buildProjectNotes({
    files: request.files,
    gameBackend: request.gameBackend,
    assetNotes: request.assetNotes,
    mcpLiveTools: request.mcpLiveTools,
  })) {
    system.push({ role: 'system', content: note });
  }

  if (contextFiles && Object.keys(contextFiles).length > 0) {
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
      content: `# Current Project Files\n\n${createFilesContext(contextFiles, true)}`,
      providerOptions: CACHE_CONTROL,
    });
  }

  /*
   * The breakpoint budget, enforced where it is spent rather than asserted in a comment.
   *
   * A fifth breakpoint is HTTP 400 and a dead generation — so dropping the extra is strictly better
   * than letting the request fail, and it degrades exactly where it hurts least: the LAST breakpoint
   * is the project files, whose entry is the most volatile and therefore the cheapest to lose. Loud,
   * because a silent drop here is a permanent 2x on someone's bill.
   */
  if (countCacheBreakpoints(system) > MAX_CACHE_BREAKPOINTS) {
    logger.error(
      `Cache breakpoint budget exceeded (${countCacheBreakpoints(system)} > ${MAX_CACHE_BREAKPOINTS}) — dropping the last one. ` +
        `This would otherwise be an HTTP 400 and a dead generation. Fix the assembly above, do not rely on this.`,
    );

    for (let i = system.length - 1; i >= 0 && countCacheBreakpoints(system) > MAX_CACHE_BREAKPOINTS; i--) {
      if ((system[i] as { providerOptions?: unknown }).providerOptions !== undefined) {
        delete (system[i] as { providerOptions?: unknown }).providerOptions;
      }
    }
  }

  /*
   * 9. The tool loop runs entirely server-side; the client stream stays pure text + actions.
   *
   * Pre-loaded skills are seeded as ALREADY LOADED, so if the model calls `load_skill` for one anyway
   * (it does — we watched it call for `bt-design` four times in a single generation) the tool returns a
   * cheap acknowledgement instead of re-injecting 19KB and burning a round from the cap.
   */
  const toolContext: SkillToolContext = {
    loaded: new Set([...(slash ? [slash.skillName] : []), ...preloaded.map((s) => s.name)]),

    /*
     * Once the router has put the skills in the prefix, `load_skill` has nothing left to fetch — so it
     * is removed rather than merely discouraged. Discouraging it did not work: see `offerLoadSkill`.
     */
    offerLoadSkill: preloaded.length === 0 && !slash,
  };

  const tools = { ...createSkillTools(toolContext), ...mcpRelayTools } as SkillTools;

  /*
   * How hard to think on THIS turn (§4.2a). Decided from turn KIND — never from reading the prompt;
   * see `effort-policy.ts`. It only ever escalates: a repair that already failed gets `high`/`xhigh`,
   * an explicitly-invoked skill gets `high`, and everything else takes the operator's configured
   * default. There is no cheap tier for edits — `low` breached a read-only zone when we measured it.
   */
  const effort = effortForTurn({
    isRepair,
    repairAttempt: request.repairAttempt ?? 1,
    isSlashInvocation: Boolean(slash),
  });

  const modelInstance = provider.getModelInstance({
    model,
    serverEnv: (request.context as { cloudflare?: { env?: Env } })?.cloudflare?.env as Env,
    apiKeys: useByok ? request.apiKeys : undefined,
    providerSettings: useByok ? request.providerSettings : undefined,
    effort,
  });

  logger.info(
    `Generation: model=${model} prompt=${promptVersion.id} blocks=[${blocks.map((b) => b.id).join(',')}] ` +
      `${slash ? `slash=/${slash.skillName} ` : ''}${isRepair ? `repair(${request.repairAttempt ?? 1}) ` : ''}` +
      `mode=${useByok ? 'byok' : 'platform'}${isCreationTurn ? ' CREATION' : ''} ` +
      `tools=${allowTools ? 'on' : `off (${isCreationTurn ? 'creation' : 'skills pre-loaded'})`} ` +
      `effort=${effort ?? 'default'}`,
  );

  /*
   * COMPACT THE HISTORY before it goes on the wire (§4.2.8, `llm/history.ts`).
   *
   * The conversation is UNCACHED — all four cache breakpoints are on the system blocks, and the
   * messages come after them — so every byte of every previous turn is re-sent at FULL input rate on
   * every turn, forever, and the bill grows with the length of the session.
   *
   * Measured on real conversations from this project: 83-87% of that history is file BODIES inside
   * `<boltAction type="file">` blocks — and every one of them is redundant, because the current (and
   * more accurate) contents of those same files are sent fresh each turn in `# Current Project Files`.
   * We were paying, repeatedly, for a stale second copy of something we also send correctly. That is
   * the same double-representation bug §4.2.8 found in the creation artifact, displaced into history.
   *
   * The tags survive, so the model still knows exactly which files it wrote and edited.
   *
   * Windowing runs in the SAME pass (it only ever touches the messages, never the cached system
   * prefix): a char cap plus an env-tunable turn cap (`HISTORY_WINDOW_TURNS`) drop the oldest turns
   * once a long session outgrows either bound, always keeping the first brief and the current turn.
   */
  const maxTurns = envNumber(request.context, 'HISTORY_WINDOW_TURNS', HISTORY_WINDOW_TURNS);
  const compacted = compactHistory(messages, { maxTurns });
  const saved = historySavings(messages, compacted);

  if (saved > 0) {
    logger.info(
      `History compacted: ${saved.toLocaleString()} chars (~${Math.round(saved / 4).toLocaleString()} tokens) removed`,
    );
  }

  const coreMessages = convertToCoreMessages(compacted as any);

  const totals: GenerationUsage = emptyUsage();
  let toolRounds = 0;
  let finishReason = 'unknown';

  /**
   * Did the LAST step actually call a tool? The only trustworthy sign the model was cut off mid-loop.
   *
   * 🔴 `finishReason` ALONE CANNOT ANSWER THIS, AND TRUSTING IT COST ~2x ON AN EDIT TURN. The AI SDK
   * propagates the provider's finish reason VERBATIM — it never cross-checks it against whether a tool
   * call was emitted. So a provider that reports `tool-calls` on a step that made none produces exactly
   * this, proven against the real `streamText` in `forced-continuation.spec.ts`:
   *
   *   { finishReason: 'tool-calls', stepCount: 1, lastStepToolCalls: 0, text: '<the whole artifact>' }
   *
   * Measured live: a complete answer on step 1, then a forced continuation that re-sent the entire
   * prefix — **111,827 more cache tokens for 682 chars of text** — billing one real edit 831 credits
   * where ~415 were warranted. Note the SDK had 6 steps left and did NOT use them: with no tool call to
   * execute there was nothing to loop on, so the cap was never reached and the warning text was a
   * fiction. The gate's own comment said "its last act was a tool call" — it just never checked.
   */
  let lastStepToolCalls = 0;

  /** Did a forced continuation actually run? Recorded, because `finishReason` gets overwritten below. */
  let forcedContinuation = false;

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

        const tools = (step.toolCalls ?? []).flatMap((c) => (c?.toolName ? [String(c.toolName)] : []));
        const out = step.usage?.completionTokens ?? 0;
        const meta = step.providerMetadata?.anthropic as
          | { cacheReadInputTokens?: number; cacheCreationInputTokens?: number }
          | undefined;

        /*
         * What this step's output actually BECAME. `outTokens` alone cannot answer that: it bundles
         * thinking, tool-call JSON and text into one number, and only text can reach the user.
         */
        const textChars = step.text?.length ?? 0;
        const reasoningChars = step.reasoning?.length ?? 0;

        stepLog.push({
          ms,
          outTokens: out,
          inTokens: step.usage?.promptTokens ?? 0,
          cacheRead: meta?.cacheReadInputTokens ?? 0,
          cacheWrite: meta?.cacheCreationInputTokens ?? 0,
          tools,
          textChars,
          reasoningChars,
        });

        /*
         * The two numbers that diagnose a slow/expensive step, and they are different questions:
         *
         *   tok/s   — HOW FAST the tokens came out. Low = the provider/model was slow.
         *   chars/tok — WHAT the tokens were. Text runs ~3.5–4 chars per output token, so a step near
         *               that ratio spent its budget writing the artifact. A step far below it was billed
         *               for thinking and tool calls the user never sees. `spec/context-budget.md` says
         *               a latency complaint must never be answered with caching until this log is read —
         *               it is what tells "the answer is big" apart from "we paid for invisible output".
         */
        const rate = ms > 0 ? Math.round((out / ms) * 1000) : 0;
        const density = out > 0 ? (textChars / out).toFixed(1) : '0.0';

        logger.info(
          `  step ${++stepIndex}: ${ms}ms · ${out} out (${rate} tok/s · ${textChars} chars text = ${density} ch/tok` +
            `${reasoningChars ? `, ${reasoningChars} chars reasoning` : ''}) · ` +
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
  async function* drain(result: StreamTextResult<SkillTools, never>): AsyncGenerator<AgentChunk> {
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        if (part.textDelta.length > 0) {
          producedText = true;
        }

        yield { type: 'text', value: part.textDelta };
      } else if (part.type === 'reasoning') {
        /*
         * The model's summarized reasoning (`display: 'summarized'`, set in `thinkingFetch`).
         *
         * Forwarded on its own channel so the user sees WORK HAPPENING during the long think instead
         * of a dead spinner. It deliberately does NOT set `producedText`: a generation that only ever
         * thought and never wrote an artifact is still a failed generation, and must still refund.
         */
        yield { type: 'reasoning', value: part.textDelta };
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
    lastStepToolCalls = steps?.[steps.length - 1]?.toolCalls?.length ?? 0;
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

  /** Did the model actually SAY anything? Zero text is a failure, whatever `finishReason` claims. */
  let producedText = false;

  async function* run(): AsyncGenerator<AgentChunk> {
    try {
      /*
       * A creation turn runs with NO tools: one call, one answer, no round trips (§4.4b).
       *
       * `toolChoice: 'none'` is not enough on its own to save the time — the model still gets the tool
       * definitions and still drafts around them. Passing `allowTools: false` sets `maxSteps: 1`, so
       * there is exactly one LLM call and the model has no way to abandon its draft and start over.
       */
      const first = startStream([...system, ...coreMessages], allowTools);
      yield* drain(first);

      /*
       * "On cap, proceed with what's loaded" (spec/skills.md) — the half that is easy to forget.
       *
       * The loop ran out of STEPS with a tool call outstanding, so the model never wrote an answer.
       * Left alone that is a silent truncation — the user gets a few sentences of preamble and no
       * artifact. So continue once more with tools disabled, forcing it to finish with what it loaded.
       *
       * ⚠️ BOTH CONDITIONS ARE LOAD-BEARING; `finishReason` alone is not a fact (see `lastStepToolCalls`).
       * A provider may report `tool-calls` on a step that made none, and this gate then re-runs a
       * COMPLETE generation — measured at +111,827 cache tokens for 682 chars, ~2x on a real edit.
       *
       * ⚠️ And do NOT "simplify" this to `!producedText`. A genuine cut-off usually HAS emitted text
       * ("Let me load the design skill...") before its tool call, so that gate would skip the
       * continuation exactly when it is needed and restore the silent truncation this exists to fix.
       * The question is not "did it say anything", it is "was it interrupted mid-tool-loop".
       */
      if (shouldForceContinuation({ finishReason, lastStepToolCalls })) {
        forcedContinuation = true;
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

      /*
       * A generation that produced NO TEXT is a failure, however cheerfully the provider says "stop".
       *
       * This is not hypothetical. The degenerate tool loop above ended exactly here: `finishReason`
       * was `stop`, `result.text` was `""`, `response.messages` was `[]` — and 10,054 output tokens
       * had been billed. Without this check the ledger takes 405 credits, the client renders an empty
       * assistant bubble, and nothing anywhere reports a problem. The user just sees their request
       * quietly do nothing, which is the worst possible failure: unattributable.
       *
       * So: no text, no charge. `failed` routes it to the §4.6 auto-refund, and the error gives the
       * user something to react to (and Retry, §4.12) instead of silence.
       */
      if (!producedText) {
        failed = true;
        throw new Error(
          'The model returned an empty response. You have not been charged for this generation — please try again.',
        );
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
      const settlement = await settleGeneration({
        userId: user.id,
        generationId,
        model,

        // The provider that ACTUALLY served this generation — it decides the rates (`ratesFor`).
        provider: config.provider,
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

      /*
       * Enriches the row `settleGeneration` already anchored (it had to — the debit's foreign key
       * points at it). Everything the anchor could not know until the generation was over lands here:
       * which skills fired, which doc snapshot answered, where the time actually went.
       */
      await getGenerationLog(request.context).record({
        id: generationId,
        chatId: request.chatId,
        userId: user.id,
        projectId: request.projectId,
        model,
        provider: config.provider,
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

        /*
         * ⚠️ A FORCED CONTINUATION IS INVISIBLE HERE UNLESS IT IS SAID OUT LOUD (§4.10).
         *
         * `drain` runs twice and OVERWRITES `finishReason`, so a generation that paid for two full
         * prefixes records the continuation's `stop` — the doubling leaves no trace. That is exactly how
         * the spurious-continuation bug hid: the live usage line read `finish=stop · 0 tool rounds` on a
         * generation that had just been billed twice, which reads as a completely ordinary turn.
         * (`toolRounds` is no help either — it counts steps BEYOND the first, and both drains ran one
         * step, so it summed to 0 while the warning was firing.)
         */
        finishReason: failed ? 'error' : forcedContinuation ? `${finishReason}+forced-continuation` : finishReason,
        status: failed ? 'failed' : 'completed',
      });

      /*
       * Ops + funnel (§5A). A HARD FAILURE is recorded to the rolling failure-rate window; a stop is
       * not a failure (§4.12), so it feeds the window as a success — the tokens it burned were owed and
       * the generation did what the user asked (it stopped). When the failing fraction over the recent
       * window crosses the threshold, one alert fires (the window self-cools so it does not spam).
       */
      const outcome = sharedFailureRate().record(failed);

      if (outcome.shouldAlert) {
        monitor.alert(
          ALERT_SIGNALS.GENERATION_FAILURE_RATE,
          `Generation failure rate ${(outcome.rate * 100).toFixed(0)}% ` +
            `(${outcome.failures}/${outcome.window} recent generations)`,
          { severity: 'critical' },
        );
      }

      monitor.track(failed ? FUNNEL_EVENTS.GENERATION_FAILED : FUNNEL_EVENTS.GENERATION_COMPLETED, {
        userId: user.id,
        projectId: request.projectId,
        model,
        durationMs: Date.now() - startedAt,
      });

      /*
       * Settle any MCP tool-call still waiting on the client (§4.14). If the stream ended — normally, on
       * a Stop, or on an error — while an MCP `execute` was blocked awaiting a sandbox result, this
       * unblocks it with an error rather than leaking a promise that never resolves.
       */
      cancelGenerationToolCalls(generationId);
    }
  }

  return {
    textStream: run(),
    generationId,
    promptVersionId: promptVersion.id,
    model,
    blocksLoaded: blocks.map((b) => b.id),
    toolContext,
    usage: usagePromise,
    settlement: settlementPromise,
    notice: byok.notice,
    onMcpToolCall: (listener) => mcpListeners.push(listener),
  };
}
