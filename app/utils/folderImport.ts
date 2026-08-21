import type { Message } from 'ai';
import { generateId } from './fileUtils';
import { detectProjectCommands, createCommandsMessage, escapeBoltTags } from './projectCommands';
import { openImportWorkspace, type ImportWorkspace } from '~/lib/registry/import-project';
import { checkpointImportedProject } from '~/lib/persistence/import-checkpoint';
import { settleAfterCreation, IMPORT_SETTLE_OPTIONS } from '~/lib/registry/settle';
import { bootProgress, endBootPhase } from '~/lib/stores/boot-progress';
import { workbenchStore } from '~/lib/stores/workbench';
import { runtimeSupportsNativeAddons } from '~/lib/sandbox';
import { createScopedLogger } from './logger';

const logger = createScopedLogger('FolderImport');

const relativePathOf = (file: File) => file.webkitRelativePath.split('/').slice(1).join('/');

interface TextFile {
  path: string;
  content: string;
}

/**
 * Write one imported file into the workspace, creating its directory first.
 *
 * Bytes for a binary, a string for text — never base64 and never through the artifact. The artifact is
 * a TEXT protocol whose content also reaches the model, so routing a binary through it decodes and
 * rewrites it corrupted (`spec/binary-files.md`, SPEC §1.3 principle 10) and routing anything through
 * it buys a permanent per-turn context bill (§4.2.8).
 */
const writeImportedFile = async (
  workspace: ImportWorkspace,
  path: string,
  data: string | Uint8Array,
): Promise<boolean> => {
  try {
    const dir = path.split('/').slice(0, -1).join('/');

    if (dir) {
      await workspace.sandbox.fs.mkdir(dir, { recursive: true });
    }

    await workspace.sandbox.fs.writeFile(path, data);

    return true;
  } catch (error) {
    logger.error(`Failed to import file: ${path}`, error);
    return false;
  }
};

/**
 * Put the whole folder on disk, narrating the write.
 *
 * Additive on purpose, and that is the difference from the git door: `openImportWorkspace` hands back
 * the ALREADY-BOOTED project when an import is started from inside one, so a folder import writes into
 * a workspace it is not authoritative about. `restoreFiles` would be authoritative — it deletes what
 * the incoming map does not have — and that would turn "import these assets" into "replace my game".
 */
const writeFolderIntoWorkspace = async (
  workspace: ImportWorkspace,
  textFiles: TextFile[],
  binaryFiles: File[],
): Promise<{ text: number; binaries: string[] }> => {
  const total = textFiles.length + binaryFiles.length;
  let done = 0;

  bootProgress.set({ step: 'files', done, total });

  const progress = () => bootProgress.set({ step: 'files', done: ++done, total });

  let text = 0;

  for (const file of textFiles) {
    if (await writeImportedFile(workspace, file.path, file.content)) {
      text++;
    }

    progress();
  }

  const binaries: string[] = [];

  for (const file of binaryFiles) {
    const path = relativePathOf(file);

    if (await writeImportedFile(workspace, path, new Uint8Array(await file.arrayBuffer()))) {
      binaries.push(path);
    }

    progress();
  }

  return { text, binaries };
};

/**
 * The message that RECORDS the import.
 *
 * No file bodies — the bytes are already on disk and correct, and the checkpoint is what carries them
 * across the hand-off's page load. It carries what the model and the user actually need: what was
 * imported, and how big it is. Mirrors `describeImport` on the git door.
 */
const describeFolderImport = (input: { folderName: string; fileCount: number; binaries: string[] }): Message => {
  // The agent is told these assets exist — never their contents.
  const assets =
    input.binaries.length > 0
      ? `\n\nImported ${input.binaries.length} binary asset(s):\n${input.binaries.map((f) => `- ${f}`).join('\n')}`
      : '';

  return {
    role: 'assistant',
    content:
      `I've imported the contents of the "${input.folderName}" folder — ` +
      `${input.fileCount} file(s) are in your workspace and ready to edit.${assets}`,
    id: generateId(),
    createdAt: new Date(),
  };
};

/**
 * The DEGRADED carrier: the files as artifact bodies, replayed by the message parser after the reload.
 *
 * 🔴 Only reachable when the import has no project — registration was unreachable on a runtime that can
 * carry on without it (`import-project.ts`; a 402 is refused outright). Without a project there is no
 * `sandbox_id` to boot again, so the reload gets a brand-new empty runtime and the chat is the only
 * thing that survives: dropping the bodies here would delete the import rather than economise on it.
 * Binaries are still never carried — the artifact would corrupt them — so a degraded import is text
 * only, exactly as it has always been.
 */
const artifactCarrierMessage = (folderName: string, textFiles: TextFile[]): Message => ({
  role: 'assistant',
  content: `I've imported the contents of the "${folderName}" folder.

<boltArtifact id="imported-files" title="Imported Files" type="bundled" >
${textFiles
  .map(
    (file) => `<boltAction type="file" filePath="${file.path}">
${escapeBoltTags(file.content)}
</boltAction>`,
  )
  .join('\n\n')}
</boltArtifact>`,
  id: generateId(),
  createdAt: new Date(),
});

export interface ImportedFolder {
  messages: Message[];

  /**
   * The project this folder was imported into, when the runtime required one.
   *
   * The caller MUST put it on the imported chat's metadata: the import ends in a full page load, and
   * this pointer is the only thing that boots the same sandbox again.
   */
  projectId?: string;
}

export const createChatFromFolder = async (
  files: File[],
  binaryFiles: File[],
  folderName: string,
): Promise<ImportedFolder> => {
  /*
   * 🔴 Acquired FIRST, and unconditionally — not lazily inside the write loop.
   *
   * A folder with no binaries still needs a workspace: with no project there is no sandbox for the
   * files to land in, so registering only when a binary happens to be present would make a text-only
   * import silently land nowhere (see `openImportWorkspace` for why the project comes before the bytes).
   */
  const workspace = await openImportWorkspace({ name: folderName });

  /*
   * 🔴 Everything below can still fail — a file that will not read, a write that is refused — and
   * until now it failed with a project already registered, leaving an empty card on the dashboard
   * and a VM billing by the second (T3b). A no-op when this call registered nothing.
   */
  try {
    return await buildImportedFolder(workspace, files, binaryFiles, folderName);
  } catch (error) {
    await workspace.rollback();

    throw error;
  } finally {
    /*
     * `endBootPhase`, never a literal `idle` reset — the same rule the git door records: the literal
     * would stomp a `failed` phase written a fraction of a second earlier, taking down the only
     * sentence explaining what went wrong.
     */
    endBootPhase();
  }
};

const buildImportedFolder = async (
  workspace: ImportWorkspace,
  files: File[],
  binaryFiles: File[],
  folderName: string,
): Promise<ImportedFolder> => {
  const textFiles = await Promise.all(
    files.map(async (file) => {
      return new Promise<TextFile>((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => {
          const content = reader.result as string;
          resolve({
            content,
            path: relativePathOf(file),
          });
        };
        reader.onerror = reject;
        reader.readAsText(file);
      });
    }),
  );

  const written = await writeFolderIntoWorkspace(workspace, textFiles, binaryFiles);

  if (workspace.projectId) {
    /*
     * The write resolving is not the map having finished changing — the watcher's tail is still
     * arriving, an RTT per file on a server sandbox, and the checkpoint below serializes that map.
     * `IMPORT_SETTLE_OPTIONS`, never a re-derived copy and never a blind `setTimeout`: too short on a
     * cold VM, pure dead time on a warm one.
     */
    bootProgress.set({ step: 'settling' });
    await settleAfterCreation({
      ...IMPORT_SETTLE_OPTIONS,
      readCount: () => Object.keys(workbenchStore.files.get()).length,
    });

    /*
     * 🔴 The copy the hand-off's page load mounts from (`import-checkpoint.ts`). No map is handed in:
     * this door ADDS files, so its own list is not the whole truth and a checkpoint that is not the
     * whole truth is a deletion on the next restore. `serverCopy` because a folder import is born
     * UNLINKED — there is no repository behind it, so this checkpoint plus the §4.5.4c recovery copy
     * are the only places the project exists.
     */
    await checkpointImportedProject({ projectId: workspace.projectId, name: folderName, serverCopy: true });
  }

  const commands = await detectProjectCommands(textFiles, {
    nativeAddons: await runtimeSupportsNativeAddons(),
  });
  const commandsMessage = createCommandsMessage(commands);

  const filesMessage = workspace.projectId
    ? describeFolderImport({
        folderName,
        fileCount: written.text + written.binaries.length,
        binaries: written.binaries,
      })
    : artifactCarrierMessage(folderName, textFiles);

  const userMessage: Message = {
    role: 'user',
    id: generateId(),
    content: `Import the "${folderName}" folder`,
    createdAt: new Date(),
  };

  const messages = [userMessage, filesMessage];

  if (commandsMessage) {
    messages.push({
      role: 'user',
      id: generateId(),
      content: 'Setup the codebase and Start the application',
    });
    messages.push(commandsMessage);
  }

  return { messages, projectId: workspace.projectId };
};
