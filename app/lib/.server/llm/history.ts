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
import { dataUrlByteLength } from '~/lib/.server/agent/attachments';
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
 * A turn-based complement to `MAX_HISTORY_CHARS`, env-tunable via `HISTORY_WINDOW_TURNS`.
 *
 * The char cap bounds history by SIZE; this bounds it by COUNT — keep the first user brief plus the N
 * most-recent messages verbatim, dropping the whole turns in between. The two compose: whichever bites
 * first wins, and the char cap still trims within the retained window if those messages are large.
 *
 * A "turn" here is one entry in the `Message[]` array (user and assistant messages alternate). The
 * default is generous — a request essentially never needs more than this many recent messages for
 * continuity — so on a normal session neither backstop fires. Set `HISTORY_WINDOW_TURNS=0` to disable
 * the turn cap and fall back to the char cap alone.
 *
 * Why no summary model call for the dropped turns: after compaction strips the 83–87% that is file
 * bodies, what remains is prose, and a `createSummary`-style round trip would bill its own output tokens
 * on every long turn — routinely MORE than the handful of retained prose messages cost. A straight
 * window is the cheapest correct option (`spec/context-budget.md` §5).
 */
export const HISTORY_WINDOW_TURNS = 30;

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
 * Compact the same bodies out of `text` PARTS, not just `content`.
 *
 * 🔴 Both carry the message: `Chat.client.tsx` sets `content` and `parts` from one string, and the AI
 * SDK's `convertToCoreMessages` prefers `parts` when they exist. Compacting only `content` would look
 * correct in every test that reads `content` and change nothing at all on the wire — the same trap that
 * made the transport envelope reach the model for months (`chat/message-envelope.ts`).
 *
 * File parts (image attachments) are returned untouched, and a message whose parts hold no file bodies
 * is returned by IDENTITY, so this is free on the overwhelming majority of turns.
 */
function compactTextParts(message: Message): Message {
  if (!Array.isArray(message.parts)) {
    return message;
  }

  const parts = message.parts.map((part) => {
    if (part.type !== 'text' || typeof part.text !== 'string') {
      return part;
    }

    const text = compactContent(part.text);

    return text === part.text ? part : { ...part, text };
  });

  return parts.some((part, i) => part !== message.parts![i]) ? { ...message, parts } : message;
}

/**
 * Strip thinking from a PRIOR assistant turn — required for correctness, not just for cost.
 *
 * ## The bug this fixes: every edit turn returned a 400, on every project
 *
 *   Custom error: messages.2.content.0.thinking.signature: Field required
 *
 * Anthropic requires every `thinking` block sent back in history to carry the opaque `signature` it
 * issued with it. Our proxy streams reasoning to the client on its own channel as TEXT — `AgentChunk`
 * is `{type:'text'|'reasoning'}` and has no signature field at all — so the client stores the model's
 * reasoning with no signature, posts it back on the next turn, and the API rejects the request before
 * generating a single token. 0 in, 0 out, ~0.3s, `finish=error`. Creations worked (no history);
 * everything after turn one did not.
 *
 * ## Why STRIP rather than forward the signature
 *
 * Anthropic only requires thinking blocks to survive WITHIN a turn (across tool results) — which
 * `streamText` handles internally, since our tool loop lives inside one call. Previous turns' thinking
 * may simply be omitted. Stripping is therefore the smaller change AND the cheaper one: the history is
 * UNCACHED and re-sent in full every turn, and a real creation emitted 14,874 chars of reasoning
 * summary (§"MEASURED"). Forwarding the signature would restore correctness while making us pay,
 * forever, to re-send reasoning the model does not need.
 *
 * The same argument as file bodies, one field over: if the model does not need it next turn, it must
 * not be in the history.
 *
 * ⚠️ Do NOT "fix" this by adding a signature to `AgentChunk` and threading it to the client. That
 * re-introduces the per-turn cost this avoids, and the 400 comes back the moment any path drops it.
 */
function stripReasoning(message: Message): Message {
  const parts = message.parts?.filter((part) => part.type !== 'reasoning');
  const hadReasoning = message.reasoning !== undefined || (parts && parts.length !== message.parts?.length);

  if (!hadReasoning) {
    return message;
  }

  const next = { ...message, parts } as Message & { reasoning?: string };
  delete next.reasoning;

  return next;
}

/**
 * Compact prior turns.
 *
 * Every assistant message is compacted, including the most recent one: the file-context block is a
 * strictly better source for file contents than any assistant message, because it reflects the file as
 * it is NOW rather than as it was written. A repair turn in particular needs the *current* broken file,
 * not the text the model believed it was emitting.
 *
 * ## User messages: the WORDS are never touched — but a file body is not a word
 *
 * This function used to skip user messages entirely, on the rule that "what the user said is the one
 * thing in the history that exists nowhere else". That rule is right and still holds. What it missed is
 * that not everything in a user message was said by the user.
 *
 * When the user edits files in the editor, `Chat.client.tsx` prepends a MACHINE-GENERATED
 * `<boltArtifact>` of every modified file — full bodies — to their next message
 * (`filesToArtifacts(getModifiedFiles())`). Those bodies are the same double representation §4.2.8
 * diagnosed twice already: the current, fresher contents of exactly those files are sent every turn in
 * `# Current Project Files`. Because they rode in a USER message, compaction skipped them and they were
 * re-sent, uncached, at full rate, on every subsequent turn, forever — the one place in the history
 * that could still grow without bound.
 *
 * So the SAME body strip runs over user messages. It is safe by construction: `compactContent` only
 * rewrites the inside of `<boltAction type="file"|"edit">` tags — our own protocol syntax, which a
 * human does not type — and returns every other byte untouched. The tags survive, so the model still
 * knows precisely which files the user changed; it reads their contents from the file context, where
 * they are correct.
 */
export function compactHistory(messages: Message[], options: { maxTurns?: number } = {}): Message[] {
  const compacted = messages.map((message) => {
    if (message.role !== 'assistant' && message.role !== 'user') {
      return message;
    }

    // Thinking first: it must go whether or not the content is a plain string (see `stripReasoning`).
    const stripped = message.role === 'assistant' ? stripReasoning(message) : message;
    const withParts = compactTextParts(stripped);

    if (typeof withParts.content !== 'string') {
      return withParts;
    }

    const content = compactContent(withParts.content);

    return content === withParts.content ? withParts : { ...withParts, content };
  });

  return windowHistory(compacted, options.maxTurns ?? HISTORY_WINDOW_TURNS);
}

/**
 * The backstop: drop the OLDEST turns until the history fits, by COUNT then by SIZE.
 *
 * **The first user message is never dropped.** It is the original brief — the request the whole project
 * exists to satisfy — and losing it makes the agent forget what it is building. Everything else is
 * fair game, oldest first, because recent turns are what the current request refers to.
 *
 * Two bounds, applied in order:
 *   1. **Turn cap** (`maxTurns`, from `HISTORY_WINDOW_TURNS`): keep the first brief plus the N
 *      most-recent messages, dropping the whole turns in between. A whole message is dropped or kept as
 *      a unit, so an assistant turn is never severed from the request it answered. (Our persisted
 *      history is plain user/assistant text — the tool loop lives inside a single `streamText` call —
 *      so there are no raw tool_use/tool_result blocks to orphan.) `maxTurns <= 0` disables this bound.
 *   2. **Char cap** (`MAX_HISTORY_CHARS`): trim the retained window further if those messages are large.
 */
function windowHistory(messages: Message[], maxTurns: number): Message[] {
  const size = (list: Message[]) =>
    list.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);

  let windowed = messages;

  /*
   * 1. Turn cap: first brief + the most-recent `maxTurns` messages. Guard `> maxTurns + 1` so the first
   * message is genuinely OUTSIDE the recent window before we prepend it (never duplicate it).
   */
  if (maxTurns > 0 && messages.length > maxTurns + 1) {
    const recent = messages.slice(-maxTurns);
    windowed = [messages[0], ...recent];
    logger.info(`History exceeded ${maxTurns} turns — kept the brief + the ${maxTurns} most recent message(s).`);
  }

  // 2. Char cap: nothing more to do if the (possibly turn-capped) window already fits.
  if (size(windowed) <= MAX_HISTORY_CHARS || windowed.length <= 3) {
    return windowed;
  }

  const first = windowed[0];
  const rest = windowed.slice(1);
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

/**
 * An UPPER bound on what one image attachment costs, in tokens.
 *
 * Anthropic downscales any image to a long edge of ~1568px before tokenizing (~(w×h)/750), so no
 * single image can exceed roughly this. We deliberately use the bound rather than estimating from
 * byte size: base64 length is a terrible proxy for vision tokens (a 5MB photo and a 5MB screenshot of
 * flat colour cost wildly different amounts to store and nearly the same to look at), and for a SPEND
 * indicator the safe direction to be wrong is over-reporting. A 200×200 icon really costs ~54 tokens
 * and will be counted as 1,600 — the meter nags slightly early on tiny images, which is the failure
 * we can live with. Under-reporting is the one this whole fix exists to remove.
 */
export const IMAGE_TOKENS_UPPER_BOUND = 1_600;

/** The prose rule of thumb used throughout §4.2.8 — for converting text attachments to tokens. */
const CHARS_PER_TOKEN = 4;

export interface HistorySize {
  /* All-numeric by design: this object is streamed verbatim as a JSON annotation (`api.agent.ts`). */
  [field: string]: number;

  messages: number;
  chars: number;

  /** Attachments still riding in the re-sent history (images and text files). */
  attachments: number;

  /**
   * Estimated tokens those attachments cost — EVERY TURN, uncached, like the rest of the history.
   * Separate from `chars` on purpose: `chars` must keep meaning "characters of text", or the field
   * becomes a number that is honest only if you know how it was cooked.
   */
  attachmentTokens: number;
}

/**
 * Everything on a message that can carry attachment bytes. `experimental_attachments` is what our
 * client sends today; `parts` of type `file` is the shape the SDK is moving toward. Counting both
 * means the meter does not quietly go blind the day the transport changes underneath it.
 */
type AttachmentBearing = Message & {
  experimental_attachments?: Array<{ contentType?: string; url?: string }>;
};

function measureAttachments(message: Message): { count: number; tokens: number } {
  const listed = (message as AttachmentBearing).experimental_attachments ?? [];
  const fileParts = (message.parts ?? [])
    .filter((part) => part.type === 'file')
    .map((part) => {
      const file = part as { mimeType?: string; data?: string };

      return { contentType: file.mimeType, url: file.data };
    });

  const all = [...listed, ...fileParts];

  const tokens = all.reduce((sum, attachment) => {
    if (attachment.contentType?.startsWith('image/')) {
      return sum + IMAGE_TOKENS_UPPER_BOUND;
    }

    // A text attachment IS text on the wire: its decoded bytes are its characters.
    return sum + Math.ceil(dataUrlByteLength(attachment.url) / CHARS_PER_TOKEN);
  }, 0);

  return { count: all.length, tokens };
}

/**
 * What actually went on the wire this turn — the numbers behind the client's `/context` report
 * (SPEC §4.5.6). Measured AFTER compaction+windowing, so it is the re-sent history exactly, not the
 * stored conversation. The client must never estimate this from its own messages: it would be
 * measuring the un-compacted copy, which is precisely the number that does not matter.
 *
 * ## Why attachments are counted here and not left to `promptTokens`
 *
 * An image attached five turns ago is still in the history and is still sent, uncached, at full rate,
 * on every turn after it — exactly the growth this whole module exists to bound. But it carries ZERO
 * characters, so a chars-only measure reported it as free and the health dot stayed green while the
 * user paid for it every turn. The panel's `promptTokens` did show the spend, which is what made this
 * hard to see: the report was right and the traffic light was wrong, and people read the light.
 */
export function historySize(messages: Message[]): HistorySize {
  return messages.reduce<HistorySize>(
    (size, message) => {
      const attachments = measureAttachments(message);

      return {
        messages: size.messages + 1,
        chars: size.chars + (typeof message.content === 'string' ? message.content.length : 0),
        attachments: size.attachments + attachments.count,
        attachmentTokens: size.attachmentTokens + attachments.tokens,
      };
    },
    { messages: 0, chars: 0, attachments: 0, attachmentTokens: 0 },
  );
}

/** Characters removed. Used to log what compaction actually bought on a given turn. */
export function historySavings(before: Message[], after: Message[]): number {
  const size = (list: Message[]) =>
    list.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);

  return size(before) - size(after);
}
