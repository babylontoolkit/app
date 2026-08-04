import type { ServerBuild } from '@remix-run/cloudflare';
import { createPagesFunctionHandler } from '@remix-run/cloudflare-pages';
import { normalizeShareDomain, shareHostRewrite } from '../app/lib/share-host';

export const onRequest: PagesFunction = async (context) => {
  const serverBuild = (await import('../build/server')) as unknown as ServerBuild;

  const handler = createPagesFunctionHandler({
    build: serverBuild,
  });

  /*
   * 🔴 VANITY-HOST ROUTING, AND IT HAS TO HAPPEN HERE — BEFORE REMIX MATCHES A ROUTE (SPEC §4.8).
   *
   * A published project is addressed by HOST (`arcade-racer-k7m2p9qx4nrt.codewrx.app`), not by path.
   * MEASURED live 2026-08-03 with the equivalent check living inside the share route's own loader: a
   * request to that host's `/` matched Remix's `_index` route — the app's landing page — and the share
   * loader was never invoked at all. Every probe answered a confident `200` with
   * `<title>App Builder</title>`, which reads as working until you look at the body. **A route cannot
   * decide that it should have been a different route.**
   *
   * The PATH is rewritten and the Host is left alone: the visitor must STAY on the project's own
   * origin, because that origin is the §5 isolation boundary and it is the address they were given.
   *
   * `vite.config.ts`'s `shareHostPlugin` is the DEV half of this, and both are a few lines around the
   * same pure `shareHostRewrite` — the rule itself lives in one dependency-free module so the two
   * environments cannot drift into serving different projects for the same URL.
   */
  const env = context.env as unknown as Record<string, string | undefined> | undefined;
  const domain = normalizeShareDomain(env?.SHARE_DOMAIN);
  const url = new URL(context.request.url);
  const rewritten = domain ? shareHostRewrite(url.pathname, url.hostname, domain) : undefined;

  if (rewritten) {
    url.pathname = rewritten;

    /*
     * A fresh Request rather than a mutated one — `Request.url` is read-only, and the method, headers
     * and body must survive verbatim (the anonymous report POST reaches the app on this host too).
     */
    return handler({ ...context, request: new Request(url, context.request) });
  }

  return handler(context);
};
