/**
 * The SERVER records a finished managed first build on the row (`build-complete.ts`, owner 2026-10-02).
 *
 * Measured: a build finished after a dropped stream and a reload, and the row still said "owes its first
 * build" — plan on Step 1 forever, no "done" message, every later message treated as a first build.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newCreationPlan, projectOwesBuild } from '~/lib/agent/creation-plan';
import { FsProjectStore, setProjectStore } from '~/lib/.server/projects/store';
import { recordManagedBuildPhases } from './build-complete';

let tmp: string;
let store: FsProjectStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'build-complete-'));
  store = new FsProjectStore(tmp);
  setProjectStore(store);
});

afterEach(async () => {
  setProjectStore(undefined);
  await fs.rm(tmp, { recursive: true, force: true });
});

const project = async (plan = newCreationPlan()) =>
  store.create({ userId: 'u1', name: 'Kart', creationHandoff: { plan } } as never);

describe('a finished managed build is recorded on the row', () => {
  it('every step reported → the handoff is cleared and the project no longer owes a build', async () => {
    const row = await project();

    const result = await recordManagedBuildPhases({
      projectId: row.id,
      phases: ['design', 'game', 'frontend'],
      generationId: 'gen_1',
    });

    const after = await store.get(row.id);
    expect(result.complete).toBe(true);
    expect(after?.creationHandoff).toBeUndefined();
    expect(projectOwesBuild(after?.creationHandoff)).toBe(false);
  });

  it('a partial report moves the plan FORWARD only as far as it goes', async () => {
    const row = await project();

    const result = await recordManagedBuildPhases({ projectId: row.id, phases: ['design'], generationId: 'gen_1' });

    expect(result.complete).toBe(false);
    expect((await store.get(row.id))?.creationHandoff?.plan?.next).toBe(1);
  });

  it('CONTROL: a step the plan does not owe next is never skipped to', async () => {
    const row = await project();

    await recordManagedBuildPhases({ projectId: row.id, phases: ['frontend'], generationId: 'gen_1' });

    expect((await store.get(row.id))?.creationHandoff?.plan?.next).toBe(0);
  });

  it('already recorded (the client got there first) → a no-op that still reports complete', async () => {
    const row = await store.create({ userId: 'u1', name: 'Kart' } as never);

    const result = await recordManagedBuildPhases({ projectId: row.id, phases: ['design'], generationId: 'gen_1' });

    expect(result.complete).toBe(true);
  });

  it('never throws — a missing project is a logged no-op', async () => {
    await expect(
      recordManagedBuildPhases({ projectId: 'prj_missing', phases: ['design'], generationId: 'gen_1' }),
    ).resolves.toEqual({ complete: true });
  });
});
