/**
 * Game Backend hard separation (SPEC §4.15, §5).
 *
 * The one thing that must never happen: user game code — which ships a public anon key — scaffolded
 * against the PLATFORM Supabase (accounts, credits, projects). A client that posts our own project ref
 * as its "game backend" must be treated as having NO backend, not as a connected one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPlatformBackend, platformProjectRef, sanitizeGameBackend } from './separation';

const ctx = (url?: string) => ({ cloudflare: { env: url ? { SUPABASE_URL: url } : {} } });

afterEach(() => vi.unstubAllEnvs());

describe('platform project ref', () => {
  it('derives the ref from the platform Supabase URL', () => {
    expect(platformProjectRef(ctx('https://plat4orm.supabase.co'))).toBe('plat4orm');
  });

  it('is null when the platform Supabase is not configured (local dev)', () => {
    expect(platformProjectRef(ctx())).toBeNull();
  });
});

describe('detecting a platform-pointed backend', () => {
  it('flags a claim that is the platform ref', () => {
    expect(isPlatformBackend('plat4orm', ctx('https://plat4orm.supabase.co'))).toBe(true);
  });

  it('flags a claim that is the full platform URL', () => {
    expect(isPlatformBackend('https://plat4orm.supabase.co', ctx('https://plat4orm.supabase.co'))).toBe(true);
  });

  it('allows a genuinely different user backend', () => {
    expect(isPlatformBackend('user1234', ctx('https://plat4orm.supabase.co'))).toBe(false);
  });

  it('does not flag anything when the platform is unconfigured', () => {
    expect(isPlatformBackend('anything', ctx())).toBe(false);
  });
});

describe('sanitising an incoming claim', () => {
  it('passes a real user backend through unchanged', () => {
    const backend = { connected: true, projectRef: 'user1234', rlsConfirmed: true };

    expect(sanitizeGameBackend(backend, ctx('https://plat4orm.supabase.co'))).toEqual(backend);
  });

  it('drops a backend that points at the platform — the safe failure', () => {
    const backend = { connected: true, projectRef: 'plat4orm' };

    expect(sanitizeGameBackend(backend, ctx('https://plat4orm.supabase.co'))).toBeUndefined();
  });

  it('treats a disconnected claim as no backend', () => {
    expect(sanitizeGameBackend({ connected: false }, ctx())).toBeUndefined();
    expect(sanitizeGameBackend(undefined, ctx())).toBeUndefined();
  });
});
