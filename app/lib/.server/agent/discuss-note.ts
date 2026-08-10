/**
 * Plan mode — the server half of the chat's Build/Plan toggle (SPEC §4.2.9).
 *
 * The UI labels it **Plan**; the wire value stays `chatMode: 'discuss'` (upstream's field, and the
 * server contract never moved — only the label). "Discuss" in identifiers here means Plan mode.
 *
 * Upstream bolt.diy implemented Discuss by SWAPPING the system prompt (`discuss-prompt.ts`), which on
 * our proxy would be a cache catastrophe: a different first system block is a different prefix, so
 * every Discuss<->Build toggle would re-WRITE the entire cached base prompt at 2x (§4.2.8). Instead
 * the mode is one small instruction in the UNCACHED volatile tail — placed AFTER the last cache
 * breakpoint (the file context), so toggling it invalidates NOTHING and costs a few dozen uncached
 * input tokens on discuss turns only.
 *
 * What it buys: the model answers in prose and emits NO `<boltArtifact>`/`<boltAction>` — no files
 * written, nothing to checkpoint, and (the real saving) the OUTPUT is a few hundred prose tokens
 * instead of a rewritten artifact. Output bills at 5x input and decodes serially at ~60-110 tok/s, so
 * suppressing an unwanted artifact is both the cheapest and the fastest thing a mode can do.
 *
 * A PURE function, tested, because its failure mode is silent: never emitting the note leaves the
 * toggle inert, quietly billing artifact-sized output for planning questions while the user believes
 * nothing can be written.
 *
 * ## 🔴 The first-build exemption is GONE (owner, 2026-08-09)
 *
 * This used to take an `isFirstBuildTurn` flag and drop the note on a creation turn — "the user asked
 * for a game, and an essay instead would be a game-less creation they had already been billed for."
 * Sound when creation was one hidden-brief turn the model was told to build. It is wrong now, twice:
 *
 *   - **The user can ask for a plan first, deliberately.** The handoff card's **Plan my brief** button
 *     (§4.4a) exists to turn the first turn into an ordered task list instead of one 64k-token
 *     everything-at-once build. Dropping the note there composes a `/bt-plan` command and then runs it
 *     with full write access — the read-only half missing, nothing on screen disagreeing.
 *   - **The flag was already inert**, since nothing has sent `CREATION_BRIEF_MARKER` since the brief
 *     was retired. So the exemption was dormant code that would have woken up and broken that button
 *     the moment the brief or the §4.4e phase messages returned. Removing it is a no-op today and the
 *     difference between a working feature and a silent one later.
 *
 * The concern it was written for did not disappear — it moved to where it can be answered: Plan is a
 * mode the user SETS and can see, on a toggle labelled with its current state, and `owesFiles`
 * (`proxy.ts`) already excuses a discuss turn from producing files rather than failing it.
 */
import { PLAN_ARTIFACTS_DIR } from '~/lib/chat/plan-artifacts';

export interface DiscussNoteInput {
  chatMode?: 'discuss' | 'build';
}

export function discussModeNote(input: DiscussNoteInput): string | null {
  if (input.chatMode !== 'discuss') {
    return null;
  }

  return [
    '# Plan Mode (this turn only)',
    '',
    'The user switched this conversation turn to PLAN mode. They want to talk — plan, review,',
    'weigh options, understand the code — not to change the project yet.',
    '',
    '- Respond in plain prose (markdown is fine). Do NOT emit `<boltArtifact>` or `<boltAction>` tags,',
    '  do NOT write or edit any files, and do NOT run shell commands or start media generations.',
    `- ONE exception — planning artifacts: files inside the \`${PLAN_ARTIFACTS_DIR}/\` folder (e.g.`,
    `  \`${PLAN_ARTIFACTS_DIR}/<feature>_spec.md\`, \`${PLAN_ARTIFACTS_DIR}/<feature>_plan.md\`) MAY be`,
    '  written with normal `<boltArtifact>`/`<boltAction type="file">` markup, and those writes ARE',
    '  applied. Use this when a skill (bt-spec, bt-plan) or the user asks you to record a spec or plan',
    '  as a file. Writes to any other path will render as an unapplied proposal — never claim a file',
    `  outside \`${PLAN_ARTIFACTS_DIR}/\` was changed on a plan turn.`,
    '- You may reference project files freely and quote short excerpts to ground the discussion.',
    '- If concrete changes come out of the discussion, END with a short numbered summary of the',
    '  proposed steps and tell the user to switch back to Build mode (or just ask you to build it)',
    '  when they are ready.',
  ].join('\n');
}
