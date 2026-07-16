/**
 * `GET /healthz` — the conventional container/uptime health path (DEPLOY.md monitors this exact URL).
 *
 * An alias for `/api/health` so the uptime monitor and the load balancer can use the name they expect
 * without knowing our Remix route layout. Same report, same guarantees (see `monitoring/health.ts`).
 */
import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { buildHealthReport } from '~/lib/.server/monitoring/health';

export const loader = async ({ context }: LoaderFunctionArgs) => {
  return json(buildHealthReport(context));
};
