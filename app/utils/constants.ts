import { LLMManager } from '~/lib/modules/llm/manager';
import type { Template } from '~/types/template';

export const WORK_DIR_NAME = 'project';
export const WORK_DIR = `/home/${WORK_DIR_NAME}`;
export const MODIFICATIONS_TAG_NAME = 'bolt_file_modifications';
export const MODEL_REGEX = /^\[Model: (.*?)\]\n\n/;
export const PROVIDER_REGEX = /\[Provider: (.*?)\]\n\n/;

/*
 * The platform's default model (SPEC §4.2a) — the value used when NO env var and NO SSM property is
 * set. `LLM_MODEL` overrides it at runtime (validated against the rate tables — see
 * `agent/config.ts`); this is what a bare `docker run` with an empty environment gets.
 *
 * ## Why Opus 4.8, despite it being the ONE model KIE cannot stream thinking text for
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
 * ⚠️ Changing this means adding the new model's rate row first (`billing/rates.ts`) — a price cannot be
 * guessed, only looked up — and re-checking `grantHeadroom()`.
 */
export const DEFAULT_MODEL = 'claude-opus-4-8';
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
