/**
 * The Unity Bridge routes a browser and a helper actually call (SPEC §4.17, D54, D55).
 *
 * D54 (owner, 2026-09-29): there is NO project link. D55: the dialog's GET reports only the device the
 * agent would drive (the most recently seen present one) and the production origin; the dialog mints a
 * single-use install code (`invite`) and the helper claims it (`claim`) — the only pairing flow. The
 * helper's poll speaks protocol 2 — a protocol-1 helper is told to update (426), because it would still
 * expect a `unityProjectKey` on every dispatch.
 *
 * D58 (owner, 2026-09-29): the per-computer Allow scripts switch is back — on by default, turned in the
 * dialog through `POST /api/bridge/devices {action:'allowScripts'}`, own device only (404 otherwise).
 *
 * ⚠️ Lives here, not in `app/routes/` — Remix compiles a spec in that folder as a route and the
 * manifest then imports `vitest` at runtime, which 500s every request (§4.5.6).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsProjectStore, setProjectStore } from '~/lib/.server/projects/store';
import { MemoryUserRateLimitStore, setUserRateLimitStore } from '~/lib/.server/security/user-rate-limit';
import type { Project } from '~/lib/.server/projects/types';
import { BRIDGE_PROTOCOL_VERSION, type BridgeHello } from '~/lib/bridge/protocol';
import { hashSecret } from './auth';
import { resetBridgeRelayForTests, touchDevice } from './relay';
import { FsBridgeStore, setBridgeStore, type BridgeDeviceRow } from './store';

const USER = { id: 'user-1', email: 'a@example.com', emailVerified: true } as const;

vi.mock('~/lib/.server/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireVerifiedUser: async () => USER,
  requireUser: async () => USER,
}));

const TOKEN = 'btkb_test_token';

let tmp: string;
let store: FsBridgeStore;
let projects: FsProjectStore;
let mine: Project;
let theirs: Project;

const device = (overrides: Partial<BridgeDeviceRow> = {}): BridgeDeviceRow => ({
  id: 'dev_1',
  userId: USER.id,
  name: 'Studio Mac',
  os: 'darwin',
  tokenHash: hashSecret(`${TOKEN}_${overrides.id ?? 'dev_1'}`),
  createdAt: '2026-09-29T00:00:00.000Z',
  ...overrides,
});

const hello = (overrides: Partial<BridgeHello> = {}): BridgeHello => ({
  protocol: BRIDGE_PROTOCOL_VERSION,
  helperVersion: '2.0.0',
  os: 'darwin',
  projectsDir: 'Unity',
  unityProjects: [{ key: 'k1', name: 'Racer' }],
  currentProject: 'Racer',
  scriptsDisabledLocally: false,
  ...overrides,
});

beforeEach(async () => {
  vi.stubEnv('UNITY_BRIDGE_ENABLED', undefined as unknown as string);
  vi.stubEnv('APP_URL', undefined as unknown as string);
  setUserRateLimitStore(new MemoryUserRateLimitStore());
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-routes-'));
  store = new FsBridgeStore(path.join(tmp, 'bridge'));
  setBridgeStore(store);
  projects = new FsProjectStore(path.join(tmp, 'projects'));
  setProjectStore(projects);
  mine = await projects.create({ userId: USER.id, name: 'Mine', templateId: 'racing' });
  theirs = await projects.create({ userId: 'someone-else', name: 'Theirs', templateId: 'racing' });
  resetBridgeRelayForTests();
});

afterEach(async () => {
  resetBridgeRelayForTests();
  setBridgeStore(null);
  setProjectStore(undefined);
  setUserRateLimitStore(undefined);
  vi.unstubAllEnvs();
  await fs.rm(tmp, { recursive: true, force: true });
});

async function getStatus(projectId: string) {
  const { loader } = await import('~/routes/api.projects.$projectId.bridge');
  return loader({
    request: new Request('http://localhost/api/projects/x/bridge'),
    params: { projectId },
    context: {},
  } as never);
}

async function postJson(route: 'api.bridge.devices' | 'api.bridge.pair', body: unknown, ip = '203.0.113.7') {
  const mod = (await import(`~/routes/${route}.ts`)) as { action: (args: never) => Promise<Response> };

  return mod.action({
    request: new Request(`http://localhost/${route}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    }),
    params: {},
    context: {},
  } as never);
}

const invite = async () =>
  (await (await postJson('api.bridge.devices', { action: 'invite' })).json()) as {
    code: string;
    expiresAt: string;
  };

const claim = (code: string, deviceName = 'Studio Mac', osName = 'darwin') =>
  postJson('api.bridge.pair', { action: 'claim', code, deviceName, os: osName });

async function poll(body: unknown, token = `${TOKEN}_dev_1`) {
  const { action } = await import('~/routes/api.bridge.poll');
  const controller = new AbortController();
  const pending = action({
    request: new Request('http://localhost/api/bridge/poll', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      signal: controller.signal,
    }),
    params: {},
    context: {},
  } as never);

  // A healthy poll parks for up to 25 s; release it so the test never waits on the hold.
  setTimeout(() => controller.abort(), 20);

  return pending;
}

describe('GET /api/projects/:projectId/bridge', () => {
  it('no devices → exactly {enabled, state:unpaired, productionOrigin:null} — no devices, jobs or link', async () => {
    const view = (await (await getStatus(mine.id)).json()) as Record<string, unknown>;

    expect(view).toEqual({ enabled: true, state: 'unpaired', productionOrigin: null });
  });

  it('productionOrigin is the ORIGIN of APP_URL (path and trailing slash dropped); garbage → null', async () => {
    vi.stubEnv('APP_URL', 'https://app.example.com/some/path/');
    expect(((await (await getStatus(mine.id)).json()) as { productionOrigin: unknown }).productionOrigin).toBe(
      'https://app.example.com',
    );

    vi.stubEnv('APP_URL', 'not a url');
    expect(((await (await getStatus(mine.id)).json()) as { productionOrigin: unknown }).productionOrigin).toBeNull();
  });

  it('a paired device that is not polling → offline, naming it; its id and Allow scripts (on — the D58 default), never a token hash', async () => {
    await store.putDevice(device());

    const view = (await (await getStatus(mine.id)).json()) as {
      state: string;
      device: Record<string, unknown>;
    };

    expect(view.state).toBe('offline');
    expect(view.device).toMatchObject({ id: 'dev_1', name: 'Studio Mac', online: false, allowScripts: true });
    expect(Object.keys(view.device).sort()).toEqual(['allowScripts', 'id', 'name', 'online']);
  });

  it('the device view reports the Allow scripts switch once the user turns it off (D58)', async () => {
    await store.putDevice(device());
    await store.setDeviceAllowScripts('dev_1', false);

    const view = (await (await getStatus(mine.id)).json()) as { device: { allowScripts: boolean } };

    expect(view.device.allowScripts).toBe(false);
  });

  it('a present device → online, with the helper hello (projects folder, projects, current)', async () => {
    await store.putDevice(device());
    touchDevice('dev_1', hello());

    const view = (await (await getStatus(mine.id)).json()) as {
      state: string;
      device: { online: boolean; hello: BridgeHello };
    };

    expect(view.state).toBe('online');
    expect(view.device.online).toBe(true);
    expect(view.device.hello).toMatchObject({ projectsDir: 'Unity', currentProject: 'Racer' });
  });

  it('a disabled bridge still answers 200 with enabled:false', async () => {
    vi.stubEnv('UNITY_BRIDGE_ENABLED', 'false');

    const response = await getStatus(mine.id);

    expect(response.status).toBe(200);
    expect(((await response.json()) as { enabled: boolean }).enabled).toBe(false);
  });

  it("someone else's project → 404, not 403", async () => {
    expect((await getStatus(theirs.id)).status).toBe(404);
  });

  it('the route has no POST action (the Allow scripts switch posts to /api/bridge/devices, D58)', async () => {
    const mod = (await import('~/routes/api.projects.$projectId.bridge')) as Record<string, unknown>;

    expect(mod.action).toBeUndefined();
    expect(typeof mod.loader).toBe('function'); // CONTROL
  });
});

describe('install codes: POST /api/bridge/devices {invite} → POST /api/bridge/pair {claim}', () => {
  it('invite → XXXX-XXXX; claim → {deviceId, token} once, for the inviting user', async () => {
    const { code, expiresAt } = await invite();

    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());

    const response = await claim(code);
    const body = (await response.json()) as { deviceId: string; token: string };

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body.token).toMatch(/^btkb_/);
    expect((await store.getDevice(body.deviceId))?.userId).toBe(USER.id);
  });

  it('is single use: the same code again → 410 with the copy-a-fresh-command sentence', async () => {
    const { code } = await invite();
    await claim(code);

    const again = await claim(code, 'Other PC', 'win32');

    expect(again.status).toBe(410);
    expect(((await again.json()) as { message: string }).message).toBe(
      'That install code is not valid or has expired. Copy a fresh command from the Unity Bridge dialog.',
    );
  });

  it('an unknown code → 410; a 6th computer → 409', async () => {
    expect((await claim('ZZZZ-ZZZZ')).status).toBe(410);

    for (let i = 0; i < 5; i++) {
      await store.putDevice(device({ id: `dev_${i}`, name: `pc${i}` }));
    }

    const { code } = await invite();
    expect((await claim(code, 'sixth', 'linux')).status).toBe(409);
  });

  it('invite is rate-limited per user: the 11th in 10 minutes → 429', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await postJson('api.bridge.devices', { action: 'invite' })).status).toBe(200);
    }

    expect((await postJson('api.bridge.devices', { action: 'invite' })).status).toBe(429);
  });

  it('claim validates its body (400) and refuses the removed start/redeem actions and approve', async () => {
    const { code } = await invite();

    expect((await postJson('api.bridge.pair', { action: 'claim', code, os: 'darwin' })).status).toBe(400);
    expect((await postJson('api.bridge.pair', { action: 'claim', code, deviceName: 'x', os: 'beos' })).status).toBe(
      400,
    );
    expect((await postJson('api.bridge.pair', { action: 'start', deviceName: 'x', os: 'darwin' })).status).toBe(400);
    expect((await postJson('api.bridge.pair', { action: 'redeem', pairingId: 'p', secret: 's' })).status).toBe(400);
    expect((await postJson('api.bridge.devices', { action: 'approve', code })).status).toBe(400);
  });
});

describe("POST /api/bridge/devices {action:'allowScripts'} (D58)", () => {
  const toggle = (deviceId: unknown, value: unknown) =>
    postJson('api.bridge.devices', { action: 'allowScripts', deviceId, value });

  it('the caller turns their own device on and off; the response and the store agree', async () => {
    await store.putDevice(device());

    const on = await toggle('dev_1', true);

    expect(on.status).toBe(200);
    expect(on.headers.get('Cache-Control')).toBe('no-store');
    expect(await on.json()).toEqual({ device: { id: 'dev_1', allowScripts: true } });
    expect((await store.getDevice('dev_1'))?.allowScripts).toBe(true);

    const off = await toggle('dev_1', false);

    expect(await off.json()).toEqual({ device: { id: 'dev_1', allowScripts: false } });
    expect((await store.getDevice('dev_1'))?.allowScripts).toBe(false);
  });

  it("someone else's device, an unknown id and a removed device → 404 (never 403), and nothing changes", async () => {
    await store.putDevice(device({ id: 'dev_other', userId: 'someone-else' }));
    await store.putDevice(device({ id: 'dev_gone', revokedAt: '2026-09-29T01:00:00.000Z' }));

    expect((await toggle('dev_other', true)).status).toBe(404);
    expect((await toggle('dev_missing', true)).status).toBe(404);
    expect((await toggle('dev_gone', true)).status).toBe(404);
    expect((await store.getDevice('dev_other'))?.allowScripts).toBeUndefined();
    expect((await store.getDevice('dev_gone'))?.allowScripts).toBeUndefined();
  });

  it('a value that is not a boolean → 400 (never coerced: "false" is truthy), and the switch stays off', async () => {
    await store.putDevice(device());

    for (const value of ['true', 'false', 1, null, undefined]) {
      expect((await toggle('dev_1', value)).status).toBe(400);
    }

    expect((await store.getDevice('dev_1'))?.allowScripts).toBeUndefined();
  });

  it('GET /api/bridge/devices lists allowScripts per device', async () => {
    await store.putDevice(device());
    await store.setDeviceAllowScripts('dev_1', true);

    const { loader } = await import('~/routes/api.bridge.devices');
    const response = await loader({
      request: new Request('http://localhost/api/bridge/devices'),
      params: {},
      context: {},
    } as never);
    const body = (await response.json()) as { devices: Array<{ id: string; allowScripts: boolean }> };

    expect(body.devices).toEqual([expect.objectContaining({ id: 'dev_1', allowScripts: true })]);
  });
});

describe('POST /api/bridge/poll', () => {
  it('a protocol-1 hello → 426 telling the user to update the Desktop Agent', async () => {
    await store.putDevice(device());

    const response = await poll({ hello: hello({ protocol: 1 }) });

    expect(response.status).toBe(426);
    expect(((await response.json()) as { message: string }).message).toMatch(/bt-agent update/);
  });

  it('a protocol-2 hello is accepted and persisted', async () => {
    await store.putDevice(device());

    const response = await poll({ hello: hello() });

    expect(response.status).toBe(200);

    const row = await store.getDevice('dev_1');
    expect(row?.capabilities?.projectsDir).toBe('Unity');
    expect(row?.name).toBe('Studio Mac');
  });
});
