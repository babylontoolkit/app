/**
 * Creation is UNCONDITIONAL (SPEC §4.4, owner rule 2026-07-22).
 *
 * The rule these tests pin: **the project gets created first and foremost, and only two things may
 * ever stop it** — no starter fetched, or a mount that did not land. Everything else in
 * `createProjectFromRegistry` is a head start, not the project. A registry row that names a class the
 * template no longer ships, or a hygiene pass that throws, must still leave the user with a mounted,
 * runnable project, because a project that exists is one prompt away from correct and a refused
 * creation is not recoverable at all.
 *
 * The second half matters as much as the first and is easier to get wrong: a degraded creation must
 * TELL THE MODEL IT IS DEGRADED. Mounting the template while the brief still claims the GameMode is
 * "already copied, renamed and registered" trades a loud failure for a silent one — the model builds
 * against a class that does not exist and the project compiles, boots, and dead-ends at a blank
 * `/play`, which is the exact failure §4.4b exists to prevent. So every assertion about "it still
 * creates" is paired with one about what the brief says.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GameRegistryEntry } from '~/types/game-registry';
import type { TemplateFile } from '~/types/template';

const mountTemplate = vi.hoisted(() => vi.fn());
const clearInheritedDevServer = vi.hoisted(() => vi.fn());
const applyProjectHygiene = vi.hoisted(() => vi.fn());
const bootForProject = vi.hoisted(() => vi.fn());
const writeSandboxIdentity = vi.hoisted(() => vi.fn());

vi.mock('./mount', () => ({ mountTemplate, clearInheritedDevServer }));
vi.mock('./hygiene', () => ({ applyProjectHygiene }));

/*
 * The seam, not the runtime. Creation now BOOTS the sandbox for the project it was given (a
 * server-backed VM belongs to a project, so there is nothing to boot until one exists) — importing the
 * real module here would evaluate a provider and hang on a runtime that cannot exist in a test.
 * `SANDBOX_REQUIRES_PROJECT: false` keeps these tests on the WebContainer-shaped path they describe;
 * the project-scoped behaviour is pinned in `create-project-boot.spec.ts`.
 */
vi.mock('~/lib/sandbox', () => ({
  bootForProject,
  SANDBOX_REQUIRES_PROJECT: false,
  describeSandboxFailure: () => undefined,
}));
vi.mock('~/lib/sandbox/identity', () => ({ writeSandboxIdentity }));

import { createProjectFromRegistry } from './create-project';
import { bootProgress } from '~/lib/stores/boot-progress';
import { CREATION_BRIEF_MARKER } from '~/types/creation';

const ENTRY: GameRegistryEntry = {
  id: 'gm_racing_v1',
  title: 'Arcade Racing',
  genre: 'racing',
  description: 'Drive fast.',
  source_class: 'VehicleControllerDemo.ts',
  match_keywords: ['racing'],
  is_active: true,
};

/** A starter reduced to the files §4.4b actually reads — enough to scaffold, small enough to read. */
function starterFiles(): TemplateFile[] {
  return [
    { name: 'package.json', path: 'package.json', content: '{"name":"starter"}' },
    {
      name: 'globals.ts',
      path: 'src/babylon/globals.ts',
      content: [
        'export async function InitializeRuntime() {',
        '        await import("./classes/DefaultGameMode");',
        '}',
      ].join('\n'),
    },
    {
      name: 'VehicleControllerDemo.ts',
      path: 'src/babylon/classes/VehicleControllerDemo.ts',
      content: 'import GameManager from "../globals";\nexport class VehicleControllerDemo {}\n',
    },
    { name: 'babylon.png', path: 'public/babylon.png', content: '', isBinary: true },
  ];
}

/** The files handed to `mountTemplate` — i.e. what actually reached the WebContainer. */
function mountedPaths(): string[] {
  return (mountTemplate.mock.calls[0][0] as TemplateFile[]).map((file) => file.path);
}

beforeEach(() => {
  vi.clearAllMocks();
  mountTemplate.mockResolvedValue(undefined);
  clearInheritedDevServer.mockResolvedValue(undefined);
  bootForProject.mockResolvedValue({ fs: {} });
  writeSandboxIdentity.mockResolvedValue(undefined);
  applyProjectHygiene.mockImplementation((files: TemplateFile[]) => files);

  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => starterFiles() }));
});

describe('createProjectFromRegistry — the project is created first and foremost', () => {
  it('scaffolds the GameMode and briefs the model that it is ready (the healthy path)', async () => {
    const created = await createProjectFromRegistry({ entry: ENTRY, title: 'Kart Racer' });

    expect(created.className).toBe('KartRacerMode');
    expect(mountedPaths()).toContain('src/scripts/KartRacerMode.ts');

    // The copy is registered, and the library original is left pristine (§4.4b step 5).
    const mounted = mountTemplate.mock.calls[0][0] as TemplateFile[];
    const globals = mounted.find((file) => file.path === 'src/babylon/globals.ts')!;
    const library = mounted.find((file) => file.path === 'src/babylon/classes/VehicleControllerDemo.ts')!;
    expect(globals.content).toContain('../scripts/KartRacerMode');
    expect(library.content).toContain('export class VehicleControllerDemo {}');

    expect(created.userMessage).toContain('already copied');
    expect(created.mustBeVisible.some((path) => path.endsWith('src/scripts/KartRacerMode.ts'))).toBe(true);
  });

  /*
   * A reused sandbox can wake with a previous session's dev server still holding 5173, and the
   * artifact's `npm run dev` then dies with "Port 5173 is already in use" (MEASURED live,
   * 2026-07-27). The clear must run BEFORE the mount, so the stale process never serves this
   * project's half-mounted files.
   */
  it('clears an inherited dev server BEFORE the template mounts', async () => {
    await createProjectFromRegistry({ entry: ENTRY, title: 'Kart Racer' });

    expect(clearInheritedDevServer).toHaveBeenCalledTimes(1);
    expect(clearInheritedDevServer.mock.invocationCallOrder[0]).toBeLessThan(mountTemplate.mock.invocationCallOrder[0]);
  });

  it('STILL CREATES THE PROJECT when the registry names a class the template does not ship', async () => {
    const created = await createProjectFromRegistry({
      entry: { ...ENTRY, source_class: 'DeletedDemo.ts' },
      title: 'Kart Racer',
    });

    // The whole template reached the container — that is the guarantee.
    expect(mountTemplate).toHaveBeenCalledTimes(1);
    expect(mountedPaths()).toContain('package.json');
    expect(mountedPaths()).toContain('src/babylon/globals.ts');

    // ...and nothing pretends the mode is there.
    expect(mountedPaths()).not.toContain('src/scripts/KartRacerMode.ts');
    expect(created.userMessage).not.toContain('already copied');
    expect(created.userMessage).toContain('has NOT been scaffolded');

    /*
     * The degraded brief must be ACTIONABLE, not just honest: the registration step is the one whose
     * omission is invisible until run time.
     */
    expect(created.userMessage).toContain('src/babylon/globals.ts');
  });

  it('does not wait on a GameMode it never wrote (a degraded creation would burn the whole timeout)', async () => {
    const created = await createProjectFromRegistry({
      entry: { ...ENTRY, source_class: 'DeletedDemo.ts' },
      title: 'Kart Racer',
    });

    expect(created.mustBeVisible.some((path) => path.includes('/src/scripts/'))).toBe(false);
    expect(created.mustBeVisible.length).toBeGreaterThan(0);
  });

  it('STILL CREATES THE PROJECT when globals.ts has moved and the mode cannot be registered', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => starterFiles().filter((file) => file.path !== 'src/babylon/globals.ts'),
      }),
    );

    const created = await createProjectFromRegistry({ entry: ENTRY, title: 'Kart Racer' });

    expect(mountTemplate).toHaveBeenCalledTimes(1);
    expect(created.userMessage).toContain('has NOT been scaffolded');
  });

  it('STILL CREATES THE PROJECT when project hygiene throws', async () => {
    applyProjectHygiene.mockImplementation(() => {
      throw new Error('pinBabylonDependencies exploded');
    });

    await createProjectFromRegistry({ entry: ENTRY, title: 'Kart Racer' });

    // Mounted unmodified rather than not at all — hygiene is polish, not the project.
    expect(mountTemplate).toHaveBeenCalledTimes(1);
    expect(mountedPaths()).toContain('package.json');
  });

  it('the creation artifact still carries no file bodies (§4.2.8)', async () => {
    const created = await createProjectFromRegistry({ entry: ENTRY, title: 'Kart Racer' });

    expect(created.assistantMessage).toContain('npm install');
    expect(created.assistantMessage).not.toContain('boltAction type="file"');
  });

  /*
   * The creation splash (`WorkspaceSplash`) narrates these phases; without them New Project is a
   * blank page with three dots for the whole starter-download + sandbox-boot + mount sequence.
   * The reset to `idle` deliberately does NOT happen here — `startProject` owns it in a `finally`,
   * so a phase left standing after this function returns is correct, not a leak.
   */
  it('narrates the creation phases in order, and never resets to idle itself', async () => {
    bootProgress.set({ step: 'idle' });

    const steps: string[] = [];
    const unsubscribe = bootProgress.subscribe((phase) => steps.push(phase.step));

    await createProjectFromRegistry({ entry: ENTRY, title: 'Kart Racer' });
    unsubscribe();

    const order = ['creating-starter', 'creating-workspace', 'creating-mount'].map((step) => steps.indexOf(step));
    expect(order.every((index) => index !== -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    // The caller owns the reset — the last phase this function set must still be standing.
    expect(bootProgress.get().step).toBe('creating-mount');
  });
});

/*
 * THE BRIEF IS THE FIRST BUILD TURN'S INSTRUCTIONS (§4.4c, T11).
 *
 * It is machine-written, the user never sees it, and it rides hidden on the most expensive turn in the
 * product — so every one of its failures is silent. Four properties are pinned here because each of them
 * breaks nothing, throws nothing, and simply produces a worse project:
 *
 *   - **The marker, verbatim.** `CREATION_BRIEF_MARKER` is how the server recognises a first build turn;
 *     ten protections hang off that one string (premium lock, skill preload, the bounded media-only tool
 *     loop, `requiresAction`, the liveness copy). Reword the opening sentence without moving the constant
 *     and creation silently regresses to the slow six-tool-round path.
 *   - **The play contract.** The one call gameplay is entered through (§4.4c). A model that has to guess
 *     it writes a project that compiles and dead-ends at a blank `/play`.
 *   - **The scaffolded-class facts.** The brief must describe the DISK. `src/scripts/<Class>.ts` was
 *     written by §4.4b; a brief that omits it hands the model a class it cannot see.
 *   - **BOTH branches of the landing/chrome decision.** The DEFAULT (build the whole frontend shell) and
 *     the EXCEPTION (a narrow request changes nothing else) only work as a pair: with only the default,
 *     "just add a rotating cube" destroys a landing page nobody asked it to touch; with only the
 *     exception, every game ships on the stock starter page.
 */
describe('the creation brief — what the first build turn is told', () => {
  const SCENE_ENTRY: GameRegistryEntry = { ...ENTRY, scene_url: 'scenes/track.gltf' };

  async function brief(entry: GameRegistryEntry = ENTRY, title = 'Kart Racer'): Promise<string> {
    const created = await createProjectFromRegistry({ entry, title });
    return created.userMessage;
  }

  it('opens with CREATION_BRIEF_MARKER verbatim — the string the server sniffs for', async () => {
    const text = await brief();

    expect(text.startsWith(CREATION_BRIEF_MARKER)).toBe(true);
  });

  it('states the play contract exactly, with and without a preload scene', async () => {
    expect(await brief()).toContain("navigate('/play', { gameMode: 'KartRacerMode' })");

    const withScene = await brief(SCENE_ENTRY);
    expect(withScene).toContain("navigate('/play', { gameMode: 'KartRacerMode', sceneUrl: 'scenes/track.gltf' })");

    // The no-scene brief must SAY there is no scene, or the model invents one.
    expect(await brief()).toContain('no preload scene');
    expect(withScene).not.toContain('no preload scene');
  });

  it('states the scaffolded-class facts: the file on disk, the rename, the registration', async () => {
    const text = await brief();

    expect(text).toContain('`KartRacerMode`');
    expect(text).toContain('src/scripts/KartRacerMode.ts');
    expect(text).toContain('already copied');
    expect(text).toContain('registered');
  });

  it('lists the images actually on disk, and forbids inventing any other path', async () => {
    const text = await brief();

    expect(text).toContain('public/babylon.png');
    expect(text).toContain('never invent an asset path');
  });

  it('states the situation: a stock starter with nothing designed yet', async () => {
    const text = await brief();

    expect(text).toContain('stock starter template');
    expect(text).toMatch(/nothing in it has been designed or built yet/i);

    // The user's own message is the authority — the brief must never present itself as the request.
    expect(text).toMatch(/user's own message above is the request/i);
  });

  it('carries the DEFAULT branch — a game brief gets the landing page AND the src/chrome chrome', async () => {
    const text = await brief();

    expect(text).toMatch(/a game, an experience, or anything that implies a whole project/i);
    expect(text).toContain('DEFAULT');
    expect(text).toContain('bt-landing');
    expect(text).toContain('src/pages/Home.tsx');
    expect(text).toContain('src/chrome/**');
  });

  it('carries the EXCEPTION branch — a narrow request leaves the landing page and chrome alone', async () => {
    const text = await brief();

    expect(text).toMatch(/a single narrow change/i);
    expect(text).toMatch(/leave the landing page and the chrome alone/i);
  });

  /*
   * The two branches are only meaningful together. This is the assertion that fails if a future edit
   * "simplifies" the block down to whichever half it happened to be looking at.
   */
  it('states both branches, in that order — the default first, the exception after it', async () => {
    const text = await brief();

    const defaultAt = text.search(/a game, an experience, or anything that implies a whole project/i);
    const exceptionAt = text.search(/a single narrow change/i);

    expect(defaultAt).toBeGreaterThan(-1);
    expect(exceptionAt).toBeGreaterThan(defaultAt);
  });

  it('treats an empty request as the default rather than doing nothing', async () => {
    expect(await brief()).toMatch(/empty or says nothing about what to build/i);
  });

  /*
   * 🔴 THE BRIEF CARRIES NO COPY OF THE USER'S REQUEST (§4.4a).
   *
   * Creation contacts no model: the prompt goes back to the TEXTBOX, where the user may edit it before
   * sending. A copy taken at creation would therefore be a STALE second request sitting underneath the
   * real one, and the model would be asked to build two different games in one turn with no way to know
   * which is current. The `prompt` option was removed outright rather than ignored — a field nothing
   * reads is how a deleted system comes back.
   */
  it('contains no copy of the user request, even when one is forced through the options', async () => {
    const request = 'build me a neon cyberpunk hoverbike racer with a boost meter';

    const baseline = await brief();

    /*
     * The cast is the point: `prompt` is not part of the signature any more. Forcing it through proves
     * the removal is real — the brief is byte-identical, so nothing anywhere is still reading it.
     */
    const forced = await createProjectFromRegistry({
      entry: ENTRY,
      title: 'Kart Racer',
      prompt: request,
    } as unknown as Parameters<typeof createProjectFromRegistry>[0]);

    expect(forced.userMessage).toBe(baseline);
    expect(forced.userMessage).not.toContain(request);
    expect(forced.userMessage).not.toContain('hoverbike');
    expect(forced.assistantMessage).not.toContain(request);
  });
});

describe('createProjectFromRegistry — the two failures that ARE fatal', () => {
  it('refuses when the starter cannot be fetched (there is nothing to mount)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 502, statusText: 'Bad Gateway', json: async () => undefined }),
    );

    await expect(createProjectFromRegistry({ entry: ENTRY, title: 'Kart Racer' })).rejects.toThrow(/502/);
    expect(mountTemplate).not.toHaveBeenCalled();
  });

  it('reports an expired SESSION as itself, not as a template failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ message: 'Not signed in' }) }),
    );

    await expect(createProjectFromRegistry({ entry: ENTRY, title: 'Kart Racer' })).rejects.toThrow(/sign in/i);
  });

  it('reports a request that never completed as a connectivity failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(createProjectFromRegistry({ entry: ENTRY, title: 'Kart Racer' })).rejects.toThrow(
      /could not reach the server/i,
    );
    expect(mountTemplate).not.toHaveBeenCalled();
  });

  it('refuses an empty 200 rather than mounting nothing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] }));

    await expect(createProjectFromRegistry({ entry: ENTRY, title: 'Kart Racer' })).rejects.toThrow(/empty/i);
    expect(mountTemplate).not.toHaveBeenCalled();
  });

  it('refuses when the mount does not land — a half-written project must be LOUD', async () => {
    mountTemplate.mockRejectedValue(new Error('The starter template did not mount — the project would be empty.'));

    /*
     * Attributed to the WRITE (a different problem with a different fix than a failed download), with
     * `mountTemplate`'s own specific message preserved rather than flattened.
     */
    await expect(createProjectFromRegistry({ entry: ENTRY, title: 'Kart Racer' })).rejects.toThrow(
      /could not be written.*did not mount/is,
    );
  });
});
