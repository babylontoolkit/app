/**
 * 🔴 THE BUILD SHOWS EVERY STEP — ALL of them, from the first (owner, 2026-08-14).
 *
 * *"If you are going to show these Steps… YOU MUST SHOW ALL STEPS, so the user knows what is going on.
 * Including the first and last steps... all of them."*
 *
 * ## What the user was actually seeing
 *
 * Phased creation posts a turn per phase, and the only trace of that on screen was the short user
 * message each phase carries — `Step 2 of 4 — art.` So the build read like this:
 *
 *   - **step 1 was invisible.** The front-end phase rides the user's OWN message (that is deliberate:
 *     posting their words and then a machine turn would pay for the whole prefix twice to say one
 *     thing), so nothing ever announced it. The first thing the user saw was `Step 2 of 4`.
 *   - **the middle steps were disconnected labels** with no list to belong to.
 *   - **the last step never resolved** — the count stopped and nothing said why.
 *
 * A counter that starts at 2 and stops before the end is worse than no counter: it tells the user
 * there is a plan, shows them neither its beginning nor its end, and leaves them to infer that
 * something was skipped. Which, on the run that produced the report, it had been.
 *
 * ## Why this is a CARD and not more chat messages
 *
 * The plan is STATE, not conversation. It has a shape the user should be able to look at — three
 * steps, this one is running, that one is done — and re-reading a transcript to reconstruct it is
 * exactly the work a UI is for. It is also the only way step 1 can be shown at all without inventing
 * a message for a turn that deliberately does not have one.
 *
 * ⚠️ **It renders from `describeCreationPlan`, which was written, tested and never called.** Same
 * shape as `creationPhaseMessage` before the runner existed: a pure function with no renderer is a
 * feature that is finished everywhere except where the user could see it.
 *
 * ⚠️ Self-gating off the store, like `CreationHandoffCard` beside it — no prop threading, and it costs
 * an ordinary project nothing because a project with no plan renders `null`.
 */
import { useStore } from '@nanostores/react';
import { describeCreationPlan, phaseById } from '~/lib/agent/creation-plan';
import { newProjectModeStore } from '~/lib/stores/new-project-mode';
import { projectId } from '~/lib/persistence/useChatHistory';

export function CreationPlanCard() {
  const mode = useStore(newProjectModeStore);
  const pid = useStore(projectId);

  /*
   * The same second wall as the handoff card: a module-level store survives an SPA navigate, so
   * without the project check a plan could follow the user into a different project and narrate a
   * build that is not happening there.
   */
  if (!mode?.plan || !pid || mode.projectId !== pid) {
    return null;
  }

  const view = describeCreationPlan(mode.plan);

  /*
   * A finished plan takes the card away rather than showing a row of ticks forever. The build is over;
   * what the user wants on screen then is their game, and `exitNewProjectMode` clears the mode moments
   * later anyway — rendering "complete" in the gap only makes the card flash before it vanishes.
   */
  if (view.complete) {
    return null;
  }

  const current = phaseById(mode.plan.phases[mode.plan.next]);

  return (
    <div className="max-w-chat mx-auto w-full px-1">
      <div className="rounded-lg border border-accent-500/40 bg-bolt-elements-background-depth-2 p-4">
        <div className="flex items-center gap-2 mb-1">
          <div className="i-svg-spinners:90-ring-with-bg text-lg text-accent-500" />
          <h2 className="text-sm font-semibold text-bolt-elements-textPrimary">{current.activeLabel}</h2>
        </div>

        {/*
         * The counter and the list say the same thing two ways ON PURPOSE. The list is what the user
         * reads to understand the shape of the build; the counter is what they glance at to see how
         * far in they are, and it is the string that was previously the ONLY thing on screen.
         */}
        <p className="text-xs text-bolt-elements-textTertiary mb-3">
          {view.step} — your game is built in steps so each one fits in a single response.
        </p>

        <ol className="flex flex-col gap-1.5">
          {view.rows.map((row, n) => (
            <li key={row.id} className="flex items-center gap-2 text-sm">
              <span
                className={
                  row.state === 'done'
                    ? 'i-ph:check-circle-fill text-base text-green-500'
                    : row.state === 'current'
                      ? 'i-svg-spinners:90-ring-with-bg text-base text-accent-500'
                      : 'i-ph:circle text-base text-bolt-elements-textTertiary'
                }
                aria-hidden
              />
              <span
                className={
                  row.state === 'pending' ? 'text-bolt-elements-textTertiary' : 'text-bolt-elements-textPrimary'
                }
              >
                {/*
                 * Numbered from ONE and rendered for every phase including the one already running —
                 * the whole point of the card. `aria-current` so a screen reader lands on the step in
                 * progress rather than reading three lines of equal weight.
                 */}
                {n + 1}. {row.label}
              </span>
              {row.state === 'current' && (
                <span className="sr-only" aria-current="step">
                  in progress
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
