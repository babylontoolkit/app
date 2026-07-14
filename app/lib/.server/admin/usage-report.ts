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
   * Output tokens spent on steps whose text the user never saw — the "wasted output" pathology. Derived
   * from `steps`: total step output minus the final visible answer's tokens. A big number here means we
   * are paying decode rate for redrafts/abandoned attempts, which caching cannot fix.
   */
  estimatedWastedOutputTokens: number;

  byModel: ModelUsage[];
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
    estimatedWastedOutputTokens: 0,
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

    report.estimatedWastedOutputTokens += wastedOutput(rec);

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

  report.byModel = [...models.values()].sort((a, b) => b.rawCostUsd - a.rawCostUsd);

  return report;
}

/**
 * Output tokens on a generation that never reached the user.
 *
 * The last step's output IS the visible answer (the model's final text); everything before it was tool
 * preambles, abandoned drafts, and post-cap regeneration. So: sum of all-but-last step outputs. Zero
 * when there is no step breakdown or only one step (nothing was wasted).
 */
function wastedOutput(rec: GenerationRecord): number {
  const steps = rec.steps;

  if (!steps || steps.length <= 1) {
    return 0;
  }

  return steps.slice(0, -1).reduce((sum, s) => sum + n(s.outTokens), 0);
}
