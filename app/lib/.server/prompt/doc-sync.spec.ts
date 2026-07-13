/**
 * Doc-sync money/safety paths (spec/doc-sync.md "Tests").
 *
 * The guarantee under test: a broken docs push can NEVER take generation down. A build either
 * produces a complete, validated prompt or it fails and leaves the previous version active.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsPromptStore, sha256 } from './store';
import { selectOnDemandBlocks } from './sources';

let root: string;
let store: FsPromptStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-store-'));
  store = new FsPromptStore(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const version = (content: string, skillsIndex = 'index') => ({
  content,
  sourceCommitSha: 'abc123',
  skillsSetHash: sha256(skillsIndex),
  onDemand: { 'racing-system': 'RACING DOCS' },
  declarations: { 'babylon.toolkit.d.ts': 'declare module TOOLKIT {}' },
});

describe('prompt version store', () => {
  it('has no active version before anything is built', async () => {
    expect(await store.getActive()).toBeNull();
  });

  it('stores and activates a version, round-tripping content byte-identically', async () => {
    const meta = await store.put(version('SYSTEM PROMPT'));
    await store.activate(meta.id);

    const active = await store.getActive();

    expect(active?.id).toBe(meta.id);
    expect(active?.content).toBe('SYSTEM PROMPT');
    expect(active?.isActive).toBe(true);
    expect(active?.contentHash).toBe(sha256('SYSTEM PROMPT'));
  });

  it('keeps exactly one version active', async () => {
    const first = await store.put(version('ONE'));
    const second = await store.put(version('TWO'));

    await store.activate(first.id);
    await store.activate(second.id);

    const listed = await store.list();

    expect(listed.filter((v) => v.isActive).map((v) => v.id)).toEqual([second.id]);
  });

  /*
   * Rollback is the escape hatch when a doc change degrades generation quality. It must restore the
   * old prompt EXACTLY — a rollback that returns "almost" the previous bytes is not a rollback.
   */
  it('rolls back to any previous version, byte-identically', async () => {
    const good = await store.put(version('GOOD PROMPT'));
    await store.activate(good.id);

    const bad = await store.put(version('BAD PROMPT'));
    await store.activate(bad.id);
    expect((await store.getActive())?.content).toBe('BAD PROMPT');

    await store.activate(good.id);

    const restored = await store.getActive();
    expect(restored?.id).toBe(good.id);
    expect(restored?.content).toBe('GOOD PROMPT');
    expect(restored?.contentHash).toBe(sha256('GOOD PROMPT'));
  });

  it('refuses to activate a version that does not exist', async () => {
    await expect(store.activate('pv_nope')).rejects.toThrow(/not found/i);
  });

  it('serves on-demand blocks and declarations per version', async () => {
    const meta = await store.put(version('P'));

    expect(await store.readOnDemand(meta.id, 'racing-system')).toBe('RACING DOCS');
    expect(await store.readOnDemand(meta.id, 'not-a-block')).toBeNull();
    expect(await store.readDeclaration(meta.id, 'babylon.toolkit.d.ts')).toBe('declare module TOOLKIT {}');
  });

  it('content-addresses bodies so identical docs are not duplicated across versions', async () => {
    await store.put(version('A'));
    await store.put(version('B'));

    // Two versions, but the identical on-demand + declaration bodies are stored once each.
    const blobs = await fs.readdir(path.join(root, 'blobs'));

    // 2 distinct base prompts + 1 shared on-demand + 1 shared declaration.
    expect(blobs).toHaveLength(4);
  });
});

describe('on-demand block routing', () => {
  it('routes a racing request to the RacingSystem docs', () => {
    const ids = selectOnDemandBlocks('build a kart racing game with lap times').map((b) => b.id);
    expect(ids).toContain('racing-system');
  });

  it('routes a navmesh request to NavigationAgent, not to RacingSystem', () => {
    const ids = selectOnDemandBlocks('make the enemies pathfind around obstacles using a navmesh').map((b) => b.id);

    expect(ids).toContain('navigation-agent');
    expect(ids).not.toContain('racing-system');
  });

  it('routes nothing for a request that needs no system docs', () => {
    expect(selectOnDemandBlocks('change the title text to hello')).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(selectOnDemandBlocks('Add HAVOK Physics').map((b) => b.id)).toContain('rigidbody-physics');
  });
});
