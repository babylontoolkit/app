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

  /**
   * What the user actually TYPED, when that differs from `prompt`.
   *
   * They are the same on the typed-prompt path and absent on the card path. They diverge only for the
   * wizard (§4.7), where `prompt` is the compiled brief and this is the short text shown in its place.
   * Kept because creation no longer sends anything to a model: the prompt is carried into the chat
   * textbox for the user to edit, and what belongs in a textbox is the user's own words.
   */
  visiblePrompt?: string;

  /** Keywords that fired, for the chip's tooltip — the seed should never feel like magic. */
  matched?: string[];
}

export const projectSeedStore = atom<ProjectSeed | null>(null);

export function setProjectSeed(seed: ProjectSeed | null) {
  projectSeedStore.set(seed);
}
