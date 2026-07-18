/**
 * Built-in media generation — quote, start, list (SPEC §4.16).
 *
 *   POST /api/projects/:id/media  { action:'quote', model, options, durationSeconds }
 *        → { credits, usd, model, kind }             — the price shown BEFORE Generate; never debits
 *   POST /api/projects/:id/media  { action:'start', model, prompt, options, durationSeconds, fileName }
 *        → { taskId, destPath, credits, usd }        — debits up-front, creates the KIE task
 *   GET  /api/projects/:id/media                      → { tasks }  — recent tasks for the panel
 *
 * Two walls as everywhere (verified user + owned project), and the credit rules live in
 * `media/service.ts`: exact-price debit before any spend, refuse-if-unpriced, refuse-if-insufficient
 * (402), auto-refund on failure. This route can reach the platform `KIE_API_KEY`, so it is gated —
 * "any route that can reach a provider key must pass the credit gate or it is a hole" (§4.5.4).
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { errorResponse } from '~/lib/.server/http';
import { getObjectStore } from '~/lib/.server/storage';
import { getPlatformConfig, NotConfiguredError } from '~/lib/.server/agent/config';
import { ensureMarketPrices } from '~/lib/.server/billing/market-price-store';
import { KieMediaProvider } from '~/lib/.server/media/kie-client';
import { listMediaTasks } from '~/lib/.server/media/store';
import { MediaRefusedError, quoteMediaRequest, startMediaTask } from '~/lib/.server/media/service';

interface MediaActionBody {
  action?: 'quote' | 'start';
  model?: string;
  prompt?: string;
  options?: Record<string, string | number | boolean>;
  durationSeconds?: number;
  fileName?: string;
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  try {
    const user = await requireVerifiedUser(request, context);
    await requireOwnedProject(user, params.projectId!, context);

    const tasks = await listMediaTasks(getObjectStore(context), params.projectId!);

    return json({ tasks });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  try {
    if (request.method !== 'POST') {
      return json({ error: true, message: 'Method not allowed.' }, { status: 405 });
    }

    const user = await requireVerifiedUser(request, context);
    await requireOwnedProject(user, params.projectId!, context);

    const body = await request.json<MediaActionBody>();

    if (!body.model) {
      return json({ error: true, message: 'model is required.' }, { status: 400 });
    }

    await ensureMarketPrices(context);

    const mediaRequest = {
      model: body.model,
      prompt: body.prompt ?? '',
      options: body.options ?? {},
      durationSeconds: body.durationSeconds,
    };

    if (body.action === 'quote') {
      // Never debits — this is the number on the Generate button.
      return json(quoteMediaRequest(mediaRequest, context));
    }

    if (body.action === 'start') {
      /*
       * The platform key is required HERE, not lazily inside the provider — a missing key must be a
       * describable 503 before any debit is taken, never a refund cycle.
       */
      const platform = getPlatformConfig(context);

      if (!platform.kieApiKey) {
        throw new NotConfiguredError(
          'Media generation (KIE_API_KEY)',
          'Set KIE_API_KEY in the server environment — image/video generation uses the platform KIE key.',
        );
      }

      const started = await startMediaTask({
        ...mediaRequest,
        userId: user.id,
        projectId: params.projectId!,
        fileName: body.fileName,
        provider: new KieMediaProvider(platform.kieApiKey),
        objectStore: getObjectStore(context),
        context,
      });

      return json({ ok: true, ...started });
    }

    return json({ error: true, message: `Unknown action: ${String(body.action)}` }, { status: 400 });
  } catch (error) {
    if (error instanceof MediaRefusedError) {
      return json({ error: true, message: error.message }, { status: error.statusCode });
    }

    return errorResponse(error);
  }
}
