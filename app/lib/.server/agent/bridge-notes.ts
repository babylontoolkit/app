/**
 * Per-turn Unity Bridge notes (SPEC §4.17, D37) — what the model is told about the user's machine this
 * turn: the paired device is online (its projects folder, the Unity projects in it, which one is current,
 * and what it runs) or offline, which bridge jobs finished since the last turn, and — from the helper's
 * own report only (D55; the browser no longer saves a dev-server origin) — which local scene server
 * serves exported scenes. There is no project link (D54) — the model opens or creates the Unity
 * project with `unity_project`.
 *
 * 🔴 PLACEMENT: the proxy pushes these AFTER the last cache breakpoint (immediately after the discuss
 * note). They change turn to turn — presence, job rows — so anywhere ahead of a breakpoint would
 * re-write a cached entry at the 2x cache-write rate every time a helper connects or a job finishes.
 *
 * They live here rather than in `buildProjectNotes` because they need per-turn SERVER state (presence
 * and the job rows) that `buildProjectNotes`'s pure inputs do not carry. Pure: no I/O.
 */
import type { BridgeHello } from '~/lib/bridge/protocol';

export interface BridgeTurnNotesInput {
  bridgeTurn: { state: 'none' | 'disabled' | 'offline' | 'online'; device?: { name: string }; hello?: BridgeHello };
  finishedJobs: Array<{ id: string; operation: string; status: string; resultText?: string; error?: string }>;
}

/** At most this many project names ride in the note; the rest are counted. */
const MAX_PROJECT_NAMES = 20;

function projectNames(hello: BridgeHello | undefined): string {
  const names = (hello?.unityProjects ?? []).map((project) => project.name);

  if (names.length === 0) {
    return 'no Unity projects yet';
  }

  const shown = names.slice(0, MAX_PROJECT_NAMES).join(', ');
  const more = names.length - MAX_PROJECT_NAMES;

  return more > 0 ? `${shown} (and ${more} more)` : shown;
}

export function bridgeTurnNotes(input: BridgeTurnNotesInput): string[] {
  const { bridgeTurn, finishedJobs } = input;
  const notes: string[] = [];
  const deviceName = bridgeTurn.device?.name ?? 'your computer';

  if (bridgeTurn.state === 'offline') {
    notes.push(
      `Your computer "${deviceName}" is paired but the helper is not running. If the user asks for Unity or Blender work, tell them to open the Unity Bridge dialog (the cube icon in the chat box) and run the install command it shows. Never claim to have run a Unity or Blender command.`,
    );
  }

  if (bridgeTurn.state === 'online') {
    const hello = bridgeTurn.hello;
    const current = hello?.currentProject;
    const currentInfo = current ? hello?.unityProjects.find((project) => project.name === current) : undefined;
    const currentText = current
      ? `Current project: "${current}".`
      : 'Current project: none — open or create one with unity_project.';
    const blender = hello?.blender;

    notes.push(
      `# Unity Bridge\n\nConnected to "${deviceName}". Projects folder "${hello?.projectsDir ?? '?'}": ${projectNames(hello)}. ${currentText} Unity CLI ${hello?.unityCli?.version ?? 'not found'}, Toolkit ${currentInfo?.toolkitVersion ?? '?'}, Blender ${blender ? blender.version : 'not found'}. Paths are relative to the current Unity project.`,
    );
  }

  if (finishedJobs.length) {
    const lines = finishedJobs.map(
      ({ id, operation, status, error, resultText }) =>
        `- ${id} ${operation}: ${status}${error ? ' — ' + error : ''}${resultText ? '\n  ' + resultText.slice(0, 400) : ''}`,
    );

    notes.push(`# Unity Bridge jobs finished since your last turn\n${lines.join('\n')}`);
  }

  // Only the helper's own report, while it is online and its dev server is running (D55).
  const helperServer = bridgeTurn.state === 'online' ? bridgeTurn.hello?.devServer : undefined;
  const server =
    helperServer?.running && helperServer.origin
      ? { origin: helperServer.origin, scenes: helperServer.scenes }
      : undefined;

  if (server?.origin) {
    const { origin } = server;
    const scenes = server.scenes ?? [];

    notes.push(
      `# Local scene server\n\n${origin} serves exported scenes (e.g. ${origin}/scenes/<Name>.gltf). Scenes: ${scenes.slice(0, 20).join(', ') || 'unknown'}. Local URLs work only while developing — import a scene with import_local_scene before the user publishes.`,
    );
  }

  return notes.filter((note) => note.length > 0);
}
