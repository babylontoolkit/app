/**
 * What the current project was seeded from (SPEC §4.4a).
 *
 * "The seed is visible and reversible": the chat header shows *"Started from: Racing — change"*, and
 * changing re-seeds from a different entry. Reversibility is only meaningful before the first
 * generation lands — after that there is something to lose — so `canChange` closes as soon as the
 * project has been built on.
 */
import { atom } from 'nanostores';
import type { GameRegistryEntry } from '~/types/game-registry';

export interface ProjectSeed {
  entry: GameRegistryEntry;

  /** The project's own GameMode class (§4.4b). */
  className: string;

  title: string;

  /** The prompt that was seeded, so re-seeding can re-run it against a different entry. */
  prompt?: string;

  /** Keywords that fired, for the chip's tooltip — the seed should never feel like magic. */
  matched?: string[];
}

export const projectSeedStore = atom<ProjectSeed | null>(null);

export function setProjectSeed(seed: ProjectSeed | null) {
  projectSeedStore.set(seed);
}
