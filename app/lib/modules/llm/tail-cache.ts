/**
 * The rolling TAIL cache breakpoint (tool-loop plan D13).
 *
 * A tool-loop turn re-sends a GROWING conversation on every step: the cached system prefix, then every
 * tool call and tool result so far. The system array's breakpoints stop at the system prompt, so
 * without a breakpoint on the tail every step re-bills the whole conversation at the full input rate —
 * a 40-step segment pays for step 1's messages forty times.
 *
 * ai@4 has no `prepareStep`, so the messages cannot be touched between steps. The body can: this is a
 * FETCH-level wrapper that puts `cache_control: {type:'ephemeral'}` (the 5-minute tier) on the last
 * eligible content block of the last message. Each step then reads the previous step's prefix from
 * cache and writes only what is new.
 *
 * ## Never regress
 *
 *  - **Four breakpoints is the API's hard maximum** (a fifth is HTTP 400 — every generation dead before
 *    a token). The system array uses at most three (`cache-breakpoints.spec.ts`); the tail takes the one
 *    spare and only when `countCacheControls(body) < 4`.
 *  - **Only when the tool loop is on.** `withTailCache(base, false|undefined)` returns `base` itself, so
 *    the legacy path is byte-identical.
 *  - **Never break a generation.** A non-string body or a body that is not JSON passes through with the
 *    IDENTICAL `init` (the `thinkingFetch` rule).
 *  - The 5-minute tier AFTER the system's 1-hour breakpoints is the order the API requires (a longer
 *    TTL may not follow a shorter one).
 *  - Thinking blocks cannot carry `cache_control`, and neither can an EMPTY text block (API 400).
 */

type Block = Record<string, unknown>;

/** Every `cache_control` marker in `system[]`, `tools[]` and each `messages[].content[]` block. */
export function countCacheControls(body: unknown): number {
  if (!body || typeof body !== 'object') {
    return 0;
  }

  const b = body as Record<string, unknown>;
  let count = 0;

  const countIn = (list: unknown) => {
    if (!Array.isArray(list)) {
      return;
    }

    for (const entry of list) {
      if (entry && typeof entry === 'object' && (entry as Block).cache_control) {
        count++;
      }
    }
  };

  countIn(b.system);
  countIn(b.tools);

  if (Array.isArray(b.messages)) {
    for (const message of b.messages) {
      countIn((message as Block | null)?.content);
    }
  }

  return count;
}

const MAX_BREAKPOINTS = 4;
const SKIPPED_TYPES = new Set(['thinking', 'redacted_thinking']);

function eligible(block: unknown): block is Block {
  if (!block || typeof block !== 'object') {
    return false;
  }

  const b = block as Block;

  if (SKIPPED_TYPES.has(b.type as string)) {
    return false;
  }

  /* The API refuses cache_control on an empty text block. */
  if (b.type === 'text' && (typeof b.text !== 'string' || b.text.length === 0)) {
    return false;
  }

  return true;
}

/** Pure: returns a NEW body with the tail breakpoint, or `body` itself when none applies. */
export function addTailCacheBreakpoint(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.messages) || body.messages.length === 0 || countCacheControls(body) >= MAX_BREAKPOINTS) {
    return body;
  }

  const messages = body.messages as Block[];
  const last = messages[messages.length - 1];

  if (!last || typeof last !== 'object') {
    return body;
  }

  const content: unknown[] =
    typeof last.content === 'string'
      ? [{ type: 'text', text: last.content }]
      : Array.isArray(last.content)
        ? last.content
        : [];

  let target = -1;

  for (let i = content.length - 1; i >= 0; i--) {
    if (eligible(content[i])) {
      target = i;
      break;
    }
  }

  if (target === -1) {
    return body;
  }

  const nextContent = content.map((block, i) =>
    i === target ? { ...(block as Block), cache_control: { type: 'ephemeral' } } : block,
  );

  return {
    ...body,
    messages: [...messages.slice(0, -1), { ...last, content: nextContent }],
  };
}

export function tailCacheFetch(baseFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    if (!init?.body || typeof init.body !== 'string') {
      return baseFetch(input, init);
    }

    let body: unknown;

    try {
      body = JSON.parse(init.body);
    } catch {
      return baseFetch(input, init);
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return baseFetch(input, init);
    }

    const next = addTailCacheBreakpoint(body as Record<string, unknown>);

    if (next === body) {
      return baseFetch(input, init);
    }

    return baseFetch(input, { ...init, body: JSON.stringify(next) });
  };
}

/** Identity when the tool loop is off — the legacy path gets the very same function object. */
export function withTailCache(baseFetch: typeof fetch, toolLoop: boolean | undefined): typeof fetch {
  return toolLoop ? tailCacheFetch(baseFetch) : baseFetch;
}
