/**
 * THE MEDIA PROVIDER IS A PROPERTY OF THE TASK, NEVER OF CURRENT CONFIG (SPEC §4.16, T7).
 *
 * ## The defect this file exists to prevent
 *
 * `MEDIA_PROVIDER` is an operator switch and a render takes MINUTES. Flip it while a KIE render is in
 * flight and a poll that resolved its gateway from CURRENT config would ask Comet about a task id
 * Comet has never issued. Nothing throws: the query returns "not found" or errors transiently, the
 * task never completes, and the refund path eventually fires on a render that may well have
 * succeeded — the user refunded for art they did not get, our account billed for art nobody
 * receives. The download half is the same bug one door along.
 *
 * So `startMediaTask` STAMPS `MediaTaskRecord.provider` from the instance it was handed, and
 * `pollMediaTask` / `downloadMediaResult` take a RESOLVER rather than a provider — they read the name
 * off the record and ask for that one. A caller cannot pass "whatever is configured now" because it
 * does not pass a provider at all.
 *
 * ## How these tests are built
 *
 * ⚠️ **Every in-flight test flips the env AFTER the task is created.** A test that never moves
 * `MEDIA_PROVIDER` passes for a poll that resolves from config, because config and the record agree —
 * which is the whole point of the rule and exactly the case the rule does not need. The flip is what
 * makes the assertion able to fail.
 *
 * ⚠️ **The `'KIE'` cases carry a `'Comet'` CONTROL.** "The resolver was asked for KIE" passes for a
 * function that hardcodes `'KIE'` and ignores the record entirely — the same shape as this repo's
 * de-dup assertion that would have passed for a function collapsing everything to one entry. A record
 * stamped `Comet` must resolve to `Comet`, or the legacy fallback is not a fallback, it is a constant.
 *
 * ⚠️ `env()` falls back to `process.env` and Vitest loads `.env.local`, which on this machine holds a
 * real `COMET_API_KEY` and may hold `MEDIA_PROVIDER` / `LLM_PROVIDER`. Every one of them is stubbed
 * away in `beforeEach` (the `oauth.spec.ts` trap, which has fired four times in this repo).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsLedger, setLedger } from '~/lib/.server/billing/ledger';
import { setGenerationStore, type GenerationStore, type GenerationUpsert } from '~/lib/.server/billing/generations';
import { invalidateMarketPricesCache, MARKET_PRICE_PROVIDERS } from '~/lib/.server/billing/market-price-store';
import {
  getMediaProvider,
  MEDIA_PROVIDERS as CONFIG_MEDIA_PROVIDERS,
  NotConfiguredError,
  PLATFORM_PROVIDERS,
} from '~/lib/.server/agent/config';
import { SAFE_ERRORS } from '~/lib/.server/http';
import { setObjectStore, type ObjectStore } from '~/lib/.server/storage';
import {
  MEDIA_PROVIDERS,
  mediaProviderFor,
  mediaProviderOf,
  resolveMediaProvider,
  type CreateMediaTaskInput,
  type MediaEndpoint,
  type MediaProvider,
  type MediaProviderName,
  type MediaTaskState,
} from './provider';
import { KieMediaProvider } from './kie-client';
import { CometMediaProvider } from './comet-client';
import { getMediaTask, putMediaTask, type MediaTaskRecord } from './store';
import { setMediaDispatcher } from './dispatch';
import { downloadMediaResult, pollMediaTask, startMediaTask } from './service';

const USER = 'user-1';
const PROJECT = 'proj-1';

let tmp: string;
let ledger: FsLedger;
let upserts: GenerationUpsert[];

function memoryStore(): ObjectStore {
  const objects = new Map<string, Uint8Array>();

  return {
    backend: 'filesystem',
    put: async (key, bytes) => void objects.set(key, bytes),
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => void objects.delete(key),
    list: async (prefix) =>
      [...objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ key: k, size: v.length })),
  };
}

/** A provider that records what it was asked to do and answers whatever the test sets. */
class FakeProvider implements MediaProvider {
  created: CreateMediaTaskInput[] = [];
  downloaded: string[] = [];
  state: MediaTaskState = { state: 'pending' };

  constructor(readonly name: MediaProviderName = 'KIE') {}

  async create(input: CreateMediaTaskInput): Promise<string> {
    this.created.push(input);

    return `task-${this.created.length}`;
  }

  async query(): Promise<MediaTaskState> {
    return this.state;
  }

  async download(url: string): Promise<Response> {
    this.downloaded.push(url);

    return new Response(new Uint8Array([1, 2, 3]));
  }
}

/**
 * Every variable that can decide which gateway is "current", which prices apply, or whether a real
 * credential is reachable. Scrubbed to undefined before each test — see the file header.
 */
const MEDIA_ENV = [
  'MEDIA_PROVIDER',
  'LLM_PROVIDER',
  'KIE_API_KEY',
  'COMET_API_KEY',
  'BILLING_ENFORCED',
  'CREDIT_UNIT_COST_USD',
  'CREDIT_MARGIN',
  'CREATION_FLAT_CREDITS',
] as const;

beforeEach(async () => {
  for (const key of MEDIA_ENV) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  invalidateMarketPricesCache();

  /*
   * `ensureMarketPrices` reads the ObjectStore. Left alone it resolves the operator's REAL `.data`
   * directory — a read, but this repo has already destroyed a live project from a spec run, so the
   * store is pointed at memory here and restored in `afterEach`. Empty store → the baked price list,
   * which is what every assertion below is measured against.
   */
  setObjectStore(memoryStore());

  // The production dispatcher sleeps on a real timer; the money is what is under test, not the spacing.
  setMediaDispatcher((_label, create) => create());

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'media-provider-'));
  ledger = new FsLedger(tmp);
  setLedger(ledger);

  upserts = [];
  setGenerationStore({
    upsert: async (row: GenerationUpsert) => void upserts.push(row),
    list: async () => [],
  } as unknown as GenerationStore);
});

afterEach(async () => {
  setMediaDispatcher(undefined);
  setLedger(undefined);
  setGenerationStore(undefined);
  setObjectStore(undefined);
  await fs.rm(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
  invalidateMarketPricesCache();
});

async function grant(credits: number) {
  await ledger.append({ userId: USER, delta: credits, reason: 'grant' });
}

function imageInput(overrides: Partial<Parameters<typeof startMediaTask>[0]> = {}) {
  return {
    model: 'nano-banana-2',
    prompt: 'a neon city skyline',
    options: { resolution: '2K' },
    userId: USER,
    projectId: PROJECT,
    provider: new FakeProvider('KIE'),
    objectStore: memoryStore(),
    ...overrides,
  };
}

/**
 * A stored task, written directly. `startMediaTask` cannot create a Comet task yet (T8 ships the
 * client, and `endpointFor` refuses before then) — but a record CAN carry any provider, which is
 * exactly the state a mid-flight cutover produces and the state the resolver must honour.
 */
function storedRecord(overrides: Partial<MediaTaskRecord> = {}): MediaTaskRecord {
  const now = new Date().toISOString();

  return {
    id: 'med_stored_1',
    projectId: PROJECT,
    userId: USER,
    kind: 'image',
    endpoint: 'jobs' as MediaEndpoint,
    model: 'nano-banana-2',
    prompt: 'a stored render',
    options: {},
    destPath: 'public/assets/generated/x.jpg',
    usd: 0.06,
    credits: 24,
    status: 'pending',
    kieTaskId: 'upstream-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('mediaProviderOf — which gateway a stored task belongs to', () => {
  it('resolves a record with NO provider field to KIE — the only gateway that could have written it', () => {
    /*
     * The legacy case, and the one with no second chance: media shipped KIE-only, so every record
     * written before T7 has no `provider`. Resolving those to anything else — or throwing — strands
     * renders that are in flight at the moment of deploy.
     */
    expect(mediaProviderOf({ id: 'med_legacy' })).toBe('KIE');
    expect(mediaProviderOf({})).toBe('KIE');
  });

  it('honours an explicitly stamped provider, both of them', () => {
    expect(mediaProviderOf({ id: 'a', provider: 'KIE' })).toBe('KIE');

    /*
     * CONTROL for every "resolves to KIE" assertion in this file. Without this, all of them pass for
     * `() => 'KIE'`, which reads as a working fallback and is actually a hardcoded constant that
     * would send every Comet task to KIE the day T8 lands.
     */
    expect(mediaProviderOf({ id: 'b', provider: 'Comet' })).toBe('Comet');
  });

  it('treats an unrecognised provider as KIE rather than making the record unpollable', () => {
    /*
     * Throwing here would be a worse answer than the incumbent: a corrupt or future-dated record
     * would become permanently unpollable AND unrefundable — money taken, nothing able to close it
     * out. Asking KIE produces a failure the refund path can actually act on.
     */
    expect(mediaProviderOf({ id: 'c', provider: 'Replicate' })).toBe('KIE');
    expect(mediaProviderOf({ id: 'd', provider: '' })).toBe('KIE');
  });

  it('is not case-forgiving — the stored value is a stamped enum, not user input', () => {
    // Records are written by us from `MediaProviderName`, so a lowercase value means a corrupt record.
    expect(mediaProviderOf({ id: 'e', provider: 'comet' })).toBe('KIE');
  });
});

describe('the provider is STAMPED at creation', () => {
  beforeEach(() => vi.stubEnv('BILLING_ENFORCED', 'true'));

  it('writes the creating provider onto the task record AND the generations anchor', async () => {
    await grant(100);

    const objectStore = memoryStore();
    const started = await startMediaTask(imageInput({ provider: new FakeProvider('KIE'), objectStore }));

    const record = await getMediaTask(objectStore, PROJECT, started.taskId);

    // The record is what every later poll reads; the anchor is what the §4.10 margin report attributes by.
    expect(record?.provider, 'the record must name the gateway that is rendering it').toBe('KIE');
    expect(upserts[0]).toMatchObject({ id: started.taskId, provider: 'KIE' });
  });

  it('takes the name off the INSTANCE, not off config — they can already disagree at creation', async () => {
    /*
     * The operator flipped `MEDIA_PROVIDER` a moment ago; the request in flight still holds the client
     * that was resolved before the flip. Stamping from config here would label a KIE task `Comet` and
     * make it unpollable from the instant it was born.
     */
    vi.stubEnv('MEDIA_PROVIDER', 'Comet');
    await grant(100);

    const objectStore = memoryStore();
    const started = await startMediaTask(imageInput({ provider: new FakeProvider('KIE'), objectStore }));

    expect((await getMediaTask(objectStore, PROJECT, started.taskId))?.provider).toBe('KIE');
    expect(upserts[0]?.provider).toBe('KIE');
  });
});

describe('an in-flight task is polled by the gateway that CREATED it', () => {
  beforeEach(() => vi.stubEnv('BILLING_ENFORCED', 'true'));

  it('still asks KIE after MEDIA_PROVIDER flips to Comet mid-render — and the task advances', async () => {
    /*
     * 🔴 THE LOAD-BEARING TEST. Create on KIE, flip the operator switch, poll. A `pollMediaTask` that
     * resolved from `getMediaProvider(context)` would ask Comet about a KIE task id and the render
     * would hang until the refund path fired on art that had rendered fine.
     */
    await grant(100);

    const provider = new FakeProvider('KIE');
    const objectStore = memoryStore();
    const started = await startMediaTask(imageInput({ provider, objectStore }));

    // The cutover happens here — AFTER the task exists. Without this the assertion cannot fail.
    vi.stubEnv('MEDIA_PROVIDER', 'Comet');
    vi.stubEnv('LLM_PROVIDER', 'Comet');

    provider.state = { state: 'succeeded', resultUrl: 'https://cdn.kie.ai/x.jpg' };

    const asked: MediaProviderName[] = [];
    const task = await pollMediaTask({
      projectId: PROJECT,
      taskId: started.taskId,
      resolveProvider: (name) => {
        asked.push(name);
        return provider;
      },
      objectStore,
      context: undefined,
    });

    expect(asked, 'the poll resolved the gateway from current config, not from the record').toEqual(['KIE']);
    expect(task).toMatchObject({ status: 'succeeded', resultUrl: 'https://cdn.kie.ai/x.jpg' });
  });

  it('asks Comet for a Comet-stamped record under the very same env — the control', async () => {
    /*
     * Same environment as the test above (`MEDIA_PROVIDER=Comet`), opposite record. Both tests pass
     * only for a resolver keyed on the RECORD: `() => 'KIE'` fails here, and reading config fails
     * above. Neither alone can tell those two implementations apart.
     */
    vi.stubEnv('MEDIA_PROVIDER', 'Comet');

    const provider = new FakeProvider('Comet');
    const objectStore = memoryStore();
    await putMediaTask(objectStore, storedRecord({ provider: 'Comet', endpoint: 'comet-image' }));

    const asked: MediaProviderName[] = [];
    await pollMediaTask({
      projectId: PROJECT,
      taskId: 'med_stored_1',
      resolveProvider: (name) => {
        asked.push(name);
        return provider;
      },
      objectStore,
    });

    expect(asked).toEqual(['Comet']);
  });

  it('polls a legacy record (no provider field) via KIE even on a Comet-configured box', async () => {
    // The deploy-day case: records written before T7 carry no provider and must not be stranded.
    vi.stubEnv('MEDIA_PROVIDER', 'Comet');
    vi.stubEnv('LLM_PROVIDER', 'Comet');

    const provider = new FakeProvider('KIE');
    provider.state = { state: 'succeeded', resultUrl: 'https://cdn.kie.ai/legacy.jpg' };

    const objectStore = memoryStore();
    const legacy = storedRecord();
    expect(legacy.provider, 'the fixture must genuinely lack the field').toBeUndefined();
    await putMediaTask(objectStore, legacy);

    const asked: MediaProviderName[] = [];
    const task = await pollMediaTask({
      projectId: PROJECT,
      taskId: legacy.id,
      resolveProvider: (name) => {
        asked.push(name);
        return provider;
      },
      objectStore,
    });

    expect(asked).toEqual(['KIE']);
    expect(task?.status).toBe('succeeded');
  });

  it('chains the cut-out pass through the SAME gateway the render ran on', async () => {
    /*
     * A transparent image is two upstream calls under one task. The second one is issued from inside
     * the poll, so it inherits whatever the poll resolved — resolve from config and stage 2 is created
     * on a gateway that has never seen stage 1's result URL, after the user has already been debited
     * for both.
     */
    await grant(100);

    const provider = new FakeProvider('KIE');
    const objectStore = memoryStore();
    const started = await startMediaTask(
      imageInput({ provider, objectStore, prompt: 'a wordmark', options: { resolution: '2K', transparent: true } }),
    );

    vi.stubEnv('MEDIA_PROVIDER', 'Comet');
    provider.state = { state: 'succeeded', resultUrl: 'https://cdn.kie.ai/render.jpg' };

    const asked: MediaProviderName[] = [];
    const mid = await pollMediaTask({
      projectId: PROJECT,
      taskId: started.taskId,
      resolveProvider: (name) => {
        asked.push(name);
        return provider;
      },
      objectStore,
    });

    expect(asked).toEqual(['KIE']);
    expect(mid).toMatchObject({ status: 'pending', stage: 'cutout' });
    expect(provider.created[1]?.model).toBe('recraft/remove-background');
  });
});

describe('downloadMediaResult — the bytes come from the task’s gateway too', () => {
  it('downloads a KIE-stamped result via KIE after the switch flipped to Comet', async () => {
    /*
     * The file route used to import KIE's `downloadResult` directly. That coupling was invisible until
     * a second gateway existed: polling would have become provider-aware while downloading silently
     * stayed on KIE. Now both read the record — so both must be tested against a flipped switch.
     */
    vi.stubEnv('MEDIA_PROVIDER', 'Comet');
    vi.stubEnv('LLM_PROVIDER', 'Comet');

    const provider = new FakeProvider('KIE');
    const asked: MediaProviderName[] = [];

    const response = await downloadMediaResult(
      { id: 'med_x', provider: 'KIE', resultUrl: 'https://cdn.kie.ai/final.png' },
      (name) => {
        asked.push(name);
        return provider;
      },
    );

    expect(asked, 'the download resolved the gateway from current config, not from the record').toEqual(['KIE']);
    expect(provider.downloaded).toEqual(['https://cdn.kie.ai/final.png']);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('downloads a Comet-stamped result via Comet — the control', async () => {
    const provider = new FakeProvider('Comet');
    const asked: MediaProviderName[] = [];

    await downloadMediaResult({ id: 'med_y', provider: 'Comet', resultUrl: 'https://cdn.comet/final.png' }, (name) => {
      asked.push(name);
      return provider;
    });

    expect(asked).toEqual(['Comet']);
  });

  it('downloads a legacy (unstamped) result via KIE', async () => {
    vi.stubEnv('MEDIA_PROVIDER', 'Comet');

    const provider = new FakeProvider('KIE');
    const asked: MediaProviderName[] = [];

    await downloadMediaResult({ id: 'med_legacy', resultUrl: 'https://cdn.kie.ai/old.png' }, (name) => {
      asked.push(name);
      return provider;
    });

    expect(asked).toEqual(['KIE']);
  });

  it('refuses a task with no result URL instead of resolving a provider for nothing', async () => {
    const asked: MediaProviderName[] = [];

    await expect(
      downloadMediaResult({ id: 'med_z', provider: 'KIE' }, (name) => {
        asked.push(name);
        return new FakeProvider('KIE');
      }),
    ).rejects.toMatchObject({ name: 'MediaRefusedError', statusCode: 409 });

    expect(asked).toEqual([]);
  });
});

describe('KieMediaProvider refuses another gateway’s endpoint', () => {
  /*
   * `MediaEndpoint` is a shared, PERSISTED vocabulary that now names Comet's routes too. The tempting
   * implementation — "anything that is not veo is jobs" — would POST a Comet task to KIE's jobs
   * endpoint: a debit taken, a task id that means nothing to anyone, and a poll that can only ever
   * time out. Refusing names the mismatch instead.
   */
  const COMET_ENDPOINTS: MediaEndpoint[] = ['comet-image', 'comet-gemini-image', 'comet-video'];

  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const endpoint of COMET_ENDPOINTS) {
    it(`create("${endpoint}") throws and never reaches the wire`, async () => {
      const kie = new KieMediaProvider('sentinel-key');

      await expect(kie.create({ endpoint, model: 'nano-banana-2', payload: {} })).rejects.toThrow(
        /does not serve the "comet-/,
      );

      /*
       * The load-bearing half: a refusal that still POSTs has spent money and created an orphan task
       * upstream. "It threw" is not the property — "it threw BEFORE the request" is.
       */
      expect(fetchSpy, 'KIE was called with another gateway’s endpoint').not.toHaveBeenCalled();
    });

    it(`query("${endpoint}") throws and never reaches the wire`, async () => {
      const kie = new KieMediaProvider('sentinel-key');

      await expect(kie.query(endpoint, 'task-1')).rejects.toThrow(/another provider/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  /* CONTROL: the refusal is about the OTHER gateway's routes, not about all traffic. */
  for (const endpoint of ['jobs', 'veo'] as const) {
    it(`still serves its own "${endpoint}" endpoint`, async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify({ code: 200, data: { taskId: 'kie-1' } })));

      const kie = new KieMediaProvider('sentinel-key');

      expect(await kie.create({ endpoint, model: 'nano-banana-2', payload: {} })).toBe('kie-1');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  }
});

describe('mediaProviderFor — the one factory', () => {
  it('builds the KIE client', () => {
    const provider = mediaProviderFor('KIE', 'sentinel-key');

    expect(provider).toBeInstanceOf(KieMediaProvider);

    /*
     * 🔴 The client must report the name it was asked for. `startMediaTask` stamps the record from
     * `provider.name`, so a client that lied here would hand every one of its tasks to somebody else
     * — the stamping tests above would all still pass, because they read the same wrong value.
     */
    expect(provider.name).toBe('KIE');
  });

  it('builds the COMET client for Comet — never a KIE one', () => {
    /*
     * T8 shipped `CometMediaProvider`, so this stopped being a refusal. What it still pins is the
     * thing that would be catastrophic and silent: falling back to a KIE client would spend the wrong
     * gateway's key and bill users against a price list their operator never promoted, and every
     * downstream assertion would still pass because the seam is identical.
     */
    const provider = mediaProviderFor('Comet', 'sentinel-key');

    expect(provider).toBeInstanceOf(CometMediaProvider);
    expect(provider).not.toBeInstanceOf(KieMediaProvider);
    expect(provider.name).toBe('Comet');
  });

  it('still refuses an unknown gateway with a class the HTTP layer will SHOW the operator', () => {
    /*
     * 🔴 The class, not the wording, is the load-bearing half — and it is the half a message
     * assertion cannot see. `errorResponse` only surfaces an error whose `name` is in `SAFE_ERRORS`;
     * anything else becomes a generic 500 ("Something went wrong on our end"), so a carefully-worded
     * plain `Error` reaches nobody and a comment promising a *describable* refusal becomes false.
     *
     * The exhaustive `default` is unreachable through the type system, which is exactly why it is
     * worth pinning: it fires the day someone adds a name to `MEDIA_PROVIDERS` and forgets the client.
     */
    expect(() => mediaProviderFor('Fictional' as MediaProviderName, 'k')).toThrow(NotConfiguredError);
    expect(SAFE_ERRORS).toContain('NotConfiguredError');

    // CONTROL: the allow-list is a real list that rejects things, not one that contains everything.
    expect(SAFE_ERRORS).not.toContain('Error');
  });
});

describe('resolveMediaProvider — the non-throwing door', () => {
  /*
   * 🔴 THE REGRESSION THIS EXISTS FOR. The agent proxy resolves media tools in straight-line code on
   * every turn with a project. Composed from throwing parts — `getMediaProvider` refuses a typo'd
   * `MEDIA_PROVIDER`, `mediaProviderFor` refuses a gateway with no client — that made an unserveable
   * CAPABILITY take down the whole REQUEST: on a box with `LLM_PROVIDER=Comet` (this repo's own
   * `.env.local`), `/api/agent` returned HTTP 500 before a token. No chat, because image generation
   * was unavailable.
   *
   * The rule is the one already written down for `/api/me`'s premium hint: a degraded capability
   * reports OFF, never ON, and never throws on the hot path.
   */
  const ENV = ['MEDIA_PROVIDER', 'LLM_PROVIDER', 'KIE_API_KEY', 'COMET_API_KEY'] as const;

  beforeEach(() => {
    for (const key of ENV) {
      vi.stubEnv(key, undefined as unknown as string);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns a client when media IS serveable (control — the null cases below are not vacuous)', () => {
    vi.stubEnv('LLM_PROVIDER', 'KIE');
    vi.stubEnv('KIE_API_KEY', 'sentinel-kie');

    expect(resolveMediaProvider({})?.name).toBe('KIE');
  });

  it('returns the Comet client on a Comet box (control — the null cases are about failures, not Comet)', () => {
    /*
     * Before T8 this asserted `null`, because Comet had no media client. Keeping it as a CONTROL is
     * the point: without it, `resolveMediaProvider` returning null for EVERYTHING would satisfy every
     * other case in this describe.
     */
    vi.stubEnv('LLM_PROVIDER', 'Comet');
    vi.stubEnv('COMET_API_KEY', 'sentinel-comet');

    expect(resolveMediaProvider({})?.name).toBe('Comet');
  });

  it('returns null instead of throwing on a typo’d MEDIA_PROVIDER', () => {
    vi.stubEnv('LLM_PROVIDER', 'KIE');
    vi.stubEnv('KIE_API_KEY', 'sentinel-kie');
    vi.stubEnv('MEDIA_PROVIDER', 'Kei');

    // The validating reader refuses it — correct for the media route, fatal on the generation path.
    expect(() => getMediaProvider({})).toThrow(NotConfiguredError);
    expect(resolveMediaProvider({})).toBeNull();
  });

  it('returns null when no media provider is configured at all', () => {
    vi.stubEnv('LLM_PROVIDER', 'Anthropic');

    expect(resolveMediaProvider({})).toBeNull();
  });

  it('is what the agent proxy uses — the throwing factory must not be on that path', () => {
    /*
     * A source pin, because the failure is invisible in behaviour: the proxy compiles, every media
     * test passes, and the 500 only appears on a deploy whose media gateway has no client. Asserted
     * over comment-stripped source so the paragraph above cannot satisfy it.
     */
    const proxy = sourceWithoutComments(join(process.cwd(), 'app/lib/.server/agent/proxy.ts'));

    expect(proxy).toContain('resolveMediaProvider(');
    expect(proxy, 'the proxy must not construct a media provider through the THROWING factory').not.toContain(
      'mediaProviderFor(',
    );
  });
});

describe('the media provider list agrees with its neighbours', () => {
  /*
   * CONTROL: everything below is derived from these unions, and an assertion over an empty list is
   * green by vacuity.
   */
  it('is non-empty and re-exported identically from the seam', () => {
    expect(MEDIA_PROVIDERS.length).toBeGreaterThanOrEqual(2);
    expect([...MEDIA_PROVIDERS]).toEqual([...CONFIG_MEDIA_PROVIDERS]);
  });

  it('is a strict subset of the platform providers', () => {
    /*
     * A media gateway the platform cannot otherwise talk to would have no key resolution, no rate
     * table and no operator switch — it would exist only in this list.
     */
    for (const provider of MEDIA_PROVIDERS) {
      expect(PLATFORM_PROVIDERS, `${provider} is not a platform provider`).toContain(provider);
    }

    // Strict: Anthropic sells no renders, so the two lists must NOT be the same list.
    expect(PLATFORM_PROVIDERS).toContain('Anthropic');
    expect(MEDIA_PROVIDERS).not.toContain('Anthropic' as never);
  });

  it('matches the marketplace price providers exactly — an unpriced gateway is an unbillable render', () => {
    /*
     * 🔴 Media debits happen BEFORE any spend, from an EXACT price, and `lookupMediaPrice` has no
     * most-expensive fallback: a media provider with no promotable price list cannot render at all,
     * and a marketplace with no media provider is a price list nothing charges against. The two lists
     * are declared separately on purpose (the `config -> rates -> market-price-store` cycle), which is
     * precisely why something has to relate them — see `billing.spec.ts`'s sibling assertion.
     */
    expect([...MEDIA_PROVIDERS].sort()).toEqual([...MARKET_PRICE_PROVIDERS].sort());
  });
});

/*
 * ------------------------------------------------------------------------------------------------ *
 * Default-deny source scan: nothing outside the factory constructs a media client
 * ------------------------------------------------------------------------------------------------
 */

const APP_DIR = join(process.cwd(), 'app');

/** This file names the forbidden construction as DATA (needles, samples), so it excludes itself. */
const SELF = join(APP_DIR, 'lib/.server/media/media-provider.spec.ts');

/**
 * 🔴 SPECS ARE OUT OF SCOPE, AND THAT IS THE RULE'S OWN SCOPE — not a hole punched in it.
 *
 * The rule is "no ROUTE or PROXY constructs a media client": it protects the shipped request paths,
 * where a stray `new` bypasses `requireMediaKey`'s per-provider key lookup and would strand an
 * in-flight KIE task on a Comet box. A spec that tests a client has to construct the class it is
 * testing — `comet-client.spec.ts` does, exactly as this file already did, which is why `SELF`
 * existed. Generalising `SELF` to every spec is that same decision applied consistently rather than
 * one file at a time; the alternative (an allow-list entry per spec) turns a wall into a place to
 * append, which is the failure mode this repo has recorded for exactly this shape of test.
 *
 * ⚠️ It stays honest only because the controls below assert the scanner still FINDS the real
 * construction in `provider.ts` and still reaches the four production files by name. Without those,
 * widening the exclusion could silently empty the scan.
 */
const IS_SPEC = /\.spec\.tsx?$/;

/** Comments quote `new KieMediaProvider(...)` in several post-mortems — documentation is not coupling. */
function sourceWithoutComments(absPath: string): string {
  return readFileSync(absPath, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') {
      continue;
    }

    const abs = join(dir, entry);

    if (statSync(abs).isDirectory()) {
      walk(abs, out);
    } else if (/\.tsx?$/.test(abs)) {
      out.push(abs);
    }
  }

  return out;
}

/**
 * Any media client construction, present or future.
 *
 * ⚠️ Deliberately NOT `new KieMediaProvider` / `new CometMediaProvider` as literals: the Comet client
 * does not exist yet, so a needle naming it matches nothing and would report a clean bill of health
 * for a rule it has never been able to check. A shape catches the class that has not been written.
 */
const CONSTRUCTS_A_MEDIA_CLIENT = /new\s+\w*MediaProvider\s*\(/;

/**
 * The ONLY module allowed to construct one, with its reason — a list without reasons becomes a place
 * to append rather than a wall.
 */
const MAY_CONSTRUCT: Record<string, string> = {
  'app/lib/.server/media/provider.ts':
    'The factory itself (`mediaProviderFor`) — the one door, and the thing a second gateway extends.',
};

const SOURCE_FILES = walk(APP_DIR).filter((abs) => abs !== SELF && !IS_SPEC.test(abs));

function repoPath(abs: string): string {
  return relative(process.cwd(), abs).replace(/\\/g, '/');
}

describe('no route or proxy constructs a media provider directly', () => {
  const constructors = SOURCE_FILES.filter((abs) => CONSTRUCTS_A_MEDIA_CLIENT.test(sourceWithoutComments(abs))).map(
    repoPath,
  );

  it('the scanner read a real, non-empty tree (control)', () => {
    /*
     * ⚠️ A scan that silently matches nothing reports a clean bill of health forever — this repo has
     * hit that trap twice. Prove the reader saw files, and that it saw CONTENT.
     */
    expect(SOURCE_FILES.length).toBeGreaterThan(200);
    expect(sourceWithoutComments(join(APP_DIR, 'lib/.server/media/provider.ts')).length).toBeGreaterThan(200);

    /*
     * The spec exclusion is NARROW: a client's own test file is out of scope, its implementation is
     * not. Without this pair, widening the filter to `.spec` could have quietly dropped shipped code.
     */
    const scanned = new Set(SOURCE_FILES.map(repoPath));
    expect(scanned).not.toContain('app/lib/.server/media/comet-client.spec.ts');
    expect(scanned).toContain('app/lib/.server/media/comet-client.ts');
    expect([...scanned].filter((file) => IS_SPEC.test(file))).toEqual([]);
  });

  it('the matcher matches a real construction and not the factory call (control)', () => {
    // Positive: both the shipping class and the one T8 will add.
    expect(CONSTRUCTS_A_MEDIA_CLIENT.test('  const p = new KieMediaProvider(apiKey);')).toBe(true);
    expect(CONSTRUCTS_A_MEDIA_CLIENT.test('return new CometMediaProvider(key)')).toBe(true);

    // Negative: the sanctioned route through the factory must not read as a violation.
    expect(CONSTRUCTS_A_MEDIA_CLIENT.test('mediaProviderFor(name, requireMediaKey(name, context))')).toBe(false);
    expect(CONSTRUCTS_A_MEDIA_CLIENT.test('const provider = new FakeProvider();')).toBe(false);
  });

  it('the scan actually finds the factory’s construction in the real tree (control)', () => {
    /*
     * The strongest control available: the rule is only meaningful if the scanner can see a genuine
     * `new …MediaProvider(` in the shipped source. If this stops matching, every "no violations"
     * assertion below has quietly become vacuous.
     */
    expect(constructors).toContain('app/lib/.server/media/provider.ts');
  });

  it('the media routes and the proxy are inside the scanned set, and do resolve providers (control)', () => {
    /*
     * The AC names these four files. A scan that never reached them would pass for a route that
     * constructs a client on every request — so pin that they are scanned AND that they genuinely
     * obtain providers (via the factory), which is what makes their absence from `constructors`
     * evidence rather than coincidence.
     */
    const targets = [
      'app/routes/api.projects.$projectId.media.ts',
      'app/routes/api.projects.$projectId.media.$taskId.ts',
      'app/routes/api.projects.$projectId.media.$taskId.file.ts',
      'app/lib/.server/agent/proxy.ts',
    ];
    const scanned = new Set(SOURCE_FILES.map(repoPath));

    for (const target of targets) {
      expect(scanned, `${target} was never scanned`).toContain(target);
      expect(
        sourceWithoutComments(join(process.cwd(), target)),
        `${target} does not obtain its provider from the factory module`,
      ).toMatch(/\b(mediaProviderFor|resolveMediaProvider)\(/);
    }
  });

  it('only the factory constructs a media client', () => {
    /*
     * DEFAULT-DENY. A new file is a failure until someone writes down why it is allowed — because the
     * point of the seam is that adding a gateway is ONE entry in `mediaProviderFor`, not a fifth `new`
     * somewhere nobody greps. A route holding its own `new` also bypasses `requireMediaKey`'s
     * per-provider key lookup, which is what keeps an in-flight KIE task pollable on a Comet box.
     */
    expect(constructors.filter((file) => !MAY_CONSTRUCT[file])).toEqual([]);
  });
});
