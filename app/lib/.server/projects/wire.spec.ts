/**
 * What a project looks like on the wire (SPEC §4.5.3, §5).
 *
 * The defect this pins is that **a TypeScript type strips nothing at runtime**. `app/types/project.ts`
 * omits the server-only fields and it is easy to read that omission as a guarantee — but both project
 * routes serialize the row they loaded, so a new server-side field ships to every dashboard load the
 * moment it exists. Nothing throws and nothing looks wrong.
 *
 * So the omission is a function both routes call, and it is asserted here rather than assumed from a
 * type. The route-level half is pinned too: a field stripped in `wire.ts` but re-added by a route that
 * spreads the raw project is the same leak one layer up.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsProjectStore, setProjectStore } from './store';
import { toWireProject } from './wire';
import type { Project } from './types';

const USER = { id: 'user-1', email: 'a@example.com', emailVerified: true } as const;

vi.mock('~/lib/.server/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireVerifiedUser: async () => USER,
  requireUser: async () => USER,
}));

let tmp: string;
let projects: FsProjectStore;
let mine: Project;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'project-wire-'));
  projects = new FsProjectStore(tmp);
  setProjectStore(projects);

  mine = await projects.create({ userId: USER.id, name: 'Mine', templateId: 'racing' });
  await projects.update(mine.id, { sandboxId: 'sb-secret' });
});

afterEach(async () => {
  setProjectStore(undefined);
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('toWireProject', () => {
  it('strips sandboxId', async () => {
    const wire = toWireProject((await projects.get(mine.id))!);

    expect(wire).not.toHaveProperty('sandboxId');
  });

  it('keeps everything else, including userId', async () => {
    /*
     * A considered list, not a blanket filter. `userId` is deliberately kept — the client relies on
     * it and it identifies the caller to themselves — so an over-eager strip is a regression too.
     */
    const project = (await projects.get(mine.id))!;
    const { sandboxId: _stripped, ...rest } = project;

    expect(toWireProject(project)).toEqual(rest);

    const wire = toWireProject(project);
    expect(wire.userId).toBe(USER.id);
    expect(wire.id).toBe(mine.id);
    expect(wire.name).toBe('Mine');
  });

  it('keeps route-added extras like chatCount', () => {
    const wire = toWireProject({ id: 'p1', name: 'X', sandboxId: 'sb-1', chatCount: 3 } as never) as Record<
      string,
      unknown
    >;

    expect(wire).toEqual({ id: 'p1', name: 'X', chatCount: 3 });
  });

  it('does not mutate the project it was given — the server still needs the id', () => {
    const project = { id: 'p1', sandboxId: 'sb-1' } as never as Project;

    toWireProject(project);

    expect(project.sandboxId).toBe('sb-1');
  });

  it('is safe on a project that never had a sandbox', () => {
    expect(toWireProject({ id: 'p1' } as never)).toEqual({ id: 'p1' });
  });
});

describe('the routes actually call it', () => {
  const listProjects = async () => {
    const { loader } = await import('~/routes/api.projects');

    return loader({ request: new Request('http://localhost/api/projects'), params: {}, context: {} } as never);
  };

  const getProject = async (projectId: string) => {
    const { loader } = await import('~/routes/api.projects.$projectId');

    return loader({
      request: new Request('http://localhost/api/projects/x'),
      params: { projectId },
      context: {},
    } as never);
  };

  it('the listing does not serialize sandboxId', async () => {
    const body = (await (await listProjects()).json()) as { projects: Array<Record<string, unknown>> };

    expect(body.projects.length).toBeGreaterThan(0);

    for (const project of body.projects) {
      expect(project).not.toHaveProperty('sandboxId');
    }
  });

  it('the single-project loader does not serialize sandboxId', async () => {
    const body = (await (await getProject(mine.id)).json()) as { project: Record<string, unknown> };

    expect(body.project.id).toBe(mine.id);
    expect(body.project).not.toHaveProperty('sandboxId');
  });
});
