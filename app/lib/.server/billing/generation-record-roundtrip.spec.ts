/**
 * What a `generations` row REMEMBERS, on the only backend that bills real money (SPEC §4.6, §4.2a).
 *
 * 🔴 **Five declared fields had nowhere to land.** `rawStops`, `fallbackHandoffs` and `blocksLoaded`
 * were declared on `GenerationRecord`, written in local FS mode, and — until migration 0023 — had no
 * Postgres column at all, so the Supabase store never mentioned them and they evaporated on every
 * production deploy. `chatId` was written to `message_id` and never once read back. Nothing threw,
 * no build failed, and the row simply came back missing a field it claims to carry.
 *
 * The most expensive of them is `fallbackHandoffs`, whose ENTIRE reason for existing is to record
 * that a different model served a turn while the turn billed at the requested model's rates. In
 * production that fact had nowhere to go.
 *
 * 🔴 **And `blocksLoaded` was worse than absent: it was fabricated.** `toGenerationRecord` hardcoded
 * `[]`, so a Postgres deploy answered "no on-demand doc blocks were loaded" for every generation ever
 * written, with total confidence and no way to tell it from the truth — on the one number the whole
 * §4.2.8 context-budget programme is measured by. That is the pattern migration 0021 killed for
 * `provider`, arriving one field to the left. So the suite asserts the DISTINCTION, in both
 * directions: a row that never recorded blocks reads back `undefined`, a row that recorded an empty
 * array reads back `[]`, and the write side sends `null` rather than `[]` so the two stay tellable
 * apart in the column. An assertion on either half alone passes for a store that fabricates the
 * other.
 *
 * The second half is `totalTokens`, which is DERIVED on read (`FIELD_COVERAGE`) rather than stored.
 * That is not a saving, it is a defence: before T12 the FS record persisted the wire's number while
 * `gate.ts` and this mapper derived it, and on an inclusive-cache family the two differed by exactly
 * the cache read (`gen_msopyq5f`: 17,464 + 78 stored as 35,431). So the round trip is driven by the
 * REAL `accumulateStepUsage` over a real multi-step turn — a hand-written totals object would assert
 * the arithmetic this test exists to check against a copy of itself.
 *
 * Lives in its own file because it needs `~/lib/.server/supabase/client` mocked, and the specs beside
 * it must import the real one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accumulateStepUsage, emptyUsage, type UsageStep } from '~/lib/.server/agent/step-usage';
import type { GenerationRecord, GenerationUpsert } from './generations';

/** Every payload the store sent, in order — "it returned the right record" passes on the wrong write. */
const upserts: Array<{ payload: Record<string, any>; options: unknown }> = [];

/** The rows the fake table answers a `select().in()` with. */
let rows: Array<Record<string, any>> = [];

/** What the store filtered on, so a read that ignores its ids cannot pass by returning everything. */
let selectedIds: unknown;

vi.mock('~/lib/.server/supabase/client', () => ({
  isSupabaseConfigured: () => true,
  createAdminClient: async () => ({
    from: () => ({
      upsert: (payload: Record<string, any>, options: unknown) => {
        upserts.push({ payload, options });
        return Promise.resolve({ error: null });
      },
      select: () => ({
        in: (_column: string, ids: string[]) => {
          selectedIds = ids;
          return Promise.resolve({ data: rows.filter((row) => ids.includes(row.id)) });
        },
      }),
    }),
  }),
}));

const generations = await import('./generations');
const store = () => new generations.SupabaseGenerationStore();

const ANCHOR = { id: 'gen_1', userId: 'usr_1', model: 'claude-opus-5' } satisfies GenerationUpsert;

function lastPayload(): Record<string, any> {
  return upserts[upserts.length - 1].payload;
}

/**
 * Write a record, then read back exactly what was written.
 *
 * The upsert payload's keys ARE the column names, so feeding it back as a row is the honest shape of
 * the round trip: anything the store declines to send is a column the mapper genuinely cannot find.
 */
async function roundTrip(row: GenerationUpsert): Promise<{ payload: Record<string, any>; record: GenerationRecord }> {
  const s = store();
  await s.upsert(row);

  const payload = lastPayload();
  rows = [{ ...payload }];

  const [record] = await s.listByIds([row.id]);

  return { payload, record };
}

beforeEach(() => {
  upserts.length = 0;
  rows = [];
  selectedIds = undefined;
});

describe('the five fields that used to vanish on Postgres (migration 0023)', () => {
  const carried = {
    ...ANCHOR,
    chatId: 'cht_9',
    rawStops: ['refusal', 'end_turn'],

    // A realistic handoff: the requested model declined and another served the turn, at the first's rates.
    fallbackHandoffs: ['claude-fable-5→claude-opus-5'],
    blocksLoaded: ['racing-system', 'scene-manager'],
  } satisfies GenerationUpsert;

  it('sends all four to their columns', async () => {
    await store().upsert(carried);

    const payload = lastPayload();

    expect(payload.raw_stops).toEqual(['refusal', 'end_turn']);
    expect(payload.fallback_handoffs).toEqual(['claude-fable-5→claude-opus-5']);
    expect(payload.blocks_loaded).toEqual(['racing-system', 'scene-manager']);

    // `chatId` had a column for the life of the store and was never read back out of it.
    expect(payload.message_id).toBe('cht_9');
  });

  it('reads all four back unchanged', async () => {
    const { record } = await roundTrip(carried);

    expect(record.rawStops).toEqual(['refusal', 'end_turn']);
    expect(record.fallbackHandoffs).toEqual(['claude-fable-5→claude-opus-5']);
    expect(record.blocksLoaded).toEqual(['racing-system', 'scene-manager']);
    expect(record.chatId).toBe('cht_9');

    // The read is scoped, not a table scan the filter happens to agree with.
    expect(selectedIds).toEqual(['gen_1']);
  });

  /*
   * 🔴 THE POINT OF THE WHOLE FIELD. "We recorded none" and "we never recorded" are different answers
   * and the second one is the truth for every row written before 0023. A `?? []` on either side of the
   * wire collapses them into a confident lie about the context-budget programme's own metric.
   */
  it('distinguishes a row that recorded NO blocks from one that never recorded blocks at all', async () => {
    const [neverRecorded] = await (async () => {
      rows = [{ id: 'gen_old', user_id: 'usr_1', model: 'claude-opus-5', input_tokens: 0, output_tokens: 0 }];
      return store().listByIds(['gen_old']);
    })();

    expect(neverRecorded.blocksLoaded).toBeUndefined();

    /*
     * CONTROL: an empty array is a real answer and must survive as one, or the assertion above passes
     * for a mapper that simply drops the column.
     */
    const { record: recordedNone } = await roundTrip({ ...ANCHOR, blocksLoaded: [] });

    expect(recordedNone.blocksLoaded).toEqual([]);
  });

  it('distinguishes never-recorded from recorded-and-empty for rawStops and fallbackHandoffs too', async () => {
    const [neverRecorded] = await (async () => {
      rows = [{ id: 'gen_old', user_id: 'usr_1', model: 'claude-opus-5', input_tokens: 0, output_tokens: 0 }];
      return store().listByIds(['gen_old']);
    })();

    expect(neverRecorded.rawStops).toBeUndefined();
    expect(neverRecorded.fallbackHandoffs).toBeUndefined();

    const { record } = await roundTrip({ ...ANCHOR, rawStops: [], fallbackHandoffs: [] });

    expect(record.rawStops).toEqual([]);
    expect(record.fallbackHandoffs).toEqual([]);
  });

  /*
   * The write half of the same distinction. `?? []` here would record "there were none" for a
   * settlement anchor that simply does not know yet — re-creating the fabrication in the one place a
   * read-side test cannot see it.
   */
  it('sends NULL, not an empty array, for an absent array field', async () => {
    await store().upsert(ANCHOR);

    const payload = lastPayload();

    expect(payload.raw_stops).toBeNull();
    expect(payload.fallback_handoffs).toBeNull();
    expect(payload.blocks_loaded).toBeNull();
    expect(payload.message_id).toBeNull();
  });
});

/*
 * ---------------------------------------------------------------------------------------------
 * `totalTokens` — derived on read, and it must agree with what settlement counted
 * ---------------------------------------------------------------------------------------------
 */

/**
 * A cache-heavy turn on an INCLUSIVE-cache family (`codex`: `promptTokensIncludeCacheRead: true`),
 * where the wire's `promptTokens` and `totalTokens` both count the cached tokens that
 * `accumulateStepUsage` subtracts. This is the shape that produced the live 1.86x over-charge and the
 * stored-vs-derived split — a claude fixture cannot exercise either, because the subtraction is a
 * no-op there.
 */
const INCLUSIVE_STEPS: UsageStep[] = [
  {
    usage: { promptTokens: 100_000, completionTokens: 500, totalTokens: 100_500 },
    providerMetadata: { openai: { cachedPromptTokens: 90_000 } },
  },
  {
    usage: { promptTokens: 101_000, completionTokens: 800, totalTokens: 101_800 },
    providerMetadata: { openai: { cachedPromptTokens: 100_000 } },
  },
  {
    usage: { promptTokens: 102_000, completionTokens: 12_000, totalTokens: 114_000 },
    providerMetadata: { openai: { cachedPromptTokens: 100_000 } },
  },
];

/** Both cache classes non-zero, on the family whose wire actually reports a cache WRITE counter. */
const CACHE_WRITE_STEPS: UsageStep[] = [
  {
    usage: { promptTokens: 4_000, completionTokens: 600, totalTokens: 4_600 },
    providerMetadata: { anthropic: { cacheReadInputTokens: 0, cacheCreationInputTokens: 31_000 } },
  },
  {
    usage: { promptTokens: 900, completionTokens: 5_000, totalTokens: 5_900 },
    providerMetadata: { anthropic: { cacheReadInputTokens: 31_000, cacheCreationInputTokens: 0 } },
  },
];

/** No cache at all — the ordinary cold turn, and the control that the derivation is not luck. */
const NO_CACHE_STEPS: UsageStep[] = [
  { usage: { promptTokens: 1_200, completionTokens: 300, totalTokens: 1_500 } },
  { usage: { promptTokens: 800, completionTokens: 2_400, totalTokens: 3_200 } },
];

describe('totalTokens survives the round trip as a derivation, never as a second stored copy', () => {
  it('matches accumulateStepUsage on a cache-heavy inclusive-family turn', async () => {
    const usage = accumulateStepUsage(emptyUsage(), INCLUSIVE_STEPS, 'codex');

    // Guard the fixture itself: a turn with no cache reads would make this whole case vacuous.
    expect(usage.cacheReadTokens).toBe(290_000);

    const { record } = await roundTrip({ ...ANCHOR, model: 'gpt-5-6-terra', ...usage });

    expect(record.promptTokens).toBe(usage.promptTokens);
    expect(record.completionTokens).toBe(usage.completionTokens);
    expect(record.totalTokens).toBe(usage.totalTokens);
    expect(record.cacheReadTokens).toBe(usage.cacheReadTokens);
  });

  it('matches accumulateStepUsage when BOTH cache classes are non-zero', async () => {
    const usage = accumulateStepUsage(emptyUsage(), CACHE_WRITE_STEPS, 'claude');

    expect(usage.cacheReadTokens).toBe(31_000);
    expect(usage.cacheCreationTokens).toBe(31_000);

    const { record } = await roundTrip({ ...ANCHOR, ...usage });

    expect(record.totalTokens).toBe(usage.totalTokens);
    expect(record.cacheReadTokens).toBe(31_000);
    expect(record.cacheCreationTokens).toBe(31_000);
  });

  /*
   * CONTROL. Without a zero-cache case the suite could pass on a formula that happens to be right
   * only where the subtraction fires; without the inclusive case above it could pass on the old
   * formula that ignored the cache entirely. Both, or neither proves anything.
   */
  it('matches accumulateStepUsage on a turn with no cache activity at all', async () => {
    const usage = accumulateStepUsage(emptyUsage(), NO_CACHE_STEPS, 'claude');

    expect(usage.cacheReadTokens).toBe(0);
    expect(usage.cacheCreationTokens).toBe(0);

    const { record } = await roundTrip({ ...ANCHOR, ...usage });

    expect(record.totalTokens).toBe(usage.totalTokens);
  });

  /*
   * The derivation the mapper is allowed to use, asserted against the accumulator directly. If this
   * ever stops holding, `input_tokens + output_tokens` is the wrong formula and every assertion above
   * would go green while reporting a total that disagrees with what settlement billed.
   */
  it('keeps accumulateStepUsage totalTokens equal to promptTokens + completionTokens', () => {
    const usage = accumulateStepUsage(emptyUsage(), INCLUSIVE_STEPS, 'codex');

    expect(usage.totalTokens).toBe(usage.promptTokens + usage.completionTokens);
  });
});
