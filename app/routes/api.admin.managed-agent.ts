/**
 * Managed Agents provisioning admin endpoint (`_specs/managed-agents-engine_plan.md` T3).
 *
 *   GET  /api/admin/managed-agent            → which agent the managed engine runs on (or "not configured")
 *   POST /api/admin/managed-agent provision  → create/update the agent from the active prompt version
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
import { getManagedAgentStatus, provisionManagedAgent } from '~/lib/.server/agent-managed/provision';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.admin.managed-agent');

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
    const status = await getManagedAgentStatus(context);

    return json({
      configured: true,
      engine,
      key: status.key,
      activeVersionId: status.activeVersionId,
      current: status.current,
      agent: status.record
        ? {
            agentId: status.record.agentId,
            agentVersion: status.record.agentVersion,
            environmentId: status.record.environmentId,
            referenceSha: status.record.referenceSha,
            referenceFiles: status.record.referenceFiles.length,
            skills: status.record.skills.map((skill) => skill.name),
            provisionedAt: status.record.provisionedAt,
          }
        : null,
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

    const result = await provisionManagedAgent({ context, force: (body as { force?: boolean }).force === true });

    return json({ ok: true, ...result });
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
