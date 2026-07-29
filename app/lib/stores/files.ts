import { map, type MapStore } from 'nanostores';
import type { SandboxProvider, SandboxWatchEvent } from '~/lib/sandbox';
import {
  base64ByteLength,
  bytesToBase64,
  fileEntryFromBuffer,
  serializeFileMap,
  writeSerializedFileMap,
  type SerializedFileMap,
} from '~/lib/binary/binary-files';
import { toProjectRelativePath } from '~/lib/common/sandbox-paths';
import { path } from '~/utils/path';
import { bufferWatchEvents } from '~/utils/buffer';
import { WORK_DIR } from '~/utils/constants';
import { computeFileModifications } from '~/utils/diff';
import { planRestore } from '~/lib/persistence/restore-plan';
import { createScopedLogger } from '~/utils/logger';
import { unreachable } from '~/utils/unreachable';
import {
  addLockedFile,
  removeLockedFile,
  addLockedFolder,
  removeLockedFolder,
  getLockedItemsForChat,
  getLockedFilesForChat,
  getLockedFoldersForChat,
  isPathInLockedFolder,
  migrateLegacyLocks,
  clearCache,
} from '~/lib/persistence/lockedFiles';
import { getCurrentChatId } from '~/utils/fileLocks';
import { walkSandboxTree } from '~/lib/stores/refresh-walk';
import { isDirectoryPathError } from '~/lib/sandbox/codesandbox-translate';

const logger = createScopedLogger('FilesStore');

/**
 * Re-reads of the FAILED paths only, before a read failure is treated as one.
 *
 * On a server sandbox every read is a round trip and a transient timeout is ordinary; on WebContainer
 * it is a memory copy and this never fires. Small on purpose — a genuinely unreadable file must be
 * reported quickly rather than retried into a long stall on a path the user is waiting on.
 */
const SERIALIZE_RETRY_ATTEMPTS = 2;

/**
 * The project could not be fully serialized — raised only for `strict` callers (see `serializeFiles`).
 *
 * Carries the paths because "which files are missing?" is the first question, and because a caller that
 * degrades (skip the checkpoint, warn the user) needs to say what was lost.
 */
export class IncompleteSerializationError extends Error {
  constructor(readonly paths: string[]) {
    super(
      `Could not read ${paths.length} file(s) from the sandbox: ${paths.slice(0, 5).join(', ')}` +
        (paths.length > 5 ? `, and ${paths.length - 5} more` : ''),
    );
    this.name = 'IncompleteSerializationError';
  }
}

/**
 * Directories that never enter the file map, in ONE place, for BOTH readers.
 *
 * The watcher and the full re-scan have always had to agree — they are two spellings of the same
 * rule, and the walk's comment says so ("Match the watcher's exclusions"). A comment is not a
 * mechanism, so the list is now the mechanism and each reader derives its own spelling from it.
 *
 * 🔴 `.codesandbox` is here because the map is the SOURCE for every egress path, and this directory is
 * the provider's, not the user's. Excluding it at the map layer removes it from the model's context,
 * the file tree, ZIP exports, working copies, checkpoints and git pushes in one move — and defuses a
 * real data-loss hazard: `tasks.json` lives in it, no repo contains that path, so a repo restore
 * (`planRestore` + `protectForRepoRestore`) planned it for DELETION off the VM, and without it the
 * template's port task never starts (MEASURED: the build times out waiting for the port).
 *
 * ⚠️ This is the MAP layer only. It is deliberately NOT `isSecretPath`, which doubles as
 * restore-protection semantics — overloading that rule would change what a restore protects.
 *
 * 🔴 `dist` is here because a PUBLISH runs `npm run build` in the sandbox and the watcher then
 * streamed the whole build output into the map (MEASURED, T17c: 67 files → 113 after one publish —
 * ~25MB of minified bundles riding into the model's context, every checkpoint, the working copy,
 * ZIP exports, git pushes and the next publish's remix seed, forever). Build output is DERIVED —
 * `readDist` and every deploy client read it straight off the sandbox FS, so nothing consumes it
 * from the map. Like the others this matches the directory NAME at any depth; a user directory
 * named `dist` inside `src/` would be excluded too, which is accepted — the name is reserved as
 * build output by the template's own Vite config.
 */
export const MAP_EXCLUDED_DIRS = ['node_modules', '.git', '.codesandbox', 'dist'] as const;

/**
 * The watcher's spelling of {@link MAP_EXCLUDED_DIRS}.
 *
 * ⚠️ Written out rather than generated, because the two shapes are not interchangeable and neither is
 * ours to redefine: `**\/node_modules` must match at any depth (a nested dependency tree), while
 * `.git` and `.codesandbox` are single root-level directories. `.codesandbox` copies `.git`'s
 * spelling because that is the one this codebase has always used for a root dotdir — NOT because
 * either form is proven on this provider: `.git`'s history is WebContainer's, and the CodeSandbox
 * SDK types its excludes as a bare `readonly string[]` with the matcher unspecified. **Which shapes
 * that watcher actually honours is exactly what T17 scenario 2 owes a live check** — and an ignored
 * exclude is not quiet: one `npm install` then floods enrichment reads at an RTT each, into a
 * 3,600 req/hr cap. A spec asserts every excluded dir appears here, so the two lists cannot drift
 * even though one is not derived from the other.
 */
export const MAP_EXCLUDE_GLOBS = ['**/node_modules', '.git', '.codesandbox', 'dist'];

/** The walk's spelling of {@link MAP_EXCLUDED_DIRS}: a predicate over a single directory name. */
export function isMapExcludedDir(name: string): boolean {
  return (MAP_EXCLUDED_DIRS as readonly string[]).includes(name);
}

export interface File {
  type: 'file';
  content: string;

  /**
   * When true, `content` is ALWAYS empty: binary bytes live in the sandbox FS,
   * not in this map (SPEC §1.3 principle 10 — binary content never enters the editor's
   * text map or LLM context). Read the bytes with `FilesStore.readBinaryFile()`.
   */
  isBinary: boolean;

  /** Byte length on disk. The only thing we know about a binary file's contents. */
  size?: number;
  isLocked?: boolean;
  lockedByFolder?: string; // Path of the folder that locked this file
}

export interface Folder {
  type: 'folder';
  isLocked?: boolean;
  lockedByFolder?: string; // Path of the folder that locked this folder (for nested folders)
}

type Dirent = File | Folder;

export type FileMap = Record<string, Dirent | undefined>;

export class FilesStore {
  #sandbox: Promise<SandboxProvider>;

  /**
   * Tracks the number of files without folders.
   */
  #size = 0;

  /**
   * @note Keeps track all modified files with their original content since the last user message.
   * Needs to be reset when the user sends another message and all changes have to be submitted
   * for the model to be aware of the changes.
   */
  #modifiedFiles: Map<string, string> = import.meta.hot?.data.modifiedFiles ?? new Map();

  /**
   * Keeps track of deleted files and folders to prevent them from reappearing on reload
   */
  #deletedPaths: Set<string> = import.meta.hot?.data.deletedPaths ?? new Set();

  /**
   * Map of files that matches the state of the sandbox filesystem.
   */
  files: MapStore<FileMap> = import.meta.hot?.data.files ?? map({});

  get filesCount() {
    return this.#size;
  }

  constructor(sandboxPromise: Promise<SandboxProvider>) {
    this.#sandbox = sandboxPromise;

    // Load deleted paths from localStorage if available
    try {
      if (typeof localStorage !== 'undefined') {
        const deletedPathsJson = localStorage.getItem('bolt-deleted-paths');

        if (deletedPathsJson) {
          const deletedPaths = JSON.parse(deletedPathsJson);

          if (Array.isArray(deletedPaths)) {
            deletedPaths.forEach((path) => this.#deletedPaths.add(path));
          }
        }
      }
    } catch (error) {
      logger.error('Failed to load deleted paths from localStorage', error);
    }

    // Load locked files from localStorage
    this.#loadLockedFiles();

    if (import.meta.hot) {
      // Persist our state across hot reloads
      import.meta.hot.data.files = this.files;
      import.meta.hot.data.modifiedFiles = this.#modifiedFiles;
      import.meta.hot.data.deletedPaths = this.#deletedPaths;
    }

    // Listen for URL changes to detect chat ID changes
    if (typeof window !== 'undefined') {
      let lastChatId = getCurrentChatId();

      // Use MutationObserver to detect URL changes (for SPA navigation)
      const observer = new MutationObserver(() => {
        const currentChatId = getCurrentChatId();

        if (currentChatId !== lastChatId) {
          logger.info(`Chat ID changed from ${lastChatId} to ${currentChatId}, reloading locks`);
          lastChatId = currentChatId;
          this.#loadLockedFiles(currentChatId);
        }
      });

      observer.observe(document, { subtree: true, childList: true });
    }

    this.#init();
  }

  /**
   * Load locked files and folders from localStorage and update the file objects
   * @param chatId Optional chat ID to load locks for (defaults to current chat)
   */
  #loadLockedFiles(chatId?: string) {
    try {
      const currentChatId = chatId || getCurrentChatId();
      const startTime = performance.now();

      // Migrate any legacy locks to the current chat
      migrateLegacyLocks(currentChatId);

      // Get all locked items for this chat (uses optimized cache)
      const lockedItems = getLockedItemsForChat(currentChatId);

      // Split into files and folders
      const lockedFiles = lockedItems.filter((item) => !item.isFolder);
      const lockedFolders = lockedItems.filter((item) => item.isFolder);

      if (lockedItems.length === 0) {
        logger.info(`No locked items found for chat ID: ${currentChatId}`);
        return;
      }

      logger.info(
        `Found ${lockedFiles.length} locked files and ${lockedFolders.length} locked folders for chat ID: ${currentChatId}`,
      );

      const currentFiles = this.files.get();
      const updates: FileMap = {};

      // Process file locks
      for (const lockedFile of lockedFiles) {
        const file = currentFiles[lockedFile.path];

        if (file?.type === 'file') {
          updates[lockedFile.path] = {
            ...file,
            isLocked: true,
          };
        }
      }

      // Process folder locks
      for (const lockedFolder of lockedFolders) {
        const folder = currentFiles[lockedFolder.path];

        if (folder?.type === 'folder') {
          updates[lockedFolder.path] = {
            ...folder,
            isLocked: true,
          };

          // Also mark all files within the folder as locked
          this.#applyLockToFolderContents(currentFiles, updates, lockedFolder.path);
        }
      }

      if (Object.keys(updates).length > 0) {
        this.files.set({ ...currentFiles, ...updates });
      }

      const endTime = performance.now();
      logger.info(`Loaded locked items in ${Math.round(endTime - startTime)}ms`);
    } catch (error) {
      logger.error('Failed to load locked files from localStorage', error);
    }
  }

  /**
   * Apply a lock to all files within a folder
   * @param currentFiles Current file map
   * @param updates Updates to apply
   * @param folderPath Path of the folder to lock
   */
  #applyLockToFolderContents(currentFiles: FileMap, updates: FileMap, folderPath: string) {
    const folderPrefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;

    // Find all files that are within this folder
    Object.entries(currentFiles).forEach(([path, file]) => {
      if (path.startsWith(folderPrefix) && file) {
        if (file.type === 'file') {
          updates[path] = {
            ...file,
            isLocked: true,

            // Add a property to indicate this is locked by a parent folder
            lockedByFolder: folderPath,
          };
        } else if (file.type === 'folder') {
          updates[path] = {
            ...file,
            isLocked: true,

            // Add a property to indicate this is locked by a parent folder
            lockedByFolder: folderPath,
          };
        }
      }
    });
  }

  /**
   * Lock a file
   * @param filePath Path to the file to lock
   * @param chatId Optional chat ID (defaults to current chat)
   * @returns True if the file was successfully locked
   */
  lockFile(filePath: string, chatId?: string) {
    const file = this.getFile(filePath);
    const currentChatId = chatId || getCurrentChatId();

    if (!file) {
      logger.error(`Cannot lock non-existent file: ${filePath}`);
      return false;
    }

    // Update the file in the store
    this.files.setKey(filePath, {
      ...file,
      isLocked: true,
    });

    // Persist to localStorage with chat ID
    addLockedFile(currentChatId, filePath);

    logger.info(`File locked: ${filePath} for chat: ${currentChatId}`);

    return true;
  }

  /**
   * Lock a folder and all its contents
   * @param folderPath Path to the folder to lock
   * @param chatId Optional chat ID (defaults to current chat)
   * @returns True if the folder was successfully locked
   */
  lockFolder(folderPath: string, chatId?: string) {
    const folder = this.getFileOrFolder(folderPath);
    const currentFiles = this.files.get();
    const currentChatId = chatId || getCurrentChatId();

    if (!folder || folder.type !== 'folder') {
      logger.error(`Cannot lock non-existent folder: ${folderPath}`);
      return false;
    }

    const updates: FileMap = {};

    // Update the folder in the store
    updates[folderPath] = {
      type: folder.type,
      isLocked: true,
    };

    // Apply lock to all files within the folder
    this.#applyLockToFolderContents(currentFiles, updates, folderPath);

    // Update the store with all changes
    this.files.set({ ...currentFiles, ...updates });

    // Persist to localStorage with chat ID
    addLockedFolder(currentChatId, folderPath);

    logger.info(`Folder locked: ${folderPath} for chat: ${currentChatId}`);

    return true;
  }

  /**
   * Unlock a file
   * @param filePath Path to the file to unlock
   * @param chatId Optional chat ID (defaults to current chat)
   * @returns True if the file was successfully unlocked
   */
  unlockFile(filePath: string, chatId?: string) {
    const file = this.getFile(filePath);
    const currentChatId = chatId || getCurrentChatId();

    if (!file) {
      logger.error(`Cannot unlock non-existent file: ${filePath}`);
      return false;
    }

    // Update the file in the store
    this.files.setKey(filePath, {
      ...file,
      isLocked: false,
      lockedByFolder: undefined, // Clear the parent folder lock reference if it exists
    });

    // Remove from localStorage with chat ID
    removeLockedFile(currentChatId, filePath);

    logger.info(`File unlocked: ${filePath} for chat: ${currentChatId}`);

    return true;
  }

  /**
   * Unlock a folder and all its contents
   * @param folderPath Path to the folder to unlock
   * @param chatId Optional chat ID (defaults to current chat)
   * @returns True if the folder was successfully unlocked
   */
  unlockFolder(folderPath: string, chatId?: string) {
    const folder = this.getFileOrFolder(folderPath);
    const currentFiles = this.files.get();
    const currentChatId = chatId || getCurrentChatId();

    if (!folder || folder.type !== 'folder') {
      logger.error(`Cannot unlock non-existent folder: ${folderPath}`);
      return false;
    }

    const updates: FileMap = {};

    // Update the folder in the store
    updates[folderPath] = {
      type: folder.type,
      isLocked: false,
    };

    // Find all files that are within this folder and unlock them
    const folderPrefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;

    Object.entries(currentFiles).forEach(([path, file]) => {
      if (path.startsWith(folderPrefix) && file) {
        if (file.type === 'file' && file.lockedByFolder === folderPath) {
          updates[path] = {
            ...file,
            isLocked: false,
            lockedByFolder: undefined,
          };
        } else if (file.type === 'folder' && file.lockedByFolder === folderPath) {
          updates[path] = {
            type: file.type,
            isLocked: false,
            lockedByFolder: undefined,
          };
        }
      }
    });

    // Update the store with all changes
    this.files.set({ ...currentFiles, ...updates });

    // Remove from localStorage with chat ID
    removeLockedFolder(currentChatId, folderPath);

    logger.info(`Folder unlocked: ${folderPath} for chat: ${currentChatId}`);

    return true;
  }

  /**
   * Check if a file is locked
   * @param filePath Path to the file to check
   * @param chatId Optional chat ID (defaults to current chat)
   * @returns Object with locked status, lock mode, and what caused the lock
   */
  isFileLocked(filePath: string, chatId?: string): { locked: boolean; lockedBy?: string } {
    const file = this.getFile(filePath);
    const currentChatId = chatId || getCurrentChatId();

    if (!file) {
      return { locked: false };
    }

    // First check the in-memory state
    if (file.isLocked) {
      // If the file is locked by a folder, include that information
      if (file.lockedByFolder) {
        return {
          locked: true,
          lockedBy: file.lockedByFolder as string,
        };
      }

      return {
        locked: true,
        lockedBy: filePath,
      };
    }

    // Then check localStorage for direct file locks
    const lockedFiles = getLockedFilesForChat(currentChatId);
    const lockedFile = lockedFiles.find((item) => item.path === filePath);

    if (lockedFile) {
      // Update the in-memory state to match localStorage
      this.files.setKey(filePath, {
        ...file,
        isLocked: true,
      });

      return { locked: true, lockedBy: filePath };
    }

    // Finally, check if the file is in a locked folder
    const folderLockResult = this.isFileInLockedFolder(filePath, currentChatId);

    if (folderLockResult.locked) {
      // Update the in-memory state to reflect the folder lock
      this.files.setKey(filePath, {
        ...file,
        isLocked: true,
        lockedByFolder: folderLockResult.lockedBy,
      });

      return folderLockResult;
    }

    return { locked: false };
  }

  /**
   * Check if a file is within a locked folder
   * @param filePath Path to the file to check
   * @param chatId Optional chat ID (defaults to current chat)
   * @returns Object with locked status, lock mode, and the folder that caused the lock
   */
  isFileInLockedFolder(filePath: string, chatId?: string): { locked: boolean; lockedBy?: string } {
    const currentChatId = chatId || getCurrentChatId();

    // Use the optimized function from lockedFiles.ts
    return isPathInLockedFolder(currentChatId, filePath);
  }

  /**
   * Check if a folder is locked
   * @param folderPath Path to the folder to check
   * @param chatId Optional chat ID (defaults to current chat)
   * @returns Object with locked status and lock mode
   */
  isFolderLocked(folderPath: string, chatId?: string): { isLocked: boolean; lockedBy?: string } {
    const folder = this.getFileOrFolder(folderPath);
    const currentChatId = chatId || getCurrentChatId();

    if (!folder || folder.type !== 'folder') {
      return { isLocked: false };
    }

    // First check the in-memory state
    if (folder.isLocked) {
      return {
        isLocked: true,
        lockedBy: folderPath,
      };
    }

    // Then check localStorage for this specific chat
    const lockedFolders = getLockedFoldersForChat(currentChatId);
    const lockedFolder = lockedFolders.find((item) => item.path === folderPath);

    if (lockedFolder) {
      // Update the in-memory state to match localStorage
      this.files.setKey(folderPath, {
        type: folder.type,
        isLocked: true,
      });

      return { isLocked: true, lockedBy: folderPath };
    }

    return { isLocked: false };
  }

  getFile(filePath: string) {
    const dirent = this.files.get()[filePath];

    if (!dirent) {
      return undefined;
    }

    // For backward compatibility, only return file type dirents
    if (dirent.type !== 'file') {
      return undefined;
    }

    return dirent;
  }

  /**
   * Get any file or folder from the file system
   * @param path Path to the file or folder
   * @returns The file or folder, or undefined if it doesn't exist
   */
  getFileOrFolder(path: string) {
    return this.files.get()[path];
  }

  getFileModifications() {
    return computeFileModifications(this.files.get(), this.#modifiedFiles);
  }
  getModifiedFiles() {
    let modifiedFiles: { [path: string]: File } | undefined = undefined;

    for (const [filePath, originalContent] of this.#modifiedFiles) {
      const file = this.files.get()[filePath];

      if (file?.type !== 'file') {
        continue;
      }

      if (file.content === originalContent) {
        continue;
      }

      if (!modifiedFiles) {
        modifiedFiles = {};
      }

      modifiedFiles[filePath] = file;
    }

    return modifiedFiles;
  }

  resetFileModifications() {
    this.#modifiedFiles.clear();
  }

  /**
   * Record a write the ACTION RUNNER has already made to the sandbox FS — map update only, no disk.
   *
   * 🔴 Exists because "on disk is not visible" applies to the PERSISTENCE path too. On WebContainer
   * the watcher reports a write almost instantly, with content in the event; on a server provider it
   * is a network round trip per file (event, then an enrichment read), so for a moment after a
   * generation the map holds a STALE PREFIX of what the artifact wrote. Everything that serializes
   * the map — the §4.5.4c working copy, local checkpoints — captures that prefix, and a later mount
   * restores it over the correct files (MEASURED live: a working copy holding the generated
   * `Home.tsx` beside the STARTER's `Home.css`, which then reverted the landing page on reopen).
   * Same contract as `saveFile` above: "immediately update the file and don't rely on the `change`
   * event"; the watcher's later event simply confirms what is already here.
   */
  recordAgentWrite(filePath: string, content: string) {
    const current = this.files.get()[filePath];

    if (current?.type !== 'file') {
      this.#size++;
    }

    this.files.setKey(filePath, {
      type: 'file',
      content,
      isBinary: false,
      isLocked: current?.type === 'file' ? current.isLocked : false,
    });
  }

  async saveFile(filePath: string, content: string) {
    const sandbox = await this.#sandbox;

    try {
      const relativePath = path.relative(sandbox.workdir, filePath);

      if (!relativePath) {
        throw new Error(`EINVAL: invalid file path, write '${relativePath}'`);
      }

      const oldContent = this.getFile(filePath)?.content;

      if (!oldContent && oldContent !== '') {
        unreachable('Expected content to be defined');
      }

      await sandbox.fs.writeFile(relativePath, content);

      if (!this.#modifiedFiles.has(filePath)) {
        this.#modifiedFiles.set(filePath, oldContent);
      }

      // Get the current lock state before updating
      const currentFile = this.files.get()[filePath];
      const isLocked = currentFile?.type === 'file' ? currentFile.isLocked : false;

      // we immediately update the file and don't rely on the `change` event coming from the watcher
      this.files.setKey(filePath, {
        type: 'file',
        content,
        isBinary: false,
        isLocked,
      });

      logger.info('File updated');
    } catch (error) {
      logger.error('Failed to update file content\n\n', error);

      throw error;
    }
  }

  async #init() {
    const sandbox = await this.#sandbox;

    // Clean up any files that were previously deleted
    this.#cleanupDeletedFiles();

    /*
     * File watcher.
     *
     * Upstream also excluded `**\/package-lock.json` here, on the assumption that the file map is a
     * view for the model. It is not — it is the SOURCE for every egress path (ZIP export, GitHub
     * sync, snapshot, share build all iterate `this.files`). A lockfile absent from the map is a
     * lockfile absent from the user's exported project, so a restored snapshot re-resolves its
     * dependencies and can install a different tree than the one that was tested (SPEC §4.4, §4.2.8).
     *
     * Keeping it OUT of the model's context is a separate concern, handled where it belongs — at the
     * context boundary (`~/lib/context/opaque-files`): the model gets a `<boltFile>` marker, and the
     * client strips the body before posting the map to the agent route.
     */
    sandbox.watchPaths(
      {
        include: [`${WORK_DIR}/**`],
        exclude: MAP_EXCLUDE_GLOBS,
        includeContent: true,
      },
      bufferWatchEvents(100, this.#processEventBuffer.bind(this)),
    );

    // Get the current chat ID
    const currentChatId = getCurrentChatId();

    // Migrate any legacy locks to the current chat
    migrateLegacyLocks(currentChatId);

    // Load locked files immediately for the current chat
    this.#loadLockedFiles(currentChatId);

    /**
     * Also set up a timer to load locked files again after a delay.
     * This ensures that locks are applied even if files are loaded asynchronously.
     */
    setTimeout(() => {
      this.#loadLockedFiles(currentChatId);
    }, 2000);

    /**
     * Set up a less frequent periodic check to ensure locks remain applied.
     * This is now less critical since we have the storage event listener.
     */
    setInterval(() => {
      // Clear the cache to force a fresh read from localStorage
      clearCache();

      const latestChatId = getCurrentChatId();
      this.#loadLockedFiles(latestChatId);
    }, 30000); // Reduced from 10s to 30s
  }

  /**
   * Removes any deleted files/folders from the store
   */
  #cleanupDeletedFiles() {
    if (this.#deletedPaths.size === 0) {
      return;
    }

    const currentFiles = this.files.get();
    const pathsToDelete = new Set<string>();

    // Precompute prefixes for efficient checking
    const deletedPrefixes = [...this.#deletedPaths].map((p) => p + '/');

    // Iterate through all current files/folders once
    for (const [path, dirent] of Object.entries(currentFiles)) {
      // Skip if dirent is already undefined (shouldn't happen often but good practice)
      if (!dirent) {
        continue;
      }

      // Check for exact match in deleted paths
      if (this.#deletedPaths.has(path)) {
        pathsToDelete.add(path);
        continue; // No need to check prefixes if it's an exact match
      }

      // Check if the path starts with any of the deleted folder prefixes
      for (const prefix of deletedPrefixes) {
        if (path.startsWith(prefix)) {
          pathsToDelete.add(path);
          break; // Found a match, no need to check other prefixes for this path
        }
      }
    }

    // Perform the deletions and updates based on the collected paths
    if (pathsToDelete.size > 0) {
      const updates: FileMap = {};

      for (const pathToDelete of pathsToDelete) {
        const dirent = currentFiles[pathToDelete];
        updates[pathToDelete] = undefined; // Mark for deletion in the map update

        if (dirent?.type === 'file') {
          this.#size--;

          if (this.#modifiedFiles.has(pathToDelete)) {
            this.#modifiedFiles.delete(pathToDelete);
          }
        }
      }

      // Apply all deletions to the store at once for potential efficiency
      this.files.set({ ...currentFiles, ...updates });
    }
  }

  /**
   * Force a full re-scan of the sandbox filesystem and rebuild the file map from disk truth.
   *
   * The incremental watcher (`watchPaths`, `#init`) is the normal path and is reliable, but it is
   * asynchronous and event-driven: a coalesced/missed event or an out-of-band write can leave the map
   * a step behind what is actually on disk, which is exactly what a user means by "the file list is
   * stale". This walks the tree from `WORK_DIR` and rebuilds the map from the filesystem itself, so the
   * Code view reflects precisely what exists.
   *
   * Invariants preserved: the same {@link MAP_EXCLUDED_DIRS} exclusions the watcher uses; lock state
   * carried forward per file; user-deleted paths honored (a refresh must never resurrect a file the
   * user removed). Binaries keep `content: ''` — their bytes stay on disk (`readBinaryFile`).
   *
   * The walk itself lives in `refresh-walk.ts` with bounded read concurrency — on a server provider
   * every call is a network round trip, and the serial version of this scan measured ~17s for a
   * 75-file project, all of it on the blank screen a project open shows before `ready`.
   *
   * `onProgress` surfaces the scan to the boot UI: (filesRead, totalFiles) after each read.
   */
  async refreshFiles(onProgress?: (done: number, total: number) => void): Promise<void> {
    const sandbox = await this.#sandbox;

    const nextFiles: FileMap = {};
    let size = 0;

    const { folders, files } = await walkSandboxTree(sandbox.fs, {
      // The watcher's exclusions, from the one list both read (`MAP_EXCLUDED_DIRS`).
      exclude: isMapExcludedDir,

      // Honor user deletions — a refresh must not resurrect what was removed.
      skip: (relPath) => this.#deletedPaths.has(`${WORK_DIR}/${relPath}`),
      onFileRead: onProgress,
    });

    for (const relPath of folders) {
      nextFiles[`${WORK_DIR}/${relPath}`] = { type: 'folder' };
    }

    for (const { relPath, buffer, error } of files) {
      const absPath = `${WORK_DIR}/${relPath}`;
      const existing = this.files.get()[absPath];
      const isLocked = existing?.type === 'file' ? existing.isLocked : undefined;

      if (buffer) {
        nextFiles[absPath] = { ...fileEntryFromBuffer(buffer), isLocked };
      } else {
        /*
         * A file we cannot read (races a delete, permissions) keeps its prior entry rather than
         * vanishing from the tree — a refresh must not lose a file it merely failed to re-read.
         */
        logger.error(`Failed to read ${absPath} during workspace refresh`, error);

        if (!existing) {
          continue;
        }

        nextFiles[absPath] = existing;
      }

      size++;
    }

    this.#size = size;
    this.files.set(nextFiles);

    // Re-apply locks against the freshly rebuilt map.
    this.#loadLockedFiles();

    logger.info(`Workspace refreshed: ${size} files re-scanned from disk`);
  }

  #processEventBuffer(events: Array<[events: SandboxWatchEvent[]]>) {
    const watchEvents = events.flat(2);

    for (const { type, path, buffer } of watchEvents) {
      // remove any trailing slashes
      const sanitizedPath = path.replace(/\/+$/g, '');

      switch (type) {
        case 'add_dir': {
          // we intentionally add a trailing slash so we can distinguish files from folders in the file tree
          this.files.setKey(sanitizedPath, { type: 'folder' });
          break;
        }
        case 'remove_dir': {
          this.files.setKey(sanitizedPath, undefined);

          for (const [direntPath] of Object.entries(this.files)) {
            if (direntPath.startsWith(sanitizedPath)) {
              this.files.setKey(direntPath, undefined);
            }
          }

          break;
        }
        case 'add_file':
        case 'change': {
          if (type === 'add_file') {
            this.#size++;
          }

          /**
           * Binary files keep `content: ''` here — their bytes stay on disk in the
           * sandbox and are read back on demand (`readBinaryFile`). We record
           * `isBinary` + `size` so the editor can refuse to render them and egress
           * paths know to fetch real bytes instead of trusting `content`.
           */
          const entry = fileEntryFromBuffer(buffer);

          // Preserve lock state — the watcher must not silently unlock a file.
          const existing = this.files.get()[sanitizedPath];
          const isLocked = existing?.type === 'file' ? existing.isLocked : undefined;

          this.files.setKey(sanitizedPath, { ...entry, isLocked });

          break;
        }
        case 'remove_file': {
          this.#size--;
          this.files.setKey(sanitizedPath, undefined);
          break;
        }
        case 'update_directory': {
          // we don't care about these events
          break;
        }
      }
    }
  }

  /**
   * Read a binary file's real bytes from the sandbox — the source of truth for
   * binary content. Every egress path (snapshot, ZIP, GitHub push, deploy, share build)
   * goes through here rather than reading `File.content`, which is empty for binaries.
   */
  async readBinaryFile(filePath: string): Promise<Uint8Array> {
    const sandbox = await this.#sandbox;
    const relativePath = path.relative(sandbox.workdir, filePath);

    return sandbox.fs.readFile(relativePath);
  }

  /**
   * Serialize the whole project for transport (snapshot / share build / GitHub sync),
   * reading real bytes for every binary file. Binaries arrive base64-encoded; text is
   * carried verbatim. A snapshot→restore round-trip is byte-exact.
   *
   * ## `strict` — and why it is a per-call-site answer, not a default
   *
   * `serializeFileMap` OMITS a binary it cannot read (deliberately — a missing file is recoverable, a
   * silently-zeroed PNG is not). That is the right call for a map you are about to inspect or ship,
   * and it is dangerous for a map you are about to RESTORE FROM: a local checkpoint restores with
   * `protectNothing` ("this map is the whole truth"), so a checkpoint written while `havok.wasm` was
   * unreadable would DELETE the physics engine on undo. Silently.
   *
   * So callers whose map becomes a restore source or an egress artifact pass `strict: true` and get an
   * error instead of a quietly incomplete project. The same shape as `restoreFiles`' required
   * `protect` argument, and for the same reason: "what is this map authoritative about?" has no safe
   * default.
   *
   * ## Retry
   *
   * A failed read is retried before it is called a failure. On a server sandbox a read is a round trip
   * and a transient timeout is ordinary; only the FAILED paths are retried, never the whole project —
   * re-reading everything to recover one file is the storm `CoalescedTask` exists to prevent.
   */
  async serializeFiles(options?: { strict?: boolean }): Promise<SerializedFileMap> {
    const sandbox = await this.#sandbox;
    const toRelative = (filePath: string) => path.relative(sandbox.workdir, filePath);

    let failed: string[] = [];

    const serialized = await serializeFileMap(this.files.get(), sandbox.fs, toRelative, (filePath) => {
      failed.push(filePath);
    });

    for (let attempt = 1; attempt <= SERIALIZE_RETRY_ATTEMPTS && failed.length > 0; attempt++) {
      const retrying = failed;
      failed = [];

      for (const filePath of retrying) {
        try {
          const bytes = await sandbox.fs.readFile(toRelative(filePath));
          serialized[filePath] = {
            type: 'file',
            content: bytesToBase64(bytes),
            isBinary: true,
            size: bytes.byteLength,
          };
        } catch {
          failed.push(filePath);
        }
      }
    }

    if (failed.length > 0) {
      logger.error(`Failed to read ${failed.length} binary file(s) for serialization: ${failed.join(', ')}`);

      if (options?.strict) {
        throw new IncompleteSerializationError(failed);
      }
    }

    return serialized;
  }

  /**
   * Materialize a serialized project back into the sandbox, byte-faithfully.
   * Used by snapshot restore and checkpoint restore (SPEC §4.12).
   *
   * 🔴 **Without `protect`, this is an OVERLAY, not a restore** — it writes what it is given and
   * deletes nothing, so a file the incoming map does not have simply survives. That made undo not
   * undo (§4.12) and made "use the version from my repository" produce a third version that is neither
   * (§4.13). Both silent. Pass `protect` and it deletes what the map genuinely dropped; the decision
   * is `planRestore`, which is pure and exhaustively tested because it is the code that destroys the
   * user's files.
   *
   * The overlay behaviour is kept as the DEFAULT deliberately: a caller that has not thought about
   * what its map is authoritative about must not be silently upgraded into one that deletes things.
   * `protect` is how a caller says it has thought about it (`protectForRepoRestore` /
   * `protectNothing`).
   */
  async restoreFiles(
    files: SerializedFileMap,
    options?: { protect?: (path: string) => boolean; onProgress?: (done: number, total: number) => void },
  ): Promise<void> {
    const sandbox = await this.#sandbox;

    /*
     * 🔴 Through the ONE root rule, so a FOREIGN root is rebased rather than passed through.
     *
     * This used to hand an unrecognised path to the provider verbatim. On CodeSandbox that happened
     * to be rescued (`resolveInWorkdir` rebases), so a WebContainer-era working copy restored into a
     * CodeSandbox project landed correctly — but the WebContainer adapter is a bare `container.fs`
     * with nothing to rescue it, so the same map going the other way (a rollback to WebContainer,
     * which is the documented way to revert the provider) would write OUTSIDE the project. Same rule
     * as the map write-through below: keys of unknown provenance are normalised, once, here.
     */
    const toContainerPath = (filePath: string) => toProjectRelativePath(filePath);

    /*
     * 🔴 The T9 excludes apply on the way IN, too (T17a). A checkpoint or working copy written before
     * `.codesandbox` joined `MAP_EXCLUDED_DIRS` still CARRIES those entries, and writing one over the
     * provider's live directory throws a raw `21: Os { … IsADirectory }` that used to kill the whole
     * mount. What the map layer refuses to hold, a restore must refuse to write.
     */
    const restorable = Object.fromEntries(
      Object.entries(files).filter(([filePath]) => !toContainerPath(filePath).split('/').some(isMapExcludedDir)),
    );

    /*
     * One bad entry is REPORTED and skipped, never the whole restore lost (T17a): classified as
     * "that path is a directory on disk" where the provider says so, raw otherwise. Loud, because a
     * skipped entry is a file the user does not get back — but a mount that silently degrades to the
     * legacy path loses ALL of them plus the wake hook.
     */
    const failures: string[] = [];

    await writeSerializedFileMap(restorable, sandbox.fs, toContainerPath, {
      onError: (filePath, error) => {
        failures.push(filePath);

        const reason = isDirectoryPathError(error)
          ? 'the path is a directory on disk'
          : ((error as Error)?.message ?? String(error));
        logger.warn(`Restore skipped ${filePath}: ${reason}`);
      },
      onProgress: options?.onProgress,
    });

    if (failures.length > 0) {
      logger.error(`Restore completed with ${failures.length} skipped file(s): ${failures.slice(0, 5).join(', ')}`);
    }

    /*
     * 🔴 Report the restore into the map SYNCHRONOUSLY — the same write-through `recordAgentWrite`
     * gives artifact writes, for the same reason and against the same measured defect.
     *
     * The disk is now correct; the map is not, and on a server provider it will not be for a while
     * (an event per file, then an enrichment read, each a round trip). Anything that SERIALIZES the
     * store in that window — the §4.5.4c working copy, a checkpoint, a push — captures a stale mix of
     * the old project and the new one, and a later mount restores that mix over correct files. That
     * is exactly the measured second-session defect (a generated `Home.tsx` beside the starter's
     * `Home.css`), reached through the restore door instead of the artifact door: checkpoint undo,
     * working-copy restore, repo restore and git pull all land here.
     *
     * ⚠️ Binaries go in as METADATA ONLY (`isBinary` + `size`, empty content — SPEC §1.3 principle
     * 10). The incoming map holds base64, which is a WIRE format: putting it in `content` would put
     * binary bytes in the editor's text map and in the model's context.
     *
     * 🔴 And it is keyed off THIS sandbox's workdir, never the incoming path. An incoming map may
     * carry a FOREIGN root — that is the whole reason `SANDBOX_ROOTS` is a list: a working copy
     * written under WebContainer (`/home/project/...`) is restored into a CodeSandbox project
     * (`/project/workspace/...`), which is precisely the cutover this plan performs. The disk write
     * above rebases (via the provider's `resolveInWorkdir`), so keying the map on the raw path would
     * record entries that exist on disk under a DIFFERENT key: a strict serialize then fails to read
     * them (the working-copy save and every checkpoint), and once the watcher catches up every
     * restored file is in the map twice — doubled context, doubled exports, and phantom keys that the
     * next restore plans for deletion.
     */
    this.#recordRestoredFiles(restorable, sandbox.workdir);

    // Only a caller that PASSED `protect` has opted into deletions (see the doc comment above).
    const protect = options?.protect;

    if (!protect) {
      return;
    }

    /*
     * Deletions come AFTER the writes. If anything fails partway, the project is left with too many
     * files rather than too few — the recoverable direction. (`node_modules` and `.git` are excluded
     * from the watcher, so they are not in this map and can never be planned for deletion.)
     */
    const { toDelete } = planRestore({
      current: Object.entries(this.files.get())
        .filter(([, dirent]) => dirent?.type === 'file')
        .map(([filePath]) => filePath),
      incoming: Object.keys(restorable),
      protect,
    });

    for (const filePath of toDelete) {
      try {
        await this.deleteFile(filePath);
      } catch (error) {
        // Never fatal: the restore itself landed. A file we could not remove is visible, not lost.
        logger.error(`Failed to delete ${filePath} during restore`, error);
      }
    }

    if (toDelete.length > 0) {
      logger.info(`Restore removed ${toDelete.length} file(s) the incoming version does not have.`);
    }
  }

  /**
   * Put a just-restored map into the store, without touching the disk (it was written a moment ago).
   *
   * Deliberately mirrors `recordAgentWrite`'s contract: lock state is carried forward (a restore is
   * not an unlock), the size counter tracks genuinely new entries, and a binary is recorded by
   * `isBinary` + `size` with EMPTY content — its bytes live on disk and are read back through
   * `readBinaryFile`, never from this map.
   *
   * `size` for a binary comes from the entry when it has one and is derived from the base64 length
   * otherwise, so the marker the model sees stays truthful rather than reporting a base64 length as a
   * byte count (~4/3 too big).
   *
   * 🔴 Every key is REBASED onto `workdir` first — see the caller. An incoming map is allowed to carry
   * another provider's root, and the disk write rebases it, so recording the raw key would put the
   * entry somewhere the file is not.
   */
  #recordRestoredFiles(files: SerializedFileMap, workdir: string) {
    const toStoreKey = (filePath: string) => `${workdir}/${toProjectRelativePath(filePath)}`;

    for (const [rawPath, dirent] of Object.entries(files)) {
      if (!dirent) {
        continue;
      }

      const filePath = toStoreKey(rawPath);
      const current = this.files.get()[filePath];

      if (dirent.type === 'folder') {
        if (current?.type !== 'folder') {
          this.files.setKey(filePath, { type: 'folder' });
        }

        continue;
      }

      if (current?.type !== 'file') {
        this.#size++;
      }

      const isLocked = current?.type === 'file' ? current.isLocked : false;

      this.files.setKey(
        filePath,
        dirent.isBinary
          ? {
              type: 'file',
              content: '',
              isBinary: true,
              size: dirent.size ?? base64ByteLength(dirent.content),
              isLocked,
            }
          : { type: 'file', content: dirent.content, isBinary: false, size: dirent.size, isLocked },
      );
    }
  }

  async createFile(filePath: string, content: string | Uint8Array = '') {
    const sandbox = await this.#sandbox;

    try {
      const relativePath = path.relative(sandbox.workdir, filePath);

      if (!relativePath) {
        throw new Error(`EINVAL: invalid file path, create '${relativePath}'`);
      }

      const dirPath = path.dirname(relativePath);

      if (dirPath !== '.') {
        await sandbox.fs.mkdir(dirPath, { recursive: true });
      }

      const isBinary = content instanceof Uint8Array;

      if (isBinary) {
        await sandbox.fs.writeFile(relativePath, content);

        /**
         * Bytes now live on disk; the map records metadata only, matching what the
         * watcher will report for this same file a moment later. Storing base64 here
         * (as upstream did) both leaked binary content into the editor's text map and
         * was immediately clobbered by the watcher anyway.
         */
        this.files.setKey(filePath, {
          type: 'file',
          content: '',
          isBinary: true,
          size: content.byteLength,
          isLocked: false,
        });
      } else {
        const contentToWrite = (content as string).length === 0 ? ' ' : content;
        await sandbox.fs.writeFile(relativePath, contentToWrite);

        this.files.setKey(filePath, {
          type: 'file',
          content: content as string,
          isBinary: false,
          isLocked: false,
        });

        this.#modifiedFiles.set(filePath, content as string);
      }

      logger.info(`File created: ${filePath}`);

      return true;
    } catch (error) {
      logger.error('Failed to create file\n\n', error);
      throw error;
    }
  }

  async createFolder(folderPath: string) {
    const sandbox = await this.#sandbox;

    try {
      const relativePath = path.relative(sandbox.workdir, folderPath);

      if (!relativePath) {
        throw new Error(`EINVAL: invalid folder path, create '${relativePath}'`);
      }

      await sandbox.fs.mkdir(relativePath, { recursive: true });

      this.files.setKey(folderPath, { type: 'folder' });

      logger.info(`Folder created: ${folderPath}`);

      return true;
    } catch (error) {
      logger.error('Failed to create folder\n\n', error);
      throw error;
    }
  }

  async deleteFile(filePath: string) {
    const sandbox = await this.#sandbox;

    try {
      const relativePath = path.relative(sandbox.workdir, filePath);

      if (!relativePath) {
        throw new Error(`EINVAL: invalid file path, delete '${relativePath}'`);
      }

      await sandbox.fs.rm(relativePath);

      this.#deletedPaths.add(filePath);

      this.files.setKey(filePath, undefined);
      this.#size--;

      if (this.#modifiedFiles.has(filePath)) {
        this.#modifiedFiles.delete(filePath);
      }

      this.#persistDeletedPaths();

      logger.info(`File deleted: ${filePath}`);

      return true;
    } catch (error) {
      logger.error('Failed to delete file\n\n', error);
      throw error;
    }
  }

  async deleteFolder(folderPath: string) {
    const sandbox = await this.#sandbox;

    try {
      const relativePath = path.relative(sandbox.workdir, folderPath);

      if (!relativePath) {
        throw new Error(`EINVAL: invalid folder path, delete '${relativePath}'`);
      }

      await sandbox.fs.rm(relativePath, { recursive: true });

      this.#deletedPaths.add(folderPath);

      this.files.setKey(folderPath, undefined);

      const allFiles = this.files.get();

      for (const [path, dirent] of Object.entries(allFiles)) {
        if (path.startsWith(folderPath + '/')) {
          this.files.setKey(path, undefined);

          this.#deletedPaths.add(path);

          if (dirent?.type === 'file') {
            this.#size--;
          }

          if (dirent?.type === 'file' && this.#modifiedFiles.has(path)) {
            this.#modifiedFiles.delete(path);
          }
        }
      }

      this.#persistDeletedPaths();

      logger.info(`Folder deleted: ${folderPath}`);

      return true;
    } catch (error) {
      logger.error('Failed to delete folder\n\n', error);
      throw error;
    }
  }

  // method to persist deleted paths to localStorage
  #persistDeletedPaths() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('bolt-deleted-paths', JSON.stringify([...this.#deletedPaths]));
      }
    } catch (error) {
      logger.error('Failed to persist deleted paths to localStorage', error);
    }
  }
}
