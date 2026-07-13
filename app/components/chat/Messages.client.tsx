import type { Message } from 'ai';
import { Fragment } from 'react';
import { classNames } from '~/utils/classNames';
import { AssistantMessage } from './AssistantMessage';
import { UserMessage } from './UserMessage';
import { useLocation } from '@remix-run/react';
import { db, chatId, projectId } from '~/lib/persistence/useChatHistory';
import { forkChat } from '~/lib/persistence/db';
import { listSnapshots, readSnapshot, setCurrentSnapshot } from '~/lib/persistence/projects';
import { workbenchStore } from '~/lib/stores/workbench';
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
  append?: (message: Message) => void;
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
     * Put the project files back to how they were at this message (§4.12).
     *
     * Deliberately does NOT delete the checkpoints taken after this one. History is append-only: the
     * restore mounts the old files and then takes a NEW checkpoint, so the trail reads
     * "… → restore → new checkpoint" and the user can always undo their undo. Destroying the future
     * would make this button the very thing it exists to protect against.
     */
    const handleRestore = async (messageId: string) => {
      const pid = activeProjectId;

      if (!pid) {
        toast.error('This project is saved on this device only, so it has no checkpoints to restore.');
        return;
      }

      const toastId = toast.loading('Restoring your project…');

      try {
        const { snapshots } = await listSnapshots(pid);
        const checkpoint = snapshots.find((s) => s.messageId === messageId);

        if (!checkpoint) {
          toast.update(toastId, {
            render: 'There is no checkpoint for this message.',
            type: 'error',
            isLoading: false,
            autoClose: 4000,
          });
          return;
        }

        const { files } = await readSnapshot(pid, checkpoint.id);

        // Byte-faithful: binaries are base64-decoded and written as bytes, never as UTF-8 text.
        await workbenchStore.restoreFiles(files);
        await setCurrentSnapshot(pid, checkpoint.id);

        toast.update(toastId, {
          render: 'Project restored to this checkpoint.',
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
