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
 * A PURE function, tested, because both failure modes are silent: emitting the note on a creation
 * turn would produce a game-less "creation" (the user asked for a game and gets an essay — while the
 * full creation context was assembled and billed), and never emitting it leaves the toggle inert,
 * quietly billing artifact-sized output for planning questions.
 */
export interface DiscussNoteInput {
  chatMode?: 'discuss' | 'build';

  /** The creation turn MUST build (§4.4) — Discuss is ignored on it, like the premium toggle. */
  isCreationTurn: boolean;
}

export function discussModeNote(input: DiscussNoteInput): string | null {
  if (input.chatMode !== 'discuss' || input.isCreationTurn) {
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
    '- You may reference project files freely and quote short excerpts to ground the discussion.',
    '- If concrete changes come out of the discussion, END with a short numbered summary of the',
    '  proposed steps and tell the user to switch back to Build mode (or just ask you to build it)',
    '  when they are ready.',
  ].join('\n');
}
