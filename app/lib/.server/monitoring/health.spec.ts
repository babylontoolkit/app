import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHealthReport } from './health';
import { setPromptStore } from '~/lib/.server/prompt/store';
import { invalidateActivePrompt } from '~/lib/.server/prompt/active';

/**
 * 🔴 **CodeSandbox is DISABLED in the shipping build** (owner decision, 2026-07-31 —
 * `ENABLED_SANDBOX_PROVIDERS`): it bills per VM-hour, so no configuration may select it. `/api/health`
 * therefore reports no CodeSandbox dependency at all, whatever a stale deploy variable says.
 *
 * The conditional-reporting logic below is still exercised, because the provider is dormant rather
 * than deleted — the day someone re-enables it, its health reporting has to already work. This switch
 * is what lets both be true at once, and the un-mocked reality is asserted in its own block.
 */
const codeSandboxEnabled = vi.hoisted(() => ({ value: false }));

vi.mock('~/lib/common/sandbox-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/common/sandbox-runtime')>();

  return {
    ...actual,
    isSandboxProviderEnabled: (id: import('~/lib/common/sandbox-runtime').SandboxProviderId) =>
      id === 'codesandbox' ? codeSandboxEnabled.value : actual.isSandboxProviderEnabled(id),
  };
});

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
    'SHARE_DOMAIN',
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

    /*
     * 🔴 The `oauth.spec.ts` trap, one dependency later. `systemPrompt` reads a REAL store, and the
     * default one resolves to the developer's own object store — so "nothing is configured" would
     * quietly become "…except the prompt version I happen to have synced locally", and `ready` would
     * differ between a developer's machine and CI. Pinned empty here; the tests that care override it.
     */
    setPromptStore({ getActive: async () => null } as unknown as Parameters<typeof setPromptStore>[0]);
    invalidateActivePrompt();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setPromptStore(undefined);
    invalidateActivePrompt();

    for (const k of keys) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });

  it('reports healthy liveness and NOT ready when nothing is configured', async () => {
    const report = await buildHealthReport(undefined);

    expect(report.status).toBe('healthy');
    expect(report.ready).toBe(false);
    expect(report.dependencies.platformKey).toBe('degraded');
    expect(report.dependencies.playOrigin).toBe('degraded');
  });

  /*
   * 🔴 A deploy with no prompt version fails EVERY generation, and used to report itself ready.
   *
   * There is no boot-time doc-sync — a version is built only by an admin pressing Refresh or a `curl`
   * with `ADMIN_TOKEN` — so a brand-new environment has none and `proxy.ts` throws
   * `NotConfiguredError('The system prompt')` on every request. This is the same failure the
   * `platformKey` block below describes ("healthy AND ready while 503ing every generation"), which is
   * exactly why it belongs in the one check §9a keys on.
   */
  describe('the system prompt is a reported dependency', () => {
    it('is degraded, and blocks ready, when no version is active', async () => {
      setPromptStore({ getActive: async () => null } as unknown as Parameters<typeof setPromptStore>[0]);
      invalidateActivePrompt();

      const report = await buildHealthReport(undefined);

      expect(report.dependencies.systemPrompt).toBe('degraded');
      expect(report.ready).toBe(false);

      // Liveness is unaffected: a degraded dependency is not an outage.
      expect(report.status).toBe('healthy');
    });

    it('CONTROL — is ok once a version is active', async () => {
      setPromptStore({ getActive: async () => ({ id: 'pv_test' }) } as unknown as Parameters<typeof setPromptStore>[0]);
      invalidateActivePrompt();

      expect((await buildHealthReport(undefined)).dependencies.systemPrompt).toBe('ok');
    });

    /*
     * Observability must never be the thing that breaks the health endpoint. A store that throws is
     * reported as `degraded` — the same answer as "no version", and the honest one: we cannot confirm
     * we can serve.
     */
    it('reports degraded rather than throwing when the store errors', async () => {
      setPromptStore({
        getActive: async () => {
          throw new Error('S3 unreachable');
        },
      } as unknown as Parameters<typeof setPromptStore>[0]);
      invalidateActivePrompt();

      const report = await buildHealthReport(undefined);

      expect(report.dependencies.systemPrompt).toBe('degraded');
      expect(report.status).toBe('healthy');
    });
  });

  /*
   * ⚠️ `LLM_PROVIDER` is set EXPLICITLY, never left to the default.
   *
   * This test used to set only `ANTHROPIC_API_KEY` and assume that WAS the platform key. That was true
   * while Anthropic was the only provider, and it broke the moment the default became KIE — correctly,
   * because the assumption had silently become false. A test that leans on the default is really
   * testing the default; pin what you mean.
   */
  it('flips a dependency to ok once its env is present', async () => {
    process.env.LLM_PROVIDER = 'Anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.SHARE_DOMAIN = 'codewrx.app';

    const report = await buildHealthReport(undefined);

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
  it('defaults to KIE, so KIE_API_KEY alone is a healthy platform key', async () => {
    process.env.KIE_API_KEY = 'kie-test';

    expect((await buildHealthReport(undefined)).dependencies.platformKey).toBe('ok');
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
    it('is degraded on KIE when only the Anthropic key is set', async () => {
      process.env.LLM_PROVIDER = 'KIE';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

      expect((await buildHealthReport(undefined)).dependencies.platformKey).toBe('degraded');
    });

    it('is ok on KIE with only the KIE key set — an Anthropic key is not required', async () => {
      process.env.LLM_PROVIDER = 'KIE';
      process.env.KIE_API_KEY = 'kie-test';

      expect((await buildHealthReport(undefined)).dependencies.platformKey).toBe('ok');
    });

    it('is degraded on Anthropic when only the KIE key is set', async () => {
      process.env.LLM_PROVIDER = 'Anthropic';
      process.env.KIE_API_KEY = 'kie-test';

      expect((await buildHealthReport(undefined)).dependencies.platformKey).toBe('degraded');
    });
  });

  it('is never anything but healthy for liveness, even fully unconfigured', async () => {
    expect((await buildHealthReport(undefined)).status).toBe('healthy');
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
    // Dormant-but-tested: see `codeSandboxEnabled` at the top of this file.
    beforeEach(() => {
      codeSandboxEnabled.value = true;
    });

    afterEach(() => {
      codeSandboxEnabled.value = false;
    });

    /** Everything except the sandbox, so `ready` turns purely on the dependency under test. */
    const wireEverythingElse = () => {
      process.env.LLM_PROVIDER = 'KIE';
      process.env.KIE_API_KEY = 'kie-test';
      process.env.SUPABASE_URL = 'https://db.example.com';
      process.env.SUPABASE_ANON_KEY = 'anon-test';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test';
      process.env.STRIPE_SECRET_KEY = 'sk_test';
      process.env.SHARE_DOMAIN = 'codewrx.app';
      process.env.MONITORING_WEBHOOK_URL = 'https://collector.example.com/errors';
      process.env.ANALYTICS_WEBHOOK_URL = 'https://collector.example.com/events';

      /*
       * The prompt version is not an env var, but it IS part of "everything else" — a deploy with no
       * active version is not ready no matter how complete its configuration is. Left out, `ready`
       * would turn on this instead of on the dependency each test names.
       */
      setPromptStore({ getActive: async () => ({ id: 'pv_test' }) } as unknown as Parameters<typeof setPromptStore>[0]);
      invalidateActivePrompt();
    };

    it('is ok — and counts toward ready — on a CodeSandbox build with a key', async () => {
      vi.stubEnv('VITE_SANDBOX_PROVIDER', 'codesandbox');
      process.env.CODESANDBOX_API_KEY = 'csb_test_key';
      wireEverythingElse();

      const report = await buildHealthReport(undefined);

      expect(report.dependencies.codesandbox).toBe('ok');
      expect(report.ready).toBe(true);
    });

    it('🔴 is degraded — and drags ready false — on a CodeSandbox build with NO key', async () => {
      /*
       * The whole point of reporting it: this deploy answers every `/api/sandbox/session` with a 503
       * and is otherwise indistinguishable from a healthy one. §9a's `ready` is the check that is
       * supposed to catch a missing credential before users do.
       */
      vi.stubEnv('VITE_SANDBOX_PROVIDER', 'codesandbox');
      wireEverythingElse();

      const report = await buildHealthReport(undefined);

      expect(report.dependencies.codesandbox).toBe('degraded');
      expect(report.ready).toBe(false);

      // Still not an outage — a degraded dependency never moves liveness.
      expect(report.status).toBe('healthy');
    });

    it('🔴 is ABSENT on a browser-runtime build, which is still ready without a CodeSandbox key', async () => {
      /*
       * `VITE_SANDBOX_PROVIDER` unset is the default build — **Nodepod** since 2026-07-31, when the
       * fallback moved off the paid runtimes (a typo must never select something that spends).
       * Such a deploy has no reason to hold `CODESANDBOX_API_KEY`, and reporting a key it does not
       * need as `degraded` would pin
       * `ready` to false on a perfectly healthy deploy for the rest of its life.
       *
       * ⚠️ `vi.stubEnv` rather than a `process.env` delete: the check reads `import.meta.env` too, and
       * this repo's own `.env.local` sets the provider to `codesandbox`. Without the stub this test
       * passes in CI and fails only on the machine of the person who configured the feature.
       */
      vi.stubEnv('VITE_SANDBOX_PROVIDER', '');
      wireEverythingElse();

      const report = await buildHealthReport(undefined);

      expect(report.dependencies).not.toHaveProperty('codesandbox');
      expect(report.ready).toBe(true);
    });

    it('reports the sandbox when the container sets the variable without a matching build', async () => {
      /*
       * `process.env` is checked as well as `import.meta.env` so a runtime that was handed the variable
       * without a rebuild is not silently reported as WebContainer — the answer should follow whichever
       * source says CodeSandbox, because that is the deploy an operator is trying to verify.
       */
      process.env.VITE_SANDBOX_PROVIDER = 'codesandbox';
      wireEverythingElse();

      expect((await buildHealthReport(undefined)).dependencies.codesandbox).toBe('degraded');
    });
  });

  /*
   * 🔴 THE SHIPPING WALL, un-mocked. CodeSandbox is disabled (`ENABLED_SANDBOX_PROVIDERS`), so the
   * `|| process.env` arm above stops being a chosen risk and becomes a guaranteed lie: without the
   * enabled-check in `usesCodeSandbox`, one stale deploy variable would demand a credential for a
   * runtime this image cannot load and hold `ready` false forever — the §9a outage that whole block
   * exists to avoid, arriving through the fix rather than through the bug.
   */
  describe('with the real enable list, CodeSandbox is never reported', () => {
    it.each(['codesandbox', ''])('ignores VITE_SANDBOX_PROVIDER=%s', async (value) => {
      vi.stubEnv('VITE_SANDBOX_PROVIDER', value);
      process.env.VITE_SANDBOX_PROVIDER = value;

      expect((await buildHealthReport(undefined)).dependencies).not.toHaveProperty('codesandbox');
    });
  });
});
