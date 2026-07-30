/**
 * NEW PROJECT MODE — the state (T7).
 *
 * The mode carries the machine-written creation brief from the moment a project is cloned to the moment
 * its first build turn is posted. Everything it can get wrong is silent:
 *
 *   - a mode that does not survive a reload loses the brief for a user who created a project, refreshed,
 *     and then typed — they get a build with no play contract, no scaffolded class name, no asset list;
 *   - a mode that leaks across projects sends project A's brief as project B's;
 *   - a mode cleared by `/context` spends itself on a command that posted nothing;
 *   - a mode NOT cleared on send appends the brief twice.
 *
 * None of those throw. So the storage is injected and every branch is driven directly, and the two
 * properties that depend on module-level state (surviving a reload, not leaking across an SPA navigate)
 * are driven through the real store rather than asserted about the reader in isolation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NEW_PROJECT_MODE_PREFIX,
  enterNewProjectMode,
  exitNewProjectMode,
  hydrateNewProjectMode,
  newProjectModeKey,
  newProjectModeStore,
  readNewProjectMode,
  type ModeStorage,
} from './new-project-mode';

/** A plain in-memory `Storage` the tests can inspect key-by-key — the persistence half made readable. */
function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));

  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  } satisfies ModeStorage & { map: Map<string, string> };
}

const BRIEF = '<creation-brief>build the racing game</creation-brief>';

beforeEach(() => {
  /* Module-level nanostore: without this the tests pass or fail on their order. */
  newProjectModeStore.set(null);
});

describe('the key', () => {
  it('is per project', () => {
    expect(newProjectModeKey('proj_a')).toBe(`${NEW_PROJECT_MODE_PREFIX}proj_a`);
    expect(newProjectModeKey('proj_a')).not.toBe(newProjectModeKey('proj_b'));
  });
});

describe('entering the mode', () => {
  it('sets the live store and persists the brief under this project’s key', () => {
    const storage = memoryStorage();

    enterNewProjectMode({ projectId: 'proj_a', brief: BRIEF }, storage);

    expect(newProjectModeStore.get()).toEqual({ projectId: 'proj_a', brief: BRIEF });
    expect(JSON.parse(storage.map.get(newProjectModeKey('proj_a'))!)).toEqual({ projectId: 'proj_a', brief: BRIEF });
  });

  /**
   * 🔴 The unregistered project (server unreachable) has no id to key on. It gets the mode for THIS
   * session and writes nothing — a write under the bare prefix would give every such project one shared
   * record, which is the per-user-flag bug (`bt_saving_intro_shown`) this module exists to avoid.
   */
  it('with no project id sets the store but writes NOTHING — least of all under the bare prefix', () => {
    const storage = memoryStorage();

    enterNewProjectMode({ projectId: '', brief: BRIEF }, storage);

    expect(newProjectModeStore.get()).toEqual({ projectId: '', brief: BRIEF });
    expect([...storage.map.keys()]).toEqual([]);
    expect(storage.map.has(NEW_PROJECT_MODE_PREFIX)).toBe(false);
  });

  it('survives a storage that throws (private browsing, full quota) — the session still has the mode', () => {
    const throwing: ModeStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('QuotaExceededError');
      },
    };

    expect(() => enterNewProjectMode({ projectId: 'proj_a', brief: BRIEF }, throwing)).not.toThrow();
    expect(newProjectModeStore.get()).toEqual({ projectId: 'proj_a', brief: BRIEF });
  });

  it('tolerates having no storage at all (SSR)', () => {
    expect(() => enterNewProjectMode({ projectId: 'proj_a', brief: BRIEF }, null)).not.toThrow();
    expect(newProjectModeStore.get()?.brief).toBe(BRIEF);
  });
});

describe('reading a stored mode', () => {
  it('returns the brief for its own project', () => {
    const storage = memoryStorage();
    enterNewProjectMode({ projectId: 'proj_a', brief: BRIEF }, storage);

    /*
     * The full shape, not a subset: the record is rebuilt field by field on read (never spread), and
     * `handoffDismissed` is deliberately NOT among the fields — it is a session fact, so a reload
     * reopens the card on a project that has still never been built (§4.4a).
     */
    expect(readNewProjectMode('proj_a', storage)).toEqual({
      projectId: 'proj_a',
      brief: BRIEF,
      userPrompt: undefined,
    });
  });

  it('returns null for a project with no record', () => {
    expect(readNewProjectMode('proj_b', memoryStorage())).toBeNull();
  });

  /**
   * 🔴 The inner id is checked against the key. A record that disagrees is a mis-keyed write, and a
   * stored brief is INSTRUCTIONS that reach the model — believing it would send another project's brief.
   */
  it('REJECTS a record whose inner projectId disagrees with the key it was found under', () => {
    const storage = memoryStorage({
      [newProjectModeKey('proj_b')]: JSON.stringify({ projectId: 'proj_a', brief: BRIEF }),
    });

    expect(readNewProjectMode('proj_b', storage)).toBeNull();
  });

  it.each([
    ['corrupt JSON', '{not json'],
    ['a truncated write', '{"projectId":"proj_a"'],
    ['a missing brief', JSON.stringify({ projectId: 'proj_a' })],
    ['an empty brief', JSON.stringify({ projectId: 'proj_a', brief: '' })],
    ['a non-string brief', JSON.stringify({ projectId: 'proj_a', brief: 42 })],
    ['a bare null', JSON.stringify(null)],
    ['an array', JSON.stringify([{ projectId: 'proj_a', brief: BRIEF }])],
  ])('returns null for %s', (_label, raw) => {
    const storage = memoryStorage({ [newProjectModeKey('proj_a')]: raw });

    expect(readNewProjectMode('proj_a', storage)).toBeNull();
  });

  it('returns null for an empty project id without touching storage', () => {
    const storage = memoryStorage();
    const spy = vi.spyOn(storage, 'getItem');

    expect(readNewProjectMode('', storage)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns null with no storage (SSR)', () => {
    expect(readNewProjectMode('proj_a', null)).toBeNull();
  });

  it('survives a storage whose getItem throws', () => {
    const throwing: ModeStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };

    expect(readNewProjectMode('proj_a', throwing)).toBeNull();
  });
});

describe('surviving a reload', () => {
  /**
   * The reload is simulated the only way that means anything here: the live store is emptied (module
   * state does not survive a page load) and the mode is re-hydrated from the SAME storage.
   */
  it('a project created, then reloaded, is still in the mode with its brief intact', () => {
    const storage = memoryStorage();
    enterNewProjectMode({ projectId: 'proj_a', brief: BRIEF }, storage);

    newProjectModeStore.set(null); // the reload

    const rehydrated = { projectId: 'proj_a', brief: BRIEF, userPrompt: undefined };

    expect(hydrateNewProjectMode('proj_a', storage)).toEqual(rehydrated);
    expect(newProjectModeStore.get()).toEqual(rehydrated);
  });

  it('a project whose mode was cleared before the reload comes back with nothing', () => {
    const storage = memoryStorage();
    enterNewProjectMode({ projectId: 'proj_a', brief: BRIEF }, storage);
    exitNewProjectMode('proj_a', storage);

    newProjectModeStore.set(null);

    expect(hydrateNewProjectMode('proj_a', storage)).toBeNull();
  });
});

describe('scoping — one project can never answer for another', () => {
  it('entering for A then hydrating for B yields null', () => {
    const storage = memoryStorage();
    enterNewProjectMode({ projectId: 'proj_a', brief: BRIEF }, storage);

    expect(hydrateNewProjectMode('proj_b', storage)).toBeNull();
    expect(newProjectModeStore.get()).toBeNull();
  });

  /**
   * 🔴 THE `null` WRITE IS THE LOAD-BEARING HALF. "New project" and a dashboard Open are SPA navigates:
   * module state survives them, so a hydrate that only writes when it FINDS something leaves the previous
   * project's brief in the store and the user carries it into a game they had already built.
   */
  it('hydrating a project with no mode CLEARS the store — it does not leave the previous project’s mode', () => {
    const storage = memoryStorage();
    enterNewProjectMode({ projectId: 'proj_a', brief: BRIEF }, storage);
    expect(newProjectModeStore.get()?.projectId).toBe('proj_a');

    hydrateNewProjectMode('proj_b', storage);

    expect(newProjectModeStore.get()).toBeNull();
  });

  it('hydrating with no project at all clears the store', () => {
    const storage = memoryStorage();
    enterNewProjectMode({ projectId: 'proj_a', brief: BRIEF }, storage);

    expect(hydrateNewProjectMode(undefined, storage)).toBeNull();
    expect(newProjectModeStore.get()).toBeNull();
  });

  it('two projects hold independent records, and going back to A restores A’s brief', () => {
    const storage = memoryStorage();
    enterNewProjectMode({ projectId: 'proj_a', brief: 'brief A' }, storage);
    enterNewProjectMode({ projectId: 'proj_b', brief: 'brief B' }, storage);

    expect(hydrateNewProjectMode('proj_a', storage)?.brief).toBe('brief A');
    expect(hydrateNewProjectMode('proj_b', storage)?.brief).toBe('brief B');
  });

  it('creating a second project does not overwrite the first one’s stored brief', () => {
    const storage = memoryStorage();
    enterNewProjectMode({ projectId: 'proj_a', brief: 'brief A' }, storage);
    enterNewProjectMode({ projectId: 'proj_b', brief: 'brief B' }, storage);

    expect(storage.map.size).toBe(2);
    expect(readNewProjectMode('proj_a', storage)?.brief).toBe('brief A');
  });
});

describe('leaving the mode', () => {
  it('clears the live store and removes the record', () => {
    const storage = memoryStorage();
    enterNewProjectMode({ projectId: 'proj_a', brief: BRIEF }, storage);

    exitNewProjectMode('proj_a', storage);

    expect(newProjectModeStore.get()).toBeNull();
    expect(storage.map.has(newProjectModeKey('proj_a'))).toBe(false);
    expect(readNewProjectMode('proj_a', storage)).toBeNull();
  });

  /**
   * The exit takes its target explicitly. Clearing project B must never empty the store while A is open —
   * an exit that resolved its own target from the open project would do exactly that after a switch.
   */
  it('exiting a project that is NOT the open one leaves the open one’s store alone', () => {
    const storage = memoryStorage();
    enterNewProjectMode({ projectId: 'proj_a', brief: BRIEF }, storage);

    exitNewProjectMode('proj_b', storage);

    expect(newProjectModeStore.get()).toEqual({ projectId: 'proj_a', brief: BRIEF });
  });

  it('is idempotent — a second exit is a no-op, not a throw', () => {
    const storage = memoryStorage();
    enterNewProjectMode({ projectId: 'proj_a', brief: BRIEF }, storage);

    exitNewProjectMode('proj_a', storage);

    expect(() => exitNewProjectMode('proj_a', storage)).not.toThrow();
    expect(newProjectModeStore.get()).toBeNull();
  });

  it('survives a storage whose removeItem throws', () => {
    const throwing: ModeStorage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };

    newProjectModeStore.set({ projectId: 'proj_a', brief: BRIEF });

    expect(() => exitNewProjectMode('proj_a', throwing)).not.toThrow();
    expect(newProjectModeStore.get()).toBeNull();
  });

  /**
   * 🔴 CLEARED ON SEND, NOT ON FINISH — so a failed build is retried WITH the brief. The mode is gone
   * from the moment the first turn is posted, which is what makes the retry ordinary rather than a
   * second hidden append.
   */
  it('a retry after a failed build carries no second brief — the mode ended at the send', () => {
    const storage = memoryStorage();
    enterNewProjectMode({ projectId: 'proj_a', brief: BRIEF }, storage);

    exitNewProjectMode('proj_a', storage); // the send

    // the generation fails; the user retries; a reload in between changes nothing
    newProjectModeStore.set(null);
    expect(hydrateNewProjectMode('proj_a', storage)).toBeNull();
  });
});
