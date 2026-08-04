/**
 * Share / publish / remix (SPEC §4.8, §5).
 *
 * These test the parts that are pure and load-bearing, because publishing is the one irreversible
 * action a user can take and the one place a private key becomes a public URL. The three failure modes
 * under test all fail SILENTLY in the wrong direction:
 *
 * - the checklist waving a SECRET through → a key on a public CDN forever;
 * - a build path escaping its prefix → one game's publish overwriting another's, or reading a private
 *   snapshot back out of storage;
 * - a remix carrying ownership / a repo link / a share id → a project that belongs to, or can push to,
 *   or claims the public URL of, the wrong person.
 */
import { describe, expect, it } from 'vitest';
import { runPublishingChecklist } from './checklist';
import { buildObjectKey, buildPrefix, contentTypeFor, generateShareId, UnsafeBuildPathError } from './publish';
import {
  buildContentKey,
  cacheControlFor,
  isPlayServableInProduction,
  resolvePlayOrigin,
  resolvePlayRequest,
} from './serve';
import { renderPlayWrapper } from './wrapper';
import { deriveRemix } from './remix';
import { SANDBOX_ROOTS } from '~/lib/common/sandbox-paths';
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import type { Project } from '~/lib/.server/projects/types';

const file = (content: string, isBinary = false): SerializedFileMap[string] => ({ type: 'file', content, isBinary });

describe('the publishing checklist', () => {
  it('BLOCKS a project that carries a .env file', () => {
    const result = runPublishingChecklist({ '.env': file('KIE_API_KEY=sk-live-abcdef') });

    expect(result.ok).toBe(false);
    expect(result.findings[0].level).toBe('blocking');
    expect(result.findings[0].code).toBe('secret-file');
  });

  it('BLOCKS an Anthropic-shaped key pasted into source', () => {
    const result = runPublishingChecklist({
      'src/config.ts': file('const key = "sk-ant-api03-abcdefghijklmnop1234";'),
    });

    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === 'secret-in-source')).toBe(true);
  });

  it('BLOCKS a service-role key', () => {
    const result = runPublishingChecklist({ 'src/db.ts': file('SUPABASE_SERVICE_ROLE_KEY=xxx') });

    expect(result.ok).toBe(false);
  });

  it('BLOCKS a key inlined into .mcp.json', () => {
    const result = runPublishingChecklist({ '.mcp.json': file('{"env":{"KIE":"sk-ant-api03-abcdefghijklmnop1234"}}') });

    expect(result.ok).toBe(false);
    expect(result.findings[0].code).toBe('secret-in-mcp-config');
  });

  it('lets .env.example through — it is placeholders, and upstream commits it', () => {
    const result = runPublishingChecklist({ '.env.example': file('KIE_API_KEY=your-key-here') });

    expect(result.ok).toBe(true);
  });

  it('does NOT block on a Supabase anon key — shipping it is normal under RLS (§4.15)', () => {
    // A JWT-shaped anon key is public by design for a Game Backend. It must not read as a secret.
    const result = runPublishingChecklist({
      'src/backend.ts': file('const anon = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.sig";'),
    });

    expect(result.ok).toBe(true);
  });

  it('WARNS (does not block) on debug keys — the user may publish a rough game', () => {
    const result = runPublishingChecklist({ 'src/Game.ts': file('debugInfo.enableDebugKeys = true;') });

    expect(result.ok).toBe(true);
    expect(result.findings[0].level).toBe('warning');
    expect(result.findings[0].code).toBe('debug-keys');
  });

  it('flags a network-capable game for solo launch rather than blocking it', () => {
    const result = runPublishingChecklist({ 'src/Net.ts': file('const room = await client.joinOrCreate("race");') });

    expect(result.ok).toBe(true);
    expect(result.soloLaunchRequired).toBe(true);
  });

  it('never scans binary dirents (their content is empty by contract)', () => {
    // A binary file's `.content` is empty (spec/binary-files.md); a rule that read it would be a bug.
    const result = runPublishingChecklist({ 'public/model.glb': file('', true) });

    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(0);
  });
});

/**
 * THE CHECKLIST NORMALISES EVERY PROVIDER ROOT (T7b, SPEC §8).
 *
 * Its `relative()` helper was a `/^\/?(home\/project\/)?/` regex, so a map keyed under CodeSandbox's
 * `/project/workspace` kept its root. Today's secret rules survive that only by ACCIDENT — they anchor
 * on `(^|\/)`, so `project/workspace/.env` still matches `(^|\/)\.env$` — which is precisely why the
 * miss is invisible and why it gets a test rather than a shrug: the first root-anchored rule anyone
 * adds (`^dist/`, `^\.env`) would block on one provider and wave the key through on the other.
 *
 * The reported `path` is also asserted, because a finding is USER-FACING text (§4.8 renders it in the
 * Share dialog) and "/project/workspace/.env holds your private keys" is the same leak of provider
 * plumbing the workdir rule exists to end.
 */
describe.each(SANDBOX_ROOTS)('the publishing checklist under the %s root', (root) => {
  it('BLOCKS a .env keyed under the root, and reports the path relative', () => {
    const result = runPublishingChecklist({ [`${root}/.env`]: file('KIE_API_KEY=sk-live-abcdef') });

    expect(result.ok).toBe(false);
    expect(result.findings[0].code).toBe('secret-file');
    expect(result.findings[0].path).toBe('.env');
    expect(result.findings[0].message).toContain('.env holds your private keys');
  });

  it('BLOCKS a key pasted into source under the root, naming the project-relative file', () => {
    const result = runPublishingChecklist({
      [`${root}/src/config.ts`]: file('const key = "sk-ant-api03-abcdefghijklmnop1234";'),
    });

    expect(result.ok).toBe(false);
    expect(result.findings[0].code).toBe('secret-in-source');
    expect(result.findings[0].path).toBe('src/config.ts');
  });

  it('WARNS on a debug overlay under the root with the same relative path', () => {
    const result = runPublishingChecklist({ [`${root}/src/Game.ts`]: file('scene.showDebugLayer = true;') });

    expect(result.ok).toBe(true);
    expect(result.findings[0].level).toBe('warning');
    expect(result.findings[0].path).toBe('src/Game.ts');
  });

  it('still lets .env.example through under the root', () => {
    const result = runPublishingChecklist({ [`${root}/.env.example`]: file('KIE_API_KEY=your-key-here') });

    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it('still flags a network-capable game for solo launch', () => {
    const result = runPublishingChecklist({
      [`${root}/src/Net.ts`]: file('const room = await client.joinOrCreate("race");'),
    });

    expect(result.soloLaunchRequired).toBe(true);
  });
});

describe('build object keys — the path-traversal wall', () => {
  it('maps a normal dist path under the share prefix', () => {
    expect(buildObjectKey('abc123', 'dist/assets/index-a1b2.js')).toBe('builds/abc123/assets/index-a1b2.js');
  });

  it('strips a home/project prefix and the dist/ root', () => {
    expect(buildObjectKey('abc123', 'home/project/dist/index.html')).toBe('builds/abc123/index.html');
  });

  it('keys the same build file identically under EVERY provider root', () => {
    /*
     * The root is a provider fact (SPEC §8): a CodeSandbox build arrives under `/project/workspace`
     * and a WebContainer build under `/home/project`. A share URL must not depend on which sandbox
     * produced the bytes, and the old `/^\/?home\/project\//` literal made it depend silently — on a
     * CodeSandbox build the prefix never matched, so the key kept the whole absolute path.
     */
    const expected = 'builds/abc123/index.html';

    expect(buildObjectKey('abc123', '/project/workspace/dist/index.html')).toBe(expected);
    expect(buildObjectKey('abc123', '/home/project/dist/index.html')).toBe(expected);
    expect(buildObjectKey('abc123', 'dist/index.html')).toBe(expected);
  });

  it.each([
    ['../../etc/passwd', 'parent traversal'],
    ['/etc/passwd', 'absolute'],
    ['/dist/index.html', 'absolute, dist-shaped — a leading slash is never stripped'],
    ['a/../../b', 'embedded traversal'],
    ['C:\\windows', 'windows drive'],
    ['a\\b', 'backslash'],
    ['a/\0/b', 'null byte'],
    ['a//b', 'empty segment'],
    ['', 'empty path'],
    ['.env', 'never-publish secret'],
    ['sub/.git/config', 'git internals'],
  ])('REJECTS %s (%s)', (badPath) => {
    /*
     * The rejections are the important half: `stripSandboxRootPrefix` was chosen over
     * `toProjectRelativePath` precisely so `/etc/passwd` still LOOKS absolute when it gets here.
     */
    expect(() => buildObjectKey('abc123', badPath)).toThrow(UnsafeBuildPathError);
  });
});

describe('content keys — the same wall on the read side', () => {
  it('defaults a bare share request to index.html', () => {
    expect(buildContentKey('abc', '')).toBe(`${buildPrefix('abc')}/index.html`);
  });

  it.each(['../../snapshots/x.json', '/etc/passwd', 'a/../../b', 'a\\b'])('REJECTS %s', (badPath) => {
    expect(() => buildContentKey('abc', badPath)).toThrow();
  });

  it('serves fingerprinted assets as immutable and the entry HTML as must-revalidate', () => {
    expect(cacheControlFor('builds/abc/assets/index-a1b2c3d4.js')).toContain('immutable');
    expect(cacheControlFor('builds/abc/index.html')).toContain('must-revalidate');
  });
});

describe('share origin isolation (§5)', () => {
  it('reports NOT isolated when SHARE_DOMAIN is unset (local dev is not the security boundary)', () => {
    expect(resolvePlayOrigin({}).isolated).toBe(false);
  });

  it('reports isolated once SHARE_DOMAIN names a domain', () => {
    const origin = resolvePlayOrigin({ cloudflare: { env: { SHARE_DOMAIN: 'codewrx.app' } } });

    expect(origin).toEqual({ origin: 'https://codewrx.app', isolated: true });
  });

  it('serves in local dev even without SHARE_DOMAIN (dev is not the boundary)', () => {
    expect(isPlayServableInProduction({ cloudflare: { env: { NODE_ENV: 'development' } } })).toBe(true);
  });

  it('REFUSES to serve in production when SHARE_DOMAIN is unset (fail closed)', () => {
    expect(isPlayServableInProduction({ cloudflare: { env: { NODE_ENV: 'production' } } })).toBe(false);
  });

  it('serves in production once SHARE_DOMAIN names a separate domain', () => {
    const context = { cloudflare: { env: { NODE_ENV: 'production', SHARE_DOMAIN: 'codewrx.app' } } };
    expect(isPlayServableInProduction(context)).toBe(true);
  });
});

describe('resolvePlayRequest — asset vs game document vs wrapper (T17b)', () => {
  const noSignals = { embed: false, secFetchDest: null };
  const embedded = { embed: true, secFetchDest: null };

  it('serves a path with an extension as an asset', () => {
    expect(resolvePlayRequest('assets/index-a1b2.js', noSignals)).toBe('asset');
    expect(resolvePlayRequest('havok.wasm', noSignals)).toBe('asset');
  });

  it('serves index.html as an asset — an extension always wins', () => {
    expect(resolvePlayRequest('index.html', noSignals)).toBe('asset');
  });

  /**
   * 🔴 The recursion-critical case. The wrapper's iframe loads the extensionless directory URL with
   * `?embed=1` — if embed does not win here, that request gets the wrapper again, which embeds the
   * wrapper, forever.
   */
  it('serves the game document for the embedded directory request — or the wrapper recurses', () => {
    expect(resolvePlayRequest('', embedded)).toBe('game-document');
  });

  it('extension outranks embed — the iframe still fetches its assets as assets', () => {
    expect(resolvePlayRequest('assets/x.js', embedded)).toBe('asset');
  });

  /**
   * An in-game full reload of a client-side route (`/play/<id>/play`) carries no `?embed=1` — the game
   * navigated itself there. `sec-fetch-dest: iframe` is what identifies it as the iframe's document.
   */
  it('serves the game document for an in-game full reload signalled by sec-fetch-dest: iframe', () => {
    expect(resolvePlayRequest('play', { embed: false, secFetchDest: 'iframe' })).toBe('game-document');
  });

  it('serves the wrapper to a person at the top-level URL', () => {
    expect(resolvePlayRequest('', noSignals)).toBe('wrapper');
  });

  /** A browser sending neither signal degrades to nested chrome — never to a 404. */
  it('degrades an extensionless route with no signals to the wrapper, never a 404', () => {
    expect(resolvePlayRequest('play', noSignals)).toBe('wrapper');
    expect(resolvePlayRequest('play', { embed: false, secFetchDest: 'document' })).toBe('wrapper');
  });
});

describe('the play wrapper iframe src (T17b)', () => {
  /** Local dev: the wrapper is served by the app, so the game sits under the platform's `/app` route. */
  const input = {
    shareId: 'abc123def456',
    title: 'Kart Racer',
    solo: false,
    gameBase: '/app/abc123def456',
    appOrigin: '',
  };

  /** Deployed: the project owns its whole vanity origin, so the game is at that origin's ROOT. */
  const onVanityHost = { ...input, gameBase: '', appOrigin: 'https://app.codewrx.ai' };

  it('loads the DIRECTORY URL with ?embed=1 — same-origin (local dev)', () => {
    expect(renderPlayWrapper(input)).toContain('src="/app/abc123def456/?embed=1&__nodepod=host"');
  });

  it('appends &solo=true for a network-capable game', () => {
    expect(renderPlayWrapper({ ...input, solo: true })).toContain(
      'src="/app/abc123def456/?embed=1&__nodepod=host&solo=true"',
    );
  });

  /*
   * On a vanity host the game is at the ROOT of the project's own origin, so the src is bare `/`.
   * That is the whole point of a label per project: there is no share prefix left to be under.
   */
  it('loads the origin root on a vanity host', () => {
    expect(renderPlayWrapper(onVanityHost)).toContain('src="/?embed=1&__nodepod=host"');
  });

  /*
   * 🔴 The Remix link must be ABSOLUTE to the app, and only on a vanity host does that matter.
   * `/remix/<id>` there resolves to the PROJECT's origin — our app answers (the wildcard points at
   * it) but the session cookie does not, because it is host-only and set on the app origin. The
   * visitor would arrive logged out of an account they are signed into, on the one link §4.8's growth
   * loop depends on.
   */
  it('sends Remix back to the app origin from a vanity host', () => {
    expect(renderPlayWrapper(onVanityHost)).toContain('href="https://app.codewrx.ai/remix/abc123def456"');
  });

  /* CONTROL: served by the app itself, the relative link is already correct and must stay relative. */
  it('keeps the Remix link relative when the app serves the wrapper', () => {
    expect(renderPlayWrapper(input)).toContain('href="/remix/abc123def456"');
  });

  /*
   * The Report POST stays relative on BOTH shapes: it is anonymous, the wildcard points at this same
   * Remix app, and making it absolute would buy a cross-origin preflight for a request that needs no
   * identity at all.
   */
  it('keeps the anonymous report POST relative on both shapes', () => {
    for (const html of [renderPlayWrapper(input), renderPlayWrapper(onVanityHost)]) {
      expect(html).toContain("fetch('/api/play/abc123def456/report'");
    }
  });

  /*
   * 🔴 The marker is what stops the published game being REPLACED by the builder's sandbox.
   *
   * Nodepod's service worker owns the root of our origin and cannot tell one of OUR same-origin
   * iframes from a pod preview, so its recovery rule adopts any unattributed frame into whatever pod
   * is live — serving the BUILDER's dev server in place of the game. Every asset still returns 200, so
   * it reads as a working publish and shows a blank page (found live 2026-08-01; fixed in our Nodepod
   * fork as rule 1b, `@babylonjs-toolkit/nodepod@1.9.18-btk.2`).
   *
   * Asserted on EVERY variant above rather than once: the bug is in the URL the browser actually
   * requests, so a marker that survives the plain case and is dropped when `solo` is set (a string
   * built by concatenation, which is exactly how that happens) would be a blank page for precisely the
   * multiplayer games nobody tests locally.
   */
  it('marks the frame as the HOST’s on every variant, so the sandbox worker cannot adopt it', () => {
    for (const variant of [input, { ...input, solo: true }, onVanityHost, { ...onVanityHost, solo: true }]) {
      const src = /src="([^"]*embed=1[^"]*)"/.exec(renderPlayWrapper(variant))?.[1];

      expect(src, 'no iframe src matched — the wrapper markup changed shape').toBeDefined();
      expect(src, `frame is adoptable by the sandbox worker: ${src}`).toContain('__nodepod=host');
    }
  });

  /**
   * 🔴 Never `/index.html`: the game is a BrowserRouter SPA whose basename it resolves at runtime, so a
   * document URL ending in `index.html` leaves `index.html` as the route path — which matches nothing
   * and renders a blank page.
   */
  it('does NOT point the iframe at index.html', () => {
    for (const html of [renderPlayWrapper(input), renderPlayWrapper(onVanityHost)]) {
      const src = html.match(/src="([^"]+)"/)?.[1];

      expect(src).toBeDefined();
      expect(src).not.toContain('index.html');
    }
  });
});

describe('share ids', () => {
  it('are 12 chars of an unambiguous alphabet', () => {
    const id = generateShareId();

    expect(id).toHaveLength(12);
    expect(id).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]+$/);
    expect(id).not.toMatch(/[l1o0]/); // the glyphs deliberately excluded
  });

  it('does not collide across a run of ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateShareId()));

    expect(ids.size).toBe(500);
  });
});

describe('content types', () => {
  it('serves .wasm and .glb correctly (Babylon refuses a mistyped wasm)', () => {
    expect(contentTypeFor('havok.wasm')).toBe('application/wasm');
    expect(contentTypeFor('car.glb')).toBe('model/gltf-binary');
  });

  it('falls back to a byte stream for the unknown', () => {
    expect(contentTypeFor('weird.xyz')).toBe('application/octet-stream');
  });
});

describe('remix — what travels and what must not', () => {
  const source: Project = {
    id: 'prj_source',
    userId: 'owner_A',
    name: 'Kart Racer',
    templateId: 'gm_racing_v1',
    shareId: 'sharedaaaaaa',
    shareTitle: 'My Kart Racer',
    sharedAt: '2026-07-14T00:00:00.000Z',
    galleryStatus: 'approved',
    remixSeedAt: '2026-07-14T00:00:00.000Z',

    /*
     * A COMPLETE link (§4.5.4b): provider + repo + branch always travel together, and the database
     * refuses a half-set one. The fixture used to omit `provider`, which made it an impossible project
     * — and quietly made any assertion about `remix.provider` pass for the wrong reason.
     */
    provider: 'github',
    linkedRepo: 'ownerA/kart',
    linkedBranch: 'main',
    autoPush: true,
    lastSyncedCommitSha: 'deadbeef',
    githubInstallationRef: 'inst_1',
    gameBackendRef: 'backend_1',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
  };

  it('copies the files by giving the new project the source template and remix provenance', () => {
    const remix = deriveRemix(source, { newOwnerId: 'visitor_B' });

    expect(remix.userId).toBe('visitor_B');
    expect(remix.templateId).toBe('gm_racing_v1');
    expect(remix.remixedFrom).toBe('prj_source');
  });

  it('does NOT carry ownership, the share id, gallery state, or the GitHub link', () => {
    const remix = deriveRemix(source, { newOwnerId: 'visitor_B' });

    expect(remix.userId).not.toBe('owner_A');
    expect(remix.shareId).toBeUndefined();
    expect(remix.sharedAt).toBeUndefined();
    expect(remix.galleryStatus).toBe('none');
    expect(remix.provider).toBeUndefined();
    expect(remix.linkedRepo).toBeUndefined();
    expect(remix.linkedBranch).toBeUndefined();
    expect(remix.lastSyncedCommitSha).toBeUndefined();
    expect(remix.githubInstallationRef).toBeUndefined();
    expect(remix.gameBackendRef).toBeUndefined();

    /*
     * The clone must not be handed the SOURCE's seed pointer. `api.remix` deposits the clone its own
     * copy under its own project id immediately after this — a shared pointer would mean unpublishing
     * the original (which deletes its seed) silently empties every remix of it.
     */
    expect(remix.remixSeedAt).toBeUndefined();
  });

  /**
   * 🔴 A remix is born UNLINKED (§4.5.4b), and the link is a TUPLE — `provider`, `linkedRepo`,
   * `linkedBranch` are all-or-nothing (migration 0006 enforces it).
   *
   * Asserting the fields one at a time is how two thirds of an invariant ships: the test above names
   * the fields that existed when it was written, and `provider` was added later. This asserts the
   * PROPERTY instead, so a field added to the link tomorrow has to be reset or explained.
   *
   * What is at stake is not tidiness. A remix that inherited the link points at the ORIGINAL author's
   * repository — so the remixer's first auto-push would commit a stranger's edits into the only
   * permanent copy of someone else's game.
   */
  it('is born UNLINKED — no part of the source’s link survives, and the link is all-or-nothing', () => {
    const remix = deriveRemix(source, { newOwnerId: 'visitor_B' });
    const linkFields = [remix.provider, remix.linkedRepo, remix.linkedBranch];

    expect(linkFields.every((field) => field === undefined)).toBe(true);

    // And the fixture really was linked — otherwise the assertion above proves nothing.
    expect([source.provider, source.linkedRepo, source.linkedBranch].every((field) => field !== undefined)).toBe(true);
  });

  it('names a stranger remix "(remix)" and a self-remix "(copy)"', () => {
    expect(deriveRemix(source, { newOwnerId: 'B' }).name).toBe('Kart Racer (remix)');
    expect(deriveRemix(source, { newOwnerId: 'owner_A', isSelfRemix: true }).name).toBe('Kart Racer (copy)');
  });

  it('honours an explicit name override', () => {
    expect(deriveRemix(source, { newOwnerId: 'B', name: 'My Version' }).name).toBe('My Version');
  });
});
