/**
 * The game registry (SPEC §4.4).
 *
 * Genres are registry DATA, not repos: there is ONE starter (`babylontoolkit/StarterAssets`), and a
 * genre is a row that names which demo class to copy out of its read-only library. Adding a genre is
 * adding a row — never a new repo, never a new snapshot pipeline.
 *
 * Field names are snake_case because these rows become a Supabase table verbatim in Stage 3. Keeping
 * the shape identical now means the swap is a store implementation, not a refactor of every caller.
 */
export interface GameRegistryEntry {
  /** Stable id (`gm_racing_v1`) — referenced by `wizard.json` and, later, by project rows. */
  id: string;

  /** Card title shown to the user ("Arcade Racing"). */
  title: string;

  genre: string;

  /** Card copy — written for non-developers, no class names (spec/wizard-config.md). */
  description: string;

  /**
   * The file in `src/babylon/classes/` to COPY (§4.4b). NEVER the class the project runs: the
   * project's GameMode is the renamed copy in `src/scripts/`. The library stays pristine.
   */
  source_class: string;

  /** Optional scene the framework preloads before the mode runs (Unreal-style). */
  scene_url?: string;

  /** Powers Path A prompt seeding (§4.4a). Lowercase; matched as whole words. */
  match_keywords: string[];

  thumbnail_url?: string;

  /** Icon class for the card (UnoCSS `i-ph:*`) — a thumbnail stand-in until art exists. */
  icon?: string;

  /** Ties a row to its `wizard.json` genre block. */
  wizard_config_ref?: string;

  toolkit_version?: string;

  is_active: boolean;

  /**
   * The fallback row (Blank Canvas). Exactly one entry carries this: it is what a specific prompt
   * with no genre match seeds from, so that we never block on ambiguity when intent is clear.
   * It must never win a keyword match on its own.
   */
  is_fallback?: boolean;
}
