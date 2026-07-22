/**
 * The working-copy route (SPEC §4.5.3, §4.5.4c, §5).
 *
 * This route reads and OVERWRITES a user's entire game, so the wall tests are the point: both methods
 * go through `requireOwnedProject`, and someone else's project must answer **404, not 403** — a 403
 * confirms the id exists and turns the route into an enumeration oracle.
 *
 * The validation tests are data-loss tests rather than input hygiene. There is exactly one copy per
 * project and a write overwrites it, so any request the route accepts too readily destroys the thing it
 * was built to protect.
 *
 * ⚠️ Lives here, not in `app/routes/` — Remix compiles a spec in that folder as a route and the
 * manifest then imports `vitest` at runtime, which 500s every request (§4.5.6).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToBase64 } from '~/lib/binary/binary-files';
import { FsObjectStore } from '~/lib/.server/storage/store';
import { setObjectStore } from '~/lib/.server/storage';
import { FsProjectStore, setProjectStore } from './store';
import { getWorkingCopy, putWorkingCopy } from './working-copy';
import type { Project } from './types';
import type { SerializedFileMap } from '~/lib/binary/binary-files';

const USER = { id: 'user-1', email: 'a@example.com', emailVerified: true } as const;

vi.mock('~/lib/.server/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireVerifiedUser: async () => USER,
  requireUser: async () => USER,
}));

const HOSTILE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80, 0xc0]);

const FILES: SerializedFileMap = {
  'src/pages/Home.tsx': { type: 'file', content: 'export default function Home() {}', isBinary: false },
  'public/assets/generated/hero.png': {
    type: 'file',
    content: bytesToBase64(HOSTILE),
    isBinary: true,
    size: HOSTILE.length,
  },
};

let tmp: string;
let projects: FsProjectStore;
let mine: Project;
let theirs: Project;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'working-routes-'));
  setObjectStore(new FsObjectStore(path.join(tmp, 'objects')));

  projects = new FsProjectStore(path.join(tmp, 'projects'));
  setProjectStore(projects);

  mine = await projects.create({ userId: USER.id, name: 'Mine', templateId: 'racing' });
  theirs = await projects.create({ userId: 'someone-else', name: 'Theirs', templateId: 'racing' });
});

afterEach(async () => {
  setObjectStore(undefined);
  setProjectStore(undefined);
  await fs.rm(tmp, { recursive: true, force: true });
});

async function put(projectId: string, body: unknown, method = 'PUT') {
  const { action } = await import('~/routes/api.projects.$projectId.working');
  return action({
    request: new Request('http://localhost/api/projects/x/working', {
      method,
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
    params: { projectId },
    context: {},
  } as never);
}

async function get(projectId: string) {
  const { loader } = await import('~/routes/api.projects.$projectId.working');
  return loader({
    request: new Request('http://localhost/api/projects/x/working'),
    params: { projectId },
    context: {},
  } as never);
}

describe('both walls (§4.5.3)', () => {
  it('404s — never 403 — when reading someone else’s project', async () => {
    expect((await get(theirs.id)).status).toBe(404);
  });

  it('404s — never 403 — when writing to someone else’s project', async () => {
    expect((await put(theirs.id, { seq: 1, files: FILES })).status).toBe(404);

    /* And nothing was written to their project on the way to refusing. */
    expect(await getWorkingCopy(theirs.id)).toBeNull();
  });

  it('404s for a project id that does not exist, identically', async () => {
    expect((await get('prj_nope')).status).toBe(404);
  });
});

describe('round trip', () => {
  it('stores and returns the copy, binaries intact', async () => {
    expect((await put(mine.id, { seq: 4, files: FILES })).status).toBe(200);

    const response = await get(mine.id);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { copy: { seq: number; files: SerializedFileMap } };
    expect(body.copy.seq).toBe(4);
    expect(body.copy.files['public/assets/generated/hero.png']).toEqual(FILES['public/assets/generated/hero.png']);
  });

  it('404s for a project that has never checkpointed — normal, not an error', async () => {
    expect((await get(mine.id)).status).toBe(404);
  });

  it('overwrites rather than accumulating — there is only ever one copy', async () => {
    await put(mine.id, { seq: 1, files: FILES });
    await put(mine.id, { seq: 2, files: FILES });

    expect((await getWorkingCopy(mine.id))!.seq).toBe(2);
  });
});

describe('what the route refuses, and why each refusal is a data-loss guard', () => {
  /*
   * A client mid-mount reports zero files. Storing that would overwrite a good copy with an empty one,
   * making the recovery buffer the CAUSE of the loss. Same bias as `planRestore`: when in doubt, do
   * nothing.
   */
  it('refuses an empty file map, leaving the existing copy untouched', async () => {
    await putWorkingCopy(mine.id, { projectId: mine.id, seq: 1, updatedAt: 'a', files: FILES });

    expect((await put(mine.id, { seq: 2, files: {} })).status).toBe(400);
    expect((await getWorkingCopy(mine.id))!.seq).toBe(1);
  });

  /*
   * `seq` orders this copy against the browser's local checkpoint. Defaulting a missing one would
   * silently store something that cannot be ordered — so it fails loudly instead.
   */
  it('refuses a write with no usable seq', async () => {
    expect((await put(mine.id, { files: FILES })).status).toBe(400);
    expect((await put(mine.id, { seq: 'later', files: FILES })).status).toBe(400);
    expect((await put(mine.id, { seq: Number.NaN, files: FILES })).status).toBe(400);
    expect(await getWorkingCopy(mine.id)).toBeNull();
  });

  it('refuses a write with no files', async () => {
    expect((await put(mine.id, { seq: 1 })).status).toBe(400);
  });

  it('refuses a method that is neither PUT nor POST', async () => {
    expect((await put(mine.id, { seq: 1, files: FILES }, 'DELETE')).status).toBe(405);
  });
});
