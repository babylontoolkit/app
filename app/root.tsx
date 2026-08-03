import { useStore } from '@nanostores/react';
import type { LinksFunction } from '@remix-run/cloudflare';
import { Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse, useRouteError } from '@remix-run/react';
import tailwindReset from '@unocss/reset/tailwind-compat.css?url';
import { themeStore } from './lib/stores/theme';
import { brand } from './config/brand';
import { captureClientError } from './lib/monitoring/client';
import { clearLegacyGitCredentialCookies } from './lib/git/legacy-credentials';
import { stripIndents } from './utils/stripIndent';
import { createHead } from 'remix-island';
import { useEffect } from 'react';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { ClientOnly } from 'remix-utils/client-only';
import { cssTransition, ToastContainer } from 'react-toastify';

import reactToastifyStyles from 'react-toastify/dist/ReactToastify.css?url';
import globalStyles from './styles/index.scss?url';
import xtermStyles from '@xterm/xterm/css/xterm.css?url';

import 'virtual:uno.css';

const toastAnimation = cssTransition({
  enter: 'animated fadeInRight',
  exit: 'animated fadeOutRight',
});

export const links: LinksFunction = () => [
  {
    rel: 'icon',
    href: brand.assets.favicon,
    type: 'image/x-icon',
  },
  { rel: 'apple-touch-icon', href: '/apple-touch-icon.png', sizes: '180x180' },
  { rel: 'manifest', href: '/manifest.webmanifest' },
  { rel: 'stylesheet', href: reactToastifyStyles },
  { rel: 'stylesheet', href: tailwindReset },
  { rel: 'stylesheet', href: globalStyles },
  { rel: 'stylesheet', href: xtermStyles },
  {
    rel: 'preconnect',
    href: 'https://fonts.googleapis.com',
  },
  {
    rel: 'preconnect',
    href: 'https://fonts.gstatic.com',
    crossOrigin: 'anonymous',
  },
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
  },
];

const inlineThemeCode = stripIndents`
  setTutorialKitTheme();

  function setTutorialKitTheme() {
    let theme = localStorage.getItem('bolt_theme');

    if (!theme) {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    document.querySelector('html')?.setAttribute('data-theme', theme);
  }
`;

export const Head = createHead(() => (
  <>
    <meta charSet="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <Meta />
    <Links />

    {/*
     * Brand-driven social / PWA meta (SPEC §2.3, §2.5). Title + description come from each route's
     * `meta` export (already brand-sourced); these are the Open Graph / Twitter / theme surfaces the
     * route meta does not cover. Every value is a static brand string — no hardcoded marks. The image
     * path is relative (the per-env absolute origin is server-only `APP_URL`, deliberately not a client
     * brand field); crawlers resolve it against the page origin.
     */}
    <meta name="theme-color" content="#0a0a0a" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content={brand.productFullName} />
    <meta property="og:title" content={brand.productFullName} />
    <meta property="og:description" content={brand.metaDescription} />
    <meta property="og:image" content={brand.assets.ogImage} />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content={brand.productFullName} />
    <meta name="twitter:description" content={brand.metaDescription} />
    <meta name="twitter:image" content={brand.assets.ogImage} />

    <script dangerouslySetInnerHTML={{ __html: inlineThemeCode }} />
  </>
));

export function Layout({ children }: { children: React.ReactNode }) {
  const theme = useStore(themeStore);

  useEffect(() => {
    document.querySelector('html')?.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <>
      <ClientOnly>{() => <DndProvider backend={HTML5Backend}>{children}</DndProvider>}</ClientOnly>
      <ToastContainer
        closeButton={({ closeToast }) => {
          return (
            <button className="Toastify__close-button" onClick={closeToast}>
              <div className="i-ph:x text-lg" />
            </button>
          );
        }}
        icon={({ type }) => {
          switch (type) {
            case 'success': {
              return <div className="i-ph:check-bold text-bolt-elements-icon-success text-2xl" />;
            }
            case 'error': {
              return <div className="i-ph:warning-circle-bold text-bolt-elements-icon-error text-2xl" />;
            }
          }

          return undefined;
        }}
        position="bottom-right"
        pauseOnFocusLoss
        transition={toastAnimation}
        autoClose={3000}
      />
      <ScrollRestoration />
      <Scripts />
    </>
  );
}

import { logStore } from './lib/stores/logs';

/**
 * Root error boundary (SPEC §5A — client error tracking).
 *
 * Catches anything a route throws that no closer boundary handled, forwards it to the vendor-neutral
 * monitor (no-op until a collector is configured), and shows a brand-driven fallback instead of a blank
 * screen. Ordinary 404 route responses are NOT captured — a mistyped URL is not an error to page ops
 * about. `Layout` (above) wraps this automatically in Remix v2, so it renders inside the app shell.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const isNotFound = isRouteErrorResponse(error) && error.status === 404;

  useEffect(() => {
    if (!isNotFound) {
      captureClientError(error, 'root-error-boundary');
    }
  }, [error, isNotFound]);

  const heading = isNotFound ? 'Page not found' : 'Something went wrong';
  const detail = isNotFound
    ? "The page you're looking for doesn't exist."
    : 'An unexpected error occurred. Please try again.';

  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold text-bolt-elements-textPrimary">{heading}</h1>
      <p className="text-bolt-elements-textSecondary">{detail}</p>
      <a href="/" className="text-bolt-elements-item-contentAccent underline">
        Back to {brand.productName}
      </a>
    </div>
  );
}

export default function App() {
  const theme = useStore(themeStore);

  useEffect(() => {
    /*
     * Reap the plaintext PAT the retired browser-side clone used to write (§4.13,
     * `~/lib/git/legacy-credentials`). Here because this is the only effect guaranteed to run for every
     * user — the hook that wrote it has no callers left, so a cleanup living there would never fire for
     * exactly the people who have one.
     */
    const reaped = clearLegacyGitCredentialCookies();

    if (reaped.length > 0) {
      logStore.logSystem('Removed legacy git credential cookies', { count: reaped.length });
    }

    logStore.logSystem('Application initialized', {
      theme,
      platform: navigator.platform,
      userAgent: navigator.userAgent,
      timestamp: new Date().toISOString(),
    });

    // Initialize debug logging with improved error handling
    import('./utils/debugLogger')
      .then(({ debugLogger }) => {
        /*
         * The debug logger initializes itself and starts disabled by default
         * It will only start capturing when enableDebugMode() is called
         */
        const status = debugLogger.getStatus();
        logStore.logSystem('Debug logging ready', {
          initialized: status.initialized,
          capturing: status.capturing,
          enabled: status.enabled,
        });
      })
      .catch((error) => {
        logStore.logError('Failed to initialize debug logging', error);
      });
  }, []);

  return (
    <Layout>
      <Outlet />
    </Layout>
  );
}
