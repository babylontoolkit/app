/**
 * One open billing owner per managed session (`_specs/no-unbilled-usage_plan.md` residual R2b, migration 0030).
 *
 * An open orphan OWNS a session's cost cursor: the sweep settles the session from it. Two concurrent rebinds
 * of a still-running switched session each kept it for the sweep — and the record was a blind upsert, so the
 * cursor that landed LAST won (an older one re-bills everything between the two), and a record arriving after
 * the sweep had resolved the orphan REOPENED it with an old cursor (re-billing the whole settled range).
 *
 * Every store pinned to a throwaway directory.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsManagedOrphanStore, mergeOrphanCursors } from './orphans';
import { EMPTY_COST_CURSOR, parseCostCursor, serializeCostCursor } from './session-cost';

const USER = '66666666-6666-4666-8666-666666666666';

let tmp: string;
let store: FsManagedOrphanStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'orphans-'));
  store = new FsManagedOrphanStore(tmp);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const cursorAt = (credits: number, input: number, pending: string[] = []) =>
  serializeCostCursor({
    ...EMPTY_COST_CURSOR,
    credits,
    tokens: { ...EMPTY_COST_CURSOR.tokens, input },
    pending: pending.map((generationId) => ({
      generationId,
      credits: 5,
      rawCostUsd: 0.01,
      model: 'm',
      userId: USER,
      projectId: 'prj',
      chatId: 'chat',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
    })),
  });

const keep = (cursor: string | null, chatId = 'chat') =>
  store.record({ userId: USER, projectId: 'prj', chatId, sessionId: 'sesn_1', cursor, model: 'm' });

describe('one open owner per session (R2b)', () => {
  it('a second record keeps the MORE ADVANCED cursor, whatever order they land in', async () => {
    await keep(cursorAt(40, 4000));
    await keep(cursorAt(25, 2500)); // the older settlement's record lands last

    const open = await store.listOpen();

    expect(open).toHaveLength(1);
    expect(parseCostCursor(open[0].cursor)?.credits, 'never rewound to the older cursor').toBe(40);
  });

  it('pending intents of both records are kept (a duplicate debit is refused by 0029)', async () => {
    await keep(cursorAt(40, 4000, ['gen_a']));
    await keep(cursorAt(25, 2500, ['gen_b']));

    const pending = parseCostCursor((await store.listOpen())[0].cursor)?.pending?.map((p) => p.generationId);

    expect(pending?.sort()).toEqual(['gen_a', 'gen_b']);
  });

  it('a RESOLVED orphan is never reopened by a late record', async () => {
    const first = await keep(cursorAt(40, 4000));

    await store.resolve(first.id);
    await keep(cursorAt(25, 2500));

    expect(await store.listOpen(), 'the sweep billed it in full — reopening re-bills').toEqual([]);
  });

  it('the same session under another id joins the open orphan (one open per SESSION)', async () => {
    await keep(cursorAt(10, 1000), 'chat');
    await keep(cursorAt(30, 3000), 'chat_other');

    const open = await store.listOpen();

    expect(open).toHaveLength(1);
    expect(parseCostCursor(open[0].cursor)?.credits).toBe(30);
  });

  /* CONTROL — a different session is its own orphan. */
  it('CONTROL: two sessions are two orphans', async () => {
    await keep(cursorAt(10, 1000));
    await store.record({
      userId: USER,
      projectId: 'prj',
      chatId: 'chat',
      sessionId: 'sesn_2',
      cursor: null,
      model: 'm',
    });

    expect(await store.listOpen()).toHaveLength(2);
  });
});

describe('mergeOrphanCursors', () => {
  it('prefers the parseable cursor, and the other when one is missing', () => {
    expect(mergeOrphanCursors(null, cursorAt(5, 1))).toBe(cursorAt(5, 1));
    expect(mergeOrphanCursors(cursorAt(5, 1), null)).toBe(cursorAt(5, 1));
  });

  it('on equal credits, the one with more tokens wins', () => {
    expect(parseCostCursor(mergeOrphanCursors(cursorAt(5, 100), cursorAt(5, 900)))?.tokens.input).toBe(900);
  });
});
