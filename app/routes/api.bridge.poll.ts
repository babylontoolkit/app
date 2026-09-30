/**
 * Unity Bridge long-poll (SPEC §4.17, D4, D6).
 *
 *   POST /api/bridge/poll {hello?: BridgeHello} → BridgePollResponse
 *
 * The Desktop Agent's only inbound channel: the request is HELD up to `BRIDGE_POLL_HOLD_MS` and released
 * the moment a job or a cancel exists for this device. Authenticated by the device token
 * (`requireBridgeDevice`). Presence is in memory on every poll; the store is written only when the
 * helper's capabilities changed or `BRIDGE_LAST_SEEN_WRITE_MS` has passed — never on every poll (D6).
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { BRIDGE_POLL_HOLD_MS, BRIDGE_PROTOCOL_VERSION, type BridgeHello } from '~/lib/bridge/protocol';
import { isBridgeEnabled, requireBridgeDevice } from '~/lib/.server/bridge/auth';
import { shouldPersistHello } from '~/lib/.server/bridge/persist-hello';
import { pollBridgeJobs, touchDevice } from '~/lib/.server/bridge/relay';
import { getBridgeStore } from '~/lib/.server/bridge/store';
import { errorResponse } from '~/lib/.server/http';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('bridge.poll');
const NO_STORE = { 'Cache-Control': 'no-store' };

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    if (request.method !== 'POST') {
      return json({ error: true, message: 'Method not allowed.' }, { status: 405, headers: NO_STORE });
    }

    const { device } = await requireBridgeDevice(request, context);

    if (!isBridgeEnabled(context)) {
      return json({ jobs: [], cancels: [] }, { headers: NO_STORE });
    }

    let body: { hello?: BridgeHello };

    try {
      body = ((await request.json()) as { hello?: BridgeHello }) ?? {};
    } catch {
      body = {};
    }

    const hello = body.hello && typeof body.hello === 'object' ? body.hello : undefined;

    if (hello && hello.protocol !== BRIDGE_PROTOCOL_VERSION) {
      return json(
        { error: true, message: 'Update the Babylon Toolkit Desktop Agent: run bt-agent update.' },
        { status: 426, headers: NO_STORE },
      );
    }

    touchDevice(device.id, hello);

    if (hello) {
      const now = Date.now();
      const lastWrite = device.lastSeenAt ? Date.parse(device.lastSeenAt) : 0;

      // Content comparison, key-order-insensitive: jsonb re-orders keys (see persist-hello.ts).
      if (shouldPersistHello(device.capabilities, hello, lastWrite, now)) {
        try {
          const store = getBridgeStore(context);

          // Re-read: the row may have changed since authentication (e.g. revoked by a re-pair of this computer).
          const current = (await store.getDevice(device.id)) ?? device;

          await store.putDevice({
            ...current,
            capabilities: hello,
            lastSeenAt: new Date(now).toISOString(),
          });
        } catch (error) {
          // Presence is in memory; a failed persistence must not drop the poll.
          logger.warn(`Could not persist bridge device ${device.id}: ${(error as Error).message}`);
        }
      }
    }

    return json(await pollBridgeJobs(device.id, BRIDGE_POLL_HOLD_MS, request.signal), { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
