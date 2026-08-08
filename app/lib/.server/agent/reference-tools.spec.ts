/**
 * `load_reference` and the carry-forward that makes it cheap (Phase 2, 2026-08-08).
 *
 * This file replaces `prompt/sticky-blocks.spec.ts`, which pinned the keyword router's append-only
 * rules. Those rules were right and they are preserved here — but they now apply to what the MODEL
 * loaded rather than to what a substring table guessed, which is the whole change.
 *
 * Two categories, and they fail in opposite directions:
 *
 *   - **The BUDGET** protects a paid generation from spending every step on tool calls. Its failure is
 *     `gen_msixapaq_i871b6`: 1,489 credits, no game. It is enforced inside `execute`, checked BEFORE
 *     the store read, and it must never become a zod constraint (that kills the generation *after* the
 *     tokens are spent) nor be implemented by withdrawing the tool (a dangling instruction).
 *   - **The CARRY-FORWARD** protects the cached prefix. Its failures are silent and show up only as a
 *     bigger bill: a set that re-orders, shrinks, or flickers rewrites the prefix at the 2x cache-WRITE
 *     rate every turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_REFERENCE_LOADS,
  MAX_STICKY_REFERENCES,
  carriedReferenceIds,
  createReferenceTools,
  type ReferenceToolContext,
} from './reference-tools';
import { setPromptStore } from '~/lib/.server/prompt/store';
import { resolveReferenceId } from '~/lib/.server/prompt/sources';

const VERSION = 'pv_test';

/** Bodies by id, plus a count of reads — so a test can prove a refusal never reached the store. */
const bodies = new Map<string, string>([
  ['racing-system', 'RACING BODY'],
  ['ui-design-system', 'UI BODY'],
  ['rigidbody-physics', 'PHYSICS BODY'],
  ['audio-source', 'AUDIO BODY'],
]);

let reads: string[];

beforeEach(() => {
  reads = [];
  setPromptStore({
    get: async (id: string) => (id === VERSION ? ({ onDemandIds: [...bodies.keys()] } as never) : null),
    readOnDemand: async (versionId: string, blockId: string) => {
      reads.push(blockId);
      return versionId === VERSION ? (bodies.get(blockId) ?? null) : null;
    },
  } as never);
});

afterEach(() => {
  setPromptStore(undefined);
  vi.restoreAllMocks();
});

function ctx(overrides: Partial<ReferenceToolContext> = {}): ReferenceToolContext {
  return { versionId: VERSION, loaded: new Set(), loadedThisTurn: new Set(), ...overrides };
}

/** The tool's `execute`, which is where every rule that matters lives. */
function run(context: ReferenceToolContext) {
  const { load_reference: tool } = createReferenceTools(context);

  return (id?: string) => (tool.execute as (args: { id?: string }, opts: unknown) => Promise<string>)({ id }, {});
}

describe('load_reference — the happy path', () => {
  it('returns the document body, and records it as loaded', async () => {
    const context = ctx();
    const result = await run(context)('racing-system');

    expect(result).toContain('RACING BODY');
    expect(context.loaded.has('racing-system')).toBe(true);
    expect(context.loadedThisTurn.has('racing-system')).toBe(true);
  });

  it('names the reference in the returned block, so the model knows what it is reading', async () => {
    expect(await run(ctx())('racing-system')).toContain('racing-system');
  });
});

describe('load_reference — a bad argument is RECOVERABLE, never fatal', () => {
  /*
   * The schema accepts anything and `execute` validates, deliberately. A required zod field is enforced
   * by the AI SDK before `execute` runs and a violation throws `InvalidToolArgumentsError`, aborting
   * the stream — we watched a real edit turn die on a literal `load_skill({})`, 45s and ~3,500 output
   * tokens spent, the user's file untouched, a zod dump in the chat.
   */
  it('answers a missing id with the list of ids, rather than throwing', async () => {
    const result = await run(ctx())(undefined);

    expect(result).toContain('racing-system');
    expect(result).toMatch(/needs an "id"/);
  });

  it('answers an unknown id with the list, rather than throwing', async () => {
    const result = await run(ctx())('no-such-doc');

    expect(result).toMatch(/No reference matches "no-such-doc"/);
    expect(result).toContain('ui-design-system');
  });

  /*
   * The stale-prompt-version case wears the same clothes as a typo, and it is the one an operator will
   * actually hit: a version built before Phase 2 has only the OLD on-demand ids, so a document that is
   * now on demand resolves to nothing until a doc-sync and a promote. Listing what the version really
   * holds is what makes that diagnosable instead of mysterious.
   */
  it('lists what THIS version holds, which is how a stale prompt version explains itself', async () => {
    const result = await run(ctx({ versionId: 'pv_older' }))('racing-system');

    /*
     * A KNOWN id that this VERSION lacks — a different branch from an unresolvable name, and the
     * message says so: the id was recognised, the stored version simply does not hold it.
     */
    expect(result).toMatch(/No reference named "racing-system" exists in this prompt version/);
  });
});

describe('load_reference — an already-loaded document is one sentence, not a second copy', () => {
  it('does not re-send a body the model already has', async () => {
    const result = await run(ctx({ loaded: new Set(['racing-system']) }))('racing-system');

    expect(result).not.toContain('RACING BODY');
    expect(result).toMatch(/already loaded/i);
  });

  /*
   * Not merely an optimisation. These bodies run to 55KB, and the ids seeded into `loaded` are the ones
   * CARRIED from earlier turns — already sitting in the cached prefix. Re-sending one would pay full
   * rate for bytes the turn is already paying 0.1x for.
   */
  it('never reaches the store for an already-loaded document', async () => {
    await run(ctx({ loaded: new Set(['racing-system']) }))('racing-system');

    expect(reads).toEqual([]);
  });

  it('does not spend the budget on a re-request', async () => {
    const context = ctx({ loaded: new Set(['racing-system']) });
    await run(context)('racing-system');

    expect(context.loadedThisTurn.size).toBe(0);
  });
});

describe('🔴 the budget — MAX_REFERENCE_LOADS, enforced in execute', () => {
  it('hands over exactly MAX_REFERENCE_LOADS bodies and then refuses', async () => {
    const context = ctx();
    const load = run(context);
    const ids = [...bodies.keys()];

    for (let i = 0; i < MAX_REFERENCE_LOADS; i++) {
      expect(await load(ids[i]), `load ${i + 1} should have been allowed`).toContain('BODY');
    }

    const refused = await load(ids[MAX_REFERENCE_LOADS]);

    expect(refused).not.toContain('BODY');
    expect(refused).toMatch(/limit/i);
  });

  /*
   * Checked BEFORE the store read, so an over-budget call cannot even pay for a lookup — the same rule
   * `MAX_SKILL_LOADS` follows. Asserting the READ (not just the return value) is what makes this test
   * about ordering rather than about the message.
   */
  it('refuses before touching the store', async () => {
    const context = ctx({ loadedThisTurn: new Set(['a', 'b', 'c'].slice(0, MAX_REFERENCE_LOADS)) });
    await run(context)('racing-system');

    expect(reads).toEqual([]);
  });

  it('is a refusal the model can act on, naming what it already has', async () => {
    const context = ctx({
      loaded: new Set(['racing-system', 'ui-design-system']),
      loadedThisTurn: new Set(['a', 'b', 'c'].slice(0, MAX_REFERENCE_LOADS)),
    });

    const refused = await run(context)('audio-source');

    expect(refused).toContain('racing-system');
    expect(refused).toMatch(/Proceed with the task/);
  });

  /*
   * 🔴 The budget counts NEW loads only. Charging for documents CARRIED from earlier turns means a
   * conversation holding its cap can never load another — "withdraw the tool" returning through the
   * budget instead of the tool set, which is the failure `spec/skills.md` records and undoes.
   */
  it('does not charge the budget for documents carried from earlier turns', async () => {
    const carried = new Set(['racing-system', 'ui-design-system', 'rigidbody-physics', 'audio-source']);
    const result = await run(ctx({ loaded: carried }))('a-new-one');

    expect(result, 'a full carried set must not exhaust this turn`s budget').not.toMatch(/limit/i);
  });
});

describe('🔴 carriedReferenceIds — append-only, first-seen, truncating', () => {
  const meta = (blocksLoaded: string[]) => ({ annotations: [{ type: 'agentMeta', value: { blocksLoaded } }] });

  it('reads the ids off the agentMeta annotation', () => {
    expect(carriedReferenceIds([meta(['racing-system'])])).toEqual(['racing-system']);
  });

  /*
   * FIRST-SEEN order, never sorted and never re-derived. The carried set sits in the cached prefix, so
   * an id inserted ahead of one that was already there rewrites every byte behind it at the 2x
   * cache-write rate. Append-only has to hold at the BYTE level, not merely as a set.
   */
  it('keeps first-seen order across turns, so the prefix only ever grows', () => {
    const ids = carriedReferenceIds([meta(['ui-design-system']), meta(['ui-design-system', 'racing-system'])]);

    expect(ids).toEqual(['ui-design-system', 'racing-system']);
  });

  it('never duplicates an id repeated on every turn', () => {
    const ids = carriedReferenceIds([meta(['racing-system']), meta(['racing-system']), meta(['racing-system'])]);

    expect(ids).toEqual(['racing-system']);
  });

  /*
   * The cap TRUNCATES, never rotates. Rotation makes the set change without growing, which is the same
   * prefix rewrite wearing a different hat.
   */
  it('truncates at the cap rather than rotating', () => {
    const many = Array.from({ length: MAX_STICKY_REFERENCES + 3 }, (_, i) => `doc-${i}`);
    const ids = carriedReferenceIds([meta(many)]);

    expect(ids).toEqual(many.slice(0, MAX_STICKY_REFERENCES));
  });

  it('ignores annotations that are not agentMeta, and messages with none', () => {
    expect(
      carriedReferenceIds([
        {},
        { annotations: 'not an array' },
        { annotations: [null, 'nope', { type: 'usage', value: { blocksLoaded: ['racing-system'] } }] },
      ]),
    ).toEqual([]);
  });

  it('ignores non-string entries rather than carrying them into a store read', () => {
    expect(
      carriedReferenceIds([{ annotations: [{ type: 'agentMeta', value: { blocksLoaded: [1, '', 'ok'] } }] }]),
    ).toEqual(['ok']);
  });
});

/**
 * 🔴 THE AGENT REFERENCE IS WRITTEN IN URLs AND WE SERVE IDs (2026-08-08).
 *
 * Measured across `babylontoolkit/agent`: **90 cross-document references in 12 files**, every one
 * phrased as *"Always reference the Babylon Toolkit Component Reference at
 * https://raw.githubusercontent.com/…"*. Those sentences are correct in VS Code, where the model can
 * fetch. Here the document is right there behind `load_reference` under a name the doc never mentions
 * — so a model doing exactly as instructed got a refusal.
 *
 * Accepting the URL closes that without one byte changing in the docs repo, which is the point: they
 * stay correct for every other host and become literally executable here.
 */
describe('load_reference accepts what the DOCS say, not only what our index says', () => {
  const cases: Array<[string, string]> = [
    ['the id from our index', 'racing-system'],
    [
      'the full raw URL, as quoted in a doc',
      'https://raw.githubusercontent.com/babylontoolkit/agent/main/training/components/13-RacingSystem.md',
    ],
    ['the repo-relative path', 'training/components/13-RacingSystem.md'],
    ['the bare filename', '13-RacingSystem.md'],
    ['the filename without its extension', '13-RacingSystem'],
    [
      'a URL with the prose sentence’s full stop attached',
      'https://raw.githubusercontent.com/babylontoolkit/agent/main/training/components/13-RacingSystem.md.',
    ],
  ];

  it.each(cases)('resolves %s', (_label, spelling) => {
    expect(resolveReferenceId(spelling)).toBe('racing-system');
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(resolveReferenceId('  TRAINING/COMPONENTS/13-RacingSystem.MD  ')).toBe('racing-system');
  });

  /*
   * Resolution happens BEFORE the already-loaded guard, the budget and the carry-forward, all of which
   * key on the canonical id. Without that ordering one document loads twice under two spellings and is
   * billed for both — and the carried set would then hold two names for one thing, permanently.
   */
  it('canonicalises before the already-loaded guard, so one doc cannot load twice under two names', async () => {
    const context = ctx({ loaded: new Set(['racing-system']) });
    const result = await run(context)('training/components/13-RacingSystem.md');

    expect(result).toMatch(/already loaded/i);
    expect(reads).toEqual([]);
  });

  it('reads the store with the canonical id, never the spelling the model used', async () => {
    const context = ctx();
    await run(context)(
      'https://raw.githubusercontent.com/babylontoolkit/agent/main/training/components/13-RacingSystem.md',
    );

    expect(reads).toEqual(['racing-system']);
    expect([...context.loaded]).toEqual(['racing-system']);
  });

  /*
   * No fuzzy matching, no nearest-neighbour, no scoring. A WRONG document delivered confidently is far
   * worse than a refusal that lists the alternatives — it is the keyword router's failure mode returning
   * through the back door.
   */
  it('refuses a near-miss rather than guessing', () => {
    expect(resolveReferenceId('racing')).toBeNull();
    expect(resolveReferenceId('RacingSystem.md')).toBeNull();
    expect(resolveReferenceId('')).toBeNull();
    expect(resolveReferenceId('   ')).toBeNull();
  });
});

/**
 * The documents the BAKED router index names that this platform deliberately does not serve.
 *
 * `reference.md` is authored for every host, so its table is right elsewhere and wrong here. Since the
 * model now has a tool it will follow that table and ask — and a bare "no such reference" reads as a
 * platform fault, whose natural next move is to improvise the very thing the exclusion prevents.
 */
describe('an EXCLUDED document explains itself instead of looking broken', () => {
  it('tells the model why UMD is unavailable, and what to do instead', async () => {
    const result = await run(ctx())('classic');

    expect(result).toMatch(/ESM-only/);
    expect(result).toMatch(/never emit UMD/i);
    expect(result, 'a bare not-found invites improvisation').not.toMatch(/^No reference matches/);
  });

  it('tells the model skills are already served here, so there is nothing to install', async () => {
    expect(await run(ctx())('skills-repository')).toMatch(/load_skill/);
  });

  it('recognises an excluded document by the URL the index gave it', async () => {
    const url = 'https://raw.githubusercontent.com/babylontoolkit/agent/main/references/classic.md';

    expect(await run(ctx())(url)).toMatch(/ESM-only/);
  });

  it('never spends the budget or reaches the store for an excluded document', async () => {
    const context = ctx();
    await run(context)('classic');

    expect(reads).toEqual([]);
    expect(context.loadedThisTurn.size).toBe(0);
  });

  /*
   * CONTROL: the exclusion path must not swallow an ordinary unknown id, or every typo would come back
   * as a confident explanation of a rule that has nothing to do with it.
   */
  it('CONTROL — an ordinary unknown id still reports not-found with the list', async () => {
    const result = await run(ctx())('no-such-doc');

    expect(result).toMatch(/No reference matches/);
    expect(result).toContain('ui-design-system');
  });
});
