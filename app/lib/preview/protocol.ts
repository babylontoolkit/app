/**
 * The wire protocol between the builder and the game running in the preview iframe.
 *
 * ## Why this exists (owner, 2026-08-09)
 *
 * *"Can we basically debug or verify our game in the preview window… whatever we need to do to be able
 * to debug our game session like Claude can with chrome devtools MCP?"*
 *
 * chrome-devtools-mcp is not available to the platform and cannot be: it drives Chrome over the
 * DevTools protocol on a loopback port, and Chrome deliberately refuses those connections from web
 * pages. Playwright is out for a different reason — it launches a browser binary, and Nodepod runs
 * Node in Web Workers over a Wasm filesystem with no native process spawning.
 *
 * What IS available is better suited to the actual job. Both shipped providers can inject a script
 * into every preview document before any page content loads (`setPreviewScript`), and a script inside
 * the document can talk to the builder with `postMessage`. That gives the agent a channel INTO the
 * running game — not pixels and DOM, but the game's own JavaScript: the Babylon scene, `GameManager`,
 * the player controller, whatever the project defined.
 *
 * 🔴 **`postMessage`, deliberately, and NOT direct same-origin access to `contentWindow`.** Nodepod
 * serves previews from a same-origin service worker, so reaching straight into the iframe would work
 * there — `Preview.tsx` already reads `contentDocument` to count pending images. It would NOT work on
 * WebContainer, whose previews are cross-origin, and a debugging channel that silently exists on one
 * provider and not another is the `setPreviewScript` gap this same change is fixing, reintroduced one
 * layer up. The message channel is origin-independent, so the capability is a property of the
 * PROTOCOL rather than of whichever runtime the build happens to select.
 *
 * ## The two rules that make this safe
 *
 * 🔴 **Both ends verify the peer.** The document answers only messages whose `source` is its own
 * parent, and the builder accepts only messages whose `source` is the preview iframe's
 * `contentWindow`. Neither check is optional: without the first, any page that can get a handle to the
 * preview can evaluate code in the user's game; without the second, any framed third-party document
 * can feed the agent fabricated console output and screenshots. The failure is silent in both
 * directions.
 *
 * 🔴 **Every reply is BUDGETED before it leaves the iframe.** This channel feeds a model, so the reply
 * is billed on every remaining step of the turn (`spec/context-budget.md`). A Babylon `Scene` has
 * thousands of cross-linked properties and would serialize to megabytes; `evaluate` returning one
 * naively is a context-budget catastrophe that throws nothing and simply makes the turn cost ten times
 * what it should. `capValue` enforces depth, breadth, string length and a total character ceiling, and
 * says so in the output when it truncates — a silent truncation reads to the model as "that is the
 * whole object", which is how it concludes a mesh has no children.
 */

/** Namespacing tag. Distinct from Nodepod's own `__nodepodInspect` bridge, which may run alongside. */
export const PREVIEW_WIRE_TAG = '__btPreviewAgent';

/** Bumped only for a breaking shape change; the document and the builder must agree. */
export const PREVIEW_WIRE_VERSION = 1;

/** What the builder can ask the running game to do. */
export type PreviewMethod = 'ping' | 'evaluate' | 'console' | 'errors' | 'screenshot';

export interface PreviewRequest {
  [PREVIEW_WIRE_TAG]: 1;
  v: number;
  kind: 'request';
  id: string;
  method: PreviewMethod;
  params?: Record<string, unknown>;
}

/** A console line captured in the game document. `args` are already capped strings, never live objects. */
export interface PreviewConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  at: number;
}

/** An uncaught exception or unhandled rejection from the game. */
export interface PreviewErrorEntry {
  type: 'error' | 'rejection';
  message: string;
  stack?: string;
  url?: string;
  line?: number;
  column?: number;
  at: number;
}

export interface PreviewResponse {
  [PREVIEW_WIRE_TAG]: 1;
  v: number;
  kind: 'response';
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface PreviewEvent {
  [PREVIEW_WIRE_TAG]: 1;
  v: number;
  kind: 'event';
  event: 'ready' | 'error' | 'console';
  data?: unknown;
}

export type PreviewMessage = PreviewRequest | PreviewResponse | PreviewEvent;

/**
 * Is this a message from our injected agent, at a version we understand?
 *
 * Shape-only — the SOURCE check (is it really the preview iframe?) belongs to the caller, which is the
 * only side that holds the iframe handle. Splitting them is deliberate: a predicate that quietly did
 * both would be reused somewhere it has no iframe and would silently pass everything.
 */
export function isPreviewMessage(data: unknown): data is PreviewMessage {
  if (!data || typeof data !== 'object') {
    return false;
  }

  const message = data as Record<string, unknown>;

  return message[PREVIEW_WIRE_TAG] === 1 && message.v === PREVIEW_WIRE_VERSION;
}

/** Ceilings for anything crossing back to the builder — and therefore to the model. */
export interface PreviewValueLimits {
  depth: number;
  breadth: number;
  string: number;
  total: number;
}

export const PREVIEW_VALUE_LIMITS: PreviewValueLimits = {
  /** Object/array nesting. A Babylon node graph is effectively infinite; 4 shows shape without the graph. */
  depth: 4,

  /** Keys per object and items per array. */
  breadth: 40,

  /** One string. A shader source or a data URI would otherwise be the whole budget. */
  string: 2_000,

  /** The whole serialized reply. ~4k tokens — generous for an answer, nowhere near a scene dump. */
  total: 16_000,
} as const;

/**
 * Serialize an arbitrary value from the game into something safe to send, and to bill for.
 *
 * Runs INSIDE the preview document (it is inlined into the agent script), and is exported here so the
 * rules can be unit-tested without a browser. Keep it dependency-free and ES5-ish for that reason.
 *
 * Truncation is always ANNOUNCED — `'…(truncated)'`, `'[Depth limit]'`, `'[+N more]'`. A model shown a
 * silently-shortened array concludes the array is that length, which is worse than being told nothing.
 */
export function capValue(value: unknown, limits?: PreviewValueLimits): unknown {
  /*
   * 🔴 THE DEFAULT IS AN INLINE LITERAL, NOT `= PREVIEW_VALUE_LIMITS`.
   *
   * This function's SOURCE is stringified and re-created with `eval` inside the user's game
   * (`agent-script.ts`), where nothing from this module exists. A default parameter referencing the
   * exported constant compiles, type-checks and reads perfectly — and throws `ReferenceError` on the
   * first line of someone else's page the moment anyone calls it with one argument. The function has
   * to be closed over nothing at all.
   *
   * `capValueMatchesLimits` in the spec pins these numbers against `PREVIEW_VALUE_LIMITS`, so the two
   * copies cannot drift.
   */
  const caps: PreviewValueLimits = limits ?? { depth: 4, breadth: 40, string: 2_000, total: 16_000 };

  const seen = new WeakSet<object>();
  let budget = caps.total;

  const walk = (input: unknown, depth: number): unknown => {
    if (budget <= 0) {
      return '[Budget exhausted]';
    }

    if (input === null || input === undefined) {
      return input ?? null;
    }

    const type = typeof input;

    if (type === 'string') {
      const text = input as string;
      const clipped = text.length > caps.string ? `${text.slice(0, caps.string)}…(truncated)` : text;
      budget -= clipped.length;

      return clipped;
    }

    if (type === 'number' || type === 'boolean') {
      budget -= 8;
      return input;
    }

    if (type === 'function') {
      budget -= 16;
      return `[Function ${(input as { name?: string }).name || 'anonymous'}]`;
    }

    if (type === 'bigint' || type === 'symbol') {
      budget -= 16;
      return String(input);
    }

    if (type !== 'object') {
      return String(input);
    }

    const object = input as object;

    /* A cycle is ordinary in a scene graph (mesh.parent.children), not exotic — never throw on one. */
    if (seen.has(object)) {
      return '[Circular]';
    }

    if (depth >= caps.depth) {
      return '[Depth limit]';
    }

    seen.add(object);

    if (Array.isArray(object)) {
      const items = object.slice(0, caps.breadth).map((item) => walk(item, depth + 1));

      if (object.length > caps.breadth) {
        items.push(`[+${object.length - caps.breadth} more]`);
      }

      return items;
    }

    /*
     * An Error must keep its message and stack — they are the reason anyone is inspecting — and its
     * own enumerable keys would otherwise miss both (they are non-enumerable on Error instances).
     */
    if (object instanceof Error) {
      return { name: object.name, message: walk(object.message, depth + 1), stack: walk(object.stack, depth + 1) };
    }

    const out: Record<string, unknown> = {};
    const keys = Object.keys(object).slice(0, caps.breadth);

    for (const key of keys) {
      try {
        out[key] = walk((object as Record<string, unknown>)[key], depth + 1);
      } catch (error) {
        /* A getter that throws is common on engine objects (a disposed mesh). Report, never abort. */
        out[key] = `[Getter threw: ${(error as Error)?.message ?? 'unknown'}]`;
      }
    }

    const total = Object.keys(object).length;

    if (total > caps.breadth) {
      out['…'] = `[+${total - caps.breadth} more keys]`;
    }

    return out;
  };

  return walk(value, 0);
}
