/**
 * Guided Tour compile step (SPEC §4.7, spec/wizard-config.md).
 *
 * The wizard's whole purpose is keeping a non-developer's FIRST generation on well-trodden ground:
 * every checkbox compiles to a fragment naming the built-in Toolkit system that fulfils it, so the
 * model is pointed at the batteries-included path instead of inventing one. A checkbox that produces
 * broken code is worse than no checkbox — which is why `backing` is required on every mechanic and
 * why the config is validated rather than trusted.
 */
import wizardConfig from '~/config/wizard.json';
import type { GameRegistryEntry } from '~/types/game-registry';

export interface WizardMechanic {
  id: string;
  label: string;
  fragment: string;
  backing: string;

  /** Gate (e.g. `gameBackend`) — hidden until the requirement is met. */
  requires?: string;
}

export interface WizardVibe {
  id: string;
  label: string;
  description: string;
  fragment: string;
}

export interface WizardGenre {
  registryId: string;
  card: string;
  mechanics: WizardMechanic[];
}

export interface WizardConfig {
  version: number;
  preamble: string;
  vibes: WizardVibe[];
  crossGenre: WizardMechanic[];
  genres: WizardGenre[];
}

export const WIZARD_CONFIG = wizardConfig as unknown as WizardConfig;

export interface WizardSelection {
  entry: GameRegistryEntry;
  vibeId?: string;
  mechanicIds: string[];
  twist?: string;
}

/** Every mechanic offered for a genre: its own, plus the cross-genre toggles shown everywhere. */
export function mechanicsFor(registryId: string, config: WizardConfig = WIZARD_CONFIG): WizardMechanic[] {
  const genre = config.genres.find((entry) => entry.registryId === registryId);

  return [...(genre?.mechanics ?? []), ...config.crossGenre];
}

/**
 * Compile the four steps into the first user message.
 *
 * The user never sees this text — they see a friendly summary card. It is stored on the message so a
 * bad first generation can be traced back to the fragment that caused it.
 */
export function compileWizardPrompt(selection: WizardSelection, config: WizardConfig = WIZARD_CONFIG): string {
  const { entry, vibeId, mechanicIds, twist } = selection;

  const vibe = config.vibes.find((candidate) => candidate.id === vibeId);
  const available = mechanicsFor(entry.id, config);
  const chosen = mechanicIds
    .map((id) => available.find((mechanic) => mechanic.id === id))
    .filter((mechanic): mechanic is WizardMechanic => Boolean(mechanic));

  const parts = [config.preamble, '', `This is a ${entry.title.toLowerCase()} game.`];

  if (vibe) {
    parts.push('', vibe.fragment);
  }

  if (chosen.length > 0) {
    parts.push('', 'Features to build:', ...chosen.map((mechanic, index) => `${index + 1}. ${mechanic.fragment}`));
  }

  if (twist?.trim()) {
    parts.push('', `The twist that makes this game its own: ${twist.trim()}`);
  }

  return parts.join('\n');
}

/** The friendly summary shown in place of the compiled prompt. */
export function summarizeSelection(selection: WizardSelection, config: WizardConfig = WIZARD_CONFIG): string {
  const available = mechanicsFor(selection.entry.id, config);
  const labels = selection.mechanicIds
    .map((id) => available.find((mechanic) => mechanic.id === id)?.label)
    .filter(Boolean);

  const vibe = config.vibes.find((candidate) => candidate.id === selection.vibeId);

  return [
    selection.entry.title,
    vibe?.label,
    labels.length > 0 ? labels.join(', ') : undefined,
    selection.twist?.trim() ? `“${selection.twist.trim()}”` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Validate the config against the registry (spec/wizard-config.md: "validated at boot; ids unique,
 * registryIds exist in game_registry, fragments non-empty").
 *
 * Returns problems rather than throwing: a bad wizard config must never take down the New Project
 * screen, which has two other entry paths that do not depend on it.
 */
export function validateWizardConfig(config: WizardConfig, entries: GameRegistryEntry[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const genre of config.genres) {
    if (!entries.some((entry) => entry.id === genre.registryId)) {
      problems.push(`Genre "${genre.registryId}" has no matching game_registry entry.`);
    }

    for (const mechanic of genre.mechanics) {
      const key = `${genre.registryId}:${mechanic.id}`;

      if (seen.has(key)) {
        problems.push(`Duplicate mechanic id "${mechanic.id}" in ${genre.registryId}.`);
      }

      seen.add(key);

      if (!mechanic.fragment.trim()) {
        problems.push(`Mechanic "${mechanic.id}" has an empty fragment.`);
      }

      if (!mechanic.backing?.trim()) {
        problems.push(`Mechanic "${mechanic.id}" names no backing Toolkit system.`);
      }
    }
  }

  for (const vibe of config.vibes) {
    if (!vibe.fragment.trim()) {
      problems.push(`Vibe "${vibe.id}" has an empty fragment.`);
    }
  }

  return problems;
}
