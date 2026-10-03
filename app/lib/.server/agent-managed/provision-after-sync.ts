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
import {
  type ProvisionOptions,
  type ProvisionResult,
  provisionManagedAgent,
  provisionManagedAgents,
} from './provision';
import { env } from '~/lib/.server/env';
import { ALERT_SIGNALS, getMonitor } from '~/lib/.server/monitoring';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('managed-provision');

/** One rung's line in the outcome: what happened to its agent, or why it failed. */
export interface ManagedTierOutcome {
  tier: string;
  label: string;
  model: string;
  status?: ProvisionResult['status'];
  agentId?: string;
  agentVersion?: number;
  error?: string;
}

/**
 * What the sync response reports about the managed agents. The top-level fields are the STANDARD rung's
 * (what the panel has always shown); `tiers` lists every rung — Standard, Premium, Platinum — because
 * each is its own agent and a paid rung that failed to provision must be visible, not averaged away.
 */
export type ManagedProvisionOutcome =
  | {
      status: ProvisionResult['status'];
      agentId: string;
      agentVersion: number;
      promptVersionId: string;
      tiers: ManagedTierOutcome[];
    }
  | { skipped: 'not-configured' }
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

  try {
    const results = await provisionManagedAgents({ context }, testProvisioner ?? provisionManagedAgent);
    const tiers: ManagedTierOutcome[] = results.map((row) => ({
      tier: row.tier,
      label: row.label,
      model: row.model,
      ...(row.result
        ? { status: row.result.status, agentId: row.result.agentId, agentVersion: row.result.agentVersion }
        : { error: row.error }),
    }));

    for (const row of results) {
      if (row.result && row.result.status !== 'unchanged') {
        logger.info(
          `Managed ${row.label} agent ${row.result.status} after sync: ${row.result.agentId} v${row.result.agentVersion}`,
        );
      }
    }

    const failed = results.filter((row) => row.error);

    if (failed.length > 0) {
      getMonitor(context).alert(
        ALERT_SIGNALS.DOCSYNC_BUILD_FAILURE,
        `The prompt synced, but provisioning ${failed.map((row) => `the ${row.label} agent (${row.model}): ${row.error}`).join('; ')}`,
        { severity: 'warning', scope: 'managed-provision' },
      );
    }

    const standard = results[0];

    if (!standard?.result) {
      return { error: standard?.error ?? 'No model tier could be provisioned.' };
    }

    return {
      status: standard.result.status,
      agentId: standard.result.agentId,
      agentVersion: standard.result.agentVersion,
      promptVersionId: standard.result.promptVersionId,
      tiers,
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
