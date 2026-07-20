/**
 * "Build & Apply" affordance logic (SPEC §4.2.9).
 *
 * Plan mode is READ-ONLY by guarantee: a `<boltAction type="file">` the model emits on a plan turn is
 * rendered as a proposal but never executed (the `NO_REPLAY` wall in `api.agent.ts`). That is correct,
 * but it leaves a trap — the model may claim it "made the changes" while nothing was written, and the
 * user has no obvious way to say "yes, actually do that". The fix is a deterministic one-click button on
 * the plan reply that flips the toggle to Build and re-runs, instead of guessing at the user's words.
 *
 * The button appears ONLY on a plan turn that actually PROPOSED a concrete change. A pure discussion /
 * Q&A plan turn proposes nothing, so there is nothing to apply and no button is shown. Both halves are
 * required:
 *   - `isPlanModeMessage` — the message carries the server-written `PLAN_MODE` mark (never present on a
 *     normal or restored build message, so the button can never appear where files are already applied);
 *   - `messageProposesWrite` — the rendered text contains an actionable `<boltAction>` (a file write or
 *     a shell/start command) that the read-only wall prevented from running.
 *
 * Pure and tested because it is a display gate that must not misfire: a false positive offers to spend
 * credits re-running a turn that changed nothing, a false negative recreates the silent dead-end.
 */
import { NO_REPLAY, PLAN_MODE } from '~/types/message-marks';

export { NO_REPLAY, PLAN_MODE };

/**
 * The user message sent when "Build & Apply" is clicked. It runs in Build mode (the caller overrides
 * `chatMode`), so the model actually writes this time; the text only has to point it at the plan it
 * just laid out.
 */
export const BUILD_AND_APPLY_MESSAGE = 'Apply the changes you just proposed — make the edits to the project files now.';

/** A `<boltAction>` that would WRITE or RUN something (as opposed to prose the model wrapped in tags). */
const ACTIONABLE_BOLT_ACTION = /<boltAction\b[^>]*\btype\s*=\s*["'](?:file|shell|start)["']/i;

/** Was this assistant message produced on a Plan-mode turn? (Server-written `PLAN_MODE` mark.) */
export function isPlanModeMessage(annotations: unknown): boolean {
  return Array.isArray(annotations) && annotations.includes(PLAN_MODE);
}

/** Does the message's text propose a concrete change (a file write or a shell/start command)? */
export function messageProposesWrite(content: string): boolean {
  return ACTIONABLE_BOLT_ACTION.test(content);
}

/**
 * Should the "Build & Apply" button be offered under this message? True only for a plan turn that
 * proposed a concrete change — never a discussion-only plan turn, never a build message.
 */
export function shouldOfferBuildAndApply(annotations: unknown, content: string): boolean {
  return isPlanModeMessage(annotations) && messageProposesWrite(content);
}
