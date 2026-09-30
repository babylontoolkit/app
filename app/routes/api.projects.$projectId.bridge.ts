/**
 * A project's Unity Bridge link and status (SPEC §4.17, D15, D19, D43).
 *
 *   GET  /api/projects/:projectId/bridge                                      → BridgeStatusView
 *   POST /api/projects/:projectId/bridge {action:'link', deviceId, unityProjectKey} → {ok:true}
 *                                        {action:'unlink'}                       → {ok:true}
 *                                        {action:'allowScripts', value:boolean}  → {ok:true}
 *                                        {action:'cancelJob', jobId}             → {ok:true}
 *
 * Both walls: a verified session AND ownership of the project (404, not 403). A disabled bridge answers
 * the GET with `{enabled:false, …}` (200, so the composer icon can still offer local scenes, D43/D52) and
 * every POST with a 404.
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import type { BridgeHello, BridgeJobStatus } from '~/lib/bridge/protocol';
import { BRIDGE_DISABLED_BODY, isBridgeEnabled } from '~/lib/.server/bridge/auth';
import { cancelBridgeJob, deviceHello, isDevicePresent } from '~/lib/.server/bridge/relay';
import { settleDropped } from '~/lib/.server/bridge/service';
import { getBridgeStore } from '~/lib/.server/bridge/store';
import { errorResponse } from '~/lib/.server/http';
import { NotFoundError, requireOwnedProject } from '~/lib/.server/projects/ownership';
import { getProjectStore } from '~/lib/.server/projects/store';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';

/** Mirrors `BridgeStatusView` in `app/lib/stores/unity-bridge.ts` (the client store). */
interface BridgeStatusView {
  enabled: boolean;
  state: 'unpaired' | 'unlinked' | 'offline' | 'online';
  link: { deviceId: string; deviceName: string; unityProjectName: string; allowScripts: boolean } | null;
  devices: Array<{ id: string; name: string; os: string; online: boolean; lastSeenAt?: string; hello?: BridgeHello }>;
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

    const devices = (await store.listDevices(user.id))
      .filter((row) => !row.revokedAt)
      .map((row) => ({
        id: row.id,
        name: row.name,
        os: row.os,
        online: isDevicePresent(row.id),
        lastSeenAt: row.lastSeenAt,
        hello: deviceHello(row.id) ?? row.capabilities,
      }));

    const bridgeLink = project.bridgeLink;
    const linkedDevice = bridgeLink ? devices.find((device) => device.id === bridgeLink.deviceId) : undefined;
    const link = bridgeLink
      ? {
          deviceId: bridgeLink.deviceId,
          deviceName: linkedDevice?.name ?? 'Removed device',
          unityProjectName: bridgeLink.unityProjectName,
          allowScripts: bridgeLink.allowScripts,
        }
      : null;

    let state: BridgeStatusView['state'];

    if (devices.length === 0) {
      state = 'unpaired';
    } else if (!bridgeLink) {
      state = 'unlinked';
    } else if (linkedDevice?.online) {
      state = 'online';
    } else {
      state = 'offline';
    }

    const jobs = (await store.listJobs(project.id, 10)).map((row) => ({
      id: row.id,
      operation: row.operation,
      status: row.status,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
      resultText: row.resultText,
      error: row.error,
    }));

    const view: BridgeStatusView = { enabled: isBridgeEnabled(context), state, link, devices, jobs };

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
    const projects = getProjectStore(context);

    switch (body.action) {
      case 'link': {
        const device = typeof body.deviceId === 'string' ? await store.getDevice(body.deviceId) : null;

        if (!device || device.userId !== user.id || device.revokedAt) {
          throw new NotFoundError('That device does not exist.');
        }

        const hello = deviceHello(device.id) ?? device.capabilities;
        const unityProject =
          typeof body.unityProjectKey === 'string'
            ? hello?.unityProjects?.find((candidate) => candidate.key === body.unityProjectKey)
            : undefined;

        if (!unityProject) {
          return json(
            {
              error: true,
              message: 'That Unity project is not open in the Desktop Agent on this device. Start the bridge from it.',
            },
            { status: 400, headers: NO_STORE },
          );
        }

        await projects.update(project.id, {
          bridgeLink: {
            deviceId: device.id,
            unityProjectKey: unityProject.key,
            unityProjectName: unityProject.name,
            allowScripts: false,
            linkedAt: new Date().toISOString(),
          },
        });

        return json({ ok: true }, { headers: NO_STORE });
      }

      case 'unlink': {
        await projects.update(project.id, { bridgeLink: undefined });
        return json({ ok: true }, { headers: NO_STORE });
      }

      case 'allowScripts': {
        if (!project.bridgeLink) {
          return json({ error: true, message: 'Link a Unity project first.' }, { status: 400, headers: NO_STORE });
        }

        await projects.update(project.id, {
          bridgeLink: { ...project.bridgeLink, allowScripts: Boolean(body.value) },
        });

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
