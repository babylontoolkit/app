/**
 * Provision the managed agent right after a Synchronize (`_specs/managed-agents-engine_plan.md` T12).
 *
 * Before T12 a Synchronize "wanted a Provision after it": an admin had to press a second button, and
 * until they did, managed turns kept reading the PREVIOUS prompt version's docs — working, quietly stale,
 * nothing reporting it. With `managed` the default engine that gap is every deploy's gap, so the sync
 * route now provisions as its last step.
 *
 * Three properties, each silent if lost:
 *
 *   - **Best-effort.** The sync has already activated the new prompt version by the time this runs; a
 *     provisioning failure (Anthropic down, a GitHub read refused) must NOT turn that success into a 500,
 *     or the admin retries a sync that worked. The failure is RETURNED (the Admin panel shows it) and
 *     ALERTED (`scope: 'managed-provision'`) — never swallowed, never thrown.
 *   - **Cheap when nothing moved.** `provisionManagedAgent` is hash-skipped: an unchanged input makes zero
 *     Anthropic calls, so running it after every sync costs a local hash.
 *   - **Only where it applies.** No Anthropic key, or a deploy on the legacy engine → not called at all
 *     (`skipped`), so a legacy deploy never mints agents it will not use. The Provision button stays for a
 *     manual or forced run either way.
 */
import { resolveAgentEngine } from './config';
import { type ProvisionOptions, type ProvisionResult, provisionManagedAgent } from './provision';
import { env } from '~/lib/.server/env';
import { ALERT_SIGNALS, getMonitor } from '~/lib/.server/monitoring';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('managed-provision');

/** What the sync response reports about the managed agent. */
export type ManagedProvisionOutcome =
  | { status: ProvisionResult['status']; agentId: string; agentVersion: number; promptVersionId: string }
  | { skipped: 'not-configured' | 'legacy-engine' }
  | { error: string };

type Provisioner = (options: ProvisionOptions) => Promise<ProvisionResult>;

let testProvisioner: Provisioner | undefined;

/** Specs replace the provisioner so nothing reaches Anthropic or GitHub. */
export function setSyncProvisionerForTests(provisioner: Provisioner | undefined): void {
  testProvisioner = provisioner;
}

export async function provisionAfterSync(context: unknown): Promise<ManagedProvisionOutcome> {
  if (!env(context, 'ANTHROPIC_API_KEY')) {
    return { skipped: 'not-configured' };
  }

  if (resolveAgentEngine(context) !== 'managed') {
    return { skipped: 'legacy-engine' };
  }

  try {
    const result = await (testProvisioner ?? provisionManagedAgent)({ context });

    if (result.status !== 'unchanged') {
      logger.info(`Managed agent ${result.status} after sync: ${result.agentId} v${result.agentVersion}`);
    }

    return {
      status: result.status,
      agentId: result.agentId,
      agentVersion: result.agentVersion,
      promptVersionId: result.promptVersionId,
    };
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    logger.error(`Provisioning after sync failed: ${message}`);

    getMonitor(context).alert(
      ALERT_SIGNALS.DOCSYNC_BUILD_FAILURE,
      `The prompt synced, but provisioning the managed agent failed: ${message}`,
      { severity: 'warning', scope: 'managed-provision' },
    );

    return { error: message };
  }
}
