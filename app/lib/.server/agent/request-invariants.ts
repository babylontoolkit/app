/**
 * 🔴 FOUR THINGS THAT MUST BE TRUE OF EVERY ASSEMBLED REQUEST (SPEC §4.2 step 2a, §4.2.8).
 *
 * Each is a pure, separately-exported predicate over the assembled arrays — the `countCacheBreakpoints`
 * shape, deliberately not logic buried in the proxy closure, because the whole value of a guard is
 * that you can point a test at it.
 *
 * They exist because three incidents in this codebase had the same shape and none of them threw:
 * the model was shown 7 files of a 78-file tree; every agent-written file was listed twice for weeks;
 * the history carried stale file bodies at 83–87% of a re-sent conversation. In all three the request
 * was wrong, the record was right about everything it recorded, and **nothing anywhere compared the
 * two**. These predicates are that comparison.
 *
 * ## The rule that governs all four
 *
 * 🔴 **A VIOLATION NEVER FAILS THE GENERATION IN PRODUCTION.** It reports — a monitor alert and a
 * persisted field on the record. `spec/fail-loud.md` sanctions exactly two silent swallows and
 * *"observability itself"* is one of them: a guard that can take down a paid turn is worse than the
 * defect it watches for. Under test it THROWS, because a guard that only ever reports is a guard
 * nobody notices going quiet, and that property is what makes this worth having rather than a chart.
 */
import type { CoreMessage } from 'ai';
import type { ManifestEntry } from '~/lib/context/file-manifest';
import type { CollapsedPath } from '~/lib/common/sandbox-paths';

export type InvariantId = 'INV-1' | 'INV-2' | 'INV-3a' | 'INV-3b' | 'INV-4';

export interface InvariantViolation {
  invariant: InvariantId;

  /** Short, human, and safe to put in an alert: names and counts, never a body. */
  detail: string;
}

/**
 * INV-1 — no two manifest entries normalise to the same project-relative path.
 *
 * The de-dup backstop already collapses them. This makes the collapse REPORT rather than merely
 * happen (`spec/fail-loud.md` rule 3) — and it names BOTH spellings, because "a duplicate was
 * collapsed" is not actionable and "`src/pages/Home.tsx` also arrived as
 * `/home/project/src/pages/Home.tsx`" says exactly which ingest path to go and look at.
 *
 * ⚠️ It takes what the de-dup ALREADY collapsed rather than re-deriving it. Re-deriving would be a
 * third implementation of a rule this feature just finished reducing to one.
 */
export function checkNoDuplicatePaths(collapsed: readonly CollapsedPath[]): InvariantViolation | null {
  if (collapsed.length === 0) {
    return null;
  }

  const named = collapsed
    .slice(0, 5)
    .map((c) => `${c.path} (kept '${c.kept}', dropped '${c.dropped}')`)
    .join('; ');

  return {
    invariant: 'INV-1',
    detail:
      `${collapsed.length} file(s) arrived under more than one spelling and were collapsed: ${named}` +
      `${collapsed.length > 5 ? ` (+${collapsed.length - 5} more)` : ''}`,
  };
}

/**
 * What the history compactor leaves in place of a file body (`llm/history.ts`).
 *
 * ⚠️ Duplicated as a LENGTH, not as the string: `history.ts` owns the marker's text, and importing a
 * server module's constant into a predicate that must stay pure is not worth the coupling.
 *
 * ⚠️ The headroom is 12 characters (the real marker trims to 88) and it is NOT slack in a safe
 * direction — a claim that "a marker that grows only makes this stricter" is backwards. A marker
 * longer than this floor would make INV-2 fire on EVERY compacted request, i.e. flood the signal with
 * false positives rather than tighten it. `request-invariants.spec.ts` therefore reads the literal out
 * of `history.ts` and asserts it EXACTLY — never `toContain`, which goes green on a marker that grew,
 * i.e. on the one direction this paragraph is warning about — and separately asserts it still fits
 * under this floor.
 */
export const OMITTED_MARKER_CHARS = 100;

const FILE_ACTION = /<boltAction[^>]*type="(?:file|edit)"[^>]*>([\s\S]*?)<\/boltAction>/g;

/**
 * INV-2 — no file body survives compaction, asserted on the CONVERTED array.
 *
 * ⚠️ This is the check `history.spec.ts` structurally cannot make. That suite tests the regex against
 * `Message[]` fixtures it builds itself, so a client shipping a THIRD carrier for the message text is
 * invisible to it — and its own header records that this trap has already fired once, when `parts`
 * was added beside `content` and a content-only fix passed every test while changing nothing on the
 * wire. Running post-`convertToCoreMessages` means whatever the SDK actually produced is what is
 * inspected, regardless of which field it came out of.
 *
 * A `shell` action's command is untouched by design: it is not a file body, it is what the action IS.
 */
export function checkNoFileBodies(messages: readonly CoreMessage[]): InvariantViolation | null {
  const offenders: string[] = [];

  for (const [index, message] of messages.entries()) {
    for (const text of textPartsOf(message.content)) {
      for (const match of text.matchAll(FILE_ACTION)) {
        const body = match[1] ?? '';

        if (body.trim().length > OMITTED_MARKER_CHARS) {
          offenders.push(`message ${index} (${message.role}): a file action body of ${body.length} chars`);
        }
      }
    }
  }

  if (offenders.length === 0) {
    return null;
  }

  return {
    invariant: 'INV-2',
    detail: `${offenders.length} file body(ies) survived compaction into the request: ${offenders.slice(0, 5).join('; ')}`,
  };
}

/** Every string of TEXT a core message carries. Attachment parts have no text and are skipped. */
function textPartsOf(content: unknown): string[] {
  if (typeof content === 'string') {
    return [content];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((part) => {
    const text = (part as { text?: unknown })?.text;

    return typeof text === 'string' ? [text] : [];
  });
}

/** The framework file every Babylon Toolkit project has, scaffolded or imported. */
const FRAMEWORK_SENTINEL = 'src/babylon/globals.ts';

export interface FirstBuildManifestInput {
  isFirstBuildTurn: boolean;
  entries: readonly ManifestEntry[];

  /**
   * The §4.4b scaffolded class, project-relative, when the project HAS one.
   *
   * ⚠️ `undefined` is a real and ordinary answer — an imported or remixed project legitimately has no
   * scaffolded class (edge case 7), and a degraded creation that failed to scaffold has none either.
   * When it is absent the check falls back to the framework sentinel alone. Treating "we don't know
   * the class name" as "the class is missing" would fire this alert on every import, which is how a
   * channel gets muted in week one.
   */
  scaffoldedClassPath?: string;
}

/**
 * INV-3(a) — on a first build turn, the files the model MUST be able to see are in the manifest.
 *
 * These are the same paths `waitForMountVisible` waits for on the client (`create-project.ts`'s
 * `mustBeVisible`), verified for the first time by the party that actually builds the request. The
 * client wait is a promise about the store; this is the receipt.
 *
 * It is also the first thing that would notice a project whose tree never quiesced —
 * `settleAfterCreation` reaching its ceiling is documented as *"normal and silent"* (edge case 14),
 * and silent is precisely the problem.
 *
 * ⚠️ **WHAT IS LIVE TODAY, stated so nobody reads this as more than it is: only the framework
 * sentinel.** The proxy does not pass `scaffoldedClassPath`, because the scaffolded class's NAME is a
 * client-side fact (`create-project.ts` derives it from the project title) and the server is never
 * told it. A heuristic substitute was tried and REJECTED: "the manifest contains no `src/scripts/`
 * file" fires on every legitimately imported or remixed project (edge case 7), which is the
 * noisy-in-week-one failure that mutes a channel. So the parameter stays, exercised by tests and
 * ready for the turn that can name the class, and the honest live scope is the framework file — which
 * is the one that was actually missing in the incident this was written for.
 */
export function checkFirstBuildManifest(input: FirstBuildManifestInput): InvariantViolation | null {
  if (!input.isFirstBuildTurn) {
    return null;
  }

  const paths = new Set(input.entries.map((e) => e.path));
  const missing: string[] = [];

  if (!paths.has(FRAMEWORK_SENTINEL)) {
    missing.push(FRAMEWORK_SENTINEL);
  }

  if (input.scaffoldedClassPath && !paths.has(input.scaffoldedClassPath)) {
    missing.push(input.scaffoldedClassPath);
  }

  if (missing.length === 0) {
    return null;
  }

  return {
    invariant: 'INV-3a',
    detail:
      `a first build turn was assembled without ${missing.join(' and ')} in a ${input.entries.length}-entry ` +
      'manifest — the model is being asked to build a game it cannot see the framework of',
  };
}

/**
 * How much of the manifest may disappear between two turns of one chat before it is worth recording.
 *
 * A fraction rather than a count: "12 files vanished" is alarming on a 20-file project and routine on
 * a 400-file one.
 */
export const MANIFEST_SHRINK_FRACTION = 0.5;

/** In-process, per CHAT — two tabs on one project interleave through this process (edge case 10). */
const lastSeenEntryCount = new Map<string, number>();

/**
 * INV-3(b) — the manifest shrank sharply within one chat.
 *
 * 🔴 **The suppression signal has landed, so this now alerts like every other invariant** (§4.13a
 * T15; Open Question 1, decided by the owner 2026-08-21). A branch switch is a legitimate large
 * file-map change on EVERY SINGLE USE — a feature branch with 90 files to a default branch with 60 is
 * exactly this shape, and it is correct — so alerting on it without a way to say "that one was
 * deliberate" would make the channel noisy in week one for precisely the users adopting the new
 * feature, and a muted channel is the same as no guard. `applyBranchTree` emits `treeReplaced` once,
 * for the turn after it swaps the tree; this re-baselines and reports nothing.
 *
 * ⚠️ **The "RECORDING-ONLY" claim this comment used to carry was never implemented.** There was no
 * filter anywhere: the violation went into `manifestViolations` → `integrityIssues` → `reportIntegrity`
 * with every other one, so it has been alert-capable since the day it shipped. A false claim in a
 * comment is how a thing survives review — recorded here rather than quietly corrected, because the
 * useful part is that the gap was found by looking for the code the sentence described.
 *
 * ⚠️ The suppression can only ever make this SAY LESS. It arrives in a browser body, so it is worth
 * stating what it cannot do: it spends no credit, selects no model, reaches no file, and cannot make
 * a violation appear. The worst a tampered value achieves is muting a signal about the tamperer's own
 * project.
 *
 * ⚠️ Best-effort and non-durable by design. The `GenerationStore` has no `get(id)` and no
 * query-by-chat, and adding one for a signal is not worth a store change. It is also per-PROCESS, so
 * a user's turns landing on different instances simply will not fire it (edge case: acceptable for a
 * signal, unacceptable if this is ever promoted to anything stronger).
 */
export function checkManifestShrink(
  chatId: string | undefined,
  entryCount: number,
  options: { treeReplaced?: boolean } = {},
): InvariantViolation | null {
  if (!chatId) {
    return null;
  }

  const previous = lastSeenEntryCount.get(chatId);

  /*
   * 🔴 RE-BASELINE FIRST, ALWAYS — including on the suppressed turn, and including when we are about
   * to return a violation.
   *
   * A suppressed turn that did not update the baseline would compare the NEXT turn against the
   * pre-switch count too, so one switch would suppress one turn and then fire on the one after it:
   * the noise arrives a turn late instead of not arriving, which is worse than not suppressing at all
   * because the signal now points at an innocent turn.
   */
  lastSeenEntryCount.set(chatId, entryCount);

  /*
   * The tree was replaced on purpose (§4.13a — a branch switch, a discard, a pull). The shrink is real
   * and it is correct, so there is nothing to report.
   */
  if (options.treeReplaced) {
    return null;
  }

  /* No previous turn is not a shrink. A legitimately tiny project is not one either (edge case 8). */
  if (previous === undefined || previous === 0) {
    return null;
  }

  if (entryCount >= previous * MANIFEST_SHRINK_FRACTION) {
    return null;
  }

  return {
    invariant: 'INV-3b',
    detail:
      `the file manifest for this chat went from ${previous} entries to ${entryCount}. This is a SIGNAL, ` +
      'not a verdict: a user deleting half a project produces the same shape, and the server cannot ' +
      'tell the two apart',
  };
}

/** Test seam — the map is module state, and a spec that cannot clear it is order-dependent. */
export function resetManifestShrinkState() {
  lastSeenEntryCount.clear();
}

/**
 * INV-4 — a model handoff that HAPPENED reached the record.
 *
 * §4.2a's refusal fallback retries a declined request on another model **on the same stream**, so a
 * different model serves the turn while the turn still bills at the requested model's rates.
 * `fallbackHandoffs` exists precisely so that stays visible — and until migration 0023 it had no
 * column, so in production it did not. This is the check that a handoff observed on the wire is a
 * handoff the record carries.
 *
 * ⚠️ A handoff is NOT itself a violation. Recording the requested model is correct — it is what the
 * turn bills at (edge case 15). Both facts are needed and neither alone is the answer; the violation
 * is losing one of them.
 *
 * ⚠️ **What it can and cannot see, stated plainly.** It must be handed the value that is ACTUALLY ON
 * THE RECORD PAYLOAD — not a local re-derivation of it, which would make the call
 * `checkHandoffRecorded(x, x)` and unable to fire for any input. The caller therefore reads the field
 * back off the object it is about to persist. It still cannot see a STORE that drops the column;
 * that failure is one layer down and is guarded structurally by `FIELD_COVERAGE`, which is where a
 * property of the store belongs.
 */
export function checkHandoffRecorded(
  observed: readonly string[] | undefined,
  recorded: readonly string[] | undefined,
): InvariantViolation | null {
  const seen = observed ?? [];

  if (seen.length === 0) {
    return null;
  }

  if ((recorded ?? []).length >= seen.length) {
    return null;
  }

  return {
    invariant: 'INV-4',
    detail:
      `${seen.length} model handoff(s) occurred (${seen.join(', ')}) but ${(recorded ?? []).length} reached the ` +
      'record — the turn billed at the requested model and nothing says which model answered',
  };
}

/**
 * 🔴 REPORT IN PRODUCTION. THROW UNDER TEST. NEVER FAIL A PAID TURN.
 *
 * The asymmetry is the whole design and both halves are load-bearing:
 *
 *  - **Production reports.** `spec/fail-loud.md` sanctions exactly two silent swallows and
 *    *"observability itself"* is one of them. A guard that can kill a generation the user has already
 *    been gated for is strictly worse than the defect it watches for — the defect costs tokens, the
 *    guard costs the turn.
 *  - **Test throws.** A guard that only ever reports is a guard nobody notices going quiet. Without
 *    this half the feature is a chart, and `spec/fail-loud.md` rule 6 — *a guard is only real if a
 *    test fails when it is removed* — has nothing to bite on.
 *
 * ⚠️ The mode is an INJECTED PARAMETER, not a global env read, and that is not stylistic: the test
 * that proves the PRODUCTION reporting path works must be able to run the guard without dying on the
 * throw. Reaching for `process.env.VITEST` here would make the reporting half untestable — the guard
 * would be provably loud and unprovably useful.
 */
export type IntegrityMode = 'report' | 'throw';

/**
 * 🔴 THIS SIGNAL NEEDS ITS OWN WINDOW, AND INHERITING THE DEFAULT SILENCES IT COMPLETELY.
 *
 * `DEFAULT_FAILURE_RATE_CONFIG` is `minSamples: 10, threshold: 0.5` — tuned for "is a subsystem
 * broken", where half of everything failing is the interesting state. Measured against that config, a
 * single INV-1 duplicate path or a single lost INV-4 handoff **in twenty otherwise-healthy turns
 * alerts ZERO times**, and the first alert lands only once ten of the last twenty generations are
 * violating.
 *
 * That is precisely backwards for this signal. Every incident it was built for was LOW FREQUENCY and
 * high cost: one project's file map double-keyed for weeks at ~22.5k tokens a turn; one refusal
 * fallback whose handoff had nowhere to land. A window that only fires at 50% is guaranteed to
 * swallow all of them — an alert that cannot fire on the incidents it was written for is the muted
 * pager it was supposed to avoid, arriving through the threshold instead of through the volume.
 *
 * So: a LOW threshold with a real cooldown. Any sustained violation is worth one alert; the cooldown,
 * not the threshold, is what stops it becoming a pager nobody reads. ⚠️ `sharedRateWindow` fixes its
 * config on FIRST USE, so the `'request-integrity'` window must have exactly ONE creator — it is
 * `proxy.ts`, and `report-integrity.spec.ts` pins that it passes this config rather than inheriting
 * the shared default.
 */
export const REQUEST_INTEGRITY_RATE_CONFIG = {
  /* Three samples, not ten: a violation on turn one of a quiet deploy is still worth knowing. */
  minSamples: 3,

  /* 10%, not 50%. These are rare-and-expensive, not broken-subsystem. */
  threshold: 0.1,

  windowSize: 20,

  /* One alert, then quiet for a window — the cooldown does the de-duplication, not the threshold. */
  cooldownSamples: 20,
};

/** The house form. Callers may override; the default is what the proxy gets. */
export function defaultIntegrityMode(): IntegrityMode {
  return process.env.VITEST || process.env.NODE_ENV === 'test' ? 'throw' : 'report';
}

export interface IntegrityReport {
  violations: InvariantViolation[];

  /** `true` when the rolling window says this one is worth waking somebody for. */
  shouldAlert: boolean;

  /** The failing fraction over the window, for the alert's body. */
  rate: number;
}

export interface IntegrityReporter {
  /** Fire-and-forget. It must never throw — that is `getMonitor()`'s contract (§5A). */
  alert(detail: string, tags: Record<string, string>): void;
}

/**
 * Fold a turn's violations into the rolling window, report, and (under test) throw.
 *
 * ⚠️ **Every generation is recorded, not only the violating ones.** A window fed only failures has no
 * denominator, so its "rate" is always 1.0 and the threshold means nothing — the same rule
 * `proxy.ts`'s failure-rate call already follows. Passing an empty array is a healthy sample and must
 * still be recorded.
 *
 * ⚠️ The reporter is wrapped. A guard whose survival depends on a monitoring library has moved the
 * silent failure one level down, which is the `execution-queue` lesson: `onError` is required, not
 * politeness.
 */
export function reportIntegrity(
  violations: readonly InvariantViolation[],
  options: {
    mode?: IntegrityMode;
    reporter?: IntegrityReporter;
    tags?: Record<string, string>;
    window?: { record(failed: boolean): { shouldAlert: boolean; rate: number } };
  } = {},
): IntegrityReport {
  const mode = options.mode ?? defaultIntegrityMode();
  const found = [...violations];

  /*
   * Recorded on EVERY turn — a window with no denominator cannot have a rate.
   *
   * Wrapped for the reporter's reason: in production this whole function must be total, so that the
   * ONLY thing able to escape it is the deliberate test-mode throw below. That is what lets the proxy
   * call it bare and still never lose a paid turn to its own bookkeeping.
   */
  let outcome = { shouldAlert: found.length > 0, rate: 1 };

  try {
    outcome = options.window?.record(found.length > 0) ?? outcome;
  } catch {
    /* Observability itself — the one sanctioned swallow (`spec/fail-loud.md`). */
  }

  /*
   * 🔴 NO SECOND GATE ON "DID THIS TURN VIOLATE" — and the absent `found.length > 0 &&` is the whole
   * point of this comment, because adding it is the obvious thing to write and it silently breaks the
   * alert.
   *
   * `FailureRateWindow.record` zeroes its cooldown on whichever sample TRIPS the threshold, and that
   * sample is frequently a healthy one — a violation enters the window, the rate crosses on the next
   * clean turn, and the window reports `shouldAlert`. Gating on this turn's violations there discards
   * the alert **and consumes the twenty-sample cooldown anyway**, so a lone violation followed by
   * healthy traffic pages ZERO times. Measured on the real config: `[violation, x19 clean]` fires at
   * sample 3 (a clean turn), gets swallowed, and nothing alerts for the remaining 17.
   *
   * That is a second, independent instance of exactly what `REQUEST_INTEGRITY_RATE_CONFIG` exists to
   * prevent — the config fixed the THRESHOLD half, this is the ORDERING half — and it is invisible to
   * any test that only feeds sustained violations. So: alert on the WINDOW, like `sharedFailureRate`'s
   * consumer one screen over, which has never had this bug because it never added the extra gate.
   */
  const shouldAlert = outcome.shouldAlert;

  if (shouldAlert && options.reporter) {
    const detail = found.length
      ? found.map((v) => `${v.invariant}: ${v.detail}`).join(' | ')
      : `request integrity violations at ${(outcome.rate * 100).toFixed(0)}% of recent generations ` +
        '(this turn was clean — the rate crossed on it)';

    try {
      options.reporter.alert(detail, {
        ...options.tags,
        invariants: found.map((v) => v.invariant).join(','),
      });
    } catch {
      /*
       * The one sanctioned swallow, and it is deliberately narrow: observability itself
       * (`spec/fail-loud.md`). A reporter that throws must not be able to take down the generation
       * this guard exists to leave running.
       */
    }
  }

  if (found.length > 0 && mode === 'throw') {
    /*
     * 🔴 THE HALF THAT MAKES THIS A GUARD RATHER THAN A CHART — and it only works if the CALLER does
     * not swallow it. `proxy.ts` therefore calls this bare, with no `try/catch` of its own: everything
     * that could throw for an uninteresting reason (the reporter, the window) is already wrapped
     * INSIDE this function, so the only thing that can escape is this deliberate throw. Wrapping it at
     * the call site would catch exactly the one exception that is supposed to fail a suite, which is
     * how "it throws under test" becomes a sentence in a comment with nothing behind it.
     */
    throw new Error(
      `Request integrity violated (${found.length}): ${found.map((v) => `${v.invariant} — ${v.detail}`).join(' | ')}`,
    );
  }

  return { violations: found, shouldAlert, rate: outcome.rate };
}
