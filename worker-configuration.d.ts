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
   * The paid rung of the MODEL TIER LADDER (§4.6.1a). `PREMIUM_MODEL` is a SELECTOR priced by the
   * active Marketplace price list — never a price — and `PREMIUM_MINIMUM_CREDITS` is the balance a user
   * must HOLD to unlock it. `ENABLE_PREMIUM_MODEL` is the master switch (default ON).
   *
   * ⚠️ `ENABLE_EXTENDED_MODELS`, `SUPERMAX_MODEL` and `SUPERMAX_MINIMUM_CREDITS` are RETIRED and
   * REFUSED if set (`billing/premium-model-flag.ts`), so they are deliberately absent from this type.
   */
  ENABLE_PREMIUM_MODEL: string;
  PREMIUM_MODEL: string;
  PREMIUM_MINIMUM_CREDITS: string;

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
}
