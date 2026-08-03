/**
 * The browser-side clone — SUPERSEDED, kept per §2.1a's hide-don't-delete rule (SPEC §4.13).
 *
 * 🔴 **This hook has NO production callers.** Both clone doors now go through
 * `~/lib/git/import-repository`, which asks the SERVER to read the repository with the token the user
 * already authorized (`git/clone.ts`). The module and its `isomorphic-git` dependency stay on disk
 * because the upstream project still uses them and this fork stays mergeable with it (§2.1a) — not
 * because anything here is a live fallback.
 *
 * ## What was REMOVED rather than left standing, and why
 *
 * The credential path. `git.clone`'s `onAuth` used to `confirm()` and then `prompt()` for a username
 * and a personal access token, and `onAuthSuccess` wrote the pair — plaintext, JSON, non-httpOnly, no
 * expiry — to a `git:<domain>` cookie which was then replayed as Basic auth through `/api/git-proxy`.
 * The platform therefore held TWO unrelated GitHub identities and the one the user had explicitly
 * granted was the one clone could not see.
 *
 * "Hide, don't delete" is about keeping upstream's SHAPE, not about keeping a credential prompt alive
 * on an unreachable path: a `window.prompt` asking for a PAT is the kind of thing that gets found again
 * and re-wired in good faith. What remains here clones PUBLIC repositories only; `onAuth` cancels, and
 * the resulting `UserCanceledError` is translated in the catch — NOT in `onAuthFailure`, which
 * isomorphic-git never calls when authentication was never offered.
 *
 * Cookies the old flow already wrote are actively reaped at app start — superseding a flow does not
 * remove what it wrote (`~/lib/git/legacy-credentials`).
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { bootedProjectId, requireBootedSandbox, SANDBOX_REQUIRES_PROJECT } from '~/lib/sandbox';
import type { SandboxProvider } from '~/lib/sandbox';
import { NO_ROLLBACK, openImportWorkspace } from '~/lib/registry/import-project';
import { clearWorkspace } from '~/lib/registry/clear-workspace';
import git, { type PromiseFsClient } from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import { toast } from 'react-toastify';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('useGit');

/**
 * What to call the project a clone creates: the repository's own name.
 *
 * Deliberately tolerant — a URL that does not parse still yields something a person recognises,
 * because a bad name is never a reason to refuse someone an import.
 */
export const repoNameOf = (url: string): string => {
  const withoutRef = url.split('#')[0].replace(/\/+$/, '');
  const last = withoutRef.split('/').pop() ?? '';

  return last.replace(/\.git$/i, '') || 'Imported Repository';
};

export function useGit() {
  const [ready, setReady] = useState(false);
  const [sandbox, setSandbox] = useState<SandboxProvider>();
  const [fs, setFs] = useState<PromiseFsClient>();
  const fileData = useRef<Record<string, { data: any; encoding?: string }>>({});
  useEffect(() => {
    /*
     * 🔴 A clone runs from the landing page, before any project exists — and on a runtime whose
     * sandbox belongs to a project there is nothing to await here yet. Awaiting the seam anyway is how
     * this used to sit pending forever with `ready` false and nothing to explain it.
     *
     * So on that runtime the hook is ready IMMEDIATELY and acquires its workspace when the user
     * actually clones: `openImportWorkspace` registers the project and boots the sandbox for it, which
     * is the shape a creation already has. Anything else — WebContainer, or a clone started from
     * inside an open project — keeps the eager await it has always had.
     */
    if (SANDBOX_REQUIRES_PROJECT && !bootedProjectId()) {
      setReady(true);
      return;
    }

    requireBootedSandbox()
      .then((container) => {
        fileData.current = {};
        setSandbox(container);
        setFs(getFs(container, fileData));
        setReady(true);
      })
      .catch((error) => logger.warn(`Git is unavailable here: ${(error as Error).message}`));
  }, []);

  const gitClone = useCallback(
    async (url: string, retryCount = 0) => {
      if (!ready) {
        throw new Error('The project sandbox is not initialized. Please try again later.');
      }

      /*
       * Deferred acquisition (see the effect). On the eager path these are already set and this is a
       * no-op; on a project-backed runtime this is where the project is registered and its VM booted.
       * A failure throws with the reason — never a spinner that runs out the clock.
       */
      let activeSandbox = sandbox;
      let activeFs = fs;
      let workspaceProjectId = bootedProjectId();

      /*
       * Undo the registration if the clone below fails — a project this hook created a moment ago and
       * never filled is an empty card on the dashboard and a VM billing by the second. A no-op when
       * this call registered nothing (the eager path, or a clone from inside an open project), which
       * is what keeps a retry from deleting the project the first attempt legitimately created.
       */
      let rollback = NO_ROLLBACK;

      /*
       * Did THIS call register the workspace? It decides whether the tree may be cleared below, so it
       * is tracked explicitly rather than inferred from `rollback !== NO_ROLLBACK` — a later edit that
       * changed how rollback is assigned would silently re-point a destructive operation.
       */
      let ownsWorkspace = false;

      if (!activeSandbox || !activeFs) {
        const workspace = await openImportWorkspace({ name: repoNameOf(url) });
        activeSandbox = workspace.sandbox;
        activeFs = getFs(workspace.sandbox, fileData);
        workspaceProjectId = workspace.projectId;
        rollback = workspace.rollback;
        ownsWorkspace = Boolean(workspace.projectId);

        setSandbox(activeSandbox);
        setFs(activeFs);
      }

      fileData.current = {};

      /*
       * 🔴 A clone needs an EMPTY directory, and on a server sandbox the workspace it was just handed
       * is a fork of the starter template — files, node_modules and the starter's own `.git`. Measured
       * live: `git.clone` died on `AlreadyExistsError: Failed to create remote at origin because it
       * already exists`, so "Clone a repo" from the landing page failed 100% of the time on this
       * provider. `clear-workspace.ts` explains why only `.git` is not enough.
       *
       * Guarded by `ownsWorkspace`: a clone started from INSIDE an open project writes into that
       * project, and clearing there would delete the user's game.
       */
      if (ownsWorkspace) {
        await clearWorkspace(activeSandbox, { owned: true });
      }

      let branch: string | undefined;
      let baseUrl = url;

      if (url.includes('#')) {
        [baseUrl, branch] = url.split('#');
      }

      /*
       * Skip Git initialization for now - let isomorphic-git handle it
       * This avoids potential issues with our manual initialization
       */

      /*
       * No `Authorization` header, and no way to acquire one here. The credential this used to read
       * came out of a `git:<domain>` cookie written by a `window.prompt` — see the module header.
       */
      const headers: {
        [x: string]: string;
      } = {
        'User-Agent': 'bolt.diy',
      };

      /*
       * The clone below is the LAST thing that can fail, and until now it failed with a project
       * already registered — a typo'd URL or a rejected credential left an empty card on the
       * dashboard and a VM billing by the second (T3b). The inner block owns retries and messaging;
       * this one owns the undo. A retry that succeeds never reaches here.
       */
      try {
        try {
          // Add a small delay before retrying to allow for network recovery
          if (retryCount > 0) {
            await new Promise((resolve) => setTimeout(resolve, 1000 * retryCount));
            console.log(`Retrying git clone (attempt ${retryCount + 1})...`);
          }

          await git.clone({
            fs: activeFs,
            http,
            dir: activeSandbox.workdir,
            url: baseUrl,
            depth: 1,
            singleBranch: true,
            ref: branch,
            corsProxy: '/api/git-proxy',
            headers,
            onProgress: (event) => {
              console.log('Git clone progress:', event);
            },

            /*
             * 🔴 CANCEL, never a prompt. This is the callback that used to `confirm()` and then
             * `prompt()` for a username and a personal access token; a private repository is now the
             * server's job, with the token the user already authorized (`git/clone.ts`).
             *
             * `{ cancel: true }` rather than a thrown error because isomorphic-git treats a cancel as
             * a clean refusal and surfaces it as one, where a throw from inside `onAuth` becomes an
             * opaque transport failure that the retry logic below would then re-attempt three times.
             */
            onAuth: () => ({ cancel: true }),

            /*
             * ⚠️ NO `onAuthFailure`. isomorphic-git only calls it when credentials were SUPPLIED and
             * then rejected (`providedAuthBefore ? onAuthFailure : onAuth`); cancelling means it never
             * runs at all, and the clone rejects with `UserCanceledError` instead. A first draft of
             * this change put a carefully-worded "connect your account" sentence there — dead code
             * that could never be shown, with a module header claiming it would be. The message the
             * user would actually get is handled in the catch below, where the cancel really lands.
             */
          });

          const data: Record<string, { data: any; encoding?: string }> = {};

          for (const [key, value] of Object.entries(fileData.current)) {
            data[key] = value;
          }

          /*
           * `projectId` rides out with the files. The caller puts it on the imported chat's metadata:
           * the import ends in a full page load of `/chat/<id>`, and that pointer is the only thing that
           * will boot THIS sandbox again rather than leaving the clone stranded on a VM nothing names.
           */
          return { workdir: activeSandbox.workdir, data, projectId: workspaceProjectId };
        } catch (error) {
          console.error('Git clone error:', error);

          // Handle specific error types
          const errorMessage = error instanceof Error ? error.message : String(error);

          /*
           * The cancel from `onAuth` above — what a private repository now produces on this path.
           * isomorphic-git's own wording for it is "The operation was canceled", which tells a user
           * nothing and reads as the button having failed; the actionable sentence is that the
           * repository needs a connected account, so it is said here, where the error actually lands.
           */
          if (error instanceof Error && error.name === 'UserCanceledError') {
            const message = 'That repository needs a connected account to read. Connect it in Settings and try again.';

            toast.error(message);
            throw new Error(message);
          }

          // Check for common error patterns
          if (errorMessage.includes('Authentication failed')) {
            toast.error(`Authentication failed. Please check your GitHub credentials and try again.`);
            throw error;
          } else if (
            errorMessage.includes('ENOTFOUND') ||
            errorMessage.includes('ETIMEDOUT') ||
            errorMessage.includes('ECONNREFUSED')
          ) {
            toast.error(`Network error while connecting to repository. Please check your internet connection.`);

            // Retry for network errors, up to 3 times
            if (retryCount < 3) {
              return gitClone(url, retryCount + 1);
            }

            throw new Error(
              `Failed to connect to repository after multiple attempts. Please check your internet connection.`,
            );
          } else if (errorMessage.includes('404')) {
            toast.error(`Repository not found. Please check the URL and make sure the repository exists.`);
            throw new Error(`Repository not found. Please check the URL and make sure the repository exists.`);
          } else if (errorMessage.includes('401')) {
            toast.error(
              `Unauthorized access to repository. Please connect your GitHub account with proper permissions.`,
            );
            throw new Error(
              `Unauthorized access to repository. Please connect your GitHub account with proper permissions.`,
            );
          } else {
            toast.error(`Failed to clone repository: ${errorMessage}`);
            throw error;
          }
        }
      } catch (error) {
        await rollback();
        throw error;
      }
    },
    [sandbox, fs, ready],
  );

  return { ready, gitClone };
}

const getFs = (
  sandbox: SandboxProvider,
  record: MutableRefObject<Record<string, { data: any; encoding?: string }>>,
) => ({
  promises: {
    readFile: async (path: string, options: any) => {
      const encoding = options?.encoding;
      const relativePath = pathUtils.relative(sandbox.workdir, path);

      try {
        const result = await sandbox.fs.readFile(relativePath, encoding);

        return result;
      } catch (error) {
        throw error;
      }
    },
    writeFile: async (path: string, data: any, options: any = {}) => {
      const relativePath = pathUtils.relative(sandbox.workdir, path);

      if (record.current) {
        record.current[relativePath] = { data, encoding: options?.encoding };
      }

      try {
        // Handle encoding properly based on data type
        if (data instanceof Uint8Array) {
          // For binary data, don't pass encoding
          const result = await sandbox.fs.writeFile(relativePath, data);
          return result;
        } else {
          // For text data, use the encoding if provided
          const encoding = options?.encoding || 'utf8';
          const result = await sandbox.fs.writeFile(relativePath, data, encoding);

          return result;
        }
      } catch (error) {
        throw error;
      }
    },
    mkdir: async (path: string, options: any) => {
      const relativePath = pathUtils.relative(sandbox.workdir, path);

      try {
        const result = await sandbox.fs.mkdir(relativePath, { ...options, recursive: true });

        return result;
      } catch (error) {
        throw error;
      }
    },
    readdir: async (path: string, options: any) => {
      const relativePath = pathUtils.relative(sandbox.workdir, path);

      try {
        const result = await sandbox.fs.readdir(relativePath, options);

        return result;
      } catch (error) {
        throw error;
      }
    },
    rm: async (path: string, options: any) => {
      const relativePath = pathUtils.relative(sandbox.workdir, path);

      try {
        const result = await sandbox.fs.rm(relativePath, { ...(options || {}) });

        return result;
      } catch (error) {
        throw error;
      }
    },
    rmdir: async (path: string, options: any) => {
      const relativePath = pathUtils.relative(sandbox.workdir, path);

      try {
        const result = await sandbox.fs.rm(relativePath, { recursive: true, ...options });

        return result;
      } catch (error) {
        throw error;
      }
    },
    unlink: async (path: string) => {
      const relativePath = pathUtils.relative(sandbox.workdir, path);

      try {
        return await sandbox.fs.rm(relativePath, { recursive: false });
      } catch (error) {
        throw error;
      }
    },
    stat: async (path: string) => {
      try {
        const relativePath = pathUtils.relative(sandbox.workdir, path);
        const dirPath = pathUtils.dirname(relativePath);
        const fileName = pathUtils.basename(relativePath);

        // Special handling for .git/index file
        if (relativePath === '.git/index') {
          return {
            isFile: () => true,
            isDirectory: () => false,
            isSymbolicLink: () => false,
            size: 12, // Size of our empty index
            mode: 0o100644, // Regular file
            mtimeMs: Date.now(),
            ctimeMs: Date.now(),
            birthtimeMs: Date.now(),
            atimeMs: Date.now(),
            uid: 1000,
            gid: 1000,
            dev: 1,
            ino: 1,
            nlink: 1,
            rdev: 0,
            blksize: 4096,
            blocks: 1,
            mtime: new Date(),
            ctime: new Date(),
            birthtime: new Date(),
            atime: new Date(),
          };
        }

        const resp = await sandbox.fs.readdir(dirPath, { withFileTypes: true });
        const fileInfo = resp.find((x) => x.name === fileName);

        if (!fileInfo) {
          const err = new Error(`ENOENT: no such file or directory, stat '${path}'`) as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          err.errno = -2;
          err.syscall = 'stat';
          err.path = path;
          throw err;
        }

        return {
          isFile: () => fileInfo.isFile(),
          isDirectory: () => fileInfo.isDirectory(),
          isSymbolicLink: () => false,
          size: fileInfo.isDirectory() ? 4096 : 1,
          mode: fileInfo.isDirectory() ? 0o040755 : 0o100644, // Directory or regular file
          mtimeMs: Date.now(),
          ctimeMs: Date.now(),
          birthtimeMs: Date.now(),
          atimeMs: Date.now(),
          uid: 1000,
          gid: 1000,
          dev: 1,
          ino: 1,
          nlink: 1,
          rdev: 0,
          blksize: 4096,
          blocks: 8,
          mtime: new Date(),
          ctime: new Date(),
          birthtime: new Date(),
          atime: new Date(),
        };
      } catch (error: any) {
        if (!error.code) {
          error.code = 'ENOENT';
          error.errno = -2;
          error.syscall = 'stat';
          error.path = path;
        }

        throw error;
      }
    },
    lstat: async (path: string) => {
      return await getFs(sandbox, record).promises.stat(path);
    },
    readlink: async (path: string) => {
      throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
    },
    symlink: async (target: string, path: string) => {
      /*
       * Since WebContainer doesn't support symlinks,
       * we'll throw a "operation not supported" error
       */
      throw new Error(`EPERM: operation not permitted, symlink '${target}' -> '${path}'`);
    },

    chmod: async (_path: string, _mode: number) => {
      /*
       * WebContainer doesn't support changing permissions,
       * but we can pretend it succeeded for compatibility
       */
      return await Promise.resolve();
    },
  },
});

const pathUtils = {
  dirname: (path: string) => {
    // Handle empty or just filename cases
    if (!path || !path.includes('/')) {
      return '.';
    }

    // Remove trailing slashes
    path = path.replace(/\/+$/, '');

    // Get directory part
    return path.split('/').slice(0, -1).join('/') || '/';
  },

  basename: (path: string, ext?: string) => {
    // Remove trailing slashes
    path = path.replace(/\/+$/, '');

    // Get the last part of the path
    const base = path.split('/').pop() || '';

    // If extension is provided, remove it from the result
    if (ext && base.endsWith(ext)) {
      return base.slice(0, -ext.length);
    }

    return base;
  },
  relative: (from: string, to: string): string => {
    // Handle empty inputs
    if (!from || !to) {
      return '.';
    }

    // Normalize paths by removing trailing slashes and splitting
    const normalizePathParts = (p: string) => p.replace(/\/+$/, '').split('/').filter(Boolean);

    const fromParts = normalizePathParts(from);
    const toParts = normalizePathParts(to);

    // Find common parts at the start of both paths
    let commonLength = 0;
    const minLength = Math.min(fromParts.length, toParts.length);

    for (let i = 0; i < minLength; i++) {
      if (fromParts[i] !== toParts[i]) {
        break;
      }

      commonLength++;
    }

    // Calculate the number of "../" needed
    const upCount = fromParts.length - commonLength;

    // Get the remaining path parts we need to append
    const remainingPath = toParts.slice(commonLength);

    // Construct the relative path
    const relativeParts = [...Array(upCount).fill('..'), ...remainingPath];

    // Handle empty result case
    return relativeParts.length === 0 ? '.' : relativeParts.join('/');
  },
};
