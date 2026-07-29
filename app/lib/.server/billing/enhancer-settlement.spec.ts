/**
 * The prompt enhancer's terminal states (`spec/fail-loud.md`, SPEC §4.6).
 *
 * The enhancer is a paid, KIE-reaching call site with far less machinery around it than a generation,
 * which is exactly why it drifted: it settled every outcome as a success. A stream that errored
 * halfway, or one that finished cheerfully with no text, was logged and CHARGED — the browser got a
 * truncated response, the ledger got a debit, and nothing anywhere said a thing.
 *
 * ⚠️ This spec lives in `billing/`, NOT in `app/routes/` — Remix compiles a spec file there as a route
 * and its manifest imports `vitest` at runtime, which 500s every request.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsLedger, setLedger } from './ledger';
import { setGenerationStore, type GenerationStore, type GenerationUpsert } from './generations';

const USER = 'user-enh';

const streamText = vi.fn();

vi.mock('~/lib/.server/llm/stream-text', () => ({ streamText: (...args: unknown[]) => streamText(...args) }));
vi.mock('~/lib/.server/supabase/auth', () => ({
  requireVerifiedUser: async () => ({ id: USER, email: 'e@example.com', isLocal: false }),
}));
vi.mock('~/lib/.server/licensing/entitlements', () => ({ resolveByok: async () => ({ allowed: false }) }));
vi.mock('~/lib/.server/agent/config', () => ({
  getPlatformModel: () => 'claude-opus-4-8',
  getPlatformProvider: () => 'KIE',
}));

let tmp: string;
let ledger: FsLedger;
let upserts: GenerationUpsert[];

/** A fake `streamText` result: the parts the route consumes, and nothing else. */
function fakeResult(parts: unknown[]) {
  return {
    fullStream: (async function* () {
      for (const part of parts) {
        yield part;
      }
    })(),
    textStream: (async function* () {
      for (const part of parts as Array<{ type: string; textDelta?: string }>) {
        if (part.type === 'text-delta' && part.textDelta) {
          yield part.textDelta;
        }
      }
    })(),
    usage: Promise.resolve({ promptTokens: 4000, completionTokens: 1200 }),
  };
}

async function enhance() {
  const { action } = await import('~/routes/api.enhancer');

  return action({
    request: new Request('http://localhost/api/enhancer', {
      method: 'POST',
      body: JSON.stringify({ message: 'make a racing game' }),
    }),
    context: {},
    params: {},
  } as never);
}

beforeEach(async () => {
  /*
   * The oauth.spec trap: `env()` falls back to `process.env`, and vitest loads `.env.local`.
   *
   * `CREATION_FLAT_CREDITS` is RETIRED (§4.4a) and `getBillingConfig` throws when it is set, so it
   * belongs in this list for a stronger reason than the price vars beside it: leaving it out does not
   * skew an assertion, it kills the settlement path outright on the operator's machine only.
   */
  for (const key of ['BILLING_ENFORCED', 'CREDIT_UNIT_COST_USD', 'CREDIT_MARGIN', 'CREATION_FLAT_CREDITS']) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  vi.stubEnv('BILLING_ENFORCED', 'true');

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'enh-'));
  ledger = new FsLedger(tmp);
  setLedger(ledger);
  await ledger.append({ userId: USER, delta: 1000, reason: 'grant' });

  upserts = [];
  setGenerationStore({
    upsert: async (row: GenerationUpsert) => void upserts.push(row),
    list: async () => [],
  } as unknown as GenerationStore);
});

afterEach(async () => {
  setLedger(undefined);
  setGenerationStore(undefined);
  streamText.mockReset();
  await fs.rm(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('the enhancer settles into exactly one terminal state', () => {
  it('DELIVERED — text streamed, so the charge stands', async () => {
    streamText.mockResolvedValue(fakeResult([{ type: 'text-delta', textDelta: 'a better prompt' }]));

    await enhance();

    await vi.waitFor(() => expect(upserts.length).toBeGreaterThan(0));
    expect(await ledger.balance(USER)).toBeLessThan(1000);
    expect(upserts.every((u) => u.status !== 'failed')).toBe(true);
  });

  it('REFUNDED — a stream error mid-enhancement comes back, and records `failed`', async () => {
    streamText.mockResolvedValue(
      fakeResult([
        { type: 'text-delta', textDelta: 'a bett' },
        { type: 'error', error: new Error('provider exploded') },
      ]),
    );

    await enhance();

    await vi.waitFor(() => expect(upserts.some((u) => u.status === 'failed')).toBe(true));
    expect(await ledger.balance(USER), 'the debit came straight back').toBe(1000);
  });

  /*
   * The proxy's `producedText` rule, one subsystem over: a clean finish with nothing to show is a
   * failure however cheerfully the provider says `stop`. The user pasted a prompt and got an empty
   * textarea back — charging for that is the 316-credit promise in miniature.
   */
  it('REFUNDED — a zero-text finish is a failure, not a cheap success', async () => {
    streamText.mockResolvedValue(fakeResult([{ type: 'step-finish' }]));

    await enhance();

    await vi.waitFor(() => expect(upserts.some((u) => u.status === 'failed')).toBe(true));
    expect(await ledger.balance(USER)).toBe(1000);
  });

  it('REFUSED BEFORE SPEND — an empty balance never reaches the model', async () => {
    await ledger.append({ userId: USER, delta: -1000, reason: 'adjustment' });
    streamText.mockResolvedValue(fakeResult([{ type: 'text-delta', textDelta: 'x' }]));

    const response = (await enhance()) as Response;

    expect(response.status).toBe(402);
    expect(streamText, 'the gate refused before the model was called').not.toHaveBeenCalled();
  });
});
