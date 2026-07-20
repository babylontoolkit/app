/**
 * New Project creation (SPEC §4.4 / §4.4b / §4.4c) — every entry path ends here.
 *
 * The division of labour is deliberate:
 *
 *   **This code** does everything that must be RIGHT: mounting the starter, project hygiene, copying
 *   the registry entry's `source_class` into `src/scripts/`, renaming the class and its registration
 *   string, re-basing its imports, and adding it to `globals.ts` so it actually registers. None of it
 *   is left to the model, because every one of these failures is silent — the project compiles and
 *   then dead-ends.
 *
 *   **The model** does everything that must be GOOD: the landing page designed for this game, and the
 *   user's actual request. It gets a mounted, registered, running project to start from.
 */
import registryData from '~/config/game-registry.json';
import type { GameRegistryEntry } from '~/types/game-registry';
import type { TemplateFile } from '~/types/template';
import { WORK_DIR } from '~/utils/constants';
import { createScopedLogger } from '~/utils/logger';
import { applyProjectHygiene } from './hygiene';
import { mountTemplate } from './mount';
import { CREATION_BRIEF_MARKER } from '~/types/creation';
import {
  CLASS_LIBRARY_DIR,
  GLOBALS_PATH,
  RESERVED_CLASS_NAMES,
  deriveClassName,
  registerGameModeInGlobals,
  scaffoldGameMode,
} from './scaffold';

const logger = createScopedLogger('CreateProject');

/** The ONE universal starter (SPEC §4.4) — there are no per-genre repos. */
export const STARTER_REPO = registryData.starter_repo;

export interface CreatedProject {
  /** The assistant turn that mounts the files — replayed into the chat as a completed artifact. */
  assistantMessage: string;

  /** The hidden user turn that briefs the model on what it must now build. */
  userMessage: string;

  /** The project's starting GameMode class (§4.4b) — the seed, not a limit: any registered mode is launchable. */
  className: string;

  /**
   * Store paths the caller MUST `waitForMountVisible` on before generating (§4.2.8).
   *
   * Not a suggestion: skipping it means the model is handed a half-mounted project and writes the game
   * without ever seeing it.
   */
  mustBeVisible: string[];
}

async function fetchStarterFiles(): Promise<TemplateFile[]> {
  const response = await fetch(`/api/github-template?repo=${encodeURIComponent(STARTER_REPO)}`);

  if (!response.ok) {
    throw new Error(`Could not fetch the starter template (${response.status}).`);
  }

  return (await response.json()) as TemplateFile[];
}

/**
 * The images the project actually has on disk.
 *
 * Handed to the model explicitly because the alternative is it GUESSING an asset path — the exact
 * cause of the "Failed to resolve import" blank preview in Phase 1 (§4.4c). It may import any of
 * these or none of them; it may never import anything else.
 */
function listAvailableImages(files: TemplateFile[]): string[] {
  return files
    .filter(
      (file) =>
        file.isBinary && /^(src\/assets|public)\//.test(file.path) && /\.(png|jpe?g|svg|webp)$/i.test(file.path),
    )
    .map((file) => file.path)
    .sort();
}

/**
 * Create a project from a registry entry.
 *
 * `prompt` is the user's own words (Path A) or the wizard's compiled brief (Path C); on the card path
 * (Path B) there is none, and the model is told to build the landing page and stop.
 */
export async function createProjectFromRegistry(options: {
  entry: GameRegistryEntry;
  title: string;
  prompt?: string;
}): Promise<CreatedProject> {
  const { entry, title, prompt } = options;

  const files = applyProjectHygiene(await fetchStarterFiles(), { projectTitle: title });

  const className = deriveClassName(title, RESERVED_CLASS_NAMES);

  // ---- §4.4b: copy the demo out of the read-only library, rename it, register it ----

  const sourcePath = `${CLASS_LIBRARY_DIR}/${entry.source_class}`;
  const source = files.find((file) => file.path === sourcePath);

  if (!source) {
    throw new Error(`Registry entry "${entry.id}" names ${sourcePath}, which is not in the starter template.`);
  }

  const gameMode = scaffoldGameMode({
    sourceClassFile: entry.source_class,
    sourceContent: source.content,
    className,
  });

  const globals = files.find((file) => file.path === GLOBALS_PATH);

  if (!globals) {
    throw new Error(`The starter template is missing ${GLOBALS_PATH} — the GameMode could never register.`);
  }

  globals.content = registerGameModeInGlobals(globals.content, className);

  /*
   * The library file itself is NEVER touched — it stays pristine as a clean source for every future
   * copy, and as read-only reference material for the model (§4.4b step 5).
   */
  const projectFiles = [...files, { name: `${className}.ts`, path: gameMode.path, content: gameMode.content }];

  /*
   * ---- the artifact carries NO file bodies (SPEC §4.2.8) ----
   *
   * The artifact is a channel to the MODEL that happens to write files. Inlining the starter into it
   * sent every file to the model TWICE — once here, in an assistant message that then rides in the
   * history FOREVER, and again in the `# Current Project Files` context the agent proxy builds from
   * the file map on every turn. The starter is 258KB of text (~70k tokens), and the tool loop re-sends
   * the prefix on each of its steps: the measured cost of one "make me a kart racer" was 997,775
   * uncached prompt tokens.
   *
   * So the whole project — binary AND text — is mounted straight into the WebContainer in ONE atomic
   * `container.mount(tree)` (`mountTemplate`), and the artifact carries only the two shell actions. The
   * filesystem is the filesystem; the file map (which the watcher populates from this mount) is the
   * single representation the model ever sees. Atomic and awaited here, so the whole project is on disk
   * — verified — before `npm install` runs, with no per-file boot race (see `mount-tree.ts`).
   */
  await mountTemplate(projectFiles);

  const binaryCount = projectFiles.filter((file) => file.isBinary).length;

  logger.info(
    `Seeded "${title}" from ${entry.id} → ${className} ` +
      `(${projectFiles.length - binaryCount} text, ${binaryCount} binary, 0 inlined)`,
  );

  const assistantMessage = `Setting up your project from the ${entry.title} starter.

<boltArtifact id="project-setup" title="${title}" type="bundled">
<boltAction type="shell">npm install</boltAction>
<boltAction type="start">npm run dev</boltAction>
</boltArtifact>`;

  return {
    assistantMessage,
    userMessage: buildCreationBrief({ entry, title, className, prompt, images: listAvailableImages(projectFiles) }),
    className,

    /*
     * 🔴 The files the caller must see IN THE STORE before it may generate (§4.2.8) — see
     * `waitForMountVisible`, and DO NOT move the wait back in here.
     *
     * The writes above put the bytes on disk. The model reads `workbenchStore.files`, which a watcher
     * fills asynchronously, so creation used to fire the generation 126ms early and send SEVEN files
     * instead of 78 — no scaffolded GameMode, no `classes/`, no `globals.ts`.
     *
     * The wait belongs at the END of the caller's sequence, not here, because the caller ALSO sets
     * state the request needs (`projectId`, from the server registration that happens after this
     * returns) and the AI SDK reads its body from a ref refreshed in a `useEffect` — i.e. only from
     * COMMITTED renders. Waiting here fixed the files and left `projectId` undefined on every
     * creation, which is the same bug wearing a different hat. One wait, after everything.
     *
     * Sentinels rather than a count: a count is a guess about a number that moves when the template
     * does, while these are exactly what §4.4b just produced or edited — and the one whose absence the
     * owner reported ("the ai does not see KartRacerMode").
     */
    mustBeVisible: [`${WORK_DIR}/${gameMode.path}`, `${WORK_DIR}/${GLOBALS_PATH}`, `${WORK_DIR}/${sourcePath}`],
  };
}

/**
 * The hidden first user message: what the model must know that it cannot see from the files alone.
 *
 * Kept short on purpose. The Hard Constraints (file zones, play contract, bundle integrity, the
 * landing-page rewrite rule) already live in the CACHED system prompt (§4.2) — repeating them here
 * would pay full input rates on every project creation to say what the model has already been told.
 * This message carries only the per-project FACTS: the class, the scene, the images, the request.
 */
function buildCreationBrief(options: {
  entry: GameRegistryEntry;
  title: string;
  className: string;
  prompt?: string;
  images: string[];
}): string {
  const { entry, title, className, prompt, images } = options;

  const play = entry.scene_url
    ? `navigate('/play', { gameMode: '${className}', sceneUrl: '${entry.scene_url}' })`
    : `navigate('/play', { gameMode: '${className}' })`;

  /*
   * The opening sentence is a CONTRACT, not prose: the agent proxy matches `CREATION_BRIEF_MARKER` to
   * recognise a creation turn and run it without tools (§4.2). Change the wording here and you must
   * change the constant — otherwise creation silently regresses to the slow, six-tool-round path.
   */
  return `${CREATION_BRIEF_MARKER} Do not re-create it.

**This project**
- Title: ${title}
- Seeded from: ${entry.title} (${entry.genre})
- Its starting GameMode is \`${className}\`, already copied to \`src/scripts/${className}.ts\`, renamed, and registered. Launch it first — and freely add more GameModes in \`src/scripts/\` later; any registered GameMode class may be launched through the play contract.
- Launch it with: \`${play}\`
${entry.scene_url ? '' : '- This genre has no preload scene; the GameMode builds its own content.\n'}
**Images on disk** (import from these or none — never invent an asset path):
${images.map((path) => `- ${path}`).join('\n')}

**Built-in media generation — use it to make this design beautiful.** You have \`generate_image\` and \`generate_video\` tools available on this turn (if they are absent from your tool list, skip this section and design with CSS + the images on disk). Be creative: generate any bespoke art you need to give *${title}* a frontend that matches the shape and mood of the game — a hero background, a logo/wordmark, splash art, texture accents for the chrome (16:9 for wide heroes and splash, 1:1 for badges/logos; png when you need alpha). If the design truly benefits, ONE short looping hero video clip is allowed — video costs the user hundreds of credits, so use it sparingly and never more than one. Rules:
- The \`generate_*\` tools are the ONLY tools this turn. \`<boltArtifact>\` / \`<boltAction>\` are plain-text tags you write in your reply — NEVER call them as tools.
- Make ALL your generate calls FIRST, in ONE parallel round, BEFORE writing any files. Each call returns the asset's project path immediately; the render lands in the background — do not wait or poll.
- The returned paths (under \`public/assets/generated/\`) are the ONE exception to "never invent an asset path": reference them in your code exactly as returned (as \`/assets/generated/…\` URLs) and they will appear.
- Design every surface to look finished while a render is still landing: a styled background color/gradient behind each generated image, never a blank box.

**Your task now**
1. Design the complete frontend shell for *${title}* by following the **bt-landing skill** (pre-loaded in your Skills) EXACTLY, using the facts above (GameMode class, play contract, images) as its Step-0 inputs: the landing page (\`src/pages/Home.tsx\` + \`Home.css\`, rewritten completely, full-page-width per the Layout law) AND the game chrome in \`src/custom/**\` (preloader, splash, overlay — redesigned to the same theme, never derived from the default splash, lightweight, wiring preserved). If the bt-landing skill is absent from your Skills, follow the same rules from the system prompt's "Layout law" and "Chrome rewrites" sections instead.
2. ${
    prompt
      ? `Then build what the user asked for:\n\n> ${prompt}`
      : `That is all for now — the user has not asked for anything else yet.`
  }

When you are done, suggest two or three concrete next steps (a new game mode, a menu, a mechanic).`;
}
