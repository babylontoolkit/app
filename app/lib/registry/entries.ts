/**
 * Reading the `game_registry` by id (SPEC §4.4).
 *
 * Its own module, and small on purpose: `create-project.ts` also holds the entries, but importing it
 * boots the sandbox seam — so a server module that wants nothing but a row would drag a WebContainer
 * boot into the agent proxy. The registry is DATA; reading it should cost a JSON import.
 */
import registryData from '~/config/game-registry.json';
import type { GameRegistryEntry } from '~/types/game-registry';

export const REGISTRY_ENTRIES = registryData.entries as GameRegistryEntry[];

/**
 * The entry a project was created from — `Project.templateId`, which is the row id.
 *
 * `null` for an id that names no row, which is an ordinary state rather than a defect: a project
 * created before a row was retired, or one made through a path that records no starter at all. Every
 * caller must render nothing in that case, never a guess — a project told it started from the wrong
 * starter gets a base scene that is not its own.
 */
export function findRegistryEntry(id: string | undefined | null): GameRegistryEntry | null {
  if (!id) {
    return null;
  }

  return REGISTRY_ENTRIES.find((entry) => entry.id === id) ?? null;
}
