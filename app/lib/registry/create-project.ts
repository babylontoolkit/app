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
 *
 * 🔴 **CREATE IS UNCONDITIONAL (owner rule, 2026-07-22). The project gets created FIRST AND FOREMOST,
 * and nothing decorative may take it down with it.**
 *
 * Exactly TWO things in this function are allowed to fail a creation, because without either there is
 * no project at all: fetching the starter, and mounting it (verified on disk by `mountTemplate`'s
 * sentinel). Everything else — hygiene, the §4.4b copy-rename-register — is a HEAD START, not the
 * project. Each is a pure transform over an in-memory file list; if one throws we mount the template
 * without it and say so in the brief, because a mounted project with an unseeded GameMode is one
 * prompt away from correct, while a refused creation is not recoverable at all.
 *
 * 🔴 **THERE IS NO CREATION BRIEF (owner, 2026-08-08).** Creation used to build a machine-written
 * brief (`buildCreationBrief`) that rode hidden on the first build message. Retired: the baked system
 * prompt (`20-hard-constraints.md` — play contract, landing/chrome rewrite rules, Layout law) plus the
 * file context the model reads every turn proved more reliable than the brief layer, and the first
 * build turn is now an ordinary turn carrying only the user's own words. Do not reintroduce a hidden
 * machine message on the send path.
 */
import registryData from '~/config/game-registry.json';
import type { GameRegistryEntry } from '~/types/game-registry';
import type { TemplateFile } from '~/types/template';
import { WORK_DIR } from '~/utils/constants';
import { bootProgress } from '~/lib/stores/boot-progress';
import { bootForProject, describeSandboxFailure, SANDBOX_REQUIRES_PROJECT } from '~/lib/sandbox';
import { writeSandboxIdentity } from '~/lib/sandbox/identity';
import { createScopedLogger } from '~/utils/logger';
import { applyProjectHygiene } from './hygiene';
import { clearInheritedDevServer, mountTemplate } from './mount';
import {
  CreationError,
  describeMountFailure,
  describeSandboxBootFailure,
  describeStarterFetchFailure,
  describeStarterPayloadFailure,
  describeStarterTransportFailure,
} from './creation-errors';
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

/**
 * Get the starter's bytes into the browser — the first of the two steps that may fail a creation.
 *
 * ⚠️ **Despite the route's inherited name, this does NOT call GitHub.** Since §4.4 pin-and-cache the
 * starter is a SHA-addressed snapshot in object storage that an admin promotes; this is a request to
 * our OWN server, and only an un-pinned repo with no last-known-good snapshot falls through to GitHub.
 * So its failures are overwhelmingly session/server failures, and each is reported as itself rather
 * than as a generic "template" problem (`creation-errors.ts`).
 */
async function fetchStarterFiles(): Promise<TemplateFile[]> {
  let response: Response;

  try {
    response = await fetch(`/api/github-template?repo=${encodeURIComponent(STARTER_REPO)}`);
  } catch (error) {
    // The request never completed — offline, server restarted, proxy cut it. Not a template problem.
    throw new CreationError(describeStarterTransportFailure(error));
  }

  if (!response.ok) {
    /*
     * Read the body for the server's own reason before classifying. It may not be JSON at all (an HTML
     * error page from a proxy, or nothing mid-deploy), which is not itself an error worth surfacing —
     * the STATUS is still specific enough to act on.
     */
    const body = await response.json().catch(() => undefined);

    throw new CreationError(
      describeStarterFetchFailure({ status: response.status, statusText: response.statusText, body }),
    );
  }

  const files = await response.json().catch(() => undefined);

  if (!Array.isArray(files) || files.length === 0) {
    throw new CreationError(describeStarterPayloadFailure(files));
  }

  return files as TemplateFile[];
}

/**
 * Create a project from a registry entry.
 *
 * ⚠️ It takes NO prompt. Creation contacts no model, and the brief it returns deliberately carries no
 * copy of the user's request — the user edits and sends that themselves (§4.4a, `new-project-mode.ts`).
 * A `prompt` option here would be a field nothing reads, which is how a deleted system comes back.
 */
export async function createProjectFromRegistry(options: {
  entry: GameRegistryEntry;
  title: string;

  /**
   * The platform project this creation belongs to, when the server registration succeeded.
   *
   * Required in practice on a server-backed sandbox — that runtime has no VM to write into until a
   * project row names one — and genuinely optional on WebContainer, whose runtime is tab-local and
   * anonymous. The caller enforces which of those it is; this function just passes it to the boot.
   */
  projectId?: string;

  /**
   * Whether the user CHOSE this entry (card / wizard / blank-scene offer / re-seed) or it is merely
   * where a typed prompt lands now that genre inference is retired (`decideSeed`, §4.4a).
   *
   * It changes exactly one thing: whether the creation line names the starter. See `ProjectSeed`.
   */
  seedSource?: 'explicit' | 'inferred';
}): Promise<CreatedProject> {
  const { entry, title, projectId, seedSource = 'explicit' } = options;

  /*
   * The creation splash (`WorkspaceSplash`) narrates these phases — set as each await is reached, so
   * "New Project" is never a blank page with three dots. This function only ever moves the phase
   * FORWARD; the caller (`startProject`) owns the reset to `idle` on every exit, success or failure.
   */
  bootProgress.set({ step: 'creating-starter' });

  /*
   * The starter itself — the ONE fetch a creation cannot survive without. A throw here is correct and
   * fatal: there is nothing to mount.
   */
  const starter = await fetchStarterFiles();

  /*
   * Hygiene is a polish pass over an in-memory list (junk removal, dependency pinning, package name).
   * Losing it costs a tidier `package.json`; it does not cost the project, so it never fails one.
   */
  let files: TemplateFile[];

  try {
    files = applyProjectHygiene(starter, { projectTitle: title });
  } catch (error) {
    logger.error('Project hygiene failed — mounting the starter unmodified', error);
    files = starter;
  }

  const className = deriveClassName(title, RESERVED_CLASS_NAMES);

  // ---- §4.4b: copy the demo out of the read-only library, rename it, register it ----

  const sourcePath = `${CLASS_LIBRARY_DIR}/${entry.source_class}`;

  /*
   * Degradable by design (see the header). `scaffolded` is null when the registry entry and the
   * template disagree, or globals.ts has moved — a real defect worth fixing, but never a reason to
   * refuse someone a project. The brief reads this and changes what it asks the model to do.
   */
  let scaffolded: { path: string; content: string } | null = null;

  try {
    const source = files.find((file) => file.path === sourcePath);

    if (!source) {
      throw new Error(`Registry entry "${entry.id}" names ${sourcePath}, which is not in the starter template.`);
    }

    const globals = files.find((file) => file.path === GLOBALS_PATH);

    if (!globals) {
      throw new Error(`The starter template is missing ${GLOBALS_PATH} — the GameMode could never register.`);
    }

    const gameMode = scaffoldGameMode({
      sourceClassFile: entry.source_class,
      sourceContent: source.content,
      className,
    });

    /*
     * Registration is edited LAST: `registerGameModeInGlobals` mutates a file that is already in the
     * list, so doing it before the copy could leave globals.ts importing a module that was never
     * written if the copy then threw.
     */
    globals.content = registerGameModeInGlobals(globals.content, className);
    scaffolded = gameMode;
  } catch (error) {
    logger.error(
      `GameMode scaffolding failed for "${entry.id}" — creating the project anyway; the model will author it`,
      error,
    );
  }

  /*
   * The library file itself is NEVER touched — it stays pristine as a clean source for every future
   * copy, and as read-only reference material for the model (§4.4b step 5).
   */
  const projectFiles = scaffolded
    ? [...files, { name: `${className}.ts`, path: scaffolded.path, content: scaffolded.content }]
    : files;

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
  /*
   * A reused sandbox can wake with a PREVIOUS session's dev server still bound to 5173 (per-user VM
   * reuse, or a template snapshot taken while serving — see `clearInheritedDevServer`). Cleared
   * BEFORE the mount so the stale process never serves this project's files, and so the artifact's
   * `npm run dev` below cannot die with "Port 5173 is already in use" (MEASURED live, 2026-07-27).
   * Best-effort and awaited: bounded inside, and a failure logs rather than failing the creation.
   */
  /*
   * The `await sandbox` inside is where a server provider actually boots/forks the VM — the longest
   * single wait on this path, and the one that most needs a face.
   */
  bootProgress.set({ step: 'creating-workspace' });

  /*
   * 🔴 The boot is EXPLICIT and PER PROJECT, and it happens here rather than at module load.
   *
   * On a server-backed provider this is where the VM is forked or resumed for the project the caller
   * just registered — `~/lib/sandbox` cannot do it on its own, because at module-evaluation time
   * there is no project to do it for. A failure is fatal and correctly attributed: the starter is on
   * hand and there is nowhere to put it, which is a different problem with a different fix than a
   * template that never downloaded.
   */
  const runtime = await bootForProject(projectId).catch((error) => {
    throw new CreationError(describeSandboxBootFailure(describeSandboxFailure(error), error));
  });

  await clearInheritedDevServer();

  bootProgress.set({ step: 'creating-mount' });

  try {
    await mountTemplate(projectFiles);
  } catch (error) {
    /*
     * Fatal and LOUD, but attributed correctly: the bytes arrived and the WRITE failed, which is a
     * different problem with a different fix than a template that never downloaded. `mountTemplate`'s
     * own messages are specific (which file, or that the sentinel was missing) and are preserved.
     */
    throw new CreationError(describeMountFailure(error));
  }

  /*
   * Stamp whose project this sandbox now holds (`spec/sandbox-codesandbox.md` §11 C1). Written at
   * creation so the very first warm resume can be verified, and best-effort inside: a marker file is
   * defense in depth for the warm-boot gate, never a reason to fail a creation that has already
   * landed on disk.
   */
  if (projectId && SANDBOX_REQUIRES_PROJECT) {
    await writeSandboxIdentity(runtime, projectId);
  }

  const binaryCount = projectFiles.filter((file) => file.isBinary).length;

  logger.info(
    `Seeded "${title}" from ${entry.id} → ${className} ` +
      `(${projectFiles.length - binaryCount} text, ${binaryCount} binary, 0 inlined)`,
  );

  /*
   * 🔴 NAME THE STARTER ONLY WHEN THE USER PICKED IT (2026-08-04, reported live).
   *
   * On a card/wizard/blank-scene creation the entry title is a confirmation of a choice they made.
   * On a TYPED prompt it is not: `decideSeed` no longer guesses a genre, so every typed prompt seeds
   * the fallback row — and telling someone who asked for a twin-stick shooter that we are "setting up
   * your project from the Blank Canvas starter" reads as the product having thrown their words away,
   * when in fact those words are carried onto the handoff card and build the game on the next turn.
   */
  const assistantMessage = `${
    seedSource === 'inferred' ? 'Setting up your project.' : `Setting up your project from the ${entry.title} starter.`
  }

<boltArtifact id="project-setup" title="${title}" type="bundled">
<boltAction type="shell">npm install</boltAction>
<boltAction type="start">npm run dev</boltAction>
</boltArtifact>`;

  return {
    assistantMessage,
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
     *
     * Only ever files we KNOW we wrote: waiting on the scaffolded mode when scaffolding failed would
     * burn the full 15s timeout on every degraded creation and then log a false alarm about a partial
     * context, so a degraded creation waits on `globals.ts` alone.
     */
    mustBeVisible: scaffolded
      ? [`${WORK_DIR}/${scaffolded.path}`, `${WORK_DIR}/${GLOBALS_PATH}`, `${WORK_DIR}/${sourcePath}`]
      : [`${WORK_DIR}/${GLOBALS_PATH}`],
  };
}

// Mackey Kinard - Creation Brief: 2026-07-22
