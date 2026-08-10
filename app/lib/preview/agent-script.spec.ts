// @vitest-environment jsdom
/**
 * THE INJECTED AGENT — testing a script that runs in someone else's page.
 *
 * This module's whole hazard is that its output is a STRING executed in the user's game. Nothing in a
 * normal test touches it: it type-checks, it lints, and the way it fails is a silent no-op inside a
 * document we do not own. Two failure modes, both invisible without a test that actually RUNS the text:
 *
 *   1. **A closure reference survives `toString()` as a dangling identifier.** `previewAgentBody`
 *      reads like ordinary TypeScript, so it is natural to reach for a module constant — and the
 *      serialized function then throws `ReferenceError` on the first line of the user's page.
 *   2. **The script throws at all.** It is the FIRST thing in the document; if it throws before the
 *      game's own code, the report is "the preview is broken" about a project that is fine.
 *
 * So this evaluates the built source in a jsdom window and drives the real message protocol.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPreviewAgentScript } from './agent-script';
import { isPreviewMessage, PREVIEW_WIRE_TAG, PREVIEW_WIRE_VERSION, type PreviewMessage } from './protocol';

/** Everything the script posted to its parent, in order. */
let posted: PreviewMessage[];

/**
 * Run the built script with `parent` pointing at a collector.
 *
 * jsdom's `window.parent` is the window itself, which is exactly the shape the script expects (it
 * posts to `parent` and answers messages whose `source` is `parent`), so the collector is installed by
 * spying on `postMessage`.
 */
function runAgent() {
  posted = [];
  vi.spyOn(window, 'postMessage').mockImplementation(((message: unknown) => {
    if (isPreviewMessage(message)) {
      posted.push(message);
    }
  }) as typeof window.postMessage);

  const source = buildPreviewAgentScript();

  // eslint-disable-next-line no-eval
  (0, eval)(source);
}

/** Send a request the way the builder does, and wait for the matching response. */
async function ask(method: string, params?: Record<string, unknown>) {
  const id = `t_${method}_${Math.random().toString(36).slice(2)}`;

  window.dispatchEvent(
    new MessageEvent('message', {
      data: { [PREVIEW_WIRE_TAG]: 1, v: PREVIEW_WIRE_VERSION, kind: 'request', id, method, params },
      source: window,
    }),
  );

  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));

    const reply = posted.find((m) => m.kind === 'response' && (m as { id?: string }).id === id);

    if (reply) {
      return reply as PreviewMessage & { ok: boolean; data?: any; error?: string };
    }
  }

  throw new Error(`no response to ${method}`);
}

beforeEach(() => {
  runAgent();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the built script survives being torn out of its module', () => {
  /* 🔴 Failure mode 1. A dangling closure identifier throws here and nowhere else. */
  it('runs without throwing and announces itself', () => {
    expect(posted.some((m) => m.kind === 'event' && (m as { event?: string }).event === 'ready')).toBe(true);
  });

  /*
   * 🔴 The serialized body must not reference anything from this module's scope. Checking the SOURCE
   * as well as the behaviour catches an identifier on a branch the tests do not reach.
   */
  it('inlines its constants instead of referencing module scope', () => {
    const source = buildPreviewAgentScript();

    for (const identifier of [
      'PREVIEW_WIRE_TAG',
      'PREVIEW_WIRE_VERSION',
      'PREVIEW_VALUE_LIMITS',
      'PREVIEW_RING_SIZE',
    ]) {
      expect(source).not.toContain(identifier);
    }

    // …but the VALUES are there, or it was inlined as nothing.
    expect(source).toContain(JSON.stringify(PREVIEW_WIRE_TAG));
  });

  it('is wrapped so a throw cannot break the host page', () => {
    expect(buildPreviewAgentScript()).toContain('try{');
  });
});

describe('answering the builder', () => {
  it('responds to ping with the document it is in', async () => {
    const reply = await ask('ping');

    expect(reply.ok).toBe(true);
    expect(reply.data.data ?? reply.data).toBeDefined();
  });

  it('evaluates an expression in the page', async () => {
    const reply = await ask('evaluate', { expression: '1 + 1' });

    expect(reply.ok).toBe(true);
    expect(reply.data.value).toBe(2);
  });

  /* 🔴 `await` must parse — the only way to reach an ESM project's live modules is a dynamic import. */
  it('supports await in an expression', async () => {
    const reply = await ask('evaluate', { expression: 'await Promise.resolve(7)' });

    expect(reply.ok).toBe(true);
    expect(reply.data.value).toBe(7);
  });

  /* A thrown expression is a RESULT, not a dead generation. */
  it('reports a throwing expression as a failed response', async () => {
    const reply = await ask('evaluate', { expression: 'nope.nothing' });

    expect(reply.ok).toBe(false);
    expect(reply.error).toBeTruthy();
  });

  it('refuses an empty expression rather than evaluating nothing', async () => {
    const reply = await ask('evaluate', { expression: '   ' });

    expect(reply.ok).toBe(false);
  });

  it('reports an unknown method instead of hanging', async () => {
    const reply = await ask('teleport');

    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('Unknown method');
  });
});

describe('console capture', () => {
  /* 🔴 WRAP, NEVER REPLACE — the game's own output must still reach the real devtools. */
  it('still calls through to the original console', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    runAgent();
    console.log('hello from the game');

    expect(spy).toHaveBeenCalledWith('hello from the game');
  });

  it('forwards the line to the builder', async () => {
    console.log('kart spawned');

    const reply = await ask('console');
    const entries = (reply.data.entries ?? []) as Array<{ text: string }>;

    expect(entries.some((entry) => entry.text.includes('kart spawned'))).toBe(true);
  });
});

describe('error capture', () => {
  it('records an uncaught error and pushes it immediately', async () => {
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'GetKeyDown is not a function', filename: 'src/scripts/Kart.ts', lineno: 87 }),
    );

    expect(
      posted.some(
        (m) =>
          m.kind === 'event' &&
          (m as { event?: string }).event === 'error' &&
          String((m as any).data?.message).includes('GetKeyDown'),
      ),
    ).toBe(true);

    const reply = await ask('errors');
    const entries = (reply.data.entries ?? []) as Array<{ message: string }>;

    expect(entries.some((entry) => entry.message.includes('GetKeyDown'))).toBe(true);
  });
});

/**
 * 🔴 FOUND LIVE (2026-08-09), all three against a real crashed Babylon scene.
 *
 * The scene had thrown and stopped rendering, so the canvas read back solid black — the exact state the
 * `blank` flag exists to describe. It reported `blank: false`, because blankness was inferred from the
 * encoded file's SIZE and a 1024x982 black JPEG is 6.7KB. A frame containing nothing was handed to the
 * model as evidence, which is the failure the flag was written to prevent, inverted.
 */
describe('statements, not just expressions', () => {
  /* 🔴 The agent's own `location.reload(); 'reloading'` was rejected by the parser and never ran. */
  it('runs a multi-statement expression with an explicit return', async () => {
    const reply = await ask('evaluate', { expression: 'const a = 2; const b = 3; return a * b;' });

    expect(reply.ok).toBe(true);
    expect(reply.data.value).toBe(6);
  });

  it('still evaluates a bare expression implicitly', async () => {
    const reply = await ask('evaluate', { expression: '40 + 2' });

    expect(reply.ok).toBe(true);
    expect(reply.data.value).toBe(42);
  });

  /* CONTROL — the fallback must not swallow genuine errors into a silent success. */
  it('CONTROL: a genuinely broken expression still fails', async () => {
    const reply = await ask('evaluate', { expression: 'const = = ;' });

    expect(reply.ok).toBe(false);
  });
});

describe('blankness is measured from pixels, never from file size', () => {
  /*
   * jsdom ships no 2D context, so `getContext('2d')` returns null and the real code would take its
   * "cannot check" branch — which would make every assertion below vacuous. This fake is backed by an
   * actual pixel buffer, so `isFlat` runs its real sampling loop against real bytes.
   */
  const parseHex = (value: string) => {
    const hex = value.replace('#', '');
    const full =
      hex.length === 3
        ? hex
            .split('')
            .map((c) => c + c)
            .join('')
        : hex;

    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16), 255];
  };

  function installFakeCanvas() {
    vi.spyOn(window.HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
      kind: string,
    ) {
      if (kind !== '2d') {
        return null;
      }

      const self = this as HTMLCanvasElement & { __px?: Uint8ClampedArray };
      const ensure = () => {
        if (!self.__px || self.__px.length !== self.width * self.height * 4) {
          self.__px = new Uint8ClampedArray(self.width * self.height * 4);
        }

        return self.__px;
      };

      return {
        fillStyle: '#000',
        fillRect(x: number, y: number, w: number, h: number) {
          const px = ensure();
          const [r, g, b, a] = parseHex(String((this as { fillStyle: string }).fillStyle));

          for (let yy = y; yy < y + h && yy < self.height; yy++) {
            for (let xx = x; xx < x + w && xx < self.width; xx++) {
              const i = (yy * self.width + xx) * 4;
              px[i] = r;
              px[i + 1] = g;
              px[i + 2] = b;
              px[i + 3] = a;
            }
          }
        },
        drawImage(src: HTMLCanvasElement & { __px?: Uint8ClampedArray }, _x: number, _y: number, w: number, h: number) {
          const px = ensure();
          const from = src.__px;

          if (!from) {
            return;
          }

          for (let yy = 0; yy < h; yy++) {
            for (let xx = 0; xx < w; xx++) {
              const sx = Math.min(src.width - 1, Math.floor((xx / w) * src.width));
              const sy = Math.min(src.height - 1, Math.floor((yy / h) * src.height));
              const si = (sy * src.width + sx) * 4;
              const di = (yy * self.width + xx) * 4;
              px[di] = from[si];
              px[di + 1] = from[si + 1];
              px[di + 2] = from[si + 2];
              px[di + 3] = from[si + 3];
            }
          }
        },
        getImageData(x: number, y: number) {
          const px = ensure();
          const i = (y * self.width + x) * 4;

          return { data: [px[i], px[i + 1], px[i + 2], px[i + 3]] };
        },
      } as unknown as CanvasRenderingContext2D;
    } as typeof window.HTMLCanvasElement.prototype.getContext);

    vi.spyOn(window.HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(
      () => 'data:image/jpeg;base64,' + 'A'.repeat(9_000),
    );
  }

  /** Put a canvas in the document that `gameCanvas()` will find, painted by `paint`. */
  const withCanvas = (paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) => {
    const canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 90;

    const ctx = canvas.getContext('2d')!;
    paint(ctx, canvas.width, canvas.height);
    document.body.appendChild(canvas);

    return canvas;
  };

  beforeEach(() => {
    installFakeCanvas();
    runAgent();
  });

  afterEach(() => {
    document.querySelectorAll('canvas').forEach((c) => c.remove());
  });

  /* 🔴 The live failure: solid black is BLANK, however many bytes it encodes to. */
  it('reports a solid-black frame as blank', async () => {
    withCanvas((ctx, w, h) => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
    });

    const reply = await ask('screenshot');

    expect(reply.ok).toBe(true);
    expect(reply.data.blank).toBe(true);
    expect(String(reply.data.note)).toContain('blank');
  });

  /* CONTROL — without this, "always return blank:true" passes the test above. */
  it('CONTROL: a frame with real content is not blank', async () => {
    withCanvas((ctx, w, h) => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, Math.floor(w / 2), h);
    });

    const reply = await ask('screenshot');

    expect(reply.ok).toBe(true);
    expect(reply.data.blank).toBe(false);
    expect(reply.data.note).toBeUndefined();
  });

  /*
   * 🔴 The reported size is the IMAGE's, not the source canvas's — measured wrong live (the tool said
   * 2046x1962 for a picture that decoded to 1024x982).
   *
   * The canvas MUST be bigger than the 1024 long edge or this test is vacuous: below the threshold the
   * scratch and the source have identical dimensions, so reporting the wrong one passes.
   */
  it('reports the dimensions of the encoded image, not of the source canvas', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 2046;
    canvas.height = 1962;

    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#123';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    document.body.appendChild(canvas);

    const reply = await ask('screenshot');

    expect(reply.data.width).toBe(1024);
    expect(reply.data.height).toBe(982);
    expect(reply.data.sourceWidth).toBe(2046);
    expect(reply.data.sourceHeight).toBe(1962);
  });
});

describe('only the parent may drive the page', () => {
  /*
   * 🔴 Without the `source` check, any page holding a handle to this document can evaluate arbitrary
   * code inside the user's game. Dropping the check leaves every other test in this file passing.
   */
  it('ignores a request from a window that is not its parent', async () => {
    const before = posted.length;

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          [PREVIEW_WIRE_TAG]: 1,
          v: PREVIEW_WIRE_VERSION,
          kind: 'request',
          id: 'evil',
          method: 'evaluate',
          params: { expression: '1' },
        },
        source: { postMessage() {} } as unknown as Window,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(posted.slice(before).some((m) => (m as { id?: string }).id === 'evil')).toBe(false);
  });
});
