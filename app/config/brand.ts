/**
 * Brand module — the single source of every user-facing brand string (SPEC §2.3, §2.5; CLAUDE.md
 * "Branding rule").
 *
 * **No bolt.diy marks in any user-facing surface, and nothing brand-shaped is ever hardcoded in a
 * component, email, meta tag, PWA manifest, or the public play page.** Product name, taglines,
 * attribution lines, support links, and asset paths all come from here. Swapping the brand is a change
 * to this one file (+ the assets it points at) — which is the whole point of the rule: the final name
 * is undecided (SPEC open question #18) and must be swappable without a hunt through the codebase.
 *
 * **Client-safe by construction.** This module is imported by client components, so it holds only
 * static strings — never `process.env`. The two absolute URLs that genuinely vary per environment,
 * the app origin (`APP_URL`) and the play origin (`PLAY_URL`), are resolved SERVER-SIDE via
 * `env(context, 'APP_URL' | 'PLAY_URL')` (see `api.auth.ts`, `api.checkout.ts`, `share/serve.ts`) and
 * are deliberately NOT fields here — putting them in a client module would inline a build-time value
 * and break per-environment deploys. Everything else (marketing site, docs, legal, support) is a
 * stable public URL and lives here.
 *
 * **Asset paths** are public-served URL paths (Vite serves `public/` at the web root). Swapping visual
 * identity = replace those files under `public/` and, if the filenames change, repoint them here. The
 * CI grep-gate (SPEC §2.5 rule 4) enforces that the brand STRINGS live here and nowhere else; binary
 * assets carry no such strings, so their location is a functional choice, not a debrand one.
 *
 * MIT attribution for inherited bolt.diy code lives in LICENSE and source-file headers ONLY, never in
 * the UI (§2.3) — this module never carries it.
 */
export interface Brand {
  /** The product's working name (browser title, headers, receipts). Final name undecided — change here only. */
  productName: string;

  /** Full/legal-ish product name for formal surfaces (footers, emails, ToS headers). */
  productFullName: string;

  /**
   * Short, filesystem- and URL-safe slug (kebab-case, no dots). Used where a NAME would be invalid or
   * ugly: download filenames (`<slug>-event-logs.json`), deploy site/repo name prefixes. Never a
   * display string — those use `productName`.
   */
  productSlug: string;

  /** One-line positioning statement. */
  tagline: string;

  /** `<meta name="description">` for the app shell — public/SEO facing. */
  metaDescription: string;

  /** The empty-state intro shown before a chat starts (BaseChat `#intro`). */
  intro: {
    heading: string;
    subheading: string;
  };

  /** The technology-brand layer. Part of the brand, not decoration (§2.5 rule 3). */
  poweredBy: {
    name: string;
    url: string;
  };

  /** Legal entity for footers/receipts. Placeholder until the company is named (SPEC open questions). */
  company: string;

  /** Stable public URLs (NOT the per-env app/play origins — those are server env; see file header). */
  urls: {
    marketing: string;
    docs: string;
    terms: string;
    privacy: string;
  };

  /** Support surface. */
  support: {
    email: string;
  };

  /** Public social links (empty string = not shown). */
  social: {
    x: string;
    github: string;
    discord: string;
  };

  /** Visual identity — public-served paths (see file header on swapping). */
  assets: {
    logo: string;
    logoLight: string;
    logoDark: string;
    mark: string;
    favicon: string;
    ogImage: string;
  };

  /** The attribution shown on public shared games (§4.8 badge). The Toolkit, not the app-builder. */
  playBadgeAttribution: string;

  /** Call to action on the play badge — drives the remix growth loop. */
  playBadgeRemixLabel: string;
}

export const brand: Brand = {
  productName: 'App Builder',
  productFullName: 'Babylon Toolkit App Builder',
  productSlug: 'babylon-toolkit',
  tagline: 'Build 3D Web Games With AI',
  metaDescription:
    'Build and play Babylon Toolkit 3D web games with AI — describe your game and watch it come to life.',
  intro: {
    heading: 'Build A 3D Game With AI',
    subheading: 'Describe your game and watch it come to life — playable in minutes, exportable as real code.',
  },
  poweredBy: {
    name: 'Babylon Toolkit',
    url: 'https://www.babylontoolkit.com',
  },
  company: 'codewrx.ai',
  urls: {
    marketing: 'https://www.babylontoolkit.com',
    docs: 'https://doc.babylontoolkit.com',
    terms: 'https://www.babylontoolkit.com/terms',
    privacy: 'https://www.babylontoolkit.com/privacy',
  },
  support: {
    email: 'support@babylontoolkit.com',
  },
  social: {
    x: '',
    github: 'https://github.com/babylontoolkit',
    discord: '',
  },
  assets: {
    logo: '/logo.svg',
    logoLight: '/logo-light.png',
    logoDark: '/logo-dark.png',
    mark: '/logo-babylontoolkit.svg',
    favicon: '/favicon.ico',
    ogImage: '/logo-light-styled.png',
  },
  playBadgeAttribution: 'Made with Babylon Toolkit',
  playBadgeRemixLabel: 'Remix this game',
};
