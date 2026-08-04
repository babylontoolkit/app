/**
 * How a published project is named in public, as pure string logic (SPEC §4.8).
 *
 * ```
 * arcade-racer-k7m2p9qx4nrt.codewrx.app
 * └── share_slug ──┘└─ share_id ─┘
 * ```
 *
 * 🔴 **ZERO IMPORTS, AND THAT IS THE POINT.** Three very different callers need this rule and none of
 * them can carry the others' dependencies:
 *
 *   - `share/serve.ts` — the server, which resolves the project and serves its bytes;
 *   - `vite.config.ts` — the DEV server, which must allow the host and rewrite the URL before Remix
 *     routes it. It cannot import `~/lib/.server/**` (that pulls the whole server graph, including the
 *     admin Supabase client, into config load);
 *   - `functions/[[path]].ts` — the PRODUCTION entry, which does the same rewrite. It is excluded from
 *     `tsconfig.json` and runs before anything else exists.
 *
 * Written once here, they cannot drift. Written three times, the day someone changes the id length is
 * the day one of them starts resolving a DIFFERENT project — silently, because every layer still
 * returns a valid-looking answer.
 */

/**
 * How many characters of the host label are the share id.
 *
 * The single source for `generateShareId` (which builds them) and `shareIdFromHost` (which reads them
 * back). Two files each writing `12` is how one of them changes alone, and the failure is not an
 * error — it is serving somebody else's game.
 */
export const SHARE_ID_LENGTH = 12;

/** A DNS label may not exceed 63 octets. Everything about slug length derives from this. */
export const MAX_DNS_LABEL = 63;

/** What is left for the decorative slug once the id and its separator have taken their share. */
export const MAX_SHARE_SLUG_LENGTH = MAX_DNS_LABEL - SHARE_ID_LENGTH - 1;

/** Enough of a published project to address it. */
export interface ShareTarget {
  shareId: string;

  /** Decoration. A wrong, stale or absent slug still resolves — see {@link shareIdFromHost}. */
  shareSlug?: string;
}

/**
 * Reduce whatever an operator put in `SHARE_DOMAIN` to a bare hostname, or `undefined`.
 *
 * Tolerant on the way in (an origin, a trailing slash, a trailing dot, mixed case are all things
 * people really type) because the alternative is a share path that fails closed in production over a
 * `https://` prefix.
 */
export function normalizeShareDomain(raw: string | undefined | null): string | undefined {
  const trimmed = raw?.trim();

  if (!trimmed) {
    return undefined;
  }

  return (
    trimmed
      .replace(/^https?:\/\//i, '')
      .replace(/[/.]+$/, '')
      .toLowerCase() || undefined
  );
}

/**
 * The single DNS label for a published project: `arcade-racer-k7m2p9qx4nrt`.
 *
 * ONE label, never two. A wildcard certificate covers exactly one level — `*.codewrx.app` matches
 * `arcade-racer-x.codewrx.app` and does NOT match `arcade-racer.mackey.codewrx.app` — so any scheme
 * that reads as nested must flatten into a single label or it needs a certificate per project.
 */
export function shareHostLabel(target: ShareTarget): string {
  const slug = target.shareSlug?.trim();

  return slug ? `${slug}-${target.shareId}` : target.shareId;
}

/**
 * Recover the share id from a vanity host, or `undefined` if this host is not one.
 *
 * 🔴 **THE ID IS THE IDENTITY AND THE SLUG IS DECORATION — that is what makes the whole naming problem
 * disappear.** Fifty people publish a game called "Arcade Racer"; all fifty get a working URL, because
 * uniqueness is carried by the trailing `share_id` and never by the name. No unique constraint, no
 * reservation queue, no `-2` suffix walk, no reserved-word deny list, and no squatting policy. It also
 * means a slug that is stale, edited or plain wrong still resolves, so renaming a project can never
 * break a link somebody already pasted into a chat — which for a SHOWCASE system is the property that
 * matters most.
 *
 * The split is `slice(-SHARE_ID_LENGTH)` rather than "everything after the last hyphen", and that is
 * load-bearing: slugs contain hyphens (`arcade-racer`), so a last-hyphen split would read `racer` as
 * the id. A share id is a fixed-length draw from a fixed alphabet, so a fixed-width tail is
 * unambiguous no matter what precedes it.
 *
 * ⚠️ Returns `undefined` for the apex and for any host outside the share domain, so the app's own
 * hostname can never be mistaken for a project.
 */
export function shareIdFromHost(host: string | null | undefined, domain: string | undefined): string | undefined {
  if (!host || !domain) {
    return undefined;
  }

  // A Host header carries the port; a hostname does not. Strip it before comparing, and ignore case.
  const hostname = host.trim().toLowerCase().split(':')[0].replace(/\.$/, '');
  const suffix = `.${domain}`;

  if (!hostname.endsWith(suffix)) {
    return undefined;
  }

  const label = hostname.slice(0, -suffix.length);

  // Exactly one label. `a.b.codewrx.app` is not a share host — and no wildcard cert would cover it.
  if (!label || label.includes('.') || label.length < SHARE_ID_LENGTH) {
    return undefined;
  }

  return label.slice(-SHARE_ID_LENGTH);
}

/** The platform route that serves share bytes. One constant, because three files build paths onto it. */
export const SHARE_ROUTE_PREFIX = '/app';

/**
 * The path a vanity-host request should be routed as, or `undefined` to leave it alone.
 *
 * 🔴 **THIS HAS TO HAPPEN BEFORE ROUTE MATCHING, AND THAT IS WHY IT IS NOT IN THE ROUTE.**
 * MEASURED live 2026-08-03: with the host check living inside `app.$.tsx`'s loader, a request to
 * `arcade-racer-<id>.codewrx.app/` matched Remix's `_index` route — the app's own landing page — and
 * the share loader was never invoked at all. Every probe returned a confident `200` with
 * `<title>App Builder</title>`, so it read as working right up until you looked at the body. A route
 * cannot decide it should have been a different route.
 *
 * Rewriting instead of redirecting is deliberate: the visitor must STAY on the project's own origin
 * (that origin is the isolation boundary, and it is what they pasted), so the address bar must not
 * change. `/` becomes `/app/<id>/`, `/assets/x.js` becomes `/app/<id>/assets/x.js`, and the existing
 * splat route then handles both exactly as it always has.
 *
 * Already-prefixed paths pass through untouched, so the rewrite is idempotent — an adapter that runs
 * twice (or a request that somehow arrives pre-rewritten) cannot produce `/app/<id>/app/<id>/…`.
 */
export function shareHostRewrite(
  pathname: string,
  host: string | null | undefined,
  domain: string | undefined,
): string | undefined {
  const shareId = shareIdFromHost(host, domain);

  if (!shareId) {
    return undefined;
  }

  const prefix = `${SHARE_ROUTE_PREFIX}/${shareId}`;

  if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
    return undefined;
  }

  return `${prefix}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}
