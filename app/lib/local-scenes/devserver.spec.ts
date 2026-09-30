import { describe, expect, it, vi } from 'vitest';
import { checkDevServer } from './devserver';

const ORIGIN = 'http://localhost:8888';

function fetchWith(cors: 'ok' | 'throw', noCors: 'ok' | 'throw') {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const outcome = init?.mode === 'no-cors' ? noCors : cors;

    if (outcome === 'throw') {
      throw new TypeError('Failed to fetch');
    }

    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
}

function permissionsWith(query: (d: { name: string }) => Promise<{ state: string }>) {
  return { query: vi.fn(query) } as unknown as Permissions;
}

describe('checkDevServer', () => {
  it('cors resolves → running (whatever the status)', async () => {
    const f = fetchWith('ok', 'ok');

    expect(await checkDevServer(ORIGIN, { fetch: f })).toBe('running');
    expect(f).toHaveBeenCalledWith(`${ORIGIN}/`, { mode: 'cors', cache: 'no-store' });
  });

  it('cors throws & no-cors resolves → old-exporter', async () => {
    expect(await checkDevServer(ORIGIN, { fetch: fetchWith('throw', 'ok') })).toBe('old-exporter');
  });

  it('both throw & loopback-network denied → blocked', async () => {
    const permissions = permissionsWith(async ({ name }) => ({
      state: name === 'loopback-network' ? 'denied' : 'prompt',
    }));

    expect(await checkDevServer(ORIGIN, { fetch: fetchWith('throw', 'throw'), permissions })).toBe('blocked');
  });

  it('both throw & permissions query throws → not-running', async () => {
    const permissions = permissionsWith(async () => {
      throw new TypeError('unknown permission');
    });

    expect(await checkDevServer(ORIGIN, { fetch: fetchWith('throw', 'throw'), permissions })).toBe('not-running');
  });

  it('CONTROL: both throw & permission granted → not-running, not blocked', async () => {
    const permissions = permissionsWith(async () => ({ state: 'granted' }));

    expect(await checkDevServer(ORIGIN, { fetch: fetchWith('throw', 'throw'), permissions })).toBe('not-running');
  });
});
