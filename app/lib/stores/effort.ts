/**
 * The user's thinking effort (SPEC §4.2a, §4.2.9; `_specs/effort-selector_plan.md`) — the effort control.
 *
 * Thinking tokens bill as OUTPUT, at the full output rate (`spec/anthropic-models.md` §3.5), so this is
 * the one user-facing dial that moves the bill directly rather than through what gets built. Credits are
 * cost-proportional, so a deeper level bills the user more per turn; the platform's margin is unchanged.
 *
 * ## The levels (owner, 2026-10-02 — reverses the old "Medium or High only" rule)
 *
 *  - **`medium`** — the default, and there is nothing below it (`low` breached a read-only project zone
 *    when we measured it; it is not even representable in `EffortLevel`).
 *  - **`high`**, **`xhigh`** ("Extra high") — offered on every deploy.
 *  - **`max`** — offered only when the operator sets `ENABLE_MAX_EFFORT` (D11). The offered list arrives
 *    on `/api/me` (`sessionStore.effortLevels`), so the control shows 3 or 4 notches with no rebuild.
 *
 * ## It is PERSISTED per browser, like the model tier (D6)
 *
 * The old rule was "session-only, never persisted", because a raised level billed more on every turn
 * with NO visible signal that it was on. The control is now an always-visible pill in the composer row
 * showing its current value, so that reason is gone and the choice persists in `localStorage` like
 * `modelTierStore`. Two rules keep the stored value from ever asking for more than the user picked:
 *
 *  - **Unknown, corrupt or hand-edited → Medium.** Read through `parseUserEffort`, the same exact-match
 *    whitelist the server uses. Never clamp UP.
 *  - **A stored level this deploy does not offer → Medium**, never a step to the next level down. A
 *    stored `max` with Max switched off is Medium, not Extra high: inventing a level the user did not pick
 *    is the wrong direction either way, and Medium is the one level everyone chose by not choosing.
 *    Until `/api/me` answers, the default list (no Max) applies; once it answers, a stored choice the
 *    deploy does not offer is reset to Medium in storage too, so it cannot silently come back later.
 *
 * Authority still lives on the server: every turn's effort is re-validated with `parseUserEffort(raw,
 * offered)`, so a tampered store can only ever ask for a level the deploy offers.
 */
import { atom, computed } from 'nanostores';
import {
  DEFAULT_USER_EFFORT,
  USER_EFFORT_LEVELS,
  parseUserEffort,
  type EffortLevel,
  type UserEffortLevel,
} from '~/lib/modules/llm/capabilities';
import { sessionStore, type SessionState } from '~/lib/stores/session';

export type { UserEffortLevel };

/** The `localStorage` key for the persisted choice. */
export const EFFORT_STORAGE_KEY = 'bt_effort_level';

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // Storage disabled by policy, or a sandboxed frame: no persistence, never a crash.
    return null;
  }
}

/**
 * The persisted choice, validated against EVERY level the client knows. Whether this deploy offers it
 * is decided separately (`effectiveEffort`), because the offered list arrives asynchronously and a
 * stored `max` must survive until we know whether Max is on.
 */
export function readStoredEffort(storage: Storage | null = browserStorage()): UserEffortLevel {
  if (!storage) {
    return DEFAULT_USER_EFFORT;
  }

  let stored: string | null = null;

  try {
    stored = storage.getItem(EFFORT_STORAGE_KEY);
  } catch {
    return DEFAULT_USER_EFFORT;
  }

  if (stored === null) {
    return DEFAULT_USER_EFFORT;
  }

  // Accept a JSON-quoted value too (the `getStoredModelTier` rule): refusing a value the user plainly meant is a silent revert.
  let value: unknown = stored;

  if (stored.startsWith('"')) {
    try {
      value = JSON.parse(stored);
    } catch {
      value = undefined;
    }
  }

  return parseUserEffort(value, USER_EFFORT_LEVELS) ?? DEFAULT_USER_EFFORT;
}

function writeStoredEffort(level: UserEffortLevel, storage: Storage | null = browserStorage()): void {
  try {
    storage?.setItem(EFFORT_STORAGE_KEY, level);
  } catch {
    // Quota or policy: the choice still applies for this page; it just will not survive a reload.
  }
}

/** The effective level: the user's choice if this deploy offers it, otherwise the default (never a step down). */
export function effectiveEffort(chosen: UserEffortLevel, offered: readonly EffortLevel[]): UserEffortLevel {
  return parseUserEffort(chosen, offered) ?? DEFAULT_USER_EFFORT;
}

/** What the user picked (persisted). Read `baseEffortStore` for what a turn will actually ask for. */
const chosenEffortStore = atom<UserEffortLevel>(readStoredEffort());

/** The levels this deploy offers — from `/api/me`, the default list (no Max) until it answers. */
export const offeredEffortLevelsStore = computed(sessionStore, (session) => session.effortLevels);

/** The level every generation sends: the choice, filtered by what this deploy offers. */
export const baseEffortStore = computed([chosenEffortStore, offeredEffortLevelsStore], effectiveEffort);

/** `/effort`, the composer's effort pill and the `/context` effort row all open the picker. */
export const effortPanelOpen = atom<boolean>(false);

export function setBaseEffort(level: UserEffortLevel): void {
  chosenEffortStore.set(level);
  writeStoredEffort(level);
}

/**
 * Once `/api/me` has answered, a persisted choice this deploy does not offer is reset to the default —
 * in storage too, so Max switched off and later back on does not silently restore a Max the user is no
 * longer looking at. Skipped while loading or after a failed load: the fallback list is a guess, and
 * resetting a real choice on a guess would lose it.
 */
export function reconcileEffortWithSession(session: SessionState): void {
  if (session.loading || session.loadFailed) {
    return;
  }

  const chosen = chosenEffortStore.get();

  if (!session.effortLevels.includes(chosen)) {
    setBaseEffort(DEFAULT_USER_EFFORT);
  }
}

sessionStore.subscribe(reconcileEffortWithSession);

/** Human labels — one source, shared by the picker, the pill and `/context`. */
export const EFFORT_LABELS: Record<UserEffortLevel, string> = {
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/**
 * What each level buys, in the terms a user cares about (speed and credits) rather than API terms.
 * Honest about cost: deeper levels think longer, and thinking bills as output.
 */
export const EFFORT_DESCRIPTIONS: Record<UserEffortLevel, string> = {
  medium: 'Default. Fast and thorough for most changes.',
  high: 'Thinks longer before acting. Good for tricky features. Uses more credits per turn.',
  xhigh: 'For hard bugs and big systems. Slower, uses more credits per turn.',
  max: 'Deepest reasoning. Slowest, uses the most credits per turn.',
};
