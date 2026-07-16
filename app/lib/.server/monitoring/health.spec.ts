import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHealthReport } from './health';

/**
 * The health report is what an uptime monitor and the §9a credential-pass verification read. Two
 * invariants matter: liveness is ALWAYS healthy (a degraded dependency is not an outage), and `ready`
 * is true only when every dependency is wired — the single "all green in prod" signal.
 */
describe('buildHealthReport', () => {
  const keys = [
    'ANTHROPIC_API_KEY',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_ANON_KEY',
    'STRIPE_SECRET_KEY',
    'PLAY_URL',
    'MONITORING_WEBHOOK_URL',
    'ANALYTICS_WEBHOOK_URL',
  ];

  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });

  it('reports healthy liveness and NOT ready when nothing is configured', () => {
    const report = buildHealthReport(undefined);

    expect(report.status).toBe('healthy');
    expect(report.ready).toBe(false);
    expect(report.dependencies.platformKey).toBe('degraded');
    expect(report.dependencies.playOrigin).toBe('degraded');
  });

  it('flips a dependency to ok once its env is present', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.PLAY_URL = 'https://play.example.com';

    const report = buildHealthReport(undefined);

    expect(report.dependencies.platformKey).toBe('ok');
    expect(report.dependencies.playOrigin).toBe('ok');

    // Still not fully ready — Supabase/Stripe/monitoring remain unset.
    expect(report.ready).toBe(false);
  });

  it('is never anything but healthy for liveness, even fully unconfigured', () => {
    expect(buildHealthReport(undefined).status).toBe('healthy');
  });
});
