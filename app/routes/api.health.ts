/**
 * Health / liveness endpoint (SPEC §5A).
 *
 * `GET /api/health` — a fast, unauthenticated liveness answer plus a per-dependency configuration
 * report. It never makes a live network call and never returns a secret value (only whether each
 * subsystem is CONFIGURED), so it is safe to expose to an uptime monitor. See `monitoring/health.ts`
 * for why liveness stays `200 healthy` even when dependencies are `degraded`.
 */
import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { buildHealthReport } from '~/lib/.server/monitoring/health';

export const loader = async ({ context }: LoaderFunctionArgs) => {
  return json(buildHealthReport(context));
};
