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

/**
 * The PLAN parser (SPEC §4.2.9) — the transcript parser with exactly one door in the wall.
 *
 * Plan mode is read-only by guarantee, and that guarantee blocked the one write a plan-shaped turn
 * legitimately needs: bt-spec/bt-plan author their planning artifacts (`_specs/<x>_spec.md`,
 * `_specs/<x>_plan.md`) as ordinary file actions, and the wall silently dropped them — the skill
 * reported a spec written that did not exist. A LIVE plan turn is therefore parsed by THIS instance:
 * file actions inside `_specs/` (the `isPlanArtifactPath` rule, shared with the server's plan-mode
 * note) execute exactly like a build turn's; every other file action, and every shell/start action,
 * is registered completed-only, same as the transcript parser.
 *
 * 🔴 ONLY a live-streaming plan message may reach this parser (see the sticky routing below). A
 * RESTORED plan message re-parsed through here would re-write its historical `_specs` bodies over
 * whatever the user has edited since — the §4.5.4b stale-replay bug wearing plan clothes.
 */
const planParser = new EnhancedStreamingMessageParser({
  callbacks: {
    onArtifactOpen: (data) => {
      workbenchStore.showWorkbench.set(true);
      workbenchStore.addArtifact(data);
    },
    onArtifactClose: (data) => {
      workbenchStore.updateArtifact(data, { closed: true });
    },
    onActionOpen: (data) => {
      if (data.action.type !== 'file') {
        return;
      }

      if (isPlanArtifactPath(data.action.filePath)) {
        workbenchStore.addAction(data);
      } else {
        workbenchStore.addCompletedAction(data);
      }
    },
    onActionStream: (data) => {
      if (data.action.type === 'file' && isPlanArtifactPath(data.action.filePath)) {
        workbenchStore.runAction(data, true);
      }
    },
    onActionClose: (data) => {
      if (data.action.type === 'file' && isPlanArtifactPath(data.action.filePath)) {
        // The one sanctioned plan-mode write: the planning artifact itself.
        workbenchStore.runAction(data);
        return;
      }

      if (data.action.type !== 'file') {
        // Shell/start/etc: rendered as a proposal, NEVER run — the wall stands everywhere else.
        workbenchStore.addCompletedAction(data);
      }
    },
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
 *
 * The constant lives in `~/types/message-marks` (re-exported here for existing importers) because the
 * SERVER also writes it now — a Discussion-mode generation (§4.2.9) is annotated before its text
 * streams — and a server route must not import this module (it drags the client stores with it).
 */
export { NO_REPLAY } from '~/types/message-marks';
import { NO_REPLAY, PLAN_MODE } from '~/types/message-marks';
import { isPlanArtifactPath } from '~/lib/chat/plan-artifacts';

export function isTranscriptMessage(message: Message): boolean {
  return Array.isArray(message.annotations) && message.annotations.includes(NO_REPLAY);
}

function isPlanMessage(message: Message): boolean {
  return Array.isArray(message.annotations) && message.annotations.includes(PLAN_MODE);
}

/**
 * 🔴 Routing is STICKY per message id, and that is load-bearing twice over.
 *
 * The parsers are stateful per message id: each instance remembers how much of a message it has
 * consumed. If a message ever switched instances mid-life (say planParser while streaming, then
 * transcriptParser after `isLoading` flips), the new instance would see the ENTIRE content as
 * unparsed — the text renders twice and every completed action registers again. So the first
 * DECIDABLE routing wins for the message's lifetime.
 *
 * "Decidable" is the second half: a streaming message can exist for a render or two before its
 * annotations arrive, and freezing a route off that blank frame would misroute a plan message to
 * the LIVE parser (which writes everything). The server writes `NO_REPLAY`/`PLAN_MODE` BEFORE any
 * text streams (the ordering is the wall, §4.2.9), so by the first non-empty parse the marks are
 * present — until then the message parses as a no-op without recording a route.
 *
 * The plan parser is reachable ONLY here, and only for a message that is plan-marked AND currently
 * streaming (loading + last in the list). A restored plan message is never routed to it: at restore
 * time nothing is loading, so it freezes onto the transcript parser — which is what keeps a reload
 * from re-writing historical `_specs` bodies over the user's edits.
 */
const parserRoutes = new Map<string, EnhancedStreamingMessageParser>();

export function useMessageParser() {
  const [parsedMessages, setParsedMessages] = useState<{ [key: number]: string }>({});

  const parseMessages = useCallback((messages: Message[], isLoading: boolean) => {
    let reset = false;

    if (import.meta.env.DEV && !isLoading) {
      reset = true;
      messageParser.reset();
      transcriptParser.reset();
      planParser.reset();
      parserRoutes.clear();
    }

    for (const [index, message] of messages.entries()) {
      if (message.role === 'assistant' || message.role === 'user') {
        let parser = parserRoutes.get(message.id);

        if (!parser) {
          parser = !isTranscriptMessage(message)
            ? messageParser
            : isPlanMessage(message) && isLoading && index === messages.length - 1
              ? planParser
              : transcriptParser;

          const decidable =
            extractTextContent(message).length > 0 ||
            (Array.isArray(message.annotations) && message.annotations.length > 0);

          if (decidable) {
            parserRoutes.set(message.id, parser);
          }
        }

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
