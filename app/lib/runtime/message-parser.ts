import type {
  ActionType,
  BoltAction,
  BoltActionData,
  EditAction,
  FileAction,
  ShellAction,
  SupabaseAction,
} from '~/types/actions';
import type { BoltArtifactData } from '~/types/artifact';
import { createScopedLogger } from '~/utils/logger';
import { unreachable } from '~/utils/unreachable';

const ARTIFACT_TAG_OPEN = '<boltArtifact';
const ARTIFACT_TAG_CLOSE = '</boltArtifact>';
const ARTIFACT_ACTION_TAG_OPEN = '<boltAction';
const ARTIFACT_ACTION_TAG_CLOSE = '</boltAction>';
const BOLT_QUICK_ACTIONS_OPEN = '<bolt-quick-actions>';
const BOLT_QUICK_ACTIONS_CLOSE = '</bolt-quick-actions>';

const logger = createScopedLogger('MessageParser');

export interface ArtifactCallbackData extends BoltArtifactData {
  messageId: string;
  artifactId?: string;
}

export interface ActionCallbackData {
  artifactId: string;
  messageId: string;
  actionId: string;
  action: BoltAction;
}

export type ArtifactCallback = (data: ArtifactCallbackData) => void;
export type ActionCallback = (data: ActionCallbackData) => void;

export interface ParserCallbacks {
  onArtifactOpen?: ArtifactCallback;
  onArtifactClose?: ArtifactCallback;
  onActionOpen?: ActionCallback;
  onActionStream?: ActionCallback;
  onActionClose?: ActionCallback;
}

interface ElementFactoryProps {
  messageId: string;
  artifactId?: string;
}

type ElementFactory = (props: ElementFactoryProps) => string;

export interface StreamingMessageParserOptions {
  callbacks?: ParserCallbacks;
  artifactElement?: ElementFactory;
}

interface MessageState {
  position: number;
  insideArtifact: boolean;
  insideAction: boolean;
  artifactCounter: number;
  currentArtifact?: BoltArtifactData;
  currentAction: BoltActionData;
  actionId: number;

  /** Raw tail of an action still streaming, so `finish()` can salvage a truncated file. */
  pendingActionTail?: string;
}

function cleanoutMarkdownSyntax(content: string) {
  const codeBlockRegex = /^\s*```\w*\n([\s\S]*?)\n\s*```\s*$/;
  const match = content.match(codeBlockRegex);

  // console.log('matching', !!match, content);

  if (match) {
    return match[1]; // Remove common leading 4-space indent
  } else {
    return content;
  }
}

function cleanEscapedTags(content: string) {
  return content.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
export class StreamingMessageParser {
  #messages = new Map<string, MessageState>();
  #artifactCounter = 0;

  constructor(private _options: StreamingMessageParserOptions = {}) {}

  parse(messageId: string, input: string) {
    let state = this.#messages.get(messageId);

    if (!state) {
      state = {
        position: 0,
        insideAction: false,
        insideArtifact: false,
        artifactCounter: 0,
        currentAction: { content: '' },
        actionId: 0,
      };

      this.#messages.set(messageId, state);
    }

    let output = '';
    let i = state.position;
    let earlyBreak = false;

    while (i < input.length) {
      if (input.startsWith(BOLT_QUICK_ACTIONS_OPEN, i)) {
        const actionsBlockEnd = input.indexOf(BOLT_QUICK_ACTIONS_CLOSE, i);

        if (actionsBlockEnd !== -1) {
          const actionsBlockContent = input.slice(i + BOLT_QUICK_ACTIONS_OPEN.length, actionsBlockEnd);

          // Find all <bolt-quick-action ...>label</bolt-quick-action> inside
          const quickActionRegex = /<bolt-quick-action([^>]*)>([\s\S]*?)<\/bolt-quick-action>/g;
          let match;
          const buttons = [];

          while ((match = quickActionRegex.exec(actionsBlockContent)) !== null) {
            const tagAttrs = match[1];
            const label = match[2];
            const type = this.#extractAttribute(tagAttrs, 'type');
            const message = this.#extractAttribute(tagAttrs, 'message');
            const path = this.#extractAttribute(tagAttrs, 'path');
            const href = this.#extractAttribute(tagAttrs, 'href');
            buttons.push(
              createQuickActionElement(
                { type: type || '', message: message || '', path: path || '', href: href || '' },
                label,
              ),
            );
          }
          output += createQuickActionGroup(buttons);
          i = actionsBlockEnd + BOLT_QUICK_ACTIONS_CLOSE.length;
          continue;
        }
      }

      if (state.insideArtifact) {
        const currentArtifact = state.currentArtifact;

        if (currentArtifact === undefined) {
          unreachable('Artifact not initialized');
        }

        if (state.insideAction) {
          const closeIndex = input.indexOf(ARTIFACT_ACTION_TAG_CLOSE, i);
          const artifactCloseIndex = input.indexOf(ARTIFACT_TAG_CLOSE, i);

          const currentAction = state.currentAction;

          /*
           * An action ends at its own </boltAction> — OR, when the model omits it (a recurring
           * KIE/Opus formatting slip), at the enclosing </boltArtifact>, whichever comes first.
           *
           * Without the artifact-close fallback the LAST file in an artifact is streamed forever and
           * NEVER written to disk: with no </boltAction> to find, the parser keeps appending
           * </boltArtifact> and the trailing prose to the file body and waits for a close tag that will
           * never arrive, so onActionClose (which is what runs the write) never fires. Confirmed live —
           * a landing page whose Home.css ended with a complete rule and jumped straight to
           * </boltArtifact>: Home.css never reached the sandbox, so vite served the starter CSS and the
           * page rendered unstyled. The FIRST file in the same artifact was written fine, because its
           * </boltAction> was followed by more text; only the last one is exposed.
           */
          const usesArtifactClose = artifactCloseIndex !== -1 && (closeIndex === -1 || artifactCloseIndex < closeIndex);
          const actionEndIndex = usesArtifactClose ? artifactCloseIndex : closeIndex;

          if (actionEndIndex !== -1) {
            currentAction.content += input.slice(i, actionEndIndex);

            let content = currentAction.content.trim();

            if ('type' in currentAction && currentAction.type === 'file') {
              // Remove markdown code block syntax if present and file is not markdown
              if (!currentAction.filePath.endsWith('.md')) {
                content = cleanoutMarkdownSyntax(content);
                content = cleanEscapedTags(content);
              }

              content += '\n';
            }

            currentAction.content = content;

            this._options.callbacks?.onActionClose?.({
              artifactId: currentArtifact.id,
              messageId,

              /**
               * We decrement the id because it's been incremented already
               * when `onActionOpen` was emitted to make sure the ids are
               * the same.
               */
              actionId: String(state.actionId - 1),

              action: currentAction as BoltAction,
            });

            state.insideAction = false;
            state.currentAction = { content: '' };
            state.pendingActionTail = undefined;

            /*
             * Explicit close: consume the </boltAction>. Implicit (artifact) close: leave `i` AT the
             * </boltArtifact> so the artifact-close branch fires next iteration and emits onArtifactClose.
             */
            i = usesArtifactClose ? actionEndIndex : actionEndIndex + ARTIFACT_ACTION_TAG_CLOSE.length;
          } else {
            if ('type' in currentAction && currentAction.type === 'file') {
              /*
               * The RAW, uncleaned tail, kept so `finish()` can salvage this file if the stream ends
               * without ever closing the action. It is stored rather than appended to
               * `currentAction.content` because the close path does `content += input.slice(i, end)`
               * from this same `i` — appending here would duplicate the body on a normal close.
               */
              state.pendingActionTail = input.slice(i);

              let content = input.slice(i);

              if (!currentAction.filePath.endsWith('.md')) {
                content = cleanoutMarkdownSyntax(content);
                content = cleanEscapedTags(content);
              }

              this._options.callbacks?.onActionStream?.({
                artifactId: currentArtifact.id,
                messageId,
                actionId: String(state.actionId - 1),
                action: {
                  ...(currentAction as FileAction),
                  content,
                  filePath: currentAction.filePath,
                },
              });
            }

            break;
          }
        } else {
          const actionOpenIndex = input.indexOf(ARTIFACT_ACTION_TAG_OPEN, i);
          const artifactCloseIndex = input.indexOf(ARTIFACT_TAG_CLOSE, i);

          if (actionOpenIndex !== -1 && (artifactCloseIndex === -1 || actionOpenIndex < artifactCloseIndex)) {
            const actionEndIndex = input.indexOf('>', actionOpenIndex);

            if (actionEndIndex !== -1) {
              state.insideAction = true;

              state.currentAction = this.#parseActionTag(input, actionOpenIndex, actionEndIndex);

              this._options.callbacks?.onActionOpen?.({
                artifactId: currentArtifact.id,
                messageId,
                actionId: String(state.actionId++),
                action: state.currentAction as BoltAction,
              });

              i = actionEndIndex + 1;
            } else {
              break;
            }
          } else if (artifactCloseIndex !== -1) {
            this._options.callbacks?.onArtifactClose?.({
              messageId,
              artifactId: currentArtifact.id,
              ...currentArtifact,
            });

            state.insideArtifact = false;
            state.currentArtifact = undefined;

            i = artifactCloseIndex + ARTIFACT_TAG_CLOSE.length;
          } else {
            break;
          }
        }
      } else if (input[i] === '<' && input[i + 1] !== '/') {
        let j = i;
        let potentialTag = '';

        while (j < input.length && potentialTag.length < ARTIFACT_TAG_OPEN.length) {
          potentialTag += input[j];

          if (potentialTag === ARTIFACT_TAG_OPEN) {
            const nextChar = input[j + 1];

            if (nextChar && nextChar !== '>' && nextChar !== ' ') {
              output += input.slice(i, j + 1);
              i = j + 1;
              break;
            }

            const openTagEnd = input.indexOf('>', j);

            if (openTagEnd !== -1) {
              const artifactTag = input.slice(i, openTagEnd + 1);

              const artifactTitle = this.#extractAttribute(artifactTag, 'title') as string;
              const type = this.#extractAttribute(artifactTag, 'type') as string;

              // const artifactId = this.#extractAttribute(artifactTag, 'id') as string;
              const artifactId = `${messageId}-${state.artifactCounter++}`;

              if (!artifactTitle) {
                logger.warn('Artifact title missing');
              }

              if (!artifactId) {
                logger.warn('Artifact id missing');
              }

              state.insideArtifact = true;

              const currentArtifact = {
                id: artifactId,
                title: artifactTitle,
                type,
              } satisfies BoltArtifactData;

              state.currentArtifact = currentArtifact;

              this._options.callbacks?.onArtifactOpen?.({
                messageId,
                artifactId: currentArtifact.id,
                ...currentArtifact,
              });

              const artifactFactory = this._options.artifactElement ?? createArtifactElement;

              output += artifactFactory({ messageId, artifactId });

              i = openTagEnd + 1;
            } else {
              earlyBreak = true;
            }

            break;
          } else if (!ARTIFACT_TAG_OPEN.startsWith(potentialTag)) {
            output += input.slice(i, j + 1);
            i = j + 1;
            break;
          }

          j++;
        }

        if (j === input.length && ARTIFACT_TAG_OPEN.startsWith(potentialTag)) {
          break;
        }
      } else {
        /*
         * Note: Auto-file-creation from code blocks is now handled by EnhancedMessageParser
         * to avoid duplicate processing and provide better shell command detection
         */
        output += input[i];
        i++;
      }

      if (earlyBreak) {
        break;
      }
    }

    state.position = i;

    return output;
  }

  /**
   * The stream for `messageId` has ENDED. Close anything still open.
   *
   * 🔴 **Without this, a generation that stops mid-artifact leaves the file unwritten and its row
   * spinning forever.** A file action's CLOSING run is what writes the file and marks it complete, so
   * an action that never closes is a permanent "creating…" under prose that says the build shipped —
   * and nothing throws.
   *
   * The parser is otherwise purely streaming: it closes an action at `</boltAction>`, or (a recurring
   * model formatting slip) at the enclosing `</boltArtifact>`. This is the third case, and the only
   * one it could not see — **NEITHER tag ever arrives.** Observed live 2026-07-31: the model leaked
   * tool-call protocol syntax into the TEXT channel from inside a `<boltAction>`, then left to make a
   * tool call and never came back to the artifact. The transcript ends with 1 open `<boltArtifact>`,
   * 1 open `<boltAction>`, **zero closes** — a complete, valid `StreetRacerMode.ts` that never reached
   * the disk, after 15,051 billed output tokens. `finish=tool-calls` on the server; a clean-looking
   * generation on the client.
   *
   * Bounded by construction: it emits exactly the callbacks the ordinary close path emits, using the
   * content accumulated so far. Idempotent — a second call after the state is closed does nothing —
   * because the caller is a React effect and will run again on re-render.
   *
   * ⚠️ This CANNOT be "just call reset()". Reset drops the state; the file still never gets written.
   * The whole point is to run the close side effects first.
   */
  finish(messageId: string) {
    const state = this.#messages.get(messageId);

    if (!state?.insideArtifact || !state.currentArtifact) {
      return;
    }

    const currentArtifact = state.currentArtifact;

    const currentAction = state.currentAction;

    /*
     * 🔴 ONLY a `file` action is salvaged. A truncated `shell`/`start` action is a HALF-WRITTEN
     * COMMAND, and running one is worse than leaving its row unfinished — `npm install lodash` and
     * `npm install lodash && rm -rf /` share a prefix, which is the same reasoning that makes
     * `shell-strip.ts` buffer a command until it can see the whole thing. A partial file is
     * recoverable by the user and inspectable in the editor; a partial command is not.
     */
    if (state.insideAction && 'type' in currentAction && currentAction.type === 'file') {
      /*
       * The body lives in the raw streaming tail, not in `content`: while an action is open the
       * parser re-slices from `state.position` on every pass and only accumulates at a close tag, so
       * `currentAction.content` is still empty here.
       */
      let content = (currentAction.content + (state.pendingActionTail ?? '')).trim();

      if (!currentAction.filePath.endsWith('.md')) {
        content = cleanoutMarkdownSyntax(content);
        content = cleanEscapedTags(content);
      }

      currentAction.content = `${content}\n`;

      this._options.callbacks?.onActionClose?.({
        artifactId: currentArtifact.id,
        messageId,

        // Decremented for the same reason the ordinary close path decrements it.
        actionId: String(state.actionId - 1),
        action: currentAction as BoltAction,
      });
    }

    if (state.insideAction) {
      state.insideAction = false;
      state.currentAction = { content: '' };
      state.pendingActionTail = undefined;
    }

    this._options.callbacks?.onArtifactClose?.({ messageId, artifactId: currentArtifact.id, ...currentArtifact });

    state.insideArtifact = false;
    state.currentArtifact = undefined;
  }

  reset() {
    this.#messages.clear();
  }

  #parseActionTag(input: string, actionOpenIndex: number, actionEndIndex: number) {
    const actionTag = input.slice(actionOpenIndex, actionEndIndex + 1);

    const actionType = this.#extractAttribute(actionTag, 'type') as ActionType;

    const actionAttributes = {
      type: actionType,
      content: '',
    };

    if (actionType === 'supabase') {
      const operation = this.#extractAttribute(actionTag, 'operation');

      if (!operation || !['migration', 'query'].includes(operation)) {
        logger.warn(`Invalid or missing operation for Supabase action: ${operation}`);
        throw new Error(`Invalid Supabase operation: ${operation}`);
      }

      (actionAttributes as SupabaseAction).operation = operation as 'migration' | 'query';

      if (operation === 'migration') {
        const filePath = this.#extractAttribute(actionTag, 'filePath');

        if (!filePath) {
          logger.warn('Migration requires a filePath');
          throw new Error('Migration requires a filePath');
        }

        (actionAttributes as SupabaseAction).filePath = filePath;
      }
    } else if (actionType === 'file' || actionType === 'edit') {
      const filePath = this.#extractAttribute(actionTag, 'filePath') as string;

      if (!filePath) {
        logger.debug('File path not specified');
      }

      (actionAttributes as FileAction | EditAction).filePath = filePath;
    } else if (!['shell', 'start'].includes(actionType)) {
      logger.warn(`Unknown action type '${actionType}'`);
    }

    return actionAttributes as FileAction | EditAction | ShellAction;
  }

  #extractAttribute(tag: string, attributeName: string): string | undefined {
    const match = tag.match(new RegExp(`${attributeName}="([^"]*)"`, 'i'));
    return match ? match[1] : undefined;
  }
}

const createArtifactElement: ElementFactory = (props) => {
  const elementProps = [
    'class="__boltArtifact__"',
    ...Object.entries(props).map(([key, value]) => {
      return `data-${camelToDashCase(key)}=${JSON.stringify(value)}`;
    }),
  ];

  return `<div ${elementProps.join(' ')}></div>`;
};

function camelToDashCase(input: string) {
  return input.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function createQuickActionElement(props: Record<string, string>, label: string) {
  const elementProps = [
    'class="__boltQuickAction__"',
    'data-bolt-quick-action="true"',
    ...Object.entries(props).map(([key, value]) => `data-${camelToDashCase(key)}=${JSON.stringify(value)}`),
  ];

  return `<button ${elementProps.join(' ')}>${label}</button>`;
}

function createQuickActionGroup(buttons: string[]) {
  return `<div class=\"__boltQuickAction__\" data-bolt-quick-action=\"true\">${buttons.join('')}</div>`;
}
