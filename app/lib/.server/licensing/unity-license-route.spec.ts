/**
 * The Unity Project Licenser route (SPEC §4.18, §4.5.3) — link / unlink / generate / status.
 *
 * Two walls, as everywhere a project is touched: a verified session (`requireVerifiedUser`) AND proof
 * that this user owns THIS project (`requireOwnedProject`, 404-not-403). Generation is now a FLAT credit
 * charge per SELECTED tier (the §4.18 ladder), charged once per (Unity project, tier) and free after —
 * the tier is a server-validated selection, no longer derived from a Stripe plan. The generated license
 * is server-derived end to end: `licensee` is the verified email and `product` is the linked Unity id,
 * so a `unityProjectId`/`tier` a client puts in the body is either ignored or validated, never trusted.
 *
 * Route tests live BESIDE the code, never under `app/routes/` — a spec there is compiled as a route and
 * 500s every request (the manifest imports vitest at runtime).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsProjectStore, setProjectStore } from '~/lib/.server/projects/store';
import { FsLedger, setLedger } from '~/lib/.server/billing/ledger';
import { resetLicenseEntitlementStoreForTests } from '~/lib/.server/licensing/license-entitlements';
import type { AuthUser } from '~/lib/.server/supabase/auth';
import type { Project } from '~/lib/.server/projects/types';

const USER: AuthUser = {
  id: 'user-1',
  email: 'creator@example.com',
  emailVerified: true,
  displayName: 'Creator',
  isAdmin: false,
  isLocal: false,
};

// A mutable "who is signed in" — null exercises the 401 path.
let currentUser: AuthUser | null = USER;

vi.mock('~/lib/.server/supabase/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/.server/supabase/auth')>();
  const authed = async () => {
    if (!currentUser) {
      throw new actual.UnauthorizedError();
    }

    return currentUser;
  };

  return { ...actual, requireVerifiedUser: authed, requireUser: authed };
});

const GUID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'; // 32 hex
const GUID_OTHER = '0011223344556677889900aabbccddee';

let tmp: string;
let projects: FsProjectStore;
let ledger: FsLedger;
let mine: Project;
let theirs: Project;

beforeEach(async () => {
  // FS backends only (never Supabase / real .data/); unmetered by default so generate never blocks.
  vi.stubEnv('SUPABASE_URL', undefined as unknown as string);
  vi.stubEnv('SUPABASE_ANON_KEY', undefined as unknown as string);
  vi.stubEnv('BILLING_ENFORCED', undefined as unknown as string);

  for (const key of [
    'UNITY_LICENSE_CREDITS_INDIE',
    'UNITY_LICENSE_CREDITS_SMALLBUSINESS',
    'UNITY_LICENSE_CREDITS_PREMIUMCONTENT',
  ]) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'unity-license-route-'));
  vi.stubEnv('PLATFORM_DATA_DIR', tmp);

  projects = new FsProjectStore(path.join(tmp, 'projects'));
  setProjectStore(projects);

  ledger = new FsLedger(path.join(tmp, 'ledger'));
  setLedger(ledger);
  resetLicenseEntitlementStoreForTests();

  mine = await projects.create({ userId: USER.id, name: 'My Racer', templateId: 'racing' });
  theirs = await projects.create({ userId: 'someone-else', name: 'Theirs', templateId: 'racing' });

  currentUser = USER;
});

afterEach(async () => {
  setProjectStore(undefined);
  setLedger(undefined);
  resetLicenseEntitlementStoreForTests();
  await fs.rm(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const loadRoute = async (projectId: string) => {
  const { loader } = await import('~/routes/api.projects.$projectId.unity-license');
  return loader({
    request: new Request('https://app.example.com/x'),
    params: { projectId },
    context: {},
  } as never);
};

const postRoute = async (projectId: string, body: unknown, method = 'POST') => {
  const { action } = await import('~/routes/api.projects.$projectId.unity-license');
  return action({
    request: new Request('https://app.example.com/x', { method, body: JSON.stringify(body) }),
    params: { projectId },
    context: {},
  } as never);
};

describe('the two walls', () => {
  it('401s on both loader and action when unauthenticated', async () => {
    currentUser = null;

    expect((await loadRoute(mine.id)).status).toBe(401);
    expect((await postRoute(mine.id, { action: 'unlink' })).status).toBe(401);
  });

  it("404s (never 403) for someone else's project — loader and action", async () => {
    expect((await loadRoute(theirs.id)).status).toBe(404);
    expect((await postRoute(theirs.id, { action: 'unlink' })).status).toBe(404);
  });

  it('404s identically for a project that does not exist', async () => {
    expect((await loadRoute('prj_nope')).status).toBe(404);
    expect((await postRoute('prj_nope', { action: 'unlink' })).status).toBe(404);
  });
});

describe('loader status', () => {
  it('returns { linkedUnityProjectId, tiers } with the ladder for the linked project', async () => {
    await postRoute(mine.id, { action: 'link', unityProjectId: GUID });

    const body = (await (await loadRoute(mine.id)).json()) as {
      linkedUnityProjectId: string | null;
      tiers: Array<{ tier: string; label: string; credits: number; unlocked: boolean }>;
    };

    expect(body.linkedUnityProjectId).toBe(GUID);
    expect(body.tiers.map((t) => t.tier)).toEqual(['Indie', 'SmallBusiness', 'PremiumContent']);
    expect(body.tiers.map((t) => t.credits)).toEqual([500, 1000, 2000]);
    expect(body.tiers.every((t) => t.unlocked === false)).toBe(true);
    expect(body.tiers.find((t) => t.tier === 'PremiumContent')?.label).toBe('Enterprise Studio');

    // No retired Stripe fields survive.
    expect(body).not.toHaveProperty('nextTier');
    expect(body).not.toHaveProperty('notice');
  });

  it('returns a null linked id and unlocked=false tiers when nothing is linked', async () => {
    const body = (await (await loadRoute(mine.id)).json()) as {
      linkedUnityProjectId: string | null;
      tiers: Array<{ unlocked: boolean }>;
    };

    expect(body.linkedUnityProjectId).toBeNull();
    expect(body.tiers.every((t) => t.unlocked === false)).toBe(true);
  });
});

describe('link', () => {
  it('400s on a bad GUID and leaves the field unset', async () => {
    for (const bad of ['', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6f', 'zzzz'.repeat(8)]) {
      expect((await postRoute(mine.id, { action: 'link', unityProjectId: bad })).status).toBe(400);
    }

    expect((await postRoute(mine.id, { action: 'link' })).status).toBe(400);
    expect((await projects.get(mine.id))?.linkedUnityProjectId).toBeUndefined();
  });

  it('stores a valid GUID normalized (lowercased, trimmed), then unlink clears it', async () => {
    const response = await postRoute(mine.id, { action: 'link', unityProjectId: `  ${GUID.toUpperCase()}  ` });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, linkedUnityProjectId: GUID });
    expect((await projects.get(mine.id))?.linkedUnityProjectId).toBe(GUID);

    const unlinked = await postRoute(mine.id, { action: 'unlink' });

    expect(unlinked.status).toBe(200);
    expect(await unlinked.json()).toEqual({ ok: true, linkedUnityProjectId: null });
    expect((await projects.get(mine.id))?.linkedUnityProjectId).toBeUndefined();
  });
});

describe('generate', () => {
  const link = () => postRoute(mine.id, { action: 'link', unityProjectId: GUID });

  it('400s when no Unity id is linked', async () => {
    expect((await postRoute(mine.id, { action: 'generate', tier: 'Indie' })).status).toBe(400);
  });

  it('4xxs on an invalid tier', async () => {
    await link();

    const response = await postRoute(mine.id, { action: 'generate', tier: 'bogus' });

    expect(response.status).toBe(400);
  });

  it('returns a license whose fields are all server-derived, plus tier/credits/alreadyUnlocked', async () => {
    await link();

    const body = (await (await postRoute(mine.id, { action: 'generate', tier: 'SmallBusiness' })).json()) as {
      license: Record<string, unknown>;
      tier: string;
      credits: number;
      alreadyUnlocked: boolean;
    };

    expect(body.license.licensee).toBe(USER.email);
    expect(body.license.product).toBe(GUID);
    expect(body.license.project).toBe(mine.name);
    expect(body.license.trial).toBe(false);
    expect(body.license.expires).toBe('never');
    expect(body.license.org).toBe('*');
    expect(body.license.plan).toBe('SmallBusiness');
    expect(body.license.s1).toBe('');
    expect(body.license.s2).toBe('');
    expect(body.tier).toBe('SmallBusiness');
    expect(body.alreadyUnlocked).toBe(false);
  });

  it('IGNORES a client-supplied unityProjectId in the generate body', async () => {
    await link();

    const body = (await (
      await postRoute(mine.id, { action: 'generate', tier: 'Indie', unityProjectId: GUID_OTHER })
    ).json()) as { license: { product: string } };

    expect(body.license.product).toBe(GUID);
    expect(body.license.product).not.toBe(GUID_OTHER);
  });

  it('charges the first time and is free (alreadyUnlocked) the second — enforced with credits', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'true');
    await ledger.append({ userId: USER.id, delta: 2000, reason: 'grant' });
    await link();

    const first = (await (await postRoute(mine.id, { action: 'generate', tier: 'Indie' })).json()) as {
      credits: number;
      alreadyUnlocked: boolean;
    };

    expect(first.credits).toBe(500);
    expect(first.alreadyUnlocked).toBe(false);
    expect(await ledger.balance(USER.id)).toBe(1500);

    const second = (await (await postRoute(mine.id, { action: 'generate', tier: 'Indie' })).json()) as {
      credits: number;
      alreadyUnlocked: boolean;
    };

    expect(second.credits).toBe(0);
    expect(second.alreadyUnlocked).toBe(true);
    expect(await ledger.balance(USER.id)).toBe(1500);
  });

  it('402s when billing is enforced and the balance cannot cover the tier', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'true');
    await link();

    const response = await postRoute(mine.id, { action: 'generate', tier: 'PremiumContent' });

    expect(response.status).toBe(402);
    expect(await ledger.balance(USER.id)).toBe(0);
  });
});

describe('method + action validation', () => {
  it('405s a non-POST to the action', async () => {
    expect((await postRoute(mine.id, { action: 'unlink' }, 'PUT')).status).toBe(405);
  });

  it('400s an unknown or missing action', async () => {
    expect((await postRoute(mine.id, { action: 'frobnicate' })).status).toBe(400);
    expect((await postRoute(mine.id, {})).status).toBe(400);
  });
});
