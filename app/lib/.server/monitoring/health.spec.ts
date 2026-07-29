import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

    /*
     * ⚠️ Both halves of the sandbox question, and `VITE_SANDBOX_PROVIDER` is the one that bites.
     *
     * It is a BUILD-time switch, so `usesCodeSandbox()` reads `import.meta.env` as well as
     * `process.env` — and the owner's `.env.local` sets it to `codesandbox`, which vitest loads into
     * `import.meta.env`. Deleting it from `process.env` alone would leave the "WebContainer build"
     * test running as a CodeSandbox build on exactly the machine where someone would notice, and
     * green in CI. That is the `oauth.spec.ts` trap in its worst shape, so the sandbox tests below
     * `vi.stubEnv` this variable in BOTH directions rather than relying on the deletion here.
     */
    'VITE_SANDBOX_PROVIDER',
    'CODESANDBOX_API_KEY',

    /*
     * 🔴 A RETIRED VARIABLE IS PART OF THE PRECEDENCE CHAIN TOO — it decides whether
     * `getBillingConfig()` returns or THROWS.
     *
     * `buildHealthReport` → `isStripeConfigured` → `getBillingConfig`, which now refuses
     * `CREATION_FLAT_CREDITS` outright (§4.4a). The owner's `.env.local` still sets it (it was the
     * documented way to price a creation until 2026-07-29), so every test in this file threw a
     * `NotConfiguredError` on that machine while CI stayed green — the `oauth.spec.ts` trap wearing
     * the retirement's clothes. Scrubbed here rather than in the sandbox block because the throw is
     * upstream of every assertion, not just the sandbox ones.
     */
    'CREATION_FLAT_CREDITS',
  ];

  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }

    /*
     * `import.meta.env` is a separate object from `process.env` and the deletion above cannot reach it.
     * Stubbing it empty is what makes "this build is not a CodeSandbox build" true on a developer
     * machine whose `.env.local` says otherwise.
     */
    vi.stubEnv('VITE_SANDBOX_PROVIDER', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();

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

  /*
   * The sandbox runtime (plan T13, `spec/sandbox-codesandbox.md`).
   *
   * Which sandbox a deploy needs is a fact about the BUILD, not about the environment — the provider is
   * chosen by `VITE_SANDBOX_PROVIDER` at build time, and a WebContainer build has correctly dropped
   * `CODESANDBOX_API_KEY`. So the dependency is reported CONDITIONALLY, and both directions of getting
   * that wrong are silent:
   *
   *   - Report it unconditionally and every WebContainer deploy is `degraded` → `ready: false` forever,
   *     which is the mirror image of the `platformKey` bug above: §9a keys on `ready` to confirm "all
   *     green in prod", so a permanently-red signal is a signal nobody can act on.
   *   - Omit it on a CodeSandbox build and a deploy with no API key reports READY while every project
   *     open 503s — the same waved-through credential the `platformKey` fix exists to catch.
   *
   * 🔴 Config presence ONLY. There is deliberately no reachability probe: this endpoint is what an
   * uptime monitor polls, so a live provider call here would turn a CodeSandbox outage into a red
   * uptime alert plus a retry storm. Reachability is the rate windows' job (`sandbox-rates.ts`).
   */
  describe('codesandbox is reported only on a build that uses it', () => {
    /** Everything except the sandbox, so `ready` turns purely on the dependency under test. */
    const wireEverythingElse = () => {
      process.env.LLM_PROVIDER = 'KIE';
      process.env.KIE_API_KEY = 'kie-test';
      process.env.SUPABASE_URL = 'https://db.example.com';
      process.env.SUPABASE_ANON_KEY = 'anon-test';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test';
      process.env.STRIPE_SECRET_KEY = 'sk_test';
      process.env.PLAY_URL = 'https://play.example.com';
      process.env.MONITORING_WEBHOOK_URL = 'https://collector.example.com/errors';
      process.env.ANALYTICS_WEBHOOK_URL = 'https://collector.example.com/events';
    };

    it('is ok — and counts toward ready — on a CodeSandbox build with a key', () => {
      vi.stubEnv('VITE_SANDBOX_PROVIDER', 'codesandbox');
      process.env.CODESANDBOX_API_KEY = 'csb_test_key';
      wireEverythingElse();

      const report = buildHealthReport(undefined);

      expect(report.dependencies.codesandbox).toBe('ok');
      expect(report.ready).toBe(true);
    });

    it('🔴 is degraded — and drags ready false — on a CodeSandbox build with NO key', () => {
      /*
       * The whole point of reporting it: this deploy answers every `/api/sandbox/session` with a 503
       * and is otherwise indistinguishable from a healthy one. §9a's `ready` is the check that is
       * supposed to catch a missing credential before users do.
       */
      vi.stubEnv('VITE_SANDBOX_PROVIDER', 'codesandbox');
      wireEverythingElse();

      const report = buildHealthReport(undefined);

      expect(report.dependencies.codesandbox).toBe('degraded');
      expect(report.ready).toBe(false);

      // Still not an outage — a degraded dependency never moves liveness.
      expect(report.status).toBe('healthy');
    });

    it('🔴 is ABSENT on a WebContainer build, which is still ready without a CodeSandbox key', () => {
      /*
       * `VITE_SANDBOX_PROVIDER` unset is the WebContainer build (unset or a typo falls back to
       * WebContainer — the safe direction, `app/lib/sandbox/index.ts`). Such a deploy has no reason to
       * hold `CODESANDBOX_API_KEY`, and reporting a key it does not need as `degraded` would pin
       * `ready` to false on a perfectly healthy deploy for the rest of its life.
       *
       * ⚠️ `vi.stubEnv` rather than a `process.env` delete: the check reads `import.meta.env` too, and
       * this repo's own `.env.local` sets the provider to `codesandbox`. Without the stub this test
       * passes in CI and fails only on the machine of the person who configured the feature.
       */
      vi.stubEnv('VITE_SANDBOX_PROVIDER', '');
      wireEverythingElse();

      const report = buildHealthReport(undefined);

      expect(report.dependencies).not.toHaveProperty('codesandbox');
      expect(report.ready).toBe(true);
    });

    it('reports the sandbox when the container sets the variable without a matching build', () => {
      /*
       * `process.env` is checked as well as `import.meta.env` so a runtime that was handed the variable
       * without a rebuild is not silently reported as WebContainer — the answer should follow whichever
       * source says CodeSandbox, because that is the deploy an operator is trying to verify.
       */
      process.env.VITE_SANDBOX_PROVIDER = 'codesandbox';
      wireEverythingElse();

      expect(buildHealthReport(undefined).dependencies.codesandbox).toBe('degraded');
    });
  });
});
