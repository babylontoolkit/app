/**
 * CodeSandbox template pin admin endpoints (plan T14, SPEC §4.4 applied to the runtime).
 *
 *   GET  /api/admin/sandbox-template            → the current pin, its history, and what is live now
 *   POST /api/admin/sandbox-template  promote   → validate a candidate, then re-point (the deliberate move)
 *   POST /api/admin/sandbox-template  rollback  → re-point at a target already in the history (the undo)
 *
 * The sibling of `api.admin.template.ts`, and the same argument applies word for word: an
 * unauthenticated promote endpoint would let anyone choose the code every new project starts from — a
 * supply-chain hole, not merely an unmetered one. `requireAdmin` on BOTH halves.
 *
 * ⚠️ Validation forks a real VM for a few seconds. That is deliberate (see `validateSandboxTemplate`)
 * and it is why this is an admin-only, one-per-promotion action rather than something the read path
 * ever does.
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { createScopedLogger } from '~/utils/logger';
import { requireAdmin } from '~/lib/.server/supabase/auth';
import { getObjectStore } from '~/lib/.server/storage';
import { errorResponse } from '~/lib/.server/http';
import { getMonitor } from '~/lib/.server/monitoring';
import {
  DEFAULT_SANDBOX_TEMPLATE,
  isSandboxConfigured,
  requireSandboxApiKey,
  sandboxTemplateDecision,
} from '~/lib/.server/sandbox/config';
import { deleteSandbox, validateSandboxTemplate } from '~/lib/.server/sandbox/service';
import {
  applyPromotion,
  readSandboxTemplatePin,
  setSandboxTemplatePinCache,
  writeSandboxTemplatePin,
  type SandboxTemplatePin,
} from '~/lib/.server/sandbox/template-pin';

const logger = createScopedLogger('api.admin.sandbox-template');

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    await requireAdmin(request, context);

    const store = getObjectStore(context);
    const file = await readSandboxTemplatePin(store);

    /*
     * The cache is refreshed on the way past so the panel and the fork path cannot disagree about
     * what is live — an admin reading "pinned to X" while projects still fork Y for another minute is
     * the sort of drift that gets diagnosed as a caching bug days later.
     */
    setSandboxTemplatePinCache(file);

    const decision = sandboxTemplateDecision(context);

    return json({
      configured: isSandboxConfigured(context),
      pin: file.current,
      history: [...file.history].reverse(),

      /*
       * What a project forked RIGHT NOW would use, and WHY — read through the same function the fork
       * path calls, never re-derived here. Two copies of a precedence rule is how the panel ends up
       * confidently describing a decision the runtime is not making.
       */
      live: decision.template,
      effective: decision.source,
      baked: DEFAULT_SANDBOX_TEMPLATE,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    await requireAdmin(request, context);

    if (request.method !== 'POST') {
      return json({ error: true, message: 'Method not allowed' }, { status: 405 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      action?: unknown;
      target?: unknown;
      provenance?: unknown;
    };

    const target = typeof body.target === 'string' ? body.target.trim() : '';
    const provenance = typeof body.provenance === 'string' ? body.provenance.trim() || undefined : undefined;

    if (!target) {
      return json({ error: true, message: 'A target template id or alias is required.' }, { status: 400 });
    }

    /*
     * Fails here with the operator-facing "set <var>" message rather than a bespoke one — the variable
     * NAME lives in `.server/sandbox/config.ts` and nowhere else, which is a structural rule
     * (`sandbox-seam.spec.ts`), not tidiness: a client module or a route naming a platform secret is
     * exactly the regression that scan exists to catch.
     */
    requireSandboxApiKey(context);

    const store = getObjectStore(context);
    const file = await readSandboxTemplatePin(store);

    if (body.action === 'promote') {
      /*
       * Validate BEFORE re-pointing. On a refusal the pin is untouched — that is the guarantee, not a
       * consolation — and the probe VM is reaped either way, so refusing costs no more than accepting.
       */
      const check = await validateSandboxTemplate(target, context);
      await reapProbe(check.probeSandboxId, context);

      if (!check.ok) {
        logger.error(`Refused to promote sandbox template ${target}: ${check.reason}`);

        return json(
          {
            error: true,
            message: `Refused to promote ${target}: ${check.reason}`,
            pinUnchanged: file.current?.target ?? null,
          },
          { status: 422 },
        );
      }

      return json(await record(store, file, { target, promotedBy: 'promote', provenance }));
    }

    if (body.action === 'rollback') {
      /*
       * Roll back only onto a target we have RECORDED promoting. An arbitrary id here would make
       * rollback a second, unvalidated promote wearing the word that means "undo" — and it would do it
       * at the exact moment someone is using it to escape a bad template.
       */
      if (!file.history.some((entry) => entry.target === target)) {
        return json({ error: true, message: `${target} is not in the promotion history.` }, { status: 404 });
      }

      const previous = file.current?.target;
      logger.warn(`Rolling the sandbox template back from ${previous ?? '(none)'} to ${target}.`);

      return json(await record(store, file, { target, promotedBy: 'rollback', provenance }));
    }

    return json({ error: true, message: `Unknown action: ${String(body.action)}` }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Write the new pin and make it effective immediately, without waiting for the cache TTL. */
async function record(
  store: ReturnType<typeof getObjectStore>,
  file: Awaited<ReturnType<typeof readSandboxTemplatePin>>,
  pin: Omit<SandboxTemplatePin, 'promotedAt'>,
) {
  const next = applyPromotion(file, { ...pin, promotedAt: new Date().toISOString() });

  await writeSandboxTemplatePin(store, next);
  setSandboxTemplatePinCache(next);

  logger.info(`Sandbox template pin is now ${next.current?.target} (${pin.promotedBy}).`);

  return { ok: true, pin: next.current, history: [...next.history].reverse() };
}

/**
 * Destroy the validation probe.
 *
 * Best-effort but MONITORED: a leaked probe is a VM billing by the second that no panel names, which
 * is the same orphan the project-delete path exists to prevent. Never fails the promotion — the pin
 * decision has already been made correctly by this point.
 */
async function reapProbe(sandboxId: string | undefined, context: unknown): Promise<void> {
  if (!sandboxId) {
    return;
  }

  try {
    await deleteSandbox(sandboxId, context);
  } catch (error) {
    logger.warn(`Could not delete the template validation probe ${sandboxId}: ${(error as Error)?.message}`);
    getMonitor(context).captureException(error, { scope: 'sandbox.template-probe', tags: { sandboxId } });
  }
}
