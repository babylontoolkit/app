/**
 * The Babylon Toolkit license service client (SPEC §4.6.1).
 *
 * The license service is the **sole authority** on who is a Pro Tools subscriber. This platform never
 * talks to a subscription or payment provider for entitlements — how the license service verifies a
 * subscription internally is outside this system's boundary.
 *
 * Scope boundary: `ValidateSubscription` is the ONLY operation we call. Project license keys and the
 * Generate Project License flow belong to the Unity Editor Export Tool; web projects (including
 * builder exports) neither use nor check them.
 *
 * **Build-first.** The endpoint may not be live yet. This client is written against the contract and
 * returns `{active: false}` on ANY failure — unreachable, malformed, unauthorized. The result is that
 * the user is in Credits mode, which is the full product. No feature is blocked (§1.3 principle 0).
 */
import { createScopedLogger } from '~/utils/logger';
import { env } from '~/lib/.server/env';
import { getMonitor, ALERT_SIGNALS } from '~/lib/.server/monitoring';

const logger = createScopedLogger('licenser');

export type EntitlementTier = 'indie' | 'small_business' | 'enterprise';

export interface SubscriptionStatus {
  active: boolean;
  tier?: EntitlementTier;
  expiresAt?: string;

  /**
   * True when we could not REACH the service, as opposed to reaching it and being told "not a
   * subscriber". The distinction is the whole point of the grace window: an outage on our side must
   * never lapse a paying customer (§4.6.1).
   */
  unreachable?: boolean;
}

export interface LicenserConfig {
  endpoint: string;
  sharedSecret?: string;
  timeoutMs: number;
}

export function getLicenserConfig(context?: unknown): LicenserConfig {
  return {
    endpoint: env(context, 'LICENSE_SERVICE_URL') || 'https://www.babylontoolkit.com/licenser.asmx',
    sharedSecret: env(context, 'LICENSE_SERVICE_SECRET'),
    timeoutMs: 8000,
  };
}

/** XML-escape a value before it goes into the SOAP envelope. An email with `&` must not break it. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Pull one element's text out of a SOAP response. The payload is tiny and fixed; a parser is overkill. */
function extractTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);

  return match?.[1]?.trim();
}

function normalizeTier(raw?: string): EntitlementTier | undefined {
  switch (raw?.toLowerCase().replace(/[\s-]/g, '_')) {
    case 'indie':
      return 'indie';
    case 'small_business':
      return 'small_business';
    case 'enterprise':
      return 'enterprise';
    default:
      return undefined;
  }
}

/**
 * `ValidateSubscription(email) → { active, tier, expiry }`.
 *
 * Server-to-server only — the shared secret must never be callable from a browser, which is why this
 * module lives under `.server/` and is only ever reached through the entitlement refresh.
 */
export async function validateSubscription(email: string, context?: unknown): Promise<SubscriptionStatus> {
  const config = getLicenserConfig(context);

  if (!email) {
    return { active: false };
  }

  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <ValidateSubscription xmlns="http://babylontoolkit.com/">
      <email>${escapeXml(email)}</email>
      <secret>${escapeXml(config.sharedSecret ?? '')}</secret>
    </ValidateSubscription>
  </soap:Body>
</soap:Envelope>`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: 'http://babylontoolkit.com/ValidateSubscription',
      },
      body: envelope,
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn(`License service returned ${response.status} — treating as unreachable`);
      getMonitor(context).alert(
        ALERT_SIGNALS.LICENSE_SERVICE_UNREACHABLE,
        `License service returned HTTP ${response.status}`,
        { severity: 'warning' },
      );

      return { active: false, unreachable: true };
    }

    const xml = await response.text();
    const active = extractTag(xml, 'active')?.toLowerCase() === 'true';

    if (!active) {
      return { active: false };
    }

    return {
      active: true,
      tier: normalizeTier(extractTag(xml, 'tier')),
      expiresAt: extractTag(xml, 'expiry') || extractTag(xml, 'expiresAt'),
    };
  } catch (error) {
    /*
     * Unreachable — NOT "not a subscriber". The caller applies the grace window rather than lapsing
     * the user. Getting this branch wrong would mean every license-service hiccup silently downgrades
     * every Pro customer on the platform.
     */
    const reason = (error as Error).name === 'AbortError' ? 'timed out' : (error as Error).message;
    logger.warn(`License service unreachable (${reason}) — no entitlement change`);
    getMonitor(context).alert(ALERT_SIGNALS.LICENSE_SERVICE_UNREACHABLE, `License service unreachable: ${reason}`, {
      severity: 'warning',
    });

    return { active: false, unreachable: true };
  } finally {
    clearTimeout(timer);
  }
}
