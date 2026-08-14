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
import { ensureCacheWarmer, PROMPT_CACHE_TTL, recordCacheRead } from '~/lib/.server/prompt/cache-warmer';
import { getPromptStore } from '~/lib/.server/prompt/store';
import {
  carriedReferenceIds,
  createReferenceTools,
  type ReferenceToolContext,
} from '~/lib/.server/agent/reference-tools';
import { getSkillStore } from '~/lib/.server/skills/store';
import { parseSlashInvocation } from '~/lib/skills/slash';
import {
  countUnstrippedEnvelopes,
  splitCarriedArtifact,
  stripTransportEnvelopes,
  stripTransportPrefix,
} from '~/lib/chat/message-envelope';
import {
  isFailedBuildTurn,
  NO_FILES_WRITTEN_ERROR,
  shouldRescueUnproductiveTurn,
  UNPRODUCTIVE_RESCUE_PROMPT,
} from './unproductive';
import { ACTION_CLOSE_TAG, ACTION_OPEN_TAG, createTagCounter, isTruncatedAction } from './action-tags';
import { CREATION_COMPLETION_PROMPT, shouldVerifyCreationCompleteness } from './creation-completion';
import type { TurnOutcomeFacts } from '~/lib/agent/turn-outcome';
import { createFileTools } from './file-tools';
import { createPreviewTools, type PreviewToolCallEvent } from './preview-tools';
import { resolveAgentBudgets } from './budgets';
import { buildFileManifest, renderFileManifest } from '~/lib/context/file-manifest';
import type { FileMap } from '~/lib/.server/llm/constants';
import { PROVIDER_LIST } from '~/utils/constants';
import type { IProviderSetting } from '~/types/model';
import type { AuthUser } from '~/lib/.server/supabase/auth';
import { resolveByok } from '~/lib/.server/licensing/entitlements';
import { checkCreditGate, refundGeneration, settleGeneration } from '~/lib/.server/billing/gate';
import { getModelTiers } from '~/lib/.server/billing/rates';
import { ensureMarketPrices, marketPriceProvidersFor } from '~/lib/.server/billing/market-price-store';
import { activeAssetLibrary, ensureAssetLibraryForContext } from '~/lib/.server/assets/library-store';
import { assetLibraryIndexForRequest } from '~/lib/.server/assets/library-manifest';
import { creationPhaseNote, parseCreationPhaseId } from '~/lib/agent/creation-plan';
import { toolkitSystemsNoteForRequest } from '~/lib/agent/toolkit-systems';
import {
  decideModelTier,
  tierDeclinedNotice,
  type ModelTierDecisionReason,
  type ModelTierId,
} from '~/lib/.server/billing/premium';
import {
  getPlatformConfig,
  getPlatformModel,
  providersToPrice,
  getTierModel,
  NotConfiguredError,
  requirePlatformKey,
  type PlatformProviderName,
} from './config';
import { recordProviderFailure, recordProviderSuccess } from './provider-select';
import { describeSavings, type Savings } from '~/lib/.server/billing/savings';
import { createSkillTools, type SkillToolContext } from './tools';
import { toolPolicyForTurn } from './tool-policy';
import { mediaProtocolNote } from './media-note';
import {
  EMPTY_RESPONSE_ERROR,
  MAX_PROVIDER_RETRY_ATTEMPTS,
  retryThinkingMode,
  retryToolMode,
  shouldRetryGeneration,
} from './retry-policy';
import { deliveryModeFor, type DeliveryMode } from './delivery';
import type { AgentActivitySnapshot, AgentStatusKind } from './heartbeat';
import { createRepairTool, repairUnavailableToolCall } from './tool-repair';
import { createWebFetchTool } from './web-fetch-tool';
import { createWebSearchTool } from './web-search-tool';
import { createMcpRelayTools, type McpToolCallEvent } from './mcp-tools';
import { createMediaTools, type MediaTaskEvent } from './media-tools';
import { resolveMediaProvider } from '~/lib/.server/media/provider';
import { getObjectStore } from '~/lib/.server/storage';
import { buildProjectInstructions, MAX_INSTRUCTIONS_CHARS } from './project-instructions';
import { cancelGenerationToolCalls } from './mcp-relay';
import { effortForTurn } from './effort-policy';
import { canDisableThinking, parseUserEffort } from '~/lib/modules/llm/capabilities';
import type { LanguageModelV1 } from 'ai';
import { getGenerationLog, type GenerationRecord } from './usage';
import {
  compactHistory,
  stripReplayedReasoning,
  historySavings,
  historySize,
  HISTORY_WINDOW_TURNS,
  type HistorySize,
} from '~/lib/.server/llm/history';
import { envNumber } from '~/lib/.server/env';
import { buildPreloadedSkillBlock, carriedSkillNames, loadSkillBodies, preloadSkills } from './preload-skills';
import { buildProjectNotes, type GameBackendState } from './project-notes';
import { discussModeNote } from './discuss-note';
import { getMonitor, FUNNEL_EVENTS, ALERT_SIGNALS } from '~/lib/.server/monitoring';
import { sharedFailureRate } from '~/lib/.server/monitoring/failure-rate';
import { recordRefundOutcome, recordRescueMarkers } from '~/lib/.server/monitoring/paid-path-rates';
import { CREATION_BRIEF_MARKER } from '~/types/creation';
import { accumulateStepUsage, emptyUsage, type GenerationUsage, type UsageStep } from './step-usage';
import { extractStepCacheTokens, shouldWarnMissingUsageNamespace, usageNamespaceFor } from './usage-metadata';
import { familyOf } from '~/lib/modules/llm/model-families';
import { drainStopReasons, peekStopReasons } from '~/lib/modules/llm/stop-reason-tap';
import { describeRefusal, drainFallbackHandoffs } from '~/lib/modules/llm/refusal-fallback';

const logger = createScopedLogger('agent-proxy');

/** Self-healing cap per generation (§4.2.7). Beyond this the agent is thrashing, not fixing. */
export const MAX_REPAIR_TURNS = 2;

/**
 * Prompt-cache breakpoints (SPEC §4.2.8). Anthropic permits four, and we spend all four:
 *
 *   1. the base prompt                                  (byte-identical globally — the warmed block)
 *   2. the STARTER framework files                      (byte-identical per template pin, 2026-07-30)
 *   3. routed doc blocks + skills, sharing ONE breakpoint (append-only per conversation)
 *   4. the game-code files                              (the one entry that changes every build turn)
 *
 * The 2026-07-30 restructure (`spec/context-budget.md` §"shared-starter prefix restructure", built
 * after 66 real generations measured 82% of ALL spend as cache writes): the file context used to be
 * ONE entry, so every build turn re-wrote the starter's never-edited framework zones at 2× to cache
 * the handful of game files that actually changed. The split (`~/lib/context/stable-zones.ts`) puts
 * the stable half AHEAD of the per-conversation blocks — identical bytes for every project on a pin,
 * so it warms across projects the way the base prompt does — and leaves a small game-code entry as
 * the only per-turn write. Paying for the fifth position: doc blocks and skills MERGED into one
 * breakpoint region (either changes → both rewrite; both are append-only and small, so that is the
 * cheap corner to give up).
 *
 * ⚠️ **There are none spare, and this list is the reason to believe it.** An earlier version of this
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
const CACHE_CONTROL = { anthropic: { cacheControl: { type: 'ephemeral' as const, ttl: PROMPT_CACHE_TTL } } };

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
   * The rung of the MODEL TIER LADDER the user picked for this generation (§4.6.1a) — a persisted
   * per-user preference the client sends: `'standard' | 'premium'`.
   *
   * It is a REQUEST, never authorization: the server maps the ID to THAT rung's operator-configured,
   * operator-priced model and only honors it if `decideModelTier` clears the rung's threshold. Typed
   * `string` because it arrives in a browser body — `decideModelTier` narrows it, resolving anything
   * unrecognised DOWN to `standard` (never upward; inventing an expensive rung is the costly direction).
   */
  tier?: string;

  /**
   * @deprecated The pre-ladder boolean (§4.6.1), still accepted as an alias for `tier: 'premium'`.
   *
   * Kept because a browser holding the previous bundle keeps sending it across a deploy, and the failure
   * of dropping it is silent: the user's premium preference simply stops being honored, they are served
   * the standard model, and nothing anywhere says so. `tier` wins when both are present.
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
   * The user's "Use Asset Library" preference (§4.4d, Control Panel → Features, default ON).
   *
   * ONLY an explicit `false` opts out — absent/undefined means ON, so older clients and non-browser
   * callers keep the shipped default. When false, the §4.4d library block is not pushed for this
   * generation, and since the creation brief's sourcing rule is conditional on that block's presence,
   * the pinned library behaves as if it never existed for THIS user's project — nothing about it can
   * leak into their game. A preference, not security: it spends nothing and reveals nothing.
   */
  useAssetLibrary?: boolean;

  /**
   * The user's "Toolkit systems" preference (§4.4e, Control Panel → Features, default `'auto'`).
   *
   * Raw and untyped on purpose: it arrives in a browser body, and `toolkitSystemsNoteForRequest` owns
   * the parse so the client and the server can never disagree about what a value means. Anything
   * unrecognised — junk, an older client that omits the field — resolves DOWN to `'auto'`, which
   * pushes NO block and costs nothing. A preference, not security: it spends nothing and reveals
   * nothing, it only decides whether the model reaches for the built-in controllers.
   */
  toolkitSystems?: string;

  /**
   * Which phase of the creation plan this turn is (§4.4e, `~/lib/agent/creation-plan`).
   *
   * Raw and untyped for the `toolkitSystems` reason: it arrives in a browser body and
   * `parseCreationPhaseId` owns the parse. Unrecognised resolves DOWN to `null` — "no phase" — which
   * behaves exactly as creation did before phases existed. That direction is deliberate: the `art`
   * phase carries the media tools, and inventing a more capable phase than the caller named is the
   * expensive direction.
   *
   * 🔴 Only consulted on a FIRST BUILD TURN. A forged value on an ordinary edit is ignored outright,
   * so this field can never widen a turn's tool set on its own.
   */
  creationPhase?: string;

  /**
   * 🔴 Does this project still owe a build? — resolved by the ROUTE from the project ROW, and the
   * reason `isFirstBuildTurn` is a fact again rather than a string match (`projectOwesBuild`).
   *
   * NOT part of the request body and it must never become one: it decides `owesFiles`, i.e. whether a
   * turn that writes nothing is REFUNDED. Everything else on this interface that arrives from a
   * browser resolves DOWN when it is unrecognised; this one cannot resolve at all, so it is derived
   * server-side from an ownership-checked row the client can only advance monotonically.
   *
   * Absent means "no project named" — a generation with nothing to build into is never a first build.
   */
  owesBuild?: boolean;

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

/**
 * What a settled turn cost, and what it would have cost at full price.
 *
 * `savings` rides here rather than being recomputed by the route because it must be derived from the
 * SAME usage and provider settlement billed from — a second derivation is a second chance to disagree
 * with the ledger, and the number is displayed next to the charge it is describing.
 */
export interface AgentSettlement {
  creditsCharged: number;
  balanceAfter: number;

  /** Null when there is nothing honest to say — see `describeSavings`. */
  savings: Savings | null;
}

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

  /**
   * The GATEWAY that served this turn — `KIE`, `Comet` or `Anthropic` (§4.2a).
   *
   * Recorded for the same reason as `modelTier` beside it: once `AUTO_MODEL_SELECT` can pick a rung
   * per turn, "which model ran" no longer implies "who ran it", and the two gateways price the same
   * model very differently (measured: Premium settled 1,017 credits on Anthropic against ~407 at
   * KIE-shaped rates). It is the field that makes a surprising bill traceable to a choice, and it is
   * what `/context` shows the user — a turn whose price moved because the gateway moved must be able
   * to say so.
   *
   * ⚠️ ALWAYS the provider that actually served, never `LLM_PROVIDER`: it is read from the same
   * `config.provider` that `settleGeneration` bills from, so the number and the label cannot disagree.
   */
  provider: PlatformProviderName;

  /**
   * The rung of the model tier ladder that actually RAN, and why (§4.6.1a).
   *
   * Recorded alongside the model rather than inferred from it: the model string could tell you a tier
   * only while every rung named a different model, which stops being true the moment an operator points
   * two rungs at one id (ordinary during a migration) — and it could never distinguish "the user chose
   * standard" from "the user chose Premium and was declined for credits". Both can be the same model and
   * very different facts about the ladder.
   */
  tier: ModelTierId;
  tierReason: ModelTierDecisionReason;

  /**
   * The Agent Reference documents this turn had in context, carried + newly loaded (Phase 2).
   *
   * 🔴 **This field is the carry-forward wire.** It rides out on the `agentMeta` annotation, the AI SDK
   * posts annotations back with the conversation, and `carriedReferenceIds` reads it on the NEXT turn to
   * rebuild the cached prefix — so it is not a metric that happens to be persisted, it is the mechanism.
   * A turn that under-reports here silently drops a document the model was relying on; one that
   * re-orders breaks the append-only rule and rewrites the prefix at the 2x cache-write rate.
   *
   * Named `blocks` because it is the same column and the same annotation the keyword router used, and
   * renaming it would have orphaned every conversation already in flight.
   */
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

  /**
   * How the configured provider puts the answer on the wire (`agent/delivery.ts`).
   *
   * On a `batched` provider nothing can appear until the turn ends — measured 2026-08-03, KIE holds a
   * whole 26KB answer and flushes it in the final second. The panel needs this to say so, because a
   * silence that is EXPECTED and a silence that means "broken" look identical from the outside, and
   * the user reasonably reads the second one.
   */
  deliveryMode: DeliveryMode;

  /**
   * What is happening to the REQUEST right now (a provider retry in flight), or null. Read on every
   * heartbeat tick — the retry loop runs inside `textStream`, where the heartbeat wrapper cannot see it.
   */
  currentActivity: () => AgentActivitySnapshot | null;

  /** Skills loaded during this generation — mutated by the tool loop as it runs. */
  toolContext: SkillToolContext;

  /** Resolves once the stream is fully drained. */
  usage: Promise<GenerationUsage>;

  /**
   * The facts the USER needs about how this turn ended (`~/lib/agent/turn-outcome.ts`). Resolves with
   * the usage. Written onto the `agentMeta` annotation so it is persisted with the message and
   * survives a reload — a warning about a broken build that vanishes on refresh is not a warning.
   */
  outcome: Promise<TurnOutcomeFacts>;

  /** Resolves with what we charged, once settled. Drives the client's credit badge (§4.6). */
  settlement: Promise<AgentSettlement | null>;

  /** e.g. "your Pro subscription lapsed, so this build used credits" (§4.6.1). Never an error. */
  notice?: string;

  /**
   * Subscribe to MCP tool-calls the model makes during this generation (§4.14). The route forwards each
   * to the client (which runs it in the WebContainer and posts the result back to `/api/agent/tool-result`).
   * No-op when the project has no MCP servers. Subscribe BEFORE draining `textStream`.
   */
  onMcpToolCall(listener: (event: McpToolCallEvent) => void): void;

  /** Preview dev-tools calls (`lib/preview/protocol.ts`) — same relay shape as MCP. */
  onPreviewToolCall(listener: (event: PreviewToolCallEvent) => void): void;

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
 * Does this turn carry the machine-written creation brief? — the FIRST BUILD turn (§4.4a).
 *
 * Exported and pure so the derivation has a real seam: it drives ten non-billing behaviours (skill
 * preload, sticky-skill suppression, `offerLoadSkill`, `requiresAction`, the premium lock, the tool
 * policy, the liveness copy), and a verifier once broke five of them at once with the whole suite
 * green. See `first-build-turn.spec.ts` for the paired assertions.
 *
 * Read from the LAST user message only, and from the NORMALIZED messages — a slash rewrite never
 * carries the marker, and a brief three turns back is a conversation ABOUT a build, not one.
 */
export function carriesCreationBrief(messages: Message[]): boolean {
  return lastUserText(messages).includes(CREATION_BRIEF_MARKER);
}

/**
 * 🔴 IS THIS A FIRST BUILD TURN? — two signals, and the MESSAGE one is now the legacy half.
 *
 * `carriesCreationBrief` was the whole answer until 2026-08-14, and it had been returning `false` on
 * every creation since the hidden brief was retired on 2026-08-08. Six days, ten protections off,
 * nothing red — the post-mortem is on `projectOwesBuild`, which is the signal that replaces it.
 *
 * Both are kept and OR'd, because they answer for different eras and neither covers the other:
 *
 *   - **`owesBuild`** — the project row still carries a `creation_handoff` with work outstanding.
 *     Server-derived, unforgeable, and true for every phase of a plan until the last one lands. This
 *     is the live path.
 *   - **`carriesBrief`** — the last user message contains `CREATION_BRIEF_MARKER`. Live only for
 *     phase messages (`creationPhaseMessage` emits it verbatim) and for the saved transcripts of
 *     projects built before the retirement, whose rows were cleared long ago. Dropping it would make
 *     a resumed old build an ordinary edit.
 *
 * ⚠️ OR, never AND. A phase message carries the marker AND its row owes a build, so the two agree on
 * the common path — but they disagree at both ends of a project's life, and requiring both would
 * reproduce the outage in the half nobody was looking at.
 *
 * Pure and exported for `carriesCreationBrief`'s reason: this one boolean drives ten behaviours, a
 * verifier once broke five of them at once with the suite green, and the derivation itself had no
 * seam at all — which is precisely how it went dead without a single test noticing.
 */
export function isFirstBuildTurnFor(input: { carriesBrief: boolean; owesBuild: boolean }): boolean {
  return input.carriesBrief || input.owesBuild;
}

/**
 * The turn's identity for the liveness panel — facts, in the same precedence the effort policy uses:
 * a repair is a repair even on a first build, and plan mode outranks an ordinary edit.
 *
 * Pure and exported for the same reason as `carriesCreationBrief`: it is the only consumer of
 * `isFirstBuildTurn` whose correctness is an ORDERING, and an ordering degrades silently (drop the
 * first-build arm and every build narrates itself as an ordinary edit — nothing throws).
 */
export function statusKindFor(input: {
  isRepair: boolean;
  isFirstBuildTurn: boolean;
  isDiscussTurn: boolean;
}): 'repair' | 'creation' | 'plan' | 'edit' {
  if (input.isRepair) {
    return 'repair';
  }

  if (input.isFirstBuildTurn) {
    return 'creation';
  }

  return input.isDiscussTurn ? 'plan' : 'edit';
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
  await Promise.all(
    [...new Set(providersToPrice(request.context).flatMap((platform) => marketPriceProvidersFor(platform)))].map((p) =>
      ensureMarketPrices(p, request.context),
    ),
  );

  /*
   * Same doorway: refresh the pinned Synty asset library so the prompt assembly below can read it
   * synchronously (`activeAssetLibrary`). Never throws; an unreadable store degrades to "no library"
   * and the prompt simply emits no block (§4.4d).
   */
  await ensureAssetLibraryForContext(request.context);

  /*
   * Same doorway, same posture: fire-and-forget, can never throw, keeps block 1 of every user's
   * prompt reading at 0.1x instead of writing at 2x (`prompt/cache-warmer.ts`).
   */
  ensureCacheWarmer(request.context);

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
   * 3. Model + key. Three ways the model is decided, in strict precedence:
   *
   *   a. BYOK (Pro) — the user's OWN key pays, so their explicit model choice is honored (§4.6.1).
   *   b. A paid RUNG of the model tier ladder — a credits user who picked one AND holds its threshold
   *      (§4.6.1a). This is the ONE user-facing model choice in credits mode: an enum tier ID the
   *      server maps to that rung's configured model, never a free-form model string.
   *      `decideModelTier` is the authority.
   *   c. The platform default — a FIXED, operator-configured model, no choices to make (§4.2a).
   *
   * Each rung's threshold protects a new user's free grant: 1000 granted < 1200/1500 default minimums,
   * so a fresh account cannot burn its grant on an expensive model before it has ever bought credits.
   * It binds on the BALANCE regardless of `BILLING_ENFORCED` — settlement debits either way (see
   * `premium.ts`).
   */
  const useByok = byok.allowed;

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
   * The FIRST BUILD turn — the turn that carries the machine-written creation brief (§4.4a).
   *
   * 🔴 **This is a BEHAVIOURAL fact, not a PRICING one, and the rename records that (2026-07-29).**
   * It was `isCreationTurn` and it drove eleven things, exactly one of which was money. Under the
   * project-first flow the flat charge moved to project REGISTRATION (`project_create`, migration 0015)
   * and this turn bills cost-derived like any other — so the ten protections it still drives (premium
   * lock, skill preload, sticky-skill suppression, discuss suppression, the media-only bounded loop,
   * `offerLoadSkill`, `requiresAction`, the media-note suppression, the liveness copy) had to stop
   * travelling under a name that reads as a price. Do not re-attach billing to it.
   *
   * Decoupling also closed a latent exploit: while this decided the price, a user who typed the marker
   * sentence verbatim bought flat pricing on an arbitrary turn. Now the worst a forged marker buys is
   * 24KB of inlined skills the user pays tokens for anyway.
   *
   * Computed from the NORMALIZED messages (a slash rewrite never carries the marker) because the
   * PREMIUM decision needs it: a first build on KIE-buffered Fable 5 dies at the gateway timeout before
   * its artifact can flush (see `premium.ts`). The tool policy below reuses the same value.
   */
  /*
   * 🔴 Read from the ROW as well as the message since 2026-08-14. `carriesCreationBrief` alone was
   * silently false on every creation for six days (`projectOwesBuild`); `owesBuild` is the
   * server-derived half and is what makes this a fact rather than a string match.
   */
  const isFirstBuildTurn = isFirstBuildTurnFor({
    carriesBrief: carriesCreationBrief(messages0),
    owesBuild: Boolean(request.owesBuild),
  });

  /*
   * WHICH PHASE of the creation plan this is (§4.4e), or `null` for the pre-phase single turn.
   *
   * 🔴 **`isFirstBuildTurn` stays TRUE for every phase, and that is the design.** Every phase message
   * carries `CREATION_BRIEF_MARKER`, so all ten protections above apply to all of them — including
   * `owesFiles` (which makes a phase that writes nothing a FAILURE rather than a billed success) and
   * `describeTurnOutcome`, which returns `finished` for any turn that is not a first build turn. A
   * phase that dropped the marker would silently become an ordinary edit: unable to report
   * `incomplete`, unable to be refunded for writing nothing.
   *
   * So this is ORTHOGONAL, not a replacement. Ten behaviours ask "is this a creation turn?"; exactly
   * two ask "what is this turn FOR?" — the tool policy (only `art` gets media) and the media note.
   *
   * 🔴 **Parsed only when `isFirstBuildTurn`.** A forged `creationPhase` on an ordinary edit is
   * ignored outright, so this field can never widen a turn's tool set on its own — the same
   * containment as the forged-marker analysis above.
   */
  const creationPhase = isFirstBuildTurn ? parseCreationPhaseId(request.creationPhase) : null;

  /*
   * 2. Credit gate — once, up front, and only for platform-paid generations. In-flight generations
   * are never killed for balance (§4.2.1), so this is the ONE moment we may refuse.
   *
   * No `minimumCredits`: no turn's cost is knowable pre-flight any more. The flat price this gate used
   * to enforce is charged at project creation now, before a generation exists (§4.4a).
   */
  const gate = await checkCreditGate({
    userId: user.id,
    byok: byok.allowed,
    context: request.context,
  });

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
   * The MODEL TIER LADDER, resolved AFTER the gate on purpose: resolving a rung reads the active
   * Marketplace price list and `getPlatformModel` throws while `LLM_MODEL` names an unpriced model —
   * the normal transient state mid-repricing — and an out-of-credits user should still get their 402,
   * not the operator's config error.
   *
   * ⚠️ This block used to call `getPremiumTier` UNCONDITIONALLY, which threw for every user on the
   * platform the moment `PREMIUM_MODEL` named a model the active list could not price — including the
   * overwhelming majority who had not asked for premium at all. `getModelTiers` never throws; a rung
   * that cannot be priced comes back `serveable: false` and `decideModelTier` declines it to standard.
   * One broken rung must never be able to stop the other two.
   */
  const byokModel = useByok && request.model ? request.model : undefined;

  /*
   * `getPlatformModel` is skipped entirely on the BYOK-with-a-model path, exactly as before: a Pro user
   * paying with their own key must not be blocked by a platform model they are not going to run.
   *
   * ⚠️ It is otherwise called MORE often than before, and that is a deliberate divergence rather than
   * an accident. The old code reached it only when premium was declined; now every non-BYOK turn
   * resolves the standard model, including a granted Premium one — because the standard rung
   * is the fallback for EVERY decline path, so a ladder that cannot name it is not a working ladder.
   * The visible consequence: with an unpriced `LLM_MODEL`, a premium user who used to sail past the
   * fault now gets the same loud `NotConfiguredError` everyone else already got. An unbillable standard
   * model is a real config fault, and having it surface for some users and not others is how it stays
   * unfixed.
   */
  const standardModel = byokModel ?? getPlatformModel(request.context, config.provider);
  const tiers = getModelTiers(standardModel, request.context);

  /*
   * A rung whose selector cannot be priced is reported ONCE, loudly, here — not left to be noticed.
   *
   * `getModelTiers` deliberately never throws (a broken rung must not take down the ones that work, the
   * 2026-07-25 `/api/me` lesson), and that trade has a cost this line pays back: the previous code's
   * unconditional `getPremiumTier` was an outage, but it was also an unmissable ALARM. Without this,
   * a misconfigured `PREMIUM_MODEL` is invisible platform-wide until a user happens to pick that rung
   * — and `ModelTierStatus.reason`, which explains exactly what the operator got wrong, would be
   * computed and read by nothing. Degrading a capability quietly is honest to the USER and must never
   * be quiet to the OPERATOR.
   */
  for (const broken of tiers.filter((row) => !row.serveable)) {
    logger.warn(`Model tier "${broken.id}" cannot be served: ${broken.reason ?? 'unknown reason'}`);
  }

  /*
   * `tier` wins over the legacy `premium` boolean; a client sending neither asks for standard. BYOK
   * short-circuits to standard because the user's own key pays, so there is no platform rung to buy —
   * `request.model` is already the honored choice on that path (§4.6.1).
   */
  const requestedTier = useByok ? 'standard' : (request.tier ?? (request.premium ? 'premium' : 'standard'));

  const tierDecision = decideModelTier({
    requested: requestedTier,
    balance: gate.mode === 'byok' ? 0 : gate.balance,
    tiers,
    isFirstBuildTurn,
  });

  const model =
    byokModel ??
    (tierDecision.tier === 'standard'
      ? standardModel
      : getTierModel(tierDecision.tier, request.context, config.provider));

  /**
   * Which wire this generation is on, derived from the model id (`model-families.ts`).
   *
   * Read by BOTH usage call sites below — settlement's accumulator and the persisted step log — so the
   * two numbers can never disagree about which namespace a cache counter lives under. `undefined` for
   * a BYOK model of some other vendor, which reads the historical `anthropic` namespace.
   */
  const modelFamily = familyOf(model);

  /*
   * A user who asked for a paid rung but was short of ITS threshold gets told, softly — never blocked
   * (§4.6.1). The notice names the rung they actually asked for: a hardcoded "premium" would quote a
   * Premium user the wrong threshold, which is worse than saying nothing.
   */
  const requestedRow = tiers.find((row) => row.id === requestedTier);
  const tierNotice =
    tierDecision.reason === 'below_minimum' && requestedRow
      ? tierDeclinedNotice(requestedRow.label, requestedRow.minimumCredits)
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
   * 7. 🔴 THERE IS NO DOC ROUTER ANY MORE (Phase 2, 2026-08-08).
   *
   * This step used to substring-match the whole conversation against a keyword table and paste the
   * winners into the cached prefix. Measured on the live prompt version, the input it was actually
   * matching was the platform's own HIDDEN creation brief, not the user's request — so
   * `"mario kart racer clone"` and `"a chess puzzle game"` produced **byte-identical sets of ten
   * documents, 61.6k tokens, `racing-system` included**, and the user's own words contributed nothing.
   *
   * The model now chooses from the Reference Library index in the cached prompt and calls
   * `load_reference` (`reference-tools.ts`) — the same fix applied to skills on 2026-07-26, and the
   * fourth keyword table removed from this codebase. `sources.ts` carries the full post-mortem.
   *
   * What is carried here is only what the model ITSELF loaded on an earlier turn: a document fetched on
   * turn 1 would otherwise be gone on turn 2, because the tool loop is server-side and its results never
   * enter the saved conversation. Append-only in first-seen order, read from the FULL message list —
   * see `carriedReferenceIds` for why each of those fails as a bigger bill rather than an error.
   */
  // `isFirstBuildTurn` is computed above the premium decision (raw request messages) and reused here.
  const store = getPromptStore();
  const carriedReferences: Array<{ id: string; body: string }> = [];

  for (const id of carriedReferenceIds(messages)) {
    const body = await store.readOnDemand(promptVersion.id, id);

    if (body) {
      carriedReferences.push({ id, body });
    }
  }

  /*
   * 8. Assemble system blocks, most-shared first (SPEC §4.2.8; restructured 2026-07-30).
   *
   * Anthropic caches the prefix UP TO each breakpoint, so ordering is what makes caching pay — and
   * the ordering principle is SHAREDNESS, not merely stability: the base prompt (byte-identical for
   * everyone) leads, the starter framework files (byte-identical for every project on a template pin)
   * come second, the per-CONVERSATION blocks (routed docs + skills, append-only) third, and the
   * per-TURN game-code files last. Everything behind the last breakpoint is uncached tail, where
   * changing costs nothing. This is a primary margin lever (§4.3.5): measured 2026-07-30, the
   * pre-restructure shape spent 82% of the platform's LLM bill on cache WRITES, because the
   * per-project and per-conversation bytes sat in front of (or inside) the biggest entry.
   */

  /*
   * The project's own `CLAUDE.md` (§4.2) is LIFTED OUT of the file map before the split — it becomes
   * the Project Instructions block further down, and the same bytes must never be sent twice (paid
   * twice per turn, and two copies to disagree after an edit).
   */
  const instructions = buildProjectInstructions(request.files);
  let contextFiles = request.files;

  if (instructions) {
    const { [instructions.key]: _lifted, ...rest } = request.files!;
    contextFiles = rest;

    if (instructions.truncated) {
      logger.warn(`Project CLAUDE.md exceeded ${MAX_INSTRUCTIONS_CHARS} chars and was truncated`);
    }
  }

  /*
   * ⚠️ `splitFilesForContext` is no longer used here (Inversion 3): the starter/game-code split existed
   * to shard a 36k-token dump across two cache breakpoints, and the manifest that replaced it is ~700
   * tokens on one. The module stays (hide-don't-delete) but the prefix no longer has two file blocks.
   */
  const projectFiles = contextFiles ?? {};

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
  const preloaded = await preloadSkills(slash?.skillName, isFirstBuildTurn);

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
  const carriedNames = carriedSkillNames({ isFirstBuildTurn, messages, invokedSkillName: slash?.skillName });
  const carried = await loadSkillBodies(carriedNames);

  /*
   * 🔴 THE INVOKED SKILL AND THE PRE-LOADED SKILLS SHARE ONE BREAKPOINT — because ANTHROPIC ALLOWS
   * EXACTLY FOUR AND WE HAD FIVE (found + fixed 2026-07-17).
   *
   * Since 2026-07-30 the routed doc blocks share it too (the freed breakpoint bought the starter-files
   * entry below). Merging is the STRUCTURAL fix rather than a counter: the skill blocks cannot become
   * two breakpoints again, and the doc set's breakpoint exists only when there is no skills block —
   * so five is unreachable by construction instead of by arithmetic someone has to redo.
   *
   * Computed HERE, before the assembly, because the doc-block push needs to know whether a skills
   * block will follow (the shared breakpoint rides on whichever comes last).
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

  const system: CoreMessage[] = [{ role: 'system', content: promptVersion.content, providerOptions: CACHE_CONTROL }];

  /*
   * 🔴 THE FILE MANIFEST — the model reads files, it is not shown them (Inversion 3, `FRESH-START.md`).
   *
   * Measured on a real project: the dump this replaces cost 36,453 tokens per turn to show 70 files,
   * of which the model reads about eight. The manifest is 704 — a 52x cut, and 47% of the entire
   * 77,699-token cached prefix. Bodies come from `read_file` (`file-tools.ts`).
   *
   * ⚠️ THE TWO-PART SPLIT IS GONE, DELIBERATELY. `stable-zones.ts` divided the dump into a
   * starter half and a game-code half so the starter bytes could sit ahead of the per-conversation
   * doc blocks and warm across projects. That was the right answer to "this block is enormous and
   * rewrites every turn" — and the block is now 704 tokens, so the whole apparatus (two entries, two
   * breakpoints, a mutability classifier) is machinery for a number that no longer exists. ONE entry,
   * sorted, on one breakpoint. Do not reintroduce the split "for cache reasons": at this size the
   * split costs more in breakpoints than it can ever save in bytes.
   */
  if (Object.keys(projectFiles).length > 0) {
    system.push({
      role: 'system',
      content:
        '# Project files\n\n' +
        'Every file in the project, with its size in bytes. Call `read_file` for the ones you need ' +
        "before you change them — do not guess at a file's contents, and do not assume a path that is " +
        'not listed here exists. Files marked [binary] or [opaque] cannot be read and never need to be.\n\n' +
        renderFileManifest(buildFileManifest(projectFiles)),
      providerOptions: CACHE_CONTROL,
    });
  }

  /*
   * The Synty asset library index (§4.4d) — platform-stable bytes that change only when an admin
   * PROMOTES a manifest, exactly like a prompt promotion. Placed after the starter files and before
   * the per-conversation doc blocks (sharedness ordering: this is identical for every user with the
   * feature on), and deliberately with NO breakpoint of its own — it is covered by whichever
   * breakpoint follows (docs/skills or the game-code entry), so `MAX_CACHE_BREAKPOINTS` is untouched.
   * When nothing is pinned there is NO block at all: telling the model about a library it cannot see
   * is how invented asset paths ship (`library-manifest.ts`).
   *
   * PER-USER GATE (§4.4d, Control Panel → Features → "Use Asset Library", default ON): a user who
   * switched the feature off gets NO block — and because the creation brief's sourcing rule is
   * conditional on the block's presence, the library then behaves as if it never existed for their
   * project. Only an explicit `false` opts out; absent means ON (older clients keep the default) —
   * the decision is `assetLibraryIndexForRequest`, pure + pinned in `library-manifest.spec.ts`.
   * The prefix simply has two stable shapes (with/without the block), both cache-warm on real traffic.
   */
  const assetLibraryIndex = assetLibraryIndexForRequest(request.useAssetLibrary, activeAssetLibrary());

  if (assetLibraryIndex) {
    system.push({ role: 'system', content: assetLibraryIndex });
  }

  /*
   * The "Toolkit systems" override (§4.4e) — the same sharedness class as the block above: a per-user
   * preference with only three possible values, stable for the whole conversation, so it sits here
   * rather than in the volatile tail and likewise carries NO breakpoint of its own.
   *
   * 🔴 The DEFAULT pushes NOTHING. `20-hard-constraints.md` already states the balanced position in
   * the cached prefix ("a menu, not a mapping"), so an `auto` note would restate the cached prompt at
   * full rate on every turn forever (§4.2.8) — a regression that throws nothing and just costs money.
   * Only an explicit `prefer`/`own` adds bytes, and only for the user who asked for it.
   */
  const toolkitSystemsNote = toolkitSystemsNoteForRequest(request.toolkitSystems);

  if (toolkitSystemsNote) {
    system.push({ role: 'system', content: toolkitSystemsNote });
  }

  /*
   * References the model loaded on an EARLIER turn of this conversation (`carriedReferenceIds`).
   *
   * Same slot the routed doc blocks used to occupy, and the same breakpoint arithmetic — but the set is
   * now a record of what the model asked for rather than a guess made before it spoke, so it grows by
   * one document at a time and only when a document was genuinely used.
   */
  carriedReferences.forEach((reference, i) => {
    system.push({
      role: 'system',
      content: `# Babylon Toolkit Reference: ${reference.id}\n\n${reference.body}`,

      /*
       * Reference blocks and the skills block SHARE one breakpoint (the 2026-07-30 restructure spent
       * the freed one on the starter files above): the set's breakpoint rides on the skills block when
       * one exists, else on the last reference block. `skillBlocks` is computed above the push for
       * exactly this decision.
       */
      ...(i === carriedReferences.length - 1 && skillBlocks.length === 0 ? { providerOptions: CACHE_CONTROL } : {}),
    });
  });

  // The merged skills block — computed above the assembly; carries the shared docs+skills breakpoint.
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
   * 🔴 PREVIEW DEV-TOOLS (`lib/preview/protocol.ts`) — the agent asking the RUNNING game questions.
   *
   * Same relay as MCP, for the same reason: the game runs in the user's browser and the server can
   * never touch it (§5). Offered on EVERY turn that has a project, including a discuss/plan turn — they
   * are pure READS (`evaluate` runs in the user's own preview and writes nothing to the sandbox), and a
   * turn that can discuss a bug but not look at it is the dangling-instruction failure `read_file` was
   * added to fix, one layer out.
   *
   * They cost nothing when unused: a tool definition the model does not call is a few hundred cached
   * tokens, and without them `bt-execute`'s self-verification can only narrate about code it read.
   */
  const previewListeners: Array<(event: PreviewToolCallEvent) => void> = [];
  const emitPreviewCall = (event: PreviewToolCallEvent) => {
    for (const listener of previewListeners) {
      listener(event);
    }
  };

  /*
   * 🔴 NO PROJECT ID MEANS THREE TOOL FAMILIES VANISH, SO SAY SO.
   *
   * `previewTools`, `mediaTools` and the MCP relay tools are all gated on this one field. A turn that
   * arrives without it runs with none of them, bills normally, and throws nothing — measured live
   * 2026-08-10, where a reload beat the render commit and the model reported "I do not have
   * evaluate_in_game this turn" on a project that was open on screen (`~/lib/chat/turn-identity.ts`).
   *
   * The client now sends the LIVE store value on every path, so this should not happen. Which is
   * exactly why it is logged rather than tolerated: if it ever appears again, the fix is upstream and
   * this line is the only thing that would show it.
   */
  if (!request.projectId) {
    logger.warn(
      `Generation ${generationId} has no projectId — preview, media and MCP tools are all unavailable for this turn`,
    );
  }

  const previewTools = request.projectId
    ? createPreviewTools({
        generationId,
        userId: user.id,
        abortSignal: request.abortSignal,
        emit: emitPreviewCall,
      })
    : {};

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

  /*
   * Whether media tools exist at all is the MEDIA provider's key, not the LLM provider's (§4.16).
   * This gated on `config.kieApiKey`, which is the same question only for as long as KIE is the only
   * gateway that renders: a Comet media deploy would have advertised no media tools at all while
   * holding a working key, and the model would have drawn the art in CSS — the §4.16 pathology where
   * a capability that exists is unreachable, announced only by the model saying so.
   *
   * 🔴 `resolveMediaProvider`, never `mediaProviderFor`, because this is STRAIGHT-LINE code on the
   * hot path: a media provider with no client, or a typo'd `MEDIA_PROVIDER`, must cost the turn its
   * media tools and nothing else. Resolving it eagerly here returned HTTP 500 for the whole
   * generation on a Comet box — no chat, because image generation was unavailable.
   */
  const mediaProvider = resolveMediaProvider(request.context);

  const mediaTools =
    request.projectId && mediaProvider
      ? createMediaTools({
          userId: user.id,
          projectId: request.projectId,
          provider: mediaProvider,
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
   * annotation must all agree, and `discussModeNote` owns the rule.
   *
   * It no longer takes `isFirstBuildTurn`: a first build turn CAN be a plan turn, deliberately (the
   * handoff card's "Plan my brief"). `owesFiles` below is what keeps that honest — a discuss turn is
   * excused from producing files rather than failed for it.
   */
  const discussNote = discussModeNote({ chatMode: request.chatMode });

  /*
   * 🔴 THE TURN'S READ BUDGETS, RESOLVED ONCE FOR THE WHOLE GENERATION (`budgets.ts`, owner 2026-08-09).
   *
   * One resolve, deliberately: these numbers are NOT independent. `maxToolRounds` is DERIVED from
   * `maxReferenceLoads`, so resolving them separately at the three seams that need them (the policy
   * here, the reference tool, the file tool) is how a raised reference budget ends up giving a creation
   * more rounds than an ordinary turn — the one relationship `tool-policy.spec.ts` pins — with nothing
   * throwing. Resolved HERE rather than beside the tool contexts because the policy is decided first.
   */
  const budgets = resolveAgentBudgets(request.context);

  const toolPolicy = toolPolicyForTurn({
    isFirstBuildTurn,
    creationPhase,
    hasMcpTools,
    hasMediaTools: Object.keys(mediaTools).length > 0,
    preloadedCount: preloaded.length,
    isSlash: Boolean(slash),
    isDiscussTurn: discussNote !== null,
    budgets,
  });
  const allowTools = toolPolicy.allowTools;

  /*
   * The project's own `CLAUDE.md` (§4.2), promoted from "a file" to "instructions".
   *
   * Computed up at the top of step 8 (the lifting must happen before the stable/mutable split ever
   * sees the map); PUSHED here, just ahead of the game-code files, INSIDE the last breakpoint's
   * segment — it can be up to `MAX_INSTRUCTIONS_CHARS` and changes only when the user edits it, so
   * caching it with the game code is the cheap placement. It outranks the notes below, which moved
   * to the uncached tail (2026-07-30).
   */
  if (instructions) {
    system.push({ role: 'system', content: instructions.block });
  }

  /*
   * ⚠️ The game-code file block used to go out here (breakpoint 4), carrying every mutable file's
   * BODY. It is gone: the manifest above lists the whole project in ~700 tokens and `read_file`
   * serves the bodies. That frees a cache breakpoint AND removes the per-turn rewrite this block's
   * own comment was written to justify — the cheapest entry is the one that is not sent.
   */

  /*
   * Volatile project-context notes (§4.9 assets, §4.14 MCP tools, §4.15 Game Backend).
   *
   * In the UNCACHED tail — which this comment used to claim while the code pushed them BEFORE the
   * file-context breakpoint, i.e. inside its cached prefix, where a backend connect, an asset add or
   * a `.mcp.json` edit re-wrote the whole file entry at 2× (the defect CLAUDE.md flagged 2026-07-19;
   * fixed with the 2026-07-30 restructure). Here, past the last breakpoint, a note appearing or
   * changing invalidates nothing; they are small, and re-sending them uncached each turn costs less
   * than one rewrite did.
   */
  for (const note of buildProjectNotes({
    files: request.files,
    gameBackend: request.gameBackend,
    assetNotes: request.assetNotes,
    mcpLiveTools: request.mcpLiveTools,
  })) {
    system.push({ role: 'system', content: note });
  }

  /*
   * Discussion mode (§4.2.9) — past the last breakpoint, so toggling Build<->Plan invalidates
   * nothing. (Decided once, up by the tool policy — this is only the placement.)
   */
  if (discussNote) {
    system.push({ role: 'system', content: discussNote });
  }

  /*
   * 🔴 WHAT THIS PHASE OWES (§4.4e) — same placement rule as `discussNote` above, and for the same
   * reason: it changes on EVERY phase, so anywhere ahead of a breakpoint would re-write the
   * file-context entry at the 2x cache-WRITE rate four times per build.
   *
   * This is what makes a phase a phase. `creationPhase` alone tells the model which step it is on and
   * never what the step is FOR — which is the monolithic turn again, wearing a label. `creationPhase`
   * is already `null` for anything that is not a first build turn, so an ordinary edit can never
   * receive one.
   */
  const phaseNote = creationPhaseNote(creationPhase);

  if (phaseNote) {
    system.push({ role: 'system', content: phaseNote });
  }

  /*
   * The media protocol (§4.16) — same placement rule as `discussNote` above, and for the same reason:
   * it varies per turn (a project without a KIE key gets no media tools), so anywhere earlier would
   * re-write the ~110k-token file-context entry at 2x whenever it appeared or vanished.
   *
   * ⚠️ **This predicate WAS `toolPolicy.toolset === 'all' && …`, and the art phase made it a lie** —
   * exactly what the previous version of this comment warned would happen to a proxy for the tool set
   * ("the next turn shape that reads it inherits a lie"). The art phase is `creation` AND has media,
   * so the re-derived answer said no while the tool object said yes: the model would have been handed
   * `generate_image` with no statement of the protocol. It reads the policy's OWN answer now, which is
   * the single value the tool object is also built from, so the two cannot disagree.
   */
  const mediaNote = mediaProtocolNote({
    hasMediaTools: toolPolicy.allowsMedia,
    isFirstBuildTurn,
    creationPhase,
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
   *
   * ⚠️ Deliberately NOT family-gated (checked 2026-08-04 when the KIE provider gained three families).
   * The four-breakpoint ceiling is an Anthropic API limit, and on a `gpt-*`/`gemini-*` turn the
   * `providerOptions` this counts are `anthropic`-NAMESPACED, so the other vendors' SDKs ignore them
   * outright — they cost nothing and can never 400. The guard therefore neither refuses nor mis-measures
   * a non-Claude turn; it just never fires on one, because the count is driven by prompt ASSEMBLY, which
   * is family-independent. Adding a family branch here would be a second rule to keep in step with the
   * assembly above, for zero behavioural difference.
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
  /*
   * The same two-set shape, for references (`reference-tools.ts`).
   *
   * `loaded` is seeded with what earlier turns pulled in — those bodies are in the cached prefix above,
   * so a re-request must return one sentence rather than a second copy of a 55KB document. Whatever
   * ends up in it is recorded as this generation's `referencesLoaded`, which is what `carriedReferenceIds`
   * reads next turn; dropping the carried ids here would make the carried set flicker between turns and
   * rewrite the prefix each time.
   */
  const referenceContext: ReferenceToolContext = {
    versionId: promptVersion.id,
    loaded: new Set(carriedReferences.map((r) => r.id)),
    loadedThisTurn: new Set<string>(),
    maxLoads: budgets.maxReferenceLoads,
  };

  /*
   * `read_file` reads the SAME map the manifest was rendered from, so what the model is offered and
   * what it can fetch can never disagree. The budgets are per-turn and live here, not in the tool,
   * because the tool is recreated per call site and a budget on a fresh object is no budget at all.
   *
   * `planCharsThisTurn` is the RESERVED `_specs/**` pool: a `/bt-execute` turn reads its own plan to
   * know what to build and to verify its Acceptance clause, and charging that to the same pool as the
   * project source means the harder the turn looks at the code, the less able it is to check its own
   * work. Separate ceiling, never an exemption — see `budgets.ts`.
   */
  const fileToolContext = {
    files: projectFiles,
    readThisTurn: new Set<string>(),
    charsThisTurn: { total: 0 },
    planCharsThisTurn: { total: 0 },
    budgets,
  };

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
    offerLoadSkill: !isFirstBuildTurn,
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

  /*
   * 🔴 `load_reference` IS IN EVERY TOOL SET, INCLUDING CREATION'S (Phase 2, 2026-08-08).
   *
   * The Babylon Toolkit documentation is no longer baked into the prompt — the base prompt carries the
   * Reference Library INDEX and this tool returns a document by id. So withholding it from any turn
   * means telling the model which documents exist and then refusing to hand any of them over, which is
   * the dangling-instruction failure `spec/skills.md` records for `load_skill` and which the baked
   * router index has been committing for months ("FETCH THE MATCHING SUB-DOCUMENTS" — with no tool).
   *
   * The six-round pathology cannot come back through it: `MAX_REFERENCE_LOADS` is enforced inside
   * `execute` (never by withdrawing the tool, never as a zod constraint), the index instructs the model
   * to load BEFORE it starts writing, and every turn's `maxSteps` is derived so the budget cannot eat
   * the answer step.
   */
  const referenceTools = createReferenceTools(referenceContext);

  /*
   * 🔴 MEDIA ON EXACTLY ONE CREATION PHASE (`phaseAllowsMedia`, tool-policy.ts — the full reasoning
   * and the live step log are there). The build phases write the project; the `art` phase renders the
   * art the design asked for. A creation with NO plan gets no media at all, exactly as before phases.
   */
  /*
   * 🔴 `read_file` IS IN EVERY TOOLSET, INCLUDING THE READ-ONLY ONE. The project files are no longer
   * IN the prompt (Inversion 3) — the manifest lists them and this is the only way to see a body. A
   * turn that can discuss code but not read it is the dangling-instruction failure in its purest
   * form: the model is shown a list of files and refused every one of them. It is a pure read, so it
   * is safe on a discuss turn by construction.
   */
  const fileTools = createFileTools(fileToolContext);

  const tools = (
    toolPolicy.toolset === 'creation'
      ? /*
         * `allowsMedia` is the policy's own answer, not a re-derivation from the toolset name: two
         * turns can both be `creation` and differ on it, so a predicate reconstructed here is one
         * that drifts from what the policy decided — and this one decides whether the turn can spend
         * credits on renders.
         */
        {
          ...fileTools,
          ...previewTools,
          ...referenceTools,
          ...createRepairTool(),
          ...(toolPolicy.allowsMedia ? mediaTools : {}),
        }
      : toolPolicy.toolset === 'skills-only'
        ? {
            ...fileTools,
            ...previewTools,
            ...createSkillTools(toolContext),
            ...referenceTools,
            ...researchTools,
            ...createRepairTool(),
          }
        : {
            ...fileTools,
            ...previewTools,
            ...createSkillTools(toolContext),
            ...referenceTools,
            ...mcpRelayTools,
            ...mediaTools,
            ...researchTools,
            ...createRepairTool(),
          }
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

  /*
   * The rung is logged BESIDE the model, never left to be inferred from it (see `AgentGeneration.tier`).
   * The reason rides along whenever it is not a plain standard turn, so a declined rung is visible in
   * the log rather than looking identical to a user who never asked.
   */
  const tierLog =
    tierDecision.tier === 'standard' && tierDecision.reason === 'standard_requested'
      ? 'tier=standard'
      : `tier=${tierDecision.tier}(${tierDecision.reason})`;

  logger.info(
    `Generation: model=${model} ${tierLog} prompt=${promptVersion.id} refs=[${carriedReferences.map((r) => r.id).join(',')}] ` +
      `${slash ? `slash=/${slash.skillName} ` : ''}${isRepair ? `repair(${request.repairAttempt ?? 1}) ` : ''}` +
      `mode=${useByok ? 'byok' : 'platform'}${isFirstBuildTurn ? ' CREATION' : ''}${discussNote ? ' DISCUSS' : ''} ` +
      `tools=${allowTools ? (toolPolicy.toolset === 'all' ? 'on' : toolPolicy.toolset) : `off (${isFirstBuildTurn ? 'creation' : 'skills pre-loaded'})`} ` +
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
   * Did the creation completeness pass run (`creation-completion.ts`)?
   *
   * Unlike the two flags above this is expected on EVERY creation, so it is not a failure signal by
   * itself — it is how the step log stays a true account of how many streams the turn ran. What is
   * worth watching is the pass WRITING files: that means a creation ended half-written, which is the
   * defect this pass covers rather than fixes, and the cause is upstream of it.
   */
  let creationCompletionPass = false;

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

  /**
   * The live provider-level activity, for the liveness panel only (`agent/heartbeat.ts`).
   *
   * Never billing, never context — a display fact. It is a plain `let` read through a getter on the
   * handle rather than pushed at the heartbeat, because the heartbeat wrapper is installed OUTSIDE
   * this function (in `api.agent.ts`, around `textStream`) and therefore cannot see the retry loop
   * that runs inside it. That invisibility is exactly why the panel reported "Thinking" through four
   * minutes of provider retries.
   */
  let activityState: AgentActivitySnapshot | null = null;

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

  /** One warning per generation when the family's usage namespace is absent — see the step handler. */
  let warnedMissingUsageNamespace = false;
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

        /*
         * The SAME reader settlement bills from (`usage-metadata.ts`) — never a second literal. The
         * step log is what the Admin dashboard diagnoses margin from, so a log that reads a different
         * namespace than the bill would make every cache investigation start from a wrong number.
         */
        const cache = extractStepCacheTokens(step.providerMetadata, modelFamily);

        if (!cache.sawNamespace && shouldWarnMissingUsageNamespace(modelFamily) && !warnedMissingUsageNamespace) {
          /*
           * ONCE per generation, and only on a family whose cache we PRICE. "Nothing was cached" is
           * silent-zero and ordinary; "the counter we bill from is not there" means every generation
           * on this family is under-reporting cache tokens with the credit total going DOWN, which
           * reads as a cheaper turn. Per-step would be noise; never would be the §4.2.8 silent failure.
           */
          warnedMissingUsageNamespace = true;
          logger.warn(
            `Usage metadata has no "${usageNamespaceFor(modelFamily)}" namespace for ${model} ` +
              `(family ${modelFamily}) — cache tokens are being billed as zero. This is NOT "nothing was ` +
              'cached": the counter itself is absent, so the provider adapter may have changed shape.',
          );
        }

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
          cacheRead: cache.cacheReadTokens,
          cacheWrite: cache.cacheCreationTokens,
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
            `${step.usage?.promptTokens ?? 0} in (+${cache.cacheReadTokens} cached, ` +
            `${cache.cacheCreationTokens} written)` +
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

        if (!emittedAction) {
          const window = actionScanTail + part.textDelta;
          emittedAction = window.includes(ACTION_OPEN_TAG);
          actionScanTail = window.slice(-(ACTION_OPEN_TAG.length - 1));
        }

        /* Opens vs closes — an excess of opens means the stream stopped mid-action (see above). */
        openedActions.push(part.textDelta);
        closedActions.push(part.textDelta);

        if (!emittedArtifact) {
          const window = artifactScanTail + part.textDelta;
          emittedArtifact = window.includes(ARTIFACT_TAG);
          artifactScanTail = window.slice(-(ARTIFACT_TAG.length - 1));
        }

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
    accumulateStepUsage(totals, steps as unknown as UsageStep[], modelFamily);

    finishReason = await result.finishReason;
    lastStepToolCalls = steps?.[steps.length - 1]?.toolCalls?.length ?? 0;
    toolRounds += Math.max(0, (steps?.length ?? 1) - 1);
  }

  /*
   * 🔴 The turn's OUTCOME, for the user (`~/lib/agent/turn-outcome.ts`).
   *
   * Deferred exactly like `usage`, and for the same reason: the flags that decide it
   * (`forcedContinuation`, the completeness pass, the final `finishReason`) are only known once the
   * stream has drained, but the handle is consumed before that. Without this the facts stayed local
   * to `run()` and reached only the `generations` DB row — machine-visible, user-invisible, which is
   * how a truncated build came to show `🎮 Your game is ready`.
   */
  let resolveOutcome: (facts: TurnOutcomeFacts) => void;
  const outcomePromise = new Promise<TurnOutcomeFacts>((resolve) => {
    resolveOutcome = resolve;
  });

  let resolveUsage: (usage: GenerationUsage) => void;
  const usagePromise = new Promise<GenerationUsage>((resolve) => {
    resolveUsage = resolve;
  });

  let resolveSettlement: (settlement: AgentSettlement | null) => void;
  const settlementPromise = new Promise<AgentSettlement | null>((resolve) => {
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

  /*
   * Did this turn write anything? Tracked as a STICKY flag over the raw stream, not sniffed out of
   * `assistantText` — that buffer stops growing at `MAX_RECOVERED_CHARS`, so a turn that narrated past
   * the cap before finally emitting its artifact would read as "wrote nothing". Harmless while the only
   * reader was the rescue (worst case: one extra pass); NOT harmless now that `isFailedBuildTurn`
   * refunds on it, where the same miss gives a completed build away for free.
   *
   * The tail carries `ACTION_OPEN_TAG.length - 1` chars between deltas because the provider is free to split
   * `<boltAction` across two of them, and a containment test on each delta alone would never see it.
   */
  let emittedAction = false;
  let actionScanTail = '';

  /*
   * 🔴 AND DID EVERY ACTION IT OPENED ACTUALLY CLOSE?
   *
   * The action runner executes a CLOSED action; an unclosed one writes no file. Measured live
   * 2026-08-10 (`gen_msn0zl5h_44wpni`): one `<boltArtifact`, one `<boltAction`, ZERO closes of either,
   * ending mid-diff on `>>>>>>> REPLACE`. 240 credits, no file, an artifact card with no rows under it
   * — and no rescue, because `emittedAction` was true on the strength of the opening tag alone.
   *
   * Counted separately from `emittedAction` rather than replacing it: `creation-completion.ts` reads
   * that flag with the meaning "it emitted ONE action", and quietly changing what it means would move
   * a second decision nobody re-checked.
   *
   * Both tags need their own scan tail — a provider may split either across deltas, and sharing one
   * tail between two different-length needles silently truncates the shorter one's lookback.
   */
  const openedActions = createTagCounter(ACTION_OPEN_TAG);
  const closedActions = createTagCounter(ACTION_CLOSE_TAG);

  /*
   * Did the model COMMIT to producing files? An opened artifact is the strongest evidence a turn was a
   * build rather than an answer, and `isFailedBuildTurn` needs that evidence: the creation brief rides
   * on whatever the user types first, so their first message can legitimately be a question.
   *
   * Same rolling-tail scan, same reason — the tag can arrive split across two deltas.
   */
  const ARTIFACT_TAG = '<boltArtifact';
  let emittedArtifact = false;
  let artifactScanTail = '';

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

          /*
           * THE GATEWAY IS THE SUSPECT HERE, AND ONLY HERE (`provider-select.ts`).
           *
           * `shouldRetryGeneration` has already established the narrow thing the `AUTO_MODEL_SELECT`
           * cooldown is about: the provider broke BEFORE producing a single billed token. That is a
           * fact about the gateway, unlike the `failed` flag below it — a generation can fail for a
           * zod violation, an unproductive turn or a refusal while the gateway behaved perfectly, and
           * cooling a healthy rung on that evidence moves every following turn onto a COLD prefix
           * (~8x one prefix in cache writes). Wrong here is expensive and throws nothing, so the
           * signal stays exactly as narrow as the evidence.
           *
           * No-op when the ladder is off: nothing reads the map, and it is bounded by the provider
           * count either way.
           */
          recordProviderFailure(config.provider, Date.now());

          /*
           * Tell the liveness panel this is a RETRY, not a think (`heartbeat.ts` `AgentStatusActivity`).
           * Recorded here — where the fact is actually known — and read by the heartbeat at tick time;
           * `since` makes it self-clearing the moment the next attempt streams anything.
           */
          activityState = {
            activity: 'retrying',
            attempt: attempt + 1,
            maxAttempts: MAX_PROVIDER_RETRY_ATTEMPTS,
            since: Date.now(),
          };

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

        const priorMessages = stripReplayedReasoning((await first.response).messages);

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

      /*
       * A creation MUST write files (§4.4b). ONE predicate, read by both the rescue below and the
       * terminal verdict after it — if those two ever disagreed about which turns owe files, a turn
       * could be rescued for not writing and then billed as a success for the same thing.
       */
      const owesFiles = isFirstBuildTurn && !discussNote;

      if (
        shouldRescueUnproductiveTurn({
          aborted: Boolean(request.abortSignal?.aborted),
          alreadyContinued: forcedContinuation,
          emittedAction,

          /*
           * Cut off mid-action: it opened more actions than it closed, so the runner executed the
           * unclosed one never, and the file was not written. See `truncatedAction` in
           * `unproductive.ts` for the live measurement this closes.
           */
          truncatedAction: isTruncatedAction(openedActions.count, closedActions.count),
          toolCalls: toolCallCount,
          textChars: visibleTextChars,
          outTokens: totals.completionTokens,

          /*
           * A creation MUST write files (§4.4b). Measured 2026-07-27: a creation retried after a KIE
           * `Internal error` answered with 31,852 chars of prose and no `<boltAction>` — the project
           * never built and the user paid for a description of a game. Plan turns are excluded by
           * construction (they are prose by guarantee, §4.2.9) and so are ordinary edits.
           */
          requiresAction: owesFiles,
        })
      ) {
        unproductiveRescue = true;
        logger.warn(
          `Unproductive turn (${visibleTextChars} chars text on ${totals.completionTokens} out tokens, no actions, ` +
            'no tool calls) — the model announced work it did not do; forcing one corrective pass',
        );

        const priorMessages = stripReplayedReasoning((await first.response).messages);

        const rescue = startStream(
          [...system, ...coreMessages, ...priorMessages, { role: 'user', content: UNPRODUCTIVE_RESCUE_PROMPT }],
          false,
        );

        yield* drain(rescue);
      }

      /*
       * 🔴 A CREATION IS NEVER ALLOWED TO END HALF-WRITTEN (`creation-completion.ts`).
       *
       * The third sibling, and the one the other two could not see. Both guards above ask "did this turn
       * do ANYTHING?" — a forced continuation needs `finishReason: 'tool-calls'`, the unproductive
       * rescue needs zero actions. Measured: a creation wrote ONE file, said "Writing the full project
       * now.", and stopped `stop` with 7,165 chars of text. It passed all three checks and billed as a
       * success, leaving the user a stock starter with one orphan class in it.
       *
       * So the model is asked whether it finished, once, against a now-warm prefix. Complete → a short
       * closing message (the one the brief already asks for). Incomplete → it finishes the project the
       * user has already paid for. `alreadyContinued` keeps it mutually exclusive with both guards
       * above, so no turn can ever run three streams.
       */
      if (
        shouldVerifyCreationCompleteness({
          isFirstBuildTurn,
          isDiscussTurn: Boolean(discussNote),
          aborted: Boolean(request.abortSignal?.aborted),
          alreadyContinued: forcedContinuation || unproductiveRescue,

          /*
           * `length` is the provider saying it stopped at the OUTPUT CEILING, not that the model
           * finished — measured live at exactly 64,000 out / 111,403 chars, mid-project. It is the one
           * signal that overrides `alreadyContinued`, because it PROVES truncation rather than
           * suggesting it, and the forced continuation that precedes it is usually where the project
           * was being written.
           */
          truncatedByLength: finishReason === 'length',
          emittedAction,
        })
      ) {
        creationCompletionPass = true;
        logger.info('First build turn finished — running the completeness pass before closing the turn');

        const priorMessages = stripReplayedReasoning((await first.response).messages);

        const completion = startStream(
          [...system, ...coreMessages, ...priorMessages, { role: 'user', content: CREATION_COMPLETION_PROMPT }],
          false,
        );

        yield* drain(completion);
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

        /*
         * When the wire tap saw a REFUSAL end this generation, say so — "empty response" sends the
         * user hunting for a transient fault, and the retry ladder keys on that sentence, so a
         * refusal (which a same-model retry only repeats) must carry different copy. With the
         * server-side fallback wired, reaching here on a refusal means every model in the chain
         * declined. Peek, not drain: the `finally` below still records the raw stops.
         */
        const refusal = peekStopReasons().find((s) => s.stopReason === 'refusal');

        throw new Error(refusal ? describeRefusal(refusal) : EMPTY_RESPONSE_ERROR);
      }

      /*
       * The sibling of the check above, and the one `gen_msixapaq_i871b6` walked straight through:
       * a first build turn that produced plenty of TEXT and wrote no FILES (`unproductive.ts`).
       *
       * Deliberately LAST — after the forced continuation and after the rescue, so this is the verdict
       * on a turn that has already been given every second chance the pipeline has. Reaching here means
       * the user asked for a game, was billed in full, and has nothing. `failed` routes it to the §4.6
       * auto-refund exactly like the empty-response case, and the error gives them something to Retry
       * (§4.12) instead of a chat that claims success over an empty project.
       */
      if (
        isFailedBuildTurn({
          aborted: Boolean(request.abortSignal?.aborted),
          requiresAction: owesFiles,
          emittedAction,

          /*
           * Positive evidence the model was BUILDING rather than answering (`unproductive.ts`). The
           * brief rides on whatever the user types first, so their first message can legitimately be a
           * question — and without this that gets a "the build wrote no files" error over a good answer.
           *
           * `unproductiveRescue` is excluded on purpose: it fires on any first-turn prose, so counting
           * it would let our own reaction manufacture the evidence it is supposed to test for.
           */
          attemptedBuild: emittedArtifact || toolCallCount > 0 || forcedContinuation,
        })
      ) {
        failed = true;

        logger.warn(
          `Build turn ${generationId} wrote no files (${visibleTextChars} chars text, ` +
            `${toolCallCount} tool calls, artifact=${emittedArtifact}, ` +
            `forcedContinuation=${forcedContinuation}, rescue=${unproductiveRescue}) — ` +
            'failing it so the §4.6 auto-refund fires',
        );

        throw new Error(NO_FILES_WRITTEN_ERROR);
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
       * A gateway that STREAMED is a healthy gateway, whatever became of the turn afterwards
       * (`provider-select.ts`). Deliberately keyed on billed output rather than on `failed`, for the
       * mirror-image reason the failure above is keyed on the retry: our own downstream failures are
       * not evidence against the provider, and leaving a stale cooldown standing would keep traffic
       * off the cheapest rung — and off its warm prefix — long after it recovered.
       */
      if (totals.completionTokens > 0) {
        recordProviderSuccess(config.provider);
      }

      /*
       * Resolved in the same `finally` as the usage, so it can never be missed on an error path — a
       * turn that failed is exactly one whose outcome the user most needs told.
       */
      resolveOutcome({
        isFirstBuildTurn,
        finishReason,
        forcedContinuation,
        unproductiveRescue,
        completionPassWroteFiles: creationCompletionPass && emittedAction,
        wroteFiles: emittedAction,
        aborted: Boolean(request.abortSignal?.aborted),
      });

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

        /*
         * NO `flatCredits`, NO `maxCredits` — every turn settles cost-derived, including the first
         * build (§4.4a, 2026-07-29). The flat price it used to carry moved to project REGISTRATION,
         * where it is charged once under its own ledger reason (`project_create`) before any
         * generation exists. `decideCredits` keeps both levers, pure and tested, with no caller here:
         * ceasing to pass them is the pricing decision, deleting them would throw the capability away.
         */
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

      const chargedAfterRefund = settlement && !failed ? settlement.creditsCharged : 0;

      resolveSettlement(
        settlement
          ? {
              creditsCharged: chargedAfterRefund,
              balanceAfter: failed ? settlement.balanceAfter + settlement.creditsCharged : settlement.balanceAfter,

              /*
               * What the gateway saved the user on THIS turn (`billing/savings.ts`).
               *
               * Derived from `chargedAfterRefund`, not from `settlement.creditsCharged`: a failed turn
               * is refunded to zero, and a "you saved 300 credits" line beside a charge that was handed
               * straight back describes a transaction that did not happen. `describeSavings` returns
               * null for a zero charge, so the refunded case reports nothing by construction.
               */
              savings: describeSavings({
                usage: totals,
                model,

                /* The raw USD settlement just computed — the same number recorded on the row. */
                actualCostUsd: settlement.rawCostUsd,
                creditsCharged: chargedAfterRefund,
              }),
            }
          : null,
      );

      /*
       * A refusal fallback that fired is worth a loud line the moment it happens, not just a field
       * in the record: it means the requested model declined this turn and another model served it.
       */
      const fallbackHandoffs = drainFallbackHandoffs();

      for (const handoff of fallbackHandoffs) {
        logger.warn(
          `Generation ${generationId}: ${handoff.from} declined via safety classifier — served by ${handoff.to} (server-side fallback)`,
        );
      }

      /*
       * Tell the cache warmer that ORGANIC traffic just warmed the shared prefix. Its next cycle then
       * no-ops instead of paying a read to discover what this generation already did — which is what
       * makes the warmer's steady-state cost proportional to how QUIET the platform is, rather than a
       * flat toll it charges around the clock (`prompt/cache-warmer.ts` `shouldSkipWarmCycle`).
       *
       * Fire-and-forget and free: a module-level timestamp, no IO. It is deliberately stamped here
       * rather than per-step — one read anywhere in the turn means the prefix is warm.
       */
      if (totals.cacheReadTokens > 0) {
        recordCacheRead();
      }

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

        /*
         * The documents this turn HAD, carried + newly loaded (Phase 2). Same column that recorded the
         * keyword router's picks, now recording the model's — and it is what `carriedReferenceIds`
         * reads back on the next turn, so it must include the carried ids or the set flickers.
         */
        blocksLoaded: [...referenceContext.loaded],
        promptTokens: totals.promptTokens,
        completionTokens: totals.completionTokens,
        totalTokens: totals.totalTokens,
        cacheReadTokens: totals.cacheReadTokens,
        cacheCreationTokens: totals.cacheCreationTokens,
        toolRounds,

        /*
         * WHAT KIND of turn this was (migration 0019). Already decided before a token was spent, and
         * paired with `durationMs` it is what makes "how long does a typical edit take?" answerable at
         * all — the question `agent/delivery.ts`'s baseline had to answer with a hand-picked constant
         * because this was computed on every turn and persisted on none of them.
         */
        statusKind: statusKindFor({ isRepair, isFirstBuildTurn, isDiscussTurn: Boolean(discussNote) }),
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
          (creationCompletionPass ? '+creation-completeness' : '') +
          (retried ? '+provider-retry' : ''),
        status: failed ? 'failed' : 'completed',

        /*
         * The RAW wire stop_reasons for this turn (stop-reason-tap). `@ai-sdk/anthropic` collapses
         * every stop_reason it does not know into `finishReason: 'unknown'` and discards the raw
         * value — which left the Fable 5 first-build hang (3–4-token steps, finish=unknown,
         * 2026-08-06) undiagnosable from this record. Order-only diagnostic: entries are process-
         * global, so concurrent generations may interleave on a busy deployment.
         */
        rawStops: drainStopReasons().map((s) => (s.detail ? `${s.stopReason} ${s.detail}` : s.stopReason)),

        /*
         * Refusal fallbacks that served (part of) this turn (`refusal-fallback.ts`): the requested
         * model declined via safety classifier and the named model answered on the same stream. The
         * turn still BILLS at the requested model's rates (settlement never re-derives the model
         * mid-turn) — this field is what makes that visible instead of silent.
         */
        fallbackHandoffs: fallbackHandoffs.length ? fallbackHandoffs.map((h) => `${h.from}→${h.to}`) : undefined,
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

    // The gateway that served the turn — the same value `settleGeneration` bills from.
    provider: config.provider,

    /*
     * The rung that actually RAN, plus why. Recorded because a tier used to be inferable only from the
     * model string — which stops working the moment two rungs can name the same model (an operator
     * pointing Standard and Premium at one id during a migration is ordinary), and which could never
     * distinguish "ran standard" from "asked for Premium and was declined". A generation log that
     * cannot answer which rung was billed cannot audit the ladder at all.
     */
    tier: tierDecision.tier,
    tierReason: tierDecision.reason,

    /*
     * Read at the END of the generation (the handle is built after the stream settles), so this is
     * carried + newly loaded — which is exactly what the next turn must carry. `loadedThisTurn` alone
     * would drop everything earlier turns had established.
     */
    blocksLoaded: [...referenceContext.loaded],
    historyStats,
    discussMode: discussNote !== null,

    /**
     * What is happening to the REQUEST right now, for the liveness panel. A getter, not a value: the
     * route reads it on every heartbeat tick, long after this object was built.
     */
    currentActivity: () => activityState,

    /*
     * The turn's identity for the liveness panel — facts, in the same precedence the effort policy
     * uses: a repair is a repair even on a creation, and plan mode outranks an ordinary edit.
     */
    statusKind: statusKindFor({ isRepair, isFirstBuildTurn, isDiscussTurn: Boolean(discussNote) }),

    /*
     * A property of the (PROVIDER, FAMILY) pair, resolved once here where both are in hand. The
     * buffering lives in the ADAPTER in front of the family's endpoint — KIE runs three of them and
     * they do not agree (claude buffers, codex streams) — so provider alone can no longer answer it.
     * Still never keyed by the raw MODEL id: a model swap within a family must not silently flip this
     * to "streamed". See `delivery.ts`.
     */
    deliveryMode: deliveryModeFor(config.provider, model),
    toolContext,
    usage: usagePromise,
    outcome: outcomePromise,
    settlement: settlementPromise,
    notice: byok.notice ?? tierNotice,
    onMcpToolCall: (listener) => mcpListeners.push(listener),
    onPreviewToolCall: (listener) => previewListeners.push(listener),
    onMediaTask: (listener) => mediaListeners.push(listener),
  };
}
