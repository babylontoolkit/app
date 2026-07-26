/**
 * Admin usage & cost aggregation (SPEC §4.10).
 *
 * The diagnostics columns landed in Stage 3 (migration 0002: `tool_rounds`, `duration_ms`,
 * `finish_reason`, `steps`) for exactly this: so the admin dashboards can **diagnose** spend, not
 * merely chart it. Aggregate totals hide every pathology `spec/context-budget.md` catalogues — a clean
 * `stop` billed for output nobody saw, a generation that spent 68% of its tokens loading one skill, a
 * failure rate creeping up. This function turns a list of generation records into the numbers that make
 * those visible.
 *
 * Pure, and tested, because it is the lens the operator judges the whole platform's health through: if
 * the cache-hit-rate math is wrong, "why is the bill high" gets answered wrongly, and the fix goes to
 * the wrong place. `spec/context-budget.md` warns specifically that a latency complaint must never be
 * answered with "more caching" before the step log is read — this report IS that step log, aggregated.
 */
import type { GenerationRecord } from '~/lib/.server/billing/generations';

export interface ModelUsage {
  model: string;
  generations: number;
  creditsCharged: number;
  rawCostUsd: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface UsageReport {
  generations: number;
  completed: number;
  failed: number;

  /** Failed / total. The alerting number — a rising failure rate is refunds AND unhappy users (§5A). */
  failureRate: number;

  creditsCharged: number;
  rawCostUsd: number;

  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;

  /**
   * cacheRead / (all input that COULD have been cached) = cacheRead / (prompt + cacheRead + cacheCreation).
   * The single most important margin number (§4.3.5): cache reads bill at 0.1x, so a falling hit rate is
   * a rising bill with no change in what users did.
   */
  cacheHitRate: number;

  /** Averages that tell the two latency causes apart (§4.10, spec/context-budget.md). */
  avgDurationMs: number;
  avgToolRounds: number;

  /**
   * Output tokens billed on steps that emitted NO text — thinking and tool calls the user never saw.
   * Exact (see `silentStepOutput`). Caching cannot touch this; only emitting less output can.
   */
  silentStepOutputTokens: number;

  /**
   * Characters of text actually streamed, and chars-per-output-token across the sample.
   *
   * **This is the number that answers "where did the output go".** Text runs ~3.5–4 chars per output
   * token. Near that, the bill bought the artifact. Far below it, the bill bought thinking, redrafts and
   * tool preambles — and no amount of prompt trimming will help, because output is 5× input and decodes
   * serially at 60–110 tok/s (`spec/context-budget.md`).
   */
  visibleTextChars: number;
  charsPerOutputToken: number;

  /**
   * How often each AUTOMATIC transition on the paid path fired (`spec/fail-loud.md` Stage C).
   *
   * Counted from `finish_reason`, where `proxy.ts` already records them — and the point of surfacing
   * them is that each one is a rescue that WORKED, which is exactly why it is invisible otherwise. The
   * user got their artifact, the ledger looks ordinary, and nothing in an aggregate says the platform
   * had to save the turn to get there. A rising count means the cause is upstream of the rescue and
   * the rescue is only paying for it (at 5x output rate, since every one of these is a second stream).
   */
  markers: MarkerCounts;

  byModel: ModelUsage[];
}

export interface MarkerCounts {
  /** The tool-loop ran out of steps mid-call and a tool-free pass was forced to finish the answer. */
  forcedContinuation: number;

  /** The model announced work it did not do, and a corrective pass was bought for the user. */
  unproductiveRescue: number;

  /** The provider broke before producing anything and the generation was attempted once more. */
  providerRetry: number;

  /** Generations carrying at least one marker — the denominator-friendly headline for the panel. */
  rescued: number;
}

function n(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function buildUsageReport(records: GenerationRecord[]): UsageReport {
  const report: UsageReport = {
    generations: records.length,
    completed: 0,
    failed: 0,
    failureRate: 0,
    creditsCharged: 0,
    rawCostUsd: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheHitRate: 0,
    avgDurationMs: 0,
    avgToolRounds: 0,
    silentStepOutputTokens: 0,
    visibleTextChars: 0,
    charsPerOutputToken: 0,
    markers: { forcedContinuation: 0, unproductiveRescue: 0, providerRetry: 0, rescued: 0 },
    byModel: [],
  };

  const models = new Map<string, ModelUsage>();
  let durationSum = 0;
  let durationCount = 0;
  let toolRoundSum = 0;

  for (const rec of records) {
    if (rec.status === 'failed') {
      report.failed++;
    } else if (rec.status === 'completed') {
      report.completed++;
    }

    report.creditsCharged += n(rec.creditsCharged);
    report.rawCostUsd += n(rec.rawCostUsd);
    report.promptTokens += n(rec.promptTokens);
    report.completionTokens += n(rec.completionTokens);
    report.cacheReadTokens += n(rec.cacheReadTokens);
    report.cacheCreationTokens += n(rec.cacheCreationTokens);
    toolRoundSum += n(rec.toolRounds);

    if (rec.durationMs !== undefined) {
      durationSum += rec.durationMs;
      durationCount++;
    }

    report.silentStepOutputTokens += silentStepOutput(rec);
    report.visibleTextChars += visibleTextChars(rec);
    countMarkers(rec, report.markers);

    const key = rec.model || 'unknown';
    const m = models.get(key) ?? {
      model: key,
      generations: 0,
      creditsCharged: 0,
      rawCostUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };

    m.generations++;
    m.creditsCharged += n(rec.creditsCharged);
    m.rawCostUsd += n(rec.rawCostUsd);
    m.promptTokens += n(rec.promptTokens);
    m.completionTokens += n(rec.completionTokens);
    m.cacheReadTokens += n(rec.cacheReadTokens);
    m.cacheCreationTokens += n(rec.cacheCreationTokens);
    models.set(key, m);
  }

  report.failureRate = records.length ? report.failed / records.length : 0;

  const cacheable = report.promptTokens + report.cacheReadTokens + report.cacheCreationTokens;
  report.cacheHitRate = cacheable ? report.cacheReadTokens / cacheable : 0;

  report.avgDurationMs = durationCount ? Math.round(durationSum / durationCount) : 0;
  report.avgToolRounds = records.length ? toolRoundSum / records.length : 0;

  /*
   * Density across the whole sample. Guarded: with no output tokens there is no ratio, and 0/0 must not
   * become NaN and render as "NaN ch/tok" on the dashboard.
   */
  report.charsPerOutputToken = report.completionTokens ? report.visibleTextChars / report.completionTokens : 0;

  report.byModel = [...models.values()].sort((a, b) => b.rawCostUsd - a.rawCostUsd);

  return report;
}

/**
 * Output tokens on steps that emitted NO TEXT AT ALL — exact, not estimated.
 *
 * A step's billed output is thinking + tool-call JSON + text, and only text can reach the user. A step
 * with zero text therefore produced literally nothing for the user and was billed at decode rate for it.
 * That is unambiguous: no heuristic, no assumption about which step is "the answer".
 *
 * **This replaces "sum of all-but-last step outputs", which was blind to the case it was named for.**
 * That definition assumed waste means EXTRA STEPS — true when it was written, and made false by the fix
 * for the very pathology it measured: pre-loading skills sets `allowTools:false` → `maxSteps:1`, so a
 * creation now runs as exactly ONE step, hits the `steps.length <= 1` guard, and reports **zero wasted
 * output** — on the single most expensive generation in the product (~44k output tokens, ~$1.11). The
 * metric said "no waste" precisely where all the money was, and it said it in good faith.
 *
 * Steps recorded before `textChars` existed are skipped rather than counted: `undefined` is "we did not
 * measure", not "no text", and treating it as zero would report every historical generation as 100%
 * waste.
 */
function silentStepOutput(rec: GenerationRecord): number {
  return (rec.steps ?? []).reduce((sum, s) => (s.textChars === 0 ? sum + n(s.outTokens) : sum), 0);
}

/**
 * Tally the `+marker` suffixes `proxy.ts` appends to `finish_reason`.
 *
 * SUFFIX MATCHING, deliberately: a marker is written as `stop+forced-continuation+provider-retry`, so
 * a generation can carry more than one and each must count once. `finishReason` is also the field that
 * has ALREADY been overwritten once in this codebase's history — `drain` runs twice and the second run
 * clobbered the first's value, which is precisely why the markers were added — so reading it back is
 * reading the fix, not the raw provider claim.
 */
function countMarkers(rec: GenerationRecord, into: MarkerCounts): void {
  const finish = rec.finishReason ?? '';
  let any = false;

  for (const [marker, key] of MARKER_FIELDS) {
    if (finish.includes(`+${marker}`)) {
      into[key]++;
      any = true;
    }
  }

  if (any) {
    into.rescued++;
  }
}

/** The marker string as written, paired with where it lands. Renaming one without the other is the bug. */
const MARKER_FIELDS: Array<[string, keyof Omit<MarkerCounts, 'rescued'>]> = [
  ['forced-continuation', 'forcedContinuation'],
  ['unproductive-rescue', 'unproductiveRescue'],
  ['provider-retry', 'providerRetry'],
];

/** Characters of text a generation actually streamed. Paired with output tokens, this is the density. */
function visibleTextChars(rec: GenerationRecord): number {
  return (rec.steps ?? []).reduce((sum, s) => sum + n(s.textChars), 0);
}
