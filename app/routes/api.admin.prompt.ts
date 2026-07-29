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
import { requireAdmin } from '~/lib/.server/supabase/auth';
import { buildSystemPrompt } from '~/lib/.server/prompt/build';
import { invalidateActivePrompt } from '~/lib/.server/prompt/active';
import { warmAfterPromptChange } from '~/lib/.server/prompt/cache-warmer';
import { getPromptStore } from '~/lib/.server/prompt/store';
import { AGENT_REPO, SKILLS_REPO } from '~/lib/.server/prompt/sources';
import { syncSkills } from '~/lib/.server/skills/sync';
import { getSkillStore } from '~/lib/.server/skills/store';
import { getPlatformConfig } from '~/lib/.server/agent/config';
import { getMonitor, ALERT_SIGNALS } from '~/lib/.server/monitoring';

const logger = createScopedLogger('api.admin.prompt');

/**
 * The admin endpoints mutate what every future generation is built from — an unauthenticated
 * prompt-rebuild endpoint would be a remote takeover of the agent's instructions. Two ways in, both
 * closed by default:
 *
 *   1. A logged-in ADMIN SESSION (`requireAdmin`) — this is the Admin panel button (§4.10). Same
 *      session `isAdmin` wall as every other `/api/admin/*` route; the browser sends its cookie, never
 *      a server secret.
 *   2. An `ADMIN_TOKEN` Bearer header — the headless path for CI, cron, and curl, kept because this
 *      route existed before the dashboard did (§4.3.3) and a scheduled sync has no session.
 *
 * Session first so the common case (an admin clicking Refresh) never depends on ADMIN_TOKEN being set.
 * "Not configured" for the token path still means closed, not open.
 */
async function authorize(request: Request, context: unknown): Promise<Response | null> {
  try {
    await requireAdmin(request, context);
    return null;
  } catch {
    // Not an admin session — fall through to the token path (CI / cron / curl).
  }

  const { adminToken } = getPlatformConfig(context);

  if (!adminToken) {
    return json(
      {
        error: true,
        message:
          'Admin access required: sign in as an admin, or set ADMIN_TOKEN in the server environment ' +
          'for headless (CI/cron/curl) access.',
      },
      403,
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
  const denied = await authorize(request, context);

  if (denied) {
    return denied;
  }

  const [versions, skills, activeSkills] = await Promise.all([
    getPromptStore().list(),
    getSkillStore().listAll(),
    getSkillStore().listActive(),
  ]);
  const active = versions.find((v) => v.isActive) ?? null;

  /*
   * A human-readable summary for the Admin panel (§4.10): the two supply chains — the Agent Reference
   * (docs) and the Skills — as ONE line each, keyed to the commit that is actually live. `versions` /
   * `skills` stay for the curl contract (§4.3.3); the UI reads `summary` and never the raw list.
   *
   * Skills count is `listActive` (the current version of each DISTINCT skill), NOT `listAll` — the
   * latter is every version ever synced, so it reports ~14x too many (126 records for 9 skills). Same
   * reason its commit comes from an active skill: all active skills share the latest sync HEAD.
   */
  const summary = {
    reference: active
      ? { repo: AGENT_REPO, commitSha: active.lastSeenCommitSha, syncedAt: active.lastSeenAt ?? active.createdAt }
      : null,
    skills: {
      repo: SKILLS_REPO,
      count: activeSkills.length,
      commitSha: activeSkills[0]?.sourceCommitSha ?? null,
    },
  };

  return json({ versions, skills, summary });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const denied = await authorize(request, context);

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

      /*
       * New active bytes = ~fanout cold cache writes coming. Prepay them off-request so no user's
       * creation eats the first miss (fire-and-forget — a promote must not block on KIE).
       */
      warmAfterPromptChange(context);

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
      warmAfterPromptChange(context);

      return json({
        ok: true,
        status: build.status,
        version: build.version,
        docsFetched: build.fetched,
        agentCommitSha: build.sourceCommitSha,

        /*
         * `status: "unchanged"` reads as "did the sync even run?" on its own — it is the same word
         * whether we fetched HEAD and found nothing to bake, or never looked. Say which: the commit
         * we just confirmed the active version against.
         */
        confirmedCurrentAt: build.version.lastSeenCommitSha,
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
