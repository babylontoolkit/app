/**
 * THE DEV-TOOLS WIRE, AND THE BUDGET THAT KEEPS IT AFFORDABLE (owner, 2026-08-09).
 *
 * `capValue` is the only thing standing between "the agent asked the game a question" and a Babylon
 * `Scene` — thousands of cross-linked, cyclic, getter-laden properties — being serialized into a tool
 * result that is then billed on every remaining step of the turn. It runs inside the user's page, so
 * it is written dependency-free and tested here rather than in a browser.
 *
 * The failure modes are asymmetric and both silent:
 *   - too permissive → a scene dump, a ten-times-costlier turn, and nothing throws;
 *   - too aggressive → the model is shown a truncated array and concludes that IS the array.
 * Hence every limit has a test AND every truncation is required to announce itself.
 */
import { describe, expect, it } from 'vitest';
import { capValue, isPreviewMessage, PREVIEW_VALUE_LIMITS, PREVIEW_WIRE_TAG, PREVIEW_WIRE_VERSION } from './protocol';

const msg = (extra: Record<string, unknown> = {}) => ({
  [PREVIEW_WIRE_TAG]: 1,
  v: PREVIEW_WIRE_VERSION,
  kind: 'event',
  ...extra,
});

describe('isPreviewMessage — shape only', () => {
  it('accepts our own message', () => {
    expect(isPreviewMessage(msg())).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'hello'],
    ['a foreign postMessage', { type: 'webpackOk' }],
    ["Nodepod's own inspector bridge", { __nodepodInspect: 1, v: 1, kind: 'event' }],
    ['a future protocol version', { [PREVIEW_WIRE_TAG]: 1, v: 99, kind: 'event' }],
  ])('rejects %s', (_label, value) => {
    expect(isPreviewMessage(value)).toBe(false);
  });

  /*
   * 🔴 It deliberately does NOT check the sender. The source check needs the iframe handle, which only
   * the bridge has; a predicate that quietly did both would be reused somewhere with no iframe and
   * would then pass everything. Pinned so nobody "completes" it later.
   */
  it('does not attempt to identify the sender', () => {
    expect(isPreviewMessage(msg({ source: 'somewhere-else' }))).toBe(true);
  });
});

describe('capValue — primitives pass through', () => {
  it.each([
    ['a number', 42],
    ['a boolean', true],
    ['null', null],
    ['a short string', 'kart'],
  ])('%s', (_label, value) => {
    expect(capValue(value)).toBe(value);
  });

  it('describes a function rather than dropping it', () => {
    const update = () => {};

    expect(capValue(update)).toBe('[Function update]');
  });
});

describe('capValue — the ceilings, each announced', () => {
  it('truncates a long string and says so', () => {
    const result = capValue('x'.repeat(PREVIEW_VALUE_LIMITS.string + 500)) as string;

    expect(result).toContain('…(truncated)');
    expect(result.length).toBeLessThan(PREVIEW_VALUE_LIMITS.string + 100);
  });

  /* 🔴 The count must survive. "40 items" and "40 items of 900" are different answers about a scene. */
  it('caps an array and reports how many were dropped', () => {
    const result = capValue(Array.from({ length: 900 }, (_, i) => i)) as unknown[];

    expect(result).toHaveLength(PREVIEW_VALUE_LIMITS.breadth + 1);
    expect(result[result.length - 1]).toBe(`[+${900 - PREVIEW_VALUE_LIMITS.breadth} more]`);
  });

  it('caps object keys and reports how many were dropped', () => {
    const wide: Record<string, number> = {};

    for (let i = 0; i < 100; i++) {
      wide[`k${i}`] = i;
    }

    const result = capValue(wide) as Record<string, unknown>;

    expect(Object.keys(result)).toHaveLength(PREVIEW_VALUE_LIMITS.breadth + 1);
    expect(result['…']).toBe(`[+${100 - PREVIEW_VALUE_LIMITS.breadth} more keys]`);
  });

  it('stops at the depth limit rather than walking a node graph forever', () => {
    let deep: Record<string, unknown> = { leaf: true };

    for (let i = 0; i < 12; i++) {
      deep = { child: deep };
    }

    expect(JSON.stringify(capValue(deep))).toContain('[Depth limit]');
  });

  /* 🔴 `mesh.parent.children[0] === mesh` is ORDINARY in a scene graph, not exotic. Never throw. */
  it('handles a cycle', () => {
    const parent: Record<string, unknown> = { name: 'root' };
    const child = { name: 'kart', parent };
    parent.children = [child];

    expect(() => capValue(parent)).not.toThrow();
    expect(JSON.stringify(capValue(parent))).toContain('[Circular]');
  });

  /*
   * 🔴 SHARED ≠ CIRCULAR — found live 2026-08-09.
   *
   * A reply named one kart as both `nearest` and an entry in `all`. With a global visited-set the
   * second occurrence came back `[Circular]`, which tells the model the data references itself when it
   * does not, and withholds a value it explicitly asked for. Sharing is ordinary: one material on many
   * meshes, one node in two lists. Only a SELF-containing object is circular.
   */
  it('serializes a value referenced twice, rather than calling it circular', () => {
    const kart = { name: 'kart_0', x: 100.5 };
    const result = capValue({ nearest: kart, all: [kart] }) as { nearest: unknown; all: unknown[] };

    expect(result.nearest).toEqual(kart);
    expect(result.all[0]).toEqual(kart);
    expect(JSON.stringify(result)).not.toContain('[Circular]');
  });

  /* The same object appearing many times across siblings must never be mistaken for a cycle. */
  it('handles a shared reference repeated across many siblings', () => {
    const material = { name: 'kartPaint', color: 'red' };
    const meshes = Array.from({ length: 6 }, (_, i) => ({ name: `mesh_${i}`, material }));

    expect(JSON.stringify(capValue({ meshes }))).not.toContain('[Circular]');
  });

  /* CONTROL — the fix must not disable cycle detection, which is what `seen.delete` could do. */
  it('CONTROL: a self-referencing object is still reported as circular', () => {
    const node: Record<string, unknown> = { name: 'self' };
    node.me = node;

    expect(JSON.stringify(capValue(node))).toContain('[Circular]');
  });

  /* A disposed Babylon node throws from its own getters. Report the throw; do not abort the answer. */
  it('survives a getter that throws, and keeps the rest of the object', () => {
    const object = {
      name: 'kart',
      get position() {
        throw new Error('disposed');
      },
    };

    const result = capValue(object) as Record<string, unknown>;

    expect(result.name).toBe('kart');
    expect(String(result.position)).toContain('Getter threw');
  });

  /* An Error's message and stack are non-enumerable, so the generic object walk would lose both. */
  it('keeps an Error readable', () => {
    const result = capValue(new Error('GetKeyDown is not a function')) as Record<string, unknown>;

    expect(result.message).toBe('GetKeyDown is not a function');
    expect(result.name).toBe('Error');
  });

  /*
   * 🔴 The whole-reply ceiling, and the one that actually prevents the scene dump: breadth and depth
   * alone still permit an enormous WIDE-AND-SHALLOW payload.
   */
  it('stops once the total budget is spent', () => {
    const heavy = Array.from({ length: PREVIEW_VALUE_LIMITS.breadth }, () => 'y'.repeat(PREVIEW_VALUE_LIMITS.string));
    const serialized = JSON.stringify(capValue(heavy));

    expect(serialized).toContain('[Budget exhausted]');
    expect(serialized.length).toBeLessThan(PREVIEW_VALUE_LIMITS.total * 2);
  });

  /*
   * CONTROL — an ordinary answer is returned WHOLE. Without this every assertion above passes for a
   * function that returns '[Budget exhausted]' for everything.
   */
  it('CONTROL: a small realistic answer is untouched', () => {
    const answer = { meshes: 42, hasKart: true, camera: 'FollowCamera', position: { x: 0, y: 1.5, z: -3 } };

    expect(capValue(answer)).toEqual(answer);
  });
});

/**
 * 🔴 THE INLINE DEFAULT AND THE EXPORTED CONSTANT MUST AGREE.
 *
 * `capValue` cannot reference `PREVIEW_VALUE_LIMITS` for its default — its source is stringified and
 * re-created inside the user's game, where this module does not exist, so a free identifier is a
 * `ReferenceError` on the first line of someone else's page. That leaves two copies of four numbers,
 * and nothing but this test to stop them drifting: a drift would silently change how much every tool
 * result costs, in the direction nobody notices (`spec/context-budget.md`).
 */
describe('the inline default cannot drift from the exported limits', () => {
  it.each([
    ['a deep object', { a: { b: { c: { d: { e: { f: 1 } } } } } }],
    ['a wide array', Array.from({ length: 300 }, (_, i) => i)],
    ['a long string', 'z'.repeat(9_000)],
  ])('behaves identically with and without explicit limits — %s', (_label, value) => {
    expect(JSON.stringify(capValue(value))).toBe(JSON.stringify(capValue(value, PREVIEW_VALUE_LIMITS)));
  });

  /*
   * CONTROL — the comparison above passes trivially if `capValue` ignores its argument entirely, which
   * is precisely the bug "use the inline default everywhere" would introduce. Tightened limits MUST
   * change the answer.
   */
  it('CONTROL: explicit limits are actually honored', () => {
    const wide = Array.from({ length: 300 }, (_, i) => i);
    const tight = capValue(wide, { depth: 4, breadth: 5, string: 100, total: 16_000 }) as unknown[];

    expect(tight).toHaveLength(6);
    expect(JSON.stringify(tight)).not.toBe(JSON.stringify(capValue(wide)));
  });
});
