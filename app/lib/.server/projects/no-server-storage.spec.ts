/**
 * The platform does not store the user's game code (SPEC §4.5.4b).
 *
 * This is the invariant repo-primary persistence *is*. It has no error message, no failing build and
 * no test of its own unless one is written: the way it regresses is that someone adds a well-meaning
 * "back up the project" call, everything works, and the platform is quietly a file host again — which
 * is the exact model §4.5.4b removed, now with nobody aware it came back.
 *
 * ## What changed, and why the assertions got stronger
 *
 * This file used to pin that the snapshot WRITE route *refused* (405, after both walls). That was the
 * right test for a route that still existed. It does not any more, and neither does the store behind
 * it — so the pin is now structural: **the routes are absent, the store is absent, no client helper
 * exists, and no client module hand-rolls a fetch to either.** An uncalled route that can store a whole
 * project is a door; the fix was to remove the door, not to lock it.
 *
 * The one deliberate exception is the remix seed — a published game's source, which the OWNER chose to
 * make public (§4.8). It is pinned here too: it must stay a READ, and it must stay derived.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsProjectStore, setProjectStore } from './store';
import type { Project } from './types';

const USER = { id: 'user-1', email: 'a@example.com', emailVerified: true } as const;

vi.mock('~/lib/.server/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireVerifiedUser: async () => USER,
  requireUser: async () => USER,
}));

let tmp: string;
let mine: Project;
let theirs: Project;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'no-server-storage-'));

  const projects = new FsProjectStore(tmp);
  mine = await projects.create({ userId: USER.id, name: 'Mine', templateId: 'racing' });
  theirs = await projects.create({ userId: 'someone-else', name: 'Theirs', templateId: 'racing' });

  setProjectStore(projects);
});

afterEach(async () => {
  setProjectStore(undefined);
  await fs.rm(tmp, { recursive: true, force: true });
});

const routeExists = async (name: string) =>
  fs
    .access(path.resolve(process.cwd(), 'app/routes', name))
    .then(() => true)
    .catch(() => false);

describe('there is no server-side snapshot machinery', () => {
  /**
   * A route file is the door itself. Remix maps the filename to a URL, so re-adding
   * `api.projects.$projectId.snapshots.ts` re-opens the write path by existing — no import, no call
   * site, nothing else to review.
   */
  it('has no snapshot routes at all', async () => {
    expect(await routeExists('api.projects.$projectId.snapshots.ts')).toBe(false);
    expect(await routeExists('api.projects.$projectId.snapshots.$snapshotId.ts')).toBe(false);
  });

  it('exports no snapshot store to write one with', async () => {
    const store = await import('./store');

    expect(store).not.toHaveProperty('getSnapshotStore');
    expect(store).not.toHaveProperty('setSnapshotStore');
    expect(store).not.toHaveProperty('FsSnapshotStore');
    expect(store).not.toHaveProperty('SupabaseSnapshotStore');
  });

  /**
   * `currentSnapshotId` is gone from the project record, and its absence is load-bearing rather than
   * tidy. It kept a real meaning (a pointer to a remix seed) under a name describing the deleted
   * version history, which is how the deleted system finds its way back.
   */
  it('has no currentSnapshotId on a project', async () => {
    expect(mine).not.toHaveProperty('currentSnapshotId');
    expect(await new FsProjectStore(tmp).get(mine.id)).not.toHaveProperty('currentSnapshotId');
  });

  it('starts a new project with no seed', async () => {
    expect(mine.remixSeedAt).toBeUndefined();
  });
});

describe('the client cannot ask for it', () => {
  it('has no snapshot helpers to call', async () => {
    const client = await import('~/lib/persistence/projects');

    expect(client).not.toHaveProperty('createSnapshot');
    expect(client).not.toHaveProperty('listSnapshots');
    expect(client).not.toHaveProperty('setCurrentSnapshot');
    expect(client).not.toHaveProperty('readSnapshot');
    expect(client).not.toHaveProperty('restoreLatestServerCheckpoint');
  });

  /**
   * The stronger half: no client module reaches a snapshots URL by hand. A helper removed from one file
   * and hand-rolled with `fetch` in another is the same regression with better camouflage.
   *
   * Comments are stripped BEFORE the scan, and that is not a detail — the files that explain why this
   * route is gone necessarily name it, and a scanner that reads prose flags the documentation of the
   * fix as the bug. Stripping first is also what lets the pattern be loose enough to catch a URL built
   * by concatenation rather than only a template literal.
   */
  it('no client module references a snapshots route', async () => {
    const dirs = ['app/components', 'app/lib/persistence', 'app/lib/stores', 'app/routes'];
    const offenders: string[] = [];

    const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    for (const dir of dirs) {
      for (const file of await fs.readdir(path.resolve(process.cwd(), dir), { recursive: true })) {
        const full = path.resolve(process.cwd(), dir, file as string);

        if (!/\.(ts|tsx)$/.test(full) || /\.spec\.|\.server\//.test(full)) {
          continue;
        }

        const code = stripComments(await fs.readFile(full, 'utf8'));

        // Any URL aimed at a project's snapshots — the read is as gone as the write.
        if (/\/api\/projects\/.{0,40}?\/snapshots/.test(code)) {
          offenders.push(full);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * The control. Without it, a scanner broken into always-passing (a bad regex, a wrong directory
   * list, a `readdir` that silently returns nothing) reports a clean bill of health forever — the
   * failure mode this whole file exists to prevent, wearing the costume of the test that prevents it.
   */
  it('the scanner can actually find a snapshots URL', () => {
    const scan = (code: string) => /\/api\/projects\/.{0,40}?\/snapshots/.test(code);

    expect(scan('await fetch(`/api/projects/${id}/snapshots`, { method: "POST" })')).toBe(true);
    expect(scan("await fetch('/api/projects/' + id + '/snapshots')")).toBe(true);
    expect(scan('await fetch(`/api/projects/${id}/snapshots/${snapshotId}`)')).toBe(true);
    expect(scan('await fetch(`/api/projects/${id}/seed`)')).toBe(false);
  });
});

describe('the remix seed — the one deliberate exception (§4.8)', () => {
  const getSeed = async (projectId: string) => {
    const { loader } = await import('~/routes/api.projects.$projectId.seed');

    return loader({
      request: new Request('https://app.example.com/api/projects/p/seed'),
      params: { projectId },
      context: {},
    } as never);
  };

  /** It is a READ. A write method here would be server-side project storage under another name. */
  it('offers no way to write a seed from the browser', async () => {
    const route = await import('~/routes/api.projects.$projectId.seed');

    expect(route).not.toHaveProperty('action');
    expect(route).toHaveProperty('loader');
  });

  it('404s for a project with no seed — the normal case', async () => {
    expect((await getSeed(mine.id)).status).toBe(404);
  });

  /**
   * The walls come first. Someone else's project id must be indistinguishable from a nonexistent one
   * (§4.5.3: 404, never 403 — a 403 confirms the id is real).
   */
  it('404s for someone else’s project, identically', async () => {
    expect((await getSeed(theirs.id)).status).toBe(404);
    expect((await getSeed('prj_does_not_exist')).status).toBe(404);
  });
});
