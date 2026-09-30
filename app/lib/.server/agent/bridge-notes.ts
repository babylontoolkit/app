/**
 * Per-turn Unity Bridge notes (SPEC §4.17, D37) — what the model is told about the user's machine this
 * turn: the linked device is online (and what it runs) or offline, which bridge jobs finished since the
 * last turn, and which local scene server serves exported scenes.
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
  localSceneServer?: { origin: string; scenes?: string[] };
  linkName?: string;
}

export function bridgeTurnNotes(input: BridgeTurnNotesInput): string[] {
  const { bridgeTurn, finishedJobs, localSceneServer, linkName } = input;
  const notes: string[] = [];
  const deviceName = bridgeTurn.device?.name ?? 'your computer';

  if (bridgeTurn.state === 'offline') {
    notes.push(
      `The Unity Bridge is linked to "${deviceName}" but the helper is not running. If the user asks for Unity or Blender work, tell them to run the helper (the cube icon shows the command). Never claim to have run a Unity or Blender command.`,
    );
  }

  if (bridgeTurn.state === 'online') {
    const hello = bridgeTurn.hello;
    const first = hello?.unityProjects[0];
    const toolkitVersion = first?.toolkitVersion;
    const blender = hello?.blender;

    notes.push(
      `# Unity Bridge\n\nConnected to "${deviceName}" (Unity project "${linkName ?? first?.name ?? '?'}"). Unity ${first?.unityVersion ?? '?'}, Babylon Toolkit ${toolkitVersion ?? '?'}${blender ? `, Blender ${blender.version}` : ', Blender not found'}. Use the Unity Bridge tools; paths are relative to the Unity project.`,
    );
  }

  if (finishedJobs.length) {
    const lines = finishedJobs.map(
      ({ id, operation, status, error, resultText }) =>
        `- ${id} ${operation}: ${status}${error ? ' — ' + error : ''}${resultText ? '\n  ' + resultText.slice(0, 400) : ''}`,
    );

    notes.push(`# Unity Bridge jobs finished since your last turn\n${lines.join('\n')}`);
  }

  // The helper's own report wins while it is online and running (D38); otherwise the client's hint.
  const helperServer = bridgeTurn.state === 'online' ? bridgeTurn.hello?.devServer : undefined;
  const server =
    helperServer?.running && helperServer.origin
      ? { origin: helperServer.origin, scenes: helperServer.scenes }
      : localSceneServer;

  if (server?.origin) {
    const { origin } = server;
    const scenes = server.scenes ?? [];

    notes.push(
      `# Local scene server\n\n${origin} serves exported scenes (e.g. ${origin}/scenes/<Name>.gltf). Scenes: ${scenes.slice(0, 20).join(', ') || 'unknown'}. Local URLs work only while developing — import a scene with import_local_scene before the user publishes.`,
    );
  }

  return notes.filter((note) => note.length > 0);
}
