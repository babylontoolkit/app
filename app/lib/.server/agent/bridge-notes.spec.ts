/**
 * Per-turn Unity Bridge notes (§4.17, D37) — pure. The placement (after the last cache breakpoint) is
 * the proxy's; `cache-breakpoints.spec.ts` covers the breakpoint budget.
 */
import { describe, expect, it } from 'vitest';
import type { BridgeHello } from '~/lib/bridge/protocol';
import { bridgeTurnNotes, scriptsStateLine } from './bridge-notes';

const hello = (overrides: Partial<BridgeHello> = {}): BridgeHello => ({
  protocol: 2,
  helperVersion: '1.0.0',
  os: 'darwin',
  projectsDir: 'Unity',
  unityProjects: [
    { key: 'k1', name: 'Racer', unityVersion: '6000.0.30f1', toolkitVersion: '9.28.0' },
    { key: 'k2', name: 'Kart', unityVersion: '6000.0.30f1', toolkitVersion: '9.29.0' },
  ],
  unityCli: { path: '/u', version: '1.4.0' },
  scriptsDisabledLocally: false,
  ...overrides,
});

describe('the scripts state (D58)', () => {
  const online = (allowScripts: boolean | undefined, scriptsDisabledLocally = false) =>
    bridgeTurnNotes({
      bridgeTurn: {
        state: 'online',
        device: { name: 'Studio Mac', allowScripts },
        hello: hello({ scriptsDisabledLocally }),
      },
      finishedJobs: [],
    })[0];

  it('switch on → "Scripts: on."', () => {
    expect(online(true)).toContain(' Scripts: on. ');
  });

  it('switch off → off, naming the dialog switch — never a command; ABSENT is on (the D58 default, as dispatched)', () => {
    const off = 'Scripts: off — the user can turn on Allow scripts in the Unity Bridge dialog (the cube icon).';

    expect(online(false)).toContain(off);
    expect(online(undefined)).toContain(' Scripts: on. ');
    expect(online(undefined)).not.toContain(off);
    expect(online(false)).not.toMatch(/npx|bt-agent|--/);
  });

  it('--no-scripts on the helper → disabled on this computer, and it wins over an ON switch', () => {
    const disabled =
      'Scripts are disabled on this computer (--no-scripts) — the Allow scripts switch has no effect; the user must re-run the install command from the Unity Bridge dialog without --no-scripts.';

    expect(online(true, true)).toContain(disabled);
    expect(online(false, true)).toContain(disabled);
    expect(online(true, true)).not.toContain('Scripts: on.');

    // the D58 slip: under --no-scripts the model must never be steered to the (already on, disabled) switch
    expect(online(true, true)).not.toMatch(/can turn on Allow scripts/);
  });

  it('online note tells the model to speak in plain words — no tool names or job ids (verifier item 10)', () => {
    expect(online(true)).toContain(
      'Speak to the user in plain words — never name these tools (unity_command, unity_project, …) or internal job ids in replies.',
    );
  });

  it('scriptsStateLine is the one wording (three states)', () => {
    expect(scriptsStateLine({ allowScripts: true }, { scriptsDisabledLocally: false })).toBe('Scripts: on.');

    // A device that never touched the switch is ON — the same reading the dispatch uses (D58 default).
    expect(scriptsStateLine({}, undefined)).toBe('Scripts: on.');
    expect(scriptsStateLine({ allowScripts: undefined }, undefined)).toBe('Scripts: on.');
    expect(scriptsStateLine({ allowScripts: false }, undefined)).toMatch(/^Scripts: off — /);
    expect(scriptsStateLine(undefined, { scriptsDisabledLocally: true })).toBe(
      'Scripts are disabled on this computer (--no-scripts) — the Allow scripts switch has no effect; the user must re-run the install command from the Unity Bridge dialog without --no-scripts.',
    );
  });
});

describe('bridgeTurnNotes', () => {
  it('offline → the one-line note naming the device', () => {
    const notes = bridgeTurnNotes({
      bridgeTurn: { state: 'offline', device: { name: 'Studio Mac' } },
      finishedJobs: [],
    });

    expect(notes).toHaveLength(1);
    expect(notes[0]).toBe(
      'Your computer "Studio Mac" is paired but the helper is not running. If the user asks for Unity or Blender work, tell them to open the Unity Bridge dialog (the cube icon in the chat box) and run the install command it shows. Never claim to have run a Unity or Blender command.',
    );
  });

  it('none and no local scene server → no notes', () => {
    expect(bridgeTurnNotes({ bridgeTurn: { state: 'none' }, finishedJobs: [] })).toEqual([]);
    expect(bridgeTurnNotes({ bridgeTurn: { state: 'disabled' }, finishedJobs: [] })).toEqual([]);
  });

  it('online → names the device, the projects folder, its projects, the current one and versions', () => {
    const [note] = bridgeTurnNotes({
      bridgeTurn: {
        state: 'online',
        device: { name: 'Studio Mac' },
        hello: hello({ currentProject: 'Kart', blender: { path: '/b', version: '4.2.0' } }),
      },
      finishedJobs: [],
    });

    expect(note).toBe(
      '# Unity Bridge\n\nConnected to "Studio Mac". Projects folder "Unity": Racer, Kart. Current project: "Kart". Unity CLI 1.4.0, Toolkit 9.29.0, Blender 4.2.0. Scripts: on. Paths are relative to the current Unity project. Speak to the user in plain words — never name these tools (unity_command, unity_project, …) or internal job ids in replies.',
    );
  });

  it('online with no current project → tells the model to open or create one', () => {
    const [note] = bridgeTurnNotes({
      bridgeTurn: { state: 'online', device: { name: 'Studio Mac' }, hello: hello({ unityCli: undefined }) },
      finishedJobs: [],
    });

    expect(note).toBe(
      '# Unity Bridge\n\nConnected to "Studio Mac". Projects folder "Unity": Racer, Kart. Current project: none — open or create one with unity_project. Unity CLI not found, Toolkit ?, Blender not found. Scripts: on. Paths are relative to the current Unity project. Speak to the user in plain words — never name these tools (unity_command, unity_project, …) or internal job ids in replies.',
    );
  });

  it('online → at most 20 project names, the rest counted; an empty folder says so', () => {
    const many = Array.from({ length: 23 }, (_, i) => ({ key: `k${i}`, name: `P${i}` }));
    const [note] = bridgeTurnNotes({
      bridgeTurn: { state: 'online', device: { name: 'Mac' }, hello: hello({ unityProjects: many }) },
      finishedJobs: [],
    });

    expect(note).toContain('P19 (and 3 more).');
    expect(note).not.toContain('P20');

    const [empty] = bridgeTurnNotes({
      bridgeTurn: { state: 'online', device: { name: 'Mac' }, hello: hello({ unityProjects: [] }) },
      finishedJobs: [],
    });

    expect(empty).toContain('Projects folder "Unity": no Unity projects yet.');
  });

  it('online with the helper dev server running → the local scene note carries its origin', () => {
    const notes = bridgeTurnNotes({
      bridgeTurn: {
        state: 'online',
        device: { name: 'Studio Mac' },
        hello: hello({ devServer: { running: true, origin: 'http://localhost:8888', scenes: ['Level.gltf'] } }),
      },
      finishedJobs: [],
    });

    const scene = notes.find((n) => n.startsWith('# Local scene server'));
    expect(scene).toContain('http://localhost:8888 serves exported scenes');
    expect(scene).toContain('Scenes: Level.gltf.');

    // D60 — scenes stay on the dev server / the user's hosting; never copied into the web project.
    expect(scene).toContain('NEVER copy exported scene files into the web project');
    expect(scene).toContain('ask for the URL where they host the exported scene folder');
    expect(scene).not.toContain('import_local_scene');
    expect(notes[0]).toContain('Blender not found');
  });

  it('no local scene note without a running helper dev server (D55 — the browser no longer supplies one)', () => {
    expect(bridgeTurnNotes({ bridgeTurn: { state: 'none' }, finishedJobs: [] })).toEqual([]);

    const stopped = bridgeTurnNotes({
      bridgeTurn: {
        state: 'online',
        device: { name: 'Studio Mac' },
        hello: hello({ devServer: { running: false, origin: 'http://localhost:8888' } }),
      },
      finishedJobs: [],
    });
    expect(stopped.some((n) => n.startsWith('# Local scene server'))).toBe(false);
  });

  it('finished jobs are listed by id', () => {
    const notes = bridgeTurnNotes({
      bridgeTurn: { state: 'offline', device: { name: 'Studio Mac' } },
      finishedJobs: [
        { id: 'brg_1', operation: 'unity_command bt_export_level', status: 'succeeded', resultText: 'Exported.' },
        { id: 'brg_2', operation: 'unity_command save_all', status: 'cancelled', error: 'not picked up' },
      ],
    });

    const jobs = notes.find((n) => n.startsWith('# Unity Bridge jobs finished since your last turn'))!;
    expect(jobs).toContain('- brg_1 unity_command bt_export_level: succeeded\n  Exported.');
    expect(jobs).toContain('- brg_2 unity_command save_all: cancelled — not picked up');
  });

  it('a 1000-char resultText is truncated to 400', () => {
    const [note] = bridgeTurnNotes({
      bridgeTurn: { state: 'none' },
      finishedJobs: [{ id: 'brg_1', operation: 'op', status: 'succeeded', resultText: 'y'.repeat(1000) }],
    });

    expect(note).toBe(`# Unity Bridge jobs finished since your last turn\n- brg_1 op: succeeded\n  ${'y'.repeat(400)}`);
  });
});
