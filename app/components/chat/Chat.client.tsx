import { useStore } from '@nanostores/react';
import type { Message } from 'ai';
import { useChat } from '@ai-sdk/react';
import { useAnimate } from 'framer-motion';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { useMessageParser, usePromptEnhancer, useShortcuts } from '~/lib/hooks';
import { chatMetadata, description, projectId, useChatHistory } from '~/lib/persistence';
import { createProject } from '~/lib/persistence/projects';
import { chatStore } from '~/lib/stores/chat';
import { workbenchStore } from '~/lib/stores/workbench';
import { stripOpaqueContent } from '~/lib/context/opaque-files';
import { applySettlement, canUsePremium, sessionStore } from '~/lib/stores/session';
import { premiumModelStore } from '~/lib/stores/settings';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, PROMPT_COOKIE_KEY, PROVIDER_LIST } from '~/utils/constants';
import { cubicEasingFn } from '~/utils/easings';
import { createScopedLogger, renderLogger } from '~/utils/logger';
import { BaseChat } from './BaseChat';
import Cookies from 'js-cookie';
import { debounce } from '~/utils/debounce';
import { useSettings } from '~/lib/hooks/useSettings';
import type { ProviderInfo } from '~/types/model';
import { useSearchParams } from '@remix-run/react';
import { createSampler } from '~/utils/sampler';
import { createProjectFromRegistry } from '~/lib/registry/create-project';
import { waitForMountVisible } from '~/lib/registry/mount';
import { decideSeed, deriveProjectTitle, findFallbackEntry } from '~/lib/registry/match';
import { compileWizardPrompt, summarizeSelection, type WizardSelection } from '~/lib/registry/wizard';
import { projectSeedStore, setProjectSeed } from '~/lib/stores/project';
import { useGameRegistry } from '~/lib/hooks/useGameRegistry';
import type { GameRegistryEntry } from '~/types/game-registry';
import { logStore } from '~/lib/stores/logs';
import { streamingState } from '~/lib/stores/streaming';
import { filesToArtifacts } from '~/utils/fileUtils';
import { supabaseConnection } from '~/lib/stores/supabase';
import { defaultDesignScheme, type DesignScheme } from '~/types/design-scheme';
import type { ElementInfo } from '~/components/workbench/Inspector';
import type { TextUIPart, FileUIPart, Attachment } from '@ai-sdk/ui-utils';
import { useMCPStore } from '~/lib/stores/mcp';
import { mcpToolsAtom, syncMcpBridge, callMcpTool } from '~/lib/stores/mcpBridge';
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

export function Chat() {
  renderLogger.trace('Chat');

  const { ready, initialMessages, storeMessageHistory, checkpointProject, importChat, exportChat } = useChatHistory();
  const title = useStore(description);
  useEffect(() => {
    workbenchStore.setReloadedMessages(initialMessages.map((m) => m.id));
  }, [initialMessages]);

  return (
    <>
      {ready && (
        <ChatImpl
          description={title}
          initialMessages={initialMessages}
          exportChat={exportChat}
          storeMessageHistory={storeMessageHistory}
          checkpointProject={checkpointProject}
          importChat={importChat}
        />
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
  checkpointProject: (messageId: string) => Promise<void>;
  importChat: (description: string, messages: Message[]) => Promise<void>;
  exportChat: () => void;
  description?: string;
}

export const ChatImpl = memo(
  ({ description, initialMessages, storeMessageHistory, checkpointProject, importChat, exportChat }: ChatProps) => {
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
    const { activeProviders, promptId, contextOptimizationEnabled } = useSettings();
    const [llmErrorAlert, setLlmErrorAlert] = useState<LlmErrorAlertType | undefined>(undefined);

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
     * The PREMIUM tier (§4.6.1): the user's opt-in AND live eligibility. We send `premium: true` only
     * when both hold, so an ineligible user never triggers the server's "declined" notice. The server
     * re-derives eligibility regardless — this is a request, never authorization.
     */
    const premiumEnabled = useStore(premiumModelStore);
    const session = useStore(sessionStore);
    const premiumRequested = premiumEnabled && canUsePremium(session);

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

        promptId,
        contextOptimization: contextOptimizationEnabled,
        chatMode,
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

        /* The premium-model opt-in (§4.6.1) — a boolean the server maps to the one configured premium model. */
        premium: premiumRequested,
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
         * Celebrate the initial build, exactly once, when a fresh project's creation generation lands
         * (§4.4). Ref-gated so it never fires on an edit or a self-heal — those are not "your game is
         * ready" moments. Distinct from the §4.5.4b save nudge (that is about persistence and fires
         * once per BROWSER); this is about the build finishing and fires once per PROJECT.
         */
        if (creationCompleteRef.current) {
          creationCompleteRef.current = false;
          toast.success('🎮 Your game is ready — open Preview to play it.');
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
        const meta = message.annotations?.find(
          (a): a is { type: 'agentMeta'; value: { generationId?: string } } =>
            typeof a === 'object' && a !== null && (a as { type?: string }).type === 'agentMeta',
        );

        const generationId = meta?.value?.generationId;

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
          // Already logged. A failed checkpoint is our problem, not something the user can act on.
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
    const handledToolCalls = useRef<Set<string>>(new Set());
    useEffect(() => {
      if (!chatData) {
        return;
      }

      for (const part of chatData) {
        if (!part || typeof part !== 'object') {
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
            errors: decision.errors,
            repairOf: decision.repairOf,
            repairAttempt: decision.repairAttempt,
          },
        },
      );
    }, [actionAlert, isLoading]);

    useEffect(() => {
      const prompt = searchParams.get('prompt');

      // console.log(prompt, searchParams, model, provider);

      if (prompt) {
        setSearchParams({});
        runAnimation();
        append({
          role: 'user',
          content: `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${prompt}`,
        });
      }
    }, [model, provider, searchParams]);

    const { enhancingPrompt, promptEnhanced, enhancePrompt, resetEnhancer } = usePromptEnhancer();
    const { parsedMessages, parseMessages } = useMessageParser();

    const TEXTAREA_MAX_HEIGHT = chatStarted ? 400 : 200;

    /*
     * (Upstream's `useEffect(() => chatStore.setKey('started', initialMessages.length > 0), [])` lived
     * here. It is folded into the open-state effect above — see the 🔴 note there. It was a second,
     * unconditional writer of the same flag on the same mount, and it won.)
     */

    useEffect(() => {
      processSampledMessages({
        messages,
        initialMessages,
        isLoading,
        parseMessages,
        storeMessageHistory,
      });
    }, [messages, isLoading, parseMessages]);

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

        logStore.logError(`${context} request failed`, error, {
          component: 'Chat',
          action: 'request',
          error: errorInfo.message,
          context,
          retryable: errorInfo.isRetryable,
          errorType,
          provider: provider.name,
        });

        // Create API error alert
        setLlmErrorAlert({
          type: 'error',
          title,
          description: errorInfo.message,
          provider: provider.name,
          errorType,
        });
        setData([]);
      },
      [provider.name, stop],
    );

    const clearApiErrorAlert = useCallback(() => {
      setLlmErrorAlert(undefined);
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
     * Create the project and start the first generation (SPEC §4.4 / §4.4b / §4.4c).
     *
     * Every New Project path lands here — typed prompt (A), card (B), wizard (C). The deterministic
     * work (mount, hygiene, copy-rename-register the GameMode) happens in `createProjectFromRegistry`;
     * what reaches the model is a mounted, registered, running project plus a brief.
     *
     * When there is no prompt (a card click), the chat is empty: the model builds the landing page and
     * stops. `visiblePrompt` is what the user actually typed — the wizard's compiled text is hidden
     * behind its summary card, per §4.7.
     */
    const startProject = async (options: {
      entry: GameRegistryEntry;
      prompt?: string;
      visiblePrompt?: string;
      matched?: string[];
    }): Promise<boolean> => {
      const { entry, prompt, visiblePrompt, matched } = options;
      const title = prompt ? deriveProjectTitle(prompt, entry.title) : entry.title;

      try {
        const { assistantMessage, userMessage, className, mustBeVisible } = await createProjectFromRegistry({
          entry,
          title,
          prompt,
        });

        setProjectSeed({ entry, className, title, prompt, matched });

        /*
         * Register the project with the PLATFORM (§4.5.5) — before the first generation, because the
         * agent route checks ownership of `projectId` and enforces one in-flight build per project.
         *
         * If this fails the build still runs: the game is already written into the WebContainer and
         * refusing to continue because our bookkeeping call timed out would be an absurd way to lose
         * someone's work. It simply stays a local-only project (no checkpoints, no resume elsewhere),
         * and says so rather than pretending.
         */
        try {
          const project = await createProject({ name: title, templateId: entry.id });
          projectId.set(project.id);
          chatMetadata.set({ ...chatMetadata.get(), projectId: project.id });
        } catch (error) {
          projectId.set(undefined);
          logger.error(`Could not register the project with the server: ${(error as Error).message}`);
          toast.warn('This project is saved on this device only — we could not reach the server.');
        }

        const shown = visiblePrompt ?? prompt;
        const stamp = new Date().getTime();

        const messages: Message[] = [];

        if (shown) {
          const userMessageText = `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${shown}`;
          messages.push({
            id: `1-${stamp}`,
            role: 'user',
            content: userMessageText,
            parts: createMessageParts(userMessageText, imageDataList),
          });
        }

        messages.push(
          { id: `2-${stamp}`, role: 'assistant', content: assistantMessage },
          {
            id: `3-${stamp}`,
            role: 'user',
            content: `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${userMessage}`,
            annotations: ['hidden'],
          },
        );

        setMessages(messages);

        const reloadOptions =
          uploadedFiles.length > 0 ? { experimental_attachments: await filesToAttachments(uploadedFiles) } : undefined;

        /*
         * 🔴 THE LAST THING BEFORE THE MOST EXPENSIVE GENERATION IN THE PRODUCT. Do not move it, and do
         * not move anything that sets state below it.
         *
         * Two things have to be true before the model is worth paying for, and neither was:
         *
         *   1. **The project must be VISIBLE, not merely written.** The writes above are awaited, so the
         *      bytes are on disk — but the model reads `workbenchStore.files`, which a watcher fills
         *      asynchronously. Measured: the request fired at 5405ms, the store filled at 5531ms, and
         *      the model was asked to write a racing game having been shown SEVEN files, none of them
         *      source. It told the owner so — "I can't see its source" — and we read that as caution.
         *
         *   2. **`projectId` must have reached a COMMITTED render.** The AI SDK refreshes its request
         *      body from a `useEffect` (`extraMetadataRef`), so it only ever sends values from a render
         *      that has committed. `createProject` above sets the atom, but `reload()` runs in the same
         *      synchronous block, so the body still carried `projectId: undefined` on every creation —
         *      the server's ownership check and its per-project attribution both got nothing. Fixing
         *      only (1) left this one standing, silently: the files came through and the id did not.
         *
         * Awaiting here fixes both, because it yields — the store update and the `projectId.set` above
         * both land in a commit before `reload()` reads the ref. That is also why the wait is HERE and
         * not inside `createProjectFromRegistry`, which returns before the project is registered.
         */
        await waitForMountVisible(mustBeVisible);

        // This turn IS the creation build — onFinish celebrates it once (see creationCompleteRef).
        creationCompleteRef.current = true;

        reload(reloadOptions);

        setInput('');
        Cookies.remove(PROMPT_COOKIE_KEY);
        setUploadedFiles([]);
        setImageDataList([]);
        setVaguePrompt(null);
        resetEnhancer();
        textareaRef.current?.blur();
        setFakeLoading(false);

        return true;
      } catch (error) {
        logger.error('Project creation failed', error);
        toast.error(error instanceof Error ? error.message : 'Could not create the project from the starter template.');
        setFakeLoading(false);

        return false;
      }
    };

    /** §4.4a Path B — a picked card is explicit input: create it and go. No wizard. */
    const handleSelectEntry = async (entry: GameRegistryEntry) => {
      runAnimation();
      setFakeLoading(true);
      await startProject({ entry });
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
        reload(attachments ? { experimental_attachments: attachments } : undefined);
        setFakeLoading(false);
        setInput('');
        Cookies.remove(PROMPT_COOKIE_KEY);

        setUploadedFiles([]);
        setImageDataList([]);

        resetEnhancer();

        textareaRef.current?.blur();

        return;
      }

      if (error != null) {
        setMessages(messages.slice(0, -1));
      }

      const modifiedFiles = workbenchStore.getModifiedFiles();

      chatStore.setKey('aborted', false);

      if (modifiedFiles !== undefined) {
        const userUpdateArtifact = filesToArtifacts(modifiedFiles, `${Date.now()}`);
        const messageText = `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${userUpdateArtifact}${finalMessageContent}`;

        const attachmentOptions =
          uploadedFiles.length > 0 ? { experimental_attachments: await filesToAttachments(uploadedFiles) } : undefined;

        append(
          {
            role: 'user',
            content: messageText,
            parts: createMessageParts(messageText, imageDataList),
          },
          attachmentOptions,
        );

        workbenchStore.resetAllFileModifications();
      } else {
        const messageText = `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${finalMessageContent}`;

        const attachmentOptions =
          uploadedFiles.length > 0 ? { experimental_attachments: await filesToAttachments(uploadedFiles) } : undefined;

        append(
          {
            role: 'user',
            content: messageText,
            parts: createMessageParts(messageText, imageDataList),
          },
          attachmentOptions,
        );
      }

      setInput('');
      Cookies.remove(PROMPT_COOKIE_KEY);

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

    return (
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
  },
);
