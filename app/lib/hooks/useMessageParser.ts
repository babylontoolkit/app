import type { Message } from 'ai';
import { useCallback, useState } from 'react';
import { EnhancedStreamingMessageParser } from '~/lib/runtime/enhanced-message-parser';
import { workbenchStore } from '~/lib/stores/workbench';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('useMessageParser');

const messageParser = new EnhancedStreamingMessageParser({
  callbacks: {
    onArtifactOpen: (data) => {
      logger.trace('onArtifactOpen', data);

      workbenchStore.showWorkbench.set(true);
      workbenchStore.addArtifact(data);
    },
    onArtifactClose: (data) => {
      logger.trace('onArtifactClose');

      workbenchStore.updateArtifact(data, { closed: true });
    },
    onActionOpen: (data) => {
      logger.trace('onActionOpen', data.action);

      /*
       * File actions are streamed, so we add them immediately to show progress
       * Shell actions are complete when created by enhanced parser, so we wait for close
       */
      if (data.action.type === 'file') {
        workbenchStore.addAction(data);
      }
    },
    onActionClose: (data) => {
      logger.trace('onActionClose', data.action);

      /*
       * Add non-file actions (shell, build, start, etc.) when they close
       * Enhanced parser creates complete shell actions, so they're ready to execute
       */
      if (data.action.type !== 'file') {
        workbenchStore.addAction(data);
      }

      workbenchStore.runAction(data);
    },
    onActionStream: (data) => {
      logger.trace('onActionStream', data.action);
      workbenchStore.runAction(data, true);
    },
  },
});

/**
 * The TRANSCRIPT parser (SPEC §4.5.4b).
 *
 * 🔴 Parsing a message is not a read-only act — `onActionClose` above calls `workbenchStore.runAction`,
 * which WRITES FILES. That is deliberate and load-bearing: it is how upstream rebuilds a project that
 * has no snapshot, by replaying its history.
 *
 * It is also exactly wrong for a project mounted from the user's own repository. Those files are
 * already correct and already theirs; replaying a months-old `<boltAction type="file">` would write
 * its stale body over the repo's version, racing the mount, silently — the same class of bug as the
 * overlay restore (`restore-plan.ts`), in the same area, where being wrong costs the only copy.
 *
 * So a restored conversation is parsed by THIS instance: same rendering, same artifact bubbles, same
 * file lists — every action registered as already-complete (`addCompletedAction`), none executed. It
 * is a record of what happened, not an instruction to do it again.
 *
 * A separate instance rather than a flag on the shared one because the parser is stateful per message
 * id, and a mode flag flipped between `parse` calls is a race with a live generation.
 */
const transcriptParser = new EnhancedStreamingMessageParser({
  callbacks: {
    onArtifactOpen: (data) => {
      /*
       * 🔴 BOTH of these, exactly like the live parser.
       *
       * This shipped with only `addArtifact`, and the project view VANISHED for every restored
       * conversation: the chat came back, the artifact bubbles rendered, and the file tree, editor and
       * preview were simply not there — for a project the user was looking straight at.
       *
       * The cause was conflating two different things while writing this parser. Dropping `runAction`
       * is the entire point of it (replaying a stale `<boltAction type="file">` over the user's repo is
       * the bug it exists to prevent). Dropping `showWorkbench` was collateral: opening a panel writes
       * no files and re-runs nothing. It is UI, and a restored project deserves the same UI as a live
       * one — reaching the workbench should not require a generation.
       */
      workbenchStore.showWorkbench.set(true);

      // The artifact still has to exist, or the chat renders a bubble that resolves to nothing.
      workbenchStore.addArtifact(data);
    },
    onArtifactClose: (data) => {
      workbenchStore.updateArtifact(data, { closed: true });
    },
    onActionOpen: (data) => {
      if (data.action.type === 'file') {
        workbenchStore.addCompletedAction(data);
      }
    },
    onActionClose: (data) => {
      if (data.action.type !== 'file') {
        workbenchStore.addCompletedAction(data);
      }

      // 🔴 No `runAction`. That is the entire point of this parser — do not add one.
    },

    // No `onActionStream` either: streaming IS running.
  },
});

const extractTextContent = (message: Message) =>
  Array.isArray(message.content)
    ? (message.content.find((item) => item.type === 'text')?.text as string) || ''
    : message.content;

/**
 * Marks a message as history to SHOW, never to re-run — see `transcriptParser`.
 *
 * An annotation rather than a field because `Message` is the AI SDK's type and annotations are its
 * sanctioned extension point; it also survives the IndexedDB round-trip with the message, so a reload
 * cannot lose the "do not replay this" and start writing stale files.
 */
export const NO_REPLAY = 'no-replay';

export function isTranscriptMessage(message: Message): boolean {
  return Array.isArray(message.annotations) && message.annotations.includes(NO_REPLAY);
}

export function useMessageParser() {
  const [parsedMessages, setParsedMessages] = useState<{ [key: number]: string }>({});

  const parseMessages = useCallback((messages: Message[], isLoading: boolean) => {
    let reset = false;

    if (import.meta.env.DEV && !isLoading) {
      reset = true;
      messageParser.reset();
      transcriptParser.reset();
    }

    for (const [index, message] of messages.entries()) {
      if (message.role === 'assistant' || message.role === 'user') {
        const parser = isTranscriptMessage(message) ? transcriptParser : messageParser;
        const newParsedContent = parser.parse(message.id, extractTextContent(message));
        setParsedMessages((prevParsed) => ({
          ...prevParsed,
          [index]: !reset ? (prevParsed[index] || '') + newParsedContent : newParsedContent,
        }));
      }
    }
  }, []);

  return { parsedMessages, parseMessages };
}
