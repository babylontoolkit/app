import { memo, Fragment } from 'react';
import { Markdown } from './Markdown';
import type { JSONValue } from 'ai';
import Popover from '~/components/ui/Popover';
import { workbenchStore } from '~/lib/stores/workbench';
import { WORK_DIR } from '~/utils/constants';
import WithTooltip from '~/components/ui/Tooltip';
import type { Message } from 'ai';
import type { ProviderInfo } from '~/types/model';
import type {
  TextUIPart,
  ReasoningUIPart,
  ToolInvocationUIPart,
  SourceUIPart,
  FileUIPart,
  StepStartUIPart,
} from '@ai-sdk/ui-utils';
import { ToolInvocations } from './ToolInvocations';
import { ThinkingPanel } from './ThinkingPanel';
import type { ToolCallAnnotation } from '~/types/context';
import { shouldOfferBuildAndApply } from '~/lib/chat/plan-proposal';

interface AssistantMessageProps {
  content: string;
  annotations?: JSONValue[];
  messageId?: string;
  onRewind?: (messageId: string) => void;
  onFork?: (messageId: string) => void;

  /** Restore the project FILES to the checkpoint taken at this message (§4.12). */
  /** `mode` selects the state BEFORE this change (the undo people want) or AFTER it (§4.12). */
  onRestore?: (messageId: string, mode: 'before' | 'after') => void;

  /** Re-run this turn from the checkpoint that preceded it (§4.12). */
  onRetry?: (messageId: string) => void;
  append?: (message: Message) => void;

  /**
   * Plan mode (§4.2.9): flip the toggle to Build and re-run to APPLY the change this plan turn
   * proposed. Offered only on a plan turn that proposed a write — see `shouldOfferBuildAndApply`.
   */
  onBuildAndApply?: (messageId: string) => void;
  chatMode?: 'discuss' | 'build';
  setChatMode?: (mode: 'discuss' | 'build') => void;
  model?: string;
  provider?: ProviderInfo;
  parts:
    | (TextUIPart | ReasoningUIPart | ToolInvocationUIPart | SourceUIPart | FileUIPart | StepStartUIPart)[]
    | undefined;
  addToolResult: ({ toolCallId, result }: { toolCallId: string; result: any }) => void;
}

function openArtifactInWorkbench(filePath: string) {
  filePath = normalizedFilePath(filePath);

  if (workbenchStore.currentView.get() !== 'code') {
    workbenchStore.currentView.set('code');
  }

  workbenchStore.setSelectedFile(`${WORK_DIR}/${filePath}`);
}

function normalizedFilePath(path: string) {
  let normalizedPath = path;

  if (normalizedPath.startsWith(WORK_DIR)) {
    normalizedPath = path.replace(WORK_DIR, '');
  }

  if (normalizedPath.startsWith('/')) {
    normalizedPath = normalizedPath.slice(1);
  }

  return normalizedPath;
}

export const AssistantMessage = memo(
  ({
    content,
    annotations,
    messageId,
    onRewind,
    onFork,
    onRestore,
    onRetry,
    append,
    onBuildAndApply,
    chatMode,
    setChatMode,
    model,
    provider,
    parts,
    addToolResult,
  }: AssistantMessageProps) => {
    const offerBuildAndApply = Boolean(onBuildAndApply && messageId && shouldOfferBuildAndApply(annotations, content));
    const filteredAnnotations = (annotations?.filter(
      (annotation: JSONValue) =>
        annotation && typeof annotation === 'object' && Object.keys(annotation).includes('type'),
    ) || []) as { type: string; value: any } & { [key: string]: any }[];

    let chatSummary: string | undefined = undefined;

    if (filteredAnnotations.find((annotation) => annotation.type === 'chatSummary')) {
      chatSummary = filteredAnnotations.find((annotation) => annotation.type === 'chatSummary')?.summary;
    }

    let codeContext: string[] | undefined = undefined;

    if (filteredAnnotations.find((annotation) => annotation.type === 'codeContext')) {
      codeContext = filteredAnnotations.find((annotation) => annotation.type === 'codeContext')?.files;
    }

    const usage: {
      completionTokens: number;
      promptTokens: number;
      totalTokens: number;
    } = filteredAnnotations.find((annotation) => annotation.type === 'usage')?.value;

    const toolInvocations = parts?.filter((part) => part.type === 'tool-invocation');
    const toolCallAnnotations = filteredAnnotations.filter(
      (annotation) => annotation.type === 'toolCall',
    ) as ToolCallAnnotation[];

    /*
     * The model's summarized reasoning (§4.2a). It arrives on the AI SDK's own reasoning channel, so
     * it is never fed to the artifact parser — reasoning that leaked into `text` mid-`<boltAction>`
     * would be written into the user's file.
     */
    const reasoning = (parts ?? [])
      .filter((part): part is ReasoningUIPart => part.type === 'reasoning')
      .map((part) => part.reasoning)
      .join('');

    /* Still thinking, nothing written yet — the case that used to render as a dead spinner. */
    const isThinking = Boolean(reasoning) && !content.trim();

    return (
      <div className="overflow-hidden w-full">
        <>
          {reasoning && <ThinkingPanel reasoning={reasoning} streaming={isThinking} />}
          <div className=" flex gap-2 items-center text-sm text-bolt-elements-textSecondary mb-2">
            {(codeContext || chatSummary) && (
              <Popover side="right" align="start" trigger={<div className="i-ph:info" />}>
                {chatSummary && (
                  <div className="max-w-chat">
                    <div className="summary max-h-96 flex flex-col">
                      <h2 className="border border-bolt-elements-borderColor rounded-md p4">Summary</h2>
                      <div style={{ zoom: 0.7 }} className="overflow-y-auto m4">
                        <Markdown>{chatSummary}</Markdown>
                      </div>
                    </div>
                    {codeContext && (
                      <div className="code-context flex flex-col p4 border border-bolt-elements-borderColor rounded-md">
                        <h2>Context</h2>
                        <div className="flex gap-4 mt-4 bolt" style={{ zoom: 0.6 }}>
                          {codeContext.map((x) => {
                            const normalized = normalizedFilePath(x);
                            return (
                              <Fragment key={normalized}>
                                <code
                                  className="bg-bolt-elements-artifacts-inlineCode-background text-bolt-elements-artifacts-inlineCode-text px-1.5 py-1 rounded-md text-bolt-elements-item-contentAccent hover:underline cursor-pointer"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    openArtifactInWorkbench(normalized);
                                  }}
                                >
                                  {normalized}
                                </code>
                              </Fragment>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <div className="context"></div>
              </Popover>
            )}
            <div className="flex w-full items-center justify-between">
              {usage && (
                <div>
                  Tokens: {usage.totalTokens} (prompt: {usage.promptTokens}, completion: {usage.completionTokens})
                </div>
              )}
              {(onRewind || onFork || onRestore || onRetry) && messageId && (
                <div className="flex gap-2 flex-col lg:flex-row ml-auto">
                  {/*
                   * Restore the FILES (§4.12) — distinct from Revert, which only rewinds the
                   * conversation. For a non-developer who cannot read a diff to see what the last
                   * generation broke, this is the safety net: it puts the game back.
                   *
                   * BOTH directions are offered, because they answer different questions and only one
                   * of them is the one people actually reach for:
                   *   - BEFORE — "that change wrecked it, undo it." The common case.
                   *   - AFTER  — "I liked it as it was here, bring that back."
                   * Offering only "after" made undoing THIS change impossible without hunting for the
                   * preceding message and restoring that instead.
                   *
                   * Neither destroys history: the checkpoints after the restore point survive, and the
                   * restore itself is checkpointed, so the undo can always be undone.
                   */}
                  {onRestore && (
                    <WithTooltip tooltip="Undo this change — restore the files to how they were BEFORE it">
                      <button
                        onClick={() => onRestore(messageId, 'before')}
                        key="i-ph:arrow-arc-left"
                        className="i-ph:arrow-arc-left text-xl text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary transition-colors"
                      />
                    </WithTooltip>
                  )}
                  {onRestore && (
                    <WithTooltip tooltip="Restore the project files to how they were AFTER this change">
                      <button
                        onClick={() => onRestore(messageId, 'after')}
                        key="i-ph:clock-counter-clockwise"
                        className="i-ph:clock-counter-clockwise text-xl text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary transition-colors"
                      />
                    </WithTooltip>
                  )}
                  {onRetry && (
                    <WithTooltip tooltip="Try this again">
                      <button
                        onClick={() => onRetry(messageId)}
                        key="i-ph:arrows-clockwise"
                        className="i-ph:arrows-clockwise text-xl text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary transition-colors"
                      />
                    </WithTooltip>
                  )}
                  {onRewind && (
                    <WithTooltip tooltip="Revert to this message">
                      <button
                        onClick={() => onRewind(messageId)}
                        key="i-ph:arrow-u-up-left"
                        className="i-ph:arrow-u-up-left text-xl text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary transition-colors"
                      />
                    </WithTooltip>
                  )}
                  {onFork && (
                    <WithTooltip tooltip="Fork chat from this message">
                      <button
                        onClick={() => onFork(messageId)}
                        key="i-ph:git-fork"
                        className="i-ph:git-fork text-xl text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary transition-colors"
                      />
                    </WithTooltip>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
        <Markdown append={append} chatMode={chatMode} setChatMode={setChatMode} model={model} provider={provider} html>
          {content}
        </Markdown>
        {offerBuildAndApply && (
          <div className="mt-3">
            <button
              onClick={() => onBuildAndApply!(messageId!)}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-xs rounded-md bg-accent-500 text-white hover:bg-bolt-elements-button-primary-backgroundHover transition-colors"
            >
              <div className="i-ph:hammer" />
              Build &amp; Apply
            </button>
            <p className="mt-1.5 text-xs text-bolt-elements-textTertiary">
              This was a plan — no files were changed. Switch to Build and apply it.
            </p>
          </div>
        )}
        {toolInvocations && toolInvocations.length > 0 && (
          <ToolInvocations
            toolInvocations={toolInvocations}
            toolCallAnnotations={toolCallAnnotations}
            addToolResult={addToolResult}
          />
        )}
      </div>
    );
  },
);
