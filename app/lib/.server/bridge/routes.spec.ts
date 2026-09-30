/**
 * The Unity Bridge routes a browser and a helper actually call (SPEC §4.17, D54).
 *
 * D54 (owner, 2026-09-29): there is NO project link. The panel's GET reports the user's devices and the
 * one the agent would drive (the most recently seen present device); "Allow scripts" is a switch on the
 * DEVICE, posted with its id; and the helper's poll speaks protocol 2 — a protocol-1 helper is told to
 * update (426), because it would still expect a `unityProjectKey` on every dispatch.
 *
 * ⚠️ Lives here, not in `app/routes/` — Remix compiles a spec in that folder as a route and the
 * manifest then imports `vitest` at runtime, which 500s every request (§4.5.6).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsProjectStore, setProjectStore } from '~/lib/.server/projects/store';
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

async function post(projectId: string, body: unknown) {
  const { action } = await import('~/routes/api.projects.$projectId.bridge');
  return action({
    request: new Request('http://localhost/api/projects/x/bridge', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
    params: { projectId },
    context: {},
  } as never);
}

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
  it('no devices → unpaired, no device, and no link field at all', async () => {
    const view = (await (await getStatus(mine.id)).json()) as Record<string, unknown>;

    expect(view).toMatchObject({ enabled: true, state: 'unpaired', device: null, devices: [], jobs: [] });
    expect(view).not.toHaveProperty('link');
  });

  it('a paired device that is not polling → offline, naming it with its allowScripts', async () => {
    await store.putDevice(device({ allowScripts: true }));

    const view = (await (await getStatus(mine.id)).json()) as {
      state: string;
      device: { id: string; allowScripts: boolean; online: boolean };
    };

    expect(view.state).toBe('offline');
    expect(view.device).toMatchObject({ id: 'dev_1', allowScripts: true, online: false });
  });

  it('a present device → online, with the helper hello (projects folder, projects, current)', async () => {
    await store.putDevice(device());
    touchDevice('dev_1', hello());

    const view = (await (await getStatus(mine.id)).json()) as {
      state: string;
      device: { id: string; hello: BridgeHello };
    };

    expect(view.state).toBe('online');
    expect(view.device.hello).toMatchObject({ projectsDir: 'Unity', currentProject: 'Racer' });
  });

  it("someone else's project → 404, not 403", async () => {
    expect((await getStatus(theirs.id)).status).toBe(404);
  });
});

describe('POST /api/projects/:projectId/bridge', () => {
  it('allowScripts {deviceId, value:true} writes the DEVICE row, and false switches it back off', async () => {
    await store.putDevice(device());

    expect((await post(mine.id, { action: 'allowScripts', deviceId: 'dev_1', value: true })).status).toBe(200);
    expect((await store.getDevice('dev_1'))?.allowScripts).toBe(true);

    expect((await post(mine.id, { action: 'allowScripts', deviceId: 'dev_1', value: false })).status).toBe(200);
    expect((await store.getDevice('dev_1'))?.allowScripts).toBe(false);
  });

  it('allowScripts with a string "true" does not switch scripts on (only a real boolean does)', async () => {
    await store.putDevice(device());

    await post(mine.id, { action: 'allowScripts', deviceId: 'dev_1', value: 'true' });
    expect((await store.getDevice('dev_1'))?.allowScripts).toBe(false);
  });

  it("allowScripts on another user's, a revoked, or a missing device → 404 and nothing written", async () => {
    await store.putDevice(device({ id: 'dev_theirs', userId: 'someone-else' }));
    await store.putDevice(device({ id: 'dev_revoked', revokedAt: '2026-09-29T01:00:00.000Z' }));

    expect((await post(mine.id, { action: 'allowScripts', deviceId: 'dev_theirs', value: true })).status).toBe(404);
    expect((await post(mine.id, { action: 'allowScripts', deviceId: 'dev_revoked', value: true })).status).toBe(404);
    expect((await post(mine.id, { action: 'allowScripts', value: true })).status).toBe(404);
    expect((await store.getDevice('dev_theirs'))?.allowScripts).toBeFalsy();
    expect((await store.getDevice('dev_revoked'))?.allowScripts).toBeFalsy();
  });

  it.each(['link', 'unlink'])('the removed %s action → 400 Unknown action', async (action) => {
    await store.putDevice(device());

    const response = await post(mine.id, { action, deviceId: 'dev_1', unityProjectKey: 'k1' });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toBe('Unknown action.');
  });
});

describe('POST /api/bridge/poll', () => {
  it('a protocol-1 hello → 426 telling the user to update the Desktop Agent', async () => {
    await store.putDevice(device());

    const response = await poll({ hello: hello({ protocol: 1 }) });

    expect(response.status).toBe(426);
    expect(((await response.json()) as { message: string }).message).toMatch(/bt-agent update/);
  });

  it("a protocol-2 hello is accepted and persisted without losing the device's allowScripts", async () => {
    await store.putDevice(device({ allowScripts: true }));

    const response = await poll({ hello: hello() });

    expect(response.status).toBe(200);

    const row = await store.getDevice('dev_1');
    expect(row?.capabilities?.projectsDir).toBe('Unity');
    expect(row?.allowScripts).toBe(true);
  });
});
