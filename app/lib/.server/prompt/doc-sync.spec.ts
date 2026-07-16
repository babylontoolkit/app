/**
 * Doc-sync money/safety paths (spec/doc-sync.md "Tests").
 *
 * The guarantee under test: a broken docs push can NEVER take generation down. A build either
 * produces a complete, validated prompt or it fails and leaves the previous version active.
 */
import fs from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsPromptStore, getPromptStore, setPromptStore, sha256 } from './store';
import { BASE_DOCS, DECLARATION_FILES, ON_DEMAND_BLOCKS, selectOnDemandBlocks } from './sources';
import { isOpaqueToModel } from '~/lib/context/opaque-files';

/*
 * Doc bodies keyed by URL, plus the agent repo's HEAD, so a test can move ONE of them and rebuild.
 * `vi.hoisted` because `vi.mock` is hoisted above the imports and its factory cannot close over an
 * ordinary top-level binding.
 */
const { fixtures, head } = vi.hoisted(() => ({
  fixtures: new Map<string, string>(),
  head: { sha: 'commit-sha' },
}));

/** Fixture sentinel: a doc whose fetch fails outright (404, network error, redirect to login). */
const UNFETCHABLE = '__UNFETCHABLE__';

vi.mock('./github', () => ({
  githubText: async (url: string) => {
    const body = fixtures.get(url);

    if (body === '__UNFETCHABLE__') {
      throw new Error('404 Not Found');
    }

    return body ?? `BODY OF ${url}`;
  },
  githubJson: async () => ({ sha: head.sha }),
}));

// Imported after the mock so the build never reaches the network.
const { buildSystemPrompt, assemblePrompt } = await import('./build');

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
 * What a doc-sync can and cannot take away.
 *
 * The platform sections are `?raw` imports — compiled into the bundle, versioned with this code, and
 * never fetched. A docs push therefore cannot delete the play contract or the no-clone rule. What a
 * bad push CAN do is return an empty or missing doc, and the guarantee there is that the build fails
 * whole rather than activating a partial prompt (spec/doc-sync.md).
 */
describe('every refresh still carries what the agent needs', () => {
  const dir = new URL('./sections/', import.meta.url);

  /*
   * The silent one: add a section file, forget the import in `build.ts`, and it never reaches a
   * single generation. Nothing throws — the rule simply is not there. Globbing the directory means
   * this test fails the moment a section is authored but not wired.
   */
  it('assembles EVERY section file on disk into the prompt', () => {
    const prompt = assemblePrompt([], 'skills index');
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));

    expect(files.length).toBeGreaterThanOrEqual(6);

    for (const file of files) {
      const heading = readFileSync(new URL(file, dir), 'utf8').split('\n')[0].trim();
      expect(prompt, `${file} is on disk but never reaches the prompt — is it imported in build.ts?`).toContain(
        heading,
      );
    }
  });

  it('keeps the platform rules even when every fetched doc comes back empty-ish', () => {
    // Docs are inputs; the rules are not. Assembling with NO reference docs at all still yields them.
    const prompt = assemblePrompt([], '');

    expect(prompt).toMatch(/THE PLAY CONTRACT/);
    expect(prompt).toMatch(/never clone/i);
    expect(prompt).toMatch(/# The Project Spec/);
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

  /*
   * Both paths must return the SAME shape. `unchanged` reads the active version (which carries the
   * body) and `built` gets a meta back from the store, so returning the read straight through made
   * one path answer with ~150KB and the other with a few hundred bytes, for the same admin call.
   */
  it('returns metadata without the prompt body, on both paths', async () => {
    const built = await buildSystemPrompt({ skillsIndex: 'index' });
    const unchanged = await buildSystemPrompt({ skillsIndex: 'index' });

    expect(built.status).toBe('built');
    expect(unchanged.status).toBe('unchanged');
    expect(built.version).not.toHaveProperty('content');
    expect(unchanged.version).not.toHaveProperty('content');

    // The body is still reachable where it belongs.
    expect((await getPromptStore().get(unchanged.version.id))?.content).toContain('Platform Identity');
  });

  /*
   * THE GUARANTEE (spec/doc-sync.md): a broken docs push can never take generation down, and can
   * never quietly activate a prompt with a doc missing from it. Failing loud beats a silently
   * truncated system prompt — the agent would improvise exactly where the missing doc mattered.
   */
  it('fails the whole build on an empty doc, leaving the previous version active and intact', async () => {
    const good = await buildSystemPrompt({ skillsIndex: 'index' });
    const activeBefore = await getPromptStore().getActive();

    // A docs push lands a truncated file.
    fixtures.set(BASE_DOCS[0].url, '   \n  ');

    await expect(buildSystemPrompt({ skillsIndex: 'index' })).rejects.toThrow(/is empty/i);

    const activeAfter = await getPromptStore().getActive();
    expect(activeAfter?.id).toBe(good.version.id);
    expect(activeAfter?.content).toBe(activeBefore?.content);
    expect(await store.list()).toHaveLength(1);
  });

  it('fails the whole build when a doc cannot be fetched at all', async () => {
    await buildSystemPrompt({ skillsIndex: 'index' });

    const active = await getPromptStore().getActive();

    // Someone renames a doc in the agent repo; the URL now 404s.
    fixtures.set(BASE_DOCS[0].url, UNFETCHABLE);

    await expect(buildSystemPrompt({ skillsIndex: 'index' })).rejects.toThrow(/404/);
    expect((await getPromptStore().getActive())?.content).toBe(active?.content);
  });

  /*
   * An on-demand doc is not "optional" — it is the doc a baked reference points at. A build that
   * quietly activated without it would ship the dangling-pointer bug all over again.
   */
  it('fails the whole build when an ON-DEMAND doc goes missing, not just a baked one', async () => {
    await buildSystemPrompt({ skillsIndex: 'index' });

    const active = await getPromptStore().getActive();
    fixtures.set(ON_DEMAND_BLOCKS[0].url, UNFETCHABLE);

    await expect(buildSystemPrompt({ skillsIndex: 'index' })).rejects.toThrow(/404/);
    expect((await getPromptStore().getActive())?.content).toBe(active?.content);
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

  it('routes a React game-builder request to the React training reference', () => {
    const ids = selectOnDemandBlocks('wire up the SceneController and a custom overlay HUD').map((b) => b.id);
    expect(ids).toContain('react-training');
  });

  it('routes an image-generation request to the kie MCP docs', () => {
    expect(selectOnDemandBlocks('generate a texture for the car using MCP').map((b) => b.id)).toContain('kie-servers');
  });

  it('routes an example request to the matching playground', () => {
    expect(selectOnDemandBlocks('show me the simplest script that will rotate a cube').map((b) => b.id)).toContain(
      'demo-rotator',
    );
  });

  it('routes an install request to the project installer', () => {
    expect(selectOnDemandBlocks('npm install a physics helper package').map((b) => b.id)).toContain(
      'project-installer',
    );
  });

  /*
   * The point of unbaking it: a turn that is not about installing anything must not pay ~12k tokens
   * for the installer, on every request, forever.
   */
  it('does NOT route the installer into an ordinary gameplay edit', () => {
    expect(selectOnDemandBlocks('the car flips over when it lands, fix the suspension').map((b) => b.id)).not.toContain(
      'project-installer',
    );
  });
});

/**
 * The user project's own `SPEC.md` (the one at the root of the GAME the user is building — not this
 * platform's spec, which the agent never sees).
 *
 * The rule is only enforceable because the file is already in context: `.md` is not ignored, not
 * opaque, and not binary, so `createFilesContext` sends `SPEC.md` in full on every turn. If that ever
 * changes, this section becomes an instruction to consult a document the model cannot see — the exact
 * confabulation shape the reachability rules exist to prevent. `opaque-files.spec.ts` guards the
 * other half; this guards the prompt half.
 */
describe('project SPEC.md workflow', () => {
  const section = readFileSync(new URL('./sections/25-project-spec.md', import.meta.url), 'utf8');

  it.each([
    [/source of truth/i, 'the spec outranks the agent defaults'],
    [/flag conflicts/i, 'conflicts are surfaced, not silently resolved'],
    [/same response/i, 'the spec is updated in the turn that outdates it'],

    // `\s+` because markdown wraps this line — do not tighten it back to a literal space.
    [/never scaffold a `SPEC\.md`\s+unasked/i, 'no spec is invented for projects that never wanted one'],
    [/Current Project Files/, 'it tells the model the file is already in context, not fetchable'],
  ])('states %s — %s', (pattern) => {
    expect(section).toMatch(pattern);
  });

  it('reaches the assembled prompt', () => {
    const prompt = assemblePrompt([], 'skills index');

    expect(prompt).toMatch(/# The Project Spec/);

    /*
     * The platform's own non-negotiables still come first — a project spec cannot license
     * writing to a read-only zone or breaking the play contract.
     */
    expect(prompt.indexOf('# Hard Constraints')).toBeLessThan(prompt.indexOf('# The Project Spec'));
  });

  /*
   * A project SPEC.md must never be classified opaque — the whole workflow depends on the model
   * seeing its contents, not a `<boltFile … opaque>` marker.
   */
  it.each([['SPEC.md'], ['docs/SPEC.md']])('%s is never opaque to the model', (path) => {
    expect(isOpaqueToModel(path)).toBe(false);
  });
});

/**
 * The installer doc's STEP 0 is a BLOCKING "detect the host, clone StarterAssets.git" procedure.
 * This platform mounts the starter before the agent's first turn and has no `git`, so that procedure
 * is not merely useless here — following it would destroy or duplicate the user's project.
 *
 * Routing the doc out of the cached prefix does NOT fix that: a creation turn matches its keywords
 * and pulls it straight back in. The override therefore lives in the ALWAYS-BAKED identity section,
 * which is why these assertions are on the section file rather than on the routing.
 */
describe('the no-clone override is unconditional', () => {
  const identity = readFileSync(new URL('./sections/00-platform-identity.md', import.meta.url), 'utf8');

  it.each([[/never clone/i], [/never scaffold a new project/i], [/does not apply here/i], [/already scaffolded/i]])(
    'the baked identity section states %s',
    (pattern) => {
      expect(identity).toMatch(pattern);
    },
  );

  it('names the cloning procedure it is overriding, so the rule survives a docs rewrite', () => {
    expect(identity).toMatch(/StarterAssets\.git/);
    expect(identity).toMatch(/git.{0,40}(does not exist|NOT available)/is);
  });
});

/**
 * THE INVARIANT: there is no network at generation time, and the model is told the routing step is
 * complete and never to report a failed fetch. So a doc that is neither baked nor routed does not
 * exist for the model — it improvises instead, silently, in exactly the area the doc covered.
 *
 * These pin the docs a BAKED reference explicitly points at. `references/react-framework.md` says
 * "always reference" the React training doc; `references/training-reference.md` lists all five
 * playgrounds and says to check them before writing code from scratch; the Reference Index routes
 * image/video generation to the kie doc. Each was configured nowhere and therefore unreachable.
 */
describe('reachability of docs the baked references point at', () => {
  const reachable = new Set([
    ...BASE_DOCS.map((d) => d.path),
    ...ON_DEMAND_BLOCKS.map((b) => b.path),
    ...DECLARATION_FILES.map((d) => d.path),
  ]);

  it.each([
    ['training/react/README.md', 'references/react-framework.md says to always reference it'],
    ['training/playgrounds/01-DemoRotator.md', 'training-reference.md lists it as an example to check'],
    ['training/playgrounds/02-DemoBobber.md', 'training-reference.md lists it as an example to check'],
    ['training/playgrounds/03-DemoUserInput.md', 'training-reference.md lists it as an example to check'],
    ['training/playgrounds/04-DemoPlayerScene.md', 'training-reference.md lists it as an example to check'],
    ['training/playgrounds/05-DemoVehicleScene.md', 'training-reference.md lists it as an example to check'],
    ['references/web-kie-servers.md', 'the Reference Index routes image/video generation to it'],
  ])('%s is reachable — %s', (path) => {
    expect(reachable).toContain(path);
  });

  /*
   * The deliberate exclusions. `classic.md` is UMD and this platform is ESM-only; `skills-repository`
   * describes installing skills into the project, which is another host's mechanism (§4.11). Both are
   * neutralized in the platform-identity section rather than synced.
   */
  it.each([['references/classic.md'], ['references/skills-repository.md']])('%s stays unsynced', (path) => {
    expect(reachable).not.toContain(path);
  });

  /*
   * Ids key the stored blob maps and paths key the fetch, so a duplicate of either silently drops a
   * doc: the second write wins and the first block becomes unreachable with nothing thrown. Cheap to
   * assert, invisible if it ever happens.
   */
  it('has unique ids and paths across every synced doc', () => {
    const all = [...BASE_DOCS, ...ON_DEMAND_BLOCKS, ...DECLARATION_FILES];
    const ids = all.map((d) => d.id);
    const paths = all.map((d) => d.path);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('gives every on-demand block at least one routable keyword', () => {
    for (const block of ON_DEMAND_BLOCKS) {
      expect(block.keywords.length, `${block.id} has no keywords and can never be routed in`).toBeGreaterThan(0);
      expect(block.keywords, `${block.id} has a non-lowercase keyword; routing lowercases the haystack`).toEqual(
        block.keywords.map((k) => k.toLowerCase()),
      );
    }
  });
});
