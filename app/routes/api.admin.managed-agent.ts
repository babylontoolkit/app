/**
 * Managed Agents provisioning admin endpoint (`_specs/managed-agents-engine_plan.md` T3).
 *
 *   GET  /api/admin/managed-agent            → which agent each model tier runs on (or "not configured")
 *   POST /api/admin/managed-agent provision  → create/update every tier's agent from the active prompt version
 *
 * One agent per rung of the model tier ladder (§4.6.1a): Standard `LLM_MODEL`, Premium `PREMIUM_MODEL`,
 * Platinum `PLATINUM_MODEL`. The top-level fields stay the Standard rung's; `tiers` lists every rung.
 *
 * Admin session only (`requireAdmin`), like the template and prompt admin surfaces: provisioning decides
 * the instructions and tools every managed generation runs with, so an open endpoint would be a remote
 * takeover of the agent. Not configured (no `ANTHROPIC_API_KEY`, no prompt version yet) is a 503 with
 * the sentence that says what to set — never a crash.
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireAdmin } from '~/lib/.server/supabase/auth';
import { errorResponse } from '~/lib/.server/http';
import { resolveAgentEngine } from '~/lib/.server/agent-managed/config';
import {
  getManagedAgentStatus,
  managedTierModels,
  provisionManagedAgents,
  type ManagedAgentStatus,
} from '~/lib/.server/agent-managed/provision';
import { ensureMarketPrices, LLM_PRICE_PROVIDERS } from '~/lib/.server/billing/market-price-store';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.admin.managed-agent');

function describeAgent(status: ManagedAgentStatus) {
  return status.record
    ? {
        agentId: status.record.agentId,
        agentVersion: status.record.agentVersion,
        environmentId: status.record.environmentId,
        referenceSha: status.record.referenceSha,
        referenceFiles: status.record.referenceFiles.length,
        skills: status.record.skills.map((skill) => skill.name),
        provisionedAt: status.record.provisionedAt,
      }
    : null;
}

function isCoded(error: unknown): boolean {
  return typeof (error as { statusCode?: unknown })?.statusCode === 'number';
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    await requireAdmin(request, context);
  } catch (error) {
    return errorResponse(error);
  }

  const engine = resolveAgentEngine(context);

  try {
    await Promise.all(LLM_PRICE_PROVIDERS.map((provider) => ensureMarketPrices(provider, context)));

    const status = await getManagedAgentStatus(context);
    const tiers = await Promise.all(
      managedTierModels(context).map(async (rung) => {
        const tierStatus = await getManagedAgentStatus(context, rung.model);

        return { ...rung, key: tierStatus.key, current: tierStatus.current, agent: describeAgent(tierStatus) };
      }),
    );

    return json({
      configured: true,
      engine,
      key: status.key,
      activeVersionId: status.activeVersionId,
      current: status.current,
      agent: describeAgent(status),
      tiers,
    });
  } catch (error) {
    if ((error as Error)?.name === 'NotConfiguredError') {
      // A state the panel renders, not a failure: the loader answers 200 so the rest of Admin loads.
      return json({ configured: false, engine, message: (error as Error).message });
    }

    return errorResponse(error);
  }
}

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    await requireAdmin(request, context);

    const body = await request.json<{ action?: string; force?: boolean }>().catch(() => ({}) as { action?: string });

    if (body.action !== 'provision') {
      return json({ error: true, message: `Unknown action: ${String(body.action)}` }, { status: 400 });
    }

    await Promise.all(LLM_PRICE_PROVIDERS.map((provider) => ensureMarketPrices(provider, context)));

    const results = await provisionManagedAgents({ context, force: (body as { force?: boolean }).force === true });
    const tiers = results.map((row) => ({
      tier: row.tier,
      label: row.label,
      model: row.model,
      ...(row.result
        ? { status: row.result.status, agentId: row.result.agentId, agentVersion: row.result.agentVersion }
        : { error: row.error }),
    }));
    const standard = results[0]?.result;

    if (!standard) {
      const message = results[0]?.error ?? 'No model tier could be provisioned.';
      logger.error(`Provisioning failed: ${message}`);

      return json({ error: true, message: `Provisioning failed: ${message}`, tiers }, { status: 502 });
    }

    return json({ ok: true, ...standard, tiers });
  } catch (error) {
    if (isCoded(error)) {
      return errorResponse(error);
    }

    /*
     * An Anthropic or GitHub failure mid-provision. This route is admin-only, so the operator gets the
     * real cause rather than the generic 500 sentence — a refusal that names no cause reads as the
     * button being broken. Neither SDK puts a credential in its error messages.
     */
    const message = (error as Error)?.message ?? String(error);
    logger.error(`Provisioning failed: ${message}`);

    return json({ error: true, message: `Provisioning failed: ${message}` }, { status: 502 });
  }
}
