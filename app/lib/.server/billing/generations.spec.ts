/**
 * `listByIds` — the batched lookup that lets the credits panel say what a debit was FOR (SPEC §4.6).
 *
 * It is a DECORATION path, and every assertion here is about that: a ledger row whose generation row
 * is missing, swept or corrupt must still render as itself. The balance and the history are what that
 * panel exists for, and neither may depend on this lookup succeeding.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsGenerationStore } from './generations';

/**
 * 🔴 A THROWAWAY DIRECTORY, ALWAYS.
 *
 * `new FsGenerationStore()` with no argument resolves to `platformDataDir()/generations` — the
 * developer's REAL `.data`, which `buildUsageReport` lists into the §4.10 admin dashboard. A spec that
 * takes the default deposits its fixtures into the numbers an operator reads to decide whether the
 * platform is healthy (`billing.spec.ts` records exactly that happening, with a row named `g-fail`
 * recorded as a completed generation charging 14 credits).
 */
let tmp: string;
let store: FsGenerationStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'generations-'));
  store = new FsGenerationStore(tmp);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function seed(id: string, over: Record<string, unknown> = {}) {
  await store.upsert({ id, userId: 'u-1', model: 'claude-opus-5', ...over });
}

describe('FsGenerationStore.listByIds', () => {
  it('returns the rows it was asked for', async () => {
    await seed('g-1', { statusKind: 'creation' });
    await seed('g-2', { statusKind: 'edit' });
    await seed('g-3');

    const found = await store.listByIds(['g-1', 'g-2']);

    expect(found.map((r) => r.id).sort()).toEqual(['g-1', 'g-2']);
    expect(found.find((r) => r.id === 'g-1')?.statusKind).toBe('creation');
  });

  /*
   * Ids not found are simply ABSENT — never an error and never a placeholder row. A generation swept
   * by retention still has its ledger entry, and that entry has to render.
   */
  it('omits ids that do not exist, and returns the ones that do', async () => {
    await seed('g-1');

    const found = await store.listByIds(['g-1', 'never-existed']);

    expect(found.map((r) => r.id)).toEqual(['g-1']);
  });

  it('survives a corrupt record — the others still come back', async () => {
    await seed('g-1');
    await fs.writeFile(path.join(tmp, 'g-broken.json'), '{ not json', 'utf8');

    const found = await store.listByIds(['g-1', 'g-broken']);

    expect(found.map((r) => r.id)).toEqual(['g-1']);
  });

  /*
   * The caller builds this list from a page of ledger entries, and a generation with a debit AND its
   * refund appears twice there. Reading the same file twice is wasted I/O; returning it twice would
   * put a second copy into the `byId` map's source and, more to the point, misreport how many rows the
   * lookup actually resolved.
   */
  it('de-duplicates the requested ids', async () => {
    await seed('g-1');

    expect(await store.listByIds(['g-1', 'g-1', 'g-1'])).toHaveLength(1);
  });

  it('an empty request is an empty answer, not a directory scan', async () => {
    await seed('g-1');

    expect(await store.listByIds([])).toEqual([]);
  });

  /* A missing directory (a fresh deploy, nothing generated yet) is not an error either. */
  it('returns nothing when the store has never been written', async () => {
    const empty = new FsGenerationStore(path.join(tmp, 'does-not-exist'));

    expect(await empty.listByIds(['g-1'])).toEqual([]);
  });

  /*
   * The id becomes a filename, so it is sanitised on write — and `listByIds` must sanitise IDENTICALLY
   * or it looks up a name that was never written. Asserted through the pair rather than by reading the
   * regex, because a divergence here is silent: every decorated row simply stops being decorated.
   */
  it('reads back an id that had to be sanitised into a filename', async () => {
    await seed('gen_msixapaq_i871b6');

    expect((await store.listByIds(['gen_msixapaq_i871b6'])).map((r) => r.id)).toEqual(['gen_msixapaq_i871b6']);
  });
});
