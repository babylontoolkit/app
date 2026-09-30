/**
 * The Unity Bridge status for a project's panel (SPEC §4.17, D19, D43, D54).
 *
 *   GET  /api/projects/:projectId/bridge                                   → BridgeStatusView
 *   POST /api/projects/:projectId/bridge {action:'allowScripts', deviceId, value:boolean} → {ok:true}
 *                                        {action:'cancelJob', jobId}                     → {ok:true}
 *
 * There is NO project link (D54): the bridge drives whichever paired device is present (the most recently
 * seen one — `pickBridgeDevice`, the same rule the agent turn uses), and the model opens or creates the
 * Unity project itself. "Allow scripts" is a switch on the DEVICE. The project id still scopes the job
 * list, because jobs are recorded under the project that asked for them.
 *
 * Both walls: a verified session AND ownership of the project (404, not 403). A disabled bridge answers
 * the GET with `{enabled:false, …}` (200, so the composer icon can still offer local scenes, D43/D52) and
 * every POST with a 404.
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import type { BridgeHello, BridgeJobStatus } from '~/lib/bridge/protocol';
import { BRIDGE_DISABLED_BODY, isBridgeEnabled } from '~/lib/.server/bridge/auth';
import { cancelBridgeJob, deviceHello, isDevicePresent } from '~/lib/.server/bridge/relay';
import { pickBridgeDevice, settleDropped } from '~/lib/.server/bridge/service';
import { getBridgeStore } from '~/lib/.server/bridge/store';
import { errorResponse } from '~/lib/.server/http';
import { NotFoundError, requireOwnedProject } from '~/lib/.server/projects/ownership';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';

interface BridgeDeviceView {
  id: string;
  name: string;
  os: string;
  online: boolean;
  lastSeenAt?: string;
  allowScripts: boolean;
  hello?: BridgeHello;
}

/** Mirrors `BridgeStatusView` in `app/lib/stores/unity-bridge.ts` (the client store). */
interface BridgeStatusView {
  enabled: boolean;
  state: 'unpaired' | 'offline' | 'online';

  /** The device the agent would drive: the most recently seen present one, else the last seen. */
  device: BridgeDeviceView | null;
  devices: BridgeDeviceView[];
  jobs: Array<{
    id: string;
    operation: string;
    status: BridgeJobStatus;
    createdAt: string;
    finishedAt?: string;
    resultText?: string;
    error?: string;
  }>;
}

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  try {
    const user = await requireVerifiedUser(request, context);
    const project = await requireOwnedProject(user, params.projectId ?? '', context);
    const store = getBridgeStore(context);

    const rows = await store.listDevices(user.id);
    const devices: BridgeDeviceView[] = rows
      .filter((row) => !row.revokedAt)
      .map((row) => ({
        id: row.id,
        name: row.name,
        os: row.os,
        online: isDevicePresent(row.id),
        lastSeenAt: row.lastSeenAt,
        allowScripts: row.allowScripts === true,
        hello: deviceHello(row.id) ?? row.capabilities,
      }));

    const picked = pickBridgeDevice(rows, user.id);
    const state: BridgeStatusView['state'] = picked.state === 'none' ? 'unpaired' : picked.state;
    const device = picked.state === 'none' ? null : (devices.find((view) => view.id === picked.device.id) ?? null);

    const jobs = (await store.listJobs(project.id, 10)).map((row) => ({
      id: row.id,
      operation: row.operation,
      status: row.status,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
      resultText: row.resultText,
      error: row.error,
    }));

    const view: BridgeStatusView = { enabled: isBridgeEnabled(context), state, device, devices, jobs };

    return json(view, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function action({ request, context, params }: ActionFunctionArgs) {
  try {
    if (request.method !== 'POST') {
      return json({ error: true, message: 'Method not allowed.' }, { status: 405, headers: NO_STORE });
    }

    const user = await requireVerifiedUser(request, context);
    const project = await requireOwnedProject(user, params.projectId ?? '', context);

    if (!isBridgeEnabled(context)) {
      return json(BRIDGE_DISABLED_BODY, { status: 404, headers: NO_STORE });
    }

    let body: Record<string, unknown>;

    try {
      body = ((await request.json()) as Record<string, unknown>) ?? {};
    } catch {
      body = {};
    }

    const store = getBridgeStore(context);

    switch (body.action) {
      case 'allowScripts': {
        const device = typeof body.deviceId === 'string' ? await store.getDevice(body.deviceId) : null;

        if (!device || device.userId !== user.id || device.revokedAt) {
          throw new NotFoundError('That device does not exist.');
        }

        await store.putDevice({ ...device, allowScripts: body.value === true });

        return json({ ok: true }, { headers: NO_STORE });
      }

      case 'cancelJob': {
        const job = typeof body.jobId === 'string' ? await store.getJob(body.jobId) : null;

        if (!job || job.projectId !== project.id || job.userId !== user.id) {
          throw new NotFoundError('That job does not exist.');
        }

        if (cancelBridgeJob(job.id, user.id) === 'dropped') {
          await settleDropped([job.id], context);
        }

        return json({ ok: true }, { headers: NO_STORE });
      }

      default:
        return json({ error: true, message: 'Unknown action.' }, { status: 400, headers: NO_STORE });
    }
  } catch (error) {
    return errorResponse(error);
  }
}
