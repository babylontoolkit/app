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
import {
  countUnstrippedEnvelopes,
  splitCarriedArtifact,
  stripTransportEnvelopes,
  stripTransportPrefix,
} from '~/lib/chat/message-envelope';
import { shouldRescueUnproductiveTurn, UNPRODUCTIVE_RESCUE_PROMPT } from './unproductive';
import { createFilesContext } from '~/lib/.server/llm/utils';
import type { FileMap } from '~/lib/.server/llm/constants';
import { PROVIDER_LIST } from '~/utils/constants';
import type { IProviderSetting } from '~/types/model';
import type { AuthUser } from '~/lib/.server/supabase/auth';
import { resolveByok } from '~/lib/.server/licensing/entitlements';
import { checkCreditGate, refundGeneration, settleGeneration } from '~/lib/.server/billing/gate';
import { getPremiumTier } from '~/lib/.server/billing/rates';
import { ensureMarketPrices } from '~/lib/.server/billing/market-price-store';
import { decidePremium, premiumDeclinedNotice } from '~/lib/.server/billing/premium';
import { getPlatformConfig, getPlatformModel, getPremiumModel, NotConfiguredError, requirePlatformKey } from './config';
import { createSkillTools, type SkillToolContext } from './tools';
import { toolPolicyForTurn } from './tool-policy';
import { mediaProtocolNote } from './media-note';
import { MAX_PROVIDER_RETRY_ATTEMPTS, retryThinkingMode, retryToolMode, shouldRetryGeneration } from './retry-policy';
import type { AgentStatusKind } from './heartbeat';
import { createRepairTool, repairUnavailableToolCall } from './tool-repair';
import { createWebFetchTool } from './web-fetch-tool';
import { createWebSearchTool } from './web-search-tool';
import { createMcpRelayTools, type McpToolCallEvent } from './mcp-tools';
import { createMediaTools, type MediaTaskEvent } from './media-tools';
import { KieMediaProvider } from '~/lib/.server/media/kie-client';
import { getObjectStore } from '~/lib/.server/storage';
import { buildProjectInstructions, MAX_INSTRUCTIONS_CHARS } from './project-instructions';
import { cancelGenerationToolCalls } from './mcp-relay';
import { effortForTurn } from './effort-policy';
import { canDisableThinking, parseUserEffort } from '~/lib/modules/llm/capabilities';
import type { LanguageModelV1 } from 'ai';
import { getGenerationLog, type GenerationRecord } from './usage';
import {
  compactHistory,
  historySavings,
  historySize,
  HISTORY_WINDOW_TURNS,
  type HistorySize,
} from '~/lib/.server/llm/history';
import { envNumber } from '~/lib/.server/env';
import { buildPreloadedSkillBlock, loadSkillBodies, preloadSkills, stickyLoadedSkills } from './preload-skills';
import { buildProjectNotes, type GameBackendState } from './project-notes';
import { discussModeNote } from './discuss-note';
import { getMonitor, FUNNEL_EVENTS, ALERT_SIGNALS } from '~/lib/.server/monitoring';
import { sharedFailureRate } from '~/lib/.server/monitoring/failure-rate';
import { recordRefundOutcome, recordRescueMarkers } from '~/lib/.server/monitoring/paid-path-rates';
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
   * The user opted into the PREMIUM model tier for this generation (§4.6.1) — a persisted per-user
   * preference the client sends. It is a REQUEST, never authorization: the server maps it to the one
   * configured premium model and only honors it if `decidePremium` clears the credits threshold.
   */
  premium?: boolean;

  /**
   * The user's chosen base thinking effort for this session (§4.2.9) — `'medium'` or `'high'`.
   *
   * Untrusted and validated at the boundary (`parseUserEffort`): anything else — `max`, `xhigh`, `low`, a
   * typo — becomes `undefined` and the operator default stands. It is a FLOOR handed to `effortForTurn`,
   * so the escalation rules still fire above it.
   */
  effort?: string;

  /**
   * The chat's Discuss toggle (§4.2.9). `'discuss'` appends a prose-only instruction to the UNCACHED
   * volatile tail — never a prompt swap, which would re-write the cached prefix on every toggle.
   * Ignored on the creation turn (`discussModeNote`).
   */
  chatMode?: 'discuss' | 'build';

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

  /**
   * The re-sent conversation as it actually went on the wire this turn — post-compaction, post-window
   * (`llm/history.ts`). Feeds the client's `/context` report and health dot (§4.5.6): the history is
   * the one UNCACHED, ever-growing input component, so this is the number "should I /clear?" is about.
   */
  historyStats: HistorySize & { maxTurns: number };

  /**
   * This generation ran in Discussion mode (§4.2.9). The route writes the NO_REPLAY message
   * annotation BEFORE streaming the text — that ordering is the hard wall: the client parser routes
   * the message to the render-only transcript parser from the first chunk, so a disobedient
   * `<boltAction>` can never write a file.
   */
  discussMode: boolean;

  /**
   * WHAT this turn is, for the liveness panel (`agent/heartbeat.ts`).
   *
   * Reported live: *"2-3min of empty is a killer… thinking about what???"* The panel proved the pipe
   * was alive and said nothing else. This is the fact — decided before a token is spent, from the same
   * signals `effort-policy.ts` reads — that lets the client say "Building your project" instead.
   */
  statusKind: AgentStatusKind;

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

  /**
   * Subscribe to media renders the model STARTED during this generation (§4.16). Fire-and-forget,
   * unlike the MCP relay: the tool already returned (the loop never parks on a render); the client's
   * job is to poll the task and write the bytes into the project when they land.
   */
  onMediaTask(listener: (event: MediaTaskEvent) => void): void;
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
export async function resolveSlashInvocation(
  messages: Message[],
): Promise<{ skillBlock: string; skillName: string; messages: Message[] } | null> {
  const index = messages.map((m) => m.role).lastIndexOf('user');

  if (index === -1) {
    return null;
  }

  const message = messages[index];
  const raw = typeof message.content === 'string' ? message.content : '';

  /*
   * 🔴 Parse the user's TYPED text, not the raw message.
   *
   * The client wraps every message in `[Model: …]\n\n[Provider: …]\n\n` and, when the user has edited
   * files, prepends a modified-files `<boltArtifact>`. `parseSlashInvocation` anchors on `/`, so the
   * raw content NEVER matched and every `/slash` invocation was dropped — silently, because that miss
   * returns null one branch ABOVE the unknown-skill warning. See `chat/message-envelope.ts`.
   *
   * `carried` is the artifact: real content the model needs, so the rewrite below keeps it.
   */
  const { carried, text } = splitCarriedArtifact(stripTransportPrefix(raw));
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

  /*
   * 🔴 THE REWRITE MUST NAME THE SKILL — dropping it is how a loaded skill stops binding.
   *
   * This line replaced the user's message with `invocation.args` ALONE for the life of the product,
   * and never once ran: `resolveSlashInvocation` was parsing the RAW content, the client's envelope
   * pushed the `/` off the front, and it returned null every time (the demo bug above). Fixing the
   * parse switched this on for the first time — and the first live `/bt-spec` afterwards wrote a
   * pause menu instead of a spec.
   *
   * The reason is that the args of a planning skill READ AS A BUILD ORDER. The user typed
   * `/bt-spec add a pause menu with resume and quit buttons`; the model received exactly
   * `add a pause menu with resume and quit buttons` as the last user message, with the only
   * counter-instruction sitting in a system block. It obeyed the user turn and built the feature.
   *
   * Ironically the pre-fix behaviour was BETTER here by accident: with the invocation dropped, the
   * model saw the raw `/bt-spec …` text and improvised the workflow off the literal command. So the
   * command string must survive the rewrite — now alongside the real skill body rather than instead
   * of it. (The no-args branch always worded this correctly; only the args branch threw it away.)
   */
  const task = invocation.args
    ? `Run the ${skill.name} skill for this request:\n\n${invocation.args}`
    : `Run the ${skill.name} skill. The user provided no additional input.`;

  const rewritten = [...messages];

  /*
   * The carried artifact survives the rewrite. Dropping it would silently discard the user's own file
   * edits from the turn — the model would plan against a project it can no longer see changed.
   *
   * `parts` are dropped with the old content on purpose: they are the SAME text the client duplicated
   * (see `stripTransportEnvelopes`), so leaving them would re-send the un-rewritten message and the AI
   * SDK would prefer them over `content` — i.e. the slash rewrite would be silently discarded.
   */
  const { parts: _replacedByTask, ...withoutParts } = rewritten[index] as Message & { parts?: unknown };
  rewritten[index] = { ...withoutParts, content: `${carried}${task}` } as Message;

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
  /*
   * Refresh the marketplace price list BEFORE anything prices anything: the gate, the premium
   * decision and settlement all read it synchronously (`activeMarketPrices`), and this is the async
   * doorway they share. A failed refresh falls back to the last-loaded/baked list inside — it can
   * never throw and never block a generation.
   */
  await ensureMarketPrices(request.context);

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
   * 3. Model + key. Three ways the model is decided, in strict precedence:
   *
   *   a. BYOK (Pro) — the user's OWN key pays, so their explicit model choice is honored (§4.6.1).
   *   b. Premium tier — a credits user who opted in AND holds `PREMIUM_MINIMUM_CREDITS` (§4.6.1). This
   *      is the ONE user-facing model choice in credits mode: a boolean the server maps to the single
   *      configured premium model, never a free-form model string. `decidePremium` is the authority.
   *   c. The platform default — a FIXED, operator-configured model, no choices to make (§4.2a).
   *
   * The premium threshold protects a new user's free grant: 500 granted < 1000 default minimum, so a
   * fresh account cannot burn its grant on a 2x model before it has ever bought credits. It binds on
   * the BALANCE regardless of `BILLING_ENFORCED` — settlement debits either way (see `premium.ts`).
   */
  const useByok = byok.allowed;
  const premiumTier = getPremiumTier(request.context);

  /*
   * 🔴 NORMALIZE THE MESSAGES ONCE, HERE, AND NEVER READ `request.messages` AGAIN.
   *
   * The client wraps every user message in `[Model: …]\n\n[Provider: …]\n\n` — upstream's BYOK transport
   * for the fail-closed `/api/chat` path (`stream-text.ts` parses it off; we never did). Leaving the raw
   * form reachable is what cost an investor demo: `resolveSlashInvocation` anchors on a leading `/`, the
   * envelope pushed it off the front, and EVERY `/slash` invocation was silently dropped.
   *
   * The specific bug is fixed by stripping. The CLASS is fixed by there being only one value: two forms
   * of the same messages in one function is the two-readers-disagree trap this codebase keeps
   * rediscovering, and the next reader will not know to ask which one they hold.
   * `transport-envelope.spec.ts` fails the build if `request.messages` is read anywhere below.
   */
  const messages0 = stripTransportEnvelopes(request.messages);

  /*
   * The drift tripwire (`countUnstrippedEnvelopes`). The stripper is strict by necessity; if upstream
   * ever changes the envelope's shape it stops matching, and the demo failure returns with no error and
   * no log. A LOOSE shape check on the stripped output is the only thing that can see that, because a
   * tripwire sharing the stripper's regex is blind to exactly what the stripper misses.
   */
  const unstripped = countUnstrippedEnvelopes(messages0);

  if (unstripped > 0) {
    logger.warn(
      `${unstripped} user message(s) still look enveloped after stripping — the client's transport format ` +
        'has probably changed. Slash commands and skill routing are degraded until `message-envelope.ts` catches up.',
    );
    getMonitor(request.context).captureMessage(`${unstripped} user message(s) survived transport-envelope stripping`, {
      scope: 'transport-envelope',
      level: 'warning',
    });
  }

  /*
   * Computed from the NORMALIZED messages (a slash rewrite never carries the creation marker) because
   * the PREMIUM decision needs it: a creation on KIE-buffered Fable 5 dies at the gateway timeout
   * before its artifact can flush (see `premium.ts`). The tool policy below reuses the same value.
   */
  const isCreationTurn = lastUserText(messages0).includes(CREATION_BRIEF_MARKER);

  const premium = decidePremium({
    requested: Boolean(request.premium) && !useByok,
    balance: gate.mode === 'byok' ? 0 : gate.balance,
    minimumCredits: premiumTier.minimumCredits,
    isCreationTurn,
  });

  const model =
    useByok && request.model
      ? request.model
      : premium.usePremium
        ? getPremiumModel(request.context)
        : getPlatformModel(request.context);

  // A user who asked for premium but was short of the threshold gets told, softly — never blocked (§4.6.1).
  const premiumNotice =
    Boolean(request.premium) && !useByok && premium.reason === 'below_minimum'
      ? premiumDeclinedNotice(premiumTier.minimumCredits)
      : undefined;

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

  // 5. Explicit slash invocation force-loads its skill (against the already-normalized messages).
  const slash = await resolveSlashInvocation(messages0);
  let messages = slash ? slash.messages : messages0;

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
   * Keyed off every USER request. It used to also include the invoked skill's BODY, on the reasoning
   * that `/bt-spec build a racing game` should pull the RacingSystem docs — but the user's own words
   * ("build a racing game") already do that, and a skill body is thousands of words of machine-written
   * prose that matches almost everything. Measured 2026-07-26: `/bt-spec add a gem counter to the HUD`
   * routed TEN doc blocks including `racing-system` and `demo-rotator`, none of which the task implied,
   * all of them into the cached prefix and (routing being sticky) pinned there for the conversation.
   * Same defect as the skill router this file used to carry, one subsystem to the left.
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

  /*
   * Is this the turn that BUILDS the project? (§4.4b)
   *
   * On a creation turn the brief is the whole workflow — there is nothing to look up — and letting the
   * model try is what made creation slow: it drafted the game, abandoned the draft to call `load_skill`,
   * and redrafted, six times, for 350s and 29,173 wasted output tokens. The system prompt forbids this
   * in words and the model did it anyway. So the tools are taken away rather than argued about.
   */
  // `isCreationTurn` is computed above the premium decision (raw request messages) and reused here.
  const store = getPromptStore();
  const blocks: Array<{ id: string; title: string; body: string }> = [];

  for (const block of selectStickyBlocks(userTexts)) {
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
   * 🔴 There is no skill ROUTER any more (2026-07-26). Only the creation turn pre-loads — a constant,
   * because the brief was written against those two skills. On every other turn the MODEL picks from
   * the index of `name — description` in the cached prompt and calls `load_skill`, which is the
   * agentskills.io contract this platform claims to implement and is how Claude Code behaves.
   *
   * The keyword table that used to live here decided which instructions the model got by substring
   * accidents in our own source — `"why is my build failing"` inlined `bt-design` because "b*ui*ld"
   * contains `ui`, three synced skills had no entry and could never load at all, and the invoked
   * skill's own body was fed into the router (so `/bt-spec` dragged in `bt-landing`). See
   * `preload-skills.ts` for the full post-mortem and for why removing it does not re-buy the
   * six-round pathology.
   */
  const preloaded = await preloadSkills(slash?.skillName, isCreationTurn);

  /*
   * 🔴 A SKILL THE MODEL LOADED EARLIER IN THIS CONVERSATION STAYS LOADED (2026-07-26).
   *
   * The last real gap against Claude Code, where a loaded skill remains in context for the rest of the
   * session. Our tool loop is server-side and internal, so its call and result never enter the saved
   * conversation: a skill fetched on turn 1 was GONE on turn 2, and a spec -> plan -> execute workflow
   * paid a fresh round trip every turn for instructions it had already been given.
   *
   * Carrying them in the CACHED prefix makes this cheaper than the thing it copies — Claude Code
   * re-sends a loaded skill inside an uncached conversation; we re-send it at 0.1x.
   *
   * Read from `messages` (the FULL list, pre-compaction) and never from the windowed history: the set
   * must only ever GROW, or the prefix rewrites itself at 2x on the turn the window slides. Creation is
   * excluded because it has its own fixed pair and no tools. See `stickyLoadedSkills`.
   */
  const carriedNames = isCreationTurn ? [] : stickyLoadedSkills(messages).filter((name) => name !== slash?.skillName);
  const carried = await loadSkillBodies(carriedNames);

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

    /*
     * Creation's fixed pair has no tools, so its block withholds resource paths (a file the model
     * cannot open is a dangling instruction). Carried skills DO have the tools, so their paths travel.
     */
    ...(preloaded.length > 0 ? [buildPreloadedSkillBlock(preloaded)] : []),
    ...(carried.length > 0 ? [buildPreloadedSkillBlock(carried, true)] : []),
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
   * Built-in media generation tools (§4.16) — offered whenever the platform holds a KIE key and the
   * turn belongs to a project (the debit needs a project for the bytes to land in). Async-enqueue:
   * the tool debits, starts the render, EMITS a `media-task` data part and returns immediately — the
   * loop never parks on a multi-minute render (§4.2.8). Media spend is credits-only regardless of
   * BYOK: BYOK covers the user's LLM key, not renders on OUR media key.
   */
  const mediaListeners: Array<(event: MediaTaskEvent) => void> = [];

  /**
   * Renders this generation has ALREADY paid for and started.
   *
   * Load-bearing for the retry below: those debits are taken and those KIE tasks are running, so a
   * retry that re-offered the media tools would commission the whole set a second time and charge for
   * it. The retry runs tool-free and is handed this list instead — the art still lands (the client is
   * already polling for it), and the model gets the paths it needs to reference.
   */
  const startedMedia: MediaTaskEvent[] = [];
  mediaListeners.push((event) => startedMedia.push(event));

  const mediaTools =
    request.projectId && config.kieApiKey
      ? createMediaTools({
          userId: user.id,
          projectId: request.projectId,
          provider: new KieMediaProvider(config.kieApiKey),
          objectStore: getObjectStore(request.context),
          context: request.context,
          emit: (event) => {
            for (const listener of mediaListeners) {
              listener(event);
            }
          },
        })
      : {};

  /*
   * When the project has MCP tools, the tool loop MUST be on — otherwise the model cannot call them.
   * That re-enables the loop the skill-preload path deliberately disables (see the note above), which is
   * the correct trade: a project with running MCP servers wants those tools reachable, and MCP is a
   * minority of generations. Without MCP tools, `allowTools` is exactly what it always was.
   *
   * Media tools open the loop too, on EVERY turn (§4.16) — creation via a media-only loop, and an
   * ordinary turn that nothing else opened via the same bounded media-only loop. The earlier rule
   * ("media never forces the loop; the Media panel covers the rest") made an advertised capability
   * unreachable on exactly the prompts that want it, because the skill router fires on `design` /
   * `landing` / `art`, so those turns had a preloaded skill and therefore no tools at all. It is
   * bounded, not a full loop: skill tools are not offered and the cap is 3 — see `tool-policy.ts` for
   * why that cannot re-open the six-round skill-loading pathology.
   */
  /*
   * Discussion mode (§4.2.9), decided ONCE — the note, the tool policy, and the route's NO_REPLAY
   * annotation must all agree, and `discussModeNote` owns the rule (including the creation-turn guard).
   */
  const discussNote = discussModeNote({ chatMode: request.chatMode, isCreationTurn });

  const toolPolicy = toolPolicyForTurn({
    isCreationTurn,
    hasMcpTools,
    hasMediaTools: Object.keys(mediaTools).length > 0,
    preloadedCount: preloaded.length,
    isSlash: Boolean(slash),
    isDiscussTurn: discussNote !== null,
  });
  const allowTools = toolPolicy.allowTools;

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
   * Discussion mode (§4.2.9) — MUST come after the file-context breakpoint above. A cache breakpoint
   * covers the whole prefix up to itself, so this note one line earlier would re-write the ~110k-token
   * file entry at 2x on every Discuss<->Build toggle. Here, past the last breakpoint, toggling it
   * invalidates nothing. (Decided once, up by the tool policy — this is only the placement.)
   */
  if (discussNote) {
    system.push({ role: 'system', content: discussNote });
  }

  /*
   * The media protocol (§4.16) — same placement rule as `discussNote` above, and for the same reason:
   * it varies per turn (a project without a KIE key gets no media tools), so anywhere earlier would
   * re-write the ~110k-token file-context entry at 2x whenever it appeared or vanished.
   *
   * Creation is excluded because its brief already carries a richer copy — see `media-note.ts`.
   */
  const mediaNote = mediaProtocolNote({
    hasMediaTools: toolPolicy.toolset !== 'skills-only' && Object.keys(mediaTools).length > 0,
    isCreationTurn,
  });

  if (mediaNote && allowTools) {
    system.push({ role: 'system', content: mediaNote });
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
   * `loaded` is seeded with everything ALREADY IN CONTEXT — the `/slash` skill, creation's fixed pair,
   * and the skills this conversation carried forward — so a `load_skill` call for one of them returns a
   * cheap sentence instead of re-injecting 15–25KB. That guard is what makes it safe to keep offering
   * the tool at all: the model asking again costs one round, not a body.
   *
   * `loadedThisTurn` is what the BUDGET spends. It starts empty even when `loaded` is full, because
   * charging a conversation for skills it loaded on previous turns would mean a workflow that carried
   * two skills could never load a third — the "withdraw the tool" failure returning through the budget.
   *
   * ⚠️ Whatever ends up in `loaded` is recorded as this generation's `skillsLoaded` (§4.11 metrics) and
   * is therefore what `stickyLoadedSkills` reads on the NEXT turn. Carried skills must stay in the set
   * for that reason: dropping them here would make the carried set flicker on and off between turns,
   * rewriting the cached prefix each time.
   */
  const toolContext: SkillToolContext = {
    loaded: new Set([
      ...(slash ? [slash.skillName] : []),
      ...preloaded.map((s) => s.name),
      ...carried.map((s) => s.name),
    ]),
    loadedThisTurn: new Set<string>(),

    /*
     * Offered on every turn that gets skill tools at all. The creation turn is the exception, and it is
     * excluded upstream by `toolPolicy.toolset` rather than here — creation inlines its pair and runs
     * with no skill tools, which is the one place "inlined AND offered" would still be a contradiction.
     */
    offerLoadSkill: !isCreationTurn,
  };

  /*
   * `createRepairTool` rides in EVERY set that can run with `toolChoice: 'auto'` — it is the bounce
   * target `repairUnavailableToolCall` reroutes unknown-tool calls to (observed live: the model calling
   * `boltArtifact` as a tool killed a whole paid creation). See `tool-repair.ts`.
   */
  /*
   * `web_fetch` + `web_search` (§4.2) — the research pair — ride in every set EXCEPT the creation
   * media-only loop: searching/reading a public URL is read-only grounding (no spend beyond context, no
   * mutation), so they belong on ordinary turns AND on discussion/plan turns (`skills-only`). They are
   * deliberately kept OFF the creation turn, whose loop is held to media-only to keep the six-round
   * skill-thrash pathology dead. They are only ever REACHABLE when the loop is already on (`allowTools`)
   * — their presence never forces the loop, since they are universal and forcing it would reopen
   * tool-round cost on turns that never research.
   */
  const researchTools = {
    ...createWebSearchTool({ userId: user.id, context: request.context }),
    ...createWebFetchTool(),
  };

  const tools = (
    toolPolicy.toolset === 'media-only'
      ? { ...mediaTools, ...createRepairTool() }
      : toolPolicy.toolset === 'skills-only'
        ? { ...createSkillTools(toolContext), ...researchTools, ...createRepairTool() }
        : { ...createSkillTools(toolContext), ...mcpRelayTools, ...mediaTools, ...researchTools, ...createRepairTool() }
  ) as SkillTools;

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

    /*
     * The user's session floor (§4.2.9), validated here rather than trusted: a browser body asking for
     * `max` on every turn would multiply the thinking bill on the platform's pool. Only `medium`/`high`
     * survive `parseUserEffort`; everything else is `undefined` and falls back to the operator default.
     */
    baseEffort: parseUserEffort(request.effort),
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
      `mode=${useByok ? 'byok' : 'platform'}${isCreationTurn ? ' CREATION' : ''}${discussNote ? ' DISCUSS' : ''} ` +
      `tools=${allowTools ? (toolPolicy.toolset === 'all' ? 'on' : toolPolicy.toolset) : `off (${isCreationTurn ? 'creation' : 'skills pre-loaded'})`} ` +
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
  const historyStats = { ...historySize(compacted), maxTurns };

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

  /**
   * Did the unproductive-turn rescue run (`unproductive.ts`)?
   *
   * Recorded for the same reason as `forcedContinuation`: the rescue's `drain` OVERWRITES
   * `finishReason` with its own clean `stop`, so without this the turn that promised-and-stalled looks
   * identical to one that worked first time — and this class of failure is invisible in every other
   * column (it bills a normal amount and completes normally). If this starts appearing often, the
   * cause is upstream of the rescue and the rescue is only paying for it.
   */
  let unproductiveRescue = false;

  /**
   * Did we re-run this generation after a provider failure?
   *
   * Recorded in `finish_reason` for the same reason `forcedContinuation` is: the second `drain`
   * OVERWRITES `finishReason`, so a retried generation would otherwise record the retry's clean
   * `stop` and leave no trace that the first attempt died. That is precisely how the spurious
   * forced-continuation hid for a day (§4.10) — a metric that cannot see the failure it was added
   * for reports success. If retries start being common, this column is how anyone finds out.
   */
  let retried = false;

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

  /**
   * `toolsOverride` exists for ONE caller: the tool-free retry.
   *
   * Everywhere else the tool set must keep travelling even when calls are forbidden — Anthropic
   * requires the definitions whenever the history contains `tool_use` blocks, which is exactly the
   * forced-continuation and rescue case. The retry's history is clean (it re-sends the original
   * messages), so it is the one place the definitions can be dropped outright — and dropping them is
   * the point: a model that can SEE `generate_image` but may not call it tells the user it is missing.
   */
  const startStream = (
    history: CoreMessage[],
    allowTools: boolean,
    toolsOverride?: SkillTools,
    modelOverride?: LanguageModelV1,
  ) => {
    const activeTools = toolsOverride ?? tools;

    return _streamText({
      model: modelOverride ?? modelInstance,
      messages: history,
      maxTokens: 64_000,
      tools: activeTools,

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
       * An unknown-tool call becomes a corrective bounce instead of a dead generation — the model is
       * told the tag is text, and the SAME generation continues to build the project (`tool-repair.ts`).
       */
      experimental_repairToolCall: repairUnavailableToolCall as never,

      /*
       * `toolChoice: 'none'` still passes the tool DEFINITIONS (Anthropic requires them whenever the
       * history contains tool_use blocks) while forbidding new calls — that is what forces an answer.
       *
       * With an EMPTY tool set there is nothing to forbid, and sending `'none'` alongside no tools is a
       * malformed request — so the field is omitted entirely on that path.
       */
      toolChoice: allowTools ? 'auto' : Object.keys(activeTools).length > 0 ? 'none' : undefined,

      /*
       * +1 for the ANSWER step. `maxSteps` counts every LLM round trip, tool calls included, so
       * handing it the raw tool cap leaves no step in which to actually reply. The cap comes from the
       * TURN policy (`tool-policy.ts`): a creation turn with media tools gets a small media-only loop,
       * everything else the full `MAX_TOOL_ROUNDS + 1`. The forced continuation passes `allow: false`,
       * which must always mean exactly one step.
       */
      maxSteps: allowTools ? toolPolicy.maxSteps : 1,
    });
  };

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
      /* Liveness ticks on ANY part — a stream emitting tool events is alive even with no text yet. */
      lastChunkAt = Date.now();
      chunkCount += 1;

      if (part.type === 'text-delta') {
        if (part.textDelta.length > 0) {
          producedText = true;
        }

        streamedChars += part.textDelta.length;

        if (assistantText.length < MAX_RECOVERED_CHARS) {
          assistantText += part.textDelta;
        }

        yield { type: 'text', value: part.textDelta };
      } else if (part.type === 'reasoning') {
        streamedChars += part.textDelta.length;

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

  /*
   * STREAM LIVENESS — the one number that tells a starved stream apart from a reset socket.
   *
   * A creation died with `TypeError: terminated` after 180.7s, having commissioned three images and
   * streamed a design paragraph. Two explanations fit that equally well and call for OPPOSITE fixes:
   *
   *  - The provider went QUIET and a gateway idle-timeout eventually cut the connection. KIE
   *    soft-throttles by QUEUEING rather than rejecting (measured: p95 349ms -> 7,474ms under load,
   *    zero 429s, no headers — see `providers/kie.ts`), and a media turn hits the SAME ACCOUNT with a
   *    burst of task polls while the stream runs. That would make "slow the media traffic down" right.
   *  - The socket was reset mid-flow, with bytes arriving normally until the moment it died. That is
   *    provider infrastructure and media load has nothing to do with it.
   *
   * `msSinceLastChunk` at the moment of the throw separates them, and NOTHING recorded it — which is
   * why the first two failures produced theories instead of a diagnosis. Kept permanently: aggregate
   * usage cannot answer "where did the stream go", the same reason §4.10's step diagnostics exist.
   */
  let lastChunkAt = 0;
  let chunkCount = 0;
  let streamedChars = 0;

  /*
   * The assistant text, kept so a settled generation can leave a record even if the browser never
   * gets to save one (`transcript-recovery.ts`). TEXT ONLY — reasoning is not part of the transcript
   * and is not replayed to the model (`llm/history.ts`).
   *
   * Bounded: a runaway generation must not grow server memory without limit. A creation artifact runs
   * ~35k chars, so this is ~4x the largest real output and only ever truncates a pathological one.
   */
  const MAX_RECOVERED_CHARS = 150_000;
  let assistantText = '';

  /**
   * Write the plain transcript IF the client has not (`transcript-recovery.ts` decides).
   *
   * Everything risky lives in that pure function; this is only the IO around it. Swallows its own
   * errors for the same reason the monitoring transport does: a generation the user has already been
   * charged for must not fail because a best-effort write did.
   */
  async function recoverTranscript(): Promise<void> {
    if (!request.chatId || !request.projectId) {
      return;
    }

    try {
      const { planTranscriptRecovery } = await import('./transcript-recovery');
      const { getChat, putChat } = await import('~/lib/.server/projects/message-store');

      const existing = await getChat(request.projectId, request.chatId, request.context);

      const plan = planTranscriptRecovery({
        serverChatId: request.chatId,
        existing,

        /*
         * The NORMALIZED messages — a recovered transcript must not preserve the transport envelope.
         * It is not something the user typed, and this record is what the conversation becomes when the
         * client dies before saving (§4.5.6).
         */
        requestMessages: messages0.map((m) => ({
          id: m.id,
          role: m.role,
          content: String(m.content ?? ''),
        })),
        assistantText,
        now: new Date().toISOString(),
      });

      if (!plan) {
        return;
      }

      await putChat(request.projectId, plan, request.context);
      logger.warn(
        `Generation ${generationId}: the client did not save this turn — recovered ${plan.messages.length} ` +
          `messages to chat ${request.chatId} server-side.`,
      );
    } catch (error) {
      logger.error(`Transcript recovery failed for ${generationId}: ${(error as Error)?.message}`);
    }
  }

  async function* run(): AsyncGenerator<AgentChunk> {
    try {
      /*
       * A creation turn runs a MEDIA-ONLY loop when the platform can render (§4.16) — one small round
       * of generate_* calls for the design art, then the answer — and with NO tools otherwise: one
       * call, one answer, no round trips (§4.4b). `tool-policy.ts` decides; skill tools are never
       * offered on creation, so the model cannot abandon its draft to go load skills.
       */
      let first = startStream([...system, ...coreMessages], allowTools);

      /*
       * BOUNDED RETRIES, and only while the provider has broken before producing anything
       * (`retry-policy.ts`, `MAX_PROVIDER_RETRY_ATTEMPTS`).
       *
       * Measured 2026-07-27: KIE kills any step that emits no bytes for ~30s with `Internal error,
       * please try again later` — three failures at 28.9s / 31.5s / 30.1s, all with zero output, while
       * every step that emitted something ran for minutes. One retry is a coin flip against that; a few
       * are not. `drain` accumulates usage only after its loop finishes, so a mid-stream throw records
       * nothing: the ledger has nothing to reverse, which is what makes another attempt honest rather
       * than a double charge — and `outTokens > 0` stops the loop the instant a step has been billed.
       */
      for (let attempt = 0; ; attempt++) {
        try {
          yield* drain(first);
          break;
        } catch (error) {
          if (
            !shouldRetryGeneration({
              error,
              outTokens: totals.completionTokens,
              aborted: Boolean(request.abortSignal?.aborted),
              attempts: attempt,
            })
          ) {
            throw error;
          }

          retried = true;
          logger.warn(
            `Generation ${generationId} retry ${attempt + 1}/${MAX_PROVIDER_RETRY_ATTEMPTS} after a provider failure: ${(error as Error)?.message}`,
          );

          /*
           * 🔴 CAPABILITIES ARE STRIPPED ONLY TO PROTECT MONEY ALREADY SPENT (`retryToolMode`).
           *
           * This used to be TOOL-FREE, ALWAYS — correct reasoning (a re-offered media tool would buy the
           * whole set twice) applied unconditionally, including when nothing had been commissioned. Live:
           * KIE failed at 29s before any tool call, the retry withdrew the media tools regardless, and the
           * model told the user "I don't have the generate_image or generate_video tools available in this
           * session" and wrote an essay instead of building the project. 50 credits, no game.
           *
           * So: nothing started → retry with the first attempt's exact policy. Renders started → genuinely
           * tool-free (definitions DROPPED, not merely forbidden — a visible-but-forbidden tool is what the
           * model narrated), plus the already-started paths, since inventing an asset path is forbidden.
           */
          const alreadyStarted = startedMedia.length
            ? [
                {
                  role: 'system' as const,
                  content:
                    '# Media already generated for this request\n\n' +
                    'These renders were ALREADY commissioned and paid for on a previous attempt and are ' +
                    'being saved into the project right now. Reference them exactly as listed and do NOT ' +
                    'ask for them again:\n' +
                    startedMedia.map((m) => `- ${m.destPath.replace(/^public\//, '/')} (${m.kind})`).join('\n'),
                },
              ]
            : [];

          const toolMode = retryToolMode(startedMedia.length);

          logger.info(
            `Generation ${generationId} retry: tools=${toolMode}${startedMedia.length ? ` (${startedMedia.length} render(s) already paid for)` : ''}`,
          );

          /*
           * 🔴 THE LAST ATTEMPT RUNS WITH THINKING OFF, because the silence IS the failure (§4.2a).
           *
           * KIE kills a step that emits no bytes for ~30s, and an extended think is exactly that: their
           * adapter forwards thinking text on only ~14% of requests, so on the rest a long think puts
           * nothing on the wire and their own gateway times out the request they are buffering. Two
           * adaptive attempts are a dice roll against that window; disabling thinking is not — the model
           * starts emitting text immediately, so the stream can never go quiet long enough to be killed.
           *
           * Scoped to the FINAL attempt on purpose (`retryThinkingMode`): attempts 1 and 2 are unchanged,
           * so the reasoning text a good backend gives us is never sacrificed on a healthy generation.
           * The turn that loses thinking is one the silent think had already killed twice.
           *
           * ⚠️ CLAMPED. Fable 5 rejects `{type:'disabled'}` outright and Opus 5 rejects it above `high`,
           * so an unclamped override would trade a timeout for a hard 400 on the attempt that has already
           * failed twice — the worst moment to invent a new failure mode.
           */
          const thinkingMode = retryThinkingMode(attempt + 1);
          const lastResortModel =
            thinkingMode === 'disabled' && provider && canDisableThinking(model, effort ?? 'medium')
              ? provider.getModelInstance({
                  model,
                  serverEnv: (request.context as { cloudflare?: { env?: Env } })?.cloudflare?.env as Env,
                  apiKeys: useByok ? request.apiKeys : undefined,
                  providerSettings: useByok ? request.providerSettings : undefined,
                  effort,
                  thinkingMode: 'disabled',
                })
              : undefined;

          if (thinkingMode === 'disabled') {
            logger.warn(
              `Generation ${generationId} last-resort attempt: thinking ${lastResortModel ? 'DISABLED (bytes flow immediately)' : `kept adaptive — ${model} cannot disable it at effort ${effort ?? 'medium'}`}`,
            );
          }

          /*
           * The next attempt becomes the loop's stream, so a second failure is handled by the same
           * gate rather than escaping — which is the whole point of making this a loop. `startedMedia`
           * is re-read each time, so once renders exist every later attempt is tool-free.
           */
          first =
            toolMode === 'same-as-first'
              ? startStream([...system, ...coreMessages], allowTools, undefined, lastResortModel)
              : startStream([...system, ...alreadyStarted, ...coreMessages], false, {} as SkillTools, lastResortModel);
        }
      }

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
        logger.warn(`Tool-round cap (${toolPolicy.maxSteps - 1}) reached — forcing a final answer with tools disabled`);

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
       * The sibling failure: the model ANNOUNCED the work and then ended the turn (`unproductive.ts`).
       *
       * Measured on a live demo: 524 output tokens bought 83 characters — "I'll load the bt-spec skill
       * workflow…" — and the ledger recorded a clean 316-credit success. `!producedText` cannot see it,
       * because a promise is text. So: one more pass, against a prefix that is now warm, telling the
       * model to stop narrating and do the thing. The user gets their spec instead of their money back.
       *
       * Bounded to ONE extra pass and mutually exclusive with the forced continuation above
       * (`alreadyContinued`), so no turn can ever run three streams.
       */
      const visibleTextChars = stepLog.reduce((n, step) => n + (step.textChars ?? 0), 0);
      const toolCallCount = stepLog.reduce((n, step) => n + step.tools.length, 0);

      if (
        shouldRescueUnproductiveTurn({
          aborted: Boolean(request.abortSignal?.aborted),
          alreadyContinued: forcedContinuation,
          emittedAction: assistantText.includes('<boltAction'),
          toolCalls: toolCallCount,
          textChars: visibleTextChars,
          outTokens: totals.completionTokens,

          /*
           * A creation MUST write files (§4.4b). Measured 2026-07-27: a creation retried after a KIE
           * `Internal error` answered with 31,852 chars of prose and no `<boltAction>` — the project
           * never built and the user paid for a description of a game. Plan turns are excluded by
           * construction (they are prose by guarantee, §4.2.9) and so are ordinary edits.
           */
          requiresAction: isCreationTurn && !discussNote,
        })
      ) {
        unproductiveRescue = true;
        logger.warn(
          `Unproductive turn (${visibleTextChars} chars text on ${totals.completionTokens} out tokens, no actions, ` +
            'no tool calls) — the model announced work it did not do; forcing one corrective pass',
        );

        const priorMessages = (await first.response).messages;

        const rescue = startStream(
          [...system, ...coreMessages, ...priorMessages, { role: 'user', content: UNPRODUCTIVE_RESCUE_PROMPT }],
          false,
        );

        yield* drain(rescue);
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
       * Say what broke, out loud. Without this the only trace of a broken stream was an `agent-usage`
       * line reading `0 in / 0 out, finish=unknown` — which is indistinguishable from a dozen other
       * causes and, because `failed` is false for a user abort, was even reported to monitoring as
       * `generation_completed`. A generation that produced nothing must never look like a quiet success.
       *
       * The liveness half: a LONG silence means the provider stopped sending and something eventually
       * cut the connection (starvation / gateway idle-timeout); a SHORT one means bytes were arriving
       * normally and the socket was reset mid-flow. Those two have opposite fixes.
       */
      const silentFor = lastChunkAt ? `${Date.now() - lastChunkAt}ms ago` : 'never arrived';

      logger.error(
        `Generation ${generationId} broke after ${Date.now() - startedAt}ms: ` +
          `${(error as Error)?.name}: ${(error as Error)?.message} (aborted=${request.abortSignal?.aborted})` +
          ` — last chunk ${silentFor}, ${chunkCount} chunks / ${streamedChars} chars streamed`,
      );

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
        finishReason:
          (failed ? 'error' : forcedContinuation ? `${finishReason}+forced-continuation` : finishReason) +
          (unproductiveRescue ? '+unproductive-rescue' : '') +
          (retried ? '+provider-retry' : ''),
        status: failed ? 'failed' : 'completed',
      });

      /*
       * A PAID generation must leave a record even if the browser never saves one (§4.5.6).
       *
       * The client owns persistence and runs it AFTER the stream; settlement is server-side and runs
       * the moment the stream ends. A tab that dies in between takes the whole turn with it — measured:
       * `/bt-landing` finished, settled 427 credits, and the conversation re-opened with no trace it had
       * ever run. This writes the plain version so that window is no longer silent.
       *
       * ⚠️ RECORD, NEVER FILES. The platform stores no project files (§4.5.4b, `no-server-storage.spec`)
       * — do not extend this to stash the artifact's bytes anywhere.
       *
       * Non-throwing and last: recovery failing must never fail a generation the user already paid for.
       */
      if (!failed) {
        await recoverTranscript();
      }

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

      /*
       * The rescue markers, as RATES (`spec/fail-loud.md` Stage C). Recorded on EVERY generation, not
       * only the rescued ones — a rate needs its denominator, and recording only the firings would put
       * every window at 100% and alert on the first one.
       *
       * The refund rate is recorded here too, and it is deliberately NOT the same number as the failure
       * rate above: a generation can fail having charged nothing (the zero-text check fires before any
       * credits are owed), and that is a failure with no refund in it.
       */
      recordRescueMarkers(monitor, {
        forcedContinuation,
        unproductiveRescue,
        providerRetry: retried,
      });
      recordRefundOutcome(monitor, 'generation', failed && (settlement?.creditsCharged ?? 0) > 0);

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
    historyStats,
    discussMode: discussNote !== null,

    /*
     * The turn's identity for the liveness panel — facts, in the same precedence the effort policy
     * uses: a repair is a repair even on a creation, and plan mode outranks an ordinary edit.
     */
    statusKind: isRepair ? 'repair' : isCreationTurn ? 'creation' : discussNote ? 'plan' : 'edit',
    toolContext,
    usage: usagePromise,
    settlement: settlementPromise,
    notice: byok.notice ?? premiumNotice,
    onMcpToolCall: (listener) => mcpListeners.push(listener),
    onMediaTask: (listener) => mediaListeners.push(listener),
  };
}
