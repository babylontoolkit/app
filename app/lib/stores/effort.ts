/**
 * The user's base thinking effort for THIS session (SPEC §4.2a, §4.2.9) — the `/effort` control.
 *
 * Thinking tokens bill as OUTPUT, at the full output rate (`spec/anthropic-models.md` §3.5), so this is
 * the one user-facing dial that moves the bill directly rather than through what gets built. Two levels,
 * and only two:
 *
 *  - **`medium`** — the default, and there is nothing below it (`low` breached a read-only project zone
 *    when we measured it; it is not even representable in `EffortLevel`).
 *  - **`high`** — for a genuinely hard task where the extra deliberation is worth the credits.
 *
 * `xhigh`/`max` are deliberately NOT offered. Those are what `effort-policy.ts` escalates to on EVIDENCE
 * (a repair that has already failed twice); handing them out as a session default turns an escalation
 * ceiling into a floor, and every ordinary edit would start where a twice-failed build ends.
 *
 * ## It is a SESSION preference and it is NOT persisted — that is the point
 *
 * Unlike `modelTierStore` (localStorage), this resets to `medium` on every reload. A raised floor
 * costs real money on every subsequent turn while producing no visible signal that it is on, so the
 * failure mode of persisting it is the worst kind: a user raises it once for one hard problem, forgets,
 * and quietly pays more for months. Making it session-scoped means the expensive state can never outlive
 * the reason it was chosen. `/effort` is one keystroke away when it is wanted again.
 *
 * Authority still lives on the server: the proxy validates this with `parseUserEffort` and `effortForTurn`
 * treats it as a floor, so a tampered store can only ever ask for one of the two levels.
 */
import { atom } from 'nanostores';
import { DEFAULT_USER_EFFORT, type UserEffortLevel } from '~/lib/modules/llm/capabilities';

export type { UserEffortLevel };

/** The session's base effort. Sent on every generation; the server treats it as a floor, never a cap. */
export const baseEffortStore = atom<UserEffortLevel>(DEFAULT_USER_EFFORT);

/** `/effort` opens the picker; the `/context` panel's effort row toggles it too. */
export const effortPanelOpen = atom<boolean>(false);

export function setBaseEffort(level: UserEffortLevel): void {
  baseEffortStore.set(level);
}

/** Human labels for the two levels — one source, shared by the picker, the model pill and `/context`. */
export const EFFORT_LABELS: Record<UserEffortLevel, string> = {
  medium: 'Medium',
  high: 'High',
};

/**
 * What each level actually buys, in the terms a user cares about (credits and depth) rather than in
 * API terms. Honest about `high`: it is more deliberation, and more deliberation is more output tokens.
 */
export const EFFORT_DESCRIPTIONS: Record<UserEffortLevel, string> = {
  medium: 'Default. Best value — full-quality builds and edits at the lowest thinking spend.',
  high: 'More deliberation before it writes. Costs more credits per turn; worth it for genuinely hard tasks.',
};
