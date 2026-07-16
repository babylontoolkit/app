import { useLoaderData, useNavigate, useSearchParams } from '@remix-run/react';
import { useState, useEffect, useCallback, useRef } from 'react';
import { atom } from 'nanostores';
import { generateId, type JSONValue, type Message } from 'ai';
import { toast } from 'react-toastify';
import { workbenchStore } from '~/lib/stores/workbench';
import { logStore } from '~/lib/stores/logs'; // Import logStore
import {
  getMessages,
  getNextId,
  getUrlId,
  openDatabase,
  setMessages,
  duplicateChat,
  createChatFromMessages,
  getSnapshot,
  setSnapshot,
  type IChatMetadata,
} from './db';
import type { FileMap } from '~/lib/stores/files';
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import type { Snapshot } from './types';
import { detectProjectCommands, createCommandActionsString } from '~/utils/projectCommands';
import type { ContextAnnotation } from '~/types/context';
import {
  getRepoStatus,
  pullFromRepo,
  restoreLatestServerCheckpoint,
  saveMessages,
  saveProjectToRepo,
  type RepoStatus,
} from './projects';
import {
  createLocalSnapshot,
  getLocalSyncState,
  markSynced,
  readCurrentLocalSnapshot,
  type LocalSyncState,
} from './local-snapshots';
import { selectMountSource } from './mount-source';
import { protectForRepoRestore, protectNothing } from './restore-plan';
import { decideDependencyInstall, findLockfile, hasManifest } from './dependencies';
import { SaveQueue, saveState } from './save-queue';
import { takePendingProjectMount, PENDING_REMIX_KEY } from './pending-remix';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('ChatHistory');

export interface ChatHistoryItem {
  id: string;
  urlId?: string;
  description?: string;
  messages: Message[];
  timestamp: string;
  metadata?: IChatMetadata;
}

const persistenceEnabled = !import.meta.env.VITE_DISABLE_PERSISTENCE;

export const db = persistenceEnabled ? await openDatabase() : undefined;

export const chatId = atom<string | undefined>(undefined);
export const description = atom<string | undefined>(undefined);
export const chatMetadata = atom<IChatMetadata | undefined>(undefined);

/**
 * The server-side project this chat is building (§4.5.5).
 *
 * `undefined` for a chat that has no project yet (a fresh page, or an upstream blank/import flow that
 * has not created one). Everything that talks to the server keys off this: the agent route's ownership
 * check, checkpoints, and the message history. It is persisted in the chat's IndexedDB metadata, which
 * is what lets a reload find its way back to the project.
 */
export const projectId = atom<string | undefined>(undefined);

/**
 * Whether the project currently on screen has work that exists only in this browser (§4.5.4b).
 *
 * Read by the LINKED/UNLINKED indicator, the nudges, and the beforeunload warning. An atom rather than
 * a fetch, because those three must agree with each other and with what just happened, without three
 * independent round-trips racing.
 */
export const unsavedWork = atom<boolean>(false);

/** The project's repo link, as of the last time we looked. `undefined` = not loaded yet. */
export const repoStatus = atom<RepoStatus | undefined>(undefined);

/** The repo moved AND this browser has unsaved work. The user must choose (§4.13) — we never merge. */
export const mountDivergence = atom<{ projectId: string; remoteHead: string } | undefined>(undefined);

/**
 * How many things the user has made in this project — the nudge MILESTONE counter (§4.5.4b).
 *
 * §4.5.4b forbids a timed nudge, so this is the only clock the nudges get: the user's own progress. It
 * counts checkpoints rather than generations exactly (a pull or a restore also checkpoints), and that
 * imprecision is fine and deliberate — it drives chrome, never a decision about anyone's files. It is
 * seeded on mount from the local checkpoint seq, which is monotonic and survives the 20-checkpoint
 * trim, so a long-lived project's milestones do not silently stop at the trim boundary.
 */
export const generationCount = atom<number>(0);

/**
 * Put a project's files on screen (§4.5.4b) — from this browser, or from the user's repo.
 *
 * This is the "load from GitHub seamlessly" half. It does no deciding of its own: it gathers the three
 * facts (is it linked, where is the repo, how far has this browser moved) and hands them to
 * `selectMountSource`, which is pure and exhaustively tested precisely because every wrong answer here
 * silently destroys someone's work.
 *
 * What it does with each answer:
 *
 *   - `local`     — mount this browser's current checkpoint. No network.
 *   - `repo`      — fetch the linked repo and mount it. This is the new-device path: clear your
 *                   storage, open the project, and the game comes back from your repository.
 *   - `seed`      — read the one-time remix copy and adopt it as the first local checkpoint.
 *   - `diverged`  — mount LOCAL (it is the unsaved side) and raise the two-button choice. Mounting the
 *                   repo here would destroy the very work that caused the divergence.
 *   - `empty`     — nothing to mount. A brand-new project before its first generation.
 */
async function mountProjectFiles(pid: string): Promise<void> {
  const [status, sync] = await Promise.all([
    getRepoStatus(pid),
    db ? getLocalSyncState(db, pid) : Promise.resolve({} as LocalSyncState),
  ]);

  repoStatus.set(status);

  /*
   * Seed the milestone counter (§4.5.4b). `localSeq` is monotonic and unaffected by the checkpoint
   * trim, so a project reopened after twenty generations resumes counting where it was rather than
   * restarting its nudges from zero.
   */
  generationCount.set(sync.localSeq === undefined ? 0 : sync.localSeq + 1);

  const decision = selectMountSource({
    linked: status.linked,
    lastSyncedCommitSha: status.lastSyncedCommitSha,

    // Deliberately preserves the absent/null distinction — see `RepoStatus.remoteHead`.
    remoteHead: status.remoteHead,
    localSeq: sync.localSeq,
    syncedSeq: sync.syncedSeq,
    hasServerSeed: undefined,
  });

  logger.info(`Mounting project ${pid} from: ${decision.source}`);

  if (decision.source === 'local' || decision.source === 'diverged') {
    const local = db ? await readCurrentLocalSnapshot(db, pid) : undefined;

    if (local) {
      /*
       * A local checkpoint is the whole truth (it serialized the entire store), so `protectNothing`:
       * a file it does not have is one the project does not have. Without this the mount is an
       * overlay, and a file deleted before the checkpoint would come back from the template mount.
       */
      await workbenchStore.restoreFiles(local.files, { protect: protectNothing });
    }

    unsavedWork.set(decision.source === 'diverged' || decision.unsavedWork);

    if (decision.source === 'diverged') {
      mountDivergence.set({ projectId: pid, remoteHead: decision.remoteHead });
    }

    return;
  }

  if (decision.source === 'repo') {
    await mountFromRepo(pid);
    return;
  }

  if (decision.source === 'empty') {
    /*
     * `empty` for a LINKED project is not necessarily nothing — it can be a remix seed we did not know
     * about, since `hasServerSeed` needs a round-trip we do not make on the common path. Trying the
     * seed here costs one request on a path that had nothing to show anyway.
     */
    await mountFromSeed(pid);
    return;
  }

  await mountFromSeed(pid);
}

/**
 * Fetch the linked repo and put it on screen.
 *
 * The pulled files become this browser's first checkpoint AND are marked as synced — they came FROM
 * the repo, so they are by definition saved. Skipping the mark would make a freshly-opened project
 * claim unsaved work it does not have, and nag the user to save what they just downloaded.
 */
async function mountFromRepo(pid: string): Promise<void> {
  const { files, message } = await pullFromRepo(pid);

  if (!files) {
    // LOUD: this is the path where the repo is the only copy, so failing quietly means an empty screen.
    toast.error(message ?? 'Could not load this project from its repository.');
    return;
  }

  /*
   * `protectForRepoRestore`: the repo is authoritative about everything EXCEPT the `.env` family and
   * `.npmrc`, which `isSecretPath` kept out of every push — so their absence from the tree says
   * nothing, and deleting them would destroy the user's keys, the one thing here with no other copy.
   */
  await workbenchStore.restoreFiles(files, { protect: protectForRepoRestore });

  if (db) {
    await createLocalSnapshot(db, { projectId: pid, files, label: 'Loaded from repository' });
    await markSynced(db, pid);
  }

  unsavedWork.set(false);
  await installDependencies(files);
}

/**
 * Reinstall dependencies for a project that just arrived from a repo.
 *
 * `node_modules` is not in the repository (nor should it be), so a project mounted on a fresh device
 * has every file and cannot run. A resumed project used to get away without this because its chat
 * replayed an artifact carrying `npm install` as a shell action — a project mounted from a repo on a
 * new device has no chat to replay, so without this the user sees a complete, correct, entirely
 * non-running game, and it reads as a broken product rather than a missing install.
 *
 * `decideDependencyInstall` decides; this only runs it. Failure is reported, never swallowed: a
 * project that cannot install is one the user needs to know about, and the alternative is a blank
 * preview with no explanation.
 */
async function installDependencies(files: SerializedFileMap): Promise<void> {
  const paths = Object.keys(files);

  const decision = decideDependencyInstall({
    // The repo never carries `node_modules`, and `restoreFiles` writes exactly what the repo had.
    hasNodeModules: paths.some((path) => path.includes('/node_modules/')),
    hasManifest: hasManifest(paths),
    lockfile: (() => {
      const lock = findLockfile(paths);
      const dirent = lock ? files[lock] : undefined;

      return dirent?.type === 'file' ? dirent.content : undefined;
    })(),
  });

  if (!decision.install) {
    return;
  }

  const shell = workbenchStore.boltTerminal;
  const toastId = toast.loading('Getting this project ready — installing its dependencies…');

  try {
    const result = await shell.executeCommand(`deps-${Date.now()}`, 'npm install');

    if (result?.exitCode !== 0) {
      toast.update(toastId, {
        render: 'This project loaded, but installing its dependencies failed. Open the terminal to see why.',
        type: 'error',
        isLoading: false,
        autoClose: 8000,
      });

      return;
    }

    toast.update(toastId, { render: 'Ready.', type: 'success', isLoading: false, autoClose: 2000 });
  } catch (error) {
    toast.update(toastId, {
      render: `Could not install this project's dependencies: ${(error as Error).message}`,
      type: 'error',
      isLoading: false,
      autoClose: 8000,
    });
  }
}

/**
 * The save queue for the project currently open (§4.5.4b).
 *
 * Rebuilt per project rather than shared: `saveState` is what the header badge reads, and a
 * module-level queue would carry one project's `failed` badge into the next project the user opens.
 */
let queue: SaveQueue | undefined;
let queueProjectId: string | undefined;

function saveQueueFor(pid: string): SaveQueue {
  if (queue && queueProjectId === pid) {
    return queue;
  }

  queueProjectId = pid;
  saveState.set({ status: 'idle' });

  queue = new SaveQueue({
    /*
     * The files are read HERE, at push time — never captured when the save was requested. A retry that
     * runs 30 seconds later would otherwise push a stale snapshot, silently reverting whatever the
     * user did in between.
     */
    push: async () => {
      const files = await workbenchStore.serializeFiles();
      const outcome = await saveProjectToRepo(pid, { files, summary: lastSummary });

      if (outcome.ok && db) {
        /*
         * Mark synced only after the push LANDED. This is what the indicator, the nudges and the
         * beforeunload warning all read — marking optimistically would tell the user their only copy
         * is safe at the exact moment it is not.
         */
        await markSynced(db, pid);
        unsavedWork.set(false);
      }

      return outcome;
    },
  });

  return queue;
}

/**
 * What the last generation was for — becomes the commit message (§4.13).
 *
 * The user's own request, not the assistant's reply. It is what they would recognise scrolling their
 * repo's history six months later ("add boost pads to the track"), and it is a single short line,
 * where the reply is an artifact full of code. `buildCommitMessage` bounds and prefixes it.
 */
let lastSummary: string | undefined;

/** The last thing the user asked for, as plain text. */
function summarizeRequest(messages: Message[]): string | undefined {
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');

  if (!lastUserMessage) {
    return undefined;
  }

  const text =
    typeof lastUserMessage.content === 'string'
      ? lastUserMessage.content
      : // A multimodal message (text + images): the text parts are the request.
        (lastUserMessage.content as Array<{ type: string; text?: string }>)
          .filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join(' ');

  /*
   * Strip the model-directed prefixes the chat prepends to a user's words (skills, context markers).
   * They are instructions to us, not something a person wants to read in their commit log.
   */
  return text.replace(/\[[^\]]*\]/g, '').trim() || undefined;
}

/**
 * Push this project to its repo, if it is linked and set to save itself (§4.5.4b).
 *
 * Called after every checkpoint. Does nothing for an UNLINKED project — there is nowhere to push, and
 * that is not a failure, it is the normal state of a project the user has not saved yet. The nudges
 * are what address that; an error here would be nagging with an error dialog.
 */
async function autoPush(pid: string): Promise<void> {
  const status = repoStatus.get() ?? (await getRepoStatus(pid));
  repoStatus.set(status);

  if (!status.linked || status.autoPush === false) {
    return;
  }

  const outcome = await saveQueueFor(pid).request();

  if (outcome?.divergence) {
    /*
     * Someone committed to the repo from elsewhere. Never merge (§4.13) — raise the choice and let the
     * user decide. The work is still safe in this browser meanwhile.
     */
    mountDivergence.set({ projectId: pid, remoteHead: '' });
  }
}

/**
 * Save, because the user pressed Save (§4.5.4b).
 *
 * The same queue and the same route as auto-push — deliberately. A manual Save that took its own path
 * could race the automatic one and produce the spurious divergence the queue exists to prevent, and it
 * would need its own copy of the "did it land?" logic, which is the half that must never be wrong.
 *
 * The difference from `autoPush` is only in what it does about being UNLINKED: auto-push does nothing
 * (that is the normal state of a project nobody has saved yet), whereas pressing Save is the user
 * asking for exactly the thing that makes it linked, so the route creates the repository.
 *
 * Never throws. The outcome is reported through `saveState`, which the header badge reads.
 */
export async function requestSave(pid: string): Promise<void> {
  const outcome = await saveQueueFor(pid).request();

  if (!outcome) {
    // Coalesced into a save already in flight. That save reports for both of us.
    return;
  }

  if (outcome.divergence) {
    mountDivergence.set({ projectId: pid, remoteHead: '' });
    return;
  }

  if (outcome.reconnect) {
    // The badge offers the reconnect button; `saveState` already carries it. Nothing to add here.
    return;
  }

  if (outcome.ok) {
    /*
     * Refresh the link. On a FIRST save this is what turns the badge from "browser only" into the
     * user's own repo name — the whole point of having pressed the button, and invisible without it.
     */
    repoStatus.set(await getRepoStatus(pid));

    toast.success(outcome.created ? `Saved. Your game is now in your own repository.` : 'Saved.');
  }
}

/** Send the user through OAuth and bring them back to this page. */
export function startGitConnect(provider: 'github' | 'gitlab' = 'github'): void {
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.location.href = `/api/git/connect/${provider}?returnTo=${encodeURIComponent(returnTo)}`;
}

/** Read the one-time remix seed, if there is one, and adopt it as this browser's first checkpoint. */
async function mountFromSeed(pid: string): Promise<void> {
  const { files } = await restoreLatestServerCheckpoint(pid);

  if (!files) {
    return;
  }

  // The seed is built with the same secret rule (`buildRemixSeed` → `isSecretPath`), so it is protected the same way.
  await workbenchStore.restoreFiles(files, { protect: protectForRepoRestore });

  if (db) {
    await createLocalSnapshot(db, { projectId: pid, files, label: 'Opened' });
  }

  unsavedWork.set(true);
}

export function useChatHistory() {
  const navigate = useNavigate();
  const { id: mixedId } = useLoaderData<{ id?: string }>();
  const [searchParams] = useSearchParams();

  const [archivedMessages, setArchivedMessages] = useState<Message[]>([]);
  const [initialMessages, setInitialMessages] = useState<Message[]>([]);
  const [ready, setReady] = useState<boolean>(false);
  const [urlId, setUrlId] = useState<string | undefined>();

  /** Guards against re-checkpointing the same message — see `checkpointProject`. */
  const lastCheckpointedMessage = useRef<string | undefined>(undefined);

  /** The conversation as last stored locally — uploaded to the server once a generation finishes. */
  const latestMessages = useRef<Message[]>([]);

  useEffect(() => {
    if (!db) {
      setReady(true);

      if (persistenceEnabled) {
        const error = new Error('Chat persistence is unavailable');
        logStore.logError('Chat persistence initialization failed', error);
        toast.error('Chat persistence is unavailable');
      }

      return;
    }

    if (mixedId) {
      Promise.all([
        getMessages(db, mixedId),
        getSnapshot(db, mixedId), // Fetch snapshot from DB
      ])
        .then(async ([storedMessages, snapshot]) => {
          if (storedMessages && storedMessages.messages.length > 0) {
            /*
             * const snapshotStr = localStorage.getItem(`snapshot:${mixedId}`); // Remove localStorage usage
             * const snapshot: Snapshot = snapshotStr ? JSON.parse(snapshotStr) : { chatIndex: 0, files: {} }; // Use snapshot from DB
             */
            const validSnapshot = snapshot || { chatIndex: '', files: {} }; // Ensure snapshot is not undefined
            const summary = validSnapshot.summary;

            const rewindId = searchParams.get('rewindTo');
            let startingIdx = -1;
            const endingIdx = rewindId
              ? storedMessages.messages.findIndex((m) => m.id === rewindId) + 1
              : storedMessages.messages.length;
            const snapshotIndex = storedMessages.messages.findIndex((m) => m.id === validSnapshot.chatIndex);

            if (snapshotIndex >= 0 && snapshotIndex < endingIdx) {
              startingIdx = snapshotIndex;
            }

            if (snapshotIndex > 0 && storedMessages.messages[snapshotIndex].id == rewindId) {
              startingIdx = -1;
            }

            let filteredMessages = storedMessages.messages.slice(startingIdx + 1, endingIdx);
            let archivedMessages: Message[] = [];

            if (startingIdx >= 0) {
              archivedMessages = storedMessages.messages.slice(0, startingIdx + 1);
            }

            setArchivedMessages(archivedMessages);

            if (startingIdx > 0) {
              const files = Object.entries(validSnapshot?.files || {})
                .map(([key, value]) => {
                  // Binaries carry no text content and no project commands (package.json etc.).
                  if (value?.type !== 'file' || value.isBinary) {
                    return null;
                  }

                  return {
                    content: value.content,
                    path: key,
                  };
                })
                .filter((x): x is { content: string; path: string } => !!x); // Type assertion
              const projectCommands = await detectProjectCommands(files);

              // Call the modified function to get only the command actions string
              const commandActionsString = createCommandActionsString(projectCommands);

              filteredMessages = [
                {
                  id: generateId(),
                  role: 'user',
                  content: `Restore project from snapshot`, // Removed newline
                  annotations: ['no-store', 'hidden'],
                },
                {
                  id: storedMessages.messages[snapshotIndex].id,
                  role: 'assistant',

                  // Combine followup message and the artifact with files and command actions
                  content: `Bolt Restored your chat from a snapshot. You can revert this message to load the full chat history.
                  <boltArtifact id="restored-project-setup" title="Restored Project & Setup" type="bundled">
                  ${Object.entries(snapshot?.files || {})
                    .map(([key, value]) => {
                      /**
                       * Binary files are deliberately omitted: their bytes are already on
                       * disk via restoreSnapshot. Emitting them here would inline base64
                       * into LLM context (SPEC §1.3 principle 10) and have the action
                       * runner rewrite them as UTF-8 text, corrupting them.
                       */
                      if (value?.type === 'file' && !value.isBinary) {
                        return `
                      <boltAction type="file" filePath="${key}">
${value.content}
                      </boltAction>
                      `;
                      } else {
                        return ``;
                      }
                    })
                    .join('\n')}
                  ${commandActionsString} 
                  </boltArtifact>
                  `, // Added commandActionsString, followupMessage, updated id and title
                  annotations: [
                    'no-store',
                    ...(summary
                      ? [
                          {
                            chatId: storedMessages.messages[snapshotIndex].id,
                            type: 'chatSummary',
                            summary,
                          } satisfies ContextAnnotation,
                        ]
                      : []),
                  ],
                },

                // Remove the separate user and assistant messages for commands
                /*
                 *...(commands !== null // This block is no longer needed
                 *  ? [ ... ]
                 *  : []),
                 */
                ...filteredMessages,
              ];

              /*
               * Upstream called `restoreSnapshot(mixedId)` with NO snapshot, so it restored `{}` and
               * wrote nothing. The files came back only by replaying the `<boltAction>` artifact
               * above — which is TEXT ONLY, so every binary (textures, models, audio, the framework's
               * own PNGs) was silently missing after a reload. Passing the snapshot restores the
               * bytes; the artifact still replays the text.
               */
              await restoreSnapshot(mixedId, validSnapshot);
            }

            setInitialMessages(filteredMessages);

            setUrlId(storedMessages.urlId);
            description.set(storedMessages.description);
            chatId.set(storedMessages.id);
            chatMetadata.set(storedMessages.metadata);
            projectId.set(storedMessages.metadata?.projectId);

            /*
             * 🔴 The hierarchy INVERTED here (§4.5.4b).
             *
             * This used to fetch the SERVER's checkpoint and unconditionally overwrite whatever the
             * local snapshot had just restored — because the platform was the authority on files. It
             * holds none now, and "overwrite local with remote, always" is precisely the bug that
             * would eat a user's unsaved work on every reload.
             *
             * `mountProjectFiles` decides properly: local, the linked repo, or a divergence the user
             * resolves. Reloading a project saved on another device is what makes it come back here.
             */
            const pid = storedMessages.metadata?.projectId;

            if (pid) {
              try {
                await mountProjectFiles(pid);
              } catch (error) {
                logger.warn(`Could not restore project ${pid}: ${(error as Error).message}`);
              }
            }
          } else {
            navigate('/', { replace: true });
          }

          setReady(true);
        })
        .catch((error) => {
          console.error(error);

          logStore.logError('Failed to load chat messages or snapshot', error); // Updated error message
          toast.error('Failed to load chat: ' + error.message); // More specific error
        });
    } else {
      /*
       * No mixedId — a fresh builder. But a remix (§4.8) or a dashboard "Open" (§4.1) may have parked a
       * project id here on its way in. If so, adopt it and mount its files. The conversation is fresh
       * (both start a new chat), but the files are the real project, ready to build on.
       *
       * Local checkpoints first, then the server SEED (§4.5.4b). The seed is not ambient persistence —
       * it is the one-time copy a remix leaves behind so the clone has something to open (`api.remix`),
       * and it exists precisely because the source project's own repo belongs to someone else. A
       * project that has been worked on in this browser has local checkpoints and never reads it.
       */
      const mountProjectId = takePendingProjectMount();

      if (mountProjectId) {
        projectId.set(mountProjectId);
        chatMetadata.set({ ...chatMetadata.get(), projectId: mountProjectId });

        mountProjectFiles(mountProjectId)
          .catch((error) => logger.warn(`Could not load project ${mountProjectId}: ${error.message}`))
          .finally(() => setReady(true));
      } else {
        setReady(true);
      }
    }
  }, [mixedId, db, navigate, searchParams]); // Added db, navigate, searchParams dependencies

  const takeSnapshot = useCallback(
    async (chatIdx: string, _files: FileMap, _chatId?: string | undefined, chatSummary?: string) => {
      const id = chatId.get();

      if (!id || !db) {
        return;
      }

      /**
       * Serialize from the WebContainer rather than snapshotting the in-memory FileMap:
       * binary files hold no content in the map, so persisting it directly wrote empty
       * PNGs/GLBs into the snapshot (SPEC §1.3 principle 10).
       */
      const files = await workbenchStore.serializeFiles();

      const snapshot: Snapshot = {
        chatIndex: chatIdx,
        files,
        summary: chatSummary,
      };

      // localStorage.setItem(`snapshot:${id}`, JSON.stringify(snapshot)); // Remove localStorage usage
      try {
        await setSnapshot(db, id, snapshot);
      } catch (error) {
        console.error('Failed to save snapshot:', error);
        toast.error('Failed to save chat snapshot.');
      }
    },
    [db],
  );

  /**
   * Push a checkpoint to the server (§4.5.5, §4.12).
   *
   * DELIBERATELY NOT called from `takeSnapshot`. Upstream fires that on every mutation of the message
   * array — which, while a generation streams, is every few hundred milliseconds. Hooking a server
   * upload to it produced 160+ checkpoints for ONE message, each a 5.9MB copy of the whole project:
   * about a gigabyte of uploads competing with the stream the user is waiting on. It made the build
   * visibly crawl.
   *
   * SPEC §4.5.5 says it plainly — snapshot "after each APPLIED generation", not per token. So this is
   * called once, from `onFinish`, when the files have stopped moving.
   *
   * Idempotent on `messageId`: a re-render, a retry, or a double `onFinish` cannot mint a duplicate.
   */
  const checkpointProject = useCallback(async (messageId: string) => {
    const pid = projectId.get();

    if (!pid || !db || lastCheckpointedMessage.current === messageId) {
      return;
    }

    lastCheckpointedMessage.current = messageId;
    lastSummary = summarizeRequest(latestMessages.current);

    try {
      const files = await workbenchStore.serializeFiles();

      /*
       * 🔴 The FILES stay in this browser (§4.5.4b). This used to `createSnapshot(pid, …)` — uploading
       * the entire project to our object storage after every generation. Under repo-primary
       * persistence the platform does not hold the user's code: it lives here until they save, and in
       * their own repo afterwards. A server-side copy of every unlinked project is not a backup, it is
       * the old model under a new name.
       *
       * The CONVERSATION still goes up, and that is not an inconsistency — §4.5.4b keeps the project
       * record and the chat on the platform. Without it a build cannot be resumed on another machine
       * and a remixed project arrives with no history of how it was made (§4.5).
       */
      await Promise.all([
        createLocalSnapshot(db, { projectId: pid, files, messageId }),
        saveMessages(pid, latestMessages.current),
      ]);

      /*
       * A generation just produced work that exists in this browser and nowhere else. Everything that
       * warns the user — the indicator, the nudges, the beforeunload prompt — reads this atom, and it
       * is only honest if it is set HERE, at the moment the work becomes unsaved. Auto-push (§4.5.4b)
       * clears it again when it lands.
       */
      unsavedWork.set(true);
      generationCount.set(generationCount.get() + 1);

      logger.info(`Checkpointed project ${pid} at message ${messageId}`);

      /*
       * Auto-push (§4.5.4b), AFTER the local checkpoint is safely written and outside its try/catch.
       *
       * The ordering is deliberate: the local checkpoint is the only copy of this work, so it is
       * written first and a push failure can never cost it. `autoPush` reports its own failures
       * through `saveState` — loudly, per §4.5.4b — so it is not wrapped in the checkpoint's quiet
       * error handling, which would swallow exactly the message the user needs.
       */
      void autoPush(pid);
    } catch (error) {
      /*
       * Reset the guard so the next turn retries.
       *
       * Still not surfaced here, but the reasoning CHANGED and is worth stating: it used to be "their
       * game is on disk and in IndexedDB, so a failed upload is our problem". The local half of that
       * is now the only copy, so a failure to write it is not merely our problem. It stays quiet only
       * because the files are still live in the WebContainer and on screen — nothing is lost yet, and
       * the next generation checkpoints again. The LOUD path is the save to the repo (§4.5.4b), which
       * is the one that decides whether the work survives this browser.
       */
      lastCheckpointedMessage.current = undefined;
      logger.error(`Failed to checkpoint project ${pid}: ${(error as Error).message}`);
    }
  }, []);

  const restoreSnapshot = useCallback(async (_id: string, snapshot?: Snapshot) => {
    const validSnapshot = snapshot || { chatIndex: '', files: {} };

    if (!validSnapshot?.files) {
      return;
    }

    /**
     * Binary entries are base64-decoded and written as bytes. Upstream passed the raw
     * `content` string to `fs.writeFile` for every file, which UTF-8 encoded it — so a
     * binary was written either as a 0-byte file or as literal base64 text.
     */
    await workbenchStore.restoreFiles(validSnapshot.files);
  }, []);

  return {
    ready: !mixedId || ready,
    initialMessages,
    updateChatMestaData: async (metadata: IChatMetadata) => {
      const id = chatId.get();

      if (!db || !id) {
        return;
      }

      try {
        await setMessages(db, id, initialMessages, urlId, description.get(), undefined, metadata);
        chatMetadata.set(metadata);
      } catch (error) {
        toast.error('Failed to update chat metadata');
        console.error(error);
      }
    },

    /** Call once a generation has finished and the files have stopped moving (§4.5.5). */
    checkpointProject,
    storeMessageHistory: async (messages: Message[]) => {
      if (!db || messages.length === 0) {
        return;
      }

      const { firstArtifact } = workbenchStore;
      messages = messages.filter((m) => !m.annotations?.includes('no-store'));

      let _urlId = urlId;

      if (!urlId && firstArtifact?.id) {
        const urlId = await getUrlId(db, firstArtifact.id);
        _urlId = urlId;
        navigateChat(urlId);
        setUrlId(urlId);
      }

      let chatSummary: string | undefined = undefined;
      const lastMessage = messages[messages.length - 1];

      if (lastMessage.role === 'assistant') {
        const annotations = lastMessage.annotations as JSONValue[];
        const filteredAnnotations = (annotations?.filter(
          (annotation: JSONValue) =>
            annotation && typeof annotation === 'object' && Object.keys(annotation).includes('type'),
        ) || []) as { type: string; value: any } & { [key: string]: any }[];

        if (filteredAnnotations.find((annotation) => annotation.type === 'chatSummary')) {
          chatSummary = filteredAnnotations.find((annotation) => annotation.type === 'chatSummary')?.summary;
        }
      }

      takeSnapshot(messages[messages.length - 1].id, workbenchStore.files.get(), _urlId, chatSummary);

      if (!description.get() && firstArtifact?.title) {
        description.set(firstArtifact?.title);
      }

      // Ensure chatId.get() is used here as well
      if (initialMessages.length === 0 && !chatId.get()) {
        const nextId = await getNextId(db);

        chatId.set(nextId);

        if (!urlId) {
          navigateChat(nextId);
        }
      }

      // Ensure chatId.get() is used for the final setMessages call
      const finalChatId = chatId.get();

      if (!finalChatId) {
        console.error('Cannot save messages, chat ID is not set.');
        toast.error('Failed to save chat messages: Chat ID missing.');

        return;
      }

      const allMessages = [...archivedMessages, ...messages];

      await setMessages(
        db,
        finalChatId, // Use the potentially updated chatId
        allMessages,
        urlId,
        description.get(),
        undefined,
        chatMetadata.get(),
      );

      /*
       * The server copy of the conversation is written by `checkpointProject` at the END of a
       * generation, NOT here. This function runs on every mutation of the message array — many times
       * a second while streaming — and uploading the whole conversation on each of those ticks is the
       * same mistake that made checkpoints storm the server.
       */
      latestMessages.current = allMessages;
    },

    /**
     * Remix — clone this project into a new owned copy (SPEC §4.8 self-remix).
     *
     * The platform's unit is the server PROJECT (files + snapshot), not the local conversation. So this
     * runs the self-remix (`/api/remix { projectId }`, `deriveRemix`) using the project id in the chat's
     * metadata, and hands the clone to the builder's resume path (the same baton a shared-game remix
     * uses). Only a pure-legacy chat with no server project (`metadata.projectId` absent) falls back to
     * cloning just the local conversation, so the action never silently produces a dangling copy.
     */
    duplicateCurrentChat: async (listItemId: string) => {
      const id = mixedId || listItemId;

      if (!db || !id) {
        return;
      }

      try {
        const chat = await getMessages(db, id);
        const sourceProjectId = chat?.metadata?.projectId;

        if (sourceProjectId) {
          const response = await fetch('/api/remix', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId: sourceProjectId }),
          });
          const data = (await response.json()) as { projectId?: string; message?: string };

          if (response.ok && data.projectId) {
            sessionStorage.setItem(PENDING_REMIX_KEY, data.projectId);
            navigate('/', { replace: true });
            toast.success('Project remixed');

            return;
          }

          toast.error(data.message ?? 'Failed to remix project');

          return;
        }

        // Legacy fallback: a local-only chat with no server project — clone just the conversation.
        const newId = await duplicateChat(db, id);
        navigate(`/chat/${newId}`);
        toast.success('Chat remixed successfully');
      } catch (error) {
        toast.error('Failed to remix');
        console.log(error);
      }
    },
    importChat: async (description: string, messages: Message[], metadata?: IChatMetadata) => {
      if (!db) {
        return;
      }

      try {
        const newId = await createChatFromMessages(db, description, messages, metadata);
        window.location.href = `/chat/${newId}`;
        toast.success('Chat imported successfully');
      } catch (error) {
        if (error instanceof Error) {
          toast.error('Failed to import chat: ' + error.message);
        } else {
          toast.error('Failed to import chat');
        }
      }
    },
    exportChat: async (id = urlId) => {
      if (!db || !id) {
        return;
      }

      const chat = await getMessages(db, id);
      const chatData = {
        messages: chat.messages,
        description: chat.description,
        exportDate: new Date().toISOString(),
      };

      const blob = new Blob([JSON.stringify(chatData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `chat-${new Date().toISOString()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
  };
}

function navigateChat(nextId: string) {
  /**
   * FIXME: Using the intended navigate function causes a rerender for <Chat /> that breaks the app.
   *
   * `navigate(`/chat/${nextId}`, { replace: true });`
   */
  const url = new URL(window.location.href);
  url.pathname = `/chat/${nextId}`;

  window.history.replaceState({}, '', url);
}
