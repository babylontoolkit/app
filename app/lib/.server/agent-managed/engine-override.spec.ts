/**
 * The eval-only engine override (`resolveEngineForRequest`, managed-agents-engine plan T11).
 *
 * A browser value that picks the engine is only acceptable on a dev server started for an eval. The
 * dangerous direction is an override honoured in PRODUCTION or on a dev server that never opted in, so
 * both are pinned — each with a CONTROL proving the same override IS honoured once both gates open
 * (otherwise "ignored" passes for a function that ignores everything).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveEngineForRequest } from './engine-select';

const ctx = (vars: Record<string, string | undefined>) => ({ cloudflare: { env: vars } });

describe('resolveEngineForRequest', () => {
  beforeEach(() => {
    // `env()` falls back to process.env (vitest loads .env.local) — scrub both keys.
    vi.stubEnv('AGENT_ENGINE_EVAL_OVERRIDE', undefined as unknown as string);
    vi.stubEnv('NODE_ENV', 'development');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('CONTROL: honours the override on a non-production server that opted in', () => {
    const context = ctx({ AGENT_ENGINE_EVAL_OVERRIDE: 'true', NODE_ENV: 'development' });

    expect(resolveEngineForRequest({ deployEngine: 'legacy', override: 'managed', context })).toBe('managed');
    expect(resolveEngineForRequest({ deployEngine: 'managed', override: 'legacy', context })).toBe('legacy');
  });

  it('ignores the override in production, even with the flag on', () => {
    const context = ctx({ AGENT_ENGINE_EVAL_OVERRIDE: 'true', NODE_ENV: 'production' });

    expect(resolveEngineForRequest({ deployEngine: 'legacy', override: 'managed', context })).toBe('legacy');
    expect(resolveEngineForRequest({ deployEngine: 'managed', override: 'legacy', context })).toBe('managed');
  });

  it('ignores the override in production when NODE_ENV comes from the process', () => {
    vi.stubEnv('NODE_ENV', 'production');

    const context = ctx({ AGENT_ENGINE_EVAL_OVERRIDE: 'true' });

    expect(resolveEngineForRequest({ deployEngine: 'legacy', override: 'managed', context })).toBe('legacy');
  });

  it('ignores the override when the flag is unset', () => {
    const context = ctx({ NODE_ENV: 'development' });

    expect(resolveEngineForRequest({ deployEngine: 'legacy', override: 'managed', context })).toBe('legacy');
    expect(resolveEngineForRequest({ deployEngine: 'managed', override: 'legacy', context })).toBe('managed');
  });

  it('ignores the override unless the flag is exactly "true"', () => {
    for (const flag of ['1', 'yes', 'TRUE', 'false', '']) {
      const context = ctx({ AGENT_ENGINE_EVAL_OVERRIDE: flag, NODE_ENV: 'development' });

      expect(resolveEngineForRequest({ deployEngine: 'legacy', override: 'managed', context })).toBe('legacy');
    }
  });

  it('an unrecognised or absent override resolves to the deploy engine', () => {
    const context = ctx({ AGENT_ENGINE_EVAL_OVERRIDE: 'true', NODE_ENV: 'development' });

    for (const override of [undefined, null, '', 'Managed', 'anthropic', 1, { engine: 'managed' }]) {
      expect(resolveEngineForRequest({ deployEngine: 'legacy', override, context })).toBe('legacy');
      expect(resolveEngineForRequest({ deployEngine: 'managed', override, context })).toBe('managed');
    }
  });
});
