/**
 * ADOPTING A NEW MODEL IS CONFIG, NEVER CODE (owner, 2026-09-29).
 *
 * *"what happens when i deploy app and six month later i wanna use the new model… do i have do thru all
 * this"* — no. The whole path is: add the model's price row in Settings → Admin → Marketplace prices,
 * promote, then point `LLM_MODEL` / `PREMIUM_MODEL` / `PLATINUM_MODEL` at it. These tests pin every
 * seam that used to force a source edit instead:
 *
 *  1. Anthropic's prices were a hardcoded table (`MODEL_RATES`) — now a promotable list.
 *  2. A paid rung had to be priced by KIE's list, even on a deploy that never uses KIE.
 *  3. The provider picker gated on the STANDARD model, so a rung naming a model only some gateways sell
 *     could be routed to one that does not sell it.
 *  4. `canDisableThinking` was a deny-list, so an unknown model was sent `thinking: disabled` on the
 *     last retry — a hard 400 on every model of the 5.5 / 5.1 generation.
 *
 * Every model id below that is not a real Anthropic model is deliberately fictional (`claude-opus-9`),
 * because the property under test is "a model nobody has written code for".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anthropicRates, getModelTier, MODEL_RATES, providerRates } from './rates';
import { BAKED_ANTHROPIC_PRICES } from './baked-anthropic-prices';
import { invalidateMarketPricesCache, promoteMarketPrices } from './market-price-store';
import { getPlatformModel, resolvePlatformProvider } from '~/lib/.server/agent/config';
import { canDisableThinking } from '~/lib/modules/llm/capabilities';
import type { ObjectStore } from '~/lib/.server/storage';

/** Every variable that can decide a model, a rung, a gateway or a price — `.env.local` must not leak in. */
const ENV = [
  'LLM_MODEL',
  'LLM_PROVIDER',
  'LLM_PROVIDER_CHAIN',
  'AUTO_MODEL_SELECT',
  'KIE_DEFAULT_MODEL',
  'KIE_API_KEY',
  'COMET_API_KEY',
  'ANTHROPIC_API_KEY',
  'PREMIUM_MODEL',
  'PREMIUM_MINIMUM_CREDITS',
  'PLATINUM_MODEL',
  'PLATINUM_MINIMUM_CREDITS',
  'ENABLE_EXTENDED_MODELS',
  'ENABLE_PLATINUM_MODEL',
  'ENABLE_PREMIUM_MODEL',
  'SUPERMAX_MODEL',
  'SUPERMAX_MINIMUM_CREDITS',
  'PREMIUM_INPUT_DOLLARS',
  'PREMIUM_OUTPUT_DOLLARS',
  'KIE_INPUT_DOLLARS',
  'KIE_OUTPUT_DOLLARS',
  'KIE_CACHED_INPUT',
  'KIE_CACHED_WRITES',
] as const;

function stubEnv(vars: Partial<Record<(typeof ENV)[number], string>> = {}) {
  for (const key of ENV) {
    vi.stubEnv(key, (vars[key] ?? undefined) as unknown as string);
  }
}

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

/** Promote the baked Anthropic list plus `extra` rows, exactly as the Admin panel would. */
async function promoteAnthropic(extra: Record<string, { inputPerMTok: number; outputPerMTok: number }>) {
  const result = await promoteMarketPrices(memoryStore(), 'Anthropic', {
    ...BAKED_ANTHROPIC_PRICES,
    llm: { ...BAKED_ANTHROPIC_PRICES.llm, ...extra },
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
}

beforeEach(() => {
  invalidateMarketPricesCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  invalidateMarketPricesCache();
});

describe('1. Anthropic prices come from a promotable list', () => {
  it('prices a model added ONLY in the Admin panel, and LLM_MODEL accepts it — no code', async () => {
    stubEnv({ LLM_PROVIDER: 'Anthropic', LLM_MODEL: 'claude-opus-9' });

    // CONTROL: before the promotion the model is unknown, and the platform refuses it loudly.
    expect(() => getPlatformModel({})).toThrow(/Marketplace prices/);

    await promoteAnthropic({ 'claude-opus-9': { inputPerMTok: 6, outputPerMTok: 30 } });

    expect(getPlatformModel({})).toBe('claude-opus-9');
    expect(providerRates({}).Anthropic['claude-opus-9']).toEqual({
      inputPerMTok: 6,
      outputPerMTok: 30,
      cacheReadPerMTok: 0.6000000000000001,
      cacheWritePerMTok: 12,
    });
  });

  it('keeps a baked row’s EXACT vendor cache rates while its price is unchanged', () => {
    stubEnv();

    // Opus 5.5 reads cache at $0.20 (0.05x), not the family's derived 0.1x ($0.40).
    expect(anthropicRates({})['claude-opus-5-5'].cacheReadPerMTok).toBe(0.2);
    expect(anthropicRates({})['claude-fable-5-1'].cacheReadPerMTok).toBe(0.25);
    expect(anthropicRates({})['claude-opus-5-5']).toEqual(MODEL_RATES['claude-opus-5-5']);
  });

  it('derives cache again once an operator REPRICES a baked row (the exact numbers are for the old price)', async () => {
    stubEnv();
    await promoteAnthropic({ 'claude-opus-5-5': { inputPerMTok: 5, outputPerMTok: 25 } });

    const rates = anthropicRates({})['claude-opus-5-5'];
    expect(rates.inputPerMTok).toBe(5);
    expect(rates.cacheReadPerMTok).toBeCloseTo(0.5, 9);
    expect(rates.cacheWritePerMTok).toBeCloseTo(10, 9);
  });
});

describe('2. a paid rung may be priced by ANY provider’s list', () => {
  it('accepts PLATINUM_MODEL=claude-fable-5-1, which KIE does not sell', () => {
    stubEnv({ PLATINUM_MODEL: 'claude-fable-5-1' });

    const tier = getModelTier('platinum', {});
    expect(tier.model).toBe('claude-fable-5-1');

    // The gap-fill price is the MOST EXPENSIVE list's (Anthropic $10/$50 over Comet $8/$40).
    expect(tier.rates.outputPerMTok).toBe(50);
  });

  it('accepts a brand-new model promoted onto the Anthropic list alone', async () => {
    stubEnv({ PLATINUM_MODEL: 'claude-fable-9' });

    // CONTROL: nothing prices it yet, so the rung is refused rather than guessed.
    expect(() => getModelTier('platinum', {})).toThrow(/Marketplace prices/);

    await promoteAnthropic({ 'claude-fable-9': { inputPerMTok: 12, outputPerMTok: 60 } });
    expect(getModelTier('platinum', {}).model).toBe('claude-fable-9');
  });
});

describe('3. a paid turn is routed to a gateway that SELLS its model', () => {
  const chain = {
    AUTO_MODEL_SELECT: 'true',
    LLM_PROVIDER: 'KIE',
    LLM_PROVIDER_CHAIN: 'KIE,Comet,Anthropic',
    KIE_API_KEY: 'k',
    COMET_API_KEY: 'c',
    ANTHROPIC_API_KEY: 'a',
    LLM_MODEL: 'claude-opus-5-5',
    PLATINUM_MODEL: 'claude-fable-5-1',
  } as const;

  it('keeps a Standard turn on the head of the chain', () => {
    stubEnv(chain);
    expect(resolvePlatformProvider({}, 0)).toBe('KIE');
  });

  it('moves a Platinum turn past KIE, which does not sell Fable 5.1', () => {
    stubEnv(chain);
    expect(resolvePlatformProvider({}, 0, 'claude-fable-5-1')).toBe('Comet');
  });

  it('falls back to the standard gate when NO gateway sells the rung’s model', () => {
    stubEnv(chain);
    expect(resolvePlatformProvider({}, 0, 'claude-nobody-sells-this')).toBe('KIE');
  });
});

describe('4. an unknown model is never sent thinking: disabled', () => {
  it.each(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-9'])(
    '%s cannot disable thinking at any effort',
    (model) => {
      for (const effort of ['medium', 'high', 'xhigh', 'max'] as const) {
        expect(canDisableThinking(model, effort), `${model} @ ${effort}`).toBe(false);
      }
    },
  );

  it('CONTROL: the models known to accept it still do, dated ids included', () => {
    expect(canDisableThinking('claude-opus-4-8', 'max')).toBe(true);
    expect(canDisableThinking('claude-sonnet-5', 'high')).toBe(true);
    expect(canDisableThinking('claude-opus-4-8-20260101', 'high')).toBe(true);
  });

  it('keeps Opus 5’s effort ceiling', () => {
    expect(canDisableThinking('claude-opus-5', 'high')).toBe(true);
    expect(canDisableThinking('claude-opus-5', 'xhigh')).toBe(false);
  });

  it('never lets an older model’s prefix speak for a newer one', () => {
    expect(canDisableThinking('claude-sonnet-5', 'medium')).toBe(true);
    expect(canDisableThinking('claude-sonnet-5-5', 'medium')).toBe(false);
  });
});
