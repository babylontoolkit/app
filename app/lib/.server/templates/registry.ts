/**
 * The game registry store (SPEC §4.4).
 *
 * An interface plus a static implementation, mirroring the prompt and skill stores: in Stage 3 the
 * rows move into a Supabase `game_registry` table and only `getGameRegistry()` changes. The row shape
 * is already the table shape (snake_case), so nothing downstream moves.
 */
import registryData from '~/config/game-registry.json';
import type { GameRegistryEntry } from '~/types/game-registry';

export interface GameRegistryStore {
  list(): Promise<GameRegistryEntry[]>;
  get(id: string): Promise<GameRegistryEntry | null>;
}

/** Reads the versioned JSON in `app/config/` — data, not code (SPEC §4.4: "genres are registry DATA"). */
export class StaticGameRegistry implements GameRegistryStore {
  #entries: GameRegistryEntry[];

  constructor(entries: GameRegistryEntry[] = registryData.entries as GameRegistryEntry[]) {
    this.#entries = entries;
  }

  async list(): Promise<GameRegistryEntry[]> {
    return this.#entries.filter((entry) => entry.is_active);
  }

  async get(id: string): Promise<GameRegistryEntry | null> {
    return this.#entries.find((entry) => entry.id === id && entry.is_active) ?? null;
  }
}

let store: GameRegistryStore = new StaticGameRegistry();

export function getGameRegistry(): GameRegistryStore {
  return store;
}

/** Test seam / Stage 3 swap point. */
export function setGameRegistry(next: GameRegistryStore) {
  store = next;
}
