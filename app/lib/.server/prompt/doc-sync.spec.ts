/**
 * Doc-sync money/safety paths (spec/doc-sync.md "Tests").
 *
 * The guarantee under test: a broken docs push can NEVER take generation down. A build either
 * produces a complete, validated prompt or it fails and leaves the previous version active.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsPromptStore, getPromptStore, setPromptStore, sha256 } from './store';
import { DECLARATION_FILES, ON_DEMAND_BLOCKS, selectOnDemandBlocks } from './sources';

/*
 * Doc bodies keyed by URL, plus the agent repo's HEAD, so a test can move ONE of them and rebuild.
 * `vi.hoisted` because `vi.mock` is hoisted above the imports and its factory cannot close over an
 * ordinary top-level binding.
 */
const { fixtures, head } = vi.hoisted(() => ({
  fixtures: new Map<string, string>(),
  head: { sha: 'commit-sha' },
}));

vi.mock('./github', () => ({
  githubText: async (url: string) => fixtures.get(url) ?? `BODY OF ${url}`,
  githubJson: async () => ({ sha: head.sha }),
}));

// Imported after the mock so the build never reaches the network.
const { buildSystemPrompt } = await import('./build');

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

  /*
   * `buildHash` is what the no-op keys on, so it must move when ANY artefact moves — including the
   * ones `contentHash` deliberately ignores.
   */
  it('fingerprints the whole build, not just the base prompt', async () => {
    const base = await store.put(version('SAME PROMPT'));

    const changedBlock = await store.put({
      ...version('SAME PROMPT'),
      onDemand: { 'racing-system': 'DIFFERENT RACING DOCS' },
    });

    const changedDecl = await store.put({
      ...version('SAME PROMPT'),
      declarations: { 'babylon.toolkit.d.ts': 'declare module TOOLKIT { const v: 2; }' },
    });

    // Same base prefix in all three...
    expect(changedBlock.contentHash).toBe(base.contentHash);
    expect(changedDecl.contentHash).toBe(base.contentHash);

    // ...but three distinct builds.
    expect(changedBlock.buildHash).not.toBe(base.buildHash);
    expect(changedDecl.buildHash).not.toBe(base.buildHash);
    expect(changedDecl.buildHash).not.toBe(changedBlock.buildHash);
  });

  it('fingerprints identically for identical builds', async () => {
    const first = await store.put(version('P'));
    const second = await store.put(version('P'));

    expect(second.buildHash).toBe(first.buildHash);
  });

  /*
   * Versions written before observation tracking have no `lastSeen*` fields. They must read as "seen
   * once, at build time" — never as `undefined` leaking into an admin listing or a staleness check.
   */
  it('reads a version with no recorded observation as seen at build time', async () => {
    const meta = await store.put(version('LEGACY'));

    // Strip the fields exactly as a record written by the old code would lack them.
    const file = path.join(root, 'versions', `${meta.id}.json`);
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    delete record.lastSeenCommitSha;
    delete record.lastSeenAt;
    await fs.writeFile(file, JSON.stringify(record));

    const read = await store.get(meta.id);

    expect(read?.lastSeenCommitSha).toBe('abc123');
    expect(read?.lastSeenAt).toBe(read?.createdAt);
  });

  it('records an observation without touching the build, and ignores an unknown version', async () => {
    const meta = await store.put(version('P'));

    await store.recordSeen(meta.id, 'a-newer-commit');

    const read = await store.get(meta.id);

    expect(read?.lastSeenCommitSha).toBe('a-newer-commit');
    expect(read?.sourceCommitSha).toBe('abc123');
    expect(read?.content).toBe('P');
    expect(read?.buildHash).toBe(meta.buildHash);

    // A note in the margin must not be able to fail a refresh.
    await expect(store.recordSeen('pv_nope', 'sha')).resolves.toBeUndefined();
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

/**
 * The no-op that decides whether a sync produced a new version.
 *
 * This is a SILENT path: every failure here reports `ok: true` and serves stale docs forever. There
 * is no error to notice, so the tests are the only thing standing between a docs push and the agent
 * quietly working from last week's reference.
 */
describe('build no-op', () => {
  const racing = ON_DEMAND_BLOCKS.find((b) => b.id === 'racing-system')!;
  const toolkitDts = DECLARATION_FILES.find((d) => d.id === 'babylon.toolkit.d.ts')!;

  beforeEach(() => {
    fixtures.clear();
    head.sha = 'commit-sha';
    setPromptStore(store);
  });

  afterEach(() => {
    setPromptStore(undefined);
  });

  /*
   * The no-op has to keep working: a spurious new version on every refresh would churn the prompt
   * and throw away the cached prefix (§4.2.8) — the exact cost the hash check exists to avoid.
   */
  it('reports unchanged when nothing moved, without writing a new version', async () => {
    const first = await buildSystemPrompt({ skillsIndex: 'index' });
    const second = await buildSystemPrompt({ skillsIndex: 'index' });

    expect(first.status).toBe('built');
    expect(second.status).toBe('unchanged');
    expect(second.version.id).toBe(first.version.id);
    expect(await store.list()).toHaveLength(1);
  });

  /*
   * The traceability half of "unchanged". Docs move without changing a byte we bake — a commit that
   * only touches skill bodies, or an excluded doc. If an unchanged build recorded nothing, the active
   * version's `sourceCommitSha` would sit behind HEAD forever, indistinguishable from a sync that
   * silently never ran.
   */
  it('records the confirming commit on an unchanged build, without rewriting provenance', async () => {
    head.sha = 'sha-at-build-time';

    const first = await buildSystemPrompt({ skillsIndex: 'index' });
    expect(first.version.sourceCommitSha).toBe('sha-at-build-time');
    expect(first.version.lastSeenCommitSha).toBe('sha-at-build-time');

    // The docs repo moves on, but nothing this prompt bakes actually changed.
    head.sha = 'sha-that-changed-nothing-we-bake';

    const second = await buildSystemPrompt({ skillsIndex: 'index' });

    expect(second.status).toBe('unchanged');
    expect(second.version.id).toBe(first.version.id);

    // Provenance is immutable: this version really was built from the older commit...
    expect(second.version.sourceCommitSha).toBe('sha-at-build-time');

    // ...but we now know it is current as of the newer one.
    expect(second.version.lastSeenCommitSha).toBe('sha-that-changed-nothing-we-bake');
    expect(await store.list()).toHaveLength(1);
  });

  it('carries the observation through activation and rollback, leaving the build untouched', async () => {
    head.sha = 'sha-one';

    const first = await buildSystemPrompt({ skillsIndex: 'index' });
    const before = await getPromptStore().get(first.version.id);

    head.sha = 'sha-two';
    await buildSystemPrompt({ skillsIndex: 'index' });

    const after = await getPromptStore().get(first.version.id);

    // An observation must never disturb what the version IS.
    expect(after?.content).toBe(before?.content);
    expect(after?.contentHash).toBe(before?.contentHash);
    expect(after?.buildHash).toBe(before?.buildHash);
    expect(after?.isActive).toBe(true);
    expect(await getPromptStore().readOnDemand(first.version.id, 'racing-system')).toBe(
      await store.readOnDemand(first.version.id, 'racing-system'),
    );
  });

  it('rebuilds when a base doc changes', async () => {
    await buildSystemPrompt({ skillsIndex: 'index' });
    fixtures.set(racing.url, 'irrelevant');
    fixtures.set(ON_DEMAND_BLOCKS[0].url, 'irrelevant');

    const rebuilt = await buildSystemPrompt({ skillsIndex: 'A DIFFERENT SKILLS INDEX' });

    expect(rebuilt.status).toBe('built');
    expect((await getPromptStore().get(rebuilt.version.id))?.content).toContain('A DIFFERENT SKILLS INDEX');
  });

  /*
   * THE REGRESSION. `contentHash` covers the base prompt only, so an on-demand-only edit hashed
   * identical, took the early return, and never reached `store.put()` — the fetched bytes were
   * discarded and the active version kept serving the old blob.
   */
  it('rebuilds when ONLY an on-demand block changes, and serves the new bytes', async () => {
    fixtures.set(racing.url, 'RACING DOCS V1');

    const first = await buildSystemPrompt({ skillsIndex: 'index' });
    expect(await getPromptStore().readOnDemand(first.version.id, 'racing-system')).toBe('RACING DOCS V1');

    fixtures.set(racing.url, 'RACING DOCS V2 — cornering rewritten');

    const second = await buildSystemPrompt({ skillsIndex: 'index' });

    expect(second.status).toBe('built');
    expect(second.version.id).not.toBe(first.version.id);

    // The base prefix is untouched, which is exactly why the old check missed this.
    expect(second.version.contentHash).toBe(first.version.contentHash);

    const active = await getPromptStore().getActive();
    expect(active?.id).toBe(second.version.id);
    expect(await getPromptStore().readOnDemand(active!.id, 'racing-system')).toBe(
      'RACING DOCS V2 — cornering rewritten',
    );
  });

  it('rebuilds when ONLY a declaration file changes', async () => {
    fixtures.set(toolkitDts.url, 'declare module TOOLKIT { const v: 1; }');

    const first = await buildSystemPrompt({ skillsIndex: 'index' });

    fixtures.set(toolkitDts.url, 'declare module TOOLKIT { const v: 2; }');

    const second = await buildSystemPrompt({ skillsIndex: 'index' });

    expect(second.status).toBe('built');
    expect(second.version.contentHash).toBe(first.version.contentHash);
    expect(await getPromptStore().readDeclaration(second.version.id, 'babylon.toolkit.d.ts')).toBe(
      'declare module TOOLKIT { const v: 2; }',
    );
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
