import { LLMManager } from '~/lib/modules/llm/manager';
import type { Template } from '~/types/template';

/**
 * The name WebContainer is asked to give its working directory (`workdirName`).
 *
 * WebContainer-specific by nature — it is a boot parameter of that runtime, and only
 * `~/lib/webcontainer/index.ts` consumes it. A server provider does not get to choose its path.
 */
export const WORK_DIR_NAME = 'project';

/**
 * Where the user's project lives inside the sandbox.
 *
 * 🔴 **This is a property of the RUNTIME, so it follows the same build-time switch the runtime does.**
 * It was `/home/${WORK_DIR_NAME}` — correct for WebContainer and silently wrong for anything else.
 * CodeSandbox puts a project at `/project/workspace`, and the mismatch is invisible rather than
 * loud: the file map fills with correct `/project/workspace/...` keys from the watcher while the
 * file tree renders `rootFolder={WORK_DIR}` and matches nothing, so the workbench shows an EMPTY
 * PROJECT sitting on top of 64 real files (MEASURED live).
 *
 * It stays a plain synchronous constant because ~6 call sites — the editor's root folder, the
 * breadcrumb regex, the search root, the diff regex, and the system prompt's description of the
 * project layout — read it at module scope and cannot await a provider. Deriving it from
 * `VITE_SANDBOX_PROVIDER` keeps that shape while making it true per build, which is exactly the
 * granularity the switch already has (SPEC §8: "we make builds for that").
 *
 * ⚠️ It must agree with `SANDBOX_ROOTS` in `~/lib/common/sandbox-paths.ts`, which is the one place
 * that knows every provider's root. Adding a provider means touching both.
 */
export const WORK_DIR =
  import.meta.env.VITE_SANDBOX_PROVIDER === 'codesandbox' ? '/project/workspace' : `/home/${WORK_DIR_NAME}`;
export const MODIFICATIONS_TAG_NAME = 'bolt_file_modifications';
export const MODEL_REGEX = /^\[Model: (.*?)\]\n\n/;
export const PROVIDER_REGEX = /\[Provider: (.*?)\]\n\n/;

/*
 * The platform's default model (SPEC §4.2a) — the value used when NO env var and NO SSM property is
 * set. `LLM_MODEL` overrides it at runtime (validated against the rate tables — see
 * `agent/config.ts`); this is what a bare `docker run` with an empty environment gets.
 *
 * ## `claude-sonnet-5` — the STANDARD rung since 2026-07-31 (owner decision)
 *
 * The platform ships a three-class ladder (SPEC §4.6.1a): **Standard** (this constant) · **Premium**
 * (`PREMIUM_MODEL`, Opus 5) · **SuperMax** (`SUPERMAX_MODEL`, Fable 5). This is the rung every
 * generation runs on unless a user has deliberately bought their way up, so it is the one that decides
 * whether ordinary editing is affordable.
 *
 * The money case is measured on the platform's own generation log, not a vendor sheet. Opus 5 was
 * costing 450–500 credits on edits that felt small, and across 19 real Opus 5 generations the median
 * was **435 credits**, p90 **913**, max **1,095**. Re-pricing those exact token vectors at Sonnet 5's
 * KIE rates ($0.85/$4.275 against Opus 5's $2/$10):
 *
 * | model      | median | p90 | max   | 62 real generations |
 * |------------|--------|-----|-------|---------------------|
 * | opus-5     | 435    | 913 | 1,095 | 20,463 cr / $46.84  |
 * | sonnet-5   | 185    | 245 |   322 |  7,489 cr / $18.65  |
 *
 * **2.73x cheaper for the same work**, with the tail compressing hardest (p90 falls 3.7x, because the
 * spikes are cache WRITES billed at 2x and Sonnet scales every one of them down). Anyone who wants the
 * old behaviour now buys it a rung up, deliberately, instead of every user paying for it by default.
 *
 * ## 🔴 The vendor risk this carries, and the one-variable escape hatch
 *
 * Sonnet 5 was tried once before — 2026-07-30 — and reverted the same day, because KIE could not serve
 * it. Measured against the live API with an INTERLEAVED control (same key, same request shape, same
 * minute, alternating models, so a provider blip cannot masquerade as a model fault):
 *
 * | model      | ok     | HTTP 500 | rate |
 * |------------|--------|----------|------|
 * | sonnet-5   |  7 /30 |       23 | 77%  |
 * | opus-5     | 21 /22 |        1 |  5%  |
 *
 * `{"type":"api_error","message":"Network error, please try again later."}`, in ~1.9s — too fast to be
 * a timeout, and reproduced at `max_tokens: 1` and at a realistic 300-token request alike. Our
 * `MAX_PROVIDER_RETRY_ATTEMPTS = 3` does not rescue that: 0.77³ still leaves ~46% of generations dead.
 * Opus 5's single failure is the ordinary KIE flakiness the retry policy exists for.
 *
 * That is a VENDOR fault, which means it can clear — or come back — without anyone telling us. So:
 * **re-probe before trusting either verdict**, and if the 500s return, the revert is
 * `LLM_MODEL=claude-opus-5` — config only, no rebuild and no deploy of this file (§4.2a). That escape
 * hatch is the only reason this constant is allowed to carry vendor risk at all; do not remove
 * `LLM_MODEL`'s precedence over this value.
 *
 * 🔴 **RE-PROBED 2026-07-31, THE SAME DAY: IT GOT WORSE, AND THE ESCAPE HATCH IS CURRENTLY REQUIRED.**
 * 136 live requests, interleaved and order-rotated, at `max_tokens` 1 and 300, `thinkingFlag` on and
 * off — `node scripts/kie-model-health.mjs` reproduces it. **KIE served 2 of the 10 Claude models it
 * PRICES**: `claude-opus-5` (22/22) and `claude-opus-4-8` (12/12), everything else at 0 successes —
 * sonnet-5, sonnet-4-6 (2/18 in the first pass), sonnet-4-5, opus-4-7, opus-4-6, opus-4-5, haiku-4-5
 * and fable-5, all `HTTP 500 "Network error"` in ~1.5s.
 *
 * **Read it as a KIE catalogue outage, not a fact about Sonnet.** The 07-30 measurement looked like a
 * Sonnet-5 fault because only Sonnet 5 and Opus 5 were in the sample; probing the whole catalogue
 * shows the Opus 4-8/5 line standing and everything else down, including `claude-fable-5`, which had
 * been serving as the premium model days earlier, and `claude-opus-4-7`, a former platform default.
 * **A one-model probe cannot tell a model fault from an outage — probe the catalogue.**
 *
 * Consequences while it lasts: a deploy MUST set `LLM_MODEL=claude-opus-5` or every generation fails,
 * and two of the three §4.6.1a rungs (Standard and SuperMax) cannot run. The value of this constant is
 * a decision about where the platform sits when the provider is healthy; it is not a claim that the
 * provider is healthy today. Owner decision 2026-07-31: keep it, wait for KIE. Re-probe before
 * removing this note.
 *
 * ⚠️ Sonnet 5 clears the bar that disqualified 4-7 and fable-5 below: its cache accounting is HONEST
 * (a 5,404-token write reported on a cold request, a clean 5,420-token READ on a warm one). It is also
 * LISTED in `KIE_MODELS`, which is not cosmetic — priced-but-unlisted is survivable for an operator
 * override (`kieEnvModel` synthesises a `ModelInfo` from `LLM_MODEL`) and NOT survivable as a bare
 * default: with no env var there is nothing to synthesise, so the enhancer path would fall through to
 * `modelsList[0]` while settlement charged Sonnet's rates — the mis-bill this file's closing warning
 * names.
 *
 * ## `claude-opus-5` — the PREMIUM rung; the default from 2026-07-27 to 07-31, at KIE's $2/$10
 *
 * The swap was gated on re-verifying the TWO properties that made 4-8 the default, both probed live
 * against KIE on 2026-07-27:
 *
 *   1. **Cache accounting holds** — the deal-breaker for 4-7/fable (billed for cache writes they
 *      REPORT as 0, so settlement would silently eat the cache cost). Opus 5 reports honestly: a
 *      cold request reported a 5,419-token 1h cache WRITE, warm ones a 5,419-token cache READ, flat
 *      `cache_creation_input_tokens`/`cache_read_input_tokens` fields present — settles like 4-8.
 *   2. **Thinking text is still empty** (0 deltas on a forced think; 12.4s dead air then the
 *      answer) — the adapter-wide KIE regression of 2026-07-24 covers Opus 5 too, so the §4.2a
 *      liveness heartbeat (`agent/heartbeat.ts`) remains load-bearing and nothing about the swap
 *      changes the thinking story. `capabilities.ts` already knows Opus 5's one API quirk:
 *      `{type:'disabled'}` is a 400 at `xhigh`/`max` (`THINKING_DISABLED_EFFORT_CEILING`).
 *
 * ## Why Opus 4.8 held the slot before that, despite KIE not streaming its thinking text
 *
 * This was 4.7 for exactly one turn (2026-07-17), because 4.7 is the only top-tier model whose
 * thinking text KIE's adapter returns (266 chars measured, against 4.8's 0 in every shape tried). It
 * was reverted the moment the money was measured, and the reason is worth keeping:
 *
 * 🔴 **On KIE, `claude-opus-4-8` is the ONLY model that accounts for cached tokens.** With a ~5k
 * `system` block and `cache_control`, KIE reports:
 *
 * | model      | reported in | reported cache write | actually CHARGED |
 * |------------|-------------|----------------------|------------------|
 * | opus-4-8   | 14          | **10,004** ✅        | 8.02 cr — exact  |
 * | opus-4-7   | 13          | **0** 🔴             | 3.4 cr (2x = a write) |
 * | fable-5    | 13          | **0** 🔴             | 9.53 cr (2x = a write) |
 *
 * 4.7 and Fable are BILLED for the cache write and REPORT nothing. We settle from reported usage
 * (§4.6), so we would charge the user for output only and silently eat ~$0.32 of input on every
 * creation — a loss that grows with the prefix, throws nothing, and fails no test. A visible thinking
 * window is not worth an invisible per-generation loss.
 *
 * Caching is not a nicety here, it is the product's unit economics: a warm edit measured **65 credits**
 * against 393/831/574 for cold ones (CLAUDE.md "THE BIGGEST OPEN NUMBER"), i.e. ~13 edits/month on a
 * $50 plan versus ~92. A model that cannot cache honestly cannot be the default at any quality.
 *
 * ✅ **The churn that caused those cold turns is FIXED** (`selectStickyBlocks`; the skill half was retired 2026-07-26 when the model took over skill selection,
 * 2026-07-17). It was OUR bug and model-independent — `selectOnDemandBlocks` re-routed per message, so
 * the user's PHRASING re-ordered blocks sitting ahead of the ~110k file context and invalidated it. 4.8
 * only made a warm prefix possible; sticky routing is what makes one happen. Post-fix, a warm edit on KIE
 * measures ~11 credits (~545 per $50 pack). ⚠️ The 13-vs-92 figures above are the PRE-FIX measurement,
 * kept because they are why this model was chosen — do not quote them as current.
 *
 * The accepted cost: on KIE we pay full output rate for reasoning we cannot show (§4.2a's
 * `display: 'omitted'` pathology). Revisit the day KIE's adapter covers 4-8 — everything else is built.
 *
 * ⚠️ Changing this means adding the new model's rate row first (`billing/baked-market-prices.ts` +
 * `billing/rates.ts`) — a price cannot be guessed, only looked up — re-checking `grantHeadroom()`,
 * and LISTING it in `KIE_MODELS` (an unlisted default silently runs `modelsList[0]` on the enhancer
 * path while settlement charges the configured model's rates).
 */
export const DEFAULT_MODEL = 'claude-sonnet-5';
export const PROMPT_COOKIE_KEY = 'cachedPrompt';
export const TOOL_EXECUTION_APPROVAL = {
  APPROVE: 'Yes, approved.',
  REJECT: 'No, rejected.',
} as const;
export const TOOL_NO_EXECUTE_FUNCTION = 'Error: No execute function found on tool';
export const TOOL_EXECUTION_DENIED = 'Error: User denied access to tool execution';
export const TOOL_EXECUTION_ERROR = 'Error: An error occured while calling tool';

const llmManager = LLMManager.getInstance(import.meta.env);

export const PROVIDER_LIST = llmManager.getAllProviders();
export const DEFAULT_PROVIDER = llmManager.getDefaultProvider();

export const providerBaseUrlEnvKeys: Record<string, { baseUrlKey?: string; apiTokenKey?: string }> = {};
PROVIDER_LIST.forEach((provider) => {
  providerBaseUrlEnvKeys[provider.name] = {
    baseUrlKey: provider.config.baseUrlKey,
    apiTokenKey: provider.config.apiTokenKey,
  };
});

// starter Templates

export const STARTER_TEMPLATES: Template[] = [
  {
    name: 'Expo App',
    label: 'Expo App',
    description: 'Expo starter template for building cross-platform mobile apps',
    githubRepo: 'xKevIsDev/bolt-expo-template',
    tags: ['mobile', 'expo', 'mobile-app', 'android', 'iphone'],
    icon: 'i-bolt:expo',
  },
  {
    name: 'Basic Astro',
    label: 'Astro Basic',
    description: 'Lightweight Astro starter template for building fast static websites',
    githubRepo: 'xKevIsDev/bolt-astro-basic-template',
    tags: ['astro', 'blog', 'performance'],
    icon: 'i-bolt:astro',
  },
  {
    name: 'NextJS Shadcn',
    label: 'Next.js with shadcn/ui',
    description: 'Next.js starter fullstack template integrated with shadcn/ui components and styling system',
    githubRepo: 'xKevIsDev/bolt-nextjs-shadcn-template',
    tags: ['nextjs', 'react', 'typescript', 'shadcn', 'tailwind'],
    icon: 'i-bolt:nextjs',
  },
  {
    name: 'Vite Shadcn',
    label: 'Vite with shadcn/ui',
    description: 'Vite starter fullstack template integrated with shadcn/ui components and styling system',
    githubRepo: 'xKevIsDev/vite-shadcn',
    tags: ['vite', 'react', 'typescript', 'shadcn', 'tailwind'],
    icon: 'i-bolt:shadcn',
  },
  {
    name: 'Qwik Typescript',
    label: 'Qwik TypeScript',
    description: 'Qwik framework starter with TypeScript for building resumable applications',
    githubRepo: 'xKevIsDev/bolt-qwik-ts-template',
    tags: ['qwik', 'typescript', 'performance', 'resumable'],
    icon: 'i-bolt:qwik',
  },
  {
    name: 'Remix Typescript',
    label: 'Remix TypeScript',
    description: 'Remix framework starter with TypeScript for full-stack web applications',
    githubRepo: 'xKevIsDev/bolt-remix-ts-template',
    tags: ['remix', 'typescript', 'fullstack', 'react'],
    icon: 'i-bolt:remix',
  },
  {
    name: 'Slidev',
    label: 'Slidev Presentation',
    description: 'Slidev starter template for creating developer-friendly presentations using Markdown',
    githubRepo: 'xKevIsDev/bolt-slidev-template',
    tags: ['slidev', 'presentation', 'markdown'],
    icon: 'i-bolt:slidev',
  },
  {
    name: 'Sveltekit',
    label: 'SvelteKit',
    description: 'SvelteKit starter template for building fast, efficient web applications',
    githubRepo: 'bolt-sveltekit-template',
    tags: ['svelte', 'sveltekit', 'typescript'],
    icon: 'i-bolt:svelte',
  },
  {
    name: 'Vanilla Vite',
    label: 'Vanilla + Vite',
    description: 'Minimal Vite starter template for vanilla JavaScript projects',
    githubRepo: 'xKevIsDev/vanilla-vite-template',
    tags: ['vite', 'vanilla-js', 'minimal'],
    icon: 'i-bolt:vite',
  },
  {
    name: 'Vite React',
    label: 'React + Vite + typescript',
    description: 'React starter template powered by Vite for fast development experience',
    githubRepo: 'xKevIsDev/bolt-vite-react-ts-template',
    tags: ['react', 'vite', 'frontend', 'website', 'app'],
    icon: 'i-bolt:react',
  },
  {
    name: 'Vite Typescript',
    label: 'Vite + TypeScript',
    description: 'Vite starter template with TypeScript configuration for type-safe development',
    githubRepo: 'xKevIsDev/bolt-vite-ts-template',
    tags: ['vite', 'typescript', 'minimal'],
    icon: 'i-bolt:typescript',
  },
  {
    name: 'Vue',
    label: 'Vue.js',
    description: 'Vue.js starter template with modern tooling and best practices',
    githubRepo: 'xKevIsDev/bolt-vue-template',
    tags: ['vue', 'typescript', 'frontend'],
    icon: 'i-bolt:vue',
  },
  {
    name: 'Angular',
    label: 'Angular Starter',
    description: 'A modern Angular starter template with TypeScript support and best practices configuration',
    githubRepo: 'xKevIsDev/bolt-angular-template',
    tags: ['angular', 'typescript', 'frontend', 'spa'],
    icon: 'i-bolt:angular',
  },
  {
    name: 'SolidJS',
    label: 'SolidJS Tailwind',
    description: 'Lightweight SolidJS starter template for building fast static websites',
    githubRepo: 'xKevIsDev/solidjs-ts-tw',
    tags: ['solidjs'],
    icon: 'i-bolt:solidjs',
  },
];
