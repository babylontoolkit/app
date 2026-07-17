import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHealthReport } from './health';

/**
 * The health report is what an uptime monitor and the §9a credential-pass verification read. Two
 * invariants matter: liveness is ALWAYS healthy (a degraded dependency is not an outage), and `ready`
 * is true only when every dependency is wired — the single "all green in prod" signal.
 */
describe('buildHealthReport', () => {
  /*
   * ⚠️ EVERY env this report reads must be scrubbed, or "nothing is configured" is a lie.
   *
   * `env()` falls back to `process.env` and vitest loads `.env.local`, so a key missing from this list
   * silently resolves to the developer's REAL value — the trap `oauth.spec.ts` documents. It bit the
   * moment `LLM_PROVIDER`/`KIE_API_KEY` existed: a developer who had correctly configured KIE saw the
   * unconfigured-state test fail, blaming code they had not touched, while CI (no `.env.local`) stayed
   * green. That is the worst shape a failure can take — it teaches the one person who can see it that
   * a red suite is normal.
   *
   * Adding an env to `buildHealthReport` means adding it HERE.
   */
  const keys = [
    'LLM_PROVIDER',
    'ANTHROPIC_API_KEY',
    'KIE_API_KEY',
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

  /*
   * ⚠️ `LLM_PROVIDER` is set EXPLICITLY, never left to the default.
   *
   * This test used to set only `ANTHROPIC_API_KEY` and assume that WAS the platform key. That was true
   * while Anthropic was the only provider, and it broke the moment the default became KIE — correctly,
   * because the assumption had silently become false. A test that leans on the default is really
   * testing the default; pin what you mean.
   */
  it('flips a dependency to ok once its env is present', () => {
    process.env.LLM_PROVIDER = 'Anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.PLAY_URL = 'https://play.example.com';

    const report = buildHealthReport(undefined);

    expect(report.dependencies.platformKey).toBe('ok');
    expect(report.dependencies.playOrigin).toBe('ok');

    // Still not fully ready — Supabase/Stripe/monitoring remain unset.
    expect(report.ready).toBe(false);
  });

  /*
   * The DEFAULT path, with no env file at all — the deploy shape the owner asked about ("if I was not
   * using .env files"). The platform key must resolve to KIE's, not Anthropic's, or a correctly
   * configured default deploy reports degraded forever and §9a's `ready` never goes green.
   */
  it('defaults to KIE, so KIE_API_KEY alone is a healthy platform key', () => {
    process.env.KIE_API_KEY = 'kie-test';

    expect(buildHealthReport(undefined).dependencies.platformKey).toBe('ok');
  });

  /*
   * `platformKey` must report on the key the CONFIGURED provider actually needs.
   *
   * It asked about `anthropicApiKey` unconditionally, so a KIE deploy missing its KIE key reported
   * healthy AND ready while 503ing every generation — and §9a keys on `ready` to confirm a credential
   * pass, so the one check built to catch this would have waved it through. Both directions are pinned:
   * a wrong-key-present must not read as ok, and the right key alone must be enough.
   */
  describe('platformKey follows the configured provider', () => {
    it('is degraded on KIE when only the Anthropic key is set', () => {
      process.env.LLM_PROVIDER = 'KIE';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

      expect(buildHealthReport(undefined).dependencies.platformKey).toBe('degraded');
    });

    it('is ok on KIE with only the KIE key set — an Anthropic key is not required', () => {
      process.env.LLM_PROVIDER = 'KIE';
      process.env.KIE_API_KEY = 'kie-test';

      expect(buildHealthReport(undefined).dependencies.platformKey).toBe('ok');
    });

    it('is degraded on Anthropic when only the KIE key is set', () => {
      process.env.LLM_PROVIDER = 'Anthropic';
      process.env.KIE_API_KEY = 'kie-test';

      expect(buildHealthReport(undefined).dependencies.platformKey).toBe('degraded');
    });
  });

  it('is never anything but healthy for liveness, even fully unconfigured', () => {
    expect(buildHealthReport(undefined).status).toBe('healthy');
  });
});
