import { cloudflareDevProxyVitePlugin as remixCloudflareDevProxy, vitePlugin as remixVitePlugin } from '@remix-run/dev';
import react from '@vitejs/plugin-react';
import UnoCSS from 'unocss/vite';
import { defineConfig, type ViteDevServer } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { optimizeCssModules } from 'vite-plugin-optimize-css-modules';
import tsconfigPaths from 'vite-tsconfig-paths';
import * as dotenv from 'dotenv';
import { normalizeShareDomain, shareHostRewrite } from './app/lib/share-host';

// Load environment variables from multiple files
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
dotenv.config();

export default defineConfig((config) => {
  return {
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV),
    },
    build: {
      target: 'esnext',
    },
    server: {
      /*
       * Let the share domain's subdomains reach the dev server (SPEC §4.8).
       *
       * A published project is addressed by HOST — `arcade-racer-k7m2p9qx4nrt.<SHARE_DOMAIN>` — and
       * Vite's dev server rejects any Host it was not told about with a plain-text 403 ("Blocked
       * request. This host is not allowed"). That guard is right and is DEV-ONLY (production serves
       * the built Remix app, not Vite), but without this the vanity host cannot be exercised locally
       * at all: every probe answers 403 from Vite before a single line of our routing runs, which
       * looks exactly like the share machinery being broken.
       *
       * The leading dot is Vite's own subdomain wildcard. Scoped to the CONFIGURED domain and nothing
       * else — the guard exists to stop DNS-rebinding against a developer's machine, and opening it
       * to `true` would trade a real protection for a convenience.
       */
      allowedHosts: shareDomain() ? ['localhost', `.${shareDomain()}`] : undefined,
    },
    plugins: [
      /*
       * FIRST in the list, and that is load-bearing: Vite registers `configureServer` middleware in
       * plugin order, so anything after the Remix plugin runs AFTER Remix has already answered the
       * request. Measured — with this sitting next to `chrome129IssuePlugin()` at the end, a vanity
       * host still got the app's landing page.
       */
      shareHostPlugin(),
      nodePolyfills({
        include: ['buffer', 'process', 'util', 'stream'],
        globals: {
          Buffer: true,
          process: true,
          global: true,
        },
        protocolImports: true,
        exclude: ['child_process', 'fs', 'path'],
      }),
      {
        name: 'buffer-polyfill',
        transform(code, id) {
          if (id.includes('env.mjs')) {
            return {
              code: `import { Buffer } from 'buffer';\n${code}`,
              map: null,
            };
          }

          return null;
        },
      },
      config.mode !== 'test' && remixCloudflareDevProxy(),
      // The Remix plugin injects a React-refresh preamble that throws in the vitest runtime; under test
      // we transform JSX with @vitejs/plugin-react instead (dev/prod builds are untouched).
      config.mode !== 'test' &&
        remixVitePlugin({
          future: {
            v3_fetcherPersist: true,
            v3_relativeSplatPath: true,
            v3_throwAbortReason: true,
            v3_lazyRouteDiscovery: true,
          },
        }),
      config.mode === 'test' && react(),
      UnoCSS(),
      tsconfigPaths(),
      chrome129IssuePlugin(),
      config.mode === 'production' && optimizeCssModules({ apply: 'build' }),
    ],
    envPrefix: [
      'VITE_',
      'OPENAI_LIKE_API_BASE_URL',
      'OPENAI_LIKE_API_MODELS',
      'OLLAMA_API_BASE_URL',
      'LMSTUDIO_API_BASE_URL',
      'TOGETHER_API_BASE_URL',
    ],
    css: {
      preprocessorOptions: {
        scss: {
          api: 'modern-compiler',
        },
      },
    },
    test: {
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/cypress/**',
        '**/.{idea,git,cache,output,temp}/**',
        '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*',
        '**/tests/preview/**', // Exclude preview tests that require Playwright
      ],
    },
  };
});

/**
 * The configured share domain, read straight from the process environment.
 *
 * Not `~/lib/.server/env`'s `env()`: this runs in the Vite CONFIG, long before a request context
 * exists, and importing a server module here would pull the whole server graph into the config load.
 * `vite.config.ts` is also where `.env` files are read FROM, so `process.env` is the only source that
 * is meaningfully available at this point.
 */
function shareDomain(): string | undefined {
  return normalizeShareDomain(process.env.SHARE_DOMAIN);
}

/**
 * The DEV half of vanity-host routing (SPEC §4.8). Production's half is `functions/[[path]].ts`; both
 * are three lines around the same pure `shareHostRewrite`, which is where the rule actually lives.
 *
 * 🔴 It must run BEFORE Remix. MEASURED live 2026-08-03: with the host check inside the share route's
 * own loader, `arcade-racer-<id>.<domain>/` matched Remix's `_index` route and served the app's
 * LANDING PAGE with a confident 200 — the share loader never ran, because a route cannot decide it
 * should have been a different route.
 */
function shareHostPlugin() {
  return {
    name: 'share-host-rewrite',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, _res, next) => {
        const domain = shareDomain();

        if (req.url && domain) {
          /*
           * Rewrite the PATH and leave the Host alone: the visitor must stay on the project's own
           * origin (that origin is the isolation boundary, and it is the address they were given).
           */
          const url = new URL(req.url, 'http://localhost');
          const rewritten = shareHostRewrite(url.pathname, req.headers.host, domain);

          if (rewritten) {
            const target = `${rewritten}${url.search}`;
            req.url = target;

            /*
             * `originalUrl` too, and it is not belt-and-braces: connect stamps it on the way in and
             * Remix's dev handler builds its `Request` from it, so rewriting only `req.url` rewrites
             * nothing that Remix can see. Measured — the middleware logged a correct rewrite while the
             * response was still the app's landing page.
             */
            (req as { originalUrl?: string }).originalUrl = target;
          }
        }

        next();
      });
    },
  };
}

function chrome129IssuePlugin() {
  return {
    name: 'chrome129IssuePlugin',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const raw = req.headers['user-agent']?.match(/Chrom(e|ium)\/([0-9]+)\./);

        if (raw) {
          const version = parseInt(raw[2], 10);

          if (version === 129) {
            res.setHeader('content-type', 'text/html');
            res.end(
              '<body><h1>Please use Chrome Canary for testing.</h1><p>Chrome 129 has an issue with JavaScript modules & Vite local development, see <a href="https://github.com/stackblitz/bolt.new/issues/86#issuecomment-2395519258">for more information.</a></p><p><b>Note:</b> This only impacts <u>local development</u>. `pnpm run build` and `pnpm run start` will work fine in this browser.</p></body>',
            );

            return;
          }
        }

        next();
      });
    },
  };
}