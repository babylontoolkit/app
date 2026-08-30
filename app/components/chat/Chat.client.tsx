import { useStore } from '@nanostores/react';
import { clearTreeReplaced, isTreeReplaced, treeReplacedProject } from '~/lib/persistence/tree-replacement-signal';
import type { Message } from 'ai';
import { useChat } from '@ai-sdk/react';
import { useAnimate } from 'framer-motion';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { useMessageParser, usePromptEnhancer, useShortcuts } from '~/lib/hooks';
import { runPreviewToolCall } from '~/lib/preview/bridge';
import { chatMetadata, description, projectId, repoStatus, useChatHistory } from '~/lib/persistence';
import { CREATION_CHECKPOINT_LABEL } from '~/lib/persistence/local-snapshots';
import {
  ApiError,
  createProject,
  deleteProject,
  getProject,
  getRepoStatus,
  mintServerChatId,
  saveCreationHandoff,
} from '~/lib/persistence/projects';
import { chatStore, creationTurnStore } from '~/lib/stores/chat';
import { isCreationTurn } from '~/lib/chat/creation-turn';
import { liveTurnIdentity } from '~/lib/chat/live-turn-identity';
import { workbenchStore } from '~/lib/stores/workbench';
import { describeTurnOutcome, type TurnOutcome } from '~/lib/agent/turn-outcome';
import { stripOpaqueContent } from '~/lib/context/opaque-files';
import { applySettlement, canUseTier, sessionStore } from '~/lib/stores/session';
import { modelTierStore } from '~/lib/stores/settings';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, PROMPT_COOKIE_KEY, PROVIDER_LIST } from '~/utils/constants';
import { cubicEasingFn } from '~/utils/easings';
import { createScopedLogger, renderLogger } from '~/utils/logger';
import { BaseChat } from './BaseChat';
import { Menu } from '~/components/sidebar/Menu.client';
import { ClientOnly } from 'remix-utils/client-only';
import { BootScreen, WorkspaceSplash } from './BootScreen';
import { bootProgress } from '~/lib/stores/boot-progress';
import Cookies from 'js-cookie';
import { debounce } from '~/utils/debounce';
import { useSettings } from '~/lib/hooks/useSettings';
import type { ProviderInfo } from '~/types/model';
import { useSearchParams } from '@remix-run/react';
import { parseClientCommand } from '~/lib/chat/client-commands';
import { applyCreationDraft, draftTextForSeed } from '~/lib/chat/new-project-draft';
import { briefFromRegistryEntry } from '~/lib/chat/creation-handoff';
import { contextPanelOpen, resetContextStats, updateContextStats } from '~/lib/stores/context-stats';
import { baseEffortStore, effortPanelOpen } from '~/lib/stores/effort';
import { chatResetRequest } from '~/lib/stores/chat-reset';
import { resetAgentStatus, updateAgentStatus } from '~/lib/stores/agent-status';
import { resetActiveSkills, updateActiveSkills } from '~/lib/stores/active-skills';
import { createSampler } from '~/utils/sampler';
import { createProjectFromRegistry } from '~/lib/registry/create-project';
import { rollbackRegisteredProject } from '~/lib/registry/creation-rollback';
import { onSandboxFailure, SANDBOX_REQUIRES_PROJECT } from '~/lib/sandbox';
import { asCreationFailure } from '~/lib/registry/creation-errors';
import { waitForMountVisible } from '~/lib/registry/mount';
import { settleAfterCreation } from '~/lib/registry/settle';
import { awaitStarterRunning, isInstallFinished } from '~/lib/registry/starter-ready';
import { settleableStatuses, waitForActionsSettled } from '~/lib/runtime/actions-settled';
import { decideSeed, deriveProjectTitle, findFallbackEntry, isBlankCanvasStart } from '~/lib/registry/match';
import { compileWizardPrompt, summarizeSelection, type WizardSelection } from '~/lib/registry/wizard';
import { projectSeedStore, setProjectSeed } from '~/lib/stores/project';
import {
  enterNewProjectMode,
  exitNewProjectMode,
  hydrateNewProjectMode,
  newProjectModeStore,
  updateCreationPlan,
} from '~/lib/stores/new-project-mode';
import {
  advanceCreationPlan,
  creationPhaseMessage,
  isCreationPlanComplete,
  newCreationPlan,
  parseCreationPlan,
} from '~/lib/agent/creation-plan';
import {
  creationPlanActive,
  decideCreationPhaseRetry,
  decideNextCreationTurn,
  type CreationPauseReason,
} from '~/lib/chat/creation-plan-runner';
import { useGameRegistry } from '~/lib/hooks/useGameRegistry';
import { trackMediaTask } from '~/lib/media/tasks';
import { streamActivitySize } from '~/lib/chat/stream-activity';
import type { GameRegistryEntry } from '~/types/game-registry';
import { logStore } from '~/lib/stores/logs';
import { streamingState } from '~/lib/stores/streaming';
import { filesToArtifacts } from '~/utils/fileUtils';
import { supabaseConnection } from '~/lib/stores/supabase';
import { defaultDesignScheme, type DesignScheme } from '~/types/design-scheme';
import type { ElementInfo } from '~/components/workbench/Inspector';
import type { TextUIPart, FileUIPart, Attachment } from '@ai-sdk/ui-utils';
import { useMCPStore } from '~/lib/stores/mcp';
import { syncMcpBridge, callMcpTool, mcpToolsAtom } from '~/lib/stores/mcpBridge';
import { assetNotesAtom } from '~/lib/stores/assetNotes';
import type { LlmErrorAlertType } from '~/types/actions';
import {
  decideAutoRepair,
  repairMessage,
  MAX_CLIENT_REPAIRS,
  REPAIR_WINDOW_MS,
  type RepairWatch,
} from '~/lib/runtime/auto-repair';

const logger = createScopedLogger('Chat');

/**
 * The server's verdict on how the turn ended, off the persisted `agentMeta` annotation.
 *
 * ⚠️ Read from the ANNOTATION, never re-derived here. The server owns the facts (`finishReason`, the
 * rescue flags) and `describeTurnOutcome` is shared so both halves agree on what "finished" means —
 * two independent definitions is the drift this codebase keeps rediscovering.
 *
 * Falls back to re-describing raw facts if a future server sends them un-described, so an older or
 * newer client cannot lose the warning entirely.
 */
function readTurnOutcome(annotations: unknown[] | undefined): TurnOutcome | null {
  const meta = annotations?.find(
    (a): a is { type: string; value?: Record<string, unknown> } =>
      Boolean(a) && typeof a === 'object' && (a as { type?: unknown }).type === 'agentMeta',
  );

  const outcome = meta?.value?.outcome as TurnOutcome | undefined;

  if (outcome && typeof outcome.state === 'string') {
    return outcome;
  }

  const facts = meta?.value?.outcomeFacts;

  return facts ? describeTurnOutcome(facts as Parameters<typeof describeTurnOutcome>[0]) : null;
}

/**
 * The server's id for the generation that just finished, off the same `agentMeta` annotation.
 *
 * Extracted so the repair watch and the creation plan read it through ONE rule. They ask for the same
 * fact for different reasons — a repair must NAME what it repairs, a phase record is the join to what
 * that phase COST — and two inline `annotations.find` copies is the shape of drift this file already
 * carries several notes about.
 */
function readGenerationId(annotations: unknown[] | undefined): string | undefined {
  const meta = annotations?.find(
    (a): a is { type: string; value?: { generationId?: string } } =>
      Boolean(a) && typeof a === 'object' && (a as { type?: unknown }).type === 'agentMeta',
  );

  return meta?.value?.generationId;
}

/**
 * Every queued action's terminal-ness, for `waitForActionsSettled`.
 *
 * One reader, three callers (the celebration, the phase advance, and the phase pause) — and they must
 * agree on what "settled" looks at, or a phase can advance over a tree the celebration would still be
 * waiting on.
 */
function readSettleableStatuses() {
  return settleableStatuses(
    Object.values(workbenchStore.artifacts.get()).flatMap((artifact) =>
      Object.values(artifact.runner.actions.get()).map((action) => ({
        type: action.type,
        status: action.status,
      })),
    ),
  );
}

/*
 * How a mid-session sandbox failure reaches a person.
 *
 * 🔴 The one failure the boot screen cannot show, because it happens long after the page is ready: a
 * RECONNECT that the seam refused (`SandboxAdoptionError` — the server offered a different sandbox
 * than this page booted, so accepting it would swap the user's filesystem underneath a live
 * workbench). The SDK turns the refusal into a connection that simply stops working, which reads as
 * "the app froze", so it has to be said out loud. `autoClose: false` because there is nothing to do
 * but reload, and a toast that fades leaves the user with a dead tab and no explanation.
 *
 * Registered here rather than inside the seam so that module stays free of React and of a toast
 * library — and registered at all, because an exported notifier with no caller is a capability that
 * only looks present.
 */
onSandboxFailure((error) => {
  logger.error(`Sandbox connection refused: ${error.message}`);
  toast.error(error.message, { autoClose: false });
});

export function Chat() {
  renderLogger.trace('Chat');

  const { ready, initialMessages, storeMessageHistory, checkpointProject, importChat, exportChat, startFreshChat } =
    useChatHistory();
  const title = useStore(description);
  useEffect(() => {
    workbenchStore.setReloadedMessages(initialMessages.map((m) => m.id));
  }, [initialMessages]);

  return (
    <>
      {ready ? (
        <ChatImpl
          description={title}
          initialMessages={initialMessages}
          exportChat={exportChat}
          storeMessageHistory={storeMessageHistory}
          checkpointProject={checkpointProject}
          importChat={importChat}
          startFreshChat={startFreshChat}
        />
      ) : (
        <>
          {/*
           * Booting a project must NOT take the whole page (owner decision 2026-07-27). The sidebar is
           * rendered by `BaseChat`, which does not exist yet on this branch — so the boot screen owned
           * the entire viewport, and a boot that stalls left the user with no way out: no dashboard, no
           * other project, no settings. Rendering the sidebar here keeps the chrome reachable while the
           * content window narrates the wait, and it costs nothing when the sidebar is undocked (it is
           * hidden until hovered, and slides out OVER the boot screen — `.z-sidebar` beats its z-index).
           * The creation splash obeys the same rule from the other side: it sits under the chrome.
           */}
          <ClientOnly>{() => <Menu />}</ClientOnly>
          <BootScreen />
        </>
      )}
    </>
  );
}

const processSampledMessages = createSampler(
  (options: {
    messages: Message[];
    initialMessages: Message[];
    isLoading: boolean;
    parseMessages: (messages: Message[], isLoading: boolean) => void;
    storeMessageHistory: (messages: Message[]) => Promise<void>;
  }) => {
    const { messages, initialMessages, isLoading, parseMessages, storeMessageHistory } = options;
    parseMessages(messages, isLoading);

    if (messages.length > initialMessages.length) {
      storeMessageHistory(messages).catch((error) => toast.error(error.message));
    }
  },
  50,
);

interface ChatProps {
  initialMessages: Message[];
  storeMessageHistory: (messages: Message[]) => Promise<void>;

  /** Snapshot the project to the server once a generation has finished (§4.5.5). */
  checkpointProject: (messageId: string, options?: { label?: string }) => Promise<void>;
  importChat: (description: string, messages: Message[]) => Promise<void>;
  exportChat: () => void;
  description?: string;

  /** "New chat, same game", in place: reset the chat's identity + history without touching the project (§4.5.6). */
  startFreshChat: () => void;
}

export const ChatImpl = memo(
  ({
    description,
    initialMessages,
    storeMessageHistory,
    checkpointProject,
    importChat,
    exportChat,
    startFreshChat,
  }: ChatProps) => {
    useShortcuts();

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [chatStarted, setChatStarted] = useState(initialMessages.length > 0);
    const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
    const [imageDataList, setImageDataList] = useState<string[]>([]);
    const [searchParams, setSearchParams] = useSearchParams();
    const [fakeLoading, setFakeLoading] = useState(false);
    const files = useStore(workbenchStore.files);

    /*
     * The map the SERVER sees. Opaque bodies (the 218KB lockfile, the vendor shims) are stripped:
     * they belong in `files` — every egress path builds from it — but the model only ever gets a
     * `<boltFile>` marker for them, so posting their contents on every turn is pure freight
     * (SPEC §4.2.8). `files` itself is untouched, so the workbench and exports still see everything.
     */
    const agentFiles = useMemo(() => stripOpaqueContent(files), [files]);

    const [designScheme, setDesignScheme] = useState<DesignScheme>(defaultDesignScheme);
    const actionAlert = useStore(workbenchStore.alert);
    const deployAlert = useStore(workbenchStore.deployAlert);
    const supabaseConn = useStore(supabaseConnection);
    const selectedProject = supabaseConn.stats?.projects?.find(
      (project) => project.id === supabaseConn.selectedProjectId,
    );
    const supabaseAlert = useStore(workbenchStore.supabaseAlert);
    const { activeProviders, promptId, contextOptimizationEnabled, useAssetLibrary, toolkitSystems } = useSettings();
    const [llmErrorAlert, setLlmErrorAlert] = useState<LlmErrorAlertType | undefined>(undefined);

    /*
     * "This build did not finish" — persistent, dismissed only by the user or by a new turn. State
     * rather than a toast, because the whole point is that it is still on screen when someone comes
     * back to a project they walked away from.
     */
    const [turnOutcomeAlert, setTurnOutcomeAlert] = useState<TurnOutcome | undefined>(undefined);

    // New Project routing (§4.4a). `vaguePrompt` is set ONLY when there is genuinely nothing to act on.
    const { entries: registryEntries } = useGameRegistry();
    const [vaguePrompt, setVaguePrompt] = useState<string | null>(null);
    const [model, setModel] = useState(() => {
      const savedModel = Cookies.get('selectedModel');
      return savedModel || DEFAULT_MODEL;
    });
    const [provider, setProvider] = useState(() => {
      const savedProvider = Cookies.get('selectedProvider');
      return (PROVIDER_LIST.find((p) => p.name === savedProvider) || DEFAULT_PROVIDER) as ProviderInfo;
    });
    const { showChat } = useStore(chatStore);
    const activeProjectId = useStore(projectId);

    /*
     * Which CONVERSATION this generation belongs to (§4.5.6, §4.10).
     *
     * `useStore`, not `chatMetadata.get()` — the AI SDK refreshes its request body from committed
     * RENDER state, so a value merely read at send time never reaches the wire. That is the same trap
     * that shipped `projectId: undefined` on every creation.
     *
     * `undefined` on the first turn of a new chat, because the id is minted at first SAVE. The server
     * treats that as "not recoverable" rather than minting one, which would duplicate the chat.
     */
    const activeServerChatId = useStore(chatMetadata)?.serverChatId;

    /*
     * 🔴 THE LIVE IDENTITY OVERRIDE — see `~/lib/chat/turn-identity.ts` for the measurement.
     *
     * Everything above is a render CAPTURE, which is correct for the base request body and wrong for
     * the window between a page load and the commit that carries the mounted project. Measured live:
     * a turn posted `projectId: undefined` while the project sat open on screen, and the proxy
     * silently dropped the preview, media and MCP tool families — three capabilities gone, generation
     * billed as normal, nothing thrown.
     *
     * Every send therefore passes this as a per-request body override, which `useChat` merges OVER
     * the base body. It is read from the stores at the moment of sending, so it cannot be stale.
     */
    const liveTurnBody = useCallback(
      () => liveTurnIdentity({ projectId: activeProjectId, chatId: activeServerChatId }),
      [activeProjectId, activeServerChatId],
    );

    /*
     * The MODEL TIER (§4.6.1a): the user's stored choice, NARROWED by live eligibility.
     *
     * We send the rung only when the user could actually have it, so an ineligible user never triggers
     * the server's "declined" notice for a rung they are not really asking for right now. This is the
     * client's own honest guess and nothing more — the server re-derives with `decideModelTier` on
     * every generation, so a stale or tampered value here can only ever ask for something that is then
     * declined DOWN to Standard.
     *
     * ⚠️ It is a render capture (`useStore`), which is what makes it correct on every send path: the
     * `useChat` body, the auto-repair `append`, and `reload()` all read the value React last committed.
     * A ref updated outside render would be the `projectId: undefined` bug again in the other direction.
     */
    /*
     * "The tree was replaced on purpose" (§4.13a). Read here so it rides in the `useChat` body from
     * committed render state; cleared in `onFinish` rather than at send time, because clearing at
     * send races the very request that is meant to carry it (`tree-replacement-signal.ts`).
     */
    const treeReplacedFor = useStore(treeReplacedProject);
    const treeReplaced = isTreeReplaced(treeReplacedFor, activeProjectId);

    const selectedTier = useStore(modelTierStore);
    const session = useStore(sessionStore);
    const tierRequested = canUseTier(session, selectedTier) ? selectedTier : 'standard';

    /*
     * The session's thinking-effort floor (§4.2.9), set by `/effort`. Session-scoped by design — it resets
     * to `medium` on reload so a floor raised for one hard problem cannot quietly bill for months.
     */
    const baseEffort = useStore(baseEffortStore);

    /*
     * A mounted project means we are BUILDING, even with nothing said yet (§4.5.6).
     *
     * 🔴 ALL THREE, or the user gets a dead screen. "Opened" is not one flag, it is three, and they are
     * normally set in two different places that a chat-less project reaches NEITHER of:
     *
     *   - `chatStarted`            — local; hides the landing intro.        (`runAnimation`)
     *   - `chatStore.started`      — the HEADER: project name, Save, Share.  (`runAnimation`)
     *   - `showWorkbench`          — file tree, editor, preview.  (the message parser's onArtifactOpen)
     *
     * `runAnimation` only runs when a message is SENT, and the parser only runs when there are
     * MESSAGES. Open a project with no chats — entirely normal now that deleting a chat leaves the game
     * (§4.5.6) — and none of them fire. Setting only `chatStarted` (the first version of this) hid the
     * intro and left the rest: no workbench, no project name, no Save, just a chat box floating on an
     * empty page. It looked like the landing page had broken.
     *
     * The mount is async and `ready` is `!mixedId || ready` — always true on `/` — so this cannot be a
     * `useState` initializer: the component mounts BEFORE the baton is read. It has to react.
     *
     * No animation: `runAnimation` fades the intro out because the user is watching it go. Arriving
     * from the dashboard there is nothing to fade — the intro was never theirs to see.
     *
     * 🔴 THIS IS THE ONLY PLACE THAT OPENS THE CHAT ON MOUNT — do not add a second one.
     *
     * It used to share the job with an upstream `useEffect(..., [])` that did
     * `setKey('started', initialMessages.length > 0)` unconditionally. Both ran on the same mount, this
     * one first, and the loser was whichever React called first — so on "New chat, same game" (where the
     * baton resolves BEFORE mount, so `activeProjectId` is already set on render 1) this set `started`
     * true and the `[]` effect immediately set it back to FALSE.
     *
     * The result was a half-open screen that nothing flagged: workbench and file tree present (those are
     * not driven by `started`), but the header stripped back to just the credits — no project name, no
     * Save, no Share, no New chat. Reported as "the screen is so plain i don't know that i am at a new
     * chat". Merging the two removes the race rather than ordering it, because an ordering fix here only
     * holds until someone adds the third writer.
     */
    useEffect(() => {
      const opened = initialMessages.length > 0 || !!activeProjectId;

      // The `false` branch is upstream's reset — landing page, no project, nothing said yet.
      chatStore.setKey('started', opened);

      if (!opened) {
        return;
      }

      setChatStarted(true);
      workbenchStore.showWorkbench.set(true);
    }, [activeProjectId]);

    const [animationScope, animate] = useAnimate();
    const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
    const [chatMode, setChatMode] = useState<'discuss' | 'build'>('build');
    const [selectedElement, setSelectedElement] = useState<ElementInfo | null>(null);

    /*
     * Plan mode needs a project (§4.2.9). "New project" is an SPA navigate that does NOT remount this
     * component, so a `discuss` chosen on the previous project would otherwise persist onto the blank
     * landing page — where the first message is always a creation (forced to Build server-side). Snap
     * back to Build whenever there is no active project so the state can never lag the disabled toggle.
     */
    useEffect(() => {
      if (!activeProjectId) {
        setChatMode('build');
      }
    }, [activeProjectId]);

    /*
     * NEW PROJECT MODE follows the OPEN project, and the `null` write is the load-bearing half (§4.4a).
     *
     * "New project" and a dashboard Open are SPA navigates that do not remount this component, and the
     * mode store is module-level — so without a hydrate on every change of project, a mode entered for
     * one project would still be set when the user opens another, and the handoff card plus the carried
     * prompt would follow them into a game they had already built. That is the inherited-state
     * class of bug §4.5.6 records twice; here the fix is one line, run for every project including the
     * ones that were never in the mode.
     */
    useEffect(() => {
      const local = hydrateNewProjectMode(activeProjectId);

      /*
       * 🔴 THE ROW IS THE SOURCE, `localStorage` IS THE CACHE (migration 0016).
       *
       * A project created on another device — or in a browser whose storage was cleared — has no local
       * mode, and until this existed that meant no handoff card at all. The local read stays FIRST and
       * synchronous so the common case still paints without a round trip; this only fills a gap, and it
       * re-checks the project id on arrival because an SPA navigate can land on a different project
       * while the request is in flight. The row's presence alone means "created, never built" — the
       * brief it used to carry is retired (owner, 2026-08-08).
       */
      if (!activeProjectId || local) {
        return;
      }

      getProject(activeProjectId)
        .then((project) => {
          const handoff = (
            project as { creationHandoff?: { userPrompt?: string; plan?: unknown; blankCanvas?: unknown } }
          ).creationHandoff;

          if (!handoff || projectId.get() !== activeProjectId || newProjectModeStore.get()) {
            return;
          }

          /*
           * 🔴 The PLAN comes back too (§4.4e), or a build interrupted on one device restarts from
           * phase 1 on the next — redoing work the user has already paid for and overwriting files
           * that were correct. `parseCreationPlan` validates it on the way in: this is a wire value,
           * and a malformed plan resolves to "no plan" (the pre-phase single turn), never to a clear.
           *
           * ⚠️ It is HYDRATED, not RESUMED. Nothing is armed here, so no generation starts on page
           * load — the user presses Build, and the send path continues from `plan.next` rather than
           * starting over. Auto-running on mount would spend credits nobody asked for at that moment,
           * which is the one thing every decider in this flow exists to prevent.
           */
          /*
           * 🔴 AND THE BLANK-CANVAS FLAG, or this path re-phases the one project that must never be
           * phased (owner, 2026-08-14). It shipped carrying `userPrompt` and `plan` only — so a Blank
           * Canvas project opened on a second device, or in a browser whose storage was cleared, came
           * back with the flag missing and built a landing page and artwork nobody asked for.
           *
           * ⚠️ It fails WORSE than a plain regression, because the two sides read different copies:
           * the SERVER derives `isFirstBuildTurn` from the ROW (`projectOwesBuild`), which does carry
           * the flag, so the client would have run three phases with every first-build protection
           * switched off — a shape neither branch was ever meant to produce.
           *
           * Same `=== true` narrowing as the other two layers: this arrives from a wire response, and
           * a truthy `1` waving a project past its build is a silent no-op of the whole pipeline.
           */
          enterNewProjectMode({
            projectId: activeProjectId,
            userPrompt: handoff.userPrompt,
            plan: parseCreationPlan(handoff.plan),
            blankCanvas: handoff.blankCanvas === true ? true : undefined,
          });
        })
        .catch((error) => {
          logger.warn('Could not read the creation handoff for this project', error);
        });
    }, [activeProjectId]);

    const mcpSettings = useMCPStore((state) => state.settings);

    /*
     * MCP bridge (§4.14): launch the project's `.mcp.json` servers INSIDE the WebContainer and expose
     * their tools. Runs when the active project changes; the sync is idempotent and only relaunches on
     * a real config change. The discovered tools ride in the agent body so the server knows what is
     * available. (Servers run in the user's sandbox — never on platform infrastructure, §5.)
     */
    const mcpTools = useStore(mcpToolsAtom);
    useEffect(() => {
      syncMcpBridge().catch(() => undefined);
    }, [activeProjectId]);

    /*
     * Store-asset component references (§4.9). When a user adds a store scene/prefab, the assets tab
     * introspects its GLB in the browser and pushes the component reference here; it rides in the agent
     * body so the model scaffolds against the asset's real components.
     */
    const assetNotes = useStore(assetNotesAtom);

    /*
     * SELF-HEALING (§4.2.7, §4.2 item 7) — the client half.
     *
     * The server has always been able to run a repair turn: it accepts `errors` / `repairOf` /
     * `repairAttempt`, folds the compiler output into the prompt (`buildRepairMessage`), caps attempts
     * at `MAX_REPAIR_TURNS`, and escalates the thinking effort (repair → `high`, second repair →
     * `xhigh`). None of it ever ran, because nothing on the client sent those fields — so a generation
     * that produced code which does not compile just left the user staring at a red error box.
     *
     * `repairWatch` is armed when a generation finishes and disarms itself after
     * `REPAIR_WINDOW_MS`. Vite recompiles a moment AFTER the last file action lands, so the error we
     * care about arrives shortly after `onFinish`, not during it. An alert outside that window is the
     * user's own doing (they edited a file, they ran something) and must never trigger a generation we
     * bill them for.
     */
    const repairWatch = useRef<RepairWatch | null>(null);

    /**
     * Which repair attempt the CURRENTLY STREAMING generation is (0 = an ordinary turn).
     *
     * Separate from `repairWatch` because the watch is consumed the moment a repair fires, and the
     * count has to survive that. Without it, every repair would look like attempt 1 and the loop would
     * never reach its cap — an agent that cannot fix the build would keep being paid to try.
     * Reset to 0 whenever the user sends a message of their own.
     */
    const repairAttemptRef = useRef(0);

    /**
     * Set when a NEW project's first generation is about to run (creation), consumed once in
     * `onFinish` to celebrate that the initial build is done. A ref, not `generationCount`, because
     * that atom is bumped inside the un-awaited `checkpointProject` and is racy to read here — and
     * because "creation" is a property of THIS turn (the one right after `startProject`), not a count.
     * Cleared on fire so edits and repairs never trigger it.
     */
    const creationCompleteRef = useRef(false);

    /**
     * The creation phase the runner has armed, or `null` (§4.4e, `decideNextCreationTurn`).
     *
     * 🔴 A ref and a one-shot LATCH, exactly like `repairWatch`. The effect that consumes it re-runs on
     * every render, so without an arm that is cleared BEFORE the `append` it would post the same phase
     * repeatedly the instant `isLoading` goes false — a self-inflicted loop that bills a full generation
     * per render. Set only after the finished phase's actions have settled AND the row has accepted the
     * advance, which is what stops it running a phase the server does not believe is next.
     */
    const armedPhaseRef = useRef<number | null>(null);

    /** Mirrors the ref into render so the effect re-evaluates when a phase is armed. */
    const [armedPhase, setArmedPhase] = useState<number | null>(null);

    /**
     * 🔴 WAS THE TURN THAT JUST FINISHED A PHASE? — set on a phase send, cleared on every other one.
     *
     * Without this, `onFinish` advances the plan for ANY turn that ends while a plan is active — and a
     * user can type their own message mid-build (a question, a correction, a retry after a failure).
     * Those turns would silently tick the plan forward, so a phase the user paid for is skipped and
     * never runs, and the build completes having quietly missed a step.
     *
     * Caught by `creation-celebration.spec.tsx`: a failed build, then `/clear`, then an ordinary edit
     * marched the plan to completion and fired "🎮 Your game is ready" over a project with no game.
     */
    const phaseTurnRef = useRef(false);

    /**
     * Why the creation plan stopped, if it did. Terminal until the user acts — never re-derived, or a
     * paused plan starts running again on its own (`decideNextCreationTurn`).
     */
    const [phasePause, setPhasePause] = useState<CreationPauseReason | null>(null);

    /**
     * 🔴 THE AUTOMATIC RETRY OF A FAILED PHASE (owner, 2026-08-14 — *"just please make it finish"*).
     *
     * Two refs, not state, for the reason every latch in this file is a ref: they are read inside
     * callbacks and must be the CURRENT value, not the value as of the last commit.
     *
     * `attempts` is keyed by phase index and RESET when the plan advances, so "once" means once per
     * step rather than once per build — a later phase is not punished for an earlier one's bad luck.
     * `retrying` suppresses exactly one error-pause, because `useChat` keeps `error` set until the
     * next request starts and without it the retry re-arms into a decider that pauses anyway.
     */
    const phaseRetriesRef = useRef<{ index: number; attempts: number }>({ index: -1, attempts: 0 });
    const retryingPhaseRef = useRef(false);

    const {
      messages,
      isLoading,
      input,
      handleInputChange,
      setInput,
      stop,
      append,
      setMessages,
      reload,
      error,
      data: chatData,
      setData,
      addToolResult,
    } = useChat({
      /*
       * The platform agent proxy (SPEC §3, §4.2) — NOT upstream's /api/chat. LLM calls never leave
       * the browser directly: the platform key, the synced prompt version, the credit gate, the
       * server-side skill tool loop, and usage recording all live behind this route.
       */
      api: '/api/agent',
      body: {
        apiKeys,
        files: agentFiles,

        /*
         * Which project this generation is building (§4.5.3, §4.12).
         *
         * The server checks ownership on it before spending a token, and uses it to enforce one
         * in-flight generation per project. Read from the store rather than captured, so it is
         * present on the very first turn after `startProject` creates the project.
         */
        projectId: activeProjectId,

        /*
         * Which chat this generation belongs to. Was NEVER SENT: the route read `body.chatId` and the
         * client never supplied it, so every `generations` row recorded `chatId: null` — a 427-credit
         * generation the audit trail could not attribute to a conversation — and the server had no key
         * to write a recovery transcript against (`transcript-recovery.ts`).
         */
        chatId: activeServerChatId,

        promptId,
        contextOptimization: contextOptimizationEnabled,
        chatMode,

        /*
         * The "Use Asset Library" preference (§4.4d, Control Panel → Features, default ON). The
         * proxy omits the pinned Synty library block when this is false; only an explicit false opts
         * out, so a stale bundle that never sends the field keeps the shipped default.
         */
        useAssetLibrary,

        /*
         * The "Toolkit systems" preference (§4.4e, Control Panel → Features, default 'auto'). The proxy
         * pushes an override block only for 'prefer'/'own'; 'auto' — and anything it does not recognise,
         * including a stale bundle that omits the field — pushes nothing and costs no tokens.
         */
        toolkitSystems,

        /*
         * The whole file tree was replaced since the last turn (§4.13a — a branch switch, a discard,
         * a pull). Suppresses INV-3(b)'s manifest-shrink signal for exactly one turn: a switch from a
         * 90-file feature branch to a 60-file default is that signal's exact shape and it is correct.
         *
         * ⚠️ A `useStore` render capture, deliberately — the same reason `tierRequested` is one. The
         * `useChat` body is refreshed from committed render state, so a ref updated outside render is
         * the documented `projectId: undefined` bug in the other direction.
         */
        treeReplaced,

        designScheme,
        supabase: {
          isConnected: supabaseConn.isConnected,
          hasSelectedProject: !!selectedProject,
          credentials: {
            supabaseUrl: supabaseConn?.credentials?.supabaseUrl,
            anonKey: supabaseConn?.credentials?.anonKey,
          },
        },

        /*
         * Game Backend (§4.15) — the SAME user-owned Supabase connection, described for the platform
         * agent proxy so it scaffolds RLS-first. Only the PUBLIC project ref travels (never the
         * management PAT), and the server independently refuses a ref that resolves to the platform
         * Supabase (hard separation). This is what the `/api/agent` proxy actually reads; the upstream
         * `supabase` block above is left in place for pull compatibility.
         */
        gameBackend: {
          connected: Boolean(supabaseConn.isConnected && selectedProject),
          projectRef: supabaseConn.selectedProjectId,
        },

        /*
         * MCP tools actually RUNNING in this project's WebContainer (§4.14). The server uses these to
         * tell the model what it can call; execution stays client-side in the sandbox (`callMcpTool`).
         * Empty when the project has no `.mcp.json` or no servers started.
         *
         * `inputSchema` must travel: it is how the model learns each tool's ARGUMENTS. Dropped, the model
         * calls the tool with invented arguments and the MCP server rejects every call — a relay that
         * looks wired up and never does useful work. The server caps how much of it reaches the prompt.
         */
        mcpTools: mcpTools.map((t) => ({
          name: t.name,
          description: t.description,
          server: t.server,
          inputSchema: t.inputSchema,
        })),

        /* Store-asset component references (§4.9), introspected client-side when an asset was added. */
        assetNotes,
        maxLLMSteps: mcpSettings.maxLLMSteps,

        /*
         * The chosen rung of the model tier ladder (§4.6.1a) — an enum id the server maps to THAT rung's
         * operator-configured model, never a free-form model string (§4.2a).
         *
         * This rides in the `useChat` body, which is the base for EVERY send path: the composer, the
         * auto-repair `append` (whose per-call `body` extends rather than replaces this one), and
         * `reload()`. That is deliberate — a tier threaded onto only the main path would silently
         * downgrade every repair turn, and a repair is exactly when a user most wants the model they
         * chose.
         */
        tier: tierRequested,

        /*
         * The session's base thinking effort (§4.2.9) — `medium` (default) or `high`. A FLOOR, not a cap:
         * the server still escalates repairs and `/slash` turns above it, and it validates the value rather
         * than trusting it, so this can only ever ask for one of the two user-selectable levels.
         */
        effort: baseEffort,
      },
      sendExtraMessageFields: true,
      onError: (e) => {
        setFakeLoading(false);

        handleError(e, 'chat');
      },
      onFinish: (message, response) => {
        const usage = response.usage;
        setData(undefined);

        /*
         * The tree-replacement suppression is spent (§4.13a). Cleared on FINISH, not on send: the
         * body is composed from committed render state, so clearing when the request goes out races
         * the request that is meant to carry the flag. One turn late is harmless — the server
         * re-baselines every call — and one turn early restores the noise it exists to prevent.
         */
        clearTreeReplaced();

        /*
         * THE CREATION PLAN (§4.4e) — whether this turn finished the BUILD is a question about the
         * PLAN, not about the stream. Read from the STORE, never from a captured render value:
         * `useStore` is a render capture and the plan advances between commits by design (the
         * documented `projectId: undefined` post-mortem, §4.4a).
         */
        const livePlan = newProjectModeStore.get()?.plan;
        const planProjectId = newProjectModeStore.get()?.projectId ?? '';
        const outcome = readTurnOutcome(message.annotations);

        /**
         * Celebrate the initial build, exactly once (§4.4). Ref-gated so it never fires on an edit or a
         * self-heal — those are not "your game is ready" moments. Distinct from the §4.5.4b save nudge
         * (that is about persistence and fires once per BROWSER); this is about the build finishing and
         * fires once per PROJECT.
         *
         * 🔴 **A FUNCTION, because its two callers reach this moment at different TIMES** (2026-08-14).
         * With no plan it fires synchronously from `onFinish`, exactly as it always did; with one it
         * fires from inside the settle-and-advance promise, on the turn that completes the LAST phase.
         *
         * The first draft of the phase wiring left this as an `if` placed after the advance — which is
         * the silent version of this bug. The advance is async, so the plan is still `active` when a
         * synchronous check runs, and the celebration would simply never have fired again, on any
         * build, with nothing to notice it: a missing toast throws nothing.
         */
        const celebrateBuild = () => {
          if (!creationCompleteRef.current) {
            return;
          }

          creationCompleteRef.current = false;

          /*
           * 🔴 NEVER CELEBRATE A BUILD THAT DID NOT FINISH (2026-08-08, owner-directed).
           *
           * Measured: a creation ended `length+forced-continuation` — cut off at the output ceiling,
           * mid-project, 1,175 credits — and this branch showed `🎮 Your game is ready`. Every marker
           * existed server-side and none of them reached the person looking at the broken project.
           *
           * The server now decides (`~/lib/agent/turn-outcome.ts`, shared so the two halves cannot
           * disagree about what "finished" means) and rides the verdict on `agentMeta`, which is
           * persisted with the message — so the warning survives a reload, which a toast would not.
           */
          if (outcome && outcome.state !== 'finished') {
            setTurnOutcomeAlert(outcome);
          }

          /*
           * 🔴 THE STREAM ENDING IS NOT THE BUILD FINISHING (reported live 2026-07-27).
           *
           * `onFinish` fires when the model stops TALKING. The work is the `<boltAction>`s it queued,
           * which execute against the sandbox afterwards — and on a server sandbox each file write is a
           * round trip, so the queue lags the text badly. Observed: this toast on screen, the model's
           * closing summary in the past tense, and the artifact card still spinning on
           * `Write src/chrome/splash.css`. We announced a finished game while writing the splash, and
           * sent the user to a preview that was mid-rebuild — which reads as a broken build.
           *
           * So the celebration waits for every queued action to reach a terminal state
           * (`actions-settled.ts`; failed and aborted count — waiting for `complete` would hang on the
           * turn that most needs a message). Fire-and-forget: a slow tail must never block `onFinish`.
           */
          void waitForActionsSettled({ readStatuses: readSettleableStatuses }).then((result) => {
            /*
             * A truncated or rescued build gets the persistent alert above instead. Firing a success
             * toast beside a "this build did not finish" panel is worse than either alone — it tells
             * the user the two halves of the product disagree about whether their project works.
             */
            if (outcome && outcome.state === 'incomplete') {
              return;
            }

            if (result.settled) {
              toast.success('🎮 Your game is ready — open Preview to play it.');
            } else {
              /* Never claim ready when it is not — say what is still happening (§"fail loud"). */
              toast.info(
                `Your project is still writing ${result.stillPending} file(s). It will be ready in the Preview shortly.`,
              );
            }
          });
        };

        /*
         * Consume the phase flag: whatever happens below, the NEXT turn is not a phase unless
         * something posts one. Read-and-clear, like every other one-shot latch in this file.
         */
        const wasPhaseTurn = phaseTurnRef.current;
        phaseTurnRef.current = false;

        if (wasPhaseTurn && creationPlanActive(livePlan) && livePlan) {
          /*
           * The server judged the turn unfinished. Do NOT advance: the next phase builds on the files
           * this one wrote, so continuing over a truncated phase compounds a broken tree and bills for
           * it. The persistent alert carries a "Finish the build" action, so the user has somewhere to
           * go — and `creationCompleteRef` stays armed, so the celebration is still owed to whichever
           * turn eventually completes the plan.
           */
          if (outcome && outcome.state === 'incomplete') {
            setPhasePause('incomplete');
            setTurnOutcomeAlert(outcome);
          } else {
            /*
             * The stream ending is not the phase finishing, for the reason written in `celebrateBuild`
             * above. Advancing before the actions land would start the next phase against a
             * half-written tree — the same defect, one phase earlier.
             */
            void waitForActionsSettled({ readStatuses: readSettleableStatuses }).then(async (result) => {
              if (!result.settled) {
                /*
                 * Files still moving after the timeout. Pausing is the honest answer: the next phase
                 * would read a tree that is mid-write, and building on it silently is how a creation
                 * ends up half-finished with every individual turn reporting success.
                 *
                 * 🔴 And it is SAID OUT LOUD. A plan that stops without a word strands a half-built
                 * project and looks exactly like one that is still working — the failure this whole
                 * feature exists to end. Same sentence the celebration uses for the same condition,
                 * because it is the same fact about the same tree.
                 */
                setPhasePause('unsettled');
                creationCompleteRef.current = false;
                toast.info(
                  `Your project is still writing ${result.stillPending} file(s). It will be ready in the Preview shortly.`,
                );

                return;
              }

              const advanced = advanceCreationPlan(livePlan, {
                id: livePlan.phases[livePlan.next],
                generationId: readGenerationId(message.annotations) ?? '',
                at: new Date().toISOString(),
                state: outcome?.state ?? 'finished',
              });

              const complete = isCreationPlanComplete(advanced);

              /* A new step starts with its own retry, so bad luck on one phase never spends another's. */
              phaseRetriesRef.current = { index: -1, attempts: 0 };

              /*
               * 🔴 THE ROW IS THE SOURCE; THE LOCAL COPY IS A CACHE — so the row is written FIRST and
               * the mirror takes only what the server accepted. `mergeCreationPlan` is monotonic
               * server-side precisely so two tabs cannot rewind `next` and re-run a phase the user has
               * already paid for.
               *
               * Completing the plan is what CLEARS the handoff (`null`): the row's presence has meant
               * "created, never built" since migration 0016, and since phases it ends at the last one.
               * That is also the flag the server reads to know a turn is a build (`projectOwesBuild`),
               * so this write is what stops every later edit being treated as a creation.
               */
              if (planProjectId) {
                try {
                  await saveCreationHandoff(planProjectId, complete ? null : { plan: advanced });
                } catch (error) {
                  /*
                   * Loud, and it PAUSES rather than continuing. Advancing locally over a row that did
                   * not accept it is how the same phase runs twice on the next device — and this write
                   * is the only thing that makes a half-finished build resumable at all.
                   */
                  logger.error('Could not advance the creation plan', error);
                  setPhasePause('error');

                  return;
                }
              }

              if (complete) {
                exitNewProjectMode(planProjectId);
                armedPhaseRef.current = null;
                setArmedPhase(null);
                celebrateBuild();
              } else {
                updateCreationPlan(planProjectId, advanced);

                /*
                 * Arm the next phase. The effect that consumes this disarms BEFORE its `append` — the
                 * documented rule from the repair watch, and the reason a re-render cannot post the
                 * same phase twice.
                 */
                armedPhaseRef.current = advanced.next;
                setArmedPhase(advanced.next);
              }
            });
          }
        } else {
          // No plan (an older project, or a build that never started): unchanged single-turn behaviour.
          celebrateBuild();
        }

        /*
         * Arm the self-healing watch (§4.2.7). `generationId` comes from the server's `agentMeta`
         * annotation — a repair turn has to NAME the generation it repairs, which is what tells the
         * server this is a repair (escalate the effort, count it against the cap, link the two rows in
         * `generations`) rather than a fresh request the user made.
         *
         * `attempt` carries forward: if THIS generation was itself repair attempt 1 and its output
         * still does not compile, the next one is attempt 2 — and there is no attempt 3. Two failed
         * repairs means the agent is thrashing, and a third turn spends the user's credits to watch it
         * thrash again.
         */
        const generationId = readGenerationId(message.annotations);

        repairWatch.current = generationId
          ? { generationId, attempt: repairAttemptRef.current, until: Date.now() + REPAIR_WINDOW_MS }
          : null;

        /*
         * Checkpoint the project HERE — once, now that the generation is done and the files have
         * stopped moving (SPEC §4.5.5: "auto-snapshot after each applied generation").
         *
         * Not inside `storeMessageHistory`: that runs on every mutation of the message array, which
         * while streaming is several times a second. Uploading a 5.9MB project on each of those ticks
         * produced 160 checkpoints for a single message and visibly starved the stream the user was
         * waiting on.
         */
        checkpointProject(message.id).catch(() => {
          /*
           * Already handled inside: every failure branch logs AND toasts (T17c) — this catch only
           * keeps an unexpected rejection out of onFinish. The silent `.catch(() => {})` here used to
           * be the LAST line of defense and the reason "checkpoints stopped on CSB" had no symptom.
           */
        });

        /*
         * The settled cost of this generation (§4.6). The server charged against REAL token usage —
         * including for a generation the user stopped — so we take its balance verbatim rather than
         * subtracting locally, which would drift from the ledger on the first stop or repair turn.
         *
         * `notice` carries the friendly "your Pro subscription lapsed, so this used credits" fallback
         * (§4.6.1). It is never an error; the build succeeded.
         */
        const credits = message.annotations?.find(
          (a): a is { type: 'credits'; value: { balanceAfter: number | null; notice: string | null } } =>
            typeof a === 'object' && a !== null && (a as { type?: string }).type === 'credits',
        );

        if (credits) {
          applySettlement(credits.value.balanceAfter);

          if (credits.value.notice) {
            toast.info(credits.value.notice);
          }
        }

        /*
         * Feed the `/context` report + health dot (§4.5.6) from this turn's annotations — the wire
         * truth for history size and token counts, never a client-side estimate.
         */
        updateContextStats(message.annotations as unknown[] | undefined);

        if (usage) {
          console.log('Token usage:', usage);
          logStore.logProvider('Chat response completed', {
            component: 'Chat',
            action: 'response',
            model,
            provider: provider.name,
            usage,
            messageLength: message.content.length,
          });
        }

        logger.debug('Finished streaming');
      },
      initialMessages,
      initialInput: Cookies.get(PROMPT_COOKIE_KEY) || '',
    });

    /*
     * MCP tool-call relay — the CLIENT half (§4.14).
     *
     * The server streams `mcp-tool-call` data parts while a generation's tool loop is blocked awaiting a
     * tool the model called. We run each ONCE in the project's WebContainer (`callMcpTool`) and POST the
     * result back to `/api/agent/tool-result`, which unblocks the waiting server-side `execute`. MCP
     * servers run only in the user's sandbox — never on platform infrastructure (§5) — and their results
     * are untrusted input. `handledToolCalls` dedupes by tool-call id so a re-render never double-runs one.
     */
    /*
     * Seed the context health dot on load (§4.5.6): a reopened chat's last assistant message carries
     * the same annotations a live turn streams, so the dot is honest before the first new generation.
     * Reset FIRST — "New chat, same game" mounts with no messages, and stats inherited from the
     * previous conversation would report the context the user just cleared.
     */
    useEffect(() => {
      resetContextStats();

      for (let i = initialMessages.length - 1; i >= 0; i--) {
        const message = initialMessages[i];

        if (message.role === 'assistant' && message.annotations?.length) {
          updateContextStats(message.annotations as unknown[]);
          break;
        }
      }
    }, [initialMessages]);

    /*
     * Liveness heartbeat (§4.2a) — clear on EVERY isLoading edge. Rising: a new generation must
     * never open under the previous one's "Thinking — 4m" panel. Falling: the generation is over;
     * a lingering fresh status would keep the panel alive into an idle chat.
     */
    useEffect(() => {
      resetAgentStatus();
      resetActiveSkills();
    }, [isLoading]);

    const handledToolCalls = useRef<Set<string>>(new Set());
    useEffect(() => {
      if (!chatData) {
        return;
      }

      for (const part of chatData) {
        if (!part || typeof part !== 'object') {
          continue;
        }

        /*
         * Generation liveness heartbeat (§4.2a). This effect replays the whole array every chunk;
         * `updateAgentStatus` gates on `(generationId, seq)` internally, so re-presenting old parts
         * is free and never refreshes a stale status into looking current.
         */
        if ((part as { type?: string }).type === 'agent-status') {
          updateAgentStatus(part);
          continue;
        }

        // Which skills this turn loaded (§4.11) — idempotent, so replayed parts are free.
        if ((part as { type?: string }).type === 'skills-loaded') {
          updateActiveSkills(part);
          continue;
        }

        const call = part as {
          type?: string;
          generationId?: string;
          toolCallId?: string;
          toolName?: string;
          server?: string;
          args?: unknown;
        };

        /*
         * Media renders the model started (§4.16). The debit is already taken server-side; our job is
         * to poll until the render lands and write the bytes into the WebContainer at destPath.
         *
         * This effect re-runs on EVERY stream chunk and replays the same `media-task` parts each time,
         * so `trackMediaTask` must dedupe twice over: a `tracking` set while a poller is live, and a
         * permanent `completed` latch once a task is terminal. The latch is the one that matters here —
         * without it a delivered image was re-fetched and re-toasted once per chunk (~100 toasts for
         * three images, observed live). Never pass `force` from this path.
         */
        const media = part as { type?: string; taskId?: string; projectId?: string; destPath?: string; kind?: string };

        if (media.type === 'media-task' && media.taskId && media.projectId && media.destPath) {
          void trackMediaTask({
            projectId: media.projectId,
            taskId: media.taskId,
            destPath: media.destPath,
            kind: media.kind === 'video' ? 'video' : 'image',
          });
          continue;
        }

        /*
         * Preview dev-tools (`lib/preview/protocol.ts`) — the agent asking the RUNNING game a question.
         *
         * Same relay as MCP and the same dedupe set: this effect replays every data part on every stream
         * chunk, so without the `handledToolCalls` latch one `evaluate_in_game` would run per chunk.
         */
        const previewCall = part as {
          type?: string;
          generationId?: string;
          toolCallId?: string;
          method?: string;
          params?: Record<string, unknown>;
        };

        if (
          previewCall.type === 'preview-tool-call' &&
          previewCall.toolCallId &&
          previewCall.generationId &&
          previewCall.method
        ) {
          if (handledToolCalls.current.has(previewCall.toolCallId)) {
            continue;
          }

          handledToolCalls.current.add(previewCall.toolCallId);

          void (async () => {
            let result: unknown;
            let error: string | undefined;

            try {
              result = await runPreviewToolCall(previewCall.method as never, previewCall.params);
            } catch (e) {
              error = (e as Error).message;
            }

            await fetch('/api/agent/tool-result', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                generationId: previewCall.generationId,
                toolCallId: previewCall.toolCallId,
                result,
                error,
              }),
            }).catch(() => undefined);
          })();

          continue;
        }

        if (call.type !== 'mcp-tool-call' || !call.toolCallId || !call.generationId || !call.toolName) {
          continue;
        }

        if (handledToolCalls.current.has(call.toolCallId)) {
          continue;
        }

        handledToolCalls.current.add(call.toolCallId);

        void (async () => {
          let result: unknown;
          let error: string | undefined;

          try {
            result = await callMcpTool(call.toolName!, call.args, call.server);
          } catch (e) {
            error = (e as Error).message;
          }

          await fetch('/api/agent/tool-result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              generationId: call.generationId,
              toolCallId: call.toolCallId,
              result,
              error,
            }),
          }).catch(() => undefined);
        })();
      }
    }, [chatData]);

    /*
     * SELF-HEALING (§4.2.7) — fire the repair turn.
     *
     * Runs when a build error appears while the watch is armed, i.e. the code the agent JUST wrote does
     * not compile. Everything the server needs to recognise a repair rides in the body: `errors` (which
     * it folds into the prompt itself — we do not paste the compiler output into a chat message),
     * `repairOf` (the generation being repaired) and `repairAttempt` (which caps the loop and escalates
     * the thinking effort).
     *
     * The guards are the whole design. Each one is a way this could spend the user's credits without
     * their asking:
     *   - only `source: 'preview'` — a Vite compile error. A terminal error is often the user's own
     *     command, and repairing it uninvited is presumptuous AND billable.
     *   - only inside the window — an alert an hour later is not our generation's fault.
     *   - only up to MAX_CLIENT_REPAIRS — two failed repairs is thrashing, not fixing.
     *   - never while a generation is already streaming.
     * The watch is disarmed FIRST, so a re-render can never fire the same repair twice.
     */
    useEffect(() => {
      const decision = decideAutoRepair({
        alert: actionAlert,
        watch: repairWatch.current,
        isLoading,
        now: Date.now(),

        /*
         * 🔴 Mid-creation compile errors are NORMAL (§4.4e, trap 2). The frontend phase writes a page
         * importing art the ART phase has not rendered yet, so Vite is correctly red for the whole gap
         * — and without this every pair of phases would fire a repair turn, billing the user to fix
         * what the next phase was about to fix and colliding with it for the in-flight claim (§4.12).
         * Read from the store, not a render capture: the plan advances between commits.
         */
        creationPlanActive: creationPlanActive(newProjectModeStore.get()?.plan),
      });

      if (!decision.repair) {
        if (decision.disarm) {
          repairWatch.current = null;
        }

        return;
      }

      // Disarm FIRST: a re-render must never be able to fire the same repair twice.
      repairWatch.current = null;
      repairAttemptRef.current = decision.repairAttempt;

      workbenchStore.clearAlert();
      logger.debug(`Build failed — auto-repair attempt ${decision.repairAttempt} of ${MAX_CLIENT_REPAIRS}`);

      append(
        { role: 'user', content: repairMessage(decision.repairAttempt) },
        {
          body: {
            ...liveTurnBody(),
            errors: decision.errors,
            repairOf: decision.repairOf,
            repairAttempt: decision.repairAttempt,
          },
        },
      );
    }, [actionAlert, isLoading]);

    /*
     * 🔴 RUN THE NEXT CREATION PHASE (§4.4e) — the second mechanism that starts a generation with no
     * user action, and it deliberately copies the first one's shape (`decideAutoRepair`, above).
     *
     * The decision is a PURE function (`decideNextCreationTurn`) for that function's stated reason: a
     * `run` spends the user's credits without them asking, and every branch that says *don't* is the
     * point of it rather than an edge case around it.
     *
     * ⚠️ **Disarm BEFORE the `append`**, the documented rule from the repair effect. This effect re-runs
     * on every render; without clearing the latch first, one committed render would post the same phase
     * again — a full generation per render, on the user's bill.
     */
    useEffect(() => {
      const mode = newProjectModeStore.get();

      const decision = decideNextCreationTurn({
        plan: mode?.plan,
        projectId: activeProjectId,
        isLoading,
        hasError: error != null,
        armedIndex: armedPhaseRef.current,
        lastOutcome: null,
        paused: phasePause,
        retrying: retryingPhaseRef.current,
      });

      if (decision.kind !== 'run' || !mode?.plan) {
        return;
      }

      const plan = mode.plan;
      const phase = plan.phases[decision.index];

      /*
       * Disarm FIRST: a re-render must never be able to post the same phase twice. The retry
       * suppression is one-shot for the same reason — left set, a SECOND failure would slip past the
       * error pause and the plan would retry forever on the user's bill.
       */
      armedPhaseRef.current = null;
      setArmedPhase(null);
      retryingPhaseRef.current = false;

      logger.debug(`Creation phase ${decision.index + 1} of ${plan.phases.length} — ${phase}`);

      // This turn IS a phase; `onFinish` reads and clears it before deciding whether to advance.
      phaseTurnRef.current = true;

      append(
        { role: 'user', content: creationPhaseMessage(plan, decision.index) },

        /*
         * `creationPhase` tells the server which phase this is: it decides the tool set (only `art`
         * gets the media tools) and the step ceiling derived from it. The server ignores it on any turn
         * that is not a first build, so it can never widen an ordinary edit's tools.
         */
        { body: { ...liveTurnBody(), creationPhase: phase } },
      );
    }, [armedPhase, isLoading, error, phasePause, activeProjectId, liveTurnBody]);

    useEffect(() => {
      const prompt = searchParams.get('prompt');

      // console.log(prompt, searchParams, model, provider);

      if (prompt) {
        setSearchParams({});
        runAnimation();
        append(
          {
            role: 'user',
            content: `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${prompt}`,
          },
          { body: liveTurnBody() },
        );
      }
    }, [model, provider, searchParams, liveTurnBody]);

    const { enhancingPrompt, promptEnhanced, enhancePrompt, resetEnhancer } = usePromptEnhancer();
    const { parsedMessages, parseMessages, resetParsedMessages } = useMessageParser();

    const TEXTAREA_MAX_HEIGHT = chatStarted ? 400 : 200;

    /*
     * (Upstream's `useEffect(() => chatStore.setKey('started', initialMessages.length > 0), [])` lived
     * here. It is folded into the open-state effect above — see the 🔴 note there. It was a second,
     * unconditional writer of the same flag on the same mount, and it won.)
     */

    useEffect(() => {
      /*
       * Surface a parse/runtime failure instead of swallowing it. `parseMessages` drives the action
       * runner and artifact rendering; if that throws (a bad artifact, a broken client module after a
       * hot update), the stream keeps flowing but nothing renders — the user is left staring at the
       * three-dot spinner with no signal. A caught throw becomes a visible error, which is the whole
       * point of this being here rather than an uncaught effect error React logs to a console no user
       * reads.
       */
      try {
        processSampledMessages({
          messages,
          initialMessages,
          isLoading,
          parseMessages,
          storeMessageHistory,
        });
      } catch (err) {
        logger.error('Failed to render streaming response', err);
        toast.error('Something went wrong displaying the response. Try again, or reload the page.');
      }
    }, [messages, isLoading, parseMessages]);

    /*
     * Is the current/next turn the CREATION? Premium is edit-only (§4.6.1, `decidePremium`
     * `reason: 'creation_turn'`), so the pill locks while this is true. Derived, never a flag set on
     * the send path, so restores and retries agree. TRUE in two states:
     *  - the landing page / a chat with no project (the next send CREATES a project), and
     *  - NEW PROJECT MODE — a created project that has never been built (§4.4a). The retired hidden
     *    creation brief used to be a third, marker-sniffed state; with the brief gone (owner,
     *    2026-08-08) the mode is the one fact that marks the first build turn.
     * A new chat on an EXISTING project has `activeProjectId` and no mode — premium stays available,
     * because its first message is an edit.
     */
    const openNewProjectMode = useStore(newProjectModeStore);

    useEffect(() => {
      creationTurnStore.set(isCreationTurn({ activeProjectId, messages, newProjectMode: openNewProjectMode }));
    }, [messages, activeProjectId, openNewProjectMode]);

    /*
     * Stall watchdog — never leave the user on the three-dot spinner (`isLoading || fakeLoading`) with
     * no signal at all. A real generation streams SOMETHING — reasoning or text — within a couple of
     * minutes even for the hardest request, so a long stretch of TOTAL silence while the spinner is up
     * means the stream is dead, not slow. We reassure first (a long request is not an error), then, well
     * beyond any generation we have ever measured, surface an error and clear the spinner so the UI is
     * usable again. We NEVER auto-abort inside the warn window: killing a legitimately long generation
     * would waste the user's credits (§4.2.1). The clock resets on every streamed byte.
     */
    const streamActivityRef = useRef({ at: 0, size: -1, warned: false });

    useEffect(() => {
      const streaming = isLoading || fakeLoading;

      if (!streaming) {
        streamActivityRef.current = { at: 0, size: -1, warned: false };
        return undefined;
      }

      const STALL_WARN_MS = 120_000; // 2 min of silence → reassure, do not touch the generation
      const STALL_FAIL_MS = 300_000; // 5 min of silence → the stream is dead; recover the UI

      /*
       * ⚠️ Activity is EVERY channel, not just `content` — see `stream-activity.ts`. This summed
       * `content` alone, and reasoning rides `parts` (§4.2a), so a model thinking hard read as a dead
       * stream and got CANCELLED at 300s while the user watched its thinking panel fill up.
       */
      const streamedSize = streamActivitySize(messages, Array.isArray(chatData) ? chatData.length : 0);

      if (streamActivityRef.current.size !== streamedSize) {
        // Fresh bytes (or the stream just began) — reset the silence clock.
        streamActivityRef.current = { at: Date.now(), size: streamedSize, warned: false };
      }

      const timer = setInterval(() => {
        const silentMs = Date.now() - streamActivityRef.current.at;

        if (silentMs > STALL_FAIL_MS) {
          clearInterval(timer);
          toast.error('The generation stopped responding and was cancelled. Please try again.');
          stop();
          setFakeLoading(false);
          chatStore.setKey('aborted', true);
          workbenchStore.abortAllActions();
        } else if (silentMs > STALL_WARN_MS && !streamActivityRef.current.warned) {
          streamActivityRef.current.warned = true;
          toast.info('Still working — a complex request can take a couple of minutes.');
        }
      }, 5_000);

      return () => clearInterval(timer);
    }, [isLoading, fakeLoading, messages, chatData, stop]);

    const scrollTextArea = () => {
      const textarea = textareaRef.current;

      if (textarea) {
        textarea.scrollTop = textarea.scrollHeight;
      }
    };

    const abort = () => {
      stop();
      chatStore.setKey('aborted', true);
      workbenchStore.abortAllActions();

      /*
       * A stopped build produced no game, and `onFinish` never runs for it — so the armed celebration
       * would sit there and fire on whatever ordinary turn ended next ("what files are there?" →
       * "🎮 Your game is ready"). Disarming here also covers `/clear` and the ⋯ reset, both of which
       * abort an in-flight generation first. A stopped build simply gets no celebration — the user
       * stopped it, so there is nothing to congratulate them on, and the toast is not what tells them
       * the project exists (creation already did that).
       */
      creationCompleteRef.current = false;

      logStore.logProvider('Chat response aborted', {
        component: 'Chat',
        action: 'abort',
        model,
        provider: provider.name,
      });
    };

    const handleError = useCallback(
      (error: any, context: 'chat' | 'template' | 'llmcall' = 'chat') => {
        logger.error(`${context} request failed`, error);

        stop();
        setFakeLoading(false);

        let errorInfo = {
          message: 'An unexpected error occurred',
          isRetryable: true,
          statusCode: 500,
          provider: provider.name,
          type: 'unknown' as const,
          retryDelay: 0,
        };

        if (error.message) {
          try {
            const parsed = JSON.parse(error.message);

            if (parsed.error || parsed.message) {
              errorInfo = { ...errorInfo, ...parsed };
            } else {
              errorInfo.message = error.message;
            }
          } catch {
            errorInfo.message = error.message;
          }
        }

        let errorType: LlmErrorAlertType['errorType'] = 'unknown';
        let title = 'Request Failed';

        if (errorInfo.statusCode === 401 || errorInfo.message.toLowerCase().includes('api key')) {
          errorType = 'authentication';
          title = 'Authentication Error';
        } else if (errorInfo.statusCode === 429 || errorInfo.message.toLowerCase().includes('rate limit')) {
          errorType = 'rate_limit';
          title = 'Rate Limit Exceeded';
        } else if (errorInfo.message.toLowerCase().includes('quota')) {
          errorType = 'quota';
          title = 'Quota Exceeded';
        } else if (errorInfo.statusCode >= 500) {
          errorType = 'network';
          title = 'Server Error';
        }

        /*
         * 🔴 A FAILED PHASE GETS ONE AUTOMATIC RETRY, AND THE BUILD CARRIES ON (§4.4e, 2026-08-14).
         *
         * Placed here because `handleError` is the ONE point every chat failure passes through, and it
         * has already parsed the status code the decision turns on. The alternative — a `useEffect`
         * watching `error` — would fire on renders as well as on failures, which is the "a generation
         * per render" hazard the runner is shaped around.
         *
         * The measured failure is provider-side and intermittent (`gen_mstgbuqo_pkhkhi`: 34,192 output
         * tokens, 5.4 minutes of silence, no text). At ~1-in-8 per phase a three-step build finishes
         * ~68% of the time; one retry per step takes it to ~96%. The failed generation was refunded,
         * so this retry is the first actual charge for the step.
         */
        if (context === 'chat' && phaseTurnRef.current) {
          const livePlan = newProjectModeStore.get()?.plan;
          const failedIndex = livePlan?.next ?? -1;
          const seen = phaseRetriesRef.current;
          const attempts = seen.index === failedIndex ? seen.attempts : 0;

          const retry = decideCreationPhaseRetry({
            plan: livePlan,
            attempts,

            /*
             * A Stop aborts the fetch, which surfaces here as an error. Re-running what the user just
             * cancelled is the worst possible answer to it, and it would be billed.
             */
            stopped: error?.name === 'AbortError' || Boolean(chatStore.get().aborted),
            unaffordable: errorInfo.statusCode === 402,
          });

          if (retry.kind === 'retry') {
            phaseRetriesRef.current = { index: failedIndex, attempts: attempts + 1 };
            retryingPhaseRef.current = true;
            phaseTurnRef.current = false;

            armedPhaseRef.current = retry.index;
            setArmedPhase(retry.index);

            /*
             * Said out loud, but as a toast rather than the red alert below: the user has nothing to
             * do and nothing has been lost. If the retry ALSO fails, `attempts` is spent and the
             * failure comes through here again — loudly, with the alert — which is the fail-loud rule
             * kept intact rather than traded away.
             */
            toast.info('That step did not come back — trying it once more.');

            return;
          }
        }

        logStore.logError(`${context} request failed`, error, {
          component: 'Chat',
          action: 'request',
          error: errorInfo.message,
          context,
          retryable: errorInfo.isRetryable,
          errorType,
          provider: provider.name,
        });

        /*
         * A failed CREATION turn is a failed post-create, never a failed creation (§4.4, owner rule
         * 2026-07-22). By the time any generation can error, phase 1 has already mounted and verified
         * the starter and registered the project — so the project exists, whatever the model did.
         *
         * Say so. The raw provider message ("Server Error", a 402, a dead render) is accurate about
         * the generation and completely wrong about the user's project, and reading it as "my game was
         * never created" is the reasonable interpretation when nothing says otherwise.
         */
        const description = creationTurnStore.get()
          ? `${errorInfo.message}\n\nYour project was still created from the starter template and is ready in the editor — only the build step failed. Ask me to build it and I will pick up from here.`
          : errorInfo.message;

        // Create API error alert
        setLlmErrorAlert({
          type: 'error',
          title,
          description,
          provider: provider.name,
          errorType,
        });
        setData([]);
      },
      [provider.name, stop],
    );

    const clearApiErrorAlert = useCallback(() => {
      setLlmErrorAlert(undefined);

      /*
       * A stale "this build did not finish" panel sitting above a turn that has since fixed it is a
       * lie the user can act on. Cleared whenever a new turn begins.
       */
      setTurnOutcomeAlert(undefined);
    }, []);

    useEffect(() => {
      const textarea = textareaRef.current;

      if (textarea) {
        textarea.style.height = 'auto';

        const scrollHeight = textarea.scrollHeight;

        textarea.style.height = `${Math.min(scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
        textarea.style.overflowY = scrollHeight > TEXTAREA_MAX_HEIGHT ? 'auto' : 'hidden';
      }
    }, [input, textareaRef]);

    const runAnimation = async () => {
      if (chatStarted) {
        return;
      }

      await Promise.all([
        animate('#examples', { opacity: 0, display: 'none' }, { duration: 0.1 }),
        animate('#intro', { opacity: 0, flex: 1 }, { duration: 0.2, ease: cubicEasingFn }),
      ]);

      chatStore.setKey('started', true);

      setChatStarted(true);
    };

    // Helper function to create message parts array from text and images
    const createMessageParts = (text: string, images: string[] = []): Array<TextUIPart | FileUIPart> => {
      // Create an array of properly typed message parts
      const parts: Array<TextUIPart | FileUIPart> = [
        {
          type: 'text',
          text,
        },
      ];

      // Add image parts if any
      images.forEach((imageData) => {
        // Extract correct MIME type from the data URL
        const mimeType = imageData.split(';')[0].split(':')[1] || 'image/jpeg';

        // Create file part according to AI SDK format
        parts.push({
          type: 'file',
          mimeType,
          data: imageData.replace(/^data:image\/[^;]+;base64,/, ''),
        });
      });

      return parts;
    };

    // Helper function to convert File[] to Attachment[] for AI SDK
    const filesToAttachments = async (files: File[]): Promise<Attachment[] | undefined> => {
      if (files.length === 0) {
        return undefined;
      }

      const attachments = await Promise.all(
        files.map(
          (file) =>
            new Promise<Attachment>((resolve) => {
              const reader = new FileReader();

              reader.onloadend = () => {
                resolve({
                  name: file.name,
                  contentType: file.type,
                  url: reader.result as string,
                });
              };
              reader.readAsDataURL(file);
            }),
        ),
      );

      return attachments;
    };

    /**
     * Create the project, then start the first generation (SPEC §4.4 / §4.4b / §4.4c).
     *
     * Every New Project path lands here — typed prompt (A), card (B), wizard (C).
     *
     * 🔴 **TWO PHASES, AND THE SECOND MAY NEVER TAKE DOWN THE FIRST (owner rule, 2026-07-22).**
     *
     *   **Phase 1 — CREATE. Mechanical, AI-free, and it either produces a project or it produces an
     *   error.** Clone the AppTemplate, mount it, verify it on disk, register it with the platform.
     *   No model is contacted, so nothing a model does can influence whether the user ends up with a
     *   project. When this phase returns, the project EXISTS and that fact is settled.
     *
     *   **Phase 2 — POST-CREATE. Hand the finished project over to the user.** Commit the setup
     *   artifact (whose actions run `npm install` and `npm run dev`), wait for the tree to settle, and
     *   carry the user's prompt into the chat textbox. Every failure here is a bad STATE of a project
     *   that exists, and every one is one prompt away from fixed — so phase 2 is wrapped in its own
     *   boundary and **still reports success**: the project is real, it is mounted, it is installing
     *   and running, and the user can keep working on it.
     *
     * 🔴 **NEITHER PHASE CONTACTS A MODEL (owner rule, 2026-07-29).** Creation is a clone: fetch the
     * starter, mount it, install it, run it, show the stock home page. It used to end by firing the
     * game build automatically — one `reload()` call, the most expensive generation in the product,
     * with the user watching a splash. Now the prompt goes into the textbox and the user sends it when
     * they are ready, against a project that is already running. *"Nothing else should be able to stop
     * the project from getting created."*
     *
     * This is why the "🎮 Your game is ready" toast is not fired here — there is no game yet. Phase 1 is
     * a guarantee, not a milestone worth announcing, and phase 2 hands over a starter, not a game.
     *
     * The failure the split exists to kill: one `catch` around both phases told a user whose project
     * had mounted perfectly that we "could not create the project from the starter template", because
     * an image render 500'd. Wrong message, and it makes a recoverable situation read as a total loss.
     *
     * `visiblePrompt` is what the user actually typed — the wizard's compiled text is hidden behind its
     * summary card, per §4.7 — and it is what belongs in the textbox. A card click types nothing, so
     * the box is left empty.
     */
    const runStartProject = async (options: {
      entry: GameRegistryEntry;
      prompt?: string;
      visiblePrompt?: string;
      matched?: string[];

      /**
       * Did the user PICK this entry, or is it just where a typed prompt lands? Defaults to
       * `explicit` because every path except Path A is a choice the user made; only the typed-prompt
       * path passes `inferred`. See `ProjectSeed.seedSource`.
       */
      seedSource?: 'explicit' | 'inferred';
    }): Promise<boolean> => {
      const { entry, prompt, visiblePrompt, matched, seedSource = 'explicit' } = options;
      const title = prompt ? deriveProjectTitle(prompt, entry.title) : entry.title;

      // ================= PHASE 1 — CREATE THE PROJECT. Nothing below may be skipped or deferred. ====

      /*
       * 🔴 THE PROJECT RECORD COMES FIRST NOW, BEFORE A SINGLE BYTE IS WRITTEN — and the ORDER is the
       * whole point (§4.5.3, `spec/sandbox-codesandbox.md`).
       *
       * A server-backed sandbox belongs to a project: `POST /api/sandbox/session` takes a project id,
       * runs it through `requireOwnedProject`, and records the VM on the row. So there is no sandbox to
       * write the starter INTO until the project exists. Registration used to happen after the mount —
       * correct when the runtime was a tab-local WebContainer that needed nothing, impossible now.
       *
       * If it fails the outcome depends on the runtime, and both answers are honest:
       *   - WebContainer: exactly as before — a local-only project, mounted and usable, that says so.
       *   - a server sandbox: there is nowhere to put the files, so this is a real creation failure and
       *     is reported as one rather than mounting into whatever VM happened to be connected.
       */
      let registeredProjectId: string | undefined;

      try {
        const project = await createProject({ name: title, templateId: entry.id });
        registeredProjectId = project.id;
        projectId.set(project.id);

        /*
         * 🔴 MINT THE SERVER CHAT ID HERE — before the generation, not at first save (§4.5.4c, §4.6).
         *
         * It used to be minted by `mintUrlId`, called from `storeMessageHistory` — which runs AFTER
         * the request has already gone out. The AI SDK refreshes its body from committed render
         * state, so a creation sent `chatId: undefined`, and that is the id everything downstream
         * keys on: the `generations` row recorded no chat (a 427-credit generation the audit trail
         * could not attribute), and `recoverTranscript` returned early because it had no key to
         * write against.
         *
         * That left the CREATION turn — the most expensive in the product, measured at 646 credits —
         * as the least protected: no chat id, and no checkpoint yet either, so a crash meant charged,
         * no record, no files. Minting alongside `projectId` puts it in the same committed render
         * state, which is the one we know reaches the wire.
         *
         * Free (a `crypto.randomUUID()`, not a write) and idempotent downstream: both
         * `ensureServerChatId` and `mintUrlId` return an id the atom already has, so this cannot
         * produce a second chat.
         */
        chatMetadata.set({
          ...chatMetadata.get(),
          projectId: project.id,
          serverChatId: chatMetadata.get()?.serverChatId ?? mintServerChatId(),
        });

        /*
         * A newly created project is UNLINKED. Reset the badge from any previous project's state and
         * then fetch this one's — fire-and-forget so it never delays the generation below (the fetch
         * also carries `configuredProviders`, which is what lets the Save badge offer a GitHub/GitLab
         * choice on a deployment that has both; without it Save silently defaults to GitHub, §4.5.4b).
         */
        repoStatus.set({ linked: false });
        void getRepoStatus(project.id)
          .then((status) => repoStatus.set(status))
          .catch((statusError) => {
            /*
             * Swallowed on purpose. This races the rollback below: a creation that fails takes the row
             * with it, and this in-flight read then 404s into an unhandled rejection reporting a
             * project the user was already told was not created. A badge is never worth an error.
             */
            logger.warn(`Could not read the repo status: ${(statusError as Error).message}`);
          });
      } catch (error) {
        projectId.set(undefined);
        logger.error(`Could not register the project with the server: ${(error as Error).message}`);

        /*
         * 🔴 A REFUSAL IS NOT AN OUTAGE, and the difference decides whether creation may continue.
         *
         * The fallback below exists for §1.3 principle 0 — an unreachable server must not stop someone
         * building — and it is correct for a 500 or a dropped connection. But a 402 is the platform
         * deliberately declining (the flat creation charge, §4.4a): degrading past it hands a user with
         * no credits a fully working project for free on the WebContainer provider, and tells them the
         * server was unreachable, which is false. Both halves are wrong, and neither throws.
         *
         * So a 402 stops creation on EVERY provider, and it is reported as what it is — the server's own
         * message names the price and the balance, so it is the whole alert rather than a "Details:" tail
         * under a headline blaming infrastructure.
         */
        if (error instanceof ApiError && error.statusCode === 402) {
          toast.error(error.message);
          setLlmErrorAlert({
            type: 'error',
            title: 'Not enough credits to start a project',
            description: error.message,
            errorType: 'quota',
          });
          setFakeLoading(false);

          return false;
        }

        if (SANDBOX_REQUIRES_PROJECT) {
          const message = 'We could not create your project on the server, so there is no workspace to build in.';
          toast.error(message);
          setLlmErrorAlert({
            type: 'error',
            title: 'No project was created',
            description: `${message}\n\nDetails: ${(error as Error).message}`,
            errorType: 'network',
          });
          setFakeLoading(false);

          return false;
        }

        toast.warn('This project is saved on this device only — we could not reach the server.');
      }

      let created: Awaited<ReturnType<typeof createProjectFromRegistry>>;

      try {
        created = await createProjectFromRegistry({ entry, title, projectId: registeredProjectId, seedSource });
      } catch (error) {
        /*
         * The only genuinely fatal outcome: the starter never arrived, or it did not land on disk.
         * There is no project, so there is nothing to salvage and nothing to prompt against.
         *
         * Say WHICH of those it was and what to do about it (`creation-errors.ts`). The message this
         * replaced — "Could not fetch the starter template (401)" — named the template for what is
         * almost always an expired session, sending the user to retry a button that cannot work until
         * they sign in.
         *
         * Surfaced TWICE on purpose: a toast to notice, and the error panel to still be readable
         * afterwards. A toast that has already faded is indistinguishable from a New Project button
         * that silently did nothing, which is exactly how this reads when it happens.
         */
        const failure = asCreationFailure(error);

        /*
         * 🔴 ROLL THE ROW BACK — see `creation-rollback.ts` for why an empty project is worse than no
         * project at all, and why the deletion lives in a tested module rather than in this closure.
         *
         * Fire-and-forget: it never rejects, and nothing below depends on the row being gone (T3b).
         */
        const orphanId = registeredProjectId;
        registeredProjectId = undefined;

        void rollbackRegisteredProject({
          projectId: orphanId,
          remove: deleteProject,
          clear: () => {
            projectId.set(undefined);
            chatMetadata.set({ ...chatMetadata.get(), projectId: undefined });
          },
          onError: (cleanupError) => logger.error(`Could not roll back the empty project ${orphanId}`, cleanupError),
        });

        logger.error(`Project creation failed — ${failure.message} (${failure.detail})`, error);
        toast.error(failure.message);
        setLlmErrorAlert({
          type: 'error',
          title: 'No project was created',
          description: failure.isRetryable
            ? `${failure.message}\n\nDetails: ${failure.detail}`
            : `${failure.message}\n\nDetails: ${failure.detail}\n\nTrying again will not help until this is resolved.`,
          errorType: failure.isRetryable ? 'network' : 'authentication',
        });
        setFakeLoading(false);

        return false;
      }

      const { assistantMessage, className, mustBeVisible } = created;

      /*
       * From here on the project EXISTS in the sandbox. Everything that follows is best-effort by
       * construction: the catch at the bottom returns `true`, because "did the user get a project?" is
       * already answered yes and no later failure may change that answer.
       */
      try {
        // The rest of the splash's story: the mount-visibility wait below.
        bootProgress.set({ step: 'creating-finalize' });

        setProjectSeed({ entry, className, title, prompt, visiblePrompt, matched, seedSource });

        /*
         * The project exists and has never been built in — enter New Project mode so the handoff card
         * offers the next step. Done BEFORE the waits below so a user who reloads mid-wait still comes
         * back to a project that knows what it is. There is no creation brief anymore (owner,
         * 2026-08-08): the first build turn sends only the user's own words, and the baked system
         * prompt owns the landing/chrome/play-contract rules.
         *
         * 🔴 THE USER'S OWN WORDS ARE PERSISTED HERE, BECAUSE NOTHING ELSE PERSISTS THEM.
         *
         * They used to live only in the in-memory `projectSeedStore` with the `cachedPrompt` cookie
         * quietly covering the gap — and that cookie is exactly what made the prompt reappear in the
         * chat box like leftover state, and what leaked it onto the NEXT visit to the landing page. The
         * handoff card shows these words and its actions send or edit them, so a reload mid-decision
         * must not lose the one prompt in the product the user did not just type.
         *
         * On the wizard path `prompt` is the COMPILED selections (genre + vibe + mechanics + twist) and
         * `visiblePrompt` the short summary. With no hidden channel left, the compiled text IS the
         * carried prompt — the choices the user explicitly made must reach the model, and showing them
         * on the card is a quotation of an offer they accepted, not machine words in their mouth.
         */
        const handoff = {
          userPrompt:
            (prompt && visiblePrompt && prompt !== visiblePrompt
              ? prompt
              : draftTextForSeed({ prompt, visiblePrompt })) || undefined,

          /*
           * 🔴 An explicitly chosen Blank Canvas is NOT phased (owner, 2026-08-14) — see
           * `isBlankCanvasStart`, which needs the seed SOURCE as well as the entry because every typed
           * prompt lands on that same fallback row. Recorded here, at the one moment both facts are in
           * hand: `projectSeedStore` is in-memory and gone on reload, and the send that reads this can
           * happen days later on another device.
           */
          ...(isBlankCanvasStart({ isFallbackEntry: Boolean(entry.is_fallback), seedSource })
            ? { blankCanvas: true }
            : {}),
        };

        enterNewProjectMode({ projectId: registeredProjectId ?? '', ...handoff });

        /*
         * 🔴 AND ON THE PROJECT ROW, because "created but never built" is a fact about the PROJECT
         * (migration 0016). Held only in this browser it was a fact about a DEVICE: an unbuilt project
         * opened elsewhere showed no handoff card and lost the carried prompt. Fire-and-forget for the
         * same reason the checkpoint below is: the project exists and runs, and the safety net must not
         * take it down. An unregistered project has no row to write to.
         */
        if (registeredProjectId) {
          void saveCreationHandoff(registeredProjectId, handoff).catch((error) => {
            logger.error('Could not store the creation handoff on the project', error);
          });
        }

        /*
         * 🔴 ONE MESSAGE, AND IT IS NOT THE USER'S (owner rule, 2026-07-29 — creation is a clone).
         *
         * Creation used to commit three messages and then fire a generation: the user's visible prompt
         * (`1-`), this setup artifact (`2-`), and the hidden creation brief (`3-`). Two of those existed
         * only to feed a model that no longer runs here. What remains is the artifact — and it is doing
         * three jobs, none of them decorative:
         *
         *   1. **It is what installs and runs the project.** Its `shell`/`start` actions are executed by
         *      the message parser's action runner, entirely independently of any generation. `npm install`
         *      and `npm run dev` have always been driven from here, never by the model.
         *   2. **It mints the chat's identity.** `description` derives from `firstArtifact?.title ??
         *      summarizeRequest(firstUserMessage)` and the artifact carries the project title — so the
         *      chat is listed in the sidebar with no user message present. A chat needs BOTH a `urlId`
         *      and a `description` to be visible at all; drop this message and a brand-new project is
         *      invisible until the user's first send.
         *   3. **It is the user's evidence the project exists** — an empty chat beside a running preview
         *      reads as a failure.
         *
         * The user's own words are not committed here at all: they go into the TEXTBOX, for the user to
         * edit and send themselves. So the first user message in the transcript is one the user actually
         * sent — which is more honest than what it replaced, where the never-dropped "original brief"
         * (`history.ts`) was a message they never wrote.
         */
        const setupMessageId = `2-${new Date().getTime()}`;
        setMessages([{ id: setupMessageId, role: 'assistant', content: assistantMessage }]);

        /*
         * 🔴 THE WAITS STAY, AND THEY ARE NOW FOR THE USER RATHER THAN FOR THE MODEL.
         *
         * These two waits were placed here to protect the generation that used to fire on the next line:
         * the model reads `workbenchStore.files`, which a watcher fills ASYNCHRONOUSLY, and it was once
         * measured being asked to write a racing game having been shown SEVEN files of a 78-file tree,
         * none of them source (it said so — "I can't see its source" — and that was read as caution
         * rather than as the bug report it was). The second half was `projectId`: the AI SDK refreshes
         * its request body from a committed render, so an unyielded creation posted `projectId:
         * undefined` and the server's ownership check and per-project attribution both got nothing.
         *
         * No generation fires here any more, so BOTH of those specific races are gone. Keeping the waits
         * is not superstition:
         *
         *   - **The user is about to look at this tree.** The next thing they see is a file explorer and
         *     a preview of their new project. Coming down while the watcher is still draining shows them
         *     a half-populated project and calls it created.
         *   - **A mount tail leaks into whatever reads the store next** — the install/dev actions, the
         *     first checkpoint serialize, the first build turn. Removing a settle wait is how that tail
         *     becomes somebody else's intermittent bug.
         *   - **`projectId` still has to reach a committed render before the user's first send**, and
         *     yielding here is what guarantees it did — the send is now minutes later rather than
         *     microseconds, which makes it safe, not unnecessary.
         */
        await waitForMountVisible(mustBeVisible);

        /*
         * THE PROJECT IS CREATED. THE BUILD HAS NOT STARTED. That order is the hard rule, and this is
         * the seam between its two halves (`registry/settle.ts`).
         *
         * `waitForMountVisible` above returns the instant its sentinels appear — but the watcher is
         * still draining the rest of the tree behind them, and on a server sandbox each of those files
         * is a round trip rather than a memory write. So we hold here until the file map STOPS CHANGING
         * (bounded 5–10s: a floor, because a watcher that has not started yet is trivially "quiet", and
         * a ceiling, because the button must never hang — §1.3 principle 0).
         *
         * The phase is set FIRST so the splash says "Project created / Preparing to build your
         * frontend…" for the whole wait. That is not decoration: it is the moment the user's project
         * exists, and up to now the UI implied it was still being assembled.
         */
        bootProgress.set({ step: 'creating-settle' });

        const settled = await settleAfterCreation({
          readCount: () => Object.keys(workbenchStore.files.get()).length,
        });

        logger.info(
          `Creation settled after ${settled.elapsedMs}ms with ${settled.finalCount} files ` +
            `(${settled.quiesced ? 'quiesced' : 'ceiling reached'}) — installing`,
        );

        /*
         * 🔴 THE SPLASH COMES DOWN BEFORE THE INSTALL, NOT AFTER IT (owner, 2026-08-03: *"I don't like
         * the 'Installing project dependencies' splash screen state — at that stage we should see the
         * workspace and the dependencies being installed in our Nodepod Terminal"*).
         *
         * This REVERSES the 2026-07-29 rule that had the splash cover install+serve, whose reasoning was
         * that they would otherwise "run in a terminal nobody is looking at". The terminal IS the thing
         * to look at — it is the honest, moving account of a step that can take a minute, and hiding it
         * behind a spinner replaces information with a wait. It also makes creation and re-open behave
         * the same way, which they did not: re-opening a project has always installed with the workbench
         * on screen (`ensureRunnableOnce`), so the two most similar moments in the product looked like
         * different products.
         *
         * The wait below is UNCHANGED and still bounded — it is what makes "a project that is not
         * running is not created" true, and it still gates the rest of the creation flow. It simply no
         * longer covers the screen while it runs.
         *
         * The work itself is not driven from here either: the setup artifact's `shell` and `start`
         * actions were handed to the action runner when the message was committed above. This only
         * WATCHES them.
         */
        bootProgress.set({ step: 'idle' });

        const running = await awaitStarterRunning({
          /*
           * What counts as "installed" is a decision, and it lives in `starter-ready.ts` where it is tested.
           *
           * ⚠️ `firstArtifact` is `artifactIdList[0]` — the first artifact of the TAB, not of this project.
           * A second creation inside one page load would read the previous project's already-complete
           * shell action and skip the wait entirely (it would end immediately; nothing breaks). Every
           * route into creation forces a full page load today (§T19), which is the same assumption the
           * chat's `description` derivation already rests on — but if that ever stops being true, this
           * reads the wrong artifact.
           */
          installComplete: () =>
            isInstallFinished(Object.values(workbenchStore.firstArtifact?.runner.actions.get() ?? {})),
          runningPreviews: () => workbenchStore.previews.get().length,
          wait: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),

          /*
           * No `onStage`: the stages are narrated by the terminal the user is now looking at. Setting a
           * boot phase here would raise the splash back over a workspace that is already on screen —
           * see the note above, and the same mistake made one door over in `ensureRunnableOnce`.
           */
        });

        logger.info(
          `Starter ${running.serving ? 'is serving' : 'has not opened a port yet'} after ${running.elapsedMs}ms ` +
            `(install ${running.installed ? 'finished' : 'still running'})`,
        );

        /*
         * 🔴 CREATION ENDS HERE. IT DOES NOT BUILD THE GAME.
         *
         * `reload()` used to be the next line, and that ONE line was the entire game build — the most
         * expensive generation in the product, fired automatically at the end of a clone. It is gone.
         * A New Project is now exactly what the name says: fetch the starter, mount it, install it, run
         * it. Nothing a model does can decide whether the user ends up with a project, because no model
         * is contacted at all. The user's prompt is carried into the textbox instead, for them to edit
         * and send when they are ready.
         *
         * Two deletions here that are easy to re-add by reflex, both of which would be wrong:
         *
         *   - **`creationCompleteRef` is NOT armed.** It fires "🎮 Your game is ready"; there is no game
         *     yet. Arming it here would celebrate an untouched starter. It belongs to the first build
         *     turn.
         *   - **The textarea is NOT blurred, and the attachments are NOT cleared.** Both existed because
         *     the send had already happened. It has not. Blurring would fight the handoff card's Edit
         *     action for the caret, and clearing `uploadedFiles`/`imageDataList` would silently destroy
         *     images the user picked before pressing New Project — they now ride the build turn instead.
         */
        /*
         * 🔴 THE BOX IS LEFT EMPTY — THE PROMPT GOES TO THE CARD (owner, 2026-07-29).
         *
         * This used to prefill the textbox with the user's words and write them back to the
         * `cachedPrompt` cookie. Both are gone. Text arriving in a box nobody typed into reads as
         * leftover state rather than as the next step (*"it kind of feels disconnected to the initial
         * project creation process"*), and the cookie leaked the prompt onto the NEXT visit to the
         * landing page. The words are carried on the mode (`userPrompt`, above), shown by
         * `CreationHandoffCard`, and reach the box only if the user presses Edit or X.
         *
         * `clearDraftPrompt()` still runs, and it is not a leftover: the landing-page draft is still
         * sitting in the input and in a cookie, plus a debounced write that fires up to a second later
         * — so clearing it here is the only thing that stops the old text being in the box behind the
         * card.
         */
        clearDraftPrompt();

        setVaguePrompt(null);
        resetEnhancer();
        setFakeLoading(false);

        /*
         * 🔴 NO SUCCESS TOAST. The card IS the surface for "your project is ready", and it says so in
         * its heading — a toast repeating it would be a second, shorter-lived copy of the same sentence
         * competing with the thing the user is supposed to read and act on. The "🎮 Your game is ready"
         * celebration is a different moment entirely and belongs to the first build turn (armed in
         * `sendMessage`); firing anything like it here would congratulate the user on an untouched
         * template.
         */

        /*
         * 🔴 CHECKPOINT THE FRESH PROJECT — nothing else will (found live, 2026-07-29).
         *
         * This call does TWO jobs, and for most of its life only one of them was written down.
         *
         * **The transcript** (why it was added). The server copy of a conversation is written by
         * `checkpointProject` at the END of a generation, and creation no longer runs one. So a
         * created-but-not-yet-built project uploaded NOTHING: `/api/chats` returned `[]`, the sidebar
         * read "No previous conversations" next to an open chat, and the dashboard card said "No chats
         * yet" — on a device that was looking straight at the project. §4.5.6's rule is that the sidebar
         * lists the ACCOUNT's chats, so a project created on a laptop simply did not exist on the
         * desktop until its first build landed. The old flow hid this: creation ended by firing a
         * generation, and that generation's checkpoint uploaded the transcript as a side effect.
         * Removing the generation removed the upload with it — a dependency nobody had written down.
         *
         * 🔴 **The BASELINE** (why it must keep happening). `checkpointProject` also writes a LOCAL
         * checkpoint of the files, and here that is the stock starter before a single credit of
         * generation has been spent — the one state a user can always be returned to, and the anchor
         * "discard my changes" means something against. That was pure luck: this call was reasoned
         * about entirely as a transcript fix, so an optimisation that uploaded only the chat would have
         * deleted the baseline with nothing failing and nothing saying so.
         *
         * `CREATION_CHECKPOINT_LABEL` is what makes it non-incidental — it names the row in §4.12's
         * restore UI (which otherwise names checkpoints after the message they follow, and creation has
         * no message), and it gives `creation-checkpoint.spec.ts` something to assert that a
         * `toHaveBeenCalled` on a mock cannot.
         *
         * Fire-and-forget with the same posture as the post-generation call: this is the safety net,
         * and a net that fails must never take the thing it was protecting down with it. It cannot
         * fail silently — every branch inside `checkpointProject` is loud.
         */
        void checkpointProject(setupMessageId, { label: CREATION_CHECKPOINT_LABEL }).catch((error) => {
          logger.error('Could not checkpoint the freshly created project', error);
        });

        return true;
      } catch (error) {
        /*
         * 🔴 POST-CREATE FAILED, THE PROJECT DID NOT. Returns `true` deliberately — the starter is
         * mounted and verified, so the honest answer to "was a project created?" is yes, and a `false`
         * here would send the caller down a path that tells the user otherwise.
         *
         * Recoverable by prompting, which is exactly what we say. The spinner is cleared so the chat
         * box is usable immediately; nothing is unwound.
         */
        logger.error('Post-create failed — the project exists and is usable', error);
        toast.warn('Your project was created, but the last setup step did not finish. It is safe to keep working.');
        setFakeLoading(false);

        return true;
      }
    };

    /*
     * Every creation entry point goes through here so the splash lifecycle has ONE owner: the
     * `creating-*` phases (set inside `createProjectFromRegistry` and the finalize step) drive
     * `WorkspaceSplash`, and the `finally` guarantees it comes down on every exit — success, fatal
     * refusal, or a post-create failure. A stale phase would leave a full-screen overlay squatting
     * on a usable chat, which is worse than the blank screen it replaces.
     */
    const startProject = async (options: Parameters<typeof runStartProject>[0]): Promise<boolean> => {
      try {
        return await runStartProject(options);
      } finally {
        bootProgress.set({ step: 'idle' });
      }
    };

    /** §4.4a Path B — a picked card is explicit input: create it and go. No wizard. */
    const handleSelectEntry = async (entry: GameRegistryEntry) => {
      /*
       * 🔴 A CARD IS A GENRE CHOICE, NOT A REASON TO THROW THE USER'S WORDS AWAY (fixed 2026-07-29,
       * reported live).
       *
       * The landing page offers a textbox AND a row of genre cards, so "type what you want, then click
       * the genre you meant" is an obvious thing to do — and it silently discarded the typing: this
       * handler never read `input`. The project came out named after the CARD ("Arcade Racing"), the
       * carried prompt was empty because there was no prompt to carry, and the user was left looking at
       * a New Project banner telling them to edit a prompt that had just been deleted.
       *
       * Both inputs are explicit, so both are honoured — §4.4a's precedence rule is about explicit input
       * beating INFERENCE, and nothing here is inferred: the card picks the entry (better than keyword
       * seeding could), the typed words are the brief (and the project title). Empty box → the card path
       * exactly as before.
       */
      const typed = input.trim();

      runAnimation();
      setFakeLoading(true);

      /*
       * 🔴 A CARD WITH AN EMPTY BOX STILL CARRIES A BRIEF (owner, 2026-07-29, reported live).
       *
       * It used to carry nothing, so the handoff card offered *Describe your game* — asking the user to
       * type out the genre they had just picked from a menu, which defeats the quick-pick row entirely.
       * The card's own title and copy are the offer they accepted, so those are the brief.
       *
       * ⚠️ It rides on `visiblePrompt`, NOT `prompt`, and the distinction is load-bearing in two places
       * one line apart in `runStartProject`: `prompt` derives the project TITLE (so passing it here
       * would rename "Arcade Racing" to something squeezed out of the card's marketing copy), and
       * `prompt && visiblePrompt && prompt !== visiblePrompt` is the WIZARD branch, which carries the
       * compiled selections in preference to the summary — so passing both would take that branch and
       * silently drop this text from the carried prompt. With `prompt` undefined the title stays the
       * card's, the wizard branch cannot fire, and `draftTextForSeed` resolves the carried words to this
       * text.
       *
       * The fallback row returns `undefined` on purpose — see `briefFromRegistryEntry`.
       */
      await startProject(
        typed.length > 0 ? { entry, prompt: typed } : { entry, visiblePrompt: briefFromRegistryEntry(entry) },
      );
    };

    /** §4.4a Path C — the wizard's four steps compile to the first message (§4.7). */
    const handleCompleteTour = async (selection: WizardSelection) => {
      runAnimation();
      setFakeLoading(true);
      await startProject({
        entry: selection.entry,
        prompt: compileWizardPrompt(selection),
        visiblePrompt: summarizeSelection(selection),
      });
    };

    /**
     * The vague-prompt offer (§4.4a): "Want a guided setup, or just start from a blank scene?"
     * Choosing the blank scene still runs the user's words — they are not thrown away.
     */
    const handleVagueChoice = async (choice: 'tour' | 'blank') => {
      if (choice === 'tour') {
        return;
      }

      const fallback = findFallbackEntry(registryEntries);

      if (!fallback) {
        return;
      }

      const prompt = vaguePrompt ?? undefined;
      setVaguePrompt(null);
      runAnimation();
      setFakeLoading(true);
      await startProject({ entry: fallback, prompt });
    };

    /** The seed chip's "change" (§4.4a step 3) — re-seed from another entry and re-run the prompt. */
    const handleReseed = async (entry: GameRegistryEntry) => {
      const seed = projectSeedStore.get();
      setFakeLoading(true);
      await startProject({ entry, prompt: seed?.prompt });
    };

    /**
     * Debounced function to cache the prompt in cookies.
     * Caches the trimmed value of the textarea input after a delay to optimize performance.
     */
    const debouncedCachePrompt = useCallback(
      debounce((event: React.ChangeEvent<HTMLTextAreaElement>) => {
        const trimmedValue = event.target.value.trim();
        Cookies.set(PROMPT_COOKIE_KEY, trimmedValue, { expires: 30 });
      }, 1000),
      [],
    );

    /**
     * Forget the draft prompt EVERYWHERE it lives: the pending debounced write (which would
     * otherwise fire up to 1s AFTER this and resurrect the text), the cookie that seeds
     * `initialInput` on the next mount, and the controlled input itself. Observed live: `/clear`
     * left "/clear" sitting in the chat box with the slash menu open on the freshly cleared chat —
     * the SPA remount read the cookie straight back.
     */
    const clearDraftPrompt = () => {
      debouncedCachePrompt.cancel();
      Cookies.remove(PROMPT_COOKIE_KEY);
      setInput('');
    };

    /**
     * Move the handoff card's text into the chat box (§4.4a).
     *
     * The ordering hazard — clear first, because the pending debounced cookie write fires up to a
     * second LATER and would resurrect the old draft — lives in `applyCreationDraft`, which is why
     * both call sites go through it rather than writing three statements each.
     *
     * `focus` is the whole difference between the actions: **Edit brief** and **Describe your game**
     * are requests to type, so the caret goes to the box; the card's **X** is not, so it does not.
     */
    const fillChatBox = (text: string, options: { focus: boolean }) => {
      applyCreationDraft(
        text,
        {
          clearDraft: clearDraftPrompt,
          applyDraft: (value) => {
            /*
             * Through the same synthetic-event convention the web-search insert uses, so the value lands
             * in `useChat`'s input state exactly as typing would.
             *
             * 🔴 AND IT IS PERSISTED, BECAUSE FROM HERE ON IT IS AN ORDINARY DRAFT (found live).
             *
             * Both actions that land here also CLOSE the card, and that dismissal is persisted — so
             * without this write the sequence "press Edit, get distracted, reload" came back to a
             * dismissed card AND an empty box, with the words still sitting on the mode where nothing
             * surfaces them. Silently unreachable, and it is the one prompt in the product the user did
             * not just type and cannot retype from memory.
             *
             * This is NOT the cookie write that was removed from creation. That one fired without the
             * user asking, which is what leaked one project's prompt onto the next visit to the landing
             * page; this one is the user having taken the text into their box, where the debounced write
             * would have persisted it anyway had they typed it themselves. Written directly rather than
             * debounced: a reload inside the debounce window is exactly the case being fixed.
             */
            handleInputChange({ target: { value } } as React.ChangeEvent<HTMLTextAreaElement>);
            Cookies.set(PROMPT_COOKIE_KEY, value.trim(), { expires: 30 });
          },
          focusDraft: (caret) => {
            /*
             * Deferred a tick: the textarea is CONTROLLED, so its DOM value is still the old one until
             * React commits the state written above, and a `setSelectionRange` against a shorter value
             * clamps — the caret would land in the middle of the prompt instead of at its end.
             */
            setTimeout(() => {
              const textarea = textareaRef.current;

              if (!textarea) {
                return;
              }

              textarea.focus();
              textarea.setSelectionRange(caret, caret);
            }, 0);
          },
        },
        options,
      );
    };

    /**
     * **Build my game** — the first build turn, sent from the card.
     *
     * 🔴 Goes through the ORDINARY `sendMessage`, never a second send path. Every behavioural protection
     * on a first build turn hangs off that function (the mode clear, the row's handoff clear, the premium
     * lock, the celebration arming, the attachment handling); a private "just post it" shortcut here
     * would have all of them silently absent, on the most expensive turn in the product.
     */
    const handleCreationBuild = (prompt: string) => {
      void sendMessage({} as React.UIEvent, prompt);
    };

    /**
     * **Plan my brief** — fill the box with `/bt-plan <brief>` AND switch to Plan mode (§4.2.9, §4.4a).
     *
     * 🔴 **Both halves, or neither is worth having** (owner, 2026-08-09). The prefix asks the `bt-plan`
     * skill to produce an ordered task list; Plan mode is what makes the turn READ-ONLY — the server's
     * discuss note, the `skills-only` toolset (no media debits, no MCP writes) and the `NO_REPLAY` mark
     * that routes the reply through the render-only parser, with `_specs/**` as the one write door so
     * the plan file itself can land. Prefix alone leaves a turn that is free to rewrite the project
     * while the user believes they asked for a plan.
     *
     * Setting the mode here is safe where it would NOT be on Build: this sends nothing, so React has
     * committed the state (and `useChat` has refreshed its request body) long before the user presses
     * enter. `Messages.client.tsx`'s "Build & Apply" needs a per-request `body` override for exactly the
     * opposite reason — it sends immediately, and `setChatMode` does not apply until the next render.
     */
    const handleCreationPlan = (prompt: string) => {
      setChatMode('discuss');
      fillChatBox(prompt, { focus: true });
    };

    /**
     * "New chat, same game" — IN PLACE (§4.5.6, §4.2.9, `chat-reset.ts`).
     *
     * Clears the CONVERSATION and nothing else. The project stays mounted exactly as it is: files,
     * WebContainer, preview, `showWorkbench` and `chatStore.started` are all deliberately absent from
     * this function. The previous behaviour re-mounted the project through the dashboard's baton path,
     * so asking for an empty chat visibly reloaded the whole workspace.
     *
     * `chatStarted` is likewise left TRUE — the open-state effect keys on `activeProjectId`, which has
     * not changed, and flipping it back would replay the landing intro over a project that is open.
     */
    const clearConversation = () => {
      if (isLoading) {
        // A generation in flight belongs to the conversation being cleared; it must not stream into the new one.
        abort();
      }

      clearDraftPrompt();
      resetContextStats();
      resetParsedMessages();
      setMessages([]);
      setData(undefined);

      // A user-initiated reset ends any repair chain in progress (§4.2.7), for the same reason a typed message does.
      repairAttemptRef.current = 0;
      repairWatch.current = null;

      /*
       * And it ends any pending celebration: `abort()` above only runs while a generation is streaming,
       * so a build that died on `onError` would leave the ref armed for the fresh chat to fire.
       */
      creationCompleteRef.current = false;

      /*
       * 🔴 And it ends any creation PLAN in progress (§4.4e). `/clear` means "forget this
       * conversation", and a phase plan is conversation-scoped work — the phases build on each other's
       * files and refer to a brief that is about to stop being in the history.
       *
       * Without this, the local plan survives the reset and the next thing the user types is treated
       * as a RESUME: "make the car red" would post as the front-end phase and march a four-phase build
       * to completion. The row keeps its handoff, so the project correctly still owes a build and the
       * card can offer one — this only stops the next message being silently conscripted into it.
       */
      armedPhaseRef.current = null;
      setArmedPhase(null);
      phaseTurnRef.current = false;
      setPhasePause(null);

      /*
       * ⚠️ Only a plan that has actually STARTED. A `/clear` on a freshly created project — an
       * ordinary thing to type before building anything — must leave the mode and its handoff card
       * exactly where they are, which is the rule `a slash command never consumes the mode` pins. The
       * mode is only spent by a build, and this is the other end of the same rule: it is released by
       * one too.
       */
      const clearedMode = newProjectModeStore.get();

      if (clearedMode?.plan) {
        exitNewProjectMode(clearedMode.projectId);
      }

      // Identity, history and the URL — the half that lives in `useChatHistory`.
      startFreshChat();
    };

    /*
     * The ⋯ menu's "New chat" reaches the conversation from OUTSIDE this component, so it asks through a
     * signal store rather than a callback (`chat-reset.ts`). Seeded from the CURRENT value, not 0: the
     * store is module-level and survives an SPA navigate, so a fresh mount must not replay a reset that
     * already happened.
     */
    const resetRequest = useStore(chatResetRequest);
    const lastResetRequest = useRef(resetRequest);

    useEffect(() => {
      if (resetRequest === lastResetRequest.current) {
        return;
      }

      lastResetRequest.current = resetRequest;
      clearConversation();
    }, [resetRequest]);

    const sendMessage = async (_event: React.UIEvent, messageInput?: string) => {
      const messageContent = messageInput || input;

      if (!messageContent?.trim()) {
        return;
      }

      if (isLoading) {
        abort();
        return;
      }

      /*
       * `/clear` — the Claude-Code-style spelling of "New chat, same game" (§4.5.6). Intercepted HERE,
       * before anything is posted: it costs zero credits, and it takes the SAME path as the ⋯ menu's
       * "New chat" so the two cannot mean different things.
       *
       * With a project open the conversation is cleared IN PLACE — the project is already mounted, and
       * re-mounting it to empty a chat is what made this look broken. With no project there is nothing
       * to keep: that case is the sidebar's "Start new chat", a plain full-page load of `/` (an SPA
       * navigate would inherit the old chat's identity — §4.5.6).
       */
      const clientCommand = parseClientCommand(messageContent);

      if (clientCommand?.kind === 'clear') {
        if (activeProjectId) {
          clearConversation();
        } else {
          clearDraftPrompt();
          resetContextStats();
          window.location.href = '/';
        }

        return;
      }

      /*
       * `/context` — the Claude-Code-style context report (§4.5.6). Pure client toggle: the panel
       * renders the stats the server annotated onto the last generation. Nothing is posted.
       */
      if (clientCommand?.kind === 'context') {
        clearDraftPrompt();
        contextPanelOpen.set(true);

        return;
      }

      /*
       * `/effort` — the thinking-effort picker (§4.2.9). Pure client toggle, like `/context`: it changes a
       * session preference the NEXT generation carries, so nothing is posted and nothing is charged.
       */
      if (clientCommand?.kind === 'effort') {
        clearDraftPrompt();
        contextPanelOpen.set(false);
        effortPanelOpen.set(true);

        return;
      }

      /*
       * A message the USER typed is not a repair, and it ends any repair chain in progress (§4.2.7).
       * Without this reset, a build error hours later would inherit a stale attempt count and either
       * skip the auto-fix entirely or be misfiled against a generation that is long gone.
       */
      repairAttemptRef.current = 0;
      repairWatch.current = null;

      let finalMessageContent = messageContent;

      if (selectedElement) {
        console.log('Selected Element:', selectedElement);

        const elementInfo = `<div class=\"__boltSelectedElement__\" data-element='${JSON.stringify(selectedElement)}'>${JSON.stringify(`${selectedElement.displayText}`)}</div>`;
        finalMessageContent = messageContent + elementInfo;
      }

      runAnimation();

      /*
       * 🔴 "Do we need to CREATE a project?" — never "is the chat empty?" (§4.5.6).
       *
       * This was `if (!chatStarted)`, and `chatStarted` is seeded from `initialMessages.length > 0`. An
       * empty chat on an EXISTING project — "New chat, same game", or a dashboard Open of a project
       * whose conversation lives on another device — satisfied that, so the first message ran the
       * new-project path: it mounted a fresh template over the user's game and registered a SECOND
       * project named after their prompt. Measured: opening "Kart Racer" and typing "add a boost pad to
       * the track" created a new project called "Add A Boost Pad".
       *
       * The question the branch is actually asking is whether a project exists yet, so it asks that.
       */
      if (!chatStarted && !activeProjectId) {
        setFakeLoading(true);

        /*
         * §4.4a Path A: seed from the registry and RUN. No LLM round-trip, no wizard, no "now pick a
         * template" after the user has already said what they want. The ONLY prompt that does not go
         * straight to a generation is one with nothing in it to act on — and that one is offered the
         * wizard, never forced into it.
         */
        const decision = decideSeed(finalMessageContent, registryEntries);

        if (decision.kind === 'vague') {
          setVaguePrompt(finalMessageContent);
          setFakeLoading(false);

          return;
        }

        const seeded = await startProject({
          entry: decision.entry,
          prompt: finalMessageContent,
          matched: decision.kind === 'matched' ? decision.matched : undefined,

          /*
           * The ONE inferred path. `decideSeed` no longer guesses a genre, so this entry is the
           * fallback row rather than anything the user asked for — the surfaces downstream must not
           * report it back as a starter they chose (`ProjectSeed.seedSource`).
           */
          seedSource: 'inferred',
        });

        if (seeded) {
          return;
        }

        // Creation failed — fall through and let the user's message run against an empty workspace.
        const userMessageText = `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${finalMessageContent}`;
        const attachments = uploadedFiles.length > 0 ? await filesToAttachments(uploadedFiles) : undefined;

        setMessages([
          {
            id: `${new Date().getTime()}`,
            role: 'user',
            content: userMessageText,
            parts: createMessageParts(userMessageText, imageDataList),
            experimental_attachments: attachments,
          },
        ]);
        reload({ ...(attachments ? { experimental_attachments: attachments } : {}), body: liveTurnBody() });
        setFakeLoading(false);
        clearDraftPrompt();

        setUploadedFiles([]);
        setImageDataList([]);

        resetEnhancer();

        textareaRef.current?.blur();

        return;
      }

      /*
       * 🔴 LEAVE NEW PROJECT MODE ON SEND, AND ONLY HERE (§4.4a).
       *
       * Placement is the whole rule, in both directions:
       *
       *   - **After the client-command interceptions above**, because `/context` or `/effort` on a
       *     freshly created project is an ordinary thing to type and posts nothing. Clearing at the top
       *     of the handler would silently spend the mode — and with it the carried prompt, the premium
       *     lock and the game-ready celebration — on a command that was never a build.
       *   - **Before the post below**, because a mode that outlives its own send is a mode a second,
       *     fast send reads again.
       *
       * And on SEND rather than on finish: a build that fails is one the user retries, and that retry is
       * still the first build. Being the first build is a fact about the first message the user sends,
       * not about the first one that worked.
       */
      /*
       * ⚠️ Whether the mode is OURS is the mode's question, not `activeProjectId`'s — and gating on a
       * truthy project id gets the degraded path exactly backwards. When registration failed there is no
       * project id at all, and the mode is stored under an empty one (`enterNewProjectMode`) because it
       * belongs to whatever is open. Reading it only `if (activeProjectId)` therefore meant that on the
       * one path that already lost something, the brief was never appended (so all ten server
       * protections stayed off) and the mode was never cleared (so the premium pill stayed locked for
       * the rest of the session on a project that had since been built). Same rule as `isCreationTurn`'s,
       * written once in each place it is asked.
       */
      const storedMode = newProjectModeStore.get();
      const newProjectMode =
        storedMode && (!storedMode.projectId || storedMode.projectId === activeProjectId) ? storedMode : null;

      /*
       * 🔴 A PLAN TURN ARMS NOTHING (owner-reported live, 2026-08-15).
       *
       * *"When you hit `Plan my brief` it should NOT use the three stages card and try the multi stage
       * build — [it should] use a skill, like `/bt-plan`."*
       *
       * The handoff card offers Build and Plan side by side and both leave New Project mode, so this
       * block armed the §4.4e phased plan for either — the three-stage `CreationPlanCard` appeared, and
       * `decideNextCreationTurn` then auto-posted the remaining phases as BUILD turns off the back of a
       * turn the user had explicitly asked to be read-only. The user pressed the button that means
       * "think about it first" and got the build anyway.
       *
       * 🔴 And the handoff is NOT cleared here either, which is the half that is easy to get wrong. A
       * plan turn leaves the project still owing its build, so the row must survive: it is what makes
       * the LATER build a first build turn (`projectOwesBuild`) — with its brief, its skill pair, its
       * completeness pass and its §4.6 no-files refund. Clearing it would let the plan land and then
       * silently downgrade the build that follows into an ordinary edit.
       *
       * Reading `chatMode` (committed render state) is safe here for the same reason the Plan button
       * can set it: the button SENDS NOTHING, so React has committed and `useChat` has refreshed its
       * request body long before the user presses enter.
       */
      const isPlanTurn = chatMode === 'discuss';

      if (newProjectMode && !isPlanTurn) {
        /*
         * 🔴 THE BUILD STARTS A PLAN; IT NO LONGER CLEARS THE HANDOFF (§4.4e, 2026-08-14).
         *
         * This used to `exitNewProjectMode` + `saveCreationHandoff(id, null)` — "the handoff ends when
         * the build turn is SENT" (migration 0016). Two things make that wrong now:
         *
         *   1. **The plan has to outlive the send.** It is the only record of which phases are still
         *      owed, and without it a tab that dies mid-build strands a half-written project with
         *      nothing able to resume it.
         *   2. **The row is what tells the SERVER this is a first build turn** (`projectOwesBuild`).
         *      Clearing it here raced the generation this send is about to post: whichever landed
         *      first decided whether the turn got the creation tool policy, the preloaded skills, the
         *      completeness pass and the §4.6 no-files refund. That race is exactly the six-day
         *      outage — `carriesCreationBrief` had already stopped answering, and this PATCH was
         *      removing the only other evidence.
         *
         * So the handoff now ends when the LAST PHASE completes (`CreationHandoff.plan`), and the mode
         * survives with it — which also keeps the premium pill locked for every phase, not just the
         * first, since every phase is a build turn.
         *
         * ⚠️ The BRIEF is still consumed on send. Only the plan outlives it: re-appending the user's
         * words per phase would pay for them again on every turn in an UNCACHED history, forever.
         */
        /*
         * 🔴 RESUME, NEVER RESTART. A plan already in flight (a reload mid-build, or a device switch)
         * is continued from wherever the ROW says it got to; only a project with no plan starts a new
         * one. `newCreationPlan()` unconditionally here would silently rewind `next` to 0 and re-run
         * every phase the user has already paid for, overwriting files that were correct — the exact
         * failure `mergeCreationPlan`'s monotonic merge exists to make impossible server-side.
         */
        /*
         * 🔴 A BLANK CANVAS BUILD IS AN ORDINARY TURN (owner, 2026-08-14).
         *
         * *"If we are using the BLANK CANVAS options DO NOT AUTO create front end and artwork… all
         * operations from that point are just regular prompt turns."*
         *
         * No plan is started, and the handoff is CLEARED on this send — restoring, for this one path,
         * exactly the pre-phase behaviour (migration 0016: the mode ends when the build turn is sent).
         * That is what makes every later turn ordinary: `projectOwesBuild` reads the row, and a row
         * with no handoff is a project that has been built.
         *
         * ⚠️ Clearing it here is safe ONLY because `projectOwesBuild` already answers `false` for a
         * blank-canvas handoff. The race that made this dangerous for a phased build — whichever of
         * the PATCH and the generation landed first decided the turn's tool policy — cannot bite when
         * both answers are the same.
         */
        if (newProjectMode.projectId && newProjectMode.blankCanvas) {
          exitNewProjectMode(newProjectMode.projectId);

          void saveCreationHandoff(newProjectMode.projectId, null).catch((error) => {
            logger.error('Could not clear the creation handoff', error);
          });
        } else if (newProjectMode.projectId) {
          const inFlight = newProjectMode.plan;
          const plan = inFlight && !isCreationPlanComplete(inFlight) ? inFlight : newCreationPlan();

          updateCreationPlan(newProjectMode.projectId, plan);

          void saveCreationHandoff(newProjectMode.projectId, { plan }).catch((error) => {
            /*
             * Loud, and NOT fatal to the send. A plan that failed to persist still runs from the local
             * mode for this session; what is lost is resume-on-another-device, and failing the user's
             * build over that would be the worse trade.
             */
            logger.error('Could not persist the creation plan', error);
          });
        } else {
          /*
           * 🔴 THE DEGRADED UNREGISTERED PATH KEEPS THE OLD SINGLE-TURN BEHAVIOUR, and that is not a
           * shortcut — a plan here would be INCOHERENT.
           *
           * Registration failed, so there is no project id, so `/api/agent` gets no `projectId`, so
           * `requireOwnedProject` never runs and `owesBuild` is false: the server cannot recognise
           * this as a first build turn at all, and would ignore `creationPhase` outright. A local plan
           * would post four turns that the server treats as ordinary edits — four times the cost of
           * the one turn it replaced, with none of the protections.
           *
           * So the mode is cleared on send exactly as it was before phases, which also keeps the
           * premium pill unlocking afterwards (a mode nothing clears is a lock nothing lifts).
           */
          exitNewProjectMode('');
        }
      }

      /*
       * 🔴 THE GAME-READY CELEBRATION BELONGS TO THIS TURN, NOT TO CREATION (§4.4a).
       *
       * `creationCompleteRef` fires "🎮 Your game is ready — open Preview to play it." once per project.
       * It used to be armed at the end of creation, one line above the `reload()` that was the build —
       * true then, and false in both directions now: creation finishes with an untouched starter (there
       * is no game to be ready), and the turn that DOES produce the game would never announce it.
       *
       * Armed on the SEND, for the same reason the mode is cleared on the send rather than on success: a
       * build that fails is one the user retries, and the retry is still the turn that first produces a
       * game. The consumer clears the ref when it fires, so a retry after a failure celebrates once.
       */
      /*
       * Keyed to the MODE: a send out of New Project mode is, behaviourally, the turn that first
       * produces a game — there is no brief anymore (owner, 2026-08-08), the mode itself is the fact.
       *
       * 🔴 **AND TO THE BUILD, not merely to the mode being OPEN (§4.4e, 2026-08-14).** The mode used
       * to be cleared by this very send, so `if (newProjectMode)` could only ever be the first build
       * turn. Under phases the mode outlives the send — it ends with the PLAN — so that condition
       * silently became "any message typed while a build is in progress", and a user asking a question
       * mid-build re-armed the celebration for a turn that produces no game.
       *
       * Caught by `creation-celebration.spec.tsx`: a failed build, then `/clear` (which disarms), then
       * an ordinary edit re-armed it and fired "🎮 Your game is ready" over a project with no game —
       * the exact claim the whole `turn-outcome` machinery exists to stop us making.
       */
      /*
       * The phase this send carries, if any. Computed HERE — above the arm that reads it — because the
       * arm has to distinguish a build send from an ordinary message typed while a build is open, and
       * `newProjectMode` alone stopped being able to do that the moment the mode outlived the send.
       *
       * `plan.next`, never a literal 0: a resumed build continues from where the ROW says it got to
       * (see "RESUME, NEVER RESTART" above). Hardcoding the first phase would re-run a front end the
       * user has already built and paid for.
       */
      /*
       * `!isPlanTurn` here too, and not only on the arming above. A project can already HOLD a plan —
       * a build that started, then a reload, then the user reaches for "Plan my brief" — and without
       * this the plan turn would carry that plan's `creationPhase` in its body, be counted as a phase
       * turn, and tick `next` forward. The user would have paid for a phase that never ran and the
       * build would resume one step past a front end nobody wrote.
       */
      const startedPlan = newProjectMode && !isPlanTurn ? newProjectModeStore.get()?.plan : undefined;
      const phaseId = startedPlan?.phases[startedPlan.next];

      /*
       * Only a send that actually carries a phase counts as one. An ordinary message typed mid-build
       * must never tick the plan forward, or a phase the user paid for is skipped and never runs.
       */
      phaseTurnRef.current = Boolean(phaseId);

      /*
       * A build send: a phase, or the unregistered path's single turn (which has no plan at all).
       * Never a plan turn — arming the game-ready celebration for a turn that writes one markdown file
       * would announce a finished game over a project nobody has built yet.
       */
      if (phaseId || (newProjectMode && !newProjectMode.projectId && !isPlanTurn)) {
        creationCompleteRef.current = true;
      }

      // A failed turn's message is dropped before the retry is posted.
      if (error != null) {
        setMessages(messages.slice(0, -1));
      }

      const modifiedFiles = workbenchStore.getModifiedFiles();

      chatStore.setKey('aborted', false);

      /*
       * 🔴 PHASE 1 RIDES ON THE USER'S OWN WORDS, UNTOUCHED — only the BODY says which phase it is.
       *
       * An earlier draft appended the phase task to this message. Visible, so not literally the hidden
       * brief the owner retired on 2026-08-08 — but the same idea wearing a better hat, and
       * `new-project-mode-wiring.spec.tsx` pins that rule for a reason. The task lives in the server's
       * volatile system tail instead (`creationPhaseNote`), which is cheaper as well as cleaner: the
       * history is UNCACHED, so anything put in a message is re-sent at full rate on every later turn
       * forever, while a system-tail note is read once by the turn it applies to.
       *
       */

      /**
       * Post the turn — one `append`, every turn, including the first build turn. The hidden
       * creation-brief second message this used to compose is retired (owner, 2026-08-08): the baked
       * system prompt and the file context carry what the brief used to.
       */
      const postTurn = async (messageText: string) => {
        const attachmentOptions =
          uploadedFiles.length > 0 ? { experimental_attachments: await filesToAttachments(uploadedFiles) } : undefined;

        append(
          {
            role: 'user',
            content: messageText,
            parts: createMessageParts(messageText, imageDataList),
          },

          /* The live identity rides on EVERY send — see `liveTurnBody`. */
          {
            ...attachmentOptions,
            body: { ...liveTurnBody(), ...(phaseId ? { creationPhase: phaseId } : {}) },
          },
        );
      };

      if (modifiedFiles !== undefined) {
        const userUpdateArtifact = filesToArtifacts(modifiedFiles, `${Date.now()}`);
        await postTurn(
          `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${userUpdateArtifact}${finalMessageContent}`,
        );

        workbenchStore.resetAllFileModifications();
      } else {
        await postTurn(`[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${finalMessageContent}`);
      }

      clearDraftPrompt();

      setUploadedFiles([]);
      setImageDataList([]);

      resetEnhancer();

      textareaRef.current?.blur();
    };

    /**
     * Handles the change event for the textarea and updates the input state.
     * @param event - The change event from the textarea.
     */
    const onTextareaChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      handleInputChange(event);
    };

    useEffect(() => {
      const storedApiKeys = Cookies.get('apiKeys');

      if (storedApiKeys) {
        setApiKeys(JSON.parse(storedApiKeys));
      }
    }, []);

    const handleModelChange = (newModel: string) => {
      setModel(newModel);
      Cookies.set('selectedModel', newModel, { expires: 30 });
    };

    const handleProviderChange = (newProvider: ProviderInfo) => {
      setProvider(newProvider);
      Cookies.set('selectedProvider', newProvider.name, { expires: 30 });
    };

    const handleWebSearchResult = useCallback(
      (result: string) => {
        const currentInput = input || '';
        const newInput = currentInput.length > 0 ? `${result}\n\n${currentInput}` : result;

        // Update the input via the same mechanism as handleInputChange
        const syntheticEvent = {
          target: { value: newInput },
        } as React.ChangeEvent<HTMLTextAreaElement>;
        handleInputChange(syntheticEvent);
      },
      [input, handleInputChange],
    );

    const baseChat = (
      <BaseChat
        ref={animationScope}
        textareaRef={textareaRef}
        input={input}
        showChat={showChat}
        chatStarted={chatStarted}
        isStreaming={isLoading || fakeLoading}
        onStreamingChange={(streaming) => {
          streamingState.set(streaming);
        }}
        enhancingPrompt={enhancingPrompt}
        promptEnhanced={promptEnhanced}
        sendMessage={sendMessage}
        onSelectEntry={handleSelectEntry}
        onCompleteTour={handleCompleteTour}
        vaguePrompt={vaguePrompt}
        onVagueChoice={handleVagueChoice}
        onReseed={handleReseed}
        canReseed={!isLoading && !fakeLoading && messages.length <= 3}
        onCreationBuild={handleCreationBuild}
        onCreationEdit={(prompt) => fillChatBox(prompt, { focus: true })}
        onCreationPlan={handleCreationPlan}
        onCreationDismiss={(prompt) => fillChatBox(prompt, { focus: false })}
        model={model}
        setModel={handleModelChange}
        provider={provider}
        setProvider={handleProviderChange}
        providerList={activeProviders}
        handleInputChange={(e) => {
          onTextareaChange(e);
          debouncedCachePrompt(e);
        }}
        handleStop={abort}
        description={description}
        importChat={importChat}
        exportChat={exportChat}
        messages={messages.map((message, i) => {
          if (message.role === 'user') {
            return message;
          }

          return {
            ...message,
            content: parsedMessages[i] || '',
          };
        })}
        enhancePrompt={() => {
          enhancePrompt(
            input,
            (input) => {
              setInput(input);
              scrollTextArea();
            },
            model,
            provider,
            apiKeys,
          );
        }}
        uploadedFiles={uploadedFiles}
        setUploadedFiles={setUploadedFiles}
        imageDataList={imageDataList}
        setImageDataList={setImageDataList}
        actionAlert={actionAlert}
        clearAlert={() => workbenchStore.clearAlert()}
        supabaseAlert={supabaseAlert}
        clearSupabaseAlert={() => workbenchStore.clearSupabaseAlert()}
        deployAlert={deployAlert}
        clearDeployAlert={() => workbenchStore.clearDeployAlert()}
        llmErrorAlert={llmErrorAlert}
        clearLlmErrorAlert={clearApiErrorAlert}
        turnOutcomeAlert={turnOutcomeAlert}
        clearTurnOutcomeAlert={() => setTurnOutcomeAlert(undefined)}
        data={chatData}
        chatMode={chatMode}
        setChatMode={setChatMode}
        append={append}
        setMessages={setMessages}
        designScheme={designScheme}
        setDesignScheme={setDesignScheme}
        selectedElement={selectedElement}
        setSelectedElement={setSelectedElement}
        addToolResult={addToolResult}
        onWebSearchResult={handleWebSearchResult}
      />
    );

    return (
      <>
        {baseChat}
        <WorkspaceSplash />
      </>
    );
  },
);
