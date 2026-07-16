/**
 * Doc-sync admin endpoints (SPEC §4.3.3–§4.3.4, spec/doc-sync.md).
 *
 *   GET  /api/admin/prompt            → list versions (hash, source SHA, active flag)
 *   POST /api/admin/prompt  refresh   → sync skills + rebuild the prompt, activate on success
 *   POST /api/admin/prompt  activate  → roll back / forward to any version
 *
 * curl-able before an admin dashboard exists, which is the point (§4.3.3).
 *
 * FAILURE GUARANTEE: a failed build leaves the previous version active and returns 500. A broken
 * push to the docs or skills repo can never take generation down.
 */
import { type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { createScopedLogger } from '~/utils/logger';
import { buildSystemPrompt } from '~/lib/.server/prompt/build';
import { invalidateActivePrompt } from '~/lib/.server/prompt/active';
import { getPromptStore } from '~/lib/.server/prompt/store';
import { syncSkills } from '~/lib/.server/skills/sync';
import { getSkillStore } from '~/lib/.server/skills/store';
import { getPlatformConfig } from '~/lib/.server/agent/config';
import { getMonitor, ALERT_SIGNALS } from '~/lib/.server/monitoring';

const logger = createScopedLogger('api.admin.prompt');

/**
 * The admin endpoints mutate what every future generation is built from. Without an ADMIN_TOKEN set
 * they REFUSE to run — an unauthenticated prompt-rebuild endpoint would be a remote takeover of the
 * agent's instructions. "Not configured" here means closed, not open.
 */
function authorize(request: Request, context: unknown): Response | null {
  const { adminToken } = getPlatformConfig(context);

  if (!adminToken) {
    return json(
      {
        error: true,
        message:
          'Admin endpoints are disabled: ADMIN_TOKEN is not set in the server environment. ' +
          'Set it (e.g. in .env.local) to enable doc-sync refresh and rollback.',
      },
      503,
    );
  }

  const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');

  if (provided !== adminToken) {
    return json({ error: true, message: 'Unauthorized' }, 401);
  }

  return null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const denied = authorize(request, context);

  if (denied) {
    return denied;
  }

  const [versions, skills] = await Promise.all([getPromptStore().list(), getSkillStore().listAll()]);

  return json({ versions, skills });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const denied = authorize(request, context);

  if (denied) {
    return denied;
  }

  const body = await request.json<{ action: 'refresh' | 'activate'; versionId?: string }>();
  const config = getPlatformConfig(context);

  try {
    if (body.action === 'activate') {
      if (!body.versionId) {
        return json({ error: true, message: 'versionId is required to activate' }, 400);
      }

      await getPromptStore().activate(body.versionId);
      invalidateActivePrompt();

      logger.info(`Activated prompt version ${body.versionId}`);

      return json({ ok: true, activated: body.versionId });
    }

    if (body.action === 'refresh') {
      /*
       * Skills sync first: the skills index is an INPUT to the prompt build (§4.11), so syncing
       * after the build would leave the active prompt advertising a stale skill set. A skills-sync
       * failure gets its OWN alert signal (§5A) before it propagates to the shared doc-sync handler,
       * so ops can tell "the skills repo push broke" apart from "the docs build broke".
       */
      const skills = await syncSkills(config.githubToken).catch((error: unknown) => {
        getMonitor(context).alert(
          ALERT_SIGNALS.SKILLSSYNC_BUILD_FAILURE,
          `Skills sync failed: ${(error as Error).message}`,
          { severity: 'warning' },
        );
        throw error;
      });
      const build = await buildSystemPrompt({
        skillsIndex: skills.skillsIndex,
        githubToken: config.githubToken,
        activate: true,
      });

      invalidateActivePrompt();

      return json({
        ok: true,
        status: build.status,
        version: build.version,
        docsFetched: build.fetched,
        agentCommitSha: build.sourceCommitSha,
        skills: {
          commitSha: skills.sourceCommitSha,
          synced: skills.synced,
          skipped: skills.skipped,
        },
      });
    }

    return json({ error: true, message: `Unknown action: ${String(body.action)}` }, 400);
  } catch (error) {
    // Previous version stays active. This is the guarantee, not a consolation.
    logger.error(`Doc-sync failed: ${(error as Error).message}`);

    /*
     * A doc/skills sync that could not build is an ops signal (§5A): generation keeps working on the
     * previous version, so no user sees an error — which is exactly why it needs to be surfaced, or a
     * broken docs push sits unnoticed until someone wonders why new features never reach the prompt.
     */
    getMonitor(context).alert(
      ALERT_SIGNALS.DOCSYNC_BUILD_FAILURE,
      `Doc-sync ${body.action} failed: ${(error as Error).message}`,
      { severity: 'warning' },
    );

    const active = await getPromptStore().getActive();

    return json(
      {
        error: true,
        message: (error as Error).message,
        activeVersionUnchanged: active?.id ?? null,
      },
      500,
    );
  }
}
