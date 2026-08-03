/**
 * Self-serve account deletion (SPEC §4.5.1).
 *
 * The most destructive action a user can take in this product, and the only one with no undo — so it
 * follows the same rule as every other irreversible path here: the DECISION is a pure, exhaustively
 * tested function, and the execution is ordered so that a failure anywhere leaves a state somebody can
 * still recover from.
 *
 * ## The order, and why it is that order
 *
 * 1. **Every project, through the shared reaper** (`purgeProject`). Published build, remix seed,
 *    conversation, working copy, VM, row.
 * 2. **Git tokens.** The one credential we hold on the user's behalf.
 * 3. **The auth user** — which cascades `profiles`, `entitlements`, `asset_entitlements`,
 *    `unity_license_entitlements`.
 *
 * 🔴 **The identity goes LAST, and a failed purge ABORTS before it.** The user id is the only handle on
 * everything above: `projects.user_id` is how their projects are found, and each project id is how its
 * bytes are found. Delete the identity first (or carry on past a failed purge) and whatever survives is
 * orphaned — unreachable by the user, unreachable by support, and still ours after they were told it
 * was gone. That is the `delete-leaves-nothing` lesson at account scale, and here it is unrecoverable
 * rather than merely embarrassing.
 *
 * ## What is deliberately KEPT
 *
 * The **credit ledger** and the **generations** record: the financial and cost history (§4.5.1,
 * migration 0017). They stop pointing at a person the moment `auth.users` goes — that is the
 * "disassociated from PII" half — but the rows survive, because a purchase we took money for must not
 * vanish from the books, and §4.10's margin reports must not silently shrink every time somebody
 * leaves.
 *
 * ## Not soft-delete
 *
 * §4.5.1 said "soft-deleted then purged on schedule". That was written when the platform stored
 * snapshots of everyone's projects; under repo-primary persistence (§4.5.4b) we hold a project row, a
 * conversation and one recovery buffer, so an immediate purge is both achievable and stronger. A
 * scheduled purger is machinery that has to exist, run, and be monitored — and a purge that silently
 * stops running looks exactly like a purge that worked. Deviation recorded in SPEC §4.5.1.
 */
import { getProjectStore } from '~/lib/.server/projects/store';
import { purgeProject } from '~/lib/.server/projects/purge';
import { getGitTokenStore } from '~/lib/.server/git/token-store';
import { createAdminClient, isSupabaseConfigured } from '~/lib/.server/supabase/client';
import { getMonitor } from '~/lib/.server/monitoring';
import { createScopedLogger } from '~/utils/logger';
import type { AuthUser } from '~/lib/.server/supabase/auth';

const logger = createScopedLogger('account.delete');

/** Refusals a caller may show verbatim — registered in `http.ts`'s `SAFE_ERRORS`. */
export class AccountDeletionError extends Error {
  readonly statusCode: number;
  readonly isRetryable = false;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'AccountDeletionError';
    this.statusCode = statusCode;
  }
}

export interface DeletionRequest {
  /** What the user typed into the confirmation field. Must match their own email. */
  confirmation: unknown;

  /** The verified session's email — server-side, never from the body. */
  email: string;

  /** False in local mode: there is no account to delete (§4.5). */
  accountsEnabled: boolean;
}

export type DeletionDecision = { ok: true } | { ok: false; status: number; message: string };

/**
 * May this deletion proceed? Pure, so it can be tested exhaustively (`delete-account.spec.ts`).
 *
 * The confirmation is a **typed email**, not a checkbox or an `Are you sure?` dialog, for one reason:
 * this action is indistinguishable from an accident right up until it is irreversible. Matching is
 * case-insensitive and trims surrounding whitespace — an address pasted from a password manager
 * arriving with a trailing space is not a different person, and refusing it teaches the user to
 * retype rather than to reconsider.
 */
export function decideAccountDeletion(request: DeletionRequest): DeletionDecision {
  if (!request.accountsEnabled) {
    return {
      ok: false,
      status: 503,
      message:
        'Accounts are not configured on this server — there is no account to delete. ' +
        'You are signed in as the local developer.',
    };
  }

  if (typeof request.confirmation !== 'string' || request.confirmation.trim().length === 0) {
    return { ok: false, status: 400, message: 'Type your email address to confirm.' };
  }

  const typed = request.confirmation.trim().toLowerCase();
  const actual = (request.email ?? '').trim().toLowerCase();

  /*
   * An empty session email cannot be matched by anything. Refuse rather than let `'' === ''` through:
   * an account we cannot name is one we should not be irreversibly deleting on a typed confirmation.
   */
  if (!actual) {
    return { ok: false, status: 400, message: 'We could not confirm which account this is. Sign in again and retry.' };
  }

  if (typed !== actual) {
    return { ok: false, status: 400, message: 'That does not match the email on this account.' };
  }

  return { ok: true };
}

export interface DeletionResult {
  projectsDeleted: number;
}

/**
 * Execute the deletion. Assumes `decideAccountDeletion` has already said yes.
 *
 * Throws on the first failure that would leave orphaned bytes — the caller reports it and the user can
 * retry, which is safe because every step is idempotent (deleting an absent object is a no-op, and a
 * project already purged is simply not in the list on the second pass).
 */
export async function deleteAccount(user: AuthUser, context?: unknown): Promise<DeletionResult> {
  const projects = await getProjectStore(context).listByUser(user.id);

  /*
   * Sequential, not `Promise.all`. Each purge reaps a VM and walks object storage; firing all of them
   * at once at a provider is how a user with thirty projects gets rate-limited into a half-deleted
   * account. Slower is fine here — nothing is waiting on it but a confirmation dialog.
   */
  for (const project of projects) {
    /*
     * `refundCreation: false` — a refund credits a ledger belonging to a user who is about to stop
     * existing. It moves no money anyone can spend, and it appends new rows to the financial record at
     * the exact moment we are closing it.
     */
    await purgeProject(project, { userId: user.id, context, refundCreation: false });
  }

  /*
   * The credential. Before the identity, like everything else — but ALSO the one item here whose
   * survival is a security problem rather than a tidiness problem: an encrypted OAuth token for
   * somebody's GitHub account, held by a platform they have just left.
   */
  const tokens = getGitTokenStore(context);

  for (const record of await tokens.listByUser(user.id)) {
    await tokens.delete(user.id, record.provider);
  }

  /*
   * Last. This cascades `profiles`, `entitlements`, `asset_entitlements` and
   * `unity_license_entitlements`; migration 0017 detached `credit_ledger` and `generations` so the
   * financial and cost record survives it (§4.5.1).
   */
  if (isSupabaseConfigured(context)) {
    const admin = await createAdminClient(context);
    const { error } = await admin.auth.admin.deleteUser(user.id);

    if (error) {
      /*
       * LOUD (`spec/fail-loud.md`). Everything the user owned is already gone, so reporting success
       * here would be *nearly* true — and that is exactly the state that never gets fixed: an account
       * that can still sign in, owns nothing, and that nobody knows is broken.
       */
      logger.error(`Purged ${user.id}'s data but could not delete the auth user: ${error.message}`);
      getMonitor(context).captureException(error, { scope: 'account.delete-auth-user', userId: user.id });

      throw new AccountDeletionError(
        'Your projects were deleted, but we could not close the account itself. ' +
          'Please try again — if it keeps failing, contact support.',
        500,
      );
    }
  }

  logger.info(`Deleted account ${user.id} and ${projects.length} project(s)`);

  return { projectsDeleted: projects.length };
}
