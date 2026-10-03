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
import { getMediaConfig, getMediaProvider, NotConfiguredError, mediaKeyEnvFor } from '~/lib/.server/agent/config';
import { ensureMarketPrices } from '~/lib/.server/billing/market-price-store';
import { mediaProviderFor } from '~/lib/.server/media/provider';
import { listMediaTasks } from '~/lib/.server/media/store';
import { MediaRefusedError, quoteMediaRequest, startMediaTask } from '~/lib/.server/media/service';
import { keepAlive } from '~/lib/.server/runtime/keep-alive';
import { validatePanelSoundRequest } from '~/lib/media/sound-request';

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

    /*
     * Who serves media HERE — its own switch (§4.16), defaulting to the LLM provider. A quote priced
     * off a different gateway's list than the one that will render is a wrong number on the Generate
     * button and then a wrong debit, so both actions resolve it from the same call.
     */
    const mediaProvider = getMediaProvider(context);

    if (!mediaProvider) {
      throw new NotConfiguredError(
        'Media generation',
        'No media provider is configured. Set MEDIA_PROVIDER (or run on a provider that serves ' +
          'renders) — the current LLM provider sells no image or video generation.',
      );
    }

    await ensureMarketPrices(mediaProvider, context);

    const mediaRequest = {
      model: body.model,
      prompt: body.prompt ?? '',
      options: body.options ?? {},
      durationSeconds: body.durationSeconds,
    };

    /*
     * 🔴 A SOUND REQUEST IS VALIDATED HERE, against the gateway that will render it, before any quote
     * or debit (`_specs/media-gateways_plan.md` T7). The agent's door (`generate_sound`) always ran
     * `validateSoundRequest`; this door did not, so a panel request outside the gateway's limits (a
     * 30 s fal effect, an unknown voice, vocals with no lyrics) was quoted, DEBITED, sent, refused by
     * fal and then refunded — a round trip of the user's credits for a sentence we could have said
     * first. Same validator, same sentence, as a 4xx.
     */
    if (body.action === 'quote' || body.action === 'start') {
      const sound = validatePanelSoundRequest(mediaRequest, mediaProvider, { forQuote: body.action === 'quote' });

      if (sound && !sound.ok) {
        return json({ error: true, message: sound.error }, { status: 422 });
      }
    }

    if (body.action === 'quote') {
      // Never debits — this is the number on the Generate button.
      return json(quoteMediaRequest(mediaRequest, mediaProvider, context));
    }

    if (body.action === 'start') {
      /*
       * The platform key is required HERE, not lazily inside the provider — a missing key must be a
       * describable 503 before any debit is taken, never a refund cycle.
       */
      const media = getMediaConfig(context);

      if (!media) {
        throw new NotConfiguredError(
          `Media generation (${mediaKeyEnvFor(mediaProvider)})`,
          `Set ${mediaKeyEnvFor(mediaProvider)} in the server environment — media generation ` +
            `uses the platform ${mediaProvider} key.`,
        );
      }

      /*
       * Kept alive (no-unbilled-usage D1): debit → provider create → task record must finish together. Under
       * workerd a client that goes away mid-request cancels the pending work, which could leave a debit
       * with no task or — worse — a render the provider accepted with no record to bill or refund it.
       */
      const started = await keepAlive(
        context,
        startMediaTask({
          ...mediaRequest,
          userId: user.id,
          projectId: params.projectId!,
          fileName: body.fileName,
          provider: mediaProviderFor(media.provider, media.apiKey, media.baseUrl),
          objectStore: getObjectStore(context),
          context,
        }),
        'media start',
      );

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
