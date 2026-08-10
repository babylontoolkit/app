/**
 * The script injected into every preview document — the game-side half of the dev-tools channel.
 *
 * Read `protocol.ts` first; it carries the design and the two safety rules. This module only builds
 * the source text, because of one constraint that shapes everything here:
 *
 * 🔴 **This code does not run in our bundle. It runs inside the user's game**, injected by the
 * provider before any page content loads, as a plain string. So it cannot import anything, cannot use
 * our types at runtime, and must not assume any build step has touched it. It is assembled from
 * `String(fn)` rather than written as a template literal so it stays real, type-checked, editable
 * TypeScript that a reader can reason about — the alternative is a 200-line quoted blob, which is how
 * an injected script rots into something nobody dares change.
 *
 * ⚠️ **Everything the injected functions reference must be passed in or inlined.** They are serialized
 * by `toString()`, so a closure variable from this module is `undefined` at runtime and the failure is
 * a silent no-op inside someone else's page. The two values that cross that boundary — the wire tag
 * and the value limits — are stringified into the preamble on purpose, and there is a test that the
 * built source contains no bare identifier from this module's scope.
 *
 * ## What it provides
 *
 * - **Errors.** `error` and `unhandledrejection`, pushed to the builder as they happen AND kept in a
 *   ring buffer, because a crash on frame one happens long before anyone asks about it.
 * - **Console.** Same shape. `console.*` is wrapped, never replaced — the game's own output must still
 *   reach the real devtools, or we have made debugging worse by adding a debugger.
 * - **evaluate.** The one that matters, and the reason this beats a screenshot: the agent can ask the
 *   game a question in its own terms — `GameManager.GetScene().meshes.length`, `player.position.y` —
 *   and get a real answer rather than inferring one from pixels.
 * - **screenshot.** Best-effort, and honest about it (see `takeScreenshot`).
 */
import { PREVIEW_VALUE_LIMITS, PREVIEW_WIRE_TAG, PREVIEW_WIRE_VERSION, capValue } from './protocol';

/** How many console lines and errors the document keeps. Bounded — this sits in the user's page forever. */
export const PREVIEW_RING_SIZE = 200;

/**
 * The agent body. Written as a function so it type-checks and reads normally; serialized with
 * `toString()` and invoked with the constants it needs.
 *
 * `any` is used liberally and deliberately: this executes in a document whose globals we do not
 * control and whose objects have no types here.
 */

function previewAgentBody(tag: string, version: number, limits: any, ring: number, capValueSource: string) {
  /* Rebuilt from source — see the file header on why a closure reference would be `undefined` here. */
  // eslint-disable-next-line no-eval
  const cap = (0, eval)(`(${capValueSource})`) as (value: unknown, limits: unknown) => unknown;

  const errors: any[] = [];
  const logs: any[] = [];

  const push = (list: any[], item: any) => {
    list.push(item);

    if (list.length > ring) {
      list.shift();
    }
  };

  const send = (kind: string, payload: any) => {
    try {
      const message: any = { v: version, kind, ...payload };
      message[tag] = 1;
      parent.postMessage(message, '*');
    } catch {
      /* A preview that cannot reach its parent must not break the game it is hosting. */
    }
  };

  /* ---- errors ---------------------------------------------------------------------------- */

  addEventListener('error', (event: any) => {
    const entry = {
      type: 'error',
      message: String(event.message || 'Unknown error'),
      stack: event.error && event.error.stack ? String(event.error.stack) : undefined,
      url: event.filename ? String(event.filename) : undefined,
      line: event.lineno,
      column: event.colno,
      at: Date.now(),
    };
    push(errors, entry);
    send('event', { event: 'error', data: entry });
  });

  addEventListener('unhandledrejection', (event: any) => {
    const reason = event.reason;
    const entry = {
      type: 'rejection',
      message: String((reason && reason.message) || reason || 'Unknown rejection'),
      stack: reason && reason.stack ? String(reason.stack) : undefined,
      at: Date.now(),
    };
    push(errors, entry);
    send('event', { event: 'error', data: entry });
  });

  /* ---- console --------------------------------------------------------------------------- */

  const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];

  for (const level of LEVELS) {
    const original = (console as any)[level];

    if (typeof original !== 'function') {
      continue;
    }

    (console as any)[level] = function (...args: any[]) {
      try {
        const text = args
          .map((arg) => {
            if (typeof arg === 'string') {
              return arg;
            }

            try {
              return JSON.stringify(cap(arg, limits));
            } catch {
              return String(arg);
            }
          })
          .join(' ');

        const entry = {
          level,
          text: text.length > limits.string ? text.slice(0, limits.string) + '…' : text,
          at: Date.now(),
        };
        push(logs, entry);
        send('event', { event: 'console', data: entry });
      } catch {
        /* Never let instrumentation break a log call. */
      }

      /*
       * 🔴 WRAP, NEVER REPLACE. The game's own output has to keep reaching the browser console, or
       * adding a debugger has made the page harder to debug by hand.
       */
      return original.apply(console, args);
    };
  }

  /* ---- screenshot ------------------------------------------------------------------------ */

  const gameCanvas = () => {
    const canvases: any[] = Array.prototype.slice.call(document.querySelectorAll('canvas'));

    if (canvases.length === 0) {
      return null;
    }

    /* The biggest canvas is the game; a Babylon project can also host tiny UI/thumbnail canvases. */
    let best = canvases[0];

    for (const candidate of canvases) {
      if (candidate.width * candidate.height > best.width * best.height) {
        best = candidate;
      }
    }

    return best;
  };

  /** An encoded frame, with the dimensions of the IMAGE (not of the source canvas) and its blankness. */
  type EncodedFrame = { dataUrl: string; width: number; height: number; blank: boolean | null };

  /**
   * 🔴 IS THIS FRAME FLAT? — the honest blankness test, and the one thing a file SIZE cannot answer.
   *
   * Found live 2026-08-09: a crashed scene stopped rendering, the canvas read back solid black, and the
   * 1024x982 JPEG of it was 6.7KB — comfortably past the `length < 2000` size heuristic that shipped, so
   * a frame containing nothing at all was handed to the model labelled `blank: false`. The flag exists
   * precisely to stop a blank frame being read as evidence, and the size proxy inverted it.
   *
   * A rendered 3D frame is never uniform; a cleared, transparent, or crashed one always is. So sample a
   * grid and ask whether every sample is the same colour. Grid rather than every pixel because this runs
   * inside the render task and must not cost a frame.
   *
   * Returns `null` when it cannot tell (a tainted or unreadable canvas) — never `false`, because
   * "I could not check" and "I checked and it has content" must not collapse into the same answer.
   */
  const isFlat = (context: any, width: number, height: number): boolean | null => {
    try {
      const STEPS = 24;
      const stepX = Math.max(1, Math.floor(width / STEPS));
      const stepY = Math.max(1, Math.floor(height / STEPS));

      let first: number[] | null = null;

      for (let y = 0; y < height; y += stepY) {
        for (let x = 0; x < width; x += stepX) {
          const [r, g, b, a] = context.getImageData(x, y, 1, 1).data as unknown as number[];

          if (!first) {
            first = [r, g, b, a];
            continue;
          }

          /* A tolerance of 2 absorbs JPEG-adjacent noise without hiding real content. */
          if (
            Math.abs(r - first[0]) > 2 ||
            Math.abs(g - first[1]) > 2 ||
            Math.abs(b - first[2]) > 2 ||
            Math.abs(a - first[3]) > 2
          ) {
            return false;
          }
        }
      }

      /* Every sample identical: a solid fill, a cleared buffer, or a transparent read-back. */
      return true;
    } catch {
      return null;
    }
  };

  /**
   * 🔴 DOWNSCALED AND JPEG-ENCODED, BECAUSE THIS IMAGE IS BILLED.
   *
   * The capture goes to a MODEL as a vision part, so its size is a token cost on every remaining step
   * of the turn — the same reason attachments are capped server-side (`attachments.ts`). A raw 2752x1536
   * PNG off a Babylon canvas is multiple megabytes of base64; downscaled JPEG is tens of kilobytes and
   * is just as good at answering the only question anyone asks a game screenshot ("does this render, and
   * does it look right?").
   *
   * `MAX_EDGE` is a little under the point where the vision encoder downsamples anyway, so paying for
   * more pixels buys nothing at all.
   */
  const encodeCanvas = (canvas: any): EncodedFrame | null => {
    const MAX_EDGE = 1024;
    const longest = Math.max(canvas.width, canvas.height);

    if (!longest) {
      return null;
    }

    const scale = longest > MAX_EDGE ? MAX_EDGE / longest : 1;

    /*
     * 🔴 ALWAYS THROUGH A 2D SCRATCH CANVAS, EVEN AT SCALE 1 — because the scratch is the only place
     * the pixels can be READ. A WebGL/WebGPU canvas has no `getImageData`, so without this copy the
     * only available blankness signal is the encoded file's SIZE, which is what shipped and which is
     * wrong in the one direction that matters (see `isFlat`).
     *
     * `drawImage` from a WebGL canvas reads its drawing buffer, so this must happen inside the same
     * render task as everything else here — which is why it is called from the observable rather than
     * afterwards.
     */
    const scratch: any = document.createElement('canvas');
    scratch.width = Math.max(1, Math.round(canvas.width * scale));
    scratch.height = Math.max(1, Math.round(canvas.height * scale));

    const context = scratch.getContext('2d', { willReadFrequently: true });

    if (!context) {
      /* No 2D context at all: still return the frame, but never CLAIM it is non-blank. */
      return { dataUrl: canvas.toDataURL('image/jpeg', 0.82), width: canvas.width, height: canvas.height, blank: null };
    }

    context.drawImage(canvas, 0, 0, scratch.width, scratch.height);

    return {
      dataUrl: scratch.toDataURL('image/jpeg', 0.82),
      width: scratch.width,
      height: scratch.height,
      blank: isFlat(context, scratch.width, scratch.height),
    };
  };

  /**
   * 🔴 CAPTURE INSIDE THE RENDER TASK, NOT AFTER IT.
   *
   * A WebGL canvas created without `preserveDrawingBuffer` (Babylon's default, and the starter's until
   * 2026-08-09) reads back FULLY TRANSPARENT once the browser has composited the frame — `toDataURL`
   * does not fail, it returns a valid blank PNG. Handing that to a model is worse than handing it
   * nothing: it looks like evidence, and the only honest reading of a blank frame is "this game renders
   * nothing", i.e. a bug report about a game that is fine.
   *
   * The drawing buffer is still intact for the remainder of the JS task that drew it, so the fix is to
   * read inside that task. `onAfterRenderObservable` fires synchronously at the end of `scene.render()`,
   * so a capture there sees real pixels **on WebGL and WebGPU alike, whatever the engine options were** —
   * which is why this is preferred over the template flag rather than replaced by it.
   *
   * `addOnce`, and we never call `scene.render()` ourselves: the game's own loop is already rendering,
   * and forcing an extra frame would advance animations and physics by a step that the game did not ask
   * for — a debugger must not perturb what it observes.
   */
  const captureDuringRender = (scene: any, canvas: any) =>
    new Promise<EncodedFrame | null>((resolve) => {
      let settled = false;

      const done = (value: EncodedFrame | null) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };

      try {
        scene.onAfterRenderObservable.addOnce(() => {
          try {
            done(encodeCanvas(canvas));
          } catch {
            done(null);
          }
        });
      } catch {
        done(null);
        return;
      }

      /* A paused or disposed scene never renders again; do not hang the tool waiting for a frame. */
      setTimeout(() => done(null), 2_000);
    });

  /** The running scene, via Vite's module graph — the project is ESM, so nothing is on `window`. */
  const findScene = async () => {
    try {
      /*
       * Built as a variable so TypeScript does not try to resolve it (this path exists in the USER's
       * project, not in ours) and so our bundler leaves it alone — the specifier is resolved by the
       * preview's own Vite dev server at runtime.
       */
      const specifier = '/src/babylon/globals';

      // eslint-disable-next-line no-eval
      const globals: any = await (0, eval)(`import('${specifier}')`);
      const manager = globals && (globals.default || globals.GameManager);

      return manager && typeof manager.GetScene === 'function' ? manager.GetScene() : null;
    } catch {
      return null;
    }
  };

  const takeScreenshot = async () => {
    const canvas = gameCanvas();

    if (!canvas) {
      throw new Error('No canvas in the document — the game may not have started.');
    }

    const scene = await findScene();
    let frame: EncodedFrame | null = scene ? await captureDuringRender(scene, canvas) : null;
    const capturedDuringRender = frame !== null;

    if (!frame) {
      /* No scene, or it is not rendering. A direct read still works when the buffer is preserved. */
      frame = encodeCanvas(canvas);
    }

    /*
     * Split into `base64` + `mimeType` rather than shipped as a data URL, because the consumer is the
     * AI SDK's image content part, which wants the payload WITHOUT the `data:` prefix. Keeping the
     * split here means the server never has to parse a URL to find the bytes — and a parse it gets
     * wrong yields a broken image the model reports as "the game is blank".
     */
    const dataUrl = frame ? frame.dataUrl : null;
    const comma = dataUrl ? dataUrl.indexOf(',') : -1;

    /*
     * 🔴 The dimensions are the IMAGE's, not the canvas's. The frame is downscaled to a 1024 long edge,
     * so reporting `canvas.width` told the model a 1024x982 picture was 2046x1962 — measured live, and
     * wrong in a way it has no way to check.
     */
    return {
      base64: comma >= 0 ? dataUrl!.slice(comma + 1) : null,
      mimeType: 'image/jpeg',
      width: frame ? frame.width : canvas.width,
      height: frame ? frame.height : canvas.height,
      sourceWidth: canvas.width,
      sourceHeight: canvas.height,
      capturedDuringRender,
      blank: frame ? frame.blank : true,
      note: !frame
        ? 'The canvas could not be read back at all. This does NOT mean the game renders nothing — ' +
          'check what is on screen with evaluate() against the scene.'
        : frame.blank === true
          ? 'Every sampled pixel of this frame is the same colour, so the frame is blank. That does NOT ' +
            'by itself mean the game is broken: the scene may be paused, disposed, mid-load, or it may ' +
            'have thrown and stopped its render loop. Call get_game_errors and inspect the scene with ' +
            'evaluate_in_game before concluding anything about what the game draws.'
          : frame.blank === null
            ? 'The frame could not be checked for blankness (the canvas was not readable), so treat the ' +
              'image as unverified rather than as evidence either way.'
            : undefined,
    };
  };

  /* ---- request handling ------------------------------------------------------------------- */

  const execute = (method: string, params: any): any => {
    if (method === 'ping') {
      return { url: location.href, title: document.title, readyState: document.readyState };
    }

    if (method === 'evaluate') {
      const expression = String((params && params.expression) || '');

      if (!expression.trim()) {
        throw new Error('evaluate needs an "expression".');
      }

      /*
       * 🔴 Wrapped in an ASYNC IIFE, and that is the difference between a usable tool and a toy.
       *
       * The starter is ESM: `GameManager` is a module default export, NOT a global, so there is no
       * `window.GameManager` to reach and a bare expression can see almost nothing of the game. What
       * IS reachable is Vite's module graph — the preview is a dev server, so
       * `await import('/src/babylon/globals')` returns the LIVE module instance with the running
       * game's state. That needs top-level `await`, which a bare eval cannot parse.
       *
       * Indirect eval so the body still resolves names in the GAME's global scope rather than in this
       * agent's closure (a direct `eval` would find `errors`, `logs` and `cap` instead).
       *
       * 🔴 EXPRESSION FIRST, THEN STATEMENTS — because expression position alone is a trap the agent
       * hit live (2026-08-09): `location.reload(); 'reloading'` is a SyntaxError inside `(async()=>( … ))`,
       * so a perfectly ordinary two-statement instruction was rejected by the parser and the model was
       * told its own code was invalid. The expression form stays FIRST because it is the common case and
       * it returns a value implicitly; the statement form is the fallback and needs an explicit `return`,
       * exactly like a browser console.
       */
      let value: unknown;

      try {
        // eslint-disable-next-line no-eval
        value = (0, eval)('(async()=>(' + expression + '))()');
      } catch (error) {
        if (!(error instanceof SyntaxError)) {
          throw error;
        }

        // eslint-disable-next-line no-eval
        value = (0, eval)('(async()=>{' + expression + '})()');
      }

      return Promise.resolve(value).then((resolved) => ({ value: cap(resolved, limits) }));
    }

    if (method === 'console') {
      const since = (params && params.since) || 0;
      return { entries: logs.filter((entry) => entry.at >= since) };
    }

    if (method === 'errors') {
      const since = (params && params.since) || 0;
      return { entries: errors.filter((entry) => entry.at >= since) };
    }

    if (method === 'screenshot') {
      return takeScreenshot();
    }

    throw new Error('Unknown method: ' + method);
  };

  addEventListener('message', (event: any) => {
    const message = event.data;

    /*
     * 🔴 Only our parent may drive this document. Without this check any page that can get a window
     * handle to the preview can evaluate arbitrary code inside the user's game.
     */
    if (event.source !== parent || !message || message[tag] !== 1 || message.v !== version) {
      return;
    }

    if (message.kind !== 'request') {
      return;
    }

    Promise.resolve()
      .then(() => execute(message.method, message.params || {}))
      .then(
        (data) => send('response', { id: message.id, ok: true, data }),
        (error) => send('response', { id: message.id, ok: false, error: (error && error.message) || String(error) }),
      );
  });

  send('event', { event: 'ready' });
}

/**
 * The injected source.
 *
 * Built once and cached: it is a constant, and rebuilding it per preview would be pure waste on a path
 * that runs on every dev-server start.
 */
let cached: string | undefined;

export function buildPreviewAgentScript(): string {
  if (cached) {
    return cached;
  }

  const args = [
    JSON.stringify(PREVIEW_WIRE_TAG),
    String(PREVIEW_WIRE_VERSION),
    JSON.stringify(PREVIEW_VALUE_LIMITS),
    String(PREVIEW_RING_SIZE),
    JSON.stringify(String(capValue)),
  ].join(',');

  /*
   * Wrapped in a try/catch at the top level, and this is not defensive habit: this script is the FIRST
   * thing in the user's document. If it throws, the game never loads, and the user's report is "the
   * preview is broken" about a project that is fine. A debugger that can break the thing it observes
   * is worse than no debugger.
   */
  cached = `;(function(){try{(${String(previewAgentBody)})(${args});}catch(e){}})();`;

  return cached;
}
