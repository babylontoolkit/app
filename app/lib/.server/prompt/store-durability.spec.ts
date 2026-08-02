/**
 * The prompt and skills stores must not be CONTAINER state (spec/hosting.md, SPEC §4.3, §4.11).
 *
 * FOUND 2026-08-01 while answering "where does the .data folder go on AWS?". Both stores wrote to
 * `platformDataDir()` unconditionally. `spec/hosting.md` says the app is stateless and *"anything
 * stateful in the container is a bug"* — and a Lightsail container filesystem does not survive a
 * deployment, so on AWS **every deploy landed a container with no prompt version at all**.
 *
 * There is no boot-time sync: a version is built ONLY by an admin pressing Refresh in the Admin panel
 * or a `curl` carrying `ADMIN_TOKEN`. So `getActivePrompt()` returned null and the proxy threw
 * `NotConfiguredError('The system prompt')` on EVERY generation, for EVERY user, until a human
 * noticed and intervened. `DEPLOY.md`'s own smoke test ends with "new project → generate" — the exact
 * step that would have failed.
 *
 * The fix routes both stores through `ObjectStore`, which is already "S3 when `S3_BUCKET` is set, the
 * local filesystem otherwise". These tests pin the property that fix exists for, and they are written
 * as a REPLACEMENT of the process rather than as a check of a code path: a new store instance over
 * the same backing store is exactly what a redeployed container is.
 */
import { describe, expect, it } from 'vitest';
import { FsObjectStore, type ObjectStore, type StoredObject } from '~/lib/.server/storage';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PromptVersionStore, PROMPT_STORE_PREFIX, sha256 } from './store';
import { SkillVersionStore, SKILL_STORE_PREFIX } from '~/lib/.server/skills/store';

const promptVersion = (content: string) => ({
  content,
  sourceCommitSha: 'abc123',
  skillsSetHash: sha256('index'),
  onDemand: { 'racing-system': 'RACING DOCS' },
  declarations: { 'babylon.toolkit.d.ts': 'declare module TOOLKIT {}' },
});

const skillVersion = (name: string) => ({
  name,
  description: `the ${name} skill`,
  sourceCommitSha: 'abc123',
  body: `# ${name}`,
  resources: { 'references/guide.md': 'GUIDE' },
});

/** A shared backing store, standing in for S3 — outlives any one "container". */
async function sharedBackend(): Promise<ObjectStore> {
  return new FsObjectStore(await mkdtemp(path.join(tmpdir(), 'btk-durability-')));
}

describe('a prompt version survives the container that built it', () => {
  it('is readable by a brand-new store instance over the same backend', async () => {
    const objects = await sharedBackend();

    // "Container 1": build a version and activate it.
    const built = new PromptVersionStore(objects);
    const meta = await built.put(promptVersion('SYSTEM PROMPT'));
    await built.activate(meta.id);

    // "Container 2": a fresh deployment. Nothing carried over except the object store.
    const redeployed = new PromptVersionStore(objects);
    const active = await redeployed.getActive();

    expect(active?.id).toBe(meta.id);

    // Byte-identical, not merely present: the base prompt IS the cached prefix (§4.2.8).
    expect(active?.content).toBe('SYSTEM PROMPT');
    expect(active?.contentHash).toBe(sha256('SYSTEM PROMPT'));
  });

  it('carries the on-demand blocks and declarations across, not just the base', async () => {
    const objects = await sharedBackend();

    const meta = await new PromptVersionStore(objects).put(promptVersion('P'));
    const redeployed = new PromptVersionStore(objects);

    expect(await redeployed.readOnDemand(meta.id, 'racing-system')).toBe('RACING DOCS');
    expect(await redeployed.readDeclaration(meta.id, 'babylon.toolkit.d.ts')).toBe('declare module TOOLKIT {}');
  });

  it('lists prior versions, so rollback still works after a deploy', async () => {
    const objects = await sharedBackend();

    const first = new PromptVersionStore(objects);
    const good = await first.put(promptVersion('GOOD'));
    const bad = await first.put(promptVersion('BAD'));
    await first.activate(bad.id);

    const redeployed = new PromptVersionStore(objects);
    expect((await redeployed.list()).map((v) => v.id).sort()).toEqual([good.id, bad.id].sort());

    // And the rollback itself lands.
    await redeployed.activate(good.id);
    expect((await redeployed.getActive())?.content).toBe('GOOD');
  });

  /*
   * 🔴 CONTROL — the failure this whole change exists to prevent.
   *
   * Without it every assertion above could pass on a store that still wrote to container-local disk,
   * because the tests share one process. This is the one that fails if the store goes back to
   * `platformDataDir()`: a DIFFERENT backend must genuinely have nothing.
   */
  it('CONTROL — a store over a DIFFERENT backend has nothing (this is the outage)', async () => {
    const objects = await sharedBackend();
    const built = new PromptVersionStore(objects);
    await built.activate((await built.put(promptVersion('P'))).id);

    const freshDisk = new PromptVersionStore(await sharedBackend());

    expect(await freshDisk.getActive()).toBeNull();
    expect(await freshDisk.list()).toEqual([]);
  });
});

describe('a skill version survives the container that built it', () => {
  it('is readable, activatable and resource-resolvable by a new store instance', async () => {
    const objects = await sharedBackend();

    const built = new SkillVersionStore(objects);
    const meta = await built.put(skillVersion('bt-design'));
    await built.activate('bt-design', meta.id);

    const redeployed = new SkillVersionStore(objects);
    const active = await redeployed.getActive('bt-design');

    expect(active?.id).toBe(meta.id);
    expect(active?.body).toBe('# bt-design');

    // The manifest is the security boundary and must cross the redeploy intact.
    expect(await redeployed.readResource('bt-design', 'references/guide.md')).toBe('GUIDE');
    expect(await redeployed.readResource('bt-design', 'references/nope.md')).toBeNull();
  });

  /*
   * The skills index is sorted so its bytes are stable — an unstable index busts the prompt cache on
   * EVERY generation (§4.2.8). A redeploy must not perturb that order.
   */
  it('keeps the active list in sorted order after a redeploy', async () => {
    const objects = await sharedBackend();
    const built = new SkillVersionStore(objects);

    for (const name of ['bt-spec', 'bt-design', 'bt-plan']) {
      await built.activate(name, (await built.put(skillVersion(name))).id);
    }

    const redeployed = new SkillVersionStore(objects);

    expect((await redeployed.listActive()).map((s) => s.name)).toEqual(['bt-design', 'bt-plan', 'bt-spec']);
  });

  it('CONTROL — a store over a DIFFERENT backend has no skills', async () => {
    const objects = await sharedBackend();
    const built = new SkillVersionStore(objects);
    await built.activate('bt-design', (await built.put(skillVersion('bt-design'))).id);

    expect(await new SkillVersionStore(await sharedBackend()).getActive('bt-design')).toBeNull();
  });
});

/**
 * Each store owns ONE prefix. Without this, `list()` walks whatever else shares the bucket — in
 * production that is share builds, remix seeds, media and working copies, i.e. hundreds of megabytes
 * enumerated to answer "which prompt versions exist".
 */
describe('the stores are namespaced inside the shared object store', () => {
  it('writes only under its own prefix and ignores a neighbour’s objects', async () => {
    const objects = await sharedBackend();

    const prompts = new PromptVersionStore(objects);
    const skills = new SkillVersionStore(objects);

    await prompts.activate((await prompts.put(promptVersion('P'))).id);
    await skills.activate('bt-design', (await skills.put(skillVersion('bt-design'))).id);

    // A neighbouring subsystem's object, of the shape `list()` would otherwise pick up.
    await objects.put('builds/some-share/versions/decoy.json', new TextEncoder().encode('{}'));

    const promptKeys = (await objects.list(`${PROMPT_STORE_PREFIX}/`)).map((o: StoredObject) => o.key);
    const skillKeys = (await objects.list(`${SKILL_STORE_PREFIX}/`)).map((o: StoredObject) => o.key);

    expect(promptKeys.length).toBeGreaterThan(0);
    expect(skillKeys.length).toBeGreaterThan(0);
    expect(promptKeys.every((k: string) => k.startsWith(`${PROMPT_STORE_PREFIX}/`))).toBe(true);
    expect(skillKeys.every((k: string) => k.startsWith(`${SKILL_STORE_PREFIX}/`))).toBe(true);

    // And the decoy is invisible to both listings.
    expect(await prompts.list()).toHaveLength(1);
    expect(await skills.listAll()).toHaveLength(1);
  });
});
