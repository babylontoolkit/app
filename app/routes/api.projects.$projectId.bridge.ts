/**
 * The Unity Bridge status for the composer icon and the one Unity Bridge dialog (SPEC §4.17, D19, D43,
 * D54, D55).
 *
 *   GET /api/projects/:projectId/bridge → BridgeStatusView
 *       { enabled, state: 'unpaired'|'offline'|'online', device?: {name, online, lastSeenAt, hello},
 *         productionOrigin: string | null }
 *
 * There is NO project link (D54): the bridge drives whichever paired device is present (the most recently
 * seen one — `pickBridgeDevice`, the same rule the agent turn uses). `productionOrigin` is the origin of
 * `APP_URL` (null when unset): the helper defaults to the production App Builder, so the dialog's install
 * command adds `--server <this origin>` only when the page is somewhere else (D55).
 *
 * There is no POST (D55): the dialog shows no devices, scripts switch or jobs. Jobs stay server-side for
 * the model's `bridge_job` tool; devices can still be listed / revoked at `/api/bridge/devices`.
 *
 * Both walls: a verified session AND ownership of the project (404, not 403). A disabled bridge answers
 * with `{enabled:false, …}` (200), so the icon still renders and the dialog can say it is turned off.
 */
import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import type { BridgeHello } from '~/lib/bridge/protocol';
import { bridgeProductionOrigin, isBridgeEnabled } from '~/lib/.server/bridge/auth';
import { deviceHello, isDevicePresent } from '~/lib/.server/bridge/relay';
import { pickBridgeDevice } from '~/lib/.server/bridge/service';
import { getBridgeStore } from '~/lib/.server/bridge/store';
import { errorResponse } from '~/lib/.server/http';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';

interface BridgeDeviceView {
  name: string;
  online: boolean;
  lastSeenAt?: string;
  hello?: BridgeHello;
}

/** Mirrors `BridgeStatusView` in `app/lib/stores/unity-bridge.ts` (the client store). */
interface BridgeStatusView {
  enabled: boolean;
  state: 'unpaired' | 'offline' | 'online';

  /** The device the agent would drive: the most recently seen present one, else the last seen. */
  device?: BridgeDeviceView;
  productionOrigin: string | null;
}

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  try {
    const user = await requireVerifiedUser(request, context);

    await requireOwnedProject(user, params.projectId ?? '', context);

    const rows = await getBridgeStore(context).listDevices(user.id);
    const picked = pickBridgeDevice(rows, user.id);
    const state: BridgeStatusView['state'] = picked.state === 'none' ? 'unpaired' : picked.state;

    const view: BridgeStatusView = {
      enabled: isBridgeEnabled(context),
      state,
      productionOrigin: bridgeProductionOrigin(context),
    };

    if (picked.state !== 'none') {
      const row = picked.device;

      view.device = {
        name: row.name,
        online: isDevicePresent(row.id),
        lastSeenAt: row.lastSeenAt,
        hello: deviceHello(row.id) ?? row.capabilities,
      };
    }

    return json(view, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
