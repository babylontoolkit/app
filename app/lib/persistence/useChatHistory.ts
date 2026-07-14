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
import type { Snapshot } from './types';
import { detectProjectCommands, createCommandActionsString } from '~/utils/projectCommands';
import type { ContextAnnotation } from '~/types/context';
import { createSnapshot, restoreLatestServerCheckpoint, saveMessages } from './projects';
import { takePendingRemix } from './pending-remix';
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
             * The SERVER holds the authoritative files (§4.5.5). IndexedDB is a same-browser cache;
             * the project itself lives on the platform, so on resume we mount what the platform has —
             * that is what makes a build openable on another machine at all.
             *
             * Best-effort by design: if the network is down, the local snapshot above already put a
             * working project on screen, and refusing to open it would be a worse answer.
             */
            const pid = storedMessages.metadata?.projectId;

            if (pid) {
              try {
                const { files } = await restoreLatestServerCheckpoint(pid);

                if (files) {
                  await workbenchStore.restoreFiles(files);
                }
              } catch (error) {
                logger.warn(`Could not restore project ${pid} from the server: ${(error as Error).message}`);
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
       * No mixedId — a fresh builder. But a remix (§4.8) may have parked a cloned project id here on
       * its way in. If so, adopt it: set the project and mount its files through the SAME
       * server-checkpoint path a normal resume uses. The conversation is fresh (a remix starts a new
       * chat), but the files are the cloned game, ready to build on.
       */
      const remixProjectId = takePendingRemix();

      if (remixProjectId) {
        projectId.set(remixProjectId);
        chatMetadata.set({ ...chatMetadata.get(), projectId: remixProjectId });

        restoreLatestServerCheckpoint(remixProjectId)
          .then(({ files }) => (files ? workbenchStore.restoreFiles(files) : undefined))
          .catch((error) => logger.warn(`Could not load remixed project ${remixProjectId}: ${error.message}`))
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

    if (!pid || lastCheckpointedMessage.current === messageId) {
      return;
    }

    lastCheckpointedMessage.current = messageId;

    try {
      const files = await workbenchStore.serializeFiles();

      /*
       * Files and conversation together, once, at the end of a generation. The conversation belongs to
       * the PROJECT, not to this browser — without it a build cannot be resumed on another machine and
       * a shared or remixed project arrives with no history of how it was made (§4.5).
       */
      await Promise.all([createSnapshot(pid, { files, messageId }), saveMessages(pid, latestMessages.current)]);

      logger.info(`Checkpointed project ${pid} at message ${messageId}`);
    } catch (error) {
      /*
       * Never surfaced to the user: their game is on disk and in IndexedDB, the build worked, and a
       * failed checkpoint upload is our problem, not something for them to act on. Reset the guard so
       * the next turn retries.
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
    duplicateCurrentChat: async (listItemId: string) => {
      if (!db || (!mixedId && !listItemId)) {
        return;
      }

      try {
        const newId = await duplicateChat(db, mixedId || listItemId);
        navigate(`/chat/${newId}`);
        toast.success('Chat duplicated successfully');
      } catch (error) {
        toast.error('Failed to duplicate chat');
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
