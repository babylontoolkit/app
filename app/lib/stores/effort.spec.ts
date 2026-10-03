// @vitest-environment jsdom
/**
 * The effort store's persistence (`_specs/effort-selector_plan.md` T7, D6, D11).
 *
 * The choice persists per browser like the model tier — and two rules keep the persisted value from
 * ever asking for more than the user picked: anything unrecognised reads as Medium, and a stored level
 * this deploy does not offer reads as Medium (never a step down to the next level — a stored Max with
 * Max switched off is Medium, not Extra high).
 *
 * "Reload" is simulated the only honest way: `vi.resetModules()` and a fresh import, so the store
 * re-reads `localStorage` exactly as a new page load would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_OFFERED_EFFORT_LEVELS, EFFORT_LEVELS } from '~/lib/modules/llm/capabilities';

const KEY = 'bt_effort_level';

async function load() {
  vi.resetModules();

  const effort = await import('./effort');
  const session = await import('./session');

  return { ...effort, ...session };
}

/** A loaded session offering `levels`. */
function loaded(session: Awaited<ReturnType<typeof load>>, levels: readonly string[]) {
  session.sessionStore.set({
    ...session.EMPTY_SESSION,
    loading: false,
    effortLevels: levels as never,
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('persistence — the choice survives a reload', () => {
  it('a new browser starts on Medium', async () => {
    const { baseEffortStore } = await load();

    expect(baseEffortStore.get()).toBe('medium');
  });

  it('a reload keeps Extra high', async () => {
    const first = await load();
    first.setBaseEffort('xhigh');

    expect(window.localStorage.getItem(KEY)).toBe('xhigh');

    const second = await load();
    expect(second.baseEffortStore.get()).toBe('xhigh');
  });

  it('a reload keeps High', async () => {
    (await load()).setBaseEffort('high');

    expect((await load()).baseEffortStore.get()).toBe('high');
  });

  it('accepts a JSON-quoted stored value (a hand edit the user plainly meant)', async () => {
    window.localStorage.setItem(KEY, '"high"');

    expect((await load()).baseEffortStore.get()).toBe('high');
  });
});

describe('corrupt or unknown stored values read as Medium — never clamped up', () => {
  it.each(['garbage', 'low', 'LOWEST', '"', '{"x', '42', 'ultracode', ''])('%j → medium', async (stored) => {
    window.localStorage.setItem(KEY, stored);

    expect((await load()).baseEffortStore.get()).toBe('medium');
  });

  it('a storage that throws reads as Medium rather than crashing the composer', async () => {
    const { readStoredEffort } = await load();
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
    } as unknown as Storage;

    expect(readStoredEffort(throwing)).toBe('medium');
  });

  it('CONTROL — a valid stored value is read back, so the cases above are a real refusal', async () => {
    window.localStorage.setItem(KEY, 'xhigh');

    expect((await load()).baseEffortStore.get()).toBe('xhigh');
  });
});

describe('a stored Max follows the deploy (D11)', () => {
  it('stored Max with Max switched off → Medium, not Extra high', async () => {
    window.localStorage.setItem(KEY, 'max');

    const session = await load();
    loaded(session, DEFAULT_OFFERED_EFFORT_LEVELS);

    expect(session.baseEffortStore.get()).toBe('medium');
  });

  it('…and the reset is persisted, so Max switched back on later does not silently return', async () => {
    window.localStorage.setItem(KEY, 'max');

    loaded(await load(), DEFAULT_OFFERED_EFFORT_LEVELS);

    expect(window.localStorage.getItem(KEY)).toBe('medium');
  });

  it('stored Max with Max offered → Max', async () => {
    window.localStorage.setItem(KEY, 'max');

    const session = await load();
    loaded(session, EFFORT_LEVELS);

    expect(session.baseEffortStore.get()).toBe('max');
    expect(window.localStorage.getItem(KEY)).toBe('max');
  });

  it('before /api/me answers, a stored Max reads as Medium but is NOT reset (the list is still a guess)', async () => {
    window.localStorage.setItem(KEY, 'max');

    const session = await load();

    // EMPTY_SESSION: loading, default list — Max is not shown, and nothing is written.
    expect(session.baseEffortStore.get()).toBe('medium');
    expect(window.localStorage.getItem(KEY)).toBe('max');

    // The session arrives offering Max: the user's choice comes back.
    loaded(session, EFFORT_LEVELS);
    expect(session.baseEffortStore.get()).toBe('max');
  });

  it('a FAILED session load never resets a stored choice', async () => {
    window.localStorage.setItem(KEY, 'max');

    const session = await load();
    session.sessionStore.set({ ...session.EMPTY_SESSION, loading: false, loadFailed: true });

    expect(window.localStorage.getItem(KEY)).toBe('max');
  });
});

describe('normalizeEffortLevels — the offered list is validated on arrival', () => {
  it('keeps known levels in canonical order', async () => {
    const { normalizeEffortLevels } = await load();

    expect(normalizeEffortLevels(['max', 'medium', 'xhigh', 'high'])).toEqual(['medium', 'high', 'xhigh', 'max']);
  });

  it.each([undefined, null, 'medium', {}, [], ['high', 'xhigh'], ['low', 'bogus']])(
    '%j → the default list (no Max)',
    async (raw) => {
      const { normalizeEffortLevels } = await load();

      expect(normalizeEffortLevels(raw)).toEqual(DEFAULT_OFFERED_EFFORT_LEVELS);
    },
  );

  it('drops a level the client cannot label', async () => {
    const { normalizeEffortLevels } = await load();

    expect(normalizeEffortLevels(['medium', 'low', 'ultracode', 'high'])).toEqual(['medium', 'high']);
  });
});
