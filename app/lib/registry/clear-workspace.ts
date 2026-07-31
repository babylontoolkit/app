/**
 * Empty a freshly-registered import workspace before a clone writes into it (found live 2026-07-31).
 *
 * ## Why this exists
 *
 * On WebContainer an import began in an EMPTY runtime, so `git.clone` had a clean directory and nobody
 * ever had to think about this. On a server sandbox the workspace is a FORK of the starter template —
 * a full project tree with `node_modules`, a dev server, and the starter's own `.git`. Cloning into
 * that failed on the first thing isomorphic-git does after `init`:
 *
 *   AlreadyExistsError: Failed to create remote at origin because it already exists.
 *
 * So "Clone a repo" from the landing page could never work on this provider — it created the project,
 * booted the VM, then died, rolled the project back, and left the user with a toast. (The MEASURED
 * sequence: `POST /api/projects` 201 → `POST /api/sandbox/session` 200 → AlreadyExistsError →
 * `DELETE /api/projects/:id` 200.)
 *
 * Deleting only `.git` would clear that error and be worse than useless: the starter's `src/babylon/`,
 * its `package.json` and its dev-server config would survive underneath a stranger's repository, so
 * the user would "import" a project that is partly somebody else's. An import must produce the
 * repository that was imported.
 *
 * ## 🔴 It is only ever called for a workspace this import REGISTERED
 *
 * The same `gitClone` runs from inside an already-open project, where the workspace holds the user's
 * game. Wiping there would delete it. The caller passes `owned` — true only when
 * `openImportWorkspace` created the project on this call — and that flag is the whole safety argument:
 * this function has no way to tell the two apart by itself, and guessing would be unrecoverable.
 */
import type { SandboxProvider } from '~/lib/sandbox';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('ClearWorkspace');

/**
 * Never removed, whoever asks.
 *
 * `.codesandbox/` is the VM's own configuration (tasks, the dev-server definition, the ports the
 * platform mints preview URLs for). It is infrastructure, not project content — removing it breaks the
 * sandbox the import is being written into, which is a failure the user cannot understand or fix.
 */
const PROTECTED_ENTRIES = new Set(['.codesandbox']);

export interface ClearWorkspaceResult {
  removed: string[];
  failed: Array<{ path: string; reason: string }>;
}

/**
 * Remove every top-level entry from the sandbox workdir except the protected ones.
 *
 * `node_modules` IS removed: it belongs to the starter, and leaving it means the imported repo's first
 * `npm install` resolves against a tree of another project's dependencies — wrong versions that appear
 * to work. The import flow runs `npm install` anyway (`detectProjectCommands`), so the cost is time,
 * and the alternative is a silently wrong dependency graph.
 *
 * Best-effort per entry, and it REPORTS rather than throws: a workspace we could not fully clear is
 * still one a clone can usually write into, and failing the import over a stubborn temp file would
 * trade a working clone for none. The caller decides what to do with `failed`.
 */
export async function clearWorkspace(
  sandbox: SandboxProvider,
  options: { owned: boolean },
): Promise<ClearWorkspaceResult> {
  const result: ClearWorkspaceResult = { removed: [], failed: [] };

  /*
   * 🔴 The guard, not an optimisation. A clone started from inside an open project writes into the
   * project the user is looking at, and that workspace is their game.
   */
  if (!options.owned) {
    return result;
  }

  const workdir = sandbox.workdir;
  const entries = await sandbox.fs.readdir(workdir, { withFileTypes: true });

  for (const entry of entries) {
    if (PROTECTED_ENTRIES.has(entry.name)) {
      continue;
    }

    const target = `${workdir}/${entry.name}`;

    try {
      await sandbox.fs.rm(target, { recursive: true, force: true });
      result.removed.push(entry.name);
    } catch (error) {
      result.failed.push({ path: entry.name, reason: (error as Error).message });
    }
  }

  if (result.failed.length > 0) {
    logger.warn(`Could not clear ${result.failed.map((f) => f.path).join(', ')} before the import.`);
  }

  logger.info(`Cleared ${result.removed.length} entries from ${workdir} for an import.`);

  return result;
}
