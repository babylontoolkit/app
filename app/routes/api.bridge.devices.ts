/**
 * The signed-in user's paired Unity Bridge devices (SPEC §4.17, D7, D55).
 *
 *   GET  /api/bridge/devices                              → {devices:[{id,name,os,online,lastSeenAt,hello,allowScripts}]}
 *   POST /api/bridge/devices {action:'invite'}            → {code:'XXXX-XXXX', expiresAt}
 *   POST /api/bridge/devices {action:'revoke', deviceId}  → {ok:true}
 *   POST /api/bridge/devices {action:'allowScripts', deviceId, value:boolean} → {device:{id,allowScripts}}
 *
 * `invite` mints the single-use install code the Unity Bridge dialog builds its one command around (D55,
 * the only pairing flow); the helper claims it at `POST /api/bridge/pair`. Rate-limited per user.
 *
 * `allowScripts` is the per-computer Allow scripts switch (D58, on by default): the dialog's checkbox posts
 * it, and every dispatch to that device carries it. A non-boolean `value` is a 400 — never coerced, since
 * `"false"` is truthy.
 *
 * Behind a verified session. Revoked devices are omitted. A device that is not the caller's is a 404,
 * never a 403 (a 403 confirms the id exists).
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { BRIDGE_DISABLED_BODY, isBridgeEnabled } from '~/lib/.server/bridge/auth';
import { createInstallCode } from '~/lib/.server/bridge/pairing';
import { deviceHello, dropDevice, isDevicePresent } from '~/lib/.server/bridge/relay';
import { settleDropped } from '~/lib/.server/bridge/service';
import { getBridgeStore, isScriptsAllowed } from '~/lib/.server/bridge/store';
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
        allowScripts: isScriptsAllowed(row),
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

    if (body?.action === 'invite') {
      const invite = await createInstallCode({ userId: user.id, context });

      return json({ code: invite.code, expiresAt: invite.expiresAt }, { headers: NO_STORE });
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

    if (body?.action === 'allowScripts') {
      if (typeof body.value !== 'boolean') {
        return json({ error: true, message: 'value must be true or false.' }, { status: 400, headers: NO_STORE });
      }

      const store = getBridgeStore(context);
      const device = typeof body.deviceId === 'string' ? await store.getDevice(body.deviceId) : null;

      // Someone else's device, an unknown id and a removed device are all the same 404 (never a 403).
      if (!device || device.userId !== user.id || device.revokedAt) {
        throw new NotFoundError('That device does not exist.');
      }

      const updated = await store.setDeviceAllowScripts(device.id, body.value);

      if (!updated) {
        throw new NotFoundError('That device does not exist.');
      }

      return json({ device: { id: updated.id, allowScripts: isScriptsAllowed(updated) } }, { headers: NO_STORE });
    }

    return json({ error: true, message: 'Unknown action.' }, { status: 400, headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
