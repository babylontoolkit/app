/**
 * Unity Bridge job events and logout (SPEC §4.17, D13).
 *
 *   POST /api/bridge/result {events: BridgeJobEvent[]} → {delivered: number}
 *   POST /api/bridge/result {action:'logout'}          → {ok:true}
 *
 * Authenticated by the device token (`requireBridgeDevice`). An event is delivered only to a job that
 * belongs to THIS device (`deliverBridgeEvent` checks), and never to one that was dropped.
 * Logout revokes the device and cancels every job it held that never started.
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { BRIDGE_MAX_IMAGE_BASE64, capText, type BridgeJobEvent, type BridgeResultPayload } from '~/lib/bridge/protocol';
import { requireBridgeDevice } from '~/lib/.server/bridge/auth';
import { deliverBridgeEvent, dropDevice } from '~/lib/.server/bridge/relay';
import { settleDropped } from '~/lib/.server/bridge/service';
import { getBridgeStore } from '~/lib/.server/bridge/store';
import { errorResponse } from '~/lib/.server/http';

const NO_STORE = { 'Cache-Control': 'no-store' };
const MAX_EVENTS = 200;

/** Normalize one untrusted event; null when it is not a well-formed known event. */
function toEvent(raw: unknown): BridgeJobEvent | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const event = raw as Record<string, unknown>;

  if (typeof event.jobId !== 'string' || !event.jobId) {
    return null;
  }

  const jobId = event.jobId;

  switch (event.type) {
    case 'started':
      return { jobId, type: 'started' };
    case 'progress':
      return { jobId, type: 'progress', line: capText(String(event.line ?? ''), 2_000) };
    case 'refused':
      return { jobId, type: 'refused', reason: capText(String(event.reason ?? 'refused on the device'), 2_000) };
    case 'final': {
      const result = (event.result ?? {}) as Record<string, unknown>;
      const payload: BridgeResultPayload = { ok: result.ok === true, text: capText(String(result.text ?? '')) };
      const image = result.image as { base64?: unknown; mimeType?: unknown } | undefined;

      if (
        image &&
        typeof image.base64 === 'string' &&
        image.mimeType === 'image/png' &&
        image.base64.length <= BRIDGE_MAX_IMAGE_BASE64
      ) {
        payload.image = { base64: image.base64, mimeType: 'image/png' };
      }

      if (typeof result.exitCode === 'number' && Number.isFinite(result.exitCode)) {
        payload.exitCode = result.exitCode;
      }

      return { jobId, type: 'final', result: payload };
    }
    default:
      return null;
  }
}

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    if (request.method !== 'POST') {
      return json({ error: true, message: 'Method not allowed.' }, { status: 405, headers: NO_STORE });
    }

    const { device } = await requireBridgeDevice(request, context);

    let body: Record<string, unknown>;

    try {
      body = ((await request.json()) as Record<string, unknown>) ?? {};
    } catch {
      body = {};
    }

    if (body.action === 'logout') {
      await getBridgeStore(context).putDevice({ ...device, revokedAt: new Date().toISOString() });
      await settleDropped(dropDevice(device.id), context);

      return json({ ok: true }, { headers: NO_STORE });
    }

    if (Array.isArray(body.events)) {
      let delivered = 0;

      for (const raw of body.events.slice(0, MAX_EVENTS)) {
        const event = toEvent(raw);

        if (event && deliverBridgeEvent(device.id, event)) {
          delivered++;
        }
      }

      return json({ delivered }, { headers: NO_STORE });
    }

    return json({ error: true, message: 'events or action is required.' }, { status: 400, headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
