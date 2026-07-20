import type { Message } from 'ai';
import { Fragment } from 'react';
import { classNames } from '~/utils/classNames';
import { AssistantMessage } from './AssistantMessage';
import { UserMessage } from './UserMessage';
import { useLocation } from '@remix-run/react';
import { db, chatId, projectId } from '~/lib/persistence/useChatHistory';
import { forkChat } from '~/lib/persistence/db';
import {
  createLocalSnapshot,
  listLocalSnapshots,
  readLocalSnapshot,
  setCurrentLocalSnapshot,
} from '~/lib/persistence/local-snapshots';
import { selectRestoreTarget } from '~/lib/persistence/restore-target';
import { protectNothing } from '~/lib/persistence/restore-plan';
import { workbenchStore } from '~/lib/stores/workbench';
import { BUILD_AND_APPLY_MESSAGE } from '~/lib/chat/plan-proposal';
import { useStore } from '@nanostores/react';
import { toast } from 'react-toastify';
import { forwardRef } from 'react';
import type { ForwardedRef } from 'react';
import type { ProviderInfo } from '~/types/model';

interface MessagesProps {
  id?: string;
  className?: string;
  isStreaming?: boolean;
  messages?: Message[];

  /**
   * The AI SDK's `append`. The optional `options.body` overrides the request body for THIS call — used
   * by "Build & Apply" to force `chatMode: 'build'` without waiting for the toggle's state to commit
   * (the request body is otherwise read from a ref refreshed in a `useEffect`, i.e. committed renders).
   */
  append?: (message: Message, options?: { body?: Record<string, unknown> }) => void;

  /** Used to write the "restored to checkpoint" note into the chat WITHOUT starting a generation. */
  setMessages?: (messages: Message[]) => void;

  chatMode?: 'discuss' | 'build';
  setChatMode?: (mode: 'discuss' | 'build') => void;
  model?: string;
  provider?: ProviderInfo;
  addToolResult: ({ toolCallId, result }: { toolCallId: string; result: any }) => void;
}

export const Messages = forwardRef<HTMLDivElement, MessagesProps>(
  (props: MessagesProps, ref: ForwardedRef<HTMLDivElement> | undefined) => {
    const { id, isStreaming = false, messages = [] } = props;
    const location = useLocation();
    const activeProjectId = useStore(projectId);

    /** Checkpoints live on the server, so a local-only chat has nothing to restore to (§4.5.5). */
    const canRestore = Boolean(activeProjectId);

    const handleRewind = (messageId: string) => {
      const searchParams = new URLSearchParams(location.search);
      searchParams.set('rewindTo', messageId);
      window.location.search = searchParams.toString();
    };

    const handleFork = async (messageId: string) => {
      try {
        if (!db || !chatId.get()) {
          toast.error('Chat persistence is not available');
          return;
        }

        const urlId = await forkChat(db, chatId.get()!, messageId);
        window.location.href = `/chat/${urlId}`;
      } catch (error) {
        toast.error('Failed to fork chat: ' + (error as Error).message);
      }
    };

    /**
     * Put the project files back to how they were around this message (§4.12).
     *
     * **`mode` is the whole point of the version history.** Checkpoints are taken AFTER a generation is
     * applied, so the checkpoint anchored to an assistant message is the state that message *produced*:
     *
     *   - `'after'`  — the state this change produced. "I liked it here, take me back."
     *   - `'before'` — the state that existed BEFORE this change, i.e. the previous message's
     *     checkpoint. This is the one people actually reach for: "that last change wrecked it, undo it."
     *     Offering only `'after'` meant the single most-wanted action — undo THIS — was impossible
     *     without hunting for the preceding message and restoring that instead.
     *
     * Three properties this must never lose:
     *
     * 1. **Nothing is destroyed.** The checkpoints taken after the restore point survive, so the user
     *    can undo their undo by restoring forward. Deleting the future would make this button the very
     *    thing it exists to protect against.
     * 2. **The restore is itself checkpointed.** History is append-only, so the state we just came FROM
     *    stays reachable even after the next generation overwrites the working tree.
     * 3. **The chat is told.** Without a note in the conversation, the model's history claims it wrote
     *    code that no longer exists on disk — so its next edit would be reasoning about a file that is
     *    gone, and the user would have no record of why their project changed under them.
     */
    const handleRestore = async (messageId: string, mode: 'before' | 'after') => {
      const pid = activeProjectId;

      if (!pid) {
        toast.error('This project is saved on this device only, so it has no checkpoints to restore.');
        return;
      }

      if (!db) {
        toast.error('This browser cannot store checkpoints, so there is nothing to restore.');
        return;
      }

      const toastId = toast.loading('Restoring your project…');

      try {
        /*
         * The checkpoint history is LOCAL now (§4.5.4b). It used to be a list of server rows, back
         * when the platform kept a copy of every project; it keeps none, so the history lives in this
         * browser and in the linked repo. Same contract as before — oldest-first, so "the one before
         * this" is simply the preceding entry.
         */
        const snapshots = await listLocalSnapshots(db, pid);
        const selection = selectRestoreTarget(snapshots, messageId, mode);

        if (!selection.ok) {
          toast.update(toastId, {
            render:
              selection.reason === 'nothing-before'
                ? 'This is the first change in the project — there is no earlier state to go back to.'
                : 'There is no checkpoint for this message.',
            type: selection.reason === 'nothing-before' ? 'info' : 'error',
            isLoading: false,
            autoClose: 5000,
          });
          return;
        }

        const target = selection.snapshot;
        const restored = await readLocalSnapshot(db, target.id);

        if (!restored) {
          toast.update(toastId, {
            render: 'That checkpoint is no longer available on this device.',
            type: 'error',
            isLoading: false,
            autoClose: 5000,
          });
          return;
        }

        /*
         * Checkpoint the state we are LEAVING, before we overwrite it (property 2). Do it first: once
         * `restoreFiles` has run, the bytes we would have captured are gone. A failure here must not
         * block the restore the user asked for — so it is best-effort, and loud only in the log.
         */
        try {
          await createLocalSnapshot(db, {
            projectId: pid,
            files: await workbenchStore.serializeFiles(),
            label: 'Before restore',
          });
        } catch {
          // The restore is still safe: every earlier checkpoint remains, we just did not add one.
        }

        /*
         * Byte-faithful: binaries are base64-decoded and written as bytes, never as UTF-8 text.
         *
         * `protectNothing` makes this a real restore rather than an overlay (§4.12): a file the
         * checkpoint does not have is DELETED, because the checkpoint is a serialization of the whole
         * store and its absence means the project genuinely did not have that file at that moment.
         * Without it, undoing past the generation that added `Boss.ts` left `Boss.ts` on disk — the
         * undo silently did not undo, which is the one thing this button exists to do.
         */
        await workbenchStore.restoreFiles(restored.files, { protect: protectNothing });
        await setCurrentLocalSnapshot(db, pid, target.id);

        /*
         * Tell the conversation what happened (property 3). An assistant message, not a user one: it
         * must NOT trigger a generation, and the model needs to read it as a statement of fact about
         * the project it is now working on.
         */
        props.setMessages?.([
          ...messages,
          {
            id: `restore-${Date.now()}`,
            role: 'assistant',
            content:
              mode === 'before'
                ? '↩︎ Restored the project files to the checkpoint from **before** this change. Any edits that change made are no longer on disk — work from the current files, not from what was written earlier in this conversation.'
                : '↩︎ Restored the project files to the checkpoint taken **after** this change. Work from the current files, not from what was written later in this conversation.',
          } as Message,
        ]);

        toast.update(toastId, {
          render:
            mode === 'before' ? 'Project restored to before this change.' : 'Project restored to this checkpoint.',
          type: 'success',
          isLoading: false,
          autoClose: 3000,
        });
      } catch (error) {
        toast.update(toastId, {
          render: `Could not restore: ${(error as Error).message}`,
          type: 'error',
          isLoading: false,
          autoClose: 5000,
        });
      }
    };

    /**
     * "Try again" (§4.12): rewind the conversation to just before this turn and re-run it.
     *
     * A normal generation, charged normally — a hard failure auto-refunds through the ledger (§4.6),
     * so a retry after a crash costs the user nothing net.
     */
    const handleRetry = (messageId: string) => {
      const index = messages.findIndex((m) => m.id === messageId);
      const prompt = [...messages.slice(0, index)].reverse().find((m) => m.role === 'user');

      if (!prompt || !props.append) {
        toast.error('There is nothing to retry here.');
        return;
      }

      props.append({
        id: `retry-${Date.now()}`,
        role: 'user',
        content: typeof prompt.content === 'string' ? prompt.content : '',
      });
    };

    /**
     * "Build & Apply" (§4.2.9): the user approved a change proposed on a Plan-mode turn. Flip the
     * toggle to Build and re-run so the model actually writes the files this time.
     *
     * The `body: { chatMode: 'build' }` override is load-bearing: `setChatMode('build')` only takes
     * effect on the NEXT committed render, but `append` fires now and would otherwise send the stale
     * `chatMode: 'discuss'` — running ANOTHER read-only plan turn and reproducing the exact dead-end
     * this button exists to fix. We set the toggle too, so the mode stays Build for later turns.
     */
    const handleBuildAndApply = (_messageId: string) => {
      if (!props.append) {
        return;
      }

      props.setChatMode?.('build');
      props.append(
        { id: `apply-${Date.now()}`, role: 'user', content: BUILD_AND_APPLY_MESSAGE },
        { body: { chatMode: 'build' } },
      );
    };

    return (
      <div id={id} className={props.className} ref={ref}>
        {messages.length > 0
          ? messages.map((message, index) => {
              const { role, content, id: messageId, annotations, parts } = message;
              const isUserMessage = role === 'user';
              const isFirst = index === 0;
              const isHidden = annotations?.includes('hidden');

              if (isHidden) {
                return <Fragment key={index} />;
              }

              return (
                <div
                  key={index}
                  className={classNames('flex gap-4 py-3 w-full rounded-lg', {
                    'mt-4': !isFirst,
                  })}
                >
                  <div className="grid grid-col-1 w-full">
                    {isUserMessage ? (
                      <UserMessage content={content} parts={parts} />
                    ) : (
                      <AssistantMessage
                        content={content}
                        annotations={message.annotations}
                        messageId={messageId}
                        onRewind={handleRewind}
                        onFork={handleFork}
                        onRestore={canRestore ? handleRestore : undefined}
                        onRetry={props.append ? handleRetry : undefined}
                        onBuildAndApply={props.append ? handleBuildAndApply : undefined}
                        append={props.append}
                        chatMode={props.chatMode}
                        setChatMode={props.setChatMode}
                        model={props.model}
                        provider={props.provider}
                        parts={parts}
                        addToolResult={props.addToolResult}
                      />
                    )}
                  </div>
                </div>
              );
            })
          : null}
        {isStreaming && (
          <div className="text-center w-full  text-bolt-elements-item-contentAccent i-svg-spinners:3-dots-fade text-4xl mt-4"></div>
        )}
      </div>
    );
  },
);
