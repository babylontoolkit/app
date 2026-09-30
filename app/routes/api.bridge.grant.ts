/**
 * Unity automation grant (SPEC §4.17, D47–D50).
 *
 *   POST /api/bridge/grant {productGuid} → {grant, expiresAt}
 *
 * Called by a paired Desktop Agent (`requireBridgeDevice`) before it runs a `bt_*` Unity command. The
 * device's user must be entitled (§4.18a: an active subscription OR credits), and the Unity project must
 * be one this device advertised in its hello. Rate-limited per DEVICE. The grant is never logged.
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { BRIDGE_DISABLED_BODY, isBridgeEnabled, requireBridgeDevice } from '~/lib/.server/bridge/auth';
import { GRANT_RATE_LIMIT, issueAutomationGrant } from '~/lib/.server/bridge/grant';
import { errorResponse } from '~/lib/.server/http';
import { enforceUserRateLimit } from '~/lib/.server/security/user-rate-limit';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    if (request.method !== 'POST') {
      return json({ error: true, message: 'Method not allowed.' }, { status: 405, headers: NO_STORE });
    }

    const { device } = await requireBridgeDevice(request, context);

    if (!isBridgeEnabled(context)) {
      return json(BRIDGE_DISABLED_BODY, { status: 404, headers: NO_STORE });
    }

    await enforceUserRateLimit({
      userId: 'dev:' + device.id,
      bucket: 'bridge-grant',
      rule: GRANT_RATE_LIMIT,
      subject: 'automation grants',
    });

    let body: { productGuid?: unknown };

    try {
      body = ((await request.json()) as { productGuid?: unknown }) ?? {};
    } catch {
      body = {};
    }

    const { grant, expiresAt } = await issueAutomationGrant({
      userId: device.userId,
      deviceId: device.id,
      productGuid: typeof body.productGuid === 'string' ? body.productGuid : '',
      context,
    });

    return json({ grant, expiresAt }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
