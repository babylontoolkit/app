/**
 * `SupabaseGenerationStore.hasBilledGeneration` — the production half of "did this project ever deliver
 * a build the user paid for?" (§4.4a, migration 0015).
 *
 * 🔴 **It must fail CLOSED.** Its one caller decides whether to hand credits BACK on a project delete,
 * so a read error that answers `false` reads as "nothing was ever built" and refunds the creation charge
 * on EVERY deletion for the duration of an outage — including projects that were built, shared and
 * played. Failing closed costs one honest user one refund they can ask for; failing open pays out
 * platform-wide, silently, with the DELETE still reporting success either way.
 *
 * The other two properties are the predicate itself: `project_id` scoping (drop it and one billed
 * generation anywhere blocks every refund) and `credits_charged > 0` rather than "a row exists" (drop it
 * and a FAILED generation — already auto-refunded under §4.6 — silently keeps the creation charge).
 *
 * Lives in its own file because it needs `~/lib/.server/supabase/client` mocked, and the route spec
 * beside it must import the real one.
 */
import { describe, expect, it, vi } from 'vitest';

const select = vi.fn();

vi.mock('~/lib/.server/supabase/client', () => ({
  isSupabaseConfigured: () => true,
  createAdminClient: async () => ({ from: () => ({ select: (...args: unknown[]) => select(...args) }) }),
}));

const generations = await import('./generations');
const store = () => new generations.SupabaseGenerationStore();

/**
 * Records the query the store builds and answers with whatever the test supplies. Every filter is
 * captured, because "it returned the right boolean" passes just as well with the wrong WHERE clause.
 */
function respondWith(result: { data?: unknown[]; error?: { message: string } }) {
  const calls: Array<[string, unknown]> = [];

  select.mockImplementation(() => {
    const chain = {
      eq: (column: string, value: unknown) => {
        calls.push(['eq', [column, value]]);
        return chain;
      },
      gt: (column: string, value: unknown) => {
        calls.push(['gt', [column, value]]);
        return chain;
      },
      limit: (n: number) => {
        calls.push(['limit', n]);
        return Promise.resolve(result);
      },
    };

    return chain;
  });

  return calls;
}

describe('SupabaseGenerationStore.hasBilledGeneration', () => {
  it('is true when the query returns a row', async () => {
    respondWith({ data: [{ id: 'g1' }] });

    expect(await store().hasBilledGeneration('prj_1')).toBe(true);
  });

  it('is false when the query returns nothing', async () => {
    respondWith({ data: [] });

    expect(await store().hasBilledGeneration('prj_1')).toBe(false);
  });

  /*
   * 🔴 The one that costs real money if inverted: a `return false` here refunds every project deleted
   * during a database blip, and nothing throws.
   */
  it('is TRUE when the read fails — fail closed, never pay out on an outage', async () => {
    respondWith({ error: { message: 'connection reset' } });

    expect(await store().hasBilledGeneration('prj_1')).toBe(true);
  });

  /* A null `data` with no error is "no rows", not an outage — do not fail closed on the ordinary case. */
  it('is false when the query returns null data without an error', async () => {
    respondWith({ data: undefined });

    expect(await store().hasBilledGeneration('prj_1')).toBe(false);
  });

  /*
   * The predicate, asserted as the QUERY. Both halves are load-bearing and a boolean assertion cannot
   * see either one: scope to THIS project, and require credits actually charged.
   */
  it('scopes to the project AND requires credits_charged > 0', async () => {
    const calls = respondWith({ data: [] });

    await store().hasBilledGeneration('prj_1');

    expect(calls).toContainEqual(['eq', ['project_id', 'prj_1']]);
    expect(calls).toContainEqual(['gt', ['credits_charged', 0]]);

    // One row is enough to answer a boolean; scanning a project's whole history is wasted work.
    expect(calls).toContainEqual(['limit', 1]);
  });
});
