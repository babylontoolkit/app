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

export type BuildDoneBanner = { state: 'ready' } | { state: 'unverified' };

interface AnnotationLike {
  type?: unknown;
  value?: { creationPhasesCompleted?: unknown; outcome?: { state?: unknown } } | null;
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

  /* Only these two describe a build that ran to its end; anything else is not a "done" moment. */
  if (state === undefined || state === 'finished' || state === 'rescued') {
    return { state: 'ready' };
  }

  return state === 'unverified' ? { state: 'unverified' } : null;
}
