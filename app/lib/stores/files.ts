import type { PathWatcherEvent, WebContainer } from '@webcontainer/api';
import { map, type MapStore } from 'nanostores';
import {
  fileEntryFromBuffer,
  serializeFileMap,
  writeSerializedFileMap,
  type SerializedFileMap,
} from '~/lib/binary/binary-files';
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

const logger = createScopedLogger('FilesStore');

export interface File {
  type: 'file';
  content: string;

  /**
   * When true, `content` is ALWAYS empty: binary bytes live in the WebContainer FS,
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
  #webcontainer: Promise<WebContainer>;

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
   * Map of files that matches the state of WebContainer.
   */
  files: MapStore<FileMap> = import.meta.hot?.data.files ?? map({});

  get filesCount() {
    return this.#size;
  }

  constructor(webcontainerPromise: Promise<WebContainer>) {
    this.#webcontainer = webcontainerPromise;

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

  async saveFile(filePath: string, content: string) {
    const webcontainer = await this.#webcontainer;

    try {
      const relativePath = path.relative(webcontainer.workdir, filePath);

      if (!relativePath) {
        throw new Error(`EINVAL: invalid file path, write '${relativePath}'`);
      }

      const oldContent = this.getFile(filePath)?.content;

      if (!oldContent && oldContent !== '') {
        unreachable('Expected content to be defined');
      }

      await webcontainer.fs.writeFile(relativePath, content);

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
    const webcontainer = await this.#webcontainer;

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
    webcontainer.internal.watchPaths(
      {
        include: [`${WORK_DIR}/**`],
        exclude: ['**/node_modules', '.git'],
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

  #processEventBuffer(events: Array<[events: PathWatcherEvent[]]>) {
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
           * WebContainer and are read back on demand (`readBinaryFile`). We record
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
   * Read a binary file's real bytes from the WebContainer — the source of truth for
   * binary content. Every egress path (snapshot, ZIP, GitHub push, deploy, share build)
   * goes through here rather than reading `File.content`, which is empty for binaries.
   */
  async readBinaryFile(filePath: string): Promise<Uint8Array> {
    const webcontainer = await this.#webcontainer;
    const relativePath = path.relative(webcontainer.workdir, filePath);

    return webcontainer.fs.readFile(relativePath);
  }

  /**
   * Serialize the whole project for transport (snapshot / share build / GitHub sync),
   * reading real bytes for every binary file. Binaries arrive base64-encoded; text is
   * carried verbatim. A snapshot→restore round-trip is byte-exact.
   */
  async serializeFiles(): Promise<SerializedFileMap> {
    const webcontainer = await this.#webcontainer;

    return serializeFileMap(
      this.files.get(),
      webcontainer.fs,
      (filePath) => path.relative(webcontainer.workdir, filePath),
      (filePath, error) => logger.error(`Failed to read binary file for serialization: ${filePath}`, error),
    );
  }

  /**
   * Materialize a serialized project back into the WebContainer, byte-faithfully.
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
  async restoreFiles(files: SerializedFileMap, options?: { protect: (path: string) => boolean }): Promise<void> {
    const webcontainer = await this.#webcontainer;

    const toContainerPath = (filePath: string) =>
      filePath.startsWith(webcontainer.workdir) ? path.relative(webcontainer.workdir, filePath) : filePath;

    await writeSerializedFileMap(files, webcontainer.fs, toContainerPath);

    if (!options) {
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
      incoming: Object.keys(files),
      protect: options.protect,
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

  async createFile(filePath: string, content: string | Uint8Array = '') {
    const webcontainer = await this.#webcontainer;

    try {
      const relativePath = path.relative(webcontainer.workdir, filePath);

      if (!relativePath) {
        throw new Error(`EINVAL: invalid file path, create '${relativePath}'`);
      }

      const dirPath = path.dirname(relativePath);

      if (dirPath !== '.') {
        await webcontainer.fs.mkdir(dirPath, { recursive: true });
      }

      const isBinary = content instanceof Uint8Array;

      if (isBinary) {
        await webcontainer.fs.writeFile(relativePath, content);

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
        await webcontainer.fs.writeFile(relativePath, contentToWrite);

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
    const webcontainer = await this.#webcontainer;

    try {
      const relativePath = path.relative(webcontainer.workdir, folderPath);

      if (!relativePath) {
        throw new Error(`EINVAL: invalid folder path, create '${relativePath}'`);
      }

      await webcontainer.fs.mkdir(relativePath, { recursive: true });

      this.files.setKey(folderPath, { type: 'folder' });

      logger.info(`Folder created: ${folderPath}`);

      return true;
    } catch (error) {
      logger.error('Failed to create folder\n\n', error);
      throw error;
    }
  }

  async deleteFile(filePath: string) {
    const webcontainer = await this.#webcontainer;

    try {
      const relativePath = path.relative(webcontainer.workdir, filePath);

      if (!relativePath) {
        throw new Error(`EINVAL: invalid file path, delete '${relativePath}'`);
      }

      await webcontainer.fs.rm(relativePath);

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
    const webcontainer = await this.#webcontainer;

    try {
      const relativePath = path.relative(webcontainer.workdir, folderPath);

      if (!relativePath) {
        throw new Error(`EINVAL: invalid folder path, delete '${relativePath}'`);
      }

      await webcontainer.fs.rm(relativePath, { recursive: true });

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
