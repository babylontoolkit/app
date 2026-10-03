/**
 * 🔴 **THIS FILE IS THE PRODUCTION ENV DELIVERY MECHANISM, NOT A TYPE DECLARATION.**
 *
 * The production image starts with `pnpm run dockerstart` → `bindings.sh` → `wrangler pages dev`
 * (DEPLOY.md §2.2). `bindings.sh` greps THIS FILE for variable names and forwards only those it finds
 * in the container environment as `--binding NAME=value`. Under workerd `process.env` is empty, so a
 * variable that is not named here **does not reach the app at all**, however carefully it was put into
 * SSM and the deployment JSON.
 *
 * MEASURED (2026-07-28, plan T16): before the platform block below existed, this file listed only
 * upstream's provider keys — so a production container would have started with **no Supabase, no
 * Stripe, no S3, no KIE key and no CodeSandbox key**. Every one of those degrades to "not configured"
 * rather than crashing (§1.3 principle 0), which is exactly why it would have been so hard to see: the
 * app boots, serves, and quietly cannot bill, authenticate or open a sandbox.
 *
 * **Adding a `env(context, 'NEW_VAR')` read anywhere under `app/lib/.server/**` means adding the name
 * here too.** Listing a name costs nothing when the variable is unset (`bindings.sh` skips it);
 * omitting one costs a silent outage of whatever depends on it.
 */
interface Env {
  RUNNING_IN_DOCKER: Settings;
  DEFAULT_NUM_CTX: Settings;
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  GROQ_API_KEY: string;
  HuggingFace_API_KEY: string;
  OPEN_ROUTER_API_KEY: string;
  OLLAMA_API_BASE_URL: string;
  OPENAI_LIKE_API_KEY: string;
  OPENAI_LIKE_API_BASE_URL: string;
  OPENAI_LIKE_API_MODELS: string;
  TOGETHER_API_KEY: string;
  TOGETHER_API_BASE_URL: string;
  DEEPSEEK_API_KEY: string;
  LMSTUDIO_API_BASE_URL: string;
  GOOGLE_GENERATIVE_AI_API_KEY: string;
  MISTRAL_API_KEY: string;
  XAI_API_KEY: string;
  PERPLEXITY_API_KEY: string;
  AWS_BEDROCK_CONFIG: string;

  /*
   * ---------------------------------------------------------------------------------------------
   * Platform (this fork). Everything below is ours; everything above is upstream bolt.diy's.
   * ---------------------------------------------------------------------------------------------
   */

  /** Environment posture. `assertNotLocalInProduction` reads this — an unset value would let a prod deploy serve anonymous admin. */
  NODE_ENV: string;

  /** Absolute origins (SPEC §2.5, §5). `PLAY_URL` absent in production fails the /play path CLOSED. */
  APP_URL: string;
  PLAY_URL: string;

  /** Platform identity + database (SPEC §4.5). The service-role key BYPASSES RLS — server-only, never VITE_-prefixed. */
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;

  /** Payments (SPEC §4.6). */
  STRIPE_SECRET_KEY: string;
  STRIPE_PUBLISHABLE_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;

  /** The provider the platform actually buys tokens from, and the model selectors (SPEC §4.2a). */
  KIE_API_KEY: string;
  KIE_CREDITS_PER_USD: string;
  KIE_DEFAULT_MODEL: string;
  LLM_PROVIDER: string;
  LLM_MODEL: string;

  /**
   * Who serves image/video renders (SPEC §4.16) — KIE or Comet, its OWN switch. Unset, media follows
   * `LLM_PROVIDER`; `Anthropic` yields no media provider at all (they sell no renders). It selects a
   * gateway, never a key: the provider's existing `*_API_KEY` above is what pays.
   */
  MEDIA_PROVIDER: string;

  /**
   * The paid rungs of the MODEL TIER LADDER (§4.6.1a): Premium and Platinum. Each `*_MODEL` is a
   * SELECTOR priced by the active Marketplace price list — never a price — and each
   * `*_MINIMUM_CREDITS` is the balance a user must HOLD to unlock that rung.
   * `ENABLE_EXTENDED_MODELS` is the master switch over BOTH (default ON); `ENABLE_PLATINUM_MODEL`
   * withdraws Platinum alone and can only ever narrow the master switch, never widen it.
   *
   * ⚠️ `ENABLE_PREMIUM_MODEL`, `SUPERMAX_MODEL` and `SUPERMAX_MINIMUM_CREDITS` are RETIRED and
   * REFUSED if set (`billing/premium-model-flag.ts`), so they are deliberately absent from this type.
   * Note `ENABLE_PREMIUM_MODEL` was itself the LIVE name from 2026-08-08 to 2026-08-10 — the rename
   * reversed when Platinum restored the second paid rung, so which of the two is refused depends on
   * the date, and this file states the CURRENT answer.
   */
  ENABLE_EXTENDED_MODELS: string;
  ENABLE_PLATINUM_MODEL: string;
  PREMIUM_MODEL: string;
  PREMIUM_MINIMUM_CREDITS: string;
  PLATINUM_MODEL: string;
  PLATINUM_MINIMUM_CREDITS: string;

  /** Credit economics (`spec/billing.md`). Never fudge these to fix a margin — see the file's own warning. */
  CREDIT_MARGIN: string;
  CREDIT_UNIT_COST_USD: string;
  SIGNUP_GRANT_CREDITS: string;

  /** Object storage (`spec/hosting.md`) — play builds, remix seeds, template pins, working copies. */
  S3_BUCKET: string;
  S3_REGION: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  S3_ENDPOINT: string;
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  PLATFORM_DATA_DIR: string;

  /** Repo-primary persistence (SPEC §4.5.4b). The encryption key protects every stored git token. */
  GIT_TOKEN_ENCRYPTION_KEY: string;
  GIT_OAUTH_STATE_SECRET: string;
  GITHUB_TOKEN: string;
  GITHUB_API_KEY: string;
  GITHUB_ACCESS_TOKEN: string;
  GITLAB_HOST: string;

  /** Sandbox runtime (`spec/sandbox-codesandbox.md`). See DEPLOY.md §1.4 for defaults. */
  CODESANDBOX_API_KEY: string;
  CODESANDBOX_TEMPLATE: string;
  CODESANDBOX_VM_TIER: string;
  CODESANDBOX_HIBERNATION_SECONDS: string;
  CODESANDBOX_HOST_TOKEN_MINUTES: string;
  CODESANDBOX_MAX_CREATES_PER_HOUR: string;
  CODESANDBOX_MAX_RUNNING_VMS: string;

  /** Caps on client-supplied bytes (SPEC §5) — each one bounds an otherwise unbounded bill. */
  MAX_ATTACHMENTS: string;
  MAX_ATTACHMENT_BYTES: string;
  MAX_ATTACHMENT_BYTES_TOTAL: string;
  BUILD_MAX_MB: string;
  BUILD_MAX_FILES: string;
  PUBLISH_BODY_MAX_MB: string;
  REMIX_SEED_MAX_MB: string;
  WORKING_COPY_MAX_MB: string;

  /** Observability (SPEC §5A). Vendor-neutral webhooks; absent = the no-op monitor. */
  MONITORING_WEBHOOK_URL: string;
  ANALYTICS_WEBHOOK_URL: string;

  /** Operations. */
  ADMIN_TOKEN: string;
  TEMPLATE_PINNING_ENABLED: string;
  SERVER_SIDE_MCP_ENABLED: string;
  BILLING_ENFORCED: string;
  PRO_FEATURES_ENABLED: string;
  HISTORY_WINDOW_TURNS: string;

  /** Unity Bridge (SPEC §4.17). */
  UNITY_BRIDGE_ENABLED: string;
  BRIDGE_GRANT_PRIVATE_KEY: string;
  BRIDGE_GRANT_TTL_HOURS: string;

  /*
   * Read by the app but missing from this file until 2026-10-03 — so in production each one was
   * silently ignored and its code default applied (found while shipping the billing sweep).
   * `env-delivery.spec.ts` now fails any `env(context, 'NAME')` read that is not named here.
   */

  /** Agent engine + turn budgets (SPEC §4.2, §8l). */
  AGENT_ENGINE: string;
  AGENT_ENGINE_EVAL_OVERRIDE: string;
  AGENT_TOOL_LOOP: string;
  AGENT_CLAIM_TTL_MINUTES: string;
  AGENT_MAX_FILE_READS: string;
  AGENT_MAX_READ_CHARS: string;
  AGENT_MAX_PLAN_READ_CHARS: string;
  AGENT_MAX_REFERENCE_LOADS: string;

  /** Thinking effort (SPEC §4.2a, §4.2.9). `ENABLE_MAX_EFFORT` is the operator switch for the Max level. */
  THINKING_EFFORT: string;
  MANAGED_AGENT_EFFORT: string;
  ENABLE_MAX_EFFORT: string;

  /** Managed engine (SPEC §4.2, §4.6). `MANAGED_SESSION_HOUR_USD` is a billing rate. */
  MANAGED_AGENTS_ENVIRONMENT_ID: string;
  MANAGED_SESSION_HOUR_USD: string;
  MANAGED_SUPERSEDE_WAIT_MS: string;
  MANAGED_DETACH_SETTLE_WAIT_MS: string;
  MANAGED_DETACH_SETTLE_POLL_MS: string;

  /** No unbilled usage — the billing sweep (spec/billing.md). */
  BILLING_SWEEP_INTERVAL_MS: string;
  BILLING_SWEEP_STALE_MS: string;
  BILLING_SWEEP_MANAGED_WINDOW_MS: string;

  /** Pricing + grants (SPEC §4.6). `CREATION_FLAT_CREDITS` is RETIRED and refused if set — listed so the refusal fires in production too. */
  PROJECT_CREATE_CREDITS: string;
  CREATION_FLAT_CREDITS: string;
  GRANTS_ENABLED: string;

  /** Provider + media gateways (SPEC §4.2a, §4.16). */
  COMET_API_KEY: string;
  FAL_API_KEY: string;
  MEDIA_CALLBACK_URL: string;

  /** Prompt cache warmer (spec/context-budget.md). */
  CACHE_WARMER_ENABLED: string;
  CACHE_WARMER_FANOUT: string;
  CACHE_WARMER_INTERVAL_MINUTES: string;

  /** Skills, git import, sharing, sandbox cost model. */
  SKILLS_EXCLUDE: string;
  GIT_CLONE_MAX_MB: string;
  SHARE_DOMAIN: string;
  SANDBOX_VM_USD_PER_HOUR: string;
  SANDBOX_EST_VM_HOURS_PER_KCREDIT: string;

  /** Unity Editor subscription check (SPEC §4.18a). */
  UNITY_SUBSCRIPTION_API_KEY: string;
  UNITY_SUBSCRIPTION_RATE_MAX: string;
  UNITY_SUBSCRIPTION_RATE_WINDOW_MS: string;

  /** Read through wrappers (`numberSetting`, `*_ENV_KEY`, `readEnv`, `baseUrlKey`) — same silent-default failure. */
  AGENT_TURN_MAX_CREDITS: string;
  AGENT_MAX_SEGMENTS: string;
  AGENT_SEGMENT_STEPS: string;
  AGENT_CHECK_MAX_NUDGES: string;
  AGENT_COMPACT_AT_TOKENS: string;
  AUTO_MODEL_SELECT: string;
  LLM_PROVIDER_CHAIN: string;
  ENHANCE_PROMPT_MODEL: string;
  KIE_ENHANCE_PROMPT_MODEL: string;
  COMET_ENHANCE_PROMPT_MODEL: string;
  ANTHROPIC_ENHANCE_PROMPT_MODEL: string;
  KIE_BASE_URL: string;
  COMET_BASE_URL: string;
  ZAI_BASE_URL: string;

  /** Git OAuth (SPEC §4.13) — read as `${prefix}_OAUTH_CLIENT_ID|SECRET`; without these, Link to GitHub/GitLab is "not configured" in production. */
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  GITLAB_OAUTH_CLIENT_ID: string;
  GITLAB_OAUTH_CLIENT_SECRET: string;
}
