/**
 * The Media panel's route validates SOUND requests against the gateway before any quote or debit
 * (SPEC §4.16, `_specs/media-gateways_plan.md` T7).
 *
 * The agent's door (`generate_sound`) always ran `validateSoundRequest`; the panel's did not, so a
 * request outside the gateway's limits — a 30 s fal sound effect, a voice fal does not have, vocals
 * with no lyrics — was quoted, DEBITED, sent, refused by fal and refunded. The user's credits made a
 * round trip to learn a sentence we could have said first.
 *
 * ⚠️ Lives here, not in `app/routes/` — Remix compiles a spec in that folder as a route and the
 * manifest then imports `vitest` at runtime, which 500s every request (§4.5.6).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsLedger, setLedger } from '~/lib/.server/billing/ledger';
import { setGenerationStore, type GenerationStore } from '~/lib/.server/billing/generations';
import { invalidateMarketPricesCache } from '~/lib/.server/billing/market-price-store';
import { setObjectStore, type ObjectStore } from '~/lib/.server/storage';
import { FsProjectStore, setProjectStore } from '~/lib/.server/projects/store';
import type { Project } from '~/lib/.server/projects/types';
import { setMediaDispatcher } from './dispatch';

const USER = { id: 'user-1', email: 'a@example.com', emailVerified: true } as const;

vi.mock('~/lib/.server/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireVerifiedUser: async () => USER,
  requireUser: async () => USER,
}));

/** Every variable that decides the gateway, its key or the price — scrubbed (vitest loads `.env.local`). */
const MEDIA_ENV = [
  'MEDIA_PROVIDER',
  'LLM_PROVIDER',
  'KIE_API_KEY',
  'COMET_API_KEY',
  'FAL_API_KEY',
  'BILLING_ENFORCED',
  'CREDIT_UNIT_COST_USD',
  'CREDIT_MARGIN',
  'MEDIA_CALLBACK_URL',
  'APP_URL',
] as const;

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

let tmp: string;
let ledger: FsLedger;
let project: Project;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  for (const key of MEDIA_ENV) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  vi.stubEnv('BILLING_ENFORCED', 'true');
  vi.stubEnv('LLM_PROVIDER', 'Anthropic');
  invalidateMarketPricesCache();
  setObjectStore(memoryStore());
  setMediaDispatcher((_label, create) => create());

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'media-route-sound-'));
  ledger = new FsLedger(tmp);
  setLedger(ledger);
  setGenerationStore({ upsert: async () => undefined, list: async () => [] } as unknown as GenerationStore);

  const projects = new FsProjectStore(path.join(tmp, 'projects'));
  setProjectStore(projects);
  project = await projects.create({ userId: USER.id, name: 'Coins', templateId: 'blank' });

  await ledger.append({ userId: USER.id, delta: 1000, reason: 'grant' });

  // Any outbound call is a failure of the wall under test — the refusal must come before the gateway.
  fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(async () => {
  setMediaDispatcher(undefined);
  setLedger(undefined);
  setGenerationStore(undefined);
  setObjectStore(undefined);
  setProjectStore(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  invalidateMarketPricesCache();
  await fs.rm(tmp, { recursive: true, force: true });
});

async function post(body: Record<string, unknown>) {
  const { action } = await import('~/routes/api.projects.$projectId.media');
  const response = await action({
    request: new Request('http://localhost/api/projects/x/media', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
    params: { projectId: project.id },
    context: {},
  } as never);

  return { status: response.status, data: (await response.json()) as { credits?: number; message?: string } };
}

function onFal() {
  vi.stubEnv('MEDIA_PROVIDER', 'FAL');
  vi.stubEnv('FAL_API_KEY', 'sentinel-fal');
}

const FAL_EFFECT = 'fal-ai/elevenlabs/sound-effects/v2';

describe('a panel sound request outside the gateway limits is refused BEFORE any debit', () => {
  it('refuses a 30 s fal sound effect at START with the 22 s sentence — no debit, no call to fal', async () => {
    onFal();

    const { status, data } = await post({
      action: 'start',
      model: FAL_EFFECT,
      prompt: 'arcade coin pickup chime',
      options: { loop: false },
      durationSeconds: 30,
    });

    expect(status).toBe(422);
    expect(data.message).toMatch(/22 seconds/);
    expect(await ledger.balance(USER.id), 'nothing was debited').toBe(1000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses the same request at QUOTE, so the Generate button never shows a price for it', async () => {
    onFal();

    const { status, data } = await post({ action: 'quote', model: FAL_EFFECT, prompt: '', durationSeconds: 30 });

    expect(status).toBe(422);
    expect(data.message).toMatch(/22 seconds/);
  });

  it('refuses a voice fal does not have, naming the ones it does', async () => {
    onFal();

    const { status, data } = await post({
      action: 'start',
      model: 'fal-ai/elevenlabs/tts/multilingual-v2',
      prompt: 'New lap record!',
      options: { voice: 'EXAVITQu4vr4xnSDxMaL' },
    });

    expect(status).toBe(422);
    expect(data.message).toMatch(/Rachel/);
    expect(await ledger.balance(USER.id)).toBe(1000);
  });

  it('refuses fal music with vocals and no lyrics, at quote and at start', async () => {
    onFal();

    const request = { model: 'fal-ai/minimax-music/v2.6', options: { instrumental: false } };

    for (const action of ['quote', 'start']) {
      const { status, data } = await post({ action, ...request, prompt: 'upbeat retro arcade theme' });

      expect(status, action).toBe(422);
      expect(data.message).toMatch(/lyrics/);
    }

    expect(await ledger.balance(USER.id)).toBe(1000);
  });

  /*
   * CONTROLS. Every refusal above passes for a route that refuses all sound; these prove a valid
   * request on each gateway still prices — and that the fal default length (5 s) is the one quoted.
   */
  it('CONTROL — quotes a valid 5 s fal sound effect (and the empty prompt of a quote is not a refusal)', async () => {
    onFal();

    const { status, data } = await post({ action: 'quote', model: FAL_EFFECT, prompt: '', durationSeconds: 5 });

    expect(status).toBe(200);
    expect(data.credits).toBeGreaterThan(0);

    const noLength = await post({ action: 'quote', model: FAL_EFFECT, prompt: '' });

    expect(noLength.data.credits, 'no length quotes the default, which is 5 s').toBe(data.credits);
  });

  it('CONTROL — quotes fal music WITH lyrics, and KIE sound exactly as before', async () => {
    onFal();

    const music = await post({
      action: 'quote',
      model: 'fal-ai/minimax-music/v2.6',
      prompt: '',
      options: { instrumental: false, lyrics: 'quoted' },
    });

    expect(music.status).toBe(200);

    const speech = await post({
      action: 'quote',
      model: 'fal-ai/elevenlabs/tts/turbo-v2.5',
      prompt: 'New lap record!',
      options: { voice: 'Rachel' },
    });

    expect(speech.status, speech.data.message).toBe(200);

    vi.stubEnv('MEDIA_PROVIDER', 'KIE');
    vi.stubEnv('KIE_API_KEY', 'sentinel-kie');

    // KIE's Suno music needs a public callback (an existing, unrelated rule) — a public one is given.
    vi.stubEnv('MEDIA_CALLBACK_URL', 'https://app.example.com/api/media/callback');
    invalidateMarketPricesCache();

    for (const request of [
      { model: 'suno/generate-sounds', options: { loop: false } },
      { model: 'suno/generate-music', options: { instrumental: true } },
      { model: 'elevenlabs/text-to-speech-multilingual-v2', options: {}, prompt: 'New lap record!' },
    ]) {
      const { status, data } = await post({ action: 'quote', prompt: '', ...request }); // speech prices its text

      expect(status, `${request.model}: ${data.message}`).toBe(200);
    }
  });

  it('leaves image and video requests to the existing rules — the check is for sound only', async () => {
    onFal();

    const { status } = await post({ action: 'quote', model: 'fal-ai/nano-banana-2', options: { resolution: '1K' } });

    expect(status).toBe(200);
  });
});
