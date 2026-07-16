/**
 * Template pin admin endpoints (SPEC §4.4 pin-and-cache).
 *
 *   GET  /api/admin/template?repo=owner/repo   → the current pin + every snapshot available to roll back to
 *   POST /api/admin/template  promote          → fetch a ref, snapshot it, re-point the pin (the deliberate move)
 *   POST /api/admin/template  rollback         → re-point the pin at an existing snapshot (the undo)
 *
 * This is the "deliberate admin action" half of §4.4. Promotion is the ONLY way a change to the starter
 * repo reaches new projects, and rollback is the way back when a promotion turns out badly.
 *
 * Admin-only (session `isAdmin`), matching the other §4.10 admin surfaces the settings tab drives —
 * including credit adjustment, which is a money path. An unauthenticated promote endpoint would let
 * anyone choose the code every new project starts from: a supply-chain hole, not merely an unmetered one.
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { createScopedLogger } from '~/utils/logger';
import { requireAdmin } from '~/lib/.server/supabase/auth';
import { getPlatformConfig } from '~/lib/.server/agent/config';
import { getObjectStore } from '~/lib/.server/storage';
import { errorResponse } from '~/lib/.server/http';
import { fetchTemplateFiles, resolveGitHubToken, resolveTemplateRef } from '~/lib/.server/templates/fetch';
import { validateTemplateFiles } from '~/lib/.server/templates/last-known-good';
import { isTemplatePinningEnabled } from '~/lib/.server/templates/config';
import { listSnapshots, loadSnapshot, readPin, saveSnapshot, writePin } from '~/lib/.server/templates/pin';

const logger = createScopedLogger('api.admin.template');

/** The one repo this platform actually mounts (§4.4: one starter, genres are registry rows). */
const DEFAULT_TEMPLATE_REPO = 'babylontoolkit/AppTemplate';

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    await requireAdmin(request, context);

    const repo = new URL(request.url).searchParams.get('repo') || DEFAULT_TEMPLATE_REPO;
    const store = getObjectStore(context);
    const [pin, snapshots] = await Promise.all([readPin(store, repo), listSnapshots(store, repo)]);

    return json({
      repo,
      pinningEnabled: isTemplatePinningEnabled(context),
      pin,

      // Flagged so the UI can render "active" without re-deriving the rule.
      snapshots: snapshots.map((s) => ({ ...s, active: s.sha === pin?.sha })),
      storage: store.backend,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    await requireAdmin(request, context);

    const body = await request.json<{ action: 'promote' | 'rollback'; repo?: string; ref?: string; sha?: string }>();
    const repo = body.repo || DEFAULT_TEMPLATE_REPO;
    const store = getObjectStore(context);

    return await handle(body, repo, store, context);
  } catch (error) {
    return errorResponse(error);
  }
}

async function handle(
  body: { action: 'promote' | 'rollback'; ref?: string; sha?: string },
  repo: string,
  store: ReturnType<typeof getObjectStore>,
  context: unknown,
): Promise<Response> {
  try {
    if (body.action === 'promote') {
      const githubToken = resolveGitHubToken(getPlatformConfig(context).githubToken || process.env.GITHUB_TOKEN);

      /*
       * `ref` is optional: omitted promotes the default branch's HEAD; given, it promotes a tag, branch
       * or SHA by name. Either way it resolves to a concrete commit BEFORE anything is fetched — a
       * snapshot whose provenance is "whatever main was at some point" is not a pin.
       */
      const resolved = await resolveTemplateRef(repo, body.ref, githubToken);
      const files = await fetchTemplateFiles(repo, resolved.sha, { githubToken, context });

      /*
       * Validate BEFORE re-pointing the pin. Promoting an unmountable template would break every new
       * project — the exact failure the pin exists to prevent, delivered by the mechanism meant to
       * prevent it. The current pin stays untouched on a refusal.
       */
      const check = validateTemplateFiles(files);

      if (!check.ok) {
        const current = await readPin(store, repo);
        logger.error(`Refused to promote ${repo}@${resolved.sha.slice(0, 8)}: ${check.reason}`);

        return json(
          {
            error: true,
            message: `Refused to promote: the template at ${resolved.ref} is unmountable (${check.reason}).`,
            pinUnchanged: current?.sha ?? null,
          },
          422,
        );
      }

      // Snapshots are immutable and SHA-addressed: re-promoting the same commit rewrites identical bytes.
      await saveSnapshot(store, repo, resolved.sha, files);

      const pin = {
        repo,
        sha: resolved.sha,
        ref: resolved.ref,
        pinnedAt: new Date().toISOString(),
        pinnedBy: 'promote' as const,
        fileCount: files.length,
      };
      await writePin(store, pin);

      logger.info(`Promoted ${repo} to ${resolved.sha.slice(0, 8)} (${resolved.ref}), ${files.length} files`);

      return json({ ok: true, pin });
    }

    if (body.action === 'rollback') {
      if (!body.sha) {
        return json({ error: true, message: 'sha is required to roll back' }, 400);
      }

      /*
       * Roll back only to bytes we still HAVE. Pointing the pin at a snapshot that is not in the store
       * would leave every new project falling through to a live fetch — silently undoing the pin at the
       * exact moment someone is using it to escape a bad live template.
       */
      const files = await loadSnapshot(store, repo, body.sha);

      if (!files) {
        return json({ error: true, message: `No snapshot for ${repo}@${body.sha}` }, 404);
      }

      const pin = {
        repo,
        sha: body.sha,
        ref: `rollback:${body.sha.slice(0, 8)}`,
        pinnedAt: new Date().toISOString(),
        pinnedBy: 'rollback' as const,
        fileCount: files.length,
      };
      await writePin(store, pin);

      logger.warn(`Rolled ${repo} back to ${body.sha.slice(0, 8)} (${files.length} files)`);

      return json({ ok: true, pin });
    }

    return json({ error: true, message: `Unknown action: ${String(body.action)}` }, 400);
  } catch (error) {
    logger.error(`Template ${body.action} failed: ${(error as Error).message}`);

    // The pin is untouched on any failure — that is the guarantee, not a consolation.
    const current = await readPin(store, repo).catch(() => null);

    return json({ error: true, message: (error as Error).message, pinUnchanged: current?.sha ?? null }, 500);
  }
}
