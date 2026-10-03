/**
 * Which effort levels this DEPLOY offers its users (`_specs/effort-selector_plan.md` D11).
 *
 * `max` ships OFF behind `ENABLE_MAX_EFFORT`: every credit is user-backed, but the platform prepays the
 * provider, so the pool's drain RATE matters. Off (unset, or anything but `true`) → Medium · High · Extra
 * high; on → all four. The list is what the server validates a browser's effort against
 * (`parseUserEffort(raw, offered)`) — the client hiding the Max notch is a courtesy, never the wall — and
 * it reaches the client on `/api/me` so the control shows 3 or 4 notches with no rebuild.
 *
 * The operator's own defaults (`MANAGED_AGENT_EFFORT`, `THINKING_EFFORT`) may still name `max`; this
 * switch governs only what a USER may pick.
 */
import { env } from '~/lib/.server/env';
import { DEFAULT_OFFERED_EFFORT_LEVELS, type EffortLevel, USER_EFFORT_LEVELS } from '~/lib/modules/llm/capabilities';

/** True only for the exact value `true` (trimmed, case-insensitive). */
export function isMaxEffortEnabled(context: unknown): boolean {
  return env(context, 'ENABLE_MAX_EFFORT')?.trim().toLowerCase() === 'true';
}

/** The levels a user may pick on this deploy, in ascending order. */
export function offeredUserEffortLevels(context: unknown): readonly EffortLevel[] {
  return isMaxEffortEnabled(context) ? USER_EFFORT_LEVELS : DEFAULT_OFFERED_EFFORT_LEVELS;
}
