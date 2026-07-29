/**
 * The CodeSandbox template pin (plan T14, SPEC §4.4 applied to the runtime).
 *
 * This is the sibling of `templates/pin.spec.ts` and it exists for the same reason: the function under
 * test decides which BYTES a user's brand-new project boots from, and **every way it can be wrong is
 * silent**. Nobody experiences "you forked last month's starter"; they experience a project that
 * behaves oddly and they blame the agent.
 *
 * What is pinned here, and why each failure is invisible without a test:
 *
 *   - **Precedence.** A promoted pin outranks `CODESANDBOX_TEMPLATE`, which outranks the baked alias.
 *     Get it backwards and the reviewed decision is silently ignored in favour of whatever an operator
 *     left in an env var during template development.
 *   - **A corrupt pin is a MISSING pin, never an outage.** This object is read on the way to opening a
 *     project; a `JSON.parse` throw here fails every project open, for everyone, over a file nobody
 *     is looking at.
 *   - **A failed cache load KEEPS the previous pin.** Reverting to "no pin" on a transient storage
 *     blip silently returns every new project to the env default — precisely the unreviewed template
 *     that was promoted away from.
 *   - **History truncation drops the OLDEST.** Flip the direction and the rollback menu freezes on
 *     ancient entries while the ones an operator would actually want fall off, with nothing to say so.
 *   - **Promote VALIDATES before it records, and rollback only accepts a recorded target.** The first
 *     is the whole point of the mechanism (a promotion that breaks every new project delivered BY the
 *     thing meant to prevent it); the second stops "rollback" being a second, unvalidated promote
 *     wearing the word that means undo — at the exact moment someone is using it to escape a bad
 *     template.
 *
 * The CodeSandbox service is mocked wholesale (a real network call from a test is a hard failure, same
 * posture as `sandbox-routes.spec.ts`), so this file never names `@codesandbox/sdk` and therefore needs
 * no entry in `sandbox-seam.spec.ts`'s allow-list.
 *
 * ⚠️ Beside the code, never in `app/routes/` — Remix compiles a spec there as a route and the manifest
 * then imports `vitest` at runtime, 500ing every request (§4.5.6).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredObject } from '~/lib/.server/storage';
import { setObjectStore } from '~/lib/.server/storage';
import {
  applyPromotion,
  activeSandboxTemplatePin,
  decideSandboxTemplate,
  ensureSandboxTemplatePin,
  MAX_PIN_HISTORY,
  PIN_CACHE_TTL_MS,
  readSandboxTemplatePin,
  resetSandboxTemplatePinCache,
  SANDBOX_TEMPLATE_PIN_KEY,
  setSandboxTemplatePinCache,
  writeSandboxTemplatePin,
  type SandboxTemplatePin,
  type SandboxTemplatePinFile,
} from './template-pin';
import { DEFAULT_SANDBOX_TEMPLATE, sandboxTemplate, sandboxTemplateDecision } from './config';

const ADMIN = { id: 'admin-1', email: 'a@example.com', emailVerified: true, isAdmin: true } as const;

/** Flipped per test so one mock can drive both the admin and the non-admin route cases. */
const auth = vi.hoisted(() => ({ admin: true }));

vi.mock('~/lib/.server/supabase/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/.server/supabase/auth')>();

  return {
    ...actual,
    requireAdmin: async () => {
      if (!auth.admin) {
        // The real error type, so the route's `errorResponse` maps it to the real status.
        throw new actual.ForbiddenError('Admin access required.');
      }

      return ADMIN;
    },
  };
});

/*
 * The provider seam. `validateSandboxTemplate` and `deleteSandbox` are the only two the route touches,
 * and both are spies so "did a refusal leave a VM running?" is a question this suite can answer.
 */
const service = vi.hoisted(() => ({
  validateSandboxTemplate: vi.fn(),
  deleteSandbox: vi.fn(),
}));

vi.mock('./service', () => service);
vi.mock('~/lib/.server/sandbox/service', () => service);

/**
 * An in-memory `ObjectStore` with call counts.
 *
 * ⚠️ Never the real store: `getObjectStore` falls back to `FsObjectStore` under `platformDataDir()`,
 * so an unstubbed run would deposit pins into the repo's own `.data/` — the same trap that put ~200
 * real rows on disk in the §4.5.6 chat-index work.
 */
function memoryStore() {
  const objects = new Map<string, Uint8Array>();
  let failGet: Error | null = null;

  const store = {
    backend: 'filesystem' as const,
    gets: 0,
    puts: 0,

    /** Make the next reads reject — the transient-storage-blip case. */
    breakReads(error: Error | null) {
      failGet = error;
    },

    async put(key: string, bytes: Uint8Array) {
      store.puts += 1;
      objects.set(key, bytes);
    },

    async get(key: string) {
      store.gets += 1;

      if (failGet) {
        throw failGet;
      }

      return objects.get(key) ?? null;
    },

    async delete(key: string) {
      objects.delete(key);
    },

    async list(): Promise<StoredObject[]> {
      return [];
    },

    /** Read what is actually on disk, so a test can assert the store was NOT written. */
    raw(key = SANDBOX_TEMPLATE_PIN_KEY) {
      const bytes = objects.get(key);
      return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as SandboxTemplatePinFile) : null;
    },

    /** Plant arbitrary bytes — corrupt pins, legacy shapes. */
    plant(text: string, key = SANDBOX_TEMPLATE_PIN_KEY) {
      objects.set(key, new TextEncoder().encode(text));
    },
  };

  return store;
}

type MemoryStore = ReturnType<typeof memoryStore>;

const pin = (target: string, extra: Partial<SandboxTemplatePin> = {}): SandboxTemplatePin => ({
  target,
  promotedAt: '2026-07-28T00:00:00.000Z',
  promotedBy: 'promote',
  ...extra,
});

/*
 * A base far from zero. `ensureSandboxTemplatePin` compares `now - loadedAt` against the TTL and a
 * reset sets `loadedAt = 0`, so a small `now` would look like a fresh load and skip the read — a test
 * artefact that would make the "it loads" assertion pass for the wrong reason.
 */
const T0 = 1_700_000_000_000;

beforeEach(() => {
  auth.admin = true;
  resetSandboxTemplatePinCache();

  /*
   * ⚠️ `env()` falls back to `process.env` and vitest loads `.env.local`, so an operator who has set
   * `CODESANDBOX_TEMPLATE` on their own machine would fail the precedence assertions below — green in
   * CI, red only for the person who configured the feature (the `oauth.spec.ts` trap). Scrubbed
   * explicitly, then set per test.
   */
  vi.stubEnv('CODESANDBOX_TEMPLATE', '');
  vi.stubEnv('CODESANDBOX_API_KEY', 'csb_test_key');

  service.validateSandboxTemplate.mockReset();
  service.deleteSandbox.mockReset();
  service.deleteSandbox.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetSandboxTemplatePinCache();
  setObjectStore(undefined);
});

describe('decideSandboxTemplate — which template a new project forks', () => {
  it('falls back to the baked alias when there is no pin and no env var', () => {
    expect(decideSandboxTemplate({ pin: null, baked: 'btk@starter' })).toEqual({
      template: 'btk@starter',
      source: 'default',
    });
  });

  it('prefers the env var over the baked alias — the template-development escape hatch', () => {
    expect(decideSandboxTemplate({ pin: null, envTemplate: 'btk@wip', baked: 'btk@starter' })).toEqual({
      template: 'btk@wip',
      source: 'env',
    });
  });

  it('🔴 prefers a promoted pin over BOTH — the reviewed decision outranks the env var', () => {
    /*
     * The precedence that carries the feature. Inverted, a leftover `CODESANDBOX_TEMPLATE` on one
     * deploy silently overrides an admin's promotion and nothing anywhere reports a conflict.
     */
    expect(decideSandboxTemplate({ pin: pin('btk@v7'), envTemplate: 'btk@wip', baked: 'btk@starter' })).toEqual({
      template: 'btk@v7',
      source: 'pin',
    });
  });

  it('treats a whitespace-only pin target or env value as absent, never as a template', () => {
    /*
     * Both arrive from a text input somewhere. Forking `"   "` is not a template decision, it is a
     * provider error on every new project — and the fallback chain already has a correct answer.
     */
    expect(decideSandboxTemplate({ pin: pin('   '), envTemplate: 'btk@wip', baked: 'btk@starter' })).toEqual({
      template: 'btk@wip',
      source: 'env',
    });
    expect(decideSandboxTemplate({ pin: null, envTemplate: '  ', baked: 'btk@starter' })).toEqual({
      template: 'btk@starter',
      source: 'default',
    });
  });

  it('trims a padded target rather than forking a name with spaces in it', () => {
    expect(decideSandboxTemplate({ pin: pin(' btk@v7 '), baked: 'btk@starter' })).toEqual({
      template: 'btk@v7',
      source: 'pin',
    });
  });

  it('never lets a pin object without a target win', () => {
    // A half-written pin (a truncated upload, a hand-edited object) is not a decision.
    const broken = { promotedAt: 'x', promotedBy: 'promote' } as unknown as SandboxTemplatePin;

    expect(decideSandboxTemplate({ pin: broken, envTemplate: 'btk@wip', baked: 'btk@starter' })).toEqual({
      template: 'btk@wip',
      source: 'env',
    });
  });

  it('is exhaustive: every combination resolves to a non-empty template and a matching source', () => {
    for (const p of [null, pin('btk@v7'), pin('  ')]) {
      for (const envTemplate of [undefined, '', '  ', 'btk@wip']) {
        const decision = decideSandboxTemplate({ pin: p, envTemplate, baked: 'btk@starter' });

        expect(decision.template.trim()).not.toBe('');
        expect(['pin', 'env', 'default']).toContain(decision.source);

        // The source must never disagree with where the value actually came from.
        if (decision.source === 'pin') {
          expect(p?.target?.trim()).toBe(decision.template);
        }

        if (decision.source === 'env') {
          expect(envTemplate?.trim()).toBe(decision.template);
        }

        if (decision.source === 'default') {
          expect(decision.template).toBe('btk@starter');
        }
      }
    }
  });
});

describe('readSandboxTemplatePin — a corrupt pin is a missing pin, never an outage', () => {
  it('returns an empty file when nothing has ever been promoted', async () => {
    expect(await readSandboxTemplatePin(memoryStore())).toEqual({ current: null, history: [] });
  });

  it('round-trips a written pin file', async () => {
    const store = memoryStore();
    const file: SandboxTemplatePinFile = { current: pin('btk@v7'), history: [pin('btk@v6'), pin('btk@v7')] };

    await writeSandboxTemplatePin(store, file);

    expect(await readSandboxTemplatePin(store)).toEqual(file);
  });

  it('🔴 returns empty — does NOT throw — on unparseable JSON', async () => {
    /*
     * This object is read on the way to opening a project. A throw here is not "the pin is broken", it
     * is "nobody can open a project", over a file no user has ever heard of.
     */
    const store = memoryStore();
    store.plant('{ not json');

    await expect(readSandboxTemplatePin(store)).resolves.toEqual({ current: null, history: [] });
  });

  it('keeps the history when `current` has no target, so the rollback menu survives a bad promote', async () => {
    const store = memoryStore();
    store.plant(JSON.stringify({ current: { promotedAt: 'x' }, history: [pin('btk@v6')] }));

    const file = await readSandboxTemplatePin(store);

    expect(file.current).toBeNull();
    expect(file.history.map((entry) => entry.target)).toEqual(['btk@v6']);
  });

  it('drops history entries with no target rather than offering them as rollback candidates', async () => {
    const store = memoryStore();
    store.plant(JSON.stringify({ current: pin('btk@v7'), history: [pin('btk@v6'), { promotedAt: 'x' }, null] }));

    expect((await readSandboxTemplatePin(store)).history.map((entry) => entry.target)).toEqual(['btk@v6']);
  });

  it('treats a non-array history as no history', async () => {
    const store = memoryStore();
    store.plant(JSON.stringify({ current: pin('btk@v7'), history: 'btk@v6' }));

    expect((await readSandboxTemplatePin(store)).history).toEqual([]);
  });
});

describe('applyPromotion', () => {
  const empty: SandboxTemplatePinFile = { current: null, history: [] };

  it('makes the promoted target current and appends it to the history', () => {
    const next = applyPromotion(empty, pin('btk@v6'));

    expect(next.current?.target).toBe('btk@v6');
    expect(next.history.map((entry) => entry.target)).toEqual(['btk@v6']);
  });

  it('de-duplicates by target, and the NEWER entry wins', () => {
    /*
     * Re-promoting the same alias is ordinary (a rebuilt template keeps its name). Without the dedupe
     * the rollback menu fills with one repeated name; with the dedupe but the OLD entry kept, the
     * history would show the first promotion's timestamp and provenance forever.
     */
    const first = applyPromotion(empty, pin('btk@v6', { promotedAt: '2026-01-01T00:00:00.000Z' }));
    const second = applyPromotion(
      first,
      pin('btk@v6', { promotedAt: '2026-02-02T00:00:00.000Z', provenance: 'rebuilt' }),
    );

    expect(second.history).toHaveLength(1);
    expect(second.history[0]).toMatchObject({ promotedAt: '2026-02-02T00:00:00.000Z', provenance: 'rebuilt' });
    expect(second.current).toEqual(second.history[0]);
  });

  it('a re-promote moves the target to the END of the history — recency order is what an operator reads', () => {
    let file = applyPromotion(empty, pin('a'));
    file = applyPromotion(file, pin('b'));
    file = applyPromotion(file, pin('a', { provenance: 'again' }));

    expect(file.history.map((entry) => entry.target)).toEqual(['b', 'a']);
  });

  it('🔴 truncates the OLDEST entries at the cap, never the newest', () => {
    /*
     * MUTATION TARGET. `slice(-MAX)` and `slice(0, MAX)` both keep the list bounded and both look
     * plausible in review — but the wrong one freezes the rollback menu on the first 20 templates ever
     * promoted and drops everything an operator might actually want to return to. Nothing throws.
     */
    let file = empty;

    for (let index = 0; index < MAX_PIN_HISTORY + 5; index += 1) {
      file = applyPromotion(file, pin(`btk@v${index}`));
    }

    expect(file.history).toHaveLength(MAX_PIN_HISTORY);

    // The five oldest are gone and the newest is still there — asserted as an exact list, not a length.
    expect(file.history.map((entry) => entry.target)).toEqual(
      Array.from({ length: MAX_PIN_HISTORY }, (_, index) => `btk@v${index + 5}`),
    );
    expect(file.current?.target).toBe(`btk@v${MAX_PIN_HISTORY + 4}`);
  });

  it('does not mutate the file it was given — the caller still holds the pre-promotion state', () => {
    const before: SandboxTemplatePinFile = { current: pin('a'), history: [pin('a')] };
    applyPromotion(before, pin('b'));

    expect(before).toEqual({ current: pin('a'), history: [pin('a')] });
  });
});

describe('the sync/async cache seam', () => {
  it('answers null until something loads a pin — the pre-pinning behaviour, exactly', () => {
    expect(activeSandboxTemplatePin()).toBeNull();
  });

  it('loads at the doorway and serves the pin synchronously afterwards', async () => {
    const store = memoryStore();
    await writeSandboxTemplatePin(store, { current: pin('btk@v7'), history: [pin('btk@v7')] });

    await ensureSandboxTemplatePin(store, T0);

    expect(activeSandboxTemplatePin()?.target).toBe('btk@v7');
  });

  it('does NOT re-read the store inside the TTL, and does past it', async () => {
    const store = memoryStore();
    await writeSandboxTemplatePin(store, { current: pin('btk@v7'), history: [] });

    await ensureSandboxTemplatePin(store, T0);
    expect(store.gets).toBe(1);

    /* Every session mint passes this doorway; re-reading object storage on each would be an RTT per open. */
    await ensureSandboxTemplatePin(store, T0 + PIN_CACHE_TTL_MS - 1);
    expect(store.gets).toBe(1);

    await ensureSandboxTemplatePin(store, T0 + PIN_CACHE_TTL_MS);
    expect(store.gets).toBe(2);
  });

  it('picks up a promotion made elsewhere once the TTL expires', async () => {
    const store = memoryStore();
    await writeSandboxTemplatePin(store, { current: pin('btk@v6'), history: [] });
    await ensureSandboxTemplatePin(store, T0);

    await writeSandboxTemplatePin(store, { current: pin('btk@v7'), history: [] });
    await ensureSandboxTemplatePin(store, T0 + PIN_CACHE_TTL_MS);

    expect(activeSandboxTemplatePin()?.target).toBe('btk@v7');
  });

  it('🔴 KEEPS the previous pin when a refresh fails — it never reverts to none', async () => {
    /*
     * MUTATION TARGET, and the direction is the whole point. Reverting to "no pin" on a transient
     * storage blip silently returns every new project to `CODESANDBOX_TEMPLATE` or the baked alias —
     * i.e. to the unreviewed template the promotion existed to replace — and it does it without an
     * error anyone would see, for as long as storage is unhappy.
     */
    const store = memoryStore();
    await writeSandboxTemplatePin(store, { current: pin('btk@v7'), history: [] });
    await ensureSandboxTemplatePin(store, T0);

    store.breakReads(new Error('object storage is having a day'));
    await ensureSandboxTemplatePin(store, T0 + PIN_CACHE_TTL_MS);

    expect(activeSandboxTemplatePin()?.target).toBe('btk@v7');
  });

  it('retries on the next call after a failed load rather than pretending it succeeded', async () => {
    const store = memoryStore();
    await writeSandboxTemplatePin(store, { current: pin('btk@v7'), history: [] });

    store.breakReads(new Error('nope'));
    await ensureSandboxTemplatePin(store, T0);
    expect(activeSandboxTemplatePin()).toBeNull();

    store.breakReads(null);
    await ensureSandboxTemplatePin(store, T0 + 1);

    expect(activeSandboxTemplatePin()?.target).toBe('btk@v7');
  });

  it('setSandboxTemplatePinCache makes a promotion effective without waiting for the TTL', () => {
    setSandboxTemplatePinCache({ current: pin('btk@v8'), history: [] }, T0);

    expect(activeSandboxTemplatePin()?.target).toBe('btk@v8');
  });
});

describe('config.sandboxTemplate flows through the decision', () => {
  it('returns the baked alias with nothing configured', () => {
    expect(sandboxTemplate({})).toBe(DEFAULT_SANDBOX_TEMPLATE);
    expect(sandboxTemplateDecision({}).source).toBe('default');
  });

  it('honours CODESANDBOX_TEMPLATE when no pin is loaded', () => {
    vi.stubEnv('CODESANDBOX_TEMPLATE', 'btk@wip');

    expect(sandboxTemplate({})).toBe('btk@wip');
    expect(sandboxTemplateDecision({}).source).toBe('env');
  });

  it('🔴 honours the cached PIN over CODESANDBOX_TEMPLATE — the fork path reads the reviewed decision', () => {
    /*
     * The acceptance criterion "`sandboxTemplate()` callers all flow through the decision" lives here:
     * `service.ts` calls this synchronously while building a fork request, so if it read the env var
     * directly the panel would confidently report a pin that nothing was using.
     */
    vi.stubEnv('CODESANDBOX_TEMPLATE', 'btk@wip');
    setSandboxTemplatePinCache({ current: pin('btk@v7'), history: [pin('btk@v7')] }, T0);

    expect(sandboxTemplate({})).toBe('btk@v7');
    expect(sandboxTemplateDecision({})).toEqual({ template: 'btk@v7', source: 'pin' });
  });
});

describe('the admin route', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = memoryStore();
    setObjectStore(store);
  });

  async function get() {
    const { loader } = await import('~/routes/api.admin.sandbox-template');

    return loader({
      request: new Request('http://localhost/api/admin/sandbox-template'),
      params: {},
      context: {},
    } as never) as Promise<Response>;
  }

  async function post(body: unknown, method = 'POST') {
    const { action } = await import('~/routes/api.admin.sandbox-template');

    return action({
      request: new Request('http://localhost/api/admin/sandbox-template', {
        method,
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      }),
      params: {},
      context: {},
    } as never) as Promise<Response>;
  }

  /** Promote `target` and assert it landed, so later tests have a history to roll back onto. */
  async function promoted(target: string) {
    service.validateSandboxTemplate.mockResolvedValue({ ok: true, probeSandboxId: `probe-${target}` });

    const response = await post({ action: 'promote', target });
    expect(response.status).toBe(200);

    return response;
  }

  describe('both halves are admin-only', () => {
    it('🔴 refuses a non-admin with 403, writes nothing, and forks no probe VM', async () => {
      /*
       * An unauthenticated promote endpoint lets anyone choose the code every new project starts from
       * — a supply-chain hole, not merely an unmetered one. And a provider call made on the way to
       * refusing is a VM we paid to fork for whoever poked the route.
       */
      auth.admin = false;

      expect((await get()).status).toBe(403);
      expect((await post({ action: 'promote', target: 'btk@evil' })).status).toBe(403);

      expect(store.puts).toBe(0);
      expect(service.validateSandboxTemplate).not.toHaveBeenCalled();
    });
  });

  describe('GET reports the pin, its history, and what is live RIGHT NOW', () => {
    it('reports the baked default when nothing is promoted', async () => {
      const body = (await (await get()).json()) as Record<string, unknown>;

      expect(body).toMatchObject({ pin: null, history: [], live: DEFAULT_SANDBOX_TEMPLATE, effective: 'default' });
    });

    it('reports a promoted pin as live, newest history first, and refreshes the fork path’s cache', async () => {
      await writeSandboxTemplatePin(store, { current: pin('btk@v7'), history: [pin('btk@v6'), pin('btk@v7')] });

      const body = (await (await get()).json()) as { history: SandboxTemplatePin[]; live: string; effective: string };

      expect(body.live).toBe('btk@v7');
      expect(body.effective).toBe('pin');

      /* Newest first: the rollback menu is read top-down and the interesting entries are the recent ones. */
      expect(body.history.map((entry) => entry.target)).toEqual(['btk@v7', 'btk@v6']);

      /*
       * The panel and the fork path must not disagree about what is live — an admin reading "pinned to
       * X" while projects still fork Y for another minute gets diagnosed as a caching bug days later.
       */
      expect(activeSandboxTemplatePin()?.target).toBe('btk@v7');
    });
  });

  describe('promote validates BEFORE it records', () => {
    it('🔴 a candidate that fails validation leaves the pin UNCHANGED, 422s, and its probe is reaped', async () => {
      /*
       * MUTATION TARGET — record-then-validate passes every happy-path test and delivers the exact
       * failure the pin exists to prevent: a template that breaks every new project, promoted by the
       * mechanism meant to review it.
       */
      await promoted('btk@good');
      store.puts = 0;

      service.validateSandboxTemplate.mockResolvedValue({
        ok: false,
        reason: 'it booted, but it is not a Babylon Toolkit starter — missing package.json',
        probeSandboxId: 'probe-bad',
      });

      const response = await post({ action: 'promote', target: 'btk@bad' });

      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: true, pinUnchanged: 'btk@good' });

      // Nothing was written, and the previous decision is still the live one.
      expect(store.puts).toBe(0);
      expect(store.raw()?.current?.target).toBe('btk@good');
      expect(activeSandboxTemplatePin()?.target).toBe('btk@good');

      /* Refusing must cost no more than accepting: the probe VM is destroyed on BOTH paths. */
      expect(service.deleteSandbox).toHaveBeenCalledWith('probe-bad', expect.anything());
    });

    it('reports pinUnchanged: null when nothing was pinned to begin with', async () => {
      service.validateSandboxTemplate.mockResolvedValue({ ok: false, reason: 'no such template' });

      const response = await post({ action: 'promote', target: 'btk@typo' });

      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ pinUnchanged: null });
      expect(store.puts).toBe(0);
    });

    it('records a validated candidate, makes it effective immediately, and reaps the probe', async () => {
      await promoted('btk@v7');

      expect(store.raw()?.current).toMatchObject({ target: 'btk@v7', promotedBy: 'promote' });

      /* Effective without waiting for the cache TTL — otherwise a promotion is a minute of drift. */
      expect(activeSandboxTemplatePin()?.target).toBe('btk@v7');
      expect(sandboxTemplateDecision({})).toEqual({ template: 'btk@v7', source: 'pin' });

      // A successful promotion leaves no VM behind either.
      expect(service.deleteSandbox).toHaveBeenCalledWith('probe-btk@v7', expect.anything());
    });

    it('still records when the probe cannot be reaped — the pin decision was already correct', async () => {
      service.validateSandboxTemplate.mockResolvedValue({ ok: true, probeSandboxId: 'probe-1' });
      service.deleteSandbox.mockRejectedValue(new Error('provider is having a day'));

      expect((await post({ action: 'promote', target: 'btk@v7' })).status).toBe(200);
      expect(store.raw()?.current?.target).toBe('btk@v7');
    });

    it('carries the operator’s provenance into the history', async () => {
      service.validateSandboxTemplate.mockResolvedValue({ ok: true, probeSandboxId: 'p' });

      await post({ action: 'promote', target: 'btk@v7', provenance: 'nightly build 412' });

      expect(store.raw()?.current?.provenance).toBe('nightly build 412');
    });
  });

  describe('rollback only accepts a target we have recorded promoting', () => {
    it('🔴 404s an unrecorded target and writes nothing', async () => {
      /*
       * MUTATION TARGET. Accepting an arbitrary id makes rollback a second, UNVALIDATED promote
       * wearing the word that means undo — and it would do it at the exact moment an operator is
       * using it to escape a bad template.
       */
      await promoted('btk@v7');
      store.puts = 0;

      const response = await post({ action: 'rollback', target: 'btk@never-promoted' });

      expect(response.status).toBe(404);
      expect(store.puts).toBe(0);
      expect(store.raw()?.current?.target).toBe('btk@v7');

      // And it certainly did not fork a VM to find out.
      expect(service.validateSandboxTemplate).toHaveBeenCalledTimes(1); // the promote above, and nothing since
    });

    it('re-points at a recorded target, marks it as a rollback, and never re-validates', async () => {
      await promoted('btk@v6');
      await promoted('btk@v7');
      service.validateSandboxTemplate.mockClear();

      const response = await post({ action: 'rollback', target: 'btk@v6' });

      expect(response.status).toBe(200);
      expect(store.raw()?.current).toMatchObject({ target: 'btk@v6', promotedBy: 'rollback' });
      expect(activeSandboxTemplatePin()?.target).toBe('btk@v6');

      /*
       * A rollback target was validated when it was promoted; re-forking a probe would make the undo
       * path slower and able to FAIL exactly when it is being used in anger.
       */
      expect(service.validateSandboxTemplate).not.toHaveBeenCalled();

      // The history still holds both, so rolling forward again is one click.
      expect(store.raw()?.history.map((entry) => entry.target)).toEqual(['btk@v7', 'btk@v6']);
    });
  });

  describe('request shape', () => {
    it('400s a missing, blank or non-string target before any provider call', async () => {
      for (const body of [
        { action: 'promote' },
        { action: 'promote', target: '   ' },
        { action: 'rollback', target: 7 },
      ]) {
        expect((await post(body)).status).toBe(400);
      }

      expect(service.validateSandboxTemplate).not.toHaveBeenCalled();
      expect(store.puts).toBe(0);
    });

    it('400s an unknown action rather than guessing which one was meant', async () => {
      expect((await post({ action: 'pin-it', target: 'btk@v7' })).status).toBe(400);
      expect(store.puts).toBe(0);
    });

    it('405s a non-POST', async () => {
      expect((await post({ action: 'promote', target: 'btk@v7' }, 'PUT')).status).toBe(405);
      expect(service.validateSandboxTemplate).not.toHaveBeenCalled();
    });

    it('503s with the variable name when CodeSandbox is not configured, before forking a probe', async () => {
      vi.stubEnv('CODESANDBOX_API_KEY', '');

      const response = await post({ action: 'promote', target: 'btk@v7' });

      expect(response.status).toBe(503);
      expect(service.validateSandboxTemplate).not.toHaveBeenCalled();
      expect(store.puts).toBe(0);
    });
  });
});
