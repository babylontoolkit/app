/**
 * The "build done" banner on the message that finished a project's first build (owner, 2026-10-02:
 * *"We need to show some kind of BUILD DONE message at the end of the multi-stage initial build"*). Pure.
 *
 * The only end-of-build signal used to be a toast — five seconds, gone on a reload, and fired only by the
 * tab that pressed Build, so a build that finished after a dropped stream or a reload announced nothing at
 * all and the user was left watching a plan card that still said Step 1. This banner is drawn from the
 * message's PERSISTED annotations, so it is there for as long as the message is — after a reload, on another
 * device, whichever tab was open when the build finished.
 *
 * The signal is `agentMeta.creationPhasesCompleted`: the managed engine sets it only on a turn that ended
 * normally having run every step the build still owed (`engine.ts`). The outcome decides the wording: a build
 * whose final game check did not pass is finished but NOT "ready", and the banner must never claim a working
 * game the check did not see — the turn-outcome alert beside it carries the fix.
 */
import { parseCreationPhasesCompleted } from './creation-plan';

/**
 * `credits` is what creating the project cost in total — create fee, build turns and renders, net of refunds
 * (owner, 2026-10-04: one total at the end instead of a running counter). Absent when the server sent none.
 */
export type BuildDoneBanner = { state: 'ready' | 'unverified'; credits?: number };

interface AnnotationLike {
  type?: unknown;
  value?: { creationPhasesCompleted?: unknown; creationCredits?: unknown; outcome?: { state?: unknown } } | null;
}

export function decideBuildDoneBanner(annotations: readonly unknown[] | undefined): BuildDoneBanner | null {
  const meta = (annotations ?? []).find(
    (a): a is AnnotationLike => Boolean(a) && typeof a === 'object' && (a as AnnotationLike).type === 'agentMeta',
  );
  const phases = parseCreationPhasesCompleted(meta?.value?.creationPhasesCompleted);

  if (!phases || phases.length === 0) {
    return null;
  }

  const state = meta?.value?.outcome?.state;
  const raw = meta?.value?.creationCredits;
  const cost = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? { credits: Math.round(raw) } : {};

  /* Only these two describe a build that ran to its end; anything else is not a "done" moment. */
  if (state === undefined || state === 'finished' || state === 'rescued') {
    return { state: 'ready', ...cost };
  }

  return state === 'unverified' ? { state: 'unverified', ...cost } : null;
}

/** "Creating this project cost 1,234 credits in total." — nothing when no total was recorded. */
export function formatCreationCost(credits: number | undefined): string | undefined {
  if (credits === undefined) {
    return undefined;
  }

  return `Creating this project cost ${credits.toLocaleString('en-US')} credit${credits === 1 ? '' : 's'} in total.`;
}
