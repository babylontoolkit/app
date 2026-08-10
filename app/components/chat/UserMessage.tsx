/*
 * @ts-nocheck
 * Preventing TS checks with files presented in the video for a better presentation.
 */
import { Markdown } from './Markdown';
import { CopyTextButton } from './CopyTextButton';
import { copyableUserMessageText, userMessageText } from '~/lib/chat/user-message-text';
import { useStore } from '@nanostores/react';
import { profileStore } from '~/lib/stores/profile';
import type {
  TextUIPart,
  ReasoningUIPart,
  ToolInvocationUIPart,
  SourceUIPart,
  FileUIPart,
  StepStartUIPart,
} from '@ai-sdk/ui-utils';

interface UserMessageProps {
  content: string | Array<{ type: string; text?: string; image?: string }>;
  parts:
    | (TextUIPart | ReasoningUIPart | ToolInvocationUIPart | SourceUIPart | FileUIPart | StepStartUIPart)[]
    | undefined;
}

export function UserMessage({ content, parts }: UserMessageProps) {
  const profile = useStore(profileStore);

  // Extract images from parts - look for file parts with image mime types
  const images =
    parts?.filter(
      (part): part is FileUIPart => part.type === 'file' && 'mimeType' in part && part.mimeType.startsWith('image/'),
    ) || [];

  /*
   * 🔴 ONE source for both the bubble and the Copy button. They must never diverge: the raw content
   * carries a machine-prepended `<boltArtifact>` of every edited file, so a Copy that read `content`
   * would silently put tens of kilobytes of file bodies on the clipboard from a one-line message.
   */
  const textContent = userMessageText(content);
  const copyText = copyableUserMessageText(content);

  if (Array.isArray(content)) {
    return (
      <div className="overflow-hidden flex flex-col gap-3 items-center ">
        <div className="flex flex-row items-start justify-center overflow-hidden shrink-0 self-start">
          {profile?.avatar || profile?.username ? (
            <div className="flex items-end gap-2">
              <img
                src={profile.avatar}
                alt={profile?.username || 'User'}
                className="w-[25px] h-[25px] object-cover rounded-full"
                loading="eager"
                decoding="sync"
              />
              <span className="text-bolt-elements-textPrimary text-sm">
                {profile?.username ? profile.username : ''}
              </span>
            </div>
          ) : (
            <div className="i-ph:user-fill text-accent-500 text-2xl" />
          )}
        </div>
        <div className="group flex items-start gap-2 mr-auto">
          <div className="flex flex-col gap-4 bg-accent-500/10 backdrop-blur-sm p-3 py-3 w-auto rounded-lg">
            {textContent && <Markdown html>{textContent}</Markdown>}
            {images.map((item, index) => (
              <img
                key={index}
                src={`data:${item.mimeType};base64,${item.data}`}
                alt={`Image ${index + 1}`}
                className="max-w-full h-auto rounded-lg"
                style={{ maxHeight: '512px', objectFit: 'contain' }}
              />
            ))}
          </div>
          {copyText && <CopyTextButton text={copyText} className="mt-1 shrink-0" />}
        </div>
      </div>
    );
  }

  /*
   * 🔴 THE BUTTON IS IN FLOW, NEXT TO THE BUBBLE — NEVER HANGING OFF ITS CORNER (owner, 2026-08-09:
   * *"the COPY To CLIPBOARD button is cut off, it's too far over"*).
   *
   * The first version was `absolute -top-2 -right-2`, which reads well in isolation and is clipped in
   * place: the transcript lives inside `StickToBottom`, a SCROLL container, and the message row is
   * `w-full` — so the bubble's right edge IS the scroller's edge and anything past it is cut in half.
   * Nudging the offsets would only move the seam; the fix is to stop protruding at all.
   *
   * In flow it also cannot overlap the text, which the obvious "put it inside the corner instead"
   * cannot promise: the bubble is `w-auto`, so on a one-line message the words run right up to the
   * padding and an inset icon lands on the last few characters.
   *
   * The gutter is held whether or not the button is showing (it is hidden with `opacity`, so it keeps
   * its box) — the bubble simply sits ~32px further left, which is invisible on a right-aligned
   * message and buys no layout shift on hover.
   */
  return (
    <div className="group flex items-start gap-2 ml-auto">
      {copyText && <CopyTextButton text={copyText} className="mt-1 shrink-0" />}
      <div className="flex flex-col bg-accent-500/10 backdrop-blur-sm px-5 p-3.5 w-auto rounded-lg">
        <div className="flex gap-3.5 mb-4">
          {images.map((item, index) => (
            <div className="relative flex rounded-lg border border-bolt-elements-borderColor overflow-hidden">
              <div className="h-16 w-16 bg-transparent outline-none">
                <img
                  key={index}
                  src={`data:${item.mimeType};base64,${item.data}`}
                  alt={`Image ${index + 1}`}
                  className="h-full w-full rounded-lg"
                  style={{ objectFit: 'fill' }}
                />
              </div>
            </div>
          ))}
        </div>
        <Markdown html>{textContent}</Markdown>
      </div>
    </div>
  );
}
