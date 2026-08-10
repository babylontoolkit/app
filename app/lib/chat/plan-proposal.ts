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
import { isPlanArtifactPath } from '~/lib/chat/plan-artifacts';

export { NO_REPLAY, PLAN_MODE };

/**
 * The user message sent when "Build & Apply" is clicked. It runs in Build mode (the caller overrides
 * `chatMode`), so the model actually writes this time; the text only has to point it at the plan it
 * just laid out.
 */
export const BUILD_AND_APPLY_MESSAGE = 'Apply the changes you just proposed — make the edits to the project files now.';

/** Every `<boltAction …>` opening tag — each is inspected individually for type and target. */
const BOLT_ACTION_TAG = /<boltAction\b[^>]*>/gi;

function tagAttribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1];
}

/** Was this assistant message produced on a Plan-mode turn? (Server-written `PLAN_MODE` mark.) */
export function isPlanModeMessage(annotations: unknown): boolean {
  return Array.isArray(annotations) && annotations.includes(PLAN_MODE);
}

/**
 * Does the message's text propose a concrete change the read-only wall PREVENTED (a project file
 * write or a shell/start command)? A file action inside `_specs/` deliberately does not count: plan
 * mode's one writable folder (§4.2.9) means that write actually APPLIED, and offering "Build &
 * Apply" for it is the false positive this module's doc comment warns about — a button that spends
 * credits re-running a turn whose changes already landed.
 */
export function messageProposesWrite(content: string): boolean {
  for (const match of content.matchAll(BOLT_ACTION_TAG)) {
    const tag = match[0];
    const type = tagAttribute(tag, 'type')?.toLowerCase();

    if (type === 'shell' || type === 'start') {
      return true;
    }

    if (type === 'file' && !isPlanArtifactPath(tagAttribute(tag, 'filePath'))) {
      return true;
    }
  }

  return false;
}

/**
 * Should the "Build & Apply" button be offered under this message? True only for a plan turn that
 * proposed a concrete change — never a discussion-only plan turn, never a build message.
 */
export function shouldOfferBuildAndApply(annotations: unknown, content: string): boolean {
  return isPlanModeMessage(annotations) && messageProposesWrite(content);
}

/**
 * The plan file a plan turn WROTE — `_specs/<feature>_plan.md` (owner, 2026-08-09).
 *
 * The complement of `messageProposesWrite`, and the reason this file needed a second question. A
 * `bt-plan` turn's write is the ONE that plan mode applies, so nothing was left unapplied and
 * "Build & Apply" is correctly silent — which left the flow with no next step at all: the plan is on
 * disk, the toggle still says Plan, and the user has to know to flip it and type `/bt-execute`.
 *
 * 🔴 **`_plan.md` only, never any `_specs/` file.** `bt-spec` writes `<feature>_spec.md` and the next
 * step there is `bt-plan`, not `bt-execute` — offering to BUILD a spec would skip the planning step the
 * spec exists to feed, and spend a build's worth of credits doing it. The suffix is the skills' stated
 * output convention (`plan-artifacts.ts`, and the plan-mode note states both names to the model).
 *
 * The LAST match wins: a turn that writes a spec and then a plan ends on the plan, and that is the
 * artifact the user just watched appear.
 */
export function planArtifactToExecute(content: string): string | undefined {
  let found: string | undefined;

  for (const match of content.matchAll(BOLT_ACTION_TAG)) {
    const tag = match[0];
    const filePath = tagAttribute(tag, 'filePath');

    if (
      tagAttribute(tag, 'type')?.toLowerCase() === 'file' &&
      isPlanArtifactPath(filePath) &&
      filePath!.trim().toLowerCase().endsWith('_plan.md')
    ) {
      found = filePath!.trim();
    }
  }

  return found;
}

/**
 * The message "Build this plan" sends. Runs in Build mode (the caller overrides `chatMode`).
 *
 * 🔴 **The skill's OWN argument grammar, not a sentence** (owner, 2026-08-09). `bt-execute` is
 * `/bt-execute <plan> <task-id>`, where `ALL` is the literal token for "every remaining task, in
 * order". The first draft wrote an instruction naming the file instead, on the reasoning that guessing
 * at a grammar this repo does not own (skills are authored in `babylontoolkit/skills`) was the risky
 * side. It is the opposite: the skill PARSES those two positions, and its own SKILL.md says that with
 * no task id it must *"list the available task ids and ask the user what to run — DO NOT guess"*. So
 * prose does not degrade to "run everything", it degrades to a round trip that asks the question this
 * button exists to have already answered.
 *
 * ⚠️ Two positional tokens, so `planPath` must be a path with no spaces — `_specs/<feature>_plan.md`
 * by convention, and `planArtifactToExecute` only ever returns one of those.
 */
export function executePlanMessage(planPath: string): string {
  return `/bt-execute ${planPath} ALL`;
}

/**
 * What to offer under a plan-mode reply: apply an unapplied proposal, build the plan that landed, or
 * nothing at all.
 *
 * ONE button per message, decided here rather than by two independent `&&`s in the JSX — two accent
 * buttons under one reply is the §4.1a row problem in miniature, and the user cannot be expected to
 * pick between "apply" and "build" when the difference is which of them the read-only wall touched.
 *
 * **`apply` wins when both are true.** A proposed write is a concrete change the model just showed and
 * the wall blocked, so it is the narrower, cheaper and more predictable of the two; executing a whole
 * plan is many turns of work the user can ask for immediately afterwards. This also keeps every
 * existing plan turn behaving exactly as it did.
 */
export type PlanFollowUp = { kind: 'apply' } | { kind: 'execute'; planPath: string };

export function decidePlanFollowUp(annotations: unknown, content: string): PlanFollowUp | null {
  if (!isPlanModeMessage(annotations)) {
    return null;
  }

  if (messageProposesWrite(content)) {
    return { kind: 'apply' };
  }

  const planPath = planArtifactToExecute(content);

  return planPath ? { kind: 'execute', planPath } : null;
}
