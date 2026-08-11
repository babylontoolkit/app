/**
 * The media ROUND budget (`MAX_MEDIA_ROUNDS`) — the one-parallel-round rule as code, not prose.
 *
 * Born from gen_msixapaq_i871b6 (2026-08-07): a first build turn made generate_image calls on every
 * step it had (3 parallel, then 1, then 1 — the brief says ONE round), spent the whole media-turn
 * step budget, and ended with the game unwritten; the forced-continuation rescue re-billed a ~212k
 * prefix at the 2× cache-write rate and delivered 31 tokens of nothing. 1,489 credits, no game.
 *
 * The budget lives in the tools' `execute`, BEFORE any debit (the `MAX_SKILL_LOADS` pattern —
 * `spec/skills.md`: cap the spend inside the tool, never withdraw the tool). These tests pin the
 * three properties that matter, each of which fails SILENTLY as a bigger bill:
 *
 *   - a call past the budget is refused INSTANTLY and touches neither the ledger nor the provider;
 *   - the refusal text tells the model what to do instead (write the game NOW) — it fires mid-thrash;
 *   - an unwired tracker (tests, older callers) means unlimited — the cap only binds where the proxy
 *     wires it, so nothing else changes behaviour by accident.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ObjectStore } from '~/lib/.server/storage';
import { setObjectStore } from '~/lib/.server/storage';
import type { CreateMediaTaskInput, MediaProvider, MediaProviderName } from '~/lib/.server/media/provider';
import { FsLedger, setLedger } from '~/lib/.server/billing/ledger';
import { setGenerationStore, type GenerationStore, type GenerationUpsert } from '~/lib/.server/billing/generations';
import { invalidateMarketPricesCache } from '~/lib/.server/billing/market-price-store';
import { mediaModelDefaults } from '~/lib/media/provider-defaults';
import { createMediaTools, type MediaTaskEvent } from './media-tools';
import { setMediaDispatcher } from '~/lib/.server/media/dispatch';

/*
 * ⚠️ The allowed-path tests reach `startMediaTask`, whose ledger/store seams FALL BACK to the real
 * `.data` directory when unset (the `env()`/`FsChatIndex` trap — a seam that looks empty resolves to
 * the developer's real data). Both are pinned to throwaways here; the first draft of this file
 * deposited two real `med_*` records in `.data/generations`.
 */
let tmp: string;

/*
 * 🔴 THE FIXTURE MUST BE FUNDED, or this file silently stops testing what it says it tests.
 *
 * A fresh `FsLedger` starts at ZERO, and `'media'` is absent from `mayGoNegative` — so every call was
 * refused by the CREDIT GATE ("Not enough credits: this image costs 24 credits") and never reached the
 * provider. The round-budget assertions still read as passing, because the gate's message says
 * "was refused" in lower case while the budget's said "REFUSED"; only `wire.touched()` could tell the
 * difference, and it was reporting a provider that had never been called for a reason that has nothing
 * to do with this file's subject.
 *
 * That is the vacuous-test trap in its purest form: a spec whose inputs cannot reach the rule it names
 * is not a weak test, it is no test. Fund it, and the refusal path under test is the only one left.
 */
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'media-tools-'));

  const ledger = new FsLedger(tmp);
  setLedger(ledger);
  await ledger.append({ userId: 'user-1', delta: 10_000, reason: 'adjustment', note: 'spec fixture' });

  setGenerationStore({
    upsert: async (_row: GenerationUpsert) => undefined,
    list: async () => [],
  } as unknown as GenerationStore);

  /*
   * ⚠️ THE SAME `.data` TRAP, ONE SEAM FURTHER IN. `startMediaTask` opens with
   * `ensureMarketPrices(provider)`, which resolves the MODULE-LEVEL object store — not the one passed
   * on the input — so an unset seam reads the developer's real `.data/storage` (or a real S3 bucket,
   * if `S3_BUCKET` is in their `.env.local`) looking for a promoted price list. A developer with a
   * promotion would then price these tests against numbers CI has never seen. An in-memory store
   * returns null for the pointer, so both gateways resolve to their BAKED lists, deterministically.
   */
  setObjectStore(memoryStore());
  invalidateMarketPricesCache();
});

afterEach(async () => {
  setLedger(undefined);
  setGenerationStore(undefined);
  setObjectStore(undefined);
  invalidateMarketPricesCache();
  await fs.rm(tmp, { recursive: true, force: true });
});

/** A real, byte-faithful `ObjectStore` that lives and dies with the test. Never touches disk. */
function memoryStore(): ObjectStore {
  const objects = new Map<string, Uint8Array>();

  return {
    backend: 'filesystem',
    put: async (key, bytes) => {
      objects.set(key, bytes);
    },
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => {
      objects.delete(key);
    },
    list: async (prefix) =>
      [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, bytes]) => ({ key, size: bytes.byteLength })),
  };
}

/** A provider that PROVES it was reached by throwing — a refused call must never get this far. */
function tripwireProvider(name: MediaProviderName = 'KIE'): { provider: MediaProvider; touched: () => boolean } {
  let reached = false;

  const provider = new Proxy(
    { name },
    {
      get: (target, prop) => {
        /*
         * ⚠️ `name` is a FACT ABOUT the provider, not a USE of it, and it is read twice on the happy
         * path: `createMediaTools` reads it at construction to pick THIS gateway's default models
         * (T9, `media/provider-defaults.ts`), and `startMediaTask` reads it to stamp the task record.
         * Tripping on it would make every test in this file throw inside `toolsWith()`, before a tool
         * was ever called — a green-to-red flip that says nothing about the rule under test.
         *
         * The trip therefore fires on the first real USE, which is `provider.create` — i.e. the actual
         * spend. That makes `touched()` a STRONGER claim than it was: the call priced, debited and
         * reached the wire, rather than merely getting past the first property read.
         */
        if (prop === 'name') {
          return (target as { name: MediaProviderName }).name;
        }

        reached = true;
        throw new Error('provider reached — the call was not stopped before the spend path');
      },
    },
  ) as unknown as MediaProvider;

  return { provider, touched: () => reached };
}

const tripwireStore = new Proxy(
  {},
  {
    get: () => {
      throw new Error('object store reached — the call was not stopped before the spend path');
    },
  },
) as unknown as ObjectStore;

function toolsWith(provider: MediaProviderName = 'KIE') {
  const wire = tripwireProvider(provider);

  const tools = createMediaTools({
    userId: 'user-1',
    projectId: 'prj_test',
    provider: wire.provider,
    objectStore: tripwireStore,
    emit: () => undefined,
  });

  return { tools, wire };
}

async function callGenerateImage(tools: ReturnType<typeof toolsWith>['tools']): Promise<string> {
  const generate = (tools as unknown as Record<string, { execute?: (args: unknown, opts: unknown) => Promise<string> }>)
    .generate_image;

  return generate.execute!({ prompt: 'a kart hero image' }, { toolCallId: 'call-1', messages: [] });
}

/*
 * The production dispatcher sleeps on a REAL timer (spacing + retry backoff), so a spec driving a
 * failing provider would pay seconds per call — this file timed out at 5s on its first run. The
 * queue's own behaviour is tested against an injected clock in `media/dispatch.spec.ts`; here it is
 * a pass-through so these tests measure the TOOL, not the queue.
 */
beforeEach(() => setMediaDispatcher((_label, create) => create()));
afterEach(() => setMediaDispatcher(undefined));

describe('there is NO media round budget — a call is never refused (2026-08-08)', () => {
  /*
   * 🔴 The block this replaces asserted `MAX_MEDIA_ROUNDS === 2` and the REFUSED string. That cap, and
   * the "make ALL your generate calls FIRST, in ONE parallel round" instruction it enforced, refused
   * three images a live design had asked for:
   *
   *   WARN  media tool: round budget spent (2/2), call refused   x3
   *
   * The owner had asked more than once for images one at a time, spaced out. The ceiling that remains
   * is `maxSteps` (`MEDIA_IMAGE_ROUNDS`, tool-policy.ts) — it bounds the TURN without ever telling the
   * model no to a call it has already decided to make.
   */
  it('reaches the spend path on every call, however many have already been made', async () => {
    const { tools, wire } = toolsWith();

    /*
     * The tripwire provider throws when `startMediaTask` calls `create` — i.e. after the request has
     * been priced against the gateway's list and DEBITED, which is as far into the spend path as a
     * test can go without a wire. (It used to trip on the very first property read; since T9 that read
     * is `name`, which the tripwire now answers rather than trapping — see `tripwireProvider`.)
     * Asserting on the absence of a BUDGET refusal specifically, not on the word "refused": the credit
     * gate's own message contains "was refused" too, and matching that loosely is how this test spent
     * its whole life passing while every call was being stopped for an unrelated reason.
     */
    for (let call = 0; call < 6; call++) {
      const result = await callGenerateImage(tools);

      expect(result, `call ${call + 1} hit a round budget`).not.toMatch(/round budget|calls? refused|budget spent/i);
      expect(result, `call ${call + 1} never reached the spend path`).not.toMatch(/not enough credits/i);
    }

    expect(wire.touched(), 'the provider was never reached — the call was stopped before the spend path').toBe(true);
  });

  /*
   * The CONTROL. "Never refuses" passes trivially for a tool that refuses NOTHING ever, including a
   * genuinely bad request — so the empty-prompt guard must still be intact and still be a refusal.
   */
  it('CONTROL: a genuinely invalid call is still refused, without touching the provider', async () => {
    const { tools, wire } = toolsWith();
    const generate = (
      tools as unknown as Record<string, { execute?: (args: unknown, opts: unknown) => Promise<string> }>
    ).generate_image;

    const result = await generate.execute!({ prompt: '   ' }, { toolCallId: 'c', messages: [] });

    expect(result.toLowerCase()).toMatch(/prompt/);
    expect(wire.touched()).toBe(false);
  });
});

/*
 * ================================================================================================
 * T9 (2026-08-11) — THE DEFAULTS AND THE SCHEMA TEXT BELONG TO THE GATEWAY
 *
 * The three default model ids were inlined KIE slugs. On Comet none of them is priced, so every call
 * that named no model was refused before any debit and the turn burned a round rediscovering the
 * catalogue (`gen_mso6s0gd_frqrfh`: 3 calls, 3 refusals, 8.2s, 31,098 cache-write tokens, 0 tasks).
 * It self-heals, so the only symptom is a turn that cost twice what it should have.
 *
 * `provider-defaults.spec.ts` proves the TABLE is right. These two blocks prove the tools are wired to
 * it — which is where five entries in this repo's CLAUDE.md record the defects actually living.
 * ================================================================================================
 */

/** Every string this tool puts in front of the model: its description plus each parameter's. */
function schemaText(tool: unknown): string {
  const t = tool as { description?: string; parameters?: { shape?: Record<string, { description?: string }> } };
  const params = Object.values(t.parameters?.shape ?? {}).map((field) => field.description ?? '');

  return [t.description ?? '', ...params].join('\n');
}

describe('the tool SCHEMAS advertise this gateway’s models, not the other one’s (T9)', () => {
  const OTHER: Record<MediaProviderName, MediaProviderName> = { KIE: 'Comet', Comet: 'KIE' };

  for (const provider of ['KIE', 'Comet'] as const) {
    it(`${provider}: every default is named, and no id from ${OTHER[provider]} appears`, () => {
      /*
       * 🔴 THIS TEXT RIDES IN THE CACHED PREFIX. A wrong default costs one round on the turn it fires;
       * wrong SCHEMA TEXT teaches the agent unpriceable model ids on every turn of every conversation,
       * buying back the wasted round the defaults just removed. That is why the fix builds the prose
       * from the same table as the values and why this is asserted separately from the values.
       */
      const { tools } = toolsWith(provider);
      const mine = mediaModelDefaults(provider);
      const theirs = mediaModelDefaults(OTHER[provider]);

      const blob = [
        schemaText(tools.generate_image),
        schemaText(tools.generate_video),
        schemaText(tools.generate_google_video),
      ].join('\n');

      expect(blob, 'the image default is not advertised').toContain(mine.image);
      expect(blob, 'the Veo default is not advertised').toContain(mine.googleVideo);

      if (mine.video) {
        expect(blob, 'the video default is not advertised').toContain(mine.video);
      } else {
        /*
         * A gateway with no non-Google video default must SAY so, and point at the tool that can do
         * it. Silence here is the wasted-round defect wearing different clothes: the agent calls
         * `generate_video`, gets refused, and burns a round working out why.
         */
        expect(blob, 'a gateway with no video default must explain itself').toMatch(/generate_google_video/);
      }

      for (const foreign of [theirs.image, theirs.video, theirs.googleVideo].filter((id): id is string =>
        Boolean(id),
      )) {
        /*
         * Guarded on distinctness: the two gateways spell Veo `veo3_fast` / `veo3-fast` and share no
         * other id today, but an id that is legitimately shared must not fail this — the rule is "does
         * not advertise what this gateway cannot price", not "the strings differ".
         */
        if (foreign === mine.image || foreign === mine.video || foreign === mine.googleVideo) {
          continue;
        }

        expect(blob, `${provider}'s schema advertises ${OTHER[provider]}'s "${foreign}"`).not.toContain(foreign);
      }

      /*
       * 🔴 AND THE KNOB PROSE, WHICH THE ID SCAN ABOVE CANNOT SEE. The T9 verifier found that
       * `mode`'s hardcoded "kling-3.0 tier: std (720p)…" and `resolution`'s "For seedance/grok
       * models…" survived the first fix and shipped to Comet — because the loop above only tests the
       * three default IDS, and `'kling-3.0/video'` does not substring-match `"kling-3.0 tier"`. One
       * character of punctuation between a defect and its test.
       *
       * Asserted on the FAMILY NAME rather than the id for exactly that reason. Mutation that kills
       * it: reverting either `.describe()` to its literal.
       */
      const foreignFamilies = provider === 'Comet' ? ['kling-3.0', 'seedance', 'grok'] : [];

      for (const family of foreignFamilies) {
        expect(blob, `${provider}'s schema describes a "${family}" knob it cannot serve`).not.toContain(family);
      }
    });
  }

  it('CONTROL — the knob prose IS present where the gateway has the knob', () => {
    /*
     * Without this, the family scan above passes for a build that stripped `mode` and `resolution`
     * descriptions everywhere — trading dead prose on one gateway for no guidance on either. KIE
     * genuinely serves kling-3.0 and seedance, so its schema must still say so.
     */
    const kie = schemaText(toolsWith('KIE').tools.generate_video);

    expect(kie).toContain('kling-3.0');
    expect(kie).toContain('seedance');
  });

  it('CONTROL — the text really was extracted, and the two gateways really differ', () => {
    /*
     * `schemaText` reaching into `parameters.shape` is the fragile half: a zod shape that stops being
     * readable would make every `not.toContain` above pass against an EMPTY string, i.e. report a clean
     * bill of health forever. Pin that real prose came out, and that the blobs are not identical.
     */
    const kie = schemaText(toolsWith('KIE').tools.generate_video);
    const comet = schemaText(toolsWith('Comet').tools.generate_video);

    expect(kie.length).toBeGreaterThan(200);
    expect(comet.length).toBeGreaterThan(200);

    /*
     * Prose from the PARAMETERS, not only the tool description — proves the shape walk works.
     *
     * ⚠️ Comet's clause used to be `Default veo3-fast.` and is now the refusal notice, because
     * `generate_video` may never fall back to Google Veo. Both are substantive strings from the
     * parameter layer, which is what this control is really asserting.
     */
    expect(kie).toMatch(/Default kling-3\.0\/video\./);
    expect(comet).toMatch(/no non-Google default/);
    expect(comet).not.toMatch(/Default veo3-fast\./);
    expect(kie).not.toBe(comet);
  });
});

/** A provider that records what it was asked to create and reports a task id, like a real one. */
function recordingProvider(name: MediaProviderName): {
  provider: MediaProvider;
  created: CreateMediaTaskInput[];
} {
  const created: CreateMediaTaskInput[] = [];

  const provider: MediaProvider = {
    name,
    create: async (input) => {
      created.push(input);
      return `${name.toLowerCase()}-task-${created.length}`;
    },
    query: async () => ({ state: 'pending' }),
    download: async () => new Response(new Uint8Array([1, 2, 3])),
  };

  return { provider, created };
}

function drivableTools(name: MediaProviderName) {
  const wire = recordingProvider(name);
  const emitted: MediaTaskEvent[] = [];

  const tools = createMediaTools({
    userId: 'user-1',
    projectId: 'prj_test',
    provider: wire.provider,
    objectStore: memoryStore(),
    emit: (event) => emitted.push(event),
  });

  const call = async (toolName: 'generate_image' | 'generate_video' | 'generate_google_video', args: object) =>
    (tools as unknown as Record<string, { execute: (a: unknown, o: unknown) => Promise<string> }>)[toolName].execute(
      args,
      { toolCallId: 'call-1', messages: [] },
    );

  return { call, created: wire.created, emitted };
}

describe('a call that names NO model prices and starts on this gateway (T9)', () => {
  /*
   * The end-to-end shape of the live defect: prompt only, no model. Everything below drives the REAL
   * `startMediaTask` — the real price lookup against the real baked list, the real debit, the real
   * payload build — and stops at the wire. The literal ids are asserted rather than compared to
   * `mediaModelDefaults(...)`, because comparing the tool's output to the table it reads from proves
   * only that one value was plumbed to one place.
   */
  const CASES: {
    provider: MediaProviderName;
    tool: 'generate_image' | 'generate_video' | 'generate_google_video';
    model: string;
  }[] = [
    { provider: 'KIE', tool: 'generate_image', model: 'nano-banana-2' },
    { provider: 'KIE', tool: 'generate_video', model: 'kling-3.0/video' },
    { provider: 'KIE', tool: 'generate_google_video', model: 'veo3_fast' },
    { provider: 'Comet', tool: 'generate_image', model: 'gemini-3-pro-image' },

    /*
     * ⚠️ NO `Comet / generate_video` ROW, and its absence is the point. This table used to carry
     * `{ Comet, generate_video, 'veo3-fast' }` — asserting, as correct behaviour, that an unqualified
     * "make me a video" resolves to Google Veo. Comet prices no non-Google video, so on that gateway
     * `generate_video` REFUSES; the refusal is pinned in the Google-video block at the end of this
     * file, which is where a reader looking for the missing row will find it.
     */
    { provider: 'Comet', tool: 'generate_google_video', model: 'veo3-fast' },
  ];

  for (const { provider, tool, model } of CASES) {
    it(`${provider}: ${tool} defaults to ${model} and is NOT refused`, async () => {
      const { call, created, emitted } = drivableTools(provider);
      const result = await call(tool, { prompt: 'a neon kart on a night circuit' });

      /*
       * 🔴 The measured symptom, asserted directly. Before the fix this read "The media generation was
       * refused: … is not in the active Marketplace price list" for all three Comet rows, and the
       * agent spent the next round working out why.
       */
      expect(result, `${provider}/${tool} was refused: ${result}`).not.toMatch(/refused|could not start/i);
      expect(result).toMatch(/^Started \(/);

      // It reached the wire, on the right model — the record and the client event must agree.
      expect(created).toHaveLength(1);
      expect(created[0].model).toBe(model);
      expect(emitted).toHaveLength(1);
      expect(emitted[0].model).toBe(model);
    });
  }

  it('CONTROL — an explicit model this gateway cannot price is STILL refused', async () => {
    /*
     * 🔴 Without this, every assertion above passes for a `startMediaTask` whose price wall has been
     * removed — which would not be a fix, it would be a debit computed from a fallback price. These
     * are the exact cross-gateway ids from the live incident, each refused by the OTHER gateway.
     */
    const comet = drivableTools('Comet');
    const cometResult = await comet.call('generate_image', { prompt: 'x', model: 'nano-banana-2' });

    expect(cometResult).toMatch(/refused/i);
    expect(comet.created, 'a refused call must never reach the wire').toHaveLength(0);
    expect(comet.emitted, 'a refused call must never emit a task to the client').toHaveLength(0);

    const kie = drivableTools('KIE');
    const kieResult = await kie.call('generate_image', { prompt: 'x', model: 'gemini-3-pro-image' });

    expect(kieResult).toMatch(/refused/i);
    expect(kie.created).toHaveLength(0);
  });

  it('CONTROL — an explicitly named, priced model still wins over the default', async () => {
    /*
     * The other direction: a default that OVERRODE the caller would be just as wrong, and every test
     * above would still be green. `veo3_lite` is priced on KIE and is not the default.
     */
    const { call, created } = drivableTools('KIE');
    const result = await call('generate_google_video', { prompt: 'x', model: 'veo3_lite' });

    expect(result).toMatch(/^Started \(/);
    expect(created[0].model).toBe('veo3_lite');
  });

  /*
   * ==============================================================================================
   * generate_video NEVER produces Google Veo (owner rule, 2026-08-11)
   * ==============================================================================================
   *
   * `generate_google_video` exists so Veo — the most expensive video on either catalogue — is asked
   * for deliberately. `provider-defaults.spec.ts` pins the DATA (no gateway defaults to Veo); these
   * pin that `execute` actually refuses, which is the half that spends money if it is missing.
   */
  it('Comet: an unqualified generate_video is REFUSED, not silently served as Veo', async () => {
    /*
     * 🔴 THE REGRESSION TEST, and it is about money. This tool shipped for one live drive with
     * `Comet.video = 'veo3-fast'`, so this exact call debited 128 credits of Google video from a
     * request that only said "a video". `wire.touched()` false is the load-bearing half: it proves
     * nothing reached the gateway, so nothing was billed.
     */
    const { call, created, emitted } = drivableTools('Comet');
    const result = await call('generate_video', { prompt: 'neon light trails' });

    expect(result).toMatch(/generate_google_video/);
    expect(result).not.toMatch(/^Started \(/);

    /*
     * `created` is the RECORDING provider's log — empty means `provider.create` was never called, i.e.
     * nothing was priced, debited or sent. That is the half that matters: the refusal has to happen
     * before the spend, not after it.
     */
    expect(created, 'a refused call must reach neither the gateway nor the ledger').toEqual([]);
    expect(emitted, 'a refused call must not tell the client a render started').toEqual([]);
  });

  it('Comet: naming a Veo id on generate_video is REFUSED too — the rule is not just the default', async () => {
    /*
     * Removing the default alone leaves the tool drivable to Veo by naming the id, which is the same
     * spend through a different door. Mutation that kills it: dropping the `isGoogleVideoModel` guard
     * from `generate_video`'s execute.
     */
    const { call, created, emitted } = drivableTools('Comet');
    const result = await call('generate_video', { prompt: 'x', model: 'veo3-fast' });

    expect(result).toMatch(/generate_google_video/);
    expect(created).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it('KIE: the same guard, the other spelling — veo3_fast is refused on generate_video', async () => {
    /*
     * The owner's rule was "for BOTH KIE and Comet". KIE spells it with an underscore, so a guard
     * written against Comet's hyphenated id would pass every Comet test and leak on KIE.
     */
    const { call, created } = drivableTools('KIE');
    const result = await call('generate_video', { prompt: 'x', model: 'veo3_fast' });

    expect(result).toMatch(/generate_google_video/);
    expect(created).toEqual([]);
  });

  it('CONTROL — generate_google_video still serves Veo, and KIE video still works', async () => {
    /*
     * Without this the three tests above pass for a build where Veo is simply unreachable and general
     * video is broken — refusing everything satisfies every "is refused" assertion ever written.
     */
    const veo = drivableTools('Comet');
    const viaGoogleTool = await veo.call('generate_google_video', { prompt: 'x' });

    expect(viaGoogleTool).toMatch(/^Started \(/);
    expect(veo.created[0].model).toBe('veo3-fast');

    const kie = drivableTools('KIE');
    const general = await kie.call('generate_video', { prompt: 'x' });

    expect(general).toMatch(/^Started \(/);
    expect(kie.created[0].model).toBe('kling-3.0/video');
  });
});
