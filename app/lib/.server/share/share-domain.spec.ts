/**
 * The share ADDRESS (SPEC §4.8, §2.5 rule 2) — minting it, and reading it back off a Host header.
 *
 * A separate file from `share.spec.ts` deliberately: that file's contract is the publish/serve
 * PIPELINE (path safety, byte fidelity, the checklist), and none of it is about how a project is
 * named in public. Folding these in would make each file's header describe the other.
 *
 * Every property here fails silently in production, and each one fails as a different-looking bug:
 *
 *   - a URL built on the client is right on a laptop and wrong from a deploy (the original defect);
 *   - a `slice` boundary one character off resolves a DIFFERENT project's build, with no error;
 *   - a slug that overflows a DNS label makes the share simply unreachable — resolvers reject it,
 *     so there is nothing to see in any log we own;
 *   - a slug treated as identity re-introduces the entire naming problem (collisions, reservations,
 *     squatting, and links that break on rename) that keeping it decorative removes.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { resolveShareDomain, shareHostLabel, shareIdFromHost, shareUrl, isPlayServableInProduction } from './serve';
import { MAX_DNS_LABEL, MAX_SHARE_SLUG_LENGTH, SHARE_ID_LENGTH, slugifyForHost } from './publish';
import { shareHostRewrite } from '~/lib/share-host';

/**
 * ⚠️ `env()` falls back to `process.env`, and vitest loads `.env.local` — so a bare `{}` context is
 * NOT an empty environment. Without this scrub, every "unconfigured" assertion below silently reads
 * the developer's real config and starts failing on the one machine where someone actually set
 * `SHARE_DOMAIN` (the `oauth.spec.ts` trap, which this repo has now hit twice).
 *
 * `PLAY_URL` is scrubbed too, and that is not padding: `resolveShareDomain` THROWS when it is set, so
 * a developer with the retired variable still in `.env.local` would see every test in this file fail
 * with an error about the wrong thing entirely.
 */
beforeEach(() => {
  vi.stubEnv('SHARE_DOMAIN', '');
  vi.stubEnv('PLAY_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const ctx = (env: Record<string, string>) => ({ cloudflare: { env } });
const SHARE_ID = 'k7m2p9qx4nrt';
const CONFIGURED = ctx({ SHARE_DOMAIN: 'codewrx.app' });

describe('resolveShareDomain — one value decides dev vs deployed', () => {
  it('is undefined when unset, which is local dev', () => {
    expect(resolveShareDomain({})).toBeUndefined();
    expect(resolveShareDomain(ctx({ SHARE_DOMAIN: '   ' }))).toBeUndefined();
  });

  it('tolerates an operator pasting an origin, a trailing slash or a trailing dot', () => {
    for (const raw of ['codewrx.app', 'https://codewrx.app', 'https://codewrx.app/', 'codewrx.app.', 'CodeWrx.App']) {
      expect(resolveShareDomain(ctx({ SHARE_DOMAIN: raw })), raw).toBe('codewrx.app');
    }
  });

  /*
   * 🔴 The retired variable is REFUSED, never ignored. `PLAY_URL` named one flat origin and cannot be
   * reinterpreted as a wildcard base, so honouring it would be a guess; ignoring it would leave an
   * operator staring at a variable they set while production fails closed and serves nothing.
   */
  it('refuses loudly when the retired PLAY_URL is still set', () => {
    expect(() => resolveShareDomain(ctx({ PLAY_URL: 'https://play.example.com' }))).toThrow(/PLAY_URL/);
    expect(() => resolveShareDomain(ctx({ PLAY_URL: 'https://play.example.com' }))).toThrow(/SHARE_DOMAIN/);
  });
});

describe('shareUrl — minted by the server, in both modes', () => {
  it('is a relative /app path in local dev, exactly as the app already serves', () => {
    expect(shareUrl({ shareId: SHARE_ID }, {})).toBe(`/app/${SHARE_ID}`);
  });

  it('is the vanity host once a domain is configured', () => {
    expect(shareUrl({ shareId: SHARE_ID, shareSlug: 'arcade-racer' }, CONFIGURED)).toBe(
      `https://arcade-racer-${SHARE_ID}.codewrx.app`,
    );
  });

  it('drops the separator when there is no slug, so the label stays legal', () => {
    expect(shareUrl({ shareId: SHARE_ID }, CONFIGURED)).toBe(`https://${SHARE_ID}.codewrx.app`);
    expect(shareHostLabel({ shareId: SHARE_ID })).not.toMatch(/^-/);
  });

  /*
   * 🔴 THE POINT OF THE WHOLE DESIGN, asserted as a property rather than described in a comment:
   * identical names produce DIFFERENT, both-valid URLs. If this ever fails, the naming problem is
   * back — and with it a reservation queue, a squatting policy and a reserved-word deny list.
   */
  it('gives fifty projects called "Arcade Racer" fifty working URLs', () => {
    const slug = slugifyForHost('Arcade Racer');
    const a = shareUrl({ shareId: 'aaaaaaaaaaaa', shareSlug: slug }, CONFIGURED);
    const b = shareUrl({ shareId: 'bbbbbbbbbbbb', shareSlug: slug }, CONFIGURED);

    expect(a).not.toBe(b);
    expect(shareIdFromHost(new URL(a).hostname, 'codewrx.app')).toBe('aaaaaaaaaaaa');
    expect(shareIdFromHost(new URL(b).hostname, 'codewrx.app')).toBe('bbbbbbbbbbbb');
  });
});

describe('shareIdFromHost — the id is the identity, the slug is decoration', () => {
  const from = (host: string) => shareIdFromHost(host, 'codewrx.app');

  it('reads the id off an ordinary vanity host', () => {
    expect(from(`arcade-racer-${SHARE_ID}.codewrx.app`)).toBe(SHARE_ID);
  });

  /*
   * 🔴 THE SPLIT IS FIXED-WIDTH, NOT "AFTER THE LAST HYPHEN". Slugs contain hyphens, so a
   * last-hyphen split reads `racer` as the id here and serves a 404 for every share whose name has
   * more than one word — i.e. almost all of them.
   */
  it('is not confused by hyphens in the slug', () => {
    expect(from(`my-very-long-game-name-${SHARE_ID}.codewrx.app`)).toBe(SHARE_ID);
  });

  it('reads a bare id with no slug at all', () => {
    expect(from(`${SHARE_ID}.codewrx.app`)).toBe(SHARE_ID);
  });

  /*
   * A stale, edited or plain wrong slug STILL RESOLVES. This is what makes renaming a project safe
   * and is why the slug can be re-derived on every publish: a link already pasted into a chat keeps
   * working forever.
   */
  it('resolves even when the slug is wrong or stale', () => {
    expect(from(`completely-different-name-${SHARE_ID}.codewrx.app`)).toBe(SHARE_ID);
  });

  it('ignores the port and the case a Host header may carry', () => {
    expect(from(`Arcade-Racer-${SHARE_ID.toUpperCase()}.CodeWrx.app:5173`)).toBe(SHARE_ID);
  });

  it('accepts the trailing dot of a fully-qualified name', () => {
    expect(from(`arcade-racer-${SHARE_ID}.codewrx.app.`)).toBe(SHARE_ID);
  });

  /*
   * CONTROLS. These are what stop the app's own hostname being read as a project — the failure that
   * would turn every ordinary page load into a share lookup.
   */
  it('is undefined for the apex, a foreign host, or no configured domain', () => {
    expect(from('codewrx.app')).toBeUndefined();
    expect(from('app.codewrx.ai')).toBeUndefined();
    expect(from('evil.com')).toBeUndefined();
    expect(shareIdFromHost(`arcade-racer-${SHARE_ID}.codewrx.app`, undefined)).toBeUndefined();
    expect(shareIdFromHost(null, 'codewrx.app')).toBeUndefined();
  });

  /*
   * 🔴 ONE label, never two. A wildcard certificate covers exactly one level, so `a.b.codewrx.app` is
   * a host no certificate we can obtain would ever serve — treating it as a share would mean minting
   * URLs that fail TLS before they reach us.
   */
  it('refuses a nested label a wildcard certificate could not cover', () => {
    expect(from(`mackey.arcade-racer-${SHARE_ID}.codewrx.app`)).toBeUndefined();
  });

  /* A label too short to CONTAIN an id is not a share, and must not be padded into one. */
  it('refuses a label shorter than a share id', () => {
    expect(from('short.codewrx.app')).toBeUndefined();
  });

  /*
   * ⚠️ A near-miss suffix must not match. `notcodewrx.app` ends with the same characters as
   * `.codewrx.app` minus the dot; comparing without the leading separator would hand a stranger's
   * domain the ability to address our shares.
   */
  it('requires the dot before the domain, so a look-alike suffix does not match', () => {
    expect(shareIdFromHost(`arcade-racer-${SHARE_ID}.notcodewrx.app`, 'codewrx.app')).toBeUndefined();
  });
});

describe('slugifyForHost — decoration that must always produce a legal label', () => {
  it('reduces an ordinary title', () => {
    expect(slugifyForHost('Arcade Racer')).toBe('arcade-racer');
    expect(slugifyForHost('Burn The Asphalt!')).toBe('burn-the-asphalt');
  });

  it('keeps accented letters as letters rather than dropping them', () => {
    expect(slugifyForHost('Café Racer')).toBe('cafe-racer');
  });

  it('never leaves a leading or trailing hyphen — both are illegal in a DNS label', () => {
    for (const title of ['  Arcade  Racer  ', '---Arcade---Racer---', '!!!Arcade!!!']) {
      const slug = slugifyForHost(title)!;
      expect(slug, title).not.toMatch(/^-|-$/);
    }
  });

  /*
   * 🔴 Undefined, NEVER an empty string or a placeholder. An empty slug that still gets a separator
   * produces `-k7m2p9qx4nrt.codewrx.app`, which is an illegal label — the share would be unreachable
   * for the sake of a decoration that carries no meaning in the first place.
   */
  it('returns undefined when nothing survives, rather than an empty slug', () => {
    for (const title of ['', '   ', '!!!', '🎮🎮🎮', undefined]) {
      expect(slugifyForHost(title), String(title)).toBeUndefined();
    }

    expect(shareUrl({ shareId: SHARE_ID, shareSlug: slugifyForHost('🎮') }, CONFIGURED)).toBe(
      `https://${SHARE_ID}.codewrx.app`,
    );
  });

  /*
   * 🔴 The cap is DERIVED from the DNS limit and the id, and the assertion is on the FULL LABEL —
   * not on the slug. Checking the slug alone passes for a cap that is correct in isolation and one
   * character too long once the id and separator are added, which is exactly the drift a derived
   * constant exists to prevent.
   */
  it('produces a label within the DNS limit for an absurd title', () => {
    const slug = slugifyForHost('a'.repeat(500))!;

    expect(slug.length).toBe(MAX_SHARE_SLUG_LENGTH);
    expect(shareHostLabel({ shareId: SHARE_ID, shareSlug: slug }).length).toBeLessThanOrEqual(MAX_DNS_LABEL);
  });

  /* The cap can land mid-separator; trimming afterwards is what keeps the label legal. */
  it('does not leave a trailing hyphen when the cap lands on one', () => {
    const title = `${'a'.repeat(MAX_SHARE_SLUG_LENGTH - 1)} b c`;
    const slug = slugifyForHost(title)!;

    expect(slug).not.toMatch(/-$/);
    expect(slug.length).toBeLessThanOrEqual(MAX_SHARE_SLUG_LENGTH);
  });

  /* A capped slug is still only decoration — the id must survive the round trip regardless. */
  it('round-trips through the host even at maximum length', () => {
    const slug = slugifyForHost('z'.repeat(500))!;
    const url = shareUrl({ shareId: SHARE_ID, shareSlug: slug }, CONFIGURED);

    expect(shareIdFromHost(new URL(url).hostname, 'codewrx.app')).toBe(SHARE_ID);
  });
});

describe('the id length is one fact, shared', () => {
  /*
   * `shareIdFromHost` slices by `SHARE_ID_LENGTH` and `generateShareId` builds by it. Two files each
   * writing `12` is how one of them changes alone — and the failure is not an error, it is resolving
   * somebody ELSE'S project.
   */
  it('matches the ids the publisher actually mints', () => {
    expect(SHARE_ID.length).toBe(SHARE_ID_LENGTH);
    expect(shareIdFromHost(`x.${'y'.repeat(SHARE_ID_LENGTH)}`, `${'y'.repeat(SHARE_ID_LENGTH)}`)).toBeUndefined();
  });
});

describe('production still fails closed', () => {
  it('refuses to serve without a share domain, and serves once there is one', () => {
    expect(isPlayServableInProduction(ctx({ NODE_ENV: 'production' }))).toBe(false);
    expect(isPlayServableInProduction(ctx({ NODE_ENV: 'production', SHARE_DOMAIN: 'codewrx.app' }))).toBe(true);
    expect(isPlayServableInProduction(ctx({ NODE_ENV: 'development' }))).toBe(true);
  });
});

/**
 * 🔴 THE REWRITE, AND WHY IT IS NOT IN THE ROUTE.
 *
 * MEASURED live 2026-08-03: with the host check living inside the share route's own loader, a request
 * to `arcade-racer-<id>.codewrx.app/` matched Remix's `_index` route — the app's LANDING PAGE — and
 * the share loader never ran. Every probe answered a confident `200` with `<title>App Builder</title>`,
 * which reads as working until you look at the body. A route cannot decide it should have been a
 * different route, so the host→path rewrite happens at the server entry (`vite.config.ts` in dev,
 * `functions/[[path]].ts` in production) around this one pure function.
 */
describe('shareHostRewrite — host to path, before Remix routes', () => {
  const D = 'codewrx.app';

  it('turns the origin ROOT into the share route — the case that was silently serving the app', () => {
    expect(shareHostRewrite('/', `arcade-racer-${SHARE_ID}.${D}`, D)).toBe(`/app/${SHARE_ID}/`);
  });

  it('prefixes a nested asset path', () => {
    expect(shareHostRewrite('/assets/x.js', `arcade-racer-${SHARE_ID}.${D}`, D)).toBe(`/app/${SHARE_ID}/assets/x.js`);
  });

  /*
   * Idempotent. Two adapters exist (dev and production) and a request that somehow arrives already
   * rewritten must not become `/app/<id>/app/<id>/…`, which would 404 while looking like a routing bug
   * rather than a double-apply.
   */
  it('leaves an already-prefixed path alone', () => {
    for (const path of [`/app/${SHARE_ID}`, `/app/${SHARE_ID}/`, `/app/${SHARE_ID}/assets/x.js`]) {
      expect(shareHostRewrite(path, `arcade-racer-${SHARE_ID}.${D}`, D), path).toBeUndefined();
    }
  });

  /* CONTROLS — the app's own hostname must pass through untouched, or every page load becomes a share. */
  it('does not touch a request that is not on a share host', () => {
    expect(shareHostRewrite('/', 'app.codewrx.ai', D)).toBeUndefined();
    expect(shareHostRewrite('/', D, D)).toBeUndefined();
    expect(shareHostRewrite('/', `arcade-racer-${SHARE_ID}.${D}`, undefined)).toBeUndefined();
  });

  /*
   * A share id that a `/app/<other-id>` path disagrees with is still rewritten under the HOST's id.
   * The host is the address the visitor was given; a path claiming otherwise is not authority.
   */
  it('prefixes with the HOST id even when the path names another share', () => {
    expect(shareHostRewrite('/app/zzzzzzzzzzzz', `arcade-racer-${SHARE_ID}.${D}`, D)).toBe(
      `/app/${SHARE_ID}/app/zzzzzzzzzzzz`,
    );
  });
});
