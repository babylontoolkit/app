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
import { buildContentKey, cacheControlFor, isPlayServableInProduction, resolvePlayOrigin } from './serve';
import { deriveRemix } from './remix';
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

describe('build object keys — the path-traversal wall', () => {
  it('maps a normal dist path under the share prefix', () => {
    expect(buildObjectKey('abc123', 'dist/assets/index-a1b2.js')).toBe('builds/abc123/assets/index-a1b2.js');
  });

  it('strips a home/project prefix and the dist/ root', () => {
    expect(buildObjectKey('abc123', 'home/project/dist/index.html')).toBe('builds/abc123/index.html');
  });

  it.each([
    ['../../etc/passwd', 'parent traversal'],
    ['/etc/passwd', 'absolute'],
    ['a/../../b', 'embedded traversal'],
    ['C:\\windows', 'windows drive'],
    ['a\\b', 'backslash'],
    ['a/\0/b', 'null byte'],
    ['.env', 'never-publish secret'],
    ['sub/.git/config', 'git internals'],
  ])('REJECTS %s (%s)', (badPath) => {
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

describe('play origin isolation (§5)', () => {
  it('reports NOT isolated when PLAY_URL is unset (local dev is not the security boundary)', () => {
    expect(resolvePlayOrigin({}).isolated).toBe(false);
  });

  it('reports isolated and trims a trailing slash when PLAY_URL is set', () => {
    const origin = resolvePlayOrigin({ cloudflare: { env: { PLAY_URL: 'https://play.example.com/' } } });

    expect(origin).toEqual({ origin: 'https://play.example.com', isolated: true });
  });

  it('serves in local dev even without PLAY_URL (dev is not the boundary)', () => {
    expect(isPlayServableInProduction({ cloudflare: { env: { NODE_ENV: 'development' } } })).toBe(true);
  });

  it('REFUSES to serve in production when PLAY_URL is unset (fail closed)', () => {
    expect(isPlayServableInProduction({ cloudflare: { env: { NODE_ENV: 'production' } } })).toBe(false);
  });

  it('serves in production once PLAY_URL points at a separate origin', () => {
    const context = { cloudflare: { env: { NODE_ENV: 'production', PLAY_URL: 'https://play.example.com' } } };
    expect(isPlayServableInProduction(context)).toBe(true);
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
    currentSnapshotId: 'snp_1',

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
    expect(remix.currentSnapshotId).toBeUndefined();
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
