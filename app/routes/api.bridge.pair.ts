/**
 * Unity Bridge device-code pairing (SPEC §4.17, D7).
 *
 *   POST /api/bridge/pair {action:'start', deviceName, os}     → {pairingId, secret, code:'XXXX-XXXX', expiresAt}
 *   POST /api/bridge/pair {action:'redeem', pairingId, secret} → {status:'pending'} | 410 {status:'expired'}
 *                                                               | {status:'approved', deviceId, token}
 *
 * PUBLIC BY DESIGN: the Desktop Agent is a CLI with no session. `start` is rate-limited per caller
 * fingerprint; `redeem` needs the pairing secret, which only the helper that started it holds, and it
 * returns a token only after a verified user approved the code in the builder. The token appears in
 * THIS response and nowhere else, ever — never logged.
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { BRIDGE_DISABLED_BODY, isBridgeEnabled } from '~/lib/.server/bridge/auth';
import { PAIR_START_RATE_LIMIT, redeemPairing, startPairing } from '~/lib/.server/bridge/pairing';
import { errorResponse } from '~/lib/.server/http';
import { callerFingerprint } from '~/lib/.server/licensing/unity-api-key';
import { enforceUserRateLimit } from '~/lib/.server/security/user-rate-limit';

const NO_STORE = { 'Cache-Control': 'no-store' };
const OSES = new Set(['darwin', 'win32', 'linux']);

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    if (request.method !== 'POST') {
      return json({ error: true, message: 'Method not allowed.' }, { status: 405, headers: NO_STORE });
    }

    if (!isBridgeEnabled(context)) {
      return json(BRIDGE_DISABLED_BODY, { status: 404, headers: NO_STORE });
    }

    let body: Record<string, unknown>;

    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    if (body?.action === 'start') {
      await enforceUserRateLimit({
        userId: 'fp:' + callerFingerprint(request),
        bucket: 'bridge-pair-start',
        rule: PAIR_START_RATE_LIMIT,
        subject: 'pairing attempts',
      });

      const { deviceName, os } = body;

      if (
        typeof deviceName !== 'string' ||
        deviceName.trim().length < 1 ||
        deviceName.trim().length > 80 ||
        typeof os !== 'string' ||
        !OSES.has(os)
      ) {
        return json({ error: true, message: 'deviceName and os are required.' }, { status: 400, headers: NO_STORE });
      }

      const started = await startPairing({ deviceName: deviceName.trim(), os, context });

      return json(
        { pairingId: started.pairingId, secret: started.secret, code: started.code, expiresAt: started.expiresAt },
        { headers: NO_STORE },
      );
    }

    if (body?.action === 'redeem') {
      if (typeof body.pairingId !== 'string' || typeof body.secret !== 'string') {
        return json({ error: true, message: 'pairingId and secret are required.' }, { status: 400, headers: NO_STORE });
      }

      const result = await redeemPairing({ pairingId: body.pairingId, secret: body.secret, context });

      return json(result, { status: result.status === 'expired' ? 410 : 200, headers: NO_STORE });
    }

    return json({ error: true, message: 'Unknown action.' }, { status: 400, headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
