/**
 * "This build did not finish" — the user-visible half of the fail-loud corollary.
 *
 * Sits in the alert stack above the composer with `ChatAlert` and its siblings, and follows their
 * shape deliberately: a heading, a sentence about what it means for the project, and an action that
 * posts a message rather than silently spending a turn.
 *
 * ⚠️ **Not a toast, and that is the point.** The build this exists for is one the user walks away
 * from believing it worked; the warning has to still be on screen when they come back. It is fed from
 * the persisted `agentMeta` annotation, so it survives a reload.
 *
 * Two tones, because the states are genuinely different news:
 *  - `incomplete` / `paused` / `unverified` — the turn stopped short (cut off, at the credit limit,
 *    or with the game check still failing). Loud, and carries the action that continues it, labelled
 *    by the outcome ("Finish the build", "Keep building", "Fix the errors").
 *  - `rescued` — an automatic pass had to save it. The project is fine; the user should simply know
 *    a fallback ran on their bill. Quiet, no action, because there is nothing to do.
 */
import type { TurnOutcome } from '~/lib/agent/turn-outcome';
import { classNames } from '~/utils/classNames';

interface Props {
  outcome: TurnOutcome;
  clearAlert: () => void;
  postMessage: (message: string) => void;
}

export function TurnOutcomeAlert({ outcome, clearAlert, postMessage }: Props) {
  /*
   * Every state that stops short is loud. `paused` and `unverified` (D22) share `incomplete`'s styling
   * and `role="alert"`; only `rescued` (and a stray `finished`) are quiet.
   */
  const incomplete = outcome.state === 'incomplete' || outcome.state === 'paused' || outcome.state === 'unverified';

  return (
    <div
      className={classNames(
        'rounded-lg border p-4 mb-2',
        incomplete
          ? 'border-bolt-elements-button-danger-background bg-bolt-elements-button-danger-background/10'
          : 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-2',
      )}
      role={incomplete ? 'alert' : 'status'}
    >
      <div className="flex items-start gap-3">
        <div
          className={classNames(
            'text-xl shrink-0 mt-0.5',
            incomplete
              ? 'i-ph:warning-circle text-bolt-elements-button-danger-text'
              : 'i-ph:info text-bolt-elements-textSecondary',
          )}
        />

        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-bolt-elements-textPrimary">{outcome.headline}</h3>
          <p className="mt-1 text-sm text-bolt-elements-textSecondary">{outcome.detail}</p>

          <div className="mt-3 flex gap-2">
            {/*
             * Only an outcome with an action gets a button. A rescued one is already finished, and a
             * button that spends a turn to re-do completed work is worse than no button (§4.1a: a
             * permanently dead affordance is a dead end, not a roadmap). The label falls back to
             * "Finish the build" for outcomes persisted before `actionLabel` existed.
             */}
            {outcome.action && (
              <button
                onClick={() => {
                  postMessage(outcome.action!);
                  clearAlert();
                }}
                className={classNames(
                  'px-3 py-1.5 rounded-md text-sm font-medium',
                  'bg-bolt-elements-button-primary-background text-bolt-elements-button-primary-text',
                  'hover:bg-bolt-elements-button-primary-backgroundHover transition-colors',
                )}
              >
                {outcome.actionLabel ?? 'Finish the build'}
              </button>
            )}

            <button
              onClick={clearAlert}
              className={classNames(
                'px-3 py-1.5 rounded-md text-sm',
                'bg-bolt-elements-button-secondary-background text-bolt-elements-button-secondary-text',
                'hover:bg-bolt-elements-button-secondary-backgroundHover transition-colors',
              )}
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default TurnOutcomeAlert;
