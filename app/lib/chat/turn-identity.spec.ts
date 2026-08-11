/**
 * The turn-identity resolver, and the wiring that makes it load-bearing.
 *
 * The bug this closes is invisible by construction: a turn posts `projectId: undefined`, the server
 * silently omits three tool families, and the generation completes and bills normally. So the tests
 * that matter are the ones asserting a value is never DROPPED, plus a source scan proving every send
 * path actually carries the override — a resolver nobody calls is exactly as broken as no resolver.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveTurnIdentity } from './turn-identity';

describe('resolveTurnIdentity', () => {
  /* 🔴 THE MEASURED BUG: render captured nothing, the store had the project. */
  it('recovers a project id that render had not committed yet', () => {
    const result = resolveTurnIdentity({}, { projectId: 'prj_1', chatId: 'chat_1' });

    expect(result.identity.projectId).toBe('prj_1');
    expect(result.stale).toBe(true);
  });

  /* 🔴 The resolver must never be able to turn a known id into `undefined`. */
  it('keeps a captured id when the live store is empty', () => {
    const result = resolveTurnIdentity({ projectId: 'prj_1', chatId: 'chat_1' }, {});

    expect(result.identity).toEqual({ projectId: 'prj_1', chatId: 'chat_1' });
  });

  it('prefers the live value when the two disagree', () => {
    const result = resolveTurnIdentity({ projectId: 'old' }, { projectId: 'new' });

    expect(result.identity.projectId).toBe('new');
    expect(result.stale).toBe(true);
  });

  it('resolves the two fields independently', () => {
    const result = resolveTurnIdentity({ projectId: 'prj_1' }, { chatId: 'chat_9' });

    expect(result.identity).toEqual({ projectId: 'prj_1', chatId: 'chat_9' });
  });

  /* A genuinely project-less chat stays project-less — this must not invent an id. */
  it('leaves both undefined when neither side has one', () => {
    const result = resolveTurnIdentity({}, {});

    expect(result.identity).toEqual({ projectId: undefined, chatId: undefined });
    expect(result.stale).toBe(false);
  });

  /*
   * 🔴 EXACTLY TWO KEYS, AND NOTHING ELSE.
   *
   * The result is SPREAD into request bodies that already carry `tier`, `chatMode`, `errors` and the
   * repair fields. `model-tier-wire.spec.tsx` guards that the auto-repair body cannot shadow the model
   * tier — a guard this spread would quietly defeat if the identity ever grew a third field. The
   * `TurnIdentity` index signature (needed to satisfy the SDK's `Record<string, unknown>`) means the
   * type alone cannot promise this, so it is asserted here.
   */
  it('carries exactly projectId and chatId, so a spread cannot shadow anything', () => {
    const { identity } = resolveTurnIdentity({ projectId: 'p' }, { chatId: 'c' });

    expect(Object.keys(identity).sort()).toEqual(['chatId', 'projectId']);
  });

  /* CONTROL — `stale` must not be true for an ordinary healthy send, or the log is pure noise. */
  it('CONTROL: an agreeing render and store is not reported stale', () => {
    const result = resolveTurnIdentity(
      { projectId: 'prj_1', chatId: 'chat_1' },
      { projectId: 'prj_1', chatId: 'chat_1' },
    );

    expect(result.stale).toBe(false);
  });
});

/**
 * 🔴 THE WIRING IS THE FEATURE.
 *
 * `resolveTurnIdentity` is pure and cheap to get right; what actually failed live was a send path
 * posting committed state. A send site added later that forgets the override is silently back to the
 * original bug, and no behavioural test of the resolver can see it.
 */
describe('every send path carries the live identity override', () => {
  /** Comments mention `append()` and `reload()` constantly; scanning them would report false hits. */
  const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const read = (relative: string) => stripComments(readFileSync(join(process.cwd(), relative), 'utf8'));

  /**
   * Every real `append(` / `reload(` call, with the text that follows it — enough to see whether the
   * options argument carries the identity.
   */
  const sendSites = (source: string) => {
    const pattern = /(?:^|[^.\w])(?:props\.)?(append|reload)\(/g;
    const starts: number[] = [];
    let match = pattern.exec(source);

    while (match) {
      starts.push(match.index);
      match = pattern.exec(source);
    }

    /*
     * 🔴 Each site ends where the NEXT one begins — never a fixed-width window.
     *
     * The first draft sliced 600 characters after each match, which reaches past the end of the call
     * and into its neighbour. Deleting the identity from one send still found the token belonging to
     * the next, so the scan passed on the exact regression it exists to catch. Mutation testing is the
     * only thing that showed it: the assertion and the file both looked completely reasonable.
     */
    return starts.map((start, i) => source.slice(start, starts[i + 1] ?? Math.min(source.length, start + 600)));
  };

  const FILES = [
    { path: 'app/components/chat/Chat.client.tsx', token: 'liveTurnBody()' },
    { path: 'app/components/chat/Messages.client.tsx', token: 'liveTurnIdentity()' },
  ];

  it.each(FILES)('$path sends nothing without the live identity', ({ path, token }) => {
    const sites = sendSites(read(path));

    expect(sites.length).toBeGreaterThan(0);

    const missing = sites.filter((site) => !site.includes(token));

    expect(missing.map((s) => s.slice(0, 90))).toEqual([]);
  });

  /*
   * CONTROL — the scanner must be capable of REPORTING a bare send. Without this, a broken matcher
   * that finds no sites (or a `filter` that never matches) passes the assertion above forever, which
   * is precisely how the first draft of this spec passed: it asserted `projectId.get()` was present in
   * Chat.client.tsx, and it was — in unrelated pre-existing code, nowhere near a send.
   */
  it('CONTROL: the scanner flags a send that omits the identity', () => {
    const sites = sendSites('foo(); append({ role: "user" }); bar();');

    expect(sites).toHaveLength(1);
    expect(sites[0].includes('liveTurnBody()')).toBe(false);
  });

  it('CONTROL: comment text is not mistaken for a call site', () => {
    expect(sendSites(stripComments('/* the auto-repair append() and reload() read committed state */'))).toEqual([]);
  });
});
