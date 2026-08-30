/**
 * The plain project POINTERS round-trip through BOTH store backends: `gameBackendRef` (§4.15) and
 * `sandboxId` (`spec/sandbox-codesandbox.md`).
 *
 * Each is a plain pointer, never a credential. A store backend that
 * silently drops one is the exact failure this test guards: the FS backend round-trips the whole
 * domain object, the Supabase backend maps camelCase ⇄ snake_case by hand in
 * `rowToProject`/`projectToRow`, and a missing entry in either map is a silent data loss with no
 * error and no failing build. So both directions of the Supabase mapping are asserted, not just one.
 *
 * For `sandboxId` a dropped field is worse than a lost setting: the project's VM becomes an orphan
 * that nothing can address, still running and still billing, while the next session forks a fresh
 * one over the user's workspace.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * A minimal fluent stub of the Supabase query builder. Every chainable method returns `this`; the
 * terminal `.single()`/`.maybeSingle()` resolve to `{ data, error }`. `insert`/`update` capture the
 * row they were handed so the test can assert `projectToRow`'s output; the row returned from the
 * terminal is what `rowToProject` will parse, so it carries `game_backend_ref`.
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

describe('FsProjectStore round-trips gameBackendRef', () => {
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
      gameBackendRef: 'gb_aaa',
    });

    expect(created.gameBackendRef).toBe('gb_aaa');

    // A separate instance proves it survived the write to disk, not just the in-memory object.
    const read = await new FsProjectStore(tmp).get(created.id);
    expect(read?.gameBackendRef).toBe('gb_aaa');
  });

  it('a project created without the field reads back without it', async () => {
    const store = new FsProjectStore(tmp);
    const created = await store.create({ userId: 'user-1', name: 'No Unity', templateId: 'racing' });

    expect(created.gameBackendRef).toBeUndefined();
    expect((await new FsProjectStore(tmp).get(created.id))?.gameBackendRef).toBeUndefined();
  });

  it('update sets, changes, and clears the field', async () => {
    const store = new FsProjectStore(tmp);
    const created = await store.create({ userId: 'user-1', name: 'Unity Game', templateId: 'racing' });

    const set = await store.update(created.id, { gameBackendRef: 'gb_bbb' });
    expect(set.gameBackendRef).toBe('gb_bbb');
    expect((await new FsProjectStore(tmp).get(created.id))?.gameBackendRef).toBe('gb_bbb');

    const changed = await store.update(created.id, { gameBackendRef: 'gb_ccc' });
    expect(changed.gameBackendRef).toBe('gb_ccc');

    const cleared = await store.update(created.id, { gameBackendRef: undefined });
    expect(cleared.gameBackendRef).toBeUndefined();
    expect((await new FsProjectStore(tmp).get(created.id))?.gameBackendRef).toBeUndefined();
  });
});

describe('SupabaseProjectStore maps gameBackendRef in both directions', () => {
  beforeEach(() => {
    captured = {};
    returnRow = {};
  });

  it('projectToRow emits game_backend_ref on create (camelCase → snake_case)', async () => {
    // rowToProject needs a well-formed row to return; the assertion is on `captured.insert`.
    returnRow = { id: 'prj_1', user_id: 'user-1', name: 'Unity Game', created_at: 'now', updated_at: 'now' };

    await new SupabaseProjectStore().create({
      userId: 'user-1',
      name: 'Unity Game',
      templateId: 'racing',
      gameBackendRef: 'gb_ddd',
    });

    expect(captured.insert).toHaveProperty('game_backend_ref', 'gb_ddd');
  });

  it('rowToProject maps game_backend_ref back to gameBackendRef (snake_case → camelCase)', async () => {
    returnRow = {
      id: 'prj_1',
      user_id: 'user-1',
      name: 'Unity Game',
      game_backend_ref: 'gb_eee',
      created_at: 'now',
      updated_at: 'now',
    };

    const project = await new SupabaseProjectStore().get('prj_1');
    expect(project?.gameBackendRef).toBe('gb_eee');
  });

  it('a row without the column reads back with the field undefined', async () => {
    returnRow = { id: 'prj_1', user_id: 'user-1', name: 'No Unity', created_at: 'now', updated_at: 'now' };

    const project = await new SupabaseProjectStore().get('prj_1');
    expect(project?.gameBackendRef).toBeUndefined();
  });

  it('update writes the column through projectToRow, and clearing it emits null', async () => {
    returnRow = {
      id: 'prj_1',
      user_id: 'user-1',
      name: 'Unity Game',
      game_backend_ref: 'gb_fff',
      created_at: 'now',
      updated_at: 'now',
    };

    await new SupabaseProjectStore().update('prj_1', { gameBackendRef: 'gb_fff' });
    expect(captured.update).toHaveProperty('game_backend_ref', 'gb_fff');

    // Clearing: `projectToRow` maps an explicit `undefined` to `null` so the DB column is nulled.
    await new SupabaseProjectStore().update('prj_1', { gameBackendRef: undefined });
    expect(captured.update).toHaveProperty('game_backend_ref', null);
  });
});

describe('FsProjectStore round-trips sandboxId', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'store-spec-sandbox-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('survives create → update → get through a fresh store instance', async () => {
    const store = new FsProjectStore(tmp);
    const created = await store.create({ userId: 'user-1', name: 'Kart Racer', templateId: 'racing' });

    // A brand-new project has no VM yet, and `undefined` is the correct reading of that.
    expect(created.sandboxId).toBeUndefined();

    const recorded = await store.update(created.id, { sandboxId: 'csb_abc123' });
    expect(recorded.sandboxId).toBe('csb_abc123');

    // A separate instance proves it survived the write to disk, not just the in-memory object.
    expect((await new FsProjectStore(tmp).get(created.id))?.sandboxId).toBe('csb_abc123');
  });

  it('is set at create time when a VM is known up front', async () => {
    const store = new FsProjectStore(tmp);
    const created = await store.create({
      userId: 'user-1',
      name: 'Kart Racer',
      templateId: 'racing',
      sandboxId: 'csb_seed',
    });

    expect((await new FsProjectStore(tmp).get(created.id))?.sandboxId).toBe('csb_seed');
  });

  it('re-pointing at a new VM replaces the id, and clearing it removes the pointer', async () => {
    const store = new FsProjectStore(tmp);
    const created = await store.create({
      userId: 'user-1',
      name: 'Kart Racer',
      templateId: 'racing',
      sandboxId: 'csb_old',
    });

    // The resume→create fallback re-points the row; the OLD id must not linger anywhere.
    const repointed = await store.update(created.id, { sandboxId: 'csb_new' });
    expect(repointed.sandboxId).toBe('csb_new');

    const cleared = await store.update(created.id, { sandboxId: undefined });
    expect(cleared.sandboxId).toBeUndefined();
    expect((await new FsProjectStore(tmp).get(created.id))?.sandboxId).toBeUndefined();
  });

  it('listByUser carries the pointer — the row IS the registry the per-user file used to be', async () => {
    const store = new FsProjectStore(tmp);
    await store.create({ userId: 'user-1', name: 'A', templateId: 'racing', sandboxId: 'csb_a' });
    await store.create({ userId: 'user-1', name: 'B', templateId: 'racing', sandboxId: 'csb_b' });
    await store.create({ userId: 'user-2', name: 'C', templateId: 'racing', sandboxId: 'csb_c' });

    const mine = await new FsProjectStore(tmp).listByUser('user-1');
    expect(mine.map((p) => p.sandboxId).sort()).toEqual(['csb_a', 'csb_b']);
  });
});

describe('SupabaseProjectStore maps sandboxId in both directions', () => {
  beforeEach(() => {
    captured = {};
    returnRow = {};
  });

  it('projectToRow emits sandbox_id on create (camelCase → snake_case)', async () => {
    returnRow = { id: 'prj_1', user_id: 'user-1', name: 'Kart Racer', created_at: 'now', updated_at: 'now' };

    await new SupabaseProjectStore().create({
      userId: 'user-1',
      name: 'Kart Racer',
      templateId: 'racing',
      sandboxId: 'csb_abc123',
    });

    expect(captured.insert).toHaveProperty('sandbox_id', 'csb_abc123');
  });

  it('rowToProject maps sandbox_id back to sandboxId (snake_case → camelCase)', async () => {
    returnRow = {
      id: 'prj_1',
      user_id: 'user-1',
      name: 'Kart Racer',
      sandbox_id: 'csb_abc123',
      created_at: 'now',
      updated_at: 'now',
    };

    expect((await new SupabaseProjectStore().get('prj_1'))?.sandboxId).toBe('csb_abc123');
  });

  it('a row written before migration 0013 reads back with no pointer, not an empty string', async () => {
    returnRow = { id: 'prj_1', user_id: 'user-1', name: 'Legacy', created_at: 'now', updated_at: 'now' };

    expect((await new SupabaseProjectStore().get('prj_1'))?.sandboxId).toBeUndefined();
  });

  it('update writes the column, and clearing it emits null so the DB column is nulled', async () => {
    returnRow = {
      id: 'prj_1',
      user_id: 'user-1',
      name: 'Kart Racer',
      sandbox_id: 'csb_new',
      created_at: 'now',
      updated_at: 'now',
    };

    await new SupabaseProjectStore().update('prj_1', { sandboxId: 'csb_new' });
    expect(captured.update).toHaveProperty('sandbox_id', 'csb_new');

    await new SupabaseProjectStore().update('prj_1', { sandboxId: undefined });
    expect(captured.update).toHaveProperty('sandbox_id', null);
  });

  it('a patch that does not mention sandboxId leaves the column alone', async () => {
    /*
     * `projectToRow` is key-presence-driven, and that is load-bearing here: an unrelated update (a
     * rename, a publish) must never null a live VM pointer, which would orphan the running sandbox.
     */
    returnRow = { id: 'prj_1', user_id: 'user-1', name: 'Renamed', created_at: 'now', updated_at: 'now' };

    await new SupabaseProjectStore().update('prj_1', { name: 'Renamed' });
    expect(captured.update).not.toHaveProperty('sandbox_id');
  });
});

/**
 * The creation handoff (§4.4a, migration 0016) — `{brief, userPrompt}`, the only OBJECT-valued field
 * on the row, which is what makes it worth its own round trip here.
 *
 * A dropped mapping is not a lost setting: the brief carries `CREATION_BRIEF_MARKER`, and without it
 * ten server-side protections switch off on the first build turn. The build still runs and is simply
 * worse, with nothing throwing and the token count going DOWN — the exact §4.2.8 failure that made this
 * a column instead of a `localStorage` key in the first place.
 */
describe('FsProjectStore round-trips creationHandoff', () => {
  let tmp: string;

  const HANDOFF = { brief: 'Build the game.\n<!-- creation-brief -->', userPrompt: 'a kart racer' };

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'store-spec-handoff-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('survives create → get through a fresh store instance, nested fields and all', async () => {
    const store = new FsProjectStore(tmp);
    const created = await store.create({
      userId: 'user-1',
      name: 'Kart Racer',
      templateId: 'racing',
      creationHandoff: HANDOFF,
    });

    // A separate instance proves it survived the write to disk, not just the in-memory object.
    expect((await new FsProjectStore(tmp).get(created.id))?.creationHandoff).toEqual(HANDOFF);
  });

  it('clears on update — the end state, set when the first build turn is SENT', async () => {
    const store = new FsProjectStore(tmp);
    const created = await store.create({
      userId: 'user-1',
      name: 'Kart Racer',
      templateId: 'racing',
      creationHandoff: HANDOFF,
    });

    const cleared = await store.update(created.id, { creationHandoff: undefined });
    expect(cleared.creationHandoff).toBeUndefined();
    expect((await new FsProjectStore(tmp).get(created.id))?.creationHandoff).toBeUndefined();
  });
});

describe('SupabaseProjectStore maps creationHandoff in both directions', () => {
  const HANDOFF = { brief: 'Build the game.\n<!-- creation-brief -->', userPrompt: 'a kart racer' };

  beforeEach(() => {
    captured = {};
    returnRow = {};
  });

  it('projectToRow emits creation_handoff on create (camelCase → snake_case)', async () => {
    returnRow = { id: 'prj_1', user_id: 'user-1', name: 'Kart Racer', created_at: 'now', updated_at: 'now' };

    await new SupabaseProjectStore().create({
      userId: 'user-1',
      name: 'Kart Racer',
      templateId: 'racing',
      creationHandoff: HANDOFF,
    });

    expect(captured.insert).toHaveProperty('creation_handoff', HANDOFF);
  });

  it('rowToProject maps creation_handoff back (snake_case → camelCase)', async () => {
    returnRow = {
      id: 'prj_1',
      user_id: 'user-1',
      name: 'Kart Racer',
      creation_handoff: HANDOFF,
      created_at: 'now',
      updated_at: 'now',
    };

    expect((await new SupabaseProjectStore().get('prj_1'))?.creationHandoff).toEqual(HANDOFF);
  });

  it('a project that has already been built reads back with no handoff', async () => {
    returnRow = { id: 'prj_1', user_id: 'user-1', name: 'Built', created_at: 'now', updated_at: 'now' };

    expect((await new SupabaseProjectStore().get('prj_1'))?.creationHandoff).toBeUndefined();
  });

  it('clearing it emits null so the DB column is actually nulled', async () => {
    returnRow = { id: 'prj_1', user_id: 'user-1', name: 'Kart Racer', created_at: 'now', updated_at: 'now' };

    await new SupabaseProjectStore().update('prj_1', { creationHandoff: undefined });
    expect(captured.update).toHaveProperty('creation_handoff', null);
  });

  it('a patch that does not mention it leaves the column alone', async () => {
    /*
     * Key-presence-driven, and load-bearing: a rename or a publish must never wipe the brief out from
     * under an unbuilt project, which would silently downgrade its first build turn.
     */
    returnRow = { id: 'prj_1', user_id: 'user-1', name: 'Renamed', created_at: 'now', updated_at: 'now' };

    await new SupabaseProjectStore().update('prj_1', { name: 'Renamed' });
    expect(captured.update).not.toHaveProperty('creation_handoff');
  });
});

describe('the client wire type', () => {
  /**
   * `sandboxId` is not part of the wire CONTRACT (§4.5.3, §5): the client supplies a PROJECT id it
   * owns, and the server resolves the VM and mints every scoped session itself.
   *
   * ⚠️ This scan proves the TYPE does not declare it — it does NOT prove the field never reaches a
   * browser, and a TypeScript type strips nothing at runtime. `api.projects.ts` and
   * `api.projects.$projectId.ts` both serialize the whole server row (`{ ...project }` / `json({
   * project })`), so once T2 persists a `sandboxId` it WILL ship to the dashboard exactly as `userId`
   * already does. That is a routing decision for T2 (hand-pick the fields, or state plainly why the
   * pointer is safe to expose), not something this assertion can see. Do not re-word it into a claim
   * about the browser — a false claim in a comment is how a defect survives review.
   */
  it('does not declare sandboxId — it is not part of the wire contract', async () => {
    const source = await fs.readFile(path.resolve(process.cwd(), 'app/types/project.ts'), 'utf8');

    expect(source).not.toMatch(/\bsandboxId\b/);

    // Control: the scan is reading the file it thinks it is.
    expect(source).toMatch(/\btemplateId\b/);
  });
});
