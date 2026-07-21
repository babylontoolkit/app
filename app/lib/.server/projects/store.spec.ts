/**
 * `linkedUnityProjectId` round-trips through BOTH project store backends (§4.18, T3).
 *
 * The field is a plain pointer (the linked Unity project's `productGUID`), never a credential — it
 * follows `gameBackendRef`. A store backend that silently drops it is the exact failure this test
 * guards: the FS backend round-trips the whole domain object, the Supabase backend maps camelCase ⇄
 * snake_case by hand in `rowToProject`/`projectToRow`, and a missing entry in either map is a silent
 * data loss with no error and no failing build. So both directions of the Supabase mapping are
 * asserted, not just one.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * A minimal fluent stub of the Supabase query builder. Every chainable method returns `this`; the
 * terminal `.single()`/`.maybeSingle()` resolve to `{ data, error }`. `insert`/`update` capture the
 * row they were handed so the test can assert `projectToRow`'s output; the row returned from the
 * terminal is what `rowToProject` will parse, so it carries `linked_unity_project_id`.
 */
let captured: { insert?: Record<string, any>; update?: Record<string, any> };
let returnRow: Record<string, any>;

function makeDb() {
  const builder: any = {
    from() {
      return builder;
    },
    insert(row: Record<string, any>) {
      captured.insert = row;
      return builder;
    },
    update(row: Record<string, any>) {
      captured.update = row;
      return builder;
    },
    select() {
      return builder;
    },
    eq() {
      return builder;
    },
    single() {
      return Promise.resolve({ data: returnRow, error: null });
    },
    maybeSingle() {
      return Promise.resolve({ data: returnRow, error: null });
    },
  };

  return builder;
}

vi.mock('~/lib/.server/supabase/client', () => ({
  isSupabaseConfigured: () => true,
  createAdminClient: async () => makeDb(),
}));

// Imported after the mock is registered.
// eslint-disable-next-line @typescript-eslint/naming-convention -- destructured class constructors keep their PascalCase names
const { FsProjectStore, SupabaseProjectStore } = await import('./store');

describe('FsProjectStore round-trips linkedUnityProjectId', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'store-spec-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('persists the field on create and reads it back through a fresh store instance', async () => {
    const store = new FsProjectStore(tmp);
    const created = await store.create({
      userId: 'user-1',
      name: 'Unity Game',
      templateId: 'racing',
      linkedUnityProjectId: 'a'.repeat(32),
    });

    expect(created.linkedUnityProjectId).toBe('a'.repeat(32));

    // A separate instance proves it survived the write to disk, not just the in-memory object.
    const read = await new FsProjectStore(tmp).get(created.id);
    expect(read?.linkedUnityProjectId).toBe('a'.repeat(32));
  });

  it('a project created without the field reads back without it', async () => {
    const store = new FsProjectStore(tmp);
    const created = await store.create({ userId: 'user-1', name: 'No Unity', templateId: 'racing' });

    expect(created.linkedUnityProjectId).toBeUndefined();
    expect((await new FsProjectStore(tmp).get(created.id))?.linkedUnityProjectId).toBeUndefined();
  });

  it('update sets, changes, and clears the field', async () => {
    const store = new FsProjectStore(tmp);
    const created = await store.create({ userId: 'user-1', name: 'Unity Game', templateId: 'racing' });

    const set = await store.update(created.id, { linkedUnityProjectId: 'b'.repeat(32) });
    expect(set.linkedUnityProjectId).toBe('b'.repeat(32));
    expect((await new FsProjectStore(tmp).get(created.id))?.linkedUnityProjectId).toBe('b'.repeat(32));

    const changed = await store.update(created.id, { linkedUnityProjectId: 'c'.repeat(32) });
    expect(changed.linkedUnityProjectId).toBe('c'.repeat(32));

    const cleared = await store.update(created.id, { linkedUnityProjectId: undefined });
    expect(cleared.linkedUnityProjectId).toBeUndefined();
    expect((await new FsProjectStore(tmp).get(created.id))?.linkedUnityProjectId).toBeUndefined();
  });
});

describe('SupabaseProjectStore maps linkedUnityProjectId in both directions', () => {
  beforeEach(() => {
    captured = {};
    returnRow = {};
  });

  it('projectToRow emits linked_unity_project_id on create (camelCase → snake_case)', async () => {
    // rowToProject needs a well-formed row to return; the assertion is on `captured.insert`.
    returnRow = { id: 'prj_1', user_id: 'user-1', name: 'Unity Game', created_at: 'now', updated_at: 'now' };

    await new SupabaseProjectStore().create({
      userId: 'user-1',
      name: 'Unity Game',
      templateId: 'racing',
      linkedUnityProjectId: 'd'.repeat(32),
    });

    expect(captured.insert).toHaveProperty('linked_unity_project_id', 'd'.repeat(32));
  });

  it('rowToProject maps linked_unity_project_id back to linkedUnityProjectId (snake_case → camelCase)', async () => {
    returnRow = {
      id: 'prj_1',
      user_id: 'user-1',
      name: 'Unity Game',
      linked_unity_project_id: 'e'.repeat(32),
      created_at: 'now',
      updated_at: 'now',
    };

    const project = await new SupabaseProjectStore().get('prj_1');
    expect(project?.linkedUnityProjectId).toBe('e'.repeat(32));
  });

  it('a row without the column reads back with the field undefined', async () => {
    returnRow = { id: 'prj_1', user_id: 'user-1', name: 'No Unity', created_at: 'now', updated_at: 'now' };

    const project = await new SupabaseProjectStore().get('prj_1');
    expect(project?.linkedUnityProjectId).toBeUndefined();
  });

  it('update writes the column through projectToRow, and clearing it emits null', async () => {
    returnRow = {
      id: 'prj_1',
      user_id: 'user-1',
      name: 'Unity Game',
      linked_unity_project_id: 'f'.repeat(32),
      created_at: 'now',
      updated_at: 'now',
    };

    await new SupabaseProjectStore().update('prj_1', { linkedUnityProjectId: 'f'.repeat(32) });
    expect(captured.update).toHaveProperty('linked_unity_project_id', 'f'.repeat(32));

    // Clearing: `projectToRow` maps an explicit `undefined` to `null` so the DB column is nulled.
    await new SupabaseProjectStore().update('prj_1', { linkedUnityProjectId: undefined });
    expect(captured.update).toHaveProperty('linked_unity_project_id', null);
  });
});
