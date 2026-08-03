import type { Message } from 'ai';
import { generateId } from './fileUtils';
import { detectProjectCommands, createCommandsMessage, escapeBoltTags } from './projectCommands';
import { openImportWorkspace, type ImportWorkspace } from '~/lib/registry/import-project';
import { runtimeSupportsNativeAddons } from '~/lib/sandbox';
import { createScopedLogger } from './logger';

const logger = createScopedLogger('FolderImport');

const relativePathOf = (file: File) => file.webkitRelativePath.split('/').slice(1).join('/');

/**
 * Import binary files as real bytes into the WebContainer.
 *
 * Upstream listed them by name and threw the bytes away ("Skipped N binary files"), so an
 * imported game arrived without a single texture, model, or sound. They are written directly
 * rather than through the artifact because the artifact is a text protocol and its content
 * reaches the model (SPEC §1.3 principle 10, §4.4).
 */
const writeBinaryFiles = async (workspace: ImportWorkspace, files: File[]): Promise<string[]> => {
  if (files.length === 0) {
    return [];
  }

  const container = workspace.sandbox;
  const written: string[] = [];

  for (const file of files) {
    const relativePath = relativePathOf(file);

    try {
      const dir = relativePath.split('/').slice(0, -1).join('/');

      if (dir) {
        await container.fs.mkdir(dir, { recursive: true });
      }

      await container.fs.writeFile(relativePath, new Uint8Array(await file.arrayBuffer()));
      written.push(relativePath);
    } catch (error) {
      logger.error(`Failed to import binary file: ${relativePath}`, error);
    }
  }

  return written;
};

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
   * 🔴 Acquired FIRST, and unconditionally — not lazily inside `writeBinaryFiles`.
   *
   * A folder with no binaries still needs a workspace: the text files ride in as an artifact that is
   * replayed after the page reloads, and with no project there is no sandbox for those actions to
   * write into. Registering only when a binary happens to be present would make a text-only import
   * silently land nowhere (see `openImportWorkspace` for why the project comes before the bytes).
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
  }
};

const buildImportedFolder = async (
  workspace: ImportWorkspace,
  files: File[],
  binaryFiles: File[],
  folderName: string,
): Promise<ImportedFolder> => {
  const fileArtifacts = await Promise.all(
    files.map(async (file) => {
      return new Promise<{ content: string; path: string }>((resolve, reject) => {
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

  const importedBinaries = await writeBinaryFiles(workspace, binaryFiles);

  const commands = await detectProjectCommands(fileArtifacts, {
    nativeAddons: await runtimeSupportsNativeAddons(),
  });
  const commandsMessage = createCommandsMessage(commands);

  // The agent is told these assets exist — never their contents.
  const binaryFilesMessage =
    importedBinaries.length > 0
      ? `\n\nImported ${importedBinaries.length} binary asset(s):\n${importedBinaries.map((f) => `- ${f}`).join('\n')}`
      : '';

  const filesMessage: Message = {
    role: 'assistant',
    content: `I've imported the contents of the "${folderName}" folder.${binaryFilesMessage}

<boltArtifact id="imported-files" title="Imported Files" type="bundled" >
${fileArtifacts
  .map(
    (file) => `<boltAction type="file" filePath="${file.path}">
${escapeBoltTags(file.content)}
</boltAction>`,
  )
  .join('\n\n')}
</boltArtifact>`,
    id: generateId(),
    createdAt: new Date(),
  };

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
