/**
 * Guards the tool-loop token accounting (§4.6 — a money path).
 *
 * The regression these tests exist to prevent: reading cache tokens from `result.providerMetadata`,
 * which ai@4 documents as "from the LAST step". In a 6-round tool loop that throws away five rounds
 * of cache accounting while `result.usage` (combined across all steps) keeps all six — so the bill is
 * computed from two different denominators and nothing anywhere throws.
 */
import { describe, expect, it } from 'vitest';
import { accumulateStepUsage, emptyUsage, type UsageStep } from './step-usage';
import { BAKED_COMET_PRICES } from '~/lib/.server/billing/baked-comet-prices';
import { costForRates, llmRatesFromList, KIE_MODEL_RATES } from '~/lib/.server/billing/rates';

/** One round of a tool loop, shaped like the provider actually reports it. */
function step(promptTokens: number, completionTokens: number, cacheRead: number, cacheWrite: number): UsageStep {
  return {
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    providerMetadata: { anthropic: { cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite } },
  };
}

describe('accumulateStepUsage', () => {
  /**
   * The shape of a real creation: round 1 pays to WRITE the 133K prefix into the cache, rounds 2-6
   * READ it back. A correct accounting sees five reads. The bug saw one.
   */
  it('sums cache tokens across EVERY step, not just the last', () => {
    const PREFIX = 133_000;
    const steps: UsageStep[] = [
      step(4_000, 900, 0, PREFIX), // round 1: cold — writes the cache
      step(1_200, 800, PREFIX, 0), // rounds 2-6: warm — read it back
      step(1_400, 850, PREFIX, 0),
      step(1_600, 900, PREFIX, 0),
      step(1_800, 950, PREFIX, 0),
      step(2_000, 40_000, PREFIX, 0), // the answer step, where the file bodies get written
    ];

    const totals = accumulateStepUsage(emptyUsage(), steps);

    expect(totals.cacheReadTokens).toBe(PREFIX * 5);
    expect(totals.cacheCreationTokens).toBe(PREFIX);

    // The precise failure mode: last-step-only accounting would have recorded exactly one read.
    expect(totals.cacheReadTokens).not.toBe(PREFIX);

    expect(totals.promptTokens).toBe(12_000);
    expect(totals.completionTokens).toBe(44_400);
  });

  /**
   * `promptTokens` (combined) and the cache columns (last-step) must share a denominator. Before the
   * fix, input summed over 6 rounds while cache summed over 1 — so the ratio between them, which is
   * what the margin depends on, was fiction.
   */
  it('keeps input and cache accounting on the same denominator', () => {
    const steps = [step(1_000, 100, 0, 50_000), step(1_000, 100, 50_000, 0), step(1_000, 100, 50_000, 0)];

    const totals = accumulateStepUsage(emptyUsage(), steps);

    expect(totals.promptTokens).toBe(3_000);
    expect(totals.cacheReadTokens).toBe(100_000);
  });

  /**
   * A generation can stream more than once — when the tool-round cap is hit we run a second stream
   * with tools disabled to force an answer (§4.2, "on cap, proceed with what's loaded"). Both drains
   * fold into one bill; the second must not clobber the first.
   */
  it('accumulates across multiple drains rather than overwriting', () => {
    const totals = emptyUsage();

    accumulateStepUsage(totals, [step(1_000, 500, 10_000, 0)]);
    accumulateStepUsage(totals, [step(2_000, 700, 20_000, 0)]);

    expect(totals.promptTokens).toBe(3_000);
    expect(totals.completionTokens).toBe(1_200);
    expect(totals.cacheReadTokens).toBe(30_000);
  });

  /** Never bill NaN, and never fail a finished generation over our own bookkeeping. */
  it('treats missing or malformed provider numbers as zero', () => {
    const totals = accumulateStepUsage(emptyUsage(), [
      {},
      { usage: { promptTokens: 100 } },
      { usage: { promptTokens: Number.NaN, completionTokens: 50 }, providerMetadata: {} },
      { providerMetadata: { anthropic: {} } },
    ]);

    expect(totals.promptTokens).toBe(100);
    expect(totals.completionTokens).toBe(50);
    expect(totals.cacheReadTokens).toBe(0);
    expect(Number.isNaN(totals.promptTokens)).toBe(false);
  });

  it('handles a generation with no steps at all', () => {
    expect(accumulateStepUsage(emptyUsage(), undefined)).toEqual(emptyUsage());
  });

  /**
   * The family selects which `providerMetadata` namespace the cache columns are read from
   * (`usage-metadata.ts`). Accumulation is the same fold either way — the failure this pins is a
   * second family reading zeros across a whole tool loop while its input tokens keep summing, i.e.
   * the same two-denominators bug the first test in this file exists for, one wire to the left.
   *
   * ⚠️ **THE FIXTURE WAS ANTHROPIC-SHAPED AND THE LABELS WERE OPENAI (corrected T12, 2026-08-11).**
   * It read `{promptTokens: 1_200, cachedPromptTokens: 24_576}` — a step whose cache read is TWENTY
   * TIMES its prompt total, which the Responses wire cannot emit: `cached_tokens` is a breakdown OF
   * `input_tokens` and can never exceed it. The numbers were Claude's convention wearing the other
   * vendor's key names, which is precisely the mix-up that let the double-bill ship. The prompt totals
   * are now the inclusive figures a real turn reports (24,576 cached + the same 1,200/1,400 of new
   * input), so the expected uncached totals below are unchanged and the fixture is now physical.
   */
  it("accumulates the openai namespace across MULTIPLE steps when the family is 'codex'", () => {
    const steps: UsageStep[] = [
      { usage: { promptTokens: 4_000, completionTokens: 900 }, providerMetadata: { openai: {} } },
      {
        usage: { promptTokens: 25_776, completionTokens: 800 },
        providerMetadata: { openai: { cachedPromptTokens: 24_576 } },
      },
      {
        usage: { promptTokens: 25_976, completionTokens: 850 },
        providerMetadata: { openai: { cachedPromptTokens: 24_576 } },
      },
    ];

    const totals = accumulateStepUsage(emptyUsage(), steps, 'codex');

    expect(totals.promptTokens).toBe(6_600);
    expect(totals.completionTokens).toBe(2_550);
    expect(totals.cacheReadTokens).toBe(49_152);

    // There is no cache-WRITE counter on the Responses wire — it must stay zero, never be invented.
    expect(totals.cacheCreationTokens).toBe(0);
  });

  /** An omitted family reads `anthropic` — byte-identical to every bill this function ever produced. */
  it('reads the anthropic namespace when no family is passed', () => {
    const steps = [step(1_000, 100, 5_000, 200)];

    expect(accumulateStepUsage(emptyUsage(), steps)).toEqual(accumulateStepUsage(emptyUsage(), steps, 'claude'));
    expect(accumulateStepUsage(emptyUsage(), steps).cacheReadTokens).toBe(5_000);

    // ...and a codex-labelled generation must NOT bill from the anthropic keys.
    expect(accumulateStepUsage(emptyUsage(), steps, 'codex').cacheReadTokens).toBe(0);
  });
});

/**
 * 🔴 THE DOUBLE-BILL OF CACHED INPUT (T12, 2026-08-11 — a MONEY PATH).
 *
 * `costForRates` ADDS `promptTokens x input` to `cacheReadTokens x cacheRead`, which is only correct
 * when the two do not overlap. Anthropic's wire reports them as siblings, so they do not. Every
 * OpenAI- and Google-shaped wire reports the cached count as a BREAKDOWN of the prompt total, so they
 * overlap completely — and `accumulateStepUsage` was adding both, charging the cached portion once at
 * the FULL input rate and again at the cache-read rate.
 *
 * The error scales with cache WARMTH, i.e. it was worst on exactly the turns the whole context-budget
 * programme exists to make cheap, and it moved the credit total UP with nothing thrown.
 *
 * These tests are priced through the REAL `costForRates` against the REAL baked rate rows, because the
 * defect is not visible in the token vector alone — a reviewer reading `promptTokens: 35066` sees a
 * plausible number. Only the dollar figure says which one is the bill.
 */
describe('accumulateStepUsage — cached tokens are never billed twice', () => {
  /**
   * THE LIVE VECTOR, verbatim. A real `gpt-5-6-terra` turn on KIE: a first step with a cold prefix and
   * no cache metadata at all, then a second step whose ENTIRE prompt was served from the cache.
   *
   * Two steps rather than one because that is what the generation actually did, and because a
   * single-step vector cannot distinguish a per-step subtraction from a totals-level one.
   */
  const LIVE_TERRA_STEPS: UsageStep[] = [
    { usage: { promptTokens: 17_324, completionTokens: 83 } },
    {
      usage: { promptTokens: 17_742, completionTokens: 156 },
      providerMetadata: { openai: { cachedPromptTokens: 17_742 } },
    },
  ];

  /**
   * The same vector carrying the provider's own `totalTokens` (`promptTokens + completionTokens` in
   * ITS units — cache-inclusive on this wire, which is the whole point). `LIVE_TERRA_STEPS` omits
   * the field, so it cannot see whether the total tracks the subtraction.
   */
  const LIVE_TERRA_STEPS_WITH_TOTALS: UsageStep[] = [
    { usage: { promptTokens: 17_324, completionTokens: 83, totalTokens: 17_407 } },
    {
      usage: { promptTokens: 17_742, completionTokens: 156, totalTokens: 17_898 },
      providerMetadata: { openai: { cachedPromptTokens: 17_742 } },
    },
  ];

  /*
   * 🔴 ONE GENERATION, ONE TOTAL — the regression the first draft of the fix shipped.
   *
   * `totalTokens` is persisted from these totals by `proxy.ts`, while `gate.ts` and the Supabase
   * read both DERIVE it as `promptTokens + completionTokens`. Subtracting the cache read from
   * `promptTokens` alone left the same field with two values differing by exactly the cache read —
   * live, on `gen_msopyq5f`: 17,464 + 78 stored as 35,431. Nothing bills from it, which is exactly
   * why it would have gone unnoticed; this file's own history is why that is not a reason to skip it.
   *
   * Asserted as the RELATIONSHIP, not as a literal: a literal passes for an implementation that
   * subtracts the wrong amount from both sides in the same way.
   */
  it('keeps totalTokens equal to promptTokens + completionTokens on an inclusive family', () => {
    const totals = accumulateStepUsage(emptyUsage(), LIVE_TERRA_STEPS_WITH_TOTALS, 'codex');

    expect(totals.totalTokens).toBe(totals.promptTokens + totals.completionTokens);
  });

  it('CONTROL — the same relationship already held, and still holds, on claude', () => {
    const totals = accumulateStepUsage(
      emptyUsage(),
      [
        {
          usage: { promptTokens: 2_049, completionTokens: 5, totalTokens: 2_054 },
          providerMetadata: { anthropic: { cacheReadInputTokens: 31_094 } },
        },
      ],
      'claude',
    );

    expect(totals.totalTokens).toBe(totals.promptTokens + totals.completionTokens);
    expect(totals.promptTokens).toBe(2_049);
    expect(totals.cacheReadTokens).toBe(31_094);
  });

  it('bills the live gpt-5-6-terra turn at its TRUE cost, not 1.86x it', () => {
    const totals = accumulateStepUsage(emptyUsage(), LIVE_TERRA_STEPS, 'codex');

    // Step B's prompt was 100% cached, so it contributes NOTHING to the uncached input column.
    expect(totals.promptTokens).toBe(17_324);
    expect(totals.cacheReadTokens).toBe(17_742);
    expect(totals.completionTokens).toBe(239);

    /*
     * The Responses wire maps no cache-WRITE counter (`usage-metadata.ts`), so this stays zero. Pinned
     * because inventing one here would apply the row's explicit $0.70/MTok write price to nothing.
     */
    expect(totals.cacheCreationTokens).toBe(0);

    /*
     * Priced through the real formula against the real baked KIE row (input 0.56, output 3.36, cached
     * input 0.056 per MTok). Both numbers are LITERALS captured from the live turn — re-deriving them
     * from the rate row here would be re-running the function under test and would agree with any bug.
     */
    const rates = KIE_MODEL_RATES['gpt-5-6-terra'];
    expect(rates.inputPerMTok).toBe(0.56);
    expect(rates.cacheReadPerMTok).toBe(0.056);

    expect(costForRates(totals, rates)).toBeCloseTo(0.011498032, 9);

    // ...and specifically NOT what it was billed on the day: $0.021434, a 1.86x over-charge.
    expect(costForRates(totals, rates)).not.toBeCloseTo(0.021433552, 9);
  });

  /**
   * 🔴 CONTROL — CLAUDE MUST BE BYTE-IDENTICAL TO EVERY BILL THIS FUNCTION EVER PRODUCED.
   *
   * The dangerous half of this fix is not missing an inclusive family; it is "helpfully" subtracting on
   * an EXCLUSIVE one. Anthropic's `input_tokens` already excludes `cache_read_input_tokens`, so a
   * subtraction there would zero out the uncached input of every warm Claude turn and quietly bill the
   * platform's entire history of generations at a fraction of cost — the safe-looking direction, and
   * the one that reads as a cheaper turn rather than as a defect.
   *
   * The vector is deliberately one where a subtraction WOULD change the answer (cache read 8,000 <
   * prompt 10,000), so this cannot pass by arithmetic coincidence.
   */
  it('does NOT subtract on claude — the wire already reports prompt tokens exclusive of cache', () => {
    const steps = [step(10_000, 400, 8_000, 0), step(12_000, 600, 8_000, 0)];

    const totals = accumulateStepUsage(emptyUsage(), steps, 'claude');

    expect(totals.promptTokens).toBe(22_000);
    expect(totals.cacheReadTokens).toBe(16_000);

    // The pre-fix answer, restated as the REQUIRED answer: a claude bill must not move by one token.
    expect(totals.promptTokens).not.toBe(6_000);

    /*
     * Priced: Sonnet 5 on KIE (input 0.85, read 0.085 derived). A subtraction here would cut the bill
     * to $0.010735 — 44% of the correct figure. Both are literals, so the assertion cannot follow the
     * function under test.
     */
    const rates = KIE_MODEL_RATES['claude-sonnet-5'];
    expect(rates.inputPerMTok).toBe(0.85);

    expect(costForRates(totals, rates)).toBeCloseTo(0.024335, 9);
    expect(costForRates(totals, rates)).not.toBeCloseTo(0.010735, 9);
  });

  /** An omitted family must behave exactly like `claude` here too — same vendor, same arithmetic. */
  it('does NOT subtract when the family is omitted (matches the anthropic-namespace fallback)', () => {
    const steps = [step(10_000, 400, 8_000, 0)];

    expect(accumulateStepUsage(emptyUsage(), steps).promptTokens).toBe(10_000);
    expect(accumulateStepUsage(emptyUsage(), steps)).toEqual(accumulateStepUsage(emptyUsage(), steps, 'claude'));
  });

  /**
   * 🔴 FLOORED AT ZERO. A provider reporting more cached tokens than prompt tokens is malformed, and
   * settlement can never refuse (§4.6) — so the only safe reading is "all of it was cached". A negative
   * would flow straight into `costForRates` and CREDIT the user at the input rate, turning a provider's
   * bad number into a way to bill less than nothing.
   *
   * Asserted on the TOTAL as well as on the single step, because a negative can otherwise hide by
   * cancelling against a healthy step and leaving a total that looks merely low.
   */
  it('floors a malformed step at zero rather than going negative', () => {
    const malformed: UsageStep = {
      usage: { promptTokens: 100, completionTokens: 10 },
      providerMetadata: { openai: { cachedPromptTokens: 500 } },
    };

    const alone = accumulateStepUsage(emptyUsage(), [malformed], 'codex');
    expect(alone.promptTokens).toBe(0);

    const withHealthy = accumulateStepUsage(
      emptyUsage(),
      [malformed, { usage: { promptTokens: 50, completionTokens: 10 } }],
      'codex',
    );

    // 0 + 50, never -400 + 50.
    expect(withHealthy.promptTokens).toBe(50);
    expect(withHealthy.promptTokens).toBeGreaterThanOrEqual(0);
  });

  /**
   * 🔴 PER STEP, NEVER ON THE TOTALS — and this vector is chosen so the two answers DIFFER.
   *
   * Summing first lets one step's surplus prompt tokens absorb another step's over-report:
   *   per-step : max(0, 100 - 500) + max(0, 900 - 0) = 0 + 900 = 900
   *   on totals: max(0, (100 + 900) - 500)           =         = 500
   *
   * A test whose steps happen to cancel to the same number cannot see the bug it is named for, so the
   * wrong answer is pinned explicitly alongside the right one.
   */
  it('subtracts per step, so a malformed step cannot be absorbed by a healthy one', () => {
    const totals = accumulateStepUsage(
      emptyUsage(),
      [
        {
          usage: { promptTokens: 100, completionTokens: 10 },
          providerMetadata: { openai: { cachedPromptTokens: 500 } },
        },
        { usage: { promptTokens: 900, completionTokens: 10 } },
      ],
      'codex',
    );

    expect(totals.promptTokens).toBe(900);

    // The totals-level answer, named so a refactor onto the totals fails here instead of shipping.
    expect(totals.promptTokens).not.toBe(500);
  });

  /**
   * The `chat` family declares the same inclusive wire as `codex`, and carries the WORSE exposure of
   * the two: `cacheProfile: 'none'` means the cache-read rate EQUALS the input rate, so an
   * un-subtracted cached token was billed at the full input rate TWICE OVER — no discount absorbing
   * any part of it.
   *
   * Priced on Comet's real `grok-4.5` row (input 1.6, output 4.8; read = input under `none`).
   */
  it('subtracts on the chat family, where a double-bill is charged at 2x full input', () => {
    const totals = accumulateStepUsage(
      emptyUsage(),
      [
        {
          usage: { promptTokens: 10_000, completionTokens: 500 },
          providerMetadata: { openai: { cachedPromptTokens: 8_000 } },
        },
      ],
      'chat',
    );

    expect(totals.promptTokens).toBe(2_000);
    expect(totals.cacheReadTokens).toBe(8_000);

    const rates = llmRatesFromList(BAKED_COMET_PRICES)['grok-4.5'];
    expect(rates.inputPerMTok).toBe(1.6);
    expect(rates.cacheReadPerMTok).toBe(1.6); // `none` — no discount we cannot verify.

    expect(costForRates(totals, rates)).toBe(0.0184);
    expect(costForRates(totals, rates)).not.toBe(0.0312); // the pre-fix bill, 1.70x
  });

  /**
   * `gemini` declares the inclusive wire too, and its counter is structurally zero today (the SDK maps
   * no `cachedContentTokenCount` on KIE). Pinned as a no-op so the entry cannot be "corrected" to
   * `false` on the grounds that it currently changes nothing — the day an adapter starts reporting the
   * counter, the arithmetic has to be right already.
   */
  it('is a no-op on gemini today, but subtracts the moment a counter appears', () => {
    const silent = accumulateStepUsage(
      emptyUsage(),
      [{ usage: { promptTokens: 9_000, completionTokens: 100 }, providerMetadata: { google: {} } }],
      'gemini',
    );
    expect(silent.promptTokens).toBe(9_000);

    const reporting = accumulateStepUsage(
      emptyUsage(),
      [
        {
          usage: { promptTokens: 9_000, completionTokens: 100 },
          providerMetadata: { google: { cachedContentTokenCount: 6_000 } },
        },
      ],
      'gemini',
    );
    expect(reporting.promptTokens).toBe(3_000);
    expect(reporting.cacheReadTokens).toBe(6_000);
  });
});
