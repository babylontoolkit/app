/**
 * 🔴 A FIELD ON `GenerationRecord` WITH NO COLUMN IS A DEFECT, AND IT MUST BECOME IMPOSSIBLE TO ADD
 * ANOTHER ONE SILENTLY (SPEC §4.5.5, `_specs/model-visible-invariant_spec.md` live defect 1).
 *
 * Five fields were declared on the type and were wrong on Postgres, in three different ways — which
 * is the point: one guard has to catch all three, because they are one defect class wearing three
 * faces.
 *
 *   - `rawStops`, `fallbackHandoffs`, `blocksLoaded` — written in local FS mode, **no column, not
 *     mentioned by the Supabase store**. Added to the type and never to a migration.
 *   - `blocksLoaded` again, worse — `toGenerationRecord` returned a hardcoded `[]`, so a Postgres
 *     deploy answered "no doc blocks were loaded" for every row: confidently wrong, not absent.
 *   - `chatId` — **written** to `message_id` since this store existed, and never once **read back**.
 *   - `totalTokens` — never a column at all, always derived on read, and until this feature nothing
 *     said so, so a reader could not tell an intentional derivation from a forgotten column.
 *
 * Nothing threw for any of them. And one is `fallbackHandoffs`, the field that records that a
 * DIFFERENT MODEL SERVED THE TURN (§4.2a) while the turn billed at the requested model's rates.
 *
 * `FIELD_COVERAGE` is a `Record` over `keyof GenerationRecord`, so the COMPILER catches a new field
 * with no answer. This file catches the other half: an answer that is not true of the code. It is a
 * source scan for the same reason `budgets-wiring.spec.ts` is one — the two stores cannot be diffed at
 * runtime without a live Postgres, and the interesting failure is a column literal that is present in
 * a type and absent from a payload.
 *
 * ⚠️ Like every scanner in this repo it carries CONTROLS, because a scanner whose pattern silently
 * stops matching reports a clean bill of health forever.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIELD_COVERAGE, type FieldCoverage } from './generations';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

/** The doc comments quote these column names constantly; a scan that counts prose proves nothing. */
const codeOnly = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    .join('\n');

const source = () => codeOnly(read('app/lib/.server/billing/generations.ts'));

/**
 * 🔴 THE HALF THAT MAKES THE GUARD COVER ITS OWN DEFECT CLASS.
 *
 * Scanning only the store answers "does the code write this column?" — never "does the column exist?".
 * Those are different questions and the defect being fixed is the second one: a field was added to the
 * type, the payload was never updated, and NO MIGRATION WAS EVER WRITTEN. A guard that reads only the
 * store can be satisfied by adding one line to the payload, which produces a store whose every write
 * is rejected by Postgres at runtime — the same defect, one layer down, and now with a green test.
 */
const migrations = () => {
  const dir = join(process.cwd(), 'supabase/migrations');

  return (
    readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n')
      /*
       * ⚠️ COMMENT-STRIPPED, and `comment on column` statements dropped with them. The migrations are
       * mostly prose — 0023 is forty lines of argument around six of DDL — and every column name
       * appears in that prose and in a `comment on column` string literal. Without this, a `persisted`
       * entry naming a column that exists ONLY in a sentence would satisfy the existence check, and
       * the assertion would prove the opposite of what it claims. The `generations.ts` half of this
       * scanner has always stripped comments; the SQL half must apply the same rigour or one scanner
       * enforces two standards.
       */
      .replace(/^\s*--.*$/gm, '')
      .replace(/comment on column[\s\S]*?;/gi, '')
  );
};

/** The object literal handed to `.upsert(...)` — everything the Supabase store actually writes. */
const upsertPayload = () =>
  source().match(/\.from\('generations'\)\.upsert\(\s*\{[\s\S]*?\},\s*\{ onConflict/)?.[0] ?? '';

/** The row -> record mapping — everything the Supabase store actually reads. */
const mapper = () =>
  source().match(/function toGenerationRecord\(r: any\): GenerationRecord \{[\s\S]*?\n\}/)?.[0] ?? '';

/** The prose floor `outbound-enumerate.spec.ts` uses: a reason short enough to be a label is not one. */
const MIN_REASON_CHARS = 30;

const entries = Object.entries(FIELD_COVERAGE) as Array<[string, FieldCoverage]>;

describe('every GenerationRecord field has a column and a writer, or is declared derived', () => {
  it('declares a coverage for every field and nothing else', () => {
    /* The `Record<keyof …>` typing is the real guard; this proves the table is not empty or stubbed. */
    expect(entries.length).toBeGreaterThan(20);
  });

  /*
   * 🔴 THE TEST THAT MATTERS. It reports EVERY offender at once rather than stopping at the first,
   * because the failure this exists for is a batch: a migration that forgot three columns looks
   * identical to one that forgot one until you can see the list.
   */
  it('has no field whose declaration disagrees with the store', () => {
    const payload = upsertPayload();
    const read = mapper();
    const sql = migrations();
    const violations: string[] = [];

    for (const [field, coverage] of entries) {
      if (coverage.kind === 'persisted' || coverage.kind === 'database') {
        /* The column must EXIST before either store can be right about it. */
        if (!new RegExp(`\\b${coverage.column}\\b`).test(sql)) {
          violations.push(`${field}: declared as column '${coverage.column}', which no migration creates`);
        }
      }

      if (coverage.kind === 'persisted') {
        if (!new RegExp(`(^|[\\s{,])${coverage.column}:`, 'm').test(payload)) {
          violations.push(`${field}: declared persisted as '${coverage.column}', but the upsert never writes it`);
        }

        if (!new RegExp(`\\br\\.${coverage.column}\\b`).test(read)) {
          violations.push(
            `${field}: declared persisted as '${coverage.column}', but toGenerationRecord never reads it`,
          );
        }
      }

      if (coverage.kind === 'database') {
        /*
         * The floor applies to EVERY variant that carries a reason. Enforcing it only on `derived`
         * left it vacuous on the one variant that actually had an instance — an assertion aimed at
         * the empty half of the table, which is the shape this repo keeps recording as "no test".
         */
        if (coverage.reason.trim().length <= MIN_REASON_CHARS) {
          violations.push(`${field}: declared a database default with a reason too short to be one`);
        }

        if (!new RegExp(`\\br\\.${coverage.column}\\b`).test(read)) {
          violations.push(`${field}: declared a database default, but toGenerationRecord never reads it back`);
        }

        /* A store that sends a database-filled column is a second writer for a value it cannot know. */
        if (new RegExp(`(^|[\\s{,])${coverage.column}:`, 'm').test(payload)) {
          violations.push(`${field}: declared a database default, but the store sends '${coverage.column}' anyway`);
        }
      }

      if (coverage.kind === 'derived') {
        if (coverage.reason.trim().length <= MIN_REASON_CHARS) {
          violations.push(`${field}: declared derived with a reason too short to be one`);
        }

        /* A "derived" field that quietly reads its own column is mislabelled — the same bug inverted. */
        const ownColumn = field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

        if (new RegExp(`\\br\\.${ownColumn}\\b`).test(read)) {
          violations.push(`${field}: declared derived, but toGenerationRecord reads the column 'r.${ownColumn}'`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  /*
   * 🔴 THE REVERSE DIRECTION. Everything above asks "does this declared field have a column?" — the
   * mirror question is "does this written column have a declaration?", and nothing was asking it. A
   * payload key with no `FIELD_COVERAGE` entry is invisible to the compiler guard (which only ranges
   * over `keyof GenerationRecord`) AND to the checks above, so a column could be written, read, and
   * documented nowhere.
   */
  it('has no column in the payload that the table does not declare', () => {
    const declared = new Set(entries.flatMap(([, coverage]) => (coverage.kind === 'derived' ? [] : [coverage.column])));

    const written = [...upsertPayload().matchAll(/^\s{6,}(\w+):/gm)]
      .map((m) => m[1])
      .filter((column) => column !== 'id' || true);

    const undeclared = [...new Set(written)].filter((column) => !declared.has(column));

    expect(undeclared, 'these columns are written but appear in no FIELD_COVERAGE entry').toEqual([]);
  });

  /*
   * The mapper must not FABRICATE. `blocksLoaded: []` shipped for the life of this store, so a
   * Postgres deploy answered "no doc blocks were loaded" for every generation, with total confidence
   * and no way to tell it from the truth. Absent must read as absent.
   */
  it('never answers an unknown field with an empty literal', () => {
    /*
     * A default is only honest when it defaults something the row actually carried: `r.skills_loaded
     * ?? []` is fine, a bare `[]` is an answer invented out of nothing. So the rule is structural —
     * every array-valued property in the mapper must mention a column.
     */
    const fabricated = [...mapper().matchAll(/^\s*(\w+):\s*(\[\]|\{\}|''|0),?$/gm)].map((m) => m[1]);

    expect(fabricated).toEqual([]);
  });
});

/**
 * CONTROLS. Every assertion above is a regex over a file that is edited constantly. If one silently
 * stops matching, this suite goes green on a store that writes nothing.
 */
describe('CONTROLS — the scanner still reads the file it thinks it does', () => {
  it('finds the module, and it is the real one', () => {
    const s = source();

    expect(s.length).toBeGreaterThan(5_000);
    expect(s).toContain('SupabaseGenerationStore');
    expect(s).toContain('FsGenerationStore');
  });

  it('strips comments rather than matching prose', () => {
    const stripped = codeOnly(['/* raw_stops: row.rawStops */', 'const real = 1;', '// raw_stops:'].join('\n'));

    expect(stripped).toContain('const real = 1;');
    expect(stripped).not.toContain('raw_stops: row.rawStops');
    expect(stripped).not.toContain('// raw_stops');
  });

  it('locates the upsert payload and the mapper, and they are distinct regions', () => {
    const payload = upsertPayload();
    const read = mapper();

    expect(payload, 'upsert payload not found').not.toBe('');
    expect(read, 'toGenerationRecord not found').not.toBe('');
    expect(payload).toContain('user_id:');
    expect(read).toContain('r.user_id');
    expect(payload).not.toContain('function toGenerationRecord');
  });

  /*
   * The matchers must be able to FAIL. A column-present check that matches anything, and a
   * column-absent check that matches nothing, both report success on a broken store.
   */
  it('its matchers can distinguish a written column from an unwritten one', () => {
    const payload = upsertPayload();

    expect(payload).toMatch(/(^|[\s{,])model:/m);
    expect(payload).not.toMatch(/(^|[\s{,])a_column_that_does_not_exist:/m);
    expect(mapper()).not.toMatch(/\br\.a_column_that_does_not_exist\b/);
  });

  it('reads the real migrations, and can tell a real column from an invented one', () => {
    const sql = migrations();

    expect(sql.length, 'the migrations directory must not read as empty').toBeGreaterThan(10_000);
    expect(sql).toMatch(/create table (if not exists )?public\.generations/);
    expect(sql).toMatch(/\bfallback_handoffs\b/);
    expect(sql).not.toMatch(/\ba_column_that_does_not_exist\b/);
  });
});
