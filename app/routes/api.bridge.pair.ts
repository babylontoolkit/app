/**
 * Unity Bridge install-code claim (SPEC §4.17, D55).
 *
 *   POST /api/bridge/pair {action:'claim', code, deviceName, os} → {deviceId, token}
 *                                                                 | 410 (unknown / used / expired code)
 *                                                                 | 409 (device cap)
 *
 * PUBLIC BY DESIGN: the Desktop Agent is a CLI with no session. The single-use code was minted by a
 * signed-in user in the Unity Bridge dialog (`POST /api/bridge/devices {action:'invite'}`), and claiming is
 * rate-limited per caller fingerprint. The token appears in THIS response and nowhere else, ever — never
 * logged.
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { BRIDGE_DISABLED_BODY, isBridgeEnabled } from '~/lib/.server/bridge/auth';
import { CLAIM_RATE_LIMIT, claimInstallCode } from '~/lib/.server/bridge/pairing';
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

    if (body?.action !== 'claim') {
      return json({ error: true, message: 'Unknown action.' }, { status: 400, headers: NO_STORE });
    }

    await enforceUserRateLimit({
      userId: 'fp:' + callerFingerprint(request),
      bucket: 'bridge-pair-claim',
      rule: CLAIM_RATE_LIMIT,
      subject: 'pairing attempts',
    });

    const { code, deviceName, os } = body;

    if (
      typeof code !== 'string' ||
      !code.trim() ||
      typeof deviceName !== 'string' ||
      deviceName.trim().length < 1 ||
      deviceName.trim().length > 80 ||
      typeof os !== 'string' ||
      !OSES.has(os)
    ) {
      return json(
        { error: true, message: 'code, deviceName and os are required.' },
        { status: 400, headers: NO_STORE },
      );
    }

    const claimed = await claimInstallCode({ code, deviceName: deviceName.trim(), os, context });

    return json({ deviceId: claimed.deviceId, token: claimed.token }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
