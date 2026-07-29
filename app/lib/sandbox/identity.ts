/**
 * Whose project is this sandbox holding? (`spec/sandbox-codesandbox.md` §11 C1.)
 *
 * A byte on disk that names the project, read before the warm-boot gate decides the live filesystem
 * outranks every client-held copy. With per-project VMs (migration 0013) a mismatch should never
 * happen — which is the point: this is what stands between a MIS-POINTED `sandbox_id` (an operator
 * edit, a restored old row, a compare-and-set that lost) and the platform silently adopting another
 * project's files as this project's truth, then pushing them to this project's repository.
 *
 * Both functions are best-effort by construction, and their failure directions are deliberately
 * OPPOSITE. A read that fails answers `unknown` (never `mismatch`): a sandbox created before the
 * sentinel existed makes no claim, and treating "no claim" as "wrong project" would send every warm
 * VM down the restore-from-a-client-copy path the gate exists to avoid. A write that fails is
 * logged and swallowed: the sentinel is defense in depth, and refusing to open a project because a
 * marker file could not be written would turn insurance into an outage.
 */
import { SANDBOX_IDENTITY_DIR, SANDBOX_IDENTITY_PATH, identitySentinel, readIdentityVerdict } from './boot-decisions';
import type { SandboxProvider } from './types';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('sandbox-identity');

export type SandboxIdentityVerdict = 'match' | 'mismatch' | 'unknown';

/** What the sandbox on the other end of `provider` claims about which project it holds. */
export async function readSandboxIdentity(
  provider: SandboxProvider,
  projectId: string,
): Promise<SandboxIdentityVerdict> {
  try {
    const raw = await provider.fs.readFile(SANDBOX_IDENTITY_PATH, 'utf8');

    return readIdentityVerdict(raw, projectId);
  } catch {
    // Absent, unreadable, or a provider without the file — no claim, so no verdict.
    return 'unknown';
  }
}

/**
 * Record which project this sandbox belongs to.
 *
 * Written on every successful mount, not only at creation, so the sandboxes that predate the sentinel
 * acquire one the first time they are opened rather than staying permanently unverifiable.
 *
 * ⚠️ Must run AFTER {@link readSandboxIdentity} on the same mount. Writing first makes the check
 * trivially pass and turns the whole mechanism into a no-op that looks like it is working.
 */
export async function writeSandboxIdentity(provider: SandboxProvider, projectId: string): Promise<void> {
  try {
    await provider.fs.mkdir(SANDBOX_IDENTITY_DIR, { recursive: true });
    await provider.fs.writeFile(SANDBOX_IDENTITY_PATH, identitySentinel(projectId));
  } catch (error) {
    logger.warn(`Could not record the project sentinel in the sandbox: ${(error as Error)?.message}`);
  }
}
