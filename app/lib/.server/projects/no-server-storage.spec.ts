/**
 * The platform does not store the user's game code (SPEC §4.5.4b).
 *
 * This is the invariant repo-primary persistence *is*. It has no error message, no failing build and
 * no test of its own unless one is written: the way it regresses is that someone adds a well-meaning
 * "back up the project" call, everything works, and the platform is quietly a file host again — which
 * is the exact model §4.5.4b removed, now with nobody aware it came back.
 *
 * Three things are pinned here, and each is a different way in:
 *
 *   1. The snapshot WRITE route refuses. An uncalled route that stores a whole project is a door.
 *   2. It refuses AFTER the two walls, so it cannot be used to probe which project ids exist (§4.5.3).
 *   3. No client module can even ask for it — the helper that used to is gone, not just unused.
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

const files = { 'src/game.ts': { type: 'file' as const, content: 'const x = 1;', isBinary: false } };

async function postSnapshot(projectId: string) {
  const { action } = await import('~/routes/api.projects.$projectId.snapshots');

  return action({
    request: new Request('https://app.example.com/api/projects/p/snapshots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files, label: 'Backup' }),
    }),
    params: { projectId },
    context: {},
  } as never);
}

describe('the snapshot write path is closed', () => {
  it('REFUSES to store a project, however well-formed the request', async () => {
    const response = await postSnapshot(mine.id);

    expect(response.status).toBe(405);
    expect((await response.json()) as { message: string }).toMatchObject({
      error: true,
      message: expect.stringMatching(/not stored on the platform/i),
    });
  });

  /** Nothing may be written on the way to the refusal — not the row, not the bytes. */
  it('records nothing at all', async () => {
    await postSnapshot(mine.id);

    const { getSnapshotStore } = await import('./store');

    expect(await getSnapshotStore({}).listByProject(mine.id)).toEqual([]);
    expect((await new FsProjectStore(tmp).get(mine.id))!.currentSnapshotId).toBeUndefined();
  });

  /**
   * The refusal must not become an enumeration oracle. Someone else's project id has to be
   * indistinguishable from a nonexistent one (§4.5.3: 404, never 403 — and here, never 405 either,
   * which would confirm the id is real by answering the same way a real one does).
   */
  it('still 404s for someone else’s project — the walls come first', async () => {
    expect((await postSnapshot(theirs.id)).status).toBe(404);
  });

  it('404s for an id that does not exist, identically', async () => {
    expect((await postSnapshot('prj_does_not_exist')).status).toBe(404);
  });
});

describe('the client cannot ask for it', () => {
  it('has no createSnapshot helper to call', async () => {
    const client = await import('~/lib/persistence/projects');

    expect(client).not.toHaveProperty('createSnapshot');
    expect(client).not.toHaveProperty('listSnapshots');
  });

  /**
   * The stronger half: no client module POSTs to the snapshots route. A helper removed from one file
   * and hand-rolled with `fetch` in another is the same regression with better camouflage.
   */
  it('no client module posts to the snapshots route', async () => {
    const dirs = ['app/components', 'app/lib/persistence', 'app/lib/stores', 'app/routes'];
    const offenders: string[] = [];

    for (const dir of dirs) {
      for (const file of await fs.readdir(path.resolve(process.cwd(), dir), { recursive: true })) {
        const full = path.resolve(process.cwd(), dir, file as string);

        if (!/\.(ts|tsx)$/.test(full) || /\.spec\.|\.server\//.test(full)) {
          continue;
        }

        const source = await fs.readFile(full, 'utf8');

        // A fetch/POST aimed at the snapshots collection — the write, not the `/:snapshotId` read.
        if (/['"`]\/api\/projects\/\$\{[^}]+\}\/snapshots['"`]/.test(source) && /method:\s*'POST'/.test(source)) {
          offenders.push(full);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
