/**
 * The signed-in user's paired Unity Bridge devices (SPEC §4.17, D7).
 *
 *   GET  /api/bridge/devices                              → {devices:[{id,name,os,online,lastSeenAt,hello}]}
 *   POST /api/bridge/devices {action:'approve', code}     → {ok:true, deviceName}
 *   POST /api/bridge/devices {action:'revoke', deviceId}  → {ok:true}
 *
 * Behind a verified session. Revoked devices are omitted. A device that is not the caller's is a 404,
 * never a 403 (a 403 confirms the id exists).
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { BRIDGE_DISABLED_BODY, isBridgeEnabled } from '~/lib/.server/bridge/auth';
import { approvePairing } from '~/lib/.server/bridge/pairing';
import { deviceHello, dropDevice, isDevicePresent } from '~/lib/.server/bridge/relay';
import { settleDropped } from '~/lib/.server/bridge/service';
import { getBridgeStore } from '~/lib/.server/bridge/store';
import { errorResponse } from '~/lib/.server/http';
import { NotFoundError } from '~/lib/.server/projects/ownership';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    const user = await requireVerifiedUser(request, context);

    if (!isBridgeEnabled(context)) {
      return json(BRIDGE_DISABLED_BODY, { status: 404, headers: NO_STORE });
    }

    const rows = await getBridgeStore(context).listDevices(user.id);
    const devices = rows
      .filter((row) => !row.revokedAt)
      .map((row) => ({
        id: row.id,
        name: row.name,
        os: row.os,
        online: isDevicePresent(row.id),
        lastSeenAt: row.lastSeenAt,
        hello: deviceHello(row.id) ?? row.capabilities,
      }));

    return json({ devices }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    if (request.method !== 'POST') {
      return json({ error: true, message: 'Method not allowed.' }, { status: 405, headers: NO_STORE });
    }

    const user = await requireVerifiedUser(request, context);

    if (!isBridgeEnabled(context)) {
      return json(BRIDGE_DISABLED_BODY, { status: 404, headers: NO_STORE });
    }

    let body: Record<string, unknown>;

    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    if (body?.action === 'approve') {
      if (typeof body.code !== 'string' || !body.code.trim()) {
        return json({ error: true, message: 'code is required.' }, { status: 400, headers: NO_STORE });
      }

      const { deviceName } = await approvePairing({ userId: user.id, code: body.code, context });

      return json({ ok: true, deviceName }, { headers: NO_STORE });
    }

    if (body?.action === 'revoke') {
      const store = getBridgeStore(context);
      const device = typeof body.deviceId === 'string' ? await store.getDevice(body.deviceId) : null;

      if (!device || device.userId !== user.id) {
        throw new NotFoundError('That device does not exist.');
      }

      if (!device.revokedAt) {
        await store.putDevice({ ...device, revokedAt: new Date().toISOString() });
      }

      // Every job the device held that never started is marked cancelled.
      await settleDropped(dropDevice(device.id), context);

      return json({ ok: true }, { headers: NO_STORE });
    }

    return json({ error: true, message: 'Unknown action.' }, { status: 400, headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
