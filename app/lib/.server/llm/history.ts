/**
 * The conversation history is a money path too (SPEC §4.2.8, `spec/context-budget.md`).
 *
 * ## Why this exists
 *
 * The history is **uncached and re-sent in full on every turn**. All four Anthropic cache breakpoints
 * sit on the *system* blocks, and the messages come after them, so nothing in the conversation is ever
 * served from cache — every turn pays full input rate for every byte of every previous turn, forever,
 * and the bill grows monotonically with the length of the session.
 *
 * Measured on real persisted conversations from this project: **83–87% of the history is file bodies**
 * inside `<boltAction type="file">` blocks in assistant turns. On a three-message conversation that is
 * already ~15,000 characters of the ~18,000 total. It only grows.
 *
 * And every one of those bytes is **redundant**, in the most literal sense: the current, complete, and
 * *more accurate* contents of every one of those files is sent fresh each turn in the
 * `# Current Project Files` block. The body in the history is a snapshot of what the model wrote five
 * turns ago — which may since have been edited, restored, or deleted. We are paying, repeatedly, for a
 * stale second copy of something we also send correctly.
 *
 * This is exactly the **double representation** that §4.2.8 diagnosed for the creation artifact (the
 * starter was inlined into the artifact AND sent as the file map — 997,775 uncached tokens for one
 * project). The same disease, displaced into the conversation.
 *
 * ## What we do about it
 *
 * Strip the BODIES out of file actions in prior assistant turns; keep the tags. The model still sees
 * exactly which files it created and edited, in order — that is the part of the history that carries
 * meaning — and reads their real contents from the file-context block, where they are correct.
 *
 * ## Why not just cache the history instead?
 *
 * Because it would cost more, not less. A cache breakpoint caches the prefix **up to itself**, so
 * caching the history requires everything before it to be byte-stable. It is not: the routed doc blocks,
 * the invoked skill, and the file context all vary per turn and all sit in `system`, *before* the
 * messages. A breakpoint on the history would be invalidated on essentially every turn, and we would pay
 * a **2× cache WRITE** each time instead of 1× uncached. Caching the history properly means moving the
 * volatile blocks after it — a real restructure, to be measured against the live API, not guessed at.
 * Compaction is orthogonal and composes with that change if it ever lands.
 */
import type { Message } from 'ai';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('history');

/**
 * A hard ceiling on the compacted history, in characters (~4 chars/token, so ~15k tokens).
 *
 * Compaction removes the growth that scales with FILE size. This bounds the growth that scales with
 * CONVERSATION length — a fifty-turn session of pure prose would still creep upward without it. Reached
 * rarely; it is a backstop, not the main lever.
 */
export const MAX_HISTORY_CHARS = 60_000;

/**
 * The body of a file/edit action in an assistant turn. Non-greedy, so consecutive actions do not merge.
 * Deliberately matches `type="file"` and `type="edit"` only — never `shell`, whose one-line command IS
 * the information.
 */
const FILE_ACTION = /(<boltAction[^>]*type="(?:file|edit)"[^>]*>)([\s\S]*?)(<\/boltAction>)/g;

/** What the model reads instead of the body. It must be told WHERE the real content is. */
const OMITTED = '\n[body omitted — this file\'s CURRENT contents are in the "Current Project Files" section]\n';

function compactContent(content: string): string {
  return content.replace(FILE_ACTION, (_match, open: string, body: string, close: string) =>
    body.trim().length > OMITTED.length ? `${open}${OMITTED}${close}` : `${open}${body}${close}`,
  );
}

/**
 * Compact prior assistant turns.
 *
 * Every assistant message is compacted, including the most recent one: the file-context block is a
 * strictly better source for file contents than any assistant message, because it reflects the file as
 * it is NOW rather than as it was written. A repair turn in particular needs the *current* broken file,
 * not the text the model believed it was emitting.
 *
 * User messages are never touched. What the user said is the one thing in the history that exists
 * nowhere else.
 */
export function compactHistory(messages: Message[]): Message[] {
  const compacted = messages.map((message) => {
    if (message.role !== 'assistant' || typeof message.content !== 'string') {
      return message;
    }

    const content = compactContent(message.content);

    return content === message.content ? message : { ...message, content };
  });

  return windowHistory(compacted);
}

/**
 * The backstop: drop the OLDEST turns until the history fits.
 *
 * **The first user message is never dropped.** It is the original brief — the request the whole project
 * exists to satisfy — and losing it makes the agent forget what it is building. Everything else is
 * fair game, oldest first, because recent turns are what the current request refers to.
 */
function windowHistory(messages: Message[]): Message[] {
  const size = (list: Message[]) =>
    list.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);

  if (size(messages) <= MAX_HISTORY_CHARS || messages.length <= 3) {
    return messages;
  }

  const first = messages[0];
  const rest = messages.slice(1);
  let dropped = 0;

  // Keep at least the two most recent messages — the turn we are answering needs its own context.
  while (rest.length > 2 && size([first, ...rest]) > MAX_HISTORY_CHARS) {
    rest.shift();
    dropped++;
  }

  if (dropped > 0) {
    logger.info(`History exceeded ${MAX_HISTORY_CHARS} chars — dropped the ${dropped} oldest message(s).`);
  }

  return [first, ...rest];
}

/** Characters removed. Used to log what compaction actually bought on a given turn. */
export function historySavings(before: Message[], after: Message[]): number {
  const size = (list: Message[]) =>
    list.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);

  return size(before) - size(after);
}
