/**
 * 🔴 THE STARTER GAME TYPE REACHES THE MODEL (owner, 2026-08-14).
 *
 * *"They are just influenced by the game card info, like what source to copy as the game mode script
 * and what (if any) is the base scene url to load."*
 *
 * Half of that was already true and half of it had never been built. `source_class` is COPIED at
 * creation — renamed, re-based and registered in `globals.ts` — so it reaches the project as code and
 * the model finds it by reading `src/scripts/`. `scene_url` reached nothing: it was declared on
 * `GameRegistryEntry`, set on three rows, and read by no code and no prompt anywhere in the repo. A
 * base scene cannot influence a build nobody tells about it, so picking a card decided the controller
 * and never the world it ran in.
 *
 * SPEC §4.4b step 4 has said *"wire the app's navigation `gameMode` to `<ProjectClassName>` (+
 * `sceneUrl` if the entry defines one)"* since the registry was designed. Step 4 was the one step of
 * that pipeline never written.
 *
 * ## Why a note and not code
 *
 * The scene URL is an argument to a `navigate('/play', …)` call that the model WRITES and then rewrites
 * — the front-end phase authors it, and any later landing-page pass replaces the file it lives in. So
 * baking it into a file at creation buys one build and loses it on the next redesign, while a fact in
 * context is true on every turn that could rewrite the call.
 *
 * It also must not become an import. `src/scripts/` is game code, `src/pages/` is UI, and UI importing
 * game code drags the whole Babylon runtime into the main bundle — the one thing the play contract
 * exists to prevent. A string the model inlines has no such edge.
 *
 * ## Placement
 *
 * The VOLATILE TAIL, past the last cache breakpoint — the same rule as `discussNote` and
 * `creationPhaseNote`. It is per-project rather than per-turn, so it would survive a breakpoint
 * happily; it sits in the tail anyway because it is small and because a note that changes when the
 * project changes has no business sitting in front of a 110k-token file-context entry.
 */
import type { GameRegistryEntry } from '~/types/game-registry';

export interface StarterGameType {
  /** The card's title — "Arcade Racing". What the user picked, in their words. */
  title: string;

  /** The library file COPIED into `src/scripts/` at creation (§4.4b). Already on disk. */
  sourceClass: string;

  /** The base scene the play contract preloads, when the row defines one. */
  sceneUrl?: string;
}

/** Narrow a registry row to the three facts a build needs. */
export function starterGameTypeFrom(entry: GameRegistryEntry | null | undefined): StarterGameType | null {
  if (!entry) {
    return null;
  }

  return {
    title: entry.title,
    sourceClass: entry.source_class,
    ...(entry.scene_url ? { sceneUrl: entry.scene_url } : {}),
  };
}

/**
 * What this project's starter game type decided, as a system note.
 *
 * 🔴 **The two branches are the whole point, and the ABSENT one is not a smaller version of the
 * present one.** *"If the card does not have a scene_url then don't pass anything for it in the
 * navigate."* A `sceneUrl: undefined` left in the call, or an invented URL standing in for a scene the
 * starter does not have, both produce a `/play` route that resolves nothing — so the no-scene branch
 * says plainly to omit the key and build the world in code.
 */
export function starterGameTypeNote(starter: StarterGameType | null | undefined): string | null {
  if (!starter) {
    return null;
  }

  const lines = [
    `# This project's starter game type: ${starter.title}`,
    '',
    `Its GameMode was scaffolded for you at creation from \`${starter.sourceClass}\` — copied into ` +
      '`src/scripts/`, renamed, and registered in `globals.ts`. It is already on disk and already ' +
      'registered. Read that file for its REAL class name and navigate to that name; never invent one, ' +
      'and never point the play contract at the library class it was copied from.',
    '',
  ];

  if (starter.sceneUrl) {
    lines.push(
      `This starter loads a base scene: \`${starter.sceneUrl}\`. Pass it as \`sceneUrl\` through the ` +
        'play contract, alongside the mode:',
      '',
      '```ts',
      `navigate('/play', { gameMode: '<TheScaffoldedClassName>', sceneUrl: '${starter.sceneUrl}' });`,
      '```',
      '',

      /*
       * The baked prompt says, in bold, that the playground models and scenes the reference docs teach
       * with are examples and never a default — and this URL may well be one of them. That rule is
       * about a doc DEMONSTRATING an API with a Mustang; this is a scene the operator configured on
       * the starter the user chose. Without the distinction stated the model reads the two as the same
       * instruction and drops a scene it was deliberately given, which is the failure that looks most
       * like the feature simply not working.
       */
      'This scene is configured on the starter the user picked, so the "demo assets are an example, ' +
        'never a default" rule does not apply to it — that rule is about the models and levels the ' +
        "reference documents teach APIs with. Build the game's own content on top of this scene.",
    );
  } else {
    lines.push(
      'This starter loads NO base scene. Call the play contract with `gameMode` only — omit `sceneUrl` ' +
        'entirely rather than passing an empty or invented one — and build the world in code.',
      '',
      '```ts',
      "navigate('/play', { gameMode: '<TheScaffoldedClassName>' });",
      '```',
    );
  }

  return lines.join('\n');
}
