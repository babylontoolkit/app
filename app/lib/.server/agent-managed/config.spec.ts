/**
 * The engine default and the test network wall (`config.ts`, managed-agents-engine plan T12, D9).
 *
 * `resolveAgentEngine` decides which loop runs EVERY build turn on a deploy, and its failure modes are
 * silent: a kill switch that does not switch, or a default that quietly reverts. `getManagedClient`'s
 * VITEST guard is what stops a spec that forgot to pin the engine from spending real money through the
 * `.env.local` key that vitest loads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getManagedClient, getManagedEngineConfig, resolveAgentEngine, setManagedClientForTests } from './config';

const ctx = (vars: Record<string, string>) => ({ cloudflare: { env: vars } });

beforeEach(() => {
  // `env()` falls back to process.env, which vitest fills from `.env.local` — scrub the var under test.
  vi.stubEnv('AGENT_ENGINE', undefined as unknown as string);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setManagedClientForTests(undefined);
});

describe('resolveAgentEngine — Anthropic Managed Agents is the only engine (2026-10-03)', () => {
  it('unset → managed', () => {
    expect(resolveAgentEngine(ctx({}))).toBe('managed');
  });

  it('no context at all → managed', () => {
    expect(resolveAgentEngine(undefined)).toBe('managed');
  });

  it('"managed" → managed', () => {
    expect(resolveAgentEngine(ctx({ AGENT_ENGINE: 'managed' }))).toBe('managed');
  });

  /* The old kill switch is gone: `legacy` (any spelling, either env source) still runs managed. */
  it.each(['legacy', ' legacy ', 'LEGACY'])('%j → managed (the kill switch was removed)', (value) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(resolveAgentEngine(ctx({ AGENT_ENGINE: value }))).toBe('managed');
  });

  it('the process env cannot select the old engine either', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('AGENT_ENGINE', 'legacy');
    expect(resolveAgentEngine(ctx({}))).toBe('managed');
  });

  it('a set non-managed value warns ONCE per value, naming it (a stale env line must surface somewhere)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const value = `legacy-${Math.random().toString(36).slice(2)}`;

    expect(resolveAgentEngine(ctx({ AGENT_ENGINE: value }))).toBe('managed');
    expect(resolveAgentEngine(ctx({ AGENT_ENGINE: value }))).toBe('managed');

    const calls = warn.mock.calls.filter((args) => String(args[0]).includes(value));
    expect(calls).toHaveLength(1);
    expect(String(calls[0][0])).toMatch(/ignored/);
  });

  it('CONTROL: unset and "managed" never warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    resolveAgentEngine(ctx({}));
    resolveAgentEngine(ctx({ AGENT_ENGINE: 'managed' }));

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('getManagedClient — the test network wall', () => {
  it('throws under vitest when no fake was injected, even with a key configured', () => {
    expect(() => getManagedClient(ctx({ ANTHROPIC_API_KEY: 'sk-test-not-real' }))).toThrow(
      /reached the real Managed Agents client/,
    );
  });

  it('CONTROL: an injected fake is returned (the wall does not block the seam specs use)', () => {
    const fake = {} as unknown as Parameters<typeof setManagedClientForTests>[0];
    setManagedClientForTests(fake);
    expect(getManagedClient(ctx({}))).toBe(fake);
  });
});

describe('getManagedEngineConfig — MANAGED_AGENT_EFFORT (effort-selector T3, D8)', () => {
  const effortOf = (value: string | undefined) =>
    getManagedEngineConfig(
      ctx({ ANTHROPIC_API_KEY: 'sk-test-not-real', ...(value === undefined ? {} : { MANAGED_AGENT_EFFORT: value }) }),
    ).effort;

  beforeEach(() => {
    vi.stubEnv('MANAGED_AGENT_EFFORT', undefined as unknown as string);
  });

  it('unset → medium', () => {
    expect(effortOf(undefined)).toBe('medium');
  });

  it('every EffortLevel is honoured — xhigh and max no longer collapse to medium', () => {
    expect(effortOf('medium')).toBe('medium');
    expect(effortOf('high')).toBe('high');
    expect(effortOf('xhigh')).toBe('xhigh');
    expect(effortOf('max')).toBe('max');
    expect(effortOf(' MAX ')).toBe('max');
  });

  it('low clamps to medium WITH a warning naming MANAGED_AGENT_EFFORT', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(effortOf('low')).toBe('medium');
    expect(warn.mock.calls.some((args) => String(args[0]).includes('MANAGED_AGENT_EFFORT=low'))).toBe(true);
  });

  it('garbage → medium (with a warning)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(effortOf('turbo')).toBe('medium');
    expect(warn).toHaveBeenCalled();
  });
});
