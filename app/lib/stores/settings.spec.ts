/**
 * The BROWSER's half of the model tier ladder (SPEC §4.6.1a): which rung this tab remembers the user
 * picked, and how a browser that predates the ladder is carried over to it.
 *
 * Nothing here decides what the user may DO — the server re-derives the rung on every generation
 * (`decideModelTier`) and refuses anything it does not recognise. What this module decides is what the
 * tab ASKS FOR, and every way it can be wrong is silent:
 *
 *  - **Losing the migration** downgrades every existing premium user to Standard the moment they load
 *    the new bundle. Nothing throws, nothing logs; the only signal is a pill quietly naming a cheaper
 *    model, and the token count going DOWN reads as a cheaper turn rather than as a regression.
 *  - **Clamping UP** — accepting a value the ladder does not name, or letting a stale legacy key
 *    re-upgrade a user who explicitly moved back down — spends the user's credits several times faster
 *    without them asking. That is why every unrecognised value in this file is asserted to land on
 *    `'standard'` and never on anything else: refuse DOWNWARD, the same rule as `parseUserEffort` and
 *    the server's `resolveTierId`.
 *  - **Two stores disagreeing.** `premiumModelStore` is a `computed` VIEW of `modelTierStore`, not a
 *    second atom, so a picker and a pill cannot answer "what did the user pick?" differently. Test
 *    group 7 pins it as a view, including the case a naive `tier !== 'standard'` implementation gets
 *    wrong (SuperMax is not Premium).
 *
 * ⚠️ THE SEAM. `getInitialSettings()` runs at MODULE LOAD, so the stored value is read exactly once,
 * when `settings.ts` is first imported. A test cannot seed `localStorage` after importing and expect
 * the store to notice. Every case below therefore goes through `loadSettings()`, which
 * `vi.resetModules()`s the registry, stubs the browser globals, seeds storage, and only THEN does a
 * dynamic `await import('./settings')` — a genuinely fresh module instance per case, which is also
 * exactly what "survives a reload" means. Verified to work before these tests were written: with no
 * `window` stub the module reads `'standard'` (the SSR branch), and with one it reads the seeded value.
 *
 * The localStorage KEY NAMES are written out as string literals rather than imported, deliberately.
 * `SETTINGS_KEYS` is module-private, and more importantly the thing under test is what a REAL browser
 * has on disk: renaming the constant must not be able to silently move the tests with it, because a
 * renamed key is precisely the bug (a browser holding the old name migrates to nothing).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelTierId } from './settings';

/** The wire keys, as a browser holds them. Never imported — see the header note. */
const MODEL_TIER_KEY = 'modelTier';
const LEGACY_PREMIUM_KEY = 'premiumModelEnabled';

/**
 * A `Storage` that is a plain Map, so a test can seed it, hand it to a fresh module instance, and then
 * read back exactly which keys that instance wrote. The real `localStorage` is not available in the
 * node test environment at all, which is why the module reads `'standard'` unless one is stubbed.
 */
function fakeStorage(seed: Record<string, string> = {}): Storage {
  const entries = new Map<string, string>(Object.entries(seed));

  return {
    getItem: (key: string) => (entries.has(key) ? entries.get(key)! : null),
    setItem: (key: string, value: string) => void entries.set(key, String(value)),
    removeItem: (key: string) => void entries.delete(key),
    clear: () => entries.clear(),
    key: (index: number) => [...entries.keys()][index] ?? null,
    get length() {
      return entries.size;
    },
  } as unknown as Storage;
}

type SettingsModule = typeof import('./settings');

/**
 * Load a FRESH instance of `settings.ts` against the given storage.
 *
 * `vi.resetModules()` is what makes this a reload rather than a re-read of the cached instance: without
 * it every case in this file would observe whatever the first import happened to see, and the whole
 * suite would silently assert one state twenty times over.
 *
 * `fetch` is stubbed because the module schedules `autoEnableConfiguredProviders()` on a 100ms timer at
 * load; letting that reach the real `fetch` with a relative URL is a rejected promise landing after the
 * test has finished. It answers with an EMPTY provider list rather than an error, so the unrelated
 * provider machinery stays quiet instead of logging a stack trace per case.
 */
async function loadSettings(storage: Storage): Promise<SettingsModule> {
  vi.resetModules();
  vi.unstubAllGlobals();

  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { localStorage: storage });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ providers: [] }) })),
  );

  return import('./settings');
}

/** Seed a browser's storage and read back the rung the fresh module instance settles on. */
async function tierFor(seed: Record<string, string>): Promise<ModelTierId> {
  const module = await loadSettings(fakeStorage(seed));

  return module.modelTierStore.get();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/*
 * ============================================================================================
 * 1. THE MIGRATION
 *
 * A browser that predates the ladder holds only the pre-ladder boolean. Dropping it downgrades every
 * user who had opted into (and paid for) premium, silently, on the turn they load the new bundle.
 * ============================================================================================
 */
describe('the pre-ladder boolean migrates once, on first read', () => {
  it("premiumModelEnabled: 'true' with no modelTier key reads 'premium'", async () => {
    expect(await tierFor({ [LEGACY_PREMIUM_KEY]: 'true' })).toBe('premium');
  });

  it("premiumModelEnabled: 'false' reads 'standard'", async () => {
    expect(await tierFor({ [LEGACY_PREMIUM_KEY]: 'false' })).toBe('standard');
  });

  it('a browser with neither key reads standard — the default rung is the free one', async () => {
    expect(await tierFor({})).toBe('standard');
  });

  /*
   * The check is `=== true`, not truthiness. A JSON-quoted `"true"`, a `1`, or the bare word `true`
   * stored unparsed are all values that mean "someone or something wrote this key by hand" — and the
   * expensive direction is to read them as an opt-in to a paid rung.
   */
  it('a legacy value that is not literally the boolean true does NOT buy premium', async () => {
    for (const legacy of ['"true"', 'TRUE', 'True', '1', 'yes', 'on', '', '   ', '{', 'null', '[true]']) {
      expect(await tierFor({ [LEGACY_PREMIUM_KEY]: legacy }), `legacy value ${JSON.stringify(legacy)}`).toBe(
        'standard',
      );
    }
  });

  it('the migration never invents a rung above premium', async () => {
    // The old boolean could only ever mean "premium". Nothing about it can select SuperMax.
    expect(await tierFor({ [LEGACY_PREMIUM_KEY]: 'true' })).not.toBe('supermax');
  });
});

/*
 * ============================================================================================
 * 2. THE NEW KEY WINS
 *
 * 🔴 The expensive direction. A user who moved back DOWN to Standard has a stale `premiumModelEnabled`
 * still sitting in storage — the migration reads that key but never clears it. If the legacy key were
 * consulted whenever it is present (rather than only when the new key is ABSENT), every downgrade would
 * silently undo itself on the next reload and the user would be billed at the premium rate.
 * ============================================================================================
 */
describe('the new key is authoritative whenever it exists', () => {
  it("modelTier: 'standard' beats a stale premiumModelEnabled: 'true'", async () => {
    expect(await tierFor({ [MODEL_TIER_KEY]: 'standard', [LEGACY_PREMIUM_KEY]: 'true' })).toBe('standard');
  });

  it("modelTier: 'supermax' beats a stale premiumModelEnabled: 'true'", async () => {
    expect(await tierFor({ [MODEL_TIER_KEY]: 'supermax', [LEGACY_PREMIUM_KEY]: 'true' })).toBe('supermax');
  });

  it("an UNRECOGNISED new key beats the legacy key too — it lands on standard, not on 'premium'", async () => {
    /*
     * The subtle one: the new key exists but is garbage. The legacy key must still not be consulted,
     * because the user's most recent recorded intent is the new key. Falling through to the old boolean
     * here would resurrect a preference the user has since replaced.
     */
    expect(await tierFor({ [MODEL_TIER_KEY]: 'gold', [LEGACY_PREMIUM_KEY]: 'true' })).toBe('standard');
    expect(await tierFor({ [MODEL_TIER_KEY]: '', [LEGACY_PREMIUM_KEY]: 'true' })).toBe('standard');
  });
});

/*
 * ============================================================================================
 * 3. THE RECOGNISED RUNGS, BARE AND JSON-QUOTED
 * ============================================================================================
 */
describe('every rung on the ladder round-trips, bare or JSON-quoted', () => {
  it('reads each MODEL_TIER_IDS entry back in its bare form', async () => {
    // Driven off the exported list, so adding a rung without teaching the reader about it fails here.
    const { MODEL_TIER_IDS } = await loadSettings(fakeStorage());

    for (const tier of MODEL_TIER_IDS) {
      expect(await tierFor({ [MODEL_TIER_KEY]: tier }), `bare ${tier}`).toBe(tier);
    }
  });

  it('accepts the JSON-quoted form a hand-edit or an older experiment may have written', async () => {
    /*
     * `updateModelTier` writes the bare string, but refusing `"premium"` in favour of the cheap default
     * would be a silent DOWNGRADE of a value the user plainly meant — the one direction this reader is
     * allowed to be lenient in, because it can only ever land on a rung the ladder already names.
     */
    expect(await tierFor({ [MODEL_TIER_KEY]: '"supermax"' })).toBe('supermax');
    expect(await tierFor({ [MODEL_TIER_KEY]: '"premium"' })).toBe('premium');
    expect(await tierFor({ [MODEL_TIER_KEY]: '"standard"' })).toBe('standard');
  });
});

/*
 * ============================================================================================
 * 4. REFUSE DOWNWARD, AND NEVER THROW
 *
 * This value comes out of `localStorage`: a user can hand-edit it, an extension can write it, and a
 * half-finished older experiment can leave one behind. Two rules — it may only ever resolve to a rung
 * the ladder names, and a malformed one is a locked-out builder if the throw escapes module load.
 * ============================================================================================
 */
describe('an unrecognised stored value falls to standard, never up and never fatally', () => {
  const hostile: Array<[string, string]> = [
    ['an invented rung', 'gold'],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['the right rung in the wrong case', 'PREMIUM'],
    ['the right rung padded', ' premium '],
    ['malformed JSON', '{'],
    ['a truncated quoted string', '"premium'],
    ['the JSON null literal', 'null'],
    ['a number', '123'],
    ['an array of rungs', '["premium"]'],
    ['an object', '{"tier":"premium"}'],
    ['a quoted invented rung', '"gold"'],
    ['the word undefined', 'undefined'],
    ['the word true', 'true'],
    ['a rung with a trailing newline', 'premium\n'],
    ['a substring of a rung', 'prem'],
    ['a rung with a suffix', 'premium-plus'],
    ['a prototype-pollution payload', '{"__proto__":{"polluted":true}}'],
  ];

  for (const [name, stored] of hostile) {
    it(`${name} reads standard`, async () => {
      let tier!: ModelTierId;

      await expect(
        (async () => {
          tier = await tierFor({ [MODEL_TIER_KEY]: stored });
        })(),
      ).resolves.toBeUndefined();

      expect(tier).toBe('standard');
    });
  }

  it('CONTROL — the same harness reads a VALID value as itself, so the cases above assert something', async () => {
    /*
     * Without this, an implementation that returned `'standard'` unconditionally — or a harness whose
     * seeding silently did nothing — would pass all eighteen cases above and report a clean bill of
     * health forever.
     */
    expect(await tierFor({ [MODEL_TIER_KEY]: 'premium' })).toBe('premium');
    expect(await tierFor({ [MODEL_TIER_KEY]: 'supermax' })).toBe('supermax');
  });

  it('a prototype-pollution payload in the key does not pollute Object.prototype', async () => {
    await tierFor({ [MODEL_TIER_KEY]: '{"__proto__":{"polluted":true}}' });

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
});

/*
 * ============================================================================================
 * 5. ONE WRITER
 *
 * The legacy key is READ once and never written. If `updateModelTier` also wrote it, a migrated browser
 * would end up holding two keys that can disagree — and the next person to touch this file would have
 * to guess which one the user meant. That is the two-writers drift this codebase keeps rediscovering.
 * ============================================================================================
 */
describe('updateModelTier persists, and writes the NEW key only', () => {
  it('writes the bare rung string to the new key', async () => {
    const storage = fakeStorage();
    const { updateModelTier, modelTierStore } = await loadSettings(storage);

    updateModelTier('supermax');

    expect(storage.getItem(MODEL_TIER_KEY)).toBe('supermax');
    expect(modelTierStore.get()).toBe('supermax');
  });

  it('leaves an existing legacy key exactly as it found it', async () => {
    const storage = fakeStorage({ [LEGACY_PREMIUM_KEY]: 'true' });
    const { updateModelTier } = await loadSettings(storage);

    /*
     * The user moves DOWN. The stale legacy key must not be updated to agree, and must not be cleared
     * either — clearing is a write, and the migration's whole contract is that it never writes.
     */
    updateModelTier('standard');

    expect(storage.getItem(MODEL_TIER_KEY)).toBe('standard');
    expect(storage.getItem(LEGACY_PREMIUM_KEY)).toBe('true');
  });

  it('never creates a legacy key on a browser that did not have one', async () => {
    const storage = fakeStorage();
    const { updateModelTier } = await loadSettings(storage);

    for (const tier of ['premium', 'supermax', 'standard'] as const) {
      updateModelTier(tier);
      expect(storage.getItem(LEGACY_PREMIUM_KEY), `after updateModelTier('${tier}')`).toBeNull();
    }
  });

  it('the deprecated updatePremiumModel delegate writes the new key only, too', async () => {
    const storage = fakeStorage();
    const { updatePremiumModel } = await loadSettings(storage);

    updatePremiumModel(true);

    expect(storage.getItem(MODEL_TIER_KEY)).toBe('premium');
    expect(storage.getItem(LEGACY_PREMIUM_KEY)).toBeNull();
  });
});

/*
 * ============================================================================================
 * 6. SURVIVES A RELOAD
 *
 * The acceptance criterion stated as the user experiences it: pick a rung, come back tomorrow, still on
 * that rung. Written as a real write followed by a real fresh module instance reading the SAME storage
 * object, rather than as two assertions about a string, because the write and the read are two separate
 * pieces of code that have to agree on a format (bare vs JSON-quoted) as well as on a key.
 * ============================================================================================
 */
describe('the chosen rung survives a reload', () => {
  it('updateModelTier(supermax) → reload → supermax', async () => {
    const storage = fakeStorage();

    const first = await loadSettings(storage);
    first.updateModelTier('supermax');

    const reloaded = await loadSettings(storage);

    expect(reloaded).not.toBe(first); // CONTROL: the reload really produced a new module instance.
    expect(reloaded.modelTierStore.get()).toBe('supermax');
    expect(reloaded.premiumModelStore.get()).toBe(false);
  });

  it('every rung survives its own reload', async () => {
    for (const tier of ['standard', 'premium', 'supermax'] as const) {
      const storage = fakeStorage();

      const first = await loadSettings(storage);
      first.updateModelTier(tier);

      const reloaded = await loadSettings(storage);
      expect(reloaded.modelTierStore.get(), `${tier} across a reload`).toBe(tier);
    }
  });

  it('a DOWNGRADE survives a reload even with the stale legacy key present', async () => {
    // The full shape of the §2 hazard, driven end to end: migrate up, choose down, reload.
    const storage = fakeStorage({ [LEGACY_PREMIUM_KEY]: 'true' });

    const first = await loadSettings(storage);
    expect(first.modelTierStore.get(), 'CONTROL — migrated to premium').toBe('premium');

    first.updateModelTier('standard');

    const reloaded = await loadSettings(storage);
    expect(reloaded.modelTierStore.get()).toBe('standard');
  });
});

/*
 * ============================================================================================
 * 7. premiumModelStore IS A VIEW, NOT A SECOND STORE
 *
 * Kept only while `PremiumToggle`'s callers migrate (T11). The property that matters is that it cannot
 * hold an opinion of its own: it tracks `modelTierStore` live, and it is true for EXACTLY one rung.
 * A naive `tier !== 'standard'` reports SuperMax as premium — which is not a cosmetic mislabel, it is a
 * pill naming the wrong model and a legacy caller requesting the wrong rung.
 * ============================================================================================
 */
describe('premiumModelStore is a derived view of modelTierStore', () => {
  it('is true for premium and false for BOTH standard and supermax', async () => {
    const { modelTierStore, premiumModelStore } = await loadSettings(fakeStorage());

    modelTierStore.set('standard');
    expect(premiumModelStore.get()).toBe(false);

    modelTierStore.set('premium');
    expect(premiumModelStore.get()).toBe(true);

    /*
     * 🔴 The assertion a `tier !== 'standard'` implementation fails. SuperMax is a rung ABOVE premium,
     * not a synonym for it.
     */
    modelTierStore.set('supermax');
    expect(premiumModelStore.get()).toBe(false);
  });

  it('tracks a change made through updateModelTier, without a second write', async () => {
    const { updateModelTier, premiumModelStore } = await loadSettings(fakeStorage());

    updateModelTier('premium');
    expect(premiumModelStore.get()).toBe(true);

    updateModelTier('supermax');
    expect(premiumModelStore.get()).toBe(false);

    updateModelTier('standard');
    expect(premiumModelStore.get()).toBe(false);
  });

  it('reflects the migrated value at load, with no extra step', async () => {
    const module = await loadSettings(fakeStorage({ [LEGACY_PREMIUM_KEY]: 'true' }));

    expect(module.premiumModelStore.get()).toBe(true);
  });

  it('notifies subscribers when the tier changes — it is live, not a snapshot taken at load', async () => {
    const { updateModelTier, premiumModelStore } = await loadSettings(fakeStorage());

    const seen: boolean[] = [];
    const unsubscribe = premiumModelStore.subscribe((value) => seen.push(value));

    updateModelTier('premium');
    updateModelTier('supermax');
    unsubscribe();

    // The first entry is the subscribe-time value; what matters is that the changes arrived at all.
    expect(seen).toContain(true);
    expect(seen[seen.length - 1]).toBe(false);
  });

  it('updatePremiumModel round-trips through modelTierStore in both directions', async () => {
    const { updatePremiumModel, modelTierStore, premiumModelStore } = await loadSettings(fakeStorage());

    updatePremiumModel(true);
    expect(modelTierStore.get()).toBe('premium');
    expect(premiumModelStore.get()).toBe(true);

    updatePremiumModel(false);
    expect(modelTierStore.get()).toBe('standard');
    expect(premiumModelStore.get()).toBe(false);
  });

  it('updatePremiumModel(false) from supermax lands on standard, not on a half-state', async () => {
    /*
     * A legacy caller switching "premium" off while the user is on SuperMax. The delegate is defined in
     * terms of the ladder, so the answer is the bottom rung — the cheap direction, and the only one that
     * leaves the two stores agreeing.
     */
    const { updateModelTier, updatePremiumModel, modelTierStore } = await loadSettings(fakeStorage());

    updateModelTier('supermax');
    updatePremiumModel(false);

    expect(modelTierStore.get()).toBe('standard');
  });
});

/*
 * ============================================================================================
 * 8. THIS MODULE SHIPS IN THE CLIENT BUNDLE
 *
 * `MODEL_TIER_IDS` is declared here rather than imported from `~/lib/.server/billing/model-tiers`
 * precisely because nothing under `.server/` may reach a browser. A convenience import added later —
 * for the tier LABELS, say, or a price — would drag server-only code (and whatever secrets its
 * transitive imports read) into the bundle. A source scan is the only thing that notices, because the
 * unit tests above would keep passing either way.
 * ============================================================================================
 */
describe('settings.ts imports nothing from ~/lib/.server', () => {
  const SETTINGS_SOURCE = readFileSync(fileURLToPath(new URL('./settings.ts', import.meta.url)), 'utf8');

  /** Any `import`/`export … from` or dynamic `import()` whose specifier reaches into `.server`. */
  function serverImportsIn(source: string): string[] {
    const matches = source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]*\.server[^'"]*)['"]/g);

    return [...matches].map((match) => match[1]);
  }

  it('the source contains no .server import specifier', () => {
    expect(serverImportsIn(SETTINGS_SOURCE)).toEqual([]);
  });

  it('CONTROL — the file was really read, and is the file under test', () => {
    /*
     * A scan that silently reads an empty string reports a clean bill of health forever. Assert the
     * content is present and is the ladder module, not merely non-empty.
     */
    expect(SETTINGS_SOURCE.length).toBeGreaterThan(1_000);
    expect(SETTINGS_SOURCE).toContain('MODEL_TIER_IDS');
    expect(SETTINGS_SOURCE).toContain(MODEL_TIER_KEY);
    expect(SETTINGS_SOURCE).toContain(LEGACY_PREMIUM_KEY);
  });

  it('CONTROL — the scanner really detects a .server import when one is present', () => {
    const samples = [
      "import { MODEL_TIERS } from '~/lib/.server/billing/model-tiers';",
      "export { x } from '../.server/env';",
      "const m = await import('~/lib/.server/billing/model-tiers');",
    ];

    for (const sample of samples) {
      expect(serverImportsIn(sample), sample).toHaveLength(1);
    }

    // ...and does not fire on the ordinary client imports this file actually has.
    expect(serverImportsIn("import { atom } from 'nanostores';\nimport type { X } from '~/types/model';")).toEqual([]);
  });
});

/*
 * ============================================================================================
 * THE TWO LADDERS MUST AGREE (§4.6.1a)
 *
 * `MODEL_TIER_IDS` is declared TWICE on purpose — once here in the client bundle and once in
 * `~/lib/.server/billing/model-tiers.ts` — because a client store may not import from `.server/`. The
 * duplication is deliberate and safe in both directions (a client-extra rung is declined to Standard by
 * the server; a server-extra rung is simply unselectable), so this is not a correctness wall.
 *
 * It is a DRIFT wall. Nothing else in the codebase would notice the two lists parting company, and the
 * symptom would be a rung an operator has configured, priced and paid for that no user can pick — with
 * no error anywhere, because both halves are individually correct. Cheap to assert, invisible if not.
 * ============================================================================================
 */
describe('the client ladder and the server ladder are the same ladder', () => {
  it('declares the same rungs, in the same order', async () => {
    const { MODEL_TIER_IDS: client } = await import('./settings');
    const { MODEL_TIER_IDS: server } = await import('~/lib/.server/billing/model-tiers');

    expect([...client]).toEqual([...server]);
  });

  /* CONTROL — the comparison is over real, non-empty lists, not two undefineds. */
  it('CONTROL — both lists are real and non-trivial', async () => {
    const { MODEL_TIER_IDS: client } = await import('./settings');

    expect(client.length).toBeGreaterThan(1);
    expect(client).toContain('standard');
  });
});
