/**
 * Admin usage aggregation (SPEC §4.10).
 *
 * This is the lens the operator judges platform health and spend through, so its arithmetic is a
 * correctness path: a wrong cache-hit-rate sends "why is the bill high" to the wrong fix, and a wrong
 * wasted-output number hides the exact pathology the diagnostics columns exist to expose
 * (spec/context-budget.md).
 */
import { describe, expect, it } from 'vitest';
import { buildUsageReport } from './usage-report';
import { generationKind } from './generation-kind';
import { refundKind } from './refund-report';
import type { GenerationRecord } from '~/lib/.server/billing/generations';

const gen = (over: Partial<GenerationRecord>): GenerationRecord =>
  ({
    id: over.id ?? 'g',
    createdAt: '2026-07-14T00:00:00Z',
    model: 'claude-sonnet-5',
    provider: 'Anthropic',
    promptVersionId: null,
    skillsLoaded: [],
    blocksLoaded: [],
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolRounds: 0,
    ...over,
  }) as GenerationRecord;

describe('buildUsageReport', () => {
  it('is all-zero for no records, and never divides by zero', () => {
    const report = buildUsageReport([]);

    expect(report.generations).toBe(0);
    expect(report.failureRate).toBe(0);
    expect(report.cacheHitRate).toBe(0);
    expect(report.avgDurationMs).toBe(0);
  });

  it('sums cost and credits and computes the failure rate', () => {
    const report = buildUsageReport([
      gen({ status: 'completed', creditsCharged: 100, rawCostUsd: 0.05 }),
      gen({ status: 'completed', creditsCharged: 200, rawCostUsd: 0.1 }),
      gen({ status: 'failed', creditsCharged: 0, rawCostUsd: 0 }),
    ]);

    expect(report.creditsCharged).toBe(300);
    expect(report.rawCostUsd).toBeCloseTo(0.15);
    expect(report.completed).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.failureRate).toBeCloseTo(1 / 3);
  });

  it('computes cache hit rate as reads over all cacheable input', () => {
    // 900 read out of (100 prompt + 900 read + 0 write) = 0.9
    const report = buildUsageReport([gen({ promptTokens: 100, cacheReadTokens: 900, cacheCreationTokens: 0 })]);

    expect(report.cacheHitRate).toBeCloseTo(0.9);
  });

  it('counts output on steps that emitted no text at all', () => {
    const report = buildUsageReport([
      gen({
        steps: [
          // Thought, called a tool, wrote nothing. Billed at decode rate for zero user-visible output.
          { ms: 1, outTokens: 5000, inTokens: 0, cacheRead: 0, cacheWrite: 0, tools: ['load_skill'], textChars: 0 },
          { ms: 1, outTokens: 3000, inTokens: 0, cacheRead: 0, cacheWrite: 0, tools: [], textChars: 0 },
          { ms: 1, outTokens: 9000, inTokens: 0, cacheRead: 0, cacheWrite: 0, tools: [], textChars: 34_000 },
        ],
      }),
    ]);

    expect(report.silentStepOutputTokens).toBe(8000);
    expect(report.visibleTextChars).toBe(34_000);
  });

  /**
   * THE REGRESSION THIS METRIC EXISTS FOR.
   *
   * The old definition was "sum of all-but-last step outputs" — waste means extra steps. That was true
   * when written, and the fix for the pathology it measured made it false: pre-loading skills sets
   * `allowTools:false` → `maxSteps:1`, so a creation is now exactly ONE step and the old metric's
   * `steps.length <= 1` guard reported **zero waste on the most expensive generation in the product**.
   *
   * The real numbers: 44,308 output tokens billed, ~9k TOKENS of visible answer ≈ 34,200 chars at the
   * ~3.8 chars/token that real text runs at. That is 0.77 ch/tok — a fifth of healthy — so ~35k of that
   * output was thinking and redrafting. The old metric scored it a clean zero.
   */
  it('catches a single-step generation that was billed for output it never wrote', () => {
    const report = buildUsageReport([
      gen({
        completionTokens: 44_308,
        steps: [
          { ms: 550_000, outTokens: 44_308, inTokens: 0, cacheRead: 0, cacheWrite: 0, tools: [], textChars: 34_200 },
        ],
      }),
    ]);

    // The step DID emit text, so it is not "silent" — only the density exposes it.
    expect(report.silentStepOutputTokens).toBe(0);
    expect(report.charsPerOutputToken).toBeCloseTo(0.77, 2);

    // Well under the ~3.5 floor that real text cannot go below. That is the alarm.
    expect(report.charsPerOutputToken).toBeLessThan(3.5);
  });

  it('scores a healthy generation near the ~3.5-4 chars/token of real text', () => {
    const report = buildUsageReport([
      gen({
        completionTokens: 9000,
        steps: [
          { ms: 90_000, outTokens: 9000, inTokens: 0, cacheRead: 0, cacheWrite: 0, tools: [], textChars: 34_000 },
        ],
      }),
    ]);

    expect(report.charsPerOutputToken).toBeCloseTo(3.8, 1);
    expect(report.silentStepOutputTokens).toBe(0);
  });

  /*
   * `undefined` is "we never measured this", not "no text". Counting it as zero would report every
   * generation recorded before `textChars` existed as 100% waste, and the dashboard would show a
   * catastrophe that never happened.
   */
  it('skips steps recorded before textChars existed rather than calling them silent', () => {
    const report = buildUsageReport([
      gen({ steps: [{ ms: 1, outTokens: 9000, inTokens: 0, cacheRead: 0, cacheWrite: 0, tools: [] }] }),
    ]);

    expect(report.silentStepOutputTokens).toBe(0);
    expect(report.visibleTextChars).toBe(0);
  });

  it('never reports NaN density when there is no output', () => {
    expect(buildUsageReport([gen({ completionTokens: 0 })]).charsPerOutputToken).toBe(0);
    expect(buildUsageReport([]).charsPerOutputToken).toBe(0);
  });

  /*
   * The rescue markers (spec/fail-loud.md Stage C). These count generations that SUCCEEDED — the
   * user got their artifact — so nothing else on the report can show them; a rescued turn's tokens,
   * credits and `stop` all look ordinary, which is precisely the shape §4.10 exists to expose.
   */
  describe('rescue markers', () => {
    it('counts each marker, and a turn carrying two counts once as rescued', () => {
      const report = buildUsageReport([
        gen({ finishReason: 'stop' }),
        gen({ finishReason: 'stop+forced-continuation' }),
        gen({ finishReason: 'stop+unproductive-rescue' }),
        gen({ finishReason: 'stop+unproductive-rescue+provider-retry' }),
      ]);

      expect(report.markers).toEqual({
        forcedContinuation: 1,
        unproductiveRescue: 2,
        providerRetry: 1,
        rescued: 3,
      });
    });

    it('is zero for ordinary turns and for records with no finishReason at all', () => {
      const report = buildUsageReport([gen({ finishReason: 'stop' }), gen({}), gen({ finishReason: 'error' })]);

      expect(report.markers.rescued).toBe(0);
    });

    /*
     * The marker is a SUFFIX on a value that already carries the provider's own word — and a substring
     * match on the bare name would count a provider that one day reports `finishReason: "retry"`.
     * The `+` is what makes it ours.
     */
    it("matches the +marker suffix, not a bare word in the provider's own finish reason", () => {
      expect(buildUsageReport([gen({ finishReason: 'provider-retry' })]).markers.providerRetry).toBe(0);
      expect(buildUsageReport([gen({ finishReason: 'stop+provider-retry' })]).markers.providerRetry).toBe(1);
    });
  });

  it('breaks down by model, most expensive first', () => {
    const report = buildUsageReport([
      gen({ model: 'claude-sonnet-5', rawCostUsd: 0.02 }),
      gen({ model: 'claude-opus-4-8', rawCostUsd: 0.5 }),
      gen({ model: 'claude-sonnet-5', rawCostUsd: 0.03 }),
    ]);

    expect(report.byModel[0].model).toBe('claude-opus-4-8');
    expect(report.byModel[1]).toMatchObject({ model: 'claude-sonnet-5', generations: 2 });
    expect(report.byModel[1].rawCostUsd).toBeCloseTo(0.05);
  });

  /*
   * 🔴 MEDIA RENDERS SHARE THIS TABLE AND ARE NOT GENERATIONS (`generation-kind.ts`, the live defect).
   *
   * A `med_*` row is a paid image or video task (§4.16) that lives in the `generations` table because it
   * shares the ledger's foreign key. It has no prompt, no tool rounds, no finish reason and no step log —
   * and those are ABSENT, not zero. Counting them as generations diluted `failureRate` (a render cannot
   * fail the way a turn does), `avgToolRounds` (a divisor that grew with every render) and `byModel` (a
   * media model id sitting in the LLM cost table), on the one screen an operator reads to decide whether
   * the platform is healthy. A landing-page pass commissioning eight images is eight phantom generations.
   */
  describe('media rows are not generations', () => {
    /**
     * The media fixture is deliberately SPARSE — no `toolRounds`, no tokens, no `steps`, no
     * `finishReason` — because that is what a real `med_*` row looks like. A fixture that filled those
     * in with zeros would still prove the filter runs, but it would stop proving the thing that made
     * this defect expensive: the diluting values are missing, so every average taken over them is a
     * different number rather than an obviously-wrong one.
     */
    const media = (over: Partial<GenerationRecord> = {}): GenerationRecord =>
      ({
        id: 'med_1',
        createdAt: '2026-07-14T00:00:00Z',
        model: 'nano-banana-2',
        status: 'completed',
        creditsCharged: 30,
        rawCostUsd: 0.02,
        ...over,
      }) as GenerationRecord;

    const llm = (): GenerationRecord[] => [
      gen({
        id: 'gen_1',
        status: 'completed',
        toolRounds: 2,
        creditsCharged: 100,
        rawCostUsd: 0.5,
        promptTokens: 1000,
        completionTokens: 500,
        durationMs: 10_000,
      }),
      gen({
        id: 'gen_2',
        status: 'failed',
        toolRounds: 4,
        creditsCharged: 0,
        rawCostUsd: 0.1,
        promptTokens: 200,
        completionTokens: 0,
        durationMs: 2000,
      }),
    ];

    /*
     * 🔴 THE CONTROL THAT MATTERS: adding media rows to a sample must change NOTHING about the report.
     *
     * Asserted as whole-report equality rather than field by field, because the failure this pins is
     * "somebody re-let media rows into the loop" — and that lands on whichever field the next reader
     * forgot to list. A deep compare cannot forget one.
     *
     * ⚠️ INCLUDING `creditsCharged` AND `rawCostUsd`. That is a deliberate contract, not an oversight:
     * this report is LLM-only end to end (its neighbours on the panel are cache hit rate, chars per
     * output token and a per-model TOKEN table), so a media dollar landing in `rawCostUsd` while the
     * render is absent from `generations` produces a $/generation that is wrong the other way. The
     * consequence is that media spend must be reported somewhere ELSE, and it IS: `UsageReport.media`
     * carries it, the next test asserts it, and the Admin panel renders it beside these counters. That
     * counterpart is not optional — excluding media without it made real render spend vanish from a
     * section headed "Usage & cost", i.e. a fix blinding the metric that measured it.
     */
    it('leaves every GENERATION number byte-identical whether or not media rows are in the sample', () => {
      const [completed, failed] = llm();
      const withMedia = [completed, media({ id: 'med_1' }), media({ id: 'med_2' }), failed, media({ id: 'med_3' })];

      /*
       * `media` is expected to DIFFER — that is the counterpart to the exclusion, and the next test
       * asserts it. Everything else must not move by a single field: the whole defect was media rows
       * quietly diluting numbers that are about model turns.
       */
      const { media: withMediaSpend, ...generationNumbers } = buildUsageReport(withMedia);
      const { media: withoutMediaSpend, ...baseline } = buildUsageReport(llm());

      expect(generationNumbers).toEqual(baseline);
      expect(withMediaSpend).not.toEqual(withoutMediaSpend);
    });

    /*
     * 🔴 THE COUNTERPART, and the reason it exists: excluding media from the counters without
     * reporting it anywhere made real KIE spend vanish from every admin screen the moment the fix
     * landed — on a section headed "Usage & cost". A fix that blinds the number that measured the
     * thing is this codebase's most-recorded failure shape (`wastedOutput`, 2026-07-16).
     */
    it('reports media spend BESIDE the generation numbers, never nowhere', () => {
      const [completed, failed] = llm();
      const report = buildUsageReport([
        completed,
        media({ id: 'med_1', creditsCharged: 26, rawCostUsd: 0.078 }),
        failed,
        media({ id: 'med_2', creditsCharged: 40, rawCostUsd: 0.12 }),
      ]);

      expect(report.media.renders).toBe(2);
      expect(report.media.creditsCharged).toBe(66);
      expect(report.media.rawCostUsd).toBeCloseTo(0.198, 6);

      /* …and none of it leaked into the LLM totals. */
      expect(report.generations).toBe(2);
      expect(report.creditsCharged).toBe(buildUsageReport(llm()).creditsCharged);
    });

    it('CONTROL — a sample with no media reports zero renders, not a missing field', () => {
      const report = buildUsageReport(llm());

      expect(report.media).toEqual({ renders: 0, creditsCharged: 0, rawCostUsd: 0 });
    });

    it('counts only generations, so eight renders are not eight generations', () => {
      const withMedia = [...llm(), ...Array.from({ length: 8 }, (_, i) => media({ id: `med_${i}` }))];

      expect(buildUsageReport(withMedia).generations).toBe(2);
    });

    /* One failure in two turns is 50%. Media rows cannot fail a turn, so they must not enter the divisor. */
    it('does not dilute the failure rate', () => {
      const withMedia = [...llm(), media({ id: 'med_a' }), media({ id: 'med_b' })];

      expect(buildUsageReport(withMedia).failureRate).toBeCloseTo(0.5);
      expect(buildUsageReport(withMedia).failed).toBe(1);
      expect(buildUsageReport(withMedia).completed).toBe(1);
    });

    /*
     * (2 + 4) / 2 = 3. A media row has no tool rounds AT ALL — the fixture assertion below pins that,
     * because a fixture that quietly gained `toolRounds: 0` would still make this test pass while
     * testing a record shape that does not exist in production.
     */
    it('does not dilute avgToolRounds with rows that have no tool rounds', () => {
      expect(media().toolRounds).toBeUndefined();

      const withMedia = [...llm(), media({ id: 'med_a' }), media({ id: 'med_b' }), media({ id: 'med_c' })];

      expect(buildUsageReport(withMedia).avgToolRounds).toBeCloseTo(3);
    });

    /* The per-model table is the LLM cost breakdown; an image model in it is an unanswerable row. */
    it('keeps media model ids out of byModel', () => {
      const report = buildUsageReport([...llm(), media({ model: 'nano-banana-2' }), media({ model: 'veo3_lite' })]);

      expect(report.byModel.map((m) => m.model)).toEqual(['claude-sonnet-5']);
      expect(report.byModel[0].generations).toBe(2);
    });

    /*
     * A sample that is ONLY media must read as an empty report, not as a divide-by-zero. This is the
     * realistic shape of a small window on a media-heavy day, and `records.length` is the divisor for
     * both rates.
     */
    it('degrades to an empty report when the sample is all media, without NaN', () => {
      const report = buildUsageReport([media({ id: 'med_1' }), media({ id: 'med_2' })]);

      expect(report.generations).toBe(0);
      expect(report.failureRate).toBe(0);
      expect(report.avgToolRounds).toBe(0);
      expect(report.cacheHitRate).toBe(0);
      expect(report.charsPerOutputToken).toBe(0);
      expect(report.byModel).toEqual([]);
    });
  });

  /*
   * Request-integrity counters (`agent/request-invariants.ts`, SPEC §4.2 step 2a).
   *
   * A violation never fails a turn, so if it is not counted here it is a column nobody reads —
   * `spec/fail-loud.md` rule 9 waiting to fire. Both counters are per TURN, and both have an obvious
   * wrong denominator sitting right next to them (findings; fingerprints).
   */
  describe('integrity counters', () => {
    it('is zero for a sample with no integrity data at all', () => {
      const report = buildUsageReport([gen({ id: 'gen_1' }), gen({ id: 'gen_2' })]);

      expect(report.integrity).toEqual({ turnsWithViolations: 0, byInvariant: {}, turnsWithReissues: 0 });
    });

    /*
     * 🔴 TURNS, NOT FINDINGS. One turn that violated three invariants is ONE unhealthy turn; reporting
     * three would make `turnsWithViolations` exceed `generations` on a bad day, i.e. a percentage over
     * 100% on the health panel. The per-invariant tally is where the three go.
     */
    it('counts a turn with three findings as one turn, and tallies all three invariants', () => {
      const report = buildUsageReport([
        gen({
          id: 'gen_1',
          integrityIssues: ['INV-1: system block order', 'INV-2: breakpoint count', 'INV-3: history not compacted'],
        }),
        gen({ id: 'gen_2' }),
      ]);

      expect(report.integrity.turnsWithViolations).toBe(1);
      expect(report.integrity.byInvariant).toEqual({ 'INV-1': 1, 'INV-2': 1, 'INV-3': 1 });
    });

    /* The id is parsed off the `'INV-n: detail'` shape, so the same invariant across turns accumulates. */
    it('tallies each invariant across turns, keyed by the id before the colon', () => {
      const report = buildUsageReport([
        gen({ id: 'gen_1', integrityIssues: ['INV-1: a', 'INV-4: b'] }),
        gen({ id: 'gen_2', integrityIssues: ['INV-1: a different detail'] }),
        gen({ id: 'gen_3', integrityIssues: ['INV-1: and again'] }),
      ]);

      expect(report.integrity.turnsWithViolations).toBe(3);
      expect(report.integrity.byInvariant).toEqual({ 'INV-1': 3, 'INV-4': 1 });
    });

    /*
     * A finding with no `id: detail` shape still has to land somewhere loud. Silently dropping it is
     * how a renamed invariant stops being counted while the panel keeps reading 0 — the fail-loud
     * anti-pattern in an aggregation.
     */
    it('buckets an unparseable finding as unknown rather than dropping it', () => {
      const report = buildUsageReport([gen({ id: 'gen_1', integrityIssues: ['INV-2', '', 'no id here'] })]);

      expect(report.integrity.turnsWithViolations).toBe(1);
      expect(report.integrity.byInvariant).toEqual({ 'INV-2': 1, unknown: 1, 'no id here': 1 });
    });

    /*
     * ⚠️ `undefined` is "never checked", `[]` is "checked and clean" (`GenerationRecord`). Both are
     * zero violations, which is the only thing this report claims about them — it has no "turns
     * checked" field, so it cannot distinguish them and must not pretend to. The distinction has to
     * survive at the record level; a counter derived from it would need its own field.
     */
    it('treats never-checked and checked-and-clean alike as zero violations', () => {
      const neverChecked = buildUsageReport([gen({ id: 'gen_1', integrityIssues: undefined })]);
      const checkedClean = buildUsageReport([gen({ id: 'gen_1', integrityIssues: [] })]);

      expect(neverChecked.integrity.turnsWithViolations).toBe(0);
      expect(checkedClean.integrity.turnsWithViolations).toBe(0);
      expect(neverChecked.integrity.byInvariant).toEqual({});
      expect(checkedClean.integrity.byInvariant).toEqual({});
    });

    /*
     * 🔴 EDGE CASE 11: a turn that assembled FOUR requests is ONE turn that went wrong, not four.
     * Counting fingerprints would inflate the re-issue count by exactly the turns that already cost the
     * most — a metric that gets loudest where it is least accurate.
     */
    it('counts a four-fingerprint turn as one turn, and one generation', () => {
      const report = buildUsageReport([
        gen({ id: 'gen_1', requestFingerprints: [{ h: 'a' }, { h: 'b' }, { h: 'c' }, { h: 'd' }] }),
      ]);

      expect(report.generations).toBe(1);
      expect(report.integrity.turnsWithReissues).toBe(1);
    });

    /*
     * One request is the ordinary turn — the overwhelming majority — so a `>= 1` threshold would report
     * the whole platform as permanently re-issuing and the number would be ignored within a day.
     */
    it('does not count a single-fingerprint turn, nor a turn that never reached startStream', () => {
      const report = buildUsageReport([
        gen({ id: 'gen_1', requestFingerprints: [{ h: 'a' }] }),
        gen({ id: 'gen_2', requestFingerprints: [] }),
        gen({ id: 'gen_3', requestFingerprints: undefined }),
      ]);

      expect(report.integrity.turnsWithReissues).toBe(0);
    });

    it('counts re-issuing turns independently of violating turns', () => {
      const report = buildUsageReport([
        gen({ id: 'gen_1', requestFingerprints: [{ h: 'a' }, { h: 'b' }] }),
        gen({ id: 'gen_2', integrityIssues: ['INV-1: system block order'] }),
        gen({ id: 'gen_3', requestFingerprints: [{ h: 'a' }, { h: 'b' }], integrityIssues: ['INV-1: again'] }),
      ]);

      expect(report.integrity.turnsWithReissues).toBe(2);
      expect(report.integrity.turnsWithViolations).toBe(2);
      expect(report.integrity.byInvariant).toEqual({ 'INV-1': 2 });
    });
  });
});

/*
 * The prefix rule itself. It lives in one module because BOTH admin reports need it and only one of
 * them had it — the `isSecretPath` lesson: the fix for "one of the two callers has the rule" is never
 * a second copy of the rule.
 */
describe('generationKind', () => {
  it('reads a model turn from the gen_ prefix', () => {
    expect(generationKind('gen_msopyq5f')).toBe('generation');
  });

  it('reads a media render from the med_ prefix', () => {
    expect(generationKind('med_01hxyz')).toBe('media');
  });

  /*
   * 🔴 NOT 'generation'. Defaulting an unrecognised prefix into the generation bucket is how a future
   * third row type silently joins the numbers an operator trusts — exactly how `med_` got counted for
   * as long as it did. Absent must never read as a default (`provider`, `status_kind`).
   */
  it('calls an unrecognised prefix other, never generation', () => {
    expect(generationKind('lic_abc')).toBe('other');
    expect(generationKind('sandbox_abc')).toBe('other');
    expect(generationKind('gen')).toBe('other');
    expect(generationKind('')).toBe('other');
    expect(generationKind(undefined)).toBe('other');
  });

  /*
   * The prefix is matched at the START. A `med_` appearing anywhere else in an id is not a media row,
   * and an `includes` would reclassify a generation whose id happened to contain it.
   */
  it('matches the prefix at the start of the id, not anywhere inside it', () => {
    expect(generationKind('gen_med_abc')).toBe('generation');
    expect(generationKind('xx_med_abc')).toBe('other');
  });
});

/*
 * A CONTROL on the extraction, not a second test of the rule. `refundKind` is now a delegate, and the
 * refund report's own answers must be byte-identical to what they were before the move — a refactor
 * that quietly changes a money report's grouping is the worst kind of silent.
 */
describe('refundKind still answers exactly as it did before the rule was extracted', () => {
  it('returns the same kinds as generationKind for every input', () => {
    for (const id of ['gen_abc', 'med_abc', 'lic_abc', 'gen', '', undefined]) {
      expect(refundKind(id)).toBe(generationKind(id));
    }

    expect(refundKind('gen_abc')).toBe('generation');
    expect(refundKind('med_abc')).toBe('media');
    expect(refundKind(undefined)).toBe('other');
  });
});
