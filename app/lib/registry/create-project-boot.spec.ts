/**
 * Creation on a PROJECT-SCOPED sandbox (SPEC §4.4b, §8, `spec/sandbox-codesandbox.md` §11 C1).
 *
 * `create-project.spec.ts` pins the WebContainer-shaped path (`SANDBOX_REQUIRES_PROJECT: false`)
 * where a boot needs nothing and the sentinel is never written. This is the other build, and it has
 * two orderings that are silent when they are wrong:
 *
 *   - the VM must be booted BEFORE the template is written, for the project that was just registered.
 *     On a server provider there is no filesystem until a sandbox exists, and booting "for nobody"
 *     means writing a starter into whichever VM answers.
 *   - the identity sentinel is stamped AFTER the mount lands. Writing it first would make the very
 *     first warm-boot check trivially pass on a sandbox whose mount then failed — a no-op that looks
 *     like it is working, which is the shape of failure the sentinel exists to catch.
 *
 * And one non-ordering rule: a sentinel that cannot be written must never fail a creation that has
 * already landed on disk. It is defense in depth, not a precondition.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameRegistryEntry } from '~/types/game-registry';
import type { TemplateFile } from '~/types/template';

const mountTemplate = vi.hoisted(() => vi.fn());
const clearInheritedDevServer = vi.hoisted(() => vi.fn());
const applyProjectHygiene = vi.hoisted(() => vi.fn());
const bootForProject = vi.hoisted(() => vi.fn());
const writeSandboxIdentity = vi.hoisted(() => vi.fn());

vi.mock('./mount', () => ({ mountTemplate, clearInheritedDevServer }));
vi.mock('./hygiene', () => ({ applyProjectHygiene }));

/* The seam, not the runtime — and this file's whole subject is the `true` branch of this flag. */
vi.mock('~/lib/sandbox', () => ({
  bootForProject,
  SANDBOX_REQUIRES_PROJECT: true,
  describeSandboxFailure: (error: unknown) =>
    (error as { name?: string })?.name === 'SandboxUnavailableError'
      ? { message: (error as Error).message, retryable: false }
      : undefined,
}));
vi.mock('~/lib/sandbox/identity', () => ({ writeSandboxIdentity }));

import { createProjectFromRegistry } from './create-project';

const ENTRY: GameRegistryEntry = {
  id: 'gm_racing_v1',
  title: 'Arcade Racing',
  genre: 'racing',
  description: 'Drive fast.',
  source_class: 'VehicleControllerDemo.ts',
  match_keywords: ['racing'],
  is_active: true,
};

function starterFiles(): TemplateFile[] {
  return [
    { name: 'package.json', path: 'package.json', content: '{"name":"starter"}' },
    {
      name: 'globals.ts',
      path: 'src/babylon/globals.ts',
      content: 'export async function InitializeRuntime() {\n await import("./classes/DefaultGameMode");\n}',
    },
    {
      name: 'VehicleControllerDemo.ts',
      path: 'src/babylon/classes/VehicleControllerDemo.ts',
      content: 'import GameManager from "../globals";\nexport class VehicleControllerDemo {}\n',
    },
  ];
}

const RUNTIME = { fs: {} };

beforeEach(() => {
  vi.clearAllMocks();
  mountTemplate.mockResolvedValue(undefined);
  clearInheritedDevServer.mockResolvedValue(undefined);
  bootForProject.mockResolvedValue(RUNTIME);
  writeSandboxIdentity.mockResolvedValue(undefined);
  applyProjectHygiene.mockImplementation((files: TemplateFile[]) => files);

  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => starterFiles() }));
});

describe('creation boots the sandbox for the project it was given', () => {
  it('boots with the project id, before anything is written', async () => {
    await createProjectFromRegistry({ entry: ENTRY, title: 'Kart Racer', projectId: 'prj_a' });

    expect(bootForProject).toHaveBeenCalledTimes(1);
    expect(bootForProject.mock.calls[0][0]).toBe('prj_a');
    expect(bootForProject.mock.invocationCallOrder[0]).toBeLessThan(mountTemplate.mock.invocationCallOrder[0]);
  });

  /*
   * 🔴 Read-then-write is the sentinel's only useful order, one page over: stamping it before the
   * mount means the first warm resume verifies a sandbox whose files may never have arrived.
   */
  it('stamps the identity sentinel only after the template has landed', async () => {
    await createProjectFromRegistry({ entry: ENTRY, title: 'Kart Racer', projectId: 'prj_a' });

    expect(writeSandboxIdentity).toHaveBeenCalledWith(RUNTIME, 'prj_a');
    expect(writeSandboxIdentity.mock.invocationCallOrder[0]).toBeGreaterThan(mountTemplate.mock.invocationCallOrder[0]);
  });

  /** No sentinel for a mount that never happened — it would claim a project the disk does not hold. */
  it('does not stamp a sentinel when the mount fails', async () => {
    mountTemplate.mockRejectedValueOnce(new Error('disk full'));

    await expect(
      createProjectFromRegistry({ entry: ENTRY, title: 'Kart Racer', projectId: 'prj_a' }),
    ).rejects.toThrow();
    expect(writeSandboxIdentity).not.toHaveBeenCalled();
  });

  /*
   * A boot failure is FATAL and correctly attributed. The starter is downloaded and there is nowhere
   * to put it — a different problem, with a different operator fix, than a template that never
   * arrived, and the sandbox's own described message is what reaches the screen.
   */
  it('fails the creation with the sandbox’s own words when the boot dies', async () => {
    const error = new Error('Sandbox provider is not configured.');
    error.name = 'SandboxUnavailableError';
    bootForProject.mockRejectedValueOnce(error);

    await expect(createProjectFromRegistry({ entry: ENTRY, title: 'Kart Racer', projectId: 'prj_a' })).rejects.toThrow(
      'Sandbox provider is not configured.',
    );

    expect(mountTemplate).not.toHaveBeenCalled();
  });
});
