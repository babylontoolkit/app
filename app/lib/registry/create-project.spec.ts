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

vi.mock('./mount', () => ({ mountTemplate, clearInheritedDevServer }));
vi.mock('./hygiene', () => ({ applyProjectHygiene }));

import { createProjectFromRegistry } from './create-project';
import { bootProgress } from '~/lib/stores/boot-progress';

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
  applyProjectHygiene.mockImplementation((files: TemplateFile[]) => files);

  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => starterFiles() }));
});

describe('createProjectFromRegistry — the project is created first and foremost', () => {
  it('scaffolds the GameMode and briefs the model that it is ready (the healthy path)', async () => {
    const created = await createProjectFromRegistry({ entry: ENTRY, title: 'Kart Racer', prompt: 'make me a racer' });

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
   * The creation splash (`CreationSplash`) narrates these phases; without them New Project is a
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
